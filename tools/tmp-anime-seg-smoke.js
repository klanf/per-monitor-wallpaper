/**
 * isnetis vs u2netp 真图冒烟（第七十一轮）—— Node 直跑。
 * 用法：node tools/tmp-anime-seg-smoke.js [图片路径 ...]
 * 输出：D:/workbuddy/tmp/anime-seg-compare.jpg（原图 | isnetis alpha | u2netp | cleanplate）
 */
const path = require('node:path');
const fs = require('node:fs');
const sharp = require('sharp');
const ROOT = path.join(__dirname, '..');
const ENG = require(path.join(ROOT, 'src', 'depthEngineJs.js'));

const DEFAULT_IMGS = [
  'F:/壁纸/桌面壁纸/待分类/-helic-_可畏_4022279_83574395_p0.jpg',
];

async function main() {
  const probeRes = await ENG.probe(path.join(ROOT, 'models', 'segmentation', 'u2netp.onnx'));
  if (!probeRes.ok) throw new Error('probe 失败: ' + probeRes.reason);
  const sharpMod = require('sharp');
  const imgs = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_IMGS;
  const { segmentAnime, segmentPerson, personBin, writeCleanPlate, preshrinkDims } = ENG.__test;
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'animeseg-'));
  const panels = [];
  for (const imgPath of imgs) {
    const { dw, dh, w0, h0 } = await preshrinkDims(sharpMod, imgPath);
    console.log(`图: ${path.basename(imgPath)}  preshrink=${w0}x${h0} depth=${dw}x${dh}`);
    const t0 = Date.now();
    const alpha = await segmentAnime(sharpMod, imgPath, dw, dh);
    const tAnime = Date.now() - t0;
    const t1 = Date.now();
    const u2 = await segmentPerson(sharpMod, imgPath, dw, dh);
    const tU2 = Date.now() - t1;
    // 覆盖率对比（Otsu 切开后）
    const binA = personBin(alpha, dw, dh);
    const binU = personBin(u2, dw, dh);
    const cover = (b) => b ? (b.reduce((s, v) => s + (v ? 1 : 0), 0) / b.length * 100).toFixed(1) + '%' : 'null';
    console.log(`  isnetis ${tAnime}ms 覆盖=${cover(binA)}   u2netp ${tU2}ms 覆盖=${cover(binU)}`);
    // 背景板（走真实管线）
    const bgPath = path.join(tmp, path.basename(imgPath).slice(0, 8) + '.bg.jpg');
    await writeCleanPlate(sharpMod, imgPath, binA, dw, dh, w0, h0, bgPath);
    // 拼对比条：原图 | isnetis mask | u2netp mask | 背景板
    const W = 480;
    const cell = async (src, isMask, cw, ch) => {
      let p;
      if (Buffer.isBuffer(src) && !(src[0] === 0x89 && src[1] === 0x50)) {
        // 裸 u8 灰度 buffer（mask）：按 depth 分辨率声明 raw
        p = sharp(src, { raw: { width: cw, height: ch, channels: 1 } }).toColourspace('b-w');
      } else {
        p = sharp(src);
        if (isMask) p = p.toColourspace('b-w');
      }
      return p.resize(W, W, { fit: 'inside' }).png().toBuffer();
    };
    panels.push(await cell(imgPath, false));
    panels.push(await cell(alpha, true, dw, dh));
    panels.push(await cell(u2, true, dw, dh));
    panels.push(await cell(bgPath, false));
  }
  // 4 列一行拼图
  const W = 480;
  const metas = await Promise.all(panels.map((b) => sharp(b).metadata()));
  const rowH = Math.max(...metas.map((m) => m.height));
  const composite = panels.map((input, i) => ({ input, left: (i % 4) * W, top: Math.floor(i / 4) * rowH }));
  await sharp({ create: { width: W * 4, height: rowH * Math.ceil(panels.length / 4), channels: 3, background: '#222' } })
    .composite(composite).jpeg({ quality: 88 }).toFile('D:/workbuddy/tmp/anime-seg-compare.jpg');
  console.log('对比图: D:/workbuddy/tmp/anime-seg-compare.jpg');
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().then(() => process.exit(0), (err) => { console.error('SMOKE-FAIL:', err); process.exit(1); });
