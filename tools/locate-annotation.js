'use strict';

/**
 * 定位截图里标注用的红框（用户圈出「想在这里加个东西」时用）。
 *
 * 用途：拿到一张带红框标注的截图，先算出红框在画面里的**相对位置**与尺寸，
 * 再去和 DOM 里各元素的实际坐标对比，判断他圈的是哪个控件 —— 比凭印象猜靠谱得多，
 * 这一轮就因为猜错方向白做过一版。
 *
 * 需要应用带 --remote-debugging-port=9222 启动（借渲染进程的 canvas 解 PNG 像素）。
 *
 *   node tools/locate-annotation.js <图片路径>
 *
 * 输出里 boxRel 是相对整幅图的百分比，columnSegments 是红色像素按列分段的结果
 * （描边框会出现左右两段，据此能看出圈的是不是一整块区域）。
 */

const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2];
if (!file) {
  console.error('用法：node tools/locate-annotation.js <图片路径>');
  process.exit(2);
}

(async () => {
  const b64 = fs.readFileSync(path.resolve(file)).toString('base64');
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';

  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const call = (method, params) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

  const expr = `(async () => {
    const img = new Image();
    img.src = 'data:${mime};base64,${b64}';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;

    let minX = c.width, minY = c.height, maxX = -1, maxY = -1, count = 0;
    const cols = new Array(c.width).fill(0);
    for (let y = 0; y < c.height; y += 1) {
      for (let px = 0; px < c.width; px += 1) {
        const i = (y * c.width + px) * 4;
        const r = d[i], g = d[i + 1], bl = d[i + 2];
        // 标注框通常是纯红（#FF0000 一带），比图里偶发的偏红像素红得多
        if (r > 190 && g < 70 && bl < 70) {
          count += 1;
          cols[px] += 1;
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return { found: false, w: c.width, h: c.height };

    // 按列统计，看看红色集中在哪几段（描边会有左右两条竖线）
    const segs = [];
    let start = -1;
    for (let i = 0; i < cols.length; i += 1) {
      if (cols[i] > 0 && start < 0) start = i;
      else if (cols[i] === 0 && start >= 0) { segs.push([start, i - 1]); start = -1; }
    }
    if (start >= 0) segs.push([start, cols.length - 1]);

    return {
      found: true, w: c.width, h: c.height, redPixels: count,
      box: { x: minX, y: minY, right: maxX, bottom: maxY, w: maxX - minX + 1, h: maxY - minY + 1 },
      boxRel: {
        left: +(minX / c.width * 100).toFixed(1),
        right: +(maxX / c.width * 100).toFixed(1),
        top: +(minY / c.height * 100).toFixed(1),
      },
      columnSegments: segs.slice(0, 8).map(([a, b]) => [a, b, +(a / c.width * 100).toFixed(1) + '%~' + +(b / c.width * 100).toFixed(1) + '%']),
    };  })()`;

  const out = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (out.result?.exceptionDetails) throw new Error(out.result.exceptionDetails.exception?.description);
  console.log(JSON.stringify(out.result.result.value, null, 1));
  ws.close();
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
