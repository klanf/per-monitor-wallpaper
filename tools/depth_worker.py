# -*- coding: utf-8 -*-
"""
depth_worker.py —— depthService.js 的常驻深度生成 worker（stdin/stdout 行协议）

协议（每行一个 JSON）:
  入: {"path": "<原图绝对路径>", "out": "<depth png 输出绝对路径>",
       "out_mask": "<mask png 输出绝对路径>", "out_bg": "<背景板 jpg 输出绝对路径>",
       "depth_in": "<已有 depth png 绝对路径，可选 —— 旧缓存回填 mask/bg 时跳过推理>"}
      或字符串 "EXIT"（礼貌退出）
  出: "DONE" / "FAIL <原因>"（行缓冲，必须 flush）
      "WARN <环节> <原因>" —— 图层环节失败，深度照常交付

素材三件套（第八轮 v2）:
  - depth.png     深度图（推理后做边缘外扩 ~2px：近景吃进远景，压边缘拉伸）
  - mask.png      前景 alpha —— ISNet 动漫分割（isnetis.onnx）优先，Otsu 回退
  - bg.jpg        背景板 —— LaMa（big-lama.pt torchscript）优先，Telea 回退
  任一环节失败只 WARN 不 FAIL —— 主进程/渲染端按文件存在性自动降级。
  depth_in 存在时不跑深度模型（复用已有深度图，仅补 mask/bg）。

模型位置：tools/models/{isnetis.onnx, big-lama.pt}；深度模型从 --model 目录加载。
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


# ── ISNet 动漫分割（第八轮新增，Otsu 的替代/上位）────────────────────────
_ISNET = {'sess': None, 'in_name': None, 'failed': False}

def isnet_session(model_dir):
    """懒加载 ISNet ONNX；失败置 failed，后续调用直接回退 Otsu。"""
    if _ISNET['failed']:
        return None
    if _ISNET['sess'] is not None:
        return _ISNET['sess']
    try:
        import onnxruntime as ort
        # onnxruntime 的 CUDA provider 需要 cublasLt64_12/cudnn9 —— 本机没单独装，
        # 但 torch 自带同款 DLL：把 torch/lib 暴露给 DLL 搜索即可上 GPU（CPU 跑 1024 要 ~15s）
        try:
            import torch as _torch
            _tlib = os.path.join(os.path.dirname(_torch.__file__), 'lib')
            if os.path.isdir(_tlib):
                os.add_dll_directory(_tlib)
        except Exception:  # noqa: BLE001
            pass
        p = os.path.join(model_dir, 'isnetis.onnx')
        if not os.path.isfile(p):
            raise FileNotFoundError(p)
        providers = ['CUDAExecutionProvider', 'CPUExecutionProvider']
        sess = ort.InferenceSession(p, providers=providers)
        _ISNET['sess'] = sess
        _ISNET['in_name'] = sess.get_inputs()[0].name
        print('WARN isnet loaded', flush=True)   # 借 WARN 通道报一次加载成功
        return sess
    except Exception as e:  # noqa: BLE001
        print(f'WARN isnet unavailable {type(e).__name__}: {e}', flush=True)
        _ISNET['failed'] = True
        return None


def isnet_mask(im_rgb, model_dir):
    """ISNet 前景 alpha（0~255 uint8，自带软边）。失败抛异常由调用方回退。"""
    import cv2
    import numpy as np
    sess = isnet_session(model_dir)
    if sess is None:
        raise RuntimeError('ISNet 不可用')
    S = 1024
    img = np.asarray(im_rgb, dtype=np.float32) / 255.0
    h, w = img.shape[:2]
    scale = S / max(h, w)
    nh, nw = max(1, round(h * scale)), max(1, round(w * scale))
    small = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
    ph, pw = S - nh, S - nw
    padded = np.pad(small, ((ph // 2, ph - ph // 2), (pw // 2, pw - pw // 2), (0, 0)))
    x = padded.transpose(2, 0, 1)[None].astype(np.float32)
    out = sess.run(None, {_ISNET['in_name']: x})[0]      # [1,1,1024,1024]
    m = out[0, 0]
    m = m[ph // 2: ph // 2 + nh, pw // 2: pw // 2 + nw]  # 去 letterbox
    m = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR)
    return (np.clip(m, 0, 1) * 255).astype(np.uint8)


def clean_mask_soft(m_soft):
    """软 mask 清理：主体阈值 → 闭补小洞 → 掐碎域 → 轻羽化。"""
    import cv2
    import numpy as np
    fg = (m_soft > 64).astype(np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    n, labels, st, _ = cv2.connectedComponentsWithStats(fg, 8)
    min_area = 0.004 * fg.size
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] < min_area:
            fg[labels == i] = 0
    if fg.mean() > 0.92:   # 全图「前景」＝分割不可信
        raise RuntimeError('前景占比 >92%，mask 不可信')
    soft = np.maximum(m_soft.astype(np.float32), fg * 255 * 0.0)
    soft = np.where(fg > 0, np.maximum(soft, 96), soft)  # 主体内压住低于 96 的洞
    return cv2.GaussianBlur(soft.astype(np.uint8), (0, 0), 1.5)


# ── LaMa 背景板（第八轮新增，Telea 的上位）──────────────────────────────
_LAMA = {'model': None, 'failed': False}
LAMA_MAX_SIDE = 768           # bbox 裁剪后输入上限（FFT 成本随面积暴涨，裁剪+限边双保险）

def lama_model():
    """懒加载 LaMa torchscript；优先原版 big-lama.pt（standard FFC，GPU ~1s 级），
    备选动漫微调版 anime_manga_lama.pt（large FFC，修补质量对动漫背景更好但
    3070Ti 上 FFT 慢 10 倍+，实测 14s/张 —— 只当原版缺失时的兜底）。
    失败置 failed，回退 Telea。"""
    if _LAMA['failed']:
        return None
    if _LAMA['model'] is not None:
        return _LAMA['model']
    try:
        import torch
        here = os.path.dirname(os.path.abspath(__file__))
        for name in ('big-lama.pt', 'anime_manga_lama.pt'):
            p = os.path.join(here, 'models', name)
            if os.path.isfile(p):
                dev = 'cuda' if torch.cuda.is_available() else 'cpu'
                m = torch.jit.load(p, map_location=dev).eval()
                _LAMA['model'] = (m, dev)
                print(f'WARN lama loaded {name} dev={dev}', flush=True)
                return _LAMA['model']
        raise FileNotFoundError('models/ 下没有 anime_manga_lama.pt 或 big-lama.pt')
    except Exception as e:  # noqa: BLE001
        print(f'WARN lama unavailable {type(e).__name__}: {e}', flush=True)
        _LAMA['failed'] = True
        return None


def lama_inpaint(im_rgb, hole_mask_u8):
    """LaMa 修补。hole: uint8，>0 处待补。返回 RGB ndarray（原尺寸）。失败抛异常。
    性能关键：LaMa 的 FFT 层成本随面积暴涨（全图 1280 要 ~18s），而修补只需要
    洞附近的内容 —— 取 hole 包围盒外扩 20% 裁剪后跑，输出贴回（实测 ~2s 级）。"""
    import cv2
    import numpy as np
    import torch
    from PIL import Image
    pair = lama_model()
    if pair is None:
        raise RuntimeError('LaMa 不可用')
    model, dev = pair
    arr = np.asarray(im_rgb)
    h, w = arr.shape[:2]
    ys, xs = np.where(hole_mask_u8 > 0)
    if len(ys) == 0:
        return arr.copy()
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    padY = int((y1 - y0) * 0.2) + 48
    padX = int((x1 - x0) * 0.2) + 48
    cy0, cy1 = max(0, y0 - padY), min(h, y1 + padY)
    cx0, cx1 = max(0, x0 - padX), min(w, x1 + padX)
    crop = arr[cy0:cy1, cx0:cx1]
    hole = hole_mask_u8[cy0:cy1, cx0:cx1]
    ch, cw = crop.shape[:2]
    s = min(1.0, LAMA_MAX_SIDE / max(ch, cw))
    tw, th = max(8, round(cw * s) // 8 * 8), max(8, round(ch * s) // 8 * 8)
    small = cv2.resize(crop, (tw, th), interpolation=cv2.INTER_AREA)
    hsmall = cv2.resize(hole, (tw, th), interpolation=cv2.INTER_NEAREST)
    t_img = torch.from_numpy(small.astype(np.float32) / 255.0).permute(2, 0, 1)[None].to(dev)
    t_mask = torch.from_numpy((hsmall > 0).astype(np.float32))[None, None].to(dev)
    with torch.no_grad():
        out = model(t_img, t_mask)[0]                    # [3,H,W] 0~1
    patched = (out.clamp(0, 1).permute(1, 2, 0).float().cpu().numpy() * 255).astype(np.uint8)
    patched = cv2.resize(patched, (cw, ch), interpolation=cv2.INTER_CUBIC)
    result = arr.copy()
    m3 = (hole > 0)[:, :, None]
    result[cy0:cy1, cx0:cx1] = np.where(m3, patched, crop)   # 洞外原样（LaMa 已保真，双保险）
    return result


def make_layers(im_rgb, depth_img, out_mask, out_bg, model_dir):
    """mask（ISNet→Otsu）+ 背景板（LaMa→Telea）。任何上位失败自动回退下位。"""
    import cv2
    import numpy as np
    from PIL import Image

    m_soft = None
    try:
        m_soft = clean_mask_soft(isnet_mask(im_rgb, model_dir))
        src = 'isnet'
    except Exception as e:  # noqa: BLE001
        print(f'WARN isnet fallback {type(e).__name__}: {e}', flush=True)

    if m_soft is None:   # ── Otsu 回退（第六轮逻辑原样）──
        d = np.asarray(depth_img, dtype=np.float32)
        if d.ndim == 3:
            d = d[:, :, 0]
        span = float(d.max() - d.min())
        if span < 1e-6:
            raise RuntimeError('深度图无对比度')
        d = (d - d.min()) / span
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
        if fg.mean() > 0.92:
            raise RuntimeError('Otsu 前景占比 >92%%，mask 不可信')
        m_soft = cv2.GaussianBlur((fg * 255).astype(np.uint8), (0, 0), 2.0)
        src = 'otsu'

    save_img_atomic(Image.fromarray(m_soft, mode='L'), out_mask, 'PNG')
    print(f'WARN mask={src}', flush=True)

    # ── 背景板：LaMa 优先（bbox 裁剪修补，洞外原样贴回），Telea 回退 ──
    hm, wm = m_soft.shape
    src_img = cv2.resize(np.asarray(im_rgb), (wm, hm), interpolation=cv2.INTER_AREA)
    hole = cv2.dilate((m_soft > 10).astype(np.uint8), np.ones((9, 9), np.uint8))
    bg = None
    try:
        bg = lama_inpaint(Image.fromarray(src_img), hole)
        print('WARN bg=lama', flush=True)
    except Exception as e:  # noqa: BLE001
        print(f'WARN lama fallback {type(e).__name__}: {e}', flush=True)
    if bg is None:
        bg = cv2.inpaint(src_img, hole, 5, cv2.INPAINT_TELEA)
        print('WARN bg=telea', flush=True)
    save_img_atomic(bg, out_bg, 'JPG')


def expand_depth(d_img):
    """深度边缘外扩（Tiefling 技巧）：近景值吃进远景 2px，压渲染端边缘拉伸。"""
    import cv2
    import numpy as np
    a = np.asarray(d_img, dtype=np.float32)
    if a.ndim == 3:
        a = a[:, :, 0]
    span = float(a.max() - a.min())
    if span > 1e-6:
        a = (a - a.min()) / span
        a = cv2.dilate(a, np.ones((3, 3), np.float32), iterations=2)
    from PIL import Image
    return Image.fromarray(a)


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

    pipe = None
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
                d = expand_depth(d)              # 边缘外扩：压渲染端轮廓拉伸
                save_img_atomic(d, job['out'], 'PNG')

            # 素材三件套：失败只 WARN，深度照常交付（渲染端按文件存在性降级）
            if job.get('out_mask') and job.get('out_bg'):
                try:
                    dw, dh = max(1, w0 // 2), max(1, h0 // 2)
                    d_aligned = d.resize((dw, dh), Image.LANCZOS)
                    make_layers(im, d_aligned, job['out_mask'], job['out_bg'], model_dir)
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
