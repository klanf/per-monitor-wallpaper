/*
 * 轻量文件日志：给「VBS 启动丢 stdout」的场景兜底。
 * console.log 在 VBS/wscript 拉起时进不了 launch.log，关键诊断信息
 * （深度生成、全屏暂停切换）落到 userData/logs/live-debug.log，
 * 出问题先看这个文件。写失败静默（日志永远不能反过来影响主业务）。
 */
const fs = require('fs');
const path = require('path');

let file = null;

/** 初始化：传日志目录（一般 userData/logs），不存在会创建 */
function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'live-debug.log');
  } catch { file = null; }
}

function dlog(tag, ...args) {
  const line = `[${new Date().toISOString()}] [${tag}] ${args.join(' ')}\n`;
  if (file) {
    try { fs.appendFile(file, line, () => {}); } catch { /* 忽略 */ }
  }
}

module.exports = { init, dlog };
