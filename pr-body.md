## 目标

master 卡 comment 的定界区在派工 / 清卡 / 合并三个事件点全量重写为当前在途单号（写时即对）。复用 `mutateWorktreeComment`，不走 watchdog 轮询、不注入 `/rename`。署名 issue #684（关单交给 `scripts/close-issues.mjs`）。

## 验收标准

- [x] 造新增：盘面多一张带单号的卡 → master 定界区出现该号
- [x] 造删除：卡从盘面消失 → 该号从定界区消失
- [x] 造假号：手改 master 定界区塞不存在的号 → 下一次事件后收敛
- [x] 造多帅：无法分辨归属，定界区写全体在途单（退化行为有测试钉）
- [x] 盘面没查成 ≠ 在途 0：ps 失败不许把定界区抹空
- [x] 卡名里的 `#N` 不算判据（#589）；外仓卡不算（#492）
- [x] 过期前缀「各自在途单号见各自终端标题」改为「在途单号见定界区」
- [x] `node --test tests/master-title.test.js tests/dao.test.js tests/flow.test.js tests/board-hook.test.js` 相关绿
- [x] `node scripts/dao-check.mjs` 不新增红项（全仓两项红：open 未在做超阈、账本断流，本单未动）
- [x] PR 正文不写 GitHub 自动关单词

## 进展

- [x] 空提交撑分支、开 draft PR #685
- [x] `syncMasterTicketZone`：全量重写 + 回读
- [x] 挂点：`dao.mjs dispatch` / `worktree-rm` / `flow.mjs` MERGED
- [x] 四条故意构造样本 + 没查成负控
- [x] 文档：dispatch skill 命名条补 master 卡钩子
- [x] 返工：过期前缀改为在途单号见定界区
- [x] rebase 到 origin/master（#680/#689 已合）

## 体系类改动

1. 谁提的，发生在什么场景？2026-08-21 用户拍板。#545「watchdog 轮询 + 注入 /rename 纠正帅位标题」被 grill-ai 从零拷问推翻：同一目标第 2 层补丁、检测-纠正式、抢输入框（#644）、且 watchdog 已停摆（#683）。要的是面板上的在途单号在事件发生时就是对的。

2. 删哪一层能让这个问题不存在？删掉「写错了再巡检纠正」这一层。单号只在三个会改变盘面的事件点从 `worktree ps` 全量重写进 master 卡定界区。没有事件就没有纠偏——长静默期内的手改是拍板取舍，不另造轮询。

3. 如果从零重做，今天还会造它吗？会造「事件点全量重写定界区」。不会造 watchdog 轮询、不会造终端 `/rename`，也不会造 board-hook 每轮 sync。

## 设计阶段

issue #684 已消歧（grill-ai 推翻 #545 后用户点事件钩子）。解空间已收敛，本单不重出盲设计题。
