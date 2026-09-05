---
name: dao-inbox
description: 收件箱——别的会话（审计/巡检/另一台机器）把发现落盘到 docs/observations/，帅位每轮被提醒去读。想知道这条通道怎么工作、或要往里写东西时读。
---

# 收件箱

**别的会话给帅位留东西的落点。** 消息通道（`send_session_message`）只在帅位活着且还有下一个 turn 时才送得到，会话一关就丢；落盘跨会话存活。

## 往里写（外部会话）

1. 写 `docs/observations/<日期>-<短名>.md`，正文用中文说清：结论 / 证据 / 建议的最小改造。
2. **必须 `git add` 并提交**。不提交别的机器看不到——2026-09-05 当天就是这么漏的，两份记录停在未跟踪状态，帅位靠 `git status` 偶然看见 `??` 才知道。
3. 想标紧急度就在 frontmatter 写 `status: new`（不写也默认 new）。

## 读与处置（帅位）

每轮由全局 hook 注入一行提醒；未处置超 24 小时、或堆到 5 条、或有未提交的文件，注入的就不是提醒而是**硬性指令**：本轮先处置。

处置三选一，都要留痕：

| 怎么处置 | 怎么标 |
|---|---|
| 落成 issue / 已修 | 文件里加一行 `处置：#944` 或 `处置：已修 commit abc123` |
| 确实不做 | frontmatter 加 `status: wontfix` 并写理由 |
| 已做完不需要单 | frontmatter 加 `status: done` |

**不删文件**——它是判例档案，删掉等于把判例扔了。

## 装在哪

- 判断逻辑：`scripts/lib/inbox.mjs`（纯函数，可单测）
- 钩子：本 skill 的 `hooks/inbox-check.mjs`，登记在**全局** `settings.json` 的 `UserPromptSubmit`
- 因为是全局钩子，**每个项目都会跑**：新项目 `git clone` 完自动生效，不用装东西；仓里没有 `docs/observations/` 就静默
- 闸：`tests/inbox.test.js`

## 边界

- 钩子退出码永远 0。硬拦靠**注入硬性指令**，不靠 exit 2——exit 2 挡掉的是用户说话，拦错了对象。
- 「查不成」与「没有新东西」必须分开：目录读不了、git 查不成，都要报出来，不许静默当空。
