---
status: new
---

# 机制巡检：#1146 自愈钟今早合进 master，机器没装；拿来验「装上了」的 ㉚ 此刻是绿

## 结论

今早 `d64652dd`（05:11 CST）把 `dao-skills-heal.{service,timer}` 合进 master：mirasim 随时可能把 `~/.claude/skills` 整目录劫走，所以要有一个每 5 分钟的自愈钟，不能等人想起跑 onboard。到本轮（约 7.3 小时）`/etc/systemd/system/` 里没有这两份文件，`list-timers` 0 行。装机文档和 server-ops 把 **dao-check ㉚** 写成这只钟的探活；㉚ 看的是 skill 链接在不在，**不问 timer 在不在**。本轮装载面是真目录 + 逐个链接，㉚ 会绿——验「钟装上了」的那一格，在钟根本不存在时也绿。

⑳（仓机单元一致）用本机活数据会红，点名就是这两份没装。它只挂在 `server-check.mjs`。`dao-check` / `land` / 指挥官盘点都不跑 ⑳。server-check 这台机器上没人跑，已报 `2026-09-06-server-check无心跳.md`，不另报。

## 证据

本轮 2026-09-12 12:25–12:30 CST，身份 `uid=999(orca)`，未用 sudo。`HEAD=40e547e9`，与 `origin/master` 相同。

### 1. 仓里有，机器上没有

```
$ git log -1 --format='%h %ci %s' d64652dd
d64652dd 2026-09-12 05:11:19 +0800 [cc] feat(onboard): skills 装载面合并式修复 + 自愈（#1146） (#1160)
```

`host/machine/systemd/dao-skills-heal.service` 文件头：`装法：sudo bash scripts/install-skills-heal.sh`；`验：systemctl list-timers 里 dao-skills-heal.timer 的 NEXT 必须是时间`。timer 是 `OnCalendar=*:03/5`。

```
$ ls /etc/systemd/system/dao-skills-heal.service /etc/systemd/system/dao-skills-heal.timer
ls: cannot access '/etc/systemd/system/dao-skills-heal.service': No such file or directory
ls: cannot access '/etc/systemd/system/dao-skills-heal.timer': No such file or directory

$ systemctl is-enabled dao-skills-heal.timer; systemctl is-active dao-skills-heal.timer
not-found
inactive

$ systemctl list-timers --all --no-legend --no-pager | grep skills-heal
# （0 行）
```

`scripts/install-skills-heal.sh:11-14` 非 root 直接 exit 1。`dao-sync` 只拉代码不装单元（09-05 定性过的根因，本条不展开）。orca 身份不能自己装。

### 2. 装载面此刻是好的，所以 ㉚ 会绿；㉚ 不看 timer

```
$ ls -ld /home/orca/.claude/skills
drwxr-xr-x  2 orca orca 4096 Sep 12 06:31 /home/orca/.claude/skills
```

不是符号链接。目录里是逐个链接：仓内 skill → `/srv/projects/windsurf-dao/host/skills/<名>`，`lark-*` / `eval` → `/home/orca/.mirasim/skills/...`。mtime 06:31，和 `systemd-networkd-wait-online` 的 `StateChangeTimestamp` 同一分钟，像是今早有人（或某次启动）跑过 onboard / skills-heal 手工接回。没验证是谁跑的。

`scripts/lib/skill-link-check.mjs:142-223`：发现面是真目录且仓内 skill 链接齐 → `green`；整目录链接才报「被劫」；发现面不存在才 SKIP「没装」。全文 0 处读 `dao-skills-heal.timer`。`scripts/dao-check.mjs:80-83、974-982` 的 ㉚ 就是调这一份。

本轮没跑完整 dao-check。按 ㉚ 源码和此刻 `~/.claude/skills` 的形态，这一格是绿，不是 SKIP，也不是被劫红。

### 3. 文档把 ㉚ 写成自愈钟的探活

`NEW-MACHINE.md:400-402`：

```
# skills 装载面自愈（#1146）：sudo bash scripts/install-skills-heal.sh（单元 host/machine/systemd/dao-skills-heal.*）
#   …
#   验：systemctl list-timers 里 dao-skills-heal.timer 的 NEXT 必须是时间；dao-check ㉚ 绿（被劫红、没装 SKIP）
```

`host/skills/server-ops/SKILL.md:14`：「探活：`systemctl list-timers` 里要有 `dao-skills-heal.timer`，**NEXT 不能是 `-`**。dao-check ㉚：没装 SKIP，被劫红。」

㉚ 的「没装」指的是本机没有 `~/.claude/skills` 这个目录，不是 timer 没装。两句话并在「探活」里，钟不在时 ㉚ 仍然可以绿。

`land.mjs:92` 只在有东西要 `push` 时才跑 dao-check。主树与远端一致时，㉚ 连这小时一次的 land 都不进。自愈钟的设计理由就是「不等 land、不等人跑 onboard」——那只钟现在不存在。

### 4. ⑳ 用本机数据会红，但那一格没人跑；就算跑了也被 drop-in 钉红

本轮直接调 `collectUnitDriftPairs` + `classifyUnitDrift`（`scripts/server-check.mjs:972-1024`），`etcDir=/etc/systemd/system`：

```
total 31
missing: dao-skills-heal.service, dao-skills-heal.timer
drifted: feishu-triage.service, gw-remote-probe.service, mirasim-server.service
state: red
detail: 3 个仓里和机器上不是同一份：feishu-triage.service、gw-remote-probe.service、mirasim-server.service；仓里有 2 个机器上根本没有：dao-skills-heal.service、dao-skills-heal.timer——这一格从没装上过。…
```

`grep classifyUnitDrift scripts/dao-check.mjs scripts/lib/commander-inventory.mjs`：0 命中。只在 `scripts/server-check.mjs:1316`。`/etc/systemd/system/*server-check*` 和 `~/.dao/server-check` 仍是 ENOENT（与 09-06 那条相同，不另报）。

漂移的三份里，`feishu-triage` 仓内正文与 `/etc` 正文 **相同**，差在 drop-in `feishu-triage.service.d/10-local.conf`（`--groups /home/orca/.mirasim/keys/feishu-groups.json`，文件头写明是 #806 要求真实 chat_id 不进仓）。`75c02a21`（今早 07:51）让 ⑳ 比「有效单元 = 正文 + drop-in」，于是这份故意的 drop-in 变成恒红。`mirasim-server.service.d` 的 managed-update 同形。没验证 gw-remote-probe 那条除注释外还有没有实质差（`diff` 只看到一行注释）。

所以 ⑳ 现在会红是真的，但红项里真没装和故意 drop-in 混在一起。它又没人跑。

### 5. 不是已报过的那几条

| 已有观察 | 管的是 | 本条不是 |
|---|---|---|
| `2026-09-06-四套单元未装-⑳把没装判没查成.md` | 当时 ⑳ 把没装判 unknown；那四套后来装了 | ⑳ 已经改成没装即红；本条是新单元，且验装的那一格（㉚）在钟不在时绿 |
| `2026-09-11-board-watch未装-⑮负向闸仍绿.md` | board-watch 当时没装，⑮ 改成旧钟不在即绿 | 不是同一只钟；board-watch 本轮 `list-timers` 有 NEXT=12:39，已在 |
| `2026-09-06-server-check无心跳.md` | server-check 没人跑 | 本条用它当「⑳ 红了也没人看」的背景，主病是自愈钟的探活指错对象 |

## 建议的最小改造

删掉「单独一只要 sudo 才装得上的自愈 timer，再用 ㉚ 绿当探活」这一层。

自愈脚本已经是 orca 能跑的 `node scripts/skills-heal.mjs`。挂到已经在跑的 `commander-inventory` 或 `dao-land` 上（都是 `User=orca`），不必再经 `/etc`。㉚ 继续只报被劫/缺链。探活就是「盘点/land 的 journal 里有 skills-heal 这一行」，不要把 skill 链接检查冒充 timer 心跳。
