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

---

## 处置（2026-09-05，帅位）

巡检这条报得准，而且抓的是**闸自己的盲点**，不是又一个漏装的单元。分两半处理：

**闸的那一半，本仓改了。** `server-check` ⑱ 原本只认 `dao*` / `commander*` 前缀——
**按名字前缀圈定扫描面，等于只查自己认识的东西**。现在扫机器上每一个 timer，
只滤掉发行版自带的那些（`systemd-` / `apt-` / `logrotate` 等，它们的点位归 apt/systemd 管）。
`tests/timer-armed.test.js` 加三条闸：故意违规样本（非 dao 前缀的 timer 死了必须点名报出）、
采集正则不许退回前缀圈定（直接读源码里那条正则，并拿真实 `list-timers` 输出行验它采得到）、
系统 timer 过滤器必须在（不滤会天天红成噪音）。突变回旧前缀 → 红 1 条。

**单元本身，不归本仓。** `gw-remote-probe.timer` 是 `ai-gateway-stack` 的周期探针
（`host/machine/INDEX.md` 第 47 行：`~/.dao/provider-health.json` 内容由它写、**本仓只读**）。
E 类归属下**本仓不写装法**，所以这里不给它加 `OnCalendar`，
要在 `ai-gateway-stack` 那边改。已在那边落单（见下）。

在它被修好之前，⑱ 会一直把它报成红——**这是对的**：它写的健康表我们要读，
它无声停摆时派工会把过期表当 unknown 而不拦。红着比看不见好。

status: done

---

## 处置（2026-09-05 19:30，帅位）

**报得对，已修，并且顺着它把闸本身修了两轮。**

### 1. 单元已加墙钟点位

`/etc/systemd/system/gw-remote-probe.timer` 加 `OnCalendar=*:09/30`（保留原单调时钟）。
点位避开 :00/:30 和已被占用的分钟（dao-sync :01/06、commander-act *:11/20、
close-issues :23、commander-inventory :41）。原文件备份 `gw-remote-probe.timer.bak-20260905`。
`daemon-reload` + `restart` 后 `list-timers` 有墙钟 NEXT。

### 2. 闸本身翻了两轮，都是**按名字**圈扫描面

本报告说的「闸按 `dao|commander` 前缀扫，扫不到它」属实。但改法先错了一版：

- 头一版白名单（只认 `dao*`/`commander*`）→ 漏掉本单元。
- 改成「扫全机 + 排掉想得到的发行版前缀」→ 当轮就把 Ubuntu 自带的
  `apport-autoreport.timer` / `ua-timer.timer` 判成红。它们本来就不该有墙钟点位。

**名字黑名单和名字白名单是同一个毛病**：都只覆盖「有人想得到的那些」，漏的永远是没想到的那个。
第二次用同一种办法出错，换路——改成结构判据 `isOurUnit(fragmentPath)`：
发行版单元在 `/usr/lib/systemd/system/`，我们（含别的仓）装的在 `/etc/systemd/system/`。
这条界线是 systemd 自己定的，不靠任何人维护名单。本单元正是这么被捞回扫描面的。

途中还踩一个：`systemctl show` 按**它自己的属性顺序**输出，不按命令行顺序，
按下标取值取到了时间戳当路径。改成按键名解析。好在「判不出归属」定的是 null→没查成
而不是 false→不归我管，所以它**大声停下**而不是静默漏掉一批 timer。

### 3. 顺带补上「活着但没有墙钟点位」

原闸只判「现在还有没有下一次」，而本单元报告时**是活的**——单调时钟推得出下一次。
等它死了再报，中间那段无声停摆照样发生。已经死了 和 下次重启必死，是同一缺陷的两个阶段，
现在都在 ⑱ 报。落地后立刻在服务器上把本单元判红并点名，修完转绿（20 通 / 0 红 / 0 没查成）。

### 4. 它暴露的更大一件事：这个落点没有仓在管

`/home/orca/bin/`（`gw-remote-probe.mjs`、`probe-health.mjs`）**不是 git 仓**，
`host/machine/INDEX.md` 里也没有它。也就是说这个单元和它跑的脚本**没有任何仓在管**——
所以它才会长期停在别人补 OnCalendar 那一轮之外，而且这次改完仍然只活在机器上，
下次重装机器又会退回去。

单元的墙钟点位是止住血，归属才是病。已另开跟进（见下）：要么把 `/home/orca/bin/` 收进
某个仓并登记进 INDEX.md，要么明确判它是「机器本地、不进仓」并写清重装时怎么恢复。

status: done
