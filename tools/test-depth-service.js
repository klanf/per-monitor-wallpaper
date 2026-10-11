'use strict';

/**
 * 深度引擎 worker 线程的单测（r33，`npm run verify:depth`）。
 *
 * r33 把 onnxruntime-node + sharp 从主进程挪进 worker 线程 —— 根因是
 * ort 的 session.run/loadModel 是同步原生调用，留在主进程会把右键删除/
 * 调度器定时器全部卡住（真机实锤 delete 入口到补写下一张 4.5s）。这条
 * 测试锁住两件事：
 *   ① 协议回路：worker 拉起 → probe 消息 → 结果落定（坏模型路径也要给
 *      出明确 reason，而不是挂死/崩溃）；
 *   ② 真跑一单（需要本机有 ONNX 模型）：lookup miss → 入队 → worker 生成
 *      → onReady → 二次 lookup 命中；生成期间主线程事件循环延迟必须远小于
 *      推理耗时（worker 化的全部意义，旧版进程内跑这一条必挂）。
 *
 * 模型不存在（干净机器/CI）时 ② 显式 SKIP，不装失败。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;
let skip = 0;
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else if (ok === null) { skip += 1; console.log(`  - ${label}  (跳过：${detail})`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}
check.skip = (label, detail) => check(label, null, detail);

const MODEL = path.join(ROOT, 'models', 'depth-anything', 'depth_anything_v2_small.onnx');

async function main() {
  console.log('── ① worker 线程协议回路（坏模型路径 → 明确失败，不挂死）');
  {
    const { Worker } = require('node:worker_threads');
    const r = await new Promise((resolve) => {
      const w = new Worker(path.join(ROOT, 'src', 'depthEngineWorker.js'));
      const timer = setTimeout(() => resolve({ ok: false, reason: '(测试) probe 15s 无响应' }), 15000);
      w.on('message', (msg) => {
        if (msg && msg.type === 'probe-result') { clearTimeout(timer); resolve(msg); }
      });
      w.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, reason: `error: ${err.message}` }); });
      w.postMessage({ type: 'probe', seq: 1, onnxModel: path.join(os.tmpdir(), '不存在的模型.onnx') });
      w.unref();
    });
    check('probe-result 对坏模型返回 ok=false', r && r.ok === false, String(r && r.reason || '').slice(0, 80));
    check('失败带得出原因（不是空串）', Boolean(r && r.reason), '');
  }

  console.log('── ② depthService 全链路（真模型 + 真生成 + 主线程不阻塞）');
  if (!fs.existsSync(MODEL)) {
    check.skip('真模型生成链路', `模型不存在：${MODEL}`);
  } else {
    const depthService = require(path.join(ROOT, 'src', 'depthService'));
    const sharp = require(path.join(ROOT, 'node_modules', 'sharp'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-depth-test-'));
    const imgPath = path.join(cacheDir, 'src.png');
    // 512×320 渐变图：够模型吃，生成快，且深度图必然非平凡
    await sharp({ create: { width: 512, height: 320, channels: 3, background: { r: 30, g: 90, b: 200 } } })
      .composite([{
        input: Buffer.from(`<svg width="512" height="320"><circle cx="256" cy="160" r="120" fill="white"/></svg>`),
      }]).png().toFile(imgPath);

    const done = new Promise((resolve) => {
      depthService.configure({
        appRoot: ROOT,
        onnxModel: MODEL,
        cacheDir,
        depthDevice: 'gpu',
        onReady: () => resolve('ready'),
      });
      // 兜底：90s 内没回调就放行，让下面的断言去暴露问题
      setTimeout(() => resolve('timeout'), 90000).unref();
    });

    // 事件循环延迟监视：worker 化之前，DML 86ms/张、CPU 450ms/张 + dilate
    // 全部同步占主线程，这段监视的最大延迟≈单张耗时；worker 化后应 <50ms。
    let maxLag = 0;
    let last = Date.now();
    const monitor = setInterval(() => {
      const now = Date.now();
      maxLag = Math.max(maxLag, now - last - 5);
      last = now;
    }, 5);

    const first = depthService.lookup(imgPath);
    check('首查未命中（返回 null 并入队后台生成）', first === null);

    const how = await done;
    clearInterval(monitor);
    check('生成完成回调触发（onReady）', how === 'ready', how === 'timeout' ? '90s 超时' : '');
    check('生成期间主线程事件循环无感（最大延迟<120ms）', maxLag < 120, `实测 ${maxLag}ms（worker 化前应为推理耗时量级）`);

    const second = depthService.lookup(imgPath);
    check('二查命中缓存（返回深度图路径）', typeof second === 'string' && fs.existsSync(second), String(second || '').slice(-40));
    check('深度图是真 PNG（魔数校验）', (() => {
      try { return fs.readFileSync(second).subarray(1, 4).toString('ascii') === 'PNG'; } catch { return false; }
    })());

    depthService.shutdown();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败 / ${skip} 跳过`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('测试异常退出:', err);
  process.exit(1);
});
