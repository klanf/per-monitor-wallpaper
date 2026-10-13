# -*- coding: utf-8 -*-
"""
git 啃食者定罪工具之三：一键安装器（需管理员，由 install-eater-audit.bat 自提权调起）。

做五件事：
  1. 备份当前审计策略（可回滚）
  2. 打开「文件系统」审计子类（成功+失败），用 GUID 写法免受中文系统名干扰
  3. 给所有已知仓库的 .git 挂删除审计 SACL
  4. 注册隐藏计划任务 GitEaterWatch（开机自动以最高权限跑监听器）并立即启动
  5. 自测：删一个 .git 下的金丝雀文件，等监听器抓到它，全链路验证
"""
import ctypes
import subprocess
import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eater_audit_sacl as sacl  # noqa: E402

PYTHONW = r'F:\miniconda3\pythonw.exe'
TOOL_DIR = os.path.dirname(os.path.abspath(__file__))
WATCH = os.path.join(TOOL_DIR, 'eater_audit_watch.py')
TASK_NAME = 'GitEaterWatch'
POLICY_BACKUP = os.path.join(TOOL_DIR, 'eater-audit-policy-backup.csv')
FS_GUID = '{0CCE9221-69AE-11D9-BED3-505054503030}'  # File System（locale 无关）

REPOS = [
    r'D:\workbuddy\projects\electron-wallpaper\electron-wallpaper\.git',
    r'D:\workbuddy\tools\wd14-tagviewer\tag-viewer-electron\.git',
    r'D:\workbuddy\music-player\.git',
    r'D:\workbuddy\tools\MoyuFloat\.git',
    r'D:\workbuddy\tools\ruankao-software-designer\kuabu_repo\.git',
]


def run(cmd, show=True):
    r = subprocess.run(cmd, capture_output=True)
    if show:
        print('  $ %s' % ' '.join(cmd[:3]) + (' ...' if len(cmd) > 3 else ''))
        out = r.stdout.decode('gbk', 'replace').strip()
        if out:
            print('    ' + out.replace('\n', '\n    '))
        if r.returncode != 0:
            print('    [rc=%d] %s' % (r.returncode,
                                      r.stderr.decode('gbk', 'replace').strip()[:200]))
    return r


def main():
    if not ctypes.windll.shell32.IsUserAnAdmin():
        print('需要管理员权限：请右键 install-eater-audit.bat -> 以管理员身份运行')
        sys.exit(2)

    print('=== git 啃食者审计 · 安装开始 ===\n')

    # 1. 备份审计策略
    print('[1/5] 备份当前审计策略 -> %s' % POLICY_BACKUP)
    run(['auditpol', '/backup', '/file:' + POLICY_BACKUP], show=False)
    print('  已备份（回滚：auditpol /restore /file:<该文件>）\n')

    # 2. 打开文件系统审计（GUID 双保险 + 本地名兜底）
    print('[2/5] 打开「文件系统」审计（成功+失败）')
    r = run(['auditpol', '/set', '/subcategory:' + FS_GUID,
             '/success:enable', '/failure:enable'], show=False)
    if r.returncode != 0:
        print('  [失败] GUID 写法 rc=%d %s' % (r.returncode,
              r.stderr.decode('gbk', 'replace').strip()[:200]))
    # 校验 GUID 实际解析成了哪个子类（防 GUID 记错开到别的子类上）
    g = run(['auditpol', '/get', '/subcategory:' + FS_GUID], show=False)
    resolved = g.stdout.decode('gbk', 'replace').strip()
    print('  GUID 解析 →', resolved.replace('\n', ' | '))
    resolved_ok = ('文件系统' in resolved) or ('File System' in resolved)
    if not resolved_ok:
        # 枚举全部子类，找到本地化的「文件系统」名再开一次
        lst = run(['auditpol', '/list', '/subcategory:*'], show=False)
        candidates = []
        for line in lst.stdout.decode('gbk', 'replace').splitlines():
            t = line.strip()
            # 只匹配纯粹的「文件系统」（排除 文件共享/详细文件共享/可移动存储 等）
            if '文件系统' in t or t.lower() == 'file system':
                candidates.append(t)
        if candidates:
            print('  本地化子类名命中：', candidates, '—— 按名再开一次')
            for n in candidates:
                run(['auditpol', '/set', '/subcategory:' + n,
                     '/success:enable', '/failure:enable'], show=False)
        else:
            print('  [警告] /list 里没找到「文件系统」，请人工核对 auditpol /list /subcategory:*')
    # 终态确认
    g2 = run(['auditpol', '/get', '/subcategory:' + FS_GUID], show=False)
    final = g2.stdout.decode('gbk', 'replace').strip()
    print('  终态 →', final.replace('\n', ' | '))
    if not (('成功' in final and '启用' in final) or 'Success' in final.lower()
            or '成功和失败' in final):
        print('  [警告] 回显未见「启用/Success」，请人工核对上面终态行')
    print()

    # 3. 挂 SACL
    print('[3/5] 给 %d 个仓库的 .git 挂删除审计' % len(REPOS))
    for d in REPOS:
        if not os.path.isdir(d):
            print('  [跳过] %s（不存在）' % d)
            continue
        try:
            res = sacl.build_audit_sacl(d)
            print('  %s : %s' % (d, '已有审计 ACE，跳过' if res is None else '写入成功'))
        except OSError as e:
            print('  %s : 失败 —— %s' % (d, e))
            sys.exit(1)
    # 回读校验（防写入假成功）
    print('  回读校验：')
    for d in REPOS:
        if not os.path.isdir(d):
            continue
        try:
            sacl_p, sd = sacl._get_sacl(d)
            ok = sacl._audit_ace_exists(sacl_p)
            print('  %s : %s' % (d, '审计 ACE 在 ✓' if ok else '未检出审计 ACE ✗'))
        except OSError as e:
            print('  %s : 回读失败 %s' % (d, e))
    print()

    # 4. 计划任务
    print('[4/5] 注册并启动隐藏计划任务 %s（pythonw，最高权限）' % TASK_NAME)
    tr = '"%s" "%s"' % (PYTHONW, WATCH)
    run(['schtasks', '/create', '/tn', TASK_NAME, '/tr', tr,
         '/sc', 'onlogon', '/rl', 'highest', '/f'], show=False)
    run(['schtasks', '/run', '/tn', TASK_NAME], show=False)
    time.sleep(3)
    st = os.path.join(os.path.dirname(WATCH), '..', 'eater-audit-status.txt')
    st = os.path.normpath(st)
    if os.path.exists(st):
        print('  监听器已运行：%s' % open(st, encoding='utf-8').read().strip())
    else:
        print('  [注意] 状态文件还没出现，可能要再等一个轮询周期（%ds）' % 10)
    print()

    # 5. 自测
    print('[5/5] 自测：创建并删除 .git 金丝雀文件，验证全链路')
    canary = os.path.join(REPOS[0], 'canary-delete-test.tmp')
    with open(canary, 'w') as f:
        f.write('git-eater-audit canary\n')
    os.remove(canary)
    print('  金丝雀已删除，等监听器抓（最多 40s）...')
    logf = os.path.join(os.path.dirname(WATCH), '..', 'eater-audit.log')
    logf = os.path.normpath(logf)
    found = False
    deadline = time.time() + 40
    while time.time() < deadline:
        time.sleep(5)
        if os.path.exists(logf):
            body = open(logf, encoding='utf-8', errors='replace').read()
            # 金丝雀路径只会出现在 fmt() 证据行里（启动行不含它）
            if 'canary-delete-test.tmp' in body:
                found = True
                break
    if found:
        print('  [通过] 安全日志 -> 监听器 -> eater-audit.log 全链路打通！')
        print('  证据行：')
        for line in open(logf, encoding='utf-8', errors='replace'):
            if 'canary-delete-test.tmp' in line and 'watcher' not in line:
                print('    ' + line.strip())
    else:
        print('  [未抓到] 可能是事件落日志有延迟。手动验证：')
        print('    wevtutil qe Security /q:"*[System[(EventID=4663)]]" /c:5 /f:text /rd:true')
        print('  监听器每 10s 轮询，之后出现也属正常。')
    print()
    print('=== 安装完成。谁删了 .git 里的文件，eater-audit.log 会记下进程与路径 ===')


if __name__ == '__main__':
    main()
