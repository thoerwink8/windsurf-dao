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
