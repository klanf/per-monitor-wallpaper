'use strict';

/**
 * 每屏壁纸的可视化验证小应用。
 *
 * 为什么单独做成一个 Electron app 目录：
 *   `electron <某个.js>` 这种写法拿不到 electron 内置模块（require('electron') 会解析到
 *   npm 包自身，返回一个路径字符串），必须是「目录 + package.json」形式才会被当成应用加载。
 *
 * 输出：每个显示器一张缩略图 PNG + 平均色 + 哈希。
 * 平均色能直接回答「这块屏现在显示的是红图还是绿图」。
 */

const { app, desktopCapturer, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const OUT_DIR = path.join(__dirname, '..', 'verify-shots');
const THUMB = { width: 320, height: 180 };

app.whenReady().then(async () => {
  // 给桌面合成留出时间，否则可能抓到切换前的画面
  await new Promise((r) => setTimeout(r, 1500));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUT_DIR)) fs.unlinkSync(path.join(OUT_DIR, f));

  const displays = screen.getAllDisplays();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: THUMB });

  /** 用 NativeImage.toBitmap() 直接算平均色（BGRA 排布） */
  function averageColor(image) {
    const bitmap = image.toBitmap();
    const { width, height } = image.getSize();
    let r = 0; let g = 0; let b = 0; let n = 0;
    // 每隔若干像素采样一次，够用且快
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const off = (y * width + x) * 4;
        b += bitmap[off];
        g += bitmap[off + 1];
        r += bitmap[off + 2];
        n += 1;
      }
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }

  const out = [];
  sources.forEach((source, i) => {
    const png = source.thumbnail.toPNG();
    const avg = averageColor(source.thumbnail);
    const display = displays.find((d) => String(d.id) === String(source.display_id)) || displays[i] || null;
    const file = path.join(OUT_DIR, `screen-${i}.png`);
    fs.writeFileSync(file, png);

    out.push({
      index: i,
      name: source.name,
      displayId: source.display_id,
      bounds: display ? display.bounds : null,
      size: source.thumbnail.getSize(),
      avgColor: avg,
      hash: crypto.createHash('sha1').update(png).digest('hex').slice(0, 16),
      file,
    });
  });

  console.log(JSON.stringify({ ok: true, capturedAt: new Date().toISOString(), screens: out }, null, 2));
  app.exit(0);
});
