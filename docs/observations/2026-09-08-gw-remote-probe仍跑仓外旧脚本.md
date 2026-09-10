处置：#1164

# 机制巡检：#967 收进仓了，机器还在跑 ~/bin；drop-in 仍撞 :07，⑳ 看不见 drop-in
> 处置：#1164 机器还在跑 ~/bin 探活——已开单跟机器收口

处置：#1164

## 结论

今天上午合进 master 的 #967（PR #1106，`324c06b4`）把供应商探活收进本仓：单元 `ExecStart` 指 `scripts/gw-remote-probe.mjs`，timer 自带 `OnCalendar=*:09/30`，装机脚本会删掉 09-05 止血留下的 `:07/30` drop-in，INDEX / NEW-MACHINE / 测试都把 `~/bin/gw-remote-probe.mjs` 标成「收进仓后不再是真相源」。这台机器 `/etc/systemd/system/gw-remote-probe.service` 仍是 2026-09-03 那份，`ExecStart` 还指 `/home/orca/bin/gw-remote-probe.mjs`（mtime 09-04，带会写出缺墙钟单元的 `--install`）。drop-in `*:07/30` 还在，和 `dao-board-gc` 的 `:07` 叠在一起。派工读的 `~/.dao/provider-health.json` 仍由这份仓外旧脚本在写。闸和测试锁的是仓内文件，所以仓里绿。

## 证据

本轮 2026-09-09 00:35 CST，身份 `uid=999(orca)`，未用 sudo。`HEAD=92110712`，与 `origin/master` 相同。

### 1. #967 把真相源搬进仓，机器没跟上

合入：

```
$ git log -1 --format='%h %ci %s' 324c06b4
324c06b4 2026-09-08 09:53:16 +0800 [cc] feat(probe): 收 gw-remote-probe 进仓——单元+脚本+INDEX（#967） (#1106)
```

到本轮已过约 14.7 小时。仓内单元原文（`host/machine/systemd/gw-remote-probe.service:34`）：

```
ExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/gw-remote-probe.mjs
```

机器上活单元全文（`/etc/systemd/system/gw-remote-probe.service`，Birth/Modify 2026-09-03 18:38）：

```
[Unit]
Description=网关供应商探活（流式 + 校验内容）：落健康表给编排层读，红了报总控群

[Service]
Type=oneshot
User=orca
ExecStart=/usr/bin/node /home/orca/bin/gw-remote-probe.mjs
```

```
$ md5sum /etc/systemd/system/gw-remote-probe.service host/machine/systemd/gw-remote-probe.service /home/orca/bin/gw-remote-probe.mjs scripts/gw-remote-probe.mjs
a8a1edc14df4a1462242eefec291ba66  /etc/systemd/system/gw-remote-probe.service
87b3538500b526e0f45edfbf52b1b347  host/machine/systemd/gw-remote-probe.service
76c9fd80dcd15f68bb8b4035e542c94e  /home/orca/bin/gw-remote-probe.mjs
4d27c448b7bdf07d54b4abcf0b6f217a  scripts/gw-remote-probe.mjs

$ systemctl show gw-remote-probe.service -p ExecStart,FragmentPath,Result,ExecMainStatus,ExecMainStartTimestamp
ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /home/orca/bin/gw-remote-probe.mjs ; ... start_time=[Wed 2026-09-09 00:09:00 CST] ; ... status=0 }
FragmentPath=/etc/systemd/system/gw-remote-probe.service
Result=success
ExecMainStatus=0
```

`~/bin` 那份仍有 `installTimer()`（193–222 行）：`writeFileSync("/etc/systemd/system/gw-remote-probe.service"…)`，写出的 timer **没有** `OnCalendar`。仓内脚本把 `--install` 改成 exit 1（`scripts/gw-remote-probe.mjs:39-42`）。有人按旧习惯跑 `node ~/bin/gw-remote-probe.mjs --install`，会把今天仓里那份墙钟单元盖掉——本轮没跑这条（硬边界不许改单元），没验证它此刻是否还能写 `/etc`。

INDEX 已经把这句话写成事实（`host/machine/INDEX.md:63`）：

> `~/bin/gw-remote-probe.mjs` … 仓内真相源 `scripts/gw-remote-probe.mjs`；**systemd ExecStart 走仓内脚本**。

NEW-MACHINE.md:386-389 同一句，并写「不要再跑 `node ~/bin/gw-remote-probe.mjs --install`」。测试锁的也是仓内文件（`tests/gw-remote-probe.test.js:213` `assert.match(s, /scripts\/gw-remote-probe\.mjs/)`），不打开 `/etc`。

### 2. 09-05 的 drop-in 还在，活日历是 :07 **和** :09

装机脚本自己写着要删它（`scripts/install-gw-remote-probe.sh:21-24`）：

```
# 2026-09-05 止血时加过 drop-in（OnCalendar=*:07/30，撞 dao-board-gc）。
# 仓内单元已经带 *:09/30，drop-in 留下会盖掉仓里的点位，⑳ 也会报漂移。
rm -f /etc/systemd/system/gw-remote-probe.timer.d/oncalendar.conf
```

本轮：

```
$ ls -la /etc/systemd/system/gw-remote-probe.timer.d/oncalendar.conf
-rw-r--r-- 1 root root 444 Sep  5 19:14 /etc/systemd/system/gw-remote-probe.timer.d/oncalendar.conf

$ cat /etc/systemd/system/gw-remote-probe.timer.d/oncalendar.conf
[Timer]
OnCalendar=*:07/30

$ systemctl show gw-remote-probe.timer -p TimersCalendar,DropInPaths
TimersCalendar={ OnCalendar=*-*-* *:07/30:00 ; next_elapse=Wed 2026-09-09 00:37:00 CST }
TimersCalendar={ OnCalendar=*-*-* *:09/30:00 ; next_elapse=Wed 2026-09-09 00:39:00 CST }
DropInPaths=/etc/systemd/system/gw-remote-probe.timer.d/oncalendar.conf
```

仓内 `dao-board-gc.timer` / 机器上同文件都是 `OnCalendar=*:07:00`。drop-in 的 `:07/30` 就是装机脚本注释里那次碰撞。本轮 `list-timers`：probe NEXT=`00:37`（drop-in），board-gc NEXT=`01:07:46`。

⑳ 的取数（`scripts/server-check.mjs:959-964` `checkUnitDrift`）只 `readFileSync('/etc/systemd/system/' + name)`，**不读** `.d/`。drop-in 单独留下时，即便有人把 timer 正文拷成和仓里一样，⑳ 也会绿，活日历仍是 `:07/30`。装机脚本那句「⑳ 也会报漂移」对 drop-in 这一层不成立。

本轮用 ⑳ 自己的纯函数对这台机器实跑：`state=red`，detail 点名 `gw-remote-probe.service`、`gw-remote-probe.timer`（外加 close-issues / board-gc / sync / feishu-triage 的凭据行漂移，以及 land / gh-events / miraquota-contabo 没装）。server-check 在这台机器上没有心跳（已报 `2026-09-06-server-check无心跳.md`），`ls /home/orca/.dao/server-check` 仍是 `No such file or directory`——⑳ 现在会红，但没人跑。

### 3. 派工读的健康表仍是旧脚本在写

```
$ ls -la /home/orca/.dao/provider-health.json
-rw-r--r-- 1 orca orca 3255 Sep  9 00:10 /home/orca/.dao/provider-health.json
```

`updatedAt=2026-09-08T16:09:00.876Z`，对齐最近一次 `ExecMainStartTimestamp=00:09:00 CST`。`direct:codex@pqapi/responses` 本轮 `state=red`，`strikes=9`，`why=200 但零内容（空流/只有心跳，30414ms）`，`lastGreenAt=2026-09-08T14:07:00.588Z`。消费端 `scripts/lib/provider-health.mjs:6-7`：健康红只后置不拦。今天合入的路由（`a8f243b2`）把审官 gpt/codex 的 `mode` 改成 `direct`，`probeTargetOf`（`scripts/lib/provider-probe.mjs:70-71`）把 `provider==='gpt'` 一律映射到这个 key。旧脚本的 `probe.direct.model` 钉的是策略里的 `gpt-5.6-sol`（`/home/orca/bin/gateway-policy.json`）；本机 `~/.codex/config.toml` 本轮是 `model = "gpt-5.6-luna"`、`base_url = "https://api.pqapi.shop/v1"`（2026-09-08 17:48 改过）。健康表红的是 sol 那一针，不是 luna——本轮没拿仓内脚本重探（硬边界不许起付费探针），新旧脚本会不会把 luna 探成另一态，没验证。

### 4. 不是已经报过的那几条

| 已有观察 | 管的是 | 本条不是 |
|---|---|---|
| `2026-09-05-gw-remote-probe单调时钟.md` | 当时这个单元**不在本仓**、只有单调时钟；处置加了 `:07/30` drop-in，并写「归属才是病」 | #967 已经把归属收进本仓；病变成「收了仓、机器还跑旧路径」，drop-in 成了该卸没卸的残留 |
| `2026-09-05-systemd单元仓改未装.md` | dao-agent-stall / 指挥官缺 OnCalendar | 对象是探活的 ExecStart 仍指仓外脚本 |
| `2026-09-06-四套单元未装-⑳把没装判没查成.md` | 仓里有、`/etc` 没有 | 本单元 `/etc` 有，跑的是另一份 |
| `2026-09-08-board-gc单元仍钉orca-serve.md` | board-gc 正文 After= | 本条是 probe 的 ExecStart / drop-in |
| `2026-09-06-server-check无心跳.md` | 闸没人跑 | ���条对象是探活没切仓；无心跳只解释「⑳ 红了也没人看」 |

`dao-sync` 只拉代码、不装单元（已定性）。#967 的装法是 `sudo bash scripts/install-gw-remote-probe.sh`，合入后没人跑。

## 建议的最小改造

删掉「合进仓 = 机器已切仓内脚本」这一层。装机（人跑 `sudo bash scripts/install-gw-remote-probe.sh`）会拷单元、删 drop-in、把 ExecStart 切到 `scripts/gw-remote-probe.mjs`。⑳ 的取数改成比 `systemctl cat` 的有效单元（含 drop-in），不要只读 FragmentPath 正文——少这一处，拷了 timer、忘了删 `.d/`，日历仍撞 `:07` 而闸绿。测试打开活 `ExecStart` 或至少锁「仓内单元不得再写 `/home/orca/bin/gw-remote-probe.mjs`」还不够，要有一条活体样本：机器上的 ExecStart 不是仓内脚本就红。`~/bin` 那份 `--install` 在装机切走之前仍是活地雷。

本轮不动手。改 `/etc` 要 root，越巡检边界。
