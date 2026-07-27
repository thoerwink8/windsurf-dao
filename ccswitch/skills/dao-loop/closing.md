# 归档详细规范（Closing）

> 慎终如始，则无败事。

## §7 归档

### 目标达成度评估（🔒 归档前必须）

> 慎终如始——plan 全 ✅ ≠ 真完成。"所有任务做完" ≠ "目标达成"。

**当 plan.md 所有 Task 标记 ✅ 时，禁止直接归档**。必须完成以下四步评估：

#### 7.1 多维度打分

对照 strategy.md 达成度维度逐项打分（维度 | 达标线 | 实际 | ✅/⚠️/❌）。全 ✅ → 7.2.5 用户交付审查。有 ⚠️/❌ → 7.2 严重度分流。

**"连续两轮零新增"类收敛判据的已知盲区**：审查/走查型 Loop 若把"文档与代码不一致"也算作四类偏差之一（常见于 F 组收敛机制设计），会遇到一个结构性张力——每一轮的代码修复本身会在别处产生新的文档滞后点（比如某规则文件的状态描述、某处"待下一轮验证"占位文案），导致机械意义上的"连续两轮零新增"很难真正达成，容易在收敛判定阶段反复重置计数器。这不是执行不到位，是判据设计本身没有为"修复产生的衍生文档漂移"留出空间。遇到这种情况：不要死磕轮次数字，在 §7.2.5 交付审查时如实展示"字面判据未达成 vs 实质内容已收敛"的差异（真实偏差是否都已处置：修复或有理由的明确推迟），把"是否算实质收敛"的判断权交还用户，而不是自行放宽判据继续空转，也不要机械地无限加轮。

**design Loop**：打分必须含 `dao-design` fidelity.md L1~L5 全量验证（L3 Playwright 截图 diff，L3 前先 §6.4 状态矩阵枚举）。Token 变更须执行 §6.5 diff 流程。

#### 7.1.5 设计原型反向同步（🔒 有 design/ 时必须）

> 各复归其根——代码改了，原型必须跟。

**触发条件**（与 dao.md ② 设计同步门控一致）：
1. **有设计稿？** `Glob("design/**/*.html")` 有结果？（`**` 必须，正式稿常在 `design/pages/` 子目录）若无结果（worktree 可能缺文件），fallback 检查 `git ls-files 'design/*.html'`（跨子目录；禁用不带 `-r` 的 ls-tree）
2. **改了 UI 组件？** `git diff main --name-only` 含 `**/components/**` 或 `**/*.tsx`（分支级全量，不是单次 session 的增量）
3. 两条都满足才触发，否则跳过。

**执行步骤**：

1. **漂移检测**：对比 Loop 改动的组件列表与 `design/*.html` 中对应的 DOM/CSS，识别代码→原型的漂移点
2. **同步执行**：按 `dao-design sync`（或项目级 `code-to-prototype` rule）将代码变更反映到对应原型 HTML
3. **CONTEXT.md 更新**：更新页面状态表的版本号和对齐状态

**违反检测**：进入 §7.2.5 用户审查时，若 Loop diff 含 UI 组件但 `design/` 目录无变更 commit → 强制回到此步。不可跳过，不可询问用户是否跳过。

#### 7.2 严重度分流

| 严重度 | 判据 | 处理 |
|--------|------|------|
| `trivial` | ≤1 文件 ≤5 行 | 就地修 |
| `minor` | 2-3 行，当前范围内 | 追加 micro-task 当场修 |
| `major` | 3+ 文件 | 追加正式 Task，继续造线 |
| `critical` | 超出 spec 范围 | 归档当前 + 开新 Loop |

trivial/minor 修完重新打分，major 继续循环，critical 开新 Loop。

#### 7.2.5 用户交付审查（🔒 必止）

> 圣人无常心，以百姓心为心。——AI 做验证、打分、呈现，"这事儿算不算完"的判断权在用户。

**当 §7.1 打分全 ✅（或 §7.2 分流的 trivial/minor 修完后重新打分全 ✅）时**，禁止直接进入学习提取和归档。必须先展示交付报告，让用户理解**为什么这样改**，然后再通过 **AskUserQuestion** 让用户决策。

**展示内容（叙事先行，数据佐证）**：

1. **达成度打分表**（§7.1 的完整结果）
2. **变更摘要**（一句话核心 + 净增删统计，几行即可）
3. **整体叙事**（核心——按**决策主题**组织，不按 Task 机械拆分）：
   - **背景**：这个 Loop 要解决什么问题，改动前是什么状态
   - **发现**：造线中发现的核心矛盾或关键事实
   - **选择**：做了什么决策、考虑过什么替代方案、为什么排除
   - **后果**：这样改带来什么好处、有什么代价或遗留风险
4. **验证结果汇总**（测试通过/截图 diff/回归状态）

> 用户要看的是思考过程——重建 reviewer 的心智模型，不是罗列 diff。叙事的质量比 diff 覆盖更重要。数据（文件数、行数）是佐证，不是主体。

**用户四选一**：

| 选项 | 语义 | 后续 |
|------|------|------|
| **确认归档** | 用户认可交付质量 | → §7.3 学习提取 → 归档 |
| **指出问题** | 用户发现具体偏差 | 用户描述问题 → 追加 micro-task → `mode: executing` 回造线 |
| **追加需求** | 用户想在当前 Loop 扩展范围 | 用户描述需求 → 追加正式 Task 到 plan.md → `mode: executing` 回造线 |
| **暂不归档** | 用户需要时间判断或外部确认 | 保留 `mode: reviewing`，不 ScheduleWakeup，用户主动恢复 |

**主动追加提醒**：reviewing 讨论中浮现新改进想法时（用户提问引发、AI 分析发现），AI 主动评估规模并提醒："这个改动约 N 个文件，要追加为 T<X> 当场做，还是记入 HANDOFF 留给下个 Loop？"——不默默归类为"未来话题"。

**状态机变更**：`reviewing` 不再是过渡态，而是用户决策等待态。只有用户选择「确认归档」后才进入 `done`。选择「指出问题」或「追加需求」时回退到 `executing`。

**轮询行为**：`mode: reviewing` 时**不自动 ScheduleWakeup**——此阶段等待用户输入，轮询会空转。用户做出选择后，若回到 `executing` 则恢复轮询。

**违反检测**：准备写 `mode: done` 时，若 STATUS.json 无 `user_approved_at` 字段 → 强制回到 §7.2.5。

#### 7.3 学习提取

用户确认归档后，AI 扫 git log 提取可沉淀知识（项目级→`.claude/rules/`，跨项目→`memory/`，方法论→skill/dao.md），起草条目通过 **AskUserQuestion** 让用户确认。纯事实不写——那是 HANDOFF.md 的职责。

#### 7.4 规范同步

归档时将造线新增的规范（token / 组件 / 架构约束）同步到对应 rule 文件。**违反检测**：`completed_tasks.length ≥ total_tasks` 且准备写 `mode: done` → 未执行达成度评估则强制回到 7.1。

### 归档流程（用户确认归档后全自动）

> 功遂身退，天之道也。——用户在 §7.2.5 说「确认归档」是唯一决策点，之后全部自动执行，不再逐步询问。

在 worktree（`dispatch.worktree_path`）的 `feat/<topic>` 分支上完成：

1. 归档文件操作：`docs/specs/<topic>/` 移到 `docs/specs/_archive/<topic>_YYYYMMDD-HHmm/`
2. 生成 `HANDOFF.md`、更新 `INDEX.md`
3. STATUS.json 标 `mode: done`，写入 `user_approved_at`
4. 更新 `PROJECT.md`
5. commit + push（message: `[cc] chore(<topic>): Loop 归档`）

PR + 分支 + worktree 归根：

6. **先判已合并**：`git merge-base --is-ancestor feat/<topic> master`（或 `main`）——exit 0 = 已经以任意方式并入主线（直接 merge / squash-merge / rebase，不止 PR 一条路）。
   - **未合并** → 走 PR：创建 PR：`feat/<topic>` → `master`/`main`，description 从 HANDOFF.md 自动生成 → merge PR（默认 merge commit，保留完整历史）
   - **已合并**（PR 之外的方式已并入）→ **跳过 PR 创建**，直接进入步骤 8 归根。不因为"没走 PR"就放弃清理——清理步骤原先被绑死在 PR 路径后面，直接本地 merge 的分支从未触达步骤 10，是分支永久遗留的根因（教训 L13）
7. （已合并分支跳过本步）
8. **杀 worktree 内残留进程**（Windows 文件锁必须先释放）：检测 worktree 路径下是否有运行中进程（dev server / cargo / node / vite），有则终止。未杀干净直接 `worktree remove` 会报 "Invalid argument"
9. **回到主目录**，`git worktree remove ../<topic>-loop`（worktree 必须在主目录删除）。若仍失败 → `git worktree prune` + `Remove-Item -Recurse -Force`
10. 删除本地 + 远端 `feat/<topic>` 分支——**无论走的是哪条合并路径，本步骤都不可跳过**

**PR 即记录**：走 PR 路径时，分支删除后 PR 及其 diff、description、review comments 永久保留在 GitHub 上，是 Loop 的最终交付物。直接 merge 路径下无 PR 记录，commit 历史本身即交付物（message 与 HANDOFF.md 已含等价信息）。

**异常处理**：merge 冲突 → 停止自动流程，在回答正文中说明情况，等用户介入解决后继续。worktree remove 失败 → 不阻塞归档，prune + 手动删除目录兜底。

### 归档目录与模板

归档位置：`docs/specs/_archive/<topic>_YYYYMMDD-HHmm/`（含全套文件 + HANDOFF.md）。活跃 loop 在 `docs/specs/<topic>/`。

**命名格式**：`<topic>_YYYYMMDD-HHmm`
- 分隔符：话题名与时间戳之间用 `_`，话题名内部保留 `-`，时间戳内部用 `-` 隔开日期和时分
- 精度：到分钟，不含秒
- 时间来源优先级：HANDOFF.md 归档时间 > STATUS.json `lock.acquired_at` > `git log --follow` 首次 commit 时间
- 示例：`chat-ui-polish_20260622-1519`、`design-full-alignment_20260624-1106`

- **INDEX.md**（归档索引表）：详见 `templates/index-template.md`
- **HANDOFF.md**（交接文档）：详见 `templates/handoff-template.md`

### 关联触发

新任务开始前扫 INDEX.md 关键词+影响文件列，匹配则提示。时效权重：≤90天高、90-180天中、>180天低（仅路径完全匹配）。版本差≥2 major 或文件已删→降权。

## §7.5 Loop 续写（Follow-up）

已归档 loop 发现后续问题，三层路由：
- **小修**（≤2 文件 ≤30min）→ 就地改 + 记 HANDOFF.md「后续补丁」段
- **中修**（3+ 文件，原 spec 范围内）→ **Reopen**：移回 `docs/specs/`，STATUS.json 加 `mode:reopened` + `reopen_count` + `reopen_reason`，plan 追加 T-R1 系列，跳过谋线直接造线。≤3 次，第 4 次强制 Fork
- **大改**（超出 spec 范围）→ **Fork**：开新 loop，spec 头部加 `extends: <原topic>`，谋线自动读取原 HANDOFF.md 作背景

触发：用户说"之前的 XX loop 有问题"→ 扫 `_archive/INDEX.md` → 展示摘要 → 判断路由。

## §8 PROJECT.md 仪表盘

替代**幽灵型**（遗留静态清单）TODO.md，成为 **Loop 追踪**入口。自动生成（Backlog 除外），Loop 状态变更时 AI 自动更新。详见 `templates/project-template.md`。

**不是「项目追踪唯一入口」**（原措辞已改）：项目若把 `TODO.md` 用作在役候选池/dogfood 记账（判据见 `dao-project-scaffold` SKILL.md §TODO.md 存废判据），二者并存，PROJECT.md 不吞并它、也不构成删除它的理由。
