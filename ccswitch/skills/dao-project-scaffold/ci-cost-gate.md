# CI 成本门控 · ci-cost-gate

> 治大国若烹小鲜。矩阵越大，火越急，稍不慎则额度尽而全线拒启。

**触发条件**：项目存在 `.github/workflows/*.yml`。

## 检测逻辑

1. 扫描 workflow 文件的 `on.pull_request` 触发块
2. 若关联 job 使用了 macOS 或多平台 matrix（`matrix.os` 含 `macos-latest` 等），
   **判「PR 场景下矩阵成员收没收敛」**——即 `pull_request` 事件下实际展开出来的
   `matrix.os` 是不是只剩主开发平台。收敛的合法落点是
   **`jobs.<job_id>.strategy.matrix` 里的 `github.event_name` 表达式**（`fromJSON` 三元式）
3. 🔴 **同时判一条硬错**：`jobs.<job_id>.if` 里出现 `matrix.*` / `strategy.*` ⇒ **invalid
   workflow file**，该 workflow 每次 run 都是 0 jobs 直接失败（`jobs.<job_id>.if` 的合法
   上下文只有 `github`/`needs`/`vars`/`inputs`）。**这不是省钱问题，是 CI 根本没在跑**，
   命中即最高优先级——mousse-cli 曾因此连续九天 CI 全挂零而无人察觉
4. 命中 → 提醒对照 `stacks/ci-github-actions.md` 处方收敛：PR 触发只保留主开发平台，
   交叉矩阵挂 main push / release tag / workflow_dispatch
5. 缺项不自动改写 workflow，建议用户参考处方自行收敛（CI 改动影响面广，不代做）

**血泪出处**：2026-07-13 mousse-cli 实证——GitHub org Free 计划每月 2000 等效分钟，macOS runner 计费系数 ×10，mac job 只占实际运行分钟 31% 却吃掉 72% 额度，月中烧穿致全线 CI 拒启（默认 spending limit $0）。方案由 mousse-cli PR #72 立形态，固化为 `stacks/ci-github-actions.md` 处方。

⚠️ **第二笔血泪，比第一笔更贵，因为它一度就写在这份处方里**：PR #72 的首版把收敛条件写在
`jobs.<job_id>.if` 里引 `matrix.os` ⇒ invalid workflow ⇒ **2026-07-13～07-22 连续九天
每次 run 0 jobs 直接失败**，而这种失败**不触发任何 job、日志里什么都看不到**，极易被当成
"代码问题"排查。项目侧已订正为 `strategy.matrix` 表达式，**但订正没回流 dao——本文件与
`stacks/ci-github-actions.md` 直到 2026-08-01 审计才被捞出仍在教错的写法**。
⇒ 这条同时是一条元教训：**项目侧订正了一个从 dao 抄下去的处方时，回流是订正的一部分，
不是可选项**。

## 检查清单

- [ ] 🤖（启发式）`.github/workflows/*.yml` 若含 PR 触发的多平台矩阵，PR 场景的矩阵成员已收敛到主开发平台。**清单里的 `ci-pr-matrix-cost` 只做子串组合判定**（同一文件含 `pull_request` 与 `macos-`，且全文既无 `if:` 也无 `fromJSON`），两个方向都构造得出反例——`if:` 写来干别的会被放过，矩阵藏在 reusable workflow 里也会被放过。精确判据仍是本文件的检测逻辑，需人跑
- [ ] 收敛写在 `strategy.matrix` 表达式里；**`jobs.<job_id>.if` 中零 `matrix.*` 引用**（写了即 invalid workflow，0 jobs 静默全挂）
- [ ] 交叉平台完整矩阵只挂 main push / release tag / workflow_dispatch

缺项处置见 SKILL.md §缺项怎么处置。本文件的修法是**改用户既有的 workflow**（收敛矩阵），动的不是新建面 ⇒ 落**丙档：只建议不代做**，对照 `stacks/ci-github-actions.md` 处方给出改法与理由，由用户落笔。
