样本2：多条 completed 无在岗 → worker-list 无时间字段，不猜顺序 → 待帅转交
逐条来源（可核对，tests/fixtures/orca-returns/worker-list.json，采集 2026-08-15T18:14Z）：
- 第 1 条：存档第 54 行（工位「大扫除-拆旧规则」：completed 两条之一）——dispatchId/taskId/runId/agentTerminalHandle/dispatchStatus/workerState/terminalState 逐字段回抄
- 第 2 条：存档第 55 行（同工位 completed 另一条）——同上逐字段回抄
worktreeId 为快照关联改写（fixture 的 orca-worktrees.json 用 wt::worker-999 关联 PR #999），其余字段原样。
