---
title: 收工 land 的小时触发仍钉在已停的 orca automations 上
status: done
issue: 1051
date: 2026-09-06
---

# 机制巡检：收工 land 的小时触发仍钉在已停的 orca automations 上

处置：#1051（挂回统领单，作第 7 条同形，未另开单）。判据与前 6 条完全一致——**grep 那个单元名，只有定义和文档、没有第三处真的在跑它**：`LAND_AUTOMATION_TRIGGER = 'hourly'` 只出现在安装脚本和 NEW-MACHINE 里，机器上既无 timer、无 cron、`orca automations list` 返 `runtime_unavailable`。⑧ 那格因此永远是「没查成」，不是红。本页第 6 节「建议的最小改造」直接作为 #1051 这一条的做法输入。留言见 #1051。

## 结论

合并后自动清树这条路，装机文档和活体闸都把它写成 `orca automations` 的 hourly 任务；`orca-serve` 已 disabled、runtime 不在，这条 hourly 根本唤不起来。指挥官只在自己刚合完一张 PR 时顺手调一次 land，人在 GitHub 上点 merge 的那些树没人收。闸 ⑧ 的测试把「没有这条 automation」锁成红，活路径却因为 `runtime_unavailable` 先变成没查成；server-check 在这台机器上没有心跳，连没查成都没人看。CHECKS 注释还写「工人仍从 orca 派（卡 B 返工 #982 在途）」——本轮 HEAD 已经是 #982 的合入，`MIRASIM_IS_ONLY_PATH = true`，这条前提不成立。

## 证据

本轮 2026-09-07 00:37 CST，身份 `uid=999(orca)`，未用 sudo。开始时 `HEAD=afd3941a`，写这份文件前主树已快进到 `1b9bdf19`（`[pi] 卡 B 绑定层合入……（#982）(#1066)`），与 `origin/master` 相同。

### 1. 小时触发面是 orca automations，运行时不在

`NEW-MACHINE.md:437-447`（本轮读到的原文）：

```
### land automation（#829）

合并后自动清理走 `orca automations` 调同一条 `node scripts/land.mjs`，不另写服务器版。
...
hourly + `--precheck`（`land.mjs --has-work`，没活记 skipped）+ `--workspace-mode existing`
`server-check` 第⑧项认这条：不在 / disable = 红；list 没查成 = 没查成。
```

`docs/global-CLAUDE.md:23` 同一句：「服务器 automations 调同一条（`node scripts/install-land-automation.mjs`，#829）」。

安装规格 `scripts/lib/land-automation.mjs:5-7`：

```
export const LAND_AUTOMATION_NAME = 'land';
export const LAND_AUTOMATION_PROVIDER = 'pi';
export const LAND_AUTOMATION_TRIGGER = 'hourly';
```

`scripts/install-land-automation.mjs` 全部动词是 `orca automations list/create/edit`。本轮：

```
$ systemctl is-enabled orca-serve.service
disabled
$ systemctl is-active orca-serve.service
inactive

$ ls /home/orca/.config/orca/orca-runtime.json
ls: cannot access '/home/orca/.config/orca/orca-runtime.json': No such file or directory

$ timeout 20 orca automations list --json
{
  "id": "local",
  "ok": false,
  "error": {
    "code": "runtime_unavailable",
    "message": "Could not read Orca runtime metadata at /home/orca/.config/orca/orca-runtime.json. Start the Orca app first."
  },
  ...
}

$ ls /etc/systemd/system/*land*
ls: cannot access '/etc/systemd/system/*land*': No such file or directory
```

`crontab -l`：`no crontab for orca`。`host/machine/systemd/` 无 land 单元。hourly 触发面只此一条，已经死了。

`docs/initiatives.json` 的 `orca-retire.done_when` 前两截（workspaces 0 棵树、orca-serve disabled）本轮成立；dao-check 退役闸本轮会走到「树清零 + 服务已停用——只剩删代码」（`scripts/dao-check.mjs:1491-1492`，按代码路径；没验证完整跑一遍 dao-check 的打印）。西瓜清单下一步是删代码，不是把 orca-serve 拉回来。已有观察 `2026-09-06-orca正在退役别当故障修.md` 处置栏写「运行时退役已完成（树 0 / 服务 disabled）」。

### 2. ⑧ 活路径到不了「没有这条 → 红」，测试锁的是另一条路

`scripts/server-check.mjs:171-183` 的 `checkLandAutomation`：先 `orcaJson(['automations', 'list', '--json'])`，`state !== OK` 就原样返回。`classifyOrcaStdout`（同文件 75–79 行）把 `runtime_unavailable` 放进 `UNPROBEABLE_CODES`，判 `unknown`。本轮 automations list 正是这个 code，所以 ⑧ 的活结论是没查成，不是「land 没装」。

测试锁的是纯函数在**已经拿到数组**之后的判别（`tests/server-check.test.js:253-256`）：

```
await t.test('没有这条 → red，带安装命令', () => {
  const r = classifyLandAutomation([]);
  assert.equal(r.state, 'red');
```

活路径进不了这个函数。本轮没跑完整 `node scripts/server-check.mjs`（没验证它打印出来是 unknown）。按 75–79 行和 171–183 行，⑧ 会 unknown。server-check 在这台机器上没有 timer、没有 cron、`~/.dao/server-check` 目录不存在（已报 `2026-09-06-server-check无心跳.md`），没查成等于没人看。

对照：同文件 `classifyRuntimeStatus`（121–123 行）对 `orca status --json` 的 `reachable: false` 判 **red**（「orca 没起 = 查成了的根因红一条」）。本轮 `orca status --json` 实测 `ok: true`、`runtime.reachable: false`、`state: not_running`。也就是说，若有人跑 server-check，④ 会红着喊「去 `systemctl start orca-serve`」——这正是 `2026-09-06-orca正在退役别当故障修.md` 警告过的方向：把退役稳态当故障修。⑧ 连这句红都喊不出来。

CHECKS 头注（`scripts/server-check.mjs:1233-1236`）本轮原文：

```
// （用户 2026-09-06：「orca 要全撤了还检测它干嘛」）。工人仍从 orca 派（卡 B 返工 #982 在途），
// 盲删=退役前盲飞。删这 9 项的条件：mirasim 派工实跑 + orca 退役，到时一并删。
```

两条删条件本轮都已成立：

```
$ python3 -c "import pathlib; t=pathlib.Path('scripts/dao.mjs').read_text(); print('MIRASIM_IS_ONLY_PATH' in t)"
# 源码 scripts/dao.mjs:3067
const MIRASIM_IS_ONLY_PATH = true;
```

`docs/initiatives.json` 的 `orca-retire` 写验收依据「issue #1003 → PR #1025，mirasim 全程跑通并已合并，orca 侧零参与」。本轮 HEAD `1b9bdf19` 就是 #982 合入——注释里「卡 B 返工 #982 在途」已经过时。⑧ 作为「orca 产品面、现在不删」留下来的理由，前提不在了；留下来的效果是：唯一守着 land 小时触发的那一格，在退役之后变成 unknown。

### 3. 指挥官只在自己刚合完 PR 时调 land，不是 hourly

`scripts/lib/commander-core.mjs:639-641`：`kind: 'merge'` 成功之后才 `out.push(... kind: 'land' ...)`，注释写「清树归 #829，本单只调 land」。`scripts/commander.mjs:442-443` 执行 `node scripts/land.mjs`。没有 timer、没有「每小时有没有可清的树」。人在 GitHub 上点 merge、land.mjs、帅位 `gh pr merge` 这几条路，指挥官不会因此跑 land——`host/machine/systemd/dao-close-issues.service` 文件头把这三件事并列成「指挥官合的之外」的漏网，关单有 timer 补，清树没有。

本轮 `~/.dao/commander/state.json` 全文搜 `land` 出现次数：0。最近 8 份 situation 快照没有 `kind: land` 的动作数组（situation 本身是态势不是动作账）。没验证指挥官最近一次成功 merge 是什么时候——没验证。

### 4. 这台机器上 land 自己说有活

本轮当场：

```
$ git worktree list | wc -l
67

$ timeout 90 node scripts/land.mjs --has-work /srv/projects/windsurf-dao
...
[收工] 有活：删支 fix-reviewer-executor-default
...
[收工] 有活（运=clean 拆树=1 删支=1 僵尸终端=0）
# exit 0
```

`--has-work` 不改任何东西（工作树仍干净）。67 棵树、124 条本地分支。拆树=1 说明至少有一棵已合并且 land 认为可拆的树，此刻没有 hourly 去拆。屏面指纹层退役那份观察顺带写过「九棵 `dao-review-pr-88x/89x` 审官树 completed 已 45 小时——像是该收的树，归 board-gc（#1065）」——board-gc 本轮仍在 `--failed`（exit 2，盘面源还是 orca，已报 `2026-09-06-board-gc与stall仍问orca.md`），不替代 land。

### 5. 不是已经报过的那几条

- `2026-09-06-orca正在退役别当故障修.md`：别把 orca-serve 干净退出当故障拉回来。本条是退役完成之后，挂在 orca automations 上的 **land 小时触发** 一起死了，文档和闸还当它活着。
- `2026-09-06-board-gc与stall仍问orca.md`：两条看门狗入口被 orca CLI 挡死。对象不是 land。
- `2026-09-06-server-check无心跳.md`：22 项没人跑。本条在它之上：就算有人跑，⑧ 对「orca 已停所以 automation 不存在」的活结论也是 unknown，不是 red。
- `2026-09-05-审官全灭-裸pi落错provider.md` 末尾「land automation 在漏会话（`reuseSession: false`）」：那是 automation **还跑得起来** 时每次泄一个 pi 会话。本条是它已经跑不起来。泄漏那条在退役之后不再发生，清树也不再发生。
- `2026-09-06-四套单元未装-⑳把没装判没查成.md`：仓内 systemd 单元没拷到 `/etc`。land 从来就没有 systemd 单元，不在那 7 个文件里。

## 建议的最小改造

删掉「合并后清树 = orca automations hourly」这一层。

land 的周期触发改成和 `dao-close-issues` 同级的 oneshot timer（或让已经在跑的 `commander-act` 每轮无条件跑一次 `land.mjs --has-work`，有活再跑 land）——触发面不许再经过 orca CLI。⑧ 要么改问「这台机器上 land 最近一次成功跑是什么时候 / `--has-work` 连续 N 轮有活却没人跑」，扫出 0 次运行就红；要么从 CHECKS 里拿掉，不要留一格在退役之后只会 unknown 的 orca 产品面。CHECKS 头注那句「工人仍从 orca 派」一并删，它已经不是真的。

装的动作仍是人跑（本条不要求 dao-sync 去写 `/etc`）。`install-land-automation.mjs` 在 orca-serve disabled 的机器上再跑，只会再次失败——那条安装路径随退役一起退役。
