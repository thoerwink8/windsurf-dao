# tests/helpers/owner-watchdog.py —— parent-alive 的旁路看门狗
#
# 主线程卡在 spawnSync 时，Node 定时器排不上。这个进程有自己的事件循环，
# 能在那种时候按 owner pid 把被罩的进程杀掉。
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
                os.kill(victim, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except Exception:
                pass
            return 0
        time.sleep(poll)


if __name__ == "__main__":
    raise SystemExit(main())
