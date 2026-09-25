'use strict';

/**
 * 动态桌面的原生宿主层：找挂载点 + 把窗口挂进桌面图标下面。
 *
 * 与 `desktopWallpaper.js` 的分工：
 *   那个管「写系统壁纸」（换图型）；这个管「把窗口挂到桌面图标下面」（动态型）。
 *
 * ---------------------------------------------------------------------------
 * 一、为什么不能用网上那套写法
 * ---------------------------------------------------------------------------
 *
 * 流传最广的写法是「EnumWindows → 找类名 `WorkerW` 且**没有** `SHELLDLL_DefView` 子窗口 → `SetParent` 过去」。
 * 在本机（Windows 11 25H2 build 26200.8875）实测**必然出错**：
 *   系统里本来就有 **14 个**顶层 `WorkerW`，全是 202×56、不可见、无子窗口 ——
 *   它们同时满足「类名是 WorkerW」和「没有 DefView」，于是那套算法会挑中其中一个，
 *   `SetParent` 还返回**成功**，屏幕上却什么都不出现、代码也不报任何错（**静默失效**）。
 *
 * 实测真值（见 `docs/任务书-动态桌面.md` §2.1 / §2.12 / §2.13）：
 *   - `SHELLDLL_DefView`（图标层）在 **`Progman`** 里，`Progman` 句柄全程稳定；
 *   - 发 `0x052C` 造出来的 `WorkerW` 反而是 **`Progman` 的子窗口**（不是顶层兄弟），
 *     而且**每写一次系统壁纸就被 Explorer 销毁重建一次**（实测 4/4 同点，间隔 30 秒）。
 *
 * ⇒ 本模块的口径：**挂"持有 `SHELLDLL_DefView` 的那个窗口"**（本机是 `Progman`，老式布局下才是 `WorkerW`），
 *   再把自己插到 `DefView` 的**下一层**。这样既不依赖 `0x052C`，也不受壁纸写入影响。
 *
 * ---------------------------------------------------------------------------
 * 二、挂载四步（缺一不可）
 * ---------------------------------------------------------------------------
 *   1. `SetParent(our, holder)`            —— 改变父子关系
 *   2. `SetWindowLongPtrW(GWL_STYLE)`      —— **补上 `WS_CHILD`**！
 *      `SetParent` 不会自动加这个样式，少了它窗口会「挂上了但不显示」（非常常见的坑）。
 *   3. `SetWindowLongPtrW(GWL_EXSTYLE)`    —— 补 `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`
 *      （不进 Alt+Tab、不抢焦点；`Electron` 的 `focusable:false` 只影响它自己的窗口管理）
 *   4. `SetWindowPos(our, defView, ...)`   —— 插到图标层下面（`hWndInsertAfter` = 放到它**之后**= 更下层）
 *
 * ---------------------------------------------------------------------------
 * 三、DPI
 * ---------------------------------------------------------------------------
 * 任何取坐标的 GDI 调用**之前**必须 `ensureDpiAwareness()`。本机两块屏都是 150% 缩放，
 * 进程不声明 DPI 感知时 `GetWindowRect` 返回的是虚拟化 DIP ——
 * 实测会读到 `3627×1707 @(-1067,0)`，而物理真值是 `5440×2560 @(-1600,0)`。
 * 拿错坐标去 `SetWindowPos`，窗口会小一圈并偏移（而且是**每个方法都看不出来**的那种错）。
 *
 * ---------------------------------------------------------------------------
 * 四、可单测性
 * ---------------------------------------------------------------------------
 * `chooseMountParent` / `judgeWorkerWCandidates` / `findDefView` 是**纯函数**：
 * 只吃一个普通对象（`snapshot()` 的产物，或手写的假数据），不碰 koffi、不碰系统。
 * 单测（`tools/test-desktop-host.js`）喂假窗口树即可覆盖四条判定表与各种失败分支。
 */

const koffi = require('koffi');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** Explorer 用来「造一个 WorkerW 挂载层」的私有消息（退路方案才需要） */
const WM_SPAWN_WORKERW = 0x052C;

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;

/** `GetWindow` 的取值：同级中 Z 序在我们**之上紧邻**的那个窗口 */
const GW_HWNDPREV = 3;

const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_VISIBLE = 0x10000000;
/** 标题栏+对话框边框。⚠️ 挂成子窗口后必须剥掉：非客户区边框会把客户区
 * （= 网页内容区）啃掉一圈 —— 实测本机左/右/下各 11px、顶部 0（DWM 边框扩展），
 * 表现为「桌面四周露出系统壁纸」。 */
const WS_CAPTION = 0x00C00000;
/** 可调大小边框，同上必须剥掉 */
const WS_THICKFRAME = 0x00040000;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_TOOLWINDOW = 0x00000080;

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
/** 强制重算非客户区（改 GWL_STYLE 后必须带一次，否则边框不消失） */
const SWP_FRAMECHANGED = 0x0020;

const SMTO_NORMAL = 0x0000;

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** 虚拟桌面尺寸容差：允许 ±8px（不同 DPI 取整会有 1~2px 出入） */
const SIZE_TOLERANCE = 8;

/** 子窗口递归深度：实测有用的层级是 Progman → DefView → SysListView32，4 层足够 */
const MAX_DEPTH = 4;
const MAX_TOP_LEVEL = 4000;
const MAX_CHILDREN = 200;

const DEFVIEW_CLASS = 'SHELLDLL_DefView';

// ---------------------------------------------------------------------------
// 纯函数层（不依赖 Windows，可单测）
// ---------------------------------------------------------------------------

/** 把窗口树拍平成数组（深度优先） */
function flatten(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n);
    if (n.children && n.children.length) flatten(n.children, out);
  }
  return out;
}

/**
 * 找图标层 `SHELLDLL_DefView` 以及**持有它的那个窗口**。
 *
 * 注意：DefView 不一定在顶层 —— 本机实测它在 `Progman` 里面；
 * 老式布局下它在某个顶层 `WorkerW` 里面。所以必须整棵树找，不能只看顶层。
 *
 * @param {object} snap 窗口树快照
 * @returns {{defView: object|null, holder: object|null, error: string|null}}
 */
function findDefView(snap) {
  const all = flatten(snap && snap.topLevel);
  const defView = all.find((n) => n.cls === DEFVIEW_CLASS) || null;
  if (!defView) {
    return { defView: null, holder: null, error: `整棵树里找不到 ${DEFVIEW_CLASS}（桌面图标层不在，桌面可能没起来）` };
  }
  const holder = all.find((n) => n.hwnd === defView.parentHwnd) || null;
  if (!holder) {
    return { defView, holder: null, error: `找到了 ${DEFVIEW_CLASS}，但它的父窗口不在快照里（parentHwnd=0x${(defView.parentHwnd || 0).toString(16)}）` };
  }
  return { defView, holder, error: null };
}

/**
 * 挑挂载父窗口 + 插入锚点。**纯函数**，喂假快照即可测。
 *
 * 判定顺序（第一条通过就用，不再往下试）：
 *   ① holder 是 `Progman`        → 首选。句柄实测全程稳定，且不受系统壁纸写入影响
 *   ② holder 是 `WorkerW`        → 老式布局，挂它也成立（但要留意它可能被 Explorer 重建）
 *   ③ 其它类名                   → 不支持，报错退出（**绝不将就挂**）
 *
 * @param {object} snap 窗口树快照
 * @param {{allowWorkerWHolder?: boolean}} [options]
 * @returns {{
 *   ok: boolean, strategy: string, reason: string,
 *   parentHwnd: number, parentCls: string|null,
 *   insertAfterHwnd: number|null,
 *   checks: Array<{name: string, pass: boolean, detail: string}>,
 * }}
 */
function chooseMountParent(snap, options = {}) {
  const allowWorkerWHolder = options.allowWorkerWHolder !== false;
  const checks = [];
  const add = (name, pass, detail) => { checks.push({ name, pass, detail }); };

  const { defView, holder, error } = findDefView(snap);
  add('找到桌面图标层 SHELLDLL_DefView', Boolean(defView), error || `hwnd=0x${(defView.hwnd || 0).toString(16)}`);
  if (!defView) {
    return { ok: false, strategy: 'none', reason: error, parentHwnd: 0, parentCls: null, insertAfterHwnd: null, checks };
  }

  add('图标层的父窗口在快照里', Boolean(holder), holder ? `${holder.cls} hwnd=0x${holder.hwnd.toString(16)}` : '缺失');
  if (!holder) {
    return { ok: false, strategy: 'none', reason: error, parentHwnd: 0, parentCls: null, insertAfterHwnd: null, checks };
  }

  const isProgman = holder.cls === 'Progman';
  const isWorkerW = holder.cls === 'WorkerW';
  add('挂载父窗口类名受支持（Progman / WorkerW）', isProgman || isWorkerW, `实际是 ${holder.cls}`);
  add('父窗口句柄非空', holder.hwnd > 0, `0x${(holder.hwnd || 0).toString(16)}`);
  add('图标层可见', defView.visible === true, `visible=${defView.visible}`);

  if (isProgman) {
    add('holder 属于 explorer.exe', holder.pid === snap.explorerPid, `pid=${holder.pid} / explorer=${snap.explorerPid}`);
    return {
      ok: true,
      strategy: 'progman',
      reason: 'Progman 直接持有图标层，句柄实测稳定（不受系统壁纸写入影响）',
      parentHwnd: holder.hwnd,
      parentCls: holder.cls,
      insertAfterHwnd: defView.hwnd,
      checks,
    };
  }

  if (isWorkerW && allowWorkerWHolder) {
    add('holder 属于 explorer.exe', holder.pid === snap.explorerPid, `pid=${holder.pid} / explorer=${snap.explorerPid}`);
    return {
      ok: true,
      strategy: 'workerw-holder',
      reason: '老式布局：图标层在顶层 WorkerW 里，挂它（注意该 WorkerW 可能被 Explorer 重建）',
      parentHwnd: holder.hwnd,
      parentCls: holder.cls,
      insertAfterHwnd: defView.hwnd,
      checks,
    };
  }

  return {
    ok: false,
    strategy: 'none',
    reason: `图标层的父窗口是 ${holder.cls}，不在支持范围内 —— 拒绝挂载（宁可退回静态壁纸，也不挂到不确定的窗口上）`,
    parentHwnd: 0,
    parentCls: holder.cls,
    insertAfterHwnd: null,
    checks,
  };
}

/**
 * 退路方案用：给顶层 `WorkerW` 逐个打分。
 *
 * 这是给「Progman 方案在 PoC 里失败」准备的，也是 §2.1 那张判定表本身 ——
 * 用来**证伪**网上那套「找没有 DefView 的 WorkerW」：本机 14 个 WorkerW 会全部落选。
 *
 * 四条判据全部成立才 pass：
 *   ① 在发 `0x052C` **之后**才出现（拿发之前的句柄集合取差集）
 *   ② 尺寸 ≈ 虚拟桌面（排除 202×56 那些）
 *   ③ `IsWindowVisible` 为真
 *   ④ 属于 explorer.exe 进程
 *
 * @param {object} snap 窗口树快照
 * @param {number[]|null} preSpawnHandles 发 0x052C **之前**的顶层 WorkerW 句柄集合；传 null 表示未知（① 记 null）
 */
function judgeWorkerWCandidates(snap, preSpawnHandles = null) {
  const vd = (snap && snap.virtualDesktop) || { w: 0, h: 0 };
  const top = (snap && snap.topLevel) || [];
  return top
    .filter((n) => n.cls === 'WorkerW')
    .map((n) => {
      const isNew = Array.isArray(preSpawnHandles) ? !preSpawnHandles.includes(n.hwnd) : null;
      const sizeOk = Math.abs(n.rect.w - vd.w) <= SIZE_TOLERANCE && Math.abs(n.rect.h - vd.h) <= SIZE_TOLERANCE;
      const visible = n.visible === true;
      const explorerOwned = n.pid === snap.explorerPid;
      const checks = {
        isNew: { pass: isNew === true, detail: isNew === null ? '未知（没给发消息前的快照）' : String(isNew) },
        sizeOk: { pass: sizeOk, detail: `${n.rect.w}×${n.rect.h} vs 虚拟桌面 ${vd.w}×${vd.h}` },
        visible: { pass: visible, detail: String(n.visible) },
        explorerOwned: { pass: explorerOwned, detail: `pid=${n.pid} vs explorer=${snap.explorerPid}` },
      };
      return {
        hwnd: n.hwnd,
        rect: n.rect,
        checks,
        pass: Object.values(checks).every((c) => c.pass),
      };
    });
}

// ---------------------------------------------------------------------------
// 原生层
// ---------------------------------------------------------------------------

let api = null;
let loadError = null;
let dpiState = null;
let RectTy = null;
let PointTy = null;

function ensureTypes() {
  if (RectTy) return;
  // 类型名加前缀：koffi 的类型表是**进程级**的，和别的模块撞名会互相覆盖
  RectTy = koffi.struct('WpDesktopHostRect', {
    left: 'long', top: 'long', right: 'long', bottom: 'long',
  });
  PointTy = koffi.struct('WpDesktopHostPoint', { x: 'long', y: 'long' });
}

function load() {
  if (api || loadError) return api;
  try {
    ensureTypes();
    const u = koffi.load('user32.dll');
    const k32 = koffi.load('kernel32.dll');
    const g32 = koffi.load('gdi32.dll');
    api = {
      u32: u,
      k32,
      CreateRectRgn: g32.func('void *CreateRectRgn(int x1, int y1, int x2, int y2)'),
      GetDesktopWindow: u.func('void *GetDesktopWindow()'),
      FindWindowExW: u.func('void *FindWindowExW(void *parent, void *after, str16 cls, str16 title)'),
      FindWindowW: u.func('void *FindWindowW(str16 cls, str16 title)'),
      IsWindow: u.func('bool IsWindow(void *hWnd)'),
      IsWindowVisible: u.func('bool IsWindowVisible(void *hWnd)'),
      GetParent: u.func('void *GetParent(void *hWnd)'),
      GetWindow: u.func('void *GetWindow(void *hWnd, uint32 cmd)'),
      GetAncestor: u.func('void *GetAncestor(void *hWnd, uint32 flags)'),
      GetClassNameW: u.func('int GetClassNameW(void *hWnd, _Out_ uint16 *buf, int cch)'),
      GetWindowTextW: u.func('int GetWindowTextW(void *hWnd, _Out_ uint16 *buf, int cch)'),
      GetWindowRect: u.func('bool GetWindowRect(void *hWnd, _Out_ WpDesktopHostRect *r)'),
      GetClientRect: u.func('bool GetClientRect(void *hWnd, _Out_ WpDesktopHostRect *r)'),
      ClientToScreen: u.func('bool ClientToScreen(void *hWnd, _Out_ WpDesktopHostPoint *pt)'),
      GetWindowThreadProcessId: u.func('uint32 GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *pid)'),
      SetParent: u.func('void *SetParent(void *hWndChild, void *hWndNewParent)'),
      SetWindowPos: u.func('bool SetWindowPos(void *hWnd, void *hWndInsertAfter, int X, int Y, int cx, int cy, uint32 flags)'),
      GetSystemMetrics: u.func('int GetSystemMetrics(int nIndex)'),
      SendMessageTimeoutW: u.func('intptr_t SendMessageTimeoutW(void *hWnd, uint32 msg, uintptr_t wParam, intptr_t lParam, uint32 flags, uint32 timeout, _Out_ uintptr_t *result)'),
      SetProcessDpiAwarenessContext: u.func('bool SetProcessDpiAwarenessContext(intptr_t value)'),
      SetProcessDPIAware: u.func('bool SetProcessDPIAware()'),
      OpenProcess: k32.func('void *OpenProcess(uint32 access, bool inherit, uint32 pid)'),
      QueryFullProcessImageNameW: k32.func('bool QueryFullProcessImageNameW(void *hProcess, uint32 flags, _Out_ uint16 *buf, _Inout_ uint32 *size)'),
      CloseHandle: k32.func('bool CloseHandle(void *h)'),
      // SetWindowLongPtrW 只在 x64 的 user32 里导出；本项目只发 x64 包
      GetWindowLongPtrW: u.func('intptr_t GetWindowLongPtrW(void *hWnd, int index)'),
      SetWindowLongPtrW: u.func('intptr_t SetWindowLongPtrW(void *hWnd, int index, intptr_t value)'),
      SetWindowRgn: u.func('int SetWindowRgn(void *hWnd, void *hRgn, bool bRedraw)'),
    };
  } catch (err) {
    loadError = err;
  }
  return api;
}

function available() {
  return Boolean(load());
}

/** 数值化一个窗口句柄（koffi 的指针不能直接比较 / 序列化） */
function addr(ptr) {
  if (!ptr) return 0;
  try { return Number(koffi.address(ptr)); } catch { return 0; }
}

/**
 * 声明进程 DPI 感知。**必须在任何取坐标的 GDI 调用之前**调用。
 *
 * 顺序：PerMonitorV2（Win10 1703+）→ PerMonitor（Win8.1+，shcore）→ SystemAware（Vista+）。
 * 返回用了哪个，`'failed'` 表示三级都失败（那时坐标不可信，调用方应放弃）。
 */
function ensureDpiAwareness() {
  if (dpiState) return dpiState;
  const a = load();
  if (!a) { dpiState = 'unavailable'; return dpiState; }

  try {
    if (a.SetProcessDpiAwarenessContext(-4)) { dpiState = 'per-monitor-v2'; return dpiState; }
  } catch { /* 老系统没这个导出，往下退 */ }

  try {
    const shcore = koffi.load('shcore.dll');
    const r = shcore.func('int32 SetProcessDpiAwareness(int value)')(2);
    if (r === 0 || r === -2147024891) { dpiState = 'per-monitor'; return dpiState; } // 0=OK，0x80070005=已经设过
  } catch { /* 继续退 */ }

  try {
    if (a.SetProcessDPIAware()) { dpiState = 'system-aware'; return dpiState; }
  } catch { /* ignore */ }

  dpiState = 'failed';
  return dpiState;
}

function textOf(hWnd) {
  const a = load();
  const buf = Buffer.alloc(512 * 2);
  const n = a.GetWindowTextW(hWnd, koffi.as(buf, 'uint16 *'), 512);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

function classNameOf(hWnd) {
  const a = load();
  const buf = Buffer.alloc(256 * 2);
  const n = a.GetClassNameW(hWnd, koffi.as(buf, 'uint16 *'), 256);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

function pidOf(hWnd) {
  const a = load();
  const buf = koffi.alloc('uint32', 1);
  a.GetWindowThreadProcessId(hWnd, buf);
  return koffi.decode(buf, 'uint32');
}

/** 进程镜像全路径；取不到返回 null（**绝不按进程名匹配**，见用户记忆里的铁律） */
function exeOf(pid) {
  if (!pid) return null;
  const a = load();
  const h = a.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!h || addr(h) === 0) return null;
  try {
    const buf = Buffer.alloc(1024 * 2);
    const sizeBuf = koffi.alloc('uint32', 1);
    koffi.encode(sizeBuf, 'uint32', 1024);
    if (!a.QueryFullProcessImageNameW(h, 0, koffi.as(buf, 'uint16 *'), sizeBuf)) return null;
    const n = koffi.decode(sizeBuf, 'uint32');
    return n > 0 ? buf.toString('utf16le', 0, n * 2) : null;
  } finally {
    a.CloseHandle(h);
  }
}

function rectOf(hWnd) {
  const a = load();
  const buf = koffi.alloc(RectTy, 1);
  if (!a.GetWindowRect(hWnd, buf)) return { x: 0, y: 0, w: 0, h: 0 };
  const r = koffi.decode(buf, RectTy);
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
}

/** 客户区尺寸（外框矩形 - 客户区 = Electron frameless 的隐形调整边框） */
function clientSizeOf(hWnd) {
  const a = load();
  const buf = koffi.alloc(RectTy, 1);
  if (!a.GetClientRect(hWnd, buf)) return { w: 0, h: 0 };
  const r = koffi.decode(buf, RectTy);
  return { w: r.right, h: r.bottom };
}

/** 客户区原点的屏幕坐标 */
function clientOriginScreen(hWnd) {
  const a = load();
  const buf = koffi.alloc(PointTy, 1);
  koffi.decode(buf, PointTy);               // 清零
  if (!a.ClientToScreen(hWnd, buf)) return { x: 0, y: 0 };
  const p = koffi.decode(buf, PointTy);
  return { x: p.x, y: p.y };
}

/**
 * 实测当前窗口的隐形边框（Electron frameless 天生带：外框 - 客户区）。
 * 与窗口当前位置无关，随时可测。返回 {l,t,r,b} 物理像素。
 *
 * ⚠️ 只允许在「未补偿」状态下测（mount 流程内）。补偿完成后客户区原点已经
 * 贴合目标矩形，再测恒为 0 —— reaffirmZOrder 若现场重量就会把补偿打回原形
 * （2026-09-25 二次实锤：mount 补偿 ok → 看门狗重申 → 左/右/下 10px 缝复发）。
 * 补偿后的重申一律用 mount 缓存值（frameInsetsCache）。
 */
function frameInsetsOf(hWnd) {
  const wr = rectOf(hWnd);                  // GetWindowRect 对子窗口也返回屏幕坐标（本机实测）
  const cs = clientSizeOf(hWnd);
  const co = clientOriginScreen(hWnd);
  const l = co.x - wr.x;
  const t = co.y - wr.y;
  return { l, t, r: wr.w - cs.w - l, b: wr.h - cs.h - t };
}

/** hwnd → {l,t,r,b}：mount 时实测的隐形边框缓存（补偿后的重申必须用它） */
const frameInsetsCache = new Map();

/** 顶层窗口句柄列表（Z 序，最前面的先出）。
 *  ⚠️ 不用 `GetWindow(hwnd, GW_HWNDFIRST)` —— 那常量是「同级里的第一个」，
 *     桌面窗口没有同级，会永远返回 0，看起来像"系统里没有窗口"（见 dialogDriver.js 注释）。 */
function topLevelHandles() {
  const a = load();
  const out = [];
  let h = a.FindWindowExW(a.GetDesktopWindow(), null, null, null);
  let guard = 0;
  while (h && addr(h) !== 0 && guard < MAX_TOP_LEVEL) {
    out.push(h);
    h = a.FindWindowExW(a.GetDesktopWindow(), h, null, null);
    guard += 1;
  }
  return out;
}

function childHandles(parent) {
  const a = load();
  const out = [];
  let h = a.FindWindowExW(parent, null, null, null);
  let guard = 0;
  while (h && addr(h) !== 0 && guard < MAX_CHILDREN) {
    out.push(h);
    h = a.FindWindowExW(parent, h, null, null);
    guard += 1;
  }
  return out;
}

/** 把窗口做成可 JSON 序列化的节点（`parentHwnd` 是找挂载点的关键） */
/** DWM 披蔽（cloak）检测：IsWindowVisible=true 但 DWM 根本不合成上屏的窗口
 *  （锁屏界面、Windows 输入体验、UWP 宿主框架等）。做「屏幕上什么位置被占」
 *  这类判断时必须排除，否则会把整个屏幕误判成被盖住。 */
let _dwmGetWindowAttribute = null;
function cloakOf(hWnd) {
  if (_dwmGetWindowAttribute === null) {
    try {
      const d = koffi.load('dwmapi.dll');
      _dwmGetWindowAttribute = d.func('int32 DwmGetWindowAttribute(void *hwnd, uint32 attr, _Out_ uint32 *val, uint32 cb)');
    } catch {
      _dwmGetWindowAttribute = false;
    }
  }
  if (!_dwmGetWindowAttribute) return false;
  const out = koffi.alloc('uint32', 1);
  const r = _dwmGetWindowAttribute(hWnd, 14, out, 4);   // DWMWA_CLOAKED
  return r === 0 && koffi.decode(out, 'uint32') !== 0;
}

function nodeOf(hWnd, parentHwnd, depth, withExe = true) {
  const n = {
    hwnd: addr(hWnd),
    cls: classNameOf(hWnd),
    title: textOf(hWnd),
    rect: rectOf(hWnd),
    visible: Boolean(load().IsWindowVisible(hWnd)),
    cloaked: cloakOf(hWnd),
    pid: pidOf(hWnd),
    parentHwnd,
    children: [],
  };
  if (withExe) n.exe = exeOf(n.pid);
  if (depth > 0) {
    for (const c of childHandles(hWnd)) {
      n.children.push(nodeOf(c, n.hwnd, depth - 1, false));
    }
  }
  return n;
}

/**
 * 采集一次桌面窗口树快照。**只读**，不改任何窗口状态。
 *
 * @param {{monitors?: Array}} [options] 传入 `desktopWallpaper.enumMonitors().monitors`
 *        以复用项目既有的 devicePath → 物理矩形口径（**不要**自己算，见任务书 §2.4）
 */
function snapshot(options = {}) {
  const dpi = ensureDpiAwareness();
  const a = load();
  if (!a) {
    return { ok: false, error: loadError ? loadError.message : 'koffi 不可用', dpi };
  }

  const vd = {
    x: a.GetSystemMetrics(76), // SM_XVIRTUALSCREEN
    y: a.GetSystemMetrics(77), // SM_YVIRTUALSCREEN
    w: a.GetSystemMetrics(78), // SM_CXVIRTUALSCREEN
    h: a.GetSystemMetrics(79), // SM_CYVIRTUALSCREEN
  };

  const topLevel = topLevelHandles().map((h) => nodeOf(h, 0, MAX_DEPTH));

  const progmanNode = topLevel.find((n) => n.cls === 'Progman') || null;
  const explorerPid = progmanNode ? progmanNode.pid : null;

  return {
    ok: true,
    at: new Date().toISOString(),
    dpi,
    virtualDesktop: vd,
    monitors: options.monitors || [],
    explorerPid,
    progman: progmanNode,
    topLevel,
  };
}

/** 顶层 `WorkerW` 的句柄集合（给发消息前后的差集用） */
function snapshotWorkerWHandles(snap) {
  return (snap.topLevel || []).filter((n) => n.cls === 'WorkerW').map((n) => n.hwnd);
}

/**
 * 发 `0x052C` 让 Explorer 造一个 WorkerW 挂载层。**退路方案才需要** ——
 * 首选（挂 Progman）路径完全不依赖它。返回是否成功投递（不代表一定造出来了，要用快照 diff 判）。
 */
function sendSpawnMessage(timeoutMs = 1000) {
  const a = load();
  if (!a) return { ok: false, error: loadError ? loadError.message : 'koffi 不可用' };
  const progman = a.FindWindowW('Progman', null);
  if (!progman || addr(progman) === 0) return { ok: false, error: '找不到 Progman 窗口' };
  const out = koffi.alloc('uintptr_t', 1);
  const r = a.SendMessageTimeoutW(progman, WM_SPAWN_WORKERW, 0, 0, SMTO_NORMAL, timeoutMs, out);
  return { ok: true, result: Number(r), progman: addr(progman) };
}

/**
 * 挂载：把 `hwnd` 挂到 `parentHwnd` 下、插到 `insertAfterHwnd` 之后（Z 序更下层）。
 *
 * @param {number} hwnd 我们的窗口句柄（数值地址）
 * @param {number} parentHwnd 挂载父窗口
 * @param {number} insertAfterHwnd 插到它之后（通常是 SHELLDLL_DefView）
 * @param {{x:number,y:number,w:number,h:number}} [bounds] 目标矩形（虚拟桌面物理坐标）
 */
function mount(hwnd, parentHwnd, insertAfterHwnd, bounds) {
  const a = load();
  if (!a) return { ok: false, step: 'load', error: loadError ? loadError.message : 'koffi 不可用' };
  if (!hwnd) return { ok: false, step: 'args', error: 'hwnd 为空' };
  if (!parentHwnd) return { ok: false, step: 'args', error: 'parentHwnd 为空' };

  const self = koffi.as(hwnd, 'void *');
  const parent = koffi.as(parentHwnd, 'void *');
  const insertAfter = insertAfterHwnd ? koffi.as(insertAfterHwnd, 'void *') : null;

  // 1. 父子关系
  const prevParent = a.SetParent(self, parent);
  const setParentErr = !prevParent && addr(prevParent) === 0 ? 'SetParent 失败（返回 NULL）' : null;
  if (setParentErr && addr(a.GetParent(self)) !== parentHwnd) {
    return { ok: false, step: 'SetParent', error: setParentErr };
  }

  // 2. 样式补 WS_CHILD（**SetParent 不会自动加**，少了它窗口挂上了但不显示）。
  //    同时剥掉 WS_CAPTION / WS_THICKFRAME：子窗口带边框样式时，非客户区会
  //    把客户区（网页内容区）内缩一圈（本机实测左/右/下各 11px、顶部 0），
  //    窗口矩形看着是满屏的，内容却铺不满 → 桌面四周露出系统壁纸。
  const style = Number(a.GetWindowLongPtrW(self, GWL_STYLE));
  const newStyle = ((style & ~WS_POPUP) | WS_CHILD | WS_VISIBLE) & ~(WS_CAPTION | WS_THICKFRAME);
  a.SetWindowLongPtrW(self, GWL_STYLE, newStyle);

  // 3. 扩展样式：不抢焦点、不进 Alt+Tab
  const ex = Number(a.GetWindowLongPtrW(self, GWL_EXSTYLE));
  a.SetWindowLongPtrW(self, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW);

  // 4. 插到图标层之后。
  //    ⚠️ 坐标语义①：WS_CHILD 的 SetWindowPos 坐标是**父窗口客户区相对坐标**，
  //    而调用方传的是虚拟桌面物理坐标（含多屏负偏移）。Progman 的客户区原点
  //    = 虚拟桌面左上角（本机副屏在最左，是 (-1600,0)，不是 (0,0)）——
  //    阶段 0 的 PoC 单屏没炸纯属「原点恰好是 (0,0)」的巧合，多屏必错位。
  //    这里统一减掉父窗口原点换算。
  //    ⚠️ 坐标语义②：SetWindowPos 的 x/y/w/h 定的是**外框矩形**，而 Electron
  //    frameless 窗口天生带隐形调整边框（本机实测 L/R/B 各 ~10px 物理、T=0），
  //    客户区（=网页内容区）= 外框 - 边框。直接设满屏 → 内容被啃一圈，
  //    桌面四周露出系统壁纸（2026-09-25 真机抓屏实锤）。
  //    所以分两步：先摆到目标矩形量出实际边框，再把外框矩形放大补偿，
  //    让**客户区**精确落在目标矩形上。
  const pb = rectOf(parent);
  const b = bounds || { x: pb.x, y: pb.y, w: pb.w, h: pb.h };
  const relX = b.x - pb.x, relY = b.y - pb.y;
  if (!a.SetWindowPos(self, insertAfter, relX, relY, b.w, b.h,
    SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED)) {
    return { ok: false, step: 'SetWindowPos', error: 'SetWindowPos 失败' };
  }
  // 量实际边框：客户区原点（换算到父客户区相对）与刚 SetWindowPos 的位置之差
  const co = clientOriginScreen(self);
  const cs = clientSizeOf(self);
  const dl = (co.x - pb.x) - relX;              // 左边框
  const dt = (co.y - pb.y) - relY;              // 顶边框
  const wr = rectOf(self);
  const dr = (wr.w - cs.w) - dl;                // 右边框
  const db = (wr.h - cs.h) - dt;                // 底边框
  const okPos = a.SetWindowPos(self, insertAfter,
    relX - dl, relY - dt, b.w + dl + dr, b.h + dt + db,
    SWP_NOACTIVATE | SWP_SHOWWINDOW);
  console.log(`[desktop-host] 边框补偿: L=${dl} T=${dt} R=${dr} B=${db} 第二次SetWindowPos=${okPos ? 'ok' : 'FAIL'}`);
  // 缓存实测边框：reaffirmZOrder 之后必须用这份值（补偿状态下现场测量恒为 0）
  frameInsetsCache.set(hwnd, { l: dl, t: dt, r: dr, b: db });

  // 5. 窗口区域裁剪到客户区（= 目标矩形）：补偿把外框向四周扩了一圈边框宽度，
  //    那圈「隐形边框」条会**越界压到相邻显示器上**且不渲染内容 —— 透出壁纸、
  //    还把相邻屏的舞台盖在下面（2026-09-25 像素实锤：主屏外框左伸 10px 压住
  //    竖屏右缘，缝高 y=0..2170 与主屏外框底边 2170 完全一致，y>2170 竖屏自己
  //    画得好好的）。SetWindowRgn 把窗口占据的像素裁到客户区后，边框条不再
  //    属于本窗口，相邻屏恢复显示。区域是窗口相对坐标，窗口移动/重申都自适应。
  const hrgn = a.CreateRectRgn(dl, dt, dl + b.w, dt + b.h);
  const okRgn = hrgn ? Boolean(a.SetWindowRgn(self, hrgn, true)) : false;
  console.log(`[desktop-host] 窗口区域裁剪: (${dl},${dt})-(${dl + b.w},${dt + b.h}) ok=${okRgn}`);

  return {
    ok: Boolean(okPos),
    step: okPos ? 'done' : 'SetWindowPos',
    error: okPos ? null : 'SetWindowPos 失败',
    style: { before: style, after: newStyle },
    exStyle: { before: ex, after: ex | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW },
    frame: { l: dl, t: dt, r: dr, b: db },      // 调试用：实测的隐形边框宽度
  };
}

/** 把窗口脱离桌面树并恢复成普通窗口（退出/回滚时用） */
function unmount(hwnd) {
  const a = load();
  frameInsetsCache.delete(hwnd);            // 句柄值可能被系统复用，缓存必须跟着清
  if (!a || !hwnd) return { ok: false, error: 'koffi 不可用或 hwnd 为空' };
  const self = koffi.as(hwnd, 'void *');
  a.SetWindowRgn(self, null, true);         // 撤掉 mount 的窗口区域裁剪，否则还原后的普通窗口仍被裁
  const style = Number(a.GetWindowLongPtrW(self, GWL_STYLE));
  a.SetWindowLongPtrW(self, GWL_STYLE, (style & ~WS_CHILD) | WS_POPUP);
  a.SetParent(self, null);
  return { ok: true };
}

/**
 * 挂载后的自检（看门狗判据）：
 *   ① 我们自己的窗口还在（`IsWindow`）
 *   ② 父窗口还在（`IsWindow(parent)`）
 *   ③ `GetParent(our) === parent`（不等 ⇒ 已变孤儿，需要「先隐藏再重挂」）
 *   ④ 如果我们有插入锚点，锚点还在
 */
function assertMount(hwnd, parentHwnd, insertAfterHwnd) {
  const a = load();
  if (!a) return { ok: false, error: 'koffi 不可用' };
  const self = koffi.as(hwnd, 'void *');
  const parent = koffi.as(parentHwnd, 'void *');
  const alive = Boolean(a.IsWindow(self));
  const parentAlive = Boolean(a.IsWindow(parent));
  const actualParent = alive ? addr(a.GetParent(self)) : 0;
  const attached = parentAlive && actualParent === parentHwnd;
  const anchorAlive = insertAfterHwnd ? Boolean(a.IsWindow(koffi.as(insertAfterHwnd, 'void *'))) : null;
  return {
    ok: alive && attached,
    alive,
    parentAlive,
    attached,
    actualParent,
    anchorAlive,
    orphan: parentAlive && !attached,
  };
}

/**
 * Z 序自检：我们是不是**紧贴锚点之下**的那一个（即图标层上面没有别的窗口压着我们）。
 *
 * 为什么需要这个而不只是 `assertMount`：
 *   2026-09-24 实测 —— 每写一次系统壁纸，Explorer 重建子 WorkerW 并把它插到
 *   `SHELLDLL_DefView` 之后，于是**我们被挤到下一层、被新 WorkerW 完全盖住**。
 *   这时 `assertMount` 依然报 `attached: true`（父子关系确实没变），
 *   但屏幕上我们的画面已经没了 —— **只看父子关系会漏判**。
 *   判据必须是「Z 序里紧挨着我上面的就是锚点」。
 */
/**
 * Z 序自检：从 hwnd 沿「上一个窗口」链走到锚点（图标层），沿途必须全是自己人。
 *
 * 多屏下所有舞台都是同一个锚点的兄弟 —— 第二块挂上来必然把第一块顶下去一位，
 * 「紧邻我上面的必须是锚点」这个旧判据会让 N 块屏互相误报、看门狗让它们
 * 轮流重申、无限打架（e2e 实测：日志每 2s 刷一轮重申）。所以允许沿途碰到
 * harmless 里的兄弟舞台；真正夹进来的外人（Explorer 插的 WorkerW）会让
 * 链路走不通，判为失效。
 *
 * @param {number|object} hwnd 我们的窗口
 * @param {number|object} anchorHwnd 锚点（SHELLDLL_DefView）
 * @param {number[]|Set<number>} [harmless] 允许出现在链上的兄弟舞台句柄（number）
 * @returns {boolean}
 */
function isZOrderIntact(hwnd, anchorHwnd, harmless = null) {
  const a = load();
  if (!a || !hwnd || !anchorHwnd) return false;
  const anchorNum = typeof anchorHwnd === 'number' ? anchorHwnd : addr(anchorHwnd);
  const okSet = harmless instanceof Set ? harmless
    : Array.isArray(harmless) ? new Set(harmless.map((h) => (typeof h === 'number' ? h : addr(h))))
    : null;
  let cur = hwnd;
  for (let i = 0; i < 64; i += 1) {          // 64 步封顶：防异常窗口树把这里变成死循环
    const prev = a.GetWindow(koffi.as(cur, 'void *'), GW_HWNDPREV);
    const prevNum = prev ? addr(prev) : 0;
    if (!prevNum) return false;              // 走到链顶都没碰到锚点 ⇒ 失效
    if (prevNum === anchorNum) return true;  // 到锚点为止沿途都是自己人
    if (okSet && okSet.has(prevNum)) { cur = prevNum; continue; }
    return false;                            // 中间夹了外人 ⇒ 被挤住了
  }
  return false;
}

/** 重申 Z 序：把窗口重新插到锚点之后（Progman 重绘后不需要重挂，只需要这一句）。
 *  bounds 是虚拟桌面物理坐标，内部换算成父客户区相对坐标（同 mount，见那里）。
 *  ⚠️ 带 bounds 时**必须做隐形边框补偿**（同 mount）：否则看门狗每次重申都会把
 *  mount 里补偿好的外框矩形打回原形，客户区又被啃掉一圈（2026-09-25 实锤）。
 *  ⚠️ 补偿值用 mount 缓存（frameInsetsCache），**不能现场重新量**：补偿状态下
 *  客户区原点已贴合目标矩形，量出来恒为 0，等于把补偿清零（左边 10px 缝复发）。
 *  缓存缺失（理论不该发生）才回落现场测量。 */
function reaffirmZOrder(hwnd, insertAfterHwnd, bounds) {
  const a = load();
  if (!a || !hwnd) return { ok: false, error: 'koffi 不可用或 hwnd 为空' };
  const self = koffi.as(hwnd, 'void *');
  let x = 0; let y = 0; let w = 0; let h = 0;
  let flags = SWP_NOMOVE | SWP_NOSIZE;
  if (bounds) {
    const parent = a.GetParent(self);
    const pb = parent ? rectOf(parent) : { x: 0, y: 0 };
    const inf = frameInsetsCache.get(hwnd) || frameInsetsOf(self);
    x = bounds.x - pb.x - inf.l;
    y = bounds.y - pb.y - inf.t;
    w = bounds.w + inf.l + inf.r;
    h = bounds.h + inf.t + inf.b;
    flags = 0;
    // 区域裁剪是窗口相对坐标，理论上随窗口自适应；这里幂等重申一次，
    // 防止被外部清掉后边框条重新越界压到相邻显示器（成本低）。
    const hrgn = a.CreateRectRgn(inf.l, inf.t, inf.l + bounds.w, inf.t + bounds.h);
    if (hrgn) a.SetWindowRgn(self, hrgn, true);
  }
  return {
    ok: Boolean(a.SetWindowPos(
      self,
      insertAfterHwnd ? koffi.as(insertAfterHwnd, 'void *') : null,
      x, y, w, h,
      flags | SWP_NOACTIVATE
    )),
  };
}

function diagnose() {
  return {
    ok: available(),
    error: loadError ? loadError.message : null,
    dpi: dpiState,
  };
}

function release() {
  api = null;
}

module.exports = {
  // 纯函数（单测直接喂假快照）
  flatten,
  findDefView,
  chooseMountParent,
  judgeWorkerWCandidates,
  // 原生
  available,
  diagnose,
  ensureDpiAwareness,
  snapshot,
  snapshotWorkerWHandles,
  sendSpawnMessage,
  mount,
  unmount,
  assertMount,
  isZOrderIntact,
  reaffirmZOrder,
  classNameOf,
  rectOf,
  pidOf,
  exeOf,
  release,
  CONST: {
    WM_SPAWN_WORKERW,
    WS_CHILD, WS_POPUP, WS_VISIBLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    GWL_STYLE, GWL_EXSTYLE,
    SWP_NOSIZE, SWP_NOMOVE, SWP_NOACTIVATE, SWP_SHOWWINDOW,
    SIZE_TOLERANCE, DEFVIEW_CLASS,
  },
};
