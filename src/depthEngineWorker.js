'use strict';

/**
 * depthEngineWorker —— 深度引擎的 worker 线程入口（r33）。
 *
 * 为什么必须挪出主进程：onnxruntime-node 的 `session.run()` 是**同步原生调用**
 * （binding 里只是 setImmediate 包了一层，推理照样占死 JS 主线程），`loadModel`
 * （建会话）更是纯同步 —— DML 86ms/张、CPU 450ms/张、会话冷建 1.4~2.7s，期间
 * 主进程所有事情全部停摆：桌面右键菜单的 second-instance 转发、删除确认框、
 * 调度器定时器、全部 IPC 都在排队（r33 真机日志实锤：delete 入口到补写下一张
 * 卡了 4.5s，两块屏的 30s 定时器同拍迟到）。搬进 worker 线程后，推理/建会话
 * 阻塞的是 worker 自己的事件循环，主进程只收发消息，永远不被卡。
 *
 * 附带收益：onnxruntime-node + sharp 从此只在 worker 里 require，主进程不再
 * 加载任何推理原生模块 —— r31「退出时原生线程池收不干净导致 relaunch 挂死」
 * 的根因整体消失（main.js 的 taskkill 引信保留当保险）。
 *
 * 协议（parentPort 消息，全部 {type, seq, ...}）：
 *   → { type:'probe',      seq, onnxModel }            可用性探测（require 依赖 + 模型存在）
 *   ← { type:'probe-result', seq, ok, reason? }
 *   → { type:'generate',   seq, onnxModel, depthDevice, job }   job 契约与 Python worker 一致
 *   ← { type:'job-result', seq, ok, error? }
 *   → { type:'configure',  depthDevice }                设备偏好变更：worker 内释放旧会话
 *   → { type:'release' }                                闲时释放：关会话省显存，线程留着热复用
 *
 * 模型路径随 generate 下发而不是只在 probe 时给一次：任务超时后 depthService
 * 会 terminate 整个线程，下一个任务在全新线程里先自举 probe 再干活。
 */

const { parentPort } = require('node:worker_threads');
const engineJs = require('./depthEngineJs');

async function handle(msg) {
  if (msg.type === 'probe') {
    let out;
    try {
      const r = await engineJs.probe(msg.onnxModel);
      out = { ok: Boolean(r.ok), reason: r.reason };
    } catch (err) {
      out = { ok: false, reason: `probe 异常: ${err.message}` };
    }
    parentPort.postMessage({ type: 'probe-result', seq: msg.seq, ...out });
    return;
  }

  if (msg.type === 'generate') {
    let ok = false;
    let error = '';
    try {
      // 设备偏好随任务下发：ensureSession 建会话前必须就位（切设备=释放旧会话下张重建）
      engineJs.configure({ depthDevice: msg.depthDevice });
      if (!engineJs.isReady()) {
        const r = await engineJs.probe(msg.onnxModel);
        if (!r.ok) throw new Error(r.reason || 'JS 引擎不可用');
      }
      await engineJs.generate(msg.job);
      ok = true;
    } catch (err) {
      error = (err && err.message) || String(err);
    }
    parentPort.postMessage({ type: 'job-result', seq: msg.seq, ok, error });
    return;
  }

  if (msg.type === 'configure') {
    try { engineJs.configure({ depthDevice: msg.depthDevice }); } catch (_) { /* 偏好记录失败无碍 */ }
    return;
  }

  if (msg.type === 'release') {
    try { engineJs.close(); } catch (_) { /* 已释放 */ }
  }
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg.type !== 'string') return;
  handle(msg).catch(() => { /* handle 内部已兜底，这里防意外抛出拖死 worker */ });
});
