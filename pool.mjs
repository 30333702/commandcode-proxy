/**
 * CCPool 多账号池核心（commandcode-proxy 二开）
 *
 * 职责：
 *  - 上游账号池（user_* key）：增删改查、enabled/status 状态机、冷却与自动禁用
 *  - 调度：round_robin / least_used / random，跳过冷却与不可用账号
 *  - 虚拟下游 Key（sk-ccp-*）：配额、有效期、用量累计
 *  - 用量统计：账号级 + 虚拟 Key 级 + 天级汇总（保留 30 天）
 *  - 请求日志：环形缓冲（内存 500 条 / 落盘 200 条）
 *  - 管理面板鉴权：scrypt 密码哈希 + HMAC 短期令牌
 *
 * 零外部依赖；状态文件 data/pool.json，原子写 + 节流 flush。
 */
import crypto from 'crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CCPOOL_DATA_DIR || join(__dirname, 'data');
const DATA_FILE = join(DATA_DIR, 'pool.json');
const LOG_LIMIT = 20000;        // 内存日志上限（配合面板的时间筛选，全部可见）
const PERSIST_LOG_LIMIT = 3000; // 重启后仍保留的条数
const DAILY_RETENTION = 30;
const FLUSH_INTERVAL_MS = 2000;
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;

const DEFAULT_SETTINGS = {
  strategy: 'round_robin',       // round_robin | least_used | random | sticky
  cooldownSeconds: 60,           // 402/429 冷却时长
  netErrorCooldownSeconds: 30,   // 网络错误/超时冷却
  authErrorDisable: true,        // 401/403 自动禁用账号
  maxConcurrentPerAccount: 0,    // 单账号在途请求上限（0 = 不限）
  minIntervalMs: 0,              // 同一账号两次派发的最小间隔（0 = 不限，防风控节流）
  usageRefreshMinutes: 0,        // 额度自动刷新间隔（0 = 关闭，仅手动刷新）
};

function loadApiBase() {
  // 与 proxy.mjs 的加载顺序保持一致：环境变量优先，其次 config.json
  const fromEnv = process.env.CC_API_BASE;
  if (fromEnv) return String(fromEnv).replace(/\/+$/, '');
  try {
    const cfg = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));
    return String(cfg.apiBase || 'https://api.commandcode.ai').replace(/\/+$/, '');
  } catch {
    return 'https://api.commandcode.ai';
  }
}

const API_BASE = loadApiBase();
let state = null;
let rrCursor = 0;
let dirty = false;

// ── 初始化 / 持久化 ────────────────────────────────
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPasswordHash(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  try {
    const test = crypto.scryptSync(String(pw), salt, 32);
    const expect = Buffer.from(hash, 'hex');
    return test.length === expect.length && crypto.timingSafeEqual(test, expect);
  } catch {
    return false;
  }
}

function defaultState() {
  const admin = {
    passwordHash: hashPassword('admin123'),
    tokenSecret: crypto.randomBytes(32).toString('hex'),
    createdAt: Date.now(),
    firstRun: true,
  };
  return { settings: { ...DEFAULT_SETTINGS }, admin, accounts: [], vkeys: [], logs: [], daily: {} };
}

function loadState() {
  try {
    if (existsSync(DATA_FILE)) {
      const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
      state = {
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
        admin: { ...defaultState().admin, ...(raw.admin || {}) },
        accounts: (Array.isArray(raw.accounts) ? raw.accounts : []).map((a) => ({ ...a, inflight: 0 })),
        vkeys: Array.isArray(raw.vkeys) ? raw.vkeys : [],
        logs: Array.isArray(raw.logs) ? raw.logs : [],
        daily: raw.daily && typeof raw.daily === 'object' ? raw.daily : {},
      };
      return;
    }
  } catch (e) {
    console.error('[pool] failed to load state, starting fresh:', e.message);
  }
  state = defaultState();
  save(true);
}

function flushNow() {
  if (!dirty || !state) return;
  dirty = false;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const snapshot = {
      ...state,
      // inflight 是进程内在途计数，不落盘（否则重启后残留非零值）
      accounts: state.accounts.map(({ inflight, ...rest }) => rest),
      logs: state.logs.slice(-PERSIST_LOG_LIMIT),
    };
    const tmp = DATA_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(snapshot));
    renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('[pool] flush failed:', e.message);
    dirty = true;
  }
}

const save = (immediate = false) => {
  dirty = true;
  if (immediate) flushNow();
};

loadState();
setInterval(flushNow, FLUSH_INTERVAL_MS).unref();
process.on('exit', flushNow);
const gracefulExit = () => { flushNow(); process.exit(0); };
process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);

function newId(prefix) { return `${prefix}_${crypto.randomBytes(4).toString('hex')}`; }
function maskKey(key) {
  if (!key) return '';
  return key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-4)}` : key;
}
function dayKey(ts = Date.now()) { return new Date(ts).toISOString().slice(0, 10); }

// ── 账号选择（调度） ──────────────────────────────
// 运行时字段（不持久化）：inflight = 在途请求数、lastDispatchAt = 上次派发时间

// 额度耗尽判定：任一滚动窗口被上游标记 exceeded，或月度余额归零。
// 只作选号参考（跳过必败账号）；额度数据缺失或拉取失败时不判定——真正的拒绝仍由请求路径兜底冷却。
function accountOutOfQuota(a) {
  const u = a.usage;
  if (!u || u.error || u.authFailed) return false;
  const ws = u.windows || {};
  if ([ws.fiveHour, ws.weekly].some((w) => w && w.exceeded === true)) return true;
  const monthlyLeft = u.credits ? Number(u.credits.monthlyCredits) : null;
  return monthlyLeft !== null && monthlyLeft <= 0;
}

function availableAccounts(excludeId) {
  const now = Date.now();
  const s = state.settings;
  return state.accounts.filter((a) => {
    if (!a.enabled || a.status === 'error' || a.cooldownUntil > now || a.id === excludeId) return false;
    // 额度已耗尽的账号请求必然被上游拒绝，直接跳过，不浪费尝试次数
    if (accountOutOfQuota(a)) return false;
    // 单账号并发上限：避免把某个账号打爆触发上游风控
    if (s.maxConcurrentPerAccount > 0 && (a.inflight || 0) >= s.maxConcurrentPerAccount) return false;
    // 单账号派发节流：与「正常 CLI 使用频率」保持一致
    if (s.minIntervalMs > 0 && now - (a.lastDispatchAt || 0) < s.minIntervalMs) return false;
    return true;
  });
}

function pickAccount(excludeId, vkey) {
  const pool = availableAccounts(excludeId);
  if (!pool.length) return null;
  const strategy = state.settings.strategy;
  // 会话粘性：优先复用该虚拟 Key 上次用过的账号。
  // 粘住的账号不可用（冷却/被拒/达并发上限）时不阻塞，直接落到下面的均衡策略换号。
  // stickyOff = 用户显式取消粘性，此时跳过复用，完全按策略调度。
  if (strategy === 'sticky' && vkey && vkey.lastAccountId && !vkey.stickyOff) {
    const pinned = pool.find((a) => a.id === vkey.lastAccountId);
    if (pinned) return pinned;
  }
  switch (strategy) {
    case 'least_used':
      return pool.reduce((m, a) => (a.totalRequests < m.totalRequests ? a : m), pool[0]);
    case 'random':
      return pool[Math.floor(Math.random() * pool.length)];
    case 'sticky': // 粘性失效时用轮询兜底
    case 'round_robin':
    default: {
      const list = state.accounts;
      for (let i = 0; i < list.length; i++) {
        rrCursor = (rrCursor + 1) % list.length;
        if (pool.includes(list[rrCursor])) return list[rrCursor];
      }
      return pool[0];
    }
  }
}

function firstFreeInSeconds() {
  const now = Date.now();
  const times = state.accounts
    .filter((a) => a.enabled && a.status !== 'error')
    .map((a) => {
      if (a.cooldownUntil > now) return a.cooldownUntil - now;
      // 额度耗尽的账号：503 的重试时间取最近一个窗口的重置点
      if (accountOutOfQuota(a)) {
        const ws = (a.usage && a.usage.windows) || {};
        const resets = [ws.fiveHour, ws.weekly, ws.monthly]
          .map((w) => (w && Number(w.resetAt) > now ? Number(w.resetAt) - now : Infinity));
        const min = Math.min(...resets);
        if (Number.isFinite(min)) return min;
      }
      return 0;
    });
  return times.length ? Math.min(...times) : 0;
}

// ── 公开 API：虚拟 Key 鉴权 ───────────────────────
export function poolResolveClientKey(raw) {
  if (!state) return { error: { status: 503, type: 'server_busy', message: 'pool not initialized' } };
  const now = Date.now();
  const vkey = state.vkeys.find((k) => k.key === raw);
  if (!vkey) return { error: { status: 401, type: 'auth_error', message: 'Invalid virtual key' } };
  if (!vkey.enabled) return { error: { status: 401, type: 'auth_error', message: 'Virtual key is disabled' } };
  if (vkey.expiresAt && now > vkey.expiresAt) {
    return { error: { status: 401, type: 'auth_error', message: 'Virtual key is expired' } };
  }
  if (vkey.quotaRequests > 0 && vkey.usedRequests >= vkey.quotaRequests) {
    return { error: { status: 429, type: 'rate_limit_error', message: 'Virtual key quota exhausted', retryAfter: 3600 } };
  }
  // Key 级日限额（可选）：按当日已派发请求数计，0 表示不限
  const limitDaily = Number(vkey.limitDaily) || 0;
  if (limitDaily > 0) {
    const usedToday = poolKeyTodayRequests(vkey.id);
    if (usedToday >= limitDaily) {
      const tomorrow = new Date();
      tomorrow.setHours(24, 0, 0, 0);
      return {
        error: {
          status: 429,
          type: 'rate_limit_error',
          message: `Virtual key daily limit reached (${usedToday}/${limitDaily}); resets at local midnight`,
          retryAfter: Math.max(60, Math.ceil((tomorrow.getTime() - now) / 1000)),
        },
      };
    }
  }
  const account = pickAccount(null, vkey);
  if (!account) {
    // 区分「账号整体不可用」与「账号可用但被并发/节流限住」——后者应快速重试而非长退避
    if (blockedByLimit()) {
      const sec = state.settings.minIntervalMs > 0 ? Math.min(Math.ceil(state.settings.minIntervalMs / 1000), 30) : 1;
      return {
        error: {
          status: 503,
          type: 'server_busy',
          message: 'All upstream accounts are busy (per-account concurrency or rate limit); retry shortly',
          retryAfter: Math.max(1, sec),
        },
      };
    }
    const sec = firstFreeInSeconds();
    const retryAfter = sec > 0 ? Math.min(Math.max(1, Math.ceil(sec / 1000)), 300) : 30;
    return { error: { status: 503, type: 'server_busy', message: 'No available upstream account (all cooling down or disabled)', retryAfter } };
  }
  // 占用一个在途额度：由 proxy 在响应结束（finish/close）时调用 proxyReleaseAccount 释放
  account.inflight = (account.inflight || 0) + 1;
  account.lastDispatchAt = now;
  // 会话粘性：记录该虚拟 Key 本次落到的账号，后续请求优先复用。
  // stickyOff = 用户显式取消粘性（面板上点「取消粘住」/ 下拉选「不绑定」），
  // 此时不再回写，否则下一次请求又会把绑定粘回来，用户会觉得「取消没用」。
  if (state.settings.strategy === 'sticky' && !vkey.stickyOff) vkey.lastAccountId = account.id;
  return { account, vkey };
}

// 池子里还有可用账号，但都被并发上限或派发节流挡住
function blockedByLimit() {
  const now = Date.now();
  const s = state.settings;
  return state.accounts.some((a) => {
    if (!a.enabled || a.status === 'error' || a.cooldownUntil > now) return false;
    if (s.maxConcurrentPerAccount > 0 && (a.inflight || 0) >= s.maxConcurrentPerAccount) return true;
    if (s.minIntervalMs > 0 && now - (a.lastDispatchAt || 0) < s.minIntervalMs) return true;
    return false;
  });
}

// 释放账号在途额度（幂等；从每个请求的 res finish/close 调用）
export function proxyReleaseAccount(ctx) {
  if (!ctx || !ctx.account) return;
  const a = ctx.account;
  a.inflight = Math.max(0, (a.inflight || 0) - 1);
}

// 换号：把在途额度从旧账号转移到新账号（否则旧账号计数永不释放）
export function proxySwapAccount(ctx, nextAccount, logCtx) {
  if (!ctx || !nextAccount) return;
  if (ctx.account) ctx.account.inflight = Math.max(0, (ctx.account.inflight || 0) - 1);
  nextAccount.inflight = (nextAccount.inflight || 0) + 1;
  nextAccount.lastDispatchAt = Date.now();
  ctx.account = nextAccount;
  // 换号后同步粘性绑定：否则下次请求又会先去撞刚失败的那个账号
  // （用户已显式取消粘性时不回写，保持「不粘」状态）
  if (ctx.vkey && state && state.settings.strategy === 'sticky' && !ctx.vkey.stickyOff) ctx.vkey.lastAccountId = nextAccount.id;
}

// ── 公开 API：失败处理 / 换号 ───────────────────────
export function proxyPickRetryAccount(account, status, retryAfterSec, message, logCtx) {
  markFailure(account, status, retryAfterSec, message, logCtx);
  // 请求本身的问题（400/404/413 等）不换号
  if (status !== 401 && status !== 402 && status !== 403 && status !== 429 && status < 500) return null;
  return pickAccount(account.id);
}

export function proxyNoteUpstreamFailure(account, status, retryAfterSec, message) {
  if (account) markFailure(account, status, retryAfterSec, message);
}

export function proxyNoteNetworkFailure(account) {
  if (account) markFailure(account, 503, 0, 'network error / timeout');
}

function markFailure(account, status, retryAfterSec, message, logCtx) {
  if (!account) return;
  account.lastErrorAt = Date.now();
  account.lastError = message ? `HTTP ${status}: ${String(message).slice(0, 200)}` : `HTTP ${status}`;
  if (status === 401 || status === 403) {
    account.status = 'error';
    if (state.settings.authErrorDisable) account.enabled = false;
  } else if (status === 402 || status === 429 || status >= 500) {
    const sec = retryAfterSec > 0
      ? retryAfterSec
      : (status === 429 || status === 402 ? state.settings.cooldownSeconds : state.settings.netErrorCooldownSeconds);
    account.cooldownUntil = Date.now() + sec * 1000;
    account.status = 'cooldown';
  }
  if (logCtx) {
    pushLog({
      t: Date.now(),
      vkey: logCtx.vkey || '-',
      account: account.name,
      endpoint: logCtx.endpoint || '-',
      model: logCtx.model || '-',
      status,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      elapsedMs: logCtx.elapsedMs || 0,
      ttftMs: logCtx.ttftMs || 0,
      error: message || `HTTP ${status}`,
    });
    bumpDaily(false, 0, 0);
  }
  save();
}

// ── 公开 API：用量与日志 ────────────────────────────
export function proxyRecordUsage(ctx, { endpoint, model, status = 200, inputTokens = 0, outputTokens = 0, cachedTokens = 0, elapsedMs = 0, ttftMs = 0, error = '' }) {
  if (!ctx || !ctx.account || !state) return;
  const now = Date.now();
  const { account, vkey } = ctx;
  if (status >= 200 && status < 400) {
    account.status = 'active';
    account.cooldownUntil = 0;
    account.lastUsedAt = now;
    account.totalRequests++;
    account.totalInputTokens += inputTokens;
    account.totalOutputTokens += outputTokens;
    account.totalCachedTokens += cachedTokens;
    if (vkey) {
      vkey.usedRequests++;
      vkey.totalInputTokens = (vkey.totalInputTokens || 0) + inputTokens;
      vkey.totalOutputTokens = (vkey.totalOutputTokens || 0) + outputTokens;
    }
  }
  pushLog({
    t: now,
    vkey: vkey ? vkey.name : '-',
    account: account.name,
    endpoint,
    model: model || '-',
    status,
    inputTokens,
    outputTokens,
    cachedTokens,
    elapsedMs,
    ttftMs,
    error,
  });
  bumpDaily(status >= 200 && status < 400, inputTokens, outputTokens, { vkeyId: vkey && vkey.id, model, cachedTokens });
  if (status >= 200 && status < 400) save();
}

function pushLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > LOG_LIMIT) state.logs.splice(0, state.logs.length - LOG_LIMIT);
}

function bumpDaily(ok, inputTokens, outputTokens, { vkeyId, model, cachedTokens = 0 } = {}) {
  const dk = dayKey();
  const d = state.daily[dk] || (state.daily[dk] = { requests: 0, ok: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, byKey: {}, byModel: {} });
  d.requests++;
  if (ok) d.ok++;
  d.inputTokens += inputTokens;
  d.outputTokens += outputTokens;
  d.cachedTokens = (d.cachedTokens || 0) + (cachedTokens || 0);
  // 维度聚合：按虚拟 Key / 按模型。面板排行用它，虚拟 Key 的日限额也从这里取当日用量
  if (!d.byKey) d.byKey = {};
  if (!d.byModel) d.byModel = {};
  const bump = (bucket, key) => {
    if (!key) return;
    const b = bucket[key] || (bucket[key] = { requests: 0, ok: 0, inputTokens: 0, outputTokens: 0 });
    b.requests++;
    if (ok) b.ok++;
    b.inputTokens += inputTokens;
    b.outputTokens += outputTokens;
  };
  bump(d.byKey, vkeyId);
  bump(d.byModel, model && model !== '-' ? model : '');
  const cutoff = dayKey(Date.now() - DAILY_RETENTION * 86400000);
  for (const k of Object.keys(state.daily)) if (k < cutoff) delete state.daily[k];
}

// 虚拟 Key 当日已派发请求数（日限额校验与面板展示共用）
export function poolKeyTodayRequests(vkeyId) {
  if (!state) return 0;
  const d = state.daily[dayKey()];
  return (d && d.byKey && d.byKey[vkeyId] && d.byKey[vkeyId].requests) || 0;
}

// ── 公开 API：账号管理（面板） ──────────────────────
export function poolEnabled() {
  return !!state && state.accounts.length > 0 && state.settings.poolEnabled !== false;
}

export function poolAccountCount() {
  return state ? state.accounts.length : 0;
}

export function poolListAccounts() {
  if (!state) return [];
  return state.accounts.map((a) => ({
    id: a.id,
    name: a.name,
    keyMasked: maskKey(a.key),
    enabled: a.enabled,
    status: a.status,
    cooldownUntil: a.cooldownUntil,
    inflight: a.inflight || 0,
    lastError: a.lastError,
    lastErrorAt: a.lastErrorAt,
    createdAt: a.createdAt,
    lastUsedAt: a.lastUsedAt,
    totalRequests: a.totalRequests,
    totalInputTokens: a.totalInputTokens,
    totalOutputTokens: a.totalOutputTokens,
    totalCachedTokens: a.totalCachedTokens,
    usage: a.usage || null,
  }));
}

export function poolAddAccounts(keysText, namesText) {
  if (!state) return { added: 0, failed: [] };
  const lines = String(keysText || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const names = String(namesText || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const existing = new Set(state.accounts.map((a) => a.key));
  const failed = [];
  const addedIds = [];
  let added = 0;
  lines.forEach((line, i) => {
    const m = line.match(/user_[a-zA-Z0-9_-]+/);
    if (!m) {
      failed.push({ line: i + 1, reason: 'invalid key format (expect user_*)' });
      return;
    }
    const key = m[0];
    if (existing.has(key)) {
      failed.push({ line: i + 1, reason: 'duplicate key' });
      return;
    }
    existing.add(key);
    state.accounts.push({
      id: newId('acc'),
      name: (names[i] || '').slice(0, 60) || `账号 ${state.accounts.length + 1}`,
      key,
      enabled: true,
      status: 'active',
      cooldownUntil: 0,
      lastError: '',
      lastErrorAt: 0,
      createdAt: Date.now(),
      lastUsedAt: 0,
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedTokens: 0,
    });
    added++;
    addedIds.push(state.accounts[state.accounts.length - 1].id);
  });
  if (added) save();
  return { added, failed, addedIds };
}

export function poolPatchAccount(id, patch) {
  const a = state.accounts.find((x) => x.id === id);
  if (!a) return { ok: false, error: 'account not found' };
  if (typeof patch.name === 'string') a.name = patch.name.slice(0, 60);
  if (typeof patch.enabled === 'boolean') a.enabled = patch.enabled;
  save();
  return { ok: true };
}

// 删除账号后清掉指向它的粘性绑定，避免虚拟 Key 钉在已消失的账号上
function dropDanglingPins() {
  const alive = new Set(state.accounts.map((a) => a.id));
  let cleared = 0;
  for (const v of state.vkeys) {
    if (v.lastAccountId && !alive.has(v.lastAccountId)) { v.lastAccountId = ''; cleared++; }
  }
  return cleared;
}

export function poolDeleteAccount(id) {
  const idx = state.accounts.findIndex((x) => x.id === id);
  if (idx === -1) return { ok: false, error: 'account not found' };
  state.accounts.splice(idx, 1);
  dropDanglingPins();
  save();
  return { ok: true };
}

// 批量运维：面板上一次处理多个账号（逐个点太慢，且失效账号需要成批清理）
// action: enable | disable | reset | delete；ids 为空时 enable/disable/reset 作用于全部，delete 为空则不动作
export function poolBulkAccounts(action = '', ids = []) {
  if (!state) return { ok: false, error: 'pool not initialized' };
  const set = new Set(Array.isArray(ids) ? ids.filter(Boolean) : []);
  const all = set.size === 0;
  let affected = 0;
  if (action === 'enable' || action === 'reset') {
    for (const a of state.accounts) {
      if (!all && !set.has(a.id)) continue;
      a.enabled = true;
      a.status = 'active';
      a.cooldownUntil = 0;
      a.lastError = '';
      a.lastErrorAt = 0;
      affected++;
    }
  } else if (action === 'disable') {
    for (const a of state.accounts) {
      if (!all && !set.has(a.id)) continue;
      a.enabled = false;
      affected++;
    }
  } else if (action === 'delete') {
    if (all) return { ok: false, error: 'delete requires explicit ids' };
    const keep = state.accounts.filter((a) => !set.has(a.id));
    affected = state.accounts.length - keep.length;
    state.accounts = keep;
  } else {
    return { ok: false, error: 'unknown action' };
  }
  const pinsCleared = dropDanglingPins();
  save(true);
  return { ok: true, affected, pinsCleared };
}

// 一键清理：已禁用且处于 error 状态的账号（通常是失效的 Key）
export function poolPruneAccounts() {
  if (!state) return { ok: false, error: 'pool not initialized' };
  const before = state.accounts.length;
  state.accounts = state.accounts.filter((a) => !(!a.enabled && a.status === 'error'));
  const removed = before - state.accounts.length;
  const pinsCleared = dropDanglingPins();
  if (removed || pinsCleared) save(true);
  return { ok: true, removed, pinsCleared };
}

export function poolResetAccount(id) {
  const a = state.accounts.find((x) => x.id === id);
  if (!a) return { ok: false, error: 'account not found' };
  a.status = 'active';
  a.cooldownUntil = 0;
  a.lastError = '';
  a.lastErrorAt = 0;
  a.enabled = true;
  save();
  return { ok: true };
}

export function poolToggleAccount(id, enabled) {
  return poolPatchAccount(id, { enabled });
}

export async function poolTestAccount(id) {
  const a = state.accounts.find((x) => x.id === id);
  if (!a) return { ok: false, error: 'account not found' };
  const started = Date.now();
  try {
    const res = await fetch(`${API_BASE}/provider/v1/models`, {
      headers: {
        'Authorization': `Bearer ${a.key}`,
        'x-cli-environment': 'production',
      },
      signal: AbortSignal.timeout(12000),
    });
    const elapsed = Date.now() - started;
    if (res.ok) {
      const data = await res.json().catch(() => null);
      a.status = 'active';
      a.cooldownUntil = 0;
      a.lastError = '';
      save();
      return { ok: true, elapsed, detail: `可用模型 ${Array.isArray(data?.data) ? data.data.length : 0} 个` };
    }
    if (res.status === 401 || res.status === 403) {
      a.status = 'error';
      if (state.settings.authErrorDisable) a.enabled = false;
      save();
      return { ok: false, elapsed, detail: `HTTP ${res.status}（Key 无效或已失效）` };
    }
    return { ok: false, elapsed, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, elapsed: Date.now() - started, detail: `连接失败：${e.message}` };
  }
}

// ── 公开 API：虚拟 Key（面板） ──────────────────────
export function poolListVkeys() {
  if (!state) return [];
  return state.vkeys.map((k) => ({
    id: k.id,
    name: k.name,
    key: k.key,
    enabled: k.enabled,
    createdAt: k.createdAt,
    expiresAt: k.expiresAt,
    quotaRequests: k.quotaRequests,
    usedRequests: k.usedRequests,
    limitDaily: k.limitDaily || 0,
    usedToday: poolKeyTodayRequests(k.id),
    lastAccountId: k.lastAccountId || '',
    stickyOff: !!k.stickyOff,
    totalInputTokens: k.totalInputTokens || 0,
    totalOutputTokens: k.totalOutputTokens || 0,
  }));
}

export function poolCreateVkey({ name = '', quotaRequests = 0, expiresInDays = 0, limitDaily = 0 }) {
  const vkey = {
    id: newId('vk'),
    name: String(name).slice(0, 60) || `Key ${state.vkeys.length + 1}`,
    key: `sk-ccp-${crypto.randomBytes(18).toString('base64url')}`,
    enabled: true,
    createdAt: Date.now(),
    expiresAt: Number(expiresInDays) > 0 ? Date.now() + Number(expiresInDays) * 86400000 : 0,
    quotaRequests: Math.max(0, Number(quotaRequests) || 0),
    limitDaily: Math.max(0, Number(limitDaily) || 0),
    usedRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };
  state.vkeys.push(vkey);
  save();
  return vkey;
}

export function poolPatchVkey(id, patch) {
  const v = state.vkeys.find((x) => x.id === id);
  if (!v) return { ok: false, error: 'vkey not found' };
  if (typeof patch.name === 'string') v.name = patch.name.slice(0, 60);
  if (typeof patch.enabled === 'boolean') v.enabled = patch.enabled;
  if (typeof patch.quotaRequests === 'number' && patch.quotaRequests >= 0) v.quotaRequests = Math.floor(patch.quotaRequests);
  if (typeof patch.limitDaily === 'number' && patch.limitDaily >= 0) v.limitDaily = Math.floor(patch.limitDaily);
  if (typeof patch.expiresInDays === 'number' && patch.expiresInDays > 0) v.expiresAt = Date.now() + patch.expiresInDays * 86400000;
  // 手动切换粘性账号：传账号 id 绑定，传空串解绑；只接受真实存在的账号。
  // 显式指定账号 = 恢复粘性（stickyOff=false）；显式解绑 = 关闭粘性（stickyOff=true），
  // 否则 sticky 策略会在下一次请求时又把绑定粘回来，用户会觉得「取消没用」。
  if (typeof patch.lastAccountId === 'string') {
    if (patch.lastAccountId === '') { v.lastAccountId = ''; v.stickyOff = true; }
    else if (state.accounts.some((a) => a.id === patch.lastAccountId)) { v.lastAccountId = patch.lastAccountId; v.stickyOff = false; }
  }
  if (typeof patch.stickyOff === 'boolean') {
    v.stickyOff = patch.stickyOff;
    if (patch.stickyOff) v.lastAccountId = '';
  }
  save();
  return { ok: true };
}

export function poolDeleteVkey(id) {
  const idx = state.vkeys.findIndex((x) => x.id === id);
  if (idx === -1) return { ok: false, error: 'vkey not found' };
  state.vkeys.splice(idx, 1);
  save();
  return { ok: true };
}

// ── 公开 API：设置 / 概览 / 日志 ────────────────────
export function poolGetSettings() {
  if (!state) return { ...DEFAULT_SETTINGS };
  const { passwordHash, tokenSecret, ...rest } = state.admin;
  return {
    ...state.settings,
    poolEnabled: state.settings.poolEnabled !== false,
    firstRun: state.admin.firstRun,
    upstreamApiBase: API_BASE, // 只读：面板上展示上游地址，便于核对是否指向自建/官方
  };
}

export function poolUpdateSettings(patch) {
  const s = state.settings;
  if (['round_robin', 'least_used', 'random', 'sticky'].includes(patch.strategy)) s.strategy = patch.strategy;
  if (typeof patch.cooldownSeconds === 'number' && patch.cooldownSeconds >= 0) s.cooldownSeconds = Math.floor(patch.cooldownSeconds);
  if (typeof patch.netErrorCooldownSeconds === 'number' && patch.netErrorCooldownSeconds >= 0) s.netErrorCooldownSeconds = Math.floor(patch.netErrorCooldownSeconds);
  if (typeof patch.authErrorDisable === 'boolean') s.authErrorDisable = patch.authErrorDisable;
  if (typeof patch.maxConcurrentPerAccount === 'number' && patch.maxConcurrentPerAccount >= 0) s.maxConcurrentPerAccount = Math.floor(patch.maxConcurrentPerAccount);
  if (typeof patch.minIntervalMs === 'number' && patch.minIntervalMs >= 0) s.minIntervalMs = Math.floor(patch.minIntervalMs);
  if (typeof patch.usageRefreshMinutes === 'number' && patch.usageRefreshMinutes >= 0) s.usageRefreshMinutes = Math.floor(patch.usageRefreshMinutes);
  if (typeof patch.poolEnabled === 'boolean') s.poolEnabled = patch.poolEnabled;
  save();
  return { ...s };
}

export function poolVerifyPassword(pw) {
  return verifyPasswordHash(String(pw || ''), state.admin.passwordHash);
}

export function poolIssueToken() {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = `v1.${exp}`;
  const sig = crypto.createHmac('sha256', state.admin.tokenSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function poolVerifyToken(token) {
  if (!token || !state) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const sig = crypto.createHmac('sha256', state.admin.tokenSecret).update(payload).digest('base64url');
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(parts[1]) > Date.now();
}

export function poolChangePassword(oldPw, newPw) {
  // 无论是否首次登录都校验旧密码：首次登录时旧密码即默认的 admin
  if (!poolVerifyPassword(oldPw)) return { ok: false, error: '旧密码错误' };
  return doChangePassword(newPw);
}

function doChangePassword(newPw) {
  if (String(newPw || '').length < 6) return { ok: false, error: '新密码至少 6 位' };
  state.admin.passwordHash = hashPassword(newPw);
  state.admin.tokenSecret = crypto.randomBytes(32).toString('hex'); // 令旧 token 失效
  state.admin.firstRun = false;
  save(true);
  return { ok: true };
}

// 日志查询：不传时间则返回全部（倒序）；from/to 为毫秒时间戳（含边界）
export function poolLogs(filter = {}) {
  if (!state) return [];
  const from = Number(filter.from) || 0;
  const to = Number(filter.to) || 0;
  let rows = state.logs;
  if (from > 0 || to > 0) {
    rows = rows.filter((e) => (from <= 0 || e.t >= from) && (to <= 0 || e.t <= to));
  }
  return rows.slice().reverse();
}

export function poolOverview() {
  if (!state) return null;
  const now = Date.now();
  const today = state.daily[dayKey()] || { requests: 0, ok: 0, inputTokens: 0, outputTokens: 0 };
  const totals = state.accounts.reduce((m, a) => ({
    requests: m.requests + a.totalRequests,
    inputTokens: m.inputTokens + a.totalInputTokens,
    outputTokens: m.outputTokens + a.totalOutputTokens,
  }), { requests: 0, inputTokens: 0, outputTokens: 0 });
  const statusCount = { active: 0, cooldown: 0, error: 0, disabled: 0 };
  for (const a of state.accounts) {
    if (!a.enabled) statusCount.disabled++;
    else statusCount[a.status] = (statusCount[a.status] || 0) + 1;
  }
  const daily7 = [];
  const keyAgg = {};
  const modelAgg = {};
  const addTo = (bucket, key, v) => {
    if (!key) return;
    const b = bucket[key] || (bucket[key] = { requests: 0, ok: 0, inputTokens: 0, outputTokens: 0 });
    b.requests += v.requests || 0;
    b.ok += v.ok || 0;
    b.inputTokens += v.inputTokens || 0;
    b.outputTokens += v.outputTokens || 0;
  };
  for (let i = 6; i >= 0; i--) {
    const d = state.daily[dayKey(now - i * 86400000)];
    daily7.push({
      date: dayKey(now - i * 86400000), requests: d?.requests || 0, ok: d?.ok || 0,
      inputTokens: d?.inputTokens || 0, outputTokens: d?.outputTokens || 0, cachedTokens: d?.cachedTokens || 0,
    });
    for (const [id, v] of Object.entries((d && d.byKey) || {})) addTo(keyAgg, id, v);
    for (const [m, v] of Object.entries((d && d.byModel) || {})) addTo(modelAgg, m, v);
  }
  const byKey7 = Object.entries(keyAgg)
    .map(([id, v]) => {
      const k = state.vkeys.find((x) => x.id === id);
      return { id, name: k ? k.name : '(已删除)', ...v };
    })
    .sort((a, b) => b.requests - a.requests);
  const byModel7 = Object.entries(modelAgg)
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.requests - a.requests);
  return {
    today,
    totals,
    statusCount,
    accounts: state.accounts.length,
    enabledAccounts: state.accounts.filter((a) => a.enabled && a.status !== 'error' && a.cooldownUntil <= now).length,
    vkeys: state.vkeys.length,
    vkeysEnabled: state.vkeys.filter((v) => v.enabled).length,
    daily7,
    byKey7,
    byModel7,
    recentLogs: state.logs.slice(-10).reverse(),
  };
}

// ── 额度（Usage Limits） ──────────────────────────
// 数据来自上游 /alpha/* 端点（未公开文档，字段做防御性兼容）：
//   /alpha/whoami                账户身份 + orgId（订阅端点要用）
//   /alpha/billing/credits       余额 + windowLimits.{fiveHour,weekly}
//   /alpha/billing/subscriptions 套餐与账期（?orgId=）
//   /alpha/usage/summary         账期聚合统计
// 上游没有 monthly 窗口对象：月度上限按 planId 的已知套餐映射推算，
// 已用 = 上限 − 月度剩余，重置点取账期结束（与社区对官方 CLI 的逆向结论一致）。

const KNOWN_PLANS = {
  'individual-go':       { name: 'Go',        monthlyCredits: 10 },
  'individual-goat':     { name: 'GOAT',      monthlyCredits: 70 },
  'individual-pro':      { name: 'Pro',       monthlyCredits: 30 },
  'individual-pro-v1':   { name: 'Pro',       monthlyCredits: 80 },
  'individual-provider': { name: 'Provider',  monthlyCredits: 15 },
  'individual-max':      { name: 'Max',       monthlyCredits: 150 },
  'individual-ultra':    { name: 'Ultra',     monthlyCredits: 300 },
  'teams-pro':           { name: 'Teams Pro', monthlyCredits: 40 },
};
// 最长前缀优先：individual-pro-v1 应胜过 individual-pro
const PLAN_PREFIXES = Object.keys(KNOWN_PLANS).sort((a, b) => b.length - a.length);

function planInfo(planId) {
  if (!planId) return undefined;
  const norm = String(planId).toLowerCase().replace(/_/g, '-');
  const prefix = PLAN_PREFIXES.find((p) => norm.startsWith(p));
  return prefix ? KNOWN_PLANS[prefix] : undefined;
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const numOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOf = (v) => (typeof v === 'string' ? v : null);

// 毫秒时间戳兼容：数字（epoch ms 或秒）或 ISO 字符串
function toEpochMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

// 窗口对象防御性归一：windowLimits.fiveHour 也可能叫 five_hour / rolling5h 等
function pickWindow(wl, names) {
  for (const n of names) if (isRecord(wl[n])) return wl[n];
  return undefined;
}

function normalizeWindow(raw) {
  if (!isRecord(raw)) return undefined;
  const used = numOf(raw.used) ?? numOf(raw.usage) ?? numOf(raw.usedCredits) ?? numOf(raw.used_credits);
  const cap = numOf(raw.cap) ?? numOf(raw.limit) ?? numOf(raw.capCredits);
  const exceeded = raw.exceeded === true || raw.exceeded === 'true'
    || (used != null && cap != null && cap > 0 && used >= cap);
  return {
    used: used ?? 0,
    cap: cap ?? 0,
    exceeded,
    resetAt: toEpochMs(raw.resetAt ?? raw.reset_at ?? raw.resetsAt) ?? 0,
  };
}

async function usageGet(path, key) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const resp = await fetch(API_BASE + path, {
      headers: {
        Authorization: 'Bearer ' + key,
        Accept: 'application/json',
        'User-Agent': 'commandcode-proxy-pool/1.0',
      },
      signal: ctl.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      const err = new Error('HTTP ' + resp.status);
      err.status = resp.status;
      err.body = text.slice(0, 300);
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      const err = new Error('non-JSON response');
      err.status = 502;
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUsageReport(key) {
  const failures = [];
  const report = {};

  // whoami：拿身份与 orgId；401/403 在此短路，不再打其余端点
  let orgId;
  try {
    const who = await usageGet('/alpha/whoami', key);
    const user = isRecord(who.user) ? who.user
      : (isRecord(who.data) && isRecord(who.data.user) ? who.data.user : undefined);
    if (user) {
      report.identity = {
        id: strOf(user.id) ?? '',
        name: strOf(user.name) ?? '',
        userName: strOf(user.userName) ?? strOf(user.username) ?? '',
      };
    }
    const org = isRecord(who.org) ? who.org : undefined;
    orgId = org ? strOf(org.id) : undefined;
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      const err = new Error('Key 被拒（HTTP ' + e.status + '）');
      err.status = e.status;
      err.authFailed = true;
      throw err;
    }
    failures.push('whoami: ' + e.message);
  }

  let planIdFallback;
  try {
    const cr = await usageGet('/alpha/billing/credits', key);
    const credits = isRecord(cr.credits) ? cr.credits
      : (isRecord(cr.data) && isRecord(cr.data.credits) ? cr.data.credits : undefined);
    const wl = isRecord(cr.windowLimits) ? cr.windowLimits
      : (isRecord(cr.data) && isRecord(cr.data.windowLimits) ? cr.data.windowLimits : undefined);
    if (credits || wl) {
      report.credits = {
        monthlyCredits: numOf(credits?.monthlyCredits) ?? numOf(credits?.monthly_credits) ?? null,
        purchasedCredits: numOf(credits?.purchasedCredits) ?? numOf(credits?.purchased_credits) ?? null,
        freeCredits: numOf(credits?.freeCredits) ?? numOf(credits?.free_credits) ?? null,
        belowThreshold: credits?.belowThreshold === true,
      };
      report.limited = wl?.limited === true;
      report.exceededWindow = strOf(wl?.exceeded) ?? '';
      report.fiveHour = normalizeWindow(pickWindow(wl || {}, ['fiveHour', 'five_hour', 'rolling5h', '5h']));
      report.weekly = normalizeWindow(pickWindow(wl || {}, ['weekly', 'week']));
      if (credits) planIdFallback = strOf(credits.planId) ?? strOf(credits.plan_id);
    }
  } catch (e) {
    failures.push('billing/credits: ' + e.message);
  }

  try {
    const path = orgId
      ? '/alpha/billing/subscriptions?orgId=' + encodeURIComponent(orgId)
      : '/alpha/billing/subscriptions';
    const sub = await usageGet(path, key);
    const data = isRecord(sub.data) ? sub.data
      : (isRecord(sub.subscription) ? sub.subscription : undefined);
    const planId = strOf(data?.planId) ?? strOf(data?.plan_id) ?? planIdFallback;
    if (data || planId) {
      const info = planInfo(planId);
      report.plan = {
        planId: planId ?? '',
        name: info?.name ?? planId ?? '',
        status: strOf(data?.status) ?? '',
        monthlyCredits: info ? info.monthlyCredits : null,
        currentPeriodEnd: toEpochMs(data?.currentPeriodEnd ?? data?.current_period_end) ?? 0,
        cancelAtPeriodEnd: data?.cancelAtPeriodEnd === true,
      };
    }
  } catch (e) {
    if (planIdFallback) {
      const info = planInfo(planIdFallback);
      report.plan = {
        planId: planIdFallback,
        name: info?.name ?? planIdFallback,
        status: '',
        monthlyCredits: info ? info.monthlyCredits : null,
        currentPeriodEnd: 0,
        cancelAtPeriodEnd: false,
      };
    }
    failures.push('billing/subscriptions: ' + e.message);
  }

  try {
    const us = await usageGet('/alpha/usage/summary', key);
    const u = isRecord(us.data) ? us.data : us;
    if (isRecord(u)) {
      report.summary = {
        totalCount: numOf(u.totalCount) ?? 0,
        totalCost: numOf(u.totalCost) ?? 0,
        averageCost: numOf(u.averageCost) ?? null,
        successRate: numOf(u.successRate) ?? 0,
        completedCount: numOf(u.completedCount) ?? 0,
        failedCount: numOf(u.failedCount) ?? 0,
        totalTokensIn: numOf(u.totalTokensIn) ?? 0,
        totalTokensOut: numOf(u.totalTokensOut) ?? 0,
        totalCredits: numOf(u.totalCredits) ?? 0,
        periodBasis: strOf(u.periodBasis) ?? '',
      };
    }
  } catch (e) {
    failures.push('usage/summary: ' + e.message);
  }

  // 月度窗口：上游不提供，按套餐映射推算；套餐或余额未知时为 null（前端隐藏该条）
  const cap = report.plan?.monthlyCredits;
  const left = report.credits?.monthlyCredits;
  let monthly = null;
  if (cap != null && left != null) {
    monthly = {
      used: Math.max(cap - left, 0),
      cap,
      exceeded: left <= 0,
      resetAt: report.plan?.currentPeriodEnd ?? 0,
      derived: true, // 标注：上限按套餐推算
    };
  }

  return {
    fetchedAt: Date.now(),
    error: failures.length ? failures.join('; ') : null,
    identity: report.identity ?? null,
    plan: report.plan ?? null,
    credits: report.credits ?? null,
    summary: report.summary ?? null,
    limited: report.limited === true,
    exceededWindow: report.exceededWindow ?? '',
    windows: { fiveHour: report.fiveHour ?? null, weekly: report.weekly ?? null, monthly },
  };
}

// 刷新单个账号额度：失败只记录到 usage.error，不改动账号健康状态（避免面板查询产生副作用）
export async function poolRefreshUsage(id) {
  if (!state) return { ok: false, error: 'pool not initialized' };
  const account = state.accounts.find((a) => a.id === id);
  if (!account) return { ok: false, error: 'account not found' };
  try {
    const usage = await fetchUsageReport(account.key);
    account.usage = usage;
    save(true);
    return { ok: true, data: usage };
  } catch (e) {
    const prev = account.usage || {};
    const failed = {
      ...prev,
      error: e.message,
      authFailed: e.authFailed === true,
      lastAttemptAt: Date.now(),
    };
    account.usage = failed;
    save(true);
    return { ok: false, error: e.message, authFailed: e.authFailed === true, data: failed };
  }
}

export async function poolRefreshAllUsage(limit = 12) {
  if (!state) return { ok: false, error: 'pool not initialized' };
  const targets = state.accounts.slice(0, limit);
  const results = [];
  // 小并发（4）：尽量贴近正常 CLI 使用频率，避免额度查询本身触发风控
  for (let i = 0; i < targets.length; i += 4) {
    const batch = targets.slice(i, i + 4);
    const settled = await Promise.all(batch.map((a) => poolRefreshUsage(a.id).then(
      (r) => ({ id: a.id, name: a.name, ok: r.ok, error: r.error || null }),
      (e) => ({ id: a.id, name: a.name, ok: false, error: e.message }),
    )));
    results.push(...settled);
  }
  return {
    ok: true,
    total: results.length,
    refreshed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok),
    truncated: state.accounts.length > limit ? state.accounts.length - limit : 0,
  };
}

export function poolUsageSnapshot() {
  if (!state) return [];
  return state.accounts.map((a) => ({
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    status: a.status,
    usage: a.usage || null,
  }));
}

// 自动刷新：仅当设置了 usageRefreshMinutes 且数据过期时后台补刷（不阻塞面板请求）
let usageSweepRunning = false;
export function poolMaybeRefreshUsage() {
  if (!state || usageSweepRunning) return;
  const minutes = Number(state.settings.usageRefreshMinutes) || 0;
  if (minutes <= 0) return;
  const ttl = minutes * 60 * 1000;
  const now = Date.now();
  const stale = state.accounts.filter((a) => {
    const last = a.usage?.lastAttemptAt || a.usage?.fetchedAt || 0;
    return now - last > ttl;
  });
  if (!stale.length) return;
  usageSweepRunning = true;
  (async () => {
    try {
      for (let i = 0; i < stale.length; i += 4) {
        await Promise.all(stale.slice(i, i + 4).map((a) => poolRefreshUsage(a.id).catch(() => {})));
      }
    } finally {
      usageSweepRunning = false;
    }
  })();
}