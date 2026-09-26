'use strict';

/**
 * 舞台粒子图层 —— 雨 / 樱花 / 雪 / 萤火虫 / 星空流星 / 泡泡 / 落叶 / 柳絮 /
 * 光粒 / 彩带 / 烟花 / 火焰灰烬 / 雨落水花 / 雨滴挂屏
 * （profile.particles / profile.particleCount）。
 *
 * 定位（交接文档 11.7 #9 的拍板 + 第 41/42 轮扩容）：
 *   · 独立 <canvas id="particles">，盖在两个 .layer（图片层）之上、#tod（时段滤镜）
 *     之下 —— 滤镜连粒子一起调色，画面是一体的；
 *   · 由 stage.js 的 rAF gate 块驱动：fpsCap 一起被限住；stage:pause 冻结 = 停 rAF，
 *     粒子跟着停，恢复后的时间跳变由 dt 钳位兜住（DT_MAX）；
 *   · Ken Burns 只 transform 两层的内层 canvas，粒子画布是兄弟节点，天然不被带动；
 *   · pointer-events:none —— 右键/按下转发挂在 window 捕获阶段，与命中测试无关。
 *
 * 结构：**类型注册表** —— 每种特效在 TYPES 里登记 make（造粒子）/ step（推进一帧，
 * 含出屏回收）/ draw（画一个粒子），可选 begin/end（批次级 ctx 状态，如混合模式）
 * 与 cap（大场面特效数量内置：烟花 5 发，不随数量滑条走）。
 * 纯逻辑（clamp / spawn / step）与绘制分离：tools/test-particles.js 在纯 Node 里
 * require 本文件直接测前半，不需要 canvas；probe-particles.js 在真 Chromium 里
 * 逐种验证「真的出像素」。
 * 文件必须 require-safe：渲染层 <script> 挂 window.WPParticles，Node 里 require
 * 拿到同一份导出（无打包器，两种加载方式共用一个文件）。
 *
 * 性能口径（保守）：默认 256 粒、上限 1000。绘制只走 2d 路径
 * （线段/圆/椭圆/多边形）—— 桌面是常驻图层，预算按「用户零感知」给。
 */

(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (global) global.WPParticles = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  /** 种类白名单：配置里的脏值一律回落 ''（关闭），与 ANIMATIONS 同一条防线思路。
   *  「random」不在这里 —— 那是 stage.js 的抽取逻辑（每次换图重抽一种实际种类）。 */
  const PARTICLE_TYPES = [
    'rain', 'sakura', 'snow', 'fireflies', 'stars',
    'bubbles', 'leaves', 'fluff', 'dust', 'confetti',
    'fireworks', 'embers', 'splash', 'raindrops',
  ];

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

  /* ------------------------------------------------------------ 工具 */

  const TAU = Math.PI * 2;
  const pick = (r, list) => list[(r() * list.length) | 0];

  /** 左右出屏从另一侧绕回（风斜/摆动会让边缘粒子出走），m 是出屏容差 */
  function wrapX(p, W, m) {
    if (p.x > W + m) p.x = -m;
    else if (p.x < -m) p.x = W + m;
  }

  /* ------------------------------------------------------------ 类型注册表 */
  // 坐标一律是 CSS 逻辑像素（物理像素换算在 draw 的 setTransform 里），速度是 px/s。
  // make(W, H, r, anywhere)：anywhere=true 初始铺满全屏（开启瞬间就是「正在下」）；
  // false = 从边缘进来（回收复用）。step(p, dt秒, W, H, r) 就地改写粒子字段。

  const TYPES = {};

  /* 雨：短线段雨丝，快速下落带 8%~16% 风斜 */
  TYPES.rain = {
    make(W, H, r, anywhere) {
      const v = 900 + r() * 500;                    // 900~1400 px/s
      return {
        x: r() * W,
        y: anywhere ? r() * H : -30 - r() * H * 0.15,
        v,
        vx: v * (0.08 + r() * 0.08),                // 风斜：横向 ≈ 纵向的 8%~16%
        len: 14 + r() * 18,                         // 雨丝长 14~32px
        alpha: 0.20 + r() * 0.28,
      };
    },
    step(p, dt, W, H, r) {
      p.y += p.v * dt;
      p.x += p.vx * dt;
      if (p.y - p.len > H) {                        // 落出底边 → 回顶上再来
        p.x = r() * W;
        p.y = -p.len - r() * H * 0.15;
      }
      wrapX(p, W, 4);
    },
    begin(ctx) {
      ctx.lineCap = 'round';
      ctx.lineWidth = 1.1;
      ctx.strokeStyle = '#cfe4ff';                  // 偏冷白：夜晚滤镜压暗后仍读得出雨丝
    },
    draw(ctx, p) {
      const k = p.vx / p.v;                         // 尾巴方向与速度相反，斜率一致
      ctx.globalAlpha = p.alpha;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - k * p.len, p.y - p.len);
      ctx.stroke();
    },
  };

  /* 樱花：慢落花瓣 + 横向摆动（速度项不是位移项：暂停恢复不跳）+ 自旋，三档固定粉。
     第 42 轮整体放大：2.6~6 → 3.5~8，花瓣在 4K 物理像素下也要读得出来 */
  const SAKURA_COLORS = ['255,183,197', '255,203,214', '247,168,187'];
  TYPES.sakura = {
    make(W, H, r, anywhere) {
      return {
        x: r() * W,
        y: anywhere ? r() * H : -16 - r() * H * 0.15,
        v: 55 + r() * 70,                           // 55~125 px/s，慢慢飘
        size: 3.5 + r() * 4.5,                      // 3.5~8 px（椭圆长半轴）
        sway: 18 + r() * 42,                        // 横摆速度幅值 px/s
        freq: 0.8 + r() * 1.6,                      // 摆动角频率 rad/s
        phase: r() * TAU,
        rot: r() * TAU,
        rotV: (r() - 0.5) * 3,                      // 自旋 ±1.5 rad/s
        alpha: 0.55 + r() * 0.4,
        color: pick(r, SAKURA_COLORS),
      };
    },
    step(p, dt, W, H, r) {
      p.phase += p.freq * dt;
      p.rot += p.rotV * dt;
      p.y += p.v * dt;
      p.x += Math.sin(p.phase) * p.sway * dt;       // 摆动是速度不是位移：暂停/恢复不跳
      if (p.y - p.size > H) {
        p.x = r() * W;
        p.y = -p.size * 2 - r() * H * 0.15;
      }
      wrapX(p, W, p.size * 2);
    },
    draw(ctx, p) {
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = `rgb(${p.color})`;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.size, p.size * 0.62, p.rot, 0, TAU);
      ctx.fill();
    },
  };

  /* 雪：白色圆片，比樱花更慢更素，带常驻微风漂移（42 轮放大：2~5） */
  TYPES.snow = {
    make(W, H, r, anywhere) {
      return {
        x: r() * W,
        y: anywhere ? r() * H : -12 - r() * H * 0.15,
        v: 30 + r() * 60,                           // 30~90 px/s
        size: 2 + r() * 3,                          // 2~5 px
        sway: 8 + r() * 16,
        freq: 0.4 + r() * 0.9,
        phase: r() * TAU,
        drift: (r() - 0.5) * 10,                    // 常驻微风 ±5 px/s
        alpha: 0.45 + r() * 0.5,
      };
    },
    step(p, dt, W, H, r) {
      p.phase += p.freq * dt;
      p.y += p.v * dt;
      p.x += (Math.sin(p.phase) * p.sway + p.drift) * dt;
      if (p.y - p.size > H) {
        p.x = r() * W;
        p.y = -p.size * 2 - r() * H * 0.15;
      }
      wrapX(p, W, 4);
    },
    draw(ctx, p) {
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
    },
  };

  /* 萤火虫：慢速游走的小光点，呼吸式明灭；lighter 混合让重叠处发亮（42 轮核心加大） */
  TYPES.fireflies = {
    make(W, H, r) {
      return {
        x: r() * W,
        y: r() * H,
        ax: 10 + r() * 20,                          // 游走速度幅值 px/s
        ay: 10 + r() * 20,
        fa: 0.3 + r() * 0.6,                        // 游走角频率
        fb: 0.3 + r() * 0.6,
        pa: r() * TAU,
        pb: r() * TAU,
        pf: 0.4 + r() * 1.2,                        // 明灭频率
        pp: r() * TAU,
        size: 1.6 + r() * 1.6,                      // 1.6~3.2 px
        alpha: 0.5 + r() * 0.5,
      };
    },
    step(p, dt, W, H) {
      p.pa += p.fa * dt;
      p.pb += p.fb * dt;
      p.pp += p.pf * dt;
      p.x += Math.sin(p.pa) * p.ax * dt;
      p.y += Math.sin(p.pb) * p.ay * dt;
      wrapX(p, W, 20);
      if (p.y > H + 20) p.y = -20;
      else if (p.y < -20) p.y = H + 20;
    },
    begin(ctx) { ctx.globalCompositeOperation = 'lighter'; },
    end(ctx) { ctx.globalCompositeOperation = 'source-over'; },
    draw(ctx, p) {
      const blink = 0.2 + 0.8 * Math.pow(Math.max(0, Math.sin(p.pp)), 1.4);
      ctx.fillStyle = '#e8ff9c';
      ctx.globalAlpha = p.alpha * blink * 0.25;     // 光晕
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 3.2, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = p.alpha * blink;            // 核心亮点
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
    },
  };

  /* 星空流星：静星闪烁 + 低频划过的斜向光痕（候场流星在屏外倒数）。
     43 轮按反馈调亮：星点放大提亮、流星占比/长度/亮度/频率全面上调 */
  TYPES.stars = {
    make(W, H, r) {
      if (r() < 0.78) {                             // 78% 静星
        return {
          kind: 'star',
          x: r() * W,
          y: r() * H,
          size: 1.1 + r() * 1.6,                    // 1.1~2.7 px
          alpha: 0.55 + r() * 0.45,
          freq: 0.3 + r() * 1.4,
          phase: r() * TAU,
        };
      }
      const dir = r() < 0.5 ? -1 : 1;
      const v = 500 + r() * 400;
      return {
        kind: 'meteor',
        x: r() * W,
        y: -20 - r() * H * 0.3,
        vx: dir * v * 0.75,
        vy: v * 0.55,
        v,
        len: 90 + r() * 130,                        // 90~220 px 拖尾
        wait: r() * 5,                              // 候场：到点才入场
        alpha: 0.7 + r() * 0.3,
      };
    },
    step(p, dt, W, H, r) {
      if (p.kind === 'star') {
        p.phase += p.freq * dt;                     // 只闪烁不移动
        return;
      }
      if (p.wait > 0) { p.wait -= dt; return; }     // 候场中不可见
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.y - p.len > H || p.x < -p.len || p.x > W + p.len) {
        p.x = r() * W;
        p.y = -20 - r() * 40;
        p.wait = 1 + r() * 4;                       // 1~5s 一颗（43 轮：更频繁）
      }
    },
    begin(ctx) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
    },
    draw(ctx, p) {
      if (p.kind === 'star') {
        ctx.globalAlpha = p.alpha * (0.35 + 0.65 * Math.abs(Math.sin(p.phase)));
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, TAU);
        ctx.fill();
        return;
      }
      if (p.wait > 0) return;
      ctx.globalAlpha = p.alpha;
      const k = p.len / p.v;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * k, p.y - p.vy * k);
      ctx.stroke();
    },
  };

  /* 泡泡：自下而上的半透明圆环 + 左上高光点（42 轮放大：3~11） */
  TYPES.bubbles = {
    make(W, H, r, anywhere) {
      return {
        x: r() * W,
        y: anywhere ? r() * H : H + 12 + r() * H * 0.1,
        v: 20 + r() * 45,
        size: 3 + r() * 8,                          // 3~11 px
        sway: 6 + r() * 16,
        freq: 0.5 + r() * 1.2,
        phase: r() * TAU,
        alpha: 0.25 + r() * 0.35,
      };
    },
    step(p, dt, W, H, r) {
      p.phase += p.freq * dt;
      p.y -= p.v * dt;
      p.x += Math.sin(p.phase) * p.sway * dt;
      if (p.y + p.size < 0) {                       // 飘出顶边 → 从底边再来
        p.x = r() * W;
        p.y = H + 12 + r() * H * 0.1;
      }
      wrapX(p, W, 10);
    },
    begin(ctx) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
    },
    draw(ctx, p) {
      ctx.globalAlpha = p.alpha;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = p.alpha * 0.9;              // 高光
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x - p.size * 0.35, p.y - p.size * 0.35, Math.max(0.6, p.size * 0.22), 0, TAU);
      ctx.fill();
    },
  };

  /* 落叶：大叶片（椭圆 + 中脉），旋转 + 摆动，秋色系（42 轮放大：7~14，本就是「大」招牌） */
  const LEAF_COLORS = ['#c96f2f', '#b54d2a', '#d9a036', '#8f5a2a', '#9ca54e'];
  TYPES.leaves = {
    make(W, H, r, anywhere) {
      return {
        x: r() * W,
        y: anywhere ? r() * H : -20 - r() * H * 0.15,
        v: 60 + r() * 80,
        size: 7 + r() * 7,                          // 7~14 px
        sway: 20 + r() * 30,
        freq: 0.5 + r() * 1.0,
        phase: r() * TAU,
        rot: r() * TAU,
        rotV: (r() - 0.5) * 2.4,
        alpha: 0.6 + r() * 0.35,
        color: pick(r, LEAF_COLORS),
      };
    },
    step(p, dt, W, H, r) {
      p.phase += p.freq * dt;
      p.rot += p.rotV * dt;
      p.y += p.v * dt;
      p.x += Math.sin(p.phase) * p.sway * dt;
      if (p.y - p.size * 2 > H) {
        p.x = r() * W;
        p.y = -p.size * 2 - r() * H * 0.15;
      }
      wrapX(p, W, p.size * 2);
    },
    draw(ctx, p) {
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.size, p.size * 0.55, p.rot, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';         // 中脉：一点结构感，别像彩纸
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(p.x - Math.cos(p.rot) * p.size, p.y - Math.sin(p.rot) * p.size * 0.55);
      ctx.lineTo(p.x + Math.cos(p.rot) * p.size, p.y + Math.sin(p.rot) * p.size * 0.55);
      ctx.stroke();
    },
  };

  /* 柳絮：白色小绒点，极慢 + 大摆幅，光晕比本体大（42 轮放大：2~4） */
  TYPES.fluff = {
    make(W, H, r, anywhere) {
      return {
        x: r() * W,
        y: anywhere ? r() * H : -10 - r() * H * 0.15,
        v: 15 + r() * 30,
        size: 2 + r() * 2,                          // 2~4 px
        sway: 25 + r() * 45,
        freq: 0.3 + r() * 0.7,
        phase: r() * TAU,
        alpha: 0.3 + r() * 0.4,
      };
    },
    step(p, dt, W, H, r) {
      p.phase += p.freq * dt;
      p.y += p.v * dt;
      p.x += Math.sin(p.phase) * p.sway * dt;
      if (p.y - p.size * 2 > H) {
        p.x = r() * W;
        p.y = -p.size * 2 - r() * H * 0.15;
      }
      wrapX(p, W, 6);
    },
    draw(ctx, p) {
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = p.alpha * 0.35;             // 绒毛光晕
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 1.8, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = p.alpha;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
    },
  };

  /* 光粒：极慢的暖色小颗粒，漂浮质感（43 轮按反馈提亮放大：隐约 → 可见） */
  TYPES.dust = {
    make(W, H, r, anywhere) {
      return {
        x: r() * W,
        y: anywhere ? r() * H : -4 - r() * H * 0.15,
        v: 4 + r() * 12,
        size: 1 + r() * 1.6,                        // 1~2.6 px
        drift: (r() - 0.5) * 6,
        freq: 0.2 + r() * 0.5,
        phase: r() * TAU,
        alpha: 0.16 + r() * 0.24,                   // 0.16~0.40（原 0.08~0.26）
      };
    },
    step(p, dt, W, H, r) {
      p.phase += p.freq * dt;
      p.y += p.v * dt;
      p.x += (Math.sin(p.phase) * 3 + p.drift) * dt;
      if (p.y - p.size > H) {
        p.x = r() * W;
        p.y = -p.size * 2 - r() * H * 0.15;
      }
      wrapX(p, W, 3);
    },
    draw(ctx, p) {
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = '#ffe9c4';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
    },
  };

  /* 彩带纸屑：彩色小矩形，翻转下落 + 呼吸式落速，节日向（42 轮放大） */
  const CONFETTI_COLORS = ['#ff5a5a', '#ffd23f', '#4ecdc4', '#6a89cc', '#f78fb3', '#a3cb38'];
  TYPES.confetti = {
    make(W, H, r, anywhere) {
      return {
        x: r() * W,
        y: anywhere ? r() * H : -18 - r() * H * 0.15,
        v: 80 + r() * 120,
        w: 6 + r() * 6,                             // 6~12 px
        h: 3.5 + r() * 3.5,                         // 3.5~7 px
        sway: 30 + r() * 50,
        freq: 1 + r() * 2,
        phase: r() * TAU,
        rot: r() * TAU,
        rotV: (r() - 0.5) * 6,
        alpha: 0.75 + r() * 0.25,
        color: pick(r, CONFETTI_COLORS),
      };
    },
    step(p, dt, W, H, r) {
      p.phase += p.freq * dt;
      p.rot += p.rotV * dt;
      p.y += p.v * (0.55 + 0.45 * Math.abs(Math.sin(p.phase * 1.3))) * dt;   // 颤落
      p.x += Math.sin(p.phase) * p.sway * dt;
      if (p.y - p.w > H) {
        p.x = r() * W;
        p.y = -p.w * 2 - r() * H * 0.15;
      }
      wrapX(p, W, 12);
    },
    draw(ctx, p) {
      const c = Math.cos(p.rot);
      const s = Math.sin(p.rot);
      const hw = p.w / 2;
      const hh = p.h / 2;
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(p.x + c * hw - s * hh, p.y + s * hw + c * hh);
      ctx.lineTo(p.x - c * hw - s * hh, p.y - s * hw + c * hh);
      ctx.lineTo(p.x - c * hw + s * hh, p.y - s * hw - c * hh);
      ctx.lineTo(p.x + c * hw + s * hh, p.y + s * hw - c * hh);
      ctx.closePath();
      ctx.fill();
    },
  };

  /* 雷雨下线（44 轮，用户拍板）；原位置让给烟花 */

  /* 烟花：火箭升空 → 空中炸开一簇彩色火花（阻力减速 + 重力 + 渐灭 + 末段闪烁）
     → 候场再来。一条粒子 = 一发烟花的三段人生（wait/rocket/burst），
     数量 cap=5 —— 烟花是大场面特效，256 发齐炸没有意义 */
  const FIREWORK_COLORS = ['#ff6b6b', '#ffd23f', '#6be3a2', '#6a89cc', '#f78fb3', '#c39bd3'];
  TYPES.fireworks = {
    cap: 5,
    make(W, H, r) {
      return { kind: 'wait', x: 0, y: 0, wait: r() * 2.5 };
    },
    step(p, dt, W, H, r) {
      if (p.kind === 'wait') {
        p.wait -= dt;
        if (p.wait <= 0) {                          // 升空：别贴边炸，升到上半屏
          p.kind = 'rocket';
          p.x = W * (0.12 + r() * 0.76);
          p.y = H + 10;
          p.vy = -(H * 0.42 + r() * H * 0.2) / 1.1; // ~1.1s 升到顶
          p.targetY = H * (0.12 + r() * 0.3);
          p.color = pick(r, FIREWORK_COLORS);
        }
        return;
      }
      if (p.kind === 'rocket') {
        p.y += p.vy * dt;
        if (p.y <= p.targetY) {
          // 到顶 → 炸。半径锚定屏幕短边（45 轮拍板：竖屏上直径至少占一半）：
          // R = min(W,H) × 0.30~0.48；火花初速按「外圈恰好吃满 R」反推 ——
          // 指数阻力下总位移 = v0·(1-e^(-kL))/k，取 k=0.9 反解 v0。
          const R = Math.min(W, H) * (0.3 + r() * 0.18);
          const k = 0.9;                            // 阻力系数
          const L = 2.2 + r() * 0.6;                // 燃烧寿命（秒）
          const v0max = (R * k) / (1 - Math.exp(-k * L));
          const n = 60 + ((r() * 50) | 0);          // 60~110 颗：球面要填满才不像秃球
          const sparks = [];
          for (let i = 0; i < n; i += 1) {
            const a = (i / n) * TAU + r() * 0.2;
            const sp = v0max * (0.35 + r() * 0.65); // 快慢掺匀，外圈吃满 R、内圈填球
            sparks.push({ x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp });
          }
          p.kind = 'burst';
          p.sparks = sparks;
          p.k = k;
          p.g = Math.min(W, H) * 0.12;              // 重力也随屏幕走，大烟花才坠得自然
          p.life = L;
          p.age = 0;
          p.R = R;
        }
        return;
      }
      p.age += dt;                                  // burst：火花减速下坠、渐灭
      const drag = Math.max(0, 1 - p.k * dt);
      for (const s of p.sparks) {
        s.vx *= drag;
        s.vy = s.vy * drag + p.g * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
      }
      if (p.age >= p.life) {
        p.kind = 'wait';
        p.wait = 0.6 + r() * 2.4;
      }
    },
    begin(ctx) { ctx.globalCompositeOperation = 'lighter'; },
    end(ctx) { ctx.globalCompositeOperation = 'source-over'; },
    draw(ctx, p) {
      if (p.kind === 'wait') return;
      if (p.kind === 'rocket') {                    // 上升亮点 + 短尾
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = '#ffe9b0';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x, p.y + 20);
        ctx.stroke();
        return;
      }
      const t = p.age / p.life;
      if (p.age < 0.12) {                           // 炸开瞬间的闪光（半径随 R）
        ctx.globalAlpha = 0.5 * (1 - p.age / 0.12);
        ctx.fillStyle = '#fff2c8';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.R * 0.22 * (p.age / 0.12), 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = Math.max(0, (1 - t) * (0.7 + 0.3 * Math.sin(p.age * 30 + p.x)));
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2.2;                          // 火花条加粗（45 轮：太细看不清）
      for (const s of p.sparks) {
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - s.vx * 0.05, s.y - s.vy * 0.05);   // 拖尾拉长一倍半
        ctx.stroke();
      }
    },
  };

  /* 火焰灰烬：从底部升起的橙红火屑，摇曳上飘、闪烁、越高越淡（火源在画面下方）。
     lighter 混合让重叠的火屑发亮；44 轮新增 */
  const EMBER_COLORS = ['#ffb14a', '#ff7a3c', '#ffd28a', '#ff5a2e'];
  TYPES.embers = {
    make(W, H, r, anywhere) {
      return {
        x: r() * W,
        y: anywhere ? r() * H : H + 6 + r() * 20,
        vy: 20 + r() * 55,                          // 上升 20~75 px/s
        sway: 10 + r() * 26,
        freq: 0.6 + r() * 1.6,
        phase: r() * TAU,
        size: 1 + r() * 2.2,
        flicker: 2 + r() * 5,                       // 闪烁频率
        fp: r() * TAU,
        color: pick(r, EMBER_COLORS),
        alpha: 0.5 + r() * 0.5,
      };
    },
    step(p, dt, W, H, r) {
      p.phase += p.freq * dt;
      p.fp += p.flicker * dt;
      p.y -= p.vy * dt;
      p.x += Math.sin(p.phase) * p.sway * dt;
      if (p.y < -10) {                              // 飘出顶边 → 从底边重来（火源在下面）
        p.x = r() * W;
        p.y = H + 6 + r() * 20;
      }
      wrapX(p, W, 8);
    },
    begin(ctx) { ctx.globalCompositeOperation = 'lighter'; },
    end(ctx) { ctx.globalCompositeOperation = 'source-over'; },
    draw(ctx, p, W, H) {
      const flick = 0.55 + 0.45 * Math.sin(p.fp);
      const hFade = Math.max(0.15, Math.min(1, p.y / (H * 0.85)));   // 越高越淡
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha * flick * hFade * 0.3;                   // 火光晕
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 2.6, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = p.alpha * flick * hFade;                          // 核心火屑
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
    },
  };

  /* 雨落水花：雨丝落到「地面」那一刻炸开一圈小水冠，然后雨丝从顶上再来。
     一条粒子两段人生（drop → splash → drop），数组长度恒定；
     44 轮新增（复用 rain 的造型与运动，只有触地一段是自己的） */
  TYPES.splash = {
    make(W, H, r, anywhere) {
      return TYPES.rain.make(W, H, r, anywhere);    // 起手是雨丝
    },
    step(p, dt, W, H, r) {
      if (p.kind === 'splash') {                    // 水冠展开 ~0.3s 后变回雨丝
        p.t += dt;
        if (p.t >= p.dur) {
          Object.assign(p, TYPES.rain.make(W, H, r, false));
          delete p.kind;
        }
        return;
      }
      p.y += p.v * dt;
      p.x += p.vx * dt;
      wrapX(p, W, 4);
      if (p.y >= H) {                               // 触地 → 水花
        p.kind = 'splash';
        p.sx = p.x;
        p.t = 0;
        p.dur = 0.22 + r() * 0.16;
      }
    },
    draw(ctx, p, W, H) {
      if (p.kind === 'splash') {
        const k = Math.min(1, p.t / p.dur);
        ctx.globalAlpha = (1 - k) * 0.7;
        ctx.strokeStyle = '#cfe4ff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.sx, H - 1, 2 + k * 7, Math.PI, TAU);   // 向上张开的半圆水冠
        ctx.stroke();
        return;
      }
      TYPES.rain.draw(ctx, p);
    },
  };

  /* 雨滴挂屏：挂在「玻璃」上的水珠 —— 停一会儿、缓缓下滑一小段、再挂一会儿。
     玻璃质感全靠左上高光点 + 下滑时的渐隐拖尾；44 轮新增 */
  TYPES.raindrops = {
    make(W, H, r, anywhere) {
      return {
        x: r() * W,
        y: r() * H,
        size: 1.6 + r() * 3.4,                      // 1.6~5 px 水珠
        idle: r() * 4,                              // 挂着不动的时长（秒）
        vy: 26 + r() * 70,                          // 下滑速度
        slide: 0,                                   // 本次还能滑多久
        slideMax: 0.25 + r() * 0.7,
        alpha: 0.3 + r() * 0.35,
      };
    },
    step(p, dt, W, H, r) {
      if (p.idle > 0) { p.idle -= dt; return; }     // 挂着
      if (p.slide > 0) {                            // 下滑一小段
        p.slide -= dt;
        p.y += p.vy * dt;
        p.x += Math.sin(p.y * 0.045) * 8 * dt;
        if (p.y > H + 6) {                          // 滑出屏 → 换个位置重新挂
          p.x = r() * W;
          p.y = r() * H * 0.85;
          p.size = 1.6 + r() * 3.4;
          p.idle = 0.4 + r() * 3.2;
          p.slide = 0;
        }
        return;
      }
      p.slide = p.slideMax;                         // 挂够了：滑一小段
    },
    draw(ctx, p) {
      ctx.globalAlpha = p.alpha;                    // 水珠本体
      ctx.fillStyle = 'rgb(205,232,255)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = p.alpha * 0.9;              // 左上高光
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x - p.size * 0.3, p.y - p.size * 0.32, Math.max(0.5, p.size * 0.3), 0, TAU);
      ctx.fill();
      if (p.slide > 0) {                            // 下滑拖尾
        ctx.globalAlpha = p.alpha * 0.35;
        ctx.strokeStyle = '#cfe4ff';
        ctx.lineWidth = Math.max(1, p.size * 0.8);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - p.size * 4);
        ctx.lineTo(p.x, p.y - p.size);
        ctx.stroke();
      }
    },
  };

  /* ------------------------------------------------------------ 纯逻辑 API */

  /** 光效类（cap）的数量内置：用户数量再大也封顶 */
  function countFor(type, count) {
    const def = TYPES[clampType(type)];
    return def && def.cap ? Math.min(count, def.cap) : count;
  }

  function newParticle(type, W, H, r, anywhere) {
    const def = TYPES[clampType(type)];
    return def ? def.make(W, H, r, anywhere) : null;
  }

  /** 造一批粒子。anywhere=true 初始铺满全屏 —— 开启瞬间就是「正在下」，不用从零攒 */
  function spawn(type, count, W, H, rand) {
    const def = TYPES[clampType(type)];
    const r = rand || Math.random;
    const out = [];
    if (!def) return out;
    const n = countFor(type, count);
    for (let i = 0; i < n; i += 1) out.push(def.make(W, H, r, true));
    return out;
  }

  /**
   * 推进一步。dt 传毫秒；内部再钳一次 DT_MAX —— 纯函数不信任调用方，测试也好写。
   * 出屏回收与左右绕回在各类型的 step 里。
   */
  function step(parts, type, dtMs, W, H, rand) {
    const def = TYPES[clampType(type)];
    if (!def) return;
    const r = rand || Math.random;
    const dt = Math.min(Math.max(Number(dtMs) || 0, 0), DT_MAX) / 1000;
    if (dt <= 0) return;
    for (const p of parts) def.step(p, dt, W, H, r);
  }

  /** 绘制一帧。调用方保证 ctx 已按 dpr 做过 setTransform（createParticles.resize 负责） */
  function draw(ctx, parts, type, W, H) {
    const def = TYPES[clampType(type)];
    ctx.clearRect(0, 0, W, H);
    if (!def) return;
    if (def.begin) def.begin(ctx);
    for (const p of parts) def.draw(ctx, p, W, H);
    if (def.end) def.end(ctx);
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
     * 必须是无操作，不能整批重造。光效类数量经 countFor 内置封顶。
     */
    function setConfig(rawType, rawCount) {
      const type = clampType(rawType === undefined ? st.type : String(rawType || ''));
      const count = countFor(type, clampCount(rawCount !== undefined ? rawCount : (st.count || COUNT_DEFAULT)));
      if (type === st.type && count === st.count) return;
      if (type !== st.type) {
        st.parts = type ? spawn(type, count, st.W, st.H, rand) : [];   // 关 = 不养粒子
      } else if (!type) {
        st.parts = [];
      } else if (count > st.parts.length) {
        const rr = rand || Math.random;
        while (st.parts.length < count) st.parts.push(newParticle(type, st.W, st.H, rr, true));
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
