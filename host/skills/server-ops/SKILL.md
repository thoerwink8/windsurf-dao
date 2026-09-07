---
name: server-ops
description: 给服务器上的帅/工人用的运维便签。改这台机器上的 systemd 单元、探活、密钥目录、夜间指标，或启停飞书适配器时读。装法指向 NEW-MACHINE §9d，本页不复制。
---

# 服务器运维便签

只写「改这台机器前必须知道什么」。装法见 `NEW-MACHINE.md` §9d。

## land timer

- 单元模板：`host/machine/systemd/dao-land.service` + `.timer`（装法在文件头）。
- 幂等安装（要 root）：`sudo bash scripts/install-land.sh`。
- 探活：`systemctl list-timers` 里要有 `dao-land.timer`，**NEXT 不能是 `-`**。`scripts/server-check.mjs` ⑧ 认这一条。

## MiraQuota 多机页 Contabo 接入（#881）

- 单元模板：`host/machine/systemd/miraquota-contabo.service` + `host/machine/systemd/miraquota-contabo.timer`（装法在 service 文件头）。
- 幂等安装（要 root）：`sudo bash scripts/install-miraquota-contabo.sh`。装完自己验 NEXT，并以 orca 跑一次 `--dry-run`。
- 一条命令：`node scripts/miraquota-contabo-sync.mjs --once`（timer 调同一条；`--dry-run` 只打印）。
- 探活：`systemctl list-timers` 里要有 `miraquota-contabo.timer`，**NEXT 不能是 `-`**。多机页出现 `contabo`，额度数对得上 `getRelay` 的 usage windows。

## 卡死发现（盘面推进量）

2026-09-06 用户拍板删掉屏面指纹整层：不再读执行体屏幕猜它卡没卡，改成超时判死——
连续 N 轮同一对象（PR / 已消歧 issue / 复审票）同一状态就是卡住，判据全在 GitHub 面。
2026-09-07 并进 `commander-act`：不再另开 timer。发现只叫醒帅位，**不自动换审官**。

- 一条命令：`node scripts/progress-watch.mjs`（指挥官每轮调同一份；`--dry-run` 只打印）。
- 原料是指挥官每 20 分钟写的 `~/.dao/commander/situation-*.json`——`commander-act.timer` 停了它就永远「没查成」。
- 机器上若还留着独立钟：`sudo bash scripts/install-progress-watch.sh`（脚本已改成卸载）。
- 探活：`systemctl list-timers --all` 里**没有** `dao-progress-watch.timer` / `dao-nudge-stalled.timer`。`scripts/server-check.mjs` ⑮ 会红独立钟还在、屏面指纹退役件还在、或指挥官没调用 `runProgressWatch`。

## server-check 三态

```bash
node scripts/server-check.mjs           # 人读
node scripts/server-check.mjs --json    # 给循环
```

退出码：`0` 全通 / `1` 有真红 / `2` 有没查成。没查成不许当通过。`--json --out` 落仓外 `~/.dao/server-check/`。脚本在 `scripts/server-check.mjs`。第⑧项认 `dao-land.timer` 在册且启用；缺了跑 `sudo bash scripts/install-land.sh`（NEW-MACHINE「land timer（#829）」）。

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

必须非 root。细节只信 §9d 坑，本页不复制。
