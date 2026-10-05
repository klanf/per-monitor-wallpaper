/**
 * 59 轮追记二：slideshow.ini 被踩空后的一键修复。
 * 走 IDesktopWallpaper::SetSlideshow 把相册指回去（Explorer 自己重建 ini，不手写私有格式）。
 * 用法：node tools/repair-slideshow.js [文件夹路径]   （缺省 = 新世界相册）
 * ⚠️ 必须从文件执行 —— Bash 工具的 heredoc 会把反斜杠改成正斜杠，路径全坏。
 */
'use strict';
const path = require('path');
const dw = require('../src/desktopWallpaper');

const folder = process.argv[2] || 'F:\\壁纸\\桌面壁纸\\新世界';
const r = dw.setSlideshow(path.resolve(folder));
console.log('setSlideshow:', JSON.stringify(r));
process.exit(r.ok ? 0 : 1);
