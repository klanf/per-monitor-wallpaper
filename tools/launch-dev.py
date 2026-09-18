"""启动壁纸应用（开发 / 验证用）—— 普通权限，脱离父进程组。

为什么要绕这一下（三条都是踩出来的）：

1. `ELECTRON_RUN_AS_NODE` —— 自动化执行层会往环境变量里注入它（值可能是 `0`，
   但「存在」就够致命），Electron 见到它会退化成纯 Node 运行并报 `Cannot find module`。
   启动前必须从环境里剔掉。
2. **进程回收** —— 直接从 shell 里起，命令一结束进程树就被回收，应用活不过一轮对话。
   `DETACHED_PROCESS` 让它彻底独立，可以一直跑到用户自己关。
3. **日志会吊死进程** —— 用 `stdout=PIPE` 而不读，Electron 把管道写满后就会卡住
   （表现为「进程不退出」）。重定向到文件既不会死锁，出问题也有东西可看。

用法:
    python tools/launch-dev.py              # 普通启动（与开机自启等效）
    python tools/launch-dev.py --cdp        # 开调试端口 9222，配合 npm run app:eval
    python tools/launch-dev.py --hidden     # 不显示窗口（与开机自启一致）
"""

import argparse
import os
import pathlib
import subprocess
import sys
import tempfile

PROJ = pathlib.Path(__file__).resolve().parents[1]
EXE = PROJ / 'node_modules' / 'electron' / 'dist' / 'electron.exe'
LOG = pathlib.Path(tempfile.gettempdir()) / 'electron-wallpaper-dev.log'

DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200


def main() -> int:
    parser = argparse.ArgumentParser(description='启动壁纸应用（开发 / 验证用）')
    parser.add_argument('--cdp', action='store_true',
                        help='开启远程调试端口 9222（配合 tools/app-eval.js 查运行中的状态）')
    parser.add_argument('--hidden', action='store_true',
                        help='启动时不显示窗口（与开机自启一致）')
    args = parser.parse_args()

    if not EXE.exists():
        print(f'找不到 Electron: {EXE}', file=sys.stderr)
        return 1

    cmd = [str(EXE), '.']
    if args.cdp:
        # 关闭原生遮挡检测：流式 / 录制环境下 Chromium 会误判「窗口被完全遮挡」，
        # 冻住合成器（面板和菜单动画卡在第一帧、输入被吞）。
        cmd += ['--remote-debugging-port=9222', '--disable-features=CalculateNativeWinOcclusion']
    if args.hidden:
        cmd.append('--hidden')

    env = dict(os.environ)
    env.pop('ELECTRON_RUN_AS_NODE', None)

    with open(LOG, 'ab') as fh:
        proc = subprocess.Popen(
            cmd, cwd=str(PROJ), env=env,
            stdin=subprocess.DEVNULL, stdout=fh, stderr=fh,
            creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
            close_fds=True,
        )

    print(f'已启动 pid={proc.pid}')
    print(f'  命令: {" ".join(cmd)}')
    print(f'  日志: {LOG}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
