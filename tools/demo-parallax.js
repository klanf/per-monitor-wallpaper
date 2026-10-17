'use strict';

/**
 * 深度视差演示驱动（配合 OBS 录屏 · docs/视频文案-深度视差.md 镜 2/3/4/5）。
 *
 * 用法（三步）：
 *   1) 关掉现有壁纸实例，带调试端口重启（CMD，项目根目录）：
 *        node_modules\.bin\electron.cmd . --wp-user-data=D:/workbuddy/projects/electron-wallpaper/wp-live-userdata --remote-debugging-port=9222
 *      （或 python tools/run-electron.py 不行——它不透传端口参数；直接用上面命令，另开窗口跑）
 *   2) OBS 开好（显示器捕获=放壁纸那块屏，60fps，音频 AAC）
 *   3) 本机另开终端：
 *        node tools/demo-parallax.js                # 全程（镜2→3→4→5，约 4 分钟）
 *        node tools/demo-parallax.js --from=4       # 只跑镜 4 起某几段（2/3/4/5）
 *        node tools/demo-parallax.js --sweep=6      # 单独扫鼠标 6 秒（自由补镜头）
 *
 * 脚本做什么：
 *   - CDP 连 9222 驱动应用 UI（开关面板/选轨迹/下一张/读状态行）
 *   - koffi SendInput 真实移动系统光标扫过桌面（触发射线/pointer 接管镜头）
 *   - 每个节拍前在终端打大字提示（对应用哪段口播），操作人只管看提示控制 OBS 起停
 *
 * ⚠ 镜 5（主屏开/副屏关）只做主屏侧动作；双屏取景构图请按文案手动摆。
 */

const fs = require('node:fs');
const path = require('node:path');

const CDP_LIST = process.env.DEMO_CDP_LIST || 'http://127.0.0.1:9222/json';

// ---- 参数 ----
const argv = process.argv.slice(2);
const argValue = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 2)) : dflt;
};
const FROM = argValue('from', 2);
const TO = argValue('to', 5);
const SWEEP_ONLY = argv.some((a) => a.startsWith('--sweep='));
const SWEEP_SEC = argValue('sweep', 6);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cue = (msg) => {
  console.log('\n==================================================');
  console.log('▶ ' + msg);
  console.log('==================================================\n');
  fs.writeSync(1, ''); // 立即冲缓冲，别让提示迟到
};

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
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败（应用是否带 --remote-debugging-port=9222 启动？）')));
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

// ---- UI 动作（页面侧 JS 片段）----
const ui = {
  openPanelLook: `(() => {
    const p = document.getElementById('settings');
    p.classList.add('open'); p.setAttribute('aria-hidden', 'false');
    document.querySelector('.settings-tab[data-tab="look"]')?.click();
    document.getElementById('field-depth')?.scrollIntoView({ block: 'start' });
    return true;
  })()`,
  closePanel: `(() => {
    const p = document.getElementById('settings');
    p.classList.remove('open'); p.setAttribute('aria-hidden', 'true');
    return true;
  })()`,
  focusDepthField: `(() => {
    const f = document.getElementById('field-depth');
    f.scrollIntoView({ block: 'center' });
    f.style.outline = '2px solid #4da3ff'; f.style.outlineOffset = '4px'; f.style.borderRadius = '8px';
    return true;
  })()`,
  unfocusDepthField: `(() => {
    const f = document.getElementById('field-depth');
    if (f) { f.style.outline = ''; f.style.outlineOffset = ''; }
    return true;
  })()`,
  nextImage: `(() => { document.getElementById('btn-next')?.click(); return true; })()`,
  statusText: `(() => (document.getElementById('depth-status')?.textContent || ''))()`,
  setFlowStyle: (v) => `(() => {
    const s = document.getElementById('cfg-flow-style');
    if (!s) return false;
    s.value = '${v}';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`,
};

// ---- 真实光标（koffi SendInput，绝对坐标 0..65535 归一化到主屏）----
function makeCursor() {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const SendInput = user32.func('int __stdcall SendInput(int, INPUT *, int)');
  const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int)');
  const W = GetSystemMetrics(0), H = GetSystemMetrics(1); // 主屏
  const INPUT_SIZE = 40; // INPUT(x64) = 24+8+8？实测 40 对 win64 SendInput 稳定
  const sweep = async (sec, style) => {
    const t0 = Date.now();
    let i = 0;
    while ((Date.now() - t0) / 1000 < sec) {
      const t = (Date.now() - t0) / 1000;
      let fx, fy; // 0..1
      if (style === 'h') { // 横向正弦扫
        fx = 0.5 + 0.33 * Math.sin(t * 2 * Math.PI / (sec / 2));
        fy = 0.45 + 0.05 * Math.sin(t * 1.1);
      } else { // 'v' 纵向为主
        fy = 0.5 + 0.3 * Math.sin(t * 2 * Math.PI / (sec / 2));
        fx = 0.5 + 0.06 * Math.sin(t * 0.9);
      }
      const x = Math.round((W * fx) / W * 65535);
      const y = Math.round((H * fy) / H * 65535);
      const buf = Buffer.alloc(INPUT_SIZE);
      buf.writeUInt32LE(0, 0);          // type = INPUT_MOUSE
      buf.writeInt32LE(0x8000 | 0x0001, 4); // MOUSEEVENTF_MOVE|ABSOLUTE
      buf.writeInt32LE(x, 8); buf.writeInt32LE(y, 12);
      SendInput(1, buf, INPUT_SIZE);
      await sleep(16); // ~60Hz
      i++;
    }
  };
  return { sweep, W, H };
}

// ---- 等状态行「生成中 → 就绪」----
async function waitDepthReady(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = await evaluate(ui.statusText);
    if (t && t.includes('就绪')) return t;
    await sleep(400);
  }
  return null;
}

// ---- 节拍 ----
async function beat2() { // 镜 2：设置里看开关/轨迹 + 桌面视差
  cue('镜 2（01:05–01:45）｜口播「这就是它干的事，叫深度视差…」｜OBS 开始录');
  await evaluate(ui.openPanelLook);
  await evaluate(ui.focusDepthField);
  cue('  画面：设置面板 → 外观 → 深度视差区（蓝色框重点），停 10 秒');
  await sleep(10000);
  await evaluate(ui.unfocusDepthField);
  await evaluate(ui.closePanel);
  cue('  画面：回到桌面，鼠标自动横向扫 8 秒（前后景拉开）');
  await cursor.sweep(8, 'h');
  cue('  ✔ 镜 2 素材完成，OBS 可分段');
}

async function beat3() { // 镜 3：状态行 + 现场推理
  cue('镜 3（01:45–02:15）｜口播「关键它不麻烦…」｜OBS 开始录');
  await evaluate(ui.openPanelLook);
  await evaluate(`document.getElementById('depth-status')?.scrollIntoView({ block: 'center' })`);
  const st = await evaluate(ui.statusText);
  cue(`  画面：状态行特写（当前：${(st || '(空)').slice(0, 60)}），停 6 秒`);
  await sleep(6000);
  cue('  画面：点「下一张」换一张新图 → 状态行 生成中→就绪，桌面现场切视差');
  await evaluate(ui.nextImage);
  const ok = await waitDepthReady(45000);
  cue(`  状态行：${ok ? ok.slice(0, 80) : '（45s 内未见「就绪」，检查引擎）'}`);
  await sleep(4000);
  await evaluate(ui.closePanel);
  cue('  画面：桌面视差确认，鼠标扫 6 秒');
  await cursor.sweep(6, 'h');
  cue('  ✔ 镜 3 素材完成');
}

async function beat4() { // 镜 4：三种镜头轨迹
  cue('镜 4（02:15–02:50）｜口播「动法也不止一种…」｜OBS 开始录');
  const styles = [
    ['circle', '环绕 circle（被轻轻推着转）'],
    ['orbital', '公转 orbital（摆动更大）'],
    ['dolly', '推拉 dolly（纵深拉近拉远）'],
  ];
  for (const [v, label] of styles) {
    await evaluate(ui.openPanelLook);
    await evaluate(`document.getElementById('cfg-flow-style')?.scrollIntoView({ block: 'center' })`);
    await evaluate(ui.setFlowStyle(v));
    cue(`  轨迹：${label} —— 面板停 3 秒后收起，鼠标扫 4 秒`);
    await sleep(3000);
    await evaluate(ui.closePanel);
    await cursor.sweep(4, 'h');
  }
  cue('  ✔ 镜 4 素材完成（三种各一段，后期做三格对比卡）');
}

async function beat5() { // 镜 5：主屏开（顶栏快捷开关位置展示）
  cue('镜 5（02:50–03:15）｜口播「支持多屏…只给主屏开」｜双屏取景请手动构图');
  await evaluate(ui.openPanelLook);
  await evaluate(`document.getElementById('qt-depth')?.scrollIntoView({ block: 'center' })`);
  cue('  画面：顶栏快捷开关区（qt-depth 每屏独立），停 8 秒');
  await sleep(8000);
  await evaluate(ui.closePanel);
  cue('  画面：桌面确认（本脚本不代切副屏——副屏开关请按文案手动点）');
  await cursor.sweep(5, 'h');
  cue('  ✔ 镜 5 素材完成');
}

// ---- main ----
(async () => {
  let targets;
  try { targets = await (await fetch(CDP_LIST)).json(); }
  catch { throw new Error('连不上 9222 —— 应用要带 --remote-debugging-port=9222 启动（见文件头注释）'); }
  const page = targets.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
  if (!page) throw new Error('没找到设置窗口页面（index.html）');
  cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable', {});

  if (SWEEP_ONLY) {
    const cursor = makeCursor();
    cue(`单独扫鼠标 ${SWEEP_SEC} 秒`);
    await cursor.sweep(SWEEP_SEC, 'h');
    return;
  }

  globalThis.cursor = makeCursor();
  const cursor = globalThis.cursor;
  cue(`演示开始：镜 ${FROM}→${TO}。主屏 ${cursor.W}x${cursor.H}，光标将真实移动。`);
  await sleep(3000);
  if (FROM <= 2 && TO >= 2) await beat2();
  if (FROM <= 3 && TO >= 3) await beat3();
  if (FROM <= 4 && TO >= 4) await beat4();
  if (FROM <= 5 && TO >= 5) await beat5();
  // 收尾：轨迹还原 circle、面板收起
  await evaluate(ui.openPanelLook);
  await evaluate(ui.setFlowStyle('circle'));
  await evaluate(ui.closePanel);
  cue('全部节拍完成，轨迹已还原 circle。');
})().catch((e) => { console.error('✖ ' + e.message); process.exit(1); });
