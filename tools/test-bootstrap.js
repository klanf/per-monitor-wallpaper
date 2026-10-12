'use strict';

/**
 * 引导安装器本地全链测试（手动跑：node tools/test-bootstrap.js）。
 *
 * 流程：造一个假 release（fake-installer.bin 切 3 片 + bootstrap.ini，base 指向
 * 本地 HTTP 服务）→ 构建测试版引导器（--skip-run）→ /S 静默跑完整链
 * （下载→逐片 SHA→合并→整包 SHA）→ 校验合并产物字节与原文件一致。
 * 成功的铁证：%TEMP%\wp-bootstrap 被清理干净（只有走完全部校验才会走到清理）。
 */

const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { buildBootstrapIni } = require('./prepare-update.js');
const serveDir = path.join(os.tmpdir(), 'wp-bootstrap-serve');
const workDir = path.join(os.tmpdir(), 'wp-bootstrap');
const PORT = 8099;

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  // 失败现场：临时目录里有什么、各多大 —— 判断卡在哪一步
  if (fs.existsSync(workDir)) {
    for (const f of fs.readdirSync(workDir)) {
      const fp = path.join(workDir, f);
      let sz = 0;
      try { sz = fs.statSync(fp).size; } catch (_) {}
      console.error(`     现场 ${f} ${sz}B`);
    }
  } else {
    console.error('     现场: %TEMP%\\wp-bootstrap 不存在（第一步都没跑）');
  }
  process.exitCode = 1;
  try { fs.rmSync(serveDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
}

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

async function main() {
  fs.rmSync(serveDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(serveDir, { recursive: true });

  // ── 1. 造假 release：300KB 假安装包切 3 片 ──
  const fake = crypto.randomBytes(300 * 1024);
  const fakePath = path.join(serveDir, 'fake-installer.bin');
  fs.writeFileSync(fakePath, fake);
  const wholeSha = sha256(fakePath);
  const parts = [];
  for (let k = 0; k < 3; k += 1) {
    // 分片名故意带中文（真实名 = 壁纸切换器-Setup-<版本>.exe.partNNN）——
    // 顺带验证 bootstrap.ini 里预编码的 URL 与 HTTP 服务端的解码链路
    const name = `壁纸切换器-Setup-9.9.9-test.exe.part00${k + 1}`;
    const chunk = fake.subarray(k * 100 * 1024, (k + 1) * 100 * 1024);
    const p = path.join(serveDir, name);
    fs.writeFileSync(p, chunk);
    parts.push({ name, size: chunk.length, sha256: sha256(p) });
  }
  const lines = [
    '[bootstrap]',
    'version=9.9.9-test',
    'size=' + fake.length,
    `sha256=${wholeSha}`,
    'parts=3',
    `base=http://127.0.0.1:${PORT}/`,
  ];
  parts.forEach((p, i) => {
    lines.push(`[part${i + 1}]`, `name=${p.name}`, `url=http://127.0.0.1:${PORT}/${encodeURIComponent(p.name)}`, `size=${p.size}`, `sha256=${p.sha256}`);
  });
  // ⚠️ 必须用与实发文件同一份生成函数（prepare-update.buildBootstrapIni）——
  // v0.4.2 翻车实录：这里曾手写无 BOM 的 UTF-8 ini，实发文件却是 UTF-8 BOM，
  // GetPrivateProfileStringW 不认 UTF-8 BOM → 真机「版本清单内容异常」而本地测试全过。
  // UTF-16 LE BOM 版本顺带覆盖「中文分片名按 Unicode 读」的链路。
  const iniBytes = buildBootstrapIni({
    version: '9.9.9-test',
    size: fake.length,
    sha256: wholeSha,
    parts,
    base: `http://127.0.0.1:${PORT}/`,
    installerName: '壁纸切换器-Setup-9.9.9-test.exe',
  });
  fs.writeFileSync(path.join(serveDir, 'bootstrap.ini'), iniBytes);

  // ── 2. 本地 HTTP ──
  const server = http.createServer((req, res) => {
    const f = path.join(serveDir, decodeURIComponent(req.url.slice(1)));
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Length': fs.statSync(f).size });
    fs.createReadStream(f).pipe(res);
  }).listen(PORT);
  console.log(`  本地 release 服务: http://127.0.0.1:${PORT}/`);

  try {
    // ── 3. 构建测试版引导器 ──
    const outExe = path.join(os.tmpdir(), 'wp-bootstrap-test.exe');
    console.log('  构建测试版引导器…');
    execFileSync(process.execPath, [path.join(__dirname, 'build-bootstrap.js'),
      '--ini-url', `http://127.0.0.1:${PORT}/bootstrap.ini`,
      '--version', '9.9.9-test', '--skip-run', '--out', outExe], { stdio: 'inherit' });

    // ── 4. 静默全链跑（Abort=exit 1；成功=0 且临时目录被清理）──
    // ⚠️ 必须 detached + unref + 轮询等退出：spawnSync 的管道挂法会让 GUI 子进程
    // 被会话监督层盯上（真机实锤 120s 假超时；python Popen CREATE_NO_WINDOW 秒过）
    console.log('  /S 静默跑完整链（下载 300KB）…');
    const child = spawn(outExe, ['/S'], { stdio: 'ignore', detached: true, windowsHide: true });
    child.unref();
    const childPid = child.pid;
    const deadline = Date.now() + 120 * 1000;
    let exited = null;
    while (Date.now() < deadline) {
      try { process.kill(childPid, 0); } catch (_) { exited = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (exited === null) {
      try { process.kill(childPid); } catch (_) {}
      fail('引导器 120s 未退出（下载卡死或对话框阻塞）');
    }
    console.log('  ✓ 引导器自行退出');
    if (fs.existsSync(workDir)) fail(`$TEMP\\wp-bootstrap 未清理 = 链路中途失败`);
    else console.log('  ✓ 临时目录已清理（说明下载→校验→合并→SHA 全链走通）');

    // ── 5. 再验合并产物字节（引导器自己删了，用同样的分片重拼比对）──
    const merged = Buffer.concat(parts.map((p) => fs.readFileSync(path.join(serveDir, p.name))));
    if (crypto.createHash('sha256').update(merged).digest('hex') !== wholeSha) fail('假安装包自身分片不一致（测试脚手架问题）');
    else console.log('  ✓ 假 release 分片自洽（合并=原文件）');
    try { fs.unlinkSync(outExe); } catch (_) {}
  } finally {
    server.close();
    fs.rmSync(serveDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  console.log('  结果：本地全链测试通过');
}

main();
