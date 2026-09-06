# 机制巡检：miraquota-sync 以 root 解释 orca 可写脚本，提权闸扫不到

## 结论

昨天给 `dao-sync` 补的那道提权闸，只扫本仓 `host/machine/systemd/`、只认 `ExecStart` 指进 `/srv/projects/windsurf-dao`。这台机器上另有一个活着的单元 `miraquota-sync.service`：没写 `User=`、systemd 默认 root，`ExecStart` 指向 `/srv/projects/miraquota-win/provider/miraquota-provider.mjs`（`-rw-rw-r-- orca:orca`，本会话 `orca` 实测可写）。当前主进程 uid=0。能写那个仓的人改一行脚本，等进程重启就是 root。闸全绿，因为它的扫描面把这个单元定义成「不存在」。

## 证据

本轮 2026-09-06 12:29 CST，身份 `uid=999(orca)`，未用 sudo。

### 1. 活单元没有 User=，进程是 root，脚本 orca 可写

`/etc/systemd/system/miraquota-sync.service` 全文（13 行，无 `User=` / `Group=` / `ProtectSystem` / `NoNewPrivileges`）：

```
[Unit]
Description=MiraQuota ledger sync (headless: publishes this machine usage + speed shard)
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /srv/projects/miraquota-win/provider/miraquota-provider.mjs --sync-only
Restart=always
RestartSec=30
Nice=10

[Install]
WantedBy=multi-user.target
```

同轮 `systemctl show`：

```
$ systemctl show miraquota-sync.service -p User,UID,MainPID,ActiveState,FragmentPath,ProtectSystem,ProtectHome,NoNewPrivileges --no-pager
MainPID=418381
UID=[not set]
User=
ProtectHome=no
ProtectSystem=no
NoNewPrivileges=no
ActiveState=active
FragmentPath=/etc/systemd/system/miraquota-sync.service
```

`Active: active (running) since Sun 2026-09-06 03:31:29 CST`（本轮已连跑 8 小时+）。

```
$ awk '/^(Name|Uid|Gid|PPid):/' /proc/418381/status
Name:	node
PPid:	1
Uid:	0	0	0	0
Gid:	0	0	0	0

$ stat -c '%A %U:%G %n' /srv/projects/miraquota-win /srv/projects/miraquota-win/provider /srv/projects/miraquota-win/provider/miraquota-provider.mjs
drwxrwxr-x orca:orca /srv/projects/miraquota-win
drwxrwxr-x orca:orca /srv/projects/miraquota-win/provider
-rw-rw-r-- orca:orca /srv/projects/miraquota-win/provider/miraquota-provider.mjs

$ python3 -c "import os; print(os.access('/srv/projects/miraquota-win/provider/miraquota-provider.mjs', os.W_OK))"
True
```

`provider/lib/*.mjs` 同样 `-rw-rw-r-- orca:orca`（`engine.mjs` 本轮亦 `os.access W_OK True`）。主脚本和它 import 的库都在可写面上。

对照：同机 `dao-sync.service` / `dao-agent-stall.service` / `commander-act.service` 都写了 `User=orca`。`cliproxy.service` 也没写 `User=`，但 `ExecStart` 指 `/opt/cliproxy/cli-proxy-api`（`root:root`、不可写），不是这条洞。

没验证：改脚本之后要等多久才会被重新解释。当前进程已加载旧文件；`Restart=always` 只在退出时拉起。orca 杀不掉 uid=0 的 pid（没验证发信号的返回值）。触发面是下一次崩溃、`systemctl restart`、或开机（`WantedBy=multi-user.target`）。不是 dao-sync 那种每 5 分钟必再解释一次，但重启后就是 root 跑新内容。

### 2. 写单元的模板现在仍在写出这份缺 User= 的文件

`/srv/projects/miraquota-win/scripts/deploy-linux.mjs:214-247`（本轮读到的原文）把上面那份单元 `tee` 进 `/etc`：

```
ExecStart=$NODE ${DIR}/provider/miraquota-provider.mjs --sync-only
Restart=always
RestartSec=30
Nice=10
```

模板里没有 `User=`。再跑一次部署，会把「root 解释可写 checkout」重新写进 `/etc`。

`host/machine/INDEX.md` 全文搜 `miraquota-sync`：0 命中。落地清单只记「miraquota-win 克隆进驻 `/srv/projects/`」，不记这个单元。E 类登记要求「只写仓名不写文件路径」，这一条连仓名都没把它和 `/etc/systemd/system/miraquota-sync.service` 对上。

### 3. 昨天补的提权闸按目录和仓路径把它排除在外

`tests/unit-privilege.test.js:13-15`：

```
const DIR = path.join(__dirname, '..', 'host', 'machine', 'systemd');
const CHECKOUT = '/srv/projects/windsurf-dao';
```

同文件 17–19 行只 `readdirSync(DIR)`；27–34 行只对「没写 User=」且 `ExecStart` 含 `CHECKOUT` 的本仓单元判红。`miraquota-sync.service` 不在 `host/machine/systemd/`（本轮 `ls` 那个目录：13 个文件，无 miraquota），ExecStart 也不含 `/srv/projects/windsurf-dao`。闸绿，是因为它没看见。

`tests/unit-privilege.test.js:46-47` 的 sudoers 闸写死只读 `host/machine/sudoers.d/dao-sync`，同一目录里后加的 `dao-gh-events` 都不在这把尺下（`dao-gh-events` 另有 `tests/gh-events.test.js` 盯；miraquota 两边都没有）。

server-check ⑳（`scripts/server-check.mjs:1068-1085`）同样只扫 `host/machine/systemd/` 再跟 `/etc` 对内容。机器上多出来的 `miraquota-sync.service` 不进 pairs。⑱ 扫的是 `.timer`；这个单元是 `Type=simple` 常驻、没有 timer，⑱ 也看不见。

本轮没跑完整 `node scripts/server-check.mjs`（没验证它打印出来是不是绿）。按 1068–1085 行和 `unit-privilege.test.js:13-34` 行，这一格不会点名 miraquota-sync。server-check 在这台机器上没有心跳，已另报 `2026-09-06-server-check无心跳.md`；即便有人跑，扫描面也盖不住。

### 4. 不是已经报过的那几条

`2026-09-05-dao-sync-root-checkout.md` 管的是 **dao-sync** 以 root 解释 **本仓** `scripts/server-sync.sh`，处置已经给那一个单元加了 `User=orca`，并配了上面那道闸。本条是同一形态落在闸补完之后仍覆盖不到的第二个生成源，对象是 `/etc` 里正在跑的 `miraquota-sync`，不是 dao-sync 的复述。

`2026-09-05-gw-remote-probe单调时钟.md` 管的是 timer 扫描面按名字圈定；处置把 ⑱ 改成按 `/etc/systemd/system/` 落点圈定。提权闸没有做同一刀，仍按本仓目录圈定。

`2026-09-05-systemd单元仓改未装.md` 管的是本仓单元仓机内容不一致。miraquota-sync 根本不在本仓单元目录里，⑳ 对它无定义。

## 建议的最小改造

删掉「有提权风险的单元 = 文件躺在本仓 `host/machine/systemd/`，且 ExecStart 指进 `/srv/projects/windsurf-dao`」这一层。

闸对 `/etc/systemd/system/` 里每一个 `ExecStart` 指向 orca 可写路径的单元查 `User=`：没写或写 root 就红，扫出 0 个也红。结构判据已经在 ⑱ 的 `isOurUnit(fragmentPath)` 里（`scripts/server-check.mjs:714-720`），提权闸复用同一把尺，不要另维护一份目录白名单。单元本身加 `User=orca`（以及生成它的 `deploy-linux.mjs` 模板），是 `miraquota-win` 的事——本仓不写那份装法，但本仓的闸必须能看见这台机器上正在跑的那一份。
