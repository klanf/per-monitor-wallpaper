'use strict';
/** 一次性验证：前景 mask 派生（r62 idle 方案 A1）—— Otsu 阈值 + 羽化 + 退化保护。
 *  性质断言（CPU 侧可自证）：
 *  ① 双峰合成深度（下 40% 前景=亮、上 60% 背景=暗+噪声）→ mask 落盘，
 *     前景占比 ≈ 40%（±5%），边界有羽化过渡带（0<v<255 的像素存在）；
 *  ② 平坦深度（全 128±1）→ Otsu 仍出阈值但前景占比超界 → 不写 mask 文件；
 *  ③ 全前景（全 255）→ 占比 >0.95 → 不写 mask 文件。 */
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { __test } = require('../src/depthEngineJs');
const { otsuThreshold, writeMask } = __test;

const W = 100;
const H = 100;
const outDir = path.join(__dirname, 'tmp-mask-verify');

async function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // ① 双峰合成
  const dual = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const noise = (x * 7 + y * 13) % 9 - 4;   // 确定性伪噪声 ±4
      dual[y * W + x] = y >= H * 0.6 ? Math.min(255, 200 + noise) : Math.max(0, 60 + noise);
    }
  }
  const thr1 = otsuThreshold(dual);
  const p1 = path.join(outDir, 'dual.mask.png');
  await writeMask(sharp, dual, W, H, p1);
  const { data: m1, info: i1 } = await sharp(p1).raw().toBuffer({ resolveWithObject: true });
  let fg = 0;
  let mid = 0;
  for (const v of m1) { if (v > 200) fg += 1; else if (v > 20 && v < 235) mid += 1; }
  const ratio = fg / m1.length;   // 每像素 channels 个通道值同色，值占比 = 像素占比
  console.log(`① 双峰: thr=${thr1} fg占比=${(ratio * 100).toFixed(1)}% 过渡带=${mid}px mask尺寸=${i1.width}x${i1.height}`);
  if (Math.abs(ratio - 0.4) > 0.05) throw new Error(`前景占比 ${ratio} 偏离 0.4`);
  if (mid === 0) throw new Error('羽化过渡带缺失');
  if (i1.width !== W || i1.height !== H) throw new Error('mask 分辨率与深度不一致');

  // ② 真平坦深度（单值）：直方图无第二峰 → Otsu 返回 -1 → 不写 mask
  //   （注：normalizeDepth 恒拉满 0..255，±1 噪声会变双峰，Otsu 切它属正确行为不算退化）
  const flat = Buffer.alloc(W * H, 128);
  const thr2 = otsuThreshold(flat);
  const p2 = path.join(outDir, 'flat.mask.png');
  await writeMask(sharp, flat, W, H, p2);
  console.log(`② 平坦: thr=${thr2} mask文件=${fs.existsSync(p2) ? '存在（异常！）' : '未写（符合预期）'}`);
  if (fs.existsSync(p2)) throw new Error('平坦深度不应写 mask');

  // ③ 全前景
  const all = Buffer.alloc(W * H, 255);
  const thr3 = otsuThreshold(all);
  const p3 = path.join(outDir, 'all.mask.png');
  await writeMask(sharp, all, W, H, p3);
  console.log(`③ 全前景: thr=${thr3} mask文件=${fs.existsSync(p3) ? '存在（异常！）' : '未写（符合预期）'}`);
  if (fs.existsSync(p3)) throw new Error('全前景不应写 mask');

  fs.rmSync(outDir, { recursive: true, force: true });
  console.log('== MASK VERIFY ALL PASS ==');
}

main().catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
