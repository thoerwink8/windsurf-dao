---
reviewed: 2026-09-19
---

# 指挥官 + Fusion v2：贴近 Devin Fusion 的落地方案

> 起因：用户 2026-09-18 拍板——Devin Desktop 的 Fusion 设计很好，希望 windsurf-dao 在法国 VPS 上
> 用**尽可能贴近**的方式实现，**保留指挥官 + fusion**；任务清单要可观察；要有从头到尾的计划；
> 中途发现断链就补进清单并修复继续；**最终合入 `master`**。
>
> 可观察清单：[#1460](https://github.com/thoerwink8/windsurf-dao/issues/1460)（主清单 + 进度流水）。
> 决策与证据总账：[#816](https://github.com/thoerwink8/windsurf-dao/issues/816)。

## 一、Devin Fusion 的架构要点（官方 2026-09-11）

1. **两个并行 agent，各有持久上下文与工具**——不是共享一段对话，也不是串行接力。
2. **lead = 前沿模型**：计划、歧义解释、**审查**；**永远是最终权威**，sidekick 力不从心时 lead
   **收回控制权**。
3. **sidekick = 成本高效模型**：探索代码、实现改动、跑测试、报告回来。
4. **只交换 brief / result / feedback**：不传整段历史；两边各自吃满 prompt cache。
5. **配对（pairing）是一等概念**：lead + sidekick（+ effort + fast mode）一起选；官方推荐 Fable 5.1 + SWE-2。
6. **反「模型路由」**：路由靠初始 prompt 猜难度，猜不准；中途换模型还会破坏 cache。Fusion 不猜。
7. **评价口径是「价格/任务」而不是「价格/token」**：更强的模型常让整体更便宜（少返工 → lead 少烧轮）。
8. **harness 按配对调**：同一套指令对 A 配对好、对 B 可能更差。

## 二、我们的架构（保留指挥官 + fusion，按 Fusion 收口）

```
指挥官（外层，持久工作流）
  · 任务身份 dao/<仓>/issue/<号>/g<代>（贯穿所有代次）
  · 排队、租约、恢复、取消、证据、合并、关单
  └── 一个任务（内层配对）
        lead（前沿腿，永远主导）   ← 计划 / 歧义解释 / 复核 sidekick 产出 / 可收回控制权
        sidekick（成本高效腿）      ← 探索 / 实现 / 跑测试 / 报告
        verify（系统）              ← CI 证据（不让模型自称）
        review（异厂独立会话）       ← 质量闸：与 executor 必须不同厂，绑定确切 HEAD
        integrate / closeIssue（系统）← 合并前回读 head+目标枝；关单后回读 CLOSED
```

### 2.1 配对规范（T13）

- **lead 只由前沿腿担任**：不许因为「任务看起来简单」把 lead 降级——这是 Fusion 反路由原则的直接落地。
- **sidekick 按能力 + 可用性 + 成本 + 历史成功率选**（`scripts/lib/leg-choice.mjs` 的判据顺序不变）。
- **配对是一等输出**：`leg-choice` 除了单腿候选，还要给出 `pairing = { lead, sidekick, reasons }`，
  含「lead 的推荐 sidekick」；CLI 支持 `--pairing` 直接起配对。
- **配对级历史**：成功率按「配对」统计（T15），不只按单腿。

### 2.2 两级质量闸（T14）——我们比 Devin 更严的地方

| 闸 | 谁 | 管什么 | 为什么保留 |
|---|---|---|---|
| 第一级：lead 复核 | 同任务 lead（前沿腿） | sidekick 的产出是否满足计划与成功判据；不满足 → 给 feedback 返工 | Fusion 原设计：lead 是最终权威，能收回控制权 |
| 第二级：异厂独立审查 | 独立会话（family ≠ executor） | 代码质量与风险（P1 阻塞 / P2P3 建议），绑定确切 HEAD | Devin Fusion 没有异厂审查；我们的质量要求更高，这条不能丢 |

判定仍全在代码里（`packages/fleet/src/contract.mjs`）：P1 阻塞、轮次上限、旧 HEAD 证据一律不放行。

### 2.3 上下文模型（T7）

- 现状已符合「只交换结构化产物」：`plan` / `commit SHA + PR` / `checks` / `findings` 四类。
- 缺的是 **lead 的持久上下文**：现在每轮重建。v2 目标：ACP 用 `session/load` 续；mirasim 侧走
  「新会话 + checkpoint（计划/证据/反馈压缩进 brief）」，不重发全史。

### 2.4 并行（T5）

- Fusion 的两个 agent 是**并行**的。我们第一版先做**只读研究扇出**（lead 出 N 个研究问题 → 系统并行起
  N 个只读会话 → 摘要回 lead），因为不动证据链；**并行实施扇出**（N 条工作流各自合并）留后续。
- 约束不变：一树一会话租约、渠道并发闸、每子会话可异厂。

### 2.5 评价口径（T15）

- 每任务记录：lead / sidekick 各自 token 与成本、审查轮数、返工次数、是否一次过。
- 用来回答「这个配对价格/任务是多少」，而不是比 token 单价——与 Fusion 的口径一致。
- 数据源已有：`~/.mirasim/insights` 用量账本 + `~/.dao/execution/sessions` 终态记录。

### 2.6 本地（Local）

腿全部跑在 VPS 本地（ACP `route=local` / mirasim 本机服务端）；代码不出本机。这与 Devin Local 的
「执行面在本地」一致，写进设计以免后人误改成远端。

## 三、任务表

见 [#1460](https://github.com/thoerwink8/windsurf-dao/issues/1460) 的表格（T1–T17），状态随进度更新在
该 issue 的 `[进度]` 评论里。每个任务的落地 = 一个 PR（CI `check` 绿 + 独立跨厂复核 + 合入 master）。

## 四、断链自愈

真跑、复核、上游任何一环断链 → 当场记进 #1460（新任务或既有任务下加一行）→ 修复 → 补证据 → 继续。
断链不隐藏、不静默跳过。已知的断链类型与处置：

| 断链 | 处置 |
|---|---|
| 会话卡权限提问（白名单外命令） | 判断是否树内只读：是 → 补白名单；不是 → 停手报人（fail-closed） |
| 上游容量/断流（503、超时） | 判可重试，退避重试；不折成「审查没做完」 |
| 会话未知态（unknown） | 先宽限；宽限用尽停会话让树，不让重试撞租约 |
| 工作区残留（半注册树、残留目录） | 有界复位：无提交且会话终态才允许重建 |
| 证据读不到（合并/关单未回读） | 一律不放行，停手等人 |

## 五、验收

1. 全部任务合入 `master`（每笔 CI 绿 + 独立跨厂复核）。
2. 法国 VPS 上真跑：issue → 建树 → lead 计划 → sidekick 实现 → 验证 → lead 复核 → 异厂审查 → 合并 → 关单。
3. 断链记录可查（#1460 的 `[断链]` 评论）。
4. 证据全部回读（`temporal workflow query` + GitHub 结构化查询），未回读不算完成。
