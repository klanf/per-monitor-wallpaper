'use strict';

/**
 * 把 electron-builder 的 NSIS 安装包切成可上传到 Gitee Release 的原始分片，
 * 同时生成客户端认识的 update-manifest.json。只准备文件，不联网、不读取 Token。
 *
 * 用法：
 *   npm run update:prepare
 *   node tools/prepare-update.js D:\path\壁纸切换器-Setup-0.3.0.exe
 *   node tools/prepare-update.js --chunk-mib 80 --force
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));
const DEFAULT_CHUNK_MIB = 90;

function parseArgs(argv) {
  const out = { installer: null, chunkMiB: DEFAULT_CHUNK_MIB, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--chunk-mib') out.chunkMiB = Number(argv[++i]);
    else if (argv[i] === '--force') out.force = true;
    else if (!argv[i].startsWith('-') && !out.installer) out.installer = argv[i];
    else throw new Error(`未知参数：${argv[i]}`);
  }
  if (!Number.isInteger(out.chunkMiB) || out.chunkMiB < 1 || out.chunkMiB > 95) {
    throw new Error('--chunk-mib 必须是 1 到 95 的整数');
  }
  return out;
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function splitInstaller(installerPath, outputDir, chunkBytes) {
  const input = await fsp.open(installerPath, 'r');
  const stat = await input.stat();
  const installerName = path.basename(installerPath);
  const parts = [];
  const wholeHash = crypto.createHash('sha256');
  let offset = 0;
  let index = 1;

  try {
    while (offset < stat.size) {
      const size = Math.min(chunkBytes, stat.size - offset);
      const buffer = Buffer.allocUnsafe(size);
      let filled = 0;
      while (filled < size) {
        const { bytesRead } = await input.read(buffer, filled, size - filled, offset + filled);
        if (!bytesRead) throw new Error('读取安装包时意外到达文件末尾');
        filled += bytesRead;
      }
      wholeHash.update(buffer);
      const name = `${installerName}.part${String(index).padStart(3, '0')}`;
      const partPath = path.join(outputDir, name);
      await fsp.writeFile(partPath, buffer, { flag: 'wx' });
      parts.push({
        name,
        size,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      });
      console.log(`  ${name}  ${(size / 1048576).toFixed(1)} MiB`);
      offset += size;
      index += 1;
    }
  } finally {
    await input.close();
  }

  return {
    size: stat.size,
    sha256: wholeHash.digest('hex'),
    parts,
  };
}

// 引导安装器清单（r39）：NSIS 原生可读的扁平 ini，引导器下载它来拿到
// 每个分片的名字/大小/哈希，避免在 NSIS 里解析 JSON。URL 预编码好
//（分片名含中文），NSIS 侧拿来即用。
//
// ⚠️ 编码必须是 UTF-16 LE + BOM（Windows ini 官方 Unicode 口径）。
// 真机翻车实录（v0.4.2 首发版）：曾用 UTF-8 BOM，注释错误地以为
//「Unicode NSIS 的 ReadINIStr 靠 BOM 识别 UTF-8」——实际 ReadINIStr 底层是
// GetPrivateProfileStringW，只认 UTF-16 BOM / ANSI，不认 UTF-8 BOM：BOM 字节
// 粘在首节名前 → [bootstrap] 节查不到 → parts 读空 → 引导器弹「版本清单内容异常」。
// 本地测试当时自己手写了无 BOM 的 ini，与实发文件不一致，所以测试全过、真跑必挂。
// 现在生成逻辑抽成共享函数（test-bootstrap.js 也用它），杜绝再度脱节。
function buildBootstrapIni({ version, size, sha256, parts, base, installerName }) {
  const enc = encodeURIComponent;
  const iniLines = [
    '[bootstrap]',
    `version=${version}`,
    `installer=${installerName}`,
    `size=${size}`,
    `sha256=${sha256}`,
    `parts=${parts.length}`,
    `base=${base}`,
  ];
  parts.forEach((part, i) => {
    iniLines.push(`[part${i + 1}]`);
    iniLines.push(`name=${part.name}`);
    iniLines.push(`url=${base}${enc(part.name)}`);
    iniLines.push(`size=${part.size}`);
    iniLines.push(`sha256=${part.sha256}`);
  });
  // UTF-16 LE + BOM：GetPrivateProfileStringW 官方支持的 Unicode ini 格式，
  // 中文 name 字段按 Unicode 读，不再有 ANSI(GBK) 乱码。
  return Buffer.from('\ufeff' + iniLines.join('\r\n') + '\r\n', 'utf16le');
}

module.exports = { buildBootstrapIni };

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const expectedName = `壁纸切换器-Setup-${PKG.version}.exe`;
  const installerPath = path.resolve(options.installer || path.join(ROOT, 'dist', expectedName));
  if (path.basename(installerPath) !== expectedName) {
    throw new Error(`安装包文件名必须是 ${expectedName}（确保 package.json 与产物版本一致）`);
  }
  const stat = await fsp.stat(installerPath).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error(`找不到安装包：${installerPath}`);

  const outputDir = path.join(ROOT, 'dist', `update-v${PKG.version}`);
  if (options.force) await fsp.rm(outputDir, { recursive: true, force: true });
  await fsp.mkdir(outputDir, { recursive: false }).catch((err) => {
    if (err.code === 'EEXIST') throw new Error(`输出目录已存在：${outputDir}（确认后可加 --force 重建）`);
    throw err;
  });

  console.log(`版本      v${PKG.version}`);
  console.log(`安装包    ${installerPath}`);
  console.log(`分片大小  ${options.chunkMiB} MiB`);
  console.log(`输出目录  ${outputDir}\n`);

  try {
    const result = await splitInstaller(installerPath, outputDir, options.chunkMiB * 1024 * 1024);
    const manifest = {
      schemaVersion: 1,
      version: PKG.version,
      installer: {
        name: expectedName,
        size: result.size,
        sha256: result.sha256,
        parts: result.parts,
      },
    };
    const manifestPath = path.join(outputDir, 'update-manifest.json');
    await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

    // 引导安装器清单（r39）：生成逻辑与编码见 buildBootstrapIni 注释。
    // 本地测试（test-bootstrap.js）也用这个函数造 ini，保证测试文件与实发文件逐字节同源。
    const tag = `v${PKG.version}`;
    const base = `https://gitee.com/klanf/per-monitor-wallpaper/releases/download/${tag}/`;
    const iniBytes = buildBootstrapIni({
      version: PKG.version,
      size: result.size,
      sha256: result.sha256,
      parts: result.parts,
      base,
      installerName: expectedName,
    });
    await fsp.writeFile(path.join(outputDir, 'bootstrap.ini'), iniBytes, { flag: 'wx' });

    // 再从磁盘复核一遍，避免写盘异常或脚本改动让清单和成品脱节。
    for (const part of result.parts) {
      const actual = await hashFile(path.join(outputDir, part.name));
      if (actual !== part.sha256) throw new Error(`写盘后校验失败：${part.name}`);
    }

    console.log(`\n完成：${result.parts.length} 个分片 + update-manifest.json + bootstrap.ini`);
    console.log(`整包 SHA-256  ${result.sha256}`);
    console.log(`\n请创建 Gitee Release v${PKG.version}，上传该目录里的全部文件。`);
    console.log('不要上传 RAR 分卷；客户端需要这里生成的原始 .partNNN 文件。');
    console.log(`新用户入口 = tools/bootstrap-installer 产出的引导安装器（build-bootstrap.js 构建，tag=${tag}）。`);
  } catch (err) {
    await fsp.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[FAILED] ${err.message}`);
    process.exitCode = 1;
  });
}
