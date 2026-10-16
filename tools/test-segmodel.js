'use strict';

/**
 * segModel 单测（r73）：stub 掉 electron.app，验证 status 三态判定
 * （仓库在位 / userData 下载落点 / 断点续传现场）与 URL 白名单。
 * 网络层本身（downloadToFile/Range 续传/sha256）由 test-updater.js 覆盖，不在此重复。
 */

const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ---- electron stub：app.getPath('userData') → 临时目录 ----
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-segmodel-'));
const origLoad = Module._load;
Module._load = function stubbedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: (name) => (name === 'userData' ? tmpUserData : '') } };
  }
  return origLoad.apply(this, arguments);
};
const segModel = require('../src/segModel.js');
Module._load = origLoad;

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? `   ${extra}` : ''}`); }
}

// ---- status：仓库模型在位（开发机实况）----
const st1 = segModel.status();
check('仓库模型在位 → available + 体积精确匹配',
  st1.available === true && st1.path.endsWith(segModel.SEG_MODEL.file) && !st1.path.startsWith(tmpUserData));

// ---- 临时隐藏仓库候选（改名，try/finally 必还原）—— 打包布局模拟，
// 覆盖 userData 的四态：无文件 / 半截续传现场 / 坏体积 / 命中 ----
const partial = path.join(segModel.userModelDir(), segModel.SEG_MODEL.file);
const repoFile = path.join(__dirname, '..', 'models', 'segmentation', segModel.SEG_MODEL.file);
const repoHidden = `${repoFile}.test-hidden`;
fs.mkdirSync(segModel.userModelDir(), { recursive: true });
fs.renameSync(repoFile, repoHidden);
try {
  const st0 = segModel.status();
  check('两处皆无 → not available 且报下载目录', st0.available === false && st0.partialBytes === 0 && st0.dir === segModel.userModelDir());

  fs.writeFileSync(partial, Buffer.alloc(1000));
  const st2 = segModel.status();
  check('半截文件 → not available 且报 partialBytes（续传现场）',
    st2.available === false && st2.partialBytes === 1000 && st2.expectedSize === segModel.SEG_MODEL.size,
    JSON.stringify(st2));

  fs.writeFileSync(partial, Buffer.alloc(segModel.SEG_MODEL.size - 7));
  const stBad = segModel.status();
  check('体积差 7 字节的文件不被认作可用（坏文件保护）', stBad.available === false, JSON.stringify(stBad));

  fs.writeFileSync(partial, Buffer.alloc(segModel.SEG_MODEL.size));
  const stGood = segModel.status();
  check('userData 文件体积匹配 → available 指向 userData', stGood.available === true && stGood.path === partial);
} finally {
  fs.rmSync(partial, { force: true });
  fs.renameSync(repoHidden, repoFile);   // 必还原
}
check('仓库模型已还原在位', fs.existsSync(repoFile));

// ---- URL 白名单 ----
const ok1 = ['https://hf-mirror.com/skytnt/anime-seg/resolve/main/isnetis.onnx',
  'https://cdn-lfs.hf-mirror.com/x', 'https://huggingface.co/a/b', 'https://cdn-lfs.huggingface.co/y',
  'https://cas-bridge.xethub.hf.co/xet-bridge-us/63005b58?Expires=1&Signature=x'];
const bad1 = ['http://hf-mirror.com/x', 'https://evil.com/a', 'https://hf-mirror.com.evil.com/x',
  'https://cas-bridge.xethub.hf.co.evil.com/y'];
check('白名单放行 hf-mirror/huggingface 系', ok1.every((u) => segModel.__testAllowedUrl(u)));
check('白名单拒绝 http/外域/仿冒域', bad1.every((u) => !segModel.__testAllowedUrl(u)));

// ---- busy 互斥 ----
check('cancel 未在下载时静默无副作用', segModel.cancel() === undefined);

fs.rmSync(tmpUserData, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
