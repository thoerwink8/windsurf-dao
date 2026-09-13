---
status: new
---

# 机制巡检：mirasim-bridge 单元写 User=orca，drop-in 改成 root，提权闸按正文判绿

## 结论

`/etc/systemd/system/mirasim-bridge.service` 正文写了 `User=orca`，`identity.conf` 把它改成 `User=root`。活进程 uid=0，`ExecStart` 指向 `/srv/projects/ai-gateway-stack/deploy/mirasim-bridge.mjs`（本会话 `orca` 实测可写）。提权闸只读本仓 `host/machine/systemd/*.service` 正文的 `User=` 行，这个单元不在那一目录；就算只拿活正文喂同一套正则，`User=orca` 也会判绿。⑳ 已经会拼 drop-in，但只扫仓内那 31 个名字，`mirasim-bridge` 不进 pairs。闸看的那一层是「写了 User=orca」，跑的那一层是 root 解释 orca 可写脚本。同机已经有正确形状：`dao-execution-usage-export` 把脚本拷到 `root:root` 的 `/usr/local/lib`。

## 证据

本轮 2026-09-13 12:24–12:30 CST，身份 `uid=999(orca)`，未用 sudo。`HEAD=f98eaf08`，与 `origin/master` 相同。

### 1. 正文 orca，drop-in root，进程 uid=0，脚本可写

`/etc/systemd/system/mirasim-bridge.service` 正文（Birth/Modify 2026-09-10 23:39，本轮 `cat`）：

```
[Service]
Type=simple
User=orca
Group=orca
WorkingDirectory=/srv/projects/ai-gateway-stack
ExecStart=/usr/bin/node /srv/projects/ai-gateway-stack/deploy/mirasim-bridge.mjs --port 4315
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
```

`/etc/systemd/system/mirasim-bridge.service.d/identity.conf`（mtime 2026-09-10 23:55）原文：

```
[Service]
# 桥必须以 **root** 跑：它扫 /proc/<pid>/environ 找 mirasim 会话口，而本机全部会话口
# 都挂在 root 身份的会话上（/root/.mirasim-remote 那个服务端只服务 root 会话），
# orca 身份跨用户读 environ 一律 Permission denied——实测同样代码同身份，
# orca 下 matched=0、root 下 matched=5（2026-09-10）。
User=root
Group=root
PrivateTmp=no
```

本轮 `systemctl show mirasim-bridge.service`：

```
User=root
UID=0
GID=0
MainPID=2002169
ActiveState=active
SubState=running
ProtectSystem=no
ProtectHome=no
NoNewPrivileges=yes
PrivateTmp=no
DropInPaths=/etc/systemd/system/mirasim-bridge.service.d/identity.conf /etc/systemd/system/mirasim-bridge.service.d/proc.conf
ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /srv/projects/ai-gateway-stack/deploy/mirasim-bridge.mjs --port 4315 ; start_time=[Sat 2026-09-12 06:29:14 CST] }
```

`/proc/2002169/status`：`Uid: 0 0 0 0`。cmdline 就是上面那条 node。从 09-12 06:29 起到本轮一直没重启（`NRestarts=0`）。`Restart=on-failure`，下一次崩了会再解释当前磁盘上的那份脚本。

脚本本轮：

```
$ stat -c '%U:%G %a %n' /srv/projects/ai-gateway-stack/deploy/mirasim-bridge.mjs
orca:orca 664 /srv/projects/ai-gateway-stack/deploy/mirasim-bridge.mjs

$ python3 -c "import os; p='.../mirasim-bridge.mjs'; print(os.access(p, os.W_OK)); open(p,'r+').close()"
True
（open r+ 成功，未写入）
```

`/srv/projects/ai-gateway-stack` 与 `.git` 都是 `orca:orca` `775`，本会话对 `.git` `W_OK True`。仓状态 `master...origin/master [ahead 2]`。

没验证：改脚本之后活进程要不要重启才加载新内容。当前 pid 从 09-12 06:29 起一直在，已加载旧文件；触发面是下一次 `on-failure` 重启、`systemctl restart`、或开机。

### 2. 提权闸读正文、只扫本仓目录；喂活正文也绿

`tests/unit-privilege.test.js:13-15`：

```
const DIR = path.join(__dirname, '..', 'host', 'machine', 'systemd');
const CHECKOUT = '/srv/projects/windsurf-dao';
```

`:17-19` 只 `readdirSync(DIR)` 的 `.service`。`:27-35` 用正文 `^User=` 判是不是 root，再用 `ExecStart` 是否含 `CHECKOUT`。全文 0 处读 `/etc`、0 处读 `.d/`、0 处 `systemctl cat`。本轮 `ls host/machine/systemd/*.service` 18 个，没有 `mirasim-bridge`。`CHECKOUT` 钉死本仓路径，就算扫到了这条 `ExecStart`（指向 `ai-gateway-stack`）也不会进 `bad`。

本轮把活正文喂同一套正则：

```
{ user: 'orca', isRoot: false, wouldFailPrivilegeGate: false }
```

⑳ 的 `assembleEffectiveUnit`（`scripts/server-check.mjs:917-926`）会拼 drop-in，但 `collectUnitDriftPairs`（`:972`）只 `readdirSync(repoDir)`。本轮直接调：

```
pair count 31
has mirasim-bridge false
has miraquota-sync false
has commander false
state red
detail 3 个仓里和机器上不是同一份：feishu-triage.service、gw-remote-probe.service、mirasim-server.service；仓里有 2 个机器上根本没有：dao-skills-heal.service、dao-skills-heal.timer
```

红项里没有桥。server-check 心跳目录仍 ENOENT（已报 `2026-09-06-server-check无心跳.md`，不另报）。`host/machine/INDEX.md` 全文 0 处 `mirasim-bridge`。

同机对照，真正要 root 的那条已经不解释可写 checkout：

```
$ stat -c '%U:%G %a %n' /usr/local/lib/dao-execution-usage/execution-usage-export.mjs
root:root 644 /usr/local/lib/dao-execution-usage/execution-usage-export.mjs
```

`dao-execution-usage-export.service` 正文 `User=root`，`ExecStart` 指这份拷贝（`host/machine/systemd/dao-execution-usage-export.service:7-10`）。`tests/execution-usage.test.js:487-494` 把「root 只跑安装后的 root-owned 拷贝、collector 仍是 orca」锁死。桥走的是反面。

### 3. 不是已报过的那几条

| 已有观察 | 管的是 | 本条不是 |
|---|---|---|
| `2026-09-05-dao-sync-root-checkout.md` | dao-sync 正文没写 `User=`，闸后来扫本仓正文 | 桥的正文写了 `User=orca`，是 drop-in 改掉的 |
| `2026-09-06-miraquota-sync-root-checkout.md`（处置：#1051） | 另一个单元正文就没 `User=`，脚本当时 orca 可写 | 本轮那份脚本 `W_OK False`（属主 uid 197108）；本条对象是桥，形态是「正文看起来安全、有效单元不是」 |
| `2026-09-08-gw-remote-probe仍跑仓外旧脚本.md`（处置：#1164） | ⑳ 当时只读 FragmentPath，看不见 drop-in 改日历 | #1164 已经让 ⑳ 拼 drop-in；本条是拼完之后扫描面仍只有仓内文件名，仓外单元的 drop-in 改 `User=` 进不了 |
| `2026-09-13-凭据闸扫模板不扫活单元.md` | 凭据闸扫 `INSTALL_FILES()` 内存文本 | 对象是 GH_TOKEN / 空目录，不是提权；指挥官至少还在生成模板里 |

## 建议的最小改造

删掉「提权 = `host/machine/systemd/*.service` 正文里的 `User=`」这一层。问的是 systemd **正在跑的有效单元**（`systemctl cat` / 正文 + `/etc/.../<名>.d/*.conf`）里，`ExecStart` 指向 orca 可写路径、有效 `User=` 为空或 root 的那些。扫出 0 个也红。本仓目录白名单留着，下一次仓外再加一个 drop-in 照样看不见。

桥若必须读 root 会话的 `/proc/<pid>/environ`：把 `mirasim-bridge.mjs` 拷到 root-owned 路径再 `ExecStart` 那份，和 `dao-execution-usage-export` 同一把尺。不要在 drop-in 里写 `User=root` 却继续解释 `/srv/projects/` 下 orca 可写的文件。
