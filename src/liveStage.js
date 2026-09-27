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
 *   unified 频道（monitorId=null）：span 形态一块跨屏窗口盖并集，或展开成
 *   每屏一块窗口（unifiedSplit='per-display'，53 轮），见 stagePlan.expandUnifiedChannel。
 *
 * ---------------------------------------------------------------------------
 * 三条实测结论铸成的规矩（任务书 §2.13~§2.16）
 * ---------------------------------------------------------------------------
 *   1. 挂载点 = chooseMountParent() 的输出，**绝不自己找 WorkerW**；
 *   2. 「挂载还活着」不能只看父子关系 —— 写系统壁纸会把我们挤到下层，
 *      看门狗判据必须是 Z 序（isZOrderIntact），失效就 reaffirmZOrder；
 *   3. Explorer 重启后父句柄失效 → 窗口变孤儿（盖住图标、Alt+Tab 没有）。
 *      处理：先 hide 再重挂再 showInactive，全程不抢焦点。
 *
 * 所有动画在 stage.js（渲染层）；这里 backgroundThrottling:false，
 * 因为挂到桌面后 Chromium 可能把窗口当「不可见」而降帧 —— 那就全完了。
 */

const { BrowserWindow, screen } = require('electron');
const path = require('node:path');
const desktopHost = require('./desktopHost');
const stagePlan = require('./stagePlan');

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
  /*
   * 统一频道（kind='unified' / monitor=null）：盖住所有显示器的并集
   * （52 轮。此前 syncTo 直接跳过 width=0 的统一伪频道，统一模式下
   * 动态桌面从未生效 —— 用户实报「切统一配置舞台就没了」）。
   */
  if (ch && ch.kind === 'unified' && !ch.monitor) {
    // 53 轮：per-display 形态已在上游展开成带 _displayId 的伪频道，走不到这里；
    // span 形态照旧盖虚拟桌面并集。
    // ⚠️ Electron 的 Display 没有顶层 width/height（只有 bounds.width），直接传
    // 全被 virtualBounds 的脏值过滤砍光 →「枚举不到任何显示器」（探针实锤，
    // 单测喂扁平假数据掩盖了这个形状差）。这里显式拍平。
    const v = stagePlan.virtualBounds(screen.getAllDisplays().map((d) => ({
      id: d.id,
      x: d.bounds.x, y: d.bounds.y,
      width: d.bounds.width, height: d.bounds.height,
      scaleFactor: d.scaleFactor,
    })));
    if (!v) throw new Error('统一频道：枚举不到任何显示器');
    return {
      dip: { x: v.dip.x, y: v.dip.y, width: v.dip.width, height: v.dip.height },
      phys: v.phys,
      displayId: null,
      displayIds: v.displayIds,
    };
  }
  // 展开后的 per-display 伪频道：直接按 displayId 取 Display（按尺寸匹配会让
  // 两块同尺寸屏全部落在主屏上互相 z-fight）
  const disp = ch && ch._displayId !== undefined
    ? (screen.getAllDisplays().find((d) => d.id === ch._displayId) || displayForMonitor(ch.monitor || ch))
    : displayForMonitor(ch.monitor || ch);
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
  // 是 Electron display），stage 窗口必须知道自己挂在哪块屏才知道听不听暂停。
  // 统一频道跨屏，没有单一 displayId，返回 displayIds 由 stagePlan 判重叠。
  return { dip, phys, displayId: disp.id, displayIds: null };
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
 * 手动暂停（工具栏 ‖ / 托盘 / 热键，53 轮）：频道 playing=false 时舞台冻结
 * （粒子也停 —— 用户实报「点了暂停粒子还在飘」）。与自动暂停的区别：
 * **不藏窗口** —— 用户只是想画面停下来，不是要把桌面让给系统壁纸。
 */
const manualPaused = new Set();
/**
 * 暂停时把舞台窗口整个藏起来（52 轮新增，默认开）：
 * 深暂停只停 rAF，窗口还攥着 4K flip 交换链 —— 艾尔登法环独占全屏做模式切换时
 * 撞上它会驱动挂死（主屏失信号、副屏冻结、游戏有声）。藏掉 = 交换链离开显示路径。
 * 恢复用 showInactive（与看门狗重挂同一条已验证路径），画面留在原帧不重载。
 */
let pauseHide = true;

function setPauseHide(value) {
  pauseHide = value !== false;
}

/**
 * 首帧等待（53 轮防启动黑屏）：挂载/重载后窗口保持隐藏，等渲染端把第一帧真正
 * 画上屏（stage:first-frame）再亮 —— 「先 show 后画」会把纯黑底色露给桌面。
 *
 * 54 轮修正：53 轮的 3s 超时兜底会**亮出纯黑窗口**（backgroundColor #000000），
 * 冷启动大图解码超过 3s 时黑闪照旧（探针实测打出「首帧超时(3s)兜底显示」）。
 * 改为超时**只告警、保持隐藏** —— 空窗期桌面显示的是系统壁纸（和黑窗相比
 * 永远是更好的兜底），首帧无论多晚到达都由 onFirstFrame 正常亮窗。
 */
const FIRST_FRAME_WARN_MS = 30000;

function waitForFirstFrame(rec, label) {
  rec.awaitingFirstFrame = true;
  if (rec.firstFrameTimer) clearTimeout(rec.firstFrameTimer);
  rec.firstFrameTimer = setTimeout(() => {
    if (!rec.awaitingFirstFrame) return;
    rec.firstFrameTimer = null;
    console.warn(`[live-stage] ${label} 首帧 ${Math.round(FIRST_FRAME_WARN_MS / 1000)}s 未到，保持隐藏（桌面=系统壁纸）；渲染端出帧后 onFirstFrame 自动亮窗`);
  }, FIRST_FRAME_WARN_MS);
}

/** 渲染端首帧画上屏（stage:first-frame）→ 判定无暂停后亮出窗口 */
function onFirstFrame(sender) {
  for (const rec of stages.values()) {
    if (rec.win && !rec.win.isDestroyed() && rec.win.webContents === sender) {
      if (!rec.awaitingFirstFrame) return;
      if (rec.firstFrameTimer) { clearTimeout(rec.firstFrameTimer); rec.firstFrameTimer = null; }
      rec.awaitingFirstFrame = false;
      if (stagePlan.canShowStage(rec, pauseDisplays, pauseAway)) {
        try { rec.win.showInactive(); } catch { /* 正在销毁 */ }
      } else {
        rec.hiddenForPause = true;     // 自动暂停中：保持隐藏，恢复时亮
      }
      return;
    }
  }
}

/** 统一模式动态桌面形态：'span' 跨屏拼一幅（默认）| 'per-display' 每屏同一幅（53 轮） */
let unifiedSplit = 'span';

function setUnifiedSplit(value) {
  unifiedSplit = value === 'per-display' ? 'per-display' : 'span';
}

/** 手动暂停集更新（main 在 scheduler channels 事件里喂），重算每块舞台的冻结态 */
function applyManualPause(pausedIds) {
  manualPaused.clear();
  for (const id of Array.isArray(pausedIds) ? pausedIds : []) {
    if (id) manualPaused.add(id);
  }
  refreshPauseMessages();
}

/** 舞台当前是否冻结（自动暂停 ∪ 手动暂停）。hide 只认自动暂停（手动暂停不藏窗口）。 */
function isStageFrozen(rec) {
  return stagePlan.isStagePaused(rec, pauseDisplays, pauseAway)
    || manualPaused.has(rec.channelId);
}

function applyPauseState({ pausedIds, away, reasons } = {}) {
  pauseDisplays.clear();
  for (const id of Array.isArray(pausedIds) ? pausedIds : []) pauseDisplays.add(id);
  pauseAway = Boolean(away);
  refreshPauseMessages(reasons);
}

/** 按当前（自动 ∪ 手动）暂停态刷新每块舞台：发 stage:pause，自动暂停的藏窗 */
function refreshPauseMessages(reasons) {
  const affected = [];
  for (const [, rec] of stages) {
    if (!rec.win || rec.win.isDestroyed()) continue;
    const paused = isStageFrozen(rec);
    const autoPaused = stagePlan.isStagePaused(rec, pauseDisplays, pauseAway);
    if (paused) affected.push(rec.channelId);
    try {
      rec.win.webContents.send('stage:pause', { paused });
      if (pauseHide) {
        if (autoPaused && rec.win.isVisible()) {
          rec.win.hide();               // 不销毁：恢复时 showInactive 原帧续播
          rec.hiddenForPause = true;
        } else if (!autoPaused && rec.hiddenForPause) {
          rec.hiddenForPause = false;
          if (!rec.awaitingFirstFrame) {
            rec.win.showInactive();     // 不抢焦点（与挂载/重挂同款纪律）
          }                             // 首帧未到 → 等 onFirstFrame/兜底再亮
        }
      }
    } catch { /* 窗口正在销毁 */ }
  }
  if (affected.length || pauseAway) {
    // 诊断（49 轮排障）：点名哪些频道会被冻结，与调度器停表对账用
    console.log(`[live-stage] 暂停：display=[${[...pauseDisplays]}] away=${pauseAway} manual=[${[...manualPaused]}] 受影响频道=[${affected.join(',') || '无'}] hide=${pauseHide}`,
      Object.keys(reasons || {}).length ? JSON.stringify(reasons) : '');
  } else {
    console.log('[live-stage] 暂停解除：全部舞台恢复');
  }
}

function isPausedForDisplay(displayId) {
  return pauseDisplays.has(displayId);
}

/**
 * 该频道的舞台是否处于暂停（全屏 / 锁屏 / 电池 / 挂机）——调度器据此「停表不走针」
 * （48 轮）：渲染层停 rAF 之后，这里把调度推进也停掉，取消全屏后 1 秒内恢复。
 * 没有舞台的频道（已降级）不冻结 —— 系统壁纸照常轮播兜底。
 * 统一频道（跨屏舞台）任一覆盖屏被暂停即冻结（stagePlan.isStagePaused 同源判定）。
 */
function isChannelFrozen(channelId) {
  if (pauseAway) return true;   // 锁屏 / 息屏：所有频道一律停表（原语义，保持）
  let found = false;
  for (const rec of stages.values()) {
    if (rec.channelId !== channelId) continue;
    found = true;
    if (stagePlan.isStagePaused(rec, pauseDisplays, pauseAway)) return true;
  }
  return found && manualPaused.has(channelId);
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

/* ---------------------------------------------------------------- 创建 / 销毁 */

async function createStage(ch) {
  const rec = { win: null, hwnd: 0, anchor: null, bounds: null, boundsPhys: null, degraded: false, fails: 0, creating: true };
  stages.set(ch.id, rec);
  try {
    const sb = stageBounds(ch);
    const b = sb.dip;
    rec.bounds = b;
    rec.boundsPhys = sb.phys;
    // 49 轮实锤：displayId 此前从未写入 rec —— applyPauseState / isChannelFrozen
    // 用 rec.displayId 对号入座，拿到的一直是 undefined，pauseDisplays.has(undefined)
    // 恒 false：全屏/锁屏/电池暂停在舞台层从未生效（stage:pause 永远下发 paused:false）
    rec.displayId = sb.displayId;
    rec.displayIds = sb.displayIds || null;   // 统一频道 = 跨屏舞台，按覆盖屏集合判暂停
    rec.channelId = ch.channelId || ch.id;    // per-display 伪频道的 key 带后缀，tick/bind 仍用原频道 id
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
    win.setMenuBarVisibility(false);
    rec.win = win;

    win.on('closed', () => { if (stages.get(ch.id) === rec) stages.delete(ch.id); });
    // 渲染端 console 转发到主进程 stdout（黑屏类问题没有这个就是盲区 —— 2026-09-25 踩）
    win.webContents.on('console-message', (_e, _lvl, message, line, source) => {
      console.log(`[stage-render] ${message} (${source}:${line})`);
    });
    // 渲染进程崩了（GPU 驱动复位之类）→ 重载页面；窗口与挂载都还在
    win.webContents.on('render-process-gone', () => {
      if (running && rec.win && !rec.win.isDestroyed()) {
        rec.win.hide();                  // 重载后内容清空（纯黑底）：藏住等新首帧
        waitForFirstFrame(rec, ch.id);
        rec.win.webContents.reload();
      }
    });

    await win.loadFile(path.join(__dirname, 'renderer', 'stage.html'));
    if (!running) { win.destroy(); return; }

    // 找挂载点。每次创建都重新 snapshot：Explorer 可能重启过，Progman 句柄会变
    const snap = desktopHost.snapshot({});
    const choice = desktopHost.chooseMountParent(snap);
    if (!choice.ok) throw new Error(`挂载点判定失败：${choice.reason}`);
    rec.anchor = { parentHwnd: choice.parentHwnd, insertAfterHwnd: choice.insertAfterHwnd };

    rec.hwnd = hwndOf(win);
    const m = desktopHost.mount(rec.hwnd, choice.parentHwnd, choice.insertAfterHwnd, rec.boundsPhys);
    if (!m.ok) throw new Error(`挂载失败 @${m.step}: ${m.error}`);

    // 53 轮防启动黑屏：backgroundColor 是纯黑，show 之后到渲染端首帧 showFrame
    // 之间桌面会闪一块黑（冷启动几百 ms~2s）。先保持隐藏，等 stage:first-frame
    // 再亮（超时只告警不亮黑窗，54 轮），空窗期桌面显示的是系统壁纸。
    waitForFirstFrame(rec, ch.id);
    rec.fails = 0;
    rec.degraded = false;
    recreateFails.delete(ch.id);       // 挂载成功 → 重建失败计数清零
    // bind 带上初始暂停态：轮询事件只在「变化」时发，晚创建的窗口若只等
    // 事件会错过当前状态（zm 的 get_wallpaper_media 补拉同款问题）
    win.webContents.send('stage:bind', {
      channelId: rec.channelId,
      monitorId: ch.monitorId,
      paused: isPausedForDisplay(sb.displayId) || manualPaused.has(rec.channelId),
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
  if (rec.firstFrameTimer) { clearTimeout(rec.firstFrameTimer); rec.firstFrameTimer = null; }
  try {
    if (rec.hwnd) desktopHost.unmount(rec.hwnd);   // 先脱离桌面树，窗口销毁时不留残影
  } catch { /* koffi 不可用时窗口销毁同样会移除窗口本身 */ }
  if (rec.win && !rec.win.isDestroyed()) rec.win.destroy();
}

/* ---------------------------------------------------------------- 看门狗 */

function watchOnce() {
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
          const snap = desktopHost.snapshot({});
          const choice = desktopHost.chooseMountParent(snap);
          if (choice.ok) {
            rec.anchor = { parentHwnd: choice.parentHwnd, insertAfterHwnd: choice.insertAfterHwnd };
            // ⚠️ mount 要的是**物理坐标**（boundsPhys），之前误传 DIP 的 rec.bounds，
            //    多屏/高 DPI 下重挂位置会错（2026-09-25 复查时抓出）
            const m = desktopHost.mount(rec.hwnd, choice.parentHwnd, choice.insertAfterHwnd, rec.boundsPhys || {
              x: rec.bounds.x, y: rec.bounds.y, w: rec.bounds.width, h: rec.bounds.height,
            });
            if (m.ok) {
              // 暂停期间被我们主动藏掉的窗口：重挂完别急着 show，
              // 保持隐藏态等恢复（否则锁屏/全屏暂停中重挂会突然亮出来）
              if (!rec.hiddenForPause && !rec.awaitingFirstFrame) rec.win.showInactive();
              rec.fails = 0;
              console.log(`[live-stage] ${id} 重挂成功（Explorer 重启后）${rec.hiddenForPause ? '，保持暂停隐藏态' : ''}`);
            }
          }
        }
        rec.degraded = rec.fails >= DEGRADED_AFTER;
        continue;
      }

      // 父子关系正常 —— 但还要看 Z 序（§2.14：写系统壁纸会插入 WorkerW 压住我们）。
      // 兄弟舞台（其它屏的窗口）不算外人，否则多屏下互相误报、看门狗无限打架。
      const others = new Set();
      for (const [otherId, otherRec] of stages) {
        if (otherId !== id && otherRec.hwnd) others.add(otherRec.hwnd);
      }
      if (!desktopHost.isZOrderIntact(rec.hwnd, rec.anchor.insertAfterHwnd, others)) {
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
  console.log('[live-stage] 动态桌面已启动');
}

function stop() {
  running = false;
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  expectedChannels.clear();
  recreateFails.clear();
  for (const id of [...stages.keys()]) destroyStage(id);
  console.log('[live-stage] 动态桌面已停止');
}

/**
 * 频道列表 → stage 窗口增删（channels:changed / 启动时调用）。
 * 52 轮起支持统一频道（kind='unified'，width=0）：一块窗口盖住虚拟桌面并集，
 * 不再跳过 —— 此前统一模式下动态桌面整个不生效（用户实报）。
 */
function syncTo(channels) {
  if (!running) return;
  const wanted = new Set();
  const list = Array.isArray(channels) ? channels : [];
  // 统一频道按 unifiedSplit 展开：span = 原样一块跨屏窗口；per-display = 每屏一块
  const expanded = [];
  for (const ch of list) {
    if (!ch) continue;
    if (ch.kind === 'unified' && !ch.monitor) {
      expanded.push(...stagePlan.expandUnifiedChannel(
        ch,
        screen.getAllDisplays().map((d) => ({
          id: d.id,
          x: d.bounds.x, y: d.bounds.y,
          width: d.bounds.width, height: d.bounds.height,
          scaleFactor: d.scaleFactor,
        })),
        unifiedSplit,
      ));
    } else {
      expanded.push(ch);
    }
  }
  for (const ch of expanded) {
    /*
     * 不看 ch.enabled —— resolveProfile 把 applyToSystem 折进了 enabled
     * （store.js：enabled = Boolean(config.applyToSystem)），于是
     * 「动态桌面开 + 不写系统壁纸」（完全替代模式）下所有频道都是
     * enabled=false，若在这里跳过，舞台永远不会出现，模式直接失效。
     * 舞台只由 liveWallpaper 总开关控制（start 只在它为真时被调用）；
     * count=0（空相簿）照旧跳过。
     * 每屏单独退出（monitors[id].enabled=false）与动态桌面叠加的
     * 语义留到阶段 2 再定义。
     */
    if (!ch || ch.count === 0) { expectedChannels.delete(ch ? ch.id : ''); continue; }
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
      channelId: rec.channelId,
      mounted: Boolean(rec.hwnd && rec.anchor),
      degraded: rec.degraded,
      fails: rec.fails,
      paused: isStageFrozen(rec),
      hiddenForPause: Boolean(rec.hiddenForPause),
      unified: Boolean(rec.displayIds && rec.displayIds.length),
      bounds: rec.bounds,
    })),
  };
}

/** 桌面右键补偿：舞台置顶吃掉了鼠标（穿透方案见 desktopHost 的 LAYERED 注释，
 *  会让 Chromium 白屏），渲染端把 contextmenu 的 CSS(DIP) 屏幕坐标发上来，
 *  这里换算成物理像素后转发给 SHELLDLL_DefView，Explorer 就会弹原生桌面菜单。 */
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
  isChannelFrozen, setPauseHide, applyManualPause, setUnifiedSplit, onFirstFrame,
  showDesktopContextMenu,
  cancelDesktopMenu,
};
