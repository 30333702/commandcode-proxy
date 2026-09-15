/**
 * 本地 mock 上游：模拟 Command Code API，用于端到端验证账号池行为。
 * 按 Authorization 里的 key 前缀决定行为：
 *   user_ok*   → 正常返回 NDJSON 流（含 totalUsage）
 *   user_rate* → HTTP 429 + retry-after
 *   user_bad*  → HTTP 401
 */
import http from 'http';

const PORT = Number(process.env.MOCK_PORT || 39999);

const MODELS = [{ id: 'deepseek/deepseek-v4-flash' }, { id: 'claude-sonnet-4-6' }, { id: 'gpt-5.5' }];

const ndjson = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const key = String(req.headers['authorization'] || '').replace('Bearer ', '').trim();
    const url = req.url || '';
    const tag = key.slice(0, 12) || '(none)';

    if (url.startsWith('/alpha/fingerprint/record') || url.startsWith('/alpha/lifecycle-events')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    // ── 额度相关端点（Usage Limits）──
    // 默认形态对齐参考实现的面板数值：5h 27% / 周 66% / 月度 40%（Pro，上限 30，剩余 18）
    if (url.startsWith('/alpha/whoami')) {
      if (key.startsWith('user_bad')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"invalid api key"}}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        user: { id: 'u_' + tag, name: 'Mock ' + tag, userName: tag },
        org: { id: 'org_mock' },
      }));
      return;
    }

    if (url.startsWith('/alpha/billing/credits')) {
      if (key.startsWith('user_bad')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"invalid api key"}}');
        return;
      }
      // snake_case 形态：验证解析层对 used_credits / monthly_credits / reset_at(ISO) 的兼容
      if (key.startsWith('user_snake')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: {
            credits: { monthly_credits: 25, purchased_credits: 1, free_credits: 0 },
            windowLimits: {
              limited: false,
              exceeded: '',
              five_hour: { used_credits: 5, capCredits: 10, reset_at: new Date(Date.now() + 3600 * 1000).toISOString() },
              weekly: { used: 2, cap: 10, reset_at: Math.floor(Date.now() / 1000) + 6 * 24 * 3600 },
            },
          },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        credits: { monthlyCredits: 18, purchasedCredits: 5, freeCredits: 2, belowThreshold: false, planId: 'individual-pro' },
        windowLimits: {
          limited: false,
          exceeded: key.startsWith('user_rate') ? 'fiveHour' : '',
          fiveHour: {
            used: key.startsWith('user_rate') ? 10 : 2.7,
            cap: 10,
            exceeded: key.startsWith('user_rate'),
            resetAt: Date.now() + 55 * 60 * 1000,
          },
          weekly: { used: 6.6, cap: 10, exceeded: false, resetAt: Date.now() + (5 * 24 + 1) * 3600 * 1000 },
        },
      }));
      return;
    }

    if (url.startsWith('/alpha/billing/subscriptions')) {
      if (key.startsWith('user_bad')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"invalid api key"}}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: {
          planId: 'individual-pro',
          status: 'active',
          currentPeriodEnd: Date.now() + 20 * 24 * 3600 * 1000,
          cancelAtPeriodEnd: false,
        },
      }));
      return;
    }

    if (url.startsWith('/alpha/usage/summary')) {
      if (key.startsWith('user_bad')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"invalid api key"}}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: {
          // 字段与真实上游一致：successRate 是百分数（不是 0-1 比例）
          totalCount: 3537, totalCost: 5.9, averageCost: 0.0017, successRate: 100,
          completedCount: 3537, failedCount: 0, totalTokensIn: 512000000, totalTokensOut: 3805000,
          totalCredits: 5.9, periodBasis: 'billing-period',
        },
      }));
      return;
    }

    if (url.startsWith('/provider/v1/models')) {
      if (key.startsWith('user_bad')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"invalid api key"}}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: MODELS }));
      return;
    }

    if (url.startsWith('/alpha/generate')) {
      if (key.startsWith('user_bad')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"invalid api key"}}');
        return;
      }
      if (key.startsWith('user_rate')) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '30' });
        res.end('{"error":{"message":"rate limited"}}');
        return;
      }
      // user_toll*：generate 限流但额度端点正常——用于验证 429 → 冷却路径
      //（user_rate* 的额度端点标记 exceeded，会被选号直接跳过，走不到 429）
      if (key.startsWith('user_toll')) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '30' });
        res.end('{"error":{"message":"rate limited (toll fixture)"}}');
        return;
      }
      if (key.startsWith('user_slow')) {
        // 慢响应：用于验证单账号并发上限
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.end(ndjson([
            { type: 'text-start' },
            { type: 'text-delta', text: `[slow:${tag}]` },
            { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 5, outputTokens: 3, cachedInputTokens: 0 } },
          ]));
        }, Number(process.env.MOCK_SLOW_MS || 700));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(ndjson([
        { type: 'text-start' },
        { type: 'text-delta', text: `[served-by:${tag}]` },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 42, outputTokens: 7, cachedInputTokens: 12 } },
      ]));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock] upstream listening on http://127.0.0.1:${PORT}`));
