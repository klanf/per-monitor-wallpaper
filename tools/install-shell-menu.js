'use strict';

/**
 * 桌面右键菜单的安装 / 卸载 / 查看状态（命令行版）。
 *
 * App 里的「设置 → 删除 → 桌面右键菜单」两个开关走的是同一份 src/shellMenu.js，
 * 这个脚本只是给命令行、CI 和验证脚本用的入口 —— 不用开 App 也能装。
 *
 * 用法：
 *   node tools/install-shell-menu.js status             # 看装没装、注册的命令行是什么
 *   node tools/install-shell-menu.js install            # 两项都装（HKCU，不需要管理员）
 *   node tools/install-shell-menu.js install next       # 只装「切换到下一张壁纸」
 *   node tools/install-shell-menu.js uninstall delete   # 只卸「删除当前显示器的壁纸」
 *   node tools/install-shell-menu.js install --packaged dist/win-unpacked/壁纸切换器.exe
 *                                                       # 指向打包好的 exe（不再传 app 目录）
 *
 * 项名可取 next / delete，省略即「全部」。
 */

const path = require('node:path');
const fs = require('node:fs');

const shellMenu = require('../src/shellMenu.js');

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const cmd = positional[0] || 'status';
  const target = positional[1] || null;
  const get = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : null;
  };
  return { cmd, target, packaged: get('packaged'), exe: get('exe'), app: get('app') };
}

function printStatus(status) {
  if (!status.available) {
    console.log('✗ 注册表接口不可用:', status.error);
    return;
  }
  console.log(status.installed ? '✓ 桌面上有本程序的菜单（至少一项）' : '· 桌面上没有本程序的菜单');
  for (const it of status.items) {
    const state = it.installed ? '已装' : (it.stale ? '需要重装（注册的命令行和期望不一致）' : '没装');
    console.log('');
    console.log(`  [${it.key}] ${it.label} —— ${state}`);
    console.log('    期望命令行:', it.expected);
    if (it.actual) console.log('    注册表里是:', it.actual);
    console.log('    注册表位置: HKCU\\' + it.keyPath);
  }
}

function main() {
  const { cmd, target, packaged, exe, app } = parseArgs(process.argv);

  // --packaged / --exe 都是「exe 自己就是应用」，不用再传 app 目录
  let override = null;
  if (packaged) {
    const abs = path.resolve(packaged);
    if (!fs.existsSync(abs)) {
      console.error('✗ 找不到这个 exe:', abs);
      process.exit(1);
    }
    override = { exe: abs, appPath: null };
  } else if (exe) {
    override = { exe: path.resolve(exe), appPath: app ? path.resolve(app) : null };
  }

  if (target && !shellMenu.ITEMS.some((it) => it.key === target)) {
    const keys = shellMenu.ITEMS.map((it) => it.key).join(' / ');
    console.error(`✗ 不认识的项：${target}（可用：${keys}，省略即全部）`);
    process.exit(1);
  }
  const keys = target ? [target] : shellMenu.ITEMS.map((it) => it.key);

  if (cmd === 'status') {
    printStatus(shellMenu.statusAll(override));
    return;
  }

  if (cmd === 'install') {
    for (const key of keys) {
      const r = shellMenu.installItem(key, override);
      if (!r.ok) { console.error('✗ 装上失败:', r.error); process.exit(1); }
      console.log(`✓ 装上: ${r.label}`);
      console.log('  ', r.command);
    }
    printStatus(shellMenu.statusAll(override));
    return;
  }

  if (cmd === 'uninstall') {
    for (const key of keys) {
      const r = shellMenu.uninstallItem(key);
      if (!r.ok) { console.error('✗ 卸掉失败:', r.error); process.exit(1); }
      console.log(`✓ 已卸掉: ${key}`);
    }
    printStatus(shellMenu.statusAll(override));
    return;
  }

  console.error(`未知子命令：${cmd}（可用：status / install / uninstall）`);
  process.exit(1);
}

main();
