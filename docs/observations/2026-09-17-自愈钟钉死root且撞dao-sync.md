---
status: new
---

# 机制巡检：#1226 合进 master 23 小时了，活着的 root 自愈钟仍钉 `DAO_SKILL_HOMES=/root`，OnCalendar 仍是会跟 dao-sync 撞点的 `*:06/5`

## 结论

#1226（`c6936bcf3`，昨天 01:16）要把 root 那只自愈钟从「只修 `/root`」改成「passwd 枚举每个有 `.claude/` 的家」，并把 OnCalendar 从 `*:06/5` 改成 `*:00/5`——因为 `*:06/5` 和 dao-sync 的 `*:1/5` 在 systemd 回绕后是同一串分钟。合进去的还有一道测试，专门锁「heal-root 与任一现有点位不相交」。本轮现场：`/etc` 那份还是 09-13 19:07 的旧单元，`Environment=DAO_SKILL_HOMES=/root`，`OnCalendar=*:06/5`。`systemctl list-timers` 里 `dao-skills-heal-root.timer` 和 `dao-sync.timer` 上一拍都是 `00:26:04`、下一拍都是 `00:31:00`。仓内 `calendarOverlap('*:06/5','*:1/5')` 命中 288 个点（24h 全重叠）；`*:00/5` 对 `*:1/5` 是 0。那道测试只读 `host/machine/systemd/`，repo 文件一改就绿。`calendarOverlap` 全仓只有测试在调，dao-check / 指挥官盘点 / land 0 处拿活 `/etc` 展开。⑳ 本轮把 `dao-skills-heal-root.{service,timer}` 算进 7 个漂移，但它挂在没人跑的 server-check 上，而且早就被故意 drop-in 钉成永红。

## 证据

本轮 2026-09-17 16:24–16:31 UTC（= 2026-09-18 00:24–00:31 CST），身份 `uid=999(orca)`，未用 sudo。`HEAD=498a4f816`（`[grok] fix(审官): 换厂无合法目标时退回原席位重试（#1354）`），与 `origin/master` 相同。本进程：`GROK_AGENT=1`，父进程 `mirasim-server`（`GH_CONFIG_DIR=/var/empty`）。未改 `docs/observations/` 以外的文件。未开单、未评 PR、未启停单元。

### 1. #1226 已经在 master；机器上仍是它要删的那两行

```
$ git log -1 --format='%h %ci %s' c6936bcf3
c6936bcf3 2026-09-17 01:16:37 +0800 [cc] 装载面自愈守全部家目录：root 那份不再没人接（#1146 的洞） (#1226)
```

仓内 `host/machine/systemd/dao-skills-heal-root.service:10-11` 原文：

```
只能以 root 枚举并修 **本机每个有 `.claude/` 的家**（passwd 清单，不写死用户名、不钉 DAO_SKILL_HOMES）。
```

同文件 `:30`：`# 不要钉 DAO_SKILL_HOMES=/root：钉死就扫不到第三个家。`

仓内 timer `:6-8` 原文：

```
# 挂 *:00/5：每小时 :00/:05/:10…，与 dao-sync 的 *:1/5（:01/:06/:11…）不是同一串。
# 第一版写成 *:06/5，字符串跟 *:1/5 不同，systemd 回绕后展开却是同一组分钟
```

同文件 `:19`：`OnCalendar=*:00/5`。

活 `/etc/systemd/system/dao-skills-heal-root.service` mtime `2026-09-13 19:07`，`:29` 原文：

```
Environment=DAO_SKILL_HOMES=/root
```

同文件 `:42`：`ReadWritePaths=/root/.claude`（仓内是 `/root/.claude /home`）。活 timer `:18`：`OnCalendar=*:06/5`。

`scripts/install-skills-heal.sh:73-74` 会把仓内这两份装到 `/etc`。本轮没人跑过——`/etc` 与 `/usr/local/lib/dao-skills-heal/` 的 mtime 都停在 `2026-09-13 19:07`。

`/usr/local` 副本 md5 对不上仓内：

```
32607db5…  /usr/local/lib/dao-skills-heal/skills-heal.mjs     2026-09-13 19:07
7b3280a0…  scripts/skills-heal.mjs
56cd8965…  /usr/local/lib/dao-skills-heal/lib/skill-homes.mjs  2026-09-13 19:07
9164765a…  scripts/lib/skill-homes.mjs
```

活副本 `skill-homes.mjs:21` 仍把「有 `.mirasim/`」算进装载面；仓内 `:25-26` 已经改成只认 `.claude/`。活单元还钉了 `DAO_SKILL_HOMES=/root`，脚本就算想枚举也走不到 passwd。

没验证：root 那只钟 00:26 这一拍对 `/root/.claude/skills` 实际做了什么（orca 读不了 `/root`，也读不了 journal）。按单元正文，它只能写 `/root/.claude`，第三个家 systemd 也会挡。

### 2. 撞点不是推出来的，是本轮 list-timers 的同一秒

`host/machine/systemd/dao-sync.timer` 与 `/etc` 那份 `diff` 空，都是 `OnCalendar=*:1/5`。

```
$ systemd-analyze calendar '*:06/5' --iterations=2
    Next elapse: Fri 2026-09-18 00:31:00 CST
$ systemd-analyze calendar '*:1/5' --iterations=2
    Next elapse: Fri 2026-09-18 00:31:00 CST
$ systemd-analyze calendar '*:00/5' --iterations=2
    Next elapse: Fri 2026-09-18 00:30:00 CST
```

`systemctl list-timers` 本轮原文（同一行宽）：

```
Fri 2026-09-18 00:31:00 CST  …  Fri 2026-09-18 00:26:04 CST  …  dao-skills-heal-root.timer  dao-skills-heal-root.service
Fri 2026-09-18 00:31:00 CST  …  Fri 2026-09-18 00:26:04 CST  …  dao-sync.timer              dao-sync.service
```

`systemctl show`：两只 service 的 `ExecMainStartTimestamp` 都是 `Fri 2026-09-18 00:26:04 CST`。本轮直接调仓内纯函数（不出网）：

```
calendarOverlap('*:06/5', '*:1/5') → { ok: true, hitsCount: 288, firstHits: ["00:06","00:11","00:16","00:21","00:26","00:31","00:36","00:41"] }
calendarOverlap('*:00/5', '*:1/5') → { ok: true, hitsCount: 0 }
```

288 = 24 小时 × 12 个分钟点，两条日历展开后是同一集合。仓内改成 `*:00/5` 之后相交为空——测试锁的就是这个。活机器上跑的仍是相交为满的那一份。

### 3. 闸绿的那一层：只扫仓内文件；会跑的检查 0 处展开活日历

`tests/timer-armed.test.js:336-350` 故意样本就是 `*:06/5` ≡ `*:1/5`。同文件 `:379-411`「仓内 + 生成式 timer 都能展开；heal-root 与任一现有点位不相交」读的是：

```
path.join(__dirname, '..', 'host', 'machine', 'systemd')
M.INSTALL_FILES()   // commander 生成式
```

0 处读 `/etc/systemd/system`。repo 里 heal-root 已经是 `*:00/5`，这一格本轮对着仓内文件必绿。

`scripts/lib/on-calendar.mjs` 的 `calendarOverlap` 全仓调用点（`scripts/` + `tests/`）：

- `scripts/lib/on-calendar.mjs:102` 定义
- `tests/timer-armed.test.js` 三处

`scripts/dao-check.mjs` 全文 0 处 `calendarOverlap`。它跑 `tests/timer-armed.test.js`，测的仍是仓内文件。`scripts/lib/commander-inventory.mjs` / `scripts/land.mjs` 0 处。

⑱（`scripts/server-check.mjs` 的 `checkTimerArmed`）问的是活 timer 有没有 NEXT，不问两条日历展开后相不相交。本轮两只 NEXT 都是时间，这一格按「有下一次」会绿——撞点的两只都有下一次。

⑳ 本轮直接调 `collectUnitDriftPairs` + `classifyUnitDrift`：

```
state: red
pairCount: 33
drifted: dao-execution-usage-export.service、dao-execution-usage.service、
         dao-skills-heal-root.service、dao-skills-heal-root.timer、
         feishu-triage.service、gw-remote-probe.service、mirasim-server.service
```

heal-root 两份已经在漂移名单里。⑳ 挂在 `scripts/server-check.mjs:1430` CHECKS 第 ⑳ 格；`dao-check` / 盘点 / land 0 处调用。server-check 这台机器上没人跑（09-06 已报）。后三个漂移是故意 drop-in / 一句注释（09-13 已报 ⑳ 被钉成永红）。用量那两份 90 秒墙钟是 #1231 没装（09-16 已报）。本条对象不是 ⑳ 永红本身，是 **#1226 专门为撞点写的那道测试对着仓内文件绿，活 `/etc` 仍是它要拦的那份 `*:06/5`**。

### 4. 不是已报过的那几条

| 已有观察 | 管的是 | 本条不是 |
|---|---|---|
| `2026-09-14-1226处置进master代码没进.md`（处置：#1051） | 当时 PR 仍 OPEN，master 没有 `dao-skills-heal-root.*`，机器上跑的是未合入分支 | `c6936bcf3` **已经合进 origin/master**（昨天 01:16）。缺的是合了之后再跑一次已经写好的 `install-skills-heal.sh` |
| `2026-09-12-skills-heal自愈钟没装.md`（处置：#1226） | 当时 root 那只钟根本没装 | 现在 `list-timers` 有 NEXT，钟在跑。跑的是钉死 `/root`、日历撞 dao-sync 的旧副本 |
| `2026-09-13-单元一致闸被故意drop-in钉红.md` | ⑳ 被飞书 / mirasim 升级器 drop-in 钉成永红 | 本条是 **撞点闸只扫仓内文件**。⑳ 已经把 heal-root 算进漂移，但没人跑、永红里也看不出「这是会跟 dao-sync 同一秒响的那一只」 |
| `2026-09-16-用量副本闸挂没人跑的检查.md` | #1231 的副本闸挂 server-check 第 24 格 | 对象是用量。本条是 **#1226 的日历闸挂在只读 repo 的测试上** |

## 建议的最小改造

删掉「仓内 timer 文件改成 `*:00/5` + 测试锁仓内文件不相交 = 活钟已经错开」这一层。

`dao-sync` 快进到 `host/machine/systemd/dao-skills-heal-root.*` 或 `scripts/lib/skill-homes.mjs` 时，跑一次已经写好的 `install-skills-heal.sh`。装完活 timer 的 OnCalendar 不是 `*:06/5`、活 service 没有 `DAO_SKILL_HOMES=/root`、`TimeoutStartUSec` 那档不是本条对象。撞点闸拿 `/etc` 里正在 enabled 的 `.timer` 展开，和仓内文件相交为满就红；不要再加一条只扫 `host/machine/systemd` 的测试把「不相交」锁成绿——那正是本轮测绿、两只钟同一秒响的那一层。
