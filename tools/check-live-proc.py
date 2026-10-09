# -*- coding: utf-8 -*-
import psutil
found = []
for p in psutil.process_iter(['pid', 'name', 'cmdline']):
    if (p.info['name'] or '').lower() != 'electron.exe':
        continue
    cmd = ' '.join(p.info['cmdline'] or [])
    if '--type=' in cmd:
        continue
    if 'electron-wallpaper-live' in cmd or cmd.strip().endswith(' .'):
        found.append((p.info['pid'], cmd[:90]))
print('live 主进程:', found if found else '无')
