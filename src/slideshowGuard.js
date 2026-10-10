'use strict';

/**
 * slideshow.ini 守卫（59 轮）。
 *
 * ---------------------------------------------------------------------------
 * 一、为什么要存在
 * ---------------------------------------------------------------------------
 * 每次调 IDesktopWallpaper::SetWallpaper 写系统壁纸，Explorer 都会把
 * %APPDATA%\Microsoft\Windows\Themes\slideshow.ini **清成 0 字节**并把个性化
 * 的背景模式打回「图片」（57 轮取证：本机实测 ini 0 字节 + 模式被踩）。
 *
 * 后果比「模式被打回」更隐蔽：slideshow.ini 里存的是**幻灯片的相册配置**，
 * 被清空后，即使用户退出本程序（或在托盘勾了「接管系统壁纸=关」让位），
 * 再去 Windows 个性化里选「幻灯片放映」也起不来 —— 相册配置已经没了。
 * 用户实测（59 轮）：退出后在个性化切幻灯片「秒回壁纸」。
 *
 * ---------------------------------------------------------------------------
 * 二、守卫策略：写前快照，退出/让位时还原
 * ---------------------------------------------------------------------------
 * - **写前快照**：任何一笔系统壁纸写入前，若 ini 有内容（>0 字节，说明是
 *   用户配置过的相册），先复制一份到 userData 下。只快照，不打扰写入；
 *   ini 已是 0 字节（多半已被自己上一笔踩掉）就保持手头已有的快照不覆盖。
 * - **还原时机**：① 托盘/设置里「接管系统壁纸」从开拨到关（让位）的瞬间；
 *   ② 应用退出、锚点补写完成后。两处都只在 ini 为空且有快照时才还原。
 * - 还原只是把相册配置文件放回去，**不会**替用户把背景模式拨成幻灯片
 *   （那是 Explorer 的 BackgroundType，不动）；用户去个性化点一下
 *   「幻灯片放映」即可，相册还是他原来选的那个。
 *
 * ---------------------------------------------------------------------------
 * 三、可单测性
 * ---------------------------------------------------------------------------
 * snapshotIfGood / restoreIfEmpty 只碰文件系统，themesDir 与备份路径都由
 * 调用方显式传入，单测用临时目录即可覆盖全部分支；本模块不 require electron。
 */

const fs = require('fs');
const path = require('path');

/** 系统 Themes 目录（slideshow.ini 所在）。APPDATA 取不到就返回 null（守卫静默失效）。 */
function themesDir() {
  const base = process.env.APPDATA;
  if (!base) return null;
  return path.join(base, 'Microsoft', 'Windows', 'Themes');
}

/**
 * 写系统壁纸**之前**调用：ini 有内容时快照一份。
 * ini 为 0 字节 / 不存在 / 读取失败 → 不动快照（保留上一份好的），返回 false。
 */
function snapshotIfGood(themesDirIn, backupFile) {
  try {
    const ini = path.join(themesDirIn, 'slideshow.ini');
    const st = fs.statSync(ini);
    if (!st.isFile() || st.size === 0) return false;
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    fs.copyFileSync(ini, backupFile);
    return true;
  } catch {
    return false;   // Themes 目录不存在等极端环境：守卫静默失效，绝不影响写壁纸
  }
}

/**
 * 让位 / 退出时调用：ini 为空（被踩）且手上有非空快照 → 还原，返回 true。
 * ini 还有内容（比如用户自己在用幻灯片，或 Explorer 又写回了配置）→ 不动。
 */
function restoreIfEmpty(themesDirIn, backupFile) {
  try {
    const ini = path.join(themesDirIn, 'slideshow.ini');
    let empty = true;
    try {
      const st = fs.statSync(ini);
      empty = !(st.isFile() && st.size > 0);
    } catch { empty = true; }   // 不存在 = 空
    if (!empty) return false;
    const b = fs.statSync(backupFile);
    if (!b.isFile() || b.size === 0) return false;
    fs.copyFileSync(backupFile, ini);
    return true;
  } catch {
    return false;   // 没有快照 / 备份损坏：什么都不做
  }
}

module.exports = { themesDir, snapshotIfGood, restoreIfEmpty };
