样本4：failed 一律排除（不是可投递目标）→ dispatched 被选，注入照常
多历史 dispatch 形态字段取自真实 orca orchestration worker-list 存档
(tests/fixtures/orca-returns/worker-list.json，采集 2026-08-15T18:14Z：
带 worktreeId 工位 111 个，其中 21 个已有多条历史 dispatch；本 PR 工位 11 条)。
