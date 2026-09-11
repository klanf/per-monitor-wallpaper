'use strict';

/**
 * 第六轮交互修复的端到端验证。
 *
 *   ① 胶片条缩略图右上角的删除图标（含原生确认框的完整流程）
 *   ② 图片信息面板跟着当前壁纸同步更新
 *   ③ 点面板以外的地方关掉面板（图片信息 / 设置都适用）
 *
 * 用法：应用以 --remote-debugging-port=9222 启动，然后
 *   node tools/verify-ui-fixes.js
 *
 * ① 会真的删掉夹具里的一张图（进回收站），全程只碰 tools/tmp 下的测试素材；
 * 确认框用 tools/dialogDriver.js 从系统侧驱动 —— 找不到/置不前对话框就跳过那几条断言，
 * 绝不放任按键飞进应用窗口。
 */

const path = require('node:path');
const fs = require('node:fs');

const dialogDriver = require('./dialogDriver');
const testConfig = require('./testConfig');

const CDP_LIST = 'http://127.0.0.1:9222/json';
const FIX = path.resolve(__dirname, 'fixtures');
const TMP = path.resolve(__dirname, 'tmp', 'ui');
const SRC = path.join(TMP, 'src');
const IMAGE_COUNT = 12;
/** ⑥ 专用的大目录：得让胶片条溢出，居中与否才看得出差别 */
const FILM_COUNT = 40;
/** 跳到这个序号：靠近末尾，「没居中」时当前那张会整个跑到可视区外 */
const JUMP_INDEX = 30;

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; failures.push(label); console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (t) => console.log(`\n===== ${t} =====`);

/* ------------------------------------------------------------ CDP */

async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const t = await (await fetch(CDP_LIST)).json();
      const page = t.find((x) => x.type === 'page' && String(x.url).includes('index.html'));
      if (page && page.webSocketDebuggerUrl) return page;
      last = `目标 ${t.length} 个`;
    } catch (e) { last = e.message; }
    await sleep(400);
  }
  throw new Error(`等待渲染进程超时：${last}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let seq = 0;
    ws.addEventListener('open', () => resolve({
      call(method, params) {
        return new Promise((res) => {
          const id = ++seq;
          pending.set(id, res);
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close: () => ws.close(),
    }));
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
  });
}

/* ------------------------------------------------------------ 素材 */

function buildScratch() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(SRC, { recursive: true });
  const pool = fs.readdirSync(path.join(FIX, 'gallery')).sort();
  for (let i = 0; i < IMAGE_COUNT; i += 1) {
    fs.copyFileSync(path.join(FIX, 'gallery', pool[i * 2]), path.join(SRC, `u-${String(i + 1).padStart(2, '0')}.png`));
  }
}

/* ------------------------------------------------------------ 主流程 */

(async () => {
  buildScratch();
  console.log(`测试素材：${SRC}（${IMAGE_COUNT} 张，会删掉其中一张）`);
  console.log(`原子对话框驱动：${JSON.stringify(dialogDriver.diagnose())}`);

  const page = await waitForPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable', {});
  await cdp.call('Page.enable', {});

  async function ev(expression) {
    const out = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.result?.exceptionDetails) {
      throw new Error(out.result.exceptionDetails.exception?.description?.split('\n')[0] || '异常');
    }
    return out.result?.result?.value;
  }

  // 强制重载：否则渲染进程还在跑改动之前的 app.js / style.css（浏览器有缓存）
  await cdp.call('Page.reload', { ignoreCache: true });
  for (let i = 0; i < 40; i += 1) {
    await sleep(300);
    try { if (await ev('typeof window.__rendererState === "function"')) break; } catch { /* 重载中 */ }
  }
  await sleep(600);

  for (const f of (await ev('window.wp.listQuickFolders()')) || []) {
    await ev(`window.wp.removeQuickFolder(${JSON.stringify(f.id)})`);
  }

  // 基线快照：第一次跑留一份，之后不覆盖 —— 中途崩了下一轮也能还原到用户真配置
  const base = testConfig.begin();
  const cfg = base.baseline;
  const baselineWarn = testConfig.describeBaseline(base);
  if (baselineWarn) console.log(baselineWarn);
  if (testConfig.looksLikeTestData(cfg.folder)) {
    console.log(`⚠ 基线快照本身指向测试目录：${cfg.folder} —— 这一轮跑完请手动核对配置`);
  }

  // 切到测试素材：不改系统壁纸、不自动轮播，方便逐步驱动
  await ev('window.wp.setConfig(' + JSON.stringify({
    folder: SRC, recursive: false, perMonitor: false, monitor: 'primary',
    interval: 900, shuffle: false, autoPlay: false, applyToSystem: false,
    filmstrip: true, infoPanel: true, contextMenu: true,
  }) + ')');
  await ev('window.wp.rebuildChannels(true)');
  await sleep(1400);

  const chId = (await ev('window.__rendererState()')).previewId;
  const files = await ev(`window.wp.channelFiles(${JSON.stringify(chId)}).then((r) => r.files.map((f) => f.path))`);
  check('夹具已载入', files.length === IMAGE_COUNT, `${files.length} 张`);
  await ev('window.wp.rebuildChannels(true)');
  await sleep(1200);

  /* ------------------------------------------------ ① 胶片条删除图标 */

  section('① 胶片条缩略图右上角的删除图标');

  const filmDom = await ev(`(() => {
    const items = [...document.querySelectorAll('#film-track .film-item')];
    const dels = items.map((e) => e.querySelector('.film-del'));
    const idx = items.map((e) => Number(e.dataset.index));
    const currentIdx = idx.find((i, k) => items[k].classList.contains('current'));
    const futureIdx = idx.find((i, k) => items[k].classList.contains('future'));
    const cur = currentIdx !== undefined ? items[idx.indexOf(currentIdx)].querySelector('.film-del') : null;
    const fut = futureIdx !== undefined ? items[idx.indexOf(futureIdx)].querySelector('.film-del') : null;
    return {
      items: items.length,
      withDel: dels.filter(Boolean).length,
      titles: dels.filter(Boolean).slice(0, 3).map((d) => d.title),
      currentIdx,
      futureIdx,
      curDisplay: cur ? getComputedStyle(cur).display : null,
      futDisplay: fut ? getComputedStyle(fut).display : null,
      tagNames: [...new Set(dels.filter(Boolean).map((d) => d.tagName))],
      nestedButtons: [...document.querySelectorAll('#film-track button button')].length,
    };
  })()`);

  check('每个缩略图都有删除图标', filmDom.withDel === filmDom.items && filmDom.items > 0,
    `${filmDom.withDel}/${filmDom.items}`);
  check('删除图标用 span 实现（按钮不能嵌套按钮）',
    filmDom.tagNames.length === 1 && filmDom.tagNames[0] === 'SPAN' && filmDom.nestedButtons === 0,
    `tag=${filmDom.tagNames.join(',')} 嵌套 button=${filmDom.nestedButtons}`);
  check('图标 title 带上文件名', filmDom.titles.every((t) => /删除到回收站/.test(t)), filmDom.titles[0]);
  check('当前那张的图标常显（悬停之外也能看到）', filmDom.curDisplay === 'flex', String(filmDom.curDisplay));
  check('未播放的那张默认隐藏（不吵）', filmDom.futDisplay === 'none', String(filmDom.futDisplay));

  // 点非当前那张的图标：若 stopPropagation 失效，胶片条会先跳到那一张
  const before = await ev('window.__rendererState()');
  const otherIdx = filmDom.currentIdx === 0 ? 1 : 0;
  const otherName = path.basename(files[otherIdx]);
  await ev(`document.querySelector('#film-track .film-item[data-index="${otherIdx}"] .film-del').click()`);

  const dlg = await dialogDriver.waitForDialog({}, 4000);
  check('点删除图标会弹出原生确认框', Boolean(dlg), dlg ? `pid=${dlg.pid} 标题「${dlg.title}」` : '(没等到对话框)');
  // 注：Electron 44 在 Windows 上用的是 TaskDialog，正文没有 Static 子控件可读，
  // 所以「正文里有没有点名这张图」没法直接断言 —— 改成用「确认后删掉的正是这一张」间接证明。
  const dlgBody = dlg ? dialogDriver.dialogStaticTexts(dlg.handle).join(' ｜ ') : '';
  console.log(`      对话框正文（TaskDialog 通常读不到）：${dlgBody || '(空)'}`);
  const foreign = dialogDriver.listForeignDialogs().filter((x) => x.ours === false);
  check('对话框按进程号锁定，不会误抓到别的程序的窗口',
    Boolean(dlg) && dlg.pid === dialogDriver.findAppWindow().pid,
    `系统里另有 ${foreign.length} 个别人的 #32770 窗口（已排除）`);

  const canceled = dlg ? dialogDriver.pressEscape() : false;
  await sleep(700);
  const afterCancel = await ev('window.__rendererState()');
  check('取消后对话框已关闭', Boolean(await dialogDriver.waitForDialogGone(2000)));
  check('取消后画面停在原来那张（删除图标的点击没有冒泡成跳转）',
    afterCancel.index === before.index, `${before.index} → ${afterCancel.index}`);
  check('取消后文件还在', fs.existsSync(files[otherIdx]), otherName);
  check('取消后张数不变', afterCancel.count === IMAGE_COUNT, String(afterCancel.count));

  /* ---- 确认路径：真的删一张 ---- */
  const victimIdx = (await ev('window.__rendererState()')).index;
  const victim = files[victimIdx];
  const countBefore = (await ev('window.__rendererState()')).count;
  await ev(`document.querySelector('#film-track .film-item[data-index="${victimIdx}"] .film-del').click()`);
  const dlg2 = await dialogDriver.waitForDialog({}, 4000);
  const confirmed = dlg2 ? dialogDriver.pressFirstButton(1) : false;
  await sleep(1500);
  const closedAfterConfirm = await dialogDriver.waitForDialogGone(2000);

  const afterConfirm = await ev('window.__rendererState()');
  check('确认框驱动可用（能安全发键）', canceled && confirmed,
    `cancel=${canceled} confirm=${confirmed}${dialogDriver.available() ? '' : '（对话框驱动不可用）'}`);
  check('确认后对话框关闭', closedAfterConfirm);
  check('确认后文件已移入回收站', !fs.existsSync(victim), path.basename(victim));
  check('确认后轮转张数 -1', afterConfirm.count === countBefore - 1,
    `${countBefore} → ${afterConfirm.count}`);
  check('胶片条同步收缩', (await ev(`document.querySelectorAll('#film-track .film-item').length`)) === afterConfirm.count,
    String(afterConfirm.count));

  /* ------------------------------------------------ ② 信息面板跟随 */

  section('② 信息面板跟着当前壁纸同步更新');

  await ev(`document.querySelector('#btn-info').click()`);
  await sleep(900);

  const info0 = await ev(`(() => ({
    open: document.querySelector('#info').classList.contains('open'),
    name: document.querySelector('#info-name').textContent,
    current: window.__rendererState().currentName,
    rows: document.querySelectorAll('#info .ig-row').length,
    sub: document.querySelector('#info-sub').textContent,
  }))()`);
  check('信息面板打开且显示当前这张', info0.open && info0.name === info0.current,
    `${info0.name} vs ${info0.current}`);
  check('面板有实际字段', info0.rows >= 5, `${info0.rows} 行`);

  for (let step = 1; step <= 2; step += 1) {
    await ev(`window.wp.channelCommand(${JSON.stringify(chId)}, 'next')`);
    await sleep(1000);
    const snap = await ev(`(() => ({
      name: document.querySelector('#info-name').textContent,
      current: window.__rendererState().currentName,
      idx: window.__rendererState().index,
      rows: document.querySelectorAll('#info .ig-row').length,
      sub: document.querySelector('#info-sub').textContent,
      thumb: document.querySelector('#info-thumb').src,
      open: window.__rendererState().infoOpen,
    }))()`);
    check(`切到第 ${step} 张后面板跟着更新`, snap.name === snap.current && snap.open === true,
      `面板=${snap.name} 当前=${snap.current}（index ${snap.idx}）`);
    check(`第 ${step} 张的字段依然渲染出来了`, snap.rows >= 5 && !/读取中/.test(snap.sub),
      `${snap.rows} 行 / ${snap.sub.slice(0, 24)}`);
    check(`第 ${step} 张的缩略图换成了 wpthumb://`,
      String(snap.thumb).startsWith('wpthumb://'), String(snap.thumb).slice(0, 40));
  }

  /* ------------------------------------------------ ③ 点空白关闭 */

  section('③ 点面板以外的地方关闭面板');

  const pointerDownOn = (selector) => ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'no-el';
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    return 'ok';
  })()`);

  // 信息面板：点内部不该关
  const inPanel = await pointerDownOn('#info .settings-head');
  await sleep(300);
  check('点面板内部不关闭', inPanel === 'ok'
    && (await ev(`document.querySelector('#info').classList.contains('open')`)) === true);

  // 信息面板：点空白该关
  const onStage = await pointerDownOn('#stage');
  await sleep(300);
  check('点面板以外的地方关闭信息面板', onStage === 'ok'
    && (await ev(`document.querySelector('#info').classList.contains('open')`)) === false);

  // 开关按钮不能把自己刚打开的面板关掉
  await ev(`document.querySelector('#btn-info').click()`);
  await sleep(500);
  check('顶栏按钮仍能打开信息面板',
    (await ev(`document.querySelector('#info').classList.contains('open')`)) === true);
  await ev(`document.querySelector('#btn-info').click()`);
  await sleep(300);
  check('再点一次顶栏按钮能关掉（toggle 未被空白关闭逻辑抢掉）',
    (await ev(`document.querySelector('#info').classList.contains('open')`)) === false);

  // 设置面板：同一套行为
  await ev(`document.querySelector('#btn-settings').click()`);
  await sleep(600);
  const setIn = await pointerDownOn('#settings .settings-head');
  await sleep(300);
  check('点设置面板内部不关闭', setIn === 'ok'
    && (await ev(`document.querySelector('#settings').classList.contains('open')`)) === true);

  const setOut = await pointerDownOn('#stage');
  await sleep(300);
  check('点面板以外的地方关闭设置面板', setOut === 'ok'
    && (await ev(`document.querySelector('#settings').classList.contains('open')`)) === false);

  await ev(`document.querySelector('#btn-settings').click()`);
  await sleep(500);
  await ev(`document.querySelector('#btn-info').click()`);
  await sleep(500);
  const both = await ev(`({
    info: document.querySelector('#info').classList.contains('open'),
    settings: document.querySelector('#settings').classList.contains('open'),
  })`);
  check('两个面板可以同时打开', both.info === true && both.settings === true, JSON.stringify(both));

  await pointerDownOn('#stage');
  await sleep(300);
  const closed = await ev(`({
    info: document.querySelector('#info').classList.contains('open'),
    settings: document.querySelector('#settings').classList.contains('open'),
  })`);
  check('一次点空白把两个都关掉', closed.info === false && closed.settings === false, JSON.stringify(closed));

  /* ------------------------------------------------ 还原 */

  /* ------------------------------------------------ ④ 图片区左右滑动 */

  section('④ 图片区按住左右拖 = 切换上/下一张');
  const swipeState = () => ev('window.__rendererState()');

  // 每次拖拽换一个 pointerId —— 真实输入里每按一次都是一根新指针，
  // 复用同一个 id 会让合成事件看起来像「同一根指针反复按下抬起」
  let swipePid = 100;
  const swipe = async (dx, dy = 0) => {
    swipePid += 1;
    await ev(`(() => {
      const stage = document.querySelector('#stage');
      const pid = ${swipePid};
      const at = (x, y) => ({ clientX: x, clientY: y, pointerId: pid, button: 0, bubbles: true, cancelable: true });
      stage.dispatchEvent(new PointerEvent('pointerdown', at(500, 320)));
      stage.dispatchEvent(new PointerEvent('pointermove', at(500 + (${dx}), 320 + (${dy}))));
      stage.dispatchEvent(new PointerEvent('pointerup', at(500 + (${dx}), 320 + (${dy}))));
    })()`);
    await sleep(1100);
    return swipeState();
  };

  const swipeBase = await swipeState();
  const afterLeft = await swipe(-140);
  check('往左拖 → 下一张',
    afterLeft.index === (swipeBase.index + 1) % afterLeft.count,
    `${swipeBase.index} → ${afterLeft.index}`);

  const afterRight = await swipe(140);
  check('往右拖 → 回到刚才那张', afterRight.index === swipeBase.index,
    `${afterLeft.index} → ${afterRight.index}`);

  const afterTiny = await swipe(-30);
  check('位移太小不算滑动（画面不动）', afterTiny.index === afterRight.index,
    `${afterRight.index} → ${afterTiny.index}`);

  const afterDiagonal = await swipe(-140, 220);
  check('斜着拖不算（横向没明显大于纵向）', afterDiagonal.index === afterTiny.index,
    `${afterTiny.index} → ${afterDiagonal.index}`);

  // 触摸板的双指左右滑（Chromium 会发成 wheel 的 deltaX）
  await ev(`document.querySelector('#stage').dispatchEvent(new WheelEvent('wheel', { deltaX: 80, deltaY: 0, bubbles: true }))`);
  await sleep(900);
  const afterWheel = await swipeState();
  check('触摸板横向滑动 → 下一张',
    afterWheel.index === (afterTiny.index + 1) % afterWheel.count,
    `${afterTiny.index} → ${afterWheel.index}`);

  /* ------------------------------------------------ ⑤ 预览徽标切换 */

  section('⑤ 点顶栏「预览：xxx」切换预览目标');
  // 切成每屏独立才有多个目标可选（只读状态，不写桌面）
  await ev('window.wp.setConfig(' + JSON.stringify({ perMonitor: true, applyToSystem: false }) + ')');
  await ev('window.wp.rebuildChannels(true)');
  await sleep(2000);

  const chCount = (await ev('window.wp.listChannels()')).channels.length;
  const badgeBefore = await ev('document.getElementById("preview-badge").textContent');

  await ev('document.getElementById("preview-badge").click()');
  await sleep(400);
  const menu = await ev(`(() => {
    const m = document.getElementById('preview-menu');
    if (!m) return null;
    const items = [...m.querySelectorAll('.pm-item')];
    return {
      count: items.length,
      texts: items.map((b) => b.textContent.trim()),
      activeIdx: items.findIndex((b) => b.classList.contains('active')),
    };
  })()`);

  check('点击徽标弹出目标列表', Boolean(menu) && menu.count === chCount,
    menu ? `${menu.count} 项 / 频道 ${chCount}` : '(没弹出来)');
  check('当前预览的那一项被标记为选中', Boolean(menu) && menu.activeIdx >= 0,
    menu ? menu.texts[menu.activeIdx] : '');
  check('每一项都带张数与间隔', Boolean(menu) && menu.texts.every((t) => /\d+\s*张/.test(t)),
    menu ? menu.texts.join(' | ') : '');

  if (menu && menu.count > 1) {
    const other = menu.activeIdx === 0 ? 1 : 0;
    const previewBefore = (await ev('window.__rendererState()')).previewId;
    await ev(`document.querySelectorAll('#preview-menu .pm-item')[${other}].click()`);
    await sleep(1400);
    const previewAfter = (await ev('window.__rendererState()')).previewId;
    const badgeAfter = await ev('document.getElementById("preview-badge").textContent');
    check('选另一项后预览目标真的换了', previewAfter !== previewBefore,
      `${previewBefore.slice(-18)} → ${previewAfter.slice(-18)}`);
    check('徽标文字跟着变', badgeAfter !== badgeBefore, `${badgeBefore} → ${badgeAfter}`);
    check('选完之后菜单自动收起',
      !(await ev('Boolean(document.getElementById("preview-menu"))')));
  } else {
    check('（只有一个频道，跳过切换）', true, `频道数 ${chCount}`);
  }

  await ev('document.getElementById("preview-badge").click()');
  await sleep(300);
  const opened = await ev('Boolean(document.getElementById("preview-menu"))');
  await ev('document.getElementById("preview-badge").click()');
  await sleep(300);
  check('再点一次徽标可以收起',
    opened === true && !(await ev('Boolean(document.getElementById("preview-menu"))')));

  section('⑥ 切走预览再切回来，胶片条要落回当前这张');

  /*
   * 12 张撑不满胶片条（实测轨道 1304px，12 张刚好放下，scrollWidth == clientWidth），
   * 不溢出就滚不动，也就测不出「有没有居中」。所以这一节另建一个 40 张的目录。
   */
  const SRC2 = path.join(TMP, 'many');
  fs.mkdirSync(SRC2, { recursive: true });
  const pool2 = fs.readdirSync(path.join(FIX, 'gallery')).sort();
  for (let i = 0; i < FILM_COUNT; i += 1) {
    fs.copyFileSync(path.join(FIX, 'gallery', pool2[i]), path.join(SRC2, `m-${String(i + 1).padStart(2, '0')}.png`));
  }

  const FILM_PROBE = `(() => {
    const t = document.getElementById('film-track');
    const cur = document.querySelector('.film-item.current');
    if (!t || !cur) return null;
    const tr = t.getBoundingClientRect();
    const cr = cur.getBoundingClientRect();
    const want = Math.max(0, Math.min(
      cur.offsetLeft - (t.clientWidth - cur.offsetWidth) / 2,
      t.scrollWidth - t.clientWidth));
    return {
      index: Number(cur.dataset.index),
      overflow: t.scrollWidth > t.clientWidth + 1,
      scrollLeft: Math.round(t.scrollLeft),
      want: Math.round(want),
      visible: cr.left >= tr.left - 2 && cr.right <= tr.right + 2,
      centerOffset: Math.round((cr.left + cr.right) / 2 - (tr.left + tr.right) / 2),
    };
  })()`;

  await ev('window.wp.setConfig(' + JSON.stringify({
    folder: SRC2, recursive: false, perMonitor: true, applyToSystem: false,
    interval: 900, shuffle: false, autoPlay: false, filmstrip: true,
  }) + ')');
  await ev('window.wp.rebuildChannels(true)');
  await sleep(2000);

  const chans = (await ev('window.wp.listChannels()')).channels;
  if (chans.length < 2) {
    check('（只有一块屏，跳过「切走再切回」）', true, `频道数 ${chans.length}`);
  } else {
    const here = (await ev('window.__rendererState()')).previewId;
    const away = chans.map((c) => c.id).find((id) => id !== here);

    // 先跳到靠后的位置 —— 靠前的话「没居中」和「居中了」看起来一样
    await ev(`window.wp.channelCommand(${JSON.stringify(here)}, 'goto', { index: ${JUMP_INDEX} })`);
    await sleep(1200);
    const base = await ev(FILM_PROBE);
    check('胶片条确实溢出（不溢出这条断言就没意义）',
      Boolean(base) && base.overflow === true, base ? `index=${base.index}` : '(没取到)');
    check('切走之前：当前那张是居中的',
      Boolean(base) && base.visible && Math.abs(base.centerOffset) <= 16,
      base ? `index=${base.index} offset=${base.centerOffset} scrollLeft=${base.scrollLeft}/${base.want}` : '');

    // 走真实点击路径（点徽标 → 选目标），而不是直接调内部函数
    const switchPreview = async (id) => {
      await ev('document.getElementById("preview-badge").click()');
      await sleep(350);
      const idx = await ev(`window.__rendererState().channelIds.indexOf(${JSON.stringify(id)})`);
      if (idx < 0) throw new Error(`预览目标不在列表里：${id}`);
      await ev(`document.querySelectorAll('#preview-menu .pm-item')[${idx}].click()`);
      await sleep(1500);
    };

    // 切到另一块屏，再切回来
    await switchPreview(away);
    await ev(`window.wp.channelCommand(${JSON.stringify(away)}, 'goto', { index: 3 })`);
    await sleep(900);
    const onAway = await ev('window.__rendererState()');
    check('预览目标已经切走', onAway.previewId !== here, `${here.slice(-14)} → ${onAway.previewId.slice(-14)}`);

    await switchPreview(here);
    await sleep(600);
    const back = await ev(FILM_PROBE);
    const backState = await ev('window.__rendererState()');

    check('切回来后还是原来那一张（索引没被顶走）',
      backState.index === JUMP_INDEX, `index=${backState.index}，期望 ${JUMP_INDEX}`);
    check('切回来后当前那张在可视范围内',
      Boolean(back) && back.visible === true,
      back ? `index=${back.index} scrollLeft=${back.scrollLeft}` : '(没取到当前项)');
    check('切回来后胶片条已经居中到当前那张',
      Boolean(back) && Math.abs(back.centerOffset) <= 16,
      back ? `中心偏移 ${back.centerOffset}px` : '');
    check('滚动位置与「居中目标」一致',
      Boolean(back) && Math.abs(back.scrollLeft - back.want) <= 4,
      back ? `scrollLeft=${back.scrollLeft} 期望≈${back.want}` : '');
  }

  section('还原配置');
  const restored = await testConfig.restore(ev);
  await sleep(600);
  check('已从基线快照还原配置',
    restored.ok && path.normalize(restored.actual.folder) === path.normalize(cfg.folder),
    restored.ok ? restored.actual.folder : restored.error);
  check('还原后的目录不是测试素材',
    !testConfig.looksLikeTestData(restored.actual.folder), String(restored.actual.folder));
  check('每屏模式已还原', restored.actual.perMonitor === cfg.perMonitor, String(restored.actual.perMonitor));
  check('还原后与还原点逐键一致（脏值不会被下一轮继承）',
    (restored.diff || []).length === 0,
    (restored.diff || []).slice(0, 4).join('；') || '完全一致');


  cdp.close();

  console.log(`\n${'='.repeat(56)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { console.log('失败项：'); failures.forEach((f) => console.log(`  - ${f}`)); }
  console.log(`测试素材（可直接删除）：${TMP}`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n验证脚本异常终止：', err.message);
  console.error(err.stack);
  process.exit(2);
});
