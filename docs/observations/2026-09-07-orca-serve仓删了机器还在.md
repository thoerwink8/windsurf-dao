处置：#1115 只删仓；机器上 orca-serve 仍 loaded/disabled，卸载要 root，本轮没动

# 机制巡检：orca-serve 从仓里删了，机器上还在；退役闸只扫仓所以全绿

## 结论

`#1115`（`789d10803`）把 `host/machine/systemd/orca-serve.service` 从仓里删掉，西瓜清单把 `orca-retire` 标成 `done`，`dao-check` 的产品残留闸按设计会绿。这台机器 `/etc/systemd/system/orca-serve.service` 还在（disabled / inactive / LoadState=loaded），`/opt/orca` 的 194MB AppImage 还在，`PATH` 上的 `orca` 包装器还指向它。⑳ 只扫仓内目录、⑮ 的影子清单没有这一项、退役闸 grep 范围不含 `/etc`——所以「服务器上的 orca 全卸载删除」这一句没有第二只眼睛。用户 2026-09-06 拍的是卸机器，闸验收的是删仓。

## 证据

本轮 2026-09-07 12:34 CST，身份 `uid=999(orca)`，未用 sudo。`HEAD=9139c6f59`，与 `origin/master` 相同。

### 1. 仓里没了，机器上还在

```
$ ls host/machine/systemd/orca-serve.service
ls: cannot access 'host/machine/systemd/orca-serve.service': No such file or directory

$ git log -1 --format='%h %ci %s' -- host/machine/systemd/orca-serve.service
789d10803 2026-09-07 10:36:59 +0800 [grok] feat!: 删影响地图与 orca 派工脊，执行体只剩 mirasim (#1115)
```

`789d10803` 合入距本轮约 2 小时。西瓜清单本轮原文（`docs/initiatives.json:12-22`）：

- `status: done`
- `done_when`: `dao-check 的 orca 产品残留闸绿（无 spawn/run orca、无 createOrcaBinding、无 orca-serve 单元、无 dao.mjs「整段删」脊）`
- `next_action`: `产品残留闸已绿；linux 用户名 /home/orca 留下。`（`as_of: 2026-09-07`）
- `why` 里仍写着用户 2026-09-06 的两条：`服务器上的 orca 全卸载删除、仓库里关于 orca 的全删除`

机器上：

```
$ ls -la /etc/systemd/system/orca-serve.service
-rw-r--r-- 1 root root 3194 Sep  6 17:23 /etc/systemd/system/orca-serve.service

$ ls /etc/systemd/system/orca-serve.service.d/
10-env.conf  20-limits.conf

$ systemctl show orca-serve.service -p LoadState,UnitFileState,ActiveState,SubState,FragmentPath,User
LoadState=loaded
UnitFileState=disabled
ActiveState=inactive
SubState=dead
FragmentPath=/etc/systemd/system/orca-serve.service
User=orca

$ systemctl is-enabled orca-serve.service; echo exit=$?
disabled
exit=1

$ systemctl list-unit-files --no-pager | grep orca
orca-serve.service                           disabled        enabled
```

文件头第一句还是「Orca 无头运行时」，装法还写 `sudo systemctl enable --now orca-serve.service`。Birth/Modify 是 2026-09-06 17:23——`#1115` 合入之前那份，没人卸。

同轮还在的运行时本体：

```
$ ls -la /opt/orca
-rwxr-xr-x 1 root root 203821343 Sep  2 23:27 orca-linux.AppImage
drwxr-xr-x 5 root root      4096 Sep  2 23:27 squashfs-root

$ command -v orca
/home/orca/.local/bin/orca

$ cat /home/orca/.local/bin/orca
#!/usr/bin/env bash
# orca-serve-bare-orca-dispatcher
exec '/opt/orca/squashfs-root/resources/bin/orca-ide' "$@"
```

`systemctl is-active` 是 `inactive`（exit 3），所以它现在没在跑。本条不是「它还在派工」，是「卸的动作从来没发生，闸也看不见」。

### 2. 活着的本仓单元还在 After= 一份已经不存在的服务

仓内 `host/machine/systemd/dao-board-gc.service:19` 与 `dao-patrol.service:20` 已改成 `After=network-online.target`（同一次 `789d10803`）。机器上 `/etc` 仍是 2026-09-06 00:54 那份：

```
$ grep -n After= /etc/systemd/system/dao-board-gc.service /etc/systemd/system/dao-patrol.service
/etc/systemd/system/dao-board-gc.service:19:After=network-online.target orca-serve.service
/etc/systemd/system/dao-patrol.service:22:After=network-online.target orca-serve.service
```

`md5` 本轮：`dao-board-gc.service` 与 `dao-patrol.service` 仓机不一致。没有 `Requires=`，所以 orca-serve 停了这两条 timer 照样触发（board-gc 本轮 12:07:11–12:07:25 `ExecMainStatus=0`；patrol 12:23:29–12:23:32 `ExecMainStatus=0`）。`After=` 指向一份 disabled 的单元，眼下没有把它们卡住——它是退役没卸干净的痕迹，不是当前故障。

### 3. 三把闸的扫描面都把「机器上多出来的」定义成不存在

退役闸 `scripts/dao-check.mjs:1231-1234`（`checkOrcaRetirement`）的 grep 范围是 `scripts` / `tests` / `host/machine/systemd`，显式不扫 `docs/`，也**不扫 `/etc`**：

```
grep -rlnE 'spawn(Sync)?\(\s*['"]orca['"]|…|orca-serve\.service|…' scripts tests host/machine/systemd
```

本轮当场用同一条模式扫那三个目录：0 行，grep 退出 1。按 1247–1252 行，这一格会绿（「orca 产品面已清」）。本轮没跑完整 `node scripts/dao-check.mjs`（没验证它打印出来是不是绿）。按代码路径和这次 grep，会绿。

⑳ `scripts/server-check.mjs:917-933`（`checkUnitDrift`）只 `readdir` 仓内 `host/machine/systemd/`，再拿同名去读 `/etc`。仓里没有的名字根本不进 `pairs`。本轮用它自己的纯函数喂「仓有 / 机无」+「内容漂了」：

```
$ node --input-type=module -e '... classifyUnitDrift([{name:"dao-land.timer", repo:"A", live:null}, {name:"dao-board-gc.service", repo:"After=network-online.target", live:"After=… orca-serve.service"}])'
state: unknown
detail: 1 个单元没比成：dao-land.timer(机器上没装)——没查成，不是「一致」
```

`unreadable` 先返回（`scripts/server-check.mjs:900-904`），内容漂移那一截根本走不到。本轮仓内有、`/etc` 没有的是 `dao-land.{service,timer}` / `dao-gh-events.service` / `miraquota-contabo.{service,timer}` 共 5 个——⑳ 会 unknown，`dao-board-gc.service` 与 `dao-patrol.service` 的真漂移被盖掉。`orca-serve.service` 连 unknown 的名单都进不去。

测试把「没装 → unknown」锁死：`tests/server-check.test.js:606-610`。全仓没有「机器上多一份仓里没有的单元 → 红」的样本。

⑮ `scripts/server-check.mjs:417-420` 的影子清单只有 `agent-stall-watch.timer` 和 `dao-agent-stall.timer`。`orca-serve` 不在里面。本轮 `systemctl list-timers --all` 28 行，没有 `orca-serve`（它是 service 不是 timer），⑮ 按 454 行会走到「progress-watch 在册」的绿。本轮没跑完整 `server-check.mjs`（没验证打印）。

指挥官盘点 `scripts/lib/commander-inventory.mjs:99-121` 的 `checkTimers` 只问 `commander-act.timer` / `commander-inventory.timer` 是否 enabled。

`NEW-MACHINE.md:335` 整节还是「9d. Linux 服务器起 Orca 无头运行时」；`:374` 仍写「单元在 `host/machine/systemd/orca-serve.service`，装法见文件头注释」——那个文件已经不在仓里。新机照装机文档走，会去装一份仓里没有的单元。

server-check 在这台机器上没有心跳（已报 `2026-09-06-server-check无心跳.md`）。本条不靠那份心跳：就算有人跑，上面三把闸对「机器上多出来的 orca-serve」的结论也是绿或看不见。

### 4. 不是已经报过的那几条

| 已有观察 | 管的是 | 本条不是 |
|---|---|---|
| `2026-09-06-orca正在退役别当故障修.md` | 别把 disabled 当故障拉回来 | 西瓜已标 done，缺的是卸；那份处置栏写「运行时退役已完成（树 0 / 服务 disabled）」——disabled 被当成终点，卸载从未发生 |
| `2026-09-06-四套单元未装-⑳把没装判没查成.md` | 仓里有、`/etc` 没有 | 方向反了：仓里没了、`/etc` 还有 |
| `2026-09-05-systemd单元仓改未装.md` | 已装单元**内容**漂了 | orca-serve 根本不在仓内比对名单里；board-gc/patrol 的 After= 漂移被 ⑳ 的 unknown 短接盖掉，是本条的连带，不是那份的复述 |
| `2026-09-06-屏面指纹层整层退役.md` | stall 那层的影子制度，⑮ 会红 | ⑮ 的影子清单没有 orca-serve |
| `2026-09-06-land小时触发还钉orca-automations.md` | land 小时触发挂在已停的 orca automations | `#1115` 已改成 `dao-land.timer`；本条对象是 orca-serve 单元本身没卸（land 没装是「仓有机无」，归已报的 ⑳ 那条，不在这里再报） |

`dao-sync` 只拉代码、不装也不卸单元（`scripts/server-sync.sh` 全文只有一处 `systemctl`：`try-restart feishu-triage`）。仓里删掉一份 unit，机器上的那份会永远留着——这是 2026-09-05 定性过的根因的另一面：那天是「改了仓 ≠ 装了机器」，今天是「删了仓 ≠ 卸了机器」。

## 建议的最小改造

删掉「退役 = 仓内 grep 0 命中」这一层。

`checkOrcaRetirement`（或单独一格）对这台机器问三件实事：`/etc/systemd/system/orca-serve.service` 还在不在、`/opt/orca` 还在不在、`PATH` 上的 `orca` 还指不指 AppImage。任一还在就红，并点名「卸的是机器不是仓」。⑳ 的取数改成仓内名单 ∪ `/etc` 里本仓前缀（至少 `orca-serve`）的差集：仓里没有、机器上还有 = 红，不要只扫仓→机这一向。⑮ 的影子清单把 `orca-serve.service` 加进去——它已经是退役件。

装 / 卸仍是人跑（不要让 dao-sync 去写 `/etc`）。`NEW-MACHINE.md` §9d 整节该标「已退役，新机不装」，否则下一台机器会按一份已经不存在的文件去装。本轮不动手。
