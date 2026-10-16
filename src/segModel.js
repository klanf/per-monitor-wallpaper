'use strict';

/**
 * 分割模型按需下载（r73）：isnetis（176MB）不进安装包（对齐 tag-viewer WD14 的
 * 「安装包精简 + 使用时引导下载」模式）。开启双层视差时检测 → 渲染层遮罩弹窗 →
 * hf-mirror 直拉（Range 断点续传 + SHA256 锚点 + 重试）→ 落 userData。
 *
 * 模型候选顺序（depthEngineJs 同步消费，经 WP_SEG_MODELS_DIR 注入）：
 *   1. 仓库 models/segmentation/（开发机；打包布局下不存在）
 *   2. userData/models/segmentation/（本模块下载落点，写权限无虞）
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');
const { downloadToFile, sha256File } = require('./updater');

/** 模型锚点：hf-mirror skytnt/anime-seg 仓库原文件（2026-10-17 本地实测锚定）。 */
const SEG_MODEL = {
  file: 'isnetis.onnx',
  size: 176069933,
  sha256: 'f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99',
  url: 'https://hf-mirror.com/skytnt/anime-seg/resolve/main/isnetis.onnx',
};

/** 只放行模型下载相关 host。⚠️ hf-mirror 对 LFS 文件 302 到 cas-bridge.xethub.hf.co
 * （Xet CDN，签名 URL），白名单必须带 .hf.co 尾缀 —— 实测漏了它下载永远被拒。 */
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
  return path.join(__dirname, '..', 'models', 'segmentation', SEG_MODEL.file);
}

/** 下载落点：userData/models/segmentation/（写权限无虞，卸载随 userData 走）。 */
function userModelDir() {
  return path.join(app.getPath('userData'), 'models', 'segmentation');
}

function userModelPath() {
  return path.join(userModelDir(), SEG_MODEL.file);
}

/** 深度引擎 worker 的模型目录候选（main 启动时注入 env）。 */
function modelDirs() {
  return [path.dirname(repoModelPath()), userModelDir()];
}

/**
 * 模型状态探测（不弹窗，qtDual 开启方向调用）。
 * available 判定用「体积精确匹配」—— 176MB 全量 SHA256 要 1s+，每次开启都算太重；
 * 下载完成时的全量哈希兜住「体积对但内容坏」的窗口。
 */
function status() {
  for (const p of [repoModelPath(), userModelPath()]) {
    let st = null;
    try { st = fs.statSync(p); } catch { /* 无此候选 */ }
    if (st && st.isFile() && st.size === SEG_MODEL.size) {
      return { available: true, path: p };
    }
  }
  // 断点续传现场：上次下了一半的文件还在
  let partialBytes = 0;
  try { partialBytes = fs.statSync(userModelPath()).size; } catch { /* 没下过 */ }
  return { available: false, partialBytes, expectedSize: SEG_MODEL.size, dir: userModelDir() };
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
        await downloadToFile(SEG_MODEL.url, dest, SEG_MODEL.size, {
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
    if (hash !== SEG_MODEL.sha256) {
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

module.exports = { SEG_MODEL, status, download, cancel, modelDirs, userModelDir, userModelPath, __testAllowedUrl: allowedModelUrl };
