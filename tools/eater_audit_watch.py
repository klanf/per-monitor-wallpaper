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
import xml.etree.ElementTree as ET

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
XPATH = "*[System[(EventID=4663) or (EventID=4659) or (EventID=4660)]]"
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
    r = subprocess.run(
        ['wevtutil', 'qe', 'Security', '/q:' + XPATH,
         '/f:xml', '/c:%d' % BATCH, '/rd:true'],
        capture_output=True)
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


def main():
    last = load_state()
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write('==== watcher 启动 %s（last_rid=%d）====\n' % (time.strftime('%F %T'), last))
    err_streak = 0
    while True:
        try:
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
