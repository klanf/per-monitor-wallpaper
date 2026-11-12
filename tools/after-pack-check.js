/**
 * electron-builder afterPack 守卫（Gitee issue IKQ6OH）：
 * models/ 不进 git，源码自打包时 extraResources 无米下锅会**静默**打出
 * 「深度视差不可用」的废安装包 —— 终端用户只看到一堆作者机器的 legacy
 * 路径报错。这里在打包完成后校验深度模型确实进了产物，缺失即报错中断，
 * 把问题拦在出包之前。
 */
const fs = require('fs');
const path = require('path');

module.exports = function afterPackCheck(context) {
  const target = path.join(
    context.appOutDir, 'resources', 'models', 'depth-anything',
    'depth_anything_v2_small.onnx',
  );
  if (!fs.existsSync(target)) {
    throw new Error(
      '[afterPack] 打包产物缺深度模型：resources\\models\\depth-anything\\depth_anything_v2_small.onnx 不存在。'
      + '该模型（约 99MB）不进 git，源码构建前需先把它放进仓库根 models\\depth-anything\\ 目录'
      + '（官方发布构建均含此文件；缺失的包装出去后深度视差必然不可用，见 Gitee issue IKQ6OH）。',
    );
  }
};
