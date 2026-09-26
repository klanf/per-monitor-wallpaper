'use strict';

/**
 * 渲染层静态接线检查（不需要 Electron，跑 `npm run verify:wiring`）。
 *
 * Electron 起不来的会话里（最小 app 都秒退那次）真机点不了，所以把「看得见的错误」
 * 尽量变成跑得了的断言：
 *   · app.js 里 $('xxx') 取的 id 在 HTML 里都还在 —— 搬 DOM 最容易搬丢，
 *     而搬丢之后的症状是「点了没反应」，靠读代码很难发现（这次就抓到 settings-body）
 *   · HTML 里没有重复 id（重排 / 复制粘贴的常见后遗症）
 *   · 设置面板的四个分类标签与内容页一一对应、字段块没有漏在页外
 *   · 分类 id 与 store 的 SETTINGS_TABS 对得上
 *   · CSS 里的标签条 / 隐藏 / 滚动规则都在
 *
 * 新增渲染层元素时顺手跑一遍，比事后调「为什么点了没反应」便宜得多。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'src/renderer/style.css'), 'utf8');
const { SETTINGS_TABS } = require(path.join(ROOT, 'src/store'));

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

// ---- 抠出 #settings 这一段 ----
const asideAt = HTML.indexOf('<aside id="settings"');
const footAt = HTML.indexOf('<div class="settings-foot">');
check('找到设置面板的起止位置', asideAt > 0 && footAt > asideAt);
const block = HTML.slice(asideAt, footAt);

// ---- 标签与内容页一一对应 ----
const tabs = [...block.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
const panes = [...block.matchAll(/data-pane="([a-z]+)"/g)].map((m) => m[1]);
check('四个标签都在', tabs.length === 4, tabs.join(','));
check('四个内容页都在', panes.length === 4, panes.join(','));
check('标签与内容页一一对应', tabs.join(',') === panes.join(','), `${tabs.join(',')} | ${panes.join(',')}`);
check('分类 id 就是 store 里那一份', panes.join(',') === SETTINGS_TABS.join(','), panes.join(','));
check('默认页（不带 hidden）只有一个',
  (block.match(/<div class="settings-pane"[^>]*>/g) || []).filter((t) => !t.includes('hidden')).length === 1);
check('默认页是第一页 play', /<div class="settings-pane" data-pane="play">/.test(block));

// ---- 字段块：全部落在某个页里 ----
// 按缩进数判断：页内的字段块应该是 6 个空格缩进，孤儿的还是 2 个
const orphanFields = [...block.matchAll(/^ {2}<div class="field[ "]/gm)];
check('没有字段块漏在分类页外面', orphanFields.length === 0, `漏了 ${orphanFields.length} 个`);

const fieldCount = (block.match(/^ {6}<div class="field[ "]/gm) || []).length;
check('23 个字段块都归进了某一页', fieldCount === 23, String(fieldCount));

// 每个页至少有一个字段块
const perPane = {};
for (const pane of panes) {
  const at = block.indexOf(`data-pane="${pane}"`);
  const next = block.indexOf('data-pane="', at + 10);
  const slice = block.slice(at, next > 0 ? next : block.length);
  perPane[pane] = (slice.match(/^ {6}<div class="field[ "]/gm) || []).length;
}
check('没有空分类页', Object.values(perPane).every((n) => n > 0), JSON.stringify(perPane));

// ---- 归属是否符合分工（抓几个代表项验一下） ----
const paneOf = (needle) => {
  const idx = block.indexOf(needle);
  if (idx < 0) return null;
  const before = block.slice(0, idx);
  const last = before.lastIndexOf('data-pane="');
  return last < 0 ? null : before.slice(last + 11, before.indexOf('"', last + 11));
};
check('轮播模式在「轮播」页', paneOf('id="cfg-mode"') === 'play', String(paneOf('id="cfg-mode"')));
check('显示器卡片在「轮播」页', paneOf('id="monitor-cards"') === 'play', String(paneOf('id="monitor-cards"')));
check('过渡动画在「轮播」页（47 轮集中）', paneOf('id="cfg-animation"') === 'play', String(paneOf('id="cfg-animation"')));
check('粒子特效在「轮播」页（47 轮集中）', paneOf('id="cfg-particles"') === 'play', String(paneOf('id="cfg-particles"')));
check('胶片条在「外观」页', paneOf('id="cfg-filmstrip"') === 'look', String(paneOf('id="cfg-filmstrip"')));
check('热键在「操作」页', paneOf('id="hotkey-list"') === 'action', String(paneOf('id="hotkey-list"')));
check('快捷文件夹在「操作」页', paneOf('id="quick-section"') === 'action', String(paneOf('id="quick-section"')));
check('开机自启在「系统」页', paneOf('id="cfg-launch-at-login"') === 'system', String(paneOf('id="cfg-launch-at-login"')));
check('缩略图缓存在「系统」页', paneOf('id="thumb-stats"') === 'system', String(paneOf('id="thumb-stats"')));

// ---- 全局项不能被 per-monitor / unified 的显示规则挡住 ----
// mode-hint / album-bind-hint 是两种模式都要看的，不能带模式限定 class
for (const id of ['cfg-auto-scan', 'cfg-mode']) {
  const line = block.split('\n').find((l) => l.includes(`id="${id}"`));
  const fieldLine = block.split('\n').slice(0, block.split('\n').indexOf(line)).reverse()
    .find((l) => /<div class="field/.test(l));
  check(`${id} 没被模式限定隐藏`, fieldLine && !/per-monitor-only|unified-only/.test(fieldLine));
}

// ---- app.js 里 $('id') 取的 id 必须都还在（重排最容易搬丢） ----
const ids = new Set([...APP.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]));
const missing = [...ids].filter((id) => !HTML.includes(`id="${id}"`));
check(`app.js 引用的 ${ids.size} 个 id 全部存在于 HTML`, missing.length === 0, missing.join(','));

// ---- HTML 里没有重复 id ----
const allIds = [...HTML.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
const dup = allIds.filter((id, i) => allIds.indexOf(id) !== i);
check('HTML 里没有重复 id', dup.length === 0, dup.join(','));

// ---- 渲染层的接线 ----
check('绑定了标签栏点击', /settings-tabs'\)\.addEventListener\('click'/.test(APP));
check('切页时记住选择', /selectSettingsTab\(btn\.dataset\.tab, \{ save: true/.test(APP));
check('启动时恢复上次那一页', /selectSettingsTab\(c\.settingsTab \|\| 'play'\)/.test(APP));
check('「快捷文件夹」跳转会先翻到所在那一页',
  /selectSettingsTab\('action'[\s\S]{0,120}quick-section'\)\.scrollIntoView/.test(APP));
check('切页函数有定义', /function selectSettingsTab\(/.test(APP));
check('记住分类的函数有定义', /async function persistSettingsTab\(/.test(APP));
check('els 里加了 settingsBody', /settingsBody: \$\('settings-body'\)/.test(APP));

// ---- CSS ----
check('标签条样式在', /\.settings-tabs \{/.test(CSS));
check('当前页高亮样式在', /\.settings-tab\.active \{/.test(CSS));
check('隐藏非当前页的规则在', /\.settings-pane\[hidden\] \{ display: none; \}/.test(CSS));
check('内容区自己滚（标签条不跟着滚）', /\.settings-body \{[\s\S]*?overflow-y: auto;/.test(CSS));
check('内容区给了 min-height:0（不然滚动条出不来）', /\.settings-body \{[\s\S]*?min-height: 0/.test(CSS));
check('设置面板本身不再整块滚动', /\.settings \{[\s\S]*?overflow: hidden;/.test(CSS));

// ---- 主进程：切页不该重建频道 ----
const MAIN = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
check('主进程认得纯界面配置键', /const UI_ONLY_KEYS = \['settingsTab', 'expandedMonitors'\]/.test(MAIN));
check('纯界面改动跳过重建', /if \(uiOnly\) return store\.get\(\);/.test(MAIN));
// 全屏/锁屏/电池暂停轮询必须真的被启动（49 轮修：定义了却漏挂调用，所有 pauseOn* 形同虚设）
check('全屏暂停轮询已接线（启动 + 开关切换两处调用）',
  (MAIN.match(/startFullscreenWatch\(\);/g) || []).length >= 2,
  `调用 ${(MAIN.match(/startFullscreenWatch\(\);/g) || []).length} 处`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
