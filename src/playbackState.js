'use strict';

/**
 * 播放位置持久化 —— 进程重启（含开机自启）后「接着上次那张播」，而不是回到第一张。
 *
 * 【为什么单独一个文件，不塞进 config.json】
 *   这个东西每次换图都要写，间隔可能只有几秒；而 config.json 是「配置」，
 *   是 store 的唯一真相来源，写它要走 normalize + 深合并，而且用户手改配置时
 *   会在同一个文件上跟你撞车。两者变更频率差三个数量级，混在一起只会让
 *   配置文件全是噪声。所以：独立的文件、独立的写入节奏。
 *
 * 【为什么记路径，而不是只记序号】
 *   序号只对「当时那份列表」有意义 —— 列表一旦重排（走完一轮重洗 / 相簿增删
 *   目录），存「第 27 张」下次启动会落到另一张图上。存路径才能在（可能重排过的）
 *   列表里找回「就是这张」。r34 起顺序本身也持久化了（shuffleOrders.js），
 *   正常情况重启就是同一份顺序的同一个位置；路径定位退化为对账手段。
 *   序号作为**最后兜底**保留：路径找不到时，至少还能落回同一个位置附近。
 *
 * 【写盘节奏】
 *   换图才写，且合并 1.5 秒内的多次改动（连点「下一张」只落一次盘）。
 *   正常退出时 flush 兜底。进程被强杀 / 断电最多丢最后一次 —— 可以接受，
 *   那种情况下用户也不会指望「精确保留到秒」。
 */

const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const SAVE_DEBOUNCE_MS = 1500;
/** 超过这个时长的记录视为过期（显示器换了、目录换了，老记录留着没意义） */
const MAX_AGE_MS = 120 * 24 * 3600 * 1000;

class PlaybackState {
  /**
   * @param {string} filePath 落盘位置（一般是 userData/playback.json）
   * @param {{debounceMs?:number, now?:() => number}} [options] 测试用注入点
   */
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : SAVE_DEBOUNCE_MS;
    this.now = options.now || (() => Date.now());
    /** @type {Record<string, {path:string|null,index:number,album:string,folder:string,playing:boolean,at:number}>} */
    this.channels = {};
    this.timer = null;
    this.dirty = false;
    this.load();
  }

  /** 读盘。文件不存在或内容损坏都当作「没有记录」，不打扰用户 */
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
        this.channels[id] = {
          path: typeof rec.path === 'string' ? rec.path : null,
          index: Number.isFinite(rec.index) ? rec.index : -1,
          album: typeof rec.album === 'string' ? rec.album : '',
          // 旧版记录按目录路径归属（v17 及以前）；scheduler 恢复进度时两种都认
          folder: typeof rec.folder === 'string' ? rec.folder : '',
          playing: typeof rec.playing === 'boolean' ? rec.playing : true,
          at: Number.isFinite(rec.at) ? rec.at : 0,
        };
      }
    } catch {
      this.channels = {};
    }
    return this.channels;
  }

  get(channelId) {
    return this.channels[channelId] || null;
  }

  set(channelId, record) {
    if (!channelId || !record) return;
    this.channels[channelId] = { ...record, at: this.now() };
    this.dirty = true;
    this._schedule();
  }

  forget(channelId) {
    if (!(channelId in this.channels)) return;
    delete this.channels[channelId];
    this.dirty = true;
    this._schedule();
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
      console.error('[playback] 写入播放位置失败:', err.message);
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

module.exports = { PlaybackState, SAVE_DEBOUNCE_MS, MAX_AGE_MS };
