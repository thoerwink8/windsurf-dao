# 机制巡检：gw-remote-probe 仍是单调时钟，OnCalendar 闸看不见它

## 结论

今天刚为「只有单调时钟的 timer 停掉再起会进 active(elapsed)、永不再跑、无人报警」补了 OnCalendar 和两道闸，但写供应商健康表的 `gw-remote-probe.timer` 仍是 `OnBootSec` + `OnUnitActiveSec`、没有 `OnCalendar`；闸按 `dao|commander` 前缀和 `host/machine/systemd/` 扫，扫不到它。再停一次再起，探活会无声停摆，派工把过期健康表当 unknown 不拦。

## 证据

### 1. 机器上 `/etc/systemd/system/*.timer` 缺 OnCalendar 的只剩这一个

```
$ for f in /etc/systemd/system/*.timer; do
    if ! grep -q '^OnCalendar=' "$f"; then echo "NO OnCalendar: $f"; fi
  done
NO OnCalendar: /etc/systemd/system/gw-remote-probe.timer
```

活文件原文（2026-09-05 18:26 CST）：

```
# /etc/systemd/system/gw-remote-probe.timer
[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
Persistent=true
```

`systemctl show` 同轮：

```
NextElapseUSecRealtime=
NextElapseUSecMonotonic=2d 19h 57min 31.357492s
LastTriggerUSec=Sat 2026-09-05 18:18:15 CST
ActiveState=active
SubState=waiting
UnitFileState=enabled
TimersMonotonic={ OnUnitActiveUSec=30min ; next_elapse=2d 19h 57min 31.357492s }
```

此刻还在跑（`list-timers` NEXT 有墙钟时间，是单调时钟推出来的），不是已经进 elapsed。缺的是墙钟点位。这就是今天上午 `dao-agent-stall` 咬过的那种死态，只是对象换了。

健康表确实由它在写：`~/.dao/provider-health.json` mtime 与 LastTrigger 对齐（18:20 / 18:18），`updatedAt=2026-09-05T10:18:15.754Z`。INDEX 把它标成派工消费端（`host/machine/INDEX.md` 的 `~/.dao/provider-health.json` 行：本仓只读判可用性）。

### 2. 安装模板现在仍在写出这份缺 OnCalendar 的文件

`/home/orca/bin/gw-remote-probe.mjs` 193–219 行（`ls`：`-rwxr-xr-x orca orca`，2026-09-04 02:10）：

```
function installTimer() {
  ...
  const timer = `[Unit]
Description=每 ${PLAN.intervalMin} 分钟探一轮供应商健康

[Timer]
OnBootSec=5min
OnUnitActiveSec=${PLAN.intervalMin}min
Persistent=true
...
  writeFileSync("/etc/systemd/system/gw-remote-probe.timer", timer);
```

再跑一次 `--install`，会把「只有单调时钟」重新写进 `/etc`。本仓没有这份文件的副本（`find` 仓内 0 个 `*gw-remote*` / `*remote-probe*`）。INDEX 把它归 `ai-gateway-stack`（E 类，本仓不写装法）。

### 3. 今天补的闸按名字和目录把它排除在外

活体闸 `scripts/server-check.mjs:654`：

```
const names = [...String(list.stdout || '').matchAll(/\b((?:dao|commander)[a-z0-9-]*\.timer)\b/g)]
```

同轮 `systemctl list-timers --all --no-legend --no-pager` 用同一正则只吃到：

`dao-sync` / `commander-act` / `dao-agent-stall` / `commander-inventory` / `dao-board-gc` / `dao-close-issues` / `dao-patrol`

`gw-remote-probe.timer` 和 `release-train.timer` 都在表上，正则不要。⑱ 对 Realtime 空、Monotonic 有的组合本来就算绿（`server-check.mjs:662-666`），即便前缀改了，这个 timer 现在也过。

静态闸 `tests/timer-armed.test.js:48-57` 只扫 `host/machine/systemd/*.timer`；同文件 70–77 行把生成式补进 `commander-inventory.mjs` 的 `INSTALL_FILES()`。`gw-remote-probe` 两头都不在。`tests/unit-privilege.test.js`、⑳ `checkUnitDrift` 同一目录，同样看不见。

已有观察 `docs/observations/2026-09-05-systemd单元仓改未装.md` 列的是那七个 dao/commander 单元，处置把 OnCalendar 补进了指挥官模板并重装那七个。本条是同一死态落在闸补完之后仍覆盖不到的第三个生成源，不是那份报告的复述。

### 4. 探活停了之后，两道「会响」的下游都不响

指挥官盘点 `scripts/lib/commander-inventory.mjs:114-139` 的 `checkProbeJournal` 靠 `journalctl -u gw-remote-probe.service`。本轮以 orca 实测：

```
$ id
uid=999(orca) gid=988(orca) groups=988(orca)

$ journalctl -u gw-remote-probe.service -n 5 --no-pager -o cat
# exit 1
No journal files were opened due to insufficient permissions.
```

`orca` 不在 `systemd-journal` / `adm`。`sh()` 对 spawn 成功、退出码非 0 走 `unknown`（「journalctl 退出 1（可能没这个单元）」）。`runInventory` 对 unknown 不开单（文件头第 7–8 行）。所以「探针连红」这道闸在这台机器上从未查成。

派工侧 `scripts/lib/provider-health.mjs:5`：健康表过期（`now-updatedAt > 2×intervalMin`）或缺失 → unknown，**不拦**。探活停摆之后，工人和审官会继续往已经没人探的线路上派。

`checkProbeJournal` 本轮没有塞进一次完整 `commander.mjs inventory`（没验证它打印出来是不是 `? probe-red`），只核了对代码路径和 `journalctl` 的输入。按 118–119 行会进 unknown。

## 建议的最小改造

删掉「我们在乎的 timer = 名字以 dao/commander 开头，或文件躺在 `host/machine/systemd/`」这一层。

闸对 `/etc/systemd/system/` 里 ExecStart 指向本仓或 `/home/orca/bin/gw-remote-probe.mjs` 的每一个 timer 查 OnCalendar；扫出 0 个也红。`installTimer()` 那份模板加墙钟点位（错开已占用的 `:1/5`、`:2/15`、`:07`、`:11/20`、`:23`、`:41`），加完再装一次。journal 那道改读 `~/.dao/provider-health.json` 的 `updatedAt`（orca 写得进去、也读得出来），别再把「读不了 journal」写成「可能没这个单元」。
