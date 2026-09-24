'use strict';

/**
 * 图片文件操作 —— 右键菜单背后的全部动作。
 *
 * 设计上只做「把一个文件从 A 弄到 B」这一件事，并且：
 *   · 每个动作都返回结构化结果，不抛异常给调用方（菜单点了没反应最难受）；
 *   · 删除一律走回收站（shell.trashItem），不提供永久删除 —— 壁纸库误删代价太高；
 *   · 移动优先用 rename（同盘瞬时完成），跨盘才退化成 copy + unlink；
 *   · 目标目录有同名文件时自动改名，绝不静默覆盖。
 */

const { clipboard, ClipboardItem, nativeImage, shell, dialog } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const clipboardWin = require('./clipboardWin');

/* ---------------------------------------------------------------- 命名 */

/**
 * 目标目录里已有同名文件时，生成 `名字 (2).jpg` 这样的可用名。
 * 不覆盖是硬规则：用户的壁纸库是长期积累的，一次静默覆盖无法挽回。
 */
async function uniqueDestination(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);

  for (let i = 2; i < 200; i += 1) {
    try {
      await fsp.access(candidate);
      candidate = path.join(dir, `${stem} (${i})${ext}`);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

/* ---------------------------------------------------------------- 剪贴板 */

/**
 * `clipboard.write()` 的等待上限。
 *
 * 实测（Electron 44.3.0 / Windows）：剪贴板被别的程序占着、或 Chromium 那边
 * 状态没走完时，这个 Promise 会**既不 resolve 也不 reject**。表现出来就是
 * 菜单点了没有任何提示、粘贴也拿不到东西 —— 正是「复制图像到剪贴板失效」的样子。
 * 所以这里给一个硬超时，超了就换下面那条不依赖 Chromium 的兜底写法。
 */
const CLIPBOARD_WRITE_TIMEOUT_MS = 1500;

/** 给 Promise 加死线，永不抛：返回 {status:'ok'|'error'|'timeout', value?, error?} */
function withDeadline(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => finish({ status: 'timeout' }), ms);
    Promise.resolve(promise).then(
      (value) => finish({ status: 'ok', value }),
      (err) => finish({ status: 'error', error: (err && err.message) || String(err) }),
    );
  });
}

/**
 * 复制图片像素（可以粘进 Word / 画图 / PS / 微信等）。
 *
 * Electron 44 的主进程 clipboard 已换成 W3C 异步风格：writeImage 不存在了，
 * 改成 write([ClipboardItem])。写 `image/png` 时 Chromium 会自动转换成
 * CF_DIBV5 / CF_BITMAP / CF_DIB 一并放进系统剪贴板 —— 正常路径够用。
 *
 * 但「够用」不能靠猜：Chromium 用的是**延迟渲染**，`write()` resolve 只代表
 * 它认领了剪贴板。所以这里三步走，每步都有可核对的证据：
 *   ① 走 Electron 的 write()（带硬超时，防它吊死）；
 *   ② **当场回读系统剪贴板**，量 CF_DIB / CF_DIBV5 的真实体积 ——
 *      对得上 `宽×高×4` 才算真的写进去了（这一步顺带把延迟渲染的数据实体化）；
 *   ③ 对不上就换原生直写（clipboardWin.writeImage：自己拼 CF_DIBV5 + PNG，
 *      立即交出真实句柄），再回读一次。
 *
 * 返回值带 `method`（electron / native），失败时带 `attempts` 说明每一步卡在哪。
 */
async function copyImage(imagePath) {
  try {
    if (!imagePath) return { ok: false, error: '没有文件' };

    try {
      const st = await fsp.stat(imagePath);
      if (!st.isFile()) return { ok: false, error: '不是文件' };
    } catch (err) {
      return { ok: false, error: `文件已经读不到了（${err.code || err.message}）` };
    }

    const img = nativeImage.createFromPath(imagePath);
    if (img.isEmpty()) {
      return {
        ok: false,
        error: '这个格式解不出像素（Electron 的解码器只认 PNG / JPEG）—— 可以改用「复制文件到剪贴板」',
      };
    }

    const { width, height } = img.getSize();
    const png = img.toPNG();
    if (!png || !png.length) return { ok: false, error: '转 PNG 失败，无法写入剪贴板' };

    const expect = width * height * 4;
    const attempts = [];

    // ① Electron / Chromium 的正常路径
    const w3c = await withDeadline(
      clipboard.write([new ClipboardItem({
        'image/png': new Blob([png], { type: 'image/png' }),
      })]),
      CLIPBOARD_WRITE_TIMEOUT_MS,
    );

    if (w3c.status === 'ok') {
      const after = clipboardWin.readImageStatus();
      if (after.ok && (after.dibv5 >= expect || after.dib >= expect)) {
        return {
          ok: true, width, height, bytes: png.length, method: 'electron',
          clipboard: { dib: after.dib, dibv5: after.dibv5 },
        };
      }
      attempts.push(after.ok
        ? `electron 写完回读不完整（CF_DIB=${after.dib} / CF_DIBV5=${after.dibv5}，期望≥${expect}）`
        : `electron 写完读不了剪贴板：${after.error}`);
    } else if (w3c.status === 'timeout') {
      attempts.push(`electron 的 clipboard.write 在 ${CLIPBOARD_WRITE_TIMEOUT_MS}ms 内没有返回`);
    } else {
      attempts.push(`electron 的 clipboard.write 报错：${w3c.error}`);
    }

    // ② 原生兜底：绕开 Chromium 自己写 CF_DIBV5（+ 原始 PNG 的注册格式）
    const nativeWrite = clipboardWin.writeImage({
      bgra: img.toBitmap(), width, height, png,
    });
    if (!nativeWrite.ok) {
      return { ok: false, error: `写入剪贴板失败：${nativeWrite.error}`, attempts };
    }

    const after2 = clipboardWin.readImageStatus();
    if (!after2.ok || !after2.hasImage) {
      return {
        ok: false,
        error: `兜底写入后回读不到图片（${after2.error || '剪贴板里没有 CF_DIB / CF_DIBV5'}）`,
        attempts,
      };
    }

    return {
      ok: true, width, height, bytes: png.length, method: 'native', attempts,
      clipboard: { dib: after2.dib, dibv5: after2.dibv5 },
    };
  } catch (err) {
    // 兜底中的兜底：这个方法绝不抛异常，否则菜单点了会连提示都没有
    return { ok: false, error: `复制图像时出错：${err.message}` };
  }
}

/**
 * 复制「文件」本身（可以在资源管理器里 Ctrl+V 粘贴出这个文件）。
 *
 * 这一步 Electron 44 帮不上忙：拿 `CF_HDROP` 这个名字去 clipboard.write()，
 * 只会注册出一个同名的**自定义**格式（实测 id 0xc323），资源管理器不认；
 * 它要的是系统标准 CF_HDROP（id 15）。所以走 clipboardWin 用 Win32 直写。
 */
function copyFile(imagePaths) {
  const list = (Array.isArray(imagePaths) ? imagePaths : [imagePaths]).filter(Boolean);
  if (list.length === 0) return { ok: false, error: '没有文件' };

  const result = clipboardWin.writeFiles(list);
  return result.ok ? { ok: true, count: list.length } : result;
}

async function copyText(text) {
  if (!text) return { ok: false, error: '没有内容' };
  try {
    await clipboard.writeText(String(text));
    return { ok: true, length: String(text).length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ---------------------------------------------------------------- 搬移 */

/**
 * 移动到 / 复制到指定文件夹。
 * @param {string} imagePath
 * @param {string} targetDir
 * @param {'move'|'copy'} mode
 */
async function transfer(imagePath, targetDir, mode = 'move') {
  if (!imagePath || !targetDir) return { ok: false, error: '参数不完整' };

  try {
    const stat = await fsp.stat(imagePath);
    if (!stat.isFile()) return { ok: false, error: '不是文件' };
  } catch (err) {
    return { ok: false, error: `源文件不可读：${err.code || err.message}` };
  }

  // 已经在目标目录里就不动，免得原地生成一个「xxx (2).jpg」
  if (path.dirname(path.resolve(imagePath)).toLowerCase() === path.resolve(targetDir).toLowerCase()) {
    return { ok: false, error: '这个文件已经在该文件夹里了' };
  }

  try {
    await fsp.mkdir(targetDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `目标文件夹不可用：${err.message}` };
  }

  const dest = await uniqueDestination(targetDir, path.basename(imagePath));

  try {
    if (mode === 'copy') {
      await fsp.copyFile(imagePath, dest);
    } else {
      try {
        await fsp.rename(imagePath, dest);
      } catch (err) {
        // EXDEV = 跨盘（F: → D:），rename 不成立，退化成复制 + 删除
        if (err.code === 'EXDEV') {
          await fsp.copyFile(imagePath, dest);
          await fsp.unlink(imagePath);
        } else if (err.code === 'EPERM' || err.code === 'EBUSY') {
          return { ok: false, error: '文件被占用（可能正被别的程序打开）' };
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }

  return { ok: true, dest, name: path.basename(dest), mode };
}

/* ---------------------------------------------------------------- 删除 */

/**
 * 删除到回收站。
 * 刻意不提供「永久删除」—— 壁纸库是长期积累的，误删无法挽回，
 * 回收站多一步操作换的是可撤销。
 */
async function trash(imagePath) {
  if (!imagePath) return { ok: false, error: '没有文件' };
  try {
    await fsp.access(imagePath);
  } catch {
    return { ok: false, error: '文件已经不存在了' };
  }

  const name = path.basename(imagePath);
  try {
    await shell.trashItem(imagePath);
    return { ok: true, name };
  } catch (err) {
    /*
     * 「Operation was aborted」是 shell.trashItem 的已知假失败：
     * 文件其实已经进了回收站，但 IFileOperation 的收尾回调返回 E_ABORT，
     * 于是 Promise 被 reject。如果这时报失败，上层就不会更新轮播列表，
     * 用户会看到「删不掉」+ 列表里留着一张已经不存在的图。
     * 所以这里以磁盘上的事实为准：文件真的没了，就算成功。
     */
    const gone = !fs.existsSync(imagePath);
    if (gone) return { ok: true, name, note: `trashItem 报 ${err.message}，但文件已离开原位置` };
    return { ok: false, error: `移入回收站失败：${err.message}` };
  }
}

/* ---------------------------------------------------------------- 打开 */

/** 用系统默认程序打开 */
async function openExternally(imagePath) {
  const err = await shell.openPath(imagePath);
  return err ? { ok: false, error: err } : { ok: true };
}

/**
 * 打开所在文件夹 —— 并且**选中这张图**。
 *
 * 之前用的是 `shell.openPath(dirname)`：只把文件夹打开，动画多、子文件夹多的时候
 * 用户还得自己在里面找刚才那张图。改用 `showItemInFolder`，等价于 Explorer 的
 * `/select,` 参数：打开文件夹 + 选中 + 滚动到可见位置，一步到位。
 *
 * 代价是它不返回错误（`shell.openPath` 会返回错误字符串）。所以路径不存在时
 * 我们在这里自己判一下，别让菜单点了毫无反应。
 */
async function openContainingFolder(imagePath) {
  const dir = path.dirname(imagePath);
  if (!fs.existsSync(dir)) return { ok: false, error: `文件夹不存在：${dir}` };
  shell.showItemInFolder(imagePath);
  return { ok: true, method: 'select' };
}

/** 在资源管理器中定位并选中 */
function reveal(imagePath) {
  shell.showItemInFolder(imagePath);
  return { ok: true };
}

/**
 * 「打开方式…」对话框。
 * Electron 没有对应 API，Windows 上是 shell32 里那个经典的 OpenAs_RunDLL。
 */
/**
 * 用「用户自己挑的程序」打开图片 —— 沿用原版 Python 的做法：
 * `subprocess.Popen([程序路径, 图片路径])`。
 *
 * 程序列表存在配置里、由用户逐个挑选，所以这里不再做「这个 exe 是否可信」的判断 ——
 * 是他自己挑的。`detached + unref` 是为了不让子进程挂在应用的生命周期上：
 * 关掉壁纸切换器，不该把用户刚打开的看图软件一起关掉。
 *
 * 返回值区分「启动失败」和「启动了」：spawn 的 ENOENT 是异步抛的，
 * 所以留一个短暂的观察窗口，别让菜单点了报成功、其实什么都没发生。
 */
async function launchWith(programPath, imagePath) {
  if (!programPath) return { ok: false, error: '没有指定程序' };
  try {
    await fsp.access(programPath);
  } catch {
    return { ok: false, error: '这个程序找不到了（移动或卸载了？）' };
  }
  try {
    await fsp.access(imagePath);
  } catch {
    return { ok: false, error: '图片已经不在了' };
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    try {
      const child = spawn(programPath, [imagePath], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => done({ ok: false, error: err.message }));
      child.unref();
      setTimeout(() => done({ ok: true, program: path.basename(programPath) }), 300);
    } catch (err) {
      done({ ok: false, error: err.message });
    }
  });
}

/** 弹文件选择框挑一个 exe（对应旧脚本的「➕ 选择程序…」） */
async function pickProgram(win, title = '选择用来打开图片的程序') {
  const result = await dialog.showOpenDialog(win, {
    title,
    properties: ['openFile'],
    filters: [
      { name: '程序', extensions: ['exe'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

/**
 * 系统的「你要如何打开这个文件？」对话框（Windows 的「打开方式」）。
 *
 * Electron 没有对应 API。两条候选路：
 *   · `SHOpenWithDialog`（shell32）—— 现代、能拿到返回值，但它是**模态**的：
 *     直接调会把调用线程的消息循环卡到用户关掉对话框为止。本应用的全部轮播
 *     定时器都在主进程里，卡住就等于桌面定格 —— 不能这么干。
 *   · `rundll32.exe shell32.dll,OpenAs_RunDLL <路径>` —— 另起一个进程，
 *     我们的消息循环一点不受影响。代价是没人能给我们返回值，且首次弹出慢一秒左右。
 *
 * 选后者。慢一秒换「点开对话框的时候壁纸还在正常轮播」，这个交换划算。
 */
async function openWithDialog(imagePath) {
  if (!imagePath) return { ok: false, error: '没有文件' };
  try {
    await fsp.access(imagePath);
  } catch {
    return { ok: false, error: `文件已经不在了：${imagePath}` };
  }
  if (process.platform !== 'win32') return { ok: false, error: '「打开方式」对话框只有 Windows 有' };

  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    try {
      const child = spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', imagePath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', (err) => done({ ok: false, error: `调不出「打开方式」：${err.message}` }));
      child.unref();
      // 对话框由另一个进程画，我们这边只确认「拉起来了」
      setTimeout(() => done({ ok: true, method: 'OpenAs_RunDLL' }), 300);
    } catch (err) {
      done({ ok: false, error: err.message });
    }
  });
}

/* ---------------------------------------------------------------- 预设文件夹 */

/**
 * 从文件夹路径生成预设项。
 * 名字默认取最后一段目录名 —— 用户加的一般是「壁纸/垃圾桶」这种语义化目录。
 */
function makeQuickFolder(dirPath, name) {
  const clean = path.resolve(dirPath);
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  return {
    id: Buffer.from(clean, 'utf16le').toString('base64url').slice(0, 24),
    name: name || parts[parts.length - 1] || clean,
    path: clean,
  };
}

async function pickFolderForQuick(win, title = '选择要加入预设的文件夹') {
  const result = await dialog.showOpenDialog(win, {
    title,
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return makeQuickFolder(result.filePaths[0]);
}

/* ---------------------------------------------------------------- 详情 */

async function fileStats(imagePath) {
  try {
    const st = await fsp.stat(imagePath);
    return {
      ok: true,
      path: imagePath,
      name: path.basename(imagePath),
      dir: path.dirname(imagePath),
      size: st.size,
      mtime: st.mtimeMs,
      readOnly: (st.mode & 0o200) === 0,
    };
  } catch (err) {
    return { ok: false, error: err.code || err.message, path: imagePath };
  }
}

module.exports = {
  copyImage,
  copyFile,
  copyText,
  transfer,
  trash,
  openExternally,
  openContainingFolder,
  reveal,
  launchWith,
  pickProgram,
  openWithDialog,
  makeQuickFolder,
  pickFolderForQuick,
  fileStats,
  uniqueDestination,
};
