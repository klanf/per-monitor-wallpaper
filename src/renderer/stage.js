'use strict';

/**
 * 动态桌面舞台 —— 无 UI 的纯净渲染页。
 *
 * 这是挂在桌面图标**下面**那块窗口的页面（liveStage.js 创建窗口并挂到 Progman）。
 * 与主窗口 app.js 的分工：那边是「带全套 UI 的预览器 + 缩略图」，这边只做一件事
 * —— 把当前频道该显示的那张图，用全尺寸、全屏物理像素画出来。
 *
 * ---------------------------------------------------------------------------
 * 与主窗口渲染的四个关键差别
 * ---------------------------------------------------------------------------
 *
 * 1. **原图通道**：走 wpimg://（preload 的 stageUrl）拿全尺寸原文件，
 *    不是 wpthumb:// 的 256px 缩略图 —— 全屏物理像素下缩略图就是马赛克。
 *
 * 2. **canvas 而不是 <img>**：原图先解码再画进「屏幕物理像素大小」的 canvas，
 *    然后立即 close() 位图。8K 图原始解码约 132MB，双图层交叉淡入同时常驻
 *    就是 264MB；canvas 4K 约 33MB/层。解码位图只在换图瞬间存在一次。
 *
 * 3. **JS 驱动一切动画**：过渡和 Ken Burns 都由这里的 rAF tick 写 style，
 *    不用 CSS transition / animation —— 纯 CSS 动画跑在合成器里，
 *    rAF 节流对它无效（任务书 §2.8），fpsCap 就管不住帧了。
 *
 * 4. **contain 的四周用同图模糊填充**（2026-09-24 拍板）：露出的不是系统壁纸
 *    —— 系统壁纸是「填充」裁切，与 contain 的裁切对不上，同屏两种裁法会穿帮。
 *
 * 暂停语义（拍板）：全停 —— 阶段 3 接 powerMonitor 后，暂停 = 停 rAF，含 Ken Burns。
 */

/* ------------------------------------------------------------------ 常量 */

const REST = { x: 0, y: 0, s: 1, o: 1 };   // 层的静止状态

/**
 * Ken Burns：极慢的整体缩放呼吸（周期 45s，1.00→1.045→1.00）。
 * 让桌面有「生命感」的效果。⚠️ 必须是**连续**的：
 *  - 只缩放、无位移（缩放 ≥1 永不露边；位移要在四边留 travel 余量，还得靠基础放大盖住）；
 *  - 相位永不重置（2026-09-25 真机：过渡结束 ken.start 归零 + 换随机方向 ⇒
 *    画布从 scale=1/offset=0 瞬跳到 scale=1.02/offset=±14px ——「切换完成一瞬间整体偏移」）。
 */
const KEN = { period: 45_000, amplitude: 0.045 };

/**
 * 呼吸缩放（profile.breath）：比 Ken Burns 快一档的匀称呼吸（6s 一吸一呼，±2%）。
 * 与 Ken Burns 叠加时是两个振荡相乘，视觉上「大潮」里带「小潮」。
 * ⚠️ 同样必须连续：用 cos 从 0 相位起步（scale 从 1 平滑出发），永不重置相位。
 */
const BREATH = { period: 6_000, amplitude: 0.02 };

/** resize 后重绘的防抖 */
const RESIZE_DEBOUNCE = 200;

/* ------------------------------------------------------------------ 状态 */

let myChannel = null;          // 本窗口绑定的频道 id（stage:bind 指定）
let channels = [];             // 频道信息表（channels:changed 维护）
let currentEntry = null;       // 当前帧（resize 重绘要用）
let currentDir = 1;

const cfg = {
  animation: 'slide',
  duration: 900,      // 过渡时长 ms：520/620 用户实测偏快，900 起才有「电影感」
  fit: 'cover',
  fpsCap: 60,         // 30 在 60Hz 屏上过渡明显掉帧；60 = 跟满垂直同步
  kenBurns: true,              // Ken Burns 微缩放开关（profile.kenBurns=false 关）
  videoPlayFull: false,        // 视频播完再切（profile.videoPlayFull；开=不循环，ended 通知调度器）
  breath: false,               // 呼吸缩放（profile.breath；与 Ken Burns 叠加）
  particles: '',               // 粒子特效（profile.particles；'random' = 每次换图抽一种）
  particlePool: [],            // 粒子随机池（r21 profile.particlePool；空数组 = 全部参与）
  depthEnabled: true,          // 深度视差（profile.depthParallax=false 关；默认开）
  depthFlow: true,             // DepthFlow POM 模式（profile.depthFlow=false 回退第五轮单平面；
                               // 离线逐帧对比 5 相位全帧差 ≈2.5 噪声级后默认开，真机验收后落库）
  depthAmp: 0.07,              // 视差幅度（profile.depthAmp）
  depthDrift: 1.0,             // 自动漂移速度倍率（profile.depthDrift）
  depthLight: 0.45,            // 灯光强度（profile.depthLight）
  // ---- DepthFlow 流模式参数（Circle 预设默认值；profile 同名键）----
  flowStyle: 'circle',         // 动效轨迹：circle 环绕 / orbital 摆动环绕 / dolly 推拉变焦
  flowIntensity: 0.5,          // 轨迹幅度（0.5 = Circle 预设；鼠标接管幅度同源）
  flowIso: 0.6,                // 斜视角（越大立体越强、越歪）
  flowSteady: 0.3,             // 背景稳定点（越大背景越稳、前景越动）
  flowHeight: 0.2,             // 视差强度主旋钮（DepthState.height 默认）
  flowQuality: 0.5,            // POM 步进质量 0.15~1（0.5=DepthFlow CLI 默认；0.3≈省 30% GPU）
  idleFx: false,               // idle 微动画（r62，profile.idleFx）：呼吸+飘动+差速视差（mask 前景）
  depthAtmo: false,            // 分层氛围总开关（r71，profile.depthAtmo）：调色板光照+雾+金边
  atmoPalette: 'auto',         // 氛围调色板（r73）：auto=按时间（白天/黄昏）；golden/tealorange/cyberpunk/moonlight/faded=固定档
  pointerFx: true,             // 鼠标影响动效（r70，profile.pointerFx）：开=镜头被鼠标临时接管；关=恒走预设轨迹（profile 不写 = 默认开）
  particleDepth: true,         // 粒子深度遮挡（r74，profile.particleDepth）：开=前景挡住粒子（雨/雪/樱花首批；需深度图，无深度自动跳过）
  cropPan: true,               // 鼠标平移裁切（r37，profile.cropPan=false 关；只对铺满裁切且图片有溢出时生效）
};

// ---- 分层氛围（r73）：调色板档位选择 + 缓动 ----
// auto：按系统时间白天/黄昏两档（用户实测清晨与白天不明显→并入白天，夜晚档删）。
// 固定调色板（设置页选，社区公认分级）：黄金时刻/青橙好莱坞/赛博朋克/月光蓝/褪色胶片。
// 档位切换每帧 0.08 缓动（切调色板不跳变，途经档位自然渐变）；auto 交界由关键帧插值承担。
const ATMO_AUTO_FRAMES = [[0, 0], [6, 0], [16.5, 0], [18, 1], [20.5, 1], [21.5, 0], [24, 0]];
const ATMO_PALETTE_SEL = { golden: 2, tealorange: 3, cyberpunk: 4, moonlight: 5, faded: 6 };
let atmoSel = 0;               // 当前档位（浮点，向 target 缓动）
let atmoTargetCache = null;    // auto 档 60s 缓存的时钟目标
let atmoTargetAt = 0;
function atmoTargetNow() {
  const pal = cfg.atmoPalette || 'auto';
  if (pal !== 'auto') return ATMO_PALETTE_SEL[pal] || 0;
  const now = performance.now();
  if (atmoTargetCache === null || now - atmoTargetAt > 60000) {
    const d = new Date();
    const hr = d.getHours() + d.getMinutes() / 60;
    const F = ATMO_AUTO_FRAMES;
    atmoTargetCache = 0;
    for (let i = 1; i < F.length; i++) {
      if (hr <= F[i][0]) {
        const [h0, p0] = F[i - 1];
        const [h1, p1] = F[i];
        atmoTargetCache = p0 + (p1 - p0) * ((hr - h0) / Math.max(0.01, h1 - h0));
        break;
      }
    }
    atmoTargetAt = now;
  }
  return atmoTargetCache;
}
function atmoSelNow() {
  const t = atmoTargetNow();
  atmoSel += (t - atmoSel) * 0.08;
  if (Math.abs(t - atmoSel) < 0.002) atmoSel = t;
  return atmoSel;
}

const layers = {
  A: null, B: null,            // { root, canvas, ctx }，init 时填充
};
let active = 'B';

let animToken = 0;             // 过渡令牌：新过渡让进行中的旧过渡作废
let anim = null;               // { t0, duration, incoming, outgoing, v }
let rafId = 0;
let lastPaint = 0;             // fpsCap 时间闸门
const ken = { start: 0 };      // Ken Burns 相位（永不重置 —— 重置就是跳变）
/** 裁切平移（r37）：平滑后的窗口偏移，x/y ∈ [-0.5, 0.5]，0 = 居中。
 *  鼠标活动期间目标值跟随鼠标，停手 2.5s（与视差镜头的 mouseUntil 同源）后缓回 0。 */
const pan = { x: 0, y: 0, dirty: false };

/** 拼接填充（r38）：2D 拼接显示期间留存格位（位图+深度位图），
 *  depth:ready 把缺的格补齐后整体升级 GL。GL 直接上屏时置 active=false。 */
const collage = { active: false, n: 1, slots: [] };
let myChannelIndex = 0;        // 本频道当前 index（tick/applyChannels 更新）——拼格取邻居用
let activeVideo = null;        // 当前在播的 <video>（视频壁纸时非空，图片/网页壁纸为 null）
let particleFx = null;         // 粒子层句柄（particles.js，init 时绑定 #particles）

/** 全屏 / 锁屏暂停（stage:pause）：冻结 = 停 rAF，画面钉在当前帧 */
let frozen = false;

/** 深度视差层是否在显示（true 时 2D 图层的 Ken Burns / 重画都要让路） */
let glActive = false;

/** 本次会话是否成功上屏过任何一帧（2D 或 GL）。解冻自愈用：
 *  启动时若撞上暂停，bind 显示可能被冻结打断成半截 —— 解冻时若一帧都没画过
 *  就强制重显当前 entry，而不是干等下一个 60s 调度 tick（黑屏到那时）。 */
let everRendered = false;

/** 渲染端诊断日志 → 主进程落 live-debug.log。必须定义在模块顶层：
 *  showFrame（顶层函数）和 init 内的升级处理器都要用 —— 上一版定义在 init
 *  里面，showFrame 一调用就 ReferenceError，壁纸直接卡住不上屏（2026-10-09 实锤）。 */
function slog(...a) {
  try { window.wp.stageLog(a.join(' ')); } catch (_) { /* 日志永不影响主流程 */ }
}
let t0GL = performance.now();     // GL 时钟起点（漂移/灯光相位）

let resizeTimer = 0;

/* ------------------------------------------------------------------ 基础工具 */

function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * cubic-bezier(x1,y1,x2,y2) 缓动求解 —— 与主窗口 --ease 同一条曲线
 * （0.22, 0.61, 0.36, 1），保证动态桌面和预览窗的过渡手感一致。
 * 标准做法：t→x 用二分，x→t 反解后代回 y。精度 1e-4 足够（16 位颜色都分辨不出）。
 */
function easeCubicBezier(p) {
  const x1 = 0.22, y1 = 0.61, x2 = 0.36, y2 = 1;
  // 贝塞尔 x(t) = 3(1-t)²t·x1 + 3(1-t)t²·x2 + t³
  const bx = (t) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  let lo = 0, hi = 1, t = p;
  for (let i = 0; i < 24; i += 1) {
    t = (lo + hi) / 2;
    if (bx(t) < p) lo = t; else hi = t;
  }
  return by(t);
}

/**
 * 过渡变体。两种形态：
 *  - 变换型：{ u, fromT, fromO, toT, toO } —— animTick 用统一插值公式驱动（A 档 3 种沿用）；
 *  - 自绘型：{ tick(incoming, outgoing, e) } —— 每帧自己写 clip-path / mask / filter
 *    （clip 类动画没法用「位移+缩放+透明度」表达）。自绘型的图层 z 序由 showFrame
 *    统一设为 incoming 在上（clip 揭示语义必须如此），结束/打断时 clearFx 清干净。
 */
function variantFor(animation, dir) {
  const sign = dir >= 0 ? 1 : -1;
  switch (animation) {
    case 'fade':
      return { u: 'px', fromT: { x: 0, y: 0, s: 1 }, fromO: 0, toT: { x: 0, y: 0, s: 1 }, toO: 0 };
    case 'zoom':
      return { u: 'px', fromT: { x: 0, y: 0, s: 1.07 }, fromO: 0, toT: { x: 0, y: 0, s: 0.985 }, toO: 0 };
    case 'zoom-in':   // 新图从中心放大收进来盖住旧图
      return { u: 'px', fromT: { x: 0, y: 0, s: 1.18 }, fromO: 0, toT: { x: 0, y: 0, s: 1 }, toO: 0 };
    case 'zoom-out':  // 新图从小放大到满屏
      return { u: 'px', fromT: { x: 0, y: 0, s: 0.72 }, fromO: 0, toT: { x: 0, y: 0, s: 1 }, toO: 0 };
    case 'slide-zoom': // 滑动 + 新图从 1.12 缩到 1，进退感更强
      return { u: '%', fromT: { x: sign * 100, y: 0, s: 1.12 }, fromO: 1, toT: { x: -sign * 100, y: 0, s: 1 }, toO: 1 };
    case 'slide':
      return { u: '%', fromT: { x: sign * 100, y: 0, s: 1 }, fromO: 1, toT: { x: -sign * 100, y: 0, s: 1 }, toO: 1 };
    case 'wipe': {     // 幕布擦除：dir=1 从左往右，dir=-1 从右往左
      return { tick(i, o, e) {
        const r = (100 - e * 100).toFixed(2);
        i.root.style.clipPath = sign > 0 ? `inset(0 ${r}% 0 0)` : `inset(0 0 0 ${r}%)`;
      } };
    }
    case 'iris':       // 圆形扩散（75% 半径盖住四角，对角线 70.7%）
      return { tick(i, o, e) {
        i.root.style.clipPath = `circle(${(e * 75).toFixed(2)}% at 50% 50%)`;
      } };
    case 'blur-dissolve': // 旧图模糊消散、新图从模糊中变清晰
      return { tick(i, o, e) {
        i.root.style.opacity = String(e);
        i.root.style.filter = `blur(${((1 - e) * 24).toFixed(1)}px)`;
        o.root.style.opacity = String(1 - e);
        o.root.style.filter = `blur(${(e * 18).toFixed(1)}px)`;
      } };
    case 'clock': {    // 时钟扫描：以中心为轴顺时针扫一圈（扇形多边形，60 段足够圆滑）
      const SEGS = 60;
      return { tick(i, o, e) {
        const th = e * Math.PI * 2;
        const pts = ['50% 50%'];
        for (let n = 0; n <= SEGS; n += 1) {
          const a = -Math.PI / 2 + th * (n / SEGS);   // 12 点方向起扫
          pts.push(`${(50 + 75 * Math.cos(a)).toFixed(2)}% ${(50 + 75 * Math.sin(a)).toFixed(2)}%`);
        }
        i.root.style.clipPath = `polygon(${pts.join(',')})`;
      } };
    }
    case 'blinds': {   // 百叶窗：8 条横带同步向下揭开（蛇形多边形 = 不相交条带的单闭合路径）
      const N = 8;
      return { tick(i, o, e) {
        const B = 100 / N;
        const r = e * B;
        const pts = ['0% 0%', '100% 0%', `100% ${r.toFixed(2)}%`, `0% ${r.toFixed(2)}%`];
        for (let n = 1; n < N; n += 1) {
          const top = n * B;
          pts.push(`0% ${top.toFixed(2)}%`, `100% ${top.toFixed(2)}%`,
            `100% ${(top + r).toFixed(2)}%`, `0% ${(top + r).toFixed(2)}%`);
        }
        i.root.style.clipPath = `polygon(${pts.join(',')})`;
      } };
    }
    case 'split': {    // 分屏合拢：上下两半从屏幕外推进，在中线会合
      return { tick(i, o, e) {
        const r = (e * 50).toFixed(2);
        i.root.style.clipPath =
          `polygon(0% 0%,100% 0%,100% ${r}%,0% ${r}%,0% ${100 - Number(r)}%,100% ${100 - Number(r)}%,100% 100%,0% 100%)`;
      } };
    }
    default:
      return { u: '%', fromT: { x: sign * 100, y: 0, s: 1 }, fromO: 1, toT: { x: -sign * 100, y: 0, s: 1 }, toO: 1 };
  }
}

/** random：每轮换图随机挑一种（showFrame 时决定，同一次过渡内不变） */
const RANDOM_POOL = ['fade', 'zoom', 'slide', 'zoom-in', 'zoom-out', 'slide-zoom',
  'wipe', 'iris', 'blur-dissolve', 'clock', 'blinds', 'split'];

/** 抽本次过渡的动画名（2D 与 GL 共用；random 每次独立抽签，同一次过渡内不变） */
function pickAnimName() {
  return cfg.animation === 'random'
    ? RANDOM_POOL[Math.floor(Math.random() * RANDOM_POOL.length)]
    : (cfg.animation || 'fade');
}

/** GL 侧变体（r76）：GL 过渡此前写死交叉淡化 —— 深度管线稳定后几乎每张图都走 GL，
 *  设置里选的切换动画（尤其 random）在桌面上等于失效。变换型（zoom/slide 系）用
 *  「核心矩形平移+缩放」在 GL 里等价复刻（参数与 2D variantFor 对齐，见 glDrawLayer）；
 *  自绘型（wipe/iris 等 clip 系）GL 片元表达不了，降级 fade —— 视差连续性优先，
 *  少了擦除花样也不能让整幅瞬跳。返回 null = 现行交叉淡化。 */
const GL_VARIANT_DOWNGRADE_LOGGED = new Set();
function glVariantFor(animation, dir) {
  const sign = dir >= 0 ? 1 : -1;
  switch (animation) {
    case 'fade':
      return null;
    case 'zoom':
      return { from: { dx: 0, dy: 0, s: 1.07 }, fromO: 0, to: { dx: 0, dy: 0, s: 0.985 }, toO: 0 };
    case 'zoom-in':   // 新图从中心放大收进来盖住旧图
      return { from: { dx: 0, dy: 0, s: 1.18 }, fromO: 0, to: { dx: 0, dy: 0, s: 1 }, toO: 0 };
    case 'zoom-out':  // 新图从小放大到满屏
      return { from: { dx: 0, dy: 0, s: 0.72 }, fromO: 0, to: { dx: 0, dy: 0, s: 1 }, toO: 0 };
    case 'slide':     // 平移换位，全程不透明（进出两侧用同一缓动 → 边缘严丝合缝）
      return { from: { dx: sign, dy: 0, s: 1 }, fromO: 1, to: { dx: -sign, dy: 0, s: 1 }, toO: 1 };
    case 'slide-zoom':
      return { from: { dx: sign, dy: 0, s: 1.12 }, fromO: 1, to: { dx: -sign, dy: 0, s: 1 }, toO: 1 };
    default:          // wipe/iris/blur-dissolve/clock/blinds/split → 降级 fade（只提示一次）
      if (!GL_VARIANT_DOWNGRADE_LOGGED.has(animation)) {
        GL_VARIANT_DOWNGRADE_LOGGED.add(animation);
        slog(`GL 过渡：${animation} 暂不支持，降级 fade（视差连续性优先）`);
      }
      return null;
  }
}

/** 过渡结束/被打断后清掉所有自绘型残留（clip/mask/filter/z 序），回到干净静止态 */
function clearFx(el) {
  el.style.clipPath = '';
  el.style.maskImage = '';
  el.style.maskSize = '';
  el.style.maskRepeat = '';
  el.style.filter = '';
  el.style.zIndex = '';
}

function setLayer(el, t, o, unit) {
  el.style.transform = `translate3d(${t.x}${unit}, ${t.y}${unit}, 0) scale(${t.s})`;
  el.style.opacity = String(o);
}

/* ------------------------------------------------------------------ 帧绘制 */

function canvasSize(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(window.innerWidth * dpr));
  const h = Math.max(1, Math.round(window.innerHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h };
}

function coverRect(W, H, bw, bh, scale = 1) {
  const r = Math.max(W / bw, H / bh) * scale;
  const w = bw * r, h = bh * r;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

function containRect(W, H, bw, bh) {
  const r = Math.min(W / bw, H / bh);
  const w = bw * r, h = bh * r;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

/**
 * 把解码位图画进 canvas（这一步就是降采样：位图多大都行，落点只有屏幕大小）。
 * 位图用完必须 close() —— 由调用方负责。
 */
function paintLayer(layer, bmp) {
  drawSource(layer, bmp, bmp.width, bmp.height);
}

/**
 * 通用绘制：src 可为 ImageBitmap（静态图，画一次就完）或 <video>（视频壁纸，
 * rAF 每帧重画拿最新帧）。sw/sh = 源宽高（videoWidth/videoHeight）。
 */
function drawSource(layer, src, sw, sh, panPos) {
  const { w: W, h: H } = canvasSize(layer.canvas);
  const ctx = layer.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.clearRect(0, 0, W, H);

  if (cfg.fit === 'contain') {
    // 四周：同一张图 cover 画满 + 模糊（放大 12% 让模糊边缘落在画布外，不露透明底）
    ctx.save();
    ctx.filter = `blur(${Math.max(12, Math.round(Math.min(W, H) * 0.03))}px)`;
    const bg = coverRect(W, H, sw, sh, 1.12);
    ctx.drawImage(src, bg.x, bg.y, bg.w, bg.h);
    ctx.restore();
    ctx.filter = 'none';
    const core = containRect(W, H, sw, sh);
    ctx.drawImage(src, core.x, core.y, core.w, core.h);
  } else if (cfg.fit === 'mirror') {
    // 完整核心 + 镜像延展补满（r36）：以 contain 核心为原胞向四周镜像平铺，
    // 奇数格翻转 —— 与 GL 侧 texMirror 同一套数学，两条路径观感一致。
    drawMirrorFill(ctx, W, H, src, sw, sh);
  } else {
    const r = coverRect(W, H, sw, sh);
    // 裁切平移（r37）：pan.x/y ∈ [-0.5, 0.5]，0 = 居中 —— 溢出方向上把裁切窗口
    // 滑向鼠标所指的那一侧。竖版图在横屏溢出在纵向（y 起作用），横版图在竖屏
    // 溢出在横向（x 起作用）；无溢出的轴 (W-r.w)=0 天然不动。
    const px = panPos ? (W - r.w) * (panPos.x + 0.5) : r.x;
    const py = panPos ? (H - r.h) * (panPos.y + 0.5) : r.y;
    ctx.drawImage(src, px, py, r.w, r.h);
  }
}

/**
 * 镜像延展填充（r36，fit=mirror 的 2D 实现）：
 * 核心（contain 矩形）画原图，四周按国际象棋镜像规则平铺 ——
 * 偶数格正、奇数格翻。多画一圈出界的格子，省得算精确边界。
 */
function drawMirrorFill(ctx, W, H, src, sw, sh) {
  const core = containRect(W, H, sw, sh);
  const cw = Math.max(1, core.w);
  const ch = Math.max(1, core.h);
  const i0 = Math.floor(-core.x / cw) - 1;
  const j0 = Math.floor(-core.y / ch) - 1;
  for (let j = j0; core.y + j * ch < H + ch; j += 1) {
    for (let i = i0; core.x + i * cw < W + cw; i += 1) {
      const fx = (i % 2 === 0) ? 1 : -1;
      const fy = (j % 2 === 0) ? 1 : -1;
      ctx.save();
      ctx.translate(core.x + i * cw, core.y + j * ch);
      if (fx < 0) { ctx.translate(cw, 0); ctx.scale(-1, 1); }
      if (fy < 0) { ctx.translate(0, ch); ctx.scale(1, -1); }
      ctx.drawImage(src, 0, 0, sw, sh, 0, 0, cw, ch);
      ctx.restore();
    }
  }
}

/* ------------------------------------------------------ 拼接填充（r38）----
 * 竖图配宽屏（或横图配竖屏）时，取相簿里**相邻的图**拼成 N 联铺满整屏：
 * 中心格 = 当前要显示的这张（右键删除/胶片条/进度的语义都不变），两侧 = 播放
 * 顺序里的前后邻居（顺序持久化保证跨重启稳定）。格数按「屏幕比例 ÷ 中心图
 * 比例」四舍五入自动算（1 格=退化成普通单图，竖屏配竖图自动不用拼）。
 * 拼好的图在管线里就是一张宽图：镜头/过渡/降采样全部复用，每格深度图按同样
 * 几何并排拼成宽深度图——三块面板各自立体、镜头同步运动。
 * 深度没生成的格先以 0.5 灰填平坦（shader 里 d-0.5=0 无视差），depth:ready
 * 补齐后整体从 2D 升级 GL（tryCollageUpgrade）。
 */

/** 把格位数组拼成两块屏幕大画布（图 + 深度）。深度缺的格填 0.5 灰=平坦。 */
function composeCollageCanvases(slots, W, H) {
  const imgCanvas = document.createElement('canvas');
  imgCanvas.width = W;
  imgCanvas.height = H;
  const ictx = imgCanvas.getContext('2d');
  const depCanvas = document.createElement('canvas');
  depCanvas.width = W;
  depCanvas.height = H;
  const dctx = depCanvas.getContext('2d');
  const n = slots.length;
  const sw = W / n;
  let allReady = true;
  for (let k = 0; k < n; k += 1) {
    const s = slots[k];
    const r = coverRect(sw, H, s.bmp.width, s.bmp.height);
    ictx.drawImage(s.bmp, r.x + k * sw, r.y, r.w, r.h);
    if (s.depBmp) {
      const dr = coverRect(sw, H, s.depBmp.width, s.depBmp.height);
      dctx.drawImage(s.depBmp, dr.x + k * sw, dr.y, dr.w, dr.h);
    } else {
      allReady = false;
      dctx.fillStyle = '#808080';
      dctx.fillRect(k * sw, 0, sw, H);
    }
  }
  return { imgCanvas, depCanvas, allReady };
}

/** 拼接整页步长回报（r75）：把「本幅拼了几格」告诉调度器，此后调度器按整页推进，
 *  相邻两幅拼图零重复。去重发送：同 n 不重复发；fit 离开拼接 / 退化单图回报 1。 */
let collagePageSent = 0;
function reportCollagePage(n) {
  const page = Math.max(1, Math.min(4, Math.round(Number(n) || 1)));
  if (page === collagePageSent) return;
  collagePageSent = page;
  try {
    const r = window.wp.channelCollagePage(myChannel, page);
    if (r && typeof r.catch === 'function') r.catch(() => { /* 步长回落 1：一格一格切 */ });
  } catch (_) { /* IPC 不通就算了 */ }
}

/** 拼接帧构建：中心图先行解码定格数 → 邻居条目 → 并行取图+查深度 → 拼画布。
 *  返回 {n:1, bmpSrc} = 退化单图（调用方走普通单图路径）；null = 构建失败。 */
async function buildCollageFrame(entry, token) {
  const { w: W, h: H } = canvasSize(layers.A.canvas);
  let centerBmp;
  try {
    centerBmp = await fetchBitmap(entry);
  } catch (err) {
    slog('拼接: 中心图取图失败 ——', err.message);
    return null;
  }
  if (token !== animToken) {
    try { centerBmp.close(); } catch (_) { /* 已关 */ }
    return null;
  }
  const n = Math.max(1, Math.min(4, Math.round((W / H) / (centerBmp.width / centerBmp.height))));
  if (n <= 1) return { n: 1, bmpSrc: centerBmp, w: W, h: H };

  // 邻居条目（主进程已跳过视频/网页；左右不够格用中心图兜底，绝不留黑格）
  let nb = { center: null, left: [], right: [] };
  try {
    nb = await window.wp.channelNeighbors(myChannel, myChannelIndex, Math.ceil(n / 2));
  } catch (_) { /* IPC 失败：全用中心图兜底 */ }
  const centerIdx = Math.floor((n - 1) / 2);
  const paths = new Array(n).fill(null);
  paths[centerIdx] = entry;
  for (let k = 1; k <= centerIdx; k += 1) paths[centerIdx - k] = nb.left[k - 1] || entry;
  for (let k = 1; k + centerIdx < n; k += 1) paths[centerIdx + k] = nb.right[k - 1] || entry;

  // 并行：每格取图 + 查深度（depthFor miss 返回 null 且主进程已入队后台生成）
  const slots = await Promise.all(paths.map(async (p, k) => {
    const sameCenter = !p || p.path === entry.path;
    let bmp = centerBmp;
    if (!sameCenter) {
      try { bmp = await fetchBitmap(p); } catch (_) { bmp = centerBmp; }
    }
    let depBmp = null;
    let depPath = null;
    try { depPath = await window.wp.depthFor((p || entry).path); } catch (_) { /* 查询失败按无深度 */ }
    if (depPath) {
      try { depBmp = await fetchBitmap({ path: depPath }); } catch (_) { depBmp = null; }
    }
    return { path: (p || entry).path, bmp, depBmp, isCenter: sameCenter };
  }));
  if (token !== animToken) {
    for (const s of slots) {
      if (!s.isCenter) { try { s.bmp.close(); } catch (_) { /* 已关 */ } }
      try { s.depBmp?.close(); } catch (_) { /* 已关 */ }
    }
    try { centerBmp.close(); } catch (_) { /* 已关 */ }
    return null;
  }
  const comp = composeCollageCanvases(slots, W, H);
  const readyN = slots.filter((s) => s.depBmp).length;
  slog(`拼接: n=${n} 深度 ${readyN}/${n}${comp.allReady ? '（齐，直接 GL）' : '（缺格先 2D，ready 后升级）'}`);
  return { n, slots, ...comp, aspect: W / H, w: W, h: H };
}

/** 2D 拼接上屏：逐格 cover 画进层画布（等价 drawSource 的拼贴版） */
function paintCollage(layer, col) {
  const { w: W, h: H } = canvasSize(layer.canvas);
  const ctx = layer.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.clearRect(0, 0, W, H);
  const sw = W / col.n;
  for (let k = 0; k < col.n; k += 1) {
    const bmp = col.slots[k].bmp;
    const r = coverRect(sw, H, bmp.width, bmp.height);
    ctx.drawImage(bmp, r.x + k * sw, r.y, r.w, r.h);
  }
}

/**
 * 取原图并解码。wpimg:// 是 no-store 的（不进 Chromium 磁盘缓存 —— 那缓存在 C 盘）。
 * ⚠️ 必须带超时（2026-10-09 副屏黑屏实锤）：启动期 wpimg 流可能被卡住且 fetch
 * **永不返回** —— 无超时 = 无回退、无日志，GL 分支整个 await 挂死，桌面黑到下一个
 * 调度 tick（用户观感「副屏要等切换壁纸才显示」且哪块屏黑随机）。8s 超时后重开
 * 一次新请求（卡住的流换一条大概率就好），再失败抛错走调用方兜底并落日志。
 */
async function fetchOnce(entry, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(window.wp.stageUrl(entry.path), { signal: ctl.signal });
    if (!res.ok) throw new Error(`wpimg ${res.status}`);
    return await res.blob();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBitmap(entry) {
  try {
    return await decodeClamped(await fetchOnce(entry, 8000));
  } catch (err) {
    slog('取图超时/失败，重开一次请求 ——', String(entry.path).split(/[\\/]/).pop(), err.message);
    return await decodeClamped(await fetchOnce(entry, 8000));
  }
}

/* ---- 纹理降采样（r35）----
 * 画布（canvasSize）和深度 GL 层都只显示到本屏物理分辨率，原图再大也是白解码
 * 白上传：8K 位图 = 132MB 内存 + 132MB 纹理上传，4K 屏上 3/4 是白费；GL 采样
 * 没有 mipmap，超大纹理硬缩小看反而出摩尔纹。这里在解码后把位图钳到
 * 「本屏 cover/contain 恰好铺满 × 1.05」：
 *   · 1.0 覆盖本屏；0.05 余量给 Ken Burns（最大 1.045）；
 *   · 深度 GL 流模式整图可见，遗留相机路径在默认 amp(0.07) 下放大 1.12 ——
 *     属「显示端放大」，钳制不改变它（来源过大时今天就已在被 GPU 缩小）。
 * 只缩不放：s ≥ 1（小图/已是屏幕级）原样返回，绝不拿插值硬放大。
 * 深度图（≤1024²）走同一入口，天然落在「不放大」分支，精度无损。
 * 失败兜底：resize 抛异常就用原图，2D/GL 两条路都吃过这条链，不能因省内存砸显示。
 */
const FIT_HEADROOM = 1.05;

function stageTargetScale(bw, bh) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(window.innerWidth * dpr));
  const H = Math.max(1, Math.round(window.innerHeight * dpr));
  // mirror 与 contain 同取「完整可见」的缩放口径（核心 = contain 矩形）
  const containLike = cfg.fit === 'contain' || cfg.fit === 'mirror';
  const fit = (containLike ? Math.min(W / bw, H / bh) : Math.max(W / bw, H / bh));
  return fit * FIT_HEADROOM;
}

async function decodeClamped(blob) {
  const bmp = await createImageBitmap(blob);
  const s = stageTargetScale(bmp.width, bmp.height);
  if (s >= 1) return bmp;   // 屏幕级以下：原样（含 contain 下的小图）
  try {
    const from = `${bmp.width}×${bmp.height}`;
    const small = await createImageBitmap(bmp, {
      resizeWidth: Math.max(1, Math.round(bmp.width * s)),
      resizeHeight: Math.max(1, Math.round(bmp.height * s)),
      resizeQuality: 'high',
    });
    bmp.close();
    slog(`纹理降采样: ${from} → ${small.width}×${small.height}`
      + `（本屏 ${Math.round(window.innerWidth * (window.devicePixelRatio || 1))}×${Math.round(window.innerHeight * (window.devicePixelRatio || 1))}）`);
    return small;
  } catch (err) {
    slog('纹理降采样失败，用原图 ——', err.message);
    return bmp;
  }
}

/* ------------------------- 阶段 4/5：视频 / 网页壁纸 ------------------------- */

/** 条目类型：video（.mp4/.webm）/ html（.html/.htm）/ image（其余） */
function kindOf(entry) {
  const m = /\.([a-z0-9]+)$/i.exec(entry.path || '');
  const ext = m ? '.' + m[1].toLowerCase() : '';
  if (ext === '.mp4' || ext === '.webm') return 'video';
  if (ext === '.html' || ext === '.htm') return 'html';
  return 'image';
}

/** 取/建图层私有的 <video>（muted —— 桌面壁纸必须静音；loop 由 videoPlayFull 决定） */
function videoOf(layer) {
  if (!layer.video) {
    const v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.autoplay = true;
    v.style.display = 'none';
    // videoPlayFull：不循环，播完（ended 只在 loop=false 时触发）通知调度器推进。
    // 推进失败（暂停中 / 当前已不是视频）就原地重播，视频不会停在最后一帧。
    v.addEventListener('ended', async () => {
      try {
        const r = await window.wp.stageVideoEnded(myChannel);
        if (!r || !r.advanced) { try { v.play().catch(() => {}); } catch (_) {} }
      } catch (_) { /* 静默 */ }
    });
    layer.root.appendChild(v);
    layer.video = v;
  }
  return layer.video;
}

/** 等 <video> 首帧解码完成；超时抛错 → 调度器下一轮换图 */
function waitVideoReady(v, timeoutMs = 10000) {
  if (v.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('video load failed')); };
    const timer = setTimeout(bad, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      v.removeEventListener('loadeddata', ok);
      v.removeEventListener('error', bad);
    }
    v.addEventListener('loadeddata', ok);
    v.addEventListener('error', bad);
  });
}

/** 取/建图层私有的 <iframe>（网页壁纸；盖在 canvas 上，过渡走 root 的 CSS 样式） */
function iframeOf(layer, url) {
  if (!layer.iframe) {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;'
      + 'border:0;background:#000;display:none;';
    // 只给脚本权限：壁纸 html 是用户自己丢进去的，不该碰舞台 DOM（无 allow-same-origin）
    f.setAttribute('sandbox', 'allow-scripts');
    layer.root.appendChild(f);
    layer.iframe = f;
  }
  if (layer.iframe.getAttribute('src') !== url) layer.iframe.setAttribute('src', url);
  layer.iframe.style.display = 'block';
  return layer.iframe;
}

/** 隐藏图层上的 iframe（换回图片/视频时） */
function hideIframe(layer) {
  if (layer.iframe) layer.iframe.style.display = 'none';
}

/** 停掉指定图层的视频（换图/切类型时释放解码器） */
function stopLayerVideo(layer) {
  if (layer.video && !layer.video.paused) layer.video.pause();
}

/* ------------------------------------------------------------------ 深度视差（WebGL） */

/**
 * 有深度 sidecar 的图片走这层渲染：相机自动漂移 + 两盏巡游彩灯 + 鼠标临时接管。
 * 没有依赖 Three.js —— 单 quad + 片元着色器，深度图由主进程 depthService 离线
 * 生成（depth:lookup 命中返回缓存路径）。任何环节失败都退回 2D 路径，绝不黑屏。
 *
 * 与 2D 路径的分工：本层盖在 layerA/B 之上（z-index 3）。
 *   - 有深度：2D 图层不上屏，GL 负责（含过渡交叉淡入）
 *   - 无深度：GL 只负责把旧视差画面淡出（若刚才是视差），2D 动画照常
 * 过渡说明：视差帧进/出统一用交叉淡入（slide/zoom 等变换型动画只作用于 2D 层，
 * 对视差帧不复刻 —— 视差本身自带运动，再叠位移会晕）。
 */

const DEPTH_FS = `
precision highp float;
uniform sampler2D uImg;
uniform sampler2D uDepth;
uniform vec2  uCanvas;
uniform float uImgAspect;
uniform float uTime;
uniform vec2  uCam;
uniform float uAmp;
uniform float uNrm;
uniform float uLight;
uniform float uLightsOn;
uniform float uHasDepth;
uniform float uAlpha;
uniform float uFlow;       // 1 = DepthFlow POM 模式（C 路线移植）
uniform vec2  uFlowOff;    // 流模式相机位移（屏幕 gluv 单位，y 向上）
uniform float uFlowIso;     // 斜视角（cfg.flowIso，Circle 预设 0.6）
uniform float uFlowSteady;  // 背景稳定点（cfg.flowSteady，预设 0.3）
uniform float uFlowHeight;  // 视差强度主旋钮（cfg.flowHeight，DepthState 默认 0.2）
uniform float uFlowQ;       // POM 步进质量 0.15~1（cfg.flowQuality，0.5=CLI 默认；低=省 GPU）
uniform float uFlowFocus;   // 对焦点（focus：0=视差绕 z=1 面，Orbital 0.30/Dolly 0.35）
uniform float uFlowZoom;    // 图像缩放（zoom：1=满幅，Orbital 0.98/Dolly 0.95 留露边余量）
uniform float uFit;         // 填充：0=cover（铺满裁切）1=contain（核心外透明，透出 2D 模糊底）2=mirror（核心外镜像延展）
uniform vec4  uCore;        // contain/mirror 的核心矩形（屏幕像素，xy=左上角顶为 0，zw=宽高）——每层按自己宽高比现算
uniform vec4  uXf;          // 切换动画层变换（r76，cover 专用）：xy=平移（屏幕宽/高占比），z=绕中心缩放；identity=(0,0,1,0)
uniform sampler2D uMask;    // 前景 mask（Otsu+羽化，与深度图同分辨率同缓存键；r62 idle 方案）
uniform float uHasMask;     // 1 = 本层带 mask 纹理（unit 2）
uniform float uIdle;        // idle 微动画总开关（profile.idleFx）
uniform float uAtmo;        // 分层氛围总开关（r71，profile.depthAtmo）
uniform float uAtmoSel;     // 调色板档位（连续浮点，JS 端缓动防跳变）：0=白天 1=黄昏 2=黄金时刻 3=青橙好莱坞 4=赛博朋克 5=月光 6=褪色胶片

// stuv 域镜像重复采样 —— 等价 depthflow gtexture(..., true) 的边缘外扩，
// 大角度视差露边时不再是黑边/钳位硬边（Tiefling「边缘扩展」同款思路）
vec4 texMirror(sampler2D tex, vec2 stuv) {
  return texture2D(tex, 1.0 - abs(1.0 - mod(stuv, 2.0)));
}

// ---- idle 微动画（r62：让角色「活」起来的低成本方案）----
// A 呼吸+飘动：mask 加权只作用前景 —— 呼吸 = 垂直微移（整前景同相，3s 周期）；
//   飘动 = 水平 sin 扭曲，权重 ∝ mask 边缘梯度（发丝衣摆动、躯干内部梯度≈0 不变形）。
// B 差速视差：前景层额外吃一份相机位移（角色层移动系数 > 背景层 → 分层感更强），
//   权重吃 mask G 通道宽羽化（紧带会撕裂，见 idleWarp 内注释）。
// stF：最终图像采样坐标（stuv，原地改）；stB：未扭曲基准坐标（mask 采样锚点）；
// off：相机屏幕位移（gluv）；breathM：呼吸相位×mask（供亮度脉动，0 = 不动）。
// 幅度起步值（gluv，y 全幅 = 2.0）：呼吸 ±0.0012（≈2px@2160p）、飘动峰值 ±0.0035、
// 差速系数 0.12 —— 全部是真机调参起点，验收后按观感定版。
void idleWarp(inout vec2 stF, vec2 stB, vec2 off, float imgAspect, out float breathM) {
  breathM = 0.0;
  if (uIdle < 0.5 || uHasMask < 0.5) return;
  vec2 m2 = texMirror(uMask, stB).rg;   // r=紧羽化 2.5σ（呼吸/飘动） g=宽羽化 10σ（差速权重）
  float m = m2.r;
  if (m2.r <= 0.003 && m2.g <= 0.003) return;
  // mask 边缘梯度（4 邻域差分）：边缘大、平坦区趋零
  vec2 mpx = vec2(1.5 / imgAspect, 1.5) * 0.5;
  float mgx = texMirror(uMask, stB + vec2(mpx.x, 0.0)).r - texMirror(uMask, stB - vec2(mpx.x, 0.0)).r;
  float mgy = texMirror(uMask, stB + vec2(0.0, mpx.y)).r - texMirror(uMask, stB - vec2(0.0, mpx.y)).r;
  float grad = clamp(length(vec2(mgx, mgy)) * 2.0, 0.0, 1.0);
  // 呼吸：2π/3s，sin 全前景同相
  float br = sin(uTime * 2.0943951);
  // 飘动：双频叠加，相位随高度推进（波沿身体向上传）
  float sway = sin(uTime * 1.7 + stB.y * 9.0) * 0.6 + sin(uTime * 0.9 + stB.y * 4.0) * 0.4;
  vec2 dispG = vec2(sway * grad * 0.0035, br * 0.0012);
  stF += dispG * m / vec2(imgAspect, 1.0) * 0.5;
  // B 差速（mask × 0.12×off）已撤销（第六十六轮）：POM 深度本身就让前景动得多，
  // mask 差速是叠床架屋 —— 且无论紧羽化还是宽羽化，都在轮廓带叠加 28px/px 级剪切
  // （离屏复现 v1 楼梯度 18.9% vs 纯 POM 14.5%），用户两轮真机截图实锤撕边。
  breathM = m * br;
}

// ---- 分层氛围（r72 重构）：luma 分层调色 + split-toning + 指数雾 + 主体金边 ----
// r71 教训：全图乘法调色（col *= tint*lum）是「亮度同比缩放」——夜档红通道暗部乘没、
// 白天高光剪裁。r72 改游戏工业标准做法（Crytek GDC08 Photo Filter / ASC CDL）：
//   ① gamma 曲线只动 luma（比例因子回填 RGB，色相/饱和保持）；
//   ② split-toning：阴影/高光分开染色（tintS/tintH），比全图 tint 自然；
//   ③ luma key：深阴影（luma<0.05）几乎不染 —— 保暗部细节，中间调以上全量。
// 七档参数表（r73：0=白天 1=黄昏 auto 用；2~6=固定调色板）+ 相邻档线性插值（小数部分），交界平滑过渡不硬切。
struct AtmoP {
  vec3 tintS;    // 阴影染色（split-toning 暗部端）
  vec3 tintH;    // 高光染色（split-toning 亮部端）
  float gamma;   // luma 曲线指数（>1 压中间调，<1 提亮；只动 luma 不动色相）
  float lift;    // 抬黑量（0=不动；褪色胶片用，黑位抬到灰）
  float sat;     // 饱和度倍率（1=不动；胶片/月光降饱和，赛博朋克提）
  vec3 fogCol;   // 雾色（兼作金边颜色）
  float fogDen;  // 雾密度峰值（指数雾）
  float farDark; // 远景压暗系数（深度带远端）
  float rimK;    // 金边强度（mask 边缘）
};
void atmoParams(int i, out AtmoP p) {
  if (i <= 0) {          // 白天：中性（auto 档，近无操作）
    p.tintS = vec3(1.00, 1.00, 1.00); p.tintH = vec3(1.00, 1.00, 1.00); p.gamma = 1.0;
    p.lift = 0.0; p.sat = 1.0;
    p.fogCol = vec3(0.90, 0.94, 1.00); p.fogDen = 0.08; p.farDark = 0.98; p.rimK = 0.0;
  } else if (i == 1) {   // 黄昏：阴影偏暖暗、高光染金（split-toning），主体金边
    p.tintS = vec3(1.02, 0.90, 0.82); p.tintH = vec3(1.10, 0.94, 0.74); p.gamma = 1.06;
    p.lift = 0.0; p.sat = 1.05;
    p.fogCol = vec3(0.96, 0.70, 0.42); p.fogDen = 0.30; p.farDark = 0.92; p.rimK = 1.0;
  } else if (i == 2) {   // 黄金时刻：暖金高光 + 阴影微冷托底（社区 Golden Hour 标准：高光滑滚不糊橙）
    p.tintS = vec3(0.92, 0.97, 1.08); p.tintH = vec3(1.14, 0.98, 0.80); p.gamma = 1.03;
    p.lift = 0.01; p.sat = 1.06;
    p.fogCol = vec3(0.98, 0.80, 0.55); p.fogDen = 0.12; p.farDark = 0.96; p.rimK = 0.3;
  } else if (i == 3) {   // 好莱坞青橙：阴影推青、肤色/高光暖橙，对比+（Teal & Orange，影史最稳分级）
    p.tintS = vec3(0.82, 1.02, 1.10); p.tintH = vec3(1.12, 0.94, 0.78); p.gamma = 1.08;
    p.lift = 0.0; p.sat = 1.12;
    p.fogCol = vec3(0.55, 0.80, 0.88); p.fogDen = 0.10; p.farDark = 0.94; p.rimK = 0.0;
  } else if (i == 4) {   // 赛博朋克：暗部品红、高光青，霓虹感强对比
    p.tintS = vec3(1.05, 0.80, 1.12); p.tintH = vec3(0.75, 1.05, 1.15); p.gamma = 1.12;
    p.lift = 0.02; p.sat = 1.25;
    p.fogCol = vec3(0.62, 0.45, 0.85); p.fogDen = 0.16; p.farDark = 0.85; p.rimK = 0.0;
  } else if (i == 5) {   // 月光蓝：蓝银冷调压中间调（社区 Moody Blue：暗而不闷）
    p.tintS = vec3(0.78, 0.85, 1.10); p.tintH = vec3(0.85, 0.92, 1.12); p.gamma = 1.20;
    p.lift = 0.01; p.sat = 0.85;
    p.fogCol = vec3(0.35, 0.42, 0.60); p.fogDen = 0.20; p.farDark = 0.80; p.rimK = 0.0;
  } else {               // 褪色胶片：抬黑低饱和软对比（社区 Faded Film）
    p.tintS = vec3(1.00, 0.97, 0.92); p.tintH = vec3(1.02, 0.99, 0.94); p.gamma = 0.96;
    p.lift = 0.045; p.sat = 0.72;
    p.fogCol = vec3(0.88, 0.85, 0.80); p.fogDen = 0.10; p.farDark = 0.97; p.rimK = 0.0;
  }
}

// stB：未扭曲基准坐标（与 idleWarp 的 mask 锚点一致 → 效果不随视差游走）。
// 雾 = 空气透视（IQ 指数平方雾，远浓近淡无断层）；金边 = mask 边缘梯度。
vec3 atmoApply(vec3 col, vec2 stB, float imgAspect) {
  if (uAtmo < 0.5 || uHasDepth < 0.5) return col;
  float dN = texMirror(uDepth, stB).r;                 // 屏幕点深度（近=1 远=0）
  float far = 1.0 - dN;
  float ph = clamp(uAtmoSel, 0.0, 6.0);
  int i0 = int(floor(ph));
  int i1 = i0 + 1;              // GLSL ES 1.0 无 int 版 min()，用 if 截断（int min/max 是 ES 3.0 才有）
  if (i1 > 6) i1 = 6;
  float f = fract(ph);
  AtmoP a; AtmoP b;
  atmoParams(i0, a);
  atmoParams(i1, b);
  vec3 tintS = mix(a.tintS, b.tintS, f);
  vec3 tintH = mix(a.tintH, b.tintH, f);
  float gamma = mix(a.gamma, b.gamma, f);
  float lift = mix(a.lift, b.lift, f);
  float sat = mix(a.sat, b.sat, f);
  vec3 fogCol = mix(a.fogCol, b.fogCol, f);
  float fogDen = mix(a.fogDen, b.fogDen, f);
  float farDark = mix(a.farDark, b.farDark, f);
  float rimK = mix(a.rimK, b.rimK, f);

  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  // ① luma gamma 曲线：只缩放 luma（比例因子回填，色相/饱和不动）——不是全图乘法
  float lTarget = pow(clamp(luma, 0.0, 1.0), gamma);
  vec3 graded = col * (lTarget / max(luma, 1e-4));
  // ② 远景压暗（深度带）+ ③ split-toning 染色（阴影/高光分端）
  float band = smoothstep(0.10, 0.85, dN);
  graded *= mix(farDark, 1.03, band);
  graded *= mix(tintS, tintH, smoothstep(0.18, 0.85, luma));
  // ④ 饱和度 + 抬黑（褪色胶片/月光/赛博朋克档；luma 锚定防色相漂移）
  graded = mix(vec3(luma), graded, sat);
  graded = lift + graded * (1.0 - lift);
  // ⑤ luma key：深阴影几乎不染（保暗部细节），中间调以上全量
  float key = 0.22 + 0.78 * smoothstep(0.02, 0.30, luma);
  col = mix(col, graded, key);
  // 空气透视：IQ 指数平方雾（线性 smoothstep 有「中间突然一截」断层风险）；雾色亮度取自当前像素
  float fogW = fogDen * (1.0 - exp(-2.2 * far * far));
  col = mix(col, fogCol * (luma * 0.6 + 0.4), clamp(fogW, 0.0, 1.0));
  // 主体金边（黄昏/黄金时刻档）：mask 边缘梯度，与 idleWarp 同款 4 邻域差分
  if (rimK > 0.01 && uHasMask > 0.5) {
    vec2 mpx = vec2(1.5 / imgAspect, 1.5) * 0.5;
    float mgx = texMirror(uMask, stB + vec2(mpx.x, 0.0)).r - texMirror(uMask, stB - vec2(mpx.x, 0.0)).r;
    float mgy = texMirror(uMask, stB + vec2(0.0, mpx.y)).r - texMirror(uMask, stB - vec2(0.0, mpx.y)).r;
    float grad = clamp(length(vec2(mgx, mgy)) * 2.0, 0.0, 1.0);
    float mR = texMirror(uMask, stB).r;
    col += fogCol * grad * mR * rimK * 0.35;
  }
  return col;
}

// DepthFlow POM 主路径（语义 1:1 对齐 depthflow.glsl + shaderflow camera.glsl）
// Circle 预设参数：offset 幅度 0.5 / isometric 0.60 / steady 0.30；DepthState 默认 height 0.20。
// 相机：origin 在 z=0 平面按 zoom*isometric 缩放，target 在 z=focal 平面按 zoom 缩放，
// 与 z=1 深度面求交后，两阶段步进（粗探 overshoot + 细步回退）找视线与深度面的交点。
vec3 flowSample(vec2 g0, vec2 off, float imgAspect) {
  float height = uFlowHeight;   // 视差强度主旋钮（cfg.flowHeight，默认 0.20=DepthState）
  float steady = uFlowSteady;   // Circle 预设默认 0.30：固定点绕 depth=steady 转动
  float isom   = uFlowIso;      // Circle 预设默认 0.60：视线平行分量
  float focal  = 1.0 - uFlowFocus * uFlowHeight;   // focus=0 → 1.0（Circle）；Orbital/Dolly 缩短焦距
  // camera.glsl CameraProject（透视投影）：origin/target 各在 z=0 / z=focal 平面，
  // 射线矩形按 zoom 缩放（zoom<1 = 镜头后撤留露边，Dolly 变焦的物理来源）
  vec3 origin = vec3(off + g0 * (uFlowZoom * isom), 0.0);
  vec3 target = vec3(off + g0 * uFlowZoom, focal);
  // CameraRay2D：与 z=1 平面求交（plane_normal=+z），t = (1-0)/focal
  vec2 camGluv = origin.xy + (target.xy - origin.xy) * (1.0 / focal);
  // DepthMake：sticky=true（背景钉住），center=0，origin 附加位移=0
  float relSteady = steady * height;
  vec3 intersect = vec3(camGluv - off / (1.0 - relSteady), 1.0);
  // 步长随 cfg.flowQuality 伸缩（DepthFlow 原式）：q=0.5 = CLI 默认 quality 50
  // （细步 1/mix(200,2000,q)、粗探 1/mix(50,120,q)；q 越低步数越少越省 GPU）
  float q = clamp(uFlowQ, 0.15, 1.0);
  float quality = 1.0 / mix(200.0, 2000.0, q);
  float probe   = 1.0 / mix(50.0, 120.0, q);
  float safe = 1.0 - height;
  float value = 0.0;
  float walk = 0.0;
  vec2 guv = g0;
  for (int stage = 0; stage < 2; stage++) {
    bool fwd = (stage == 0);
    for (int it = 0; it < 1000; it++) {
      if (fwd && walk > 1.0) break;
      walk += (fwd ? probe : -quality);
      vec3 point = mix(origin, intersect, mix(safe, 1.0, walk));
      guv = point.xy;
      vec2 stD = guv / vec2(imgAspect, 1.0) * 0.5 + 0.5;
      value = texMirror(uDepth, stD).r;
      float surface = height * value;
      float ceiling = 1.0 - point.z;
      if (ceiling < surface) { if (fwd) break; }
      else if (!fwd) break;   // 回退阶段回到表面外 → 交点即此处
    }
  }
  vec2 stF = guv / vec2(imgAspect, 1.0) * 0.5 + 0.5;
  // idle 微动画（r62）：呼吸/飘动/差速都改采样坐标，基准点采样 mask 保证稳定不游走
  vec2 stB = g0 / vec2(imgAspect, 1.0) * 0.5 + 0.5;
  float breathM;
  idleWarp(stF, stB, off, imgAspect, breathM);
  vec3 col = texMirror(uImg, stF).rgb;
  if (breathM != 0.0) col *= 1.0 + 0.02 * breathM;   // 呼吸亮度脉动 ±2%
  col = atmoApply(col, stB, imgAspect);   // 分层氛围：调色板光照+雾+金边
  return col;
}

void main() {
  float canvasAspect = uCanvas.x / uCanvas.y;
  // 纹理不靠 UNPACK_FLIP_Y（ImageBitmap 源在 Chromium 里不认，实测颠倒）：
  // 统一按「v=0 是图顶」上传，这里把 gl_FragCoord 的 y（底为 0）翻成屏幕坐标
  vec2 uv01 = gl_FragCoord.xy / uCanvas;
  uv01.y = 1.0 - uv01.y;
  vec2 crop = vec2(1.0);
  if (uImgAspect > canvasAspect) crop.x = canvasAspect / uImgAspect;
  else                           crop.y = uImgAspect / canvasAspect;

  // ---- DepthFlow POM 模式 ----
  // contain/mirror（r36）：整图完整映射进核心矩形，视差在核心内进行；
  //   contain —— 核心外输出 alpha 0，透出下层 2D 的模糊底（同一次 showFrame 画的）；
  //   mirror  —— 核心外按 texMirror 镜像平铺（与 2D drawMirrorFill 同一套数学）。
  // 位移 off 是图像空间量：核心把整图等比装进去，位移语义与 cover 完全一致。
  if (uFlow > 0.5 && uHasDepth > 0.5) {
    if (uFit > 0.5) {
      vec2 rel = (uv01 * uCanvas - uCore.xy) / uCore.zw;   // 核心相对坐标（uv01 已翻成顶为 0）
      if (rel.x < 0.0 || rel.x > 1.0 || rel.y < 0.0 || rel.y > 1.0) {
        if (uFit < 1.5) { gl_FragColor = vec4(0.0); return; }
        rel = 1.0 - abs(1.0 - mod(rel, 2.0));              // 镜像平铺
      }
      vec2 g0 = (rel - 0.5) * 2.0 * vec2(uImgAspect, 1.0);
      vec3 col = flowSample(g0, uFlowOff, uImgAspect);
      // contain 核心边缘 1.5px 羽化：核心内容随视差移动、外圈模糊底静止，
      // 硬边会闪出一条锯齿缝
      float aEdge = 1.0;
      if (uFit < 1.5) {
        vec2 bpx = min(rel, 1.0 - rel) * uCore.zw;
        aEdge = clamp(min(bpx.x, bpx.y) / 1.5, 0.0, 1.0);
      }
      gl_FragColor = vec4(col, uAlpha * aEdge);
      return;
    }
    // cover（r35 之前的行为原样）+ 切换动画层变换（r76）：uv01 → 层本地坐标
    // （平移 + 绕中心缩放）。slide 两层用同一缓动 → 可见区严丝合缝互补；层本地
    // 越界输出 alpha 0（zoom 收进时层外区域透出底层，而不是拉伸的边缘像素）
    vec2 uvS = (uv01 - 0.5 - uXf.xy) / uXf.z + 0.5;
    if (uvS.x < 0.0 || uvS.x > 1.0 || uvS.y < 0.0 || uvS.y > 1.0) { gl_FragColor = vec4(0.0); return; }
    vec2 off = uFlowOff * crop;   // 屏幕位移 → 图像 gluv 空间（cover 裁切同比缩放）
    vec2 g0 = (vec2(0.5) + (uvS - 0.5) * crop - 0.5) * 2.0 * vec2(uImgAspect, 1.0);
    gl_FragColor = vec4(flowSample(g0, off, uImgAspect), uAlpha);
    return;
  }

  // 层变换采样坐标（r76）：uXf 为 identity（(0,0,1,0)）时 uvS ≡ uv01，零行为变化
  vec2 uvS = (uv01 - 0.5 - uXf.xy) / uXf.z + 0.5;
  if (uvS.x < 0.0 || uvS.x > 1.0 || uvS.y < 0.0 || uvS.y > 1.0) { gl_FragColor = vec4(0.0); return; }

  float margin = uAmp * 0.55 + 0.015;
  vec2 zoom = crop * (1.0 - 2.0 * margin);
  vec2 uv = vec2(0.5) + (uvS - 0.5) * zoom;

  float d = mix(0.5, texture2D(uDepth, uv).r, uHasDepth);   // 无深度=平面
  vec2 par = uCam * (d - 0.5) * uAmp;
  vec2 uvP = uv - par;
  vec2 uvC = clamp(uvP, vec2(0.0), vec2(1.0));
  vec3 col = texture2D(uImg, uvC).rgb;

  if (uHasDepth > 0.5) {
    vec2 px = 1.5 / vec2(1024.0, 1024.0);
    float dl = texture2D(uDepth, uvC - vec2(px.x, 0.0)).r;
    float dr = texture2D(uDepth, uvC + vec2(px.x, 0.0)).r;
    float db = texture2D(uDepth, uvC - vec2(0.0, px.y)).r;
    float dt = texture2D(uDepth, uvC + vec2(0.0, px.y)).r;
    vec3 nrm = normalize(vec3((dl - dr) * uNrm, (db - dt) * uNrm, 1.0));

    if (uLightsOn > 0.5) {
      vec2 p0 = vec2(0.5 + 0.38 * sin(uTime * 0.11), 0.5 + 0.30 * sin(uTime * 0.07 + 1.7));
      vec2 p1 = vec2(0.5 + 0.40 * cos(uTime * 0.083 + 4.0), 0.5 + 0.32 * sin(uTime * 0.056 + 0.6));
      p0 -= uCam * (d - 0.5) * uAmp * 0.8;
      p1 -= uCam * (d - 0.5) * uAmp * 0.8;
      vec2 asp = vec2(canvasAspect, 1.0);
      vec2 frag = uv01 * asp;   // 与采样同坐标系（y 已翻，灯位随屏幕走）
      vec3 c0 = vec3(1.00, 0.62, 0.35) * uLight;
      vec3 c1 = vec3(0.35, 0.60, 1.00) * uLight;
      float a0 = 1.0 + 0.25 * sin(uTime * 0.9);
      float a1 = 1.0 + 0.22 * sin(uTime * 0.7 + 2.1);
      vec2 v0 = frag - p0 * asp; vec2 v1 = frag - p1 * asp;
      float att0 = 1.0 / (1.0 + 6.0 * dot(v0, v0));
      float att1 = 1.0 / (1.0 + 6.0 * dot(v1, v1));
      vec3 L0 = normalize(vec3(-v0, 0.9));
      vec3 L1 = normalize(vec3(-v1, 0.9));
      float diff0 = max(dot(nrm, L0), 0.0);
      float diff1 = max(dot(nrm, L1), 0.0);
      col += c0 * att0 * (0.35 + 0.65 * diff0 * 0.5) * a0 * d;
      col += c1 * att1 * (0.35 + 0.65 * diff1 * 0.5) * a1 * (1.0 - d * 0.5);
    }
  }
  gl_FragColor = vec4(col, uAlpha);
}
`;

const glState = {
  gl: null, canvas: null, prog: null, U: null, ok: false,
  cur: null,        // { imgTex, depTex|null, aspect, imgPath }
  anim: null,       // { t0, duration, out:{imgTex,depTex,aspect}|null, in:{...}|null }
  mouse: [0, 0], mouseUntil: 0, mouseW: 0,
};

function glInit() {
  if (glState.ok || glState.failed) return;
  try {
    const canvas = document.getElementById('depthgl');
    const gl = canvas.getContext('webgl', { antialias: false, alpha: true, premultipliedAlpha: false });
    if (!gl) throw new Error('webgl 不可用');
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, mk(gl.VERTEX_SHADER, 'attribute vec2 aPos;void main(){gl_Position=vec4(aPos,0.,1.);}'));
    gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, DEPTH_FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const U = {};
    for (const n of ['uImg', 'uDepth', 'uCanvas', 'uImgAspect', 'uTime', 'uCam', 'uAmp',
      'uNrm', 'uLight', 'uLightsOn', 'uHasDepth', 'uAlpha', 'uFlow', 'uFlowOff',
      'uFlowIso', 'uFlowSteady', 'uFlowHeight', 'uFlowQ', 'uFlowFocus', 'uFlowZoom',
      'uFit', 'uCore', 'uXf', 'uMask', 'uHasMask', 'uIdle', 'uAtmo', 'uAtmoSel']) U[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(U.uImg, 0);
    gl.uniform1i(U.uDepth, 1);
    gl.uniform1i(U.uMask, 2);
    glState.canvas = canvas; glState.gl = gl; glState.prog = prog; glState.U = U;
    glState.ok = true;
  } catch (err) {
    glState.failed = true;
    console.warn('[stage] 深度视差层初始化失败（降级 2D）:', err.message);
  }
}

function glMakeTex(unit, src) {
  const gl = glState.gl;
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);   // 翻转统一在 shader 做（ImageBitmap 不认 flip）
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  return t;
}

/** mask 缓存路径（r62 idle 方案）：与深度图同缓存键派生（与 depthService trioFor
 *  同一套命名约定）。路径不是 .depth.png 结尾（异常/第三方路径）→ 返回 null，
 *  渲染端优雅降级为无 mask（idle 关），绝不影响视差本体。 */
function maskPathOf(depthPath) {
  return typeof depthPath === 'string' && /\.depth\.png$/i.test(depthPath)
    ? depthPath.slice(0, -'.depth.png'.length) + '.mask.png'
    : null;
}

/** 粒子深度遮挡（r74）：把深度位图缩采样成 CPU 像素表（长边封顶 256，
 *  粒子坐标精度 ~10px，比 V2 边缘糊还粗，查表零感知）。失败返回 null（遮挡自动跳过）。
 *  ⚠️ 必须在 depBmp.close() 之前调 —— glLoadLayer 建完纹理就关位图。 */
const DEPTH_SAMPLE_MAX = 256;
function depthPixelsFor(depBmp) {
  try {
    const k = Math.min(1, DEPTH_SAMPLE_MAX / Math.max(depBmp.width, depBmp.height));
    const w = Math.max(1, Math.round(depBmp.width * k));
    const h = Math.max(1, Math.round(depBmp.height * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(depBmp, 0, 0, w, h);
    return { data: cx.getImageData(0, 0, w, h).data, w, h };
  } catch (_) {
    return null;
  }
}

/** 深度帧喂给粒子层；src 为空或开关关了都等于清除（粒子层内部幂等） */
function feedParticleDepth(src) {
  if (!particleFx || !particleFx.setDepth) return;
  particleFx.setDepth(cfg.particleDepth ? src : null);
}

function glFreeLayer(L) {
  if (!L || !glState.gl) return;
  for (const t of [L.imgTex, L.depTex, L.maskTex]) if (t) glState.gl.deleteTexture(t);
  if (L._bmp) { try { L._bmp.close(); } catch (_) { /* 已关 */ } L._bmp = null; }
}

/** 取/建视差图层描述 {imgTex, depTex, aspect}；任何一步失败返回 null（调用方回退 2D）。
 *  ⚠️ glLayerFor 返回的层不携带位图（bmp 已关）；需要位图垫底用 glLoadLayer。 */
async function glLayerFor(imagePath, depthPath) {
  const loaded = await glLoadLayer(imagePath, depthPath);
  if (!loaded) return null;
  loaded.bmp.close();
  return loaded.layer;
}

/** 同 glLayerFor，但把原图位图一并带回（不关）—— showFrame 给 2D 层垫底用 */
async function glLoadLayer(imagePath, depthPath) {
  try {
    const maskPath = maskPathOf(depthPath);
    const [bmp, depBmp, maskBmp] = await Promise.all([
      fetchBitmap({ path: imagePath }),
      depthPath ? fetchBitmap({ path: depthPath }).catch(() => null) : Promise.resolve(null),
      maskPath ? fetchBitmap({ path: maskPath }).catch(() => null) : Promise.resolve(null),
    ]);
    const layer = {
      imgTex: glMakeTex(0, bmp),
      depTex: depBmp ? glMakeTex(1, depBmp) : null,
      maskTex: maskBmp ? glMakeTex(2, maskBmp) : null,   // r62：前景 mask（加载失败=null → idle 关）
      aspect: bmp.width / bmp.height,
      iw: bmp.width,
      ih: bmp.height,                // r74：粒子遮挡的 cover 映射用原图尺寸（位图关后仍在）
      depthPx: (depBmp && cfg.particleDepth) ? depthPixelsFor(depBmp) : null,
    };
    if (depBmp) depBmp.close();
    if (maskBmp) maskBmp.close();
    return { layer, bmp };   // 原图位图不关：调用方 2D 垫底后自行 close
  } catch (err) {
    console.warn('[stage] 视差纹理加载失败（本帧回退 2D）:', imagePath, err.message);
    return null;
  }
}

/** 相机：自动漂移为主，鼠标动过后 2.5s 内接管（权重快进慢出，平滑淡回） */
function glCam(tSec, nowMs) {
  const s = cfg.depthDrift;
  const ax = Math.sin(tSec * 0.11 * s) * 0.7 + Math.sin(tSec * 0.041 * s + 2.0) * 0.3;
  const ay = Math.sin(tSec * 0.073 * s + 1.3) * 0.65 + Math.sin(tSec * 0.033 * s + 4.0) * 0.35;
  const active = nowMs < glState.mouseUntil;
  glState.mouseW += ((active ? 1 : 0) - glState.mouseW) * (active ? 0.10 : 0.02);
  return [
    ax * (1 - glState.mouseW) + glState.mouse[0] * glState.mouseW * 1.2,
    ay * (1 - glState.mouseW) + glState.mouse[1] * glState.mouseW * 1.2,
  ];
}

/**
 * 流模式相机位移公共语义：8s 一圈的周期（cycle=2π）保证首尾无缝；
 * depthDrift 只调速不破坏连续性。
 * ⚠️ y 轴符号：shader 内 uv01 已翻成「y 向下」屏幕系（与 clientY 同向），而
 * DepthFlow 的 offset 是 y 向上 —— 离线逐帧对比实锤（negoff_y 变体把帧差从
 * ~21 打到 ~2.5 噪声级），所以自动漂移的 y 取反进 uniform；鼠标 clientY 本就
 * y 向下，天然同轴，不再翻。
 */
/**
 * 各轨迹的 focus/zoom（shader 常量，无滑杆）：与 DepthFlow 官方预设 1:1。
 * steady/height 走用户滑杆（切风格时 app.js 会写入该风格的预设默认值）。
 */
const FLOW_STYLE_PARAMS = {
  circle:  { focus: 0.0,  zoom: 1.0 },
  orbital: { focus: 0.30, zoom: 0.98 },
  dolly:   { focus: 0.35, zoom: 0.95 },
};
/**
 * 流模式（DepthFlow 预设移植）相机：返回 { off:[x,y], iso }。
 * off = 屏幕位移（y 向下；DepthFlow offset 是 y 向上，自动项已取反），
 * iso = 斜视角（Orbital/Dolly 动态、Circle 用用户滑杆）。
 * 三种轨迹与 DepthFlow 官方预设公式 1:1，cycle=(t/8)*2π 无缝循环：
 *   circle  —— offset=(cos,-sin)*amp，iso 恒定（滑杆）
 *   orbital —— offset=(sin,0)*amp，iso=0.5·cos+0.75 摆动环绕（focus 0.30/zoom 0.98）
 *   dolly   —— offset=0，iso=0.5·(1-cos) 推拉变焦（height 0.30/steady 0.35/focus 0.35/zoom 0.95）
 * 鼠标接管：位移平滑淡入（iso 不受鼠标影响）。
 */
function glCamFlow(tSec, nowMs) {
  const amp = cfg.flowIntensity;   // 预设 0.5；鼠标接管幅度同源
  const cycle = (tSec / 8.0) * Math.PI * 2 * cfg.depthDrift;
  const style = FLOW_STYLE_PARAMS[cfg.flowStyle] ? cfg.flowStyle : 'circle';
  let ax = 0, ay = 0, iso = cfg.flowIso;
  if (style === 'circle') {
    ax = Math.cos(cycle) * amp;
    ay = -Math.sin(cycle) * amp;
  } else if (style === 'orbital') {
    ax = Math.sin(cycle) * amp;
    iso = 0.5 * Math.cos(cycle) + 0.75;      // Orbital：isometric 动态摆动
  } else {                                   // dolly
    iso = 0.5 * (1.0 - Math.cos(cycle));     // Dolly：无位移，纯推拉变焦
  }
  const active = nowMs < glState.mouseUntil;
  glState.mouseW += ((active ? 1 : 0) - glState.mouseW) * (active ? 0.10 : 0.02);
  const w = glState.mouseW;
  return {
    off: [ax * (1 - w) + glState.mouse[0] * amp * w,
          ay * (1 - w) - glState.mouse[1] * amp * w],
    iso,
  };
}

function glDrawLayer(L, alpha, cam, tSec, xf) {
  const gl = glState.gl;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, L.imgTex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, L.depTex || L.imgTex);   // 无深度时占位（uHasDepth 压平）
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, L.maskTex || L.depTex || L.imgTex);   // 无 mask 占位（uHasMask 关 idle）
  const { w, h } = canvasSize(glState.canvas);
  gl.viewport(0, 0, w, h);
  gl.uniform2f(glState.U.uCanvas, w, h);
  gl.uniform1f(glState.U.uImgAspect, L.aspect);
  gl.uniform1f(glState.U.uTime, tSec);
  gl.uniform1f(glState.U.uFlow, cfg.depthFlow ? 1 : 0);
  // cam 两形态：glCam（旧路径）返回数组；glCamFlow 返回 { off, iso }
  const flowOff = Array.isArray(cam) ? cam : cam.off;
  const flowIso = (!Array.isArray(cam) && Number.isFinite(cam.iso)) ? cam.iso : cfg.flowIso;
  gl.uniform2f(glState.U.uCam, flowOff[0], flowOff[1]);
  gl.uniform1f(glState.U.uAmp, cfg.depthAmp);
  gl.uniform1f(glState.U.uNrm, 9.0);
  gl.uniform1f(glState.U.uLight, cfg.depthLight);
  gl.uniform1f(glState.U.uLightsOn, 1);
  gl.uniform1f(glState.U.uHasDepth, L.depTex ? 1 : 0);
  gl.uniform1f(glState.U.uHasMask, L.maskTex ? 1 : 0);
  gl.uniform1f(glState.U.uIdle, cfg.idleFx ? 1 : 0);
  gl.uniform1f(glState.U.uAtmo, cfg.depthAtmo ? 1 : 0);
  gl.uniform1f(glState.U.uAtmoSel, atmoSelNow());       // 调色板档位（JS 端每帧缓动防跳变）
  gl.uniform1f(glState.U.uAlpha, alpha);
  gl.uniform2f(glState.U.uFlowOff, flowOff[0], flowOff[1]);
  gl.uniform1f(glState.U.uFlowIso, flowIso);
  gl.uniform1f(glState.U.uFlowSteady, cfg.flowSteady);
  gl.uniform1f(glState.U.uFlowHeight, cfg.flowHeight);
  const flowP = FLOW_STYLE_PARAMS[cfg.flowStyle] || FLOW_STYLE_PARAMS.circle;
  gl.uniform1f(glState.U.uFlowFocus, flowP.focus);
  gl.uniform1f(glState.U.uFlowZoom, flowP.zoom);
  gl.uniform1f(glState.U.uFlowQ, Math.min(1, Math.max(0.15, cfg.flowQuality || 0.5)));
  // 填充方式（r36）：contain/mirror 的核心矩形按**本层**图像宽高比现算（两层各自不同），
  // 与 2D containRect 同一套数学 —— GL 核心必须和下层 2D 画的完整核心逐像素对齐
  let uFit = 0;
  let core;
  if ((cfg.fit === 'contain' || cfg.fit === 'mirror') && !Array.isArray(cam)) {
    const ca = w / h;
    let cw2, ch2;
    if (L.aspect > ca) { cw2 = w; ch2 = w / L.aspect; } else { ch2 = h; cw2 = h * L.aspect; }
    core = [(w - cw2) / 2, (h - ch2) / 2, cw2, ch2];
    uFit = cfg.fit === 'mirror' ? 2 : 1;
  } else {
    core = [0, 0, w, h];
  }
  // 切换动画变体（r76）：两条路各走各的 ——
  //   contain/mirror：shader 认 uCore，直接平移/缩放核心矩形（核心外本就 alpha 0）；
  //   cover：shader 不读 uCore，采样变换走 uXf（xy=平移屏占比，z=绕中心缩放）。
  if (xf && (xf.dx || xf.dy || xf.s !== 1)) {
    if (uFit > 0.5) {
      const bw2 = core[2] * xf.s;
      const bh2 = core[3] * xf.s;
      core = [
        core[0] + (core[2] - bw2) / 2 + xf.dx * w,
        core[1] + (core[3] - bh2) / 2 + xf.dy * h,
        bw2, bh2,
      ];
      gl.uniform4f(glState.U.uXf, 0, 0, 1, 0);
    } else {
      gl.uniform4f(glState.U.uXf, xf.dx, xf.dy, xf.s, 0);
    }
  } else {
    gl.uniform4f(glState.U.uXf, 0, 0, 1, 0);
  }
  gl.uniform1f(glState.U.uFit, uFit);
  gl.uniform4f(glState.U.uCore, core[0], core[1], core[2], core[3]);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/** 每帧调（gate 之后）：有内容就画，没内容就把 canvas 藏起来 */
function glTick(now) {
  if (!glState.ok) return;
  const has = glState.cur || glState.anim;
  glState.canvas.style.display = has ? 'block' : 'none';
  if (!has) return;
  const gl = glState.gl;
  const tSec = (now - t0GL) / 1000;
  const cam = cfg.depthFlow ? glCamFlow(tSec, now) : glCam(tSec, now);
  gl.disable(gl.BLEND);
  if (glState.anim) {
    const A = glState.anim;
    const p = Math.min(1, (now - A.t0) / Math.max(1, A.duration));
    const e = easeCubicBezier(p);
    // 切换动画变体（r76）：A.glv = null → 交叉淡化（现行行为）；有值 → 核心矩形
    // 平移/缩放 + 透明度按 2D variantFor 同款语义插值
    let aIn = e;
    let aOut = 1;
    let xfIn = null;
    let xfOut = null;
    if (A.glv) {
      aIn = lerp(A.glv.fromO, 1, e);
      aOut = lerp(1, A.glv.toO, e);
      xfIn = {
        dx: lerp(A.glv.from.dx, 0, e),
        dy: lerp(A.glv.from.dy, 0, e),
        s: lerp(A.glv.from.s, 1, e),
      };
      xfOut = {
        dx: lerp(0, A.glv.to.dx, e),
        dy: lerp(0, A.glv.to.dy, e),
        s: lerp(1, A.glv.to.s, e),
      };
    }
    // contain 的 2D 模糊底随 GL 核心同步淡入（bgFade 由 showFrame 挂上）
    if (A.bgFade) setLayer(A.bgFade.root, REST, e, 'px');
    if (A.out) glDrawLayer(A.out, aOut, cam, tSec, xfOut);   // 底层
    if (A.in) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      glDrawLayer(A.in, aIn, cam, tSec, xfIn);               // 顶层淡入（src-over，正确合成不压暗）
    }
    if (p >= 1) {
      if (A.bgFade) setLayer(A.bgFade.root, REST, 1, 'px');
      glFreeLayer(A.out);
      glState.cur = A.in;
      glState.anim = null;
      if (!glState.cur) { glActive = false; glState.canvas.style.display = 'none'; }
    }
  } else if (glState.cur) {
    glDrawLayer(glState.cur, 1, cam, tSec);
  }
}

/** 2D 内容要上屏了：把视差层淡出（或直接取消进行中的 GL 过渡），绝不盖住新内容 */
function glFadeOutIfAny() {
  if (!glActive) return;
  collage.active = false;   // GL（含拼接）退场后是新 2D 内容，升级链失效
  if (glState.anim) {   // 打断进行中的 GL 过渡，纹理全部释放
    glFreeLayer(glState.anim.out !== glState.cur ? glState.anim.out : null);
    glFreeLayer(glState.anim.in);
    glState.anim = null;
  }
  if (glState.cur) {
    glState.anim = { t0: performance.now(), duration: Math.max(0, cfg.duration || 0), out: glState.cur, in: null };
    glState.cur = null;   // glTick 走完自会 glActive=false 并隐藏画布
  } else {
    glActive = false;
    if (glState.canvas) glState.canvas.style.display = 'none';
  }
}

/** 深度帧上屏主入口（showFrame 的 GL 分支）。返回 true=接管成功；false=回退 2D。
 *  token：showFrame 的过渡令牌 —— 纹理加载期间被更新的 showFrame 抢走就放弃（防旧盖新）。
 *  ⚠️ 整体 try/catch：这里任何异常都会跳过 showFrame 的 2D 回退 → 桌面黑屏
 *  （2026-10-09 启动黑屏排查追加，失败原因全部落 live-debug.log）。 */
async function glShowFrame(entry, outgoingPath, token, opts = {}) {
  try {
    glInit();
    if (!glState.ok) { slog('gl: 初始化失败，回退 2D'); return { ok: false }; }
    const loaded = await glLoadLayer(entry.path, entry.depth);
    if (!loaded) { slog('gl: 纹理加载失败，回退 2D', String(entry.path).split(/[\\/]/).pop()); return { ok: false }; }
    const inLayer = loaded.layer;
    inLayer._bmp = loaded.bmp;      // 随层带走：成功时给 2D 垫底；废弃时 glFreeLayer 关闭
    if (token !== animToken) { glFreeLayer(inLayer); return { ok: false }; }   // 等待期间又被切走
    // 出场快照：刚才就是视差 → 复用它的纹理；否则抓一张平图做底（video/html 不抓）
    let outLayer = null;
    if (glState.cur && (!outgoingPath || glState.cur.imgPath === outgoingPath)) {
      outLayer = glState.cur;
    } else if (outgoingPath && kindOf({ path: outgoingPath }) === 'image') {
      outLayer = await glLayerFor(outgoingPath, null);
      if (token !== animToken) { glFreeLayer(inLayer); glFreeLayer(outLayer); return { ok: false }; }
    }
    if (glState.anim) {   // 打断进行中的升级/过渡：旧的出场层直接释放
      glFreeLayer(glState.anim.out !== glState.cur ? glState.anim.out : null);
      glFreeLayer(glState.anim.in);
      glState.anim = null;
    }
    // 切换动画（r76）：animate=false（启动/自愈/接管首帧）= 瞬上（与 2D 语义一致）；
    // variant=false（depth:ready 升级）= 淡化 —— 同一张图加视差，平移缩放会穿帮
    const animate = opts.animate !== false;
    glState.anim = {
      t0: performance.now(),
      duration: animate ? Math.max(0, cfg.duration || 0) : 0,
      out: outLayer, in: inLayer,
      glv: animate && opts.variant !== false ? glVariantFor(pickAnimName(), currentDir) : null,
    };
    inLayer.imgPath = entry.path;   // depth:ready 升级判定 / 出场快照复用判定用
    glState.cur = null;
    glActive = true;
    everRendered = true;
    return { ok: true, bmp: inLayer._bmp, layer: inLayer };
  } catch (err) {
    try { slog('gl: 异常，回退 2D ——', err && err.message); } catch (_) { /* 忽略 */ }
    console.warn('[stage] glShowFrame 异常:', err);
    return { ok: false };
  }
}

/** 拼接版 GL 上屏（r38）：画布已在外部拼好，纹理直接从 canvas 建（texImage2D 收 canvas）。
 *  出场底复用规则与 glShowFrame 一致：上一帧是 GL（单图或上一次拼接）就复用它的纹理，
 *  都没有就纯淡入盖在 2D 上。拼接画布恰好铺满屏幕 → aspect==canvas → shader 走 cover 全幅。 */
async function glShowFrameCollage(col, token, opts = {}) {
  try {
    glInit();
    if (!glState.ok) { slog('gl: 初始化失败，回退 2D'); return { ok: false }; }
    const inLayer = {
      imgTex: glMakeTex(0, col.imgCanvas),
      depTex: glMakeTex(1, col.depCanvas),
      aspect: col.aspect,
      _bmp: null,
      imgPath: 'collage@' + String(currentEntry ? currentEntry.path : ''),
    };
    if (token !== animToken) { glFreeLayer(inLayer); return { ok: false }; }
    let outLayer = glState.cur || null;
    if (glState.anim) {   // 打断进行中的升级/过渡：旧的出场层直接释放
      glFreeLayer(glState.anim.out !== glState.cur ? glState.anim.out : null);
      glFreeLayer(glState.anim.in);
      glState.anim = null;
    }
    // 变体规则与 glShowFrame 一致（r76）：升级（variant:false）走淡化 ——
    // 拼的是同一幅画面，平移缩放会穿帮
    const animate = opts.animate !== false;
    glState.anim = {
      t0: performance.now(),
      duration: animate ? Math.max(0, cfg.duration || 0) : 0,
      out: outLayer, in: inLayer,
      glv: animate && opts.variant !== false ? glVariantFor(pickAnimName(), currentDir) : null,
    };
    glState.cur = null;
    glActive = true;
    everRendered = true;
    return { ok: true, layer: inLayer };
  } catch (err) {
    try { slog('gl: 拼接异常，回退 2D ——', err && err.message); } catch (_) { /* 忽略 */ }
    return { ok: false };
  }
}

/* ------------------------------------------------------------------ rAF 循环 */

/** fpsCap 闸门：不到间隔就不写样式（rAF 本身继续跑，恢复时才准点） */
function gate(now) {
  const min = 1000 / Math.max(5, cfg.fpsCap || 30);
  if (now - lastPaint < min) return false;
  lastPaint = now;
  return true;
}

function kenTick(now) {
  if (glActive) return;   // 视差层自带漂移运动，Ken Burns 不叠加（双重运动会晕）
  const layer = layers[active];
  if (!cfg.kenBurns && !cfg.breath) {
    // 两个缩放特效都关时把画布钉回原位（只写一次，别每帧都碰样式）
    if (!ken._cleared) {
      layer.canvas.style.transform = 'none';
      ken._cleared = true;
    }
    return;
  }
  ken._cleared = false;
  if (!currentEntry) return;
  let s = 1;
  if (cfg.kenBurns) {
    const t = ((now - ken.start) % (KEN.period * 2)) / KEN.period;
    const k = t <= 1 ? t : 2 - t;                       // 0→1→0 往返，无跳变
    const e = easeCubicBezier(k);
    s += KEN.amplitude * e;                             // ≥1，永不露边
  }
  if (cfg.breath) {
    // cos 从 0 相位起步：scale 从 1 平滑出发，不重置相位（重置=瞬跳，KEN 的教训）
    // 周期/幅度由 profile.breathPeriod / breathAmplitude 驱动（主树 47 轮同款）
    const ph = (now % cfg.breathPeriod) / cfg.breathPeriod;   // 0..1
    s += (cfg.breathAmplitude / 100) * (0.5 - 0.5 * Math.cos(ph * 2 * Math.PI));
  }
  layer.canvas.style.transform = `scale(${s.toFixed(5)})`;
}

/** 关掉层上留存的解码位图（裁切平移用的那份；close 两次无害，仍兜 try） */
function dropLayerBmp(layer) {
  if (layer && layer.bmp) {
    try { layer.bmp.close(); } catch (_) { /* 已关 */ }
    layer.bmp = null;
  }
}

/**
 * 裁切平移（r37，小红车同款）：铺满裁切的图溢出屏幕的部分，跟着鼠标滑动露出。
 * 语义与深度视差的鼠标接管完全同源：mousemove 喂 glState.mouse/mouseUntil（2.5s），
 * 活动期间目标值=鼠标位置，停手缓回居中；插值系数 0.12/0.03 对齐 glCam 的权重节奏。
 * 只对 2D 铺满路径生效 —— GL 在管时鼠标属于视差镜头，contain/mirror 没有溢出可滑。
 */
function panTick(now) {
  if (!cfg.cropPan || cfg.fit !== 'cover' || glActive) return;
  if (!currentEntry || kindOf(currentEntry) !== 'image') return;
  const layer = layers[active];
  if (!layer || !layer.bmp) return;
  const live = now < glState.mouseUntil;
  const tx = live ? (glState.mouse[0] + 1) / 2 - 0.5 : 0;
  const ty = live ? (glState.mouse[1] + 1) / 2 - 0.5 : 0;
  const k = live ? 0.12 : 0.03;
  pan.x += (tx - pan.x) * k;
  pan.y += (ty - pan.y) * k;
  if (Math.abs(pan.x) < 0.0005 && Math.abs(pan.y) < 0.0005) {
    if (!pan.dirty) return;
    pan.x = 0;
    pan.y = 0;
    pan.dirty = false;          // 归中落地：最后画一次居中帧，之后不再重画
  } else {
    pan.dirty = true;
  }
  const b = layer.bmp;
  try {
    drawSource(layer, b, b.width, b.height, pan);
  } catch (err) {
    dropLayerBmp(layer);        // 位图已被关（理论不会）：止损，下次换图恢复
  }
}

function animTick(now) {
  if (!anim) return;
  const p = Math.min(1, (now - anim.t0) / anim.duration);
  const e = easeCubicBezier(p);
  const { incoming, outgoing, v } = anim;
  if (v.tick) {
    v.tick(incoming, outgoing, e);          // 自绘型：clip/mask/filter 自己写
  } else {
    setLayer(incoming.root,
      { x: lerp(v.fromT.x, 0, e), y: lerp(v.fromT.y, 0, e), s: lerp(v.fromT.s, 1, e) },
      lerp(v.fromO, 1, e), v.u);
    setLayer(outgoing.root,
      { x: lerp(0, v.toT.x, e), y: lerp(0, v.toT.y, e), s: lerp(1, v.toT.s, e) },
      lerp(1, v.toO, e), v.u);
  }
  if (p >= 1) {
    // 两层都钉死在原位：后层透明避免残留位移；前层必须钉回 scale=1 ——
    // zoom 变体的 toT.s=0.985（终态略小一圈），不钉回去的话四边会永久留缝，
    // 露出底下的旧图层（2026-09-25 真机抓屏实测：左右下各 11px 缝，内容缩 1.5%）。
    // ⚠️ Ken Burns 相位**不重置**（缩放是连续函数，重置=瞬跳 —— 0925 实锤）。
    clearFx(outgoing.root);
    clearFx(incoming.root);
    setLayer(outgoing.root, REST, 0, 'px');
    setLayer(incoming.root, REST, 1, 'px');
    anim = null;
  }
}

function ensureRaf() {
  if (rafId || frozen) return;
  // rAF 兜底（r74 追记）：循环体没有任何 try/catch，任一 tick 抛异常 → 结尾的
  // requestAnimationFrame 不执行 → 整个循环死透，视差/过渡/粒子全冻结且无人重启
  // （showFrame 要等下一次换图才 ensureRaf，然后原异常再炸一次）。粒子遮挡首帧
  // rand 未定义实锤过这条链。各 tick 独立隔离：一个挂了别的照跑，异常落 slog 限频。
  let tickErrN = 0;
  const safeTick = (label, fn) => {
    try { fn(); } catch (err) {
      if (tickErrN < 5) slog(`rAF ${label} 异常（循环续跑）——`, (err && (err.stack || err.message)) || String(err));
      tickErrN += 1;
    }
  };
  const loop = (now) => {
    rafId = 0;
    if (gate(now)) {
      safeTick('animTick', () => animTick(now));
      safeTick('kenTick', () => kenTick(now));
      safeTick('glTick', () => glTick(now));
      safeTick('panTick', () => panTick(now));
      // 视频壁纸：每帧把 <video> 的当前画面画进活动层（过渡动画是 root 的
      // CSS 样式，与 canvas 内容正交，两者并行不冲突）
      if (activeVideo && currentEntry && kindOf(currentEntry) === 'video') {
        safeTick('videoFrame', () => drawSource(layers[active], activeVideo, activeVideo.videoWidth, activeVideo.videoHeight));
      }
      // 粒子层与过渡/缓动共享同一个 fpsCap 闸门；stage:pause 停 rAF 即冻结，
      // 恢复后的时间跳变由 particles.js 的 DT_MAX 钳位兜住
      if (particleFx) safeTick('particleFrame', () => particleFx.frame(now));
    }
    if (frozen) return;                    // 暂停：这一帧画完就停表
    if (anim || currentEntry || (particleFx && particleFx.isActive())) {
      rafId = requestAnimationFrame(loop);
    }
  };
  rafId = requestAnimationFrame(loop);
}

function setFrozen(next) {
  if (frozen === Boolean(next)) return;
  frozen = Boolean(next);
  slog('stage:pause →', frozen ? '冻结（rAF 停）' : '恢复（rAF 续）');
  if (frozen) {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (activeVideo) activeVideo.pause();          // 视频壁纸跟着冻结
  } else {
    if (activeVideo) activeVideo.play().catch(() => {});
    ken.start = performance.now();         // 恢复：Ken Burns 重置起点，避免大跳
    ensureRaf();
    // 解冻自愈：启动时撞上暂停的话，bind 显示可能被冻结打断（rAF 被 cancel、
    // 过渡淡入只走到一半）—— 一帧都没画过就强制重显当前 entry，不等下一个
    // 60s 调度 tick（否则桌面黑到那时为止，用户观感就是「重启黑屏」）。
    if (!everRendered && currentEntry) {
      const e = currentEntry;
      slog('解冻自愈：重启首帧重显', String(e.path).split(/[\\/]/).pop());
      currentEntry = null;                 // 绕过 applyChannels 的「同帧跳过」守卫
      showFrame(e, 1, false).catch((err) => slog('解冻自愈失败 ——', err && err.message));
    } else {
      // 解冻补同步：冻结期间调度器照常推进（tick 全被 frozen 拦掉），桌面
      // 停在冻结前那张，调度器 index 却已前进若干张 —— 不补的话桌面最长
      // 憋 60s 旧图，期间右键「删除当前显示器的壁纸」删的是**从没显示过**
      // 的图（2026-10-09 用户实测踩中： maximizing 期间走了好几拍）。
      // applyChannels 内部有「路径没变就不动」守卫：没掉拍时零开销。
      if (window.wp && window.wp.listChannels) {
        window.wp.listChannels().then(applyChannels)
          .catch((err) => slog('解冻补同步失败 ——', err && err.message));
      }
    }
  }
}

/* ------------------------------------------------------------------ 帧切换 */

async function showFrame(entry, dir, animate) {
  if (!entry) return;
  currentEntry = entry;
  currentDir = dir >= 0 ? 1 : -1;
  const token = ++animToken;
  const kind = kindOf(entry);
  collage.active = false;   // 新帧默认不再是 2D 拼接（只有拼接 2D 分支会置回 true）
  feedParticleDepth(null);  // r74：粒子遮挡默认清 —— 2D/拼接/网页/视频各路都别吃上一张的深度（GL 深度命中时会重喂）

  const incomingKey = active === 'A' ? 'B' : 'A';
  if (!showFrame._logged) {
    showFrame._logged = true;
    console.log(`[stage] 首帧上屏: ${entry.path}`);
  }
  const incoming = layers[incomingKey];
  const outgoing = layers[active];

  // ── 内容准备：图片=解码位图 / 视频=就绪可播 / 网页=iframe 就位 ──
  let src = null, sw = 0, sh = 0;

  if (kind === 'html') {
    glFadeOutIfAny();
    iframeOf(incoming, window.wp.stageUrl(entry.path));
  } else {
    hideIframe(incoming);
  }

  if (kind === 'image') {
    // ── 拼接填充（r38）：先试拼 N 联（各格深度顺带入队），拼不起来退单图 ──
    let prefetched = null;
    if (cfg.depthEnabled && cfg.fit === 'collage' && typeof window.wp.channelNeighbors === 'function') {
      const col = await buildCollageFrame(entry, token);
      if (col) reportCollagePage(col.n);   // r75：回报页宽，调度器整页推进防重复
      if (col && col.n > 1) {
        if (col.depCanvas) {
          const gl = await glShowFrameCollage(col, token, { animate });
          if (gl.ok) {
            hideIframe(incoming);
            hideIframe(outgoing);
            dropLayerBmp(incoming);
            dropLayerBmp(outgoing);
            collage.active = false;              // GL 全屏接管：不再等升级
            setLayer(incoming.root, REST, 1, 'px');
            setLayer(outgoing.root, REST, 0, 'px');
            active = incomingKey;
            ensureRaf();
            return;
          }
        }
        // 2D 拼接上屏（部分格深度未就绪 / GL 失败）—— 留存格位等 depth:ready 升级
        glFadeOutIfAny();
        collage.active = true;
        collage.n = col.n;
        collage.slots = col.slots;
        finish2D(incoming, outgoing, col.imgCanvas, col.w, col.h, 'image', animate, incomingKey, { collage: col });
        return;
      }
      if (col && col.n === 1) prefetched = col.bmpSrc;   // 退化单图：中心位图已解码，直接用
    }
    // ── 深度视差：查 sidecar（命中→GL 路径；未命中→主进程入队后台生成，本帧 2D）──
    if (cfg.depthEnabled && typeof window.wp.depthFor === 'function') {
      let depthPath = null;
      try { depthPath = await window.wp.depthFor(entry.path); } catch (_) { /* 查询失败按无深度 */ }
      slog(`tick ${depthPath ? 'hit ' : 'miss'} ${String(entry.path).split(/[\\/]/).pop()}`);
      if (depthPath && entry.depth !== false) {
        const depthEntry = { ...entry, depth: depthPath };
        const gl = await glShowFrame(depthEntry, currentEntry && currentEntry !== entry ? currentEntry.path : null, token, { animate });
        if (gl.ok) {
          hideIframe(incoming);
          hideIframe(outgoing);
          // GL 接管后 2D 层不可见：位图留存没有意义（contain 的模糊底由下面
          // 现画，吃的是 GL 层自带的 _bmp，不是这两个槽位）
          dropLayerBmp(incoming);
          dropLayerBmp(outgoing);
          if (prefetched) { try { prefetched.close(); } catch (_) { /* 已关 */ } }   // r38：退化单图的预解码位图不再需要
          // contain（r36）：GL 只画完整核心，核心外的模糊底由 2D 层提供 ——
          // 这里必须把 2D 层按新图画好垫在 GL 下面。有过渡时底图随 GL 核心一起
          // 交叉淡入（bgFade，见 glTick），硬切会穿帮。
          const need2DBg = cfg.fit === 'contain';
          if (gl.bmp && (!animate || need2DBg)) {
            try {
              drawSource(incoming, gl.bmp, gl.bmp.width, gl.bmp.height);
              everRendered = true;
            } catch (_) { /* 垫底失败不致命 */ }
            if (!animate) {           // 垫底位图用完即弃；contain 过渡还要靠 GL 层带走
              try { gl.bmp.close(); } catch (_) { /* 已关 */ }
              gl.bmp = null;
              if (gl.layer) gl.layer._bmp = null;
            }
          }
          // GL 在管内容：cover/mirror 的 2D 层钉到终态（被 GL 全屏盖住）；
          // contain 的 incoming 2D 是模糊底，随动画淡入（outgoing 保持可见垫在下面）
          if (need2DBg && animate && glState.anim) {
            glState.anim.bgFade = { root: incoming.root };
            setLayer(incoming.root, REST, 0, 'px');
            setLayer(outgoing.root, REST, 1, 'px');
          } else {
            setLayer(incoming.root, REST, 1, 'px');
            setLayer(outgoing.root, REST, 0, 'px');
          }
          active = incomingKey;
          // r74 粒子深度遮挡：GL 深度帧上屏且 fit=cover 才喂（contain/mirror 的
          // 屏幕映射不同；拼接帧每格一张深度，不在本轮范围）
          if (cfg.fit === 'cover' && gl.layer && gl.layer.depthPx) {
            feedParticleDepth({
              data: gl.layer.depthPx.data,
              w: gl.layer.depthPx.w,
              h: gl.layer.depthPx.h,
              bw: gl.layer.iw,
              bh: gl.layer.ih,
            });
          }
          ensureRaf();
          return;
        }
      }
    }
    glFadeOutIfAny();   // 这张图没深度（或 GL 接管失败）→ 2D 上屏，视差层让路
    let bmp = prefetched;   // 拼接退化单图时中心位图已解码（r38）
    if (!bmp) {
      try {
        bmp = await fetchBitmap(entry);
      } catch (err) {
        console.warn('[stage] 取图失败:', entry.path, err.message);
        return;   // 调度器已把死图摘掉，下一帧会带新图来
      }
    }
    if (token !== animToken) { bmp.close(); return; }   // 等待期间又被切走了
    src = bmp; sw = bmp.width; sh = bmp.height;
  } else if (kind === 'video') {
    glFadeOutIfAny();   // 视频/网页壁纸不吃视差层
    const v = videoOf(incoming);
    const url = window.wp.stageUrl(entry.path);
    if (v.src !== url) v.src = url;                     // 换 src 会自动重载
    v.loop = !cfg.videoPlayFull;                        // 播完再切：不循环，ended 通知调度器
    try {
      await waitVideoReady(v);
    } catch {
      console.warn('[stage] 视频加载失败:', entry.path);
      // 调度器在 videoPlayFull 下对视频不挂定时器，坏视频不上报会永远卡住这条频道
      try { window.wp.stageVideoEnded(myChannel); } catch (_) { /* 静默 */ }
      return;   // 下一帧 tick 会带新条目来
    }
    if (token !== animToken) { v.pause(); return; }
    try { await v.play(); } catch { /* muted 自动播放一般不会拒；拒了就停在首帧 */ }
    if (token !== animToken) { v.pause(); return; }
    src = v; sw = v.videoWidth || 1920; sh = v.videoHeight || 1080;
  }

  // ── 活动视频交接：旧的立刻停（解码器释放），video→video 才允许切 src 复用 ──
  if (kind === 'video') {
    if (activeVideo && activeVideo !== src) activeVideo.pause();
    activeVideo = src;
  } else if (activeVideo) {
    activeVideo.pause();
    activeVideo = null;
  }

  finish2D(incoming, outgoing, src, sw, sh, kind, animate, incomingKey);
}

/** 2D 上屏 + 过渡收尾（r38 从 showFrame 抽出：普通单图 / 拼接画布 / 视频同一条链）。
 *  src 可为 ImageBitmap / <video> / 拼接画布（canvas 没有 close，位图留存只认有 close 的）。 */
function finish2D(incoming, outgoing, src, sw, sh, kind, animate, incomingKey, opts = {}) {
  // ── 上屏（网页壁纸没有 canvas 内容，iframe 自己就是内容）──
  // 槽位旧位图先清：incoming 马上换新内容，outgoing 即将隐退不再重画
  dropLayerBmp(incoming);
  dropLayerBmp(outgoing);
  if (kind === 'image' && opts.collage) {
    paintCollage(incoming, opts.collage);              // 拼接：逐格 cover 画进层画布
    everRendered = true;
    pan.x = 0; pan.y = 0; pan.dirty = false;           // 拼接无溢出，归中兜底
  } else if (kind === 'image') {
    drawSource(incoming, src, sw, sh);
    everRendered = true;                               // 解冻自愈标记：这一路出过画面了
    // r37：位图留在层上供裁切平移重画（r35 已把位图钳到屏幕级，两层常驻内存可控）
    if (typeof src.close === 'function') incoming.bmp = src;
    pan.x = 0; pan.y = 0; pan.dirty = false;           // 新图从居中起滑
  } else if (kind === 'video') {
    drawSource(incoming, src, sw, sh);                 // 先画上首帧，之后 rAF 接管
    everRendered = true;
  }

  const duration = animate ? Math.max(0, cfg.duration || 0) : 0;
  if (duration === 0) {
    clearFx(incoming.root);
    clearFx(outgoing.root);
    setLayer(incoming.root, REST, 1, 'px');
    setLayer(outgoing.root, REST, 0, 'px');
    active = incomingKey;
    ensureRaf();
    return;
  }

  // random：每次换图随机抽一种（与 GL 路径共用 pickAnimName，语义一致）
  const animName = pickAnimName();
  const v = variantFor(animName, currentDir);
  // 清掉上一次过渡可能残留的自绘样式（快速连切时上一次可能没走到收尾分支）
  clearFx(incoming.root);
  clearFx(outgoing.root);
  // 揭示类动画（clip）语义上要求新图盖在旧图上面；变换型统一也这样设，
  // 观感一致且不受 DOM 固定顺序（A 在 B 前）影响
  incoming.root.style.zIndex = '2';
  outgoing.root.style.zIndex = '1';
  if (v.tick) {
    // 自绘型起点：两层都必须完整可见（揭示语义：新图带 clip 盖在旧图上）。
    // ⚠️ 不能省 —— 图层复用时残留 opacity=0（上一轮它是出场层被钉 0），
    // clip 揭示的其实是透明层 = 看不到任何变化。
    setLayer(incoming.root, REST, 1, 'px');
    setLayer(outgoing.root, REST, 1, 'px');
    v.tick(incoming, outgoing, 0);                    // 再摆到入场起点（e=0）
  } else {
    setLayer(incoming.root, v.fromT, v.fromO, v.u);
  }
  void incoming.root.offsetWidth;                    // 强制样式结算，否则起始态被合并掉
  anim = { t0: performance.now(), duration, incoming, outgoing, v };
  active = incomingKey;
  ensureRaf();
}

/* ------------------------------------------------------------------ 配置与频道 */

function profileOf(id) {
  const ch = channels.find((c) => c.id === id);
  return (ch && ch.profile) || {};
}

function applyChannelConfig() {
  const p = profileOf(myChannel);
  if (p.animation) cfg.animation = p.animation;
  if (Number.isFinite(p.duration)) cfg.duration = p.duration;
  // 填充方式（r36）：运行中切换要当场收拾 2D 垫底层 —— GL 每帧读 uFit 立即生效，
  // 切到 contain 的瞬间核心外就透明了，底下没画模糊底就是一条黑缝；
  // 离开 contain（回 cover / 切 mirror）则把 2D 层藏掉（mirror 由 GL 全屏自绘）
  if (p.fit && p.fit !== cfg.fit) {
    feedParticleDepth(null);   // r74：fit 换挡后屏幕↔深度映射不再成立，作废等下帧重喂
    reportCollagePage(1);      // r75：离开拼接（或换新填充方式）先还原 1 格步长，拼图建成后再回报真实页宽
    cfg.fit = p.fit;
    if (glActive && glState.cur && glState.cur._bmp) {
      const cur2D = layers[active];
      if (cfg.fit === 'contain') {
        try {
          const b = glState.cur._bmp;
          drawSource(cur2D, b, b.width, b.height);
          setLayer(cur2D.root, REST, 1, 'px');
          cur2D.bmp = b;   // 交给裁切平移接着用（所有权与 GL 层共享，双 close 无害）
        } catch (_) { /* 补画失败不致命：下一拍 showFrame 会重新垫 */ }
      } else {
        setLayer(cur2D.root, REST, 0, 'px');
      }
    }
  }
  if (Number.isFinite(p.fpsCap)) cfg.fpsCap = p.fpsCap;
  // 裁切平移开关（r37，profile 不写 = 默认开）
  if (p.cropPan !== undefined) cfg.cropPan = Boolean(p.cropPan);
  // Ken Burns 开关（profile 不写 = 默认开）
  if (p.kenBurns !== undefined) cfg.kenBurns = Boolean(p.kenBurns);
  // 深度视差（profile 不写 = 默认开 —— 用户要求「所有壁纸自动有视差」）
  if (p.depthParallax !== undefined && Boolean(p.depthParallax) !== cfg.depthEnabled) {
    cfg.depthEnabled = Boolean(p.depthParallax);
    // 拼接分支以深度管线为前提（r38 设计）：深度一关，拼图不再构建，
    // 整页步长必须还原 1，否则调度器会整页跳过屏幕上没出现过的图
    reportCollagePage(1);
  }
  if (p.depthFlow !== undefined) cfg.depthFlow = Boolean(p.depthFlow);
  if (Number.isFinite(p.depthAmp)) cfg.depthAmp = p.depthAmp;
  if (Number.isFinite(p.depthDrift)) cfg.depthDrift = p.depthDrift;
  if (Number.isFinite(p.depthLight)) cfg.depthLight = p.depthLight;
  // DepthFlow 流模式参数（不写 = Circle 预设默认）
  if (Number.isFinite(p.flowIntensity)) cfg.flowIntensity = p.flowIntensity;
  if (Number.isFinite(p.flowIso)) cfg.flowIso = p.flowIso;
  if (Number.isFinite(p.flowSteady)) cfg.flowSteady = p.flowSteady;
  if (Number.isFinite(p.flowHeight)) cfg.flowHeight = p.flowHeight;
  if (typeof p.flowStyle === 'string' && FLOW_STYLE_PARAMS[p.flowStyle]) cfg.flowStyle = p.flowStyle;
  if (Number.isFinite(p.flowQuality)) cfg.flowQuality = Math.min(1, Math.max(0.15, p.flowQuality));
  // idle 微动画（r62，profile 不写 = 默认关）
  if (p.idleFx !== undefined) cfg.idleFx = Boolean(p.idleFx);
  // 分层氛围（r71，profile 不写 = 默认关）
  if (p.depthAtmo !== undefined) cfg.depthAtmo = Boolean(p.depthAtmo);
  // 调色板/雾/景深/丁达尔（r73；不写 = 默认值）
  if (p.atmoPalette !== undefined) {
    cfg.atmoPalette = ['auto', 'golden', 'tealorange', 'cyberpunk', 'moonlight', 'faded'].includes(p.atmoPalette) ? p.atmoPalette : 'auto';
  }
  // 鼠标影响动效（r70，profile 不写 = 默认开）：关 = 两个喂入口闸门不更新
  // glState.mouse，并立刻清 mouseUntil —— 混合权重 mouseW 按 0.02/帧平滑衰减，
  // ~2s 内镜头无跳变地回到预设轨迹。
  if (p.pointerFx !== undefined) {
    cfg.pointerFx = Boolean(p.pointerFx);
    if (!cfg.pointerFx) glState.mouseUntil = 0;
  }
  // 视频播完再切（profile 不写 = 默认关，按 interval 定时切）
  if (p.videoPlayFull !== undefined) cfg.videoPlayFull = Boolean(p.videoPlayFull);
  // 呼吸缩放（profile 不写 = 默认关）
  if (p.breath !== undefined) cfg.breath = Boolean(p.breath);
  // 呼吸节奏（主树 47 轮：周期/幅度可配；profile 不写 = 6000ms / ±2%）
  if (Number.isFinite(Number(p.breathPeriod))) {
    cfg.breathPeriod = Math.min(Math.max(Math.round(Number(p.breathPeriod)), 2000), 15000);
  }
  if (Number.isFinite(Number(p.breathAmplitude))) {
    cfg.breathAmplitude = Math.min(Math.max(Number(p.breathAmplitude), 0.5), 5);
  }
  // 时段滤镜已退役（r73 精简）：与氛围调色板重复且全图罩色观感差，按时段上色统一走 depthAtmo 调色板。
  // 旧键（timeOfDay/todRandom/todPool）已移出 PROFILE_KEYS 白名单，config 残留值无人读取，无害。
  // 粒子特效：种类白名单与数量收紧都在 particles.js 里做，这里透传。
  // setConfig 幂等（种类数量都没变 = 无操作），channels:changed 每次调过来也无妨。
  if (p.particles !== undefined) cfg.particles = String(p.particles || '');
  // r21：粒子随机池（random 时只抽池内种类；池空 = 全部参与）
  if (Array.isArray(p.particlePool)) cfg.particlePool = p.particlePool.filter((v) => typeof v === 'string');
  if (Number.isFinite(Number(p.particleCount))) cfg.particleCount = Number(p.particleCount);
  // 粒子绕开鼠标（主树 54 轮追记六，profile 不写 = 默认开）：关了就不把光标喂给粒子层
  if (p.particleCursor !== undefined) cfg.particleCursor = Boolean(p.particleCursor);
  // 粒子深度遮挡（r74）：只在值真变时作废当前深度帧 —— applyProfile 每次配置广播
  // 都带全量键（resolveProfile 连 undefined 一起拷），无脑清会把正在播的遮挡掐到下次换图
  if (p.particleDepth !== undefined && Boolean(p.particleDepth) !== cfg.particleDepth) {
    cfg.particleDepth = Boolean(p.particleDepth);
    feedParticleDepth(null);
  }
  rollParticles();
  if (particleFx) particleFx.setConfig(cfg.particlesActive, cfg.particleCount);
  // 特效从关到开会把 rAF 循环唤醒（冻结时 ensureRaf 自己会挡）
  ensureRaf();
}

/** random：每次换图从随机池里抽一种（池空 = 全部种类）。非 random 的值原样生效（含 '' = 关） */
function rollParticles() {
  if (cfg.particles !== 'random') { cfg.particlesActive = cfg.particles; return; }
  const all = (window.WPParticles && window.WPParticles.PARTICLE_TYPES) || ['rain', 'sakura'];
  const pool = (Array.isArray(cfg.particlePool) && cfg.particlePool.length
    ? all.filter((k) => cfg.particlePool.includes(k))
    : all);
  cfg.particlesActive = pool[(Math.random() * pool.length) | 0] || 'rain';
}

async function applyChannels(list) {
  /*
   * 兼容两种形态：数组（channels:changed 载荷）与 {channels:[...]} 整包
   * （listChannels 的返回值）。2026-09-25 实测：stage:bind 回调里直接
   * listChannels().then(applyChannels) 传进来整包对象 → channels 被清成 []、
   * currentEntry=null，舞台停在首帧（canvas 不清屏所以看起来「冻结」）。
   * 与其要求每个调用点都记得拆包，不如这里统一兜底。
   */
  channels = Array.isArray(list) ? list
    : (list && Array.isArray(list.channels)) ? list.channels
    : [];
  if (!applyChannels._logged) {
    applyChannels._logged = true;
    console.log(`[stage] applyChannels#1 channels=${channels.length} myChannel=${myChannel}`);
  }
  if (!myChannel) {
    // 没收到 bind（例如手动把 stage 页开在普通窗口里）：退回第一个可用频道
    const pick = channels.find((c) => c.enabled !== false && c.count > 0) || channels[0];
    myChannel = pick ? pick.id : null;
  }
  applyChannelConfig();
  if (!myChannel) { currentEntry = null; return; }
  const ch = channels.find((c) => c.id === myChannel);
  if (!ch || !ch.current) { currentEntry = null; return; }
  myChannelIndex = ch.index || 0;   // 拼接取邻居用（tick 未到前先对齐一次）
  // 只在「当前帧变了」时重画 —— channels:changed 很频繁（改配置也会发），
  // 路径没变就什么都不做，避免把正在进行的过渡打断
  if (!currentEntry || currentEntry.path !== ch.current) {
    await showFrame({ path: ch.current, name: ch.name }, 1, false);
  }
}

/* ------------------------------------------------------------------ 事件 */

function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(async () => {
    if (particleFx) particleFx.resize();   // 粒子画布跟屏幕走，与当前帧类型无关
    if (!currentEntry) return;
    // 视频：下一 rAF 自动按新画布尺寸重画；网页：iframe 100% 自适应 —— 都不用管
    if (kindOf(currentEntry) !== 'image') return;
    if (glActive) return;   // 视差层 shader 按 canvas 尺寸重算 cover，无需重取图
    // resize 后重画当前帧。⚠️ 必须走 showFrame 本尊，不能自己 ++animToken 再手动画：
    // 手动画会 (a) 把取图途中的首帧 showFrame 整个作废 —— token 作废分支把它**静默**
    // 丢掉；而 (b) 自己画进的是还没点亮（opacity=0）的图层 —— 两件事叠加就是
    // 「启动后黑屏，必须等下一个 tick」（主树第 39 轮实锤，live 树分叉早一直没移植，
    // 2026-10-09 用户重启黑屏复现后才补上；之前靠「解冻自愈」兜底，所以表现为
    // 「黑一小段时间自己好」）。showFrame 自己管理 token 互斥，画完的图层一定是
    // 被点亮的那块。
    try {
      await showFrame(currentEntry, 1, false);
    } catch { /* 下一帧 tick 会带新图来 */ }
  }, RESIZE_DEBOUNCE);
}

async function init() {
  console.log(`[stage] init 开始 ua-ok=${Boolean(window.wp)}`);
  layers.A = {
    root: document.getElementById('layerA'),
    canvas: document.querySelector('#layerA canvas'),
  };
  layers.B = {
    root: document.getElementById('layerB'),
    canvas: document.querySelector('#layerB canvas'),
  };
  layers.A.ctx = layers.A.canvas.getContext('2d');
  layers.B.ctx = layers.B.canvas.getContext('2d');
  // 粒子层（particles.js 先于本文件加载）。缺了不致命：粒子开关静默失效，其余照常
  if (window.WPParticles && document.getElementById('particles')) {
    particleFx = window.WPParticles.createParticles(document.getElementById('particles'));
    particleFx.resize();
  }

  window.addEventListener('resize', onResize);
  // 旧 Progman 置顶路径的右键补偿。新 WorkerW 安全路径上舞台在图标下方，
  // 正常情况下收不到该事件；保留转发作为旧系统兼容。
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    try { window.wp.desktopContextMenu(e.screenX, e.screenY); } catch (_) { /* 转发失败静默 */ }
  }, true);
  // 转发出来的桌面菜单是 Explorer 的模态菜单，等不到舞台上的点击，永远不消失
  // （用户实测「点别处必须选一项才关」）。任何按下都通知主进程解除——右键按下
  // 也发：若旧菜单还开着，正好先关旧的，随后的 contextmenu 再弹新的。
  window.addEventListener('mousedown', () => {
    try { window.wp.desktopCancelContextMenu(); } catch (_) { /* 静默 */ }
  }, true);

  window.wp.onStageBind((payload) => {
    myChannel = payload && payload.channelId;
    // bind 里带的是创建瞬间的暂停态（轮询事件只在变化时发，晚创建的窗口
    // 只等事件会错过当前状态）
    setFrozen(Boolean(payload && payload.paused));
    applyChannelConfig();
    wp.listChannels().then(applyChannels);
  });
  // 渲染端未捕获异常 → live-debug.log（「功能死了但没有报错」场景的唯一取证线索）
  window.addEventListener('error', (e) => {
    slog('渲染端错误 ——', e.message, '@', String(e.filename || '').split('/').pop(), e.lineno);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    slog('未处理 Promise 拒绝 ——', r && (r.stack || r.message) || String(r));
  });
  window.wp.onStagePause((payload) => {
    setFrozen(Boolean(payload && payload.paused));
  });
  // 深度视差：鼠标临时接管视角（不动就走自动漂移；坐标是 CSS 的，归一化即可）。
  // ⚠️ raised-WorkerW 挂载后这条本地 mousemove 收不到（见下方 onStageMouse）——
  // 保留它作为「挂载拓扑允许原生输入到达舞台」时的兜底，两条路并存不冲突。
  window.addEventListener('mousemove', (e) => {
    // pointerFx 关（r70）：不喂视差镜头（粒子避让光标喂送不受此闸门管，独立开关）
    if (cfg.pointerFx !== false) {
      glState.mouse = [(e.clientX / Math.max(1, innerWidth)) * 2 - 1, (e.clientY / Math.max(1, innerHeight)) * 2 - 1];
      glState.mouseUntil = performance.now() + 2500;
    }
    if (particleFx && cfg.particleCursor) particleFx.setCursor(e.clientX, e.clientY);
  }, { passive: true });
  // raised-WorkerW 挂载后桌面空白点的输入被图标层（SHELLDLL_DefView）截走，
  // 上面的原生 mousemove 收不到了 —— 深度视差接管 / 粒子避让改吃主进程
  // GetCursorPos 轮询喂送（30Hz，语义与 mousemove 一致：只在移动时来，
  // 停手 2.5s 后 mouseUntil 过期自然回落自动漂移）。两条路并存：
  // 哪天挂载拓扑让舞台重新吃得到原生输入，本地 mousemove 照样生效。
  if (window.wp.onStageMouse) {
    window.wp.onStageMouse((p) => {
      if (!p || typeof p.nx !== 'number') return;
      // pointerFx 关（r70）：同本地 mousemove 的闸门 —— 只挡视差镜头喂送
      if (cfg.pointerFx !== false) {
        glState.mouse = [p.nx, p.ny];
        glState.mouseUntil = performance.now() + 2500;
      }
      if (particleFx && cfg.particleCursor) particleFx.setCursor(p.x, p.y);
    });
  }
  // 深度生成完成 → 正在显示这张图的话，现场从 2D 升级成视差（短交叉淡入）。
  // ⚠️ 不能因 glState.anim 直接放弃：上一张视差的退场淡出（~900ms）和本张的
  // depth:ready（~1s）几乎同时到期，抢先把升级 return 掉这张图就永远停在 2D
  // —— 真机表现恰好是「隔一张才有视差」。改为等退场走完再重试（2026-10-09）。
  window.wp.onDepthReady((payload) => {
    tryDepthUpgrade(payload);
    tryCollageUpgrade(payload);   // 拼接模式：缺的格被补齐后整体升级 GL（r38）
  });

  /** 拼接升级（r38）：2D 拼接显示期间，任一格 depth:ready 都重查一遍——
   *  全部格就绪 → 用留存的格位图重拼两块画布 → GL 上屏。镜像 tryDepthUpgrade
   *  的守卫：过渡中不抢（等退场重试）、await 期间起过渡就放弃（下一拍自然 GL）。 */
  async function tryCollageUpgrade(payload, attempt = 0) {
    if (!collage.active || !currentEntry || frozen) return;
    if (!cfg.depthEnabled || cfg.fit !== 'collage') return;
    if (!collage.slots.some((s) => s.path === payload.path)) return;   // 别的图/别的屏的 ready
    if (anim) {   // 2D 过渡进行中：等它走完再升（同 tryDepthUpgrade 的退场等待）
      if (attempt < 40) setTimeout(() => tryCollageUpgrade(payload, attempt + 1), 250);
      return;
    }
    if (glActive || (glState.anim && glState.anim.in)) return;         // 已在 GL / 升级淡入进行中
    let missing = 0;
    for (const s of collage.slots) {
      if (s.depBmp) continue;
      let dp = null;
      try { dp = await window.wp.depthFor(s.path); } catch (_) { /* 仍缺 */ }
      if (!dp) { missing += 1; continue; }
      try { s.depBmp = await fetchBitmap({ path: dp }); } catch (_) { missing += 1; }
    }
    if (missing > 0 || glState.anim && glState.anim.in) return;        // 还缺 / await 期间被抢
    const { w: W, h: H } = canvasSize(layers.A.canvas);
    const comp = composeCollageCanvases(collage.slots, W, H);
    if (!comp.allReady) return;
    const gl = await glShowFrameCollage({ ...comp, aspect: W / H, n: collage.n }, animToken, { variant: false });
    if (gl.ok) {
      collage.active = false;
      const cur2D = layers[active];
      dropLayerBmp(cur2D);
      setLayer(cur2D.root, REST, 1, 'px');
      slog('拼接: 升级完成', String(currentEntry.path).split(/[\\/]/).pop());
      ensureRaf();
    }
  }
  async function tryDepthUpgrade(payload, attempt = 0) {
    if (!payload || !currentEntry || payload.path !== currentEntry.path) return;
    if (frozen) return;
    if (!cfg.depthEnabled || kindOf(currentEntry) !== 'image') return;
    // 已是「这张图自己」的稳态视差：不用升。（⚠️ 不能笼统判 glActive ——
    // 新图上屏时旧视差层要退场淡出 ~900ms，期间 glActive 仍为 true，
    // ready 在这个窗口到达就被丢 → 上一张视差则本张必丢 → 严格隔一张。
    // 2026-10-09 真机日志实锤。）
    if (glActive && glState.cur && glState.cur.imgPath === payload.path) return;
    if (glState.anim && glState.anim.in) return;       // GL 过渡/升级淡入进行中：不抢
    if (glActive || (glState.anim && !glState.anim.in)) {
      // 旧视差层退场淡出未完：等它走完再试，别放弃（放弃这张就永远停在 2D）
      if (attempt < 40) {
        slog('upgrade: 等视差层退场', attempt);
        setTimeout(() => tryDepthUpgrade(payload, attempt + 1), 250);
      }
      return;
    }
    glInit();
    if (!glState.ok) { slog('upgrade: GL 不可用', payload.path.split(/[\\/]/).pop()); return; }
    let dp = null;
    try { dp = await window.wp.depthFor(currentEntry.path); } catch (_) { return; }
    if (!dp || payload.path !== (currentEntry && currentEntry.path)) return;
    if (glState.anim && glState.anim.in) return;       // await 期间起了 GL 过渡/升级
    const inLayer = await glLayerFor(currentEntry.path, dp);
    if (!inLayer || payload.path !== (currentEntry && currentEntry.path)) { glFreeLayer(inLayer); return; }
    if (glState.anim && glState.anim.in) { glFreeLayer(inLayer); return; }   // 纹理等待期间被抢
    glState.anim = { t0: performance.now(), duration: 800, out: null, in: inLayer };
    inLayer.imgPath = currentEntry.path;
    glActive = true;   // out=null：GL 层直接淡入盖在 2D 画面上，无跳变
    ensureRaf();
    slog('upgrade: 升级完成', payload.path.split(/[\\/]/).pop());
  }
  window.wp.onChannelsChanged(async (payload) => {
    await applyChannels(payload && payload.channels);
  });
  /*
   * ⚠️ 必须是具名函数再挂 `_logged`：箭头匿名回调里写 `onChannelTick._logged`
   * 是裸标识符引用（渲染层没有这个名字）→ 每拍 tick 一进来就
   * ReferenceError: onChannelTick is not defined，永远走不到 showFrame
   * （2026-09-25 真机实锤：桌面永远停在启动首帧，「后续都没有改」）。
   * console-message 转发日志里表现为 preload.js:163 的 Uncaught Error。
   */
  function onTick(payload) {
    if (!onTick._logged) {
      onTick._logged = true;
      console.log(`[stage] 收到首个 tick: id=${payload && payload.id} myChannel=${myChannel} frozen=${frozen}`);
    }
    if (!payload || payload.id !== myChannel) return;   // 每块 stage 只听自己频道
    myChannelIndex = payload.index || 0;                // 拼接取邻居用（r38）
    if (frozen) return;   // 暂停：留在当前帧，新图等恢复后下一拍再上
    if (payload.entry) {
      if (cfg.particles === 'random') {   // 随机粒子：每次换图重抽一种（手动翻页也走 tick）
        rollParticles();
        if (particleFx) particleFx.setConfig(cfg.particlesActive, cfg.particleCount);
      }
      showFrame(payload.entry, payload.dir, true);
    } else {
      currentEntry = null;   // 频道空了（相簿被清空）→ 黑屏
    }
  }
  window.wp.onChannelTick(onTick);

  // ⚠️ listChannels 返回的是 {channels:[...],...} 整包，不是数组 —— 直接传会把
  // channels 清空成 []（2026-09-25 实测：init 后 channels=0、currentEntry=null，
  // 舞台黑屏，靠后面 channels:changed 才可能补救；第二块屏没补到就一直黑）
  const listRes = await window.wp.listChannels();
  await applyChannels(Array.isArray(listRes) ? listRes : (listRes && listRes.channels) || []);
  console.log(`[stage] init 完成 myChannel=${myChannel} channels=${channels.length} currentEntry=${currentEntry ? currentEntry.path : 'null'}`);
  ensureRaf();
}

init().catch((err) => {
  console.error('[stage] 初始化失败:', err);
});
