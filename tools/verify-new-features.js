'use strict';

/**
 * 本轮四个新功能的端到端验证：胶片条 / 托盘 / EXIF 信息面板 / 右键菜单文件操作。
 *
 * 原则和前一份 verify-per-monitor.js 一致：不看应用「说自己做了什么」，
 * 只看两件事 —— 渲染进程 DOM 的真实状态，以及操作系统侧壁纸的真实变化。
 * 文件操作还额外核对磁盘上的真实存在性（移走了就真没了、删了就从轮转里摘掉）。
 *
 * 用法：
 *   1) 应用以 --remote-debugging-port=9222 启动；
 *   2) node tools/verify-new-features.js
 *
 * 脚本会把当前配置临时改成 tools/tmp/verify/src（11 张测试图），
 * 跑完自动还原成跑之前的配置。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const desktopWallpaper = require('../src/desktopWallpaper');
const clipboardReader = require('./clipboardReader');
const testConfig = require('./testConfig');
const registryReader = require('./registryReader');
const recycleBin = require('./recycleBin');

const CDP_LIST = 'http://127.0.0.1:9222/json';
const FIXTURES = path.resolve(__dirname, 'fixtures');
const TMP = path.resolve(__dirname, 'tmp', 'verify');
const SRC = path.join(TMP, 'src');
const DEST = path.join(TMP, 'dest');
const EXIF_JPEG = path.join(FIXTURES, 'exif-camera.jpg');
const IMAGE_COUNT = 11;

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else {
    fail += 1;
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n===== ${title} =====`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ CDP */

async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(CDP_LIST)).json();
      const page = targets.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page && page.webSocketDebuggerUrl) return page;
      last = `目标 ${targets.length} 个，未匹配 index.html`;
    } catch (e) { last = e.message; }
    await sleep(400);
  }
  throw new Error(`等待渲染进程超时：${last}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const listeners = [];
    let seq = 0;

    ws.addEventListener('open', () => resolve({
      call(method, params) {
        return new Promise((res) => {
          const id = ++seq;
          pending.set(id, res);
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      on(handler) { listeners.push(handler); },
      close: () => ws.close(),
    }));

    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      else if (msg.method) listeners.forEach((fn) => fn(msg));
    });
  });
}

/* ------------------------------------------------------------ 素材 */

function buildScratch() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(SRC, { recursive: true });
  fs.mkdirSync(DEST, { recursive: true });
  const gallery = fs.readdirSync(path.join(FIXTURES, 'gallery')).sort();
  if (gallery.length < IMAGE_COUNT - 1) throw new Error('fixtures/gallery 图片不足');

  for (let i = 0; i < IMAGE_COUNT - 1; i += 1) {
    const target = path.join(SRC, `t-${String(i + 1).padStart(2, '0')}.png`);
    fs.copyFileSync(path.join(FIXTURES, 'gallery', gallery[i]), target);
  }
  // 最后一张用带完整 EXIF 的 JPEG，顺便验证非 PNG 的缩略图与信息读取
  fs.copyFileSync(EXIF_JPEG, path.join(SRC, `t-${String(IMAGE_COUNT).padStart(2, '0')}.jpg`));
}

/* ------------------------------------------------------------ 主流程 */

(async () => {
  buildScratch();

  const page = await waitForPage();
  const cdp = await connect(page.webSocketDebuggerUrl);

  // 崩溃监听必须挂上，才能证明「重载之后不再有未捕获异常」
  const crashes = [];
  const consoleErrors = [];
  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      crashes.push(d.exception?.description?.split('\n')[0] || d.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push((msg.params.args || []).map((a) => a.value || a.description).join(' '));
    }
  });

  await cdp.call('Runtime.enable', {});
  await cdp.call('Page.enable', {});

  async function ev(expression) {
    const out = await cdp.call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    const details = out.result?.exceptionDetails;
    if (details) {
      throw new Error(details.exception?.description?.split('\n')[0] || details.text || '未知异常');
    }
    return out.result?.result?.value;
  }

  // 上一轮跑挂在半路时留下的预设文件夹会污染判定，先清干净
  for (const f of (await ev('window.wp.listQuickFolders()')) || []) {
    await ev(`window.wp.removeQuickFolder(${JSON.stringify(f.id)})`);
  }
  await ev('window.wp.setConfig(' + JSON.stringify({ quickFolders: [] }) + ')');
  await sleep(300);
  check('测试开始前预设文件夹已清空', ((await ev('window.wp.listQuickFolders()')) || []).length === 0);

  // cfg 必须在这之后抓，否则会把上一轮残留的预设文件夹当成「用户原始配置」再写回去
  // 基线快照：第一次跑留一份，之后不覆盖 —— 中途崩了下一轮也能还原到用户真配置
  const base = testConfig.begin();
  const cfg = base.baseline;
  const baselineWarn = testConfig.describeBaseline(base);
  if (baselineWarn) console.log(baselineWarn);
  if (testConfig.looksLikeTestData(cfg.folder)) console.log(`⚠ 基线快照本身指向测试目录：${cfg.folder}`);

  /* -------------------------------------------------- 0. 重载无异常 */

  section('0. 重载后无未捕获异常（两个崩溃 bug 的回归测试）');
  await ev('window.wp.setConfig(' + JSON.stringify({
    folder: SRC, recursive: false, perMonitor: false, monitor: 'primary',
    interval: 900, shuffle: false, autoPlay: false, applyToSystem: true,
    filmstrip: true, infoPanel: true, contextMenu: true,
  }) + ')');
  // 目录虽然没变，但磁盘上的文件被 buildScratch 换过一遍，必须丢掉扫描缓存
  await ev('window.wp.rebuildChannels(true)');

  // 等频道建好
  for (let i = 0; i < 40; i += 1) {
    const r = await ev('window.wp.listChannels()');
    if ((r.channels || []).some((c) => c.count === IMAGE_COUNT)) break;
    await sleep(250);
  }

  crashes.length = 0;
  consoleErrors.length = 0;
  await cdp.call('Page.reload', { ignoreCache: true });
  await sleep(3500);
  for (let i = 0; i < 40; i += 1) {
    try {
      const s = await ev('window.__rendererState ? window.__rendererState() : null');
      if (s && s.count === IMAGE_COUNT) break;
    } catch { /* 重载期间上下文可能短暂不可用 */ }
    await sleep(250);
  }

  check('重载后渲染层无未捕获异常', crashes.length === 0, crashes.slice(0, 3).join(' | '));
  check('重载后控制台无 error 输出', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  const state0 = await ev('window.__rendererState()');
  check('频道已加载全部测试图', state0.count === IMAGE_COUNT, `count=${state0.count}`);

  /* -------------------------------------------------- 1. 胶片条 */

  section('1. 胶片条缩略图导航');

  const film = await ev(`(() => {
    const items = [...document.querySelectorAll('#film-track .film-item')];
    return {
      total: items.length,
      withDataIndex: items.filter((e) => e.dataset.index !== undefined).length,
      thumbSrcs: items.filter((e) => (e.querySelector('img') || {}).src || '').map((e) => e.querySelector('img').src),
      current: items.filter((e) => e.classList.contains('current')).map((e) => Number(e.dataset.index)),
      played: items.filter((e) => e.classList.contains('played')).map((e) => Number(e.dataset.index)),
      future: items.filter((e) => e.classList.contains('future')).map((e) => Number(e.dataset.index)),
    };
  })()`);

  check('胶片条渲染出缩略图节点', film.total > 0, `${film.total} 个（窗口化渲染，不必等于 ${IMAGE_COUNT}）`);
  check('每个节点都带序号', film.withDataIndex === film.total);
  check('缩略图走 wpthumb:// 自定义协议',
    film.thumbSrcs.every((s) => s.startsWith('wpthumb://')),
    film.thumbSrcs[0] ? film.thumbSrcs[0].slice(0, 46) + '…' : '(无)');
  check('当前帧唯一且被标记', film.current.length === 1, `current=[${film.current}]`);
  check('未来帧被标记为 future', film.future.length > 0, `${film.future.length} 个`);
  check('本次会话未播放的不会误标为 played', film.played.length + film.current.length <= film.total);

  // 真实解码：wpthumb:// 是不是真能拿到像素，光看 src 说明不了问题
  await sleep(2500);
  const decoded = await ev(`(() => {
    const imgs = [...document.querySelectorAll('#film-track .film-item img')];
    return {
      total: imgs.length,
      ok: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      broken: imgs.filter((i) => i.classList.contains('broken')).length,
      sizes: imgs.slice(0, 3).map((i) => i.naturalWidth + 'x' + i.naturalHeight),
    };
  })()`);
  check('缩略图真实解码成功（naturalWidth > 0）',
    decoded.ok === decoded.total && decoded.total > 0,
    `${decoded.ok}/${decoded.total}  样本 ${decoded.sizes.join(' ')}`);
  check('没有破图占位', decoded.broken === 0);

  const thumbStats = await ev('window.wp.thumbStats()');
  check('缩略图缓存已落盘', (thumbStats.files || 0) > 0,
    `文件 ${thumbStats.files} 个 / ${thumbStats.mb} MB  命中 ${thumbStats.hits} 次  未命中 ${thumbStats.misses} 次`);

  // 点击第 4 个可见节点 → 调度器应跳过去，且系统壁纸跟着变
  section('2. 点击胶片条 → 真的换壁纸（应用 + 操作系统双向确认）');
  const beforeClick = await ev('window.__rendererState()');
  // 挑一个**和当前不同**的目标：渲染层对「点当前那一格」是直接忽略的（index === state.index 就 return），
  // 硬编码 4 会在恰好停在第 4 张时静默失效 —— 第一版就是这么挂的，现象是 ticks=0、桌面没动。
  const targetIndex = (beforeClick.index + 3) % IMAGE_COUNT;
  const targetName = path.basename((await ev(`window.wp.channelFiles(${JSON.stringify(state0.previewId)}).then(r => r.files[${targetIndex}].path)`)));
  const osBefore = osMonitors();

  await ev(`document.querySelector('#film-track .film-item[data-index="${targetIndex}"]').click()`);
  await sleep(1500);

  const afterClick = await ev('window.__rendererState()');

  // Windows 的每屏壁纸是**异步落盘**的，写入后立刻回读可能拿到旧值 —— 轮询到期望值为止
  let osNow = null;
  for (let i = 0; i < 12; i += 1) {
    const snap = osMonitors();
    osNow = snap.find((m) => m.isPrimary) || snap[0];
    if (path.basename(osNow.current || '') === targetName) break;
    await sleep(350);
  }

  check('渲染层索引跳到目标', afterClick.index === targetIndex, `${beforeClick.index} → ${afterClick.index}`);
  check('渲染层当前文件名正确', afterClick.currentName === targetName, `${afterClick.currentName} vs ${targetName}`);
  const chMain = (await ev('window.wp.listChannels()')).channels.find((c) => c.id === state0.previewId);
  check('操作系统桌面壁纸换成了同一张',
    path.basename(osNow.current || '') === targetName,
    `${path.basename(osBefore.find((m) => m.isPrimary)?.current || '')} → ${path.basename(osNow.current || '')}`
      + `（期望 ${targetName}；previewId=${state0.previewId} chMain=${chMain ? chMain.id : '(找不到)'}`
      + ` ticks=${chMain && chMain.ticks} writes=${chMain && chMain.writes}`
      + ` lastWrite=${JSON.stringify(chMain && chMain.lastWrite)}）`);
  check('胶片条 current 标记跟着移动',
    (await ev(`[...document.querySelectorAll('#film-track .film-item.current')].map(e => Number(e.dataset.index))`))[0] === targetIndex);
  check('该序号被记入 played（供标记区分）',
    (await ev('window.__rendererState()')).played.includes(targetIndex),
    `played=[${(await ev('window.__rendererState()')).played}]`);

  // 控制行的上一张 / 下一张（真正切图的那对按钮）
  await ev(`document.querySelector('#btn-next').click()`);
  await sleep(1200);
  check('「下一张」切到后一张', (await ev('window.__rendererState()')).index === targetIndex + 1,
    `index=${(await ev('window.__rendererState()')).index}`);
  await ev(`document.querySelector('#btn-prev').click()`);
  await sleep(1200);
  check('「上一张」切回前一张', (await ev('window.__rendererState()')).index === targetIndex);

  // 胶片条两侧的翻屏按钮：只滚动胶片条，不能改当前图
  const scrollBefore = await ev('window.__rendererState()');
  await ev(`document.querySelector('#film-next').click()`);
  await sleep(900);
  const scrollAfter = await ev(`({ st: window.__rendererState(), scroll: document.querySelector('#film-track').scrollLeft })`);
  check('胶片条「翻一屏」只滚动不切图',
    scrollAfter.st.index === scrollBefore.index && scrollAfter.scroll >= scrollBefore.filmstrip.scrollLeft,
    `scrollLeft ${scrollBefore.filmstrip.scrollLeft} → ${scrollAfter.scroll}，index 保持 ${scrollAfter.st.index}`);
  await ev(`document.querySelector('#film-jump').click()`);
  await sleep(700);
  check('「回到当前」把窗口拉回当前帧',
    (await ev('window.__rendererState()')).filmstrip.currentInDom === true);

  /* -------------------------------------------------- 3. EXIF 面板 */

  section('3. EXIF 完整信息面板');

  const info = await ev(`window.wp.imageInfo(${JSON.stringify(EXIF_JPEG)})`);
  check('主进程读到了图片信息', info && info.ok === true, info && info.error);
  check('识别出存在 EXIF', info && info.hasExif === true);
  check('分组数量足够（文件/图像/拍摄/位置/来源…）',
    (info.groups || []).length >= 4, `${(info.groups || []).length} 组`);
  const allRows = (info.groups || []).flatMap((g) => g.rows || []);
  const byLabel = (n) => allRows.find((r) => r.label === n);
  check('解析出相机型号', Boolean(byLabel('相机型号') || byLabel('型号')),
    (byLabel('相机型号') || byLabel('型号') || {}).value || '(缺失)');
  check('解析出拍摄时间', Boolean(byLabel('拍摄时间')), (byLabel('拍摄时间') || {}).value || '(缺失)');
  check('解析出曝光参数', Boolean(byLabel('光圈') || byLabel('快门') || byLabel('曝光时间')),
    [byLabel('光圈'), byLabel('快门'), byLabel('曝光时间'), byLabel('ISO')]
      .filter(Boolean).map((r) => `${r.label}=${r.value}`).join(' '));
  check('解析出 GPS 坐标', Boolean(info.gps),
    info.gps ? `${info.gps.lat}, ${info.gps.lon}` : '(无)');
  check('没有残留裸数字枚举值',
    !allRows.some((r) => /^(ColorSpace|GPSAltitudeRef|ResolutionUnit)\b/.test(r.label) && /^\d$/.test(String(r.value))),
    allRows.filter((r) => ['色彩空间', '海拔参考', '分辨率单位'].includes(r.label))
      .map((r) => `${r.label}=${r.value}`).join(' '));

  // UI 侧
  await ev(`document.querySelector('#btn-info').click()`);
  await sleep(1200);
  const panel = await ev(`(() => {
    const el = document.querySelector('#info');
    return {
      open: el.classList.contains('open'),
      hidden: el.getAttribute('aria-hidden'),
      groups: el.querySelectorAll('.ig').length,
      rows: el.querySelectorAll('.ig-row').length,
      name: (document.querySelector('#info-name') || {}).textContent,
      thumb: (document.querySelector('#info-thumb') || {}).src || '',
    };
  })()`);
  check('信息面板打开', panel.open === true && panel.hidden === 'false');
  check('面板渲染出分组与字段', panel.groups >= 2 && panel.rows >= 6,
    `${panel.groups} 组 / ${panel.rows} 行（当前预览的是 PNG，没有拍摄参数）`);
  check('面板标题为当前图名', panel.name === (await ev('window.__rendererState()')).currentName, panel.name);
  check('面板缩略图走 wpthumb://', panel.thumb.startsWith('wpthumb://'));
  await ev(`document.querySelector('#btn-info').click()`);
  await sleep(400);
  check('再点一次可关闭面板', (await ev(`document.querySelector('#info').classList.contains('open')`)) === false);

  /* -------------------------------------------------- 4. 文件操作 */

  section('4. 右键菜单背后的文件操作（磁盘 + 轮转双重复核）');

  const chId = (await ev('window.__rendererState()')).previewId;
  const filesNow = await ev(`window.wp.channelFiles(${JSON.stringify(chId)}).then(r => r.files.map(f => f.path))`);

  const probe = await ev(`window.wp.fileStats(${JSON.stringify(filesNow[0])})`);
  check('fileStats 返回真实文件信息',
    probe && probe.ok !== false && (probe.size > 0 || probe.bytes > 0), JSON.stringify(probe).slice(0, 90));

  const copyImg = await ev(`window.wp.copyImage(${JSON.stringify(filesNow[0])})`);
  check('复制图片到剪贴板成功', copyImg && copyImg.ok !== false, JSON.stringify(copyImg).slice(0, 90));
  const clipImg = clipboardReader.inspect();
  check('系统剪贴板里真的出现了位图（CF_DIB / CF_DIBV5）',
    Boolean(clipImg.ids.dib || clipImg.ids.dibv5),
    clipImg.names.join(' | '));

  const copyPath = await ev(`window.wp.copyPath(${JSON.stringify(filesNow[0])})`);
  check('复制路径成功', copyPath && copyPath.ok !== false, JSON.stringify(copyPath).slice(0, 90));
  const clipText = clipboardReader.inspect();
  check('系统剪贴板里真的出现了文本（CF_UNICODETEXT）',
    Boolean(clipText.ids.unicodeText), clipText.names.join(' | '));

  const copyFile = await ev(`window.wp.copyFile(${JSON.stringify(filesNow[0])})`);
  check('复制文件（可粘贴）成功', copyFile && copyFile.ok !== false, JSON.stringify(copyFile).slice(0, 90));
  const clipFile = clipboardReader.inspect();
  check('系统剪贴板里真的出现了标准 CF_HDROP（id 15）',
    clipFile.ids.hdrop === clipboardReader.CF_HDROP,
    clipFile.names.join(' | '));
  check('CF_HDROP 里的路径就是那个文件',
    Array.isArray(clipFile.files) && clipFile.files.some((f) => path.normalize(f) === path.normalize(filesNow[0])),
    (clipFile.files || []).join(' ; '));

  // 不存在的路径：路由接通了就该给出结构化错误，而不是静默
  const ghost = 'Z:\\__not_exist__\\nope.png';
  check('打开不存在的文件返回结构化失败',
    (await ev(`window.wp.openExternally(${JSON.stringify(ghost)})`)).ok === false);
  check('打开不存在文件的所在目录也返回失败',
    (await ev(`window.wp.openContainingFolder(${JSON.stringify(ghost)})`)).ok === false);

  // 预设文件夹
  const added = await ev(`window.wp.addQuickFolder(${JSON.stringify(DEST)}, '验证目标')`);
  check('预设文件夹可添加', added && added.ok === true, added && added.error);
  const qlist = await ev('window.wp.listQuickFolders()');
  check('预设列表已持久化', (qlist || []).some((f) => path.normalize(f.path) === path.normalize(DEST)),
    `共 ${(qlist || []).length} 个`);

  // ---- 右键菜单本身：菜单项是否齐全、是否都接上了动作
  section('4.1 右键菜单结构（不弹菜单，直接核对模板）');
  const menuPayload = { path: filesNow[0], channelId: chId };
  const menu = await ev(`window.wp.imageMenuTemplate(${JSON.stringify(menuPayload)})`);
  const flat = [];
  (function walk(items) {
    (items || []).forEach((it) => { flat.push(it); if (it.submenu) walk(it.submenu); });
  })(menu);
  const labels = flat.map((i) => i.label).filter(Boolean);

  check('菜单取到模板', Array.isArray(menu) && menu.length > 0, `${menu ? menu.length : 0} 项`);
  for (const want of [
    '复制图像到剪贴板', '复制文件到剪贴板',
    '移动到', '复制到',
    '打开所在文件夹', '用其他程序打开',
    '删除到回收站',
  ]) {
    check(`菜单项「${want}」存在`, labels.includes(want));
  }
  // 这一轮把这几项精简掉了（用户要求）
  for (const gone of ['把这张设为壁纸', '图片信息…', '复制文件路径', '用默认程序打开', '选择打开方式…']) {
    check(`菜单项「${gone}」已移除`, !labels.includes(gone));
  }
  check('「用其他程序打开」是子菜单，且里面能选程序', (() => {
    const parent = flat.find((i) => i.label === '用其他程序打开');
    if (!parent || !parent.submenu) return false;
    return parent.submenu.some((s) => s.label === '选择程序…');
  })(), (flat.find((i) => i.label === '用其他程序打开') || {}).submenu
    ?.map((s) => s.label).filter(Boolean).join(' / '));
  check('「在资源管理器中显示」已与「打开所在文件夹」合并（不再重复出现）',
    !labels.includes('在资源管理器中显示'), labels.filter((l) => /文件夹|资源管理器/.test(l)).join(' / '));
  // 置灰的占位项（「还没有添加程序」「还没有预设文件夹」）本来就不该有动作
  const clickable = flat.filter((i) => i.type !== 'separator' && !i.submenu && i.enabled !== false);
  check('所有可点菜单项都接上了动作（去掉分隔符、父级菜单与置灰占位）',
    clickable.every((i) => i.hasClick),
    clickable.filter((i) => !i.hasClick).map((i) => i.label).join(', ') || '全部已接线');
  const moveSub = (menu || []).find((i) => i.label === '移动到');
  check('「移动到」子菜单里挂了预设文件夹',
    Boolean(moveSub && moveSub.submenu && moveSub.submenu.some((i) => /验证目标/.test(i.label || ''))),
    moveSub && moveSub.submenu ? moveSub.submenu.map((i) => i.label).join(' / ') : '(无)');
  /* ---------------------------------------------- 4.2 「用其他程序打开」 */

  section('4.2 「用其他程序打开」的程序列表（沿用旧脚本 open_with 的做法）');
  await ev('window.wp.openWithClear()');
  check('起始时程序列表为空', ((await ev('window.wp.openWithList()')) || []).length === 0);

  // 拿系统里一定存在的 exe 当夹具 —— 只验证记录与路由，不真的启动它
  const fakeExe = 'C:\\Windows\\System32\\notepad.exe';
  const addedProg = await ev(`window.wp.openWithAdd(${JSON.stringify(fakeExe)})`);
  check('添加后列表里有它', Boolean(addedProg.ok) && addedProg.programs.includes(fakeExe),
    JSON.stringify(addedProg.programs));
  check('重复添加不会产生两条',
    (await ev(`window.wp.openWithAdd(${JSON.stringify(fakeExe)})`)).programs.length === 1);
  check('列表落盘（重新读取还在）', ((await ev('window.wp.openWithList()')) || []).length === 1);

  const menu2 = await ev(`window.wp.imageMenuTemplate(${JSON.stringify(menuPayload)})`);
  const subLabels = ((menu2 || []).find((i) => i.label === '用其他程序打开') || {}).submenu
    ?.map((s) => s.label).filter(Boolean) || [];
  check('子菜单里出现了这个程序（显示 exe 名）', subLabels.includes('notepad'),
    subLabels.join(' / '));
  check('有程序时不再显示「还没有添加程序」占位',
    !subLabels.some((l) => l.includes('还没有添加')), subLabels.join(' / '));

  // 两个失败分支各走一次 —— 都该给出结构化错误，而不是静默
  const badProg = await ev(`window.wp.openWithLaunch(${JSON.stringify('Z:\\\\nope\\\\ghost.exe')}, ${JSON.stringify(filesNow[0])})`);
  check('用不存在的程序打开返回结构化失败', badProg.ok === false && Boolean(badProg.error), badProg.error);
  const badImg = await ev(`window.wp.openWithLaunch(${JSON.stringify(fakeExe)}, ${JSON.stringify(ghost)})`);
  check('用不存在的图片打开也返回结构化失败', badImg.ok === false, badImg.error);

  check('移除单个程序',
    (await ev(`window.wp.openWithRemove(${JSON.stringify(fakeExe)})`)).programs.length === 0);
  await ev(`window.wp.openWithAdd(${JSON.stringify(fakeExe)})`);
  check('清空程序列表', (await ev('window.wp.openWithClear()')).programs.length === 0);

  const ghostMenu = await ev(`window.wp.imageMenuTemplate(${JSON.stringify({ path: ghost, channelId: null })})`);
  check('文件不存在时，会改文件的操作全部置灰',
    ghostMenu.filter((i) => ['复制图像到剪贴板', '复制文件到剪贴板', '用默认程序打开', '选择打开方式…', '删除到回收站'].includes(i.label))
      .every((i) => i.enabled === false),
    ghostMenu.filter((i) => i.enabled === false).map((i) => i.label).join(' / '));

  // ---- 移动：非当前帧 → 张数 -1，画面不跳
  section('5. 移动（不碰当前帧）：轮转就地更新、画面不跳');
  const filesList0 = await ev(`window.wp.channelFiles(${JSON.stringify(chId)}).then(r => r.files.map(f => f.path))`);
  const cur0 = await ev('window.__rendererState()');
  const moveIdx = cur0.index === 1 ? 2 : 1;
  const movePath = filesList0[moveIdx];
  console.log(`      移动前 ${filesList0.length} 张：${filesList0.map((p) => path.basename(p)).join(' ')}`);
  console.log(`      当前 index=${cur0.index}(${cur0.currentName})  将被移动 #${moveIdx}(${path.basename(movePath)})`);

  const moved = await ev(`window.wp.transferFile(${JSON.stringify(movePath)}, ${JSON.stringify(DEST)}, 'move')`);
  await sleep(1200);

  const chMoved = (await ev('window.wp.listChannels()')).channels.find((c) => c.id === chId);
  const filesList1 = await ev(`window.wp.channelFiles(${JSON.stringify(chId)}).then(r => r.files.map(f => f.path))`);
  const stateMoved = await ev('window.__rendererState()');
  // 被摘掉的那张在当前帧之前 → 列表前移，索引跟着减 1，指向的还是同一张图
  const expectIdx = cur0.index > moveIdx ? cur0.index - 1 : cur0.index;

  console.log(`      移动后 ${filesList1.length} 张：${filesList1.map((p) => path.basename(p)).join(' ')}`);

  check('移动返回成功', moved && moved.ok === true, moved && moved.error);
  check('源文件已不在原位', !fs.existsSync(movePath));
  check('目标目录里出现了这个文件', fs.existsSync(path.join(DEST, path.basename(movePath))),
    path.basename(movePath));
  check('轮转张数 -1', chMoved.count === IMAGE_COUNT - 1 && filesList1.length === IMAGE_COUNT - 1,
    `期望 ${IMAGE_COUNT - 1}，实际 list=${chMoved.count} / files=${filesList1.length}`);
  check('画面没有被顶到别的图', stateMoved.currentName === cur0.currentName, stateMoved.currentName);
  check('索引随列表位移对齐', chMoved.index === expectIdx, `${cur0.index} → ${chMoved.index}（期望 ${expectIdx}）`);
  check('渲染层张数同步收缩', stateMoved.count === IMAGE_COUNT - 1, `${stateMoved.count}`);
  check('played 里没有越界序号（新进的图不会被误标成看过）',
    stateMoved.played.every((i) => i >= 0 && i < chMoved.count),
    `played=[${stateMoved.played}] count=${chMoved.count}`);
  check('胶片条 current 仍指向同一张图',
    path.basename(await ev(`window.wp.channelFiles(${JSON.stringify(chId)}).then(r => r.files[r.index].path)`))
      === cur0.currentName);

  // ---- 删除：非当前帧
  section('6. 删除到回收站（不碰当前帧）');
  const filesNow2 = await ev(`window.wp.channelFiles(${JSON.stringify(chId)}).then(r => r.files.map(f => f.path))`);
  const cur1 = await ev('window.__rendererState()');
  const delIdx = cur1.index + 2 < filesNow2.length ? cur1.index + 2 : cur1.index - 1;
  const delPath = filesNow2[delIdx];
  const rbBefore = recycleBin.query(recycleBin.rootOf(delPath));
  const trashed = await ev(`window.wp.trashFile(${JSON.stringify(delPath)})`);
  await sleep(1400);
  const rbAfter = recycleBin.query(recycleBin.rootOf(delPath));

  const chDel = (await ev('window.wp.listChannels()')).channels.find((c) => c.id === chId);
  const filesDel = await ev(`window.wp.channelFiles(${JSON.stringify(chId)}).then(r => r.files.map(f => f.path))`);
  console.log(`      删除 #${delIdx}(${path.basename(delPath)})，返回 ${JSON.stringify(trashed)}`);
  check('删除返回成功', trashed && trashed.ok === true, trashed && trashed.error);
  check('文件已离开原目录', !fs.existsSync(delPath), path.basename(delPath));
  check('回收站条目数 +1（是移入回收站，不是永久删除）',
    rbBefore.ok && rbAfter.ok && rbAfter.items === rbBefore.items + 1,
    `回收站 ${rbBefore.items} → ${rbAfter.items}`);
  check('轮转张数再 -1', chDel.count === IMAGE_COUNT - 2 && filesDel.length === IMAGE_COUNT - 2,
    `期望 ${IMAGE_COUNT - 2}，实际 list=${chDel.count} / files=${filesDel.length}`);
  check('画面仍然没变', (await ev('window.__rendererState()')).currentName === cur1.currentName,
    (await ev('window.__rendererState()')).currentName);

  // ---- 删除：正在显示的那一张（最容易踩坑：桌面挂着一张已进回收站的图）
  section('7. 删除当前正在显示的那张：索引收敛 + 桌面立即改挂别的图');
  const filesNow3 = await ev(`window.wp.channelFiles(${JSON.stringify(chId)}).then(r => r.files.map(f => f.path))`);
  const cur2 = await ev('window.__rendererState()');
  const osBeforeDelete = (osMonitors().find((m) => m.isPrimary) || osMonitors()[0]).current;
  const victim = filesNow3[cur2.index];
  const rbBefore2 = recycleBin.query(recycleBin.rootOf(victim));

  const trashedCur = await ev(`window.wp.trashFile(${JSON.stringify(victim)})`);

  // 同样要等系统把新壁纸落盘
  let osAfterDelete = osBeforeDelete;
  for (let i = 0; i < 14; i += 1) {
    osAfterDelete = (osMonitors().find((m) => m.isPrimary) || osMonitors()[0]).current;
    if (osAfterDelete && osAfterDelete !== osBeforeDelete) break;
    await sleep(350);
  }
  const rbAfter2 = recycleBin.query(recycleBin.rootOf(victim));

  const chDelCur = (await ev('window.wp.listChannels()')).channels.find((c) => c.id === chId);
  const stateDelCur = await ev('window.__rendererState()');

  console.log(`      删除当前帧 ${path.basename(victim)}，返回 ${JSON.stringify(trashedCur)}`);
  console.log(`      桌面 ${path.basename(osBeforeDelete || '')} → ${path.basename(osAfterDelete || '')}`);

  check('删除当前帧返回成功', trashedCur && trashedCur.ok === true, trashedCur && trashedCur.error);
  check('系统壁纸原来挂的就是它', path.basename(osBeforeDelete || '') === path.basename(victim),
    path.basename(osBeforeDelete || ''));
  check('回收站条目数 +1', rbBefore2.ok && rbAfter2.ok && rbAfter2.items === rbBefore2.items + 1,
    `回收站 ${rbBefore2.items} → ${rbAfter2.items}`);
  check('系统壁纸已改挂另一张（没留着一张回收站里的图）',
    osAfterDelete !== osBeforeDelete && fs.existsSync(osAfterDelete),
    `${path.basename(osBeforeDelete || '')} → ${path.basename(osAfterDelete || '')}`);
  check('索引收敛到合法范围', chDelCur.index >= 0 && chDelCur.index < chDelCur.count,
    `index=${chDelCur.index} count=${chDelCur.count}`);
  check('渲染层显示的图与桌面一致',
    stateDelCur.currentName === path.basename(osAfterDelete), `${stateDelCur.currentName} vs ${path.basename(osAfterDelete)}`);
  check('张数正确', chDelCur.count === IMAGE_COUNT - 3,
    `期望 ${IMAGE_COUNT - 3}，实际 ${chDelCur.count}`);

  // 复制（不动源文件）
  section('8. 复制到预设文件夹：源文件不动，只是多了一份');
  const filesNow4 = await ev(`window.wp.channelFiles(${JSON.stringify(chId)}).then(r => r.files.map(f => f.path))`);
  const copySrc = filesNow4[0];
  const copied = await ev(`window.wp.transferFile(${JSON.stringify(copySrc)}, ${JSON.stringify(DEST)}, 'copy')`);
  await sleep(900);
  const chCopied = (await ev('window.wp.listChannels()')).channels.find((c) => c.id === chId);
  check('复制返回成功', copied && copied.ok === true, copied && copied.error);
  check('源文件仍在', fs.existsSync(copySrc));
  check('目标目录多了一份', fs.existsSync(path.join(DEST, path.basename(copySrc))));
  check('复制不改变轮转张数', chCopied.count === IMAGE_COUNT - 3, `${chCopied.count}`);

  // 同名冲突
  const again = await ev(`window.wp.transferFile(${JSON.stringify(copySrc)}, ${JSON.stringify(DEST)}, 'copy')`);
  await sleep(700);
  check('同名文件不会互相覆盖', again && again.ok === true && path.basename(again.dest) !== path.basename(copySrc),
    again && path.basename(again.dest));

  /* -------------------------------------------------- 5. 托盘 / 自启 */

  section('9. 托盘与开机自启');
  const tray = await ev('window.wp.trayState()');
  check('托盘已安装', tray && tray.installed === true);
  // 开机自启是**系统状态**，别假设它必须是关的 —— 用户可能本来就开着。
  // 先记下来，收尾时按记下的值还原（同 config.json 的基线快照一个道理）。
  const loginSnap = await testConfig.snapshotLogin(ev);
  check('已记录自启的原始状态（收尾要还原）', loginSnap.ok,
    `测试前 launchAtLogin = ${loginSnap.launchAtLogin}`);
  check('开启了自启的机器上，状态回读为真（与系统一致）',
    Boolean(tray && tray.launchAtLogin) === loginSnap.launchAtLogin,
    `trayState=${tray && tray.launchAtLogin}`);
  check('自启命令指向当前可执行文件',
    Boolean(tray && tray.loginCommand && tray.loginCommand.includes('electron')),
    tray && tray.loginCommand);

  const on = await ev('window.wp.setLaunchAtLogin(true)');
  await sleep(600);
  const regOn = registryReader.findAppEntry('electron-wallpaper');
  check('开启自启后写入系统启动项',
    Boolean(regOn.ok && regOn.match),
    regOn.match ? `${regOn.match.name} → ${regOn.match.command.slice(0, 60)}` : `注册表里没有（读到 ${regOn.all ? Object.keys(regOn.all).length : 0} 项）`);
  check('开启后状态回读为真', (await ev('window.wp.trayState()')).launchAtLogin === true,
    `setLaunchAtLogin 返回 ${JSON.stringify(on)}`);

  const off = await ev('window.wp.setLaunchAtLogin(false)');
  await sleep(600);
  const regOff = registryReader.findAppEntry('electron-wallpaper');
  check('关闭自启后启动项被清掉', !regOff.match, regOff.match ? regOff.match.name : '(已清空)');
  check('关闭后状态回读为假', (await ev('window.wp.trayState()')).launchAtLogin === false);

  /* -------------------------------------------------- 6. 配置落盘 */

  section('10. 新配置项已写进 config.json');
  await ev('window.wp.setConfig(' + JSON.stringify({
    tray: true, closeToTray: true, filmstrip: true, infoPanel: true, contextMenu: true,
    filmstripRange: 40, thumbSize: 256, startHidden: false,
  }) + ')');
  await sleep(600);
  const saved = JSON.parse(fs.readFileSync(
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'electron-wallpaper', 'config.json'),
    'utf8',
  ));
  check('托盘相关字段已落盘', saved.tray === true && saved.closeToTray === true);
  check('胶片条字段已落盘', saved.filmstrip === true && saved.filmstripRange === 40);
  check('信息面板 / 右键菜单字段已落盘', saved.infoPanel === true && saved.contextMenu === true);
  // 空字符串是合法值（= 用 userData/thumbs 默认目录），这里只确认字段存在且落盘
  check('缩略图缓存目录字段已落盘', 'thumbCacheDir' in saved, saved.thumbCacheDir || '(空 = 用默认目录)');
  check('预设文件夹已落盘', Array.isArray(saved.quickFolders) && saved.quickFolders.length >= 1);

  /* -------------------------------------------------- 收尾 */

  /* -------------------------------------------------- 6.5 开箱即用 */

  section('10.5 开箱即用：检测到多屏 + 已选目录 → 自动开每屏独立');

  const monCount = ((await ev('window.wp.listChannels()')).monitors || []).length;

  /*
   * ① 还没选目录时不该动配置（否则每块屏都是空频道，开了也白开）。
   *    用 setConfig 把状态摆回「全新安装」：关掉每屏独立、标记清掉、目录留空。
   */
  await ev(`window.wp.setConfig(${JSON.stringify({
    autoMonitorSetup: false, perMonitor: false, folder: '',
  })})`);
  await sleep(900);
  const noFolder = await ev('window.wp.getConfig()');
  check('没选目录时不动配置（开了也是空频道）',
    noFolder.perMonitor === false, `perMonitor=${noFolder.perMonitor}`);
  check('没选目录时不落「已自动配置」标记（以后接了屏还能补上）',
    noFolder.autoMonitorSetup === false, String(noFolder.autoMonitorSetup));

  // 关掉每屏独立之后只剩一条统一频道 —— 它的 id 就是「选文件夹」要作用的那个
  const unifiedId = (await ev('window.wp.listChannels()')).channels[0].id;

  if (monCount < 2) {
    check('（这台机器只有一块屏，跳过真正的自动配置）', true, `检测到 ${monCount} 块`);
  } else {
    /*
     * ② 走**真实路径**：首次运行选文件夹是 `folder:pick` → `setChannelProfile`，
     *    不是 config:set。用 channelCommand 的 'set-profile' 复现同一条路
     *    （少一个原生目录对话框，其余完全一样）。
     */
    await ev(`window.wp.channelCommand(${JSON.stringify(unifiedId)}, 'set-profile', ${JSON.stringify({ folder: SRC })})`);
    await sleep(1600);
    const auto = await ev('window.wp.getConfig()');
    check('首次选完目录就自动打开了每屏独立（走 folder:pick 那条路）',
      auto.perMonitor === true, `perMonitor=${auto.perMonitor}`);
    check('「只做一次」的标记已落下', auto.autoMonitorSetup === true, String(auto.autoMonitorSetup));

    const autoChs = (await ev('window.wp.listChannels()')).channels;
    check('每块屏各得到一条独立频道', autoChs.length === monCount, `${autoChs.length} 路 / ${monCount} 块屏`);

    /*
     * 每块屏必须立刻有目录可播，否则「开箱即用」就是空话。
     *
     * 注意这里不能用「全都等于顶层 folder」来断言：这台机器的配置里每块屏都有自己的
     * 目录覆盖，而覆盖优先于顶层是正确的。真正的契约是
     * 「有覆盖用覆盖，没覆盖回落顶层」—— 回落那一半由单测（test-scheduler）
     * 直接测 resolveProfile，因为要造出 monitors 为空的全新安装状态在这里改不动
     * （没有从渲染层清掉单屏覆盖的接口）。
     */
    const cfgNow = await ev('window.wp.getConfig()');
    const expectFolder = autoChs.map((c) => {
      const ov = (cfgNow.monitors || {})[c.id];
      return path.normalize((ov && ov.folder) || cfgNow.folder);
    });
    check('每块屏都拿到了可播的目录（有覆盖用覆盖，没覆盖回落顶层）',
      autoChs.every((c, i) => c.profile.folder && path.normalize(c.profile.folder) === expectFolder[i]),
      autoChs.map((c) => path.basename(c.profile.folder) || '(空)').join(' | '));
    check('每块屏都在扫自己的目录（不是共用一条空频道）',
      autoChs.every((c) => c.count > 0), autoChs.map((c) => `${c.count} 张`).join(' | '));

    // ③ 用户手动关掉之后，绝不能又被自动打开（那叫抢方向盘）
    await ev('window.wp.setConfig(' + JSON.stringify({ perMonitor: false }) + ')');
    await sleep(1200);
    const manualOff = await ev('window.wp.getConfig()');
    check('用户手动关掉后不会被自动打开', manualOff.perMonitor === false,
      `perMonitor=${manualOff.perMonitor}`);
    const backToOne = (await ev('window.wp.listChannels()')).channels;
    check('关掉后回到单条统一频道', backToOne.length === 1, `${backToOne.length} 路`);
  }

  section('11. 还原配置');
  await ev('window.wp.removeQuickFolder(' + JSON.stringify((await ev('window.wp.listQuickFolders()'))[0]?.id) + ')').catch(() => {});
  await sleep(300);
  const restored2 = await testConfig.restore(ev);
  await sleep(600);
  check('已从基线快照还原配置',
    restored2.ok && path.normalize(restored2.actual.folder) === path.normalize(cfg.folder),
    restored2.ok ? restored2.actual.folder : restored2.error);
  check('还原后的目录不是测试素材',
    !testConfig.looksLikeTestData(restored2.actual.folder), String(restored2.actual.folder));
  check('预设文件夹已清空（不留验证残留）', (restored2.actual.quickFolders || []).length === 0);
  check('还原后与还原点逐键一致（脏值不会被下一轮继承）',
    (restored2.diff || []).length === 0,
    (restored2.diff || []).slice(0, 4).join('；') || '完全一致');


  /*
   * 自启不在 config.json 里，得单独还原到这一轮开始时的系统状态。
   *
   * 注意：`restore(ev)` 现在自己就会顺带还原自启（这样中途崩掉的下一轮也能自愈），
   * 所以这里不再单独调 restoreLogin —— 直接用它的返回值，顺便验证「顺手还原」真的生效了。
   */
  check('还原配置时顺带把开机自启也还原了（系统状态不在 config.json 里）',
    Boolean(restored2.login) && restored2.login.ok,
    restored2.login
      ? `launchAtLogin = ${restored2.login.launchAtLogin}`
        + `${restored2.login.changed ? '（被测试改过，已改回）' : '（本来就是这个状态）'}`
      : `没有自启快照：${restored2.loginError}`);

  // 上面是应用自己的说法，再用注册表核一遍 —— 这条才是「没污染用户系统」的硬证据
  const regAfter = registryReader.findAppEntry('electron-wallpaper');
  check('注册表里的启动项与测试前一致（用户设置没被测试吃掉）',
    Boolean(regAfter.match) === Boolean(loginSnap.launchAtLogin),
    `测试前=${loginSnap.launchAtLogin} 现在=${regAfter.match ? '有启动项' : '没有启动项'}`);

  cdp.close();

  console.log(`\n${'='.repeat(56)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log(`测试素材目录（可直接删除）：${TMP}`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n验证脚本异常终止：', err.message);
  console.error(err.stack);
  process.exit(2);
});

/* ------------------------------------------------------------ 附带工具 */

function osMonitors() {
  const result = desktopWallpaper.enumMonitors();
  return (result.monitors || []).map((m) => ({
    index: m.index,
    label: m.label,
    isPrimary: Boolean(m.primary),
    current: m.current || null,
  }));
}
