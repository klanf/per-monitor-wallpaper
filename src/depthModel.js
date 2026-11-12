'use strict';

/**
 * 深度模型按需下载（r88）：depth_anything_v2_small.onnx（99MB）不进 git
 * （models/ 目录整体 gitignore），官方安装包经 extraResources 带模型，
 * 但源码自打包 / 精简分发装出来的包没有 —— Gitee issue IKQ6OH。
 * 本模块让应用在「ONNX 缺失」时从公开模型源自助补齐，复用 segModel（r73）
 * 的成熟链路：hf-mirror 直拉（Range 断点续传 + SHA256 锚点 + 重试）→ 落
 * userData → configure 全新探测自动恢复视差。
 *
 * 模型源锚点：HF 公开 onnx-community/depth-anything-v2-small fp32
 * （onnx/model.onnx，99,060,839B）。r36 对拍实锤与自导出 ONNX 逐像素等价
 * （CORR=1.0000 / MAD=0.0/255，同 contract：predicted_depth [1,392,700]），
 * 且 0.2.1 起官方安装包内就是这份文件（sha256 afb6a5c2...）。
 *
 * 模型候选顺序（depthService.resolveRuntime 经 configure 注入 userModelDir）：
 *   1. 打包布局 resources\models\depth-anything\（extraResources 产物）
 *   2. 仓库 models/depth-anything/（开发机；打包布局下不存在）
 *   3. userData/models/depth-anything/（本模块下载落点，写权限无虞）
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');
const { downloadToFile, sha256File } = require('./updater');

/** 模型锚点：hf-mirror onnx-community 仓库原文件（2026-11-12 线上实测 + 本机 SHA 复核）。 */
const DEPTH_MODEL = {
  file: 'depth_anything_v2_small.onnx',
  size: 99060839,
  sha256: 'afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c',
  url: 'https://hf-mirror.com/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx',
};

/** 只放行模型下载相关 host。⚠️ hf-mirror 对 LFS 文件 302 到 cas-bridge.xethub.hf.co
 * （Xet CDN，签名 URL），白名单必须带 .hf.co 尾缀 —— r73 实测漏了它下载永远被拒。 */
function allowedModelUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  return url.hostname === 'hf-mirror.com' || url.hostname.endsWith('.hf-mirror.com')
    || url.hostname === 'huggingface.co' || url.hostname.endsWith('.huggingface.co')
    || url.hostname === 'hf.co' || url.hostname.endsWith('.hf.co');
}

let busy = false;
let cancelRequested = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 开发机仓库内模型（打包布局下该路径不存在，仅 dev 生效）。 */
function repoModelPath() {
  return path.join(__dirname, '..', 'models', 'depth-anything', DEPTH_MODEL.file);
}

/** 下载落点：userData/models/depth-anything/（写权限无虞，卸载随 userData 走）。 */
function userModelDir() {
  return path.join(app.getPath('userData'), 'models', 'depth-anything');
}

function userModelPath() {
  return path.join(userModelDir(), DEPTH_MODEL.file);
}

/**
 * 模型状态探测（状态行按钮用）。
 * available 判定用「体积精确匹配」—— 99MB 全量 SHA256 要 1s+，每次刷新都算太重；
 * 下载完成时的全量哈希兜住「体积对但内容坏」的窗口。
 */
function status() {
  for (const p of [repoModelPath(), userModelPath()]) {
    let st = null;
    try { st = fs.statSync(p); } catch { /* 无此候选 */ }
    if (st && st.isFile() && st.size === DEPTH_MODEL.size) {
      return { available: true, path: p };
    }
  }
  // 断点续传现场：上次下了一半的文件还在
  let partialBytes = 0;
  try { partialBytes = fs.statSync(userModelPath()).size; } catch { /* 没下过 */ }
  return { available: false, partialBytes, expectedSize: DEPTH_MODEL.size, dir: userModelDir() };
}

/**
 * 下载（含 3 次重试 + SHA256 校验）。取消 = onProgress 抛错中断流，
 * 半截文件留在原地（断点续传，下次接着传）。
 * @returns {Promise<{ok: boolean, path: string}>}
 */
async function download({ onStage = () => {}, onProgress = () => {} } = {}) {
  if (busy) throw new Error('已有模型下载在进行');
  busy = true;
  cancelRequested = false;
  const dest = userModelPath();
  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (cancelRequested) throw new Error('下载已取消');
      try {
        await downloadToFile(DEPTH_MODEL.url, dest, DEPTH_MODEL.size, {
          allowedUrl: allowedModelUrl,
          timeoutMs: 60_000,
          onProgress: (bytes) => {
            if (cancelRequested) throw new Error('下载已取消');
            onProgress(bytes);
          },
        });
        lastErr = null;
        break;
      } catch (err) {
        if (cancelRequested) throw new Error('下载已取消');
        lastErr = err;
        if (attempt < 3) onStage(`下载中断（${err.message}），5 秒后自动重试（第 ${attempt + 1}/3 次）`);
        await sleep(5000);
      }
    }
    if (lastErr) throw lastErr;
    onStage('校验文件完整性…');
    const hash = await sha256File(dest);
    if (hash !== DEPTH_MODEL.sha256) {
      await fsp.rm(dest, { force: true }).catch(() => {});
      throw new Error('SHA256 校验不通过（坏文件已删除，可重试下载）');
    }
    return { ok: true, path: dest };
  } finally {
    busy = false;
    cancelRequested = false;
  }
}

/** 请求取消进行中的下载（半截文件保留，支持续传）。 */
function cancel() {
  if (busy) cancelRequested = true;
}

module.exports = { DEPTH_MODEL, status, download, cancel, userModelDir, userModelPath, repoModelPath, __testAllowedUrl: allowedModelUrl };
