样本2：多条 completed 无在岗 → worker-list 无时间字段，不猜顺序 → 待帅转交
多历史 dispatch 形态字段取自真实 orca orchestration worker-list 存档
(tests/fixtures/orca-returns/worker-list.json，采集 2026-08-15T18:14Z：
带 worktreeId 工位 111 个，其中 21 个已有多条历史 dispatch；本 PR 工位 11 条)。
