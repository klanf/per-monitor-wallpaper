'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  UpdateService,
  compareVersions,
  defaultAllowedUrl,
  parseVersion,
  selectHighestStableRelease,
  validateManifest,
} = require('../src/updater');

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? `   ${detail}` : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? `   ${detail}` : ''}`); }
}

const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function main() {
  console.log('\n===== 1. 版本与清单校验 =====');
  check('解析标准标签', parseVersion('v0.3.1').text === '0.3.1');
  check('兼容旧中文标签', parseVersion('壁纸切换器-Setup-0.2.1').text === '0.2.1');
  check('拒绝不完整版本', parseVersion('v1.2') === null);
  check('版本比较按数值而非字符串', compareVersions('0.10.0', '0.9.9') > 0);
  const picked = selectHighestStableRelease([
    { tag_name: 'v0.4.0', prerelease: true },
    { tag_name: 'v0.3.2', prerelease: false },
    { tag_name: 'v0.3.10', prerelease: false },
  ]);
  check('排除预发行并选最高语义版本', picked.version.text === '0.3.10');
  check('Gitee API 地址允许', defaultAllowedUrl('https://gitee.com/api/v5/repos/klanf/per-monitor-wallpaper/releases'));
  check('Gitee 附件 CDN 重定向允许', defaultAllowedUrl('https://foruda.gitee.com/attach_file/example'));
  check('外部下载域名拒绝', !defaultAllowedUrl('https://example.com/update.exe'));

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'wp-updater-'));
  const whole = Buffer.alloc(240 * 1024);
  for (let i = 0; i < whole.length; i += 1) whole[i] = i % 251;
  const buffers = [whole.subarray(0, 128 * 1024), whole.subarray(128 * 1024)];
  const installerName = '壁纸切换器-Setup-0.3.1.exe';
  const partNames = [`${installerName}.part001`, `${installerName}.part002`];
  const manifest = {
    schemaVersion: 1,
    version: '0.3.1',
    installer: {
      name: installerName,
      size: whole.length,
      sha256: hash(whole),
      parts: buffers.map((buffer, i) => ({ name: partNames[i], size: buffer.length, sha256: hash(buffer) })),
    },
  };

  let base = '';
  let rangeSeen = false;
  let rangeIgnoredSeen = false;
  let badPartRequests = 0;
  const assets = () => [
    { name: 'update-manifest.json', browser_download_url: `${base}/manifest` },
    ...partNames.map((name, i) => ({ name, browser_download_url: `${base}/part/${i}` })),
  ];
  const release = () => ({ tag_name: 'v0.3.1', prerelease: false, name: '测试更新', body: '修复若干问题', assets: assets() });

  const server = http.createServer((req, res) => {
    if (req.url === '/releases') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([release(), { tag_name: 'v0.3.0', prerelease: false, assets: [] }]));
      return;
    }
    if (req.url === '/manifest') {
      res.statusCode = 302;
      res.setHeader('location', '/manifest-real');
      res.end();
      return;
    }
    if (req.url === '/manifest-real') {
      res.end(JSON.stringify(manifest));
      return;
    }
    if (req.url === '/bad-releases') {
      const badAssets = assets().map((a) => a.name === 'update-manifest.json' ? { ...a, browser_download_url: `${base}/bad-manifest` } : a);
      res.end(JSON.stringify([{ ...release(), assets: badAssets }]));
      return;
    }
    if (req.url === '/bad-manifest') {
      const bad = JSON.parse(JSON.stringify(manifest));
      bad.installer.parts[0].sha256 = '0'.repeat(64);
      res.end(JSON.stringify(bad));
      return;
    }
    const partMatch = req.url.match(/^\/part\/(\d)$/);
    if (partMatch) {
      const index = Number(partMatch[1]);
      const buffer = buffers[index];
      if (index === 0) badPartRequests += 1;
      const range = String(req.headers.range || '');
      const match = range.match(/^bytes=(\d+)-$/);
      const start = match ? Number(match[1]) : 0;
      if (start && index === 0) {
        rangeSeen = true;
        res.statusCode = 206;
        res.setHeader('content-range', `bytes ${start}-${buffer.length - 1}/${buffer.length}`);
      } else if (start) {
        // 模拟 Gitee 当前附件 CDN：收到 Range 仍返回 200 全文件。
        rangeIgnoredSeen = true;
      }
      const actualStart = res.statusCode === 206 ? start : 0;
      res.setHeader('content-length', buffer.length - actualStart);
      res.end(buffer.subarray(actualStart));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  try {
    const normalized = validateManifest(manifest, parseVersion('v0.3.1'), assets());
    check('合法清单通过并解析两个分片', normalized.installer.parts.length === 2);
    let dangerousRejected = false;
    try {
      const bad = JSON.parse(JSON.stringify(manifest));
      bad.installer.parts[0].name = '../bad.part001';
      validateManifest(bad, parseVersion('v0.3.1'), assets());
    } catch { dangerousRejected = true; }
    check('路径穿越分片名被拒绝', dangerousRejected);

    console.log('\n===== 2. 本地 HTTP 检查、重定向、续传与合并 =====');
    const updatesDir = path.join(tmp, 'updates');
    const versionDir = path.join(updatesDir, '0.3.1');
    await fsp.mkdir(versionDir, { recursive: true });
    await fsp.writeFile(path.join(versionDir, partNames[0]), buffers[0].subarray(0, 4096));
    await fsp.writeFile(path.join(versionDir, partNames[1]), buffers[1].subarray(0, 2048));
    const states = [];
    const service = new UpdateService({
      currentVersion: '0.3.0',
      updatesDir,
      apiUrl: `${base}/releases`,
      allowedUrl: () => true,
      supported: false,
      unsupportedReason: '测试环境不安装',
      logger: { warn: () => {} },
      onState: (state) => states.push(state),
    });
    const available = await service.check({ manual: true });
    check('发现 0.3.1 新版本', available.status === 'available' && available.latestVersion === '0.3.1');
    check('Release 正文进入状态', available.releaseNotes === '修复若干问题');
    const ready = await service.download();
    check('下载并合并后进入 ready', ready.status === 'ready', ready.error || '');
    check('断点请求发送了 Range', rangeSeen);
    check('服务器忽略 Range 时安全覆盖重下该片', rangeIgnoredSeen);
    const assembled = await fsp.readFile(path.join(versionDir, installerName));
    check('合并结果与原安装包逐字节相同', assembled.equals(whole));
    check('进度广播到 100%', states.some((s) => s.status === 'ready' && s.percent === 100));
    const install = await service.install();
    check('不支持的运行方式拒绝安装', install.status === 'error' && install.error.includes('测试环境'));

    console.log('\n===== 3. 篡改与旧版本处理 =====');
    const oldService = new UpdateService({
      currentVersion: '0.3.1', updatesDir: path.join(tmp, 'old'), apiUrl: `${base}/releases`, allowedUrl: () => true,
      logger: { warn: () => {} },
    });
    check('等版本不会提示更新', (await oldService.check({ manual: true })).status === 'up-to-date');

    await fsp.rm(path.join(tmp, 'bad'), { recursive: true, force: true });
    badPartRequests = 0;
    const badService = new UpdateService({
      currentVersion: '0.3.0', updatesDir: path.join(tmp, 'bad'), apiUrl: `${base}/bad-releases`, allowedUrl: () => true,
      logger: { warn: () => {} },
    });
    await badService.check({ manual: true });
    const badVersionDir = path.join(tmp, 'bad', '0.3.1');
    await fsp.mkdir(badVersionDir, { recursive: true });
    // 长度已经完整、内容却不符合清单：必须删掉重下，不能发 bytes=<文件末尾>- 后卡死。
    await fsp.writeFile(path.join(badVersionDir, partNames[0]), buffers[0]);
    const badResult = await badService.download();
    check('分片哈希不符时拒绝进入 ready', badResult.status === 'error' && badResult.error.includes('校验失败'));
    check('校验失败按约定最多重试三次', badPartRequests === 3, `实际 ${badPartRequests}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(tmp, { recursive: true, force: true });
  }

  console.log(`\n${fail ? 'FAILED' : 'OK'}  ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
