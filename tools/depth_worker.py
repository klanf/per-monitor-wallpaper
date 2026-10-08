# -*- coding: utf-8 -*-
"""
depth_worker.py —— depthService.js 的常驻深度生成 worker（stdin/stdout 行协议）

协议（每行一个 JSON）:
  入: {"path": "<原图绝对路径>", "out": "<depth png 输出绝对路径>"}
      或字符串 "EXIT"（礼貌退出）
  出: "DONE" / "FAIL <原因>"（行缓冲，必须 flush）

模型从 --model 目录离线加载（curl 直拉的三件套），全程不联网。
写文件走「临时名 + os.replace」保证原子性 —— 主进程 stat 到的一定是完整文件。
"""
import json
import os
import sys


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
            with torch.no_grad():
                result = pipe(im)
            d = result['depth'] if isinstance(result, dict) else getattr(result, 'depth', result[0])
            dw, dh = max(1, w0 // 2), max(1, h0 // 2)
            d = d.resize((dw, dh), Image.LANCZOS)
            tmp = job['out'] + '.tmp'
            d.save(tmp, format='PNG', optimize=True)   # .tmp 扩展名 PIL 推不出格式，必须显式给
            os.replace(tmp, job['out'])   # 原子落盘
            print('DONE', flush=True)
        except Exception as e:  # noqa: BLE001  单张失败不能带走 worker
            print(f'FAIL {type(e).__name__}: {e}', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001  模型加载失败等致命错误
        print(f'FATAL {type(e).__name__}: {e}', flush=True)
        sys.exit(1)
