'use strict';

/**
 * 「切到下一台显示器」全局热键的端到端验证。
 *
 * 这条链路跨了三个边界，每一段都得单独证明 —— 因为任何一段断了，
 * 用户看到的现象都是同一句话：「按了没反应」。
 *
 *   主进程 globalShortcut
 *     → runHotkeyAction('cycleMonitor') → cycleMonitorTarget()   改 currentPreviewId
 *     → send('preview:select')                                   跨进程反向通知
 *     → 渲染层 setPreview() → state.previewId                     界面跟着走
 *
 * 主流程把 applyToSystem 关掉跑：频道照常建立、热键照常切目标，但**一张图都不写进系统壁纸**。
 * 「切换目标」和「真的写进哪块屏」是两件事 —— 前者零副作用就能测干净（第 2~4 节），
 * 后者单独用一节带壁纸存档的方式测（第 6 节）。这样跑一次测试不会把用户的桌面刷成测试图。
 *
 * 用法：应用以 --remote-debugging-port=9222 启动，然后
 *   node tools/verify-monitor-cycle.js
 *
 * 需要机器上至少有 2 块显示器（每屏模式才有两路频道可切）；只有 1 块时第 2/3/6 节会显式跳过，
 * 而不会伪装成通过。
 */

const path = require('node:path');
const fs = require('node:fs');

const keyboardDriver = require('./keyboardDriver');
const dialogDriver = require('./dialogDriver');
const testConfig = require('./testConfig');
const desktopWallpaper = require('../src/desktopWallpaper');

const CDP_LIST = 'http://127.0.0.1:9222/json';
const FIX = path.resolve(__dirname, 'fixtures');
const TMP = path.resolve(__dirname, 'tmp', 'monitor-cycle');
const DIR_A = path.join(TMP, 'A');
const DIR_B = path.join(TMP, 'B');
const PER_DIR = 6;

/** 这一轮用的测试热键：Ctrl+Alt+F10（和 verify:tray 的 F9 错开，两者同时跑也不打架） */
const TEST_ACCEL = 'Ctrl+Alt+F10';
const TEST_KEYS = [keyboardDriver.VK.CONTROL, keyboardDriver.VK.ALT, keyboardDriver.VK.F10];

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; failures.push(label); console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

function skip(label, why) {
  skipped += 1;
  console.log(`  ~ ${label}（跳过：${why}）`);
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

/** 轮询到条件成立（或超时）。比裸 sleep 稳 —— 每屏壁纸是异步落盘的 */
async function waitUntil(fn, { timeout = 6000, interval = 300 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  return null;
}

/* ------------------------------------------------------------ 素材 */

function buildScratch() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(DIR_A, { recursive: true });
  fs.mkdirSync(DIR_B, { recursive: true });
  const pool = fs.readdirSync(path.join(FIX, 'gallery')).sort();
  for (let i = 0; i < PER_DIR; i += 1) {
    fs.copyFileSync(path.join(FIX, 'gallery', pool[i * 5]), path.join(DIR_A, `a-${String(i + 1).padStart(2, '0')}.png`));
    fs.copyFileSync(path.join(FIX, 'gallery', pool[i * 5 + 2]), path.join(DIR_B, `b-${String(i + 1).padStart(2, '0')}.png`));
  }
}

function osMonitors() {
  const r = desktopWallpaper.enumMonitors();
  return r.monitors || [];
}

const osCurrentOf = (device) => {
  const m = osMonitors().find((x) => x.id === device);
  return m ? m.current : null;
};

/* ------------------------------------------------------------ 主流程 */

(async () => {
  buildScratch();
  console.log(`测试素材：${DIR_A} / ${DIR_B}（各 ${PER_DIR} 张）`);
  console.log(`键盘驱动：${JSON.stringify(keyboardDriver.diagnose())}`);

  const monitors = osMonitors();
  console.log(`系统显示器：${monitors.length} 块 —— ${monitors.map((m) => `${m.width}×${m.height}`).join(' / ')}`);

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

  const previewIdOf = async () => (await ev('window.__rendererState()')).previewId;
  const channelsOf = async () => (await ev('window.wp.listChannels()')).channels;
  const channelIds = async () => (await channelsOf()).map((c) => c.id);
  const channelById = async (id) => (await channelsOf()).find((c) => c.id === id) || null;

  /** 一路路切过去，直到预览落在 id 上 */
  async function switchPreviewTo(id) {
    for (let i = 0; i < 8; i += 1) {
      if ((await previewIdOf()) === id) return true;
      await ev('window.wp.invokeHotkey("cycleMonitor")');
      await sleep(450);
    }
    return (await previewIdOf()) === id;
  }

  /* -------------------------------------------------- 0. 准备 */

  section('0. 切到测试素材（每屏独立、不写系统壁纸）');

  const base = testConfig.begin();
  const baselineWarn = testConfig.describeBaseline(base);
  if (baselineWarn) console.log(baselineWarn);

  const devA = monitors[0] ? monitors[0].id : null;
  const devB = monitors[1] ? monitors[1].id : null;

  /*
   * 每屏覆盖只设 folder / interval 这两个「基线里本来就有的键」。
   * 加一个基线里没有的键（比如 animation），还原时 deepMerge 会把当前值留在对象里，
   * 于是它残留在用户的正式配置里 —— 这是测试污染最隐蔽的一种。
   */
  const testConfigPatch = {
    folder: DIR_A,
    recursive: false,
    perMonitor: true,
    applyToSystem: false,      // ← 主流程零副作用：只切目标，不写壁纸
    applyOnStart: false,
    autoPlay: false,
    shuffle: false,
    interval: 3600,
    monitors: {},
  };
  if (devA) testConfigPatch.monitors[devA] = { folder: DIR_A, interval: 3600 };
  if (devB) testConfigPatch.monitors[devB] = { folder: DIR_B, interval: 3600 };

  await ev('window.wp.setConfig(' + JSON.stringify(testConfigPatch) + ')');
  await ev('window.wp.rebuildChannels(true)');
  await sleep(1800);

  const ids0 = await channelIds();
  check('每屏独立建出了两路频道', ids0.length >= 2, `${ids0.length} 路`);
  check('测试期间没接管系统壁纸（applyToSystem 已关）',
    (await ev('window.wp.getConfig()')).applyToSystem === false);

  if (ids0.length < 2) {
    skip('第 2~6 节全部', '这台机器上只有 1 路频道，没东西可切');
    console.log('\n提示：需要至少 2 块显示器才能验证「切到下一台显示器」。');
  } else {
    const A = ids0[0];
    const B = ids0[1];

    /* ------------------------------------------------ 1. 动作表与注册 */

    section('1. 动作表、校验与注册');

    const hk = await ev('window.wp.getHotkeys()');
    check('动作表里有 cycleMonitor', Boolean(hk.actions.cycleMonitor), String(hk.actions.cycleMonitor));
    check('配置里补出了 cycleMonitor 键（老配置自动兼容）',
      Object.prototype.hasOwnProperty.call(hk.hotkeys, 'cycleMonitor'),
      JSON.stringify(hk.hotkeys));

    const rejected = await ev('window.wp.setHotkeys({ cycleMonitor: "F10" })');
    const rejFail = (rejected.failed || []).find((f) => f.action === 'cycleMonitor');
    check('拒绝不带修饰键的切屏热键', Boolean(rejFail), rejFail ? rejFail.reason : '(没拒绝)');

    const okSet = await ev(`window.wp.setHotkeys({ cycleMonitor: ${JSON.stringify(TEST_ACCEL)} })`);
    check(`注册 ${TEST_ACCEL} 成功`, okSet.registered.cycleMonitor === TEST_ACCEL,
      JSON.stringify(okSet.registered) + (okSet.failed.length ? ` 失败:${JSON.stringify(okSet.failed)}` : ''));
    check('切屏热键落盘了',
      (await ev('window.wp.getConfig()')).hotkeys.cycleMonitor === TEST_ACCEL);

    /* ------------------------------------------------ 2. 切换目标（核心） */

    section('2. 按一次：目标与界面一起换到另一块屏');

    const atA = await switchPreviewTo(A);
    check('先把预览停在第 1 路（后面才好观察推进方向）', atA, `preview=${await previewIdOf()}`);

    const before2 = await previewIdOf();
    const r1 = await ev('window.wp.invokeHotkey("cycleMonitor")');
    check('动作返回成功', r1.ok === true, JSON.stringify(r1));
    check('主进程的目标换成了另一路', r1.target !== before2, `${stripId(before2)} → ${stripId(r1.target)}`);
    check('切到的就是第 2 路', r1.target === B, `${stripId(r1.target)} vs ${stripId(B)}`);

    const synced = await waitUntil(async () => ((await previewIdOf()) === B ? true : null), { timeout: 4000 });
    check('渲染层的预览跟到了新频道（反向通道打通）', Boolean(synced),
      `renderer.previewId = ${stripId(await previewIdOf())}`);

    // 再切一次应该绕回第一路
    const r2 = await ev('window.wp.invokeHotkey("cycleMonitor")');
    check('再按一次绕回第 1 路', r2.target === A, `${stripId(r1.target)} → ${stripId(r2.target)}`);
    const back = await waitUntil(async () => ((await previewIdOf()) === A ? true : null), { timeout: 4000 });
    check('界面跟着绕回来', Boolean(back), `renderer.previewId = ${stripId(await previewIdOf())}`);

    // 主进程与渲染层必须始终是同一个值 —— 漂移了就会出现「热键作用在 A 屏、界面在看 B 屏」
    const t3 = (await ev('window.wp.invokeHotkey("cycleMonitor")')).target;
    await sleep(500);
    check('主进程目标与渲染层预览始终一致', t3 === (await previewIdOf()),
      `主进程 ${stripId(t3)} vs 渲染层 ${stripId(await previewIdOf())}`);

    /* ------------------------------------------------ 3. 后续热键的目标跟着走 */

    section('3. 切完之后，其余热键作用在新那块屏上');

    await switchPreviewTo(A);
    await ev('window.wp.invokeHotkey("cycleMonitor")');     // 切到 B
    await waitUntil(async () => ((await previewIdOf()) === B ? true : null), { timeout: 4000 });

    const aIdxBefore = (await channelById(A)).index;
    const bIdxBefore = (await channelById(B)).index;

    const nextTarget = (await ev('window.wp.invokeHotkey("next")')).target;
    check('「下一张」的目标就是新那块屏', nextTarget === B, `${stripId(nextTarget)}`);

    const moved = await waitUntil(async () => {
      const b = await channelById(B);
      return b && b.index !== bIdxBefore ? b : null;
    }, { timeout: 5000 });
    check('被推进的是新那块屏', Boolean(moved), `B.index ${bIdxBefore} → ${moved && moved.index}`);
    check('原来那块屏一张没动', (await channelById(A)).index === aIdxBefore,
      `A.index = ${(await channelById(A)).index}（期望 ${aIdxBefore}）`);

    /* ------------------------------------------------ 4. 只有一路时切不动 */

    section('4. 统一模式（只有一路）时不会乱切');

    await ev('window.wp.setConfig({ perMonitor: false, applyToSystem: false })');
    await ev('window.wp.rebuildChannels(true)');
    await sleep(1800);

    const oneIds = await channelIds();
    check('切回统一模式只剩一路', oneIds.length === 1, `${oneIds.length} 路`);

    if (oneIds.length === 1) {
      await waitUntil(async () => ((await previewIdOf()) === oneIds[0] ? true : null), { timeout: 3000 });
      const beforeOne = await previewIdOf();
      const rOne = await ev('window.wp.invokeHotkey("cycleMonitor")');
      check('单路时动作不抛错', rOne.ok === true, JSON.stringify(rOne));
      check('单路时目标没变', rOne.target === beforeOne, `${stripId(rOne.target)}`);
      await sleep(400);
      check('单路时界面也没动', (await previewIdOf()) === beforeOne);
    }

    /* ------------------------------------------------ 5. 真往系统里按一次键 */

    section('5. 真按一次 Ctrl+Alt+F10（窗口藏在托盘里的情况下）');

    await ev('window.wp.setConfig({ perMonitor: true, applyToSystem: false })');
    await ev('window.wp.rebuildChannels(true)');
    await sleep(1800);

    const kbOk = keyboardDriver.available();
    if (!kbOk) {
      skip('真实按键注入', 'koffi 加载 user32 失败');
    } else if ((await channelIds()).length < 2) {
      skip('真实按键注入', '频道不足两路');
    } else {
      await switchPreviewTo(A);
      const beforeKey = await previewIdOf();

      await ev('window.wp.hideWindow()');
      await sleep(900);
      check('窗口已隐藏（热键要在没有窗口的情况下照样生效）',
        !dialogDriver.isAppWindowVisible(), 'IsWindowVisible 仍为真');

      keyboardDriver.combo(TEST_KEYS);
      const switched = await waitUntil(async () => ((await previewIdOf()) !== beforeKey ? true : null), { timeout: 5000 });
      check('窗口隐藏时按 Ctrl+Alt+F10 仍然换了目标', Boolean(switched),
        `${stripId(beforeKey)} → ${stripId(await previewIdOf())}`);
      check('换到的是另一路（不是原地打转）', (await previewIdOf()) !== beforeKey);

      const targetAfterKey = (await ev('window.wp.invokeHotkey("cycleMonitor")')).target;
      await sleep(400);
      check('按键之后两个视角仍然一致', targetAfterKey === (await previewIdOf()),
        `主进程 ${stripId(targetAfterKey)} vs 渲染层 ${stripId(await previewIdOf())}`);

      await ev('window.wp.showWindow()');
      await sleep(800);
      check('窗口能重新显示出来', dialogDriver.isAppWindowVisible());
    }

    /* ------------------------------------------------ 6. 真写一遍：落到那块屏上 */

    section('6. 打开写入后：切到 B 再下一张，只有 B 屏跟着变');

    // 先存档两屏当前壁纸（系统侧的真实值，不是应用自己记的）
    const wallpaperBackup = osMonitors().map((m) => ({ device: m.id, current: m.current }));
    console.log(`      壁纸存档：${wallpaperBackup.map((w) => path.basename(w.current || '（无）')).join(' / ')}`);

    await ev('window.wp.setConfig({ perMonitor: true, applyToSystem: true, applyOnStart: false })');
    await ev('window.wp.rebuildChannels(true)');
    await sleep(1600);

    const ids6 = await channelIds();
    if (ids6.length < 2) {
      skip('第 6 节', '频道不足两路');
    } else {
      const A6 = ids6[0];
      const B6 = ids6[1];

      // 让两屏各自立刻写上自己那一路的当前帧（rebuild 的 takeover 只在启动那一次做）
      await ev(`window.wp.applyChannel(${JSON.stringify(A6)})`);
      await ev(`window.wp.applyChannel(${JSON.stringify(B6)})`);
      await sleep(2200);

      const a = await channelById(A6);
      const b = await channelById(B6);
      check('A 屏写上了 A 频道当前的这一张',
        path.basename(osCurrentOf(A6) || '') === path.basename(a.current || ''),
        `${path.basename(osCurrentOf(A6) || '')} vs ${path.basename(a.current || '')}`);
      check('B 屏写上了 B 频道当前的这一张',
        path.basename(osCurrentOf(B6) || '') === path.basename(b.current || ''),
        `${path.basename(osCurrentOf(B6) || '')} vs ${path.basename(b.current || '')}`);

      // 切到 B，再按「下一张」
      const atB6 = await switchPreviewTo(B6);
      check('已把操作目标切到 B 屏', atB6, `${stripId(await previewIdOf())}`);

      const aIdx = (await channelById(A6)).index;
      const bIdx = (await channelById(B6)).index;
      const aWall = osCurrentOf(A6);

      await ev('window.wp.invokeHotkey("next")');
      const written = await waitUntil(async () => {
        const ch = await channelById(B6);
        return ch && ch.index !== bIdx ? ch : null;
      }, { timeout: 5000 });
      check('B 频道推进了一张', Boolean(written), `B.index ${bIdx} → ${written && written.index}`);

      const bWall = await waitUntil(async () => {
        const cur = osCurrentOf(B6);
        const ch = await channelById(B6);
        return cur && ch && path.basename(cur) === path.basename(ch.current || '') ? cur : null;
      }, { timeout: 6000 });
      check('B 屏真的换成了新那张（OS 侧回读）', Boolean(bWall),
        `${path.basename(osCurrentOf(B6) || '')} vs ${path.basename((await channelById(B6)).current || '')}`);
      check('A 屏一动没动（热键没有误伤另一块屏）',
        osCurrentOf(A6) === aWall && (await channelById(A6)).index === aIdx,
        `${path.basename(osCurrentOf(A6) || '')} / A.index=${(await channelById(A6)).index}`);
    }

    /* ------------------------------------------------ 收尾：别把测试图留在桌面 */

    await ev('window.wp.setConfig({ applyToSystem: false })');
    await sleep(700);
    for (const w of wallpaperBackup) {
      if (w.device && w.current && fs.existsSync(w.current)) {
        desktopWallpaper.setWallpaper(w.device, w.current);
      }
    }
    await sleep(2000);

    const leaked = osMonitors().filter((m) => /tools[\\/]tmp[\\/]/i.test(String(m.current || '')));
    check('桌面上没有留下测试图', leaked.length === 0,
      leaked.length ? leaked.map((m) => m.current).join(' , ') : '两屏都已回到测试前的壁纸');
  }

  /* -------------------------------------------------- 7. 还原配置 */

  section('7. 还原配置');

  const restored = await testConfig.restore(ev);
  await sleep(1200);
  check('已从基线快照还原配置', restored.ok, restored.ok ? restored.actual.folder : restored.error);
  check('还原后与还原点逐键一致（没有「还原了但没完全还原」）',
    Boolean(restored.ok) && restored.diff.length === 0,
    restored.ok ? (restored.diff.length ? restored.diff.slice(0, 5).join(' ; ') : '逐键比对无差异') : '');
  check('还原后配置不指向测试素材',
    Boolean(restored.ok) && !testConfig.looksLikeTestData(restored.actual.folder),
    restored.ok ? String(restored.actual.folder) : '');

  const endCfg = await ev('window.wp.getConfig()');
  check('切屏热键没有以测试值残留',
    !endCfg.hotkeys || endCfg.hotkeys.cycleMonitor !== TEST_ACCEL,
    `cycleMonitor=${JSON.stringify(endCfg.hotkeys && endCfg.hotkeys.cycleMonitor)}`);

  /* -------------------------------------------------- 汇总 */

  console.log(`\n${'='.repeat(52)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项${skipped ? `，跳过 ${skipped} 项` : ''}`);
  if (failures.length) console.log(`失败项：\n  - ${failures.join('\n  - ')}`);
  console.log('='.repeat(52));

  cdp.close();
  desktopWallpaper.release();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error('\n脚本异常：', err.message);
  try { desktopWallpaper.release(); } catch { /* 忽略 */ }
  process.exitCode = 2;
});

/**
 * MONITOR 设备路径长得离谱，而且两块屏只有中段不同：
 *   \\?\DISPLAY#AAAA1234#5&000000&0&UID00000#{xxxxxxxx-…}
 *   \\?\DISPLAY#BBBB5678#5&000000&0&UID00001#{xxxxxxxx-…}
 * 简单掐头留尾（只留最后 34 字符）会把两块屏显示成同一个字符串，
 * 日志里就变成「A → A」，看不出到底切了没有。抓中段的型号 + UID 才有诊断价值。
 */
function stripId(id) {
  if (!id) return '(空)';
  const s = String(id);
  if (s === '__unified__') return '全部显示器';
  const m = s.match(/DISPLAY#([^#]+)#.*?UID(\d+)/i);
  if (m) return `${m[1]}·UID${m[2]}`;
  return s.length > 34 ? `…${s.slice(-34)}` : s;
}
