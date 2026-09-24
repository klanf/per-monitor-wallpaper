'use strict';

/**
 * 「复制图像到剪贴板」的验证 —— **需要 Electron**（用的是真剪贴板），但不碰桌面、不弹窗口。
 *
 * 为什么单独有这么一份：这个功能曾经以「菜单点了没有任何反应、粘出来也是空的」
 * 的形式失效过 —— 一个**连错误信息都没有**的失败。根因是 Electron 44 的
 * `clipboard.write()` 在剪贴板被别的程序占着、或内部状态没走完时**既不 resolve
 * 也不 reject**：菜单的 click 就永远停在 await 上，既不报错也不复制。
 *
 * 现在的实现是三步：硬超时 → 原生直写兜底（clipboardWin.writeImage）→ 回读校验。
 * 本脚本把三条路全部钉住：
 *   §1 回读接口（readImageStatus）
 *   §2 正常路径：走 Electron 的 write()
 *   §3 write 挂死 → 超时后走原生兜底（就是用户遇到的那个症状的复现）
 *   §4 write 直接 reject → 同样落到兜底
 *   §5 像素级正确性：兜底写出来的 CF_DIBV5 与 Chromium 自己写的**逐字节相同**
 *   §6 守卫分支：文件不在 / 格式解不了 / 空参数
 *
 * 运行：`npm run verify:clipboard`
 * 副作用：会覆盖系统剪贴板（和 verify:features 里的复制断言一样）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const koffi = require('koffi');
const { app, clipboard } = require('electron');

const SRC = path.join(__dirname, '..', 'src');
const clipboardWin = require(path.join(SRC, 'clipboardWin.js'));
const fileActions = require(path.join(SRC, 'fileActions.js'));

const FIXTURES = path.join(__dirname, 'fixtures');
const GALLERY_PNG = path.join(FIXTURES, 'gallery', 'g-001-h0.png');
const SOLID_BMP = path.join(FIXTURES, 'monitor-A-red.bmp');

const CF_DIB = 8;
const CF_DIBV5 = 17;

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

function section(title) {
  console.log(`\n===== ${title} =====`);
}

/* ------------------------------------------------ 剪贴板原文（含体积与像素） */

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const OpenClipboard = user32.func('bool OpenClipboard(void *hWnd)');
const CloseClipboard = user32.func('bool CloseClipboard()');
const GetClipboardData = user32.func('void *GetClipboardData(uint32 uFormat)');
const GlobalLock = kernel32.func('void *GlobalLock(void *hMem)');
const GlobalUnlock = kernel32.func('bool GlobalUnlock(void *hMem)');
const GlobalSize = kernel32.func('size_t GlobalSize(void *hMem)');

/**
 * 把某个格式的**原始载荷**整块读出来（CF_DIB / CF_DIBV5 都是 HGLOBAL，能这么读）。
 * 不要拿它去读 CF_BITMAP —— 那是 GDI 对象，GlobalLock 会直接崩。
 */
function readClipboardBlob(format = CF_DIBV5) {
  if (!OpenClipboard(null)) return null;
  try {
    const h = GetClipboardData(format);
    if (!h) return null;
    const size = Number(GlobalSize(h));
    if (!size) return null;
    const p = GlobalLock(h);
    if (!p) return null;
    const bytes = Buffer.from(koffi.decode(p, koffi.array('uint8', size)));
    GlobalUnlock(h);
    return bytes;
  } finally {
    CloseClipboard();
  }
}

/** CF_DIBV5 = 124 字节头 + 像素；返回像素段 */
function dibV5Pixels() {
  const blob = readClipboardBlob(CF_DIBV5);
  return blob && blob.length > 124 ? blob.subarray(124) : null;
}

/* ------------------------------------------------ 带 alpha 的夹具 */

/** 4×1 的 RGBA：不透明白 / 全透明 / 半透明蓝 / 半透明白 —— 四种 alpha 边界 */
const ALPHA_PX = [
  [255, 0, 0, 255],
  [255, 0, 0, 0],
  [0, 128, 255, 64],
  [255, 255, 255, 128],
];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

/**
 * 手写一张带 alpha 的 PNG。
 * 为什么要手写：Node 没有图像编码器，而这个用例必须要有透明度
 * （预乘 / 直存 alpha 的差异只有在半透明像素上才看得出来）。
 */
function writeAlphaPng(file) {
  const width = ALPHA_PX.length;
  const height = 1;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  raw[0] = 0;    // 行过滤器：none
  ALPHA_PX.forEach(([r, g, b, a], i) => {
    const o = 1 + i * 4;
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
  });
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
  return file;
}

/** 源 RGBA → **预乘** BGRA（Chromium / toBitmap 的约定：floor(通道*alpha/255)） */
function expectedPremultipliedBgra() {
  return Buffer.from(ALPHA_PX.flatMap(([r, g, b, a]) => [
    Math.floor(b * a / 255), Math.floor(g * a / 255), Math.floor(r * a / 255), a,
  ]));
}

/* ------------------------------------------------ 驱动 */

const realWrite = clipboard.write.bind(clipboard);
const patchWrite = (fn) => Object.defineProperty(clipboard, 'write', {
  value: fn, configurable: true, writable: true,
});

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-clip-'));
  const alphaPng = writeAlphaPng(path.join(tmp, 'alpha.png'));

  /* ---------------------------------------------- §1 */
  section('1. 回读接口（readImageStatus）');
  const status = clipboardWin.readImageStatus();
  check('能打开剪贴板并枚举格式', status.ok === true, status.error || `formats=[${status.formats.join(',')}]`);
  check('返回的是结构化字段（dib / dibv5 / hasImage）',
    typeof status.dib === 'number' && typeof status.dibv5 === 'number' && typeof status.hasImage === 'boolean');

  /* ---------------------------------------------- §2 */
  section('2. 正常路径：走 Electron 的 clipboard.write');
  patchWrite(realWrite);
  const normal = await fileActions.copyImage(GALLERY_PNG);
  check('copyImage 成功', normal.ok === true, JSON.stringify(normal).slice(0, 110));
  check('走的是 Electron 那条路', normal.method === 'electron', `method=${normal.method}`);
  const expectBytes = normal.width * normal.height * 4;
  check('回读到的 CF_DIBV5 体积对得上宽×高×4',
    normal.clipboard && normal.clipboard.dibv5 >= expectBytes,
    `dibv5=${normal.clipboard && normal.clipboard.dibv5} 期望≥${expectBytes}`);
  const blob2 = readClipboardBlob(CF_DIBV5);
  check('真去系统剪贴板量一次也一样（不是自己报的数）',
    blob2 && blob2.length === normal.clipboard.dibv5, blob2 ? `${blob2.length} 字节` : '读不到');

  /* ---------------------------------------------- §3 */
  section('3. clipboard.write 挂死 → 硬超时后走原生兜底（复现「点了没反应」）');
  patchWrite(() => new Promise(() => {}));
  const t0 = Date.now();
  const hung = await fileActions.copyImage(GALLERY_PNG);
  const cost = Date.now() - t0;
  check('copyImage 仍然成功（不再静默吊死）', hung.ok === true, JSON.stringify(hung).slice(0, 130));
  check('改走原生兜底', hung.method === 'native', `method=${hung.method}`);
  check('超时是有限的（≥1500ms 且 < 6s）', cost >= 1500 && cost < 6000, `实测 ${cost}ms`);
  check('attempts 里写明卡在哪一步',
    Array.isArray(hung.attempts) && /没有返回/.test(hung.attempts[0] || ''), (hung.attempts || []).join('；'));
  const blob3 = readClipboardBlob(CF_DIBV5);
  check('兜底写进去的位图体积同样对得上',
    blob3 && blob3.length === 124 + expectBytes, blob3 ? `${blob3.length} 字节` : '读不到');

  /* ---------------------------------------------- §4 */
  section('4. clipboard.write 直接 reject → 同样落到兜底');
  patchWrite(() => Promise.reject(new Error('模拟剪贴板被占用')));
  const rejected = await fileActions.copyImage(GALLERY_PNG);
  check('copyImage 仍然成功', rejected.ok === true, JSON.stringify(rejected).slice(0, 130));
  check('改走原生兜底', rejected.method === 'native', `method=${rejected.method}`);

  /* ---------------------------------------------- §5 */
  section('5. 像素级正确性：兜底写出的位图与 Chromium 写的逐字节相同');
  // 参考样本：让 Chromium 自己写一遍同样这张图（正常路径可用时才拿得到）
  patchWrite(realWrite);
  const viaElectron = await fileActions.copyImage(alphaPng);
  const chromiumPixels = viaElectron.method === 'electron' ? dibV5Pixels() : null;

  patchWrite(() => new Promise(() => {}));
  const alphaCopy = await fileActions.copyImage(alphaPng);
  const ourPixels = dibV5Pixels();

  check('透明 PNG 走兜底也能复制', alphaCopy.ok === true && alphaCopy.method === 'native',
    JSON.stringify(alphaCopy).slice(0, 120));
  const expected = expectedPremultipliedBgra();
  check('像素 == 手算的预乘 BGRA（覆盖 4 个 alpha 边界）',
    Boolean(ourPixels && ourPixels.subarray(0, expected.length).equals(expected)),
    ourPixels ? `实际 ${ourPixels.subarray(0, expected.length).toString('hex')} / 期望 ${expected.toString('hex')}` : '读不到');
  if (chromiumPixels) {
    check('像素 == Chromium 自己写的（同一条 CF_DIBV5 约定）',
      Boolean(ourPixels && ourPixels.equals(chromiumPixels)),
      `${chromiumPixels.length} 字节 / ${ourPixels ? ourPixels.length : 0} 字节`);
  } else {
    console.log('  · Electron 路径这次没生效，跳过「与 Chromium 一致」的对照');
  }

  /* ---------------------------------------------- §6 */
  section('6. 守卫分支（都要给结构化错误，不能静默）');
  const ghost = await fileActions.copyImage(path.join(tmp, '不存在.png'));
  check('文件不在 → 结构化失败', ghost.ok === false && /读不到/.test(ghost.error || ''), ghost.error);
  const bmp = await fileActions.copyImage(SOLID_BMP);
  check('解不出像素的格式（BMP）→ 结构化失败并给出替代做法',
    bmp.ok === false && /PNG \/ JPEG/.test(bmp.error || ''), bmp.error);
  check('空参数 → 结构化失败', (await fileActions.copyImage('')).ok === false);
  const dlgGhost = await fileActions.openWithDialog(path.join(tmp, '不存在.png'));
  check('「打开方式…」目标文件不在 → 结构化失败（不弹空对话框）',
    dlgGhost.ok === false && Boolean(dlgGhost.error), dlgGhost.error);
  const dlgEmpty = await fileActions.openWithDialog('');
  check('「打开方式…」空参数 → 结构化失败', dlgEmpty.ok === false, dlgEmpty.error);

  patchWrite(realWrite);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(main).catch((err) => {
  console.error('验证崩溃:', err);
  app.exit(2);
});
