# -*- coding: utf-8 -*-
# POM 渲染复现器：逐行复刻 stage.js flowSample 的数学（circle 预设 / cover / q=0.5），
# 用真实深度图渲染屏幕 1:1 裁片，对拍四种深度变体的轮廓锯齿（楼梯块）。
# 变体：v2(现行) / da3-rep(现行, dilate2x) / da3-nodil(无膨胀) / da3-dilblur(膨胀+高斯羽化)
# 用法：F:/miniconda3/python.exe tools/pom-sim.py <imgPath> <base>
import numpy as np
from PIL import Image
import os, sys

IMG = sys.argv[1]
BASE = sys.argv[2]
OUT = os.path.join(os.path.dirname(__file__), 'out', 'pom-sim')
os.makedirs(OUT, exist_ok=True)
AB = os.path.join(os.path.dirname(__file__), 'out', 'depth-ab')

# ---- shader 常量（stage.js 默认） ----
HEIGHT, STEADY, ISO, FOCUS, ZOOM = 0.2, 0.3, 0.6, 0.0, 1.0
Q = 0.5
PROBE = 1.0 / (50 + (120 - 50) * Q)        # 1/85
QUALITY = 1.0 / (200 + (2000 - 200) * Q)   # 1/1100
SAFE = 1.0 - HEIGHT
OFF = (0.35, -0.25)                        # circle 幅度内取大位移（锯齿最明显处）
SCR_W, SCR_H = 2560, 1440
CANVAS_ASPECT = SCR_W / SCR_H

def load_depth(name):
    im = Image.open(os.path.join(AB, name))
    if im.mode != 'L': im = im.convert('L')
    d = np.asarray(im, dtype=np.float64) / 255.0
    return d  # (dh, dw)

def load_depth_at(dirpath, fname):
    im = Image.open(os.path.join(dirpath, fname))
    if im.mode != 'L': im = im.convert('L')
    return np.asarray(im, dtype=np.float64) / 255.0

def mirror(u):
    # texMirror: 1 - |1 - mod(u,2)|
    return 1.0 - np.abs(1.0 - np.mod(u, 2.0))

def bilinear(img, sx, sy):
    """img (H,W) 或 (H,W,3)，sx/sy 像素坐标数组，镜像取址（与 texMirror 一致）。"""
    H, W = img.shape[:2]
    sx = mirror(sx); sy = mirror(sy)
    sx = np.clip(sx * W - 0.5, 0, W - 1.001)
    sy = np.clip(sy * H - 0.5, 0, H - 1.001)
    x0 = np.floor(sx).astype(np.int64); y0 = np.floor(sy).astype(np.int64)
    fx = (sx - x0); fy = (sy - y0)
    if img.ndim == 3: fx = fx[..., None]; fy = fy[..., None]
    x1 = np.minimum(x0 + 1, W - 1); y1 = np.minimum(y0 + 1, H - 1)
    a = img[y0, x0]; b = img[y0, x1]; c = img[y1, x0]; d = img[y1, x1]
    out = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
    return out

def _march(depth, org_x, org_y, it_x, it_y, img_aspect, shape):
    """逐像素复刻 shader 两阶段步进：fwd 粗探首个穿越点，back 细步回退到表面外。"""
    walk = np.zeros(shape)
    hit_done = np.zeros(shape, dtype=bool)
    guv_x = np.full(shape, np.nan); guv_y = np.full(shape, np.nan)
    for _ in range(140):                      # fwd：1/85 步长，walk 上限 1.0
        active = (~hit_done) & (walk < 1.0)
        if not active.any(): break
        walk = np.where(active, walk + PROBE, walk)
        t = SAFE + (1.0 - SAFE) * walk
        px = org_x + (it_x - org_x) * t; py = org_y + (it_y - org_y) * t
        stx = px / img_aspect * 0.5 + 0.5; sty = py * 0.5 + 0.5
        val = bilinear(depth, stx, sty)
        hit = active & ((1.0 - t) < HEIGHT * val)
        guv_x = np.where(hit, px, guv_x); guv_y = np.where(hit, py, guv_y)
        hit_done |= hit
    walk_b = walk.copy()
    back_done = np.zeros(shape, dtype=bool)
    for _ in range(60):                       # back：1/1100 步长回退
        active = ~back_done
        if not active.any(): break
        walk_b = np.where(active, walk_b - QUALITY, walk_b)
        t = SAFE + (1.0 - SAFE) * walk_b
        px = org_x + (it_x - org_x) * t; py = org_y + (it_y - org_y) * t
        stx = px / img_aspect * 0.5 + 0.5; sty = py * 0.5 + 0.5
        val = bilinear(depth, stx, sty)
        outside = active & ((1.0 - t) >= HEIGHT * val)
        guv_x = np.where(outside, px, guv_x); guv_y = np.where(outside, py, guv_y)
        back_done |= outside
    # 从未回退到表面外的（射线始终在表面下）→ 取 fwd 命中点
    guv_x = np.where(np.isnan(guv_x), org_x + (it_x - org_x) * (SAFE + (1 - SAFE) * walk), guv_x)
    guv_y = np.where(np.isnan(guv_y), org_y + (it_y - org_y) * (SAFE + (1 - SAFE) * walk), guv_y)
    return guv_x, guv_y

def render(depth, color, img_aspect, crop_box):
    """depth (dh,dw)，color (h0,w0,3) uint8；crop_box=(x0,y0) 屏幕 1:1 裁片 512²。"""
    x0, y0 = crop_box
    xs = np.arange(x0, x0 + 512) + 0.5
    ys = np.arange(y0, y0 + 512) + 0.5
    uvx, uvy = np.meshgrid(xs / SCR_W, ys / SCR_H)     # (512,512)
    uvy = 1.0 - uvy                                     # shader 翻 v
    crop_x = crop_y = 1.0
    if img_aspect > CANVAS_ASPECT: crop_x = CANVAS_ASPECT / img_aspect
    else: crop_y = img_aspect / CANVAS_ASPECT
    g0x = (0.5 + (uvx - 0.5) * crop_x - 0.5) * 2.0 * img_aspect
    g0y = (0.5 + (uvy - 0.5) * crop_y - 0.5) * 2.0 * 1.0
    focal = 1.0 - FOCUS * HEIGHT
    org_x = OFF[0] + g0x * (ZOOM * ISO); org_y = OFF[1] + g0y * (ZOOM * ISO)
    tgt_x = OFF[0] + g0x * ZOOM;         tgt_y = OFF[1] + g0y * ZOOM
    cam_x = org_x + (tgt_x - org_x) * (1.0 / focal)
    cam_y = org_y + (tgt_y - org_y) * (1.0 / focal)
    rel = STEADY * HEIGHT
    it_x = cam_x - OFF[0] / (1.0 - rel); it_y = cam_y - OFF[1] / (1.0 - rel)
    guv_x, guv_y = _march(depth, org_x, org_y, it_x, it_y, img_aspect, g0x.shape)
    stFx = guv_x / img_aspect * 0.5 + 0.5; stFy = guv_y * 0.5 + 0.5
    return bilinear(color.astype(np.float64), stFx, stFy)

def stair_metric(img):
    """轮廓楼梯度：强边缘像素里，梯度方向落在 ±6° 轴线（0°/90°）的占比。"""
    g = img.mean(axis=2) if img.ndim == 3 else img
    gx = np.zeros_like(g); gy = np.zeros_like(g)
    gx[:, 1:-1] = g[:, 2:] - g[:, :-2]
    gy[1:-1, :] = g[2:, :] - g[:-2, :]
    mag = np.hypot(gx, gy)
    strong = mag > max(20.0, np.percentile(mag, 97))
    ang = np.degrees(np.arctan2(np.abs(gy), np.abs(gx)))  # 0=水平边 90=垂直边
    ax_aligned = ((ang < 6) | (ang > 84)) & strong
    return 100.0 * ax_aligned.sum() / max(1, strong.sum())

# ---- 载入 ----
meta = Image.open(IMG)
w0, h0 = meta.size
if max(w0, h0) > 2048:
    s = 2048 / max(w0, h0)
    w0, h0 = round(w0 * s), round(h0 * s)
    color = np.asarray(meta.resize((w0, h0), Image.LANCZOS).convert('RGB'))
else:
    color = np.asarray(meta.convert('RGB'))
img_aspect = w0 / h0

variants = {
    'v2':          load_depth(f'{BASE}.v2.png'),
    'da3-rep':     load_depth(f'{BASE}.da3-rep.png'),
    'da3-nodil':   load_depth(f'{BASE}.da3-nodil.png'),
}
# dilate+羽化变体：对现行 da3-rep 深度做小σ高斯（模拟修法）
from PIL import ImageFilter
d = Image.fromarray((variants['da3-rep'] * 255).astype(np.uint8))
variants['da3-dilblur'] = np.asarray(d.filter(ImageFilter.GaussianBlur(1.4)), dtype=np.float64) / 255.0

# 额外变体：pom-sim 目录下 depth-<name>.png 自动纳入对拍
for f in sorted(os.listdir(OUT)):
    if f.startswith('depth-') and f.endswith('.png'):
        variants[f[6:-4]] = load_depth_at(OUT, f)

# 全屏 1:1 渲染 → 缩略图 + 变体间 diff 定位病灶裁片
full = {}
for name, dep in variants.items():
    col = render(dep, color, img_aspect, (0, 0)) if False else None
# render() 以 (x0,y0) 为左上渲染 512²；全屏需分块。改成整屏一次算：
def render_full(depth, color, img_aspect):
    dh, dw = depth.shape
    xs = np.arange(SCR_W) + 0.5
    ys = np.arange(SCR_H) + 0.5
    uvx, uvy = np.meshgrid(xs / SCR_W, ys / SCR_H)
    uvy = 1.0 - uvy
    crop_x = crop_y = 1.0
    if img_aspect > CANVAS_ASPECT: crop_x = CANVAS_ASPECT / img_aspect
    else: crop_y = img_aspect / CANVAS_ASPECT
    g0x = (0.5 + (uvx - 0.5) * crop_x - 0.5) * 2.0 * img_aspect
    g0y = (0.5 + (uvy - 0.5) * crop_y - 0.5) * 2.0
    focal = 1.0 - FOCUS * HEIGHT
    org_x = OFF[0] + g0x * (ZOOM * ISO); org_y = OFF[1] + g0y * (ZOOM * ISO)
    tgt_x = OFF[0] + g0x * ZOOM;         tgt_y = OFF[1] + g0y * ZOOM
    cam_x = org_x + (tgt_x - org_x) * (1.0 / focal)
    cam_y = org_y + (tgt_y - org_y) * (1.0 / focal)
    rel = STEADY * HEIGHT
    it_x = cam_x - OFF[0] / (1.0 - rel); it_y = cam_y - OFF[1] / (1.0 - rel)
    guv_x, guv_y = _march(depth, org_x, org_y, it_x, it_y, img_aspect, g0x.shape)
    stFx = guv_x / img_aspect * 0.5 + 0.5; stFy = guv_y * 0.5 + 0.5
    return bilinear(color.astype(np.float64), stFx, stFy)

ref = None
BASE3 = ('v2', 'da3-rep', 'da3-nodil')
for name, dep in variants.items():
    if name not in BASE3:
        continue
    col = render_full(dep, color, img_aspect)
    full[name] = col
    Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)).save(os.path.join(OUT, f'{BASE}.FULL.{name}.png'))
    m = stair_metric(col)
    print(f'{name:12s} 轴对齐边缘占比 {m:6.2f}%')
    if ref is None: ref = col
    else:
        diff = np.abs(col - ref).mean(axis=2)
        print(f'   vs v2: diff均值 {diff.mean():6.2f}  最大 {diff.max():5.1f}')

# diff 热区裁片：现行 da3-rep vs 无膨胀 的最大差异处（=dilation 影响区）
diff2 = np.abs(full['da3-rep'] - full['da3-nodil']).mean(axis=2)
iy, ix = np.unravel_index(np.argmax(diff2), diff2.shape)
cx = max(0, min(SCR_W - 512, ix - 256)); cy = max(0, min(SCR_H - 512, iy - 256))
print(f'\nmax da3-rep↔nodil diff at screen ({ix},{iy}) val={diff2.max():.1f} → crop ({cx},{cy})')
for name, dep in variants.items():
    col = render(dep, color, img_aspect, (cx, cy))
    m = stair_metric(col)
    Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)).save(os.path.join(OUT, f'{BASE}.crop.{name}.png'))
    print(f'{name:12s} 裁片轴对齐占比 {m:6.2f}%')
print('\noutputs ->', OUT)
