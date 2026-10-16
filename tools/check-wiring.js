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
const STAGE_SOURCE = fs.readFileSync(path.join(ROOT, 'src/renderer/stage.js'), 'utf8');
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
const totalFields = (block.match(/<div class="field[ "]/gm) || []).length;
check('所有字段块都归进了某一页', fieldCount === totalFields, `页内 ${fieldCount}/${totalFields}（孤儿看上一条）`);

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
check('过渡动画在「外观」页', paneOf('id="cfg-animation"') === 'look', String(paneOf('id="cfg-animation"')));
check('胶片条在「外观」页', paneOf('id="cfg-filmstrip"') === 'look', String(paneOf('id="cfg-filmstrip"')));
check('热键在「操作」页', paneOf('id="hotkey-list"') === 'action', String(paneOf('id="hotkey-list"')));
check('快捷文件夹在「操作」页', paneOf('id="quick-section"') === 'action', String(paneOf('id="quick-section"')));
check('开机自启在「系统」页', paneOf('id="cfg-launch-at-login"') === 'system', String(paneOf('id="cfg-launch-at-login"')));
check('缩略图缓存在「系统」页', paneOf('id="thumb-stats"') === 'system', String(paneOf('id="thumb-stats"')));
check('软件更新在「系统」页', paneOf('id="update-section"') === 'system', String(paneOf('id="update-section"')));

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
check('更新状态事件已接到渲染层', /window\.wp\.onUpdateState\(renderUpdateState\)/.test(APP));
check('更新三阶段按钮都已接线',
  ['btn-update-check', 'btn-update-download', 'btn-update-install']
    .every((id) => new RegExp(`\\$\\('${id}'\\)\\.addEventListener`).test(APP)));

const PRELOAD = fs.readFileSync(path.join(ROOT, 'src/preload.js'), 'utf8');
for (const api of ['updateState', 'checkForUpdate', 'downloadUpdate', 'installUpdate', 'onUpdateState']) {
  check(`preload 暴露 ${api}`, new RegExp(`\\b${api}:`).test(PRELOAD));
}

// ---- CSS ----
check('标签条样式在', /\.settings-tabs \{/.test(CSS));
check('当前页高亮样式在', /\.settings-tab\.active \{/.test(CSS));
check('隐藏非当前页的规则在', /\.settings-pane\[hidden\] \{ display: none; \}/.test(CSS));
check('内容区自己滚（标签条不跟着滚）', /\.settings-body \{[\s\S]*?overflow-y: auto;/.test(CSS));
check('内容区给了 min-height:0（不然滚动条出不来）', /\.settings-body \{[\s\S]*?min-height: 0/.test(CSS));
check('设置面板本身不再整块滚动', /\.settings \{[\s\S]*?overflow: hidden;/.test(CSS));

// ---- 空态引导闭环（54 轮追记九修复的回归，r32 补回） ----
check('空态大按钮直弹目录对话框（folder:pick 自动建相簿并绑屏），不是只开相簿页',
  /\$\('empty-pick'\)\.addEventListener\('click', async[\s\S]{0,200}pickFolder\(state\.previewId\)/.test(APP));
check('相簿页加目录后会尝试自动绑定空屏', /ensureAlbumBound\(albumId\)\) closeAlbumsPage\(\)/.test(APP));
check('ensureAlbumBound 只绑还没绑相簿的屏（不抢已绑定的）',
  /function ensureAlbumBound[\s\S]{0,400}profile\.albumId === albumId[\s\S]{0,200}!c\.profile\.albumId/.test(APP));

// ---- 主进程：切页不该重建频道 ----
const MAIN = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
for (const channel of ['update:state', 'update:check', 'update:download', 'update:install']) {
  check(`主进程注册 ${channel}`, MAIN.includes(`ipcMain.handle('${channel}'`));
}
// 自洽式断言：UI_ONLY_KEYS 必须同时含这些键（顺序不限，后续加键不算违规）
// （47 轮的 expandedMonitors 折叠记忆未移植：r21 起设置面板是「胶囊 + 单卡渲染」，
//  「整列卡片默认折叠」的前提已不存在，移植反而会让唯一那张卡默认收起）
const mUiOnly = MAIN.match(/const UI_ONLY_KEYS = \[([^\]]*)\]/);
check('主进程认得纯界面配置键', Boolean(mUiOnly)
  && ['settingsTab', 'swipeSwitch', 'hintParticlesPerMonitor']
    .every((k) => mUiOnly[1].includes(`'${k}'`)));
check('纯界面改动跳过重建', /if \(uiOnly\) return store\.get\(\);/.test(MAIN));

// ---- 自动暂停：配置保存与应用级常驻接线 ----
const STORE_SOURCE = fs.readFileSync(path.join(ROOT, 'src/store.js'), 'utf8');
check('liveStage 默认配置只有一份',
  (STORE_SOURCE.match(/^  liveStage: \{$/gm) || []).length === 1);
check('clampLiveStage 只有一份完整实现',
  (STORE_SOURCE.match(/^function clampLiveStage\(/gm) || []).length === 1
    && ['pauseOnIdle', 'idlePauseMinutes', 'hideOnPaused'].every((key) => STORE_SOURCE.includes(key)));

const whenReadyAt = MAIN.indexOf('app.whenReady().then');
const startupRebuildAt = MAIN.indexOf("await scheduler.rebuild('startup')", whenReadyAt);
const dynamicStartupAt = MAIN.indexOf('if (store.get().liveWallpaper)', whenReadyAt);
const pauseWatchStartupAt = MAIN.indexOf('startFullscreenWatch();', whenReadyAt);
/*
 * 2026-10-16 冷开机提速：暂停监控与动态舞台链路**先于**启动重建 ——
 * rebuild 吃扫描缓存磁盘水合时几乎瞬时；缓存未命中时舞台也不再被冷盘扫描堵住。
 * 不变式保留两条：暂停监控无条件启动（不进 liveWallpaper 条件），且先于
 * 动态桌面开关出现（舞台 bind 带初始暂停态，监控必须先跑起来）。
 */
check('暂停监控在动态桌面条件判断之前无条件启动（且先于启动重建）',
  startupRebuildAt >= 0 && pauseWatchStartupAt >= 0
    && pauseWatchStartupAt < dynamicStartupAt
    && pauseWatchStartupAt < startupRebuildAt);
check('修改 liveStage 后立即重采样暂停状态',
  /if \(keys\.includes\('liveStage'\)\) \{[\s\S]{0,400}refreshFullscreenPauseState\(\);/.test(MAIN));

// ---- 双层视差性能警告（r72）：开启方向必经主进程确认，五端缺一不可 ----
check('双层视差开启前过性能警告（handler/preload/门控/偏好/设置重开 五端齐全）',
  MAIN.includes("ipcMain.handle('dual-layer:confirm', () => askDualLayerPermission())")
  && MAIN.includes("dualLayerHint === false") && MAIN.includes("dual-hint:changed")
  && PRELOAD.includes('dualLayerWithConfirm') && PRELOAD.includes('onDualHintChanged')
  && APP.includes('await window.wp.dualLayerWithConfirm()')
  && APP.includes("cfg-dual-hint")
  && STORE_SOURCE.includes('dualLayerHint: true')
  && HTML.includes('cfg-dual-hint'));

// ---- 分割模型按需下载（r73）：开启方向缺模型走遮罩弹窗，五端缺一不可 ----
check('分割模型下载链（status/download/cancel handler + preload 桥 + 渲染端门控）',
  MAIN.includes("ipcMain.handle('model:seg-status', () => segModel.status())")
  && MAIN.includes("ipcMain.handle('model:seg-download'") && MAIN.includes('segModel.cancel')
  && MAIN.includes('WP_SEG_MODELS_DIR')
  && PRELOAD.includes('segModelStatus') && PRELOAD.includes('segModelDownload')
  && PRELOAD.includes('segModelCancel') && PRELOAD.includes('onSegModelProgress')
  && APP.includes('await window.wp.segModelStatus()')
  && APP.includes('await ensureSegModel()') && APP.includes('segModelOverlay')
  && HTML.includes('seg-model-overlay'));

// ---- idle 微动画移除（r73）：五端不得再有任何残留 ----
check('idle 微动画已彻底移除（shader/开关/偏好/els 全无残留）',
  !STAGE_SOURCE.includes('idleWarp') && !STAGE_SOURCE.includes('uIdle')
    && !STAGE_SOURCE.includes('idleFx')
    && !APP.includes('qtIdle') && !APP.includes('resolvedIdle') && !APP.includes('idleFx')
    && !STORE_SOURCE.includes('idleFx') && !HTML.includes('qt-idle'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);