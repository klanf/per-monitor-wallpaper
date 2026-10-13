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
# 真实 GUID（从 auditpol /backup 底账核实）：文件系统=0CCE921D
FS_GUID = '{0CCE921D-69AE-11D9-BED3-505054503030}'
# 首跑误开的「证书服务」（0CCE9221），安装时回关复原
WRONG_GUID = '{0CCE9221-69AE-11D9-BED3-505054503030}'

REPOS = [
    r'D:\workbuddy\projects\electron-wallpaper\electron-wallpaper\.git',
    r'D:\workbuddy\tools\wd14-tagviewer\tag-viewer-electron\.git',
    r'D:\workbuddy\music-player\.git',
    r'D:\workbuddy\tools\MoyuFloat\.git',
    r'D:\workbuddy\tools\ruankao-software-designer\kuabu_repo\.git',
]


def run(cmd, show=True):
    r = subprocess.run(cmd, capture_output=True)
    out = r.stdout.decode('gbk', 'replace').strip()
    err = r.stderr.decode('gbk', 'replace').strip()
    if r.returncode != 0:
        # 任何失败都必须可见——首跑的按名 /set 失败就是这样被 show=False 吞掉的
        print('  [rc=%d] %s | %s' % (r.returncode, ' '.join(cmd[:4]),
                                    (err or out)[:200]))
    elif show:
        print('  $ %s' % ' '.join(cmd[:3]) + (' ...' if len(cmd) > 3 else ''))
        if out:
            print('    ' + out.replace('\n', '\n    '))
    return r


def main():
    if not ctypes.windll.shell32.IsUserAnAdmin():
        print('需要管理员权限：请右键 install-eater-audit.bat -> 以管理员身份运行')
        sys.exit(2)

    print('=== git 啃食者审计 · 安装开始 ===\n')

    # 1. 备份审计策略（首跑的底账是「改动前原状」，存在就不覆盖）
    if os.path.exists(POLICY_BACKUP):
        print('[1/5] 底账已存在，跳过备份（保留改动前原状）：', POLICY_BACKUP)
    else:
        print('[1/5] 备份当前审计策略 -> %s' % POLICY_BACKUP)
        run(['auditpol', '/backup', '/file:' + POLICY_BACKUP], show=False)
        print('  已备份（回滚：auditpol /restore /file:<该文件>）')
    print()

    # 2. 打开文件系统审计（真 GUID + 本地名双开 + 校验 + 回关误开的证书服务）
    print('[2/5] 打开「文件系统」审计（成功+失败）')
    # 先回关首跑误开的「证书服务」（GUID 记错的历史遗留，本机无 AD CS 但保持干净）
    run(['auditpol', '/set', '/subcategory:' + WRONG_GUID,
         '/success:disable', '/failure:disable'], show=False)
    # 真 GUID 开
    run(['auditpol', '/set', '/subcategory:' + FS_GUID,
         '/success:enable', '/failure:enable'], show=False)
    # 本地化名兜底再开（幂等）
    lst = run(['auditpol', '/list', '/subcategory:*'], show=False)
    fs_names = []
    for line in lst.stdout.decode('gbk', 'replace').splitlines():
        t = line.strip()
        if '文件系统' in t or t.lower() == 'file system':
            fs_names.append(t)
    for n in fs_names:
        run(['auditpol', '/set', '/subcategory:' + n,
             '/success:enable', '/failure:enable'], show=False)
    if not fs_names:
        print('  [警告] /list 没找到「文件系统」子类名，请人工核对')
    # 终态校验：按名 get（GUID 只用于 set，get 的解析名每次都要人看容易漏）
    ok2 = False
    for probe in ([FS_GUID] + fs_names):
        g = run(['auditpol', '/get', '/subcategory:' + probe], show=False)
        txt = g.stdout.decode('gbk', 'replace').strip().replace('\n', ' | ')
        enabled = ('成功和失败' in txt) or ('成功, 失败' in txt) or \
                  ('Success and Failure' in txt)
        print('  %s → %s%s' % (probe[:40], txt,
                               '  ✓' if enabled else ''))
        if enabled and ('文件系统' in txt or 'File System' in txt):
            ok2 = True
    if not ok2:
        print('  [失败] 文件系统审计未确认启用——金丝雀测试将无意义，请把上面回显发回')
        sys.exit(1)
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

    # 5. 自测：继承诊断 + 金丝雀全链路 + 文件级直挂对照
    print('[5/5] 自测：继承诊断 + 金丝雀全链路')
    logf = os.path.join(os.path.dirname(WATCH), '..', 'eater-audit.log')
    logf = os.path.normpath(logf)

    def wait_canary(name, seconds):
        """轮询 eater-audit.log 找金丝雀证据行。"""
        deadline = time.time() + seconds
        while time.time() < deadline:
            time.sleep(5)
            if os.path.exists(logf):
                body = open(logf, encoding='utf-8', errors='replace').read()
                if name in body:
                    return True
        return False

    # ① 继承诊断：建金丝雀 → 读它自己的 SACL（提权进程有权读）
    canary = os.path.join(REPOS[0], 'canary-delete-test.tmp')
    with open(canary, 'w') as f:
        f.write('git-eater-audit canary\n')
    try:
        p, sd = sacl._get_sacl(canary)
        aces = list(sacl._walk_aces(p))
        print('  ① 金丝雀自身 SACL：%d ACEs' % len(aces))
        for t, fl, m, sid in aces:
            print('     type=%d flags=0x%02x mask=0x%08x sid=%s'
                  % (t, fl, m, sid.hex()))
        if not aces:
            print('  [诊断] 审计 ACE 没有从 .git 目录继承到新文件 → 继承腿断了')
        inherited_ok = len(aces) > 0
    except OSError as e:
        print('  ① 金丝雀 SACL 读取失败：%s' % e)
        inherited_ok = False

    # ② 删金丝雀，等监听器/事件
    os.remove(canary)
    print('  ② 金丝雀（继承 SACL）已删除，等 40s...')
    got = wait_canary('canary-delete-test.tmp', 40)

    # ③ 对照：文件级直挂审计 ACE 再删（绕开继承）
    if not got:
        print('  ③ 继承腿没抓到 → 对照实验：文件级直挂审计 ACE')
        f2 = os.path.join(REPOS[0], 'canary-direct-test.tmp')
        with open(f2, 'w') as f:
            f.write('x')
        try:
            sacl.build_audit_sacl(f2)
            print('     文件级 SACL 写入成功')
        except OSError as e:
            print('     文件级 SACL 写入失败：%s' % e)
        os.remove(f2)
        print('     已删除，等 30s...')
        got = wait_canary('canary-direct-test.tmp', 30)

    # ④ 结论分流
    if got:
        print('  [通过] 全链路打通！证据行：')
        for line in open(logf, encoding='utf-8', errors='replace'):
            if 'canary-' in line and 'watcher' not in line:
                print('    ' + line.strip())
    elif inherited_ok:
        print('  [诊断] 文件上继承了审计 ACE 但删除无事件：')
        print('    - 嫌疑=DELETE 审计在该系统的语义/策略层。请跑：')
        print('      auditpol /get /subcategory:{0CCE921D-69AE-11D9-BED3-505054503030}')
        print('    - 以及检查是否有组策略覆盖（gpedit 高级审核策略）')
    else:
        print('  [诊断] 继承与直挂均无事件 → 把本回显整体发回，需要看')
        print('    「金丝雀自身 SACL」行与文件级直写结果来定断点')
    print()
    print('=== 安装完成。谁删了 .git 里的文件，eater-audit.log 会记下进程与路径 ===')


if __name__ == '__main__':
    main()
