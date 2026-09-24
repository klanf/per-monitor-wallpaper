#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""按 PID 树重启「本项目正在跑的那个实例」—— 关得准，起得来。

为什么单独有这个脚本（而不是 `proc-list.py --kill`）：
「本项目实例」和「我的调试实例」共用同一个 `electron.exe` 镜像路径，
按路径/名字过滤**区分不了同一项目的多个实例**，2026-09-24 就用它误关了用户
正在跑的壁纸切换器。所以这里的判据是「镜像路径在本项目目录之下」**加上**
「按 PID 树、先子后父」，并且默认只列不动手。

    列出会关掉哪棵树（dry-run，默认）
        python tools/restart-app.py
    真关 + 重新拉起
        python tools/restart-app.py --yes

重新拉起走用户自己的入口（桌面 VBS），它会自己剔掉环境里的
ELECTRON_RUN_AS_NODE；VBS 不在时才退化成直接起 electron.exe。
"""

import argparse
import ctypes
import ctypes.wintypes as wt
import os
import subprocess
import sys
import time

PROCESS_TERMINATE = 0x0001
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TH32CS_SNAPPROCESS = 0x0002
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
u32 = ctypes.WinDLL('user32', use_last_error=True)


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ('dwSize', ctypes.c_ulong), ('cntUsage', ctypes.c_ulong),
        ('th32ProcessID', ctypes.c_ulong), ('th32DefaultHeapID', ctypes.c_void_p),
        ('th32ModuleID', ctypes.c_ulong), ('cntThreads', ctypes.c_ulong),
        ('th32ParentProcessID', ctypes.c_ulong), ('pcPriClassBase', ctypes.c_long),
        ('dwFlags', ctypes.c_ulong), ('szExeFile', ctypes.c_wchar * 260),
    ]


def snapshot():
    """{pid: (ppid, exe_name)}"""
    k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    rows = {}
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(entry)
    ok = k32.Process32FirstW(snap, ctypes.byref(entry))
    while ok:
        rows[entry.th32ProcessID] = (entry.th32ParentProcessID, entry.szExeFile)
        ok = k32.Process32NextW(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)
    return rows


def image_path(pid):
    """真实镜像路径；取不到就返回 None —— 绝不拿名字凑合"""
    k32.OpenProcess.restype = wt.HANDLE
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return None
    try:
        buf = ctypes.create_unicode_buffer(1024)
        n = ctypes.c_ulong(1024)
        if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
            return buf.value
        return None
    finally:
        k32.CloseHandle(h)


def norm(p):
    return os.path.normcase(os.path.abspath(p)).replace('/', '\\').rstrip('\\')


def under(path, root):
    if not path:
        return False
    p = norm(path)
    return p == root or p.startswith(root + '\\')


def handles(pid):
    h = k32.OpenProcess(PROCESS_TERMINATE, False, pid)
    if not h:
        return False
    k32.CloseHandle(h)
    return True


def kill_tree(pid, children_of):
    """后序：先关所有后代，再关自己。返回关掉的 pid 列表"""
    killed = []
    for child in children_of.get(pid, []):
        killed.extend(kill_tree(child, children_of))
    h = k32.OpenProcess(PROCESS_TERMINATE, False, pid)
    if not h:
        return killed
    try:
        if k32.TerminateProcess(h, 1):
            killed.append(pid)
    finally:
        k32.CloseHandle(h)
    return killed


def window_titles(pids):
    """这些 pid 的可见顶层窗口标题（用来判断「界面真的回来了」）"""
    found = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, _lparam):
        pid = wt.DWORD()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in pids and u32.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(512)
            u32.GetWindowTextW(hwnd, buf, 512)
            if buf.value:
                found.append((pid.value, buf.value))
        return True

    u32.EnumWindows(cb, 0)
    return found


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description='按 PID 树重启本项目正在跑的实例')
    ap.add_argument('--dir', default=os.path.dirname(here),
                    help='项目目录（默认：本脚本的上一级）')
    ap.add_argument('--vbs', default=r'D:\Backup\桌面\壁纸切换器.vbs',
                    help='用户自己的启动入口；不存在就退化成直接起 electron.exe')
    ap.add_argument('--wait', type=float, default=3.0, help='拉起后等几秒再核对')
    ap.add_argument('--yes', action='store_true', help='真的关掉并重启（默认只列出来）')
    args = ap.parse_args()

    root = norm(args.dir)
    rows = snapshot()
    targets = []
    for pid, (ppid, name) in rows.items():
        if not name.lower().startswith('electron'):
            continue
        img = image_path(pid)
        if under(img, root):
            targets.append((pid, ppid, img))
    if not targets:
        print(f'「{root}」下没有 electron 实例 —— 没什么可重启的')
        return 0

    target_pids = {p for p, _, _ in targets}
    children_of = {}
    for pid, ppid, _ in targets:
        children_of.setdefault(ppid, []).append(pid)
    # 树根 = 父进程不在本项目实例集合里的那些
    roots = [p for p, ppid, _ in targets if ppid not in target_pids]

    print(f'项目目录：{root}')
    print(f'命中 {len(targets)} 个进程（按**镜像路径**过滤，取不到路径的一律没算进来）：')

    def show(pid, depth=0):
        img = next((i for p, _, i in targets if p == pid), '')
        print(f'  {"  " * depth}{pid:<7} {img}')
        for child in sorted(children_of.get(pid, [])):
            show(child, depth + 1)

    for r in roots:
        show(r)
    print(f'树根 {len(roots)} 个：{roots}（关闭顺序为后序：先子后父）')

    if not args.yes:
        print('\n这是预演。要真重启，加 --yes。')
        return 0

    killed = []
    for r in roots:
        killed.extend(kill_tree(r, children_of))
    print(f'\n已关闭 {len(killed)} 个进程：{killed}')
    time.sleep(1.5)  # 等单实例锁释放，否则新实例会被当成「已有实例」直接退出

    if os.path.isfile(args.vbs):
        print(f'用用户入口拉起：{args.vbs}')
        cmd = ['wscript.exe', args.vbs]
    else:
        exe = os.path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
        print(f'VBS 不在，直接起：{exe} .')
        cmd = [exe, '.']

    env = {k: v for k, v in os.environ.items() if k.upper() != 'ELECTRON_RUN_AS_NODE'}
    subprocess.Popen(cmd, cwd=root, env=env, close_fds=True,
                     creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
    time.sleep(args.wait)

    rows2 = snapshot()
    alive = []
    for pid, (ppid, name) in rows2.items():
        if not name.lower().startswith('electron'):
            continue
        img = image_path(pid)
        if under(img, root):
            alive.append(pid)
    if not alive:
        print('⚠️ 没看到新实例 —— 桌面轮播现在是停的，请双击桌面上的「壁纸切换器」')
        return 1
    titles = window_titles(set(alive))
    print(f'\n新实例 {len(alive)} 个进程：{sorted(alive)}')
    for pid, title in titles:
        print(f'  窗口 {pid} 《{title}》')
    if not titles:
        print('  （还没有可见窗口，可能仍在启动 —— 稍等再看，或双击桌面图标）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
