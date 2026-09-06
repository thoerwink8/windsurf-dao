# 机制巡检：orca 已退役，board-gc 与 stall 仍拿它当盘面真相源，每轮 exit 2

## 结论

`orca-serve` 已 disabled、workspaces 下 0 棵在途树，派工走 mirasim；但 `dao-board-gc` 和 `dao-agent-stall` 第一句仍是 `orca worktree/terminal list`。运行时不在，两条 oneshot 每轮 exit 2，进 `--failed`。stall 里后半段已经会采 mirasim 会话，却永远走不到——入口被退役对象挡死。⑮ 只问 timer 在册，所以仍绿。

## 证据

本轮 2026-09-06 19:57 CST，身份 `uid=999(orca)`，未用 sudo。`HEAD=c8bc759b`，与 `origin/master` 相同。

### 1. orca 运行时已停，CLI 回 runtime_unavailable

```
$ systemctl is-enabled orca-serve.service
disabled
$ systemctl is-active orca-serve.service
inactive

$ find /home/orca/orca/workspaces/windsurf-dao -mindepth 1 -maxdepth 1 ! -name '.*' | wc -l
0

$ git worktree list | wc -l
49

$ orca worktree list --json
{
  "id": "local",
  "ok": false,
  "error": {
    "code": "runtime_unavailable",
    "message": "Could not read Orca runtime metadata at /home/orca/.config/orca/orca-runtime.json. Start the Orca app first."
  },
  ...
}
# exit 1
```

`docs/initiatives.json` 的 `orca-retire.done_when` 写「0 棵树 且 orca-serve 已 disabled」——这两条本轮已成立。西瓜清单下一步是删代码，不是把服务拉回来。已有观察 `2026-09-06-orca正在退役别当故障修.md` 处置栏写「运行时退役已完成（树 0 / 服务 disabled）」。

### 2. 两条活单元本轮都在 --failed，退出码是「没查成」

```
$ systemctl --failed --no-legend --no-pager
● dao-agent-stall.service loaded failed failed windsurf-dao agent stall / 429 watch (issue #833)
● dao-board-gc.service    loaded failed failed windsurf-dao board GC (zombie cards)

$ systemctl show dao-board-gc.service -p Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,ActiveState
Result=exit-code
ExecMainStatus=2
ExecMainStartTimestamp=Sun 2026-09-06 19:08:26 CST
ExecMainExitTimestamp=Sun 2026-09-06 19:08:27 CST
ActiveState=failed

$ systemctl show dao-agent-stall.service -p Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,ActiveState
Result=exit-code
ExecMainStatus=2
ExecMainStartTimestamp=Sun 2026-09-06 19:32:01 CST
ExecMainExitTimestamp=Sun 2026-09-06 19:32:04 CST
ActiveState=failed
```

`dao-board-gc.service` 写了 `SuccessExitStatus=0 1`（`host/machine/systemd/dao-board-gc.service:29`），2 是故意的失败。`dao-agent-stall.service` 没有 `SuccessExitStatus`，2 同样是失败。timer 都还在、下一次也排了：

```
Sun 2026-09-06 19:47:00 CST  dao-agent-stall.timer
Sun 2026-09-06 20:08:29 CST  dao-board-gc.timer
```

### 3. 本轮当场复跑，失败点就是 orca

```
$ timeout 25 node scripts/board-gc.mjs
盘面没查成：result.worktrees 不是数组
# exit 2

$ timeout 25 node scripts/agent-stall-watch.mjs --dry-run
⚠️ 撞限流探测没查成：terminal list 读不到（Could not read Orca runtime metadata at /home/orca/.config/orca/orca-runtime.json. Start the Orca app first.）
# exit 2
```

board-gc 入口（`scripts/board-gc.mjs:207-212`）：

```
const ps = orcaJson(['worktree', 'list']);
if (!ps.ok) { console.error(`盘面没查成：${ps.error}`); process.exit(2); }
const worktrees = ps.json?.result?.worktrees;
if (!Array.isArray(worktrees)) { console.error('盘面没查成：result.worktrees 不是数组'); process.exit(2); }
```

`orcaJson`（同文件 49-58 行）只看「stdout 里有没有 `{`」：解析成功就 `{ ok: true, json }`，**不读 `json.ok`**。orca 回的是 `ok:false` + 没有 `result.worktrees`，于是走进「不是数组」而不是 runtime_unavailable。本轮没验证改 `orcaJson` 会不会让错误信息变准——那是次要的；入口被挡死是已经验证的。

stall 入口（`scripts/agent-stall-watch.mjs:324-327`）：

```
const listed = orca(['terminal', 'list', '--json']);
if (!listed.ok) {
  say(`⚠️ 撞限流探测没查成：terminal list 读不到（${listed.error}）`);
  process.exit(2);
}
```

同文件 296-317 行已经有 `mirasimSessions()`，在 366 行才 `liveSessions.push(...mirasimSessions(driverNotes))`。本轮没跑到那一行：324 行就 `process.exit(2)`。mirasim 采样面写了、装了，被 orca 那一刀切掉。

两条单元的 `After=` 仍写 `orca-serve.service`（`host/machine/systemd/dao-board-gc.service:19`、`dao-agent-stall.service:24`；`/etc` 里活文件同样）。没有 `Requires=`，所以 orca-serve 停了 timer 照样触发——只是每次都失败。`dao-progress-watch.service:20` 也写了同一行 After，但那套单元机器上没装（已报 `2026-09-06-四套单元未装-⑳把没装判没查成.md`），本条不重复。

### 4. 指挥官态势里 orca 节每轮 unscanned；progress-watch 就算装上也过不了

最新态势 `/home/orca/.dao/commander/situation-2026-09-06T11-51-08-876Z.json`：

```
orca.scanned = false
orca.error = worktree ps 没查成：Could not read Orca runtime metadata at /home/orca/.config/orca/orca-runtime.json. Start the Orca app first.
```

`scripts/lib/progress-detect.mjs:98-99`：`orca.scanned !== true` → 整份快照 unscanned。progress-watch 读的就是这些 situation 文件。commander 已把派工/返工的 `ACTION_NEEDS` 里的 orca 摘掉（`scripts/lib/commander-core.mjs:275-286`），所以 act 还在产动作；看门狗那一层没有摘。

### 5. ⑮ 仍然只问 timer 在册

`scripts/server-check.mjs:571-614` 的 `classifyAgentStallWatch`：timer 名字在 `list-timers` 文本里、垫片不在、NEXT 不是横杠 → OK。`Result` / `ExecMainStatus` / `--failed` 一个都不读。本轮没跑完整 `server-check.mjs`（没验证它打印出来是不是绿）；按 571-614 行，⑮ 会绿。server-check 在这台机器上没有心跳（已报 `2026-09-06-server-check无心跳.md`），绿了也没人看。

`scripts/lib/commander-inventory.mjs` 与 `scripts/dao-check.mjs` 全文搜 `is-failed|--failed`：0 命中（本轮 `rg`）。

已有观察 `2026-09-05-stall单元failed闸仍绿.md` 报的是 stall 当时 exit 1（有真红没处理完）而 ⑮ 仍绿。处置收进 #1051。本条是同一把闸的另一面：exit 2 的原因已经从「屏面读不成」变成「盘面真相源整台机器都不在了」，对象还多了一个 board-gc。不是那份的复述。

## 建议的最小改造

删掉「盘面 = orca worktree/terminal list」这一层。

board-gc 和 stall 的盘面改问已经在跑的那份（`git worktree list` + mirasim 会话表，stall 后半段已经会采）。orca CLI 回 `runtime_unavailable` 不当成「没查成就整轮退出」——运行时退役后这是稳态，不是瞬时故障。⑮ 对 `--failed` 里的本仓 oneshot 读上一轮 `ExecMainStatus`：2 就红，并点名是「没查成」。`After=orca-serve.service` 随退役一起删，否则注释还在说「PATH 必须带 ~/.local/bin，否则找不到 orca」。
