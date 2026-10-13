# -*- coding: utf-8 -*-
"""
git 啃食者审计 · 卸载器（需管理员，由 uninstall_eater_audit.bat 自提权调起）。

还原三件事：
  1. 停止并删除计划任务 GitEaterWatch（开机自启源头）
  2. auditpol /restore 回滚审计策略到首跑备份的「改动前原状」
     （文件系统=无审核，同时清掉历史误开的「证书服务」）
  3. 清掉 5 个仓库 .git 上的审计 SACL（写空 ACL）
"""
import ctypes
import subprocess
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eater_audit_sacl as sacl  # noqa: E402

TASK_NAME = 'GitEaterWatch'
POLICY_BACKUP = os.path.join(TOOL_DIR := os.path.dirname(os.path.abspath(__file__)),
                             'eater-audit-policy-backup.csv')

REPOS = [
    r'D:\workbuddy\projects\electron-wallpaper\electron-wallpaper\.git',
    r'D:\workbuddy\tools\wd14-tagviewer\tag-viewer-electron\.git',
    r'D:\workbuddy\music-player\.git',
    r'D:\workbuddy\tools\MoyuFloat\.git',
    r'D:\workbuddy\tools\ruankao-software-designer\kuabu_repo\.git',
]


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, creationflags=0x08000000)
    out = r.stdout.decode('gbk', 'replace').strip()
    err = r.stderr.decode('gbk', 'replace').strip()
    tag = 'OK' if r.returncode == 0 else 'rc=%d %s' % (r.returncode, (err or out)[:120])
    print('  %s -> %s' % (' '.join(cmd[:3]), tag))
    return r


def main():
    if not ctypes.windll.shell32.IsUserAnAdmin():
        print('需要管理员权限：请双击 uninstall_eater_audit.bat')
        sys.exit(2)

    print('=== git 啃食者审计 · 卸载开始 ===\n')

    # 1. 计划任务
    print('[1/3] 停止并删除计划任务 %s' % TASK_NAME)
    run(['schtasks', '/end', '/tn', TASK_NAME])
    run(['schtasks', '/delete', '/tn', TASK_NAME, '/f'])
    chk = run(['schtasks', '/query', '/tn', TASK_NAME])
    print('  任务已不存在 ✓' if chk.returncode != 0 else '  [失败] 任务还在！')
    print()

    # 2. 审计策略回滚
    print('[2/3] 回滚审计策略（auditpol /restore 首跑底账）')
    if os.path.exists(POLICY_BACKUP):
        run(['auditpol', '/restore', '/file:' + POLICY_BACKUP])
        g = run(['auditpol', '/get', '/subcategory:{0CCE921D-69AE-11D9-BED3-505054503030}'])
        txt = g.stdout.decode('gbk', 'replace')
        print('  文件系统子类终态：%s' % ('无审核 ✓' if '无审核' in txt or 'No Auditing' in txt
                                       else txt.strip()))
    else:
        print('  [失败] 底账不存在：%s' % POLICY_BACKUP)
    print()

    # 3. 清 SACL（写空 ACL）
    print('[3/3] 清除 %d 个仓库 .git 的审计 SACL' % len(REPOS))
    for d in REPOS:
        if not os.path.isdir(d):
            continue
        rc = sacl.clear_sacl(d)
        print('  %s : %s' % (d, '已清空 ✓' if rc else '清空失败 ✗'))
    print()

    print('=== 卸载完成。commit-guard（提交护栏）不受影响，继续保留 ===')


if __name__ == '__main__':
    main()
