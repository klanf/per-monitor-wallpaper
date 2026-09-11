'use strict';

/**
 * 从截图里读文字（本模型没有视觉能力时用）。
 *
 * 用法：
 *   node tools/ocr-image.js <图片路径>
 *   node tools/ocr-image.js <图片路径> --scale 4
 *   node tools/ocr-image.js <图片路径> --crop 120,40,288,50 --scale 4
 *   node tools/ocr-image.js <图片路径> --lang chi_sim
 *   node tools/ocr-image.js <图片路径> --save out.png      # 顺便存下放大后的图，便于复核
 *   node tools/ocr-image.js <图片路径> --crop 120,42,295,26 --scale 6 --psm 7 --bin
 *
 * 小字必须裁出来放大再识别 —— 放大 3~4 倍前后是「读不出来」和「读得出来」的差别。
 * 只读**一行**时再叠 `--psm 7`（单行模式）；深底浅字的界面叠 `--bin` 先二值化。
 * 语言数据缓存在 tools/.ocr-cache，首次运行会下载约 30MB。
 */

const fs = require('node:fs');
const path = require('node:path');
const img_ = require('./imgcodec');

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('用法：node tools/ocr-image.js <图片路径> [--scale N] [--crop x,y,w,h] [--lang chi_sim] [--psm 7] [--bin] [--save out.png]');
  process.exit(2);
}

const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const langs = String(opt('lang', 'chi_sim+eng')).split('+');
const scale = Number(opt('scale', 1));
const cropArg = opt('crop', null);
const saveAt = opt('save', null);
const psm = opt('psm', null);

const CACHE = path.resolve(__dirname, '.ocr-cache');
fs.mkdirSync(CACHE, { recursive: true });

(async () => {
  let img = img_.decodePng(fs.readFileSync(path.resolve(file)));
  console.log(`原始尺寸 ${img.width}×${img.height}`);

  if (cropArg) {
    const [x, y, w, h] = cropArg.split(',').map(Number);
    img = img_.crop(img, { x, y, width: w, height: h });
    console.log(`裁出 ${img.width}×${img.height}（起点 ${x},${y}）`);
  }
  if (scale > 1) {
    img = img_.resize(img, scale);
    console.log(`放大 ×${scale} → ${img.width}×${img.height}`);
  }
  if (flag('bin')) {
    img = img_.threshold(img, Number(opt('cutoff', 128)), flag('invert'));
    console.log('已二值化');
  }

  const png = img_.encodePng(img);
  if (saveAt) { fs.writeFileSync(path.resolve(saveAt), png); console.log(`放大图已存 ${saveAt}`); }

  const { createWorker } = require('tesseract.js');
  const worker = await createWorker(langs, 1, {
    cachePath: CACHE,
    logger: (m) => { if (m.status === 'recognizing text') return; process.stderr.write(`  [ocr] ${m.status}\n`); },
  });
  // 只读一行时用单行模式（PSM 7），比自动分页准得多
  if (psm) await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
  const { data } = await worker.recognize(Buffer.from(png));
  await worker.terminate();

  const lines = String(data.text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  console.log(`\n语言 ${langs.join('+')}   置信度 ${data.confidence ? data.confidence.toFixed(1) : '-'}   读到 ${lines.length} 行\n`);
  lines.forEach((l, i) => console.log(`  ${String(i + 1).padStart(2)}. ${l}`));

  const words = [];
  const walk = (node) => {
    if (!node) return;
    if (node.text && node.text.trim() && node.bbox) {
      words.push({
        t: node.text.trim(),
        x: Math.round(node.bbox.x0 / scale) + (cropArg ? Number(cropArg.split(',')[0]) : 0),
        y: Math.round(node.bbox.y0 / scale) + (cropArg ? Number(cropArg.split(',')[1]) : 0),
        w: Math.round((node.bbox.x1 - node.bbox.x0) / scale),
        h: Math.round((node.bbox.y1 - node.bbox.y0) / scale),
      });
    }
    (node.words || node.blocks || node.paragraphs || node.lines || []).forEach(walk);
  };
  walk(data);

  if (words.length) {
    console.log(`\n逐词（坐标已换算回原图）：`);
    for (const w of words.slice(0, 80)) {
      console.log(`  x=${String(w.x).padStart(4)}..${String(w.x + w.w).padStart(4)}  y=${String(w.y).padStart(3)}..${String(w.y + w.h).padStart(3)}  ${w.t}`);
    }
  }
})().catch((err) => { console.error('OCR 失败:', err.message); process.exit(1); });
