'use strict';

/**
 * OBS 遥控（obs-websocket v5）—— 深度视差演示录屏专用。
 *
 * 用法（项目根目录）：
 *   node tools/obs-control.js setup            # 建两个场景：录-主屏 / 录-双屏（复用已有显示器采集源）
 *   node tools/obs-control.js main             # 切主屏布局（画布 2560x1440）
 *   node tools/obs-control.js dual             # 切双屏拼接布局（画布 4160x2560，主屏右/竖屏左，输出 2080x1280）
 *   node tools/obs-control.js start            # 开录
 *   node tools/obs-control.js stop             # 停录（打印输出文件路径）
 *   node tools/obs-control.js status           # 当前场景/录制状态/画布
 *
 * 密码：--pass=xxx 或环境变量 OBS_WS_PASS（不写进任何文件）。
 *
 * 录一段完整流程示例（镜 2，主屏）：
 *   node tools/obs-control.js main
 *   node tools/obs-control.js start
 *   node tools/demo-parallax.js --from=2 --to=2
 *   node tools/obs-control.js stop
 */

const crypto = require('node:crypto');

const argv = process.argv.slice(2);
const argValue = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const PASS = argValue('pass', process.env.OBS_WS_PASS || '');
const CMD = argv.find((a) => !a.startsWith('--')) || 'status';

// 主屏实测 2560x1440（GetSystemMetrics）；副竖屏 1600x2560，虚拟桌面外接矩形 4160x2560
const GEO = {
  mainW: 2560, mainH: 1440,
  dualW: 4160, dualH: 2560,
  portraitW: 1600, // 副屏在左（x=0），主屏 x=1600
};
const SCENE_MAIN = '录-主屏';
const SCENE_DUAL = '录-双屏';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connectObs(pass) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:4455');
    const pending = new Map();
    let seq = 0;
    let timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('OBS 连接超时（obs64 在跑吗？4455 开吗？）')); }, 6000);
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('OBS WebSocket 连接失败')); });
    ws.addEventListener('close', (e) => {
      if (timer) { clearTimeout(timer); reject(new Error(`OBS 连接被关闭（code=${e.code}）—— 密码错或认证被拒`)); }
    });
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.op === 0) { // Hello
        const auth = m.d.authentication;
        const identify = { op: 1, d: { rpcVersion: 1 } };
        if (auth) {
          if (!pass) { clearTimeout(timer); reject(new Error('OBS 设了 WebSocket 密码：--pass=xxx 或环境变量 OBS_WS_PASS 传入')); return; }
          const secret = crypto.createHash('sha256').update(pass + auth.salt).digest('base64');
          identify.d.authentication = crypto.createHash('sha256').update(secret + auth.challenge).digest('base64');
        }
        ws.send(JSON.stringify(identify));
        return;
      }
      if (m.op === 2) { // Identified
        clearTimeout(timer); timer = null;
        resolve({
          async call(type, data) {
            const id = `c${++seq}`;
            return new Promise((res, rej) => {
              pending.set(id, { res, rej });
              ws.send(JSON.stringify({ op: 6, d: { requestType: type, requestId: id, requestData: data || {} } }));
            });
          },
          close: () => ws.close(),
        });
        return;
      }
      if (m.op === 7 && pending.has(m.d.requestId)) {
        const { res, rej } = pending.get(m.d.requestId);
        pending.delete(m.d.requestId);
        const { requestStatus, requestData } = m.d;
        if (!requestStatus.result) rej(new Error(`${requestStatus.comment || 'OBS 请求失败'}`));
        else res(m.d.responseData || {});
      }
    });
  });
}

// 显示器采集源探测：按名字识别（本机源就叫「横屏」「竖屏」），名字认不出再按顺序兜底
async function findDisplayInputs(obs) {
  const { inputs } = await obs.call('GetInputList', { inputKind: 'monitor_capture' });
  const out = inputs.map((i) => ({ name: i.inputName, isMain: /横/.test(i.inputName), isPortrait: /竖/.test(i.inputName) }));
  return out;
}

async function ensureScene(obs, name) {
  const { scenes } = await obs.call('GetSceneList');
  if (!scenes.some((s) => s.sceneName === name)) await obs.call('CreateScene', { sceneName: name });
}

async function sceneItemId(obs, scene, sourceName) {
  const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: scene });
  const hit = sceneItems.find((it) => it.sourceName === sourceName);
  return hit ? hit.sceneItemId : null;
}

async function addSourceToScene(obs, scene, sourceName, pos, scale) {
  let id = await sceneItemId(obs, scene, sourceName);
  if (id === null) {
    await obs.call('CreateSceneItem', { sceneName: scene, sourceName, sceneItemEnabled: true });
    id = await sceneItemId(obs, scene, sourceName);
  }
  if (pos || scale) {
    const t = {};
    if (pos) { t.positionX = pos.x; t.positionY = pos.y; }
    if (scale) { t.scaleX = scale; t.scaleY = scale; }
    await obs.call('SetSceneItemTransform', { sceneName: scene, sceneItemId: id, sceneItemTransform: t });
  }
  return id;
}

async function setVideo(obs, layout) {
  const req = layout === 'dual'
    ? { baseWidth: 2080, baseHeight: 1280, outputWidth: 2080, outputHeight: 1280, fpsNumerator: 60, fpsDenominator: 1 }
    : { baseWidth: GEO.mainW, baseHeight: GEO.mainH, outputWidth: GEO.mainW, outputHeight: GEO.mainH, fpsNumerator: 60, fpsDenominator: 1 };
  await obs.call('SetVideoSettings', req);
  await obs.call('SetCurrentProgramScene', { sceneName: layout === 'dual' ? SCENE_DUAL : SCENE_MAIN });
}

(async () => {
  const obs = await connectObs(PASS);
  const show = (msg) => console.log('✔ ' + msg);

  if (CMD === 'setup') {
    const disp = await findDisplayInputs(obs);
    if (!disp.length) throw new Error('没找到显示器采集源 —— 先在 OBS 手动加两个「显示器采集」，再跑 setup');
    show(`已有采集源：${disp.map((d) => d.name + (d.isMain ? '(主)' : d.isPortrait ? '(副)' : '')).join(', ')}`);
    const mainSrc = (disp.find((d) => d.isMain) || disp[0]).name;   // 「横屏」= 主屏
    const portraitSrc = disp.find((d) => d.isPortrait);
    await ensureScene(obs, SCENE_MAIN);
    await addSourceToScene(obs, SCENE_MAIN, mainSrc, { x: 0, y: 0 });
    await ensureScene(obs, SCENE_DUAL);
    // 副屏（竖屏）放左：0.5 缩放 = 800x1280 正好贴满画布高；主屏放右：0.5 缩放 = 1280x720 垂直居中
    if (portraitSrc) await addSourceToScene(obs, SCENE_DUAL, portraitSrc.name, { x: 0, y: 0 }, 0.5);
    await addSourceToScene(obs, SCENE_DUAL, mainSrc, { x: 800, y: 280 }, 0.5);
    show(`场景就绪：「${SCENE_MAIN}」（画布 2560x1440）、「${SCENE_DUAL}」（画布 2080x1280：竖屏 0.5x 左满高 / 主屏 0.5x 右侧居中）`);
    show('画布分辨率不在 setup 里改 —— 用 main / dual 命令在开录前切换。');
  } else if (CMD === 'main') {
    await setVideo(obs, 'main');
    show('已切「录-主屏」：画布/输出 2560x1440 @60fps');
  } else if (CMD === 'dual') {
    await setVideo(obs, 'dual');
    show('已切「录-双屏」：画布/输出 2080x1280 @60fps（竖屏 0.5x 左满高 / 主屏 0.5x 右侧居中）');
  } else if (CMD === 'start') {
    await obs.call('StartRecord');
    show('● 开录');
  } else if (CMD === 'stop') {
    const r = await obs.call('StopRecord');
    show(`■ 停录 → ${r.outputPath}`);
  } else if (CMD === 'status') {
    const s = await obs.call('GetRecordStatus');
    const v = await obs.call('GetVideoSettings');
    const c = await obs.call('GetCurrentProgramScene');
    show(`场景=${c.currentProgramSceneName}｜录制=${s.outputActive ? '进行中' : '空闲'}｜画布=${v.baseWidth}x${v.baseHeight}→输出${v.outputWidth}x${v.outputHeight}@${v.fpsNumerator / v.fpsDenominator}fps`);
  } else {
    throw new Error(`未知命令：${CMD}（setup/main/dual/start/stop/status）`);
  }
  await sleep(300);
  obs.close();
})().catch((e) => { console.error('✖ ' + e.message); process.exit(1); });
