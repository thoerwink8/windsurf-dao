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

## 推荐实现形态：单 job matrix + job 级 if 条件跳过

不要拆成两个平行 job（一个 windows-only 给 PR，一个三平台给 main）——步骤清单会漂移不同步。用同一个 job + matrix + 条件表达式：

```yaml
on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
  workflow_dispatch:

jobs:
  build:
    if: github.event_name != 'pull_request' || matrix.os == 'windows-latest'
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, macos-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps: [...]
```

出处：mousse-cli PR #72（`.github/workflows/ci.yml`）。yaml 顶部留一段注释钉死账单依据（数字 + 结论），防止后人"顺手"改回全矩阵——同样的注释纪律建议随处方一起搬过去。

## 私有仓库额外提醒：额度烧穿时的代偿

私有仓库没有免费额度豁免，额度烧穿即 CI 全线拒启，不能干等账单周期重置。代偿方案：**本地全量验证背书合并**——测试 + lint/clippy + 构建 + 项目红线脚本全跑一遍，验证通过即可合并，PR 留档说明「CI 额度烧穿，本地全量验证替代」。出处：mousse-cli 2026-07-13 夜战先例。

## 与 scaffold 门控的关系

本处方是 `dao-project-scaffold` CI 成本门控检查项（见 `ci-cost-gate.md`）的落地参考；scaffold 阶段发现 `pull_request` 触发含 macOS/多平台矩阵且无条件跳过时，指向本文件收敛。
