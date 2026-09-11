'use strict';

/**
 * 抓 README 用的界面截图（窗口内的部分，走 CDP）。
 *
 *   node tools/screenshot-readme.js
 *
 * 需要应用已带 --remote-debugging-port=9222 启动。
 *
 * 为什么先把数据源切到 tools/fixtures 的测试素材：
 *   用户的真实壁纸库是成人向内容，截图作为交付物不该带进去。
 *   测试素材是 1280×720 的渐变色块 + 序号色带，能互相区分，适合演示胶片条。
 *
 * 安全约定（重要）：
 *   本脚本**只往磁盘写测试配置，不负责还原**。还原由调用方在脚本外做整文件覆盖：
 *     1. 跑之前 cp config.json tools/tmp/config-backup-readme.json
 *     2. 跑完之后 结束应用 → 把备份整文件覆盖回去 → 重新启动
 *   为什么不用 setConfig 还原：store 读取时对默认值做**深合并**，
 *   perMonitor 模式下自动写入的 monitors 覆盖项不一定能被一次 setConfig 清掉。
 *   整文件覆盖绕开这套语义，也绕开「脚本被中途打断就留在测试态」的老问题。
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
  // 24 张够胶片条铺满且看得出「已播放 / 当前 / 未播放」三种状态
  for (let i = 0; i < 24; i += 1) {
    fs.copyFileSync(
      path.join(FIXTURES, 'gallery', gallery[i * 4]),
      path.join(DEMO, `壁纸 ${String(i + 1).padStart(2, '0')}.png`),
    );
  }
  fs.copyFileSync(path.join(FIXTURES, 'exif-camera.jpg'), path.join(DEMO, '相机样张 EOS R6.jpg'));
  return 25;
}

/* ------------------------------------------------------------ 主流程 */

const results = [];

(async () => {
  const count = buildDemo();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`测试素材：${count} 张 → ${DEMO}`);

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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 唤醒上下两栏。
   *
   * 界面在鼠标静止 2.4 秒后会给 body 加 .idle，把顶栏与底栏 opacity 置 0 淡出
   * （见 app.js 的 pokeBars / body.idle .bar.bottom）。自动化过程里没有真实鼠标移动，
   * 所以**胶片条截出来永远是隐形的** —— 早先那张 1.7 KB 的「坏图」就是这么来的，
   * 它在缩略图里尺寸看着完全正常，极难发现。
   * 必须用 CDP 派发真实的 mouseMoved（合成 new MouseEvent 不一定能唤醒）。
   */
  async function wake(x = 711, y = 465) {
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: 0 });
    await sleep(420);
  }

  /** 截一张。selector 为空则截整个视口；pad 是四周留白（CSS px）。 */
  async function shot(name, selector, pad = 0) {
    await wake();
    const params = { format: 'png', captureBeyondViewport: false };
    if (selector) {
      const rect = await ev(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`);
      if (!rect) throw new Error(`找不到选择器 ${selector}`);
      const viewport = await ev('({ w: window.innerWidth, h: window.innerHeight })');

      // 关键：把框**裁剪到视口内**，不要滚动、也不要把 y 挪到别处。
      // 胶片条是贴住视口底部的，y + height 必然略微越界；
      // 早先的写法遇到越界就把 clip.y 改成 12「防空白」，结果截到的是页面顶栏 ——
      // 产出一张 1.7 KB 的纯色图，还在缩略图里看着「尺寸正常」，极难发现。
      const x = Math.max(0, Math.round(rect.x - pad));
      const y = Math.max(0, Math.round(rect.y - pad));
      params.clip = {
        x,
        y,
        width: Math.max(1, Math.min(Math.round(rect.width + pad * 2), viewport.w - x)),
        height: Math.max(1, Math.min(Math.round(rect.height + pad * 2), viewport.h - y)),
        scale: 1,
      };
    }
    const out = await cdp.call('Page.captureScreenshot', params);
    const png = Buffer.from(out.result.data, 'base64');
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, png);

    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    const pxPerByte = (w * h) / png.length;
    results.push({ name, w, h, bytes: png.length, pxPerByte: Math.round(pxPerByte) });
    console.log(`  ✓ ${name}  ${w}×${h}  ${(png.length / 1024).toFixed(1)} KB  ${Math.round(pxPerByte)} px/byte`);
    return file;
  }

  console.log('临时切到测试素材（避免把真实壁纸库截进交付物）…');
  await ev('window.wp.setConfig(' + JSON.stringify({
    folder: DEMO,
    recursive: false,
    perMonitor: false,
    monitor: 'primary',
    interval: 900,
    shuffle: true,
    autoPlay: false,
    applyToSystem: false,
    filmstrip: true,
    filmstripRange: 40,
    infoPanel: true,
    contextMenu: true,
    confirmDelete: true,
    hotkeys: { cycleMonitor: '', next: '', prev: '', playPause: '', delete: '', toggleWindow: '', info: '' },
  }) + ')');

  // 每屏覆盖必须单独处理：频道 profile 走 resolveProfile(全局, monitors[设备路径])，覆盖优先。
  // 只改全局 folder 的话，顶栏照样显示覆盖里的真实子目录（真实壁纸库的某个子目录）。
  // 注意 setConfig 对 monitors 是**深合并**，传 {} 清不掉；只能逐台把 folder 指到测试素材。
  /**
   * 把每台显示器的目录覆盖指向测试素材。
   * 统一模式下列表只有一个频道、monitorId 为 null，拿不到设备路径 → 返回 0，属正常。
   * 必须在 perMonitor:true 之后（此时列表里才有带 monitorId 的频道）再调一次。
   */
  async function maskMonitorFolders() {
    return ev(`(async () => {
      const info = await window.wp.listChannels();
      const patch = {};
      for (const ch of (info.channels || [])) {
        if (ch.monitorId) patch[ch.monitorId] = { folder: ${JSON.stringify(DEMO)} };
      }
      if (Object.keys(patch).length) await window.wp.setConfig({ monitors: patch });
      return Object.keys(patch).length;
    })()`);
  }

  console.log(`  统一模式：覆盖脱敏 ${await maskMonitorFolders()} 台`);

  await ev('window.wp.rebuildChannels(true)');
  await sleep(2800);

  /* ---- 1. 胶片条：先走过几张，做出「已播放 / 当前 / 未播放」三种状态 ---- */
  for (const i of [1, 2, 3, 6, 7]) {
    await ev(`document.querySelector('#film-track .film-item[data-index="${i}"]').click()`);
    await sleep(300);
  }
  await ev(`document.querySelector('#film-track .film-item[data-index="4"]').click()`);
  await sleep(1400);

  const filmState = await ev(`(() => {
    const items = [...document.querySelectorAll('#film-track .film-item')];
    const imgs = items.map((e) => e.querySelector('img')).filter(Boolean);
    const bar = document.querySelector('#filmstrip');
    const r = bar.getBoundingClientRect();
    return {
      items: items.length,
      decoded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      stripSize: Math.round(r.width) + 'x' + Math.round(r.height),
      box: Math.round(items[0].getBoundingClientRect().width) + 'x' + Math.round(items[0].getBoundingClientRect().height),
    };
  })()`);
  const filmOk = filmState.decoded > 0;
  console.log(`  胶片条 DOM：${filmState.items} 节点 / ${filmState.decoded} 张已解码  区域 ${filmState.stripSize}  单项 ${filmState.box}`);
  if (!filmOk) throw new Error(`胶片条一张都没解码（${JSON.stringify(filmState)}）—— 截出来必然是空条`);

  console.log('截图：');
  await shot('界面-胶片条.png', '#filmstrip', 8);

  /* ---- 2. 主界面：整窗（hero） ---- */
  await ev(`document.querySelector('#film-track .film-item[data-index="9"]').click()`);
  await sleep(1500);
  await shot('界面-主界面.png', null);

  /* ---- 3. 图片信息：切到带 EXIF 的那张再打开 ---- */
  await ev(`(() => {
    const el = [...document.querySelectorAll('#film-track .film-item')]
      .find((e) => (e.title || '').includes('EOS R6'));
    if (!el) throw new Error('胶片条里找不到带 EXIF 的样张');
    el.click();
  })()`);
  await sleep(1500);
  await ev(`document.querySelector('#btn-info').click()`);
  await sleep(1700);
  await shot('界面-图片信息.png', '#info', 0);
  await ev(`document.querySelector('#btn-info-close') && document.querySelector('#btn-info-close').click()`);
  await sleep(500);

  /* ---- 4. 设置面板：每屏独立卡片 ---- */
  await ev('window.wp.setConfig(' + JSON.stringify({ perMonitor: true }) + ')');
  await ev('window.wp.rebuildChannels(true)');
  await sleep(1800);
  console.log(`  每屏独立：覆盖脱敏 ${await maskMonitorFolders()} 台`);
  await ev('window.wp.rebuildChannels(true)');
  await sleep(2400);
  await ev(`document.querySelector('#btn-settings').click()`);
  await sleep(900);
  await ev(`(async () => {
    const el = document.querySelector('#monitor-cards');
    if (el) el.scrollIntoView({ block: 'start' });
  })()`);
  await sleep(700);
  await shot('界面-每屏独立.png', '#settings', 0);

  /* ---- 5. 顶栏与操作目标：预览徽标 ---- */
  await ev(`document.querySelector('#btn-settings-close').click()`);
  await sleep(700);
  const badge = await ev(`(() => {
    const el = document.querySelector('#preview-badge');
    return el ? (el.textContent || '').trim() : null;
  })()`);
  console.log(`  顶栏预览徽标：${JSON.stringify(badge)}`);

  // 交付物脱敏自检：顶栏路径必须是测试素材，否则说明每屏覆盖没清干净。
  const folderText = await ev(`(document.querySelector('#folder-label') || {}).textContent || ''`);
  console.log(`  顶栏目录文本：${JSON.stringify(folderText)}`);
  if (!/demo/i.test(String(folderText))) {
    throw new Error(`顶栏目录不是测试素材（${folderText}）—— 每屏覆盖没清干净，截图会泄露真实路径`);
  }

  await shot('界面-顶栏与操作目标.png', '#topbar', 8);

  /* ---- 6. 删除选项 + 全局热键：绑上几个键，看清绑定态 ---- */
  await ev(`document.querySelector('#btn-settings').click()`);
  await sleep(900);
  await ev(`window.wp.setHotkeys({ cycleMonitor: 'Ctrl+Down', next: 'Ctrl+Right', prev: 'Ctrl+Left', delete: 'Ctrl+0', info: 'Ctrl+I' })`);
  await ev(`window.__reloadConfig && window.__reloadConfig()`);
  await sleep(900);
  await ev(`(async () => {
    const fields = [...document.querySelectorAll('#settings .field')];
    const target = fields.find((f) => /^删除$/.test((f.querySelector('.field-label')?.textContent || '').trim()));
    if (target) target.scrollIntoView({ block: 'start' });
  })()`);
  await sleep(800);
  await shot('界面-删除与热键.png', '#settings', 0);

  await ev(`document.querySelector('#btn-settings-close') && document.querySelector('#btn-settings-close').click()`);

  // 热键要还原成**截图前的原值**，不能写死全空 ——
  // 写死全空等于把用户自己绑的那套抹掉（19:29 那轮就是这么干的）。
  const snapshot = path.join(__dirname, 'tmp', 'config-backup-readme.json');
  if (fs.existsSync(snapshot)) {
    const orig = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
    await ev(`window.wp.setHotkeys(${JSON.stringify(orig.hotkeys)})`);
    console.log('  热键已还原成截图前的原值：', JSON.stringify(orig.hotkeys));
  } else {
    await ev(`window.wp.setHotkeys({ cycleMonitor: '', next: '', prev: '', playPause: '', delete: '', toggleWindow: '', info: '' })`);
    console.log('  ⚠ 没有截图前快照，热键已清空（请人工核对）');
  }
  await sleep(400);

  /* ---- 自检：小图 / 疑似纯色图筛一遍 ---- */
  console.log('');
  console.log('自检：');
  let bad = 0;
  for (const r of results) {
    const problems = [];
    if (r.pxPerByte > 400) problems.push(`疑似纯色块（${r.pxPerByte} px/byte）`);
    if (r.bytes < 3000) problems.push(`体积过小（${(r.bytes / 1024).toFixed(1)} KB）`);
    if (r.w < 200 || r.h < 40) problems.push(`尺寸过小（${r.w}×${r.h}）`);
    if (problems.length) { bad += 1; console.log(`  ✗ ${r.name}  ${problems.join('；')}`); }
    else console.log(`  ✓ ${r.name}`);
  }

  cdp.close();
  console.log('');
  console.log(`截图目录：${OUT_DIR}`);
  console.log(bad ? `有 ${bad} 张需要复核` : '全部通过');
  console.log('');
  console.log('注意：配置现在处于测试态，必须按文件头部的「安全约定」整文件还原。');
  process.exit(bad ? 2 : 0);
})().catch((err) => {
  console.error('截图失败：', err.message);
  console.error('提示：配置可能停在测试态，记得整文件还原（tools/tmp/config-backup-readme.json）。');
  process.exit(1);
});
