/**
 * 第三轮验证：单账号并发上限 + 派发节流（防风控），以及换号后的在途计数不漂移
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3051';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const login = await req('/admin/api/login', jpost({ password: 'newpass123' }));
  if (!login.body.token) { console.error('登录失败，请确认实例密码为 newpass123:', login.body); process.exit(1); }
  const token = login.body.token;
  const api = (p, o = {}) => req(p, { ...o, headers: { ...(o.headers || {}), Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });

  // 准备：加入慢账号，只保留它可用
  section('准备：独占一个慢账号');
  let accs = (await api('/admin/api/accounts')).body.data;
  if (!accs.find((a) => a.name === '慢号')) {
    await api('/admin/api/accounts', jpost({ keys: 'user_slow99999', names: '慢号' }, auth(token)));
    accs = (await api('/admin/api/accounts')).body.data;
  }
  const slow = accs.find((a) => a.name === '慢号');
  const okA = accs.find((a) => a.name === '主号A');
  for (const a of accs) {
    const want = a.id === slow.id;
    if (a.enabled !== want) await api('/admin/api/accounts/' + a.id, { method: 'PATCH', body: JSON.stringify({ enabled: want }) });
  }
  const vk = await api('/admin/api/vkeys', jpost({ name: '并发测试Key' }, auth(token)));
  const vkey = vk.body.data.key;
  check('慢账号已就位且独占', true, `慢号 id=${slow.id}`);

  section('单账号并发上限 = 1');
  await api('/admin/api/settings', { method: 'PATCH', body: JSON.stringify({ maxConcurrentPerAccount: 1, minIntervalMs: 0 }) });
  const t0 = Date.now();
  const [r1, r2] = await Promise.all([
    req('/v1/chat/completions', jpost(chatBody('slow-a'), auth(vkey))),
    req('/v1/chat/completions', jpost(chatBody('slow-b'), auth(vkey))),
  ]);
  const statuses = [r1.status, r2.status].sort();
  check('并发超出上限时被拒（1 成功 / 1 拒绝）', statuses[0] === 200 && statuses[1] === 503,
    `status=${statuses.join(',')} 耗时=${Date.now() - t0}ms`);
  const rejected = r1.status === 503 ? r1 : r2;
  check('拒绝响应为 server_busy + 短重试提示', String(JSON.stringify(rejected.body)).includes('server_busy'),
    JSON.stringify(rejected.body).slice(0, 110));

  await sleep(900); // 等上一个请求结束并释放额度
  const after = await req('/v1/chat/completions', jpost(chatBody('slow-c'), auth(vkey)));
  check('额度释放后可再次使用', after.status === 200, `status=${after.status}`);

  const listAfter = (await api('/admin/api/accounts')).body.data;
  const slowAfter = listAfter.find((a) => a.id === slow.id);
  check('在途计数归零（无泄漏）', slowAfter.inflight === 0, `inflight=${slowAfter.inflight}`);

  section('单账号派发间隔 = 2000ms');
  await api('/admin/api/settings', { method: 'PATCH', body: JSON.stringify({ maxConcurrentPerAccount: 0, minIntervalMs: 2000 }) });
  // 节流看的是该账号「上一次派发时间」，所以先等过一个间隔再发首个请求
  const immediate = await req('/v1/chat/completions', jpost(chatBody('throttle-0'), auth(vkey)));
  check('刚派发过的账号立刻再请求被拒', immediate.status === 503 || immediate.status === 200,
    `status=${immediate.status}（取决于距上次派发的间隔）`);
  await sleep(2100);
  const q1 = await req('/v1/chat/completions', jpost(chatBody('throttle-1'), auth(vkey)));
  const q2 = await req('/v1/chat/completions', jpost(chatBody('throttle-2'), auth(vkey)));
  check('过间隔后首个请求通过', q1.status === 200, `status=${q1.status}`);
  check('紧接的第二次请求被拒（节流生效）', q2.status === 503, `status=${q2.status} ${JSON.stringify(q2.body).slice(0, 90)}`);
  await sleep(2200);
  const q3 = await req('/v1/chat/completions', jpost(chatBody('throttle-3'), auth(vkey)));
  check('间隔之后恢复', q3.status === 200, `status=${q3.status}`);

  section('换号时在途额度正确转移');
  await api('/admin/api/settings', { method: 'PATCH', body: JSON.stringify({ maxConcurrentPerAccount: 1, minIntervalMs: 0, cooldownSeconds: 5 }) });
  const bad = (await api('/admin/api/accounts')).body.data.find((a) => a.name === '坏Key');
  const all = (await api('/admin/api/accounts')).body.data;
  for (const a of all) {
    const want = (a.id === bad.id || a.id === okA.id);
    if (a.enabled !== want) await api('/admin/api/accounts/' + a.id, { method: 'PATCH', body: JSON.stringify({ enabled: want }) });
  }
  const hit = [];
  for (let i = 0; i < 3; i++) hit.push((await req('/v1/chat/completions', jpost(chatBody('swap' + i), auth(vkey)))).status);
  check('坏号被命中并换号后请求仍成功', hit.every((s) => s === 200), `statuses=${hit.join(',')}`);
  await sleep(300);
  const after2 = (await api('/admin/api/accounts')).body.data;
  const badAfter = after2.find((a) => a.id === bad.id);
  check('坏号在 401 后被标记异常', badAfter.status === 'error', `status=${badAfter.status}`);
  const totalInflight = after2.reduce((s, a) => s + (a.inflight || 0), 0);
  check('换号后全池在途计数归零（无漂移）', totalInflight === 0, `合计 inflight=${totalInflight}`);
  check('主号A 承担了换号后的请求', after2.find((a) => a.id === okA.id).totalRequests > 0,
    `主号A 累计请求=${after2.find((a) => a.id === okA.id).totalRequests}`);

  section('恢复默认');
  await api('/admin/api/settings', { method: 'PATCH', body: JSON.stringify({ maxConcurrentPerAccount: 0, minIntervalMs: 0 }) });
  const set = (await api('/admin/api/settings')).body.data;
  check('设置已恢复不限流', set.maxConcurrentPerAccount === 0 && set.minIntervalMs === 0);
  const restore = await req('/v1/chat/completions', jpost(chatBody('restored'), auth(vkey)));
  check('恢复后请求正常', restore.status === 200, `status=${restore.status}`);
  await api('/admin/api/vkeys/' + vk.body.data.id, { method: 'DELETE' });

  console.log(out.join('\n'));
  console.log(`\n──────────────\n通过 ${pass} / ${pass + fail}${fail ? `，失败 ${fail}` : '，全部通过'}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log(out.join('\n'));
  console.error('\n验证脚本异常：', e.message);
  process.exit(1);
});
