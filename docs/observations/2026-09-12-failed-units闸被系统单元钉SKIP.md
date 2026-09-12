---
status: new
---

# 机制巡检：昨天加的「--failed 要红」闸，在这台机器上整格 SKIP，拦不住它要拦的那种失败

## 结论

`1246c505`（2026-09-11 20:44）给 dao-check 加了「本仓单元挂 `systemctl --failed` 要红」，就是为了接住 `2026-09-09-凭据闸把额度采样的git推送掐死.md` 里那种「timer 还在响、oneshot 每轮非零、五天没人看见」。本轮用同一份纯函数喂这台机器此刻的 `--failed` 表，结果是 **unknown → dao-check SKIP → 退出码 0**。叠了两层：

1. 取数只读 `/etc/systemd/system/<名>` 和仓内模板。发行版单元 `systemd-networkd-wait-online.service` 的文件在 `/usr/lib/systemd/system/`，读不到就进 `unjudged`，整格 unknown。
2. 就算读到了，判据把「配对 timer 有过 LastTrigger」写成 **green / flaky**。所有带着 timer、已经响过的 oneshot——包括当初那五天的 `miraquota-contabo`——都不红。测试把这一档锁死了。

于是这格装了、测了、每次 land 推送前都会跑，但在这台机器上既不红也不挡。

## 证据

本轮 2026-09-12 12:25–12:30 CST，身份 `uid=999(orca)`，未用 sudo。`HEAD=40e547e9`，与 `origin/master` 相同。

### 1. 此刻 `--failed` 里有一个本仓单元、一个发行版单元

```
$ systemctl --failed --no-pager --plain
UNIT                                 LOAD   ACTIVE SUB    DESCRIPTION
dao-execution-usage.service          loaded failed failed Unified local execution usage collector
systemd-networkd-wait-online.service loaded failed failed Wait for Network to be Configured

2 loaded units listed.
```

`dao-execution-usage.service`：`User=orca`，`ExecMainStatus=2`，12:23:17–12:23:42 刚跑完。单元自己写「Exit 2 is an explicit collection gap; leave it visible as failed」（`host/machine/systemd/dao-execution-usage.service:28`）。配对 timer `OnCalendar=*:3/5`，`LastTriggerUSec=Sat 2026-09-12 12:28:10 CST`（有过触发）。仓内与 `/etc` md5 一致。

`systemd-networkd-wait-online.service`：

```
$ systemctl show systemd-networkd-wait-online.service -p FragmentPath,ActiveState,Result
FragmentPath=/usr/lib/systemd/system/systemd-networkd-wait-online.service
ActiveState=failed
Result=exit-code
```

`/etc/systemd/system/` 里没有这份文件。`ls` 两处都是 `No such file or directory`（只在 `/usr/lib` 和 `/lib`）。失败从今天 06:31:15 CST 起（`StateChangeTimestamp`）。

### 2. 活数据进同一份分类函数 → unknown，本仓那条只进 flaky

`scripts/dao-check.mjs:2031-2037` 取 unit 文本只试两个路径：`/etc/systemd/system/<名>`、仓内 `host/machine/systemd/<名>`。发行版那条两个都不在，`unitTexts` 没有它。

本轮 `node` 调 `classifyFailedUnits` + `hasEverRun`（`scripts/lib/failed-units-check.mjs`），输入就是上面那份 `--failed` 原文：

```
unit dao-execution-usage.service repoScript /srv/projects/windsurf-dao/scripts/execution-usage.mjs ever true arming true
unit systemd-networkd-wait-online.service repoScript null ever false arming false
{
  "state": "unknown",
  "detail": "1 个失败单元读不到 unit 文件，判不了归属：systemd-networkd-wait-online.service",
  "failed": [],
  "flaky": ["dao-execution-usage.service"],
  "foreign": [],
  "unjudged": ["systemd-networkd-wait-online.service"]
}
```

对应代码：`failed-units-check.mjs:125-131`——`hard` 为空之后，只要 `unjudged.length`，整格 unknown，**不再看 flaky**。`dao-check.mjs:2060-2062` 把 unknown 映射成 `skip(...)`。`dao-check.mjs:2736-2742`：`failures.length === 0` 时即使有 SKIP 也 `process.exit(0)`。文件头写「SKIP 不是绿」，退出码把「只有 SKIP」当成好的。

没验证：此刻完整跑一次 `node scripts/dao-check.mjs` 的 SKIP 行原文（会起全部测试，本轮没跑）。按上面三处源码，live 分类已经是 unknown，映射是 skip，空失败列表是 exit 0。

`dao-land.service` 上次 12:17:19–12:18:32 CST、`ExecMainStatus=0`。当时 `git status` 是 `master...origin/master`（不领先）。`land.mjs:92` 只在 `ship.action === 'push'` 时跑 dao-check。没验证那一轮有没有跑到这格——journal orca 读不了（已有观察 `2026-09-08-orca读不了journal-探针连红闸没查成.md`，不另报）。

### 3. 就算发行版单元不在表里，这格也拦不住「响过之后每轮失败」

`failed-units-check.mjs:68-77` 自己写：`dao-execution-usage` 每 5 分钟必进 `--failed`，常亮红灯没人看，所以「跑成过、最近一次非零」不红。`hasEverRun` 看的是配对 timer 的 `LastTriggerUSec`（:49-58）。带 timer 且已经响过的 oneshot，这一项恒为 true。

测试锁死（`tests/failed-units-check.test.js:41-52`）：

```
it('本仓 unit 跑成过、只是最近一次非零 → 不红，但列进 flaky 如实报')
assert.equal(r.state, 'green', ...)
```

同文件 133–137 行：**故意不拿真 `systemctl --failed` 跑**，「花一格不值」。于是「发行版单元读不到 → 整格 unknown」这条活路径，测试从未进过。

当初那五天的形状是：`miraquota-contabo.timer` 每 10 分钟响、service 每轮非零。本轮这个 timer `LastTriggerUSec=Sat 2026-09-12 12:24:00 CST`（已经响过）。按现判据它若再进 `--failed`：`hard=[]`、`flaky` 含它；再叠发行版 `unjudged` → unknown/SKIP；没有发行版 → green。两头都不红。

指挥官盘点 `scripts/lib/commander-inventory.mjs` 仍 0 处 `--failed`（本轮 `grep` 无命中）。server-check 也没有这一格。

### 4. 不是已报过的那几条

| 已有观察 | 管的是 | 本条不是 |
|---|---|---|
| `2026-09-05-stall单元failed闸仍绿.md` | 当时 **没有** `--failed` 闸，⑮ 只看 timer 在册 | 闸已经加上，加完之后仍不红 |
| `2026-09-09-凭据闸把额度采样的git推送掐死.md` | 建议「活体加一格：`--failed` 里出现本仓单元 = 红」 | 那一格昨天合进 master 了，本条是它装了没生效 |
| `2026-09-10-报帅规范化闸比真闸松.md` | 顺带写过「没人看 `--failed`」 | 那是加闸之前 |

## 建议的最小改造

删掉「读不到某个失败单元的文件 → 整格 unknown/SKIP」这一层。归属判不成的丢进 `foreign`（本来就不是本仓的活），不要阻断本仓 `hard` / `flaky` 的判定。发行版单元不在 `/etc` 是常态，不该让本仓闸停转。

「timer 响过一次就不红」这一档，至少不要套到 `miraquota-contabo` 那种「每次都是真失败」的单元上——否则昨天加的那一格从设计上就接不住它要接的样本。
