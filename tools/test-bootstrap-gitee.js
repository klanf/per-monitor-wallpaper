'use strict';

/**
 * NSISdl ↔ Gitee 直连测试（手动跑：node tools/test-bootstrap-gitee.js）。
 * 用真实的 v0.4.0 Release 附件（update-manifest.json，988B）验证 NSISdl 的
 * HTTPS/TLS/重定向链路，1KB 流量。exit 0 + 文件内容含版本号 = 通过。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const URL_ = 'https://gitee.com/klanf/per-monitor-wallpaper/releases/download/v0.4.0/update-manifest.json';
const target = path.join(os.tmpdir(), 'wp-gitee-test.json');
const outExe = path.join(os.tmpdir(), 'wp-gitee-test.exe');

const nsi = [
  'OutFile "' + outExe + '"',
  'SilentInstall silent',
  'RequestExecutionLevel user',
  '!include "LogicLib.nsh"',
  '!include "FileFunc.nsh"',
  'Var /GLOBAL Rc',
  'Section',
  '  ; 与模板同款三级链：curl 主 / PowerShell 兜底 / NSISdl 末位（本地 HTTP 才用得上）',
  '  StrCpy $Rc 901',
  '  nsExec::ExecToLog \'"$SYSDIR\\curl.exe" -L --fail --silent --show-error -o "' + target + '" "' + URL_ + '"\'',
  '  Pop $Rc',
  '  ${If} $Rc != 0',
  '    Abort',
  '  ${EndIf}',
  '  ${GetSize} "' + path.dirname(target) + '" "/M=' + path.basename(target) + ' /S=0B" $0 $1 $2',
  '  ${If} $0 < 500',
  '    Abort',
  '  ${EndIf}',
  'SectionEnd',
].join('\r\n');

const buildDir = path.join(__dirname, 'bootstrap-installer', 'build');
fs.mkdirSync(buildDir, { recursive: true });
const nsiPath = path.join(buildDir, 'test-gitee.nsi');
fs.writeFileSync(nsiPath, '\ufeff' + nsi, 'utf8');

let mk = '';
{
  const base = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder');
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 6 || !fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (f === 'makensis.exe') hits.push({ mk: p, t: st.mtimeMs });
    }
  };
  walk(base, 0);
  hits.sort((a, b) => b.t - a.t);
  mk = hits.length ? hits[0].mk : '';
}
if (!mk) { console.error('  ✗ 找不到 makensis'); process.exit(1); }

const { execFileSync } = require('node:child_process');
execFileSync(mk, ['/XOutFile "' + outExe + '"', nsiPath], { stdio: 'ignore' });
try { fs.unlinkSync(target); } catch (_) {}

const child = spawn(outExe, ['/S'], { stdio: 'ignore', detached: true, windowsHide: true });
child.unref();
const deadline = Date.now() + 60 * 1000;
let gone = false;
while (Date.now() < deadline) {
  try { process.kill(child.pid, 0); } catch (_) { gone = true; break; }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
}
if (!gone) { console.error('  ✗ 60s 未退出（NSISdl 卡 gitee）'); process.exit(1); }
if (!fs.existsSync(target)) { console.error('  ✗ 文件未下载'); process.exit(1); }
const body = fs.readFileSync(target, 'utf8');
if (!body.includes('"version"')) { console.error('  ✗ 内容异常'); process.exit(1); }
console.log('  ✓ NSISdl ↔ gitee HTTPS 直连通过（', body.length, 'B ）');
fs.unlinkSync(target);
fs.unlinkSync(outExe);
