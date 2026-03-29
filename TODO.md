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

### W1: 工作流无为化审查 *(2026-03-29)*

11个工作流全部审查。dao-cycle.md 和 dao-dev.md 两处违反无为原则，其余9个干净。教训：不为减法而减法——“大多数是好的”同样是有价值的结论。

### W2: dao-dev.md 接入知识归位 *(2026-03-29)*

dao-dev.md 涅槃阶段补入“若项目有 AGENT_GUIDE.md，写入演化条目”，与 autopilot 范式一致。

### W3: dao.ps1 sync 变更摘要 *(2026-03-29)*

sync 完成后显示 `git diff --stat` 摘要（源文件有未提交变更时），否则显示最新版本 commit。解决“全 [skip] 无可见性”问题。

### W4: dao.ps1 status 健康状态矩阵 *(2026-03-29)*

`dao.ps1 status`（无参数）扩展为显示所有注册项目的 TODO.md / AGENT_GUIDE.md 存在状态矩阵，便于查看新范式落地情况。

---

## 🚧 待实现

*无待实现项目。*
