/**
 * 第五轮验证：调度策略
 *  - sticky（会话粘性）：同一虚拟 Key 的连续请求固定落在同一账号，保 prompt 缓存命中
 *  - 粘住的账号不可用时自动换号，并把绑定转移到新账号
 *  - round_robin：请求在多账号间轮转分散
 * mock 上游在响应里回 `[served-by:<key前12位>]`，用它识别请求实际落在哪个账号。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3052';
let pass = 0; let fail = 0;
const out = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; out.push(`  PASS  ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; out.push(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
async function req(path, opts = {}) {
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
const auth = (t) => ({ headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' } });
const jpost = (obj, extra = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(extra.headers || {}) },
  body: JSON.stringify(obj),
});
const chatBody = (c = 'hello') => ({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: c }] });
const section = (s) => out.push(`\n=== ${s} ===`);
const tagOf = (r) => (/served-by:([a-z0-9_]+)/.exec(JSON.stringify(r.body || '')) || [])[1];

(async () => {
  const login = await req('/admin/api/login', jpost({ password: 'newpass123' }));
  if (!login.body.token) { console.error('登录失败，请确认实例密码为 newpass123:', login.body); process.exit(1); }
  const token = login.body.token;
  const api = (p, o = {}) => req(p, { ...o, headers: { ...(o.headers || {}), Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });

  const original = (await api('/admin/api/settings')).body.data.strategy;
  let accs = (await api('/admin/api/accounts')).body.data;
  const a = accs.find((x) => x.name === '主号A');
  const b = accs.find((x) => x.name === '主号B');
  if (!a || !b) { console.error('缺少 主号A / 主号B，请先跑 tests/verify.mjs'); process.exit(1); }

  // 只留两个正常账号，避免其他账号干扰判断
  for (const x of accs) {
    const want = x.id === a.id || x.id === b.id;
    if (x.enabled !== want) await api('/admin/api/accounts/' + x.id, { method: 'PATCH', body: JSON.stringify({ enabled: want }) });
  }
  await api('/admin/api/settings', { method: 'PATCH', body: JSON.stringify({ strategy: 'sticky', cooldownSeconds: 5, maxConcurrentPerAccount: 0, minIntervalMs: 0 }) });
  const vk = await api('/admin/api/vkeys', jpost({ name: '粘性测试Key' }, auth(token)));
  const vkey = vk.body.data.key;
  check('准备完成（两个正常账号 + 粘性策略）', !!vkey, `主号A=${a.id} 主号B=${b.id}`);

  section('sticky：连续请求固定同一账号');
  const tags = [];
  for (let i = 0; i < 4; i++) tags.push(tagOf(await req('/v1/chat/completions', jpost(chatBody('sticky' + i), auth(vkey)))));
  check('4 次请求全部落在同一账号', tags.every((t) => t && t === tags[0]), tags.join(', '));

  section('粘住的账号被禁用时自动换号');
  const pinnedId = tags[0] === 'user_ok11111' ? a.id : b.id;
  await api('/admin/api/accounts/' + pinnedId, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
  const switched = tagOf(await req('/v1/chat/completions', jpost(chatBody('after-disable'), auth(vkey))));
  check('请求被转移到另一个账号', switched && switched !== tags[0], `${tags[0]} → ${switched}`);
  const sticky2 = [];
  for (let i = 0; i < 3; i++) sticky2.push(tagOf(await req('/v1/chat/completions', jpost(chatBody('sticky2-' + i), auth(vkey)))));
  check('换号后粘性绑定也跟着转移', sticky2.every((t) => t === switched), sticky2.join(', '));

  section('原账号恢复后不自动回切（绑定已更新）');
  await api('/admin/api/accounts/' + pinnedId, { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
  const afterRestore = tagOf(await req('/v1/chat/completions', jpost(chatBody('after-restore'), auth(vkey))));
  check('仍粘在当前账号', afterRestore === switched, `实际=${afterRestore}`);

  section('sticky：粘住的账号额度耗尽时自动换号');
  let accsNow = (await api('/admin/api/accounts')).body.data;
  const limited = accsNow.find((x) => x.name === '限流号');
  // 清掉 verify 阶段 429 留下的冷却，再刷新额度拿到 exceeded 标记
  await api('/admin/api/accounts/' + limited.id + '/reset', { method: 'POST' });
  for (const x of accsNow) {
    const want = x.id === a.id || x.id === limited.id;
    if (x.enabled !== want) await api('/admin/api/accounts/' + x.id, { method: 'PATCH', body: JSON.stringify({ enabled: want }) });
  }
  await api('/admin/api/usage/refresh', { method: 'POST', body: JSON.stringify({ id: limited.id }) });
  const limUsage = (await api('/admin/api/usage')).body.data.find((r) => r.id === limited.id);
  check('限流号额度已标记耗尽（5h exceeded）',
    !!(limUsage.usage && limUsage.usage.windows.fiveHour.exceeded === true),
    JSON.stringify((limUsage.usage && limUsage.usage.windows.fiveHour) || {}));
  // 手动把粘性绑定指到限流号（等价于面板上的「粘住」按钮）
  await api('/admin/api/vkeys/' + vk.body.data.id, { method: 'PATCH', body: JSON.stringify({ lastAccountId: limited.id }) });
  const t1 = tagOf(await req('/v1/chat/completions', jpost(chatBody('quota-fallback'), auth(vkey))));
  check('额度耗尽的粘性账号被跳过，请求落到健康账号', t1 && t1 !== 'user_rate333', `实际=${t1}`);
  const vksNow = (await api('/admin/api/vkeys')).body.data.find((k) => k.id === vk.body.data.id);
  check('粘性绑定已转移到实际使用的账号', vksNow.lastAccountId && vksNow.lastAccountId !== limited.id,
    `lastAccountId=${vksNow.lastAccountId}`);

  section('所有可用账号额度耗尽 → 503 且带重置时间');
  accsNow = (await api('/admin/api/accounts')).body.data;
  for (const x of accsNow) {
    const want = x.id === limited.id;
    if (x.enabled !== want) await api('/admin/api/accounts/' + x.id, { method: 'PATCH', body: JSON.stringify({ enabled: want }) });
  }
  const q = await req('/v1/chat/completions', jpost(chatBody('all-exhausted'), auth(vkey)));
  const qbody = JSON.stringify(q.body);
  check('全账号额度耗尽 → 503 + server_busy + 重试时间',
    q.status === 503 && qbody.includes('server_busy') && /retry.?after/i.test(qbody),
    `status=${q.status} body=${qbody.slice(0, 110)}`);

  section('切换回 round_robin：请求分散到多账号');
  accsNow = (await api('/admin/api/accounts')).body.data;
  for (const x of accsNow) {
    const want = x.id === a.id || x.id === b.id;
    if (x.enabled !== want) await api('/admin/api/accounts/' + x.id, { method: 'PATCH', body: JSON.stringify({ enabled: want }) });
  }
  await api('/admin/api/settings', { method: 'PATCH', body: JSON.stringify({ strategy: 'round_robin' }) });
  const rr = [];
  for (let i = 0; i < 4; i++) rr.push(tagOf(await req('/v1/chat/completions', jpost(chatBody('rr' + i), auth(vkey)))));
  check('轮询下出现两个不同账号', new Set(rr).size === 2, rr.join(', '));

  section('least_used：优先分给累计请求少的账号');
  await api('/admin/api/settings', { method: 'PATCH', body: JSON.stringify({ strategy: 'least_used' }) });
  const before = (await api('/admin/api/accounts')).body.data;
  const least = before.filter((x) => x.enabled).sort((x, y) => x.totalRequests - y.totalRequests)[0];
  const lu = tagOf(await req('/v1/chat/completions', jpost(chatBody('lu'), auth(vkey))));
  const expect = least.id === a.id ? 'user_ok11111' : 'user_ok22222';
  check('命中累计请求最少的账号', lu === expect, `期望=${expect} 实际=${lu}（最少=${least.totalRequests}）`);

  section('429 限流 → 冷却（带 Retry-After）');
  // user_toll999999：generate 返回 429，但额度端点正常——不会被额度判定跳过，
  // 用于验证 429 → 冷却路径本身（user_rate* 的额度被标记 exceeded，走不到这一步）
  await api('/admin/api/accounts', jpost({ keys: 'user_toll999999', names: '限流测试号' }));
  const accsToll = (await api('/admin/api/accounts')).body.data;
  const toll = accsToll.find((x) => x.name === '限流测试号');
  for (const x of accsToll) {
    const want = x.id === toll.id || x.id === a.id;
    if (x.enabled !== want) await api('/admin/api/accounts/' + x.id, { method: 'PATCH', body: JSON.stringify({ enabled: want }) });
  }
  const t429 = await req('/v1/chat/completions', jpost(chatBody('toll-1'), auth(vkey)));
  check('429 后自动换号，请求仍成功', t429.status === 200 && tagOf(t429) === 'user_ok11111',
    `status=${t429.status} tag=${tagOf(t429)}`);
  const tollAfter = (await api('/admin/api/accounts')).body.data.find((x) => x.id === toll.id);
  check('限流账号进入冷却', tollAfter.status === 'cooldown', `status=${tollAfter.status}`);

  section('恢复默认与清理');
  await api('/admin/api/settings', { method: 'PATCH', body: JSON.stringify({ strategy: original || 'round_robin' }) });
  const set = (await api('/admin/api/settings')).body.data;
  check('策略已恢复', set.strategy === (original || 'round_robin'), `strategy=${set.strategy}`);
  for (const x of (await api('/admin/api/accounts')).body.data) {
    if (x.enabled !== true) await api('/admin/api/accounts/' + x.id, { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
  }
  check('账号已全部恢复启用', (await api('/admin/api/accounts')).body.data.every((x) => x.enabled === true));
  await api('/admin/api/vkeys/' + vk.body.data.id, { method: 'DELETE' });

  console.log(out.join('\n'));
  console.log(`\n──────────────\n通过 ${pass} / ${pass + fail}${fail ? `，失败 ${fail}` : '，全部通过'}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log(out.join('\n'));
  console.error('\n验证脚本异常：', e.message);
  process.exit(1);
});
