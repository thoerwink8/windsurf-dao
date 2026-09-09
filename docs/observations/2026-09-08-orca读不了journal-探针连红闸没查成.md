处置：#1166

# 机制巡检：orca 读不了 journal，盘点「探针连红」闸每轮没查成
> 处置：#1166 orca 读不了 journal——真问题未修，已开单

## 结论

指挥官盘点每 6 小时跑一次 `checkProbeJournal`，用 `journalctl -u gw-remote-probe` 判供应商探活是不是连红。跑它的身份是 `User=orca`，orca 不在 `systemd-journal` / `adm` 里，journal 文件是 `root:systemd-journal` 加 ACL，`journalctl` 退出 1、stdout 空。闸把「没权限」写成「可能没这个单元」，标 unknown，不开单。探活自己写的 `~/.dao/provider-health.json` orca 读得到，盘点不去读。于是这台机器上「探针连红」这一格从来没有真查过。

## 证据

本轮 2026-09-09 06:39 CST，身份 `uid=999(orca)`，未用 sudo。`HEAD=b2211a986`，与 `origin/master` 相同。

### 1. orca 不在能读 journal 的组里

```
$ id
uid=999(orca) gid=988(orca) groups=988(orca)

$ getent group systemd-journal adm orca
systemd-journal:x:999:
adm:x:4:syslog,ubuntu
orca:x:988:
```

journal 目录与当前文件（本轮 `ls -l` 前 6 行）：

```
drwxr-sr-x+ 3 root systemd-journal 4096 Sep  2 22:17 /var/log/journal
drwxr-sr-x+ 2 root systemd-journal 4096 Sep  9 06:31 /var/log/journal/61a98d9670e744e5917d167cb2852a8d
-rw-r-----+ 1 root systemd-journal  8388608 Sep  9 06:39 system.journal
```

`-----+` = 只有组 `systemd-journal`（加 ACL）能读。orca 不在这个组。

### 2. 同一身份跑 journalctl，退出 1、一条日志都没有

```
$ journalctl -u gw-remote-probe.service -n 20 --no-pager -o cat
exit=1
stdout 0 字节
stderr: No journal files were opened due to insufficient permissions.

$ journalctl -u dao-patrol.service -n 5 --no-pager
Hint: You are currently not seeing messages from other users and the system.
      Users in groups 'adm', 'systemd-journal' can see all messages.
No journal files were opened due to insufficient permissions.
```

### 3. 盘点单元以 orca 跑，判据把权限失败写成「可能没这个单元」

活单元 `/etc/systemd/system/commander-inventory.service:6`：`User=orca`。
本轮最近一次：`ExecMainStartTimestamp=Wed 2026-09-09 00:41:00 CST`，`ExecMainStatus=0`，`Result=success`（1 秒跑完）。

仓内判据 `scripts/lib/commander-inventory.mjs:125-131`：

```
function checkProbeJournal() {
  …
  const r = sh('journalctl', ['-u', 'gw-remote-probe.service', '-n', '20', '--no-pager', '-o', 'cat'], 20000);
  if (!r.ok) return { state: 'unknown', detail: `journalctl 探不到：${r.error}`, key: 'probe-red' };
  if (r.code !== 0) return { state: 'unknown', detail: `journalctl 退出 ${r.code}（可能没这个单元）`, key: 'probe-red' };
```

`sh()`（同文件 33–36 行）只在 spawn 自己报错时 `ok:false`；`journalctl` 退出 1 走 `ok:true, code:1`，于是落到「可能没这个单元」。本机 `gw-remote-probe.timer` 在 `list-timers` 里，最近一次 `ExecMainStartTimestamp=Wed 2026-09-09 06:39:01 CST`——单元在，是读日志的人没权。

盘点 `runInventory`（273 行起）对 unknown **不开单**，且 `process.exit(0)`。注释 17–19 行写「没查成经 status 三态可见」——`commander status` 只看两个 timer 在不在册（`scripts/server-check.mjs` 第⑭项），不看盘点 7 项里有几项 unknown。本轮 `~/.dao/commander/state.json` 里没有 `probe-red` 字样。

### 4. 探活的真输出 orca 读得到，盘点不读

```
$ ls -la /home/orca/.dao/provider-health.json
-rw-r--r-- 1 orca orca 3210 Sep  9 06:09 /home/orca/.dao/provider-health.json
```

（本轮 06:39 那次还在跑，mtime 停在上一轮 06:09 是当时的快照。）

`NEW-MACHINE.md` / `host/machine/INDEX.md` / `scripts/server-check.mjs` 全文 0 处 `systemd-journal`。装机清单没写「服务用户要能读 journal」，所以换机还会再漏一次。

同病：`scripts/patrol-failure.mjs:16` 告警原文是「请查看 dao-patrol.service 的 journal」——收告警的人如果是 orca 会话，同样打开失败。没验证：总控群里这条告警有没有人真去 journalctl。

## 建议的最小改造

删掉盘点里「用 journalctl 读别人单元日志」这一层真相源。`gw-remote-probe` 已经把结果写进 `~/.dao/provider-health.json`，orca 读得到；`checkProbeJournal` 改读那份文件（或直接复用 `scripts/lib/provider-health.mjs`），journal 留给人手（root / adm）排障。顺手把 `journalctl 退出 N（可能没这个单元）` 这句误诊删掉——没权、没单元、没日志三条分不开，unknown 就等于没查。

不要加「把 orca 丢进 systemd-journal」当主修：那是给服务用户开系统日志读权，面比这一格闸大，而且 server-check 现在扫不到「加没加组」，加了也会漂。
