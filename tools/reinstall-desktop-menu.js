// 一次性：重装桌面右键菜单命令（带 --wp-user-data=，隔离 userData 路由修复）
// 用文件跑而不用 node -e：Git Bash 会把 -e 脚本里的反斜杠路径改写成 D://
'use strict';
const sm = require('../src/shellMenu.js');
const ud = 'D:\\workbuddy\\projects\\electron-wallpaper\\wp-live-userdata';
const r = sm.installAll({ userData: ud });
if (!r.ok) { console.error('安装失败:', r.error); process.exit(1); }
const s = sm.statusAll({ userData: ud });
console.log('installed=' + s.installed, 'stale=' + s.stale);
for (const it of s.items) console.log(it.key, '|', it.installed ? 'OK' : 'MISMATCH', '|', it.actual);
