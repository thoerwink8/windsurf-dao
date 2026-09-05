# 机制巡检：撞限流探测 oneshot 在 failed，⑮ 只看 timer 在册所以仍绿

## 结论

`dao-agent-stall.service` 本轮以 exit 1 收场，systemd 把它留在 `--failed` 里；脚本自己把 1 定义成「有真红没处理完」。活体闸 ⑮ 只问 `list-timers` 里有没有 `dao-agent-stall.timer`、垫片删没删——timer 还在、下一次也排了，于是这一格绿。失败态没有第二只眼睛。

## 证据

本轮（2026-09-06 00:32 CST）实测：

```
$ systemctl --failed --no-legend --no-pager
● dao-agent-stall.service loaded failed failed windsurf-dao agent stall / 429 watch (issue #833)

$ systemctl show dao-agent-stall.service -p Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,ActiveState
Result=exit-code
ExecMainStatus=1
ExecMainStartTimestamp=Sun 2026-09-06 00:32:00 CST
ExecMainExitTimestamp=Sun 2026-09-06 00:32:27 CST
ActiveState=failed

$ systemctl show dao-agent-stall.timer -p ActiveState,SubState,LastTriggerUSec,NextElapseUSecRealtime
ActiveState=active
SubState=waiting
LastTriggerUSec=Sun 2026-09-06 00:32:00 CST
NextElapseUSecRealtime=Sun 2026-09-06 00:47:00 CST
```

脚本把三个退出码写死在文件头（`scripts/agent-stall-watch.mjs:20`）：

```
退出码：0 扫完没事或已处理 / 1 有真红没处理完 / 2 没查成。
```

末尾 `process.exit(failed ? 1 : ...)`（同文件 608 行）。单元**没有** `SuccessExitStatus`（`host/machine/systemd/dao-agent-stall.service` 全文无此行；对照 `dao-patrol.service` / `dao-board-gc.service` 写了 `SuccessExitStatus=0 1`）。所以 1 就是 systemd 眼里的失败——这是故意的，不是配漏。

闸怎么判「这项健康」（`scripts/server-check.mjs:554-586` `classifyAgentStallWatch`）：

- `list-timers` 文本里有 `dao-agent-stall.timer` → 官方在册
- 没有 `agent-stall-watch.timer`、没有 `/home/orca/bin/agent-stall-watch.mjs` → 垫片已退役
- 然后 `return { state: OK, detail: 'dao-agent-stall.timer 在册，垫片已退役' }`

⑮ 的标题就是「撞限流探测 timer 在册且垫片已退役」（同文件 1191 行）。`Result`、`ExecMainStatus`、`systemctl --failed` 一个都不读。⑱ 只问有没有下一次触发——本轮 `NextElapseUSecRealtime` 有值，也绿。指挥官盘点（`scripts/lib/commander-inventory.mjs` 的 `checkTimers`）只问 commander 两个 timer 是否 enabled。全仓 `rg 'is-failed|--failed'` 在 `scripts/server-check.mjs` 与 `scripts/lib/commander-inventory.mjs` 里 0 命中。

timer 还在、下一次还排着，所以这不是「无声停摆」那种死态（那份已报过）。这是另一面：oneshot 每轮把「没处理完」写进 systemd 的失败表，而所有会响的检查都不读那张表。

本轮没跑完整 `server-check.mjs`（没验证它打印出来是不是绿），只核了对代码路径和 `systemctl show` 的输入。按 554-586 行，⑮ 会绿。没验证：exit 1 的具体换人失败对象（orca 不在 `systemd-journal`，`journalctl -u dao-agent-stall` 读不成）。

## 建议的最小改造

删掉「timer 在册 = 撞限流探测在干活」这一层。⑮ 对 `dao-agent-stall.service` 读上一轮 `Result`/`ExecMainStatus`：1 或 2 就红，并点名是「有真红没处理完」还是「没查成」。扫不到上一轮也红。`--failed` 里出现本仓 oneshot，别的闸也可以共用这一格，不必每条自己再写一遍「在册」。
