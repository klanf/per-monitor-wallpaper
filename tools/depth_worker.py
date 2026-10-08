# -*- coding: utf-8 -*-
"""
depth_worker.py —— depthService.js 的常驻深度生成 worker（stdin/stdout 行协议）

协议（每行一个 JSON）:
  入: {"path": "<原图绝对路径>", "out": "<depth png 输出绝对路径>",
       "out_mask": "<mask png 输出绝对路径>", "out_bg": "<背景板 jpg 输出绝对路径>",
       "depth_in": "<已有 depth png 绝对路径，可选 —— 旧缓存回填 mask/bg 时跳过推理>"}
      或字符串 "EXIT"（礼貌退出）
  出: "DONE" / "FAIL <原因>"（行缓冲，必须 flush）

图层分割（第六轮）：深度推理后顺带产出
  - mask.png      前景 alpha（Otsu 阈值 + 形态学清理 + 去小连通域 + 高斯羽化），灰度 8bit
  - bg.jpg        背景板（按 mask 膨胀抠洞，Telea inpaint 补全），大角度视差露洞用它填
  mask/bg 任一失败只打 WARN 不算 FAIL —— 主进程按文件存在性自动降级回单平面。
  depth_in 存在时不跑模型（老缓存只有 depth，回填 mask/bg 复用它，秒级）。

模型从 --model 目录离线加载（curl 直拉的三件套），全程不联网。
写文件走「临时名 + os.replace」保证原子性 —— 主进程 stat 到的一定是完整文件。
"""
import json
import os
import sys


def save_img_atomic(arr_or_img, out, fmt):
    tmp = out + '.tmp'
    if fmt == 'PNG':
        arr_or_img.save(tmp, format='PNG', optimize=True)
    else:
        import cv2
        # ⚠️ cv2.imwrite 按扩展名挑编码器，.tmp 会直接报错 —— 必须 imencode
        ok, buf = cv2.imencode('.jpg', arr_or_img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        if not ok:
            raise RuntimeError('cv2.imencode 失败')
        buf.tofile(tmp)
    os.replace(tmp, out)   # 原子落盘


def make_layers(im_rgb, depth_img, out_mask, out_bg):
    """从（已对齐分辨率的）RGB 原图 + 深度图生成 mask + 背景板。失败抛异常由调用方兜。"""
    import cv2
    import numpy as np
    from PIL import Image

    d = np.asarray(depth_img, dtype=np.float32)
    if d.ndim == 3:
        d = d[:, :, 0]
    span = float(d.max() - d.min())
    if span < 1e-6:
        raise RuntimeError('深度图无对比度')
    d = (d - d.min()) / span                       # 0=远 1=近（DepthAnything 反深度）

    # 前景 mask：Otsu 自动阈值 → 开运算去噪点 → 闭运算补小洞 → 掐掉碎连通域 → 羽化
    d8 = (d * 255).astype(np.uint8)                # Otsu 只吃 8U/16U
    thr, _ = cv2.threshold(d8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    fg = (d8 > thr).astype(np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    n, labels, st, _ = cv2.connectedComponentsWithStats(fg, 8)
    min_area = 0.004 * fg.size
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] < min_area:
            fg[labels == i] = 0
    if fg.mean() > 0.92:                           # 全图都是「前景」＝阈值失效，别害背景板
        raise RuntimeError('Otsu 前景占比 >92%%，mask 不可信')
    m = cv2.GaussianBlur((fg * 255).astype(np.uint8), (0, 0), 2.0)
    save_img_atomic(Image.fromarray(m, mode='L'), out_mask, 'PNG')

    # 背景板：mask 稍膨胀出 hole，Telea 修补（在深度分辨率上做，毫秒级）
    hm, wm = m.shape
    src = cv2.resize(np.asarray(im_rgb), (wm, hm), interpolation=cv2.INTER_AREA)
    hole = cv2.dilate((m > 10).astype(np.uint8), np.ones((9, 9), np.uint8))
    bg = cv2.inpaint(src, hole, 5, cv2.INPAINT_TELEA)
    save_img_atomic(bg, out_bg, 'JPG')


def main():
    # ⚠️ 管道 stdin/stdout 编码必须显式钉死 utf-8：App 从用户桌面环境 spawn 时
    # 没有 PYTHONUTF8，Python 默认按 cp936 解码 —— GBK 尾字节会吃掉 JSON 里的
    # 反斜杠（0x5C），中文/日文路径的任务行直接变 Invalid \escape（2026-10-09 实锤）。
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')
        except Exception:  # noqa: BLE001  理论上管道流都支持；失败也不阻断
            pass

    model_dir = sys.argv[sys.argv.index('--model') + 1] if '--model' in sys.argv else 'model'
    max_side = 2048
    if '--max-side' in sys.argv:
        max_side = int(sys.argv[sys.argv.index('--max-side') + 1])

    os.environ['HF_HUB_OFFLINE'] = '1'
    import numpy as np  # noqa: F401  （transformers 依赖链需要，提前暴露缺失）
    from PIL import Image

    use_model = '--no-model' not in sys.argv   # 纯回填任务可省 6s 模型加载（暂不用，留着）
    pipe = None
    if use_model:
        import torch
        from transformers import pipeline
        dev = 'cuda' if torch.cuda.is_available() else 'cpu'
        pipe = pipeline('depth-estimation', model=model_dir, device=dev)
    print('READY', flush=True)          # 模型加载完成，父进程可开始派活

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        if line == 'EXIT':
            break
        try:
            job = json.loads(line)
            im = Image.open(job['path']).convert('RGB')
            w0, h0 = im.size
            if max(w0, h0) > max_side:
                s = max_side / max(w0, h0)
                im = im.resize((round(w0 * s), round(h0 * s)), Image.LANCZOS)

            # 深度：模型推理，或直接复用已有 sidecar（旧缓存回填 mask/bg，不碰模型）
            if job.get('depth_in'):
                d = Image.open(job['depth_in'])
            else:
                with torch.no_grad():
                    result = pipe(im)
                d = result['depth'] if isinstance(result, dict) else getattr(result, 'depth', result[0])
                dw, dh = max(1, w0 // 2), max(1, h0 // 2)
                d = d.resize((dw, dh), Image.LANCZOS)
                save_img_atomic(d, job['out'], 'PNG')

            # 图层分割：失败只 WARN，深度照常交付（渲染端按文件存在性降级单平面）
            if job.get('out_mask') and job.get('out_bg'):
                try:
                    dw, dh = max(1, w0 // 2), max(1, h0 // 2)
                    d_aligned = d.resize((dw, dh), Image.LANCZOS)
                    make_layers(im, d_aligned, job['out_mask'], job['out_bg'])
                except Exception as e:  # noqa: BLE001
                    print(f'WARN layers {type(e).__name__}: {e}', flush=True)
            print('DONE', flush=True)
        except Exception as e:  # noqa: BLE001  单张失败不能带走 worker
            print(f'FAIL {type(e).__name__}: {e}', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001  模型加载失败等致命错误
        print(f'FATAL {type(e).__name__}: {e}', flush=True)
        sys.exit(1)
