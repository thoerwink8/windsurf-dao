---
name: dao-stack-ci-github-actions
description: GitHub Actions CI 计费与矩阵策略处方：PR 只跑主开发平台，交叉矩阵挂 main/tag/手动触发，避免 Free 计划额度烧穿。
---

# CI 成本处方 · GitHub Actions

> 治大国若烹小鲜。矩阵越大，火越急，稍不慎则额度尽而全线拒启。

## 触发

- 项目新建/审计 `.github/workflows/*.yml`
- CI 矩阵新增平台（尤其 macOS）
- Free 计划组织排查「CI 突然跑不动」

## 铁律：PR 触发只跑主开发平台

PR 阶段 CI 的目的是**快速反馈**，不是**编译保险**。只在 PR 触发上跑项目行为验证实际依赖的**真机 dogfood 平台**（通常是开发者日常真机所在平台）；跨平台交叉编译矩阵挂到 main push / release tag / workflow_dispatch——合入后兜底，不占 PR 迭代额度。

## 计费认知表（GitHub Actions 分钟计费系数）

| Runner | 计费系数 | 备注 |
|---|---|---|
| ubuntu-latest | ×1 | 基准 |
| windows-latest | ×2 | |
| macos-latest | ×10 | 实际运行时间占比小，但吃额度最狠 |

**死亡组合**：GitHub Free 组织计划每月 2000 等效分钟 + 默认 spending limit **$0**——额度一烧穿，全线 CI 直接拒启（不是降速，是拒启）。2026-07 mousse-cli 实证：macOS job 只占实际运行分钟 31%，却吃掉 72% 等效额度，月中烧穿。

**查账单用量**（一行）：
```sh
gh api /orgs/<org>/settings/billing/usage
```

## 推荐实现形态：单 job + `strategy.matrix` 里直接算出矩阵成员

不要拆成两个平行 job（一个 windows-only 给 PR，一个三平台给 main）——步骤清单会漂移不同步。
用同一个 job，**在 `strategy.matrix` 里按触发事件算出矩阵成员**：

```yaml
on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
  workflow_dispatch:

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        # PR 场景只留主开发平台；push(main) / tag / 手动触发跑满交叉矩阵。
        # ⚠ 折行用 `>-` 折叠标量，且续行**缩进必须与首行内容对齐**——YAML 折叠标量里
        # "更深缩进的行"会保留换行而不折叠，对不齐就会把换行留在表达式里。
        os: >-
          ${{ github.event_name == 'pull_request'
          && fromJSON('["windows-latest"]')
          || fromJSON('["windows-latest","macos-latest","ubuntu-latest"]') }}
    runs-on: ${{ matrix.os }}
    steps: [...]
```

要点：`matrix.os` 的值本身就是一个表达式，求值结果是**数组**——故用 `fromJSON` 把 JSON
字符串转成数组，不能直接写 YAML 列表（表达式位置不吃列表字面量）。

### 🔴 铁律：matrix 上下文严禁出现在 `jobs.<job_id>.if`

**`jobs.<job_id>.if` 的合法上下文只有 `github` / `needs` / `vars` / `inputs`，不含
`matrix` / `strategy`**——GitHub 先求值 job 级 `if`，之后才展开 matrix，那一刻 `matrix`
根本还不存在。写了即 **invalid workflow file**。
而 `jobs.<job_id>.strategy` 的合法上下文**含 `github`**，所以同一个条件挪进 `strategy`
就是合法的（两条同源，出自官方 **Context availability** 表：
<https://docs.github.com/en/actions/reference/workflows-and-actions/contexts>，
2026-08-01 实查复核）。

**为什么这条要单独立成铁律**：这个错误的失败形态**极难归因**——invalid workflow 不触发
任何 job 起跑，run 页面是 **0 jobs 直接失败、日志里什么都看不到**，很容易被当成"代码问题"
去排查。mousse-cli 曾因此**连续九天 CI 全挂零**（2026-07-13～07-22），而这段错误处方
**本身就写在本文件里**（旧版「推荐实现形态」给的正是 job 级 `if` 引 `matrix.os`），
到 2026-08-01 才被审计捞出——**照抄一份处方之前，先确认它跑起来过。**

出处：mousse-cli `.github/workflows/ci.yml`（PR #72 立形态，此后按上述教训订正为 matrix 表达式）。
yaml 顶部留一段注释钉死账单依据（数字 + 结论）**与这条失败教训**，防止后人"顺手"改回全矩阵
或改回 job 级 `if`——同样的注释纪律建议随处方一起搬过去。

## 私有仓库额外提醒：额度烧穿时的代偿

私有仓库没有免费额度豁免，额度烧穿即 CI 全线拒启，不能干等账单周期重置。代偿方案：**本地全量验证背书合并**——测试 + lint/clippy + 构建 + 项目红线脚本全跑一遍，验证通过即可合并，PR 留档说明「CI 额度烧穿，本地全量验证替代」。出处：mousse-cli 2026-07-13 夜战先例。

## 与 scaffold 门控的关系

本处方是 `dao-project-scaffold` CI 成本门控检查项（见 `ci-cost-gate.md`）的落地参考；scaffold 阶段发现 `pull_request` 触发含 macOS/多平台矩阵且无条件跳过时，指向本文件收敛。
