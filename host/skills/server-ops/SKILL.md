---
name: server-ops
description: 给服务器上的帅/工人用的运维便签。改这台机器上的 orca-serve、systemd drop-in、探活、密钥目录、夜间指标，或启停飞书适配器时读。装法指向 NEW-MACHINE §9d，本页不复制。
---

# 服务器运维便签

只写「改这台机器前必须知道什么」。装法见 `NEW-MACHINE.md` §9d。

## orca-serve

- 单元模板：`host/machine/systemd/orca-serve.service`（装法在文件头注释）。
- 本机覆写（不进 git）：`/etc/systemd/system/orca-serve.service.d/`
  - `10-env.conf`：env 注入（`EnvironmentFile` / `Environment`）。只改 drop-in，不把值写进仓。
  - `20-limits.conf`：进程限额（`LimitNOFILE` / `TasksMax`）。
- 改单元或 drop-in 后：`sudo systemctl daemon-reload && sudo systemctl restart orca-serve`
- 日志：`journalctl -u orca-serve`
- 探活：`orca status --json`。**恒返回 `ok:true`**，真信号在 `result.runtime.reachable`。只看 `ok` 会在 orca 已死时报绿。`ok:false` 时退出码仍是 0。不要用 `orca --version` 探活（会占单实例锁）。清锁与其它坑见 §9d。

## MiraQuota 多机页 Contabo 接入（#881）

- 单元模板：`host/machine/systemd/miraquota-contabo.service` + `host/machine/systemd/miraquota-contabo.timer`（装法在 service 文件头）。
- 幂等安装（要 root）：`sudo bash scripts/install-miraquota-contabo.sh`。装完自己验 NEXT，并以 orca 跑一次 `--dry-run`。
- 一条命令：`node scripts/miraquota-contabo-sync.mjs --once`（timer 调同一条；`--dry-run` 只打印）。
- 探活：`systemctl list-timers` 里要有 `miraquota-contabo.timer`，**NEXT 不能是 `-`**。多机页出现 `contabo`，额度数对得上 `getRelay` 的 usage windows。

## 卡死发现（盘面推进量）

2026-09-06 用户拍板删掉屏面指纹整层：不再读执行体屏幕猜它卡没卡，改成超时判死——
连续 N 轮同一对象（PR / 已消歧 issue / 复审票）同一状态就是卡住，判据全在 GitHub 面。
发现只叫醒帅位，**不自动换审官**（换人执行面随那一层一起删了）。

- 单元模板：`host/machine/systemd/dao-progress-watch.service` + `.timer`（装法在 service 文件头）。
- 幂等安装（要 root）：`sudo bash scripts/install-progress-watch.sh`。
- 一条命令：`node scripts/progress-watch.mjs`（timer 调同一条；`--dry-run` 只打印）。
- 原料是指挥官每 20 分钟写的 `~/.dao/commander/situation-*.json`——`commander-act.timer` 停了它就永远「没查成」（exit 2），两个 timer 是一条链。
- 探活：`systemctl list-timers` 里要有 `dao-progress-watch.timer`，**NEXT 不能是 `-`**（在册但 elapsed 等于没拉）。`scripts/server-check.mjs` ⑮ 会红漏装、NEXT 横杠，以及三个退役件（`dao-agent-stall.timer` / `agent-stall-watch.timer` / `/home/orca/bin/agent-stall-watch.mjs`）任一还在。

## server-check 三态

```bash
node scripts/server-check.mjs           # 人读
node scripts/server-check.mjs --json    # 给循环
```

退出码：`0` 全通 / `1` 有真红 / `2` 有没查成。没查成不许当通过。`--json --out` 落仓外 `~/.dao/server-check/`。脚本在 `scripts/server-check.mjs`。第⑧项认 land automation 在册且启用；缺了跑 `node scripts/install-land-automation.mjs`（NEW-MACHINE「land automation（#829）」）。

## 密钥目录（只写路径，不写值）

- `~/.mirasim/keys/`
- `~/.config/ai-gateway/`

归属见 `host/machine/INDEX.md`。本仓不写装法、不写值。

## 夜间指标

`/var/tmp/night-metrics.log`：约 5 分钟一行（load / cpu / mem / 网关耗时）。机器慢或网关卡先看这里。

## 飞书

- CLI：`lark-cli`，机器人身份加 `--as bot`。日常两条见 `feishu-ops`。
- 适配器单元名 `feishu-triage`（模板随 #801 PR #806 入仓，本树未合入）。启停：`sudo systemctl start|stop|restart feishu-triage`。日志：`journalctl -u feishu-triage`。

## 改之前再看一眼

进程名是 `orca-ide` 不是 `orca`；exit 3 = 单实例锁，重启无用。必须非 root。细节只信 §9d 坑，本页不复制。
