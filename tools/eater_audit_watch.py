# -*- coding: utf-8 -*-
"""
git 啃食者定罪工具之二：安全日志监听器（由计划任务 GitEaterWatch 以管理员运行）。

轮询安全日志 4663（访问尝试）/4659（请求删除句柄）/4660（对象已删除），
过滤目标 .git 目录（排除 objects/ 的 gc 正常churn），命中的落盘 eater-audit.log，
每行含时间 / 事件ID / 进程路径 / PID / 操作者 / 被删路径 —— 这就是「定罪证据」。

状态写到 eater-audit-status.txt（心跳），方便确认它活着。
"""
import subprocess
import time
import os
import re
import json
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eater_audit_sacl as saclmod

# 监控范围：本机所有 git 仓库的 .git（与 eater-audit-sacl.py 的 --set 清单一致）
REPOS = [
    r'D:\workbuddy\projects\electron-wallpaper\electron-wallpaper\.git',
    r'D:\workbuddy\tools\wd14-tagviewer\tag-viewer-electron\.git',
    r'D:\workbuddy\music-player\.git',
    r'D:\workbuddy\tools\MoyuFloat\.git',
    r'D:\workbuddy\tools\ruankao-software-designer\kuabu_repo\.git',
]
# objects/ 下是 git gc 的正常增删，排除掉降噪
NOISE_MATCH = re.compile(re.escape(r'\objects') + r'\\', re.I)

ROOT = r'D:\workbuddy\projects\electron-wallpaper\electron-wallpaper'
LOG = os.path.join(ROOT, 'eater-audit.log')
STATUS = os.path.join(ROOT, 'eater-audit-status.txt')
STATE = os.path.join(ROOT, 'tools', 'eater-audit-state.json')
CMD_FILE = os.path.join(ROOT, 'tools', 'eater-audit-cmd.json')
DIAG = os.path.join(ROOT, 'eater-audit-diag.log')
XPATH = ("*[System[(EventID=4663) or (EventID=4659) or (EventID=4660) "
         "or (EventID=4656)]]")  # 4656=句柄请求（DELETE 意图的最早记录点）
POLL_SEC = 10
BATCH = 400


def find(el, name):
    """命名空间无关的子元素查找。"""
    for e in el.iter():
        if e.tag == name or e.tag.endswith('}' + name):
            return e
    return None


def parse_events(text):
    """wevtutil /f:xml 输出是多个 <Event> 拼接，逐个解析。"""
    out = []
    for m in re.finditer(r'<Event[ >].*?</Event>', text, re.S):
        try:
            x = ET.fromstring(m.group(0))
        except ET.ParseError:
            continue
        rec = find(x, 'EventRecordID')
        tid = find(x, 'TimeCreated')
        rid = int(rec.text) if rec is not None and rec.text else 0
        t = tid.get('SystemTime', '') if tid is not None else ''
        data = {}
        ed = find(x, 'EventData')
        if ed is not None:
            for d in ed:
                if d.get('Name'):
                    data[d.get('Name')] = (d.text or '')
        eid = find(x, 'EventID')
        out.append({'rid': rid, 'time': t, 'event': eid.text if eid is not None else '?',
                    'data': data})
    return out


def poll():
    # CREATE_NO_WINDOW：pythonw 无控制台，spawn 控制台程序（wevtutil）时
    # Windows 会给它新建可见窗口 → 每 10s 轮询就闪一次控制台。必须压掉。
    r = subprocess.run(
        ['wevtutil', 'qe', 'Security', '/q:' + XPATH,
         '/f:xml', '/c:%d' % BATCH, '/rd:true'],
        capture_output=True, creationflags=0x08000000)
    if r.returncode != 0:
        return None, r.stderr.decode('gbk', 'replace').strip()[:200]
    return parse_events(r.stdout.decode('utf-8', 'replace')), None


def relevant(data):
    name = data.get('ObjectName', '')
    if not name:
        return False
    low = name.lower()
    if not any(low.startswith(r.lower() + '\\') or low == r.lower() for r in REPOS):
        return False
    if NOISE_MATCH.search(name):
        return False
    return True


def fmt(ev):
    d = ev['data']
    proc = d.get('ProcessName', '?')
    pid = d.get('ProcessId', '?')
    user = '%s\\%s' % (d.get('SubjectDomainName', ''), d.get('SubjectUserName', ''))
    mask = d.get('AccessMask', '')
    delete_flag = ''
    if mask:
        try:
            delete_flag = ' DELETE' if int(mask, 16) & 0x10000 else ' mask=%s' % mask
        except ValueError:
            delete_flag = ' mask=%s' % mask
    return ('%s | E%s%s | %s(pid=%s) | %s | %s'
            % (ev['time'][:19], ev['event'], delete_flag, proc, pid, user,
               d.get('ObjectName', '?')))


def load_state():
    try:
        with open(STATE, encoding='utf-8') as f:
            return json.load(f).get('last_rid', 0)
    except Exception:
        return 0


def save_state(rid):
    try:
        with open(STATE, 'w', encoding='utf-8') as f:
            json.dump({'last_rid': rid}, f)
    except Exception:
        pass


def diag():
    """提权诊断：目录 SACL、新文件继承情况、文件级直写测试。结果落 DIAG。"""
    lines = []

    def w(s):
        lines.append(s)
        print(s)

    for d in REPOS[:1]:  # 主树足够，其他仓库同机制
        try:
            p, sd = saclmod._get_sacl(d)
            aces = list(saclmod._walk_aces(p))
            w('DIR %s : %d ACEs %s' % (d, len(aces), aces))
        except OSError as e:
            w('DIR %s : get failed %s' % (d, e))

    # ① 新文件继承测试：建文件→读它自己的 SACL→删除
    f = os.path.join(REPOS[0], 'diag-inherit-test.tmp')
    with open(f, 'w') as fh:
        fh.write('x')
    try:
        p, sd = saclmod._get_sacl(f)
        aces = list(saclmod._walk_aces(p))
        w('INHERIT: 新文件 SACL %d ACEs %s' % (len(aces), aces))
    except OSError as e:
        w('INHERIT: 新文件 SACL 读取失败 %s' % e)
    os.remove(f)

    # ② 文件级直写测试：直接给文件挂审计 ACE 再删
    f2 = os.path.join(REPOS[0], 'diag-direct-test.tmp')
    with open(f2, 'w') as fh:
        fh.write('x')
    try:
        saclmod.build_audit_sacl(f2)
        p, sd = saclmod._get_sacl(f2)
        aces = list(saclmod._walk_aces(p))
        w('DIRECT: 文件级直写后 %d ACEs %s' % (len(aces), aces))
    except OSError as e:
        w('DIRECT: 直写失败 %s' % e)
    os.remove(f2)

    with open(DIAG, 'a', encoding='utf-8') as fh:
        fh.write('==== diag %s ====\n%s\n' % (time.strftime('%F %T'),
                                              '\n'.join(lines)))
    with open(LOG, 'a', encoding='utf-8') as fh:
        fh.write('==== diag 完成，见 eater-audit-diag.log ====\n')


def handle_cmd():
    """消费指令文件（白名单动作），结果落 DIAG。"""
    if not os.path.exists(CMD_FILE):
        return
    try:
        with open(CMD_FILE, encoding='utf-8') as f:
            cmd = json.load(f)
        os.remove(CMD_FILE)
        act = cmd.get('action')
        if act == 'diag':
            diag()
        else:
            with open(DIAG, 'a', encoding='utf-8') as fh:
                fh.write('==== 未知指令 %r ====\n' % cmd)
    except Exception as e:
        with open(DIAG, 'a', encoding='utf-8') as fh:
            fh.write('==== cmd 异常 %r ====\n' % (e,))


def main():
    last = load_state()
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write('==== watcher 启动 %s（last_rid=%d）====\n' % (time.strftime('%F %T'), last))
    err_streak = 0
    while True:
        try:
            handle_cmd()
            events, err = poll()
            now = time.strftime('%F %T')
            if err is not None:
                err_streak += 1
                with open(STATUS, 'w', encoding='utf-8') as f:
                    f.write('%s | ERROR x%d: %s\n' % (now, err_streak, err))
                if err_streak == 1:
                    with open(LOG, 'a', encoding='utf-8') as f:
                        f.write('==== 查询失败: %s ====\n' % err)
            else:
                err_streak = 0
                fresh = [e for e in events if e['rid'] > last]
                hits = [e for e in fresh if relevant(e['data'])]
                if hits:
                    with open(LOG, 'a', encoding='utf-8') as f:
                        for e in sorted(hits, key=lambda x: x['rid']):
                            f.write(fmt(e) + '\n')
                if fresh:
                    last = max(e['rid'] for e in fresh)
                    save_state(last)
                with open(STATUS, 'w', encoding='utf-8') as f:
                    f.write('%s | 心跳正常 last_rid=%d 累计命中见 eater-audit.log\n'
                            % (now, last))
        except Exception as e:  # watcher 不能死
            try:
                with open(STATUS, 'w', encoding='utf-8') as f:
                    f.write('%s | EXCEPTION: %r\n' % (time.strftime('%F %T'), e))
            except Exception:
                pass
        time.sleep(POLL_SEC)


if __name__ == '__main__':
    main()
