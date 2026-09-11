# 机制巡检：#818 看板超时告警从未装上，⑮ 改成「旧钟不在即绿」

## 结论

昨天合进 master 的看板 v0（#818 / PR #1108）把「工人墙钟超时 → 总控群报一次」做成独立 timer `dao-board-watch`，跟已经并进指挥官的盘面推进量不是同一把尺。这台机器 `/etc/systemd/system/` 里没有这两份文件，`list-timers` 0 行，账本 `~/.dao/board-watch.json` 从未出现过。指挥官也不调 `board-watch.mjs`。⑮ 在把 progress-watch 并进 commander-act 之后改成了负向闸（旧钟还在才红、不在就绿），测试把「独立钟不在 → ok」锁死；本轮 ⑮ 实跑就是绿。⑳ 看见了没装，判成没查成。于是超时告警这条腿从合进仓到现在没响过一次，检查还绿。

## 证据

本轮 2026-09-11 00:34 CST，身份 `uid=999(orca)`，未用 sudo。`HEAD=ed0e0e14`，与 `origin/master` 相同。

### 1. 仓里有，机器上没有；指挥官也不跑它

合入：

```
$ git log -1 --format='%h %ci %s' 3eb12c06
3eb12c06 2026-09-10 21:43:52 +0800 [cc] feat(board): 看板 v0——一张表 + 超时告警发总控群（#818） (#1108)
```

到本轮已过约 2.8 小时。仓内 `host/machine/systemd/dao-board-watch.{service,timer}` 在，装法写在 service 文件头和 `NEW-MACHINE.md:384-385`（`sudo bash scripts/install-board-watch.sh`，验 `NEXT` 必须是时间）。

```
$ ls /etc/systemd/system/dao-board-watch.service /etc/systemd/system/dao-board-watch.timer
ls: cannot access '/etc/systemd/system/dao-board-watch.service': No such file or directory
ls: cannot access '/etc/systemd/system/dao-board-watch.timer': No such file or directory

$ systemctl list-timers --all --no-legend --no-pager | grep board-watch
# （0 行）

$ ls /home/orca/.dao/board-watch.json
ls: cannot access '/home/orca/.dao/board-watch.json': No such file or directory

$ grep -n board-watch scripts/commander.mjs
# （0 行）
```

`scripts/server-sync.sh` 只 `try-restart feishu-triage`，不装单元——09-06 定性过的根因，这次落在新钟上。

### 2. 本轮 dry-run 已经扫到该发的 digest，生产没人调

`--dry-run` 不调 `hub-say`、不写账本（`board-watch.mjs:155-157, 180-185`）。本轮：

```
$ node scripts/board-watch.mjs --dry-run --json
{
  "ok": true,
  "scanned": true,
  "sent": [
    "digest:2026-09-10T16:31:14.394Z"
  ],
  "skipped": 41,
  "error": null
}
```

`sent` 走 digest 是因为超时行超过 `alertBatchMax`（默认 3，`scripts/lib/board-v0.mjs:23`）。跑完账本仍不在——确认没写出、没发到群。阈值 `docs/dispatch-policy.json` 的 `board.workerWallHoursMax` 是 4 小时。

### 3. ⑮ 改成负向闸，测试锁「独立钟不在 → 绿」

`scripts/server-check.mjs:410-459` `classifyStallWatchTimer`：list-timers / `/etc` 里出现 `dao-progress-watch` / `dao-nudge-stalled` / `dao-agent-stall` / 垫片脚本 → 红；指挥官源码有 `runProgressWatch(` 且旧钟不在 → ok。全文 0 处 `board-watch`。`dao-check.mjs` 同样 0 处。

本轮用 ⑮ 自己的纯函数 + 本机 `systemctl list-timers --all` 实跑：

```
{
  "state": "ok",
  "detail": "盘面推进量已并进指挥官，独立 progress-watch / 推一把 / 屏面指纹钟已退役",
  "folded": true,
  "leftover": [],
  "hasBoardWatch": false
}
```

测试把这一格锁成绿：`tests/server-check.test.js:217-223`「已并进、独立钟不在、退役件不在 → ok」。`tests/board-v0.test.js:610-625` 只锁仓内 timer 有 `OnCalendar=*:19/20`、install 脚本不 chmod 仓内文件，不问机器上装没装。

⑱ 扫 `/etc` 里已有的 timer 和 `list-timers`（`server-check.mjs:587-603`）。没装进 `/etc` 的，⑱ 看不见。

### 4. ⑳ 看见了没装，判成没查成

本轮 `classifyUnitDrift` 对 `host/machine/systemd/` 26 个单元实跑：

```
{
  "state": "unknown",
  "detail": "5 个单元没比成：dao-board-watch.service(机器上没装)、dao-board-watch.timer(机器上没装)、dao-execution-usage-export.service(机器上没装)、dao-execution-usage.service(机器上没装)、dao-execution-usage.timer(机器上没装)——没查成，不是「一致」",
  "pairs": 26
}
```

判据 `scripts/server-check.mjs:942-943`：`live == null` → unknown。测试 `tests/server-check.test.js:624-625` 仍锁「机器上压根没装 → unknown，不是 red」。server-check 心跳目录 `~/.dao/server-check/` 本轮仍不存在（已报，不另开）。

同一次 ⑳ 扫出来的另外三份是 #1175 的 `dao-execution-usage*`：`/usr/local/lib/dao-execution-usage` 与 `/var/lib/dao-execution-usage` 均 ENOENT，用量采集同样从未上机。本条不把那一套展开成第二件事——根因同是「合进仓 ≠ 装上机器」，只是没有 ⑮ 这种负向闸把它 Greening。

已有观察 `2026-09-06-四套单元未装-⑳把没装判没查成.md` 管的是当时那四套（其中 `dao-progress-watch` 后来按设计并进了指挥官，`NEW-MACHINE.md:378` 写明不要再装）。本条对象是 09-10 新合的墙钟告警：⑮ 已经改成「旧钟必须不在」，新钟缺席被同一把闸读成健康。不是那份的复述。

## 建议的最小改造

删掉「看板超时告警要另装一只钟」这一层。指挥官 act 每 20 分钟已经醒一次、已经跑 `runProgressWatch`；墙钟告警跟推进量不是同一把尺，但可以是同一次唤醒里的第二刀。并进去之后删 `dao-board-watch.{service,timer}` 和 `install-board-watch.sh`，⑮ 继续守「独立钟不在」。没有独立单元，就没有「合了仓忘了装」。

若墙钟告警必须独立跑：⑳ 把「仓里有、机器上没装」从 unknown 改成 red，并给 `dao-board-watch.timer` 加一条正向在册闸（NEXT 不是 `-`）。现在这把负向 ⑮ 守不住新钟。
