'use strict';

/**
 * 引导安装器构建（r39）：渲染 bootstrap.nsi.tmpl → makensis 编译。
 *
 * 用法：
 *   node tools/build-bootstrap.js --tag v0.4.2            # 正式：指向 gitee 该 tag 的附件
 *   node tools/build-bootstrap.js --ini-url <url> --skip-run --out xxx.exe   # 测试
 *
 * 产物默认落 dist\壁纸切换器-引导安装器-<tag>.exe，发版时与分片一起上传 Release。
 * 依赖：electron-builder 缓存里的 makensis（自动定位，可用 MAKENSIS 环境变量覆盖）。
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { tag: '', version: '', out: '', iniUrl: '', skipRun: false, makensis: process.env.MAKENSIS || '' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tag') out.tag = argv[++i];
    else if (a === '--version') out.version = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--ini-url') out.iniUrl = argv[++i];
    else if (a === '--skip-run') out.skipRun = true;
    else if (a === '--makensis') out.makensis = argv[++i];
    else throw new Error(`未知参数：${a}`);
  }
  if (!out.iniUrl) {
    if (!out.tag) throw new Error('需要 --tag vX.Y.Z（或 --ini-url 测试覆盖）');
    out.iniUrl = `https://gitee.com/klanf/per-monitor-wallpaper/releases/download/${out.tag}/bootstrap.ini`;
  }
  if (!out.version) out.version = String(out.tag || '').replace(/^v/, '');
  if (!out.version) throw new Error('拿不到版本号（--tag/--version）');
  if (!out.out) out.out = path.join(ROOT, 'dist', `壁纸切换器-引导安装器-${out.tag || out.version}.exe`);
  return out;
}

function findMakensis(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`MAKENSIS 指定的路径不存在: ${explicit}`);
    return explicit;
  }
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
  if (!hits.length) throw new Error('找不到 makensis.exe（先跑一次 npm run dist 让 electron-builder 缓存 NSIS，或用 --makensis 指定）');
  hits.sort((a, b) => b.t - a.t);
  return hits[0].mk;
}

function main() {
  const opts = parseArgs(process.argv);
  const tmpl = fs.readFileSync(path.join(__dirname, 'bootstrap-installer', 'bootstrap.nsi.tmpl'), 'utf8');
  const icon = path.join(ROOT, 'assets', 'icon.ico');
  const rendered = tmpl
    .replaceAll('@VERSION@', opts.version)
    .replaceAll('@TAG@', opts.tag || opts.version)
    .replaceAll('@INIURL@', opts.iniUrl)
    .replaceAll('@OUTFILE@', opts.out)
    .replaceAll('@ICON@', icon)
    .replaceAll('@SKIPRUN@', opts.skipRun ? '1' : '0');

  const buildDir = path.join(__dirname, 'bootstrap-installer', 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  // makensis 的 Unicode 模式要求带 BOM 的 UTF-8（中文 DetailPrint/OutFile 依赖）
  const nsiPath = path.join(buildDir, 'bootstrap.nsi');
  fs.writeFileSync(nsiPath, '\ufeff' + rendered, 'utf8');

  const makensis = findMakensis(opts.makensis);
  console.log(`makensis: ${makensis}`);
  console.log(`清单地址: ${opts.iniUrl}`);
  console.log(`产物:     ${opts.out}`);
  const r = spawnSync(makensis, [`/XOutFile "${opts.out}"`, nsiPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  const logText = `${r.stdout || ''}\n${r.stderr || ''}`;
  fs.writeFileSync(path.join(buildDir, 'build-log.txt'), logText, 'utf8');
  if (r.status !== 0 || !fs.existsSync(opts.out)) {
    console.error(logText.split('\n').filter((l) => /error|警告|Output/i.test(l)).join('\n') || logText.slice(-800));
    throw new Error(`makensis 编译失败（exit ${r.status}），完整日志在 ${path.join(buildDir, 'build-log.txt')}`);
  }
  const size = fs.statSync(opts.out).size;
  console.log(`完成：${opts.out}（${(size / 1024 / 1024).toFixed(2)} MB）`);
}

main();
