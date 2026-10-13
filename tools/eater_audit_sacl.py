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


class ACL(ctypes.Structure):
    _fields_ = [('AclRevision', ctypes.c_ubyte),
                ('Sbz1', ctypes.c_ubyte),
                ('AclSize', ctypes.c_ushort),
                ('AceCount', ctypes.c_ushort),
                ('Sbz2', ctypes.c_ushort)]


def _get_sacl(path):
    """返回 (sacl 指针, sd 指针)。两者必须在整个使用周期存活。"""
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
        raw = ctypes.string_at(base + offset, 8)
        ace_type, ace_flags = raw[0], raw[1]
        ace_size = int.from_bytes(raw[2:4], 'little')
        mask = int.from_bytes(raw[4:8], 'little')
        sid = raw[8:] if ace_size > 8 else b''
        yield ace_type, ace_flags, mask, sid
        offset += ace_size


def _audit_ace_exists(sacl_p):
    """已有「Everyone + DELETE 审计」就返回 True（幂等保护）。"""
    for t, f, m, sid in _walk_aces(sacl_p):
        if t == SYSTEM_AUDIT_ACE_TYPE and (m & DELETE) and sid == EVERYONE_SID:
            return True
    return False


def build_audit_sacl(path):
    """在现有 SACL 基础上追加审计 ACE，返回新 SACL 的指针（caller 保活）。"""
    old_p, sd = _get_sacl(path)
    if _audit_ace_exists(old_p):
        return None  # 已存在，幂等跳过

    ace_size = 8 + len(EVERYONE_SID)
    ace = (bytes([SYSTEM_AUDIT_ACE_TYPE,
                  OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE | SUCCESSFUL_ACCESS_ACE_FLAG])
           + ace_size.to_bytes(2, 'little')
           + DELETE.to_bytes(4, 'little')
           + EVERYONE_SID)

    if old_p and old_p.value:
        old = ctypes.cast(old_p, ctypes.POINTER(ACL)).contents
        old_bytes = ctypes.string_at(old_p.value, old.AclSize)
    else:
        # 空 ACL：8 字节头
        old_bytes = (bytes([REVISION, 0]) + (8).to_bytes(2, 'little')
                     + (0).to_bytes(2, 'little') + (0).to_bytes(2, 'little'))

    new_size = len(old_bytes) + len(ace)
    buf = ctypes.create_string_buffer(new_size)
    ctypes.memmove(buf, old_bytes, len(old_bytes))
    ctypes.memmove(ctypes.addressof(buf) + len(old_bytes), ace, len(ace))

    # 修正头：AclSize / AceCount
    hdr = ctypes.cast(ctypes.addressof(buf), ctypes.POINTER(ACL)).contents
    hdr.AclSize = new_size
    hdr.AceCount += 1

    new_p = ctypes.c_void_p(ctypes.addressof(buf))
    rc = adv.SetNamedSecurityInfoW(
        ctypes.c_wchar_p(path), SE_FILE_OBJECT, SACL_SECURITY_INFORMATION,
        None, None, None, ctypes.byref(new_p))
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
