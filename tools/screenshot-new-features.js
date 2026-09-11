'use strict';

/**
 * 抓「新功能」界面截图：胶片条 / 图片信息面板 / 设置面板里的新分节。
 *
 *   node tools/screenshot-new-features.js
 *
 * 需要应用已带 --remote-debugging-port=9222 启动。
 *
 * 为什么不用 tools/screenshot-ui.js 直接截：
 * 用户的真实壁纸库是成人向内容，截图作为交付物不该带进去。
 * 所以这里先把频道临时切到 tools/fixtures 里的测试图，截完再还原原配置。
 */

const fs = require('node:fs');
const path = require('node:path');

const CDP_LIST = 'http://127.0.0.1:9222/json';
const FIXTURES = path.resolve(__dirname, 'fixtures');
const DEMO = path.resolve(__dirname, 'tmp', 'demo');
const OUT_DIR = path.resolve(__dirname, '..', 'docs');

/* ------------------------------------------------------------ CDP */

async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(CDP_LIST)).json();
      const page = targets.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch { /* 还没起来，继续等 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('等不到渲染进程，应用是否带 --remote-debugging-port=9222 启动了？');
}

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

/* ------------------------------------------------------------ 素材 */

function buildDemo() {
  fs.rmSync(DEMO, { recursive: true, force: true });
  fs.mkdirSync(DEMO, { recursive: true });

  const gallery = fs.readdirSync(path.join(FIXTURES, 'gallery')).sort();
  for (let i = 0; i < 13; i += 1) {
    fs.copyFileSync(path.join(FIXTURES, 'gallery', gallery[i * 3]), path.join(DEMO, `壁纸 ${String(i + 1).padStart(2, '0')}.png`));
  }
  fs.copyFileSync(path.join(FIXTURES, 'exif-camera.jpg'), path.join(DEMO, '相机样张 EOS R6.jpg'));
}

/* ------------------------------------------------------------ 主流程 */

(async () => {
  buildDemo();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const page = await waitForPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable', {});
  await cdp.call('Page.enable', {});

  async function ev(expression) {
    const out = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.result?.exceptionDetails) {
      throw new Error(out.result.exceptionDetails.exception?.description || '脚本异常');
    }
    return out.result?.result?.value;
  }

  async function shot(name, selector, pad = 0) {
    const params = { format: 'png', captureBeyondViewport: false };
    if (selector) {
      const rect = await ev(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x - ${pad}, y: r.y - ${pad}, width: r.width + ${pad * 2}, height: r.height + ${pad * 2} };
      })()`);
      if (rect) {
        const viewport = await ev('({ w: window.innerWidth, h: window.innerHeight })');
        params.clip = {
          x: Math.max(0, Math.round(rect.x)),
          y: Math.max(0, Math.round(rect.y)),
          width: Math.min(Math.round(rect.width), viewport.w),
          height: Math.min(Math.round(rect.height), viewport.h),
          scale: 1,
        };
      }
    }
    const out = await cdp.call('Page.captureScreenshot', params);
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, Buffer.from(out.result.data, 'base64'));
    console.log(`  ✓ ${name}  ${params.clip ? `${params.clip.width}×${params.clip.height}` : '整窗'}`);
    return file;
  }

  // 备份真实配置，切到测试素材
  const cfg = await ev('window.wp.getConfig()');
  console.log('临时切到测试素材（避免把真实壁纸库截进交付物）…');
  await ev('window.wp.setConfig(' + JSON.stringify({
    folder: DEMO, recursive: false, perMonitor: false, monitor: 'primary',
    interval: 900, shuffle: true, autoPlay: false, applyToSystem: false,
    filmstrip: true, filmstripRange: 40, infoPanel: true,
  }) + ')');
  await ev('window.wp.rebuildChannels(true)');
  await new Promise((r) => setTimeout(r, 2600));

  // 先把「看过 / 没看过」的标记做出来：跳几张再回来
  for (const i of [1, 2, 3, 6]) {
    await ev(`document.querySelector('#film-track .film-item[data-index="${i}"]').click()`);
    await new Promise((r) => setTimeout(r, 320));
  }
  await ev(`document.querySelector('#film-track .film-item[data-index="4"]').click()`);
  await new Promise((r) => setTimeout(r, 1200));

  console.log('截图：');
  const filmState = await ev(`(() => {
    const items = [...document.querySelectorAll('#film-track .film-item')];
    const imgs = items.map((e) => e.querySelector('img')).filter(Boolean);
    const bar = document.querySelector('#filmstrip');
    const r = bar.getBoundingClientRect();
    return {
      items: items.length,
      decoded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      stripSize: Math.round(r.width) + 'x' + Math.round(r.height),
      itemBox: items[0] ? (() => { const b = items[0].getBoundingClientRect(); return Math.round(b.width) + 'x' + Math.round(b.height); })() : '(无)',
      visible: getComputedStyle(bar).display,
    };
  })()`);
  console.log(`  胶片条 DOM：${filmState.items} 个节点 / ${filmState.decoded} 张已解码  区域 ${filmState.stripSize}  单项 ${filmState.itemBox}  display=${filmState.visible}`);
  await shot('新功能-胶片条.png', '#filmstrip', 6);

  // 信息面板：切到带 EXIF 的那张，再打开
  await ev(`(() => {
    const el = [...document.querySelectorAll('#film-track .film-item')]
      .find((e) => (e.title || '').includes('EOS R6'));
    if (el) el.click();
  })()`);
  await new Promise((r) => setTimeout(r, 1400));
  await ev(`document.querySelector('#btn-info').click()`);
  await new Promise((r) => setTimeout(r, 1600));
  await shot('新功能-图片信息面板.png', '#info', 0);

  // 设置面板里的新分节
  await ev(`document.querySelector('#btn-settings').click()`);
  await new Promise((r) => setTimeout(r, 900));
  await ev(`(async () => {
    const fields = [...document.querySelectorAll('#settings .field')];
    const target = fields.find((f) => /后台驻留/.test(f.querySelector('.field-label')?.textContent || ''));
    if (target) target.scrollIntoView({ block: 'start' });
  })()`);
  await new Promise((r) => setTimeout(r, 700));
  await shot('新功能-设置分节.png', '#settings', 0);

  // 「删除 + 全局热键」那一节：临时绑两个热键，好看清绑定态的样式
  await ev(`window.wp.setHotkeys({ cycleMonitor: 'Ctrl+M', next: 'Ctrl+Right', prev: 'Ctrl+Left', delete: 'Ctrl+Shift+D' })`);
  await ev(`window.__reloadConfig && window.__reloadConfig()`);
  await new Promise((r) => setTimeout(r, 700));
  await ev(`(async () => {
    const fields = [...document.querySelectorAll('#settings .field')];
    const target = fields.find((f) => /^删除$/.test((f.querySelector('.field-label')?.textContent || '').trim()));
    if (target) target.scrollIntoView({ block: 'start' });
  })()`);
  await new Promise((r) => setTimeout(r, 700));
  await shot('新功能-删除与热键.png', '#settings', 0);
  await ev(`window.wp.setHotkeys({ cycleMonitor: '', next: '', prev: '', playPause: '', delete: '', toggleWindow: '', info: '' })`);
  await new Promise((r) => setTimeout(r, 400));

  await ev(`document.querySelector('#btn-settings-close').click()`);
  await ev(`document.querySelector('#btn-info-close') ? 0 : 0`);

  // 还原
  console.log('还原原配置…');
  await ev('window.wp.setConfig(' + JSON.stringify(cfg) + ')');
  await ev('window.wp.rebuildChannels(true)');
  await new Promise((r) => setTimeout(r, 1500));
  const back = await ev('window.wp.getConfig()');
  console.log(`  频道目录已还原：${back.folder}`);

  cdp.close();
  console.log(`截图目录：${OUT_DIR}`);
  process.exit(0);
})().catch((err) => {
  console.error('截图失败：', err.message);
  process.exit(1);
});
