'use strict';

/**
 * 动态桌面窗口层：每路频道一块「挂到桌面图标下面」的常驻渲染窗口。
 *
 * 与 desktopHost.js 的分工：desktopHost 管「怎么挂」（Win32 调用 + 挂载点判定），
 * 这里管「挂什么」（Electron 窗口生命周期、频道→窗口映射、看门狗、事件广播）。
 *
 * ---------------------------------------------------------------------------
 * 窗口模型
 * ---------------------------------------------------------------------------
 *   频道（perMonitor 模式下每台显示器一路） → 一块 stage 窗口 → 挂到
 *   持有 SHELLDLL_DefView 的窗口（本机 = Progman，见 desktopHost.js 头注释）。
 *   unified 频道（monitorId=null）展开成每块显示器一块伪舞台，同步播同一张
 *   （r23 起；此前「阶段 2 再接」实际从未接 → 切统一配置舞台全灭）。
 *
 * ---------------------------------------------------------------------------
 * 三条实测结论铸成的规矩（任务书 §2.13~§2.16）
 * ---------------------------------------------------------------------------
 *   1. 先进入 raised-desktop，再使用 chooseMountParent() 选出图标层下方的全屏 WorkerW；
 *   2. 舞台做 WorkerW 的子窗口，图标层与舞台不再是同级争抢 Z 序；
 *   3. Explorer 重启后父句柄失效 → 窗口变孤儿（盖住图标、Alt+Tab 没有）。
 *      处理：先 hide 再重挂再 showInactive，全程不抢焦点。
 *
 * 所有动画在 stage.js（渲染层）；这里 backgroundThrottling:false，
 * 因为挂到桌面后 Chromium 可能把窗口当「不可见」而降帧 —— 那就全完了。
 */

const { BrowserWindow, screen } = require('electron');
const path = require('node:path');
const desktopHost = require('./desktopHost');
const debugLog = require('./debugLog');
const swipeWatch = require('./swipeWatch');

const WATCHDOG_MS = 2000;
/** 连续重挂失败多少次才算「降级」（交给系统壁纸兜底） */
const DEGRADED_AFTER = 3;

/** channelId → { win, hwnd, anchor, bounds, degraded, fails, creating } */
const stages = new Map();
/**
 * 期望频道表（syncTo 过滤后的 wanted 集）。Explorer 死亡时 Windows 会**连带销毁**
 * 挂在 Progman 下的子窗口 —— closed 事件随即把记录从 stages 删掉，看门狗的
 * 「重挂」路径救不了已销毁的窗口，只能按这张表**重建**（DoD③ 实测 2026-09-25）。
 */
const expectedChannels = new Map();
/** 每频道连续重建失败次数（超上限降级，防止 explorer 起不来时空转刷屏） */
const recreateFails = new Map();
let watchdogTimer = null;
let running = false;

/* ---------------------------------------------------------------- 工具 */

/** x64 下 getNativeWindowHandle 是 8 字节 Buffer（与 probe-attach.js 同款提取） */
function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length === 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

/**
 * 频道显示器 → Electron Display。
 * 频道里的 x/y/width/height 是 IDesktopWallpaper 的**物理像素**，而 Electron
 * 窗口的 bounds 用 **DIP**，两套坐标系不能直接混用（§2.4）。按
 * 「物理尺寸 = DIP × scaleFactor」做几何匹配，不依赖 devicePath（Electron 不给）。
 */
function displayForMonitor(m) {
  const all = screen.getAllDisplays();
  /*
   * 容差 ±2 物理像素，不能严格相等：非整数缩放下 DIP×sf 会偏零点几像素
   * （本机竖屏 1600×2560 @150% ⇒ 1067×1707 DIP ⇒ 1600.5×2560.5 物理），
   * 严格相等必失配 ⇒ 回落主屏 ⇒ 两块舞台叠在同一屏互相 z-fight
   * （e2e 实测：看门狗日志每 2s 刷一轮「Z 序被挤掉」）。
   */
  const near = (a, b) => Math.abs(a - b) <= 2;
  const bySize = all.filter((d) => near(d.bounds.width * d.scaleFactor, m.width)
    && near(d.bounds.height * d.scaleFactor, m.height));
  if (bySize.length === 1) return bySize[0];
  if (bySize.length > 1) return bySize.find((d) => d.primary) || bySize[0];
  return all.find((d) => d.primary) || screen.getPrimaryDisplay();
}

function stageBounds(ch) {
  const disp = displayForMonitor(ch.monitor || ch);
  const dip = {
    x: disp.bounds.x,
    y: disp.bounds.y,
    width: disp.bounds.width,
    height: disp.bounds.height,
  };
  // mount/SetWindowPos 要**虚拟桌面物理坐标**（内部再换算成父客户区相对，
  // 见 desktopHost.mount）；DIP×sf 在非整数缩放下可能差零点几像素，取整即可
  //（±1px，任务书 §2.4 已知）。而 BrowserWindow 的 setBounds 仍然用 DIP。
  const sf = disp.scaleFactor || 1;
  const phys = {
    x: Math.round(dip.x * sf),
    y: Math.round(dip.y * sf),
    w: Math.round(dip.width * sf),
    h: Math.round(dip.height * sf),
  };
  // displayId 也要带出去：全屏暂停按「显示器」算（fullscreenWatch 的判定单位
  // 是 Electron display），stage 窗口必须知道自己挂在哪块屏才知道听不听暂停
  return { dip, phys, displayId: disp.id };
}

/**
 * 直接从 Electron Display 算舞台 bounds（统一频道的每屏伪舞台用）：
 * 统一频道没有 monitor 几何（width=0），走不了 displayForMonitor 的尺寸匹配，
 * 但我们手里本来就攥着 Electron Display，直接用，连匹配都省了。
 */
function stageBoundsFromDisplay(disp) {
  const dip = { x: disp.bounds.x, y: disp.bounds.y, width: disp.bounds.width, height: disp.bounds.height };
  const sf = disp.scaleFactor || 1;
  const phys = {
    x: Math.round(dip.x * sf),
    y: Math.round(dip.y * sf),
    w: Math.round(dip.width * sf),
    h: Math.round(dip.height * sf),
  };
  return { dip, phys, displayId: disp.id };
}

/* ---------------------------------------------------------------- 暂停状态 */

/**
 * 全屏 / 挂机暂停（阶段 3）。fullscreenWatch 按显示器算出暂停集合，
 * 这里负责翻译成「每块 stage 冻不冻」并广播。
 * 语义（拍板）：全停 —— 冻结 = 渲染层停 rAF（含 Ken Burns），停在当前帧；
 * 不卸载、不黑屏，恢复即续播。调度器照常走针，暂停中的舞台跳过新帧。
 */
const pauseDisplays = new Set();
let pauseAway = false;

/**
 * 暂停时把舞台窗口整个藏起来（主树 52 轮，live r20 移植；默认关）：
 * 深暂停只停 rAF，窗口还攥着 4K flip 交换链 —— 独占全屏游戏做模式切换时
 * 撞上它会驱动挂死（艾尔登法环实锤）。藏掉 = 交换链离开显示路径。
 * 恢复用 showInactive（与挂载同一条已验证路径），画面留在原帧不重载。
 */
let pauseHide = false;

function setPauseHide(value) {
  pauseHide = value === true;
}

function applyPauseState({ pausedIds, away, reasons } = {}) {
  pauseDisplays.clear();
  for (const id of Array.isArray(pausedIds) ? pausedIds : []) pauseDisplays.add(id);
  pauseAway = Boolean(away);
  for (const [id, rec] of stages) {
    if (rec.win && !rec.win.isDestroyed()) {
      try {
        const paused = pauseDisplays.has(rec.displayId);
        rec.win.webContents.send('stage:pause', { paused });
        // hideOnPaused：暂停藏窗（交换链离开显示路径），恢复原帧续播不重载
        if (pauseHide) {
          if (paused) {
            if (rec.win.isVisible()) { rec.win.hide(); rec.hiddenForPause = true; }
          } else if (rec.hiddenForPause) {
            rec.hiddenForPause = false;
            rec.win.showInactive();   // 不抢焦点（与挂载同款纪律）
          }
        }
      } catch { /* 窗口正在销毁 */ }
    }
  }
  // 诊断：暂停集 vs 每块舞台实际挂的 displayId —— 两者对不上就是「点了暂停
  // 舞台照转」的实锤（2026-10-09 用户报暂停无效，日志里暂停集正常但看不到
  // 舞台侧是否命中，把这层照亮）。
  const stageIds = [...new Set([...stages.values()].map((r) => r.displayId).filter((id) => id != null))];
  if (pauseDisplays.size || pauseAway) {
    console.log(`[live-stage] 暂停：display=[${[...pauseDisplays]}] away=${pauseAway}`,
      Object.keys(reasons || {}).length ? JSON.stringify(reasons) : '');
    debugLog.dlog('pause', `暂停 display=[${[...pauseDisplays]}] away=${pauseAway} ` +
      `stages=[${stageIds.join(',')}] 命中=[${[...stages.values()].map((r) => pauseDisplays.has(r.displayId)).join(',')}] ` +
      `${JSON.stringify(reasons || {})}`);
  } else {
    console.log('[live-stage] 暂停解除：全部舞台恢复');
    debugLog.dlog('pause', `暂停解除：全部舞台恢复 stages=[${stageIds.join(',')}]`);
  }
}

function isPausedForDisplay(displayId) {
  return pauseDisplays.has(displayId);
}

/*
 * 暂停集合的统一口径是 **Electron displayId**（fullscreenWatch 的 pausedIds 就是它）。
 * 但频道 id 是 IDesktopWallpaper 设备路径 —— 两套体系直接互查永远 false
 * （2026-10-09 实锤：手动暂停把设备路径塞进暂停集，舞台照转；调度器侧同理，
 * 第十四轮的 isPaused 感知实际从未命中）。下面三个查询给 main.js 做换算用。
 */

/** IDesktopWallpaper 显示器描述（含物理矩形）→ Electron displayId；匹配不上返回 null */
function displayIdForMonitor(m) {
  const d = displayForMonitor(m || {});
  return d ? d.id : null;
}

/** 当前所有舞台挂着的 Electron displayId（去重） */
function allDisplayIds() {
  return [...new Set([...stages.values()].map((r) => r.displayId).filter((id) => id != null))];
}

/** 任一舞台处于暂停 = 统一频道（unified）也要停轮播 */
function anyDisplayPaused() {
  return pauseDisplays.size > 0;
}

/* ---------------------------------------------------------------- 广播 */

function broadcast(type, payload) {
  let sent = 0;
  for (const st of stages.values()) {
    if (st.win && !st.win.isDestroyed()) {
      try { st.win.webContents.send(type, payload); sent += 1; } catch { /* 窗口正在销毁 */ }
    }
  }
  if (!broadcast._logged) broadcast._logged = true;
  if (type === 'channel:tick') {
    const key = '_tickLogged';
    if (!broadcast[key]) {
      broadcast[key] = true;
      console.log(`[live-stage] 首次 tick 广播: 舞台数=${stages.size} 实发=${sent}`);
    }
  }
  return sent;
}

/* ---------------------------------------------------------------- 预创建暖窗 */

/**
 * 冷开机提速（第七十八轮，2026-10-17 真机时间线）：rebuild 完成后 syncTo 才建
 * 舞台窗口，Chromium 冷加载 stage.html 再花 ~6.5s —— 壁纸首帧被推到启动后 ~13s。
 * prewarm() 在启动时并行调用（先于 rebuild）：先给每块显示器建好隐藏舞台窗口
 * 并加载页面，让「页面加载」与「扫描 / 深度引擎探测」重叠；createStage 挂载时
 * 直接收养（按 Electron displayId 匹配），零加载等待。
 */
const warmWindows = new Map();      // displayId -> { win, displayId, at, loaded }
const WARM_WINDOW_TTL_MS = 60000;   // 60s 没被收养（频道拓扑没覆盖那块屏）→ 看门狗销毁

/** 统一建窗入口：同参数、同「show:false」纪律；console-message 转发在建窗时挂一次
 *  （createStage 不再重复挂，收养/新建两条路都带） */
function spawnStageWindow(b) {
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    show: false,                       // 挂载成功前绝不出现（§2.7：show 会抢焦点，挂载后用 showInactive）
    frame: false,
    backgroundColor: '#000000',
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,                  // 不进焦点链；挂载时还会补 WS_EX_NOACTIVATE 双保险
    enableLargerThanScreen: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,                  // 与主窗口一致（preload 需要 require）
      backgroundThrottling: false,     // 关键：别让 Chromium 把「桌面」降帧
    },
  });
  win.webContents.on('console-message', (_e, _lvl, message, line, source) => {
    console.log(`[stage-render] ${message} (${source}:${line})`);
  });
  return win;
}

/** createStage 收养预创建窗口（按 Electron displayId 匹配）；没有返回 null */
function takeWarmWindow(displayId) {
  const w = warmWindows.get(displayId);
  if (!w) return null;
  warmWindows.delete(displayId);
  return w;
}

async function prewarm() {
  if (!running || warmWindows.size || stages.size) return;   // 只认「启动空白窗」场景
  for (const d of screen.getAllDisplays()) {
    if (!running) return;
    const sb = stageBoundsFromDisplay(d);
    const win = spawnStageWindow(sb.dip);
    const loaded = win.loadFile(path.join(__dirname, 'renderer', 'stage.html'));
    warmWindows.set(d.id, { win, displayId: d.id, at: Date.now(), loaded });
    try { await loaded; } catch (err) {
      // 加载失败（stop 销毁窗口等）：丢弃暖窗，createStage 回落新建
      warmWindows.delete(d.id);
      try { win.destroy(); } catch { /* 已销毁 */ }
      debugLog.dlog('live-stage', `预创建窗口加载失败（display=${d.id}）：${err.message}`);
    }
  }
}

async function createStage(ch) {
  const rec = { win: null, hwnd: 0, anchor: null, bounds: null, boundsPhys: null, degraded: false, fails: 0, creating: true };
  stages.set(ch.id, rec);
  try {
    // 统一频道的每屏伪舞台直接带 Electron Display（ch._display），不用再几何匹配
    const sb = ch._display ? stageBoundsFromDisplay(ch._display) : stageBounds(ch);
    const b = sb.dip;
    rec.bounds = b;
    rec.boundsPhys = sb.phys;
    // ⚠️ displayId 必须写入 rec —— applyPauseState / isChannelFrozen 都用
    // rec.displayId 对号入座，漏写的话拿到的是 undefined，pauseDisplays.has
    // (undefined) 恒 false：**任何暂停（全屏/挂机/手动）在舞台层都永不生效**。
    // 这正是 49 轮实锤修过的断点（0f4e8ba），10-09 重建 live 树时弄丢了，
    // 2026-10-09 用户再报「桌面暂停没用」才重新抓到（诊断日志 stages=[] 命中=[false,false]）。
    rec.displayId = sb.displayId;
    // 第七十八轮：优先收养 prewarm 的预创建窗口（页面已在加载/加载完），
    // 省掉 ~6.5s 冷加载；没有暖窗（拓扑变化等）照旧新建
    const warm = takeWarmWindow(sb.displayId);
    let win;
    if (warm) {
      await warm.loaded;               // 等页面加载完（通常已完成）
      win = warm.win;
      rec.preloaded = true;
      debugLog.dlog('live-stage', `频道 ${ch.id} 收养预创建暖窗（display=${sb.displayId}）`);
    } else {
      win = spawnStageWindow(sb.dip);
    }
    win.setMenuBarVisibility(false);
    rec.win = win;

    win.on('closed', () => { if (stages.get(ch.id) === rec) stages.delete(ch.id); });
    // 渲染进程崩了（GPU 驱动复位之类）→ 重载页面；窗口与挂载都还在
    win.webContents.on('render-process-gone', () => {
      if (running && rec.win && !rec.win.isDestroyed()) rec.win.webContents.reload();
    });
    // 渲染端 console 转发已在 spawnStageWindow 里挂好（新建/收养两路一致）

    if (!rec.preloaded) await win.loadFile(path.join(__dirname, 'renderer', 'stage.html'));
    if (!running || rec.retired) { win.destroy(); return; }

    // 先让 Windows 11 24H2+ 进入 raised-desktop，保证存在图标层下方的 WorkerW。
    // 每次创建都重新 snapshot：Explorer 可能重启过，所有句柄都会变。
    const raised = desktopHost.raiseDesktop();
    if (!raised.ok) throw new Error(`raised-desktop 初始化失败：${raised.error}`);
    const snap = desktopHost.snapshot({});
    const choice = desktopHost.chooseMountParent(snap);
    if (!choice.ok) throw new Error(`挂载点判定失败：${choice.reason}`);
    rec.anchor = {
      parentHwnd: choice.parentHwnd,
      insertAfterHwnd: choice.insertAfterHwnd,
      zOrderManaged: choice.zOrderManaged !== false,
      strategy: choice.strategy,
    };

    rec.hwnd = hwndOf(win);
    const m = desktopHost.mount(rec.hwnd, choice.parentHwnd, choice.insertAfterHwnd, rec.boundsPhys);
    if (!m.ok) throw new Error(`挂载失败 @${m.step}: ${m.error}`);

    win.showInactive();                // 不抢焦点
    rec.fails = 0;
    rec.degraded = false;
    recreateFails.delete(ch.id);       // 挂载成功 → 重建失败计数清零
    // bind 带上初始暂停态：轮询事件只在「变化」时发，晚创建的窗口若只等
    // 事件会错过当前状态（zm 的 get_wallpaper_media 补拉同款问题）
    win.webContents.send('stage:bind', {
      // 统一频道的每屏伪舞台（id=`__unified__#displayId`）必须认领**逻辑频道 id**
      // —— 渲染端按 payload.id !== myChannel 过滤 tick，认领了伪 id 就一口都吃不到
      channelId: ch.channelId || ch.id,
      monitorId: ch.monitorId,
      paused: isPausedForDisplay(sb.displayId),
    });
    console.log(`[live-stage] 频道 ${ch.id} 的舞台已挂载（strategy=${choice.strategy}）`);
  } catch (err) {
    console.error('[live-stage] 创建失败:', err.message);
    rec.fails = (rec.fails || 0) + 1;
    rec.degraded = rec.fails >= DEGRADED_AFTER;
    if (rec.win && !rec.win.isDestroyed()) rec.win.destroy();
    stages.delete(ch.id);
  } finally {
    rec.creating = false;
  }
}

function destroyStage(id) {
  const rec = stages.get(id);
  if (!rec) return;
  stages.delete(id);
  try {
    if (rec.hwnd) desktopHost.unmount(rec.hwnd);   // 先脱离桌面树，窗口销毁时不留残影
  } catch { /* koffi 不可用时窗口销毁同样会移除窗口本身 */ }
  if (rec.win && !rec.win.isDestroyed()) rec.win.destroy();
}

/*
 * 拓扑变化后的全量重建（2026-10-13 主屏舞台半屏透明的修复）。
 *
 * 为什么不能只重新对齐 bounds：主屏在虚拟桌面原点，挪副屏**不会改变主屏的
 * 任何几何**，per-display 伪舞台的 displayId 也不变 —— syncTo 的复用分支
 * （!stages.has(key) 才建）于是永远复用旧窗口。但 Chromium 的渲染输出状态
 * （DirectComposition 视觉 / 交换链）会随显示器拓扑事件滞留过期坐标 ——
 * 窗口 rect 全对（探针取证过）、渲染内容却错位/半透明，CefSharp#5174 同族。
 * 副屏为什么没事：副屏 bounds 变了走 setBounds 重对齐，顺带刺激 Chromium
 * 重新评估几何；主屏什么都没变、什么都没触发，就带着污染状态继续跑。
 *
 * 销毁重建是唯一可靠的清零手段：新窗口 = 新渲染进程 = 全新合成器状态。
 * 重建由 syncTo（调用方紧跟）或 2s 看门狗（watchOnce）补上。
 */
function recreateAll(reason = 'topology') {
  if (!running) return 0;
  let n = 0;
  for (const [id, rec] of [...stages]) {
    rec.retired = true;   // createStage 在途的加载完成后看到标记即自毁，防止僵尸挂载
    destroyStage(id);
    n++;
  }
  debugLog.dlog('live-stage', `全量重建舞台（${reason}）：销毁 ${n} 块，等 syncTo/看门狗重建`);
  return n;
}

/* ---------------------------------------------------------------- 鼠标跟随喂送 */

/*
 * 为什么要主进程喂光标（2026-10-13 实锤）：
 *   舞台渲染端的深度视差接管 / 鼠标平移裁切（cropPan）靠的是舞台窗口自己收到
 *   原生 mousemove。旧挂载（Progman 置顶，舞台在图标层上方）天然吃得到；
 *   2beea28 换成 raised-WorkerW 挂载（舞台在图标层下方，修 Win10 图标被盖）
 *   之后，桌面空白点的命中测试归 SHELLDLL_DefView（WindowFromPoint 实测命中
 *   DefView 而非舞台）—— 输入被图标层截走，舞台一个 mousemove 都收不到，
 *   视差接管和平移裁切一起哑火（画面照常，只是不再跟鼠标）。
 *
 *   修法不回退挂载架构，改走主进程轮询喂送：GetCursorPos(30Hz) + 桌面本体
 *   判定（根窗口类 = Progman/WorkerW，复用 swipeWatch.isDesktopPoint —— 光标
 *   悬在应用窗口/任务栏上时舞台不响应，与旧 hit-test 语义一致）→ 换算成目标
 *   舞台的归一化坐标与 CSS 像素 → IPC 给那块屏的 stage 渲染端。渲染端把值
 *   喂进 glState.mouse/mouseUntil 与粒子层，语义与原生 mousemove 完全一致。
 *   只在位置变化时发送，停手 2.5s 后接管自然过期（渲染端既有逻辑）。
 */

const MOUSE_FEED_MS = 33;               // 30Hz：视差接管够顺滑，IPC 开销可忽略
let mouseTimer = null;
let lastMousePt = null;

function mouseFeedTick() {
  const pt = swipeWatch.cursorPoint();
  if (!pt) return;
  if (lastMousePt && lastMousePt.x === pt.x && lastMousePt.y === pt.y) return;
  lastMousePt = { x: pt.x, y: pt.y };
  // 光标必须悬在桌面本体上（Progman/WorkerW 根）：悬在应用窗口上时舞台不动，
  // 与旧挂载「只有命中舞台窗口才有 mousemove」的语义对齐
  if (!swipeWatch.isDesktopPoint(pt)) return;
  for (const rec of stages.values()) {
    if (!rec.win || rec.win.isDestroyed() || !rec.boundsPhys || !rec.bounds) continue;
    const b = rec.boundsPhys;
    if (pt.x < b.x || pt.x >= b.x + b.w || pt.y < b.y || pt.y >= b.y + b.h) continue;
    const nx = ((pt.x - b.x) / Math.max(1, b.w)) * 2 - 1;
    const ny = ((pt.y - b.y) / Math.max(1, b.h)) * 2 - 1;
    // CSS 像素 = 物理像素 ÷ 缩放（bounds 是 DIP、boundsPhys 是物理，比值即 scaleFactor）
    const scale = Math.max(0.1, b.w / Math.max(1, rec.bounds.width));
    rec.win.webContents.send('stage:mouse', {
      nx, ny,
      x: (pt.x - b.x) / scale,
      y: (pt.y - b.y) / scale,
    });
  }
}

function startMouseFeed() {
  if (mouseTimer) return;
  lastMousePt = null;
  mouseTimer = setInterval(mouseFeedTick, MOUSE_FEED_MS);
}

function stopMouseFeed() {
  if (mouseTimer) { clearInterval(mouseTimer); mouseTimer = null; }
  lastMousePt = null;
}

/* ---------------------------------------------------------------- 看门狗 */

function watchOnce() {
  // 第七十八轮：没被收养的预创建窗口超过 TTL → 销毁（频道拓扑没覆盖那块屏时防僵尸）
  for (const [id, w] of warmWindows) {
    if (Date.now() - w.at > WARM_WINDOW_TTL_MS) {
      warmWindows.delete(id);
      try { w.win.destroy(); } catch { /* 已销毁 */ }
      debugLog.dlog('live-stage', `预创建窗口超 TTL 未收养，销毁（display=${id}）`);
    }
  }
  // ── 对账：期望频道还在、舞台记录没了 = 窗口本体被外部销毁（Explorer 死亡
  //    连带销毁 Progman 子窗口）。重挂路径救不了已销毁的窗口，直接重建。
  if (running) {
    for (const [id, ch] of expectedChannels) {
      if (stages.has(id)) continue;
      const fails = (recreateFails.get(id) || 0) + 1;
      recreateFails.set(id, fails);
      if (fails <= DEGRADED_AFTER) {
        console.log(`[live-stage] ${id} 舞台窗口丢失（父窗口被销毁/Explorer 重启），重建第 ${fails} 次`);
        createStage(ch);   // 异步；creating 标记防重复
      } else if (fails === DEGRADED_AFTER + 1) {
        console.warn(`[live-stage] ${id} 连续重建失败 ${fails} 次，降级（系统壁纸兜底）`);
      }
    }
  }

  for (const [id, rec] of stages) {
    try {
      if (!rec.hwnd || !rec.anchor) continue;
      const a = desktopHost.assertMount(rec.hwnd, rec.anchor.parentHwnd, rec.anchor.insertAfterHwnd);

      if (!a.alive || !a.parentAlive || a.orphan) {
        // Explorer 重启 / 父句柄失效：窗口变孤儿（盖住图标、Alt+Tab 没有）。
        // 先隐藏再重挂（§2.6）—— 重挂过程中窗口不能以顶层形态闪现在桌面上。
        rec.fails += 1;
        if (rec.win && !rec.win.isDestroyed()) {
          rec.win.hide();
          const raised = desktopHost.raiseDesktop();
          if (!raised.ok) throw new Error(`raised-desktop 重建失败：${raised.error}`);
          const snap = desktopHost.snapshot({});
          const choice = desktopHost.chooseMountParent(snap);
          if (choice.ok) {
            rec.anchor = {
              parentHwnd: choice.parentHwnd,
              insertAfterHwnd: choice.insertAfterHwnd,
              zOrderManaged: choice.zOrderManaged !== false,
              strategy: choice.strategy,
            };
            // ⚠️ mount 要的是**物理坐标**（boundsPhys），之前误传 DIP 的 rec.bounds，
            //    多屏/高 DPI 下重挂位置会错（2026-09-25 复查时抓出）
            const m = desktopHost.mount(rec.hwnd, choice.parentHwnd, choice.insertAfterHwnd, rec.boundsPhys || {
              x: rec.bounds.x, y: rec.bounds.y, w: rec.bounds.width, h: rec.bounds.height,
            });
            if (m.ok) {
              rec.win.showInactive();
              rec.fails = 0;
              console.log(`[live-stage] ${id} 重挂成功（Explorer 重启后）`);
            }
          }
        }
        rec.degraded = rec.fails >= DEGRADED_AFTER;
        continue;
      }

      // 旧 Progman 兼容路径才需要维护与 DefView 的同级 Z 序。raised WorkerW 路径
      // 里舞台是 WorkerW 的子窗口，图标层在父层上方，不参与这段同级判定。
      // 兄弟舞台（其它屏的窗口）不算外人，否则多屏下互相误报、看门狗无限打架。
      const others = new Set();
      for (const [otherId, otherRec] of stages) {
        if (otherId !== id && otherRec.hwnd) others.add(otherRec.hwnd);
      }
      if (rec.anchor.zOrderManaged !== false
        && !desktopHost.isZOrderIntact(rec.hwnd, rec.anchor.insertAfterHwnd, others)) {
        const r = desktopHost.reaffirmZOrder(rec.hwnd, rec.anchor.insertAfterHwnd, rec.boundsPhys);
        if (r.ok) console.log(`[live-stage] ${id} Z 序被挤掉，已重申恢复`);
      }
      rec.fails = 0;
      rec.degraded = false;
    } catch (err) {
      console.warn('[live-stage] 看门狗一轮失败:', err.message);
      rec.degraded = true;
    }
  }
}

/* ---------------------------------------------------------------- 对外接口 */

function start() {
  if (running) return;
  running = true;
  if (!watchdogTimer) watchdogTimer = setInterval(watchOnce, WATCHDOG_MS);
  startMouseFeed();
  console.log('[live-stage] 动态桌面已启动');
}

function stop() {
  running = false;
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  stopMouseFeed();
  expectedChannels.clear();
  recreateFails.clear();
  for (const [, w] of warmWindows) { try { w.win.destroy(); } catch { /* 已销毁 */ } }
  warmWindows.clear();
  for (const id of [...stages.keys()]) destroyStage(id);
  console.log('[live-stage] 动态桌面已停止');
}

/**
 * 频道列表 → stage 窗口增删（channels:changed / 启动时调用）。
 * 统一频道（monitorId=null、width=0 的伪频道）展开成**每块显示器一块舞台**，
 * 全部认领同一条 channel:tick（r23 之前直接跳过 → 切回统一配置所有舞台被
 * 销毁又不建新的，用户实锤「轮播切统一模式，舞台就关闭了」）。
 */
function syncTo(channels) {
  if (!running) return;
  const wanted = new Set();
  for (const ch of Array.isArray(channels) ? channels : []) {
    /*
     * 不看 ch.enabled —— resolveProfile 把 applyToSystem 折进了 enabled
     * （store.js：enabled = Boolean(config.applyToSystem)），于是
     * 「动态桌面开 + 不写系统壁纸」（完全替代模式）下所有频道都是
     * enabled=false，若在这里跳过，舞台永远不会出现，模式直接失效。
     * 舞台只由 liveWallpaper 总开关控制（start 只在它为真时被调用）；
     * count=0（空相簿）照旧跳过。
     */
    if (!ch || ch.count === 0) { expectedChannels.delete(ch ? ch.id : ''); continue; }
    if (ch.width === 0) {
      /*
       * 统一频道 → 每块显示器一块伪舞台（key=`${频道id}#${displayId}`）。
       * 伪频道对象带 channelId（逻辑 id，bind 用）与 _display（Electron
       * Display，bounds/displayId 直接取，不走几何匹配）。tick 广播本来就
       * 发给所有舞台，渲染端按 channelId 认领 —— 多块屏同步播同一张，天然成立。
       */
      for (const disp of screen.getAllDisplays()) {
        const key = `${ch.id}#${disp.id}`;
        const pseudo = { ...ch, id: key, channelId: ch.id, _display: disp };
        wanted.add(key);
        expectedChannels.set(key, pseudo);
        if (!stages.has(key)) createStage(pseudo);   // 异步；creating 标记防重复
      }
      continue;
    }
    wanted.add(ch.id);
    expectedChannels.set(ch.id, ch);
    const existing = stages.get(ch.id);
    if (!existing && !stages.has(ch.id)) {
      createStage(ch);   // 异步；creating 标记防重复创建
    } else if (existing && !existing.creating && existing.bounds) {
      // 显示器配置可能变了 → 重新对齐 bounds（DIP 给 setBounds，物理给 reaffirm）
      const sb = stageBounds(ch);
      const b = sb.dip;
      if (b.x !== existing.bounds.x || b.y !== existing.bounds.y
        || b.width !== existing.bounds.width || b.height !== existing.bounds.height) {
        existing.bounds = b;
        existing.boundsPhys = sb.phys;
        if (existing.win && !existing.win.isDestroyed()) {
          existing.win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
          if (existing.hwnd) {
            desktopHost.reaffirmZOrder(existing.hwnd, existing.anchor.insertAfterHwnd, sb.phys);
          }
        }
      }
    }
  }
  for (const id of [...stages.keys()]) {
    if (!wanted.has(id)) destroyStage(id);
  }
  for (const id of [...expectedChannels.keys()]) {
    if (!wanted.has(id)) { expectedChannels.delete(id); recreateFails.delete(id); }
  }
}

/** 任何一路舞台降级中 = 让调度器恢复「每轮都写系统壁纸」的兜底 */
function isDegraded() {
  for (const rec of stages.values()) {
    if (rec.degraded) return true;
  }
  // 安全宿主不存在时 createStage 会销毁失败记录；这时也必须向调度器
  // 报降级，否则动态舞台没起来、系统壁纸又被错误停写，桌面会卡在旧图。
  for (const id of expectedChannels.keys()) {
    if (!stages.has(id) && (recreateFails.get(id) || 0) > DEGRADED_AFTER) return true;
  }
  return false;
}

/** 调试用：当前舞台状态摘要 */
function stats() {
  return {
    running,
    pausedDisplays: [...pauseDisplays],
    away: pauseAway,
    stages: [...stages.entries()].map(([id, rec]) => ({
      id,
      mounted: Boolean(rec.hwnd && rec.anchor),
      degraded: rec.degraded,
      fails: rec.fails,
      paused: pauseDisplays.has(rec.displayId),
      bounds: rec.bounds,
    })),
  };
}

/** 旧 Progman 置顶路径的桌面右键补偿。WorkerW 安全路径上舞台在图标层下方，
 *  不会收到 contextmenu；保留本通道是为了兼容旧系统/已存运行态。 */
function showDesktopContextMenu(dipX, dipY) {
  const rec = stages.values().next().value;
  const defViewHwnd = rec && rec.anchor && rec.anchor.insertAfterHwnd;
  if (!defViewHwnd) return { ok: false, error: '没有已挂载的舞台，拿不到 DefView 句柄' };
  const disp = screen.getDisplayNearestPoint({ x: Math.round(dipX), y: Math.round(dipY) });
  const sf = (disp && disp.scaleFactor) || 1;
  const r = desktopHost.postContextMenu(defViewHwnd, Math.round(dipX * sf), Math.round(dipY * sf));
  if (r && r.ok) beginMenuDismissWatch();
  return r;
}

/** 菜单解除看门狗：mousedown 链路被菜单的模态捕获拦住收不到（实测），
 *  改为主动轮询 —— GetAsyncKeyState/GetCursorPos 是全局状态，不受捕获影响。
 *  转发成功后启动；连续 3 秒见不到菜单就自停。 */
let dismissTimer = null;
let dismissLastSeen = 0;
let dismissTick = 0;
function beginMenuDismissWatch() {
  if (dismissTimer) return;
  dismissTick = 0;
  dismissLastSeen = 0;
  dismissTimer = setInterval(() => {
    dismissTick += 1;
    let st = null;
    try { st = desktopHost.dismissDesktopMenuIfClickOutside(); } catch (_) { st = null; }
    if (st && st.open) dismissLastSeen = dismissTick;
    if (st && st.cancelled) {
      // 菜单已解除（用户在菜单外按下且光标在菜单矩形外），无需额外动作
    }
    if (dismissTick - dismissLastSeen > 75) {   // 40ms × 75 = 3s 见不到菜单 ⇒ 自停
      clearInterval(dismissTimer);
      dismissTimer = null;
    }
  }, 40);
}

/** 舞台被点击时解除已弹出的桌面菜单（菜单等不到「别处的点击」，见上）。 */
function cancelDesktopMenu() {
  return desktopHost.cancelDesktopMenu();
}

module.exports = {
  start, stop, syncTo, broadcast, applyPauseState, isDegraded, stats,
  prewarm,              // 第七十八轮：启动预创建舞台窗口（页面加载与 rebuild 并行）
  recreateAll,          // 显示器拓扑变化时全量重建舞台（渲染器状态滞留的唯一清零手段）
  isPausedForDisplay,   // 调度器暂停感知用（暂停的显示器不推进轮播）
  displayIdForMonitor,  // 设备路径 → Electron displayId（手动暂停换算用）
  allDisplayIds,        // 当前舞台的 displayId 集合（PAUSE_ALL 展开用）
  anyDisplayPaused,     // unified 频道的暂停感知
  setPauseHide,         // hideOnPaused：暂停时藏舞台窗口（独占全屏游戏防驱动挂死）
  showDesktopContextMenu,
  cancelDesktopMenu,
};
