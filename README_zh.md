# Command Code Proxy

<p align="center"><img src="docs/logo.svg" width="88" alt="CCPool — 多账号池反代"></p>

> [English Docs](README.md)

将 Command Code API 转换为 OpenAI / Anthropic 兼容接口的反代代理。单文件，零外部依赖。

逐条对齐官方 npm 包源码（`command-code@1.53.1`；`dist/cli.mjs` 只是压缩、**没有混淆**）—— 详见 `PROTOCOL-FACTS-1.53.1.md`：

**完整功能**：OpenAI Chat Completions + Anthropic Messages API | 流式/非流式输出 | 工具调用 (tool_use) | 多模态图片输入 | 推理强度 (reasoning_effort) | 动态模型列表 | 缓存命中指标 | 设备指纹伪装（per-key 绑定、自动刷新）| `x-api-key` 鉴权（Anthropic SDK）| 客户端断连检测（上游中止） | 零输出 → 429 自动重试 | 连续超时 → 429 自动重试 | 隐私保护日志

**社区**: [Linux.do](https://linux.do) — 一个友好的中文技术社区。

## 快速开始

```bash
npm start        # 启动（仓库自带 config.json，监听 http://0.0.0.0:3050）
npm run dev      # watch 模式（文件修改自动重启）
```

API Key 通过 `Authorization` 请求头（Anthropic SDK 可用 `x-api-key`）传入，**无需配置到文件中**。Key 必须以 `user_` 开头（自动匹配任意前缀，如 `Bearer token_user_xxx`）：

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

## 文件结构

```
commandcode/
├── config.json           # 端口 / 日志路径等
├── LICENSE               # MIT License
├── package.json          # npm start / npm run dev
├── proxy.mjs             # 单文件核心代理（~1900 行）
├── Dockerfile            # 容器构建文件（node:22-alpine）
├── docker-compose.yml    # 容器编排
├── .dockerignore         # 构建上下文排除规则
├── .github/
│   └── workflows/
│       └── docker-publish.yml  # 打 v* tag 时自动发布 GHCR 多架构镜像
├── captured-requests/    # CLI 抓包数据（协议逆向参考）
├── README.md             # 英文文档
└── README_zh.md          # 本文档（中文）
```

## 配置

### config.json

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `port` | `3000` | 监听端口（仓库自带 config.json 为 3050） |
| `host` | `0.0.0.0` | 监听地址 |
| `apiBase` | `https://api.commandcode.ai` | CC API 地址 |
| `projectSlug` | `cc-proxy` | `x-project-slug` header |
| `apiKey` | `""` | 可选兜底 API Key（请求也可通过 header 传入） |
| `logFile` | `""` | 日志文件路径（空=仅控制台） |
| `logLevel` | `info` | 日志级别 |
| `useProviderModels` | `true` | 从 Provider API 动态拉取模型列表 |
| `modelRefreshIntervalMs` | `300000` | 模型列表缓存刷新间隔（5min） |
| `zdr` | `false` | 请求 Command Code 使用 ZDR-only 路由 |

### 环境变量

| 变量 | 对应 config 字段 |
|------|-----------------|
| `PORT` | `port` |
| `HOST` | `host` |
| `CC_API_BASE` | `apiBase` |
| `PROJECT_SLUG` | `projectSlug` |
| `LOG_FILE` | `logFile` |
| `CC_USE_PROVIDER_MODELS` | `useProviderModels` |
| `CC_STREAM_IDLE_MS` | 流式上游读空闲超时（默认 `30000`）|
| `CC_NONSTREAM_IDLE_MS` | 非流式上游读空闲超时（默认 `90000`）|
| `CC_MAX_INFLIGHT` | 进程内在途请求上限（默认 `0` = 不限）|
| `CMD_ZDR` | `zdr`（`1` 开启） |

开启后，代理会在 Command Code 生成请求以及 fingerprint/lifecycle 初始化请求中附加
`x-cmd-zdr: 1`。npm 版本检查和代理自己的 `/provider/v1/models` 模型目录请求不会附加该
header。该开关只是请求 Command Code 使用 ZDR-only 路由，实际数据留存和上游可用性仍由上游服务决定。

**请求体上限**：独立于 `config.json` —— 超过 **100MB** 的请求会被拒绝并返回 `HTTP 413`（连接保持可排空，不会直接 reset）。可用 `CC_MAX_BODY_MB`（正整数，单位 MB）覆盖。

> ⚠️ **内存放大**：请求体在转发到上游前会存在多份副本，实测峰值 ≈ body 大小 × **5.1~7.4**（7MB→+52MB、20MB→+116MB；被 `413` 拒绝的请求只要 ×1.05）。因此默认 `CC_MAX_BODY_MB=100` 意味着**单个请求**最坏可吃 ~550MB，且该上限是每请求的、不是全局的。详见[内存与部署](#内存与部署)。

## API 接口

### `POST /v1/chat/completions`

OpenAI Chat Completions 兼容。支持流式和非流式、工具调用、多模态图片输入、推理强度。

**请求体参数：**

| 参数 | 必填 | 说明 |
|------|------|------|
| `model` | 是 | 模型 ID（见模型列表） |
| `messages` | 是 | 对话消息，支持 `system/user/assistant/tool` 角色 |
| `max_tokens` | 否 | 最大生成 token（默认 64000） |
| `stream` | 否 | 是否 SSE 流式（默认 false） |
| `temperature` | 否 | 采样温度（0-2）|
| `reasoning_effort` | 否 | 推理强度 `low`/`medium`/`high`/`max` |
| `tools` | 否 | 工具定义（OpenAI function calling 格式）|
| `tool_choice` | 否 | 工具选择策略 |
| `parallel_tool_calls` | 否 | 是否允许并行工具调用 |

**简单请求：**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "hello" }],
  "stream": true
}
```

**多模态图片输入（需 vision 模型）：**
```json
{
  "model": "xiaomi/mimo-v2.5",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "描述这张图片" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
    ]
  }]
}
```

**工具调用：**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [...],
  "tools": [{
    "type": "function",
    "function": { "name": "get_weather", "description": "...", "parameters": {...} }
  }],
  "tool_choice": "auto"
}
```

**流式响应（SSE）：**
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"思考过程"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"prompt_tokens_details":{"cached_tokens":8}}}

data: [DONE]
```

**非流式响应（含缓存命中）：**
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "deepseek/deepseek-v4-flash",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello!",
      "reasoning_content": "The user said hello, I should respond."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 7558,
    "completion_tokens": 42,
    "total_tokens": 7600,
    "prompt_tokens_details": { "cached_tokens": 7552 }
  }
}
```

### `POST /v1/messages`

Anthropic Messages API 兼容端点。支持流式和非流式、工具调用。

**请求体：**
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1000,
  "system": "你是一个有用的助手。",
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "stream": true
}
```

**Anthropic 协议差异（自动转换）：**

| 概念 | Anthropic 原始格式 | 转换说明 |
|------|-------------------|----------|
| System prompt | 顶层 `system` 字段 | 自动转为 OpenAI `system` message |
| 消息内容 | `content` 数组（text/tool_use/tool_result） | 自动映射为对应角色 |
| 工具结果 | `user` 消息中的 `tool_result` 块 | 自动转为 `role: "tool"` |
| 工具定义 | `input_schema` | 自动映射为 `parameters` |
| `tool_choice` | `{type:"auto"/"any"/"tool"}` | `any`→`required`，`tool`→function 对象 |
| 推理强度 | `thinking.budget_tokens` | 自动映射为 `reasoning_effort`（≥10000→high, ≥5000→medium, ≥2000→low） |
| 停止原因 | `end_turn`/`max_tokens`/`tool_use` | 自动映射为 `stop`/`length`/`tool_calls` |
| Token 用量 | `input_tokens`/`output_tokens` + 缓存 | 透传，缓存字段映射为 Anthropic 格式 |

**流式响应（SSE，Anthropic 格式）：**
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","type":"message","role":"assistant","content":[],"model":"...","usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10,"cache_read_input_tokens":0,"input_tokens":100}}

event: message_stop
data: {"type":"message_stop"}
```

**非流式响应：**
```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "model": "deepseek/deepseek-v4-flash",
  "content": [{ "type": "text", "text": "Hello!" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 7558,
    "output_tokens": 42,
    "cache_read_input_tokens": 7552,
    "cache_creation_input_tokens": null
  }
}
```

### `GET /v1/models`

返回可用模型列表。优先从 Provider API 动态拉取（5min 缓存），失败回退硬编码列表。

### `GET /health`

健康检查。返回 `OK`。

## 错误码

| HTTP 状态 | 说明 |
|-----------|------|
| 400 | 请求格式错误 |
| 401 | API Key 缺失/格式不对/无效（Key 必须以 `user_` 开头；通过 `Authorization: Bearer` 或 `x-api-key` 传入） |
| 429 | 零输出 token，或流空闲超时（30s 流式 / 90s 非流式）——带 `Retry-After`，SDK 自动重试；连续 3 次超时返回"压缩上下文"提示 |
| 502 | CC 上游错误 |

## 模型列表

代理访问 `GET /v1/models` 会返回实时模型列表。以下为常见模型参考，完整列表以实际接口返回为准——各模型套餐可参考 [Command Code Pricing](https://commandcode.ai/docs/resources/pricing-limits)。

### 常用模型

| 模型 ID | 提供商 |
|---------|--------|
| `claude-sonnet-4-6` / `claude-opus-4-8` / `claude-opus-4-7` / `claude-haiku-4-5-20251001` | Anthropic |
| `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex` | OpenAI |
| `deepseek/deepseek-v4-pro` / `deepseek/deepseek-v4-flash` | DeepSeek |
| `moonshotai/Kimi-K2.6` / `moonshotai/Kimi-K2.5` | Kimi |
| `zai-org/GLM-5.1` / `zai-org/GLM-5` | GLM |
| `MiniMaxAI/MiniMax-M3` / `MiniMaxAI/MiniMax-M2.7` / `MiniMaxAI/MiniMax-M2.5` | MiniMax |
| `Qwen/Qwen3.7-Max` / `Qwen/Qwen3.6-Max-Preview` / `Qwen/Qwen3.6-Plus` | Qwen |
| `stepfun/Step-3.7-Flash` / `stepfun/Step-3.5-Flash` | Step |
| `xiaomi/mimo-v2.5-pro` / `xiaomi/mimo-v2.5` | Xiaomi（**支持图片输入**） |
| `google/gemini-3.5-flash` / `google/gemini-3.1-flash-lite` | Gemini |

> ⚠️ 部分模型（如 `deepseek-v4-flash`、`claude-sonnet-4-6`）不支持图片输入。如需多模态请用 `xiaomi/mimo-v2.5`、`Kimi-K2.5` 等 vision 模型。

## 接入示例

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    api_key="user_xxxxxxxxx",
    base_url="http://127.0.0.1:3050/v1",
)

response = client.chat.completions.create(
    model="deepseek/deepseek-v4-flash",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### cURL
```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": true
  }'
```

### Cursor
在 Cursor 设置中添加 Custom Provider：
- **API Base URL**: `http://127.0.0.1:3050/v1`
- **API Key**: `user_xxxxxxxxx`
- **Model**: 从模型列表中选择

### Anthropic (Python SDK)
```python
import anthropic

client = anthropic.Anthropic(
    api_key="user_xxxxxxxxx",
    base_url="http://127.0.0.1:3050",
)
message = client.messages.create(
    model="deepseek/deepseek-v4-flash",
    max_tokens=1000,
    system="You are helpful.",
    messages=[{"role": "user", "content": "hello"}],
)
print(message.content[0].text)
```

Anthropic SDK 通过 `x-api-key` 头鉴权——代理已原生支持（无需 `Authorization` 头）。

### OpenCode
```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:3050/v1",
  "apiKey": "user_xxxxxxxxx"
}
```

## 反检测

基于对官方 CLI 网络流量的分析（版本号从 npm registry 动态拉取），实现了以下兼容适配：

| 机制 | 实现 |
|------|------|
| **设备指纹** | 每个 Key 首次请求前发送 `POST /alpha/fingerprint/record`；信号值（Windows MachineGuid 形状、真实形状的 MAC、`DESKTOP-xxxxxx` 主机名）由 API key **确定性派生**，并按 CLI 的算法哈希 —— 同一个 key 永远报告同一台设备：重启、内存回收、多实例都一致（用 `CC_FINGERPRINT_SALT` 成批换身份）|
| **生命周期声明** | Key 初始化时与指纹并行发送 `POST /alpha/lifecycle-events`（`cli_session_exists`，metadata `{sessionId, cliVersion, mode, os}`）|
| **按 Key 分 Session** | 每个 API Key 独立 session，12h 过期 + 1h 随机抖动 |
| **协议版本号** | `x-command-code-version` 报**实际实现的协议版本**（当前 `1.53.1`）；npm 上有新版本只打**漂移告警**，不会静默改版本号 |
| **CLI 信封格式** | 9 键：`config / memory / taste / skills / permissionMode / threadId / mode / promptCache / params` |
| **OpenTelemetry** | `traceparent` (W3C Trace Context) |
| **环境标识** | `x-cli-environment: production`、`x-taste-learning: "false"`、`User-Agent: cli` |
| **Project Slug** | `x-project-slug` = `slugify(process.cwd())`，与 `config.workingDir` 同源 |
| **思考强度** | `reasoning_effort` 透传 (low/medium/high/max) |
| **API Key 格式验证** | 对 `Authorization: Bearer`、`x-api-key` 或 `x-goog-api-key`（Google SDK 风格）用正则 `user_[a-zA-Z0-9_-]+` 提取，自动清理多余路径/前缀，`sk-xxx` 等非 `user_` 格式拒 |
| **流式超时保护** | 流式 30s、非流式 90s → 429 + SDK 自动重试 |
| **连续超时阈值** | 连续 3 次超时后才提示压缩上下文 |
| **零输出防护** | outputTokens=0 → 429 `rate_limit_error`（SDK 自动重试，反异常计费） |
| **上游中止** | 客户端断连 + 全部错误路径 `AbortController` 打断 CC |
| **隐私保护日志** | 日志不含 API Key 片段、错误 body、stack trace |

## 协议细节

### CC API 请求体结构

```json
{
  "config": {
    "workingDir": "C:\\project",
    "date": "2026-06-07",
    "environment": "win32-x64, Node.js v24.16.0",
    "structure": [],
    "isGitRepo": false,
    "currentBranch": "",
    "mainBranch": "",
    "gitStatus": "",
    "recentCommits": []
  },
  "memory": null,
  "taste": null,
  "skills": "",
  "permissionMode": "standard",
  "params": {
    "model": "deepseek/deepseek-v4-flash",
    "messages": [...],
    "max_tokens": 64000,
    "stream": true,
    "reasoning_effort": "max"
  }
}
```

条件字段：`system`（从 system 消息提取）、`temperature`、`reasoning_effort`、`tools`（映射为 CC `input_schema` 格式）。

### CC API 图片消息格式

CLI 发送图片的格式：

```json
{
  "role": "user",
  "content": [
    { "type": "image", "image": "data:image/jpeg;base64,..." },
    { "type": "text", "text": "图里写了什么" }
  ]
}
```

代理收到 OpenAI `image_url` 格式后自动转为上述 CC 格式透传。

## Docker 部署

> **注意**：下方 GHCR 镜像 `ghcr.io/maxeaglet/commandcode-proxy` 由**上游仓库**的 Actions 构建，是**原版代理**，不含本二开的多账号池与管理面板。要跑二开版本请用[从源码构建](#从源码构建)或自行构建镜像。

### 从 GHCR 拉取

每次打 `v*` tag 时 GitHub Actions 会自动构建并推送多架构镜像（`linux/amd64` + `linux/arm64`）到 GitHub Container Registry：

```bash
docker pull ghcr.io/maxeaglet/commandcode-proxy:latest
docker run -d --name cc-proxy -p 3050:3050 -e PORT=3050 ghcr.io/maxeaglet/commandcode-proxy:latest
```

每次发版都会更新 `latest` 标签。镜像为公共可见，拉取无需登录。

### 快速启动 (docker compose)

```bash
docker compose up -d
```

代理将在 `http://0.0.0.0:3050` 监听。compose 已把命名卷 `ccpool-data` 挂到容器的 `/app/data`，账号池状态（账号、虚拟 Key、统计、额度缓存、面板密码）会跨容器重建保留。通过 `PROXY_PORT` 自定义主机端口：

```bash
PROXY_PORT=13050 docker compose up -d
```

### 从源码构建

```bash
docker build -t commandcode-proxy:latest .
docker run -d --name cc-proxy -p 3050:3050 -e PORT=3050 \
  -v ccpool-data:/app/data \
  commandcode-proxy:latest
```

镜像内 `/app/data` 是账号池状态目录（由 `CCPOOL_DATA_DIR` 指定）。**务必挂卷**，否则容器重建时账号池、虚拟 Key 与统计会一起丢失。

### 多架构构建

```bash
npm run docker:build:multi
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3050` | 容器内监听端口 |
| `PROXY_PORT` | `3050` | 主机映射端口（仅 compose） |
| `CCPOOL_DATA_DIR` | `./data`（镜像内为 `/app/data`）| 账号池状态目录，见[数据与安全](#数据与安全) |
| `CC_MAX_BODY_MB` | `100` | 请求体大小上限（MB），超限请求返回 `HTTP 413` |
| `CC_CLIENT_DRAIN_TIMEOUT_MS` | 空（禁用）| 下游背压阻塞超过该毫秒数则断开该客户端并中止上游请求，见[僵死连接](#僵死连接既不读也不断开) |
| `CC_STREAM_IDLE_MS` | `30000` | 流式上游读空闲超时（毫秒），见[上游空闲超时](#上游空闲超时) |
| `CC_NONSTREAM_IDLE_MS` | `90000` | 非流式上游读空闲超时（毫秒）|
| `CC_MAX_INFLIGHT` | `0`（不限）| 进程内在途请求上限，超限返回 `503` + `Retry-After`，见[在途上限](#在途请求上限可选) |

## 在途请求上限（可选）

**默认关闭**（`CC_MAX_INFLIGHT` 未设置 = 不限制并发），既有行为不变。

本项目定位是**纯反代层**，并发控制属于下游 —— 按 IP / 按 key 的限流请用反向代理（见[内存与部署](#内存与部署)里的 `limit_conn`）。
本项**不是**那套方案的替代品，只为「不挂反代裸跑」（Dockerfile 与 `npm start` 都支持这种用法）提供一个**进程内、仅全局**的兜底：

```bash
CC_MAX_INFLIGHT=32 npm start    # 最多同时处理 32 个请求
```

超限时快速返回 `503` + `Retry-After: 5` + `type: server_busy` —— OpenAI / Anthropic 官方 SDK 认得这个组合会自动退避重试，而不是拿到连接被重置。`/health` 与 `/` 不计入、也不受限制，避免探活与编排器因业务繁忙收到 503。

**为什么需要它**：内存 = `在途数 × (0.13MB + 5.5 × body_MB)`。`CC_MAX_BODY_MB` 只管住**单请求**量级，乘数无人管 —— 默认 100MB 时 N 个并发最坏可达 N × 550MB。

> ⚠️ 开启本项**不等于**内存安全：32 × 550MB 仍远超小机器容量。要拿到硬性上界，需**同时**下调 `CC_MAX_BODY_MB`。

## 上游空闲超时

两个上游读空闲看门狗，超时后返回 `429`（带 `retry_after`）让 SDK 自动重试：

| 环境变量 | 默认 | 作用于 |
|---|---|---|
| `CC_STREAM_IDLE_MS` | `30000` | 流式请求 |
| `CC_NONSTREAM_IDLE_MS` | `90000` | 非流式请求 |

**语义**：只计「`reader.read()` 的等待时间」，每收到一个 chunk 就重置 —— **不是整个请求的总时长**。
只要上游在持续吐流就不会触发，哪怕单个请求已经跑了几十分钟。

**默认值与官方 CLI 不一致，这是已知取舍**（[#19](https://github.com/MAXeaglet/commandcode-proxy/issues/19)）：
官方 CLI 对上游**没有任何** idle timeout —— 反编译 `command-code@1.50.0` 可见所有 `createApiClient({ baseUrl })` 调用点都未传 `timeout`，实测 700+ 秒的停顿可正常完成。
本代理保留 30s 是为了兜住真正死掉的连接；代价是**推理模型的长思考停顿可能被误杀**。

若遇到「`429 Response timeout`」「`zero output tokens`」且日志里 `elapsedMs ≈ 30000`、`bytesReceived = 0`，
说明是看门狗误杀了 prefill / 首 token 阶段的正常停顿 —— 调大即可：

```bash
CC_STREAM_IDLE_MS=300000 npm start      # 5 分钟
```

> ⚠️ 误杀的成本不止一次失败：被 abort 后返回 `429 + retry_after`，SDK 会自动重试，
> 而重试等于**完整重发整个上下文**，长会话下每次误杀都要重付一次全量 prefill。

## 内存与部署

> 数据来自 [issue #20](https://github.com/MAXeaglet/commandcode-proxy/issues/20) 的实测复现（Node v24，loopback mock 上游）。

单请求内存开销的经验公式：

```
RSS ≈ 70 MB + 在途请求数 × (0.13 MB + 5.5 × body_MB)
```

### 流式响应已做背压

`res.write()` 返回 `false`（socket 写缓冲超过 `highWaterMark`）时会暂停读取上游，响应不再在内存中无界堆积：

| 场景（200MB 上游流，客户端发完请求即停止读取） | 峰值 RSS 增量 |
|---|---|
| 修复前 | **+586 MB**（66 → 652 MB）|
| 修复后 | **+4 MB**（背压一路传回上游，上游只吐出 ~8MB 即停住）|

这不只是恶意客户端问题 —— 弱网/移动端、客户端卡在工具执行、客户端已放弃但 TCP 还没发 RST，都会触发。

### 请求体放大 ~5.5×

body 在转发到上游前同时存在多份副本：`chunks[]` / `Buffer.concat` / utf8 字符串 / `JSON.parse` 对象树 / `buildCcRequest` 重建对象树 / `JSON.stringify` 序列化体。

| body | 上限 | 峰值增量 | 结果 |
|---|---|---|---|
| 7 MB | 100 MB | +52 MB（7.4×）| 200 |
| 20 MB | 100 MB | +116 MB（5.8×）| 200 |
| 20 MB | 8 MB | +21 MB（1.05×）| **413** |

启动时若隐含最坏峰值 ≥ 500MB，日志会输出 `warn` 提示。上限是**按请求**的，proxy 自身没有在途限流 —— 公网部署必须在反向代理层补上。

### nginx 反代建议

`client_max_body_size` 在 nginx 拒绝时，body 根本不会进入 Node 进程：

```nginx
map $http_authorization $cc_key { default $http_authorization; "" $http_x_api_key; }
map "" $cc_global_key { default "global"; }

limit_conn_zone $binary_remote_addr zone=cc_ip:10m;
limit_conn_zone $cc_key             zone=cc_key:10m;
limit_conn_zone $cc_global_key      zone=cc_global:10m;

location /v1/ {
    client_max_body_size 4m;   # 需 <= CC_MAX_BODY_MB
    limit_conn cc_ip     8;
    limit_conn cc_key    4;
    limit_conn cc_global 32;   # 这一项就是内存天花板
    limit_conn_status 429;
    proxy_pass http://127.0.0.1:3050;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 300s;   # 需大于 30s 的流空闲超时
}
```

### 僵死连接（既不读也不断开）

背压生效后，客户端**既不读也不断开**时该请求会连带上游连接一直挂着。实测残留在途成本：

| 僵死连接数 | RSS 增量 | 上游连接持有 |
|---|---|---|
| 1 | +5 MB | 1 |
| 10 | +45 MB | 10 |
| 50 | +248 MB | 50（**永久持有**）|

特性是**有界、不泄漏、客户端断开即回收**（RSS 曲线完全持平），但**连接数本身无上限**。

默认**不处理**，因为僵死客户端与「卡在工具执行的合法客户端」在协议层无法区分；且官方 CLI 对上游没有任何 idle timeout（见 [#19](https://github.com/MAXeaglet/commandcode-proxy/issues/19)），贸然加超时会重蹈「误杀健康请求」。

需要封顶时启用（opt-in）：

```bash
# 下游持续阻塞超过 60s 才断开，正常客户端只要在推进 drain 就不会触发
CC_CLIENT_DRAIN_TIMEOUT_MS=60000 npm start
```

启用后实测（50 个僵死连接）：上游连接持有数由 **50（永久）→ 0**，且丢弃后**不会**继续抽干上游。

更稳妥的封顶仍在反向代理层（`limit_conn`），因为只有它知道该部署能承受多少并发。

### 其它注意事项

- **`logFile` 是同步写**（`appendFileSync`），公网负载下会阻塞事件循环 —— 建议保持留空，从 stdout 收集。
- **systemd 兜底**：配 `MemoryMax=` 与 `NODE_OPTIONS=--max-old-space-size=`，让超限杀掉 proxy 而不是 `sshd`/`nginx`。
- **多账号 + 多实例**：`sessionStore` / `keyStateStore` 是进程内 `Map`。同一个 API key 打到两个实例会得到两个不同 session 与**两个不同设备指纹**，上游会看到「一个账号在多台机器上」。横向扩展请按 API key 做一致性哈希（`hash $cc_key consistent`），不要轮询。

## 免责声明

本项目仅供**学习和研究**使用。

- **非官方**：本项目与 Command Code 无任何关联，非官方产品。
- **个人使用**：使用者应自行承担所有责任。请遵守 [Command Code 服务条款](https://commandcode.ai/tos)。
- **API Key**：本项目不会收集、上传或泄露你的 API Key。Key 通过每次请求的 `Authorization: Bearer <key>` 或 `x-api-key` 头传入，日志中不记录；`config.json` 中的可选 `apiKey` 字段仅作本地兜底，不会离开你的机器。
- **合规性**：协议基于对本地 CLI 网络流量的被动观察，未对服务端进行任何未授权访问、破解或篡改。
- **账号风险**：建议和正常 CLI 使用频率保持一致，超高并发调用可能触发风控。

---

[Linux.do](https://linux.do)

## 多账号池与管理面板（二开）

> 本节描述本仓库相对上游 [MAXeaglet/commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy) 的二次开发内容。
> 原有的 OpenAI / Anthropic / Responses 兼容端点、上游协议对齐、指纹伪装、超时与背压逻辑**未做修改**。

### 它解决什么问题

原版是「纯反代」：调用方每次请求自带一个 `user_*` 上游 Key，一个客户端 = 一个账号。
本二开在此基础上增加了**账号池**与**面板**：

- **多账号池**：把多个 `user_*` Key 收进池子，对下游只暴露虚拟 Key（`sk-ccp-*`）
- **自动调度**：按策略轮询选号，不可用账号（禁用 / 异常 / 冷却中）自动跳过
- **故障转移**：上游返回 401/402/403/429/5xx 时，自动换一个账号重试（客户端无感知）
- **健康状态机**：Key 失效自动禁用，限流自动冷却，冷却到期自动恢复
- **用量统计**：账号级 / 虚拟 Key 级 / 天级 token 与请求数统计，保留 30 天
- **Web 面板**：账号管理、虚拟 Key 发放、请求日志、调度设置、密码管理

### 快速开始

```bash
npm start
```

启动后：

1. 浏览器打开 `http://127.0.0.1:3050/admin`（端口同代理，路径 `/admin`）
2. 首次登录密码为 `admin123`（**登录后请立即到「设置」修改**）
3. 在「上游账号池」粘贴一个或多个 `user_*` Key（每行一个，支持批量）
4. 在「虚拟 Key」创建一个 `sk-ccp-*` Key
5. 客户端把 Base URL 指向本服务，API Key 填该虚拟 Key

代理启动日志会打印池子状态：

```
[info] CC Proxy started {... "pool":"enabled (3 upstream accounts) — admin panel: http://0.0.0.0:3050/admin"}
```

### 客户端接入

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer sk-ccp-xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

Anthropic SDK 用 `x-api-key: sk-ccp-...`，Base URL 指向 `http://127.0.0.1:3050`。
`/v1/messages`、`/v1/responses`、`/v1/models` 行为与接入方式同原版。

**向后兼容**：请求头里直接传上游 `user_*` Key 依然可用，此时请求**不经过池子**（等同于原版行为），也不计入池子统计。两种模式可以并存。

### 调度与容错

| 机制 | 说明 | 面板可配置 |
|------|------|-----------|
| 调度策略 | `round_robin`（默认）/ `least_used` / `random` / `sticky` | 是 |
| 限流冷却 | 402/429 → 账号暂停，时长取上游 `Retry-After`，缺省用配置值（默认 60s） | 是 |
| 网络冷却 | 5xx / 连接失败 → 短冷却（默认 30s） | 是 |
| 认证失败 | 401/403 → 标记 `Key 异常`，可选自动禁用 | 是 |
| 换号重试 | 上游拒绝时最多换 3 个账号重试（仅在尚未向客户端写数据时） | 固定 |
| 冷却恢复 | 冷却到期自动回到可用状态；也可在面板手动「重置」 | — |
| 单账号并发上限 | 限制同一账号的同时在途请求数，超出返回 503 + 短重试提示，交由客户端 SDK 退避重试 | 是 |
| 单账号派发间隔 | 同一账号两次请求的最小间隔，贴近正常 CLI 使用频率以降低风控风险 | 是 |
| 额度耗尽跳过 | 额度数据显示任一滚动窗口 `exceeded` 或月度余额归零的账号直接不参与选号；全池耗尽时返回 503，`Retry-After` 取最近的窗口重置点 | 自动 |

**选号过滤**：所有策略共用一个可用池——禁用、`Key 异常`、冷却中、达到单账号并发上限、未到派发间隔的账号，以及本轮重试中刚失败的那个账号，都不参与选号。

**四种策略的取舍**：

| 策略 | 选号方式 | 适用场景 |
|------|----------|----------|
| `round_robin` | 全局游标在账号列表上轮转，跳过不可用账号 | 默认；想让用量均匀摊到所有账号 |
| `least_used` | 取累计请求数最少的账号 | 账号额度差异大，想先榨干用得少的 |
| `random` | 随机 | 不想有明显轮转规律 |
| `sticky` | 同一虚拟 Key 固定复用上次的账号；该账号不可用或**额度耗尽**时才换号并转移绑定 | 在意 prompt 缓存命中与对话连续性 |

**关于粘性**：上游按账号维度维护会话与 prompt 缓存。轮询意味着同一客户端的连续请求散到不同账号，每个账号都要重新预热缓存——省不了钱也慢一截。`sticky` 把同一个虚拟 Key 钉在一个账号上保缓存命中，代价是用量集中在少数账号上（更容易先撞到窗口限额）。绑定的账号被禁用/冷却/**额度耗尽**时不会阻塞请求，会自动换号并把绑定一起转移过去；原账号恢复后也不会自动回切（否则会反复撞刚失败的账号）。绑定随虚拟 Key 持久化，重启进程后仍生效。

**手动切换与取消**：额度卡片上每个账号都有「粘住」按钮（只有一个启用 Key 时是快捷开关；有多个 Key 时提示到「虚拟 Key」页逐个指定）。「虚拟 Key」页的「粘性账号」列是**下拉框**，这才是主入口：选某个账号 = 该 Key 固定走它；选「不粘（每次按策略调度）」= **取消粘性**。`PATCH /admin/api/vkeys/:id` 的 `lastAccountId` 字段（传空串解绑）。

**「取消粘性」是持久状态，不是清空一次**：解绑会把该 Key 标记为 `stickyOff`，此后 sticky 策略**不再自动回写**绑定——否则下一次请求又会把绑定粘回来，用户看到的就是「点了取消没用」。重新在下拉里指定账号即恢复粘性（`stickyOff` 复位）。这一点在 `verify6` 里有专门的回归用例守着。

零输出与上游空闲超时**不冷却账号**：这两类现象多为模型侧或请求侧问题（见上文[上游空闲超时](#上游空闲超时)），冷却账号只会让池子整体不可用。它们仍会记录到请求日志。

虚拟 Key 支持**请求配额**与**有效期**，超额返回 `429`，过期/禁用返回 `401`。

### 面板功能

- **仪表盘**：今日请求与 tokens、可用账号数、状态分布、近 7 日请求曲线、最近请求
- **用量限额**：每个上游账号一张额度卡，含 5 小时 / 周 / 月度三条进度条与重置倒计时（见下节）
- **上游账号池**：批量添加、启用/禁用、单个测试连通性、一键测试全部、重置状态、删除
- **虚拟 Key**：创建（名称/配额/有效期）、一键复制、启用/禁用、删除、配额进度
- **请求日志**：时间、虚拟 Key、账号、端点、模型、状态码、token 明细、耗时、错误；全部展示（内存保留 2 万条，重启后仍保留 3 千条），顶部可按「今天 / 昨天 / 近24小时 / 近 7 天 / 近 14 天 / 近 30 天 / 本月 / 上月」一键筛选，或用开始/结束日期自定义区间（接口：`GET /admin/api/logs?from=<ms>&to=<ms>`，均含边界，省略即不过滤）
- **设置**：调度策略、冷却时长、自动禁用、单账号并发/节流、额度自动刷新间隔、修改管理密码

### 用量限额（Usage Limits）

仪表盘以卡片矩阵展示每个上游账号的额度，形态对齐官方用量面板。百分比与进度条都以**剩余**为主视角（剩余越多条越长），颜色则按已用比例分级，一眼能看出哪个账号快用满：

```
主账号  [Go]                       详情  刷新  删除
月度剩余 4.1    充值余额 0    免费额度 0
5-Hour Limit                     剩余 89.8%
███████████████████████░░
已用 0.4 / 3                   剩余 2.6 · 3 小时 56 分钟后重置
Weekly Limit                     剩余 3.2%
█░░░░░░░░░░░░░░░░░░░░░░░░░
已用 5.8 / 6                   剩余 0.2 · 5 天 0 小时后重置
Monthly Limit                    剩余 41.9%   上限按套餐推算
███████████░░░░░░░░░░░░░░░
已用 5.8 / 10                  剩余 4.2 · 28 天 0 小时后重置
```

点「详情」展开该账号的账期统计（数据来自 `/alpha/usage/summary`）：累计请求、成功率、成功 / 失败、累计消耗 credits、Tokens 进 / 出、单均成本、统计口径（如 `billing-period`）。
卡片还提供「粘住 / 取消粘住」（手动指定虚拟 Key 的粘性账号，见[调度与容错](#调度与容错)）、「刷新」（重新拉取该账号额度）与「删除」。**添加账号后后端会自动为新账号拉取一次额度**，几秒后卡片即有数据，无需手动刷新。

**窗口耗尽预测**：5 小时与周窗口会按「窗口内平均消耗速率」推算何时打满（`预计 2 小时 24 分钟后打满`，参考 CLIProxyAPI 生态的 run-rate forecast 做法）。只在按当前速率撑不到窗口结束、且窗口已过 5 分钟（样本足够）时才显示；月度按账期推算，账期长度不固定所以不做预测。

### 用量分布（按 Key / 按模型）

仪表盘「用量分布」面板把近 7 日请求按**虚拟 Key** 与**模型**两个维度排行（可切换）：请求数、成功率、tokens 量，条形长度按占比。数据由 `state.daily` 的维度聚合产生——每个自然日记录 `byKey` / `byModel` 桶，只保留 7 天，不需要额外数据库。

### 账号批量运维

账号页顶部提供三个批量操作，账号多时不用逐个点：

| 操作 | 行为 |
| --- | --- |
| 全部启用 | 启用所有账号并清空冷却与错误标记 |
| 全部禁用 | 禁用所有账号（池子停止派发，需确认） |
| 清理失效 | 删除所有「已禁用且 Key 异常（401/403）」的账号；删除时会自动解绑指向它们的粘性绑定 |

对应的 API：`POST /admin/api/accounts/bulk`（`{ action: 'enable' \| 'disable' \| 'reset' \| 'delete', ids }`，`delete` 必须显式给 `ids`，防止误删全部）与 `POST /admin/api/accounts/prune`。

### 虚拟 Key 限额

除了总量配额（`quotaRequests`）与有效期，虚拟 Key 还支持**每日请求上限**（`limitDaily`，创建或 `PATCH` 时设置）：按自然日统计当日已派发请求数，超限返回 429 并带「距本地零点」的 `retry_after`。虚拟 Key 表新增「今日 / 日限额」列，可直接看到当日用量与进度条。被限额挡下的请求不计入当日用量（否则计数永远追不上限额）。

数据来自上游 `/alpha/*` 端点（未公开文档，解析层已做防御性兼容）：

| 端点 | 数据 |
|------|------|
| `/alpha/whoami` | 账户身份 + orgId |
| `/alpha/billing/credits` | 余额 + `windowLimits.{fiveHour,weekly}`（used/cap/exceeded/resetAt） |
| `/alpha/billing/subscriptions` | 套餐 planId、账期结束时间（带 `?orgId=`） |
| `/alpha/usage/summary` | 账期内请求数、成功率、tokens 进出、消耗 |

要点：

- **5 小时 / 周窗口取上游权威数据**；**月度是推算值**——上游没有 monthly 窗口对象，上限按套餐映射，已用 = 上限 − 月度剩余，重置点取账期结束。面板会标注「按套餐推算」，未知套餐自动隐藏该条
- 套餐映射（社区对官方 CLI 的逆向结论，官方未文档化）：Go 10 / GOAT 70 / Pro 30 / Pro-v1 80 / Provider 15 / Max 150 / Ultra 300 / Teams Pro 40 credits
- 字段容错：窗口与余额同时兼容 camelCase 与 snake_case（`used_credits`、`monthly_credits`、`reset_at`），时间戳兼容 epoch 秒、epoch 毫秒与 ISO 字符串
- 视角：百分比与进度条长度都是**剩余**，颜色按**已用**比例分级（<50% 绿 / <75% 黄 / <90% 橙 / ≥90% 红）——条越短、颜色越红就代表越接近上限；重置文案按剩余时长自动切换为「X 分钟后重置 / X 小时后重置 / X 天 Y 小时后重置 / X 月 X 日重置」
- 成功率字段上游给的是百分数（如 `100`），不是 0-1 比例，直接按百分数显示；累计 Tokens 用亿 / 万单位，单均成本保留 4 位小数
- 额度查询**不产生副作用**：不改动账号启用状态与冷却，Key 被拒只在卡片上标红提示（与代理请求路径的判定相互独立）
- 刷新方式：卡片上的单账号「刷新」、面板右上「刷新额度」（最多 12 个账号）、或在设置里开启「额度自动刷新」（按分钟间隔后台补刷，**默认关闭**）
- 每次刷新会对该账号打 4 次上游请求，所以默认不做自动轮询：额度查询本身也要贴近正常 CLI 频率
- 额度查询并发固定为 4，避免批量刷新打爆上游

### 文件结构（新增部分）

```
commandcode/
├── proxy.mjs             # 原单文件代理（仅做少量集成改动，见下）
├── pool.mjs              # 【新增】账号池：持久化 / 调度 / 冷却 / 并发与节流 / 记账 / 虚拟 Key / 额度 / 面板鉴权
├── admin.mjs             # 【新增】面板后端：/admin 页面与 /admin/api/* 接口
├── public/
│   └── admin.html        # 【新增】面板前端（原生 HTML/CSS/JS，无构建、无外部依赖）
├── tests/                # 【新增】本地验收脚本：mock 上游 + 4 套端到端验证 + 前端完整性检查
└── data/
    └── pool.json         # 【运行时生成】池子状态（账号、虚拟 Key、统计、日志、额度缓存、密码哈希）
```

`proxy.mjs` 的改动集中在四处：模块导入与集成 helper、各端点入口的 Key 解析（`resolveRequestKey`）、上游拒绝时的换号循环、成功/失败路径的用量记账，以及 `/admin` 路由挂载。其余协议逻辑保持原样。

### 数据与安全

- `data/pool.json` 由进程**原子写入**（临时文件 + rename），内存态为准，节流落盘（2s）+ 退出时 flush
- 管理密码使用 **scrypt** 加盐哈希存储；面板登录令牌为 **HMAC-SHA256 签名**，有效期 7 天
- 修改密码会轮换签名密钥，**所有已签发令牌立即失效**
- 面板列表中的账号 Key 一律**掩码显示**（`user_ok1…1111`），不提供完整 Key 回显
- 日志与状态文件中**不含**完整上游 Key
- 可用 `CCPOOL_DATA_DIR` 指定数据目录（默认 `./data`），便于容器挂载卷

```bash
CCPOOL_DATA_DIR=/var/lib/ccpool npm start
```

### 部署详情（Docker Compose，实测 fnOS NAS）

本仓库在飞牛 fnOS NAS（Debian 12 · x86_64 · Docker 28 · Compose v2.40）上长期运行。仓库自带的 [docker-compose.yml](docker-compose.yml) 即生产形态：构建镜像、映射端口（宿主端口可用 `PROXY_PORT` 调整）、`ccpool-data` 卷持久化全部状态、内置 `/health` 健康检查（wget，30s 间隔）、`restart: unless-stopped`。

```bash
# 部署 / 升级（数据在卷里，重建容器不丢）
docker compose up -d --build
docker compose logs -f proxy

# 换宿主端口（例如与上游官方实例 3050 共存时用 3051）
PROXY_PORT=3051 docker compose up -d --build
```

| 事项 | 说明 |
| --- | --- |
| 数据持久化 | 全部运行时状态在 `ccpool-data` 卷的 `pool.json`（账号、虚拟 Key、统计、日志、密码哈希）；备份即备份该文件，升级不动它 |
| 面板 | `http://<host>:<端口>/admin`，首次登录密码 `admin123`，登录后立即修改 |
| 健康检查 | 容器内置（`wget /health`），宿主机亦可 `curl http://<host>:<端口>/health` |
| 与上游共存 | 上游官方镜像占用 3050 时，本 fork 用 `PROXY_PORT=3051`，数据目录独立互不影响 |
| 部署验证 | `BASE=http://<host>:<端口> node tests/verify.mjs`（六套共 176 项后端断言 + 74 项渲染断言，见 [tests/README.md](tests/README.md)） |

NAS 变体（bind mount 更利于直接备份/查看）：把 `ccpool-data:/app/data` 换成 `./data:/app/data`。

### 部署提示

面板默认与代理同端口同路径。若要暴露到公网，请：

- 在反向代理层为 `/admin` 增加访问控制（IP 白名单 / Basic Auth / 内网仅可达）
- 保持 `limit_conn` 等并发限制配置（见[内存与部署](#内存与部署)）——池子解决的是**账号维度**的故障转移，不改变单进程内存模型
- 多实例部署时**仍不可**用轮询负载均衡：`sessionStore` / 指纹是进程内的，同一上游账号打到两个实例会被上游视为两台设备。按虚拟 Key 做一致性哈希，或只跑单实例

## 开发

```bash
# 带 watch 模式启动（文件修改自动重启）
npm run dev
```
