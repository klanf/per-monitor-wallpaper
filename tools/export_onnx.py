# -*- coding: utf-8 -*-
r"""Export the official Depth Anything 3 Small checkpoint to depth-only ONNX.

Runtime output:
  models/depth-anything/da3_small.onnx

The released app does not need Python or PyTorch. They are build-time tools only.
The exporter intentionally keeps only the single-view DINOv2 + DualDPT depth path;
camera pose, confidence/ray, sky and Gaussian branches are not part of the graph.

Example:
  python tools/export_onnx.py --source C:\src\Depth-Anything-3

If --model-dir is omitted, the official depth-anything/DA3-SMALL checkpoint is
downloaded through huggingface_hub into its normal user cache.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

OFFICIAL_MODEL_ID = "depth-anything/DA3-SMALL"
MODEL_NAME = "da3-small"
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "models" / "depth-anything" / "da3_small.onnx"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=Path(os.environ["DA3_SOURCE_DIR"]) if os.environ.get("DA3_SOURCE_DIR") else None,
        help="Official Depth-Anything-3 checkout (or set DA3_SOURCE_DIR)",
    )
    parser.add_argument("--model-dir", type=Path, help="Directory containing official model.safetensors")
    parser.add_argument("--model-id", default=OFFICIAL_MODEL_ID)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--size", type=int, default=518)
    parser.add_argument("--opset", type=int, default=18)
    parser.add_argument("--no-validate", dest="validate", action="store_false")
    parser.set_defaults(validate=True)
    return parser.parse_args()


def source_root(path: Path | None) -> Path:
    if path is None:
        raise SystemExit("FATAL: pass --source pointing to the official Depth-Anything-3 checkout")
    path = path.resolve()
    if not (path / "src" / "depth_anything_3" / "model" / "da3.py").is_file():
        raise SystemExit(f"FATAL: not an official Depth-Anything-3 source tree: {path}")
    return path


def checkpoint_dir(path: Path | None, model_id: str) -> Path:
    if path is not None:
        resolved = path.resolve()
    else:
        from huggingface_hub import snapshot_download

        print(f"[1/5] Download official checkpoint {model_id}", flush=True)
        resolved = Path(
            snapshot_download(
                repo_id=model_id,
                allow_patterns=["config.json", "model.safetensors", "README.md"],
            )
        )
    if not (resolved / "model.safetensors").is_file():
        raise SystemExit(f"FATAL: model.safetensors not found under {resolved}")
    return resolved


def patch_position_getter() -> None:
    """torch.cartesian_prod has no ONNX symbolic; meshgrid is exactly equivalent."""
    import torch
    from depth_anything_3.model.dinov2.layers.rope import PositionGetter

    def _call(self, batch_size, height, width, device):
        key = (height, width)
        if key not in self.position_cache:
            y = torch.arange(height, device=device)
            x = torch.arange(width, device=device)
            yy, xx = torch.meshgrid(y, x, indexing="ij")
            self.position_cache[key] = torch.stack((yy.reshape(-1), xx.reshape(-1)), dim=-1)
        cached = self.position_cache[key]
        return cached.view(1, height * width, 2).expand(batch_size, -1, -1).clone()

    PositionGetter.__call__ = _call


def load_official_net(source: Path, weights: Path):
    sys.path.insert(0, str(source / "src"))
    import torch
    from safetensors.torch import load_file
    from depth_anything_3.cfg import create_object, load_config
    from depth_anything_3.registry import MODEL_REGISTRY

    patch_position_getter()
    net = create_object(load_config(MODEL_REGISTRY[MODEL_NAME])).eval()
    state = load_file(str(weights / "model.safetensors"), device="cpu")
    # Official Hub saves the public DepthAnything3 wrapper, whose only child is `model`.
    if state and all(key.startswith("model.") for key in state):
        state = {key[len("model.") :]: value for key, value in state.items()}
    missing, unexpected = net.load_state_dict(state, strict=False)
    # The current official main branch expanded unused auxiliary ray-head levels
    # after the published DA3-SMALL checkpoint. They are not connected to the
    # exported `depth` tensor; no main-depth weight is allowed to be missing.
    allowed_missing = {
        f"head.scratch.output_conv2_aux.{idx}.2.{kind}"
        for idx in (1, 2, 3)
        for kind in ("weight", "bias")
    }
    disallowed_missing = [key for key in missing if key not in allowed_missing]
    if disallowed_missing or unexpected:
        raise RuntimeError(
            "official checkpoint mismatch: "
            f"missing={disallowed_missing[:8]} unexpected={unexpected[:8]}"
        )
    if missing:
        print(f"      ignored unused auxiliary-head keys: {missing}", flush=True)
    return net.to(torch.device("cpu"))


def depth_wrapper(net):
    import torch
    import torch.nn as nn

    class DepthOnly(nn.Module):
        def __init__(self, model):
            super().__init__()
            self.net = model

        def forward(self, image: torch.Tensor) -> torch.Tensor:
            # (B,3,518,518) -> one independent view (B,S=1,3,518,518).
            x = image.unsqueeze(1)
            feats, _ = self.net.backbone(
                x, cam_token=None, export_feat_layers=[], ref_view_strategy="middle"
            )
            out = self.net._process_depth_head(feats, image.shape[-2], image.shape[-1])
            depth = out["depth"]
            if depth.dim() == 4:
                depth = depth[:, 0]
            return depth.float()

    return DepthOnly(net).eval()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def source_commit(source: Path) -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
        ).strip()
    except Exception:
        return "unknown"


def validate(wrapper, output: Path, size: int) -> dict[str, object]:
    import numpy as np
    import onnxruntime as ort
    import torch

    generator = torch.Generator(device="cpu").manual_seed(20261012)
    sample = torch.randn((1, 3, size, size), generator=generator, dtype=torch.float32)
    with torch.inference_mode():
        torch_depth = wrapper(sample).cpu().numpy()

    session = ort.InferenceSession(str(output), providers=["CPUExecutionProvider"])
    ort_depth = session.run(["depth"], {"image": sample.numpy()})[0]
    if torch_depth.shape != ort_depth.shape:
        raise RuntimeError(f"shape mismatch: torch={torch_depth.shape}, onnx={ort_depth.shape}")
    delta = np.abs(torch_depth - ort_depth)
    relative_mean = float(delta.mean() / (np.abs(torch_depth).mean() + 1e-6))
    corr = float(np.corrcoef(torch_depth.ravel(), ort_depth.ravel())[0, 1])
    result = {
        "shape": list(ort_depth.shape),
        "max_abs": float(delta.max()),
        "mean_abs": float(delta.mean()),
        "relative_mean": relative_mean,
        "correlation": corr,
        "providers": session.get_providers(),
    }
    if relative_mean > 1e-2 or corr < 0.999:
        raise RuntimeError(f"PyTorch/ONNX parity failed: {result}")
    return result


def main() -> None:
    args = parse_args()
    if args.size != 518:
        raise SystemExit("FATAL: the released DA3 graph is fixed to the native 518x518 grid")
    if args.opset != 18:
        raise SystemExit("FATAL: the released DA3 graph is pinned to ONNX opset 18")

    source = source_root(args.source)
    weights = checkpoint_dir(args.model_dir, args.model_id)
    print(f"[2/5] Load source={source} checkpoint={weights}", flush=True)
    started = time.time()
    net = load_official_net(source, weights)
    wrapper = depth_wrapper(net)
    print(f"      loaded in {time.time() - started:.1f}s", flush=True)

    import torch

    args.out.parent.mkdir(parents=True, exist_ok=True)
    temp_out = args.out.with_suffix(".onnx.tmp")
    dummy = torch.randn(1, 3, args.size, args.size, dtype=torch.float32)
    print("[3/5] Export depth-only ONNX (opset 18, fixed 518x518)", flush=True)
    started = time.time()
    with torch.inference_mode():
        torch.onnx.export(
            wrapper,
            (dummy,),
            str(temp_out),
            input_names=["image"],
            output_names=["depth"],
            dynamic_axes={"image": {0: "batch"}, "depth": {0: "batch"}},
            opset_version=args.opset,
            do_constant_folding=True,
            dynamo=False,
        )
    os.replace(temp_out, args.out)
    print(f"      {args.out.stat().st_size / 1e6:.1f} MB in {time.time() - started:.1f}s", flush=True)

    parity = None
    if args.validate:
        print("[4/5] Validate PyTorch against ONNX Runtime", flush=True)
        parity = validate(wrapper, args.out, args.size)
        print(f"      PASS {parity}", flush=True)
    else:
        print("[4/5] Validation skipped by request", flush=True)

    digest = sha256(args.out)
    manifest = {
        "model": args.model_id,
        "source_commit": source_commit(source),
        "input": {"name": "image", "shape": ["batch", 3, args.size, args.size]},
        "output": {"name": "depth"},
        "opset": args.opset,
        "sha256": digest,
        "bytes": args.out.stat().st_size,
        "parity": parity,
    }
    args.out.with_suffix(".onnx.sha256").write_text(f"{digest}  {args.out.name}\n", encoding="ascii")
    args.out.with_suffix(".onnx.validation.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"[5/5] SHA-256 {digest}", flush=True)


if __name__ == "__main__":
    main()
