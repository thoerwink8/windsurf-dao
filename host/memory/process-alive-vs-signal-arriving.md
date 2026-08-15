---
name: process-alive-vs-signal-arriving
description: 「进程在跑」和「信号进得来」是两件事——闭环不动时先验信号源有没有产出，别只验消费者活着
metadata:
  type: feedback
---

2026-08-16 实咬：#513/#514/#515 三个 PR「从无审读」，而 `scripts/flow.mjs` **两个实例都在跑**（PID 36656/48708）。
不是没跑，是**信号进不来**：流转器的完工判据是「PR 评论首行以『完工』开头」（`scripts/lib/judgment.mjs:55` `isCompletionComment`），
而工人实际发的是 orchestration 的结构化 `worker_done`（我在 `orca orchestration check` 里收到了，但三个 PR 的 issue comments 全空）。
`deriveState` 停在 `working` → `pendingAction` 返回 null → 永远不起审官，**且不报错**。

**Why**：一条通道在跑、另一条通道的信号进不来，外部表现与「守卫崩了」「还没轮到」完全一样——全是「什么都没发生」。
`ps` 看到进程活着反而给了错误的安心感，把排查引向「是不是还没到轮询点」。这是本仓 CLAUDE.md 那条
「『扫完查出 0 条』与『这次没扫到任何样本』必须分得开」在**跨进程通道**上的同一种失效。

**我诊断时先猜错一次**：以为判据是 orca worktree comment（因为 `dispatchComment` 写的就是那里），
查了 comment 格式对不上就差点下结论。正解是**读消费者代码**看它到底 subscribe 什么——
猜判据和猜字段路径是同一类错（见 [[dispatch-regex-corpus-and-stall]] 的 `result.terminal.tail`）。

**How to apply**：
1. 闭环不动时的诊断序：① 信号源产出了吗（去消费者读的那个地方看，不是去发送方看）② 消费者在不在跑 ③ 判据格式对不对。
   顺序反了就会在「进程活着」上原地打转。
2. 判据格式**读代码确认**，不靠推测——发送方写在哪 ≠ 消费者读哪。
3. 设计跨进程闭环时，「收到 0 个信号」必须与「运行正常无事可做」在日志上可区分，否则静默失效不可见。

同源：[[grep-scope-main-vs-inflight]]（查证范围不对）、[[monitor-self-check-design]]（挂监视前先问它怎么坏）。
