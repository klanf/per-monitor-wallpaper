'use strict';

/**
 * 轮播顺序持久化 —— 重启后「按上次的顺序接着播」，而不是重新洗一次。
 *
 * 【为什么单独一个文件】
 *   每个频道的完整顺序最多几万条路径（3 万张 ≈ 2MB JSON），塞进 config.json
 *   会让每次改间隔都重写 2MB；塞进 playback.json 也不行 —— 那个文件每次换图
 *   都要写（间隔可能只有几秒），给它的写入节奏叠一个 2MB 大文件完全不现实。
 *   顺序只在「走完一轮 / 换相簿 / 切播放模式 / 手动重扫」时才变（见
 *   scheduler._orderFor 的注释），变更频率极低，值得独立一个文件、独立节奏。
 *
 * 【和 playback.json 的分工】
 *   playback.json 记「播到哪张」（按路径找，重排后也能定位）；
 *   本文件记「整份顺序长什么样」。两个都有，重启后才是真正的
 *   「同一份顺序、同一个位置、同一圈「看过」标记」接着播。
 *
 * 【写盘纪律】
 *   set 时逐项对比新旧顺序，**内容没变就不写**（rebuild 会用 saved 顺序原样
 *   重放一遍 this.orders.set，不加这层守卫的话改个间隔就会重写 2MB）。
 *   防抖 3 秒合并连发，正常退出由 scheduler.stop() flush 兜底。
 */

const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const SAVE_DEBOUNCE_MS = 3000;
/** 超过这个时长没变的顺序视为过期（相簿早就换了的老记录留着没意义） */
const MAX_AGE_MS = 120 * 24 * 3600 * 1000;

class ShuffleOrders {
  /**
   * @param {string} filePath 落盘位置（一般是 userData/shuffle-orders.json）
   * @param {{debounceMs?:number, now?:() => number}} [options] 测试用注入点
   */
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : SAVE_DEBOUNCE_MS;
    this.now = options.now || (() => Date.now());
    /** @type {Record<string, {albumId:string, shuffle:boolean, paths:string[], at:number}>} */
    this.channels = {};
    this.timer = null;
    this.dirty = false;
    this.load();
  }

  /** 读盘。文件不存在 / 损坏 / 字段不合法都当作「没有记录」，不打扰用户 */
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const channels = raw && raw.channels;
      if (!channels || typeof channels !== 'object' || Array.isArray(channels)) {
        this.channels = {};
        return this.channels;
      }
      const cutoff = this.now() - MAX_AGE_MS;
      for (const [id, rec] of Object.entries(channels)) {
        if (!rec || typeof rec !== 'object') continue;
        if (Number.isFinite(rec.at) && rec.at < cutoff) continue;
        if (!Array.isArray(rec.paths) || !rec.paths.length) continue;
        this.channels[id] = {
          albumId: typeof rec.albumId === 'string' ? rec.albumId : '',
          shuffle: Boolean(rec.shuffle),
          paths: rec.paths.filter((p) => typeof p === 'string' && p).slice(),
          at: Number.isFinite(rec.at) ? rec.at : 0,
        };
        if (!this.channels[id].paths.length) delete this.channels[id];
      }
    } catch {
      this.channels = {};
    }
    return this.channels;
  }

  all() {
    return this.channels;
  }

  /**
   * 记录一份顺序。新旧内容完全一致时跳过（不标脏、不排定时器）——
   * 这条守卫挡的是「rebuild 原样重放内存顺序」和「重启后恢复的同一份顺序」。
   */
  set(channelId, record) {
    if (!channelId || !record || !Array.isArray(record.paths) || !record.paths.length) return false;
    const prev = this.channels[channelId];
    if (prev
      && prev.albumId === (record.albumId || '')
      && prev.shuffle === Boolean(record.shuffle)
      && prev.paths.length === record.paths.length
      && prev.paths.every((p, i) => p === record.paths[i])) {
      return false;
    }
    this.channels[channelId] = {
      albumId: record.albumId || '',
      shuffle: Boolean(record.shuffle),
      paths: record.paths.slice(),
      at: this.now(),
    };
    this.dirty = true;
    this._schedule();
    return true;
  }

  forget(channelId) {
    if (!(channelId in this.channels)) return;
    delete this.channels[channelId];
    this.dirty = true;
    this._schedule();
  }

  clear() {
    const had = Object.keys(this.channels).length > 0;
    this.channels = {};
    if (had) {
      this.dirty = true;
      this._schedule();
    }
  }

  _schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, this.debounceMs);
    // 这个定时器只负责落盘，不该拖住进程退出
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** 落盘（原子写）。返回是否真的写了 */
  write() {
    if (!this.dirty) return false;
    this.dirty = false;
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, channels: this.channels }, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
      return true;
    } catch (err) {
      console.error('[orders] 写入轮播顺序失败:', err.message);
      return false;
    }
  }

  /** 立即落盘并取消待执行的写（退出前调用） */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.write();
  }
}

module.exports = { ShuffleOrders, SAVE_DEBOUNCE_MS, MAX_AGE_MS };
