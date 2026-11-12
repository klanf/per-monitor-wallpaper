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
    r'D:\workbuddy\projects\tag-viewer-electron\.git',
    r'D:\workbuddy\projects\music-player\.git',
    r'D:\workbuddy\tools\MoyuFloat\.git',
    r'D:\workbuddy\tools\ruankao-software-designer\kuabu_repo\.git',
]


def run(cmd, show=True):
    r = subprocess.run(cmd, capture_output=True, creationflags=0x08000000)
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

    # 3. 挂 SACL（目录 = DELETE + FILE_DELETE_CHILD：
    #    经父目录权限删除文件时文件不会被以 DELETE 打开，只有目录的
    #    DELETE_CHILD 审计能抓到；旧 DELETE-only ACE 会被覆盖升级）
    print('[3/5] 给 %d 个仓库的 .git 挂删除审计（DELETE+DELETE_CHILD）' % len(REPOS))
    DIR_MASK = sacl.DELETE | sacl.FILE_DELETE_CHILD
    for d in REPOS:
        if not os.path.isdir(d):
            print('  [跳过] %s（不存在）' % d)
            continue
        try:
            res = sacl.build_audit_sacl(d, mask=DIR_MASK)
            print('  %s : %s' % (d, '已是所需位，跳过' if res is None else '写入成功'))
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

    # 5. 自测：地面真相直查 + 阳性对照（安装器自己就是提权进程，直查
    #    Security 日志，不再依赖监听器转发——把断点一次钉死）
    print('[5/5] 自测：直查安全日志地面真相 + 阳性对照')
    import re
    import xml.etree.ElementTree as ET
    import collections

    AUDIT_IDS = (4656, 4658, 4659, 4660, 4663)

    def evt_ids(xml_text):
        out = []
        for m in re.finditer(r"<EventID[^>]*>(\d+)</EventID>", xml_text):
            out.append(int(m.group(1)))
        return out

    def sec_recent(seconds, cap=400):
        """查询最近 N 秒的 Security 事件，返回 (EventID 计数, 原始 XML)。"""
        q = ('*[System[TimeCreated[timediff(@SystemTime) <= %d]]]' % seconds)
        r = subprocess.run(['wevtutil', 'qe', 'Security', '/q:' + q,
                            '/f:xml', '/c:%d' % cap, '/rd:true'],
                           capture_output=True, creationflags=0x08000000)
        txt = r.stdout.decode('utf-8', 'replace')
        hist = collections.Counter(evt_ids(txt))
        return hist, txt

    # ⓪ 基线：最近 90s 事件在滚动什么 + 历史上有没有对象访问审计
    hist, _ = sec_recent(90)
    if hist:
        top = ', '.join('E%d×%d' % (k, v) for k, v in hist.most_common(8))
        print('  ⓪ 最近90s Security 事件（日志在滚动什么）：%s' % top)
        hits = {k: v for k, v in hist.items() if k in AUDIT_IDS}
        print('     其中对象访问类(4656/4658/4659/4660/4663)：%s'
              % (hits if hits else '无'))
    else:
        print('  ⓪ [注意] 最近 90s Security 零事件（提权查询通了但没产出）')
    r1000 = subprocess.run(
        ['wevtutil', 'qe', 'Security',
         '/q:*[System[(EventID=4656) or (EventID=4659) or (EventID=4660) '
         'or (EventID=4663)]]', '/f:xml', '/c:5', '/rd:true'],
        capture_output=True, creationflags=0x08000000)
    any_audit = evt_ids(r1000.stdout.decode('utf-8', 'replace'))
    print('     全日志最近的对象访问事件（任意路径）：共 %d 条（抽样5）' % len(any_audit))
    print()

    def query_canary(name):
        """直查最近 60s 事件里有没有提到金丝雀名的对象访问事件。"""
        q = ('*[System[((EventID=4656) or (EventID=4659) or (EventID=4660) '
             'or (EventID=4663)) and TimeCreated[timediff(@SystemTime) <= 60000]]]')
        r = subprocess.run(['wevtutil', 'qe', 'Security', '/q:' + q,
                            '/f:xml', '/c:200', '/rd:true'], capture_output=True, creationflags=0x08000000)
        txt = r.stdout.decode('utf-8', 'replace')
        return [m.group(0) for m in re.finditer(r'<Event[ >].*?</Event>', txt, re.S)
                if name in m.group(0)]

    # ① DELETE 金丝雀（继承 SACL）→ 立即直查日志
    canary = os.path.join(REPOS[0], 'canary-delete-test.tmp')
    with open(canary, 'w') as f:
        f.write('git-eater-audit canary\n')
    try:
        p, sd = sacl._get_sacl(canary)
        aces = list(sacl._walk_aces(p))
        print('  ① 金丝雀继承 SACL：%d ACEs（mask=%s）'
              % (len(aces), ['0x%08x' % m for _, _, m, _ in aces]))
    except OSError as e:
        print('  ① 金丝雀 SACL 读取失败：%s' % e)
    os.remove(canary)
    time.sleep(12)
    found = query_canary('canary-delete-test.tmp')
    print('  ② DELETE 金丝雀已删+等12s → 直查日志：%s'
          % ('抓到 %d 条事件' % len(found) if found else '零事件'))

    # ③ 阳性对照：给金丝雀挂 READ(0x1) 审计，以 GENERIC_READ 打开（不删）
    #    ——READ 走文件打开路径，绕开「父目录删除」的一切干扰。
    #    若 READ 打开都无事件 → 对象访问审计被系统性压制（嫌疑=安全软件）
    #    若 READ 有事件而 DELETE 没有 → 是删除路径语义问题（已有
    #    FILE_DELETE_CHILD 兜底，重挂后应好转）
    canary2 = os.path.join(REPOS[0], 'canary-read-test.tmp')
    with open(canary2, 'w') as f:
        f.write('x')
    try:
        sacl.build_audit_sacl(canary2, mask=0x1)  # FILE_READ_DATA
        print('  ③ 阳性对照金丝雀挂 READ 审计：写入成功')
    except OSError as e:
        print('  ③ READ 审计写入失败：%s' % e)
    k32 = ctypes.windll.kernel32
    h = k32.CreateFileW(canary2, 0x80000000, 7, None, 3, 0, None)  # GENERIC_READ
    print('     GENERIC_READ 打开句柄 h=%s（-1=打开失败），关闭后直查…' % h)
    k32.CloseHandle(h)
    time.sleep(12)
    found2 = query_canary('canary-read-test.tmp')
    print('     直查日志：%s'
          % ('抓到 %d 条事件（审计机制本身是好的）' % len(found2) if found2
             else '零事件'))
    os.remove(canary2)
    print()

    # ④ 结论分流
    if found or found2:
        print('  [通过] 审计机制工作正常！监听器 10s 轮询会落 eater-audit.log，')
        print('    之后再删 .git 里的文件就是定罪记录（进程+PID+路径）')
    elif found2 == [] and not found:
        print('  [诊断] READ 阳性对照也零事件 → 对象访问审计被系统性压制，')
        print('    auditpol 显示启用但事件不出。嫌疑排序：')
        print('    1. 第三方安全软件（钩掉对象访问审计——与「git 啃食者」同一嫌疑人？）')
        print('    2. 组策略/MDM 下发的审核策略覆盖（gpedit→高级审核策略）')
        print('    3. 上⓪行「最近90s事件」滚动的是什么，能看出谁在霸占日志')
        print('    把本次完整回显发回排查。')
    print()
    print('=== 安装完成。谁删了 .git 里的文件，eater-audit.log 会记下进程与路径 ===')


if __name__ == '__main__':
    main()
