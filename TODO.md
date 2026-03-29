# windsurf-dao · TODO

> 唯一的"要做什么"清单。架构/教训见 AGENT_GUIDE.md，部署机制见 MIGRATION.md。

---

## ✅ 已完成

### dao-autopilot.md 真融合重构 *(2026-03-29)*

废除 plan.md / archive/ 平行系统。TODO.md 为任务唯一载体，AGENT_GUIDE.md 为知识唯一归宿，state.json 仅存执行元数据。

### dao-commit.md 无为化 *(2026-03-29)*

移除"禁止 AI 自动执行 git commit"显式禁令和"推荐模式"章节。回归原则表达：commit 是用户对历史的主动声明，流程自然引导。

### windsurf-dao 自身接入 TODO.md + AGENT_GUIDE.md *(2026-03-29)*

身教重于言教。windsurf-dao 推广的范式，自身先实践。

### 同步前自审门 *(2026-03-29)*

AGENT_GUIDE.md §三 新增"同步前自审"工作流约定（无为审视 / 知识归位 / 减法确认），固化"修道先于传道"原则。教训 T7：流程约定写进 AGENT_GUIDE.md，不靠"记住"来执行。

---

## 🚧 待实现

### W1: 审查其余工作流的"法令滋彰"问题 *(2026-03-29 已完成)*

11个工作流全部审查。只有 dao-cycle.md 和 dao-dev.md 两处真正违反无为原则，其余9个干净。教训：审查结论是"大多数是好的"同样有价值——不为减法而减法。

### W2: dao-dev.md 接入项目知识文件 *(2026-03-29 已完成)*

dao-dev.md 涅槃阶段补入"若项目有 AGENT_GUIDE.md，写入演化条目"，与 autopilot 范式一致。

---

### W3: dao.ps1 sync 变更检测优化 `P2`

**现状**：sync 输出全部为 `[skip]`（symlink 已是最新），但无法区分"真的没变"和"symlink 指向源文件已变"。对用户而言缺乏可见性。

**需求**：sync 完成后显示"本次传播影响了哪些内容"摘要（当源文件有 git diff 时）。

- [ ] 分析 dao.ps1 sync 实现
- [ ] 考虑是否在 sync 后运行 `git diff --stat` 给出本次变更摘要

---

### W4: 注册项目健康状态报告 `P3`

**需求**：`dao.ps1 status` 扩展，显示每个注册项目是否已有 TODO.md 和 AGENT_GUIDE.md（新范式的落地情况）。

- [ ] 扩展 `dao.ps1 status` 命令
- [ ] 输出：`✓ TODO.md` / `✗ AGENT_GUIDE.md` 状态矩阵

