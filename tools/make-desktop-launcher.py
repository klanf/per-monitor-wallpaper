"""在桌面生成「壁纸切换器」一键启动器（.vbs）。

为什么是 .vbs 而不是 .bat：
  .bat 双击会闪一个黑框，而且 .bat 里写中文要迁就 cmd 的代码页。
  .vbs 由 wscript.exe 执行，全程无窗口，安静地把应用拉起来。

为什么必须写成 UTF-16LE + BOM：
  Windows Script Host 解析 .vbs 时，**没有 BOM 的 UTF-8 文件会按 ANSI(GBK) 读**，
  中文提示直接变乱码。UTF-16LE + BOM 是 WSH 一等支持的编码，中文最稳。

为什么启动的是源码目录而不是 dist/ 里的 exe：
  打包版和你现在用的实例**不是同一份用户数据**（打包版 userData 是
  %APPDATA%\\壁纸切换器，源码版是 %APPDATA%\\electron-wallpaper），
  配置和播放进度互不相通，单实例锁也各持各的 —— 两边都起来会互相抢壁纸。
  开机自启指向的就是源码目录，所以启动器也走源码目录，才是「同一个应用」。

用法:
    python tools/make-desktop-launcher.py            # 生成 / 覆盖桌面启动器
    python tools/make-desktop-launcher.py --print    # 只打印内容，不落盘
    python tools/make-desktop-launcher.py --name X   # 换个文件名
"""

from __future__ import annotations

import argparse
import os
import pathlib
import sys
import winreg

PROJ = pathlib.Path(__file__).resolve().parents[1]
EXE_REL = r'node_modules\electron\dist\electron.exe'
DEFAULT_NAME = '壁纸切换器.vbs'

TEMPLATE = '''\
' ================================================================
'  {title}  ·  一键启动
'
'  双击即可。和开机自启用的是同一个实例、同一份配置：
'    已在运行 → 把主窗口唤到最前面（不会重复启动）
'    没在运行 → 启动，并接着上次那张壁纸继续轮播
' ================================================================
Option Explicit

Dim shell, fso, proj, exe
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

proj = "{proj}"
exe = proj & "\\{exe_rel}"

If Not fso.FileExists(exe) Then
  MsgBox "找不到 Electron 运行库：" & vbCrLf & vbCrLf & exe & vbCrLf & vbCrLf & _
         "可能项目被移动了，或还没装依赖（npm install）。", _
         vbCritical, "{title} · 启动失败"
  WScript.Quit 1
End If

' 自动化环境可能注入 ELECTRON_RUN_AS_NODE —— 只要这个变量存在，
' Electron 就会退化成纯 Node 运行并报 Cannot find module。启动前剔掉。
On Error Resume Next
shell.Environment("PROCESS").Remove("ELECTRON_RUN_AS_NODE")
On Error GoTo 0

' 工作目录必须是项目根：命令行末尾那个 "." 就是靠它解析的
shell.CurrentDirectory = proj
shell.Run """" & exe & """ .", 1, False

Set fso = Nothing
Set shell = Nothing
'''


def desktop_dir() -> pathlib.Path:
    """桌面真实路径。

    本机的桌面被重定向到了非系统盘（D:\\Backup\\桌面），所以不能想当然用
    %USERPROFILE%\\Desktop —— 一定问注册表里资源管理器实际在用的那个。
    """
    for root, key in (
        (winreg.HKEY_CURRENT_USER,
         r'Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders'),
        (winreg.HKEY_CURRENT_USER,
         r'Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'),
    ):
        try:
            with winreg.OpenKey(root, key) as k:
                raw, _ = winreg.QueryValueEx(k, 'Desktop')
        except OSError:
            continue
        path = pathlib.Path(os.path.expandvars(raw))
        if path.is_dir():
            return path

    fallback = pathlib.Path.home() / 'Desktop'
    if fallback.is_dir():
        return fallback
    raise SystemExit('找不到桌面目录（注册表与 %USERPROFILE%\\Desktop 都没命中）')


def render(title: str) -> str:
    return TEMPLATE.format(title=title, proj=str(PROJ), exe_rel=EXE_REL)


def main() -> int:
    ap = argparse.ArgumentParser(description='生成桌面一键启动器（.vbs）')
    ap.add_argument('--name', default=DEFAULT_NAME, help=f'文件名（默认 {DEFAULT_NAME}）')
    ap.add_argument('--print', dest='dry', action='store_true', help='只打印内容，不写文件')
    args = ap.parse_args()

    title = pathlib.Path(args.name).stem
    body = render(title)

    if args.dry:
        print(body)
        return 0

    exe = PROJ / EXE_REL
    if not exe.exists():
        print(f'[警告] 目标 exe 不存在：{exe}', file=sys.stderr)
        print('       （脚本仍会生成，双击时会弹提示框）', file=sys.stderr)

    desk = desktop_dir()
    out = desk / args.name

    # UTF-16LE + BOM：WSH 对中文提示最稳的编码
    out.write_text(body, encoding='utf-16-le')
    raw = out.read_bytes()
    out.write_bytes(b'\xff\xfe' + raw)          # 手动补 BOM

    print(f'已生成：{out}')
    print(f'  目标程序：{exe}  ({"存在" if exe.exists() else "缺失"})')
    print(f'  编码：UTF-16LE + BOM，{out.stat().st_size} 字节')
    return 0


if __name__ == '__main__':
    sys.exit(main())
