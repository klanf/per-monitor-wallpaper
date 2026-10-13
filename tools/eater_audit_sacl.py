# -*- coding: utf-8 -*-
"""
git 啃食者定罪工具之一：给 .git 目录挂「删除审计」SACL（需管理员）。

用法：
  python eater-audit-sacl.py --set <dir> [dir ...]   给目录写入审计 ACE（幂等，重复跑会跳过）
  python eater-audit-sacl.py --show <dir>            查看目录当前 SACL（需管理员）

原理：
  用 SetNamedSecurityInfoW 给目标目录写 SYSTEM_AUDIT_ACE
  （Everyone / DELETE / 仅审计成功），OI|CI 继承到所有文件与子目录。
  此后任何进程删除这些文件，安全日志记 4663（访问尝试，含进程路径与 PID）
  和 4660（对象已删除）。配合 eater_audit_watch.py 落盘取证。
"""
import ctypes
import argparse
import sys

adv = ctypes.windll.advapi32

# 显式签名：SetNamedSecurityInfoW 的 pSacl 是 PACL（一级指针），
# GetNamedSecurityInfoW 的 ppSacl 才是二级指针——两者搞反就是「rc=0 但没写上」
adv.SetNamedSecurityInfoW.restype = ctypes.c_uint32
adv.SetNamedSecurityInfoW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32,
                                      ctypes.c_uint32, ctypes.c_void_p,
                                      ctypes.c_void_p, ctypes.c_void_p,
                                      ctypes.c_void_p]

SE_FILE_OBJECT = 1
SACL_SECURITY_INFORMATION = 0x00000008
SYSTEM_AUDIT_ACE_TYPE = 2
OBJECT_INHERIT_ACE = 0x01
CONTAINER_INHERIT_ACE = 0x02
SUCCESSFUL_ACCESS_ACE_FLAG = 0x40
FAILED_ACCESS_ACE_FLAG = 0x80
DELETE = 0x00010000
REVISION = 1  # ACL_REVISION

# Everyone SID 的二进制形式：S-1-1-0
EVERYONE_SID = bytes([0x01, 0x01,
                      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                      0x00, 0x00, 0x00, 0x00])

k32 = ctypes.windll.kernel32
_priv_done = False


def enable_security_privilege():
    """开启本进程的 SeSecurityPrivilege。

    管理员令牌默认【持有但未启用】该特权，不 enable 就调
    Get/SetNamedSecurityInfoW 读 SACL 会得到 rc=1314（特权未持有）。
    幂等，重复调用无害。
    """
    global _priv_done
    if _priv_done:
        return
    TOKEN_ADJUST_PRIVILEGES = 0x0020
    TOKEN_QUERY = 0x0008
    SE_PRIVILEGE_ENABLED = 0x0002

    class LUID(ctypes.Structure):
        _fields_ = [('LowPart', ctypes.c_uint32), ('HighPart', ctypes.c_int32)]

    class LUID_AND_ATTRIBUTES(ctypes.Structure):
        _fields_ = [('Luid', LUID), ('Attributes', ctypes.c_uint32)]

    class TOKEN_PRIVILEGES(ctypes.Structure):
        _fields_ = [('PrivilegeCount', ctypes.c_uint32),
                    ('Privileges', LUID_AND_ATTRIBUTES * 1)]

    # 64 位句柄必须显式原型，否则默认 c_int 截断出 rc=6
    k32.GetCurrentProcess.restype = ctypes.c_void_p
    adv.OpenProcessToken.argtypes = [ctypes.c_void_p, ctypes.c_uint32,
                                     ctypes.POINTER(ctypes.c_void_p)]
    adv.LookupPrivilegeValueW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p,
                                          ctypes.POINTER(LUID)]
    adv.AdjustTokenPrivileges.argtypes = [ctypes.c_void_p, ctypes.c_int,
                                          ctypes.c_void_p, ctypes.c_uint32,
                                          ctypes.c_void_p, ctypes.c_void_p]

    htok = ctypes.c_void_p()
    if not adv.OpenProcessToken(k32.GetCurrentProcess(),
                                TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
                                ctypes.byref(htok)):
        raise OSError('OpenProcessToken 失败 rc=%d' % k32.GetLastError())
    try:
        tp = TOKEN_PRIVILEGES()
        tp.PrivilegeCount = 1
        if not adv.LookupPrivilegeValueW(None, 'SeSecurityPrivilege',
                                         ctypes.byref(tp.Privileges[0].Luid)):
            raise OSError('LookupPrivilegeValueW(SeSecurityPrivilege) 失败')
        tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED
        if not adv.AdjustTokenPrivileges(htok, False, ctypes.byref(tp), 0, None, None):
            raise OSError('AdjustTokenPrivileges 失败 rc=%d' % k32.GetLastError())
        # 1300 = ERROR_NOT_ALL_ASSIGNED：令牌里根本没有这个特权（不是管理员）
        err = k32.GetLastError()
        if err == 1300:
            raise OSError('SeSecurityPrivilege 未分配——请以管理员身份运行')
        _priv_done = True
    finally:
        k32.CloseHandle(htok)


class ACL(ctypes.Structure):
    _fields_ = [('AclRevision', ctypes.c_ubyte),
                ('Sbz1', ctypes.c_ubyte),
                ('AclSize', ctypes.c_ushort),
                ('AceCount', ctypes.c_ushort),
                ('Sbz2', ctypes.c_ushort)]


def _get_sacl(path):
    """返回 (sacl 指针, sd 指针)。两者必须在整个使用周期存活。"""
    enable_security_privilege()  # 不开特权，读 SACL 一律 rc=1314
    sacl = ctypes.c_void_p()
    sd = ctypes.c_void_p()
    rc = adv.GetNamedSecurityInfoW(
        ctypes.c_wchar_p(path), SE_FILE_OBJECT, SACL_SECURITY_INFORMATION,
        None, None, None, ctypes.byref(sacl), ctypes.byref(sd))
    if rc != 0:
        raise OSError('GetNamedSecurityInfoW(%s) rc=%d（非管理员会失败）' % (path, rc))
    return sacl, sd


def _walk_aces(sacl_p):
    """产出 (aceType, aceFlags, mask, sid_bytes)。"""
    if not sacl_p or not sacl_p.value:
        return
    acl = ctypes.cast(sacl_p, ctypes.POINTER(ACL)).contents
    base = sacl_p.value
    offset = 8  # ACL 头 8 字节
    for _ in range(acl.AceCount):
        if offset + 8 > acl.AclSize:
            break
        head = ctypes.string_at(base + offset, 8)
        ace_type, ace_flags = head[0], head[1]
        ace_size = int.from_bytes(head[2:4], 'little')
        if ace_size < 8 or offset + ace_size > acl.AclSize:
            break
        # ⚠️ 必须读满 ace_size 才拿得到 SID——只读 8 字节时 sid 永远为空，
        # 会把「已有审计 ACE」误判成没有（幂等失效 + 回读假阴性）
        full = ctypes.string_at(base + offset, ace_size)
        mask = int.from_bytes(full[4:8], 'little')
        sid = full[8:ace_size]
        yield ace_type, ace_flags, mask, sid
        offset += ace_size


def _audit_ace_exists(sacl_p):
    """已有「Everyone + DELETE 审计」就返回 True（幂等保护）。"""
    for t, f, m, sid in _walk_aces(sacl_p):
        if t == SYSTEM_AUDIT_ACE_TYPE and (m & DELETE) and sid == EVERYONE_SID:
            return True
    return False


def build_audit_sacl(path):
    """给目录写入「仅含审计 ACE」的全新 SACL（覆盖式，幂等）。

    ⚠️ SetNamedSecurityInfoW 的 pSacl 是 PACL——直接传 ACL 指针，
    不像 GetNamedSecurityInfoW 那样收二级指针；首版误传 byref(PPACL)
    导致 API 拿垃圾字节当 ACL、rc=0 却什么都没写。
    覆盖式而不是追加式：.git 目录此前无有效 SACL，追加反而会被
    首版写进去的垃圾 SACL 干扰；本地开发目录无其他审计条目可保全。
    """
    enable_security_privilege()
    old_p, sd = _get_sacl(path)
    if _audit_ace_exists(old_p):
        return None  # 已存在，幂等跳过

    ace_size = 8 + len(EVERYONE_SID)
    ace = (bytes([SYSTEM_AUDIT_ACE_TYPE,
                  OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE | SUCCESSFUL_ACCESS_ACE_FLAG])
           + ace_size.to_bytes(2, 'little')
           + DELETE.to_bytes(4, 'little')
           + EVERYONE_SID)

    acl_size = 8 + len(ace)
    buf = ctypes.create_string_buffer(acl_size)
    hdr = ctypes.cast(ctypes.addressof(buf), ctypes.POINTER(ACL)).contents
    hdr.AclRevision = REVISION
    hdr.AclSize = acl_size
    hdr.AceCount = 1
    ctypes.memmove(ctypes.addressof(buf) + 8, ace, len(ace))

    rc = adv.SetNamedSecurityInfoW(
        ctypes.c_wchar_p(path), SE_FILE_OBJECT, SACL_SECURITY_INFORMATION,
        None, None, None, ctypes.c_void_p(ctypes.addressof(buf)))
    if rc != 0:
        raise OSError('SetNamedSecurityInfoW(%s) rc=%d' % (path, rc))
    return buf  # 返回 buffer，防止被 GC（调用方引用）


def show(path):
    sacl_p, sd = _get_sacl(path)
    if not sacl_p or not sacl_p.value:
        print('[show] %s : SACL 为空（未挂审计）' % path)
        return
    acl = ctypes.cast(sacl_p, ctypes.POINTER(ACL)).contents
    print('[show] %s : AceCount=%d' % (path, acl.AceCount))
    names = {0x40: 'FAIL_AUDIT', 0x41: 'FAIL_AUDIT+INHERIT', 2: 'AUDIT'}
    for t, f, m, sid in _walk_aces(sacl_p):
        flag_desc = []
        if f & 0x01: flag_desc.append('OI')
        if f & 0x02: flag_desc.append('CI')
        if f & 0x40: flag_desc.append('SA(成功审计)')
        if f & 0x80: flag_desc.append('FA(失败审计)')
        print('  type=%s flags=[%s] mask=0x%08x sid=%s'
              % (names.get(t, str(t)), ','.join(flag_desc), m, sid.hex()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', nargs='+', metavar='DIR')
    ap.add_argument('--show', nargs='+', metavar='DIR')
    args = ap.parse_args()

    ok = True
    if args.set:
        for d in args.set:
            try:
                r = build_audit_sacl(d)
                print('[set] %s : %s' % (d, '已有审计 ACE，跳过' if r is None else '写入成功'))
            except OSError as e:
                print('[set] %s : 失败 —— %s' % (d, e))
                ok = False
    if args.show:
        for d in args.show:
            try:
                show(d)
            except OSError as e:
                print('[show] %s : 失败 —— %s' % (d, e))
                ok = False
    if not args.set and not args.show:
        ap.print_help()
        ok = False
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
