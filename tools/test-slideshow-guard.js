'use strict';

/**
 * slideshowGuard 单测（59 轮）：写前快照 / 还原的全部分支，临时目录隔离，
 * 不碰真实 %APPDATA%（和 test-scheduler 同一纪律：测试绝不污染用户系统）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const guard = require('../src/slideshowGuard');

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

function tmpTheme() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-guard-'));
}

function writeIni(dir, content) {
  fs.writeFileSync(path.join(dir, 'slideshow.ini'), content);
}

function main() {
  console.log('\n§1 snapshotIfGood：有内容才快照');
  {
    const dir = tmpTheme();
    const bak = path.join(tmpTheme(), 'backup.ini');
    // 没有 ini → false，不产生备份
    check('ini 不存在 ⇒ 不快照', guard.snapshotIfGood(dir, bak) === false && !fs.existsSync(bak));
    // 空文件 → false（多半已被自己踩掉，保留旧快照）
    writeIni(dir, '');
    check('ini 为 0 字节 ⇒ 不快照', guard.snapshotIfGood(dir, bak) === false && !fs.existsSync(bak));
    // 有内容 → true，内容一致
    writeIni(dir, '[Slideshow]\r\nImages=C:\\a\r\n');
    check('ini 有内容 ⇒ 快照成功', guard.snapshotIfGood(dir, bak) === true);
    check('快照内容与 ini 一致', fs.readFileSync(bak, 'utf8').includes('Images=C:\\a'));
  }

  console.log('\n§2 snapshotIfGood：快照不被空 ini 覆盖');
  {
    const dir = tmpTheme();
    const bak = path.join(tmpTheme(), 'backup.ini');
    writeIni(dir, 'GOOD-CONFIG');
    guard.snapshotIfGood(dir, bak);
    // 模拟被写壁纸踩空后再快照 —— 不能拿空文件覆盖好快照
    writeIni(dir, '');
    guard.snapshotIfGood(dir, bak);
    check('被踩空后再快照 ⇒ 备份仍是 GOOD-CONFIG', fs.readFileSync(bak, 'utf8') === 'GOOD-CONFIG');
  }

  console.log('\n§3 restoreIfEmpty：只在空且有快照时还原');
  {
    const dir = tmpTheme();
    const bak = path.join(tmpTheme(), 'backup.ini');
    // 没有快照 → false
    writeIni(dir, '');
    check('无快照 ⇒ 不还原', guard.restoreIfEmpty(dir, bak) === false);
    // 快照存在但 ini 有内容（用户自己在用幻灯片）→ 不动
    fs.writeFileSync(bak, 'RESTORED-CONFIG');
    writeIni(dir, 'USER-LIVE-CONFIG');
    check('ini 有内容 ⇒ 不覆盖', guard.restoreIfEmpty(dir, bak) === false && fs.readFileSync(path.join(dir, 'slideshow.ini'), 'utf8') === 'USER-LIVE-CONFIG');
    // ini 被踩空 → 还原，内容一致，且快照保留（可重复还原）
    writeIni(dir, '');
    check('ini 空且有快照 ⇒ 还原成功', guard.restoreIfEmpty(dir, bak) === true);
    check('还原后的 ini 是快照内容', fs.readFileSync(path.join(dir, 'slideshow.ini'), 'utf8') === 'RESTORED-CONFIG');
    // 再来一次：ini 已非空 ⇒ 不再还原（返回 false），内容保持不变 —— 守卫不折腾好文件
    check('ini 已还原（非空）⇒ 再次调用返回 false 且内容不变',
      guard.restoreIfEmpty(dir, bak) === false && fs.readFileSync(path.join(dir, 'slideshow.ini'), 'utf8') === 'RESTORED-CONFIG');
    // ini 不存在（极端清理）也当空 → 还原
    fs.unlinkSync(path.join(dir, 'slideshow.ini'));
    check('ini 不存在 ⇒ 也还原', guard.restoreIfEmpty(dir, bak) === true);
    // 空快照 → 不还原（避免拿空盖空还报成功）
    const bak2 = path.join(tmpTheme(), 'backup2.ini');
    fs.writeFileSync(bak2, '');
    writeIni(dir, '');
    check('快照本身为空 ⇒ 不还原', guard.restoreIfEmpty(dir, bak2) === false);
  }

  console.log('\n§4 themesDir：跟 APPDATA 走，无写操作');
  {
    const saved = process.env.APPDATA;
    try {
      const fakeBase = tmpTheme();
      process.env.APPDATA = fakeBase;
      const d = guard.themesDir();
      check('themesDir() = APPDATA\\Microsoft\\Windows\\Themes',
        d === path.join(fakeBase, 'Microsoft', 'Windows', 'Themes'), String(d));
      process.env.APPDATA = '';
      check('APPDATA 为空串 ⇒ themesDir() 返回 null（守卫静默失效）', guard.themesDir() === null);
    } finally {
      process.env.APPDATA = saved;
    }
  }

  console.log(`\n===== 单测结果: ${pass}/${pass + fail} =====`);
  process.exit(fail ? 1 : 0);
}

main();
