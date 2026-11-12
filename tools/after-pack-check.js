/**
 * electron-builder afterPack 校验（Gitee issue IKQ6OH）：
 * models/ 不进 git，源码自打包时 extraResources 无米下锅会打出缺模型的
 * 安装包。r88 起应用支持运行时按需下载（src/depthModel.js，hf-mirror 补齐），
 * 缺包不再致命 —— 所以这里只**警告**不阻断；官方发布构建（作者机器有模型）
 * 永远含模型不受影响。
 */
const fs = require('fs');
const path = require('path');

module.exports = function afterPackCheck(context) {
  const target = path.join(
    context.appOutDir, 'resources', 'models', 'depth-anything',
    'depth_anything_v2_small.onnx',
  );
  if (!fs.existsSync(target)) {
    console.warn(
      '[afterPack] ⚠ 打包产物缺深度模型：resources\\models\\depth-anything\\depth_anything_v2_small.onnx 不存在。\n'
      + '该模型（约 99MB）不进 git。此包的深度视差将在用户打开外观页时引导按需下载（r88）。\n'
      + '若想随包附带（官方发布包如此），先把 depth_anything_v2_small.onnx 放进仓库根 models\\depth-anything\\ 再构建。',
    );
  }
};
