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

/** Ken Burns：一次完整「推进-退回」的周期。慢到几乎察觉不到在动，但桌面是活的 */
const KEN = { period: 45_000, amplitude: 0.045, travel: 14 };

/** resize 后重绘的防抖 */
const RESIZE_DEBOUNCE = 200;

/* ------------------------------------------------------------------ 状态 */

let myChannel = null;          // 本窗口绑定的频道 id（stage:bind 指定）
let channels = [];             // 频道信息表（channels:changed 维护）
let currentEntry = null;       // 当前帧（resize 重绘要用）
let currentDir = 1;

const cfg = {
  animation: 'slide',
  duration: 520,
  fit: 'cover',
  fpsCap: 30,
};

const layers = {
  A: null, B: null,            // { root, canvas, ctx }，init 时填充
};
let active = 'B';

let animToken = 0;             // 过渡令牌：新过渡让进行中的旧过渡作废
let anim = null;               // { t0, duration, incoming, outgoing, v }
let rafId = 0;
let lastPaint = 0;             // fpsCap 时间闸门
const ken = { start: 0, dx: 1, dy: 0 };

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

/** 过渡变体：与 app.js 的 variantFor 同一套观感，但改成可插值的结构化形式 */
function variantFor(animation, dir) {
  const sign = dir >= 0 ? 1 : -1;
  switch (animation) {
    case 'fade':
      return { u: 'px', fromT: { x: 0, y: 0, s: 1 }, fromO: 0, toT: { x: 0, y: 0, s: 1 }, toO: 0 };
    case 'zoom':
      return { u: 'px', fromT: { x: 0, y: 0, s: 1.07 }, fromO: 0, toT: { x: 0, y: 0, s: 0.985 }, toO: 0 };
    case 'slide':
    default:
      return { u: '%', fromT: { x: sign * 100, y: 0, s: 1 }, fromO: 1, toT: { x: -sign * 100, y: 0, s: 1 }, toO: 1 };
  }
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
  const { w: W, h: H } = canvasSize(layer.canvas);
  const ctx = layer.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.clearRect(0, 0, W, H);

  if (cfg.fit === 'contain') {
    // 四周：同一张图 cover 画满 + 模糊（放大 12% 让模糊边缘落在画布外，不露透明底）
    ctx.save();
    ctx.filter = `blur(${Math.max(12, Math.round(Math.min(W, H) * 0.03))}px)`;
    const bg = coverRect(W, H, bmp.width, bmp.height, 1.12);
    ctx.drawImage(bmp, bg.x, bg.y, bg.w, bg.h);
    ctx.restore();
    ctx.filter = 'none';
    const core = containRect(W, H, bmp.width, bmp.height);
    ctx.drawImage(bmp, core.x, core.y, core.w, core.h);
  } else {
    const r = coverRect(W, H, bmp.width, bmp.height);
    ctx.drawImage(bmp, r.x, r.y, r.w, r.h);
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

/* ------------------------------------------------------------------ rAF 循环 */

/** fpsCap 闸门：不到间隔就不写样式（rAF 本身继续跑，恢复时才准点） */
function gate(now) {
  const min = 1000 / Math.max(5, cfg.fpsCap || 30);
  if (now - lastPaint < min) return false;
  lastPaint = now;
  return true;
}

function kenTick(now) {
  if (!currentEntry) return;
  const layer = layers[active];
  const t = ((now - ken.start) % (KEN.period * 2)) / KEN.period;
  const k = t <= 1 ? t : 2 - t;                       // 0→1→0 往返，无跳变
  const e = easeCubicBezier(k);
  const s = 1 + KEN.amplitude * e;
  const tx = (k - 0.5) * 2 * KEN.travel * ken.dx;
  const ty = (k - 0.5) * 2 * KEN.travel * ken.dy;
  layer.canvas.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${s.toFixed(5)})`;
}

function animTick(now) {
  if (!anim) return;
  const p = Math.min(1, (now - anim.t0) / anim.duration);
  const e = easeCubicBezier(p);
  const { incoming, outgoing, v } = anim;
  setLayer(incoming.root,
    { x: lerp(v.fromT.x, 0, e), y: lerp(v.fromT.y, 0, e), s: lerp(v.fromT.s, 1, e) },
    lerp(v.fromO, 1, e), v.u);
  setLayer(outgoing.root,
    { x: lerp(0, v.toT.x, e), y: lerp(0, v.toT.y, e), s: lerp(1, v.toT.s, e) },
    lerp(1, v.toO, e), v.u);
  if (p >= 1) {
    // 后层钉死在透明+原位，避免下次复用残留位移
    setLayer(outgoing.root, REST, 0, 'px');
    anim = null;
    ken.start = performance.now();   // Ken Burns 从新帧重新起算，方向也换一个
    const ang = Math.random() * Math.PI * 2;
    ken.dx = Math.cos(ang);
    ken.dy = Math.sin(ang);
  }
}

function ensureRaf() {
  if (rafId || frozen) return;
  const loop = (now) => {
    rafId = 0;
    if (gate(now)) {
      animTick(now);
      kenTick(now);
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
  } else {
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

  let bmp;
  try {
    bmp = await fetchBitmap(entry);
  } catch (err) {
    console.warn('[stage] 取图失败:', entry.path, err.message);
    return;   // 调度器已把死图摘掉，下一帧会带新图来
  }
  if (token !== animToken) { bmp.close(); return; }   // 等待期间又被切走了

  const incomingKey = active === 'A' ? 'B' : 'A';
  const incoming = layers[incomingKey];
  const outgoing = layers[active];
  paintLayer(incoming, bmp);
  bmp.close();                                       // 关键：立即释放解码位图

  const duration = animate ? Math.max(0, cfg.duration || 0) : 0;
  if (duration === 0) {
    setLayer(incoming.root, REST, 1, 'px');
    setLayer(outgoing.root, REST, 0, 'px');
    active = incomingKey;
    ken.start = performance.now();
    ensureRaf();
    return;
  }

  const v = variantFor(cfg.animation, currentDir);
  setLayer(incoming.root, v.fromT, v.fromO, v.u);    // 先摆到入场起点
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
}

async function applyChannels(list) {
  channels = Array.isArray(list) ? list : [];
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
    if (currentEntry) {
      // canvas 尺寸变了，旧像素内容会被拉伸 —— 按新尺寸重画当前帧（不做过渡）
      const token = ++animToken;
      try {
        const bmp = await fetchBitmap(currentEntry);
        if (token !== animToken) { bmp.close(); return; }
        paintLayer(layers[active], bmp);
        bmp.close();
      } catch { /* 下一帧 tick 会带新图来 */ }
    }
  }, RESIZE_DEBOUNCE);
}

async function init() {
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
  window.wp.onChannelTick((payload) => {
    if (!payload || payload.id !== myChannel) return;   // 每块 stage 只听自己频道
    if (frozen) return;   // 暂停：留在当前帧，新图等恢复后下一拍再上
    if (payload.entry) {
      showFrame(payload.entry, payload.dir, true);
    } else {
      currentEntry = null;   // 频道空了（相簿被清空）→ 黑屏
    }
  });

  await applyChannels(await window.wp.listChannels());
  ensureRaf();
}

init().catch((err) => {
  console.error('[stage] 初始化失败:', err);
});
