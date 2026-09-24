'use strict';

/**
 * 动态桌面（live desktop）策略层。
 *
 * 这个文件只做「该不该做某事」的判定，**全是纯函数**：不碰 koffi、不碰 Electron、
 * 不碰文件系统。调度器和看门狗都只是它的调用方 —— 这样每条判定都能喂假数据单测，
 * 而不必在真机上反复验证（真机验证的代价是会覆盖用户的桌面）。
 *
 * ---------------------------------------------------------------------------
 * 本文件当前负责：动态模式下还要不要写系统壁纸
 * ---------------------------------------------------------------------------
 *
 * 背景（实测，见 `docs/任务书-动态桌面.md` §2.14 / §2.16）：
 *
 *   1. 动态窗口是挂在 `Progman` 下、插在 `SHELLDLL_DefView`（图标层）**之后**的；
 *   2. 每写一次**系统壁纸**，Explorer 会在 `Progman` 下新建一个 `WorkerW` 并插到
 *      `SHELLDLL_DefView` 之后 —— 我们的窗口因此被挤到更下层，**画面被完全盖住**
 *      （实测覆盖率 1.0 → 0）；
 *   3. 看门狗重申 Z 序能救回来，但中间有 0.6~1 秒屏幕上是系统壁纸。
 *
 * 应用现在的节奏是每 40 秒写一次（两块屏各一路 ⇒ 实测约 30 秒一次），也就是说：
 * **每 30 秒桌面闪一下**。这与「每次都写系统壁纸当兜底」直接冲突。
 *
 * ---------------------------------------------------------------------------
 * 口径（2026-09-24 用户拍板，方案 A「降频写」）
 * ---------------------------------------------------------------------------
 *
 * 动态桌面开着时，系统壁纸只在**锚点时机**写一次：
 *
 *   - `takeover` —— 启动接管 / 重建。换相簿、改配置、插拔显示器都会走它，
 *                  所以「启动」和「换相簿」两个时机被这一条覆盖。
 *   - `stop`     —— 停止动态桌面之前（关开关、退出应用）补写当前帧。
 *
 * 其余时机（`timer` 定时换图 / `command` 手动翻页 / `goto` 跳转 / `manual` /
 * `file-mutation` 文件变动）动态窗口自己会变，系统壁纸**不必跟**。
 *
 * 代价（已接受）：锁屏界面、以及程序崩掉之后看到的，是「最近一次锚点时那张」，
 * 不保证是最新那张。换来的是桌面不再周期性闪烁。
 *
 * 三个例外仍然会恢复「每轮都写」：
 *   - `applyToSystem === false` —— 总开关关着，从来就不写（现状语义，不变）；
 *   - `degraded === true` —— 动态窗口已失效（挂载失败 / 被拆掉且重申无救），
 *     此时显示职责交回系统壁纸，必须每轮都写，否则桌面会停在一张死图上；
 *   - `live === false` —— 动态桌面没开，保持原有行为。
 */

/**
 * 动态模式下仍然会写系统壁纸的「锚点时机」。
 *
 * ⚠️ 这个集合是**白名单**：不在这里的 reason 一律不写。新增写入原因时，
 * 如果不确定该不该写，默认不写（动态窗口本来就会显示新图），
 * 只有「动态窗口没在显示、或刚从没显示恢复」的时机才需要进来。
 */
const LIVE_ANCHOR_REASONS = new Set(['takeover', 'stop']);

/**
 * 调度器目前会用到的全部写入原因（仅用于校验/日志，不参与判定）。
 *
 * 来源：`src/scheduler.js` 的三处 `_write(...)` 调用点，
 * 以及 `goTo` 的 reason 形参（句柄默认 `manual`）。
 */
const KNOWN_WRITE_REASONS = new Set([
  'takeover',        // 启动接管 / 重建（换相簿、改配置、插拔显示器）
  'timer',           // 定时轮播到下一张
  'command',         // 手动下一张 / 上一张（step）
  'goto',            // 渲染层跳转（胶片条点击等）
  'manual',          // goTo 的默认值
  'file-mutation',   // 当前图被移动 / 删除，列表就地更新后补写
  'stop',            // 停止动态桌面 / 退出应用前补写（新增时机，见 anchorSystem）
]);

/**
 * 动态桌面模式下，这一次写入要不要真的落到系统壁纸上？
 *
 * @param {object} ctx
 * @param {boolean} [ctx.live=false]          动态桌面是否已开启（配置项 liveDesktop）
 * @param {boolean} [ctx.applyToSystem=true]  「是否真正写系统壁纸」总开关
 * @param {string}  ctx.reason                写入原因（见 KNOWN_WRITE_REASONS）
 * @param {boolean} [ctx.degraded=false]      动态窗口是否已失效（挂载失败 / 被拆且重申无救）
 * @returns {{ write: boolean, why: string }} write = 要不要写；why = 判定依据（写日志 / 显 UI 用）
 */
function shouldWriteSystem(ctx) {
  // 显式写 `ctx || {}` 而不是只在形参上给默认值：形参默认值**只在 undefined 时生效**，
  // 传 null 会直接解构抛错。调用方从配置里取出来的值完全可能是 null。
  const { live = false, applyToSystem = true, reason, degraded = false } = ctx || {};
  if (!applyToSystem) return { write: false, why: 'system-off' };
  if (!live) return { write: true, why: 'live-off' };
  if (degraded) return { write: true, why: 'degraded-fallback' };
  if (LIVE_ANCHOR_REASONS.has(reason)) return { write: true, why: 'live-anchor' };
  return { write: false, why: 'live-throttled' };
}

/** 这个 reason 是不是锚点时机（单独导出，便于打日志与断言） */
function isAnchorReason(reason) {
  return LIVE_ANCHOR_REASONS.has(reason);
}

module.exports = {
  shouldWriteSystem,
  isAnchorReason,
  LIVE_ANCHOR_REASONS,
  KNOWN_WRITE_REASONS,
};
