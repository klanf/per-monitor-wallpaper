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
 * 触摸屏：触摸按下/移动由 Windows 合成鼠标输入，GetAsyncKeyState(VK_LBUTTON)
 * / GetCursorPos 照常读得到，无需单独处理 WM_TOUCH。
 *
 * ---------------------------------------------------------------------------
 * 三、可单测性
 * ---------------------------------------------------------------------------
 * evaluateSwipe 是纯函数（只算位移），DESKTOP_ROOT_CLASSES 常量导出，
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
    };
  } catch (err) {
    loadError = err;
  }
  return api;
}

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

function tick() {
  const a = load();
  if (!a) return;
  const down = (a.GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0;
  if (down) {
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
  if (!press) return;
  const start = press;
  press = null;                                   // 松手：一次手势终结，无论成不成交
  if (start.dead) return;
  const now = Date.now();
  if (now - lastFire < DEBOUNCE_MS) return;
  const end = cursorPoint();
  const dir = evaluateSwipe(start, end);
  if (!dir) return;
  lastFire = now;
  try { opts && opts.onSwipe && opts.onSwipe(dir, end); } catch { /* 回调自炸别带垮轮询 */ }
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
  opts = null;
}

module.exports = {
  evaluateSwipe,
  DESKTOP_ROOT_CLASSES,
  isDesktopPoint,
  cursorPoint,
  start,
  stop,
  resetForTest: () => { press = null; lastFire = 0; },
  CONST: { POLL_MS, MIN_DX, DX_DY_RATIO, MAX_PRESS_MS, DEBOUNCE_MS, VK_LBUTTON, GA_ROOT },
};
