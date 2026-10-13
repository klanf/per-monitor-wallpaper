#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
commit-guard：git commit 前后监控 refs，被「啃食者」吃掉立即自动恢复。

背景（2026-10-13 用户要求"commit 前都监控一下"）：本机 git 仓库两次发生
commit 成功后 refs/heads/<dir>/ 整目录消失（提交对象完好），且 git 管道写
ref 会静默 no-op —— 所以恢复必须直接手写 ref 文件，不能用 git update-ref。

用法（在仓库任意目录）：
    python commit-guard.py -m "提交说明"
    python commit-guard.py -m "说明" -- --no-verify   （-- 后参数原样透传给 git commit）

行为：
  1. commit 前快照：HEAD 指向、全部 refs（松散 + packed-refs）、提交对象将在的预期
  2. 执行 git commit（透传其余参数）
  3. commit 后复检：
     - 快照里的每个 ref 仍在且哈希不变（当前分支除外 —— 它应前移到新提交）
     - 新提交对象 cat-file -t = commit
     - 当前分支 ref == 新提交哈希
  4. 异常 → 直接手写 ref 文件恢复 + 追加日志 eater-watch.log（时间戳/丢什么/怎么恢复）
     正常 → 也记一行审计日志（啃食者的时间线就靠它拼）

退出码：0=正常；1=git commit 本身失败；2=检测到啃食（已恢复，请核对）。
"""

import argparse
import datetime
import subprocess
import sys
from pathlib import Path

LOG_CANDIDATES = [
    Path(r"D:\workbuddy\projects\electron-wallpaper\eater-watch.log"),
]


def run_git(repo: Path, *args, check=True):
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败: {r.stderr.strip()[:300]}")
    return r


def snapshot_refs(git_dir: Path):
    """全部 refs：{refname: hash}。松散文件 + packed-refs 合并（松散优先）。"""
    refs = {}
    packed = git_dir / "packed-refs"
    if packed.exists():
        for line in packed.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("^"):
                continue
            h, _, name = line.partition(" ")
            if name:
                refs[name.strip()] = h.strip()
    heads = git_dir / "refs"
    if heads.exists():
        for p in heads.rglob("*"):
            if p.is_file():
                name = p.relative_to(git_dir).as_posix()
                try:
                    refs[name] = p.read_text(encoding="utf-8").strip()
                except OSError:
                    pass   # 读不到 = 可能正被啃，留给复检抓
    return refs


def write_ref(git_dir: Path, name: str, hash_: str):
    """直接手写 ref 文件（git 管道写 ref 在本机会静默 no-op，不能用）。"""
    p = git_dir / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(hash_ + "\n", encoding="utf-8", newline="\n")


def append_log(msg: str):
    line = f"[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] [commit-guard] {msg}"
    print(line)
    for log in LOG_CANDIDATES:
        try:
            log.parent.mkdir(parents=True, exist_ok=True)
            with log.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
            return
        except OSError:
            continue


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-m", "--message", required=True)
    ap.add_argument("passthrough", nargs="*", help="-- 之后的参数透传给 git commit")
    args = ap.parse_args()
    passthrough = args.passthrough
    if passthrough and passthrough[0] == "--":
        passthrough = passthrough[1:]

    repo = Path.cwd()
    git_dir = Path(run_git(repo, "rev-parse", "--git-dir").stdout.strip())
    if not git_dir.is_absolute():
        git_dir = repo / git_dir
    git_dir = git_dir.resolve()

    branch = run_git(repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    pre_refs = snapshot_refs(git_dir)
    pre_head = run_git(repo, "rev-parse", "HEAD").stdout.strip() if branch != "HEAD" else ""
    append_log(f"commit 开始：branch={branch} pre_head={pre_head[:12] or '(空仓库)'} "
               f"refs={len(pre_refs)}")

    # ---- 执行 commit ----
    r = subprocess.run(["git", "-C", str(repo), "commit", "-m", args.message, *passthrough],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        append_log(f"commit 失败（rc={r.returncode}）：{(r.stderr or r.stdout).strip()[:200]}")
        print((r.stderr or r.stdout).strip()[:2000], file=sys.stderr)
        sys.exit(1)

    new_hash = run_git(repo, "rev-parse", "HEAD").stdout.strip()
    problems = []

    # ---- 复检 1：新提交对象存在 ----
    t = run_git(repo, "cat-file", "-t", new_hash, check=False).stdout.strip()
    if t != "commit":
        problems.append(f"新提交对象异常：cat-file -t {new_hash[:12]} = {t or '(无)'}")

    # ---- 复检 2：当前分支 ref == 新提交 ----
    post_refs = snapshot_refs(git_dir)
    cur = post_refs.get(f"refs/heads/{branch}")
    if cur != new_hash:
        problems.append(f"当前分支 ref 未指向新提交：refs/heads/{branch} = "
                        f"{(cur or '(缺失)')[:12]} != {new_hash[:12]}")

    # ---- 复检 3：其余 ref 一个都不能少、不能变 ----
    for name, h in pre_refs.items():
        if name == f"refs/heads/{branch}":
            continue
        now = post_refs.get(name)
        if now is None:
            problems.append(f"ref 被啃：{name}（原 {h[:12]}）消失")
        elif now != h:
            problems.append(f"ref 被改：{name} {h[:12]} -> {now[:12]}")

    # ---- 恢复 ----
    restored = 0
    if problems:
        for name, h in pre_refs.items():
            if name == f"refs/heads/{branch}":
                continue   # 当前分支保持新提交，不回写
            now = post_refs.get(name)
            if now != h:
                try:
                    write_ref(git_dir, name, h)
                    restored += 1
                except OSError as e:
                    append_log(f"恢复失败 {name}: {e}")
        # 当前分支若缺失，手写回新哈希
        if post_refs.get(f"refs/heads/{branch}") != new_hash:
            try:
                write_ref(git_dir, f"refs/heads/{branch}", new_hash)
                restored += 1
            except OSError as e:
                append_log(f"恢复当前分支失败: {e}")

    if problems:
        append_log(f"⚠️ 检测到 {len(problems)} 处异常，已恢复 {restored} 个 ref："
                   + "；".join(problems[:5]))
        print("提交完成但检测到 ref 异常（已自动恢复，请核对 git log）：")
        for p in problems:
            print("  -", p)
        sys.exit(2)

    # 正常也要验一次当前分支落盘（有过静默 no-op 前科）
    final = snapshot_refs(git_dir).get(f"refs/heads/{branch}")
    if final != new_hash:
        write_ref(git_dir, f"refs/heads/{branch}", new_hash)
        append_log(f"⚠️ commit 后当前分支 ref 未落盘（静默 no-op），已手写恢复 -> {new_hash[:12]}")
        sys.exit(2)

    append_log(f"commit 正常：{new_hash[:12]} branch={branch} refs={len(pre_refs)}->"
               f"{len(snapshot_refs(git_dir))}")


if __name__ == "__main__":
    main()
