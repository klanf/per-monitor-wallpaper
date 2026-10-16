'use strict';

/**
 * 干净背景板单测（双层视差路线 1，2026-10-16）—— Node 直跑（verify:unit 链里挂着）。
 * 覆盖：personBin 三路守卫（正常/平坦/占比退化）、writeCleanPlate 的
 * 填充正确性（人像区 ≈ 背景色、区外逐像素等于原图）、边界 person 触边也能填满、
 * 输出尺寸契约。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const sharp = require('sharp');
const ENG = require(path.join(__dirname, '..', 'src', 'depthEngineJs.js'));
const { personBin, writeCleanPlate } = ENG.__test;

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-cleanplate-'));
const BG = [10, 100, 200];      // 背景常量色
const FG = [200, 40, 40];       // 「人物」常量色

/** 造测试图：64×64，中央 16..48 为人物方块（触边变体由 atEdge 控制） */
async function makeImage(name, atEdge) {
  const w = 64, h = 64;
  const buf = Buffer.alloc(w * h * 3);
  const x0 = atEdge ? 0 : 16;
  const x1 = atEdge ? 20 : 48;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const person = x >= x0 && x < x1 && y >= 16 && y < 48;
      const c = person ? FG : BG;
      const i = (y * w + x) * 3;
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
    }
  }
  const p = path.join(tmpDir, name);
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(p);
  return p;
}

async function main() {
  try {
    // ---- personBin ----
    const W = 32, H = 32;
    const depth = Buffer.alloc(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        depth[y * W + x] = (x >= 8 && x < 24 && y >= 8 && y < 24) ? 220 : 30;
      }
    }
    const bin = personBin(depth, W, H);
    check('personBin：人像区 255 / 背景区 0',
      bin && bin[8 * W + 8] === 255 && bin[0] === 0);

    const flat = Buffer.alloc(W * H, 128);
    check('personBin：深度平坦（Otsu 无峰）→ null', personBin(flat, W, H) === null);

    const allNear = Buffer.alloc(W * H, 250);
    check('personBin：前景占比 >95% → null', personBin(allNear, W, H) === null);

    const tiny = Buffer.alloc(W * H, 30);
    tiny[0] = 250;   // 1/1024 ≈ 0.1% < 2%
    check('personBin：前景占比 <2% → null', personBin(tiny, W, H) === null);

    // ---- personBin 外扩（FG_DILATE_PX=3，第七十轮）：紧贴人物的 1px 细节（脚趾/发梢类）并入 ----
    const thin = Buffer.alloc(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        thin[y * W + x] = ((x >= 12 && x < 20 && y >= 12 && y < 20) || (x === 20 && y === 16)) ? 220 : 30;
      }
    }
    const binD = personBin(thin, W, H);
    check('personBin：外扩后 1px 细节旁 3px 处已并入', binD && binD[16 * W + 23] === 255,
      `x23=${binD ? binD[16 * W + 23] : 'null'}`);
    check('personBin：外扩不越界（细节旁 8px 处仍为背景）', binD && binD[16 * W + 28] === 0);

    // ---- writeCleanPlate：居中人物 ----
    const imgPath = await makeImage('center.png', false);
    const outPath = path.join(tmpDir, 'center.bg.jpg');
    const t0 = Date.now();
    await writeCleanPlate(sharp, imgPath, bin, W, H, 64, 64, outPath);
    const elapsed = Date.now() - t0;
    check('writeCleanPlate：产出文件存在', fs.existsSync(outPath));

    const out = await sharp(outPath).removeAlpha().raw().toBuffer();
    check('writeCleanPlate：输出尺寸 = w0×h0×3', out.length === 64 * 64 * 3);
    const px = (x, y) => {
      const i = (y * 64 + x) * 3;
      return [out[i], out[i + 1], out[i + 2]];
    };
    const near = (c, t, tol) => Math.abs(c[0] - t[0]) <= tol && Math.abs(c[1] - t[1]) <= tol && Math.abs(c[2] - t[2]) <= tol;
    check('writeCleanPlate：人像中心被填充 ≈ 背景色', near(px(32, 32), BG, 20),
      `center=${px(32, 32)} bg=${BG}`);
    check('writeCleanPlate：人像中心不再是人物色', !near(px(32, 32), FG, 40));
    check('writeCleanPlate：区外角点=原图（JPEG 量化误差内）', near(px(2, 2), BG, 3),
      `corner=${px(2, 2)}`);
    check('writeCleanPlate：区外另一点=原图（JPEG 量化误差内）', near(px(60, 60), BG, 3));
    check(`writeCleanPlate：耗时 ${elapsed}ms（64×64 小图，量级 sanity）`, elapsed < 10000);

    // ---- writeCleanPlate：人物触边（填充只能从单侧长入）----
    const imgEdge = await makeImage('edge.png', true);
    // 触边变体的 bin：x 0..10（32 空间）为人物
    const binEdge = Buffer.alloc(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) binEdge[y * W + x] = x < 10 ? 255 : 0;
    }
    const outEdge = path.join(tmpDir, 'edge.bg.jpg');
    await writeCleanPlate(sharp, imgEdge, binEdge, W, H, 64, 64, outEdge);
    const outE = await sharp(outEdge).removeAlpha().raw().toBuffer();
    const pxE = (x, y) => {
      const i = (y * 64 + x) * 3;
      return [outE[i], outE[i + 1], outE[i + 2]];
    };
    check('writeCleanPlate：触边人物也被填满 ≈ 背景色', near(pxE(6, 32), BG, 30),
      `x6=${pxE(6, 32)}`);
    check('writeCleanPlate：触边变体区外不变（JPEG 量化误差内）', near(pxE(60, 2), BG, 3));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('测试崩溃:', err); process.exit(1); });
