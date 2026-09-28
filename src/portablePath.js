'use strict';

/**
 * portable 打包形态的「原始 exe」路径解析。
 *
 * portable 是「自解压」形态：真正跑的 exe 是解包到 %TEMP% 的临时副本，
 * `process.execPath` 指向它 —— 退出后启动器会把临时目录整个删掉。于是：
 *
 *   · `app.relaunch()` 不传 path 时默认用 execPath 重启 → 目标已删
 *     → 用户看到「点重启 = 直接退出」；
 *   · `setLoginItemSettings({ path: execPath })` 写进启动项的是临时路径
 *     → 路径开机即失效 → 「勾了自启但开机不起」。
 *
 * electron-builder 的 portable 启动器会把原始 exe 的位置放进环境变量，
 * 新旧版本字段名不同，这里按可靠度依次尝试，并用 existsSync 验证：
 *   · PORTABLE_EXECUTABLE_FILE      原始 exe 完整路径（部分版本）
 *   · PORTABLE_EXECUTABLE_FILENAME  同上（另一些版本的命名）
 *   · PORTABLE_EXECUTABLE_DIR + PORTABLE_EXECUTABLE_APP_FILENAME  兜底拼路径
 *
 * 三处消费方：main.js 的 restartApp（relaunch 的 path）、
 * tray.js 的开机自启（setLoginItemSettings 的 path）、设置面板里展示的自启命令。
 * 纯 node 可 require（不碰 Electron），供单测直接喂 env 验证。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * 解析 portable 原始 exe 路径；不是 portable 形态（或解析不出）返回 null。
 *
 * @param {NodeJS.ProcessEnv} [env]  环境变量来源（默认 process.env，测试可注入）
 * @param {(p:string) => boolean} [exists]  存在性判定（默认 fs.existsSync，测试可注入）
 */
function resolvePortableExecutablePath(env = process.env, exists = (p) => fs.existsSync(p)) {
  const candidates = [];
  const direct = env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_FILENAME;
  if (direct) candidates.push(direct);

  const dir = env.PORTABLE_EXECUTABLE_DIR;
  const name = env.PORTABLE_EXECUTABLE_APP_FILENAME;
  if (dir && name) {
    candidates.push(
      name.toLowerCase().endsWith('.exe') ? path.join(dir, name) : path.join(dir, `${name}.exe`),
    );
  }

  for (const candidate of candidates) {
    try {
      if (candidate && exists(candidate)) return candidate;
    } catch { /* 下一个候选 */ }
  }
  return null;
}

module.exports = { resolvePortableExecutablePath };
