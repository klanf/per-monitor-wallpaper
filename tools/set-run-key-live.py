# -*- coding: utf-8 -*-
# 重写 HKCU Run 的 electron-wallpaper-live 值（确保反斜杠原样入库），并回读核验。
import winreg

BS = chr(92)  # 反斜杠，避免任何转义歧义
exe = BS.join(['D:', 'workbuddy', 'projects', 'electron-wallpaper', 'electron-wallpaper-live',
               'node_modules', 'electron', 'dist', 'electron.exe'])
app = BS.join(['D:', 'workbuddy', 'projects', 'electron-wallpaper', 'electron-wallpaper-live'])
ud  = BS.join(['D:', 'workbuddy', 'projects', 'electron-wallpaper', 'wp-live-userdata'])
new_val = '"' + exe + '" "' + app + '" --wp-user-data="' + ud + '" --hidden'

run = r'Software' + BS + 'Microsoft' + BS + 'Windows' + BS + 'CurrentVersion' + BS + 'Run'
k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, run, 0, winreg.KEY_SET_VALUE)
winreg.SetValueEx(k, 'electron-wallpaper-live', 0, winreg.REG_SZ, new_val)
winreg.CloseKey(k)

# 回读核验：值必须与 new_val 完全一致（含反斜杠方向）
k2 = winreg.OpenKey(winreg.HKEY_CURRENT_USER, run)
i, got = 0, None
while True:
    try:
        v, val, _ = winreg.EnumValue(k2, i); i += 1
        if v == 'electron-wallpaper-live':
            got = val
    except OSError:
        break
ok = (got == new_val) and (chr(47) not in got)  # 无正斜杠
print('EXACT_MATCH:', ok)
print('HAS_BACKSLASH:', chr(92) in (got or ''))
print('VALUE:', got)
with open(r'D:' + BS + 'workbuddy' + BS + '_archive' + BS + 'run-key-live-written.txt', 'w', encoding='utf-8') as f:
    f.write(got or '(none)')
