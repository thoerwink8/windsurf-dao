处置：#1136

# 机制巡检：#1104 合了，机器上的 dao-board-gc 还 After=orca-serve；⑳ 被没装的单元盖成没查成

## 结论

PR #1104 已合（`515953302`，审官 APPROVED @ `42269dc74`），脚本不再问 orca：`dao-board-gc.service` 最近一次 02:08 是 Result=success / ExecMainStatus=1（有要人判的卡，不是没查成 2），journal 里没有 `result.worktrees 不是数组`。推一把跳过已关 #1007。`review-pending/1104.json` 不在。

洞在装机面：`/etc/systemd/system/dao-board-gc.service` 仍是 2026-09-06 那份（`After=orca-serve.service`，没有 `NO_COLOR`/`GH_NO_COLOR`），仓里 09-07 16:21 那份已经改过。同病：`dao-patrol.service` 还 After=orca-serve，`dao-refiner.service` 缺 NO_COLOR。⑳ 本应报红，但 `dao-nudge-stalled` / `dao-land` / `dao-gh-events` / `miraquota-contabo` 机器上没装，整项走 unknown，漂移被盖住。

## 证据

本轮 2026-09-08 02:13 CST。`HEAD=c3673ad96` 与 `origin/master` 相同。#1104 `state=MERGED` `mergedAt=2026-09-07T08:17:49Z`。

```
$ md5sum /etc/systemd/system/dao-board-gc.service host/machine/systemd/dao-board-gc.service
ac9612b3c2cdbb74a390f70a1d6758a7  /etc/systemd/system/dao-board-gc.service
f6d3a3dc8c58eb188f985bf44bd43dbb  host/machine/systemd/dao-board-gc.service

$ systemctl show dao-board-gc.service -p ExecMainStatus,Result,ExecMainStartTimestamp
ExecMainStatus=1
Result=success
ExecMainStartTimestamp=Tue 2026-09-08 02:08:03 CST
```

`classifyUnitDrift` 本机实测：`state=unknown`，detail 只列 7 个没装，不提 `dao-board-gc.service`。

推一把 `--go`（orca，`/home/orca/wt/watchdog-legs`）：`[推一把·跳过] 工人 #1007（issue 已关）`；审官 #1015/#1127/#1106/#1109/#1108/#1099/#1118/#1107 起了会话。

## 不是已报过的那几条

| 已有观察 | 管的是 | 本条不是 |
|---|---|---|
| `2026-09-06-board-gc与stall仍问orca.md` | 脚本入口问 orca | 脚本已换 mirasim，**单元文件**没跟上 |
| `2026-09-06-四套单元未装-⑳把没装判没查成.md` | 新单元整份没装 | 本条是**已装却漂了**被没装盖住 |
| `2026-09-07-nudge装了却disabled-⑱看不见.md` | timer disabled | 现在连 `/etc` 文件都没了 |

## 建议的最小改造

⑳：已比对且漂了的优先于没比成。没装仍 unknown（本函数不装单元）。装机：`sudo bash scripts/install-board-gc.sh`（以及 patrol / refiner 的同款脚本）。
