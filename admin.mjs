/**
 * CCPool 管理面板后端：/admin 路由（HTML 页面 + JSON API）
 * 前端页面见 public/admin.html（原生 HTML/CSS/JS，无构建步骤）。
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  poolVerifyPassword, poolIssueToken, poolVerifyToken, poolChangePassword,
  poolListAccounts, poolAddAccounts, poolPatchAccount, poolDeleteAccount,
  poolBulkAccounts, poolPruneAccounts,
  poolResetAccount, poolTestAccount, poolListVkeys, poolCreateVkey,
  poolPatchVkey, poolDeleteVkey, poolGetSettings, poolUpdateSettings,
  poolOverview, poolLogs, poolToggleAccount,
  poolUsageSnapshot, poolRefreshUsage, poolRefreshAllUsage, poolMaybeRefreshUsage,
} from './pool.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
let htmlCache = null;

function adminHtml() {
  if (!htmlCache) {
    htmlCache = readFileSync(join(__dirname, 'public', 'admin.html'), 'utf8');
  }
  return htmlCache;
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid json body'));
      }
    });
    req.on('error', reject);
  });
}

function bearerToken(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return req.headers['x-admin-token'] || '';
}

export async function handleAdmin(req, res, url) {
  const path = url.pathname;
  if (path === '/admin' || path === '/admin/') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(adminHtml());
    return;
  }
  if (!path.startsWith('/admin/api/')) {
    json(res, 404, { ok: false, error: 'not found' });
    return;
  }

  const route = path.slice('/admin/api/'.length);
  try {
    // 登录是唯一免鉴权端点
    if (route === 'login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!poolVerifyPassword(String(body.password || ''))) {
        json(res, 401, { ok: false, error: '密码错误' });
        return;
      }
      const settings = poolGetSettings();
      json(res, 200, {
        ok: true,
        token: poolIssueToken(),
        mustChangePassword: !!settings.firstRun,
      });
      return;
    }

    if (!poolVerifyToken(bearerToken(req))) {
      json(res, 401, { ok: false, error: '未登录或登录已过期' });
      return;
    }

    const seg = route.split('/');
    const rest = seg.slice(1).join('/');

    switch (seg[0]) {
      // ── 概览 ──
      case 'overview':
        if (req.method === 'GET') { json(res, 200, { ok: true, data: poolOverview() }); return; }
        break;

      // ── 账号 ──
      case 'accounts': {
        if (req.method === 'GET' && !rest) {
          json(res, 200, { ok: true, data: poolListAccounts() });
          return;
        }
        if (req.method === 'POST' && !rest) {
          const { keys, names } = await readJsonBody(req);
          const result = poolAddAccounts(keys, names);
          // 新账号自动拉一次额度（不阻塞响应；面板的添加回调与轮询会拿到数据）
          for (const id of result.addedIds || []) poolRefreshUsage(id).catch(() => {});
          json(res, 200, { ok: true, ...result });
          return;
        }
        // 批量运维：POST /accounts/bulk { action, ids }
        if (req.method === 'POST' && rest === 'bulk') {
          const { action, ids } = await readJsonBody(req);
          json(res, 200, poolBulkAccounts(action, ids));
          return;
        }
        // 一键清理失效账号（已禁用 + error）
        if (req.method === 'POST' && rest === 'prune') {
          json(res, 200, poolPruneAccounts());
          return;
        }
        const m = rest.match(/^([^/]+)(?:\/(reset|test|toggle))?$/);
        if (m) {
          const [, id, action] = m;
          if (action === 'reset' && req.method === 'POST') { json(res, 200, poolResetAccount(id)); return; }
          if (action === 'logout' && req.method === 'POST') { json(res, 200, { ok: true }); return; }
          if (action === 'toggle' && req.method === 'POST') {
            const { enabled } = await readJsonBody(req);
            json(res, 200, poolToggleAccount(id, !!enabled));
            return;
          }
          if (action === 'test') {
            if (req.method === 'POST') {
              json(res, 200, { ok: true, ...(await poolTestAccount(id)) });
              return;
            }
            // GET /accounts/:id/test 也允许（浏览器直开测试）
            json(res, 200, { ok: true, ...(await poolTestAccount(id)) });
            return;
          }
          if (!action) {
            if (req.method === 'PATCH') {
              const patch = await readJsonBody(req);
              json(res, 200, poolPatchAccount(id, patch));
              return;
            }
            if (req.method === 'DELETE') {
              json(res, 200, poolDeleteAccount(id));
              return;
            }
          }
        }
        break;
      }

      // ── 虚拟 Key ──
      case 'vkeys': {
        if (req.method === 'GET' && !rest) {
          json(res, 200, { ok: true, data: poolListVkeys() });
          return;
        }
        if (req.method === 'POST' && !rest) {
          const { name, quotaRequests, expiresInDays, limitDaily } = await readJsonBody(req);
          json(res, 200, { ok: true, data: poolCreateVkey({ name, quotaRequests, expiresInDays, limitDaily }) });
          return;
        }
        const [id] = rest.split('/');
        if (id) {
          if (req.method === 'PATCH') {
            const patch = await readJsonBody(req);
            json(res, 200, poolPatchVkey(id, patch));
            return;
          }
          if (req.method === 'DELETE') {
            json(res, 200, poolDeleteVkey(id));
            return;
          }
        }
        break;
      }

      // ── 日志 ──
      case 'logs': {
        if (req.method === 'GET') {
          const sp = new URL(req.url, `http://${req.headers.host}`).searchParams;
          json(res, 200, { ok: true, data: poolLogs({ from: sp.get('from'), to: sp.get('to') }) });
          return;
        }
        break;
      }

      // ── 额度（Usage Limits）──
      case 'usage': {
        if (req.method === 'GET') {
          // 设了自动刷新间隔时后台补刷过期数据；本次先用缓存返回，不阻塞
          poolMaybeRefreshUsage();
          json(res, 200, { ok: true, data: poolUsageSnapshot() });
          return;
        }
        if (seg[1] === 'refresh' && req.method === 'POST') {
          const body = await readJsonBody(req);
          // 刷新失败也返回 200：错误信息在 body 内（面板逐账号展示，不整体报错）
          if (body && body.id) {
            json(res, 200, await poolRefreshUsage(body.id));
            return;
          }
          json(res, 200, await poolRefreshAllUsage());
          return;
        }
        break;
      }

      // ── 设置 / 密码 ──
      case 'settings': {
        if (req.method === 'GET') { json(res, 200, { ok: true, data: poolGetSettings() }); return; }
        if (req.method === 'PATCH') {
          const patch = await readJsonBody(req);
          json(res, 200, { ok: true, data: poolUpdateSettings(patch) });
          return;
        }
        break;
      }
      case 'password': {
        if (req.method === 'POST') {
          const { oldPassword, newPassword } = await readJsonBody(req);
          json(res, 200, poolChangePassword(oldPassword, newPassword));
          return;
        }
        break;
      }

      default:
        break;
    }
    json(res, 404, { ok: false, error: `unknown route: ${route}` });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
}