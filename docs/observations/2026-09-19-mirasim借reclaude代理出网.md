---
title: mirasim 借 reclaude 写进 ~/.claude/settings.json 的代理出网——每分钟一条 haiku 400
date: 2026-09-19
status: done
---

# mirasim 借 reclaude 的代理出网，reclaude 面板每分钟一条 haiku 400

处置：本文件同一 PR（unit 加两个 mirasim 开关 + server-check ㉕）。

## 症状

reclaude 面板上 `claude-haiku-4-5-20251001` 请求每 30–60 秒一条，状态 400「不是 Claude Code 客户端」，
设备全是 `vmi3551059·linux-amd64`（法国 VPS），未扣费。用户怀疑本机 hook。

## 链条（每一步都有实证）

1. reclaude v1.4.0 启动时把 `HTTPS_PROXY=http://127.0.0.1:<daemon端口>` + `NODE_EXTRA_CA_CERTS=~/.reclaude/ca.pem`
   写进 `~/.claude/settings.json` 的 `env`（root 与 orca 两份都是）。
2. mirasim server 有一条「借用智能体出网配置」逻辑（`server.cjs` 里 `tMs=[{agent:'claude', file:~/.claude/settings.json}]`，
   `Ro('NO_AGENT_EGRESS')==='1'` 时跳过）：读到这份 env 就当**自己**的出网代理与信任链。
3. 于是 mirasim 自己的出网全从 reclaude 穿出去：`ss` 看连着 reclaude 端口（root 45141 / orca 33257）的只有两个
   mirasim server 进程；reclaude 的 `passthrough.json` 里 `auth.mirasim.ai` / `relay.mirasim.ai` 的 CONNECT 也在。
4. haiku 那条是 mirasim 的**账号额度探针**（`vAn='claude-haiku-4-5-20251001'`、请求头 `x-mirasim-probe`），
   受 `MIRASIM_ACCOUNT_USAGE_PROBE` / `setting.json.accountUsageProbe` 控制（`EV()`），只刷新 `kind==='oauth'` 的
   本地账号窗口——**云端额度走 relay 账本，另一条路**。reclaude 只认真 Claude Code 指纹，探针 400，
   拿到 `unknown` 下一轮再试，永不收敛。两个 reclaude 守护的 `daemon.log` 各自每 1–2 分钟一条 `non-cc-client`。
5. 本仓机制没参与：只装 `mirasim-server.service`，不写 `agentLaunch`、不写 settings env。

## 真正的代价不是面板噪音

relay 流量依赖 reclaude 守护活着——reclaude 一挂，审官/工人的 relay 腿跟着断，报警长得跟 reclaude 毫无关系。

## 处置

- `host/machine/systemd/mirasim-server.service` 加 `MIRASIM_NO_AGENT_EGRESS=1`（不借代理，根治）与
  `MIRASIM_ACCOUNT_USAGE_PROBE=0`（关探针；这台机 `agent_accounts=[]`，探针本来没消费者）。
  两个都是 mirasim 自带开关，不是补丁。会话不受影响：会话的代理是 reclaude 给自己子进程配的。
- 实测：23:47 重启后，orca 与 root 两份 `daemon.log` 的 `non-cc-client` 均为 0，mirasim 进程不再连 reclaude 端口，
  `mirasim usage backfill · relay meter` 照常。
- root 的 `/root/.mirasim-remote`（桌面 Mirasim 用 root 账号 remote-ssh 连上来自动拉的，今日 20:28 起）已手动停；
  `/root/.mirasim/setting.json` 写了 `accountUsageProbe:false` 兜底。它每次 root 连接都会重生，
  根治是桌面端改用 orca 账号连（NEW-MACHINE 已记）——与 `2026-09-18-root会话在服务用户主树跑git.md` 同一起因。
- 机制：server-check ㉕ 读 `~/.reclaude/logs/daemon.log`，最近 30 分钟有 `non-cc-client` 判红；
  日志不在/无时间戳/守护 24h 没写判 unknown（没样本≠0 条）。self-test 带故意样本。

## 查法记一笔

判「谁在打这条请求」：先看面板的设备列（机器），再 `ss -tnp` 看谁连着代理端口，最后才去翻打包代码。
这次先 grep 本仓、再 grep 服务器配置，都没命中——**代码里没有 ≠ 没人在发**，连接表才是硬证据。
