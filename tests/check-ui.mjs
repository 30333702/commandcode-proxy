/** 用 Node（UTF-8）校验面板内联脚本语法 + DOM 锚点，排除 PowerShell 编码干扰 */
import { readFileSync } from 'fs';
import vm from 'vm';

const file = process.argv[2];
const html = readFileSync(file, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到 <script> 块'); process.exit(1); }
const js = m[1];
try {
  new vm.Script(js, { filename: 'admin-inline.js' });
  console.log(`内联 JS 语法 OK（${js.length} 字节）`);
} catch (e) {
  console.error('内联 JS 语法错误：', e.message);
  process.exit(1);
}

const anchors = ['id="login"', 'id="app"', 'id="p-dash"', 'id="p-acct"', 'id="p-vkey"', 'id="p-logs"', 'id="p-set"',
  'id="mAddAcct"', 'id="mAddVkey"', 'id="mShowKey"', 'id="chart"', 'id="cards"', 'id="acctWrap"', 'id="vkeyWrap"',
  'id="logWrap"', 'id="toasts"', 'id="nav"', 'id="s_strategy"', 'id="saveSettings"', 'id="savePw"',
  'id="usageWrap"', 'id="usageMeta"', 'id="refreshUsage"', 'id="s_maxconc"', 'id="s_mininterval"', 'id="s_usage"',
  'id="epOpenai"', 'id="epAnthropic"', 'id="s_apibase"',
  'id="rankWrap"', 'id="rankMode"', 'data-rank="model"',
  'id="enableAll"', 'id="disableAll"', 'id="pruneAcct"', 'id="vkDaily"',
  'id="logQuick"', 'id="logFrom"', 'id="logTo"', 'id="logApply"', 'id="logCount"', 'id="dailyWrap"'];
const missing = anchors.filter((a) => !html.includes(a));
console.log(missing.length ? `缺失锚点：${missing.join(', ')}` : `DOM 锚点齐全（${anchors.length} 个）`);

// 标签配对：改 HTML 结构时最容易漏掉闭合标签
const tagCount = (re) => (html.match(re) || []).length;
const pairs = [
  ['section', tagCount(/<section\b/g), tagCount(/<\/section>/g)],
  ['main', tagCount(/<main\b/g), tagCount(/<\/main>/g)],
  ['div(panel)', tagCount(/class="panel"/g), null],
  ['script', tagCount(/<script>/g), tagCount(/<\/script>/g)],
];
const unbalanced = pairs.filter(([_, a, b]) => b != null && a !== b).map(([n, a, b]) => `${n}: ${a} vs ${b}`);
console.log(unbalanced.length ? `标签不配对：${unbalanced.join('; ')}` : `标签配对正确（section/main/script）`);

// 关键前端功能点检查
const feats = [
  ['登录', "fetch('/admin/api/login'"],
  ['Token 持久化', 'localStorage'],
  ['账号批量添加', "'accounts', { method: 'POST'"],
  ['账号测试', "'/test', { method: 'POST'"],
  ['虚拟 Key 创建', 'function (d) {\n      el(\'mAddVkey\').classList.remove(\'on\')'],
  ['日志时间筛选', 'function logFilterRange'],
  ['设置保存', "'settings', {"],
  ['自动刷新', 'setInterval'],
  ['复制到剪贴板', 'clipboard'],
  ['7 日图表', 'daily7'],
  ['额度卡片渲染', 'function usageCard'],
  ['额度三条款度条', "limitRow('5-Hour Limit'"],
  ['额度重置文案', 'function resetText'],
  ['额度百分比配色', 'function pctColor'],
  ['额度刷新接口', "'usage/refresh'"],
  ['额度自动加载', 'loadUsage'],
  ['用量分布排行', 'function renderRankings'],
  ['窗口耗尽预测', 'function burnForecast'],
  ['账号批量运维', "'accounts/bulk'"],
  ['失效账号清理', "'accounts/prune'"],
  ['虚拟 Key 日限额字段', 'limitDaily'],
  ['粘性手动指定', 'data-upin'],
];
const miss2 = feats.filter(([_, needle]) => !js.includes(needle)).map(([name]) => name);
console.log(miss2.length ? `前端功能缺失：${miss2.join(', ')}` : `前端功能点齐全（${feats.length} 项）`);

// JS 动态生成的 DOM 类名必须在 CSS 中有定义，否则卡片会掉样式
const dynamicClasses = ['usage-card', 'uc-head', 'uc-name', 'uc-plan', 'uc-spacer', 'uc-btn',
  'ul-row', 'ul-top', 'ul-label', 'ul-pct', 'ul-bar', 'ul-sub', 'uc-foot', 'uc-err', 'uc-empty',
  'uc-bal', 'uc-stats', 'uc-stat', 'ul-warn', 'ul-burn', 'uc-pinned',
  'rank-row', 'rank-no', 'rank-name', 'rank-bar', 'rank-num', 'rank-sub', 'seg',
  'exceeded', 'usage-grid'];
const missingCss = dynamicClasses.filter((c) => !html.includes('.' + c));
console.log(missingCss.length ? `CSS 缺失：${missingCss.join(', ')}` : `额度卡片 CSS 类齐全（${dynamicClasses.length} 个）`);
console.log(`HTML 总大小：${html.length} 字节；中文/UTF-8 完整性：${html.includes('账号池') ? 'OK' : '异常'}`);
