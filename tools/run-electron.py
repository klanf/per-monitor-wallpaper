"""在「干净、隔离」的环境里前台跑一个 Electron 脚本（验证脚本用）。

三个坑，每个都真的踩过：

1. **`ELECTRON_RUN_AS_NODE`** —— 自动化执行层会往环境变量里注入它
   （**哪怕值是空串或 `0`，「存在」就已经致命**）。Electron 见到它就退化成纯 Node，
   `require('electron')` 只会返回 exe 的路径字符串，于是 `app` / `clipboard`
   全是 `undefined`，报出来的错（`Cannot read properties of undefined`）
   和真实代码毫无关系，非常容易误判成「我改坏了」。

2. **profile 单例锁** —— 用户的应用常年开着（同一个 `user-data-dir`）。
   第二个实例会在 **Chromium 启动阶段**就被 `ProcessSingleton` 挡下，
   脚本的顶层代码一行都不会执行，表现是「**卡住不动、没有任何输出**」。
   所以本脚本默认给一个**一次性的隔离 profile**，与用户的应用彻底分开。

3. **输出会丢** —— Electron 在 Windows 上是 GUI 子系统程序，正常模式（非 RUN_AS_NODE）
   下 stdout **不一定接得上**。所以这里统一重定向到文件再回读，不依赖继承的 stdout。

和 `launch-dev.py` 的分工：那个是**后台启动应用**（要 DETACHED_PROCESS 免得被回收）；
本脚本是**前台跑一个脚本并等它结束**（要拿退出码，验证脚本用 0/1 表示通过与否）。

用法:
    python tools/run-electron.py tools/verify-clipboard.js
    python tools/run-electron.py tools/verify-clipboard.js --some-flag
    python tools/run-electron.py --keep-profile tools/verify-clipboard.js   # 保留 profile 便于排查
"""

import argparse
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

PROJ = pathlib.Path(__file__).resolve().parents[1]
EXE = PROJ / 'node_modules' / 'electron' / 'dist' / 'electron.exe'


def main() -> int:
    parser = argparse.ArgumentParser(description='在隔离环境里前台跑一个 Electron 脚本')
    parser.add_argument('--timeout', type=float, default=300.0, help='秒，默认 300')
    parser.add_argument('--keep-profile', action='store_true',
                        help='跑完不删隔离 profile（排查启动问题时用）')
    parser.add_argument('--show-profile', action='store_true', help='打印隔离 profile 路径')
    parser.add_argument('script', help='要跑的 Electron 脚本（相对项目根的路径）')
    parser.add_argument('rest', nargs=argparse.REMAINDER, help='原样传给脚本的参数')
    args = parser.parse_args()

    if not EXE.exists():
        print(f'找不到 Electron: {EXE}', file=sys.stderr)
        return 1

    env = dict(os.environ)
    # 只看「在不在」，不看值 —— 空串和 '0' 一样会让 Electron 退化
    removed = [k for k in list(env) if k.upper() == 'ELECTRON_RUN_AS_NODE']
    for key in removed:
        env.pop(key, None)

    profile = pathlib.Path(tempfile.mkdtemp(prefix='wpe-profile-'))
    log = profile / 'run.log'
    if args.show_profile:
        print(f'[run-electron] 隔离 profile: {profile}')

    # 隔离 profile 必须作为 Chromium 开关**放在脚本路径之前**，
    # 否则它会被当成脚本自己的参数（那时 profile 早就锁上了）
    cmd = [str(EXE), f'--user-data-dir={profile}', args.script] + list(args.rest)

    try:
        with open(log, 'wb') as sink:
            done = subprocess.run(
                cmd, cwd=str(PROJ), env=env, stdout=sink, stderr=subprocess.STDOUT,
                timeout=args.timeout,
            )
        code = done.returncode
    except subprocess.TimeoutExpired:
        print(f'[run-electron] 超时 {args.timeout}s —— 脚本没跑完（多半是卡在启动或等一个看不见的对话框）',
              file=sys.stderr)
        code = 124

    print(f'[run-electron] 已剔掉环境变量: {", ".join(removed) if removed else "（无，本来就干净）"}',
          file=sys.stderr)
    text = log.read_text(encoding='utf-8', errors='replace') if log.exists() else ''
    if text:
        sys.stdout.write(text)
        if not text.endswith('\n'):
            sys.stdout.write('\n')
    else:
        print('[run-electron] 脚本没有任何输出 —— 注意：Electron 正常启动时也不会写 stdout，'
              '这本身就说明它没跑到你的代码', file=sys.stderr)

    if not args.keep_profile:
        shutil.rmtree(profile, ignore_errors=True)
    return code


if __name__ == '__main__':
    sys.exit(main())
