# -*- coding: utf-8 -*-
"""歌曲节奏分析：解码 -> RMS 包络 -> 选切换点 -> 生成演示时间轴 JSON。
用法: python analyze-song.py <mp3> <out.json>
切换点策略（社区 showcase 惯例：按段落切，不按每一拍切）:
  - 目标 ~8 段（225s / 8 ≈ 28s，与 30s 定时器同量级）
  - 每个切换点吸附到附近最强的能量起振（onset），让切图踩在节奏上
  - 首段从 ~12s 开始（避开纯前奏），末段留 3s 收尾
"""
import sys, json, subprocess, io, struct
import numpy as np
from imageio_ffmpeg import get_ffmpeg_exe

def decode_mono(src, sr=16000):
    """ffmpeg 解码为 16bit 单声道 PCM，返回 (np.int16 array, sr)"""
    exe = get_ffmpeg_exe()
    cmd = [exe, '-v', 'error', '-i', src, '-ac', '1', '-ar', str(sr),
           '-f', 's16le', '-']
    raw = subprocess.run(cmd, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.int16), sr

def rms_envelope(x, sr, win=0.25):
    n = int(sr * win)
    m = len(x) // n
    x = x[: m * n].astype(np.float32).reshape(m, n)
    env = np.sqrt((x ** 2).mean(axis=1)) / 32768.0
    return env, win

def find_switch_points(env, win, dur, n_seg=8):
    """返回切换时刻列表（不含 0）：每 ~dur/n_seg 一个锚点，吸附到锚点 ±8s 内
    RMS 涨幅最大的起振位置（前一窗 -> 当前窗的能量跳变）。"""
    step = dur / n_seg
    hops = np.diff(env) / (env[:-1] + 1e-6)   # 相对能量涨幅
    pts = []
    t0 = 12.0                                   # 首切避开前奏
    while t0 < dur - 6.0:
        lo = max(0, int((t0 - 4) / win))
        hi = min(len(env) - 1, int((t0 + 8) / win))
        if hi <= lo:
            t0 += step
            continue
        k = lo + int(np.argmax(hops[lo:hi]))
        t = k * win + win / 2
        # 距上一个切换点至少 18s（太密没意义）
        if pts and t - pts[-1] < 18:
            t = pts[-1] + 18
        pts.append(round(float(min(t, dur - 3)), 2))
        t0 = max(t + step * 0.85, t0 + step * 0.6)
    return pts

def find_phrase_boundaries(env, win, dur, min_gap=8.0, max_gap=16.0):
    """乐句边界 = 平滑能量包络的局部谷底（句间换气/间奏）。
    从 ~9s 开始，在 [prev+min_gap, prev+max_gap] 里找最低点作边界，
    输出「唱完一句」级别的切图时间轴。"""
    k = max(1, int(1.2 / win))                  # ~1.2s 平滑窗
    smooth = np.convolve(env, np.ones(k) / k, mode='same')
    pts = []
    prev = 9.0
    while prev < dur - 8.0:
        lo = int((prev + min_gap) / win)                 # 最早可切：prev+8s
        hi = min(len(smooth) - 1, int((prev + max_gap) / win))  # 最晚：prev+16s
        if hi - lo < 2:
            break
        k2 = lo + int(np.argmin(smooth[lo:hi]))
        t = k2 * win + win / 2
        pts.append(round(float(min(t, dur - 4)), 2))
        prev = t
    return pts

def main():
    src, out = sys.argv[1], sys.argv[2]
    x, sr = decode_mono(src)
    dur = len(x) / sr
    env, win = rms_envelope(x, sr)
    pts = find_switch_points(env, win, dur)
    bnds = find_phrase_boundaries(env, win, dur)
    # 全曲能量峰值区间（副歌）—— 供「资金镜头」排鼠标扫动
    seg = max(range(len(env) - 12), key=lambda i: env[i:i+12].mean())
    chorus = round(seg * win, 2)
    json.dump({'duration': round(dur, 2), 'switches': pts, 'chorusCenter': chorus,
               'phrases': bnds},
              io.open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('时长 %.1fs | 段落切换点: %s | 乐句边界(%d): %s | 副歌 ~%.1fs'
          % (dur, pts, len(bnds), bnds, chorus))

if __name__ == '__main__':
    main()
