# -*- coding: utf-8 -*-
# r63 idle 形变复现：对拍 差速0.12 在窄羽化带上的撕裂（截图锯齿根因验证）。
# 变体：v0 纯POM（无idle）/ v1 +差速 / v2 全开（差速+呼吸飘动）/
#       v3 修复候选=差速权重换宽羽化mask(σ=10) / v4 修复候选=差速归零只留呼吸飘动
# 用法：F:/miniconda3/python.exe tools/tmp-idle-sim.py <key前缀> <x0> <y0> <w> <h>
import numpy as np
from PIL import Image
import os, sys

KEY = sys.argv[1]
X0, Y0, W, H = map(int, sys.argv[2:6])
OUT = os.path.join(os.path.dirname(__file__), 'out', 'idle-sim')
os.makedirs(OUT, exist_ok=True)
CACHE = r'D:/workbuddy/projects/electron-wallpaper/wp-live-userdata/depth-cache'
IMG = r'F:/Syncthing/ai图/26_10_08/Anima-20261008173612_00006_.png'

# ---- shader 常量（stage.js 现行） ----
HEIGHT, STEADY, ISO, FOCUS, ZOOM = 0.2, 0.3, 0.6, 0.0, 1.0
Q = 0.5
PROBE = 1.0 / (50 + (120 - 50) * Q)
QUALITY = 1.0 / (200 + (2000 - 200) * Q)
SAFE = 1.0 - HEIGHT
OFF = (0.35, -0.25)
DIFF = 0.12          # 差速系数
T = 1.05             # 呼吸/飘动相位采样点（sway 接近峰值）

def mirror(u):
    return 1.0 - np.abs(1.0 - np.mod(u, 2.0))

def bilinear(img, sx, sy):
    H_, W_ = img.shape[:2]
    sx = mirror(sx); sy = mirror(sy)
    sx = np.clip(sx * W_ - 0.5, 0, W_ - 1.001)
    sy = np.clip(sy * H_ - 0.5, 0, H_ - 1.001)
    x0 = np.floor(sx).astype(np.int64); y0 = np.floor(sy).astype(np.int64)
    fx = (sx - x0); fy = (sy - y0)
    if img.ndim == 3: fx = fx[..., None]; fy = fy[..., None]
    x1 = np.minimum(x0 + 1, W_ - 1); y1 = np.minimum(y0 + 1, H_ - 1)
    a = img[y0, x0]; b = img[y0, x1]; c = img[y1, x0]; d = img[y1, x1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy

def march(depth, org_x, org_y, it_x, it_y, img_aspect, shape):
    walk = np.zeros(shape); hit_done = np.zeros(shape, dtype=bool)
    guv_x = np.full(shape, np.nan); guv_y = np.full(shape, np.nan)
    for _ in range(140):
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
    walk_b = walk.copy(); back_done = np.zeros(shape, dtype=bool)
    for _ in range(60):
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
    guv_x = np.where(np.isnan(guv_x), org_x + (it_x - org_x) * (SAFE + (1 - SAFE) * walk), guv_x)
    guv_y = np.where(np.isnan(guv_y), org_y + (it_y - org_y) * (SAFE + (1 - SAFE) * walk), guv_y)
    return guv_x, guv_y

# ---- 载入 ----
import glob
dep_path = glob.glob(os.path.join(CACHE, KEY + '*.depth.png'))[0]
mask_path = dep_path.replace('.depth.png', '.mask.png')
depth = np.asarray(Image.open(dep_path).convert('L')).astype(np.float64) / 255.0
mask = np.asarray(Image.open(mask_path).convert('L')).astype(np.float64) / 255.0
meta = Image.open(IMG)
w0, h0 = meta.size
color = np.asarray(meta.convert('RGB')).astype(np.float64)
img_aspect = w0 / h0

# 宽羽化 mask（修复候选）：σ=10 mask 像素
def gauss_blur(img, sigma):
    r = int(sigma * 3) | 1
    xs = np.arange(r) - r // 2
    k = np.exp(-(xs ** 2) / (2 * sigma ** 2)); k /= k.sum()
    p = np.pad(img, ((0, 0), (r // 2, r // 2)), mode='edge')
    out = np.apply_along_axis(lambda row: np.convolve(row, k, mode='valid'), 1, p)
    p = np.pad(out, ((r // 2, r // 2), (0, 0)), mode='edge')
    return np.apply_along_axis(lambda col: np.convolve(col, k, mode='valid'), 0, p)

mask_wide = gauss_blur(mask, 10.0)

# ---- 采样网格：stuv 区域（对应截图匹配框） ----
sx0, sy0 = X0 / w0, Y0 / h0
sx1, sy1 = (X0 + W) / w0, (Y0 + H) / h0
N = 512
gx = np.linspace(sx0, sx1, N)
gy = np.linspace(sy0, sy1, N)
stB_x, stB_y = np.meshgrid(gx, gy)          # (N,N) stuv
g0x = (stB_x * 2 - 1) * img_aspect
g0y = stB_y * 2 - 1

focal = 1.0 - FOCUS * HEIGHT
org_x = OFF[0] + g0x * (ZOOM * ISO); org_y = OFF[1] + g0y * (ZOOM * ISO)
tgt_x = OFF[0] + g0x * ZOOM;         tgt_y = OFF[1] + g0y * ZOOM
cam_x = org_x + (tgt_x - org_x) * (1.0 / focal)
cam_y = org_y + (tgt_y - org_y) * (1.0 / focal)
rel = STEADY * HEIGHT
it_x = cam_x - OFF[0] / (1.0 - rel); it_y = cam_y - OFF[1] / (1.0 - rel)
guv_x, guv_y = march(depth, org_x, org_y, it_x, it_y, img_aspect, g0x.shape)
stF_x0 = guv_x / img_aspect * 0.5 + 0.5
stF_y0 = guv_y * 0.5 + 0.5

# ---- idleWarp 数学（逐行对齐 shader） ----
mpx_x = 1.5 / img_aspect * 0.5; mpx_y = 0.75
mgx = bilinear(mask, stB_x + mpx_x, stB_y) - bilinear(mask, stB_x - mpx_x, stB_y)
mgy = bilinear(mask, stB_x, stB_y + mpx_y) - bilinear(mask, stB_x, stB_y - mpx_y)
grad = np.clip(np.hypot(mgx, mgy) * 2.0, 0.0, 1.0)
m_now = bilinear(mask, stB_x, stB_y)
br = np.sin(T * 2.0943951)
sway = np.sin(T * 1.7 + stB_y * 9.0) * 0.6 + np.sin(T * 0.9 + stB_y * 4.0) * 0.4

def render(stF_x, stF_y):
    return bilinear(color, stF_x, stF_y)   # bilinear 内部自乘宽高，传 stuv 即可

def stair_metric(img):
    g = img.mean(axis=2)
    gx2 = np.zeros_like(g); gy2 = np.zeros_like(g)
    gx2[:, 1:-1] = g[:, 2:] - g[:, :-2]
    gy2[1:-1, :] = g[2:, :] - g[:-2, :]
    mag = np.hypot(gx2, gy2)
    strong = mag > max(20.0, np.percentile(mag, 97))
    ang = np.degrees(np.arctan2(np.abs(gy2), np.abs(gx2)))
    ax = ((ang < 6) | (ang > 84)) & strong
    return 100.0 * ax.sum() / max(1, strong.sum())

variants = {}
variants['v0_pure_pom'] = (stF_x0, stF_y0)
disp_diff = (OFF[0] * DIFF * m_now / img_aspect * 0.5, OFF[1] * DIFF * m_now * 0.5)
disp_idle = (sway * grad * 0.0035 * m_now / img_aspect * 0.5, br * 0.0012 * m_now * 0.5)
variants['v1_diff'] = (stF_x0 + disp_diff[0], stF_y0 + disp_diff[1])
variants['v2_full'] = (stF_x0 + disp_diff[0] + disp_idle[0], stF_y0 + disp_diff[1] + disp_idle[1])
m_wide_now = bilinear(mask_wide, stB_x, stB_y)
diff_wide = (OFF[0] * DIFF * m_wide_now / img_aspect * 0.5, OFF[1] * DIFF * m_wide_now * 0.5)
variants['v3_fix_wide'] = (stF_x0 + diff_wide[0] + disp_idle[0], stF_y0 + diff_wide[1] + disp_idle[1])
variants['v4_fix_nodiff'] = (stF_x0 + disp_idle[0], stF_y0 + disp_idle[1])

row = []
for name, (fx, fy) in variants.items():
    im = render(fx, fy).astype(np.uint8)
    Image.fromarray(im).save(os.path.join(OUT, f'{name}.png'))
    # 位移场拉伸度量：|∇位移| 峰值（像素/像素）
    dx = fx * w0; dy = fy * h0
    shear_x = np.abs(np.diff(dx, axis=1)).max()
    row.append((name, stair_metric(im), shear_x))
    print(f'{name:18s} 楼梯度={stair_metric(im):6.2f}%  峰值剪切={shear_x:6.2f}px/px')

# 拼图
pad = 4
canvas = np.full((N, (N + pad) * len(row) - pad, 3), 255, np.uint8)
for i, (name, _, _) in enumerate(row):
    im = np.asarray(Image.open(os.path.join(OUT, row[i][0] + '.png')))
    canvas[:, i * (N + pad):i * (N + pad) + N] = im
Image.fromarray(canvas).save(os.path.join(OUT, 'compare.png'))
print('拼图 ->', os.path.join(OUT, 'compare.png'))
