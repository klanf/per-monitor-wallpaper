'use strict';

/**
 * 全屏 / 挂机暂停检测（阶段 3）：某块屏被全屏应用占满时只暂停那块屏的舞台，
 * 锁屏 / 息屏 / 屏保时全部暂停。恢复后自动续播。
 *
 * ---------------------------------------------------------------------------
 * 一、判定算法的出处
 * ---------------------------------------------------------------------------
 * 整套判定抄自 zm-main（幻梦桌面 LivePaper，Apache 2.0）的 `src-tauri/src/fullscreen.rs`，
 * 翻译成 koffi/JS。选它而不是最初计划的 GetForegroundWindow 方案，理由：
 *   - GetForegroundWindow 只知道「焦点在哪」，给不出「哪块屏被占满」——
 *     多屏下 ELDEN RING 占着副屏、主屏在看视频时，前者要暂停、后者不能误伤；
 *   - 工作区覆盖判定天然支持：无边框全屏、F11、窗口化全屏、多屏同时全屏；
 *   - 最大化窗口边框会超出屏幕矩形约 8px，所以判「覆盖」而不是「精确重合」。
 *     （最大化窗口盖住壁纸 ⇒ 壁纸反正在它底下看不见 ⇒ 停掉纯赚 GPU，语义正确。）
 *
 * 排除项（都是实测量产过的误报源，与 e2e 里踩过的 DWM cloaked 假绿同源）：
 *   - WS_EX_TOOLWINDOW（工具窗 / 浮层）
 *   - DWMWA_CLOAKED（UWP 挂起、切走的虚拟桌面、锁屏宿主 —— IsWindowVisible
 *     是 true 但 DWM 根本不渲染）
 *   - Shell 系统层：Progman / WorkerW（桌面本身，天然铺满每一块屏）、
 *     任务栏、输入法与任务视图悬浮层（CoreWindow / XamlExplorerHost）
 *
 * 挂机判定：SHQueryUserNotificationState() == QUNS_NOT_PRESENT
 *   = 锁屏 / 屏保 / 显示器关闭。此时 EnumWindows 的结果不可信（锁屏层本身
 *   铺满屏幕），直接全停，不再做覆盖判定。
 *
 * ---------------------------------------------------------------------------
 * 二、为什么不需要排除「自己的窗口」
 * ---------------------------------------------------------------------------
 * 舞台窗口挂载后就变成了 Progman 的**子窗口**，EnumWindows / GetWindow 沿
 * 顶层链枚举根本看不到它；挂载前 show:false 不可见，也被 visible 过滤掉。
 * 主窗口最大化盖住工作区会触发暂停 —— 这是正确语义（壁纸被它挡住了）。
 *
 * ---------------------------------------------------------------------------
 * 三、可单测性
 * ---------------------------------------------------------------------------
 * `evaluatePause` 是纯函数：只吃普通对象（窗口表 + 工作区表），不碰 koffi /
 * Electron / 系统，单测喂假数据即可覆盖全部判定分支。electron 依赖懒加载，
 * 纯 node 跑单测不会炸。
 */

// ---------------------------------------------------------------------------
// 纯函数层（不依赖 Windows / Electron，可单测）
// ---------------------------------------------------------------------------

const WS_EX_TOOLWINDOW = 0x00000080;

/** Shell 系统层窗口类：天然铺满屏幕，一律不算「应用占满」 */
const SHELL_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'Windows.UI.Core.CoreWindow',
  'XamlExplorerHostIslandWindow',
]);

/** 单个窗口是否参与「占满判定」 */
function eligibleWindow(w) {
  return Boolean(w)
    && Boolean(w.visible)
    && !(Number(w.exStyle) & WS_EX_TOOLWINDOW)
    && !w.cloaked
    && !SHELL_CLASSES.has(w.cls);
}

/** 窗口矩形是否**完整覆盖**工作区（>= 比较，容忍最大化 8px 外溢） */
function coversWork(rect, work) {
  return Number(rect.l) <= work.l
    && Number(rect.t) <= work.t
    && Number(rect.r) >= work.r
    && Number(rect.b) >= work.b;
}

/**
 * 计算每块屏的暂停集合。
 *
 * @param {object} input
 * @param {Array}  input.monitors   [{ id, work: {l,t,r,b} }]（物理像素）
 * @param {Array}  input.windows    [{ visible, exStyle, cloaked, cls, rect: {l,t,r,b} }]
 * @param {boolean} input.away      QUNS_NOT_PRESENT（锁屏 / 屏保 / 息屏）
 * @param {boolean} [input.pauseOnFullscreen=true]
 * @param {boolean} [input.pauseOnAway=true]
 * @returns {{ paused: Set<string>, reasons: Object<string,string> }}
 *   reasons: id -> 'away' | 'fullscreen'
 */
function evaluatePause(input) {
  const monitors = (input && input.monitors) || [];
  const windows = (input && input.windows) || [];
  const away = Boolean(input && input.away);
  const pauseOnFullscreen = !(input && input.pauseOnFullscreen === false);
  const pauseOnAway = !(input && input.pauseOnAway === false);

  const eligible = windows.filter(eligibleWindow);
  const paused = new Set();
  const reasons = {};
  for (const m of monitors) {
    if (!m || m.id == null || !m.work) continue;
    let why = null;
    if (away && pauseOnAway) {
      why = 'away';
    } else if (pauseOnFullscreen && eligible.some((w) => coversWork(w.rect, m.work))) {
      why = 'fullscreen';
    }
    if (why) {
      paused.add(m.id);
      reasons[m.id] = why;
    }
  }
  return { paused, reasons };
}

// ---------------------------------------------------------------------------
// Win32 采样层（koffi；与 desktopHost 同一套懒加载 + DPI 纪律）
// ---------------------------------------------------------------------------

const koffi = require('koffi');
const desktopHost = require('./desktopHost');   // 复用 ensureDpiAwareness（同一进程只需设一次）

let api = null;
let loadError = null;

/** koffi 结构体名是全局注册的，起独立前缀避免和 desktopHost 的撞名 */
koffi.struct('WpFsWatchRect', { l: 'int32', t: 'int32', r: 'int32', b: 'int32' });

const GW_CHILD = 5;
const GW_HWNDNEXT = 2;
const GWL_EXSTYLE = -20;
const MONITOR_DEFAULTTONEAREST = 2;
const QUNS_NOT_PRESENT = 1;

function load() {
  if (api || loadError) return api;
  try {
    const u = koffi.load('user32.dll');
    const s = koffi.load('shell32.dll');
    let dwmCloaked = null;
    try {
      const d = koffi.load('dwmapi.dll');
      dwmCloaked = d.func('int32 DwmGetWindowAttribute(void *hwnd, uint32 attr, _Out_ uint32 *val, uint32 cb)');
    } catch { dwmCloaked = false; }   // 没 dwmapi 就退化为「不查 cloak」，SHELL_CLASSES 仍兜底
    api = {
      GetDesktopWindow: u.func('void *GetDesktopWindow()'),
      GetWindow: u.func('void *GetWindow(void *hWnd, uint32 cmd)'),
      IsWindowVisible: u.func('bool IsWindowVisible(void *hWnd)'),
      GetClassNameW: u.func('int GetClassNameW(void *hWnd, _Out_ uint16 *buf, int cch)'),
      GetWindowRect: u.func('bool GetWindowRect(void *hWnd, _Out_ WpFsWatchRect *r)'),
      GetWindowLongPtrW: u.func('intptr_t GetWindowLongPtrW(void *hWnd, int index)'),
      SHQueryUserNotificationState: s.func('int32 SHQueryUserNotificationState(_Out_ int32 *state)'),
      dwmCloaked,
    };
  } catch (err) {
    loadError = err;
  }
  return api;
}

function classNameOf(hWnd) {
  const buf = Buffer.alloc(128 * 2);
  const n = load().GetClassNameW(hWnd, koffi.as(buf, 'uint16 *'), 128);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

function isCloaked(hWnd) {
  const fn = api.dwmCloaked;
  if (!fn) return false;
  const out = koffi.alloc('uint32', 1);
  const r = fn(hWnd, 14, out, 4);   // DWMWA_CLOAKED
  return r === 0 && koffi.decode(out, 'uint32') !== 0;
}

/** 顶层窗口表（GetWindow 链枚举，和 desktopHost.topLevelHandles 同款） */
function listTopWindows() {
  const a = load();
  const out = [];
  let h = a.GetWindow(a.GetDesktopWindow(), GW_CHILD);
  let guard = 0;
  while (h && guard < 4000) {
    out.push(h);
    h = a.GetWindow(h, GW_HWNDNEXT);
    guard += 1;
  }
  return out;
}

/**
 * 采样一次：{ away, windows: [{ visible, exStyle, cloaked, cls, rect }] }
 * 全部物理像素。koffi / shell32 不可用 时返回 { ok:false, error }。
 */
function sample() {
  const a = load();
  if (!a) {
    return { ok: false, error: loadError ? loadError.message : 'koffi 不可用' };
  }
  desktopHost.ensureDpiAwareness();   // 取坐标前必须声明 DPI 感知（§2.3）

  const stateOut = koffi.alloc('int32', 1);
  let away = false;
  try {
    const hr = a.SHQueryUserNotificationState(stateOut);
    away = hr === 0 && koffi.decode(stateOut, 'int32') === QUNS_NOT_PRESENT;
  } catch { /* 查不到就当人在场，退化为纯覆盖判定 */ }

  const windows = [];
  for (const hWnd of listTopWindows()) {
    const rect = {};
    if (!a.GetWindowRect(hWnd, rect)) continue;
    windows.push({
      hwnd: String(hWnd),
      visible: Boolean(a.IsWindowVisible(hWnd)),
      exStyle: Number(a.GetWindowLongPtrW(hWnd, GWL_EXSTYLE)) >>> 0,
      cloaked: isCloaked(hWnd),
      cls: classNameOf(hWnd),
      rect: { l: rect.l, t: rect.t, r: rect.r, b: rect.b },
    });
  }
  return { ok: true, away, windows };
}

/**
 * 每块屏的工作区（物理像素）。来源是 Electron 的 screen（DIP × scaleFactor），
 * 而不是 GetMonitorInfoW —— liveStage 的频道↔显示器映射走的就是 Electron
 * display.id，两边用同一套口径，免得再写一次 deviceName 匹配。
 */
function workAreas() {
  let screen = null;
  try { ({ screen } = require('electron')); } catch { return []; }
  if (!screen || typeof screen.getAllDisplays !== 'function') return [];
  return screen.getAllDisplays().map((d) => {
    const sf = d.scaleFactor || 1;
    const wa = d.workArea || d.bounds;
    return {
      id: d.id,
      work: {
        l: Math.round(wa.x * sf),
        t: Math.round(wa.y * sf),
        r: Math.round((wa.x + wa.width) * sf),
        b: Math.round((wa.y + wa.height) * sf),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// 轮询层：2s 一轮，只在状态变化时回调（zm 同款节奏）
// ---------------------------------------------------------------------------

const POLL_MS = 2000;

let timer = null;
let getFlags = null;
let onTick = null;
/** null = 还没跑过第一轮（第一轮无论结果如何都要通知，消费者才知道初始态） */
let last = null;

/**
 * 立即采样并计算一次。返回 { pausedIds, away, reasons, changed, ok, error? }。
 * 独立导出是为了验证脚本可以手动触发、精确断言。
 */
function tickNow(flags) {
  const f = flags
    || (typeof getFlags === 'function' ? getFlags() : {})
    || {};
  const s = sample();
  if (!s.ok) {
    // 采样失败：当什么都没发生（保持上次状态），别把桌面冻死在误报上
    return { ok: false, error: s.error, pausedIds: last ? [...last.paused] : [], away: last ? last.away : false, reasons: {}, changed: false };
  }
  const { paused, reasons } = evaluatePause({
    monitors: workAreas(),
    windows: s.windows,
    away: s.away,
    pauseOnFullscreen: f.pauseOnFullscreen !== false,
    pauseOnAway: f.pauseOnAway !== false,
  });
  const key = `${s.away ? 'A' : '-'}|[${[...paused].sort((x, y) => x - y).join(',')}]`;
  const changed = last === null || key !== last.key;
  last = { key, paused, away: s.away, reasons };
  return {
    ok: true,
    pausedIds: [...paused],
    away: s.away,
    reasons,
    changed,
  };
}

/**
 * 启动轮询。options: { getFlags: () => ({ pauseOnFullscreen, pauseOnAway }),
 *                       onTick: ({ pausedIds, away, reasons }) }
 * onTick 只在状态变化（含第一轮）时被调用。重复调用 start 是幂等的。
 */
function start(options) {
  getFlags = (options && options.getFlags) || getFlags;
  onTick = (options && options.onTick) || onTick;
  if (timer) return;
  timer = setInterval(() => {
    let r;
    try { r = tickNow(); } catch (err) {
      console.warn('[fullscreen-watch] 一轮失败:', err.message);
      return;
    }
    if (r.ok && r.changed && onTick) {
      try { onTick({ pausedIds: r.pausedIds, away: r.away, reasons: r.reasons }); } catch { /* 回调自炸别带垮轮询 */ }
    }
  }, POLL_MS);
  // 先立刻跑一轮，别让消费者等 2s 才拿到初始状态
  try {
    const r = tickNow();
    if (r.ok && onTick) onTick({ pausedIds: r.pausedIds, away: r.away, reasons: r.reasons });
  } catch { /* 下一轮再试 */ }
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  last = null;   // 下次 start 重新广播初始态
  getFlags = null;
  onTick = null;
}

/** 调试 / 测试注入：重置「上次状态」，强制下一轮视为变化 */
function resetForTest() {
  last = null;
}

module.exports = {
  evaluatePause,
  eligibleWindow,
  coversWork,
  SHELL_CLASSES,
  sample,
  workAreas,
  tickNow,
  start,
  stop,
  resetForTest,
  CONST: { QUNS_NOT_PRESENT, POLL_MS, WS_EX_TOOLWINDOW },
};
