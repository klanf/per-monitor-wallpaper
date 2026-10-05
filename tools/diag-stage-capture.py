# 诊断:用 PrintWindow 抓取两个动态桌面 stage 窗口的实际渲染内容
# 用法: python diag-stage-capture.py [输出目录]
import ctypes
import os
import sys
from ctypes import wintypes as wt

u32 = ctypes.windll.user32
g32 = ctypes.windll.gdi32
k32 = ctypes.windll.kernel32

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))

# 1. 找出挂在 Progman 下的 stage 窗口(属于 electron-wallpaper 进程)
APP_HINT = 'electron-wallpaper'
stages = []  # (hwnd, pid, rect)

def is_app_pid(pid):
    h = k32.OpenProcess(0x1000, False, pid)
    if not h:
        return False
    buf = ctypes.create_unicode_buffer(512)
    size = wt.DWORD(512)
    ok = k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
    k32.CloseHandle(h)
    return ok and APP_HINT in buf.value

def collect_children(hwnd):
    kids = []
    CBK = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def cb(kid, lp):
        kids.append(kid)
        return True
    u32.EnumChildWindows(hwnd, CBK(cb), 0)
    return kids

CBK = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
def find_progman(hwnd, lp):
    cls = ctypes.create_unicode_buffer(256)
    u32.GetClassNameW(hwnd, cls, 256)
    if cls.value == 'Progman':
        for kid in collect_children(hwnd):
            kcls = ctypes.create_unicode_buffer(256)
            u32.GetClassNameW(kid, kcls, 256)
            if kcls.value == 'Chrome_WidgetWin_1':
                pid = wt.DWORD()
                u32.GetWindowThreadProcessId(kid, ctypes.byref(pid))
                if is_app_pid(pid.value):
                    r = wt.RECT()
                    u32.GetWindowRect(kid, ctypes.byref(r))
                    stages.append((kid, pid.value, r.left, r.top, r.right - r.left, r.bottom - r.top))
    return True

u32.EnumWindows(CBK(find_progman), 0)
print('找到 stage 窗口:', stages)
if not stages:
    print('没有挂载的 stage —— 动态桌面没在跑或已卸载')
    sys.exit(0)

# 2. 逐个 PrintWindow 抓内容
PW_RENDERFULLCONTENT = 2
BI_RGB = 0
DIB_RGB_COLORS = 0

def capture(hwnd, w, h, out_path):
    hdc_win = u32.GetWindowDC(hwnd)
    hdc_mem = g32.CreateCompatibleDC(hdc_win)
    class BMIH(ctypes.Structure):
        _fields_ = [('biSize', wt.DWORD), ('biWidth', ctypes.c_long), ('biHeight', ctypes.c_long),
                    ('biPlanes', wt.WORD), ('biBitCount', wt.WORD), ('biCompression', wt.DWORD),
                    ('biSizeImage', wt.DWORD), ('biXPels', ctypes.c_long), ('biYPels', ctypes.c_long),
                    ('biClrUsed', wt.DWORD), ('biClrImportant', wt.DWORD)]
    bmi = BMIH()
    bmi.biSize = ctypes.sizeof(BMIH)
    bmi.biWidth = w
    bmi.biHeight = -h  # top-down
    bmi.biPlanes = 1
    bmi.biBitCount = 32
    bmi.biCompression = BI_RGB
    bmi.biSizeImage = w * h * 4
    buf = ctypes.create_string_buffer(bmi.biSizeImage)
    hbmp = g32.CreateDIBSection(hdc_mem, ctypes.byref(bmi), DIB_RGB_COLORS, ctypes.byref(ctypes.c_void_p()), None, 0)
    # 上面 byref 传法拿不到像素指针,改用接收指针的写法:
    g32.DeleteObject(hbmp)
    pbits = ctypes.c_void_p()
    hbmp = g32.CreateDIBSection(hdc_mem, ctypes.byref(bmi), DIB_RGB_COLORS, ctypes.byref(pbits), None, 0)
    if not hbmp or not pbits.value:
        print('CreateDIBSection 失败')
        return False
    old = g32.SelectObject(hdc_mem, hbmp)
    # 先刷一层非黑底,便于识别"真黑"还是"没画"
    g32.PatBlt(hdc_mem, 0, 0, w, h, 0xFA0089)  # WHITENESS
    ok = u32.PrintWindow(hwnd, hdc_mem, PW_RENDERFULLCONTENT)
    # 读像素
    raw = ctypes.string_at(pbits.value, bmi.biSizeImage)
    g32.SelectObject(hdc_mem, old)
    g32.DeleteObject(hbmp)
    g32.DeleteDC(hdc_mem)
    u32.ReleaseDC(hwnd, hdc_win)
    print(f'{out_path}: PrintWindow 返回 {ok}, 尺寸 {w}x{h}')
    # 统计非黑比例 + 采样
    total = w * h
    nonblack = 0
    step = max(1, total // 200000)
    import struct
    cnt = 0
    for i in range(0, total, step):
        b, g, r = raw[i*4], raw[i*4+1], raw[i*4+2]
        if (r, g, b) != (0, 0, 0):
            nonblack += 1
        cnt += 1
    print(f'  非黑像素比例: {nonblack}/{cnt} = {nonblack/cnt:.1%}')
    # 存 BMP(方便无依赖查看)
    with open(out_path, 'wb') as f:
        # BITMAPFILEHEADER
        f.write(struct.pack('<2sIHHI', b'BM', 14 + 40 + len(raw), 0, 0, 14 + 40))
        f.write(bytes(bmi))
        f.write(raw)
    return True

for idx, (hwnd, pid, x, y, w, h) in enumerate(stages):
    capture(hwnd, w, h, os.path.join(OUT, f'stage-{idx}-pid{pid}-{w}x{h}.bmp'))

print('完成')
