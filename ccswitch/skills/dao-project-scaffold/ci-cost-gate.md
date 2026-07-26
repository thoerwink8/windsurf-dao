# CI 成本门控 · ci-cost-gate

> 治大国若烹小鲜。矩阵越大，火越急，稍不慎则额度尽而全线拒启。

**触发条件**：项目存在 `.github/workflows/*.yml`。

## 检测逻辑

1. 扫描 workflow 文件的 `on.pull_request` 触发块
2. 若关联 job 使用了 macOS 或多平台 matrix（`matrix.os` 含 `macos-latest` 等），且**没有** job 级 `if` 条件把 PR 场景收敛到单平台
3. 命中 → 提醒对照 `stacks/ci-github-actions.md` 处方收敛：PR 触发只保留主开发平台，交叉矩阵挂 main push / release tag / workflow_dispatch
4. 缺项不自动改写 workflow，建议用户参考处方自行收敛（CI 改动影响面广，不代做）

**血泪出处**：2026-07-13 mousse-cli 实证——GitHub org Free 计划每月 2000 等效分钟，macOS runner 计费系数 ×10，mac job 只占实际运行分钟 31% 却吃掉 72% 额度，月中烧穿致全线 CI 拒启（默认 spending limit $0）。治本方案见 mousse-cli PR #72，已固化为 `stacks/ci-github-actions.md` 处方。

## 检查清单

- [ ] 🤖（启发式）`.github/workflows/*.yml` 若含 PR 触发的多平台矩阵，已有 job 级 `if` 条件收敛到主开发平台。**清单里的 `ci-pr-matrix-cost` 只做子串组合判定**（同一文件含 `pull_request` 与 `macos-` 且全文无 `if:`），两个方向都构造得出反例——`if:` 写来干别的会被放过，矩阵藏在 reusable workflow 里也会被放过。精确判据仍是本文件的检测逻辑，需人跑
- [ ] 交叉平台完整矩阵只挂 main push / release tag / workflow_dispatch

缺项不自动创建，建议用户对照 `stacks/ci-github-actions.md` 处方收敛并说明理由。
