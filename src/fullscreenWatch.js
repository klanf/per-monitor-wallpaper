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
 *   - 进程镜像名黑名单（54 轮追记四）：QQ.exe —— QQNT 截图/录屏遮罩是 Electron
 *     窗口（Chrome_WidgetWin_1、无 TOOLWINDOW、不 cloak），会误判全屏。
 *     按镜像路径最后一段排除，见 EXCLUDED_IMAGE_NAMES。
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

/**
 * 54 轮追记四：按**进程镜像文件名**排除（不是窗口类名——QQNT 是 Electron 套壳，
 * 类名 Chrome_WidgetWin_1 与所有 Chromium 应用相同，按类名排除会误伤浏览器全屏）。
 * QQ 截图/录屏的遮罩层是全屏不透明窗口，会误判成「全屏应用」把舞台暂停。
 * 匹配的是 exeOf(pid) 的完整镜像路径的最后一段，小写比较；取不到路径（权限等）
 * 一律**不排除**（宁可误暂停不可漏暂停）。
 */
const EXCLUDED_IMAGE_NAMES = new Set(['qq.exe']);

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
 * @param {boolean} input.away      QUNS_NOT_PRESENT（锁屏 / 屏保；**纯熄屏不算**，
 *                                  平板「合盖=仅熄屏」不锁屏不进屏保，QUNS 照常 RUNNING）
 * @param {number}  [input.idleSec=0]      系统无输入秒数（powerMonitor.getSystemIdleTime）
 * @param {boolean} [input.pauseOnIdle=true]  无输入超时也当「人离开」
 * @param {number}  [input.idlePauseSeconds=300] 无输入判定阈值（秒；0 = 关闭该判定）
 * @param {boolean} [input.pauseOnFullscreen=true]
 * @param {boolean} [input.pauseOnAway=true]
 * @param {boolean} [input.battery=false]      正在用电池供电（GetSystemPowerStatus 直查）
 * @param {boolean} [input.pauseOnBattery=false] 用电池时全部暂停
 * @returns {{ paused: Set<string>, reasons: Object<string,string> }}
 *   reasons: id -> 'away' | 'idle' | 'battery' | 'fullscreen'
 */
function evaluatePause(input) {
  const monitors = (input && input.monitors) || [];
  const windows = (input && input.windows) || [];
  const away = Boolean(input && input.away);
  const battery = Boolean(input && input.battery);
  const idleSec = Number((input && input.idleSec) || 0);
  const pauseOnFullscreen = !(input && input.pauseOnFullscreen === false);
  const pauseOnAway = !(input && input.pauseOnAway === false);
  const pauseOnBattery = Boolean(input && input.pauseOnBattery);
  const pauseOnIdle = !(input && input.pauseOnIdle === false);
  const idlePauseSeconds = Math.max(0, Number((input && input.idlePauseSeconds) || 0));

  // 熄屏/合盖（不锁屏不睡眠）时 QUNS 不变，靠「无输入超时」兜底当成人离开 —— 56→57 轮，修平板熄屏耗电
  const idleAway = pauseOnIdle && idlePauseSeconds > 0 && idleSec >= idlePauseSeconds;

  const eligible = windows.filter(eligibleWindow)
    .filter((w) => !(w.imageName && EXCLUDED_IMAGE_NAMES.has(String(w.imageName).toLowerCase())));
  const paused = new Set();
  const reasons = {};
  for (const m of monitors) {
    if (!m || m.id == null || !m.work) continue;
    let why = null;
    if ((away && pauseOnAway) || idleAway) {
      why = (away && pauseOnAway) ? 'away' : 'idle';
    } else if (battery && pauseOnBattery) {
      why = 'battery';                            // 电池优先于全屏判定：平板省电压倒一切
    } else if (pauseOnFullscreen && eligible.some((w) => coversWork(w.rect, m.work))) {
      why = 'fullscreen';
    }
    if (why) {
      paused.add(m.id);
      reasons[m.id] = why;
    }
  }
  return { paused, reasons, idleAway };
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

/** SYSTEM_POWER_STATUS（kernel32!GetSystemPowerStatus），只关心 ACLineStatus */
koffi.struct('WpFsWatchPowerStatus', {
  ACLineStatus: 'uint8',          // 0=用电池 1=接市电 255=未知
  BatteryFlag: 'uint8',
  BatteryLifePercent: 'uint8',
  Reserved0: 'uint8',
  BatteryLifeTime: 'uint32',
  BatteryFullLifeTime: 'uint32',
});

let k32 = null;
let k32Error = null;

/**
 * 电池供电直查（58 轮改判：displayWatch 熄屏事件真机收不到，弃用；
 * 拔电检测改走 GetSystemPowerStatus —— 一次同步调用，无窗口无线程，
 * 不依赖任何系统消息投递，比 powerMonitor.isOnBatteryPower() 的缓存值可靠）。
 * @returns {boolean|null} true=用电池 false=接市电 null=查不到（调用方自行兜底）
 */
function isOnBattery() {
  try {
    if (!k32) {
      if (k32Error) return null;
      const a = koffi.load('kernel32.dll');
      k32 = { GetSystemPowerStatus: a.func('bool GetSystemPowerStatus(_Out_ WpFsWatchPowerStatus *st)') };
    }
    const st = { ACLineStatus: 255, BatteryFlag: 0, BatteryLifePercent: 0, Reserved0: 0, BatteryLifeTime: 0, BatteryFullLifeTime: 0 };
    if (!k32.GetSystemPowerStatus(st)) return null;
    if (st.ACLineStatus === 0) return true;   // 拔电（电池供电）
    if (st.ACLineStatus === 1) return false;  // 接电
    return null;                              // 255 = 未知（台式机无电池常见），别瞎猜
  } catch (err) {
    k32Error = err;
    return null;
  }
}

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
      GetWindowThreadProcessId: u.func('uint32 GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *pid)'),
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
    const pidBuf = koffi.alloc('uint32', 1);
    a.GetWindowThreadProcessId(hWnd, pidBuf);
    windows.push({
      hwnd: String(hWnd),
      pid: koffi.decode(pidBuf, 'uint32'),      // 诊断用：exe 归属（54 轮追记四，QQ 截图误判排查）
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
  // 54 轮追记四：给「eligible 且完整盖住某块屏工作区」的窗口解析进程镜像名
  // （QQ 排除用）。只有这一小撮窗口才调 OpenProcess，通常 ≤2 个，每 2s 轮询无压力。
  const monitors = workAreas();
  for (const w of s.windows) {
    if (!eligibleWindow(w)) continue;
    if (!monitors.some((m) => m && m.work && coversWork(w.rect, m.work))) continue;
    let name = null;
    try {
      const exe = desktopHost.exeOf(w.pid);
      name = exe ? exe.split(/[\\/]/).pop() : null;
    } catch { /* 取不到就 null：不排除（宁可误暂停不可漏暂停） */ }
    w.imageName = name;
  }
  const { paused, reasons, idleAway } = evaluatePause({
    monitors,
    windows: s.windows,
    away: s.away,
    battery: f.battery === true,
    pauseOnFullscreen: f.pauseOnFullscreen !== false,
    pauseOnAway: f.pauseOnAway !== false,
    pauseOnBattery: f.pauseOnBattery === true,
    idleSec: Number(f.idleSec) || 0,
    pauseOnIdle: f.pauseOnIdle !== false,
    idlePauseSeconds: Number(f.idlePauseSeconds) || 0,
  });
  const key = `${s.away ? 'A' : '-'}${idleAway ? 'I' : '-'}${f.battery === true ? 'B' : '-'}|[${[...paused].sort((x, y) => x - y).join(',')}]`;
  const changed = last === null || key !== last.key;
  last = { key, paused, away: s.away || idleAway, reasons };
  return {
    ok: true,
    pausedIds: [...paused],
    away: s.away || idleAway,
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
  isOnBattery,
  SHELL_CLASSES,
  EXCLUDED_IMAGE_NAMES,
  sample,
  workAreas,
  tickNow,
  start,
  stop,
  resetForTest,
  CONST: { QUNS_NOT_PRESENT, POLL_MS, WS_EX_TOOLWINDOW },
};
