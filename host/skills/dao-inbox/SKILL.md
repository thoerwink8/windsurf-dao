---
name: dao-inbox
description: 收件箱——别的会话（审计/巡检/另一台机器）把发现落盘到 docs/observations/，指挥官盘点每 6 小时扫一次。想知道这条通道怎么工作、或要往里写东西时读。
---

# 收件箱

**别的会话给帅位留东西的落点。** 消息通道（`send_session_message`）只在帅位活着且还有下一个 turn 时才送得到，会话一关就丢；落盘跨会话存活。

## 往里写（外部会话）

1. 写 `docs/observations/<日期>-<短名>.md`，正文用中文说清：结论 / 证据 / 建议的最小改造。
2. **必须 `git add` 并提交**。不提交别的机器看不到——2026-09-05 当天就是这么漏的，两份记录停在未跟踪状态，帅位靠 `git status` 偶然看见 `??` 才知道。
3. 想标紧急度就在 frontmatter 写 `status: new`（不写也默认 new）。

## 读与处置（帅位）

指挥官盘点（`commander-inventory`，每 6 小时）会扫收件箱。未处置超 24 小时、或堆到 5 条、或有未提交的文件，盘点判红：开待拍板单并通知总控群，必须先处置。

处置三选一，都要留痕：

| 怎么处置 | 怎么标 |
|---|---|
| 落成 issue / 已修 | 文件里加一行 `处置：#944` 或 `处置：已修 commit abc123` |
| 确实不做 | frontmatter 加 `status: wontfix` 并写理由 |
| 已做完不需要单 | frontmatter 加 `status: done` |

**不删文件**——它是判例档案，删掉等于把判例扔了。

## 装在哪

- 判断逻辑：`scripts/lib/inbox.mjs`（纯函数，可单测）
- 现役挂载面：指挥官盘点 `scripts/lib/commander-inventory.mjs`（`commander-inventory.timer` 每 6 小时）
- 闸：`tests/inbox.test.js`（锁盘点调用 `assessInbox`；本页再写已死的 hook 名就红）

## 边界

- 「查不成」与「没有新东西」必须分开：目录读不了、git 查不成，都要报出来，不许静默当空。
