'use strict';

/**
 * 第九轮的端到端验证：删除确认 + 托盘删除 + 全局热键。
 *
 *   ① 设置里的「请求删除照片的权限」开关（图标 + 标题 + 说明 + 开关那行）
 *   ② 删除前弹原生确认框：取消则什么都不发生；勾「不再询问」开关自动关掉；
 *      关掉开关后直接删，不再弹框
 *   ③ 托盘每块显示器的子菜单里有「删除到回收站」，且真的能删掉当前那张
 *   ④ 全局热键：拒绝无修饰键、成功注册、键盘真实注入能触发（窗口藏起来也生效）
 *
 * 用法：应用以 --remote-debugging-port=9222 启动，然后
 *   node tools/verify-delete-hotkeys.js
 *
 * 全程只碰 tools/tmp 下的测试素材；配置用 tools/testConfig.js 的基线快照兜底还原。
 * 会往系统里注入按键（Ctrl+Alt+F9）——这是唯一能证明全局热键真的生效的办法，
 * 选的组合键在系统里没有别的程序占用。
 */

const path = require('node:path');
const fs = require('node:fs');

const dialogDriver = require('./dialogDriver');
const keyboardDriver = require('./keyboardDriver');
const recycleBin = require('./recycleBin');
const testConfig = require('./testConfig');
const desktopWallpaper = require('../src/desktopWallpaper');

const CDP_LIST = 'http://127.0.0.1:9222/json';
const FIX = path.resolve(__dirname, 'fixtures');
const TMP = path.resolve(__dirname, 'tmp', 'delete-hotkeys');
const SRC = path.join(TMP, 'src');
const IMAGE_COUNT = 12;

/** 这一轮用的测试热键：Ctrl+Alt+F9 */
const TEST_ACCEL = 'Ctrl+Alt+F9';
const TEST_KEYS = [keyboardDriver.VK.CONTROL, keyboardDriver.VK.ALT, keyboardDriver.VK.F9];

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
    fs.copyFileSync(path.join(FIX, 'gallery', pool[i * 3]), path.join(SRC, `d-${String(i + 1).padStart(2, '0')}.png`));
  }
}

function osMonitors() {
  const r = desktopWallpaper.enumMonitors();
  return (r.monitors || []).map((m) => ({
    isPrimary: Boolean(m.primary),
    current: m.current || null,
  }));
}

/* ------------------------------------------------------------ 主流程 */

(async () => {
  buildScratch();
  console.log(`测试素材：${SRC}（${IMAGE_COUNT} 张，会删掉其中两张）`);
  console.log(`对话框驱动：${JSON.stringify(dialogDriver.diagnose())}`);
  console.log(`键盘驱动：${JSON.stringify(keyboardDriver.diagnose())}`);

  const page = await waitForPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable', {});

  async function ev(expression, { awaitPromise = true } = {}) {
    const out = await cdp.call('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (out.result?.exceptionDetails) {
      throw new Error(out.result.exceptionDetails.exception?.description?.split('\n')[0] || '异常');
    }
    return out.result?.result?.value;
  }

  /* -------------------------------------------------- 0. 准备 */

  section('0. 切到测试素材（统一模式、只写主屏）');

  const base = testConfig.begin();
  const baseline = base.baseline;
  const baselineWarn = testConfig.describeBaseline(base);
  if (baselineWarn) console.log(baselineWarn);

  await ev('window.wp.setConfig(' + JSON.stringify({
    folder: SRC,
    recursive: false,
    perMonitor: false,
    monitor: 'primary',
    interval: 3600,
    autoPlay: false,
    applyToSystem: true,
    shuffle: false,
    confirmDelete: true,
    filmstrip: true,
  }) + ')');
  await ev('window.wp.rebuildChannels(true)');
  await sleep(1600);

  const ch0 = (await ev('window.wp.listChannels()')).channels[0];
  check('夹具载入', ch0 && ch0.count === IMAGE_COUNT, `${ch0 && ch0.count} 张`);
  check('删除确认默认是开的', (await ev('window.wp.getConfig()')).confirmDelete === true);

  /*
   * 记下用户**自己**的热键。
   * 以前结尾那条断言写的是「还原后热键都是空串」—— 那等于假设用户一个都没绑，
   * 用户绑了就会被判成失败（实测就是这么红的）。判据应该是「和开跑前一模一样」。
   */
  const userHotkeys0 = JSON.stringify((await ev('window.wp.getHotkeys()')).hotkeys);

  const chId = ch0.id;
  const filesOf = () => ev(`window.wp.channelFiles(${JSON.stringify(chId)}).then((r) => r.files.map((f) => f.path))`);
  const countOf = async () => (await ev('window.wp.listChannels()')).channels[0].count;

  /*
   * 重建频道本身不会写壁纸（applyOnStart 只管应用启动那一次），
   * 所以这里要主动把当前帧落到桌面一次 —— 否则桌面还挂着上一轮留下的图，
   * 后面「删除当前帧后桌面有没有换图」这类断言就失去基准了。
   */
  await ev(`window.wp.applyChannel(${JSON.stringify(chId)})`);
  await sleep(1600);

  const aligned = await ev('window.__rendererState()');
  const osAligned = osMonitors().find((m) => m.isPrimary);
  check('测试基准已对齐：桌面挂的就是应用当前的这一张',
    path.basename(osAligned.current || '') === aligned.currentName,
    `${path.basename(osAligned.current || '')} vs ${aligned.currentName}`);

  /* -------------------------------------------------- 1. 设置面板 */

  section('1. 设置面板里的「请求删除照片的权限」那一行');

  await ev(`document.querySelector('#btn-settings').click()`);
  // 上面的 setConfig 是直接打给主进程的，界面里的 state.config 还是旧的 —— 先让它重读
  await ev('window.__reloadConfig()');
  await sleep(400);

  const row = await ev(`(() => {
    const el = document.querySelector('.check.rich');
    if (!el) return null;
    const icon = el.querySelector('.rich-icon svg');
    const title = el.querySelector('.rich-title');
    const hint = el.querySelector('.rich-hint');
    const input = el.querySelector('input[type=checkbox]');
    const box = el.getBoundingClientRect();
    const ib = input.getBoundingClientRect();
    return {
      hasIcon: Boolean(icon),
      title: title ? title.textContent : null,
      hint: hint ? hint.textContent : null,
      checked: input ? input.checked : null,
      id: input ? input.id : null,
      switchWidth: Math.round(ib.width),
      switchHeight: Math.round(ib.height),
      switchRightOfText: ib.left > box.left + box.width / 2,
      textBeforeSwitch: title ? title.getBoundingClientRect().left < ib.left : false,
      labelFor: el.getAttribute('for'),
    };
  })()`);

  check('存在两行式开关行', Boolean(row), row ? `「${row.title}」` : '(没找到 .check.rich)');
  if (row) {
    check('这一行带垃圾桶图标（内联 SVG）', row.hasIcon === true);
    check('标题是「请求删除照片的权限」', row.title === '请求删除照片的权限', String(row.title));
    check('说明是「删除项目或文件夹时显示确认对话框」',
      row.hint === '删除项目或文件夹时显示确认对话框', String(row.hint));
    check('开关做成了滑块（不是方框）', row.switchWidth >= 30 && row.switchHeight >= 18,
      `${row.switchWidth}×${row.switchHeight}`);
    check('文字在左、开关在右', row.switchRightOfText && row.textBeforeSwitch);
    check('整行可点（label for 指向这个开关）', row.labelFor === row.id, `${row.labelFor} → ${row.id}`);
    check('默认是打开状态', row.checked === true);
  }

  check('「删除当前这张到回收站」按钮存在', await ev(`Boolean(document.querySelector('#btn-del-current'))`));

  // 开关能落盘
  await ev(`(() => { const el = document.querySelector('#cfg-confirm-delete'); el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(600);
  check('关掉开关后配置落盘为 false', (await ev('window.wp.getConfig()')).confirmDelete === false,
    String((await ev('window.wp.getConfig()')).confirmDelete));

  await ev(`(() => { const el = document.querySelector('#cfg-confirm-delete'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(600);
  check('再打开后配置回到 true', (await ev('window.wp.getConfig()')).confirmDelete === true);

  /* -------------------------------------------------- 2. 确认框 */

  section('2. 删除前的原生确认框');

  const appWin = dialogDriver.findAppWindow();
  const victim1 = (await filesOf())[(await ev('window.__rendererState()')).index];
  const name1 = path.basename(victim1);
  const before2 = await ev('window.__rendererState()');

  // 不 await 那个 promise —— 它会一直挂到对话框关掉为止
  await ev(`void window.wp.trashFile(${JSON.stringify(victim1)}); 'fired'`, { awaitPromise: false });
  const dlg1 = await dialogDriver.waitForDialog({}, 5000);

  check('弹出原生确认框', Boolean(dlg1), dlg1 ? `pid=${dlg1.pid} 标题「${dlg1.title}」` : '(没等到)');
  check('确认框属于本应用进程（不会误抓别的程序）',
    Boolean(dlg1) && Boolean(appWin) && dlg1.pid === appWin.pid,
    `对话框 pid=${dlg1 && dlg1.pid}，应用 pid=${appWin && appWin.pid}`);

  const canceled = dlg1 ? dialogDriver.pressEscape() : false;
  await sleep(900);
  check('按 Esc 能关掉确认框', Boolean(await dialogDriver.waitForDialogGone(2500)));
  check('取消后文件还在', fs.existsSync(victim1), name1);
  check('取消后张数不变', (await countOf()) === IMAGE_COUNT);
  check('取消后画面没跳', (await ev('window.__rendererState()')).currentName === before2.currentName);

  // 走一遍「勾上不再询问 → 取消」：开关应该被关掉
  await ev(`void window.wp.trashFile(${JSON.stringify(victim1)}); 'fired'`, { awaitPromise: false });
  const dlg2 = await dialogDriver.waitForDialog({}, 5000);
  let checkboxDriven = false;
  if (dlg2) {
    checkboxDriven = dialogDriver.pressKeys([keyboardDriver.VK.TAB, keyboardDriver.VK.SPACE]);
    await sleep(400);
    dialogDriver.pressEscape();
    await sleep(800);
  }
  const afterCheckbox = (await ev('window.wp.getConfig()')).confirmDelete;
  check('勾「不再询问」后开关自动关掉（对话框驱动可用时）',
    !checkboxDriven || afterCheckbox === false,
    checkboxDriven ? `confirmDelete=${afterCheckbox}` : '(对话框驱动不可用，跳过)');

  const uiSynced = await ev(`document.querySelector('#cfg-confirm-delete').checked`);
  check('设置面板里的开关同步变成关', !checkboxDriven || uiSynced === false, String(uiSynced));

  section('3. 关掉开关后：直接删，不再弹框');

  await ev(`void window.wp.setConfig({ confirmDelete: false })`);
  await sleep(400);

  const victim2 = (await filesOf())[0];
  const name2 = path.basename(victim2);
  const rbBefore = recycleBin.query(recycleBin.rootOf(victim2));

  await ev(`window.wp.trashFile(${JSON.stringify(victim2)})`);
  await sleep(1200);

  const dlg3 = dialogDriver.findDialog();
  check('没有弹确认框', !dlg3, dlg3 ? `不该有对话框，却出现了 pid=${dlg3.pid}` : '');
  check('文件已离开原目录', !fs.existsSync(victim2), name2);
  check('张数 -1', (await countOf()) === IMAGE_COUNT - 1, `→ ${await countOf()}`);

  const rbAfter = recycleBin.query(recycleBin.rootOf(victim2));
  check('确实进了回收站（条目 +1，不是永久删除）',
    rbBefore && rbAfter && rbAfter.items === rbBefore.items + 1,
    rbBefore && rbAfter ? `${rbBefore.items} → ${rbAfter.items}` : '(回收站读不到)');

  /* -------------------------------------------------- 4. 托盘菜单 */

  section('4. 托盘菜单结构');

  const menu = await ev('window.wp.trayMenuTemplate()');
  const flat = (items, out = []) => {
    for (const it of items || []) {
      out.push(it);
      if (it.submenu) flat(it.submenu, out);
    }
    return out;
  };
  const all = flat(menu);
  const topLabels = (menu || []).map((i) => i.label);
  const channelItem = (menu || []).find((i) => /显示器|全部显示器/.test(i.label || ''));
  const subLabels = channelItem ? channelItem.submenu.map((i) => i.label) : [];

  check('取到托盘菜单模板', Array.isArray(menu) && menu.length > 0, `${menu ? menu.length : 0} 个顶层项`);
  check('顶层有「设置…」', topLabels.includes('设置…'));
  check('顶层有「开机自启」检查项', all.some((i) => i.label === '开机自启' && i.type === 'checkbox'));
  check('顶层有「退出」', topLabels.includes('退出'));
  check('有显示器子菜单', Boolean(channelItem), channelItem ? channelItem.label : '(没找到)');

  for (const want of ['下一张', '上一张', '立即设为壁纸', '重新扫描', '删除到回收站']) {
    check(`显示器子菜单里有「${want}」`, subLabels.includes(want));
  }

  const delItem = channelItem
    ? channelItem.submenu.find((i) => i.label === '删除到回收站')
    : null;
  check('「删除到回收站」接上了动作', Boolean(delItem && delItem.hasClick));
  check('「删除到回收站」在张数 > 0 时可用', Boolean(delItem && delItem.enabled));

  /* -------------------------------------------------- 5. 删除动作 */

  section('5. 删除动作（托盘/热键共用同一条路径）');

  await ev('window.wp.setConfig({ confirmDelete: false })');
  await sleep(600);

  const beforeDel = await ev('window.__rendererState()');
  const delPath = (await filesOf())[beforeDel.index];
  const osBefore = osMonitors().find((m) => m.isPrimary);
  const chBefore = (await ev('window.wp.listChannels()')).channels[0];

  console.log(`      删除前：应用 index=${beforeDel.index} 当前=${beforeDel.currentName}`
    + `   桌面=${path.basename(osBefore.current || '')}`
    + `   主进程 lastWrite=${chBefore.lastWrite ? chBefore.lastWrite.method : 'null'}`
    + `   窗口可见=${dialogDriver.isAppWindowVisible()}`);

  // 先确认要删的那个文件真的存在 —— 列表里出现本地已不存在的路径本身就是要抓的 bug
  check('待删的那张在磁盘上确实存在', fs.existsSync(delPath), path.basename(delPath));
  check('删除前「应用当前帧」与「桌面实际挂的图」是一致的',
    path.basename(osBefore.current || '') === beforeDel.currentName,
    `${path.basename(osBefore.current || '')} vs ${beforeDel.currentName}`);

  const r2 = await ev('window.wp.invokeHotkey("delete")');
  await sleep(1600);

  const afterDel = await ev('window.__rendererState()');
  const osAfter = osMonitors().find((m) => m.isPrimary);

  check('触发删除动作返回成功', Boolean(r2 && r2.ok), JSON.stringify(r2));
  check('被删的是当时正在显示的那张', !fs.existsSync(delPath), path.basename(delPath));
  check('张数 -1', afterDel.count === beforeDel.count - 1, `${beforeDel.count} → ${afterDel.count}`);
  check('索引收敛到合法范围', afterDel.index >= 0 && afterDel.index < afterDel.count,
    `index=${afterDel.index} count=${afterDel.count}`);
  check('桌面立刻改挂了别的图（没留一张回收站里的图）',
    osAfter && osBefore && osAfter.current !== osBefore.current && fs.existsSync(osAfter.current || ''),
    `${path.basename(osBefore.current || '')} → ${path.basename(osAfter.current || '')}`);

  /*
   * 删除之后再触发一次重建（改间隔 / 切每屏独立 / 插拔显示器都会）。
   * 这里曾经有个真 bug：频道里的列表是扫描结果的**副本**，
   * 删掉的那张只从副本里消失了，扫描缓存里还在 —— 一重建它就「复活」，
   * 列表里出现一个磁盘上已不存在的路径。
   */
  await ev('window.wp.setConfig({ interval: 3590 })');
  await sleep(1600);
  const afterRebuild = await ev('window.__rendererState()');
  const filesAfterRebuild = await filesOf();
  check('重建后张数没有被「复活」', afterRebuild.count === afterDel.count,
    `${afterDel.count} → ${afterRebuild.count}`);
  check('重建后列表里没有磁盘上不存在的路径',
    filesAfterRebuild.every((p) => fs.existsSync(p)),
    filesAfterRebuild.filter((p) => !fs.existsSync(p)).map((p) => path.basename(p)).join(', ') || '全部存在');

  /* -------------------------------------------------- 6. 全局热键 */

  section('6. 全局热键');

  const hk0 = await ev('window.wp.getHotkeys()');
  check('取到热键动作表', Object.keys(hk0.actions).length >= 5,
    Object.values(hk0.actions).join(' / '));

  // 没有修饰键的必须被拒 —— 否则会抢掉全系统的输入
  const rejected = await ev(`window.wp.setHotkeys({ next: 'F9' })`);
  const rejFail = (rejected.failed || []).find((f) => f.action === 'next');
  check('拒绝不带修饰键的热键', Boolean(rejFail), rejFail ? rejFail.reason : '(没拒绝)');
  check('被拒的热键没有注册', !rejected.registered.next);

  // 合法热键
  const ok1 = await ev(`window.wp.setHotkeys({ next: ${JSON.stringify(TEST_ACCEL)} })`);
  check(`注册 ${TEST_ACCEL} 成功`, ok1.registered.next === TEST_ACCEL,
    JSON.stringify(ok1.registered) + (ok1.failed.length ? ` 失败:${JSON.stringify(ok1.failed)}` : ''));

  const state1 = await ev('window.__rendererState()');
  const target = (await ev('window.wp.invokeHotkey("next")')).target;
  check('热键目标是当前预览的频道', target === state1.previewId, `${target} vs ${state1.previewId}`);
  await sleep(1600);

  const state2 = await ev('window.__rendererState()');
  check('「下一张」动作推进了索引', state2.index === (state1.index + 1) % state1.count,
    `${state1.index} → ${state2.index}`);

  const osNext = osMonitors().find((m) => m.isPrimary);
  check('桌面壁纸跟着换了', path.basename(osNext.current || '') === state2.currentName,
    `${path.basename(osNext.current || '')} vs ${state2.currentName}`);

  await ev('window.wp.invokeHotkey("prev")');
  await sleep(1600);
  const state3 = await ev('window.__rendererState()');
  check('「上一张」动作退回去了', state3.index === state1.index, `${state2.index} → ${state3.index}`);

  // 暂停/继续
  const playingBefore = (await ev('window.__rendererState()')).playing;
  await ev('window.wp.invokeHotkey("playPause")');
  await sleep(700);
  const playingAfter = (await ev('window.__rendererState()')).playing;
  check('「暂停 / 继续」动作能翻转播放状态', playingAfter === !playingBefore,
    `${playingBefore} → ${playingAfter}`);
  await ev('window.wp.invokeHotkey("playPause")');       // 还原
  await sleep(500);

  /* --- 真实注入按键：这才是「全局热键真的生效」的证据 --- */

  section('7. 往系统里真按一次键（窗口藏起来的情况下）');

  const kbOk = keyboardDriver.available();
  if (!kbOk) {
    check('键盘驱动可用（不可用则跳过注入测试）', false, 'koffi 加载 user32 失败');
  } else {
    const before = await ev('window.__rendererState()');

    // 把窗口藏进托盘 —— 全局热键必须在这种情况下照样生效
    await ev('window.wp.hideWindow()');
    await sleep(1000);

    // 按键之前先确认窗口真的不可见了，否则这条断言证明不了「藏在托盘里也能用」
    // （隐藏到托盘后 HWND 还在，只是 IsWindowVisible 为假）
    check('窗口已隐藏（全局热键要在没有窗口的情况下生效）',
      !dialogDriver.isAppWindowVisible(), 'IsWindowVisible 仍为真');

    keyboardDriver.combo(TEST_KEYS);
    await sleep(1800);

    const after = await ev('window.__rendererState()');
    check('窗口隐藏时按下 Ctrl+Alt+F9 仍然切了图',
      after.index === (before.index + 1) % before.count,
      `${before.index} → ${after.index}（count=${before.count}）`);

    const osAfterKey = osMonitors().find((m) => m.isPrimary);
    check('桌面壁纸确实跟着变了',
      path.basename(osAfterKey.current || '') === after.currentName,
      `${path.basename(osAfterKey.current || '')} vs ${after.currentName}`);

    // 把窗口叫回来
    await ev('window.wp.showWindow()');
    await sleep(800);
    check('窗口能重新显示出来', dialogDriver.isAppWindowVisible());
  }

  /* --- 录制态的进出：不能把录制态一直挂着 --- */

  section('6.1 录制态：点格子进入，点别处退出');

  await ev(`document.querySelector('#btn-settings').click()`);
  await sleep(500);

  await ev(`document.querySelector('.hotkey-key[data-action="playPause"]').click()`);
  await sleep(300);
  check('点热键格子进入录制态',
    await ev(`document.querySelector('.hotkey-row[data-action="playPause"]').classList.contains('recording')`) === true);

  // 点面板里别的地方 → 应该退出录制态
  await ev(`document.querySelector('#settings').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`);
  await sleep(300);
  check('点别处就退出录制态（不会一直挂着）',
    await ev(`document.querySelectorAll('.hotkey-row.recording').length`) === 0);

  // 退出录制态之后再按键，不该被记成热键
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', ctrlKey: true, bubbles: true }))`);
  await sleep(500);
  const afterStray = await ev('window.wp.getHotkeys()');
  check('退出录制后随手按键不会再绑上热键', afterStray.hotkeys.playPause === '',
    `playPause=${JSON.stringify(afterStray.hotkeys.playPause)}`);

  // 关面板同样要退出录制态
  await ev(`document.querySelector('.hotkey-key[data-action="info"]').click()`);
  await sleep(250);
  await ev(`document.querySelector('#btn-settings-close').click()`);
  await sleep(300);
  check('关设置面板也会退出录制态',
    await ev(`document.querySelectorAll('.hotkey-row.recording').length`) === 0);
  await ev(`document.querySelector('#btn-settings').click()`);
  await sleep(400);

  // 清空热键
  const cleared = await ev(`window.wp.setHotkeys({ cycleMonitor: '', next: '', prev: '', playPause: '', delete: '', toggleWindow: '', info: '' })`);
  check('清空全部热键后没有任何注册',
    Object.keys(cleared.registered).length === 0, JSON.stringify(cleared.registered));
  check('配置里热键都是空串',
    Object.values(cleared.hotkeys).every((v) => v === ''), JSON.stringify(cleared.hotkeys));

  /* -------------------------------------------------- 8. 删不掉时必须说出来 */

  section('8. 删除热键：删不掉时必须说出原因（以前是静默的）');

  /*
   * 曾经这一支写的是 `if (id) trashChannelCurrent(id).then(...)`：
   * 目标为空、或这一路没有图片时直接静默跳过；再加上托盘态下 toast 根本看不见，
   * 用户按了热键什么都收不到，只能得出「热键不生效」这一个结论。
   * 下面盯住「失败必须说话」这条。
   */
  const emptyDir = path.join(TMP, 'empty');
  fs.mkdirSync(emptyDir, { recursive: true });

  await ev(`window.wp.setConfig({ folder: ${JSON.stringify(emptyDir)}, perMonitor: false, applyToSystem: false })`);
  await ev('window.wp.rebuildChannels(true)');
  await sleep(1800);

  const emptyState = await ev('window.__rendererState()');
  check('测试目录里确实一张图都没有', emptyState.count === 0, `count=${emptyState.count}`);

  const clearToastExpr = `document.querySelectorAll('#toast, .toast').forEach((e) => { e.textContent = ''; })`;
  const readToastExpr = `(() => { const e = document.querySelector('#toast, .toast'); return e ? e.textContent : ''; })()`;

  await ev(clearToastExpr);
  await ev('window.wp.invokeHotkey("delete")');
  await sleep(900);
  const emptyToast = await ev(readToastExpr);
  check('没图可删时明确说出了原因（不再静默）',
    /没有图片|没什么可删|没有可删除的目标/.test(emptyToast), emptyToast || '(没有任何提示)');

  // 换回测试素材：确认能删的时候提示还在，并且点明删的是哪一张
  await ev(`window.wp.setConfig({ folder: ${JSON.stringify(SRC)} })`);
  await ev('window.wp.rebuildChannels(true)');
  await sleep(2000);
  const backState = await ev('window.__rendererState()');
  const victimName = backState.currentName;

  await ev(clearToastExpr);
  await ev('window.wp.invokeHotkey("delete")');
  await sleep(1400);
  const delToast = await ev(readToastExpr);
  check('能删的时候提示里说清删了哪张',
    /已移入回收站/.test(delToast) && delToast.includes(String(victimName).replace(/\.[^.]+$/, '')),
    delToast || '(没有任何提示)');

  const afterDelState = await ev('window.__rendererState()');
  check('张数 -1', afterDelState.count === backState.count - 1, `${backState.count} → ${afterDelState.count}`);

  /* -------------------------------------------------- 9. 还原 */

  section('9. 还原配置');

  await ev('window.wp.showWindow()');
  const restored = await testConfig.restore(ev);
  await sleep(800);
  check('已从基线快照还原配置', restored.ok, restored.ok ? restored.actual.folder : restored.error);
  check('还原后与还原点逐键一致（没有「还原了但没完全还原」）',
    (restored.diff || []).length === 0,
    (restored.diff || []).slice(0, 4).join('；') || '完全一致');
  check('还原后的目录不是测试素材',
    !testConfig.looksLikeTestData(restored.actual.folder), String(restored.actual.folder));
  check('还原后的热键与开跑前一致（用户自己绑的没被清掉）',
    JSON.stringify(restored.actual.hotkeys) === userHotkeys0,
    `${JSON.stringify(restored.actual.hotkeys)} vs 开跑前 ${userHotkeys0}`);
  check('测试用的热键没有漏进配置',
    Object.values(restored.actual.hotkeys || {}).every((v) => v !== TEST_ACCEL),
    JSON.stringify(restored.actual.hotkeys));

  cdp.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '));
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n验证脚本异常:', err.message);
  console.error(err.stack);
  process.exit(1);
});
