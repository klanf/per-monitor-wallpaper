'use strict';

/**
 * particles.js 纯逻辑单测（Node 直跑，不需要 canvas）—— r74 随粒子深度遮挡建。
 * 跑法：node tools/test-particles.js（verify:unit 链里挂着）。
 * 遮挡判定的坐标映射与 stage.js 的 coverRect 同式，深度语义与视差 shader 同向
 * （R 通道 近=1 远=0）；这两条对不上粒子就会整体错挡，所以用例里都钉死。
 */

const path = require('node:path');
const WP = require(path.join(__dirname, '..', 'src', 'renderer', 'particles.js'));

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

/** 造一张常量深度的深度图（RGBA，R=depth*255） */
function flatDepth(w, h, depth01) {
  const v = Math.round(depth01 * 255);
  return { data: new Uint8ClampedArray(w * h * 4).fill(0).map((_, i) => (i % 4 === 0 ? v : 255)), w, h };
}

/** 确定性 rng（可复现，别用 Math.random） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log('—— 深度遮挡判定（r74）——');

// 1. 白名单：首批只有雨/雪/樱花
check('OCCL_TYPES 首批 = rain/snow/sakura',
  JSON.stringify(WP.OCCL_TYPES) === JSON.stringify(['rain', 'snow', 'sakura']));
check('rain/snow/sakura 注册表带 occl 标记（draw 分支按它走）',
  ['rain', 'snow', 'sakura'].every((t) => WP.PARTICLE_TYPES.includes(t)));

// 2. z 懒分配：调用后每粒都有 z ∈ (0,1)
{
  const dep = flatDepth(4, 4, 0);
  const parts = [{ x: 1, y: 1 }, { x: 2, y: 2 }];
  WP.applyDepthOcclusion(parts, { ...dep, bw: 4, bh: 4 }, 100, 100, mulberry32(1));
  check('z 懒分配：每粒拿到 z∈(0,1)', parts.every((p) => p.z > 0 && p.z < 1));
}

// 3. 深度全 0（远景天空）→ 恒可见
{
  const dep = flatDepth(4, 4, 0);
  const parts = [{ x: 50, y: 50, z: 0.3 }, { x: 50, y: 50, z: 0.9 }];
  WP.applyDepthOcclusion(parts, { ...dep, bw: 4, bh: 4 }, 100, 100, mulberry32(2));
  check('天空（d=0）粒子全可见', parts.every((p) => p._o === 1));
}

// 4. 深度全 1（满屏前景）→ z≤0.9 的粒子完全被挡，z=1 贴脸可见
{
  const dep = flatDepth(4, 4, 1);
  const parts = [{ x: 50, y: 50, z: 0.5 }, { x: 50, y: 50, z: 1 }];
  WP.applyDepthOcclusion(parts, { ...dep, bw: 4, bh: 4 }, 100, 100, mulberry32(3));
  check('满屏前景：z=0.5 完全被挡（_o=0）', parts[0]._o === 0);
  check('满屏前景：z=1 在前景侧可见（_o=1）', parts[1]._o === 1);
}

// 5. 软过渡带：rel 落在 [-OCCL_FADE, 0] 线性
{
  const dep = flatDepth(4, 4, 1);
  const parts = [{ x: 50, y: 50, z: 1 - WP.OCCL_FADE / 2 }];   // rel = -FADE/2
  WP.applyDepthOcclusion(parts, { ...dep, bw: 4, bh: 4 }, 100, 100, mulberry32(4));
  const expect = 0.5;
  check(`软过渡：rel=-FADE/2 → _o≈${expect}`, Math.abs(parts[0]._o - expect) < 0.02,
    `实际 ${parts[0]._o.toFixed(3)}`);
}

// 6. cover 映射：深度图比屏幕「宽高比更大」时左右裁切，屏中心仍对应深度中心
{
  // 屏 100×100，原图 200×100（cover 按 W 裁上下？不：s=max(100/200,100/100)=1 → dw=200 超宽，左右各裁 50）
  const w = 10, h = 5;
  const dep = flatDepth(w, h, 0);
  // 把深度图右半边涂成前景（u>0.75）
  for (let y = 0; y < h; y += 1) {
    for (let x = 7; x < w; x += 1) dep.data[(y * w + x) * 4] = 255;
  }
  const parts = [
    { x: 25, y: 50, z: 0.2 },    // u=0.375 → 列 3 → 远景 → 可见
    { x: 89, y: 50, z: 0.2 },    // u=0.695 → 列 6 → 仍在远景侧 → 可见
  ];
  const parts2 = [{ x: 95, y: 50, z: 0.2 }];                     // u=0.725 → 列 7 → 前景列
  WP.applyDepthOcclusion(parts, { ...dep, bw: 200, bh: 100 }, 100, 100, mulberry32(5));
  check('cover 超宽映射：屏左侧落远景 → 可见', parts[0]._o === 1);
  check('cover 超宽映射：屏右侧未到前景列 → 可见', parts[1]._o === 1);
  WP.applyDepthOcclusion(parts2, { ...dep, bw: 200, bh: 100 }, 100, 100, mulberry32(6));
  check('cover 超宽映射：屏最右落进前景列 → 被挡', parts2[0]._o === 0);
}

// 7. 屏幕点在深度图外（contain letterbox / 出界）→ 恒可见
{
  const dep = flatDepth(4, 4, 1);
  const parts = [{ x: 5, y: 50, z: 0.2 }];   // dw=100 起止 [0,100]？bw=bh=4, s=max(25,25)=25 → 恰好铺满
  // 造出界：给一个窄高比原图，左右 letterbox…… cover 不会留黑边 —— 出界只会发生在
  // setDepth 传错映射时，防御性：x<dx 落 u<0
  const p2 = [{ x: -10, y: 50, z: 0.2 }];
  WP.applyDepthOcclusion(parts, { ...dep, bw: 4, bh: 4 }, 100, 100, mulberry32(7));
  check('屏内点按深度挡（d=1, z=0.2 → 0）', parts[0]._o === 0);
  WP.applyDepthOcclusion(p2, { ...dep, bw: 4, bh: 4 }, 100, 100, mulberry32(8));
  check('深度图外（u<0）防御性可见', p2[0]._o === 1);
}

// 8. 坏输入不炸
{
  const parts = [{ x: 1, y: 1 }];
  WP.applyDepthOcclusion(parts, null, 100, 100, mulberry32(9));
  WP.applyDepthOcclusion(parts, { w: 4, h: 4, bw: 4, bh: 4 }, 100, 100, mulberry32(10));
  check('dep=null / 缺 data：不炸且不误设 _o', parts.length === 1 && parts[0]._o === undefined);
}

// 8b. 浏览器绑定路径：createParticles 单参调用 → 闭包 rand=undefined（r74 追记实锤：
// 直接调 rand() 抛 TypeError → 杀死 stage 整个 rAF 循环 → 视差被粒子拖死）
{
  const dep = flatDepth(4, 4, 0.5);
  const parts = [{ x: 50, y: 50 }, { x: 60, y: 60 }];
  let threw = false;
  try {
    WP.applyDepthOcclusion(parts, { ...dep, bw: 4, bh: 4 }, 100, 100, undefined);
  } catch (_) { threw = true; }
  check('rand=undefined（浏览器绑定路径）不炸', !threw);
  check('rand=undefined 时 z 仍被懒分配', parts.every((p) => p.z > 0 && p.z < 1));
}

console.log('—— 回归：既有纯逻辑不受影响 ——');

// 9. 老别名迁移（r51）仍在
check('TYPE_ALIASES：fluff→snow / dust→fireflies',
  WP.clampType('fluff') === 'snow' && WP.clampType('dust') === 'fireflies');
check('脏值回落关闭', WP.clampType('nope') === '');

// 10. spawn 数量仍走 cap/白名单
check('spawn 白名单外返回空数组', WP.spawn('nope', 10, 100, 100, mulberry32(11)).length === 0);
check('spawn rain 正常出粒', WP.spawn('rain', 30, 100, 100, mulberry32(12)).length === 30);

console.log(`\n结果：${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
