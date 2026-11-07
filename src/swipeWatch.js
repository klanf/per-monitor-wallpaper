'use strict';

/**
 * 桌面手势切壁纸（54 轮追记五）：在**桌面**上按住左键横向拖动 / 触摸横扫，
 * 松手后切上一张 / 下一张 —— 方向与手机相册一致：往左扫 = 下一张，往右扫 = 上一张。
 *
 * ---------------------------------------------------------------------------
 * 一、为什么是轮询而不是低级鼠标钩子
 * ---------------------------------------------------------------------------
 * WH_MOUSE_LL 钩子要自己的消息泵且回调在钩子链上，卡一下全系统鼠标都卡 ——
 * 桌面壁纸这种常驻功能用钩子风险不对称。手势判定只需要「按下时光标在哪 +
 * 松开时光标在哪」，16ms 轮询三个 Win32 调用（GetAsyncKeyState / GetCursorPos /
 * WindowFromPoint）足够，事件一个都不吞：桌面框选、拖图标完全不受影响。
 *
 * ---------------------------------------------------------------------------
 * 二、起手点判定：根窗口类 ∈ {Progman, WorkerW}
 * ---------------------------------------------------------------------------
 * WindowFromPoint → GetAncestor(GA_ROOT) → 类名。桌面图标层
 * SHELLDLL_DefView / SysListView32 是 Progman 的子树，根还是 Progman；
 * 任务栏（Shell_TrayWnd）与任何应用窗口都不算桌面。
 * 本项目舞台窗口是 WS_CHILD+WS_EX_TRANSPARENT，命中测试直接穿透，无需特判。
 *
 * 已知取舍（功能语义如此，设置里可关）：
 *   - 桌面空白处的横向橡皮筋框选同形，也会触发切图；
 *   - 横向拖图标同样触发。二者都是「按住在桌面上 + 横向松手」。
 *
 * 触摸屏（55 轮追记）：原来的假设「触摸由系统合成鼠标输入，
 * GetAsyncKeyState(VK_LBUTTON) 照常读得到」在真机上不成立 —— Win8+ 触摸走
 * WM_POINTER 消息级合成，不更新异步按键状态，轮询层看到的是「从未按下」。
 * 兜底：未按下时持续记录光标轨迹，检测「快速横扫」（flick）；这条路径只在
 * 检测到触摸硬件的机器上启用（GetSystemMetrics 最大触点数 > 0），纯鼠标机器
 * 行为不变。代价（语义同按住拖动）：触摸机上快速横穿桌面的鼠标甩动也可能
 * 触发一次切图，设置开关可整个关掉。
 *
 * ---------------------------------------------------------------------------
 * 三、可单测性
 * ---------------------------------------------------------------------------
 * evaluateSwipe / evaluateFlick 是纯函数，DESKTOP_ROOT_CLASSES 常量导出，
 * node 单测不碰 koffi / Electron。koffi 懒加载，纯 node require 不炸。
 */

// ---------------------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------------------

/** 根窗口类 = 桌面本体（含图标层所在的树） */
const DESKTOP_ROOT_CLASSES = new Set(['Progman', 'WorkerW']);

/** 水平位移下限（物理像素）：短于此不算手势，给框选/误触留余地 */
const MIN_DX = 120;
/** 横向主导系数：|dx| 必须 ≥ 4×|dy|，斜着拖不算 */
const DX_DY_RATIO = 4;

/** 触摸横扫（flick）判定：起点到当前的时间窗（触摸扫过通常 150~350ms） */
const FLICK_WINDOW_MS = 300;
/** flick 最短持续：低于此（近乎瞬移）不算，防 SetCursorPos 式跳变误触 */
const FLICK_MIN_SPAN_MS = 40;
/**
 * 瞬移守卫（单步位移上限，px）：真扫动是逐帧连续移动（16ms 一拍，哪怕 9000px/s
 * 的极限甩动单步也只有 ~150px）；触摸屏上 WM_POINTER 合成会把光标**一步跳**到
 * 新触点（点按右边缘 = 从上次落点瞬移几百 px，插值拉长到 2~3 帧刚好逃过
 * FLICK_MIN_SPAN_MS 守卫）—— 单步超过上限视为瞬移，不判 flick。
 */
const TELEPORT_STEP_PX = 150;

/**
 * 触摸横扫判定（纯函数）。samples 为按时间升序的光标轨迹（都在桌面上采到），
 * now 为当前时刻。窗口内取最早样本为起点、末样本为终点，走 evaluateSwipe；
 * 持续时长必须落在 [MIN_SPAN, WINDOW] 内。
 * @returns {'next'|'prev'|null}
 */
function evaluateFlick(samples, now) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const last = samples[samples.length - 1];
  // 窗口内最早的样本作为起点（更老的样本已滑出窗外）
  let start = null;
  for (const s of samples) {
    if (now - s.t <= FLICK_WINDOW_MS) { start = s; break; }
  }
  if (!start || start === last) return null;
  const span = last.t - start.t;
  if (span < FLICK_MIN_SPAN_MS || span > FLICK_WINDOW_MS) return null;
  // 瞬移守卫：任何相邻两样本的步进超过上限 = 光标被合成层瞬移过（触摸点按
  // /程序跳光标），不是手指连续扫过 —— 整段轨迹作废
  for (let i = 1; i < samples.length; i++) {
    const p = samples[i - 1], s = samples[i];
    if (Math.hypot(s.x - p.x, s.y - p.y) > TELEPORT_STEP_PX) return null;
  }
  return evaluateSwipe(start, last);
}

/**
 * 一次手势的判定。@returns {'next'|'prev'|null}
 *   dx < 0（往左扫）= next，dx > 0（往右扫）= prev。
 */
function evaluateSwipe(start, end) {
  if (!start || !end || typeof start.x !== 'number' || typeof end.x !== 'number') return null;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < MIN_DX) return null;
  if (Math.abs(dx) < DX_DY_RATIO * Math.abs(dy)) return null;
  return dx < 0 ? 'next' : 'prev';
}

// ---------------------------------------------------------------------------
// Win32 采样层（koffi 懒加载，与 desktopHost / fullscreenWatch 同款纪律）
// ---------------------------------------------------------------------------

const koffi = require('koffi');
const desktopHost = require('./desktopHost');   // 复用 ensureDpiAwareness

koffi.struct('WpSwipePoint', { x: 'int32', y: 'int32' });

let api = null;
let loadError = null;

const GA_ROOT = 2;
const VK_LBUTTON = 0x01;
const SM_MAXIMUMTOUCHES = 95;

function load() {
  if (api || loadError) return api;
  try {
    const u = koffi.load('user32.dll');
    api = {
      GetAsyncKeyState: u.func('int16 GetAsyncKeyState(int vKey)'),
      GetCursorPos: u.func('bool GetCursorPos(_Out_ WpSwipePoint *pt)'),
      WindowFromPoint: u.func('void *WindowFromPoint(WpSwipePoint pt)'),   // POINT 按值传
      GetAncestor: u.func('void *GetAncestor(void *h, uint32 flags)'),
      GetClassNameW: u.func('int GetClassNameW(void *hWnd, _Out_ uint16 *buf, int cch)'),
      GetSystemMetrics: u.func('int GetSystemMetrics(int idx)'),
    };
  } catch (err) {
    loadError = err;
  }
  return api;
}

/** 这台机器有没有触摸硬件（查一次，缓存）。没有就整条 flick 兜底不启用 */
let touchCache = null;
function hasTouchHardware() {
  if (touchCache !== null) return touchCache;
  try {
    const a = load();
    touchCache = Boolean(a && a.GetSystemMetrics(SM_MAXIMUMTOUCHES) > 0);
  } catch {
    touchCache = false;
  }
  return touchCache;
}

/** 仅供端到端验证：本机没有触摸屏也要跑 flick 路径时强制开启/关闭 */
function setTouchOverride(v) { touchCache = Boolean(v); }

function cursorPoint() {
  const a = load();
  const pt = { x: 0, y: 0 };
  return a.GetCursorPos(pt) ? { x: pt.x, y: pt.y } : null;
}

/** 这一点是否落在桌面本体上（根窗口类判定，见文件头 §二） */
function isDesktopPoint(pt) {
  const a = load();
  if (!pt) return false;
  const h = a.WindowFromPoint({ x: pt.x, y: pt.y });
  if (!h) return false;
  const root = a.GetAncestor(h, GA_ROOT);
  const target = root || h;
  const buf = Buffer.alloc(64 * 2);
  const n = a.GetClassNameW(target, koffi.as(buf, 'uint16 *'), 64);
  const cls = n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
  return DESKTOP_ROOT_CLASSES.has(cls);
}

// ---------------------------------------------------------------------------
// 轮询层：16ms 一拍，事件一个不吞（见文件头 §一）
// ---------------------------------------------------------------------------

const POLL_MS = 16;
/** 一次手势最多按 15s（按键卡死的保护）；触发后的冷却 */
const MAX_PRESS_MS = 15000;
const DEBOUNCE_MS = 600;

let timer = null;
let opts = null;
let press = null;       // { x, y, t, dead } | null；dead = 起手不在桌面，等松手
let lastFire = 0;
const samples = [];     // flick 轨迹（仅未按下且点在桌面上时采集）

function fire(dir, at) {
  lastFire = Date.now();
  try { opts && opts.onSwipe && opts.onSwipe(dir, at); } catch { /* 回调自炸别带垮轮询 */ }
}

function tick() {
  const a = load();
  if (!a) return;
  // 设置开关每次现查（55 轮修：此前 getEnabled 只是接了线从没被读，开关是摆设）
  if (opts && typeof opts.getEnabled === 'function' && !opts.getEnabled()) {
    press = null;
    samples.length = 0;
    return;
  }
  const down = (a.GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0;
  if (down) {
    samples.length = 0;           // 按下期间走鼠标路径，轨迹清掉免得串台
    if (!press) {
      const pt = cursorPoint();
      if (pt && isDesktopPoint(pt)) {
        press = { x: pt.x, y: pt.y, t: Date.now(), dead: false };
      } else {
        press = { t: Date.now(), dead: true };   // 起手在应用/任务栏上：整段手势作废
      }
    } else if (!press.dead && Date.now() - press.t > MAX_PRESS_MS) {
      press.dead = true;                          // 按太久（卡死保护）：不再触发
    }
    return;
  }
  // 松手：先结清鼠标手势（按下期间的 press 在上面分支里登记）
  const settled = press;
  press = null;
  if (settled && !settled.dead) {
    const now = Date.now();
    if (now - lastFire >= DEBOUNCE_MS) {
      const end = cursorPoint();
      const dir = evaluateSwipe(settled, end);
      if (dir) { fire(dir, end); return; }   // 鼠标路径已触发，本次不走 flick
    }
  }

  // ---- 触摸兜底（55 轮追记）：触摸按下不置 VK_LBUTTON，靠轨迹横扫判定 ----
  if (hasTouchHardware()) {
    const now = Date.now();
    const pt = cursorPoint();
    if (pt && isDesktopPoint(pt)) {
      const n = samples.length;
      if (n >= 2) {
        const p = samples[n - 1];
        // 瞬移步（触摸点按把合成光标一步跳过来）：清轨迹防毒化后续窗口，
        // 只保留新点当新轨迹的起点（守卫细则见 TELEPORT_STEP_PX 注释）
        if (Math.hypot(pt.x - p.x, pt.y - p.y) > TELEPORT_STEP_PX) {
          samples.length = 0;
        }
      }
      samples.push({ x: pt.x, y: pt.y, t: now });
    } else {
      samples.length = 0;         // 出了桌面（进了应用/任务栏）：整段轨迹作废
    }
    while (samples.length && now - samples[0].t > FLICK_WINDOW_MS * 2) samples.shift();
    if (samples.length >= 2 && now - lastFire >= DEBOUNCE_MS) {
      const dir = evaluateFlick(samples, now);
      if (dir) {
        samples.length = 0;       // 一次横扫只切一张
        fire(dir, pt);
      }
    }
  }
}

/**
 * 启动轮询。options: { getEnabled: () => boolean,
 *                      onSwipe: (dir: 'next'|'prev', at: {x,y}) => void }
 * getEnabled 每次起手时现查（设置实时生效）。重复 start 幂等。
 */
function start(options) {
  opts = options || opts;
  if (timer) return;
  timer = setInterval(() => {
    try { tick(); } catch { /* 单拍失败静默跳过，别让轮询死掉 */ }
  }, POLL_MS);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  press = null;
  samples.length = 0;
  opts = null;
}

module.exports = {
  evaluateSwipe,
  evaluateFlick,
  DESKTOP_ROOT_CLASSES,
  isDesktopPoint,
  cursorPoint,
  hasTouchHardware,
  _setTouchOverride: setTouchOverride,
  start,
  stop,
  resetForTest: () => { press = null; lastFire = 0; samples.length = 0; },
  CONST: { POLL_MS, MIN_DX, DX_DY_RATIO, MAX_PRESS_MS, DEBOUNCE_MS, VK_LBUTTON, GA_ROOT, FLICK_WINDOW_MS, FLICK_MIN_SPAN_MS, TELEPORT_STEP_PX },
};
