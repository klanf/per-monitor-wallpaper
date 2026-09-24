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
 *   unified 频道（monitorId=null，要盖整个虚拟桌面）阶段 2 再接，这里跳过。
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

const WATCHDOG_MS = 2000;
/** 连续重挂失败多少次才算「降级」（交给系统壁纸兜底） */
const DEGRADED_AFTER = 3;

/** channelId → { win, hwnd, anchor, bounds, degraded, fails, creating } */
const stages = new Map();
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
  const bySize = all.filter((d) => Math.round(d.bounds.width * d.scaleFactor) === m.width
    && Math.round(d.bounds.height * d.scaleFactor) === m.height);
  if (bySize.length === 1) return bySize[0];
  if (bySize.length > 1) return bySize.find((d) => d.primary) || bySize[0];
  return all.find((d) => d.primary) || screen.getPrimaryDisplay();
}

function stageBounds(ch) {
  const disp = displayForMonitor(ch.monitor || ch);
  return {
    x: disp.bounds.x,
    y: disp.bounds.y,
    width: disp.bounds.width,
    height: disp.bounds.height,
  };
}

/* ---------------------------------------------------------------- 广播 */

function broadcast(type, payload) {
  for (const st of stages.values()) {
    if (st.win && !st.win.isDestroyed()) {
      try { st.win.webContents.send(type, payload); } catch { /* 窗口正在销毁 */ }
    }
  }
}

/* ---------------------------------------------------------------- 创建 / 销毁 */

async function createStage(ch) {
  const rec = { win: null, hwnd: 0, anchor: null, bounds: null, degraded: false, fails: 0, creating: true };
  stages.set(ch.id, rec);
  try {
    const b = stageBounds(ch);
    rec.bounds = b;
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
    // 渲染进程崩了（GPU 驱动复位之类）→ 重载页面；窗口与挂载都还在
    win.webContents.on('render-process-gone', () => {
      if (running && rec.win && !rec.win.isDestroyed()) rec.win.webContents.reload();
    });

    await win.loadFile(path.join(__dirname, 'renderer', 'stage.html'));
    if (!running) { win.destroy(); return; }

    // 找挂载点。每次创建都重新 snapshot：Explorer 可能重启过，Progman 句柄会变
    const snap = desktopHost.snapshot({});
    const choice = desktopHost.chooseMountParent(snap);
    if (!choice.ok) throw new Error(`挂载点判定失败：${choice.reason}`);
    rec.anchor = { parentHwnd: choice.parentHwnd, insertAfterHwnd: choice.insertAfterHwnd };

    rec.hwnd = hwndOf(win);
    const m = desktopHost.mount(rec.hwnd, choice.parentHwnd, choice.insertAfterHwnd, {
      x: b.x, y: b.y, w: b.width, h: b.height,
    });
    if (!m.ok) throw new Error(`挂载失败 @${m.step}: ${m.error}`);

    win.showInactive();                // 不抢焦点
    rec.fails = 0;
    rec.degraded = false;
    win.webContents.send('stage:bind', { channelId: ch.id, monitorId: ch.monitorId });
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

/* ---------------------------------------------------------------- 看门狗 */

function watchOnce() {
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
            const m = desktopHost.mount(rec.hwnd, choice.parentHwnd, choice.insertAfterHwnd, {
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

      // 父子关系正常 —— 但还要看 Z 序（§2.14：写系统壁纸会插入 WorkerW 压住我们）
      if (!desktopHost.isZOrderIntact(rec.hwnd, rec.anchor.insertAfterHwnd)) {
        const r = desktopHost.reaffirmZOrder(rec.hwnd, rec.anchor.insertAfterHwnd, {
          x: rec.bounds.x, y: rec.bounds.y, w: rec.bounds.width, h: rec.bounds.height,
        });
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
  for (const id of [...stages.keys()]) destroyStage(id);
  console.log('[live-stage] 动态桌面已停止');
}

/**
 * 频道列表 → stage 窗口增删（channels:changed / 启动时调用）。
 * unified 频道（monitorId=null、width=0）阶段 2 再支持，这里跳过。
 */
function syncTo(channels) {
  if (!running) return;
  const wanted = new Set();
  for (const ch of Array.isArray(channels) ? channels : []) {
    if (!ch || ch.width === 0 || ch.enabled === false || ch.count === 0) continue;
    wanted.add(ch.id);
    const existing = stages.get(ch.id);
    if (!existing && !stages.has(ch.id)) {
      createStage(ch);   // 异步；creating 标记防重复创建
    } else if (existing && !existing.creating && existing.bounds) {
      // 显示器配置可能变了 → 重新对齐 bounds（DIP，见 stageBounds）
      const b = stageBounds(ch);
      if (b.x !== existing.bounds.x || b.y !== existing.bounds.y
        || b.width !== existing.bounds.width || b.height !== existing.bounds.height) {
        existing.bounds = b;
        if (existing.win && !existing.win.isDestroyed()) {
          existing.win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
          if (existing.hwnd) {
            desktopHost.reaffirmZOrder(existing.hwnd, existing.anchor.insertAfterHwnd,
              { x: b.x, y: b.y, w: b.width, h: b.height });
          }
        }
      }
    }
  }
  for (const id of [...stages.keys()]) {
    if (!wanted.has(id)) destroyStage(id);
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
    stages: [...stages.entries()].map(([id, rec]) => ({
      id,
      mounted: Boolean(rec.hwnd && rec.anchor),
      degraded: rec.degraded,
      fails: rec.fails,
      bounds: rec.bounds,
    })),
  };
}

module.exports = {
  start, stop, syncTo, broadcast, isDegraded, stats,
};
