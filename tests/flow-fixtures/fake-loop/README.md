端到端注入路径测试：当前 dispatched 工人 + 同 worktree 一条 completed 历史 → 正常返工照常注入。
注意：此组合（唯一 dispatched + 历史 completed）在真实 worker-list 存档
（tests/fixtures/orca-returns/worker-list.json，采集 2026-08-15T18:14Z）中为 0 条——属构造态，
仅用于验证「返工注入端到端路径（worker-start 动作）」；选择逻辑的各分支（dispatched 优先 /
多条 dispatched 待帅 / 唯一 completed / 多条 completed 无时间字段待帅 / failed 排除）由
tests/flow.tests.js ㊶ 纯函数单测覆盖（构造输入，明确不是工具真实语料）。不得把本夹具当真实分布。
