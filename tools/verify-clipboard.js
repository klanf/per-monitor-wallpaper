'use strict';

/**
 * 「复制图像到剪贴板」的验证 —— **需要 Electron**（用的是真剪贴板），但不碰桌面、不弹窗口。
 *
 * 为什么单独有这么一份：这个功能曾经以「菜单点了没有任何反应、粘出来也是空的」
 * 的形式失效过 —— 一个**连错误信息都没有**的失败。根因是 Electron 44 的
 * `clipboard.write()` 在剪贴板被别的程序占着、或内部状态没走完时**既不 resolve
 * 也不 reject**：菜单的 click 就永远停在 await 上，既不报错也不复制。
 *
 * 现在的实现是两条路：大图跳过 PNG 编码（快路），小图三步走（硬超时 → 原生直写兜底
 * → 回读校验）。本脚本把两条路都钉住：
 *   §1 回读接口（readImageStatus）
 *   §2 正常路径：走 Electron 的 write()
 *   §3 write 挂死 → 超时后走原生兜底（就是用户遇到的那个症状的复现）
 *   §4 write 直接 reject → 同样落到兜底
 *   §5 像素级正确性：兜底写出来的 CF_DIBV5 与 Chromium 自己写的**逐字节相同**
 *   §6 守卫分支：文件不在 / 格式解不了 / 空参数
 *   §7 大图快路：阈值判定 / 完全绕开 Chromium / 同一张图两条路比耗时 / 格式集合的取舍
 *      / 「先报进度再干活」的顺序
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

/**
 * 大图夹具的尺寸：必须越过 fileActions.FAST_PATH_PIXELS（12 MP），
 * 否则「自动走快路」根本不会被触发。3600×3600 = 12.96 MP。
 */
const BIG_W = 3600;
const BIG_H = 3600;

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
const RegisterClipboardFormatW = user32.func('uint32 RegisterClipboardFormatW(str16 lpszFormat)');
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

/**
 * 手写一张纯色 PNG（大图夹具）。
 *
 * 为什么要现造一张大图：只有像素数越过阈值才会触发「跳过 PNG 编码」的快路，
 * 仓库里的夹具都是 1280×720（0.92 MP），够不着。
 *
 * 纯色是**刻意**的：压缩后很小、落地快，但决定 `toPNG()` 成本的量是**像素数**，
 * 这个量是真实的一亿分之几都不差。所以它能如实反映两条路的成本差异。
 */
function writeSolidPng(file, width, height, [r, g, b, a] = [200, 40, 90, 255]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA

  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  const row = Buffer.alloc(width * 4);
  for (let x = 0; x < width; x += 1) {
    row[x * 4] = r; row[x * 4 + 1] = g; row[x * 4 + 2] = b; row[x * 4 + 3] = a;
  }
  // 整行（含行过滤器字节）复制，别逐字节写 —— 3600 行 × 14400 字节是 5200 万次写入
  const line = Buffer.concat([Buffer.from([0]), row]);
  for (let y = 0; y < height; y += 1) line.copy(raw, y * stride);

  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
  return file;
}

/* ------------------------------------------------ 驱动 */

const realWrite = clipboard.write.bind(clipboard);
const patchWrite = (fn) => Object.defineProperty(clipboard, 'write', {
  value: fn, configurable: true, writable: true,
});

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-clip-'));
  const alphaPng = writeAlphaPng(path.join(tmp, 'alpha.png'));
  const bigPng = writeSolidPng(path.join(tmp, 'big.png'), BIG_W, BIG_H);

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

  /* ---------------------------------------------- §7 */
  section('7. 大图快路：跳过 PNG 编码（「以前能复制、现在像没反应」的真凶）');

  // ① 阈值判定：只读文件头，不解码
  const planBig = fileActions.planCopy(bigPng);
  check('planCopy 认出大图 → 快路',
    planBig.fast === true && planBig.width === BIG_W && planBig.height === BIG_H,
    `${planBig.width}×${planBig.height} fast=${planBig.fast}`);
  const planGal = fileActions.planCopy(GALLERY_PNG);
  check('planCopy 认出小图 → 不走快路（保住 PNG 格式）',
    planGal.fast === false && planGal.width === 1280,
    `${planGal.width}×${planGal.height} fast=${planGal.fast}`);
  check('阈值就是 fileActions 导出的那个数',
    fileActions.FAST_PATH_PIXELS === 12_000_000, `${fileActions.FAST_PATH_PIXELS}`);

  // ② 强制快路跑 4 像素带 alpha 夹具：这样能和 Chromium 的位图逐字节对照
  let writeCalls = 0;
  patchWrite((...args) => { writeCalls += 1; return realWrite(...args); });
  const forced = await fileActions.copyImage(alphaPng, { fast: true });
  const forcedPixels = dibV5Pixels();
  check('小图也能被强制走快路', forced.ok === true && forced.fast === true && forced.method === 'native',
    JSON.stringify(forced).slice(0, 120));
  check('快路的位图 == Chromium 写的同一份（逐字节）',
    Boolean(forcedPixels && chromiumPixels && forcedPixels.equals(chromiumPixels)),
    forcedPixels && chromiumPixels
      ? `${forcedPixels.length} / ${chromiumPixels.length} 字节`
      : '缺参照样本（§5 那次 Electron 写入没生效）');

  // ③ 真实大图不传参数 → 自动走快路，且完全不碰 Chromium
  const tAuto = Date.now();
  const auto = await fileActions.copyImage(bigPng);
  const costAuto = Date.now() - tAuto;
  check('大图不传参数也自动走快路',
    auto.ok === true && auto.fast === true && auto.method === 'native',
    JSON.stringify(auto).slice(0, 130));
  check('快路一次 clipboard.write 都没调（成本全在 toPNG 上，绕开它就是全部收益）',
    writeCalls === 0, `write 调用 ${writeCalls} 次`);

  // ④ 同一张图、两条路，直接对比（这是「快 8.3 倍」那个结论的可复现版本）
  patchWrite(realWrite);
  const tSlow = Date.now();
  const slow = await fileActions.copyImage(bigPng, { fast: false });
  const costSlow = Date.now() - tSlow;
  const expectBig = BIG_W * BIG_H * 4;
  check('强制老路确实走了 Electron 的 write',
    slow.ok === true && slow.method === 'electron' && slow.fast !== true,
    JSON.stringify(slow).slice(0, 130));
  check('两条路回读的位图都装得下整图（不是空壳）',
    auto.clipboard.dibv5 >= expectBig && slow.clipboard.dibv5 >= expectBig,
    `快路 dibv5=${auto.clipboard.dibv5} / 老路 dibv5=${slow.clipboard.dibv5}，期望≥${expectBig}`);
  check('同一张大图，快路更快', costAuto < costSlow, `快路 ${costAuto}ms vs 老路 ${costSlow}ms`);

  // ⑤ 格式集合的差异 —— 这是快路的**代价**，钉住它免得将来被当成 bug
  const pngId = RegisterClipboardFormatW('PNG');
  check('快路的剪贴板里有 CF_DIBV5（Windows 程序读的就是这个）',
    auto.clipboard.formats.includes(CF_DIBV5), `formats=[${auto.clipboard.formats.join(',')}]`);
  check('快路没写注册格式 PNG（代价：只认 PNG 的程序拿不到无损原件）',
    !auto.clipboard.formats.includes(pngId), `pngId=${pngId}`);
  check('小图（Electron 路）带注册格式 PNG —— 所以小图不走快路',
    slow.clipboard.formats.includes(pngId), `formats=[${slow.clipboard.formats.join(',')}]`);

  // ⑥ 「先报进度，再干活」的顺序：提示必须发生在同步冻结**之前**
  const notices = [];
  const tNotice = Date.now();
  const withNotice = await fileActions.copyImageWithNotice(
    GALLERY_PNG,
    (text) => notices.push({ text, at: Date.now() - tNotice }),
  );
  const costNotice = Date.now() - tNotice;
  check('复制前先发了一条进度提示',
    notices.length === 1 && /正在复制图像/.test(notices[0].text), JSON.stringify(notices));
  check('进度提示带上了分辨率（用户能判断该不该等）',
    /1280×720/.test(notices[0].text), notices[0].text);
  check('提示发生在冻结之前，不是干完活才报',
    notices[0].at < costNotice - 40, `提示 ${notices[0].at}ms / 总 ${costNotice}ms`);
  check('编排之后的最终结果依然是可用的复制结果', withNotice.ok === true,
    JSON.stringify(withNotice).slice(0, 100));

  patchWrite(realWrite);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(main).catch((err) => {
  console.error('验证崩溃:', err);
  app.exit(2);
});
