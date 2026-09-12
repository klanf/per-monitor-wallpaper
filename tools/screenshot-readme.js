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
 *   脚本会自己把真实配置留档到 tools/tmp/config-backup-readme.json，
 *   正常结束、抛错、Ctrl+C 三条路径都会整文件还原回去。
 *   但**应用内存里仍是测试态**，所以跑完必须退出现有实例、重启应用。
 *   为什么还原用整文件覆盖而不是 setConfig：store 读取时对默认值做**深合并**，
 *   perMonitor 模式下自动写入的 monitors 覆盖项不一定能被一次 setConfig 清掉。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CDP_LIST = 'http://127.0.0.1:9222/json';
const FIXTURES = path.resolve(__dirname, 'fixtures');

/**
 * 演示图库必须放在**项目外**。
 *
 * 早先放在 tools/tmp/demo，结果「图片信息」面板把项目的完整绝对路径
 * （含项目所在位置与会话编号）直接截进了交付物 —— 公开仓库里不能出现这种东西。
 * 换成一个中性的图库路径，截图上看就是用户自己的某个图片文件夹。
 * 要改位置用环境变量 WP_SHOT_DEMO 覆盖。
 */
const DEMO = process.env.WP_SHOT_DEMO || path.resolve('D:/壁纸/demo');

const OUT_DIR = path.resolve(__dirname, '..', 'docs');
const TMP_DIR = path.resolve(__dirname, 'tmp');
const SNAPSHOT = path.join(TMP_DIR, 'config-backup-readme.json');

/**
 * 应用真实配置：%APPDATA%\electron-wallpaper\config.json（与应用名绑定，别改）。
 *
 * 不要直接用 `process.env.APPDATA` —— 实测在本机沙箱化的 bash 里这个变量**不存在**
 * （只有 `USERPROFILE`/`HOMEDRIVE`/`HOMEPATH`），会让留档与还原**静默失效**。
 * 用 `os.homedir()` 兜底，路径完全一致。
 */
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const CONFIG_FILE = path.join(ROAMING, 'electron-wallpaper', 'config.json');

/** 整文件覆盖还原。对付 store 的深合并语义，也兜住「内存态没救回来」的情况。 */
function restoreConfigFile() {
  if (!CONFIG_FILE || !fs.existsSync(SNAPSHOT)) return false;
  fs.copyFileSync(SNAPSHOT, CONFIG_FILE);
  return true;
}

/**
 * 交付物脱敏黑名单：这些串一旦出现在界面上，截图就不能用。
 *
 * **不要在源码里写死自己的真实路径。** 这份黑名单本身也会进公开仓库，
 * 把真实目录写进去等于换个地方再泄露一次。改成运行时拼出来：
 *   1. 用户主目录与项目绝对路径 —— 通用，不需要任何配置；
 *   2. **截图前的真实配置**里出现过的目录（壁纸库、每屏覆盖、快捷文件夹）——
 *      这才是真正要拦的内容，从快照现取，一处不漏；
 *   3. 环境变量 `WP_LEAK_NEEDLES`（逗号分隔）—— 补充自定义的串。
 */
const LEAK_NEEDLES = [
  os.homedir(),
  path.resolve(__dirname, '..'),
  ...String(process.env.WP_LEAK_NEEDLES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
];

/** 把真实配置里用户自己的目录补进黑名单（快照是切测试态**之前**取的）。 */
function addNeedlesFromConfig(cfg) {
  const dirs = [cfg && cfg.folder];
  for (const m of Object.values((cfg && cfg.monitors) || {})) {
    if (m && m.folder) dirs.push(m.folder);
  }
  for (const q of (cfg && cfg.quickFolders) || []) {
    if (q && q.path) dirs.push(q.path);
  }
  for (const d of dirs) {
    if (typeof d === 'string' && d.trim() && !LEAK_NEEDLES.includes(d)) LEAK_NEEDLES.push(d);
  }
  return LEAK_NEEDLES;
}

/**
 * 自查开关：`node tools/screenshot-readme.js --needles`
 * 只打印推导出来的黑名单就退出 —— 不连应用、不改配置，方便确认拦得住哪些串。
 */
if (process.argv.includes('--needles')) {
  if (fs.existsSync(CONFIG_FILE)) {
    addNeedlesFromConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } else {
    console.log(`⚠ 找不到 ${CONFIG_FILE} —— 只给出通用项，无法从配置补充`);
  }
  console.log('脱敏黑名单：');
  for (const n of LEAK_NEEDLES) console.log(`  - ${n}`);
  console.log(`共 ${LEAK_NEEDLES.length} 条；未做任何改动，直接退出。`);
  process.exit(0);
}

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
  fs.mkdirSync(TMP_DIR, { recursive: true });
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

  /**
   * 截图前的脱敏闸门：扫一遍 DOM 的**全部文本**（含隐藏元素）、输入框值与 title 属性，
   * 命中真实路径就直接抛错，绝不让带本机信息的图落进 docs/。
   *
   * 为什么用 textContent 而不是 innerText：innerText 只返回**可见**文本，
   * 滚动区域外或被折叠的内容都不算 —— 而截图恰恰可能把折叠内容截进去。
   */
  async function assertNoLeak(stage) {
    const hits = await ev(`(() => {
      const needles = ${JSON.stringify(LEAK_NEEDLES)};
      const found = [];
      const seen = new Set();
      const tagOf = (el) => {
        let cls = '';
        if (typeof el.className === 'string' && el.className.trim()) {
          cls = '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
        }
        return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls;
      };
      for (const el of document.querySelectorAll('*')) {
        const places = [['', [el.value]]];
        const title = el.getAttribute && el.getAttribute('title');
        if (title) places.push(['[title]', [title]]);
        const own = [];
        for (const c of el.childNodes) if (c.nodeType === 3) own.push(c.nodeValue);
        if (own.length) places.push(['', own]);
        for (const [kind, texts] of places) {
          for (const t of texts) {
            if (!t) continue;
            for (const n of needles) {
              if (t.indexOf(n) >= 0) {
                const key = tagOf(el) + kind + n;
                if (!seen.has(key)) { seen.add(key); found.push(n + '  ←  ' + tagOf(el) + kind); }
              }
            }
          }
        }
      }
      return found.slice(0, 15);
    })()`);
    if (hits && hits.length) {
      throw new Error(`[${stage}] 界面里还有本机真实信息：\n      ` + hits.join('\n      '));
    }
  }

  /** 截一张。selector 为空则截整个视口；pad 是四周留白（CSS px）。 */
  async function shot(name, selector, pad = 0) {
    await wake();
    // 自启命令、快捷文件夹、缩略图目录都是「面板一渲染就用真实配置重填」的，光 setConfig 不会刷新 DOM。
    // 所以放在这里：每次截图前都先抹一遍，紧接着自检，中间不留重渲染的窗口。
    await maskSettingsPanel();
    await maskInfoPanel();
    await assertNoLeak(name);
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

  /**
   * 写测试配置**之前**先留档。
   *
   * 这步以前靠调用方在 shell 里手动 cp，结果 20:40 那轮脚本被中断，
   * 配置就停在测试态（folder=D:\壁纸\demo、6 个热键全空）没人管。
   * 脚本自己留档，谁调用都不会漏。
   */
  if (fs.existsSync(CONFIG_FILE)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.copyFileSync(CONFIG_FILE, SNAPSHOT);
    console.log(`真实配置已留档：${SNAPSHOT}`);
    // 黑名单在第 1 步基础上，再补上真实配置里出现过的目录
    addNeedlesFromConfig(JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')));
  } else {
    console.log(`⚠ 找不到 ${CONFIG_FILE} —— 无法留档，中断后需人工核对配置`);
  }

  // Ctrl+C / 被 kill 时也要还原，否则配置留在测试态、应用重启后接着用测试图库。
  const onAbort = () => {
    const ok = restoreConfigFile();
    console.error(ok
      ? '已中止：配置整文件还原完成，请重启应用让它重新读取。'
      : '已中止：没有可用快照，配置可能停在测试态，请人工核对。');
    process.exit(130);
  };
  process.on('SIGINT', onAbort);
  process.on('SIGTERM', onAbort);

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
    // 快捷文件夹会原样渲染出用户的真实目录（早先就是这么把私人收藏目录截进去的），先清空
    quickFolders: [],
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

  /**
   * 设置面板里有两处会直接暴露本机信息，截图前必须抹掉：
   *   1. `#login-hint` —— 显示开机自启的完整命令，内含 process.execPath（真实 exe 路径）
   *   2. `#quick-list` —— 快捷文件夹列表，渲染的是用户真实目录
   *   3. `#thumb-dir` —— 缩略图缓存目录，默认值是用户主目录下的真实路径
   * 面板每次打开时 app.js 都会重新填充，所以每开一次就要抹一次。
   */
  async function maskSettingsPanel() {
    const fake = '自启命令：C:\\Users\\<用户名>\\AppData\\Local\\Programs\\壁纸切换器\\壁纸切换器.exe --hidden';
    const fakeTip = '每块屏的壁纸写入通道状态';
    const fakeThumb = 'C:\\Users\\<用户名>\\AppData\\Roaming\\壁纸切换器\\thumbs';
    return ev(`(() => {
      const hint = document.querySelector('#login-hint');
      if (hint) hint.textContent = ${JSON.stringify(fake)};
      const list = document.querySelector('#quick-list');
      if (list) list.innerHTML = '';
      const thumb = document.querySelector('#thumb-dir');
      if (thumb) thumb.textContent = ${JSON.stringify(fakeThumb)};
      // 顶栏徽标的 title 里塞着完整诊断串（配置路径 + 壁纸库目录），截图用不上，换成一句无害的
      const badge = document.querySelector('#backend-badge');
      if (badge) badge.setAttribute('title', ${JSON.stringify(fakeTip)});
      return { hint: !!hint, quick: list ? list.children.length : -1, thumb: !!thumb, badge: !!badge };
    })()`);
  }

  /**
   * 「图片信息」面板的脱敏。
   *
   * 为什么光靠重渲染不够：面板**关着**的时候里面的 DOM 还留着上一次的内容，
   * 而 assertNoLeak 扫的是 textContent（含隐藏元素，故意的 —— 截图可能把折叠内容也截进去）。
   * 应用启动时按真实配置渲染过一次，于是顶栏图名、所在文件夹、完整路径
   * 全是真实壁纸库路径，面板关着永远等不到重渲染。
   * 所以这里按黑名单把这些字段里的真实串**就地替换**成演示图库路径。
   *
   * 面板开着时（截「图片信息」那张）内容本来就是演示素材，替换是空操作，不会失真。
   */
  async function maskInfoPanel() {
    return ev(`(() => {
      const needles = ${JSON.stringify(LEAK_NEEDLES)}.slice().sort((a, b) => b.length - a.length);
      const demo = ${JSON.stringify(DEMO)};
      const scrub = (s) => {
        let out = String(s == null ? '' : s);
        for (const n of needles) out = out.split(n).join(demo);
        return out;
      };
      let touched = 0;
      const hit = (el, attr) => {
        const raw = attr ? el.getAttribute(attr) : el.textContent;
        const fixed = scrub(raw);
        if (fixed === raw) return;
        if (attr) el.setAttribute(attr, fixed); else el.textContent = fixed;
        touched += 1;
      };
      const name = document.querySelector('#info-name');
      if (name) { hit(name, null); hit(name, 'title'); }
      for (const el of document.querySelectorAll('#info .ig-value, #info .ig-label')) {
        hit(el, null); hit(el, 'title');
      }
      return touched;
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
  console.log('  ', JSON.stringify(await maskSettingsPanel()));
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
  console.log('  ', JSON.stringify(await maskSettingsPanel()));
  await shot('界面-删除与热键.png', '#settings', 0);

  await ev(`document.querySelector('#btn-settings-close') && document.querySelector('#btn-settings-close').click()`);

  // 热键要还原成**截图前的原值**，不能写死全空 ——
  // 写死全空等于把用户自己绑的那套抹掉（19:29 那轮就是这么干的）。
  // 没有快照就**什么都不写**：留空总好过把原值覆盖掉。
  if (fs.existsSync(SNAPSHOT)) {
    const orig = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    await ev(`window.wp.setHotkeys(${JSON.stringify(orig.hotkeys)})`);
    console.log('  热键已还原成截图前的原值：', JSON.stringify(orig.hotkeys));
  } else {
    console.log('  ⚠ 没有截图前快照，热键未还原（不做清空，避免覆盖掉原值）');
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
  // 内存态已在上面 setHotkeys 还原，这里补磁盘态。
  // 应用还开着、内存里仍是测试态，所以必须**重启应用**才算彻底干净。
  console.log(restoreConfigFile()
    ? `配置已整文件还原：${SNAPSHOT}\n  → ${CONFIG_FILE}\n  请退出现有实例并重启应用，让它重新读取。`
    : '⚠ 没有可用快照，配置可能停在测试态，请人工核对。');
  process.exit(bad ? 2 : 0);
})().catch((err) => {
  console.error('截图失败：', err.message);
  console.error(restoreConfigFile()
    ? '配置已整文件还原；应用重启后即恢复原状。'
    : '⚠ 没有可用快照，配置可能停在测试态，请人工核对。');
  process.exit(1);
});
