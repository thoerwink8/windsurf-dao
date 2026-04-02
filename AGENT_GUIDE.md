# windsurf-dao · Agent 指南

> 本文件是 windsurf-dao 的活体知识库。每次修改必须记录演化条目。
> 项目概览见 `README.md`，部署机制见 `MIGRATION.md`。

---

## 一、项目概览

**定位**：Windsurf AI 配对编程方法论——一套基于道德经哲学的 AI 行为规则体系，通过 symlink 部署到任意项目。

**核心架构**：

```
道（不变）→ 德（全局倾向）→ 法（操作流程）→ 术（具体技能）
                    ↕
              虚（层间流通之气）
```

**关键文件**：

| 文件/目录                      | 作用                                                   |
| ------------------------------ | ------------------------------------------------------ |
| `dao.ps1`                      | 链接管理工具（link/unlink/sync/status）                |
| `.dao-targets`                 | 注册的目标项目列表                                     |
| `global_rules.md`              | 德层全局规则（部署到 `~/.codeium/windsurf/memories/`） |
| `.windsurf/rules/dao-*.md`     | 四层规则（道/德/法/术）                                |
| `.windsurf/workflows/dao-*.md` | 九个工作流（编排/引擎/工具/元）                        |
| `.windsurf/skills/dao-*/`      | 九个可复用技能（含四个 cycle 镜头）                    |
| `references/道德经.md`         | 一切规则的推导源头，不可修改                           |

**部署原理**：symlink（文件）+ junction（目录），windsurf-dao 是唯一真相，编辑即时传播到所有注册项目。

---

## 三、同步前自审门

> 修道先于传道。windsurf-dao 推广给别人的标准，自己先通过，再传播。

**每次执行 `dao.ps1 sync` 之前，必须完成以下自审。**

### 自审清单

**1. 无为审视**（新改动是否引入了"法令滋彰"）

- 有没有新增"禁止 X"显式禁令？→ 改为原则表达
- 有没有新增"路径A/路径B"条件分支？→ 统一为单一流程
- 有没有新增平行追踪文件（plan.md / archive/ 类）？→ 路由到 TODO.md / AGENT_GUIDE.md

**2. 知识归位**（知识已落地）

- AGENT_GUIDE.md 有本次变更的演化条目？→ 若无，先写入
- TODO.md 已完成项已更新？→ 若无，先更新

**3. 减法确认**（删掉了什么）

- 本次变更删掉了什么冗余？（删掉 = 信息熵减）
- 净增加了多少内容？净增加越少越好

三项全过 → 执行 `dao.ps1 sync`
任何一项不过 → 先修，再 sync

### 约定优先级

自审门是**项目工作约定**，不是全局规则。它只约束在 windsurf-dao 项目中工作的 Agent。其他项目遵循各自的 AGENT_GUIDE.md。

---

## 二、演化记录

> 每次修改在此追加条目。格式：版本·日期·变更·根因·教训。

### 2026.04.02 · 工作流架构重构：workflow → cycle + lens

**变更**：

- 将 4 个专项工作流（dao-debug-escalation、dao-refactor、dao-optimize、dao-test）从 workflow 降级为 skill（cycle 镜头），删除对应 workflow 文件
- 新增 skills：`dao-debug/`、`dao-refactor/`、`dao-optimize/`、`dao-test/`
- `dao-cycle.md`：新增"镜头机制（Lens）"章节，五相引擎按需加载领域 skill
- `dao-dev.md`：所有 `/debug-escalation` 引用改为"cycle + debug 镜头"，工作流协作图重绘
- `dao-evolve.md`：审查对象从 workflow 扩展到 skills
- `dao-fa-layer.md`：工作流生态描述更新

**根因**：

- 第一性原理分析发现，专项工作流本质是 /cycle 的单次 turn + 领域知识，是 skill 伪装成 workflow
- 作为 workflow 的代价：① 每次对话全量注入 context（~460 行）；② 跨工作流调用链（/dev → /debug → /cycle）造成 context 膨胀和上下文断裂

**架构**：

```
编排者（workflow）：/dev, /autopilot
引擎（workflow）：/cycle（五相 + 镜头机制）
镜头（skill）：dao-debug, dao-refactor, dao-optimize, dao-test
工具（workflow）：/commit, /distill, /doc, /review
元（workflow）：/evolve, /health-check
```

**教训**：

- **T15**: Workflow 意味着独立入口→出口流程，Skill 意味着可在任意 cycle turn 中加载的领域知识。选错载体会导致不必要的 context 消耗
- **T16**: 渐进披露（按需加载 skill）优于全量注入（workflow 常驻 system prompt），因为 context 是稀缺资源

### 2026.04.02 · 全局规则脱轨修复 + references/ 纳管

**变更**：

- `global_rules.md`: 将部署位置（`~/.codeium/windsurf/memories/`）的独立演化版本回写到源仓库，重新 `link-global` 建立 symlink，恢复 single source of truth
- `dao.ps1`: 新增 `references/` 目录管理——Invoke-Link/Unlink/Status/Sync 均支持将 `$DaoRoot/references/` 下的文件符号链接到 `$Target/.windsurf/references/`
- `.git/info/exclude` 模板新增 `.windsurf/references/` 条目

**根因**：

- 全局规则 `link-global` 建立的 symlink 在某次操作后断开（变回副本），之后部署版被独立扩写（增加了详细的"云层超脱"子章节），导致源仓库不再是全局规则的 single source of truth。源（2035 bytes/51 行压缩版）与部署（4161 bytes/展开版）内容完全不同
- `references/道德经.md` 是手动复制到项目的副本，不受 `dao.ps1` 管理，无法随源更新
- 跨层内容"冗余"经分析确认为索引模式设计意图（全局=压缩索引，层文件=展开详情），不需要删减

**教训**：

- **T12**: symlink 可能静默断开（Windows 更新、权限变更、工具操作等）。`/health-check` 的全局规则检查不是可选项，是必须定期执行的——这次脱轨持续了未知时长才被发现
- **T13**: 当部署版和源版分叉时，"哪个是真相"取决于哪个在实际运行中被迭代优化。本次选择部署版为真相，回写源仓库——不是机械地"源覆盖部署"
- **T14**: `dao.ps1` 的管理范围应覆盖所有从源仓库传播到项目的文件类型。遗漏 `references/` 导致道德经.md 成为孤立副本

### 2025.07 · 双文件模式明确化

**变更**：

- `dao-fa-layer.md`: 知识归位路由表从 `项目知识 | 项目文件` 拆分为 `编码规则 | AGENT.md` + `项目知识 | AGENT_GUIDE.md`，并新增"双文件模式"说明段落

**根因**：

- autopilot 和 dev 工作流已经使用 AGENT_GUIDE.md 作为知识归宿，但法层路由表仍用模糊的"项目文件"，导致实际沉淀时不知道写哪个文件。next-platform-front 项目只有 AGENT.md，知识和规则混在一起
- 用户明确要求：每个项目都应有 AGENT.md（规则）+ AGENT_GUIDE.md（知识），AGENT.md 引用 AGENT_GUIDE.md

**教训**：

- **T10**: 当工作流（autopilot/dev）已经隐式建立了约定，法层路由表应显式对齐，否则日常开发（非 autopilot/dev）时会走老路
- **T11**: `powershell`（5.1）无法解析 dao.ps1 中的 emoji 字符（✅/❌），必须用 `pwsh`（7+）执行 `dao.ps1 sync`

### 2026.03.29 · W3+W4+OPT autopilot 执行

**变更**：

- `dao.ps1`: `Invoke-Sync` 末尾增加 `git diff --stat HEAD` 变更摘要——有未提交变更时显示"本次传播内容"，否则显示最新 commit（W3）
- `dao.ps1`: `Invoke-Status` 无参数时新增注册项目健康矩阵——显示每个注册项目的 TODO.md / AGENT_GUIDE.md 存在状态（W4）
- `dao.ps1`: help 文本更新，反映 sync/status 新能力
- `dao-fa-mechanism.md`: 修正工作流目录列表（补入缺失的 `dao-autopilot.md`）；修正规则列表（补入 `dao-ask-next-step.md`，移除 `（本文件）` 错位注释）
- `README.md` / `MIGRATION.md`: status/sync 命令描述更新
- `TODO.md`: W1-W4 全部迁移到 ✅ 区，🚧 区清空

**根因**：

- W3：symlink 模式下 sync 全输出 `[skip]`，用户无法判断是"源文件已变"还是"源文件未变"。变更摘要让传播可见
- W4：新范式（TODO.md + AGENT_GUIDE.md）落地情况无法一眼看出；status 健康矩阵给出直接答案
- OPT：dao-fa-mechanism.md 是最容易被查阅的"地图文件"，但少了 dao-autopilot.md（最重要的工作流之一）和 dao-ask-next-step.md，是显著的文档错误

**教训**：

- **T8**: 工具的说明文字应与工具实际行为同步更新——功能变了，help/README 不跟上会造成认知错位
- **T9**: "地图文件"（如 dao-fa-mechanism.md）比普通文档更需要精确——AI 和人都依赖它来建立心智模型，错误的地图比没有地图更危险

### 2026.03.29 · 同步前自审门

**变更**：

- `AGENT_GUIDE.md`: 新增"三、同步前自审门"章节——每次 `dao.ps1 sync` 前必须过三项自审（无为审视 / 知识归位 / 减法确认）

**根因**：

- windsurf-dao 今天多次 sync 前未经自审，靠的是人工检验。这个约定不应依赖人记住，应固化为项目工作约定写在 AGENT_GUIDE.md 里，下一个 Agent 开始工作时自然读到

**教训**：

- **T7**: 修道先于传道。对外的标准，先在内部验证通过，再传播。流程约定写在 AGENT_GUIDE.md 里，不需要靠"记住"来执行

### 2026.03.29 · W1 工作流无为化审查 + W2 dao-dev 接入知识归位

**变更**：

- `dao-cycle.md`: 移除"这不是建议，是硬门控"元声明（原则本身即是约束，不需要声明自己是约束）；省相表述从禁令式改为自然式
- `dao-dev.md`: "构建护甲判断"4条if-else规则 → 1行原则表达；涅槃阶段补入"若项目有 AGENT_GUIDE.md，写入演化条目"（W2）

**根因**：

- 11个工作流全部审查后，真正违反无为原则的只有 dao-cycle.md 和 dao-dev.md 两处。其余9个写得已经很好——减法不需要为减法而减法，有问题才改
- dao-dev.md 缺少与 autopilot 的知识归位一致性：autopilot 完成后写 AGENT_GUIDE.md，但 dev 管线没有同等步骤

**教训**：

- **T5**: 审查的结论是"大多数是好的"也是一个有价值的结论。不要为了"有所作为"而过度改动
- **T6**: "不是建议"的声明恰恰说明原则的力量不够。强原则不需要声明自己很强——自然流露

### 2026.03.29 · dao-autopilot.md 重构 + dao-commit.md 无为化

**变更**：

- `dao-autopilot.md`: 完全重写。废除 `plan.md` / `archive/` / "路径A/路径B" 条件分支。确立：TODO.md 是任务图的唯一载体，AGENT_GUIDE.md 是知识的唯一归宿，state.json 仅存执行元数据（commit hash + rollback_cmd）
- `dao-commit.md`: 移除"推荐模式"章节和"禁止 AI 自动执行 git commit"安全约束

**根因**：

- autopilot 原设计在 TODO.md / AGENT_GUIDE.md 存在时走"路径A"，不存在时走"路径B"——本质是建立了平行追踪系统，违反"单一载体"原则。真正的融合是：无论是否存在，都用这两个文件（不存在就创建）
- "禁止 AI 自动执行"是下德做法（法令滋彰）。行为应来自对"commit 是用户对历史的主动声明"这一道理的理解，而非显式禁令

**教训**：

- **T1**: 推广给别人的范式，自己必须先实践（windsurf-dao 自身需要 TODO.md + AGENT_GUIDE.md）
- **T2**: "有则融合，无则自建"不是条件分支，而是一种态度——所有项目最终都应有这两个文件
- **T3**: 无为而治 ≠ 无规则，而是用道理替代禁令。显式"禁止X"意味着判断力未被信任；好的原则让 AI 自然知道何时该做何时不该
- **T4**: 减法是进化方向。每次修改后问：删掉什么让系统更简洁？
