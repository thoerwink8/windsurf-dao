样本3：多条 dispatched 真歧义 → 待帅转交（不猜）
逐条来源（可核对，tests/fixtures/orca-returns/worker-list.json，采集 2026-08-15T18:14Z）：
- 第 1 条：存档第 113 行（本 PR #497 工位「480-478-流转器接管机械动作」dispatched 三条之一）
- 第 2 条：存档第 125 行（同上工位 dispatched 另一条）
- 第 3 条：存档第 104 行（同上工位 completed 历史一条）
dispatchId/taskId/runId/agentTerminalHandle/dispatchStatus/workerState/terminalState 逐字段回抄；
worktreeId 为快照关联改写（fixture 用 wt::worker-999 关联 PR #999），其余字段原样。
