# 谋线详细规范（Spec Thread）

> 图难于其易，为大于其细。

## §2 核心文件集

每个 loop 独占 `docs/specs/<topic>/`：

| 文件 | 必须 | 职责 |
|------|------|------|
| `spec.md` | ✅ | 定位、背景、目标、方案、范围、风险、依赖 |
| `strategy.md` | ✅ | HOW 决策：技术选型、组件策略、验证策略、ADR |
| `acceptance.md` | ✅ | 功能验收、回归验收、边界条件 |
| `plan.md` | ✅ | 2-5 分钟粒度任务清单、覆盖矩阵 |
| `STATUS.json` | ✅ | 状态机 + 锁 + 进度 + 调度 + Loop 类型 |

### 命名规则

从 spec 主题自动提取语义化短名：
- 英文 kebab-case，2-4 词：`report-export`、`sidebar-search`
- 中文主题自动翻译
- 禁止 `loop-a` / `loop-1` 无意义编号

### Optional docs

AI 根据复杂度判断，常见：
- `api-spec.md`（涉及 API）
- `ui-spec.md`（涉及 UI，有 design/ 目录走 `/dao-design`（open.md））
- `schema.md`（涉及数据库）
- `migration-plan.md`（数据迁移）

### 文档模板

模板文件位于 `templates/` 子目录，谋线时按需读取：

| 文件 | 模板路径 | 核心结构 |
|------|---------|---------|
| spec.md | `templates/spec-template.md` | 定位→背景→目标→方案→范围→风险→依赖 |
| strategy.md | `templates/strategy-template.md` | 达成度维度 + ADR + 组件策略 + 验证策略 |
| acceptance.md | `templates/acceptance-template.md` | 功能验收表 + 回归验收表 + 边界条件 |
| plan.md | `templates/plan-template.md` | 任务清单（2-5min 粒度）+ 覆盖矩阵 |

## §3 STATUS.json 协议

```json
{
  "version": "1.0",
  "topic": "report-export",
  "type": "design | feature | refactor | fix | infra",
  "summary": "一句话描述（从 spec 定位段提取）",
  "created": "...",
  "lock": { "holder": "session-id", "host": "claude-code", "acquired_at": "...", "expires_at": "...", "heartbeat": "..." },
  "thread": "spec | dev | done",
  "mode": "skeleton | filling | ready | go | executing | reviewing | done | abandoned",
  "docs": { "spec": {"status":"skeleton|draft|done"}, "strategy": {...}, "acceptance": {...}, "plan": {...} },
  "go_ready": false,
  "dispatch": { "branch": "feat/<topic>", "worktree_path": null, "dispatched_at": null, "worker": null },
  "execution": { "current_task": null, "completed_tasks": [], "total_tasks": 0 },
  "depends_on": null, "merged_into": null
}
```

**锁**：TTL 10 分钟 + 心跳续期，过期即可抢，崩溃自动释放。

**状态转换**：谋线 `skeleton→filling→ready→[用户确认]→go` | 造线 `go→executing→reviewing→[用户确认归档]→done` | 回退 `executing→filling` | 用户追加 `reviewing→executing` | 终止 `任意→[用户确认]→abandoned`

## §4 谋线（Spec Thread）

> 图难于其易，为大于其细。

**流程**：主线程编排 → subagent 生成 → 用户确认 → 修改 → 再确认

1. 创建 `docs/specs/<topic>/` + STATUS.json（含 `type` 字段），文档标 `skeleton`
2. **🎨 设计目录检测**（见下方增强段）
3. **🔍 诊断扫描**（`type: refactor | audit` 必做，见下方增强段）
4. **派发 `dao-brainstormer` subagent** 生成 spec.md → 用户确认 → 标 `done`
5. 主线程从 spec 推导 acceptance.md → 用户确认 → 标 `done`
6. **主线程生成 strategy.md** → 用户确认 → 标 `done`（见下方「strategy.md 生成」段）
7. **派发 `dao-plan-writer` subagent** 生成 plan.md → 用户确认 → 标 `done`
8. 交叉校验：plan 覆盖矩阵 ↔ acceptance 每项都有 Task 覆盖
9. **项目 rule 检查**：按 Loop type 检查是否需要创建/更新项目级 rule 文件（见下方）
10. 全部 done + 校验通过 → `go_ready: true`

### 设计对齐增强（design/ 自动检测）

**谋线步骤 2**：若需求涉及 `design/` 目录，**必须先走 `/dao-design`（Read open.md §1 + §1.5）**（全页面清点 + 三层 Diff），结果注入 spec 输入。plan 覆盖矩阵增加页面×层级维度，任务排序强制 top-down（共享结构→布局→节→组件），交叉校验要求所有页面三层均有 Task 或显式 deferred。

### 诊断扫描（refactor / audit 型必做）

> 不知常，妄作凶。未诊断就开方 = 妄作。

**谋线步骤 3**（`type: refactor` 或 `type: audit` 时必做，`feature` / `fix` 跳过）：在 brainstormer 生成 spec 之前，先派 subagent 扫描目标系统现状，产出诊断报告。

**扫描维度**（按目标系统调整）：
- **引用图谱**：模块/文件/skill 之间的引用关系，谁引用谁、被引用几次
- **孤岛检测**：被引用 0 次且无触发路径的模块
- **重叠分析**：description 或职责高度相似的模块对
- **缺口扫描**：常见场景无覆盖、单向引用（A→B 但 B 不知 A）

**产出**：结构化诊断报告，注入步骤 4 brainstormer 的输入。brainstormer 必须**从诊断发现推导 spec 方向**，不从用户目标直接推导解法。

**跳过条件**：`type: feature`（用户需求明确）、`type: fix`（根因分析由 debugger 覆盖）。

### 开工包注入（项目含 kit.json 时）

项目存在开工包（根目录 `kit.json` manifest，文档落位 `docs/kit/`）→ 步骤 4 的 brainstormer 输入 = kit 文档集（同 refactor 型注入诊断报告的方式），spec.md 从 kit 对应功能块推导（FRONTEND/BACKEND 每块的 定位/目标/范围 与 spec-template 字段对齐，可机械抽取），不从用户目标从零挖掘。步骤 5 的 acceptance.md：kit ACCEPTANCE 对应功能块分节若已是 acceptance-template 三表格式 → 直接采用，只补「待 dao 补命令」占位的验证命令。

### strategy.md 生成

**步骤 6**：主线程根据 spec + acceptance 按 `type` 生成——design 侧重组件策略+视觉验证，feature 侧重 ADR+API 契约，refactor 侧重迁移路径+兼容，fix 侧重根因+回归防护，infra 侧重工具链+CI/CD。每个 Loop 必须定义达成度维度（功能完整度/验收通过率/视觉保真度/测试覆盖/回归安全/文档同步），§7 归档时逐维度打分，未达标不可归档。

### 项目 rule 检查

**谋线步骤 9**（Go Gate 前最后检查）：按 `type` 检查 `.claude/rules/` 是否缺必要文件——design 需 `design-tokens.md`+`design-spirit.md`，feature/refactor 需 `architecture.md`（+`testing.md`），全部需 `CLAUDE.md` <80 行。缺则创建/提醒。归档时同步造线中新增的规范。

### subagent 调度

谋线主线程是**编排者**：诊断扫描派 fork subagent（refactor/audit 型），spec.md 派 `dao-brainstormer`（苏格拉底式挖掘，refactor 型必须以诊断报告为输入），acceptance.md 主线程直接写，strategy.md 主线程直接写，plan.md 派 `dao-plan-writer`（拆任务+代码模板）。subagent 返回后展示关键段落给用户确认，确认后更新 STATUS.json。
