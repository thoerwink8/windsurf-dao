# 造线详细规范（Dev Thread）

> 道常无为而无不为。

## §5 造线（Dev Thread）

**触发**：`go_ready = true`

### 造线入口门控（Go Gate）

> 不知常妄作凶。环境没备好就动笔 = 妄作。

状态从 `go → executing` 之前，**必须逐项完成并在 STATUS.json 记录**：

1. **谋线文档在 main** — 确认 `docs/specs/<topic>/` 已 commit + push 到 `main`/`master`。违反检测：`git log main -- docs/specs/<topic>/STATUS.json` 无输出 → 先在 main 上补提交谋线文档再继续。理由：孤儿检测、多 Loop 并发感知、可恢复性都依赖文档在 main 上可见
2. **创建 worktree** — `git worktree add ../<topic>-loop -b feat/<topic>`，确认 worktree 目录存在且分支正确。**禁止 `git checkout -b`**——checkout 是全局操作，会影响所有指向同一仓库的 session（见「为什么用 worktree」段）
3. **STATUS.json 写入 `dispatch.branch` + `dispatch.worktree_path`** — branch = 实际分支名，worktree_path = worktree 绝对路径。后续每次恢复 session 时验证 worktree 存在且分支一致
4. **worktree 环境准备** — 进入 worktree 目录，清理继承的 node_modules（dao-worktree e163 教训），执行 install
5. **基线验证** — 项目有构建/测试的先跑一次确认绿灯（无构建的跳过）
6. **六项全过 → 才写 `mode: executing`**

违反检测：任何时刻发现 `mode = executing` 但 `dispatch.worktree_path` 为空或 worktree 目录不存在 → **立即停止任务执行**，先补创 worktree 再继续。

### 为什么用 worktree 而非 checkout

> 天下神器，不可为也，不可执也。——仓库的 HEAD 是全局共享状态，不是某个 session 的私产。

`git checkout` 改变整个仓库目录的文件内容，**所有指向同一目录的 session、IDE、终端都受影响**。这导致三个问题：
- 用户在另一个 session 写代码，造线切分支会让用户的文件突然全变
- 多 Loop 并发造线，各自 checkout 不同分支互相覆盖
- 谋线要在 main 写文档，造线把 HEAD 切走了

`git worktree add` 在**另一个目录**创建同一仓库的独立工作副本，共享 .git 数据库但各自有独立的 HEAD、工作目录、暂存区。主目录不受影响。

### 造线 Git 自动化

> 善行无辙迹。——Loop 的 git 生命周期在 Go Gate 创建 worktree 时已完全确定，造线中不再逐步确认。

**所有造线 git 操作在 worktree 目录中执行**（`dispatch.worktree_path`），使用 `git -C <worktree_path>` 或先 cd 进入。AI 直接执行，禁止用 AskUserQuestion 询问 commit/push/merge/删分支：

| 操作 | 时机 | 行为 |
|------|------|------|
| **commit** | 每 Task 完成 + 验证通过后 | 在 worktree 中自动 commit（message 含 Loop topic + Task ID） |
| **push** | 每 commit 后 | 自动 push 到 `origin feat/<topic>` |
| **PR + merge** | §7.2.5 用户确认归档后 | 归档流程自动执行（见 closing.md §7 归档流程） |
| **删分支 + worktree** | PR merged 后 | 先 `git worktree remove`，再删本地 + 远端分支 |

**预授权边界**：仅限 worktree 内的 `feat/<topic>` 分支。若检测到在主目录或 `main`/`master` 分支，所有写操作立即停止。

**冲突处理**：push 遇冲突 → 尝试 rebase；rebase 失败 → 停止轮询，在回答正文中说明情况，等用户介入。

### 分诊与 subagent 调度

造线中主线程是**调度器**，按 plan.md 逐 Task 派发 subagent 执行：

| 条件 | 调度方式 |
|------|---------|
| 单 Task < 3 文件、非核心模块 | `Agent(subagent_type="dao-worker-batch", model="sonnet", prompt="执行 Task T<N>：<任务描述>。工作目录: <worktree_path>。Spec: <路径>。验证命令: <命令>。")` |
| 单 Task ≥ 3 文件或核心模块 | 主线程走 `dao-superpowers` 流程（**跳过 worktree 创建**——Go Gate 已建，传入 worktree 路径 + reviewer） |
| 多个独立 Task 无依赖 | **并行派发**多个 `dao-worker-batch`（同一消息多个 Agent 调用，均在同一 worktree 中） |
| 有依赖的 Task | 串行：前序完成后再派发后续 |

> **所有 subagent 在 Go Gate 创建的 worktree 中工作**，不另建 worktree。禁止嵌套 worktree（dao-worktree 反模式表）。

### 执行管线

Go → 环境准备 → 逐 Task 派发 subagent（写码→commit→三文件同步）→ Task 级验证 → Phase 级检查点 → 全量验证 → 逐条验收 → Review（`dao-reviewer` + 核心模块追加 `dao-reviewer-critical`）→ 目标达成度评估（closing.md §7）→ 🔒 用户交付审查（closing.md §7.2.5）→ 归根 → 归档

### 验证节奏

**Task 级**（每 commit 后）：typecheck + test（`--changedSince`）+ 契约测试。**禁止 file 级验证**。

**运行验证**（bugfix Loop 必须，全 Task 完成后）：启动应用 → 复现原 bug 场景 → 确认修复生效 → 截图存证到 `_tmp/qa/<loop-topic>/verify-*.png`。纯后端 / 纯库的 bugfix 可用集成测试替代，但前端 / UI 相关 bug 必须实际启动应用验证。**违反检测**：`STATUS.json type = "bugfix"` 且 plan 全 ✅ 但无运行验证截图或测试记录 → 强制补验。

**Phase 级**（每 Phase 末尾）：组件健康（`dao-design` component-radar.md）+ 视觉回归（design Loop 必须 `dao-design` fidelity.md L1~L3 截图 diff）+ 交互验证（L4）+ 动态组件提炼。截图路径：`_tmp/qa/<loop-topic>/<type>-<desc>.png`。

### Spec 三文件同步（🔒 每 Task commit 后）

每 Task commit 后立即同步：① STATUS.json（current_task + completed_tasks）② plan.md（标 ✅）③ acceptance.md（勾 `[x]`）。违反检测：completed_tasks 长度 > plan 中 ✅ 数量 → 立即补齐。

### subagent 调度 + 失败处理

| subagent | 触发 |
|----------|------|
| `dao-worker-batch` | 每个 Task |
| `dao-reviewer` | 所有 Task 完成后 |
| `dao-reviewer-critical` | 核心模块（auth/payment/security） |
| `dao-debugger` | 同一 Task 失败 3 次 |
| `dao-strategist` | reviewer 报告架构级问题 |

每个 prompt 必含：任务边界 + 输入路径 + 验证命令 + 输出预期。失败 3 次升级 debugger，验收项不可实现则回退谋线，5 轮无进展强制停止。

## §6 并发模型

无固定 master，任何 session 抢锁即可工作。谋线在主目录 main 分支（文档不冲突），造线在**独立 worktree** `../<topic>-loop/` 的 `feat/<topic>` 分支（Go Gate 强制创建）。主目录 HEAD 始终不动，多 session / 多 Loop 互不干扰。session 恢复时验证 worktree 存在 + 分支一致。多 loop 默认并行（各自独立 worktree），冲突合并时解决。`depends_on`：谋线不阻塞，造线前检查依赖——已 done 正常走，还在造线看文件重叠（无重叠并行/有重叠标 blocked），还在谋线则轮询等待。
