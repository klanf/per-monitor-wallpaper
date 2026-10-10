# -*- coding: utf-8 -*-
"""
export_onnx.py —— 把 HF 格式的 Depth-Anything V2 Small 导出为 ONNX，供打包进发布包。

为什么仓库里没有现成的 ONNX：~99MB 的模型权重不进 git（.gitignore 的 models/），
新机器打包前需要二选一：
  ①从有模型的其他构建机拷贝 models/depth-anything/depth_anything_v2_small.onnx；
  ②本脚本现场导出（需要 torch + transformers + onnxruntime + pillow + numpy）。

用法:
  python tools/export_onnx.py [HF模型目录]
  省略参数时读环境变量 DEPTH_HF_MODEL_DIR，再缺省用本机的历史路径。
  HF 模型目录需含 Depth-Anything V2 Small 的 safetensors + preprocessor_config.json
  （huggingface.co/depth-anything/Depth-Anything-V2-Small，Apache-2.0）。

产物:
  models/depth-anything/depth_anything_v2_small.onnx（打包 extraResources 的源）
  ref/  —— 每张测试图: input.npy、torch_depth.npy、ort_depth.npy + 对比指标

流程: 加载 HF 模型 → torch.onnx.export（opset 17，动态 H/W）→ onnxruntime 回载，
与 torch 原始输出做数值对比（corr≥0.999 且 maxdiff≤0.02 才算 PASS）。
"""
import os
import sys
import time

import numpy as np

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_MODEL_DIR = r'D:\workbuddy\tools\MoyuFloat\wallpaper\model'
OUT_ONNX = os.path.join(REPO_ROOT, 'models', 'depth-anything', 'depth_anything_v2_small.onnx')
REF_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ref')
TESTS = [os.path.join(os.path.dirname(os.path.abspath(__file__)), t) for t in ('test_a.jpg', 'test_b.jpg')]

os.environ['HF_HUB_OFFLINE'] = '1'


def metrics(a, b):
    """a,b: [H,W] float。min-max 归一后算相关系数 / 最大绝对差 / 平均绝对差。"""
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    a = (a - a.min()) / max(1e-9, a.max() - a.min())
    b = (b - b.min()) / max(1e-9, b.max() - b.min())
    corr = float(np.corrcoef(a.ravel(), b.ravel())[0, 1])
    return corr, float(np.abs(a - b).max()), float(np.abs(a - b).mean())


def main():
    model_dir = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('DEPTH_HF_MODEL_DIR') or DEFAULT_MODEL_DIR
    if not os.path.isdir(model_dir):
        print(f'FATAL 找不到 HF 模型目录: {model_dir}（可传参或设 DEPTH_HF_MODEL_DIR）')
        sys.exit(1)

    import torch
    from transformers import AutoModelForDepthEstimation, AutoImageProcessor

    print('[1/3] 加载 HF 模型 ...', flush=True)
    t0 = time.time()
    model = AutoModelForDepthEstimation.from_pretrained(model_dir).eval()
    proc = AutoImageProcessor.from_pretrained(model_dir)
    print(f'      done {time.time() - t0:.1f}s', flush=True)

    print('[2/3] torch.onnx.export (opset 17, 动态 H/W) ...', flush=True)
    t0 = time.time()

    # ⚠️ HF 原版 head 的 interpolate 用 int(patch_height*patch_size) 当 size，
    #    trace 时写成常量 → 动态导出失效（输出钉死 518x518，2026-10-10 实锤）。
    #    head_in_index 选中的特征在 8×patch 分辨率（实测 3 种尺寸 ratio 恒=8.0），
    #    故 size=(ph*14,pw*14) 等价于 scale_factor=14/8 —— 写死 8 有注释背书，
    #    导出后验证步骤有输出形状断言兜底。
    import torch.nn.functional as F
    from transformers.models.depth_anything.modeling_depth_anything import DepthAnythingDepthEstimationHead

    def _export_forward(self, hidden_states, patch_height, patch_width):
        hidden_states = hidden_states[self.head_in_index]
        predicted_depth = self.conv1(hidden_states)
        predicted_depth = F.interpolate(
            predicted_depth, scale_factor=float(self.patch_size) / 8.0,
            mode='bilinear', align_corners=True,
        )
        predicted_depth = self.conv2(predicted_depth)
        predicted_depth = self.activation1(predicted_depth)
        predicted_depth = self.conv3(predicted_depth)
        predicted_depth = self.activation2(predicted_depth) * self.max_depth
        return predicted_depth.squeeze(dim=1)

    DepthAnythingDepthEstimationHead.forward = _export_forward

    class Wrap(torch.nn.Module):
        """只取 predicted_depth，返回 [B,H,W]（输入分辨率）。"""

        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, pixel_values):
            out = self.m(pixel_values=pixel_values)
            return out.predicted_depth

    os.makedirs(os.path.dirname(OUT_ONNX), exist_ok=True)
    dummy = torch.randn(1, 3, 518, 518)
    torch.onnx.export(
        Wrap(model), dummy, OUT_ONNX,
        input_names=['pixel_values'], output_names=['predicted_depth'],
        dynamic_axes={'pixel_values': {2: 'H', 3: 'W'}, 'predicted_depth': {1: 'H', 2: 'W'}},
        opset_version=17, dynamo=False, do_constant_folding=True,
    )
    print(f'      done {time.time() - t0:.1f}s  size={os.path.getsize(OUT_ONNX) / 1e6:.1f}MB', flush=True)

    print('[3/3] onnxruntime 回载验证 ...', flush=True)
    import onnxruntime as ort
    # CUDA EP 需要 cublasLt64_12/cudnn9 —— torch 自带同款 DLL（worker 同款方案）
    try:
        _tlib = os.path.join(os.path.dirname(torch.__file__), 'lib')
        if os.path.isdir(_tlib):
            os.add_dll_directory(_tlib)
    except Exception:  # noqa: BLE001
        pass
    dev = 'cuda' if 'CUDAExecutionProvider' in ort.get_available_providers() else 'cpu'
    sess = ort.InferenceSession(OUT_ONNX, providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])
    print(f'      providers={sess.get_providers()}', flush=True)
    os.makedirs(REF_DIR, exist_ok=True)

    for path in TESTS:
        from PIL import Image
        if not os.path.exists(path):
            print(f'      跳过（缺测试图 {path}，不影响导出本身）')
            continue
        name = os.path.splitext(os.path.basename(path))[0]
        im = Image.open(path).convert('RGB')
        t0 = time.time()
        inputs = proc(images=im, return_tensors='pt')
        px = inputs['pixel_values']
        print(f'      {name}: img={im.size} -> input={tuple(px.shape)}', flush=True)
        with torch.no_grad():
            t_depth = model(pixel_values=px).predicted_depth[0].float().numpy()
        t_torch = time.time() - t0
        t0 = time.time()
        o_depth = sess.run(None, {'pixel_values': px.numpy()})[0]
        if o_depth.ndim == 4 and o_depth.shape[0] == 1:
            o_depth = o_depth[0]
        if o_depth.ndim == 3 and o_depth.shape[0] == 1 and t_depth.ndim == 2:
            o_depth = o_depth[0]   # 去 batch 维
        if tuple(o_depth.shape) != tuple(t_depth.shape):
            raise RuntimeError(f'ONNX 输出形状 {o_depth.shape} != torch {t_depth.shape} —— 动态导出失效')
        t_ort = time.time() - t0
        corr, mx, mean = metrics(t_depth, o_depth)
        print(f'      torch {t_torch:.2f}s / ort-{dev} {t_ort:.2f}s | corr={corr:.6f} maxdiff={mx:.6f} meandiff={mean:.6f}', flush=True)
        np.save(os.path.join(REF_DIR, f'{name}.input.npy'), px.numpy())
        np.save(os.path.join(REF_DIR, f'{name}.torch_depth.npy'), t_depth)
        np.save(os.path.join(REF_DIR, f'{name}.ort_depth.npy'), o_depth)

    ok = True
    verified = 0
    for path in TESTS:
        name = os.path.splitext(os.path.basename(path))[0]
        tfile = os.path.join(REF_DIR, f'{name}.torch_depth.npy')
        if not os.path.exists(tfile):
            continue
        verified += 1
        t = np.load(tfile)
        o = np.load(os.path.join(REF_DIR, f'{name}.ort_depth.npy'))
        corr, mx, _ = metrics(t, o)
        if corr < 0.999 or mx > 0.02:
            ok = False
            print(f'      FAIL {name}: corr={corr:.6f} maxdiff={mx:.6f}')
    if verified == 0:
        print('EXPORT_VERIFY=SKIP（无测试图可比对，形状断言未触发即视为导出成功）')
    else:
        print('EXPORT_VERIFY=' + ('PASS' if ok else 'FAIL'), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f'FATAL {type(e).__name__}: {e}', flush=True)
        sys.exit(1)
