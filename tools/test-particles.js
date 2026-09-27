'use strict';

/**
 * 粒子层纯逻辑单测（不需要 Electron、不碰 canvas）：`npm run verify:particles`。
 *
 * 覆盖：种类/数量收紧、初始铺屏与确定性、推进积分与 DT_MAX 钳位、
 * 出屏回收与左右绕回、摆动/自旋的推进量有界。
 * 绘制（draw / createParticles）不在纯 Node 里测 —— 那一半归 verify:stage
 * 与真机探针（capturePage 对「画没画出来」并不可信，最终以抓屏/肉眼为准）。
 */

const pt = require('../src/renderer/particles');

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

/** mulberry32 固定种子随机：同种子同序列，spawn/step 的断言才可复现 */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log('粒子层纯逻辑单测\n');

// ---- §1 收紧：配置是用户能直接手改的地方，脏值一律回落 ----
console.log('§1 种类/数量收紧');
check('clampCount 无参 → 默认 256', pt.clampCount() === 256, String(pt.clampCount()));
check("clampCount('abc') 非数字 → 默认 256", pt.clampCount('abc') === 256);
check('clampCount(99999) → 上限 1000', pt.clampCount(99999) === 1000);
check('clampCount(-5) → 下限 0', pt.clampCount(-5) === 0);
check('clampCount(300.6) → 四舍五入 301', pt.clampCount(300.6) === 301);
check("clampCount('300') 字符串数字也认", pt.clampCount('300') === 300);
check("clampType('rain') 原样保留", pt.clampType('rain') === 'rain');
check("clampType('sakura') 原样保留", pt.clampType('sakura') === 'sakura');
check("clampType('meteor_shower') 白名单外 → 关闭", pt.clampType('meteor_shower') === '');
check('clampType(undefined) → 关闭', pt.clampType(undefined) === '');
check("clampType('fluff') 老配置 → 迁到 snow", pt.clampType('fluff') === 'snow');
check("clampType('dust') 老配置 → 迁到 fireflies", pt.clampType('dust') === 'fireflies');
check('种类白名单 = 12 种注册特效（51 轮精简后）',
  JSON.stringify(pt.PARTICLE_TYPES) === JSON.stringify([
    'rain', 'sakura', 'snow', 'fireflies', 'stars',
    'bubbles', 'leaves', 'confetti',
    'fireworks', 'embers', 'splash', 'raindrops',
  ]));

// ---- §2 spawn：初始铺满全屏、字段在约定区间、同种子可复现 ----
console.log('\n§2 初始铺屏（spawn）');
const W = 1280, H = 800;
const rains = pt.spawn('rain', 50, W, H, seeded(7));
check('数量原样', rains.length === 50, String(rains.length));
check('x 全落在 [0, W)', rains.every((p) => p.x >= 0 && p.x < W));
check('y 全落在 [0, H)（开启瞬间就是「正在下」）', rains.every((p) => p.y >= 0 && p.y < H));
check('雨速在 900~1400 px/s', rains.every((p) => p.v >= 900 && p.v < 1400));
check('风斜比在 8%~16%', rains.every((p) => p.vx / p.v >= 0.08 && p.vx / p.v < 0.16));
check('同种子两次 spawn 逐字段相同',
  JSON.stringify(pt.spawn('rain', 50, W, H, seeded(7))) === JSON.stringify(rains));
const sakuras = pt.spawn('sakura', 30, W, H, seeded(11));
check('花瓣尺寸在 3.5~8 px（42 轮放大后）', sakuras.every((p) => p.size >= 3.5 && p.size < 8));
check('花瓣颜色都是「r,g,b」形态', sakuras.every((p) => /^\d{3},\d{3},\d{3}$/.test(p.color)));

// ---- §3 推进：匀速积分、DT_MAX 钳位、摆动/自旋有界 ----
console.log('\n§3 推进与钳位（step）');
const drop = [{ x: 100, y: 100, v: 1000, vx: 0, len: 10, alpha: 1 }];
pt.step(drop, 'rain', 40, W, H, seeded(1));
check('雨滴 40ms 走 40px（1000 px/s）', drop[0].y === 140, `y=${drop[0].y}`);
pt.step(drop, 'rain', 10000, W, H, seeded(1));
check('dt=10s 被钳到 50ms：只再走 50px', drop[0].y === 190, `y=${drop[0].y}`);
const still = [{ x: 100, y: 100, v: 1000, vx: 0, len: 10, alpha: 1 }];
pt.step(still, 'rain', -5, W, H, seeded(1));
check('负 dt 不动（宁可停也不倒放）', still[0].y === 100);
const petal = [{ x: 100, y: 100, v: 0, size: 4, sway: 100, freq: 1, phase: 0, rot: 0, rotV: 1, alpha: 1, color: '255,183,197' }];
pt.step(petal, 'sakura', 50, W, H, seeded(1));
check('摆动是速度项：|dx| ≤ sway·dt', Math.abs(petal[0].x - 100) <= 100 * 0.05 + 1e-9, `dx=${(petal[0].x - 100).toFixed(4)}`);
check('自旋按 rotV·dt 精确推进', Math.abs(petal[0].rot - 0.05) < 1e-9, `rot=${petal[0].rot}`);

// ---- §4 回收与绕回：出屏粒子回顶/从另一侧回来，数组长度不变 ----
console.log('\n§4 出屏回收与左右绕回');
const falling = [{ x: 640, y: 799, v: 1000, vx: 0, len: 10, alpha: 1 }];
pt.step(falling, 'rain', 40, W, H, seeded(3));
check('落出底边的雨滴回收到顶部（y<0）且 x 重新随机', falling[0].y < 0 && falling[0].x >= 0 && falling[0].x < W,
  `y=${falling[0].y.toFixed(1)}`);
const petalOut = [{ x: 640, y: 795, v: 1000, size: 4, sway: 0, freq: 1, phase: 0, rot: 0, rotV: 0, alpha: 1, color: '255,183,197' }];
pt.step(petalOut, 'sakura', 40, W, H, seeded(3));
check('飘出底边的花瓣同样回顶', petalOut[0].y < 0, `y=${petalOut[0].y.toFixed(1)}`);
const sideOut = [{ x: W + 5, y: 100, v: 1000, vx: 100, len: 10, alpha: 1 }];
pt.step(sideOut, 'rain', 40, W, H, seeded(1));
check('从右缘出走的粒子从左缘绕回', sideOut[0].x === -4, `x=${sideOut[0].x}`);
const lenBefore = falling.length;
pt.step(falling, 'rain', 40, W, H, seeded(3));
check('step 不增删粒子（长度恒定）', falling.length === lenBefore);

// ---- §5 全种类冒烟：13 种特效的 spawn / step 都必须可跑、坐标有限 ----
console.log('\n§5 全种类冒烟');
check('全种类 spawn 数量受控（≤请求数）、坐标有限',
  pt.PARTICLE_TYPES.every((t) => {
    const parts = pt.spawn(t, 10, W, H, seeded(5));
    return parts.length >= 1 && parts.length <= 10 && parts.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  }));
check('大场面数量内置：fireworks 封顶 5 发',
  pt.spawn('fireworks', 1000, W, H, seeded(5)).length === 5);
check('普通类数量原样：rain 10 粒就是 10 粒', pt.spawn('rain', 10, W, H, seeded(5)).length === 10);
check('全种类 step 推进两帧不炸、坐标仍有限',
  pt.PARTICLE_TYPES.every((t) => {
    const parts = pt.spawn(t, 10, W, H, seeded(6));
    pt.step(parts, t, 16.7, W, H, seeded(6));
    pt.step(parts, t, 33.3, W, H, seeded(6));
    return parts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  }));
check('烟花会走完 wait → rocket → burst 三段人生',
  (() => {
    const parts = pt.spawn('fireworks', 5, W, H, seeded(8));
    const kinds = new Set();
    for (let i = 0; i < 400; i += 1) {          // 400 × 16.7ms ≈ 6.7s，足够走完一轮
      pt.step(parts, 'fireworks', 16.7, W, H, seeded(8));
      for (const p of parts) kinds.add(p.kind);
    }
    return kinds.has('wait') && kinds.has('rocket') && kinds.has('burst');
  })());
check('水花粒子会从雨丝变成水冠再变回雨丝',
  (() => {
    const parts = pt.spawn('splash', 5, W, H, seeded(3));
    for (const p of parts) { p.y = H - 1; p.v = 1000; }   // 全部顶到地面
    let sawSplash = false;
    let sawRespawn = false;
    for (let i = 0; i < 60 && !(sawSplash && sawRespawn); i += 1) {
      pt.step(parts, 'splash', 16.7, W, H, seeded(3));
      for (const p of parts) {
        if (p.kind === 'splash') sawSplash = true;
        else if (sawSplash && p.y < 0) sawRespawn = true; // 水冠结束 → 顶上重来的雨丝
      }
    }
    return sawSplash && sawRespawn;
  })());
check('fluff 老值 spawn 也安全（走别名落在 snow 的字段形态上）',
  pt.spawn('fluff', 5, W, H, seeded(4)).every((p) => p.sway > 0 && p.size >= 2));
check('leaves 有左右摆动（sway > 0）',
  pt.spawn('leaves', 5, W, H, seeded(4)).every((p) => p.sway > 0));

// ---- §6 51 轮：泡泡七彩膜 + 上升变大；灰烬每粒一色 ----
console.log('\n§6 泡泡升级与灰烬全彩（51 轮）');
const bubbles = pt.spawn('bubbles', 20, W, H, seeded(9));
check('泡泡带 maxSize 且 ≥ 初值（留出长大空间）',
  bubbles.every((p) => p.maxSize >= p.size && p.maxSize <= 26.0001));
check('泡泡带 grow（0.15~0.4 px/s）与色相 hue（0~360）',
  bubbles.every((p) => p.grow >= 0.15 && p.grow <= 0.4 && p.hue >= 0 && p.hue < 360));
const one = [Object.assign({}, bubbles[0])];
const s0 = one[0].size;
const h0 = one[0].hue;
pt.step(one, 'bubbles', 1000, W, H, seeded(1));    // 传 1 秒 → 被钳到 50ms
const DTS = 0.05;                                  // DT_MAX 钳位后的实际步长（秒）
check('泡泡推进后变大（size + grow·dt，dt 走 DT_MAX 钳位）',
  Math.abs(one[0].size - (s0 + one[0].grow * DTS)) < 1e-9,
  `size ${s0.toFixed(2)} → ${one[0].size.toFixed(2)}`);
check('泡泡色相随时间流转（hue 前进 hueV·dt，360 取模）',
  Math.abs(one[0].hue - ((h0 + one[0].hueV * DTS) % 360)) < 1e-6,
  `hue ${h0.toFixed(1)} → ${one[0].hue.toFixed(1)}`);
const capped = [{ x: 100, y: 100, v: 0, size: 26, maxSize: 26, grow: 0.4, hue: 0, hueV: 10, sway: 0, freq: 1, phase: 0, alpha: 0.3 }];
pt.step(capped, 'bubbles', 1000, W, H, seeded(1));
check('泡泡长到 maxSize 封顶不再变大', capped[0].size === 26, String(capped[0].size));
const exited = [{ x: 100, y: 2, v: 1000, size: 20, maxSize: 26, grow: 0.2, hue: 0, hueV: 10, sway: 0, freq: 1, phase: 0, alpha: 0.3 }];
pt.step(exited, 'bubbles', 40, W, H, seeded(5));
check('飘出顶边的泡泡重置回初生小泡（3~11px）并从底边再来',
  exited[0].size >= 3 && exited[0].size < 11 && exited[0].y > H, `size=${exited[0].size.toFixed(1)} y=${exited[0].y.toFixed(0)}`);
const emberHues = pt.spawn('embers', 30, W, H, seeded(12)).map((p) => p.hue);
check('灰烬每粒带独立色相（0~360）且 30 粒里 ≥24 个不同色',
  emberHues.every((h) => h >= 0 && h < 360) && new Set(emberHues.map((h) => Math.round(h))).size >= 24,
  `distinct=${new Set(emberHues.map((h) => Math.round(h))).size}/30`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
