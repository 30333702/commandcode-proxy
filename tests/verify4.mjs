/**
 * 第四轮验证：Usage Limits（5 小时 / 周 / 月度额度）
 * mock 默认形态对齐参考面板数值：5h 27% / 周 66% / 月度 40%（Pro 上限 30，剩余 18）
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
const section = (s) => out.push(`\n=== ${s} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (w) => (w && w.cap > 0 ? Math.round((w.used / w.cap) * 100) : null);

(async () => {
  const login = await req('/admin/api/login', jpost({ password: 'newpass123' }));
  if (!login.body.token) { console.error('登录失败:', login.body); process.exit(1); }
  const token = login.body.token;
  const api = (p, o = {}) => req(p, { ...o, headers: { ...(o.headers || {}), Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });

  section('准备');
  let accs = (await api('/admin/api/accounts')).body.data;
  if (!accs.find((a) => a.name === 'ok号A')) {
    await api('/admin/api/accounts', jpost({ keys: 'user_ok111111\nuser_bad44444\nuser_snake777', names: 'ok号A\nbad号\nsnake号' }, auth(token)));
    accs = (await api('/admin/api/accounts')).body.data;
  }
  const okA = accs.find((a) => a.name === 'ok号A') || accs.find((a) => a.name === '主号A');
  const bad = accs.find((a) => a.name === 'bad号') || accs.find((a) => a.name === '坏Key');
  const snake = accs.find((a) => a.name === 'snake号');
  check('测试账号就绪', !!(okA && bad && snake), `账号数=${accs.length}`);

  section('额度接口');
  const snap = await api('/admin/api/usage');
  check('GET /admin/api/usage', snap.status === 200 && Array.isArray(snap.body.data) && snap.body.data.length === accs.length,
    `账号数=${(snap.body.data || []).length}`);
  check('返回结构含 id/name/usage 字段', snap.body.data.every((r) => 'id' in r && 'name' in r && 'usage' in r));

  const refreshOk = await api('/admin/api/usage/refresh', { method: 'POST', body: JSON.stringify({ id: okA.id }) });
  const u = refreshOk.body.data;
  check('单账号额度刷新成功', refreshOk.status === 200 && refreshOk.body.ok === true, refreshOk.body.error || '');

  section('窗口解析（对齐 5h 27% / 周 66% / 月度 40%）');
  check('5 小时窗口', pct(u.windows.fiveHour) === 27, `used=${u.windows.fiveHour.used} cap=${u.windows.fiveHour.cap} → ${pct(u.windows.fiveHour)}%`);
  check('周窗口', pct(u.windows.weekly) === 66, `used=${u.windows.weekly.used} cap=${u.windows.weekly.cap} → ${pct(u.windows.weekly)}%`);
  check('月度窗口（按套餐推算）', pct(u.windows.monthly) === 40 && u.windows.monthly.derived === true,
    `used=${u.windows.monthly.used} cap=${u.windows.monthly.cap} → ${pct(u.windows.monthly)}% derived=${u.windows.monthly.derived}`);
  check('月度推算值 = 上限 − 月度剩余', u.windows.monthly.used === u.windows.monthly.cap - u.credits.monthlyCredits,
    `${u.windows.monthly.cap} − ${u.credits.monthlyCredits} = ${u.windows.monthly.used}`);
  check('套餐识别', u.plan && u.plan.planId === 'individual-pro' && u.plan.name === 'Pro', JSON.stringify(u.plan));
  check('余额字段', u.credits.monthlyCredits === 18 && u.credits.purchasedCredits === 5 && u.credits.freeCredits === 2,
    `月度=${u.credits.monthlyCredits} 充值=${u.credits.purchasedCredits} 免费=${u.credits.freeCredits}`);
  check('账期统计（含 successRate 为百分数）',
    u.summary && u.summary.totalCount === 3537 && u.summary.successRate === 100 && u.summary.periodBasis === 'billing-period',
    `请求=${u.summary.totalCount} 成功率=${u.summary.successRate} 口径=${u.summary.periodBasis}`);
  check('账期统计字段齐全（tokens / 单均成本 / 成功失败）',
    u.summary.averageCost === 0.0017 && u.summary.totalTokensIn === 512000000 &&
    u.summary.totalTokensOut === 3805000 && u.summary.completedCount === 3537 && u.summary.failedCount === 0,
    `单均=${u.summary.averageCost} in=${u.summary.totalTokensIn} out=${u.summary.totalTokensOut}`);

  section('重置时间文案分类（对应 3 种展示形态）');
  const now = Date.now();
  const fh = u.windows.fiveHour.resetAt - now;
  const wk = u.windows.weekly.resetAt - now;
  const mo = u.windows.monthly.resetAt - now;
  check('5 小时窗口 → 分钟级文案', fh > 0 && fh < 3600 * 1000, `${Math.round(fh / 60000)} 分钟后重置`);
  check('周窗口 → 天+小时文案', wk > 4 * 86400e3 && wk < 7 * 86400e3, `${Math.floor(wk / 86400e3)} 天 ${Math.floor((wk % 86400e3) / 3600e3)} 小时后重置`);
  check('月度窗口 → 日期文案（>7 天）', mo > 7 * 86400e3, `${new Date(u.windows.monthly.resetAt).toISOString().slice(0, 10)} 重置`);
  check('身份信息已解析', !!(u.identity && u.identity.userName), JSON.stringify(u.identity));

  section('字段容错（snake_case + ISO/秒级时间戳）');
  await api('/admin/api/usage/refresh', { method: 'POST', body: JSON.stringify({ id: snake.id }) });
  const s = (await api('/admin/api/usage')).body.data.find((r) => r.id === snake.id).usage;
  check('snake_case 已用/上限归一化', pct(s.windows.fiveHour) === 50,
    `used_credits=${s.windows.fiveHour.used} capCredits=${s.windows.fiveHour.cap} → ${pct(s.windows.fiveHour)}%`);
  check('ISO 字符串 reset_at 解析为毫秒时间戳', s.windows.fiveHour.resetAt > now, new Date(s.windows.fiveHour.resetAt).toISOString());
  check('秒级 epoch 时间戳已转毫秒', s.windows.weekly.resetAt > 1e12, String(s.windows.weekly.resetAt));
  check('monthly_credits 归一化 + 月度推算', s.windows.monthly && s.windows.monthly.cap === 30 && s.windows.monthly.used === 5,
    `cap=${s.windows.monthly.cap} used=${s.windows.monthly.used}`);

  section('失败处理');
  // 先记录刷新前的健康状态：坏 Key 可能已被前面的用例（401）自动禁用，
  // 这里要验证的是「额度查询不改动它」，而不是它当前是否可用
  const beforeBad = (await api('/admin/api/accounts')).body.data.find((a) => a.id === bad.id);
  const badRefresh = await api('/admin/api/usage/refresh', { method: 'POST', body: JSON.stringify({ id: bad.id }) });
  check('坏 Key 刷新返回失败标记', badRefresh.status === 200 && badRefresh.body.ok === false && badRefresh.body.authFailed === true,
    badRefresh.body.error || '');
  const badRow = (await api('/admin/api/usage')).body.data.find((r) => r.id === bad.id);
  check('失败原因写入该账号 usage.error', !!(badRow.usage && badRow.usage.error), badRow.usage && badRow.usage.error);
  const badAcc = (await api('/admin/api/accounts')).body.data.find((a) => a.id === bad.id);
  check('额度查询不改变账号健康状态（无副作用）',
    beforeBad.enabled === badAcc.enabled && beforeBad.status === badAcc.status,
    `刷新前 ${beforeBad.enabled}/${beforeBad.status} → 刷新后 ${badAcc.enabled}/${badAcc.status}`);
  check('其他账号额度不受影响', (await api('/admin/api/usage')).body.data.find((r) => r.id === okA.id).usage.windows.fiveHour.used === 2.7);

  section('全部刷新');
  const all = await api('/admin/api/usage/refresh', { method: 'POST', body: '{}' });
  check('批量刷新返回统计', all.status === 200 && all.body.total === accs.length,
    `total=${all.body.total} refreshed=${all.body.refreshed} failed=${all.body.failed.length}`);
  check('失败账号被单独列出', all.body.failed.some((f) => f.id === bad.id), JSON.stringify(all.body.failed.map((f) => f.name)));

  section('设置项');
  const set1 = await api('/admin/api/settings', { method: 'PATCH', body: JSON.stringify({ usageRefreshMinutes: 30 }) });
  check('保存额度自动刷新间隔', set1.body.data.usageRefreshMinutes === 30, `usageRefreshMinutes=${set1.body.data.usageRefreshMinutes}`);
  const set2 = await api('/admin/api/settings', { method: 'PATCH', body: JSON.stringify({ usageRefreshMinutes: 0 }) });
  check('可关闭自动刷新', set2.body.data.usageRefreshMinutes === 0);

  section('脱敏');
  check('额度数据不含账号明文 Key', !JSON.stringify(snap.body).includes('user_ok111111'));

  section('添加账号自动拉取额度');
  const addResp = await api('/admin/api/accounts', jpost({ keys: 'user_ok555555', names: '自动额度号' }));
  check('添加成功', addResp.status === 200 && addResp.body.added === 1, JSON.stringify(addResp.body).slice(0, 90));
  await sleep(3200); // 后端对新账号异步拉取额度（fire-and-forget）
  const newRow = (await api('/admin/api/usage')).body.data.find((r) => r.name === '自动额度号');
  check('新账号的额度卡片数据已自动就位',
    !!(newRow && newRow.usage && newRow.usage.fetchedAt > 0),
    newRow && newRow.usage ? 'fetchedAt=' + new Date(newRow.usage.fetchedAt).toISOString() : 'usage 为空');

  section('虚拟 Key 粘性账号手动指定');
  const vkr = await api('/admin/api/vkeys', jpost({ name: '粘性指定Key' }));
  const vkId = vkr.body.data.id;
  const target = (await api('/admin/api/accounts')).body.data.find((x) => x.name === '自动额度号');
  await api('/admin/api/vkeys/' + vkId, { method: 'PATCH', body: JSON.stringify({ lastAccountId: target.id }) });
  let pinned = (await api('/admin/api/vkeys')).body.data.find((k) => k.id === vkId);
  check('PATCH lastAccountId 生效', pinned.lastAccountId === target.id, `lastAccountId=${pinned.lastAccountId}`);
  await api('/admin/api/vkeys/' + vkId, { method: 'PATCH', body: JSON.stringify({ lastAccountId: '' }) });
  pinned = (await api('/admin/api/vkeys')).body.data.find((k) => k.id === vkId);
  check('空串解绑生效', pinned.lastAccountId === '', `lastAccountId=${JSON.stringify(pinned.lastAccountId)}`);
  await api('/admin/api/vkeys/' + vkId, { method: 'PATCH', body: JSON.stringify({ lastAccountId: 'acc_not_exists' }) });
  pinned = (await api('/admin/api/vkeys')).body.data.find((k) => k.id === vkId);
  check('不存在的账号 id 被拒绝', pinned.lastAccountId === '', `lastAccountId=${JSON.stringify(pinned.lastAccountId)}`);
  await api('/admin/api/vkeys/' + vkId, { method: 'DELETE' });
  // 清理：删掉自动额度号，避免影响其他用例的账号计数
  const delResp = await api('/admin/api/accounts/' + target.id, { method: 'DELETE' });
  check('临时账号已清理', delResp.body.ok === true);

  console.log(out.join('\n'));
  console.log(`\n──────────────\n通过 ${pass} / ${pass + fail}${fail ? `，失败 ${fail}` : '，全部通过'}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log(out.join('\n'));
  console.error('\n验证脚本异常：', e.message);
  process.exit(1);
});
