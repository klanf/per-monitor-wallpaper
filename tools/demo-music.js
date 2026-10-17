'use strict';

/**
 * 音乐同步壁纸展示录制（一首歌长度，按能量节点切图 + 轨迹轮换 + 鼠标扫动）。
 *
 * 前置：
 *   1) 壁纸实例带调试端口跑着（DevTools 9222，index.html 可连）
 *   2) OBS 跑着、obs-websocket 4455 开着、有密码就 --pass=xxx（或环境变量 OBS_WS_PASS）
 *   3) tools/obs-control.js setup 过（「录-主屏」场景已建）
 *   4) tools/demo-music-timeline.json（analyze-song.py 生成）
 *
 * 用法：
 *   node tools/demo-music.js --pass=xxx           # 正式录制（一首歌长度 ~225s）
 *   node tools/demo-music.js --dry                # 彩排：预热+试切换+定时器改/还原，不开录
 *
 * 流程：预热（把接下来要用的图全部提前推好深度）→ 轮播间隔临时调大（中和 30s
 * 定时器，录完还原）→ OBS 切「录-主屏」开录 → 按时间轴切下一张（同时轮换镜头
 * 轨迹、在指定段落扫鼠标）→ 歌曲结束停录 → 还原配置 → 生成 SRT 字幕文件。
 *
 * 音频不进 OBS：录完用 ffmpeg 把歌 mux 进去（画面/音频零漂移，后期再对）。
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
async function evaluate(expression) {
  const r = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error('页面执行出错: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
}

const ui = {
  nextImage: `(() => { document.getElementById('btn-next')?.click(); return true; })()`,
  statusText: `(() => (document.getElementById('depth-status')?.textContent || ''))()`,
  getInterval: `(() => Number(document.getElementById('cfg-interval')?.value) || 0)()`,
  setInterval: (v) => `(() => {
    const s = document.getElementById('cfg-interval');
    if (!s) return false;
    s.value = '${v}';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`,
  getStyle: `(() => document.getElementById('cfg-flow-style')?.value || '')`,
  setFlowStyle: (v) => `(() => {
    const s = document.getElementById('cfg-flow-style');
    if (!s) return false;
    s.value = '${v}';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`,
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

function obs(...args) {
  const r = spawnSync('node', [OBS_CTL, ...args, `--pass=${PASS}`], { encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '') + (r.stderr || '');
}

// 演示编排：每段一个轨迹（轮换），指定段落扫鼠标
const STYLE_LABEL = { circle: '镜头轨迹 · 环绕', orbital: '镜头轨迹 · 公转', dolly: '镜头轨迹 · 推拉' };
const STYLES = ['circle', 'orbital', 'dolly'];
// 扫鼠标：段号 -> 秒数（段开头 +2.5s 起）
const SWEEPS = { 0: 6, 3: 4, 6: 4, 7: 8 };  // 7 号段含副歌中心 ~204s

function buildPlan() {
  const pts = [...TIMELINE.switches, TIMELINE.duration];
  const segs = [];
  let prev = 0;
  for (let i = 0; i < pts.length; i++) {
    segs.push({ idx: i, start: prev, end: pts[i], style: i === 0 ? 'circle' : STYLES[i % 3],
      label: i === 0 ? '深度视差 · 鼠标跟随' : STYLE_LABEL[STYLES[i % 3]], sweep: SWEEPS[i] || 0 });
    prev = pts[i];
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

  const plan = buildPlan();
  const segsDesc = plan.map((s) => `${fmt(s.start)} ${s.label}${s.sweep ? ` +扫${s.sweep}s` : ''}`).join('\n  ');
  cue(`时间轴（${TIMELINE.duration}s = ${fmt(TIMELINE.duration)}）：\n  ${segsDesc}`);

  // 1) 预热：把接下来要展示的图全部提前推好深度（顺序固定，从当前位置往后数）
  const nWarm = plan.length + 2;
  cue(`预热：连切 ${nWarm} 张等深度就绪（画面会快速换图，属正常）`);
  for (let i = 0; i < nWarm; i++) {
    await evaluate(ui.nextImage);
    const st = await waitDepthReady(60000);
    if (!st) console.log(`  ⚠ 第 ${i + 1} 张 60s 未就绪，继续（录的时候可能现场推理）`);
    await sleep(800);
  }
  cue('预热完成，深度缓存已热');

  // 2) 定时器临时调大（中和 30s 轮播），记下原值
  const oldInterval = await evaluate(ui.getInterval);
  await evaluate(ui.setInterval(3600));
  cue(`轮播间隔 ${oldInterval}s → 3600s（录完还原）`);

  if (DRY) {
    cue('彩排：按时间轴顺序试切一遍（每段 2s，不开录不改鼠标）');
    for (const s of plan.slice(1)) {
      await evaluate(ui.setFlowStyle(s.style));
      await evaluate(ui.nextImage);
      console.log(`  [${fmt(s.start)}] ${s.label} (${s.style})`);
      await sleep(2000);
    }
    await evaluate(ui.setFlowStyle('circle'));
    await evaluate(ui.setInterval(oldInterval));
    cue(`彩排完成，配置已还原（interval=${oldInterval}, style=circle）`);
    return;
  }

  // 3) OBS 切主屏场景并开录
  cue('OBS：切「录-主屏」→ 开录');
  const mainOut = obs('main');
  console.log(mainOut.trim());
  const startOut = obs('start');
  console.log(startOut.trim());
  if (mainOut.includes('✖') || startOut.includes('✖')) {
    await evaluate(ui.setInterval(oldInterval));
    throw new Error('OBS 开录失败（见上），配置已还原');
  }
  const T0 = Date.now();
  cue(`录制开始 T0 —— 目标时长 ${fmt(TIMELINE.duration)}，期间鼠标会被脚本接管扫动 ${Object.values(SWEEPS).reduce((a, b) => a + b, 0)}s，请勿操作`);

  const cursor = makeCursor();
  const timers = [];
  for (const s of plan.slice(1)) {   // 段 0 从 T0 直接开始，不用切
    timers.push(setTimeout(async () => {
      try {
        await evaluate(ui.setFlowStyle(s.style));
        await evaluate(ui.nextImage);
        console.log(`  [${fmt(s.start)}] 切换 → ${s.label} (${s.style})`);
      } catch (e) { console.error('  切换失败:', e.message); }
    }, s.start * 1000));
    if (s.sweep) {
      timers.push(setTimeout(() => cursor.sweep(s.sweep), (s.start + 2.5) * 1000));
    }
  }

  await sleep(TIMELINE.duration * 1000 + 1500);
  timers.forEach(clearTimeout);
  cue('歌曲结束，停录');
  const stopOut = obs('stop').trim();
  console.log(stopOut);

  // 4) 还原配置
  await evaluate(ui.setFlowStyle('circle'));
  await evaluate(ui.setInterval(oldInterval));
  cue(`配置已还原（interval=${oldInterval}, style=circle）`);

  // 5) SRT 字幕（后期加讲解用，剪映可直接导入）
  const srt = (sec) => {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = Math.floor(sec % 60), ms = Math.round((sec % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s2).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  const srtPath = path.join(ROOT, 'tools', 'out', 'demo-music.srt');
  fs.mkdirSync(path.dirname(srtPath), { recursive: true });
  const srtBody = plan.map((s, i) => `${i + 1}\n${srt(s.start)} --> ${srt(s.end)}\n${s.label}\n`).join('\n');
  fs.writeFileSync(srtPath, srtBody, 'utf8');
  cue(`字幕已生成：${srtPath}\n完成。接下来把歌 mux 进视频：见本次回复里的 ffmpeg 命令`);
})().catch((e) => { console.error('✖ ' + e.message); process.exit(1); });
