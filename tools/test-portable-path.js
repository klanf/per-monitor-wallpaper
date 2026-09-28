'use strict';

/**
 * portable 原始 exe 路径解析单测（纯函数，不碰系统、不碰 Electron）。
 *
 * 背景：portable 形态下 process.execPath 是 %TEMP% 临时副本，退出即删。
 * 重启 / 开机自启必须改用启动器环境变量给出的原始 exe 路径。
 *
 * 用法：node tools/test-portable-path.js
 */

const { resolvePortableExecutablePath } = require('../src/portablePath');

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

function existsFor(present) { return (p) => present.has(p); }

const TEMP_EXE = 'C:\\Users\\x\\AppData\\Local\\Temp\\123.tmp\\壁纸切换器.exe';
const REAL_EXE = 'D:\\绿色软件\\壁纸切换器-0.2.0-portable.exe';
const EXE_STEM = '壁纸切换器-0.2.0-portable';   // PORTABLE_EXECUTABLE_APP_FILENAME 不带扩展名的形态
const EXE_FULL = EXE_STEM + '.exe';

function main() {
  console.log('portable 原始 exe 路径解析单测\n');

  console.log('§1 非 portable 形态');
  {
    check('无任何 PORTABLE_* 环境变量 ⇒ null（NSIS / 开发模式走 execPath 回落）',
      resolvePortableExecutablePath({}, existsFor(new Set())) === null);
  }

  console.log('\n§2 PORTABLE_EXECUTABLE_FILE / FILENAME（完整路径，各版本命名不一）');
  {
    check('PORTABLE_EXECUTABLE_FILE 命中 ⇒ 返回它',
      resolvePortableExecutablePath({ PORTABLE_EXECUTABLE_FILE: REAL_EXE }, existsFor(new Set([REAL_EXE]))) === REAL_EXE);
    check('PORTABLE_EXECUTABLE_FILENAME 命中 ⇒ 返回它',
      resolvePortableExecutablePath({ PORTABLE_EXECUTABLE_FILENAME: REAL_EXE }, existsFor(new Set([REAL_EXE]))) === REAL_EXE);
    check('FILE 优先于 FILENAME',
      resolvePortableExecutablePath(
        { PORTABLE_EXECUTABLE_FILE: 'A:\\a.exe', PORTABLE_EXECUTABLE_FILENAME: 'B:\\b.exe' },
        existsFor(new Set(['A:\\a.exe', 'B:\\b.exe'])),
      ) === 'A:\\a.exe');
    check('路径写了但文件不存在（启动器没设好）⇒ 不采信，继续兜底',
      resolvePortableExecutablePath({ PORTABLE_EXECUTABLE_FILE: REAL_EXE }, existsFor(new Set())) === null);
  }

  console.log('\n§3 DIR + APP_FILENAME 兜底拼路径');
  {
    const env = { PORTABLE_EXECUTABLE_DIR: 'D:\\绿色软件', PORTABLE_EXECUTABLE_APP_FILENAME: EXE_STEM };
    check('APP_FILENAME 不带 .exe ⇒ 自动补扩展名拼接',
      resolvePortableExecutablePath(env, existsFor(new Set(['D:\\绿色软件\\' + EXE_FULL])))
        === 'D:\\绿色软件\\' + EXE_FULL);
    check('APP_FILENAME 自带 .exe ⇒ 不重复补',
      resolvePortableExecutablePath(
        { PORTABLE_EXECUTABLE_DIR: 'D:\\绿色软件', PORTABLE_EXECUTABLE_APP_FILENAME: EXE_FULL },
        existsFor(new Set(['D:\\绿色软件\\' + EXE_FULL])),
      ) === 'D:\\绿色软件\\' + EXE_FULL);
    check('只有 DIR 没有 APP_FILENAME ⇒ null（瞎猜目录下的 exe 太危险）',
      resolvePortableExecutablePath({ PORTABLE_EXECUTABLE_DIR: 'D:\\绿色软件' }, existsFor(new Set())) === null);
  }

  console.log('\n§4 优先级与铁律');
  {
    check('完整路径存在时压过 DIR 拼接',
      resolvePortableExecutablePath(
        {
          PORTABLE_EXECUTABLE_FILE: REAL_EXE,
          PORTABLE_EXECUTABLE_DIR: 'D:\\其他',
          PORTABLE_EXECUTABLE_APP_FILENAME: 'x.exe',
        },
        existsFor(new Set([REAL_EXE, 'D:\\其他\\x.exe'])),
      ) === REAL_EXE);
    check('完整路径不存在但 DIR 兜底可用 ⇒ 用兜底',
      resolvePortableExecutablePath(
        {
          PORTABLE_EXECUTABLE_FILE: 'Z:\\没了.exe',
          PORTABLE_EXECUTABLE_DIR: 'D:\\绿色软件',
          PORTABLE_EXECUTABLE_APP_FILENAME: EXE_STEM,
        },
        existsFor(new Set(['D:\\绿色软件\\' + EXE_FULL])),
      ) === 'D:\\绿色软件\\' + EXE_FULL);
    check('所有候选都解析不出 ⇒ null（宁可回落 execPath 也不猜）',
      resolvePortableExecutablePath(
        { PORTABLE_EXECUTABLE_DIR: 'D:\\绿色软件', PORTABLE_EXECUTABLE_APP_FILENAME: EXE_STEM },
        existsFor(new Set()),
      ) === null);
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main();
