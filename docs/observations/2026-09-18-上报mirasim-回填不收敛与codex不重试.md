---
status: done
to: mirasim 侧（E 类 ai-gateway-stack，本仓改不动）
---

# 上报 mirasim：三件本仓查清了病、开关在 mirasim 侧的事（#1333 / #1342）

用户 2026-09-18 04:40 拍板「带证据上报」。三件各自独立，证据都在本仓 issue 里，这页只放判据和要问的那一句。

## ① 账本回填不收敛（#1333）

`mirasim-server` 每 3 分钟一轮 usage backfill，每轮报「补齐 N 行」，下一轮待补仍是 N：

```
00:30:41  待补 1629，已查询 1629，补齐 1629 行，relay 无记录 0
…（75 轮）
06:48:30  待补 1671，已查询 1671，补齐 1671 行，relay 无记录 0
```

代价：主进程 CPU 85% 持续、内存撞 `MemoryHigh=3.5G`、每小时约 3.3 万次重复 relay 查询。

**要修的一句**：「补齐」之后没有更新「待补」判据（补过的行下一轮又算待补）。本仓这边加一条巡检「连续 N 轮待补数不降 = 回填不收敛」（已派工），但只能报，修不了。

## ② codex turn 报错不重试（#1342，`attempts=1`）

7 天 645 条 codex turn，48% 上游失败（已扣掉我们自己 `turn.stop` 的 interrupted/aborted），全部 `attempts=1`，一次即丢。同机同时段对照：relay 腿 2 ok / 6 error，绕开 relay 走本地桥 4/4，pqapi 直连探针 0/3 失败。

**要问的一句**：`attempts=1` 是有意为之，还是没接重试？如果可配，在哪配。

## ③ 按 agent 关掉代理注入（#1342）

mirasim 给 codex app-server 注入 `HTTPS_PROXY=127.0.0.1:36783` + MITM CA，把传输钉在 relay；`~/.codex/config.toml` 指向的本地桥（127.0.0.1:4317）拿不到流量。

**要问的一句**：能否按 agent/profile 关掉这条注入，让 codex 走它自己配置的上游。

## 本仓已做的（不需要 mirasim 侧动）

熔断器吃真流量 + relay 独立 key + 审官顺位问熔断（#1369，已合）。这三件只让本仓少往坏腿上派，不解决腿本身。

处置：已上报完毕，三件分别挂 #1333（回填不收敛）与 #1342（codex attempts=1、代理注入）。本仓侧巡检已派工，开关在 mirasim 侧，本仓不再跟。
