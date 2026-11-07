#!/usr/bin/env node
/**
 * demo-music.js —— 音乐同步展示录制 v3（歌词版）
 *
 * 按「茜」(ヨルシカ) 的带时间戳 LRC 逐行切横屏壁纸；两段间奏 + 尾奏切竖屏相簿
 * （拼接填充）。轨迹全程环绕（circle）。核心修复：切回相簿后用 goto 跳到脚本
 * 自计数的位置（set-profile 显式切相簿会把 index 归零，v2 就是栽在这里——
 * 横屏每次都回第一张），每次命令后读回 channels 校验 index/current。
 *
 * 用法：
 *   node tools/demo-music.js --pass=<OBS密码>            # 正式录制
 *   node tools/demo-music.js --pass=<OBS密码> --dry      # 彩排：不开录，事件背靠背跑+断言
 * 产物：
 *   tools/out/demo-music.ass / .srt —— 歌词字幕（底部）+ 左上角功能介绍
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const argStr = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 1) : (dflt || '');
};
const DRY = argv.includes('--dry');
const OBS_PASS = argStr('pass', process.env.OBS_WS_PASS || '');

// ---------- 歌词时间轴 ----------
const LRC = JSON.parse(fs.readFileSync(path.join(__dirname, 'akane-lrc.json'), 'utf8'));
const DUR = LRC.duration;
const INSTR = LRC.instrumentals; // [[start,end],...] 竖屏段
const inVertical = (t) => INSTR.some(([a, b]) => t >= a - 0.05 && t < b);

/** 组装事件表：T0 + 每行歌词（横屏 goto 递增）+ 每段间奏进出（竖屏 goto 递增） */
function buildPlan() {
  const events = [];
  let hIdx = 0, vIdx = 0;
  events.push({ at: 0, album: 'h', hIdx: hIdx++, label: '横屏相簿 · 深度视差 · 镜头环绕' });
  for (const line of LRC.lines) {
    if (inVertical(line.t)) continue; // 间奏里不该有词（防脏数据）
    if (inVertical(line.end)) {       // 这行之后进间奏：先走竖屏事件，本行仍是横屏
      // （落到下面统一处理）
    }
    events.push({ at: line.t, album: 'h', hIdx: hIdx++, text: line.text });
  }
  for (const [a] of INSTR) {
    events.push({ at: a, album: 'v', vIdx: vIdx++, label: '竖屏相簿 · 拼接填充 · 镜头环绕' });
  }
  events.sort((x, y) => x.at - y.at);
  // T0 是横屏 goto 0；如果第一行歌词的 t 也接近 0 会重复 goto——去重（同相簿相邻事件保留后者）
  return events;
}

// ---------- CDP ----------
let wsSeq = 0;
const wsPend = new Map();
function connectCdp() {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 连接超时（9222）')), 8000);
    try {
      const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
      const page = targets.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (!page) throw new Error('没找到 index.html 页面');
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && wsPend.has(m.id)) { wsPend.get(m.id)(m); wsPend.delete(m.id); }
      });
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket 连接失败')); });
    } catch (e) { clearTimeout(timer); reject(e); }
  });
}
let CDP = null;
function evaluate(expr, awaitPromise = false) {
  return new Promise((resolve, reject) => {
    const id = ++wsSeq;
    wsPend.set(id, (m) => {
      if (m.error) return reject(new Error(m.error.message));
      const r = m.result;
      if (r.exceptionDetails) return reject(new Error(r.exceptionDetails.exception?.description || '页面执行异常'));
      resolve(r.result?.value);
    });
    CDP.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise, returnByValue: true } }));
  });
}

/** 主进程 IPC：频道命令（带 awaitPromise，回包含 channels 列表可校验） */
async function cmd(mainId, command, payload) {
  const expr = `(window.wp.channelCommand(${JSON.stringify(mainId)}, ${JSON.stringify(command)}, ${JSON.stringify(payload || {})}))`;
  return evaluate(expr, true);
}
/** 读频道清单（{channels: scheduler.list()}，含 id/width/height/index/current/profile） */
async function chanList() {
  const r = await evaluate(`(window.wp.listChannels())`, true);
  return r.channels || r;
}
/** 读全局配置（拿相簿清单） */
async function channels0() {
  return evaluate(`(window.wp.getConfig())`, true);
}

// ---------- 鼠标（koffi SendInput，绝对坐标正弦扫动） ----------
function sweep(seconds) {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const SendInput = user32.func('int __stdcall SendInput(int, void *, int)');
  const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int)');
  const W = GetSystemMetrics(0), H = GetSystemMetrics(1);
  const cx = W / 2, cy = H / 2;
  const send = (nx, ny) => { // nx,ny ∈ 0..1
    const buf = Buffer.alloc(40);
    buf.writeUInt32LE(0, 0);
    buf.writeInt32LE(0x8000 | 0x0001, 4);            // ABSOLUTE|MOVE
    buf.writeInt32LE(Math.round(nx * 65535), 8);
    buf.writeInt32LE(Math.round(ny * 65535), 12);
    SendInput(1, buf, 40);
  };
  const t0 = Date.now();
  send(cx / W, cy / H);
  while (Date.now() - t0 < seconds * 1000) {
    const t = (Date.now() - t0) / 1000;
    const p = t / seconds;
    const nx = cx / W + 0.10 * Math.sin(p * Math.PI * 1.5);
    const ny = cy / H + 0.045 * Math.sin(p * Math.PI * 3 + 0.7);
    send(nx, ny);
    const busy = Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 16);
    void busy;
  }
  send(cx / W, cy / H);
}

// ---------- OBS ----------
function obs(sub) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'obs-control.js'), sub, `--pass=${OBS_PASS}`], { stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`OBS ${sub} 失败(${code}): ${out.trim()}`))));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const cue = (m) => console.log(`\n▶ ${m}`);

// ---------- 主流程 ----------
(async () => {
  const plan = buildPlan();
  CDP = await connectCdp();
  console.log('CDP OK');
  let _lastChannels = null;
  function findMain(chs) { return (chs || []).find((c) => c.id === MAIN); }

  // 找主屏频道（横屏 2560 宽的那块）+ 相簿 id
  const chans0 = await chanList();
  const main0 = chans0.find((c) => c.kind === 'monitor' && Number(c.width) > Number(c.height));
  if (!main0) throw new Error('没找到横屏显示器频道: ' + JSON.stringify(chans0.map((c) => `${c.width}x${c.height}`)));
  const MAIN = main0.id;
  const cfg0 = await channels0();
  const albumH = (cfg0.albums || []).find((a) => a.name.includes('横屏'))?.id;
  const albumV = (cfg0.albums || []).find((a) => a.name.includes('竖屏'))?.id;
  if (!albumH || !albumV) throw new Error('相簿清单缺「横屏/竖屏」: ' + JSON.stringify(cfg0.albums));
  const orig = { albumId: main0.albumId, fit: main0.profile?.fit || 'cover' };
  _lastChannels = chans0;
  cue(`主屏=${MAIN.slice(0, 44)}…｜横屏=${albumH === orig.albumId ? '(当前)' : ''}${albumH}｜竖屏=${albumV}｜orig.fit=${orig.fit}`);
  console.log(`时间轴：${plan.length} 个事件（${LRC.lines.length} 行歌词 + ${INSTR.length} 段竖屏）｜时长 ${fmt(DUR)}`);

  async function applyEvent(ev, strict) {
    const wantAlbum = ev.album === 'v' ? albumV : albumH;
    const wantFit = ev.album === 'v' ? 'collage' : orig.fit;
    // 1) 相簿/填充（变了才动）
    const st0 = findMain(_lastChannels) || {};
    if (st0.albumId !== wantAlbum || (st0.profile?.fit || orig.fit) !== wantFit) {
      await cmd(MAIN, 'set-profile', { albumId: wantAlbum, fit: wantFit });
      _lastChannels = await chanList();
      await sleep(900); // 等重建
    }
    // 2) goto 进度位
    const targetIdx = ev.album === 'v' ? ev.vIdx : ev.hIdx;
    await cmd(MAIN, 'goto', { index: targetIdx });
    _lastChannels = await chanList();
    const st = findMain(_lastChannels) || {};
    const okIdx = st.index === targetIdx;
    const okAlbum = st.albumId === wantAlbum;
    const okFit = (st.profile?.fit ?? orig.fit) === wantFit;
    const tag = `${ev.album === 'v' ? '竖' : '横'}#${ev.album === 'v' ? ev.vIdx : ev.hIdx}`;
    const msg = `${fmt(ev.at)} ${tag} → index=${st.index} album=${st.albumId === albumH ? 'H' : st.albumId === albumV ? 'V' : '?'} fit=${st.profile?.fit}${(strict && (!okIdx || !okAlbum || !okFit)) ? ' ❌' : ' ✓'}`;
    console.log('  ' + msg);
    if (strict && !okIdx) throw new Error(`goto 未命中：期望 index=${targetIdx}，实际 ${st.index}`);
    return st;
  }

  // ---- 1) 预热：全部事件背靠背跑一遍（横竖屏的图深度都热）+ 断言 ----
  cue(`预热：${plan.length} 个事件背靠背走 + 断言`);
  const seen = new Map(); // 相簿 → 用过的 current 路径集合（查重复图）
  for (const ev of plan) {
    const st = await applyEvent(ev, true);
    const key = ev.album;
    if (!seen.has(key)) seen.set(key, new Set());
    const cur = st.current || '';
    if (cur && seen.get(key).has(cur)) console.log(`  ⚠ ${tag2(ev)} 重复图: ${path.basename(cur)}`);
    seen.get(key).add(cur);
    if (ev.album === 'v') { // 竖屏切图等深度
      const t0 = Date.now();
      while (Date.now() - t0 < 60000) {
        const s = await evaluate(`document.getElementById('depth-status')?.textContent || ''`);
        if (String(s).includes('就绪')) break;
        await sleep(500);
      }
    }
    await sleep(200);
  }
  cue('预热完成（含断言全绿；重复图已核查）');

  // ---- 2) 回到起始状态 ----
  _lastChannels = (await cmd(MAIN, 'set-profile', { albumId: albumH, fit: orig.fit })).channels;
  _lastChannels = (await cmd(MAIN, 'goto', { index: 0 })).channels;
  await sleep(1500);
  cue(`回到首帧（横屏 index=0）${DRY ? '—— 彩排到此为止' : ''}`);

  if (DRY) {
    console.log('\n彩排通过。正式录制：node tools/demo-music.js --pass=...');
    return;
  }

  // ---- 3) OBS 开录 + 实时时间轴 ----
  cue('OBS：切「录-主屏」→ 开录');
  console.log((await obs('main')).trim());
  console.log((await obs('start')).trim());
  const t0 = Date.now();
  const elapsed = () => (Date.now() - t0) / 1000;
  cue(`录制开始 T0 —— 时长 ${fmt(DUR)}，鼠标共被接管 ~19s，请勿操作`);

  const SWEEPS = [[2, 6], [80, 4], [139, 4], [209, 5]];
  const pending = plan.filter((e) => e.at > 0.5);
  let sweepDone = 0;
  for (const ev of pending) {
    const wait = ev.at - elapsed();
    if (wait > 0) await sleep(wait * 1000);
    applyEvent(ev, false).catch((e) => console.error(`  切换失败@${fmt(ev.at)}:`, e.message));
  }
  // 鼠标扫动（与切图并行）
  (async () => {
    while (sweepDone < SWEEPS.length) {
      const [at, dur] = SWEEPS[sweepDone];
      const wait = at - elapsed();
      if (wait > 0) await sleep(wait * 1000);
      console.log(`  🖱 扫鼠标 ${dur}s @ ${fmt(at)}`);
      sweep(dur);
      sweepDone += 1;
    }
  })();

  // 等歌结束
  while (elapsed() < DUR + 1.5) await sleep(500);
  cue('歌曲结束，停录');
  console.log((await obs('stop')).trim());

  // ---- 4) 还原 ----
  await cmd(MAIN, 'set-profile', { albumId: albumH, fit: orig.fit });
  cue(`配置已还原（album=横屏, fit=${orig.fit}；flowStyle 未动）`);

  // ---- 5) 字幕 ----
  writeSubs();
  cue('字幕已生成：tools/out/demo-music.ass + .srt');
  console.log('\n完成。');
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });

function tag2(ev) { return `${ev.album === 'v' ? '竖' : '横'}#${ev.album === 'v' ? ev.vIdx : ev.hIdx}`; }

/** 生成 ASS（歌词底部 + 左上角功能介绍）与 SRT */
function writeSubs() {
  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const ts = (s) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.round((s % 1) * 100)).padStart(2, '0')}`;
  // ASS 事件：歌词（Lyr，底部）+ 每相簿段的左上角标签（Info）
  const ev = [];
  for (const L of LRC.lines) ev.push(`Dialogue: 0,${ts(L.t)},${ts(Math.min(L.end, L.t + 12))},Lyr,,0,0,0,,${L.text}`);
  // 标签段：横屏（每行歌词区间合并）与竖屏（间奏区间）
  let prevEnd = 0, curLabel = null, segStart = 0;
  const flush = (end) => { if (curLabel) ev.push(`Dialogue: 0,${ts(segStart)},${ts(end)},Info,,0,0,0,,${curLabel}`); };
  const labelOf = (t) => (inVertical(t) ? '竖屏相簿 · 拼接填充 · 镜头环绕' : '横屏相簿 · 深度视差 · 镜头环绕');
  for (const L of LRC.lines) {
    const lab = labelOf(L.t);
    if (lab !== curLabel) { flush(L.t); curLabel = lab; segStart = L.t; }
  }
  flush(DUR);
  const ass = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 2560', 'PlayResY: 1440', '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    'Style: Lyr,Microsoft YaHei,64,&H00FFFFFF,&H00101010,&H7F000000,1,1,3,1,2,80,80,64,1',
    'Style: Info,Microsoft YaHei,40,&H00FFFFFF,&H00101010,&H7F000000,1,1,3,1,7,60,60,50,1',
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...ev,
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'demo-music.ass'), ass, 'utf8');
  // SRT：歌词为主（剪映导入用）
  const srt = (x) => `${String(Math.floor(x / 3600)).padStart(2, '0')}:${String(Math.floor((x % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(x % 60)).padStart(2, '0')},${String(Math.round((x % 1) * 1000)).padStart(3, '0')}`;
  const srtTxt = LRC.lines.map((L, i) => `${i + 1}\n${srt(L.t)} --> ${srt(Math.min(L.end, L.t + 12))}\n${L.text}\n`).join('\n');
  fs.writeFileSync(path.join(outDir, 'demo-music.srt'), srtTxt, 'utf8');
}
