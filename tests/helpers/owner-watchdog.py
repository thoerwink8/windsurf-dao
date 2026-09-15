# tests/helpers/owner-watchdog.py —— parent-alive 的旁路看门狗
#
# 主线程卡在 spawnSync 时，Node 定时器排不上。这个进程有自己的事件循环，
# 能在那种时候按 owner pid 把被罩的进程杀掉。
#
# owner 死后清的是 victim 整棵非 detached 后代树，不只 victim 一个 pid。
# 仓内有测试显式覆盖 NODE_OPTIONS（只留 PATH），那些孙子装不上 parent-alive，
# 也没法靠它自己退出；只杀 runner 会把它们留给 init。规则与
# scripts/lib/test-child-guard.mjs 的 descendantPids / killProcessTree 相同：
# 先列树再动手，跳过 pgid==pid 的组头（ACP / detached），也不顺着组头往下走。
# 本进程是 victim 的孩子，名单里会有自己——杀树时跳过 self，否则清不完。
#
# 本进程是被罩进程的孩子：给自己装 PR_SET_PDEATHSIG，被罩进程正常退出时
# 我们跟着死，不留 30 秒空转。看的是 DAO_WD_OWNER（dao-check），不是立即
# 父进程——ACP 会话必须活过「发起它的那个 dao 进程」，不能装在 node 本体上。

from __future__ import annotations

import ctypes
import os
import signal
import sys
import time


def _set_pdeathsig() -> None:
    try:
        ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL)
    except Exception:
        pass


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except Exception:
        return True


def _parse_proc(pid: int):
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as fh:
            s = fh.read()
        closed = s.rfind(")")
        if closed < 0:
            return None
        fields = s[closed + 2 :].strip().split()
        if len(fields) < 20:
            return None
        state = fields[0]
        if state in ("Z", "X"):
            return None
        return {
            "pid": pid,
            "ppid": int(fields[1]),
            "pgid": int(fields[2]),
        }
    except (FileNotFoundError, ProcessLookupError, ValueError, IndexError, OSError):
        return None


def _list_processes():
    try:
        names = os.listdir("/proc")
    except OSError:
        return []
    out = []
    for name in names:
        if not name.isdigit():
            continue
        row = _parse_proc(int(name))
        if row:
            out.append(row)
    return out


def _descendant_pids(root: int, procs, skip_group_leaders: bool = True):
    children_of = {}
    for row in procs:
        children_of.setdefault(row["ppid"], []).append(row)
    out = []
    seen = {root}
    queue = [root]
    while queue:
        parent = queue.pop(0)
        for row in children_of.get(parent, []):
            pid = row["pid"]
            if pid in seen:
                continue
            seen.add(pid)
            is_leader = skip_group_leaders and row["pgid"] == pid and pid != root
            if is_leader:
                continue
            out.append(pid)
            queue.append(pid)
    return out


def _kill_tree(root: int, self_pid: int) -> None:
    # 先列后杀：先杀 root 的话孩子会被 init 收走，下一轮扫不到。
    procs = _list_processes()
    descendants = _descendant_pids(root, procs, skip_group_leaders=True) if procs else []
    seen = set()
    for pid in [*descendants, root]:
        if pid in seen or pid == self_pid:
            continue
        seen.add(pid)
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except Exception:
            pass


def _owner_alive(pid: int, starttime: str, boot: str) -> bool:
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as fh:
            s = fh.read()
        closed = s.rfind(")")
        fields = s[closed + 2 :].strip().split()
        got = fields[19] if len(fields) > 19 else ""
        if starttime:
            if got != starttime:
                return False
            if boot:
                try:
                    with open("/proc/sys/kernel/random/boot_id", "r", encoding="utf-8") as fh:
                        if fh.read().strip() != boot:
                            return False
                except Exception:
                    pass
            return True
        return _pid_alive(pid)
    except FileNotFoundError:
        return False
    except Exception:
        return True


def main() -> int:
    try:
        owner = int(os.environ["DAO_WD_OWNER"])
        victim = int(os.environ["DAO_WD_VICTIM"])
        starttime = os.environ.get("DAO_WD_STARTTIME", "")
        boot = os.environ.get("DAO_WD_BOOT", "")
        poll = max(0.05, int(os.environ.get("DAO_WD_POLL", "30000")) / 1000.0)
    except (KeyError, ValueError):
        return 0

    _set_pdeathsig()
    while True:
        if not _pid_alive(victim):
            return 0
        if not _owner_alive(owner, starttime, boot):
            try:
                _kill_tree(victim, os.getpid())
            except Exception:
                try:
                    os.kill(victim, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except Exception:
                    pass
            return 0
        time.sleep(poll)


if __name__ == "__main__":
    raise SystemExit(main())
