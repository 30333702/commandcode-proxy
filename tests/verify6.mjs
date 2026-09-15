/**
 * 第六轮验证：对齐 sub2api / CLIProxyAPI(CPA) 生态补齐的能力
 *   1) x-goog-api-key 认证（Google SDK 客户端）
 *   2) 虚拟 Key 日限额（按自然日重置）
 *   3) 用量维度统计（近 7 日按 Key / 按模型）
 *   4) 账号批量运维（bulk enable/disable/reset/delete + prune）
 *   5) 删除账号/清理时自动解绑粘性
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
const section = (s) => out.push(`\n=== ${s} ===`);
const chatBody = (txt = 'ping') => ({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: txt }] });
// 从响应里取出「哪个账号服务的」标记（mock：正常号 served-by:xxx，慢号 [slow:xxx]）
const tagOf = (r) => {
  const txt = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  return (/served-by:([a-z0-9_]+)/i.exec(txt) || /\[slow:([a-z0-9_]+)\]/i.exec(txt) || [])[1] || '';
};

(async () => {
  const login = await req('/admin/api/login', jpost({ password: 'admin123' }));
  if (login.body.token) { console.error('预期首次运行需改密码，当前已是改过的密码，请用 newpass123'); }
  const login2 = await req('/admin/api/login', jpost({ password: 'newpass123' }));
  const token = (login2.body.token) || (login.body.token);
  if (!token) { console.error('登录失败:', JSON.stringify(login.body).slice(0, 120)); process.exit(1); }
  const api = (p, o = {}) => req(p, { ...o, headers: { ...(o.headers || {}), Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });

  // ── 准备：两个可用账号 ──
  const accs = (await api('/admin/api/accounts')).body.data;
  const okA = accs.find((a) => a.name === '主号A') || accs[0];
  const okB = accs.find((a) => a.name === '主号B') || accs[1];
  await api('/admin/api/accounts/bulk', jpost({ action: 'enable', ids: [okA.id, okB.id] }));

  section('x-goog-api-key 认证（Google SDK 风格）');
  const vk = await api('/admin/api/vkeys', jpost({ name: 'verify6-GoogleKey' }));
  const vkey = vk.body.data.key;
  const g1 = await req('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': vkey },
    body: JSON.stringify(chatBody('google-header')),
  });
  const g1ok = g1.status === 200 && g1.body && Array.isArray(g1.body.choices) && g1.body.choices.length > 0;
  check('仅带 x-goog-api-key 即可调用（虚拟 Key）', g1ok,
    `status=${g1.status} content=${JSON.stringify((g1.body && g1.body.choices && g1.body.choices[0] && g1.body.choices[0].message && g1.body.choices[0].message.content) || '').slice(0, 40)}`);
  const g2 = await req('/v1/models', { headers: { 'x-goog-api-key': vkey } });
  check('x-goog-api-key 也适用于 /v1/models', g2.status === 200, `status=${g2.status}`);
  const g3 = await req('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'user_bad99999' },
    body: JSON.stringify(chatBody('google-bad')),
  });
  check('x-goog-api-key 的 user_* Key 仍走透传（401）', g3.status === 401, `status=${g3.status}`);

  section('虚拟 Key 日限额');
  const dvk = await api('/admin/api/vkeys', jpost({ name: 'verify6-DailyLimit', limitDaily: 2 }));
  const dkey = dvk.body.data.key;
  const r1 = await req('/v1/chat/completions', jpost(chatBody('d1'), auth(dkey)));
  const r2 = await req('/v1/chat/completions', jpost(chatBody('d2'), auth(dkey)));
  const r3 = await req('/v1/chat/completions', jpost(chatBody('d3'), auth(dkey)));
  check('日限额内前两次通过', r1.status === 200 && r2.status === 200, `status=${r1.status}/${r2.status}`);
  check('超出日限额 → 429 且带重置时间', r3.status === 429 && Number(r3.body.retry_after) > 0,
    `status=${r3.status} retry_after=${r3.body.retry_after}`);
  const dvkAfter = (await api('/admin/api/vkeys')).body.data.find((k) => k.id === dvk.body.data.id);
  // 只有真正派发到上游的请求才计入（被限额挡下的第 3 次不记账，否则计数永远追不上限额）
  check('日限额用量按 Key 记账（仅成功派发的请求）', dvkAfter.usedToday === 2, `usedToday=${dvkAfter.usedToday}`);
  const upD = await api('/admin/api/vkeys/' + dvk.body.data.id, { method: 'PATCH', body: JSON.stringify({ limitDaily: 0 }) });
  check('可解除日限额', upD.body.ok === true);
  const r4 = await req('/v1/chat/completions', jpost(chatBody('d4'), auth(dkey)));
  check('解除后立刻恢复', r4.status === 200, `status=${r4.status}`);

  section('用量维度统计（近 7 日）');
  const ov = (await api('/admin/api/overview')).body.data;
  check('概览含按 Key 聚合', Array.isArray(ov.byKey7) && ov.byKey7.length > 0, `byKey7=${ov.byKey7.length} 项`);
  const mine = (ov.byKey7 || []).find((k) => k.id === dvk.body.data.id);
  check('该 Key 的统计已入账', !!mine && mine.requests === 3, mine ? `requests=${mine.requests} ok=${mine.ok}` : '未找到');
  check('统计带 Key 名称（便于面板展示）', !!mine && mine.name === 'verify6-DailyLimit', mine && mine.name);
  check('概览含按模型聚合', Array.isArray(ov.byModel7) && ov.byModel7.length > 0,
    (ov.byModel7 || []).map((m) => m.model + ':' + m.requests).join(', ').slice(0, 80));
  const mrow = (ov.byModel7 || []).find((m) => m.model === 'deepseek/deepseek-v4-flash');
  check('模型维度记录请求数与 tokens', !!mrow && mrow.requests > 0 && mrow.inputTokens > 0,
    mrow ? `requests=${mrow.requests} in=${mrow.inputTokens} out=${mrow.outputTokens}` : '未找到');
  check('近 7 日明细含缓存 tokens 字段', Array.isArray(ov.daily7) && ov.daily7.length === 7 &&
    ov.daily7.every((d) => typeof d.cachedTokens === 'number'), `cachedTokens=${(ov.daily7 || []).map((d) => d.cachedTokens).join(',')}`);

  section('账号批量运维');
  const addTmp = await api('/admin/api/accounts', jpost({ keys: 'user_bad77777\nuser_ok888888', names: '批量坏号\n批量好号' }));
  check('准备：添加两个账号', addTmp.body.added === 2, `added=${addTmp.body.added}`);
  const tmpAccs = (await api('/admin/api/accounts')).body.data;
  const tmpIds = tmpAccs.filter((a) => a.name === '批量坏号' || a.name === '批量好号').map((a) => a.id);
  const dis = await api('/admin/api/accounts/bulk', jpost({ action: 'disable', ids: tmpIds }));
  check('批量禁用', dis.body.affected === 2, `affected=${dis.body.affected}`);
  let after = (await api('/admin/api/accounts')).body.data;
  check('禁用生效', tmpIds.every((id) => after.find((a) => a.id === id).enabled === false));
  const en = await api('/admin/api/accounts/bulk', jpost({ action: 'enable', ids: tmpIds }));
  check('批量启用', en.body.affected === 2);
  after = (await api('/admin/api/accounts')).body.data;
  check('启用生效', tmpIds.every((id) => after.find((a) => a.id === id).enabled === true));
  const delEmpty = await api('/admin/api/accounts/bulk', jpost({ action: 'delete', ids: [] }));
  check('批量删除必须显式给 ids（防误删全部）', delEmpty.body.ok === false, `error=${delEmpty.body.error}`);
  const del = await api('/admin/api/accounts/bulk', jpost({ action: 'delete', ids: tmpIds }));
  check('批量删除', del.body.affected === 2, `affected=${del.body.affected}`);
  after = (await api('/admin/api/accounts')).body.data;
  check('删除后不再出现', tmpIds.every((id) => !after.find((a) => a.id === id)));

  section('清理失效账号 + 粘性解绑');
  // 401 自动禁用是本用例的前提，显式设置，避免被其他套件改过的设置影响
  await api('/admin/api/settings', { method: 'PATCH', body: JSON.stringify({ authErrorDisable: true }) });
  const badKey = 'user_bad' + Math.random().toString(36).slice(2, 8); // 唯一 key，保证用例可重复运行
  const badAdd = await api('/admin/api/accounts', jpost({ keys: badKey, names: '待清理坏号' }));
  check('准备：添加一个坏 Key', badAdd.body.added === 1, `added=${badAdd.body.added}`);
  const badId = badAdd.body.addedIds[0];
  // 隔离：先禁用池子里所有账号，只留这个坏号，确保请求一定落到它身上
  await api('/admin/api/accounts/bulk', jpost({ action: 'disable' }));
  await api('/admin/api/accounts/bulk', jpost({ action: 'enable', ids: [badId] }));
  await req('/v1/chat/completions', jpost(chatBody('prune-probe'), auth(vkey)));
  const badState = (await api('/admin/api/accounts')).body.data.find((a) => a.id === badId);
  check('坏 Key 已被标记并自动禁用', badState.status === 'error' && badState.enabled === false,
    `status=${badState.status} enabled=${badState.enabled}`);
  // 把粘性绑定指到坏号，验证清理时自动解绑
  await api('/admin/api/vkeys/' + vk.body.data.id, { method: 'PATCH', body: JSON.stringify({ lastAccountId: badId }) });
  const pruned = await api('/admin/api/accounts/prune', { method: 'POST' });
  check('一键清理失效账号', pruned.body.removed >= 1, `removed=${pruned.body.removed}`);
  check('清理时自动解绑粘性绑定', pruned.body.pinsCleared >= 1, `pinsCleared=${pruned.body.pinsCleared}`);
  const vkPinned = (await api('/admin/api/vkeys')).body.data.find((k) => k.id === vk.body.data.id);
  check('绑定已清空（不再指向已删除账号）', vkPinned.lastAccountId === '', `lastAccountId=${JSON.stringify(vkPinned.lastAccountId)}`);

  section('粘性绑定：改绑与取消（面板操作路径）');
  // 场景来源：面板上「粘住」按钮此前发出的请求体被二次序列化，导致改绑/解绑静默失效
  await api('/admin/api/settings', { method: 'PATCH', body: JSON.stringify({ strategy: 'sticky' }) });
  await api('/admin/api/accounts/bulk', jpost({ action: 'disable' }));
  await api('/admin/api/accounts/bulk', jpost({ action: 'enable', ids: [okA.id, okB.id] }));
  const k1 = (await api('/admin/api/vkeys', jpost({ name: 'pin-切换测试' }))).body.data;
  const k2 = (await api('/admin/api/vkeys', jpost({ name: 'pin-独立测试' }))).body.data;

  const pin = async (vkId, accId) => (await api('/admin/api/vkeys/' + vkId, { method: 'PATCH', body: JSON.stringify({ lastAccountId: accId }) })).body;

  await pin(k1.id, okA.id);
  let t = tagOf(await req('/v1/chat/completions', jpost(chatBody('pin-a'), auth(k1.key))));
  check('绑定到主号A 后请求固定走主号A', t === 'user_ok11111', `实际=${t}`);

  // 用户报告 1：切换不了别的账号
  await pin(k1.id, okB.id);
  t = tagOf(await req('/v1/chat/completions', jpost(chatBody('pin-b'), auth(k1.key))));
  check('改绑到主号B 后请求立刻走主号B', t === 'user_ok22222', `实际=${t}`);

  // 用户报告 2：粘性取消不了
  const unpin = await pin(k1.id, '');
  check('解绑请求成功', unpin.ok === true, JSON.stringify(unpin).slice(0, 60));
  const k1After = (await api('/admin/api/vkeys')).body.data.find((x) => x.id === k1.id);
  check('解绑后绑定字段已清空', k1After.lastAccountId === '', `lastAccountId=${JSON.stringify(k1After.lastAccountId)}`);
  check('解绑即关闭粘性（stickyOff=true）', k1After.stickyOff === true, `stickyOff=${k1After.stickyOff}`);

  // 关键：解绑之后连续请求，不能被 sticky 自动粘回去（否则用户看到的就是「取消无效」）
  const afterUnpin = [];
  for (let i = 0; i < 3; i++) afterUnpin.push(tagOf(await req('/v1/chat/completions', jpost(chatBody('unpinned-' + i), auth(k1.key)))));
  const k1Rebound = (await api('/admin/api/vkeys')).body.data.find((x) => x.id === k1.id);
  check('取消粘性后不会被自动粘回（这是「取消失效」的根因）',
    k1Rebound.lastAccountId === '' && k1Rebound.stickyOff === true,
    `请求命中=${afterUnpin.join(',')} 绑定=${JSON.stringify(k1Rebound.lastAccountId)}`);
  check('取消粘性后仍能正常派发（按策略调度）', afterUnpin.every((t) => t !== '') && afterUnpin.length === 3, afterUnpin.join(','));

  // 重新指定账号 = 恢复粘性
  await pin(k1.id, okA.id);
  const rePinned = (await api('/admin/api/vkeys')).body.data.find((x) => x.id === k1.id);
  check('重新指定账号后恢复粘性', rePinned.lastAccountId === okA.id && rePinned.stickyOff === false,
    `绑定=${rePinned.lastAccountId} stickyOff=${rePinned.stickyOff}`);
  t = tagOf(await req('/v1/chat/completions', jpost(chatBody('repin'), auth(k1.key))));
  check('恢复粘性后请求又回到指定账号', t === 'user_ok11111', `实际=${t}`);

  // 多 Key 场景：两个 Key 可以各自绑定不同账号，互不干扰
  await pin(k2.id, okB.id);
  const both = (await api('/admin/api/vkeys')).body.data.filter((x) => x.id === k1.id || x.id === k2.id);
  check('多个 Key 可分别绑定（互不影响）',
    both.find((x) => x.id === k1.id).lastAccountId === okA.id && both.find((x) => x.id === k2.id).lastAccountId === okB.id,
    both.map((x) => x.name + '→' + (x.lastAccountId || '未绑定')).join(' | '));

  // 绑定到不存在的账号不应改变既有绑定（服务端校验）
  const beforeBad = (await api('/admin/api/vkeys')).body.data.find((x) => x.id === k1.id).lastAccountId;
  await pin(k1.id, 'acc_not_exists');
  const afterBad = (await api('/admin/api/vkeys')).body.data.find((x) => x.id === k1.id).lastAccountId;
  check('绑定不存在的账号被拒绝（原绑定保持不变）', afterBad === beforeBad && afterBad !== 'acc_not_exists',
    `前=${beforeBad} 后=${afterBad}`);

  await api('/admin/api/vkeys/' + k1.id, { method: 'DELETE' });
  await api('/admin/api/vkeys/' + k2.id, { method: 'DELETE' });

  section('日志查询：全部 + 时间筛选');
  await req('/v1/chat/completions', jpost(chatBody('log-filter-probe'), auth(vkey)));
  const allLogs = (await api('/admin/api/logs')).body.data;
  check('日志接口返回全部（不再封顶 100 条）', Array.isArray(allLogs) && allLogs.length > 0, `共 ${allLogs.length} 条`);
  const future = (await api('/admin/api/logs?from=' + (Date.now() + 3600000))).body.data;
  check('from 在未来 → 空结果', future.length === 0, `共 ${future.length} 条`);
  const recent = (await api('/admin/api/logs?from=' + (Date.now() - 60000))).body.data;
  check('近 1 分钟的请求能被筛出且是全集的子集', recent.length >= 1 && recent.length <= allLogs.length,
    `近1分钟=${recent.length} / 全部=${allLogs.length}`);
  const win = (await api('/admin/api/logs?from=' + (Date.now() - 60000) + '&to=' + (Date.now() + 60000))).body.data;
  check('from+to 双边界过滤生效', win.length === recent.length, `区间内=${win.length}`);
  check('日志按时间倒序（最新在前）', allLogs[0].t >= allLogs[allLogs.length - 1].t);

  section('恢复环境');
  await api('/admin/api/settings', { method: 'PATCH', body: JSON.stringify({ strategy: 'round_robin' }) });
  await api('/admin/api/accounts/bulk', jpost({ action: 'enable' })); // 全部恢复启用
  await api('/admin/api/vkeys/' + vk.body.data.id, { method: 'DELETE' });
  await api('/admin/api/vkeys/' + dvk.body.data.id, { method: 'DELETE' });
  check('环境已恢复', (await api('/admin/api/accounts')).body.data.filter((a) => a.enabled).length >= 2);

  console.log(out.join('\n'));
  console.log(`\n──────────────\n通过 ${pass} / ${pass + fail}${fail ? `，失败 ${fail}` : '，全部通过'}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e.message);
  process.exit(1);
});
