'use strict';

/**
 * 音乐同步壁纸展示 v2（按乐句切换 + 横竖屏相簿轮切）——纯 IPC 驱动。
 *
 * 用户节奏定稿：
 *   - 唱完一句就切（乐句边界 = analyze-song.py 的能量谷底，8~16s 一段）
 *   - 轨迹不用推拉：横屏段=环绕 circle，竖屏段=摆动环绕 orbital（天然交替）
 *   - 奇数段切「测试-竖屏」相簿 + 拼接填充(collage)，下一句切回「测试-横屏」
 *
 * 驱动方式：window.wp.channelCommand(主屏频道id, ...) 直连（v2 教训：主屏的
 * monitor-card 不渲染，DOM 路走不通）；主屏 interval 覆盖 1800s，录制期间
 * 不会自动切，无需动 interval。
 *
 * 用法：
 *   node tools/demo-music.js --pass=xxx    # 正式录制
 *   node tools/demo-music.js --dry         # 彩排（不开录、不扫鼠标）
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TIMELINE = JSON.parse(fs.readFileSync(path.join(__dirname, 'demo-music-timeline.json'), 'utf8'));
const OBS_CTL = path.join(__dirname, 'obs-control.js');
const CDP_LIST = process.env.DEMO_CDP_LIST || 'http://127.0.0.1:9222/json';

const argv = process.argv.slice(2);
const argStr = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : (dflt || '');
};
const PASS = argStr('pass', process.env.OBS_WS_PASS || '');
const DRY = argv.includes('--dry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cue = (msg) => { console.log(`\n▶ ${msg}`); fs.writeSync(1, ''); };
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---- CDP ----
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
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败（应用是否带 --remote-debugging-port=9222？）')));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
  });
}

let cdp;
async function evaluate(expression, awaitPromise = false) {
  const r = await cdp.call('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error('页面执行出错: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
}

const ui = {
  statusText: `(() => (document.getElementById('depth-status')?.textContent || ''))()`,
  getStyle: `(() => document.getElementById('cfg-flow-style')?.value || '')`,
  setFlowStyle: (v) => `(() => {
    const s = document.getElementById('cfg-flow-style');
    if (!s) return false;
    s.value = '${v}';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`,
  probe: `(async () => {
    const c = await window.wp.getConfig();
    const mainId = Object.keys(c.monitors || {}).find((k) => !k.includes('CYS1610'));
    const albums = (c.albums || []).map((a) => ({ id: a.id, name: a.name }));
    return { mainId, prof: c.monitors[mainId], albums, flowStyle: c.flowStyle };
  })()`,
  channel: (mainId, action, payload) => `(async () => window.wp.channelCommand(${JSON.stringify(mainId)}, '${action}', ${JSON.stringify(payload || {})}))()`,
};

// ---- 真实光标（koffi SendInput，横向正弦扫）----
function makeCursor() {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const SendInput = user32.func('int __stdcall SendInput(int, void *, int)');
  const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int)');
  const W = GetSystemMetrics(0), H = GetSystemMetrics(1);
  const INPUT_SIZE = 40;
  const sweep = async (sec) => {
    const t0 = Date.now();
    while ((Date.now() - t0) / 1000 < sec) {
      const t = (Date.now() - t0) / 1000;
      const fx = 0.5 + 0.33 * Math.sin(t * 2 * Math.PI / (sec / 2));
      const fy = 0.45 + 0.05 * Math.sin(t * 1.1);
      const buf = Buffer.alloc(INPUT_SIZE);
      buf.writeUInt32LE(0, 0);
      buf.writeInt32LE(0x8000 | 0x0001, 4);
      buf.writeInt32LE(Math.round(fx * 65535), 8);
      buf.writeInt32LE(Math.round(fy * 65535), 12);
      SendInput(1, buf, INPUT_SIZE);
      await sleep(16);
    }
  };
  return { sweep, W, H };
}

async function waitDepthReady(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = await evaluate(ui.statusText);
    if (t && t.includes('就绪')) return t;
    await sleep(400);
  }
  return null;
}
const waitDepthReadyShort = () => waitDepthReady(30000);

function obs(...args) {
  const r = spawnSync('node', [OBS_CTL, ...args, `--pass=${PASS}`], { encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '') + (r.stderr || '');
}

// ---- 编排：乐句段交替 横屏(circle/cover) ↔ 竖屏(orbital/collage) ----
const ALBUM_H = 'h', ALBUM_V = 'v';
const STYLE_OF = { [ALBUM_H]: 'circle', [ALBUM_V]: 'orbital' };
const LABEL_OF = { [ALBUM_H]: '横屏 · 镜头环绕', [ALBUM_V]: '竖屏拼接 · 摆动环绕' };

function buildPlan() {
  const bnds = [...TIMELINE.phrases, TIMELINE.duration];
  const segs = [];
  let prev = 0;
  for (let i = 0; i < bnds.length; i++) {
    const album = i % 2 === 0 ? ALBUM_H : ALBUM_V;
    segs.push({ idx: i, start: prev, end: bnds[i], album, style: STYLE_OF[album],
      label: LABEL_OF[album], sweep: 0 });
    prev = bnds[i];
  }
  // 鼠标扫动：首段 6s；副歌所在段 8s；中途均匀挑两段各 4s（钳到段长内）
  const chorusSeg = segs.find((s) => TIMELINE.chorusCenter >= s.start && TIMELINE.chorusCenter < s.end);
  const mid1 = segs[Math.floor(segs.length * 0.3)], mid2 = segs[Math.floor(segs.length * 0.6)];
  const want = new Map([[segs[0].idx, 6], [mid1.idx, 4], [mid2.idx, 4], [chorusSeg.idx, 8]]);
  for (const s of segs) {
    if (want.has(s.idx)) s.sweep = Math.max(2, Math.min(want.get(s.idx), s.end - s.start - 3));
  }
  return segs;
}

(async () => {
  let targets;
  try { targets = await (await fetch(CDP_LIST)).json(); }
  catch { throw new Error('连不上 9222 —— 壁纸实例要带 --remote-debugging-port=9222 启动'); }
  const page = targets.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
  if (!page) throw new Error('没找到设置窗口页面（index.html）');
  cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable', {});

  // 0) 探频道/相簿
  const info = await evaluate(ui.probe, true);
  if (!info || !info.mainId) throw new Error('探不到主屏频道（monitors 空？）');
  const MAIN = info.mainId;
  const albumH = (info.albums.find((a) => a.name.includes('横屏')) || {}).id;
  const albumV = (info.albums.find((a) => a.name.includes('竖屏')) || {}).id;
  if (!albumH || !albumV) throw new Error('相簿清单里没找到「横屏/竖屏」：' + JSON.stringify(info.albums));
  const styleRaw = await evaluate(ui.getStyle);
  const orig = { albumId: info.prof.albumId, fit: info.prof.fit || 'cover',
    style: (typeof styleRaw === 'string' && styleRaw) ? styleRaw : 'circle' };
  snapshotOrig(orig, MAIN);
  let curAlbum = orig.albumId, curFit = orig.fit;
  cue(`主屏频道=${MAIN.slice(0, 40)}…｜相簿=${orig.albumId} fit=${orig.fit}｜横屏=${albumH} 竖屏=${albumV}`);

  const cmd = (action, payload) => evaluate(ui.channel(MAIN, action, payload), true);

  // 切一段：填充 → 相簿（变了才动）→ 轨迹 → 下一张
  async function applySegment(s) {
    const wantFit = s.album === ALBUM_V ? 'collage' : orig.fit;
    if (wantFit !== curFit) { await cmd('set-profile', { fit: wantFit }); curFit = wantFit; await sleep(400); }
    const target = s.album === ALBUM_V ? albumV : albumH;
    if (target !== curAlbum) {
      await cmd('set-profile', { albumId: target });   // scheduler 对同一相簿保留播放位置
      curAlbum = target;
      await sleep(1000);                               // 等频道重建
    }
    await evaluate(ui.setFlowStyle(s.style));
    await cmd('next');
  }

  const plan = buildPlan();
  cue(`时间轴（${plan.length} 段，乐句 8~16s）：\n  ` +
    plan.map((s) => `${fmt(s.start)} ${s.album === 'h' ? '横' : '竖'}${s.sweep ? ` +扫${Math.round(s.sweep)}s` : ''}`).join(' '));

  // 1) 预热：按时间轴完整走一遍，等深度就绪（30s 上限，超时也继续——缓存异步补齐）
  cue(`预热：按 ${plan.length} 段完整走一遍`);
  for (const s of plan) {
    const t0 = Date.now();
    await applySegment(s);
    const st = await waitDepthReadyShort();
    console.log(`  段 ${s.idx} (${s.album === 'h' ? '横' : '竖'}) ${((Date.now() - t0) / 1000).toFixed(1)}s ${st ? '✓' : '⚠未就绪'}`);
    await sleep(400);
  }
  cue('预热完成（横竖屏的图深度已尽量热，位置已推进到末段）');

  if (DRY) {
    cue('彩排：再快走一遍（每段 1.5s，不开录不扫鼠标）');
    for (const s of plan) {
      await applySegment(s);
      console.log(`  [${fmt(s.start)}] ${s.label} (${s.style})`);
      await sleep(1500);
    }
    await restoreAll();
    cue('彩排完成，配置已还原');
    return;
  }

  // 2) 回到首段（横屏+环绕），就绪后开录
  await applySegment(plan[0]);
  const st0 = await waitDepthReady(30000);
  cue(`回到首段（横屏 · 环绕）${st0 ? '就绪' : '⚠未就绪'}`);

  cue('OBS：切「录-主屏」→ 开录');
  const mainOut = obs('main');
  console.log(mainOut.trim());
  const startOut = obs('start');
  console.log(startOut.trim());
  if (mainOut.includes('✖') || startOut.includes('✖')) {
    await restoreAll();
    throw new Error('OBS 开录失败（见上），配置已还原');
  }
  cue(`录制开始 T0 —— 时长 ${fmt(TIMELINE.duration)}，鼠标共被接管 ~${Math.round(plan.reduce((a, s) => a + (s.sweep || 0), 0))}s，请勿操作`);

  const cursor = makeCursor();
  for (const s of plan.slice(1)) {
    setTimeout(() => { applySegment(s).catch((e) => console.error('  切换失败:', e.message)); }, s.start * 1000);
    if (s.sweep) setTimeout(() => cursor.sweep(s.sweep), (s.start + 2) * 1000);
  }
  await sleep(TIMELINE.duration * 1000 + 1500);
  cue('歌曲结束，停录');
  console.log(obs('stop').trim());

  // 3) 还原 + SRT
  await restoreAll();
  const srt = (sec) => {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = Math.floor(sec % 60), ms = Math.round((sec % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s2).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  const srtPath = path.join(ROOT, 'tools', 'out', 'demo-music.srt');
  fs.mkdirSync(path.dirname(srtPath), { recursive: true });
  fs.writeFileSync(srtPath, plan.map((s, i) => `${i + 1}\n${srt(s.start)} --> ${srt(s.end)}\n${s.label}\n`).join('\n'), 'utf8');
  cue(`字幕已生成：${srtPath}\n完成。`);
})().catch((e) => { console.error('✖ ' + e.message); process.exit(1); });

let _orig = { albumId: null, fit: 'cover', style: 'circle' };
let _mainId = null;
function snapshotOrig(o, mainId) { _orig = { ...o }; _mainId = mainId; }
async function restoreAll() {
  try {
    if (!_mainId) return;
    await evaluate(ui.setFlowStyle(String(_orig.style || 'circle')));
    await evaluate(`(async () => window.wp.channelCommand(${JSON.stringify(_mainId)}, 'set-profile', { albumId: ${JSON.stringify(_orig.albumId)}, fit: ${JSON.stringify(_orig.fit)} }))()`, true);
    cue(`配置已还原（album=横屏, fit=${_orig.fit}, style=${String(_orig.style || 'circle')}；interval 未动）`);
  } catch (e) { console.error('还原出错:', e.message); }
}
