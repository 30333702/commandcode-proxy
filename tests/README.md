# 验证脚本

在本地用 mock 上游端到端验证账号池、管理面板与额度面板。**不会**访问真实 Command Code API。

## 准备

```bash
# 1) 启动 mock 上游（默认 127.0.0.1:39999）
node tests/mock-upstream.mjs

# 2) 启动代理指向 mock（另开一个终端）
CC_API_BASE=http://127.0.0.1:39999 PORT=3051 CCPOOL_DATA_DIR=./.test-data node proxy.mjs
```

Windows PowerShell：

```powershell
$env:CC_API_BASE='http://127.0.0.1:39999'; $env:PORT='3051'; $env:CCPOOL_DATA_DIR="$PWD\.test-data"; node proxy.mjs
```

## 运行

```bash
BASE=http://127.0.0.1:3051 node tests/verify.mjs    # 面板 + 池子主流程（51 项）
BASE=http://127.0.0.1:3051 node tests/verify2.mjs   # 持久化 + 边界 + 并发（15 项，需先跑 verify.mjs 并重启进程）
BASE=http://127.0.0.1:3051 node tests/verify3.mjs   # 单账号并发上限 + 派发节流 + 换号计数（15 项）
BASE=http://127.0.0.1:3051 node tests/verify4.mjs   # Usage Limits 额度解析、账期统计、添加自动拉取与粘性指定（35 项）
BASE=http://127.0.0.1:3051 node tests/verify5.mjs   # 调度策略：sticky / 额度耗尽换号 / 429 冷却 / least_used（15 项）
BASE=http://127.0.0.1:3051 node tests/verify6.mjs   # 对齐 sub2api/CPA：x-goog-api-key、Key 日限额、用量维度统计、批量运维、失效清理、粘性改绑/取消、日志时间筛选（43 项）
node tests/check-ui.mjs public/admin.html           # 面板前端语法、DOM 锚点、CSS 类与功能点
node tests/render-check.mjs public/admin.html       # 前端渲染验证：DOM stub 执行脚本，检查额度卡片、粘性标记与统计区（53 项）
```

`render-check.mjs` 不需要浏览器与运行中的服务：它注入与 mock 一致的额度数据，断言渲染出的百分比、进度条宽度与颜色、三种重置文案、余额脚注与错误提示。

`verify.mjs` 会把管理密码改成 `newpass123`，`verify3/verify4` 依赖该密码。

## mock 上游行为

| Key 前缀 | `/alpha/generate` | 额度端点 |
|----------|-------------------|----------|
| `user_ok*` | 正常 NDJSON 流（totalUsage：in 42 / out 7 / cached 12） | 5h 27% / 周 66% / 月度 40%（Pro，上限 30 剩余 18） |
| `user_rate*` | HTTP 429 + `retry-after: 30` | 5 小时窗口已用满并 `exceeded`（选号会跳过） |
| `user_toll*` | HTTP 429 + `retry-after: 30` | 正常（用于验证 429 → 冷却路径本身） |
| `user_bad*` | HTTP 401 | 所有额度端点 401（用于验证 Key 被拒短路） |
| `user_slow*` | 延迟 700ms 后返回（验证单账号并发上限） | 正常 |
| `user_snake*` | 正常 | snake_case 字段 + ISO / 秒级时间戳（验证解析容错） |

额度数值刻意对齐官方面板形态：5-Hour 27%、Weekly 66%、Monthly 40%，重置时间覆盖「分钟级 / 天+小时 / 具体日期」三种文案分支。

## 覆盖范围

- 面板鉴权（密码、伪造/过期令牌、改密后旧令牌失效）
- 账号池 CRUD、批量添加、无效/重复行跳过、Key 掩码
- 虚拟 Key 创建/禁用/删除、配额耗尽、有效期
- 三个兼容端点（`/v1/chat/completions` 流式与非流式、`/v1/messages`、`/v1/responses`、`/v1/models`）
- 上游 `user_*` Key 直传透传（不经过池子，行为与原生代理一致）
- 失败处理与状态机（401 自动禁用、429 冷却、手动重置、连通性测试）
- 单账号并发上限与派发节流；换号时在途计数正确转移、无泄漏
- 调度策略：sticky 连续请求固定同一账号、账号不可用或额度耗尽时换号并转移绑定、恢复后不自动回切、绑定可手动指定/解绑（解绑持久为 `stickyOff`，不会被下一次请求自动粘回）；round_robin 分散；least_used 命中累计最少的账号；全池额度耗尽 → 503 带重置时间；429 → 冷却
- 添加账号后自动拉取额度（fire-and-forget，几秒内卡片有数据）
- 客户端认证兼容：`Authorization: Bearer` / `x-api-key` / `x-goog-api-key` 三种头都能取 Key
- 虚拟 Key 日限额：按自然日计数、超限 429 带零点重置时间、解除后立即恢复
- 用量维度统计：近 7 日按虚拟 Key 与按模型聚合（请求数/成功率/tokens）
- 账号批量运维：批量启用/禁用/删除（删除必须显式给 ids）、一键清理失效账号并自动解绑粘性
- 测试用例可重复运行（唯一 key、显式隔离池子状态、设置改动后恢复）
- 用量统计与请求日志（token 明细、失败记录、账号/虚拟 Key 归属）
- Usage Limits：窗口解析、月度推算（上限 − 月度剩余）、套餐识别、重置时间分类、snake_case 与时间戳容错、失败处理无副作用、批量刷新、脱敏
- 账期统计字段（累计请求 / 成功率 / 成功失败 / Tokens / 单均成本 / 统计口径）解析与百分数语义
- 前端渲染：剩余视角百分比与条长、颜色档位、余额行、展开/收起的统计区、接入地址
- 调度策略切换、持久化（进程重启）、全账号不可用时的 503 与恢复、12 并发
