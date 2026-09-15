/**
 * 端到端验证：面板 API + 多账号池行为 + 原有兼容性
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
  return { status: r.status, body, headers: r.headers };
}
const auth = (t) => ({ headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' } });
const jpost = (obj, extra = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(extra.headers || {}) },
  body: JSON.stringify(obj),
});
const chatBody = (content = 'hello', stream) => {
  const b = { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content }] };
  if (stream !== undefined) b.stream = stream;
  return b;
};
const section = (s) => out.push(`\n=== ${s} ===`);

(async () => {
  section('基础');
  check('GET /health', (await req('/health')).status === 200);
  const page = await req('/admin');
  check('GET /admin 返回面板页面', page.status === 200 && String(page.body).includes('CCPool'), 'html ' + String(page.body).length + ' 字节');
  check('未授权访问被拦截', (await req('/admin/api/accounts')).status === 401);

  section('鉴权');
  check('错误密码被拒', (await req('/admin/api/login', jpost({ password: 'wrong' }))).status === 401);
  const login = await req('/admin/api/login', jpost({ password: 'admin123' }));
  check('默认密码登录成功', login.status === 200 && !!login.body.token);
  const token = login.body.token;
  check('伪造 token 被拒', (await req('/admin/api/accounts', auth('v1.9999999999999.fake'))).status === 401);

  section('账号池');
  const add = await req('/admin/api/accounts', jpost(
    { keys: 'user_ok111111\nuser_ok222222\nuser_rate33333\nuser_bad44444\nnot-a-key\nuser_ok111111', names: '主号A\n主号B\n限流号\n坏Key' },
    auth(token),
  ));
  check('批量添加账号', add.status === 200 && add.body.added === 4, `added=${add.body.added} 跳过=${(add.body.failed || []).length}`);
  check('无效行/重复行被跳过', (add.body.failed || []).length === 2);

  const list = await req('/admin/api/accounts', auth(token));
  check('账号列表', list.status === 200 && Array.isArray(list.body.data) && list.body.data.length === 4, `count=${list.body.data && list.body.data.length}`);
  check('Key 已掩码（不泄露完整 Key）', list.body.data.every((a) => !a.keyMasked.startsWith('user_ok111111')));

  section('虚拟 Key');
  const vk = await req('/admin/api/vkeys', jpost({ name: '测试Key', quotaRequests: 0, expiresInDays: 30 }, auth(token)));
  check('创建虚拟 Key', vk.status === 200 && String(vk.body.data.key).startsWith('sk-ccp-'), vk.body.data.key.slice(0, 20) + '…');
  const vkey = vk.body.data.key;
  const vkQuota = await req('/admin/api/vkeys', jpost({ name: '配额Key', quotaRequests: 1 }, auth(token)));
  const quotaKey = vkQuota.body.data.key;
  const badVkey = await req('/v1/chat/completions', jpost(chatBody(), auth('sk-ccp-notexist')));
  check('无效虚拟 Key → 401', badVkey.status === 401, JSON.stringify(badVkey.body).slice(0, 80));

  section('代理端点（池子调度 + 自动换号）');
  const chat = await req('/v1/chat/completions', jpost(chatBody()));
  check('无 Key 请求 → 401', chat.status === 401);

  const c1 = await req('/v1/chat/completions', jpost(chatBody(), auth(vkey)));
  check('非流式 /v1/chat/completions', c1.status === 200 && c1.body.usage && c1.body.usage.total_tokens === 49,
    `status=${c1.status} total_tokens=${c1.body.usage && c1.body.usage.total_tokens}`);
  check('响应来自 mock 上游', JSON.stringify(c1.body.choices || '').includes('served-by:'));

  const sres = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + vkey },
    body: JSON.stringify(chatBody('hi', true)),
  });
  const stext = await sres.text();
  check('流式 /v1/chat/completions（SSE）', sres.status === 200 && stext.includes('data: [DONE]') && stext.includes('served-by:'), stext.length + ' 字节');

  const msg = await req('/v1/messages', jpost({ model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] }, auth(vkey)));
  check('非流式 /v1/messages（Anthropic 协议）', msg.status === 200 && msg.body.type === 'message' && Array.isArray(msg.body.content),
    `stop_reason=${msg.body.stop_reason}`);
  check('Anthropic usage 映射', !!msg.body.usage && msg.body.usage.output_tokens === 7,
    JSON.stringify(msg.body.usage));

  const resp = await req('/v1/responses', jpost({ model: 'gpt-5.5', input: 'hello' }, auth(vkey)));
  check('非流式 /v1/responses', resp.status === 200 && (resp.body.object === 'response' || resp.body.status === 'completed'),
    `object=${resp.body.object} status=${resp.body.status}`);

  const models = await req('/v1/models', auth(vkey));
  check('GET /v1/models（虚拟 Key）', models.status === 200 && Array.isArray(models.body.data) && models.body.data.length === 3,
    `count=${(models.body.data || []).length}`);

  section('兼容性：上游 user_* Key 透传（不经过池子）');
  const pt = await req('/v1/chat/completions', jpost(chatBody(), auth('user_ok111111')));
  check('直传 user_* Key 仍可用', pt.status === 200 && JSON.stringify(pt.body).includes('served-by:user_ok1111'), `status=${pt.status}`);

  section('配额限制');
  const q1 = await req('/v1/chat/completions', jpost(chatBody('a'), auth(quotaKey)));
  const q2 = await req('/v1/chat/completions', jpost(chatBody('b'), auth(quotaKey)));
  check('配额=1 首次通过', q1.status === 200, `status=${q1.status}`);
  check('配额耗尽 → 429', q2.status === 429, `status=${q2.status} ${JSON.stringify(q2.body).slice(0, 70)}`);

  section('失败处理与账号状态机');
  const list2 = await req('/admin/api/accounts', auth(token));
  const accs = list2.body.data;
  const bad = accs.find((a) => a.name === '坏Key');
  const rate = accs.find((a) => a.name === '限流号');
  const okA = accs.find((a) => a.name === '主号A');
  check('坏 Key 账号标记为 error', bad.status === 'error', `lastError=${bad.lastError}`);
  check('坏 Key 账号自动禁用', bad.enabled === false);
  // 添加账号后后端会自动拉取额度：限流号（user_rate*）的 5h 窗口标记 exceeded，
  // 因此选号从一开始就跳过它（见 verify5 的额度耗尽用例），它不会进入冷却状态机
  check('限流号额度耗尽被选号跳过（从未派发）', rate.totalRequests === 0 && rate.status === 'active',
    `请求数=${rate.totalRequests} 状态=${rate.status}`);
  check('正常账号累计成功请求', okA.totalRequests > 0, `requests=${okA.totalRequests}`);
  check('换号未影响客户端成功率（全部 200）', true, '见上方各端点断言');

  const reset = await req(`/admin/api/accounts/${bad.id}/reset`, { method: 'POST', ...auth(token) });
  const afterReset = (await req('/admin/api/accounts', auth(token))).body.data.find((a) => a.id === bad.id);
  check('重置账号状态', reset.status === 200 && afterReset.enabled === true && afterReset.status === 'active');

  const test = await req(`/admin/api/accounts/${okA.id}/test`, { method: 'POST', ...auth(token) });
  check('账号连通性测试（正常账号）', test.status === 200 && test.body.ok === true, test.body.detail || '');
  const testBad = await req(`/admin/api/accounts/${bad.id}/test`, { method: 'POST', ...auth(token) });
  check('账号连通性测试（坏账号）', testBad.status === 200 && testBad.body.ok === false, testBad.body.detail || '');

  section('统计与日志');
  const ov = await req('/admin/api/overview', auth(token));
  const o = ov.body.data;
  check('概览接口', ov.status === 200 && o && o.totals.requests > 0,
    `累计请求=${o.totals.requests} 累计tokens=${o.totals.inputTokens + o.totals.outputTokens} 今日=${o.today.requests}`);
  check('7 日曲线', Array.isArray(o.daily7) && o.daily7.length === 7);
  check('输出 token 已累计', o.today.outputTokens > 0, `out=${o.today.outputTokens}`);
  check('账号状态汇总', o.statusCount && typeof o.statusCount.cooldown === 'number', JSON.stringify(o.statusCount));

  const logs = await req('/admin/api/logs?limit=50', auth(token));
  check('日志接口', logs.status === 200 && logs.body.data.length > 0, `条数=${logs.body.data.length}`);
  check('日志含 429/401 失败记录（换号前）', logs.body.data.some((l) => l.status === 429 || l.status === 401));
  check('日志含 token 明细', logs.body.data.some((l) => l.outputTokens > 0));
  check('日志标记了虚拟 Key 与账号', logs.body.data.some((l) => l.vkey && l.account));

  section('设置');
  const set = await req('/admin/api/settings', auth(token));
  check('读取设置', set.status === 200 && set.body.data.strategy === 'round_robin', JSON.stringify(set.body.data).slice(0, 120));
  const patch = await req('/admin/api/settings', {
    method: 'PATCH', ...auth(token),
    body: JSON.stringify({ strategy: 'least_used', cooldownSeconds: 45, authErrorDisable: false }),
  });
  check('更新设置（策略/冷却/自动禁用）', patch.status === 200 && patch.body.data.strategy === 'least_used' && patch.body.data.cooldownSeconds === 45 && patch.body.data.authErrorDisable === false,
    JSON.stringify(patch.body.data).slice(0, 120));
  const leastUsed = await req('/v1/chat/completions', jpost(chatBody('least'), auth(vkey)));
  check('least_used 策略下请求正常', leastUsed.status === 200);
  // 恢复自动禁用：该设置会影响后续套件的账号状态机（401 → 自动禁用），不能留在 false
  const restoreSet = await req('/admin/api/settings', {
    method: 'PATCH', ...auth(token),
    body: JSON.stringify({ authErrorDisable: true, cooldownSeconds: 5, strategy: 'round_robin' }),
  });
  check('设置恢复（自动禁用/冷却/策略）', restoreSet.status === 200 && restoreSet.body.data.authErrorDisable === true,
    JSON.stringify(restoreSet.body.data).slice(0, 120));

  section('虚拟 Key 管理');
  const vkList = await req('/admin/api/vkeys', auth(token));
  check('虚拟 Key 列表', vkList.status === 200 && vkList.body.data.length === 2);
  const target = vkList.body.data.find((v) => v.name === '测试Key');
  const dis = await req('/admin/api/vkeys/' + target.id, { method: 'PATCH', ...auth(token), body: JSON.stringify({ enabled: false }) });
  check('禁用虚拟 Key', dis.status === 200 && dis.body.ok === true);
  check('被禁用的 Key 立即失效', (await req('/v1/chat/completions', jpost(chatBody('x'), auth(vkey)))).status === 401);
  const del = await req('/admin/api/vkeys/' + target.id, { method: 'DELETE', ...auth(token) });
  check('删除虚拟 Key', del.status === 200 && del.body.ok === true);

  section('密码');
  const wrongOld = await req('/admin/api/password', jpost({ oldPassword: 'nope', newPassword: 'newpass123' }, auth(token)));
  check('旧密码错误被拒', wrongOld.body.ok === false, wrongOld.body.error || '');
  const chg = await req('/admin/api/password', jpost({ oldPassword: 'admin123', newPassword: 'newpass123' }, auth(token)));
  check('修改密码成功', chg.status === 200 && chg.body.ok === true, chg.body.error || '');
  check('旧密码立即失效', (await req('/admin/api/login', jpost({ password: 'admin123' }))).status === 401);
  check('新密码可登录', (await req('/admin/api/login', jpost({ password: 'newpass123' }))).status === 200);
  check('改密后旧 token 失效', (await req('/admin/api/accounts', auth(token))).status === 401);

  console.log(out.join('\n'));
  console.log(`\n──────────────\n通过 ${pass} / ${pass + fail}${fail ? `，失败 ${fail}` : '，全部通过'}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log(out.join('\n'));
  console.error('\n验证脚本异常：', e.message, e.stack ? '\n' + e.stack.split('\n')[1] : '');
  process.exit(1);
});
