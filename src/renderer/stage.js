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

/** 时段滤镜：色温罩在 #tod（CSS 渐变 + mix-blend-mode），去饱和/压暗写在 .layer 的 filter */
const TOD_FILTERS = {
  morning:  'brightness(1.04) saturate(1.05)',
  noon:     'brightness(1.06) contrast(1.02)',
  overcast: 'saturate(0.6) brightness(0.93) contrast(0.97)',
  dusk:     'brightness(0.96) saturate(1.12)',
  night:    'brightness(0.72) saturate(0.82)',
};

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
  timeOfDay: '',               // 时段滤镜（profile.timeOfDay：morning/noon/overcast/dusk/night）
  depthEnabled: true,          // 深度视差（profile.depthParallax=false 关；默认开）
  depthFlow: true,             // DepthFlow POM 模式（profile.depthFlow=false 回退第五轮单平面；
                               // 离线逐帧对比 5 相位全帧差 ≈2.5 噪声级后默认开，真机验收后落库）
  depthAmp: 0.07,              // 视差幅度（profile.depthAmp）
  depthDrift: 1.0,             // 自动漂移速度倍率（profile.depthDrift）
  depthLight: 0.45,            // 灯光强度（profile.depthLight）
  // ---- DepthFlow 流模式参数（Circle 预设默认值；profile 同名键）----
  flowIntensity: 0.5,          // 轨迹幅度（0.5 = Circle 预设；鼠标接管幅度同源）
  flowIso: 0.6,                // 斜视角（越大立体越强、越歪）
  flowSteady: 0.3,             // 背景稳定点（越大背景越稳、前景越动）
  flowHeight: 0.2,             // 视差强度主旋钮（DepthState.height 默认）
  flowQuality: 0.5,            // POM 步进质量 0.15~1（0.5=DepthFlow CLI 默认；0.3≈省 30% GPU）
};

const layers = {
  A: null, B: null,            // { root, canvas, ctx }，init 时填充
};
let todEl = null;              // 时段滤镜罩层（#tod，init 时填充）
let active = 'B';

let animToken = 0;             // 过渡令牌：新过渡让进行中的旧过渡作废
let anim = null;               // { t0, duration, incoming, outgoing, v }
let rafId = 0;
let lastPaint = 0;             // fpsCap 时间闸门
const ken = { start: 0 };      // Ken Burns 相位（永不重置 —— 重置就是跳变）
let activeVideo = null;        // 当前在播的 <video>（视频壁纸时非空，图片/网页壁纸为 null）

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
function drawSource(layer, src, sw, sh) {
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
  } else {
    const r = coverRect(W, H, sw, sh);
    ctx.drawImage(src, r.x, r.y, r.w, r.h);
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
    return await createImageBitmap(await fetchOnce(entry, 8000));
  } catch (err) {
    slog('取图超时/失败，重开一次请求 ——', String(entry.path).split(/[\\/]/).pop(), err.message);
    return await createImageBitmap(await fetchOnce(entry, 8000));
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
 * 与 2D 路径的分工：本层盖在 layerA/B 之上（z-index 3，#tod 是 4）。
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

// stuv 域镜像重复采样 —— 等价 depthflow gtexture(..., true) 的边缘外扩，
// 大角度视差露边时不再是黑边/钳位硬边（Tiefling「边缘扩展」同款思路）
vec4 texMirror(sampler2D tex, vec2 stuv) {
  return texture2D(tex, 1.0 - abs(1.0 - mod(stuv, 2.0)));
}

// DepthFlow POM 主路径（语义 1:1 对齐 depthflow.glsl + shaderflow camera.glsl）
// Circle 预设参数：offset 幅度 0.5 / isometric 0.60 / steady 0.30；DepthState 默认 height 0.20。
// 相机：origin 在 z=0 平面按 zoom*isometric 缩放，target 在 z=focal 平面按 zoom 缩放，
// 与 z=1 深度面求交后，两阶段步进（粗探 overshoot + 细步回退）找视线与深度面的交点。
vec3 flowSample(vec2 g0, vec2 off, float imgAspect) {
  float height = uFlowHeight;   // 视差强度主旋钮（cfg.flowHeight，默认 0.20=DepthState）
  float steady = uFlowSteady;   // Circle 预设默认 0.30：固定点绕 depth=steady 转动
  float isom   = uFlowIso;      // Circle 预设默认 0.60：视线平行分量
  float focal  = 1.0;    // focus=0 → focal_length = 1 - focus*height
  // camera.glsl CameraProject（透视投影）：origin/target 各在 z=0 / z=focal 平面
  vec3 origin = vec3(off + g0 * (isom), 0.0);
  vec3 target = vec3(off + g0, focal);
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
  return texMirror(uImg, stF).rgb;
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

  // ---- DepthFlow POM 模式：无 margin（靠镜像重复兜边，与原版观感一致）----
  if (uFlow > 0.5 && uHasDepth > 0.5) {
    vec2 off = uFlowOff * crop;   // 屏幕位移 → 图像 gluv 空间（cover 裁切同比缩放）
    vec2 g0 = (vec2(0.5) + (uv01 - 0.5) * crop - 0.5) * 2.0 * vec2(uImgAspect, 1.0);
    gl_FragColor = vec4(flowSample(g0, off, uImgAspect), uAlpha);
    return;
  }

  float margin = uAmp * 0.55 + 0.015;
  vec2 zoom = crop * (1.0 - 2.0 * margin);
  vec2 uv = vec2(0.5) + (uv01 - 0.5) * zoom;

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
      'uFlowIso', 'uFlowSteady', 'uFlowHeight', 'uFlowQ']) U[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(U.uImg, 0);
    gl.uniform1i(U.uDepth, 1);
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

function glFreeLayer(L) {
  if (!L || !glState.gl) return;
  for (const t of [L.imgTex, L.depTex]) if (t) glState.gl.deleteTexture(t);
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
    const [bmp, depBmp] = await Promise.all([
      fetchBitmap({ path: imagePath }),
      depthPath ? fetchBitmap({ path: depthPath }).catch(() => null) : Promise.resolve(null),
    ]);
    const layer = {
      imgTex: glMakeTex(0, bmp),
      depTex: depBmp ? glMakeTex(1, depBmp) : null,
      aspect: bmp.width / bmp.height,
    };
    if (depBmp) depBmp.close();
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
 * 流模式（DepthFlow Circle 移植）相机位移：8s 一圈的圆轨迹（与样片同款），
 * 周期 = 2π 保证首尾无缝；鼠标接管时同一平滑权重淡入。
 * 幅度 0.5 = DepthFlow Circle 预设 intensity；depthDrift 只调速不破坏连续性。
 * ⚠️ y 轴符号：shader 内 uv01 已翻成「y 向下」屏幕系（与 clientY 同向），而
 * DepthFlow 的 offset 是 y 向上 —— 离线逐帧对比实锤（negoff_y 变体把帧差从
 * ~21 打到 ~2.5 噪声级），所以自动漂移的 y 取反进 uniform；鼠标 clientY 本就
 * y 向下，天然同轴，不再翻。
 */
function glCamFlow(tSec, nowMs) {
  const amp = cfg.flowIntensity;   // Circle 预设 0.5；鼠标接管幅度同源
  const cycle = (tSec / 8.0) * Math.PI * 2 * cfg.depthDrift;
  const ax = Math.cos(cycle) * amp;
  const ay = -Math.sin(cycle) * amp;   // DepthFlow offset 是 y 向上，这里 y 向下
  const active = nowMs < glState.mouseUntil;
  glState.mouseW += ((active ? 1 : 0) - glState.mouseW) * (active ? 0.10 : 0.02);
  return [
    ax * (1 - glState.mouseW) + glState.mouse[0] * amp * glState.mouseW,
    ay * (1 - glState.mouseW) - glState.mouse[1] * amp * glState.mouseW,
  ];
}

function glDrawLayer(L, alpha, cam, tSec) {
  const gl = glState.gl;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, L.imgTex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, L.depTex || L.imgTex);   // 无深度时占位（uHasDepth 压平）
  const { w, h } = canvasSize(glState.canvas);
  gl.viewport(0, 0, w, h);
  gl.uniform2f(glState.U.uCanvas, w, h);
  gl.uniform1f(glState.U.uImgAspect, L.aspect);
  gl.uniform1f(glState.U.uTime, tSec);
  gl.uniform2f(glState.U.uCam, cam[0], cam[1]);
  gl.uniform1f(glState.U.uAmp, cfg.depthAmp);
  gl.uniform1f(glState.U.uNrm, 9.0);
  gl.uniform1f(glState.U.uLight, cfg.depthLight);
  gl.uniform1f(glState.U.uLightsOn, 1);
  gl.uniform1f(glState.U.uHasDepth, L.depTex ? 1 : 0);
  gl.uniform1f(glState.U.uAlpha, alpha);
  gl.uniform1f(glState.U.uFlow, cfg.depthFlow ? 1 : 0);
  gl.uniform2f(glState.U.uFlowOff, cam[0], cam[1]);
  gl.uniform1f(glState.U.uFlowIso, cfg.flowIso);
  gl.uniform1f(glState.U.uFlowSteady, cfg.flowSteady);
  gl.uniform1f(glState.U.uFlowHeight, cfg.flowHeight);
  gl.uniform1f(glState.U.uFlowQ, Math.min(1, Math.max(0.15, cfg.flowQuality || 0.5)));
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
    const p = Math.min(1, (now - glState.anim.t0) / Math.max(1, glState.anim.duration));
    const e = easeCubicBezier(p);
    if (glState.anim.out) glDrawLayer(glState.anim.out, 1, cam, tSec);   // 底：完全不透明
    if (glState.anim.in) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      glDrawLayer(glState.anim.in, e, cam, tSec);                        // 顶层淡入（src-over，正确合成不压暗）
    }
    if (p >= 1) {
      glFreeLayer(glState.anim.out);
      glState.cur = glState.anim.in;
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
async function glShowFrame(entry, outgoingPath, token) {
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
    glState.anim = { t0: performance.now(), duration: Math.max(0, cfg.duration || 0), out: outLayer, in: inLayer };
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
    const ph = (now % BREATH.period) / BREATH.period;   // 0..1
    s += BREATH.amplitude * (0.5 - 0.5 * Math.cos(ph * 2 * Math.PI));
  }
  layer.canvas.style.transform = `scale(${s.toFixed(5)})`;
}

/** 应用时段滤镜：#tod 罩色温 + .layer 根上写 filter（去饱和/压暗） */
function applyTod(mode) {
  const m = TOD_FILTERS[mode] ? mode : '';
  cfg.timeOfDay = m;
  for (const key of ['A', 'B']) {
    const layer = layers[key];
    if (layer && layer.root) layer.root.style.filter = m ? TOD_FILTERS[m] : '';
  }
  // 视差层同样吃色温（GL canvas 上写 filter，与 .layer 同一套字符串）
  if (glState.canvas) glState.canvas.style.filter = m ? TOD_FILTERS[m] : '';
  if (todEl) todEl.className = m ? `tod-on tod-${m}` : '';
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
  const loop = (now) => {
    rafId = 0;
    if (gate(now)) {
      animTick(now);
      kenTick(now);
      glTick(now);
      // 视频壁纸：每帧把 <video> 的当前画面画进活动层（过渡动画是 root 的
      // CSS 样式，与 canvas 内容正交，两者并行不冲突）
      if (activeVideo && currentEntry && kindOf(currentEntry) === 'video') {
        drawSource(layers[active], activeVideo, activeVideo.videoWidth, activeVideo.videoHeight);
      }
    }
    if (frozen) return;                    // 暂停：这一帧画完就停表
    if (anim || currentEntry) rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

function setFrozen(next) {
  if (frozen === Boolean(next)) return;
  frozen = Boolean(next);
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
    // ── 深度视差：查 sidecar（命中→GL 路径；未命中→主进程入队后台生成，本帧 2D）──
    if (cfg.depthEnabled && typeof window.wp.depthFor === 'function') {
      let depthPath = null;
      try { depthPath = await window.wp.depthFor(entry.path); } catch (_) { /* 查询失败按无深度 */ }
      slog(`tick ${depthPath ? 'hit ' : 'miss'} ${String(entry.path).split(/[\\/]/).pop()}`);
      if (depthPath && entry.depth !== false) {
        const depthEntry = { ...entry, depth: depthPath };
        const gl = await glShowFrame(depthEntry, currentEntry && currentEntry !== entry ? currentEntry.path : null, token);
        if (gl.ok) {
          hideIframe(incoming);
          hideIframe(outgoing);
          // 2D 垫底（仅无过渡的启动/重显场景）：GL 万一没画出来（纹理流卡死、
          // glTick 没跑），桌面也不至于黑屏 —— GL 内容与垫底相同，淡入叠上去无感知。
          // 真实过渡（animate=true）仍由 GL 全权做交叉淡入，不垫底以免硬切穿帮。
          if (!animate && gl.bmp) {
            try {
              drawSource(incoming, gl.bmp, gl.bmp.width, gl.bmp.height);
              everRendered = true;
            } catch (_) { /* 垫底失败不致命 */ }
            try { gl.bmp.close(); } catch (_) { /* 已关 */ }
            gl.bmp = null;
            if (gl.layer) gl.layer._bmp = null;
          }
          // GL 在管内容：2D 层钉到终态（垫底图留在 GL 层下面被盖住）
          setLayer(incoming.root, REST, 1, 'px');
          setLayer(outgoing.root, REST, 0, 'px');
          active = incomingKey;
          ensureRaf();
          return;
        }
      }
    }
    glFadeOutIfAny();   // 这张图没深度（或 GL 接管失败）→ 2D 上屏，视差层让路
    let bmp;
    try {
      bmp = await fetchBitmap(entry);
    } catch (err) {
      console.warn('[stage] 取图失败:', entry.path, err.message);
      return;   // 调度器已把死图摘掉，下一帧会带新图来
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

  // ── 上屏（网页壁纸没有 canvas 内容，iframe 自己就是内容）──
  if (kind === 'image') {
    drawSource(incoming, src, sw, sh);
    everRendered = true;                               // 解冻自愈标记：这一路出过画面了
    src.close();                                       // 关键：立即释放解码位图
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

  // random：每次换图随机抽一种（profile.animation='random' 时）
  const animName = cfg.animation === 'random'
    ? RANDOM_POOL[Math.floor(Math.random() * RANDOM_POOL.length)]
    : cfg.animation;
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
  if (p.fit) cfg.fit = p.fit;
  if (Number.isFinite(p.fpsCap)) cfg.fpsCap = p.fpsCap;
  // Ken Burns 开关（profile 不写 = 默认开）
  if (p.kenBurns !== undefined) cfg.kenBurns = Boolean(p.kenBurns);
  // 深度视差（profile 不写 = 默认开 —— 用户要求「所有壁纸自动有视差」）
  if (p.depthParallax !== undefined) cfg.depthEnabled = Boolean(p.depthParallax);
  if (p.depthFlow !== undefined) cfg.depthFlow = Boolean(p.depthFlow);
  if (Number.isFinite(p.depthAmp)) cfg.depthAmp = p.depthAmp;
  if (Number.isFinite(p.depthDrift)) cfg.depthDrift = p.depthDrift;
  if (Number.isFinite(p.depthLight)) cfg.depthLight = p.depthLight;
  // DepthFlow 流模式参数（不写 = Circle 预设默认）
  if (Number.isFinite(p.flowIntensity)) cfg.flowIntensity = p.flowIntensity;
  if (Number.isFinite(p.flowIso)) cfg.flowIso = p.flowIso;
  if (Number.isFinite(p.flowSteady)) cfg.flowSteady = p.flowSteady;
  if (Number.isFinite(p.flowHeight)) cfg.flowHeight = p.flowHeight;
  if (Number.isFinite(p.flowQuality)) cfg.flowQuality = Math.min(1, Math.max(0.15, p.flowQuality));
  // 视频播完再切（profile 不写 = 默认关，按 interval 定时切）
  if (p.videoPlayFull !== undefined) cfg.videoPlayFull = Boolean(p.videoPlayFull);
  // 呼吸缩放（profile 不写 = 默认关）
  if (p.breath !== undefined) cfg.breath = Boolean(p.breath);
  // 时段滤镜（profile 不写 = 无）
  if (p.timeOfDay !== undefined) applyTod(String(p.timeOfDay || ''));
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
  todEl = document.getElementById('tod');

  window.addEventListener('resize', onResize);
  // 舞台盖在图标层之上必然吃掉鼠标（LAYERED 穿透会让 Chromium 白屏，见 desktopHost）。
  // 右键不能就这么吞了：preventDefault 后把屏幕坐标交给主进程转发给 DefView，
  // Explorer 会照常弹出桌面菜单（探针 tools/tmp/probe-ctxmenu.js 已验证可行）。
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
  // 深度视差：鼠标临时接管视角（不动就走自动漂移；坐标是 CSS 的，归一化即可）
  window.addEventListener('mousemove', (e) => {
    glState.mouse = [(e.clientX / Math.max(1, innerWidth)) * 2 - 1, (e.clientY / Math.max(1, innerHeight)) * 2 - 1];
    glState.mouseUntil = performance.now() + 2500;
  }, { passive: true });
  // 深度生成完成 → 正在显示这张图的话，现场从 2D 升级成视差（短交叉淡入）。
  // ⚠️ 不能因 glState.anim 直接放弃：上一张视差的退场淡出（~900ms）和本张的
  // depth:ready（~1s）几乎同时到期，抢先把升级 return 掉这张图就永远停在 2D
  // —— 真机表现恰好是「隔一张才有视差」。改为等退场走完再重试（2026-10-09）。
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
  window.wp.onDepthReady(tryDepthUpgrade);
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
    if (frozen) return;   // 暂停：留在当前帧，新图等恢复后下一拍再上
    if (payload.entry) {
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
