处置：#1133

# 机制巡检：dao-nudge-stalled 文件在 /etc、timer 是 disabled，⑱ 按 list-timers 扫所以看不见

## 结论

卡死处置垫片 `dao-nudge-stalled` 的单元文件已经装进 `/etc/systemd/system/`，内容和仓里那份一字不差，但 timer 是 `disabled` + `inactive`，`timers.target.wants` 里没有软链，`list-timers --all` 里没有这一行。活体闸 ⑱ 的取数面是 `systemctl list-timers --all`，disabled 的 timer 根本不会出现在那张表上，于是「装了没启用」这一格每次都绿。#1056 还开着，垫片按设计不该停。

## 证据

本轮 2026-09-07 06:35 CST，身份 `uid=999(orca)`，未用 sudo。`HEAD=0a816011`，与 `origin/master` 相同。

### 1. 垫片按设计还在役

`#1056` 本轮 `state=OPEN`（`gh issue view 1056`）。对账循环没合进 master（`git merge-base --is-ancestor 9aeeac35 HEAD` 退出 1）。

仓内单元自己写着「随 #1056 退役」：

- `host/machine/systemd/dao-nudge-stalled.timer:17`：`Description=每 20 分钟推一把卡住的会话（垫片，随 #1056 退役）`
- `host/machine/systemd/dao-nudge-stalled.service:3-5`、`23-24`：装法 `sudo bash scripts/install-nudge-stalled.sh`，退役步骤是 #1056 落地后才删
- `NEW-MACHINE.md:378-381`：装完要能在 journal 里看到它真推了谁，「只看到已安装不算」
- `scripts/install-nudge-stalled.sh:26`：`systemctl enable --now dao-nudge-stalled.timer`

合入 master 的安装提交是 `4bbf60af`（2026-09-06 22:36:19 +0800），正文写第一轮 22:31:37 自动跑过，journal 里有「审官 PR #1071 推了」。

### 2. 机器上：文件在，启用链断了

```
$ md5sum host/machine/systemd/dao-nudge-stalled.timer /etc/systemd/system/dao-nudge-stalled.timer
f50464d2f85b2fbfa4c9367ffeb736ba  host/machine/systemd/dao-nudge-stalled.timer
f50464d2f85b2fbfa4c9367ffeb736ba  /etc/systemd/system/dao-nudge-stalled.timer

$ systemctl show dao-nudge-stalled.timer -p UnitFileState,ActiveState,SubState,NextElapseUSecRealtime,NextElapseUSecMonotonic,LastTriggerUSec,WantedBy
UnitFileState=disabled
ActiveState=inactive
SubState=dead
NextElapseUSecRealtime=
NextElapseUSecMonotonic=infinity
LastTriggerUSec=
WantedBy=

$ ls /etc/systemd/system/timers.target.wants/ | grep nudge
# （无输出）

$ systemctl list-timers --all --no-pager | grep nudge
# （无输出；28 个 timer 里没有这一行）

$ systemctl list-unit-files --type=timer --no-pager | grep nudge
dao-nudge-stalled.timer        disabled enabled
```

`/etc` 里文件的 Birth/Modify 是 2026-09-06 22:31:35，和安装提交说的第一轮时间对得上。谁后来 `disable` 的，本轮读不到 journal（orca 不在 `systemd-journal` 组），**没验证**。

对照：同目录其它 dao/commander timer 全部 `enabled` + `active` + 出现在 `list-timers` 里。`/etc/systemd/system/*.timer` 里 `enabled=disabled` 的只有这一个。

### 3. 闸 ⑱ 的取数面把 disabled 定义成「不存在」

`scripts/server-check.mjs:728-742`（`checkTimerArmed`）：

```
const list = run('systemctl', ['list-timers', '--all', '--no-legend', '--no-pager'], …);
const names = […matchAll(/\b([a-z0-9@_.-]+\.timer)\b/g)…];
```

它只扫 `list-timers` 吐出来的名字，再按 `FragmentPath` 是否在 `/etc/systemd/system/` 圈定「我们的」。disabled 的单元不进这张表，圈定步骤根本轮不到它。

`classifyTimerArmed` 的注释写明（同文件 654-655 行）：「与『装没装』『enable 没 enable』都无关」。所以这一格即使有心跳，也答不出「仓里要求在跑的 timer，机器上关着」。

闸 ⑳ 只比文件内容（同文件 `classifyUnitDrift` / `checkUnitDrift`）。本轮两边 md5 相同，⑳ 会绿。⑮ 只认 `dao-progress-watch.timer`（发现面），不认 nudge（处置面）。

`tests/timer-armed.test.js` 本轮 `rg disabled` 0 行——没有样本锁「disabled 必须红」。

server-check 在这台机器上没有心跳（已报 `2026-09-06-server-check无心跳.md`），连 unknown 都没人看。本条不靠那份心跳。

### 4. 不是已报过的那几条

| 已有观察 | 管的是 | 本条不是 |
|---|---|---|
| `2026-09-05-systemd单元仓改未装.md` | 已装单元**内容**漂了 | 内容一致，启用链断了 |
| `2026-09-06-四套单元未装-⑳把没装判没查成.md` | `/etc` 里**没有**文件 | 文件在 |
| `2026-09-06-屏面指纹层整层退役.md` | stall 那层删了，nudge **不受影响** | 正是那条「不受影响」的垫片现在没在跑 |
| `2026-09-06-board-gc与stall仍问orca.md` | 处置面问错真相源 | 本条是处置面的 timer 根本没启用 |

#1056 合进来之前，这条垫片是无人值守时「卡死了有人推一把」的唯一腿。它停了，progress-watch 仍然每 20 分钟叫醒帅位——帅位不在就整夜没人动手。这正是装它的那次提交要堵的洞。

## 建议的最小改造

删掉「⑱ 只从 `list-timers` 取名单」这一层。取数改成扫 `/etc/systemd/system/*.timer`（或 `list-unit-files --type=timer`），再逐个问 `UnitFileState` / `NextElapse*`：仓里有、机器上 disabled 或没有下一次，当场红。静态闸 `tests/timer-armed.test.js` 加一条夹具：disabled 样本必须红，不许再把「表上没有」读成「都健康」。

本轮不动手。启用它是人的动作（要 root）；不要让 dao-sync 去 enable——那是 2026-09-05 堵掉的提权路。
