# -*- coding: utf-8 -*-
# r63 idle 形变复现：对拍 差速0.12 在窄羽化带上的撕裂（截图锯齿根因验证）。
# 变体：v0 纯POM（无idle）/ v1 +差速 / v2 全开（差速+呼吸飘动）/
#       v3 修复候选=差速权重换宽羽化mask(σ=10) / v4 修复候选=差速归零只留呼吸飘动
# 用法：F:/miniconda3/python.exe tools/tmp-idle-sim.py <key前缀> <x0> <y0> <w> <h> [imgPath]
import numpy as np
from PIL import Image
import os, sys

KEY = sys.argv[1]
X0, Y0, W, H = map(int, sys.argv[2:6])
IMG = sys.argv[6] if len(sys.argv) > 6 else r'F:/Syncthing/ai图/26_10_08/Anima-20261008173612_00006_.png'
OUT = os.path.join(os.path.dirname(__file__), 'out', 'idle-sim')
os.makedirs(OUT, exist_ok=True)
CACHE = r'D:/workbuddy/projects/electron-wallpaper/wp-live-userdata/depth-cache'

# ---- shader 常量（stage.js 现行） ----
HEIGHT, STEADY, ISO, FOCUS, ZOOM = 0.2, 0.3, 0.6, 0.0, 1.0
Q = 0.5
PROBE = 1.0 / (50 + (120 - 50) * Q)
QUALITY = 1.0 / (200 + (2000 - 200) * Q)
SAFE = 1.0 - HEIGHT
OFF = tuple(float(x) for x in os.environ.get('SIM_OFF', '0.35,-0.25').split(','))
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

def march(depth, org_x, org_y, it_x, it_y, img_aspect, shape, hmap=None):
    """hmap=None 用常数 HEIGHT（v0~v4）；传 ndarray 则逐像素高度（v5 自适应）"""
    if hmap is None:
        hmap = np.full(shape, HEIGHT)
    safe_h = 1.0 - hmap
    walk = np.zeros(shape); hit_done = np.zeros(shape, dtype=bool)
    guv_x = np.full(shape, np.nan); guv_y = np.full(shape, np.nan)
    for _ in range(140):
        active = (~hit_done) & (walk < 1.0)
        if not active.any(): break
        walk = np.where(active, walk + PROBE, walk)
        t = safe_h + hmap * walk
        px = org_x + (it_x - org_x) * t; py = org_y + (it_y - org_y) * t
        stx = px / img_aspect * 0.5 + 0.5; sty = py * 0.5 + 0.5
        val = bilinear(depth, stx, sty)
        hit = active & ((1.0 - t) < hmap * val)
        guv_x = np.where(hit, px, guv_x); guv_y = np.where(hit, py, guv_y)
        hit_done |= hit
    walk_b = walk.copy(); back_done = np.zeros(shape, dtype=bool)
    for _ in range(60):
        active = ~back_done
        if not active.any(): break
        walk_b = np.where(active, walk_b - QUALITY, walk_b)
        t = safe_h + hmap * walk_b
        px = org_x + (it_x - org_x) * t; py = org_y + (it_y - org_y) * t
        stx = px / img_aspect * 0.5 + 0.5; sty = py * 0.5 + 0.5
        val = bilinear(depth, stx, sty)
        outside = active & ((1.0 - t) >= hmap * val)
        guv_x = np.where(outside, px, guv_x); guv_y = np.where(outside, py, guv_y)
        back_done |= outside
    guv_x = np.where(np.isnan(guv_x), org_x + (it_x - org_x) * (safe_h + hmap * walk), guv_x)
    guv_y = np.where(np.isnan(guv_y), org_y + (it_y - org_y) * (safe_h + hmap * walk), guv_y)
    return guv_x, guv_y

# ---- 载入 ----
import glob
dep_path = glob.glob(os.path.join(CACHE, KEY + '*.depth.png'))[0]
mask_glob = glob.glob(os.path.join(CACHE, KEY + '*.mask.png'))
depth = np.asarray(Image.open(dep_path).convert('RGB')).astype(np.float64)[:, :, 0] / 255.0  # r9 双通道取 R
if mask_glob:
    mask = np.asarray(Image.open(mask_glob[0]).convert('RGB')).astype(np.float64)[:, :, 0] / 255.0
else:
    mask = np.zeros_like(depth)   # LRU 赛跑时 mask 可能被挤掉：v0/v7 不依赖 mask，置零兜底
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

# v5 自适应高度（r67）：depth 梯度大处收缩 height。EPS_TEX=梯度基线（texel 数），
# 基线太短（1 texel）被深度图逐 texel 噪声支配 → height 逐像素震荡 → 渲染碎裂（首轮实测），
# 必须拉宽到发丝尺度把噪声平均掉。
EPS_TEX = float(os.environ.get('EPS_TEX', '5'))
K_ATT = float(os.environ.get('K_ATT', '0.35'))
DE = EPS_TEX / 640.0
dgx = bilinear(depth, stB_x + DE, stB_y) - bilinear(depth, stB_x - DE, stB_y)
dgy = bilinear(depth, stB_x, stB_y + DE) - bilinear(depth, stB_x, stB_y - DE)
dgrad = np.minimum(np.hypot(dgx, dgy) / (2.0 * DE), 60.0)
h_eff = HEIGHT / (1.0 + K_ATT * dgrad)
guv5_x, guv5_y = march(depth, org_x, org_y, it_x, it_y, img_aspect, g0x.shape, hmap=h_eff)
stF5_x = guv5_x / img_aspect * 0.5 + 0.5
stF5_y = guv5_y * 0.5 + 0.5
variants['v5_adaptive'] = (stF5_x + disp_idle[0], stF5_y + disp_idle[1])
print(f'  [info] EPS_TEX={EPS_TEX} K={K_ATT} height_eff: 平坦均值={h_eff[dgrad < np.percentile(dgrad, 50)].mean():.3f} 强边均值={h_eff[dgrad > np.percentile(dgrad, 99)].mean():.3f} 强边占比={(dgrad > 20).mean() * 100:.1f}%')

# v6 mask 修深度（r67 新假设）：发丝深度被 DA3 穿透成背景值 → 身体动发丝不动被拉扯。
# 人体 mask 内的深度洼地用十字 max 膨胀填平（发丝获得身体深度 → 跟身体同动），mask 外不动。
def maxfilt(a, r, axis):
    pad = [(0, 0), (0, 0)]; pad[axis] = (r, r)
    p = np.pad(a, pad, mode='edge')
    out = p.copy()
    for s in range(1, 2 * r + 1):
        out = np.maximum(out, np.roll(p, -s, axis))
    return out[r:-r, :] if axis == 0 else out[:, r:-r]

REP_R = int(os.environ.get('REP_R', '6'))
cross = np.maximum(maxfilt(depth, REP_R, 0), maxfilt(depth, REP_R, 1))
w_rep = np.clip((mask - 0.5) * 2.0, 0.0, 1.0)
depth_rep = depth * (1.0 - w_rep) + np.maximum(depth, cross) * w_rep
guv6_x, guv6_y = march(depth_rep, org_x, org_y, it_x, it_y, img_aspect, g0x.shape)
stF6_x = guv6_x / img_aspect * 0.5 + 0.5
stF6_y = guv6_y * 0.5 + 0.5
variants['v6_depth_repair'] = (stF6_x, stF6_y)
print(f'  [info] 深度修复: REP_R={REP_R} 修复像素占比={(depth_rep > depth + 0.02).mean() * 100:.1f}%  人体内抬升均值={(depth_rep - depth)[w_rep > 0.9].mean() if (w_rep > 0.9).any() else 0:.3f}')

# v7 轮廓过渡带展宽（r67 定案）：DA3 轮廓是 1~2 texel 硬悬崖（实测 22→47→115 跳 68 级），
# 视差位移差 ~50px 全压在带上 → 背景拉伸成梳齿。强边处混入高斯模糊版把跳变摊到 ~8 texel。
SIG_W = float(os.environ.get('SIG_W', '2.5'))
T0, T1 = 0.03, 0.10
gy2, gx2 = np.gradient(depth)
gmag = np.hypot(gx2, gy2)   # depth/texel
w_edge = np.clip((gmag - T0) / (T1 - T0), 0.0, 1.0)
depth_blur = gauss_blur(depth, SIG_W)
depth_wide = depth * (1 - w_edge) + depth_blur * w_edge
guv7_x, guv7_y = march(depth_wide, org_x, org_y, it_x, it_y, img_aspect, g0x.shape)
stF7_x = guv7_x / img_aspect * 0.5 + 0.5
stF7_y = guv7_y * 0.5 + 0.5
variants['v7_widen'] = (stF7_x, stF7_y)
print(f'  [info] 展宽: SIG={SIG_W} 强边像素占比={(w_edge > 0.5).mean() * 100:.1f}%  强边处最大抬升={np.abs(depth_wide - depth).max():.3f}')

def field_shear(fx, fy):
    """采样场逐像素位移差的 P99.9/P50（px/px）—— 直接量撕裂强度，与图像内容无关"""
    dx = fx * w0; dy = fy * h0
    ddx = np.abs(np.diff(dx, axis=1))[:-1, :]          # (N-1,N-1)
    ddy = np.abs(np.diff(dy, axis=0))[:, :-1]
    d = np.maximum(ddx, ddy)
    return np.percentile(d, 99.9), np.percentile(d, 50)

row = []
for name, (fx, fy) in variants.items():
    im = render(fx, fy).astype(np.uint8)
    Image.fromarray(im).save(os.path.join(OUT, f'{name}.png'))
    # 位移场拉伸度量：|∇位移| 峰值（像素/像素）
    dx = fx * w0; dy = fy * h0
    shear_x = np.abs(np.diff(dx, axis=1)).max()
    p999, p50 = field_shear(fx, fy)
    row.append((name, stair_metric(im), shear_x))
    print(f'{name:18s} 楼梯度={stair_metric(im):6.2f}%  峰值剪切={shear_x:6.2f}  场剪切P99.9={p999:5.2f} P50={p50:5.3f}px/px')

# 拼图
pad = 4
canvas = np.full((N, (N + pad) * len(row) - pad, 3), 255, np.uint8)
for i, (name, _, _) in enumerate(row):
    im = np.asarray(Image.open(os.path.join(OUT, row[i][0] + '.png')))
    canvas[:, i * (N + pad):i * (N + pad) + N] = im
Image.fromarray(canvas).save(os.path.join(OUT, 'compare.png'))
print('拼图 ->', os.path.join(OUT, 'compare.png'))
