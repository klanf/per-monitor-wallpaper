'use strict';

/**
 * depthModel 单测（r88）：stub 掉 electron.app，验证 status 三态判定
 * （仓库在位 / userData 下载落点 / 断点续传现场）与 URL 白名单。
 * 网络层本身（downloadToFile/Range 续传/sha256）由 test-updater.js 覆盖，不在此重复。
 */

const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ---- electron stub：app.getPath('userData') → 临时目录 ----
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-depthmodel-'));
const origLoad = Module._load;
Module._load = function stubbedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: (name) => (name === 'userData' ? tmpUserData : '') } };
  }
  return origLoad.apply(this, arguments);
};
const depthModel = require('../src/depthModel.js');
Module._load = origLoad;

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? `   ${extra}` : ''}`); }
}

// ---- status：仓库模型在位（开发机实况）----
const st1 = depthModel.status();
check('仓库模型在位 → available + 体积精确匹配',
  st1.available === true && st1.path.endsWith(depthModel.DEPTH_MODEL.file) && !st1.path.startsWith(tmpUserData));

// ---- 临时隐藏仓库候选（改名，try/finally 必还原）—— 打包布局模拟，
// 覆盖 userData 的四态：无文件 / 半截续传现场 / 坏体积 / 命中 ----
const partial = path.join(depthModel.userModelDir(), depthModel.DEPTH_MODEL.file);
const repoFile = path.join(__dirname, '..', 'models', 'depth-anything', depthModel.DEPTH_MODEL.file);
const repoHidden = `${repoFile}.test-hidden`;
fs.mkdirSync(depthModel.userModelDir(), { recursive: true });
fs.renameSync(repoFile, repoHidden);
try {
  const st0 = depthModel.status();
  check('两处皆无 → not available 且报下载目录', st0.available === false && st0.partialBytes === 0 && st0.dir === depthModel.userModelDir());

  fs.writeFileSync(partial, Buffer.alloc(1000));
  const st2 = depthModel.status();
  check('半截文件 → not available 且报 partialBytes（续传现场）',
    st2.available === false && st2.partialBytes === 1000 && st2.expectedSize === depthModel.DEPTH_MODEL.size,
    JSON.stringify(st2));

  fs.writeFileSync(partial, Buffer.alloc(depthModel.DEPTH_MODEL.size - 7));
  const stBad = depthModel.status();
  check('体积差 7 字节的文件不被认作可用（坏文件保护）', stBad.available === false, JSON.stringify(stBad));

  fs.writeFileSync(partial, Buffer.alloc(depthModel.DEPTH_MODEL.size));
  const stGood = depthModel.status();
  check('userData 文件体积匹配 → available 指向 userData', stGood.available === true && stGood.path === partial);
} finally {
  fs.rmSync(partial, { force: true });
  fs.renameSync(repoHidden, repoFile);   // 必还原
}
check('仓库模型已还原在位', fs.existsSync(repoFile));

// ---- URL 白名单（锚点 URL 本身必须放行）----
const ok1 = [depthModel.DEPTH_MODEL.url,
  'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx',
  'https://cdn-lfs.hf-mirror.com/x', 'https://huggingface.co/a/b', 'https://cdn-lfs.huggingface.co/y',
  'https://cas-bridge.xethub.hf.co/xet-bridge-us/63005b58?Expires=1&Signature=x'];
const bad1 = ['http://hf-mirror.com/x', 'https://evil.com/a', 'https://hf-mirror.com.evil.com/x',
  'https://cas-bridge.xethub.hf.co.evil.com/y'];
check('白名单放行锚点 URL 与 hf-mirror/huggingface 系', ok1.every((u) => depthModel.__testAllowedUrl(u)));
check('白名单拒绝 http/外域/仿冒域', bad1.every((u) => !depthModel.__testAllowedUrl(u)));

// ---- 锚点完整性：官方包内即此文件，SHA256/体积不许漂 ----
check('锚点体积 = 99,060,839B（r36 下载版，官方包同源）', depthModel.DEPTH_MODEL.size === 99060839);
check('锚点 SHA256 = afb6a5c2…（本机实文件复核值）',
  depthModel.DEPTH_MODEL.sha256 === 'afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c');

// ---- busy 互斥 ----
check('cancel 未在下载时静默无副作用', depthModel.cancel() === undefined);

fs.rmSync(tmpUserData, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
