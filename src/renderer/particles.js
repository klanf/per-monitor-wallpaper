'use strict';

/**
 * 舞台粒子图层 —— 雨落 / 樱花落（profile.particles / profile.particleCount）。
 *
 * 定位（交接文档 11.7 #9 的拍板）：
 *   · 独立 <canvas id="particles">，盖在两个 .layer（图片层）之上、#tod（时段滤镜）
 *     之下 —— 滤镜连粒子一起调色，画面是一体的；
 *   · 由 stage.js 的 rAF gate 块驱动：fpsCap 一起被限住；stage:pause 冻结 = 停 rAF，
 *     粒子跟着停，恢复后的时间跳变由 dt 钳位兜住（DT_MAX）；
 *   · Ken Burns 只 transform 两层的内层 canvas，粒子画布是兄弟节点，天然不被带动；
 *   · pointer-events:none —— 右键/按下转发挂在 window 捕获阶段，与命中测试无关。
 *
 * 性能口径（保守）：默认 256 粒、上限 1000。绘制只走 2d 路径（线段/椭圆），
 * 不用 shadow、不用每粒子渐变 —— 桌面是常驻图层，预算按「用户零感知」给。
 *
 * 结构：纯逻辑（clamp / spawn / step）与绘制（draw / createParticles）分开 ——
 * tools/test-particles.js 在纯 Node 里 require 本文件直接测前半，不需要 canvas。
 * 文件必须 require-safe：渲染层 <script> 挂 window.WPParticles，Node 里 require
 * 拿到同一份导出（无打包器，两种加载方式共用一个文件）。
 */

(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (global) global.WPParticles = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  /** 种类白名单：配置里的脏值一律回落 ''（关闭），与 ANIMATIONS 同一条防线思路 */
  const PARTICLE_TYPES = ['rain', 'sakura'];

  const COUNT_MIN = 0;
  const COUNT_MAX = 1000;
  const COUNT_DEFAULT = 256;   // 「默认保守 200~300 粒」的拍板中值

  /**
   * 单步推进的最大 dt（ms）。stage:pause 恢复、fpsCap 闸门、后台节流都会让两帧
   * 间隔瞬间变大 —— 一步最多走 50ms 的量：宁可慢半拍，不能瞬移穿屏。
   */
  const DT_MAX = 50;

  function clampCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return COUNT_DEFAULT;
    return Math.min(Math.max(Math.round(n), COUNT_MIN), COUNT_MAX);
  }

  function clampType(value) {
    return PARTICLE_TYPES.includes(value) ? value : '';
  }

  /* ------------------------------------------------------------ 粒子模型 */
  // 坐标一律是 CSS 逻辑像素（物理像素换算在 draw 的 setTransform 里），速度是 px/s。

  /** 樱花的三档粉 —— 固定几档避免每帧构造样式串，也压住画面别发腻 */
  const SAKURA_COLORS = ['255,183,197', '255,203,214', '247,168,187'];

  function newParticle(type, W, H, r, anywhere) {
    if (type === 'rain') {
      const v = 900 + r() * 500;                    // 900~1400 px/s
      return {
        x: r() * W,
        y: anywhere ? r() * H : -30 - r() * H * 0.15,
        v,
        vx: v * (0.08 + r() * 0.08),                // 风斜：横向 ≈ 纵向的 8%~16%
        len: 12 + r() * 16,                         // 雨丝长 12~28px
        alpha: 0.20 + r() * 0.28,
      };
    }
    return {
      x: r() * W,
      y: anywhere ? r() * H : -12 - r() * H * 0.15,
      v: 55 + r() * 70,                             // 55~125 px/s，慢慢飘
      size: 2.6 + r() * 3.4,                        // 2.6~6 px（椭圆长半轴）
      sway: 18 + r() * 42,                          // 横摆速度幅值 px/s
      freq: 0.8 + r() * 1.6,                        // 摆动角频率 rad/s
      phase: r() * Math.PI * 2,
      rot: r() * Math.PI * 2,
      rotV: (r() - 0.5) * 3,                        // 自旋 ±1.5 rad/s
      alpha: 0.55 + r() * 0.4,
      color: SAKURA_COLORS[(r() * SAKURA_COLORS.length) | 0],
    };
  }

  /** 造一批粒子。anywhere=true 初始铺满全屏 —— 开启瞬间就是「正在下」，不用从零攒 */
  function spawn(type, count, W, H, rand) {
    const r = rand || Math.random;
    const out = [];
    for (let i = 0; i < count; i += 1) out.push(newParticle(type, W, H, r, true));
    return out;
  }

  /**
   * 推进一步并回收出屏粒子。dt 传毫秒；内部再钳一次 DT_MAX ——
   * 纯函数不信任调用方，测试也好写。
   */
  function step(parts, type, dtMs, W, H, rand) {
    const r = rand || Math.random;
    const dt = Math.min(Math.max(Number(dtMs) || 0, 0), DT_MAX) / 1000;
    if (dt <= 0) return;
    for (const p of parts) {
      if (type === 'rain') {
        p.y += p.v * dt;
        p.x += p.vx * dt;
        if (p.y - p.len > H) {                      // 落出底边 → 回顶上再来
          p.x = r() * W;
          p.y = -p.len - r() * H * 0.15;
        }
      } else {
        p.phase += p.freq * dt;
        p.rot += p.rotV * dt;
        p.y += p.v * dt;
        p.x += Math.sin(p.phase) * p.sway * dt;     // 摆动是速度不是位移：暂停/恢复不跳
        if (p.y - p.size > H) {
          p.x = r() * W;
          p.y = -p.size * 2 - r() * H * 0.15;
        }
      }
      // 左右出屏从另一侧绕回（风斜/摆动会让边缘粒子出走）
      const m = type === 'rain' ? 4 : p.size * 2;
      if (p.x > W + m) p.x = -m;
      else if (p.x < -m) p.x = W + m;
    }
  }

  /** 绘制一帧。调用方保证 ctx 已按 dpr 做过 setTransform（createParticles.resize 负责） */
  function draw(ctx, parts, type, W, H) {
    ctx.clearRect(0, 0, W, H);
    if (type === 'rain') {
      ctx.lineCap = 'round';
      ctx.lineWidth = 1.1;
      ctx.strokeStyle = '#cfe4ff';                  // 偏冷白：夜晚滤镜压暗后仍读得出雨丝
      for (const p of parts) {
        const k = p.vx / p.v;                       // 尾巴方向与速度相反，斜率一致
        ctx.globalAlpha = p.alpha;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - k * p.len, p.y - p.len);
        ctx.stroke();
      }
    } else if (type === 'sakura') {
      for (const p of parts) {
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = `rgb(${p.color})`;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.size, p.size * 0.62, p.rot, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ------------------------------------------------------------ 浏览器侧绑定 */

  /**
   * 绑定一个 <canvas>，返回 { setConfig, resize, frame }。
   * stage.js 的唯一驱动点：rAF gate 块里调 frame(now)；resize 挂舞台的防抖 resize。
   */
  function createParticles(canvas, rand) {
    const ctx = canvas.getContext('2d');
    const st = { type: '', count: 0, parts: [], W: 1, H: 1, dpr: 1, last: -1 };

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.max(1, Math.round(window.innerWidth * dpr));
      const ph = Math.max(1, Math.round(window.innerHeight * dpr));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;                          // 赋值即清屏，下一帧重画
        canvas.height = ph;
      }
      st.W = Math.max(1, window.innerWidth);
      st.H = Math.max(1, window.innerHeight);
      st.dpr = dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);       // 粒子逻辑坐标走 CSS px
    }

    /**
     * 种类/数量。两个参数都允许 undefined（= 保持现值；初始数量未定过则用默认）。
     * applyChannelConfig 在每次 channels:changed 都会调过来 —— 种类、数量都没变时
     * 必须是无操作，不能整批重造。
     */
    function setConfig(rawType, rawCount) {
      const type = clampType(rawType === undefined ? st.type : String(rawType || ''));
      const count = clampCount(rawCount !== undefined ? rawCount : (st.count || COUNT_DEFAULT));
      if (type === st.type && count === st.count) return;
      if (type !== st.type) {
        st.parts = spawn(type, count, st.W, st.H, rand);        // 换种类 = 整批重造
      } else if (count > st.parts.length) {
        const r = rand || Math.random;
        while (st.parts.length < count) st.parts.push(newParticle(type, st.W, st.H, r, true));
      } else {
        st.parts.length = count;                                // 调少：直接截断
      }
      st.type = type;
      st.count = count;
      canvas.style.display = type ? '' : 'none';                // 关 = 整层不合成
      if (!type) ctx.clearRect(0, 0, st.W, st.H);
      st.last = -1;                    // 首帧给常规步长，别拿旧 last 顶满 DT_MAX 瞬跳
    }

    /** rAF gate 块调用。关闭态只对齐时钟，零绘制 */
    function frame(now) {
      if (!st.type) { st.last = now; return; }
      const dt = st.last < 0 ? 16 : now - st.last;
      st.last = now;
      step(st.parts, st.type, dt, st.W, st.H, rand);
      draw(ctx, st.parts, st.type, st.W, st.H);
    }

    return { setConfig, resize, frame };
  }

  return {
    PARTICLE_TYPES, COUNT_MIN, COUNT_MAX, COUNT_DEFAULT, DT_MAX,
    clampCount, clampType, spawn, step, draw, createParticles,
  };
});
