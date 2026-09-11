'use strict';

/**
 * 抓应用界面截图（走 CDP 的 Page.captureScreenshot）。
 *
 *   node tools/screenshot-ui.js [输出路径] [--full]
 *
 * 需要应用已带 --remote-debugging-port=9222 启动。
 * 默认**只截设置面板那一栏**：面板宽 392 CSS px，截图按窗口实际内宽裁切。
 * 这样不会把用户的壁纸内容一起截进去（本机壁纸库是成人向内容，
 * 截图作为交付物时不该带上）。
 * 加 --full 才截整个窗口。
 */

const fs = require('node:fs');
const path = require('node:path');

const CDP_LIST = 'http://127.0.0.1:9222/json';

const PANEL_WIDTH = 400;
const argv = process.argv.slice(2);
const full = argv.includes('--full');
const OUT = argv.find((a) => !a.startsWith('--'))
  || path.resolve(__dirname, '..', 'docs', 'ui-per-monitor.png');

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let seq = 0;
    ws.addEventListener('open', () => resolve({
      call(method, params) {
        return new Promise((res) => {
          const id = ++seq;
          pending.set(id, res);
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close: () => ws.close(),
    }));
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
  });
}

(async () => {
  let targets;
  try {
    targets = await (await fetch(CDP_LIST)).json();
  } catch {
    throw new Error('应用未启动，或没有开 --remote-debugging-port=9222');
  }
  const page = targets.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
  if (!page) throw new Error('没找到渲染进程页面');

  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable', {});
  await cdp.call('Page.enable', {});

  const evaluate = (expression) => cdp.call('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });

  // 截图前先把舞台清空。
  // ⚠️ 必须做这一步：窗口背景就是用户的壁纸（本机壁纸库是成人向内容），
  //    直接截会把壁纸一起截进去。CDP 截的是页面 DOM，清掉 <img> 就干净了。
  await evaluate(`(async () => {
    // 用加类而不是 click —— 面板可能是开着的，click 会把它关掉
    const panel = document.getElementById('settings');
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    document.querySelectorAll('details.mc-more').forEach(d => { d.open = true; });
    document.querySelectorAll('#stage img').forEach(img => img.removeAttribute('src'));
    document.getElementById('stage').style.background = '#0b0b0d';
    document.body.classList.remove('idle');
    panel.scrollTop = 0;
    await new Promise(r => setTimeout(r, 700));
  })()`);

  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  const base64 = shot.result && shot.result.data;
  if (!base64) throw new Error('截图失败：' + JSON.stringify(shot).slice(0, 200));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(base64, 'base64'));
  console.log('已保存:', OUT, `(${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);

  cdp.close();
})().catch((err) => {
  console.error('截图失败:', err.message);
  process.exit(1);
});
