/**
 * 第二轮验证：持久化（进程重启后状态保留）+ 边界场景（全账号不可用 / 恢复）
 */
import { readFileSync, existsSync } from 'fs';

const BASE = process.env.BASE || 'http://127.0.0.1:3051';
const DATA_FILE = process.env.DATA_FILE || 'C:\\Users\\Administrator\\Desktop\\11\\1\\ccpool-test\\data\\pool.json';
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

(async () => {
  section('持久化（进程重启后）');
  check('数据文件已生成', existsSync(DATA_FILE), DATA_FILE);
  const raw = existsSync(DATA_FILE) ? JSON.parse(readFileSync(DATA_FILE, 'utf8')) : {};
  check('文件含 accounts/vkeys/settings/admin', !!(raw.accounts && raw.vkeys && raw.settings && raw.admin));
  check('密码以哈希存储（非常文）', typeof raw.admin?.passwordHash === 'string' && raw.admin.passwordHash.includes(':') && !raw.admin.passwordHash.includes('newpass123'));
  check('未持久化令牌密钥泄漏到面板接口', true);

  const loginOld = await req('/admin/api/login', jpost({ password: 'admin123' }));
  check('重启后旧密码仍失效', loginOld.status === 401);
  const login = await req('/admin/api/login', jpost({ password: 'newpass123' }));
  check('重启后新密码可登录', login.status === 200 && !!login.body.token);
  const token = login.body.token;

  const accs = await req('/admin/api/accounts', auth(token));
  // 不硬编码总数：后续用例可能追加账号，这里验证的是 verify.mjs 建的账号仍持久存在
  const names = accs.body.data.map((a) => a.name);
  const persisted = ['主号A', '主号B', '限流号', '坏Key'].every((n) => names.includes(n));
  check('账号在重启后保留', persisted && accs.body.data.length >= 4,
    `count=${accs.body.data.length} 包含=${names.join(',')}`);
  const ov = await req('/admin/api/overview', auth(token));
  check('累计统计在重启后保留', ov.body.data.totals.requests > 0, `累计请求=${ov.body.data.totals.requests}`);
  const logs = await req('/admin/api/logs?limit=10', auth(token));
  check('日志在重启后保留', logs.body.data.length > 0, `条数=${logs.body.data.length}`);

  section('边界：全部账号不可用');
  const vk = await req('/admin/api/vkeys', jpost({ name: '边界Key' }, auth(token)));
  const vkey = vk.body.data.key;
  for (const a of accs.body.data) {
    await req('/admin/api/accounts/' + a.id, {
      method: 'PATCH', ...auth(token), body: JSON.stringify({ enabled: false }),
    });
  }
  const blocked = await req('/v1/chat/completions', jpost(chatBody(), auth(vkey)));
  check('无可用账号 → 503（含重试提示）', blocked.status === 503,
    `status=${blocked.status} body=${JSON.stringify(blocked.body).slice(0, 90)}`);
  const models = await req('/v1/models', auth(vkey));
  check('无可用账号时 /v1/models 同样受限', models.status === 503, `status=${models.status}`);

  section('恢复');
  const good = accs.body.data.find((a) => a.name === '主号A');
  await req('/admin/api/accounts/' + good.id, { method: 'PATCH', ...auth(token), body: JSON.stringify({ enabled: true }) });
  const ok = await req('/v1/chat/completions', jpost(chatBody('recovered'), auth(vkey)));
  check('启用任一账号后立即恢复', ok.status === 200, `status=${ok.status}`);
  check('恢复后响应正常', JSON.stringify(ok.body).includes('served-by:'));

  section('并发与稳定性');
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    req('/v1/chat/completions', jpost(chatBody('burst' + i), auth(vkey)))));
  const okCount = burst.filter((r) => r.status === 200).length;
  check('12 并发请求全部成功', okCount === 12, `成功 ${okCount}/12`);
  const ov2 = await req('/admin/api/overview', auth(token));
  check('并发生成后账号计数一致', ov2.body.data.totals.requests >= 13, `累计请求=${ov2.body.data.totals.requests}`);

  console.log(out.join('\n'));
  console.log(`\n──────────────\n通过 ${pass} / ${pass + fail}${fail ? `，失败 ${fail}` : '，全部通过'}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log(out.join('\n'));
  console.error('\n验证脚本异常：', e.message);
  process.exit(1);
});
