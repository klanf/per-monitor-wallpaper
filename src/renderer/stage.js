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
};

const layers = {
  A: null, B: null,            // { root, canvas, ctx }，init 时填充
};
let active = 'B';

let animToken = 0;             // 过渡令牌：新过渡让进行中的旧过渡作废
let anim = null;               // { t0, duration, incoming, outgoing, v }
let rafId = 0;
let lastPaint = 0;             // fpsCap 时间闸门
const ken = { start: 0 };      // Ken Burns 相位（永不重置 —— 重置就是跳变）
let activeVideo = null;        // 当前在播的 <video>（视频壁纸时非空，图片/网页壁纸为 null）

/** 全屏 / 锁屏暂停（stage:pause）：冻结 = 停 rAF，画面钉在当前帧 */
let frozen = false;

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
 */
async function fetchBitmap(entry) {
  const res = await fetch(window.wp.stageUrl(entry.path));
  if (!res.ok) throw new Error(`wpimg ${res.status}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);   // 解码在后台线程，不卡渲染
  return bmp;
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

/* ------------------------------------------------------------------ rAF 循环 */

/** fpsCap 闸门：不到间隔就不写样式（rAF 本身继续跑，恢复时才准点） */
function gate(now) {
  const min = 1000 / Math.max(5, cfg.fpsCap || 30);
  if (now - lastPaint < min) return false;
  lastPaint = now;
  return true;
}

function kenTick(now) {
  const layer = layers[active];
  if (!cfg.kenBurns) {
    // 关掉时把画布钉回原位（只写一次，别每帧都碰样式）
    if (!ken._cleared) {
      layer.canvas.style.transform = 'none';
      ken._cleared = true;
    }
    return;
  }
  ken._cleared = false;
  if (!currentEntry) return;
  const t = ((now - ken.start) % (KEN.period * 2)) / KEN.period;
  const k = t <= 1 ? t : 2 - t;                       // 0→1→0 往返，无跳变
  const e = easeCubicBezier(k);
  const s = 1 + KEN.amplitude * e;                    // ≥1，永不露边
  layer.canvas.style.transform = `scale(${s.toFixed(5)})`;
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
    iframeOf(incoming, window.wp.stageUrl(entry.path));
  } else {
    hideIframe(incoming);
  }

  if (kind === 'image') {
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
    src.close();                                       // 关键：立即释放解码位图
  } else if (kind === 'video') {
    drawSource(incoming, src, sw, sh);                 // 先画上首帧，之后 rAF 接管
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
  // 视频播完再切（profile 不写 = 默认关，按 interval 定时切）
  if (p.videoPlayFull !== undefined) cfg.videoPlayFull = Boolean(p.videoPlayFull);
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
    // canvas 尺寸变了，旧像素内容会被拉伸 —— 按新尺寸重画当前帧（不做过渡）
    const token = ++animToken;
    try {
      const bmp = await fetchBitmap(currentEntry);
      if (token !== animToken) { bmp.close(); return; }
      paintLayer(layers[active], bmp);
      bmp.close();
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
  window.wp.onStagePause((payload) => {
    setFrozen(Boolean(payload && payload.paused));
  });
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
