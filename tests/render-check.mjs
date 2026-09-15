/**
 * 前端渲染验证：用最小 DOM stub 在 Node 里真实执行 public/admin.html 的内联脚本，
 * 注入与 mock 上游一致的额度数据，捕获 Usage Limits 卡片的实际渲染输出。
 * 这是「无法截图时」对面板视觉文案的最强验证。
 */
import { readFileSync } from 'fs';
import vm from 'vm';

const FILE = process.argv[2] || 'public/admin.html';
let pass = 0; let fail = 0;
const out = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; out.push(`  PASS  ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; out.push(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

const html = readFileSync(FILE, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// ── 最小 DOM stub ──
const els = new Map();
function makeEl(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {},
    remove() {},
    addEventListener() {},
    getAttribute() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    onclick: null,
    onkeydown: null,
  };
}
const documentStub = {
  getElementById(id) {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  },
  createElement() { return makeEl('tmp'); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  body: makeEl('body'),
  addEventListener() {},
  execCommand() { return true; },
};

// usageWrap 需要特殊处理：拦截 innerHTML 以捕获动态生成的按钮，并支持模拟点击
let detailBtns = [];
const wrapEl = makeEl('usageWrap');
Object.defineProperty(wrapEl, 'innerHTML', {
  get() { return wrapEl._html || ''; },
  set(v) {
    wrapEl._html = v;
    // 缓存按钮对象：renderUsage 会把 onclick 绑到这批对象上，后续查询必须返回同一批
    detailBtns = Array.from(String(v).matchAll(/data-udetail="([^"]+)"/g))
      .map((m) => ({ getAttribute: () => m[1], onclick: null }));
  },
});
wrapEl.querySelectorAll = (sel) => {
  if (sel === '[data-udetail]') return detailBtns;
  return []; // 刷新 / 删除按钮不自动点击
};
els.set('usageWrap', wrapEl);

// vkeyWrap 需要能捕获渲染出的下拉（用于验证「粘性账号」这一列真的可操作）
const vkeyWrapEl = makeEl('vkeyWrap');
els.set('vkeyWrap', vkeyWrapEl);
// nav 需要能模拟点击切页
const navEl = makeEl('nav');
navEl.children = [];
els.set('nav', navEl);

// ── 与 mock 上游一致的额度数据（5h 27% / 周 66% / 月度 40%）──
const now = Date.now();
const usage = {
  fetchedAt: now - 120000,
  error: null,
  identity: { id: 'u_1', name: 'Mock ok1', userName: 'user_ok1' },
  plan: { planId: 'individual-pro', name: 'Pro', status: 'active', monthlyCredits: 30, currentPeriodEnd: now + 20 * 86400e3, cancelAtPeriodEnd: false },
  credits: { monthlyCredits: 18, purchasedCredits: 5, freeCredits: 2, belowThreshold: false },
  limited: false,
  exceededWindow: '',
  summary: {
    // 真实上游形态：successRate 是百分数（不是 0-1 比例）
    totalCount: 3537, totalCost: 5.9, averageCost: 0.0017, successRate: 100,
    completedCount: 3537, failedCount: 0, totalTokensIn: 512000000, totalTokensOut: 3805000,
    totalCredits: 5.9, periodBasis: 'billing-period',
  },
  windows: {
    fiveHour: { used: 2.7, cap: 10, exceeded: false, resetAt: now + 55 * 60 * 1000 },
    weekly: { used: 6.6, cap: 10, exceeded: false, resetAt: now + (5 * 24 + 1) * 3600 * 1000 },
    monthly: { used: 12, cap: 30, exceeded: false, resetAt: now + 20 * 86400e3, derived: true },
  },
};

const apiResponses = {
  overview: {
    ok: true,
    data: {
      totals: { requests: 320, inputTokens: 120000, outputTokens: 5000 },
      today: { requests: 12, ok: 11, inputTokens: 100, outputTokens: 50 },
      accounts: 5,
      enabledAccounts: 3,
      statusCount: { active: 3, cooldown: 0, error: 1, disabled: 1 },
      vkeys: 2,
      vkeysEnabled: 2,
      daily7: [0, 1, 2, 3, 4, 5, 6].map((i) => ({
        date: '2026-09-' + String(10 + i).padStart(2, '0'), requests: (i + 1) * 7, ok: (i + 1) * 7,
        inputTokens: 1000 * (i + 1), outputTokens: 100 * (i + 1), cachedTokens: 50 * (i + 1),
      })),
      byKey7: [
        { id: 'vk_1', name: '主Key', requests: 200, ok: 199, inputTokens: 90000, outputTokens: 4000 },
        { id: 'vk_2', name: '备用Key', requests: 60, ok: 60, inputTokens: 30000, outputTokens: 1000 },
      ],
      byModel7: [
        { model: 'deepseek/deepseek-v4-flash', requests: 180, ok: 180, inputTokens: 80000, outputTokens: 3500 },
        { model: 'claude-sonnet-4-6', requests: 80, ok: 79, inputTokens: 40000, outputTokens: 1500 },
      ],
      recent: [],
      recentLogs: [],
    },
  },
  usage: {
    ok: true,
    data: [
      { id: 'acc_1', name: '主号A', enabled: true, status: 'active', usage },
      { id: 'acc_2', name: '未刷新号', enabled: true, status: 'active', usage: null },
      {
        id: 'acc_3',
        name: '坏号',
        enabled: true,
        status: 'error',
        usage: { fetchedAt: 0, lastAttemptAt: now - 5000, error: 'Key 被拒（HTTP 401）', authFailed: true, windows: {}, credits: {}, plan: null },
      },
      // 真实账号形态（Go 套餐实测数据）：周窗口即将用满、月度按套餐推算；5h 重置点含分钟
      {
        id: 'acc_4',
        name: 'Go 套餐号',
        enabled: true,
        status: 'active',
        usage: {
          fetchedAt: now - 30000,
          error: null,
          identity: { userName: 'user_27v…' },
          plan: { planId: 'individual-go', name: 'Go', status: 'active', monthlyCredits: 10, currentPeriodEnd: now + 16 * 86400e3 },
          credits: { monthlyCredits: 4.194554498, purchasedCredits: 0, freeCredits: 0 },
          windows: {
            fiveHour: { used: 0.30587919, cap: 3, exceeded: false, resetAt: now + 3 * 3600e3 + 56 * 60e3 },
            weekly: { used: 5.805445502, cap: 6, exceeded: false, resetAt: now + 4 * 86400e3 },
            monthly: { used: 5.805445502, cap: 10, exceeded: false, resetAt: now + 16 * 86400e3, derived: true },
          },
        },
      },
    ],
  },
  vkeys: {
    ok: true,
    data: [
      { id: 'vk_1', name: '主Key', key: 'sk-ccp-AbCdEfGhIjKlMnOpQrStUvWx', enabled: true, lastAccountId: 'acc_1', stickyOff: false, usedRequests: 12, quotaRequests: 0, limitDaily: 100, usedToday: 12, totalInputTokens: 900, totalOutputTokens: 100, createdAt: now - 3600000, expiresAt: 0 },
      { id: 'vk_2', name: '备用Key', key: 'sk-ccp-ZyXwVuTsRqPoNmLkJiHgFeDc', enabled: true, lastAccountId: '', stickyOff: true, usedRequests: 0, quotaRequests: 0, limitDaily: 0, usedToday: 0, totalInputTokens: 0, totalOutputTokens: 0, createdAt: now - 1800000, expiresAt: 0 },
    ],
  },
  accounts: {
    ok: true,
    data: [
      { id: 'acc_1', name: '主号A', enabled: true, status: 'active' },
      { id: 'acc_2', name: '未刷新号', enabled: true, status: 'active' },
    ],
  },
  logs: {
    ok: true,
    data: [
      { t: now - 5000, vkey: '主Key', account: '主号A', endpoint: '/v1/chat/completions', model: 'deepseek/deepseek-v4-flash', status: 200, inputTokens: 120, outputTokens: 45, cachedTokens: 0, elapsedMs: 26360, ttftMs: 9810, error: '' },
      { t: now - 60000, vkey: '主Key', account: '主号B', endpoint: '/v1/messages', model: 'claude-sonnet-4-6', status: 200, inputTokens: 88, outputTokens: 12, cachedTokens: 0, elapsedMs: 640, ttftMs: 310, error: '' },
    ],
  },
};
async function fetchStub(url) {
  const path = String(url).replace('/admin/api/', '');
  const body = apiResponses[path] || { ok: true, data: [] };
  return { ok: true, status: 200, json: async () => body };
}

const sandbox = {
  document: documentStub,
  window: { addEventListener() {}, location: { hash: '', href: 'http://127.0.0.1:3050/admin' } },
  location: { origin: 'http://127.0.0.1:3050', hash: '', href: 'http://127.0.0.1:3050/admin', protocol: 'http:', host: '127.0.0.1:3050' },
  localStorage: {
    getItem: (k) => (k === 'ccpool_token' ? 'test-token' : null),
    setItem() {}, removeItem() {},
  },
  navigator: { clipboard: null },
  fetch: fetchStub,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  console, Date, Math, JSON, Number, String, Array, Object, Promise, isFinite, parseInt, parseFloat, RegExp, Error,
};
sandbox.globalThis = sandbox;

try {
  vm.createContext(sandbox);
  new vm.Script(script, { filename: 'admin-inline.js' }).runInContext(sandbox);
} catch (e) {
  console.error('执行前端脚本失败：', e.message);
  process.exit(1);
}

// 等异步渲染链完成
await new Promise((r) => setTimeout(r, 250));

const wrap = els.get('usageWrap');
const rendered = wrap ? wrap.innerHTML : '';
const meta = els.get('usageMeta') ? els.get('usageMeta').textContent : '';

console.log('=== 前端渲染验证（无浏览器） ===');
check('渲染未抛异常并产出 HTML', rendered.length > 200, `${rendered.length} 字节`);
check('仪表盘加载了账号卡片', (rendered.match(/class="usage-card"/g) || []).length === 4,
  `卡片数=${(rendered.match(/class="usage-card"/g) || []).length}`);
check('卡片标题栏显示账号名', rendered.includes('主号A'));
check('套餐徽章', rendered.includes('>Pro<'));

check('5-Hour Limit 行', rendered.includes('5-Hour Limit'));
check('5 小时以「剩余」为主视角', rendered.includes('剩余 73.0%'), /剩余 [\d.]+%/.exec(rendered)?.[0]);
check('5 小时重置文案（分钟级）', rendered.includes('55 分钟后重置'), /(\d+) 分钟后重置/.exec(rendered)?.[0]);
check('5 小时数值明细', rendered.includes('已用 2.7 / 10'));
check('5 小时剩余值（cap − used）', rendered.includes('剩余 7.3'), /剩余 7\.3/.exec(rendered)?.[0]);

check('Weekly Limit 行', rendered.includes('Weekly Limit'));
check('周以「剩余」为主视角', rendered.includes('剩余 34.0%'));
check('周重置文案（天+小时，对齐示例 5d 1h）', rendered.includes('5 天 1 小时后重置'), /5 天 \d+ 小时后重置/.exec(rendered)?.[0]);
check('周数值明细', rendered.includes('已用 6.6 / 10'));

check('Monthly Limit 行', rendered.includes('Monthly Limit'));
check('月度以「剩余」为主视角', rendered.includes('剩余 60.0%'));
check('月度标注「上限按套餐推算」', rendered.includes('上限按套餐推算'));
check('月度重置文案（具体日期）', /\d+ 月 \d+ 日重置/.test(rendered), /\d+ 月 \d+ 日重置/.exec(rendered)?.[0]);
check('月度剩余值（cap − used）', rendered.includes('剩余 18'), /剩余 18/.exec(rendered)?.[0]);

check('进度条长度 = 剩余百分比', rendered.includes('width:73.0%') && rendered.includes('width:34.0%') && rendered.includes('width:60.0%'));
check('颜色分级按已用，条长按剩余：已用 27% → 绿', rendered.includes('width:73.0%;background:#3fb950'));
check('颜色分级按已用，条长按剩余：已用 66% → 黄', rendered.includes('width:34.0%;background:#d29922'));
check('余额行（月度剩余 / 充值 / 免费）',
  rendered.includes('月度剩余 <b>18</b>') && rendered.includes('充值余额 <b>5</b>') && rendered.includes('免费额度 <b>2</b>'));
check('更新时间文案', rendered.includes('上次刷新 2 分钟前'), /上次刷新[^<]*/.exec(rendered)?.[0]);

check('未刷新账号显示引导文案', rendered.includes('尚未获取额度'));
check('失败账号显示错误原因（保留 HTTP 细节）',
  rendered.includes('Key 被上游拒绝') && rendered.includes('HTTP 401'),
  /Key 被上游拒绝[^<]*/.exec(rendered)?.[0]);
check('顶部统计文案', meta.includes('4 个账号') && meta.includes('1 个未刷新'), meta);

out.push('\n=== 真实账号数据（Go 套餐，周窗口接近用满）===');
check('Go 套餐徽章', rendered.includes('>Go<'));
check('周：已用 5.8 / 6', rendered.includes('已用 5.8 / 6'));
check('周：剩余 0.2', rendered.includes('剩余 0.2'));
check('周：接近用满 → 剩余 3.2%（红档）',
  rendered.includes('剩余 3.2%') && rendered.includes('width:3.2%;background:#f85149'),
  /剩余 3\.2%/.exec(rendered)?.[0]);
check('月：已用 5.8 / 10（= 上限 − 月度剩余）', rendered.includes('已用 5.8 / 10'));
check('月：剩余 4.2（= 上游 credits.monthlyCredits）', rendered.includes('剩余 4.2'));
check('月：剩余 41.9%（黄档）',
  rendered.includes('剩余 41.9%') && rendered.includes('width:41.9%;background:#d29922'),
  /剩余 41\.9%/.exec(rendered)?.[0]);
check('月：标注上限按套餐推算', rendered.includes('上限按套餐推算'));
check('5 小时：已用 0.3 / 3 · 剩余 2.7（绿档）',
  rendered.includes('已用 0.3 / 3') && rendered.includes('剩余 2.7') && rendered.includes('剩余 89.8%'));

const rankHtml = els.get('rankWrap') ? els.get('rankWrap').innerHTML : '';
out.push('\n=== 用量分布（按 Key / 按模型）===');
check('渲染排行行', rankHtml.includes('rank-row'), rankHtml.slice(0, 80));
check('按 Key 排行首位是请求最多的 Key', /主Key/.test(rankHtml) && rankHtml.indexOf('主Key') < rankHtml.indexOf('备用Key'),
  (/rank-name">([^<]+)</.exec(rankHtml) || [])[1]);
check('排行带次数、成功率与 tokens', /rank-num mono">[\d,]+ 次/.test(rankHtml) && /成功 \d+% · /.test(rankHtml),
  (/rank-sub mono">([^<]+)</.exec(rankHtml) || [])[1]);
check('排行条宽度按占比（最长为 100%）', /rank-bar"><i style="width:100%"/.test(rankHtml),
  (/style="width:(\d+)%"/.exec(rankHtml) || [])[0]);

out.push('\n=== 窗口耗尽预测 ===');
check('按速率给出打满预测', rendered.includes('ul-burn'), (/预计 [^<]+打满/.exec(rendered) || [])[0]);
check('预测文案含「打满」语义', /预计 .+后打满/.test(rendered));

out.push('\n=== 粘性绑定与分钟级重置 ===');check('已粘账号显示徽章', rendered.includes('uc-pinned') && rendered.includes('已粘'));
check('已粘账号按钮为「取消粘住」', rendered.includes('>取消粘住<'));
check('未粘账号按钮为「粘住」', rendered.includes('>粘住</button>'));
check('小时级重置精确到分钟（3 小时 56 分钟）', rendered.includes('3 小时 56 分钟后重置'),
  /3 小时 \d+ 分钟后重置/.exec(rendered)?.[0]);
check('整点不显示 0 分钟（X 小时后重置）', !rendered.includes(' 0 分钟后重置'));

out.push('\n=== 详情统计区（模拟点击「详情」）===');
const detailCount = detailBtns.length;
check('有 summary 的卡片渲染「详情」按钮', detailCount === 1, `${detailCount} 个（仅第一张卡有 summary）`);
const collapsed = wrapEl._html || '';
check('默认折叠：未展开时不渲染统计区', !collapsed.includes('uc-stats'));
if (detailCount) detailBtns[0].onclick();
const expandedHtml = wrapEl._html || '';
check('展开后出现统计区', expandedHtml.includes('uc-stats'));
check('累计请求（千分位）', expandedHtml.includes('累计请求') && expandedHtml.includes('3,537'));
check('成功率按百分数直显', expandedHtml.includes('成功率') && expandedHtml.includes('>100%<'));
check('成功 / 失败', expandedHtml.includes('3,537 / 0'));
check('累计消耗', expandedHtml.includes('5.9 credits'));
check('Tokens 进 / 出（亿 / 万）', expandedHtml.includes('5.1亿') && expandedHtml.includes('380.5万'));
check('单均成本（4 位小数）', expandedHtml.includes('0.0017'));
check('统计口径', expandedHtml.includes('billing-period'));
check('按钮切换为「收起」', expandedHtml.includes('>收起<'));

out.push('\n=== 近 7 日用量明细表 ===');
const dailyHtml = els.get('dailyWrap') ? els.get('dailyWrap').innerHTML : '';
check('每日明细表已渲染', dailyHtml.includes('<table>') && dailyHtml.includes('<th>日期</th>'));
check('列齐全（请求/成功失败/输入/输出/缓存）',
  ['>请求</th>', '成功 / 失败', '输入 Tokens', '输出 Tokens', '缓存 Tokens'].every((s) => dailyHtml.includes(s)));
check('每天一行（7 行 + 合计）', (dailyHtml.match(/<tr>/g) || []).length === 8, `行数=${(dailyHtml.match(/<tr>/g) || []).length}`);
check('合计行请求数正确（7+14+…+49=196）', /<td>合计<\/td>/.test(dailyHtml) && dailyHtml.includes('>196<'));
check('合计行缓存 Tokens（50+100+…+350=1400）', dailyHtml.includes('>1,400<'));
check('柱状图 hover 带成功数与 tokens', /title="[^"]*成功 \d+）[^"]*入 [\d,]+/.test(els.get('chart').innerHTML || ''));

out.push('\n=== 接入地址 ===');
const epOpenai = els.get('epOpenai') ? els.get('epOpenai').textContent : '';
const epAnthropic = els.get('epAnthropic') ? els.get('epAnthropic').textContent : '';
check('OpenAI 兼容 Base URL 已渲染', epOpenai === 'http://127.0.0.1:3050/v1', epOpenai);
check('Anthropic Base URL 已渲染', epAnthropic === 'http://127.0.0.1:3050', epAnthropic);

out.push('\n=== 虚拟 Key 页：粘性账号可操作 ===');
// 模拟点击导航切到虚拟 Key 页，验证「粘性账号」列渲染成可选择的下拉（改绑/取消粘性的入口）
navEl.onclick({
  target: {
    closest: () => ({
      dataset: { p: 'vkey' },
      getAttribute: () => 'vkey',
      classList: { toggle() {} },
    }),
  },
});
await new Promise((r) => setTimeout(r, 250));
const vkeyHtml = vkeyWrapEl.innerHTML || '';
check('虚拟 Key 页渲染出下拉', vkeyHtml.includes('class="pin-sel"') && vkeyHtml.includes('data-pin='), vkeyHtml.length + ' 字节');
check('下拉含「不粘」选项（用于取消粘性）', vkeyHtml.includes('>不粘（每次按策略调度）</option>'));
check('下拉含各账号选项', /<option value="acc_1"/.test(vkeyHtml));
check('已绑定的 Key 默认选中该账号', /<option value="acc_1" selected/.test(vkeyHtml),
  (/<option value="acc_1"[^>]*>([^<]*)</.exec(vkeyHtml) || [])[1]);
check('未绑定的 Key 默认选中「不粘」', /<option value="off" selected/.test(vkeyHtml));
check('日限额列渲染今日 / 日限额', vkeyHtml.includes('今日 / 日限额') && vkeyHtml.includes('12 / 100'),
  (/rank-num[^>]*>([^<]*)/.exec(vkeyHtml) || [])[0] || '');
check('粘性列不出现重复按钮（用下拉而非按钮组）', !/data-upin="[^"]*"/.test(vkeyHtml));

out.push('\n=== 日志页：时间筛选 ===');
navEl.onclick({
  target: {
    closest: () => ({
      dataset: { p: 'logs' },
      getAttribute: () => 'logs',
      classList: { toggle() {} },
    }),
  },
});
await new Promise((r) => setTimeout(r, 250));
// 快捷档与日期输入是静态 HTML，由 check-ui 的锚点检查覆盖；这里验证动态渲染
check('条数统计已渲染（不再固定 100 条）', /共 [\d,]+ 条/.test(els.get('logCount').textContent || ''), els.get('logCount').textContent);
check('日志表格渲染', (els.get('logWrap').innerHTML || '').includes('<table>') || (els.get('logWrap').innerHTML || '').includes('暂无'));
check('首字列存在（带解释 title）', /<th class="num" title="[^"]*首字[^"]*"/.test(els.get('logWrap').innerHTML || ''));
const logHtml2 = els.get('logWrap').innerHTML || '';
check('首字与总耗时按秒两位显示（9.81s / 26.36s）', logHtml2.includes('>9.81s<') && logHtml2.includes('>26.36s<'));
check('亚秒值显示毫秒（310ms / 640ms）', logHtml2.includes('>310ms<') && logHtml2.includes('>640ms<'));

console.log(out.join('\n'));
console.log(`\n──────────────\n通过 ${pass} / ${pass + fail}${fail ? `，失败 ${fail}` : '，全部通过'}`);
process.exit(fail ? 1 : 0);
