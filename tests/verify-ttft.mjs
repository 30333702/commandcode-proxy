/** 非流式 + 流式请求的 elapsedMs / ttftMs 记录验证 */
const BASE = 'http://127.0.0.1:3052';
let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  (' + d + ')' : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  (' + d + ')' : '')); } };

let login = await (await fetch(BASE + '/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'newpass123' }) })).json();
if (!login.ok) login = await (await fetch(BASE + '/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'admin123' }) })).json();
const H = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
const api = async (p, o = {}) => (await fetch(BASE + '/admin/api/' + p, { method: o.method || 'GET', headers: H, body: o.body ? JSON.stringify(o.body) : undefined })).json();

// 非流式 + 流式都走慢号（mock 延迟 ~700ms），保证 ttft 有可区分的正值
const acc = await api('accounts', { method: 'POST', body: { keys: 'user_slow_ttft01', names: 'TTFT账号' } });
if (!acc.added) { console.error('账号添加失败: ' + JSON.stringify(acc).slice(0, 200)); process.exit(1); }
// 隔离：只留慢号，排除其它套件遗留账号的轮询干扰
await api('accounts/bulk', { method: 'POST', body: { action: 'disable' } });
await api('accounts/bulk', { method: 'POST', body: { action: 'enable', ids: acc.addedIds } });
const vk = (await api('vkeys', { method: 'POST', body: { name: 'TTFT本地' } })).data;
const wall0 = Date.now();
await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + vk.key }, body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }) });
const wall1 = Date.now();
// 流式
await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + vk.key }, body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: true }) });
const wall2 = Date.now();

console.log('墙钟：非流式 ' + (wall1 - wall0) + 'ms，流式 ' + (wall2 - wall1) + 'ms');
const logs = (await api('logs?from=' + (wall0 - 3000))).data;
const rows = logs.filter((l) => l.endpoint === '/v1/chat/completions');
console.log('日志 ' + rows.length + ' 条：');
for (const l of rows) console.log('  stream前后 status=' + l.status + ' elapsed=' + l.elapsedMs + ' ttft=' + l.ttftMs);

const nn = rows.filter((l) => l.vkey === 'TTFT本地' && typeof l.ttftMs === 'number' && typeof l.elapsedMs === 'number');
check('非流式请求的耗时/首字已记录（此前一直是 0）', nn.length >= 2, nn.map((l) => 'ttft=' + l.ttftMs + '/elapsed=' + l.elapsedMs).join(' | '));
check('慢号首字 ≥ 500ms（真实测量而非默认值）', nn.every((l) => l.ttftMs >= 500));
check('首字 ≤ 总耗时', nn.every((l) => l.ttftMs <= l.elapsedMs));
check('数值与墙钟时间吻合（±1500ms）', nn.every((l) => l.elapsedMs < wall2 - wall0 + 1500));

await api('vkeys/' + vk.id, { method: 'DELETE' });
const accId = (acc.addedIds || [])[0];
if (accId) await api('accounts/' + accId, { method: 'DELETE' });
await api('accounts/bulk', { method: 'POST', body: { action: 'enable' } }); // 恢复其余账号
console.log('\n通过 ' + pass + ' / ' + (pass + fail) + (fail ? '，失败 ' + fail : '，全部通过'));
process.exit(fail ? 1 : 0);
