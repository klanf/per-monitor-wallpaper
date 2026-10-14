'use strict';
// 临时脚本：给两张在播图生成 u2netp 分割 mask（与 depthEngineJs.segmentPerson 同款逻辑）
const ort = require('onnxruntime-node');
const sharp = require('sharp');

(async () => {
  const sess = await ort.InferenceSession.create('models/segmentation/u2netp.onnx', { executionProviders: ['cpu'] });
  const jobs = [
    ['closeup', 'F:/Syncthing/ai图/26_10_08/Anima-20261008173612_00006_.png'],
    ['maid', 'F:/Syncthing/Download/Anima-Random/Anima-20260923225150_00003_.png'],
  ];
  for (const [tag, p] of jobs) {
    const img = await sharp(p).removeAlpha().resize(320, 320, { fit: 'fill' }).raw().toBuffer();
    const n = 320 * 320;
    const px = new Float32Array(3 * n);
    const MEAN = [0.485, 0.456, 0.406];
    const STD = [0.229, 0.224, 0.225];
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < n; i++) px[c * n + i] = (img[i * 3 + c] / 255 - MEAN[c]) / STD[c];
    }
    const outName = sess.outputNames[0];
    const out = await sess.run({ 'input.1': new ort.Tensor('float32', px, [1, 3, 320, 320]) });
    const d = out[outName].data;
    let mn = 1e9; let mx = -1e9;
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      sig[i] = 1 / (1 + Math.exp(-d[i]));
      if (sig[i] < mn) mn = sig[i];
      if (sig[i] > mx) mx = sig[i];
    }
    const u8 = Buffer.alloc(n);
    for (let i = 0; i < n; i++) u8[i] = Math.round((sig[i] - mn) / (mx - mn) * 255);
    const dw = 576; const dh = 1020;
    const buf = await sharp(u8, { raw: { width: 320, height: 320, channels: 1 } })
      .resize(dw, dh, { fit: 'fill' }).toColourspace('b-w').raw().toBuffer();
    await sharp(buf, { raw: { width: dw, height: dh, channels: 1 } }).png().toFile(`tools/out/idle-sim/seg-${tag}.png`);
    console.log('saved', tag);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
