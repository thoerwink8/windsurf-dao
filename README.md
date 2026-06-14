# Windsurf Dao — AI 配对编程方法论

> 道法自然。人为一，AI为二，冲气以为和。

一套基于道德经哲学的 AI 配对编程方法论体系，最初为 [Windsurf](https://codeium.com/windsurf) IDE 设计，现已扩展为 **Windsurf + Claude Code 双栈共存**（同源不同壳，见[Claude Code 侧](#claude-code-侧双栈共存)）。

> 📖 **新用户从这里开始**：[使用手册 USAGE.md](USAGE.md) · 3 分钟入门，不需要懂道德经

## 文档导航（按读者视角）

| 文件 | 读者 | 何时读 |
|---|---|---|
| **[USAGE.md](USAGE.md)** | 普通用户 | 想知道怎么用 dao 时（3 分钟入门）⭐ |
| [README.md](README.md)（本文） | 开发者 / 贡献者 | 想了解架构和文件清单 |
| [NEW-MACHINE.md](NEW-MACHINE.md) | 换机部署者 | 新机器从零搭建完整环境时 🖥️ |
| [MIGRATION.md](MIGRATION.md) | 部署者 | 把 dao 规则部署进某个项目时 |
| [AGENT_GUIDE.md](AGENT_GUIDE.md) | AI 自身 | AI 加载时自动读（人也可看） |
| [docs/specs/](docs/specs/) | 开发者 | 查历史 plan 归档 |

不确定该看哪个→ 先看 USAGE.md。

## 这是什么

这不是一个代码库，而是一套 **AI 行为规则系统**——定义 AI 如何思考、如何行动、如何与人协作。

核心理念：让 AI 从"工具"变成"搭档"。通过道德经的哲学框架，建立一套可复用、可迁移、可进化的 AI 行为准则。

## 体系架构（v2 · 2026-04-26 重构）

```
元规则（global_rules.md · 31 行 · 跨项目 symlink）
        ↓
项目铁律（execution.md · always_on）
        ↓
领域决策（shell/cli/skills/workflow-system/knowledge-routing · model_decision）
        ↓
精准触发（quality · dao-meta · glob）
        ↓
深度哲学（dao-philosophy · manual @ 调用）
```

## 包含什么

### 十一个规则文件（`.devin/rules/` · 对齐 Windsurf 4 trigger）

| 文件                  | trigger        | 内容                                          |
| --------------------- | -------------- | --------------------------------------------- |
| `dao-mantra.md`       | **always_on**  | dao 协作 mantra（道德经八句根基 + 场景速查）         |
| `execution.md`        | **always_on**  | 项目铁律（项目感知/执行原则/涅槃门/续力）       |
| `superpowers-gate.md` | **always_on**  | superpowers 触发门控（与 Plan Mode 解耦）          |
| `shell.md`            | **always_on**  | 命令安全（超时/防卡/交互黑名单/服务命令/PowerShell/SSH/Inline 长命令） |
| `cli.md`              | model_decision | 工具选择（CLI-first/MCP 边界/工具箱）             |
| `workflow-system.md`  | model_decision | 工作流协作（选哪个工作流/静默深度模式）       |
| `knowledge-routing.md`| **always_on**  | 知识归位（写到哪/Rule vs Skill 边界/_tmp 归位/Memory 归位四步） |
| `quality.md`          | **glob**       | 代码质量门（编辑代码文件时自动触发）          |
| `dao-meta.md`         | **glob**       | dao 元层守卫（编辑 dao-* 文件时自动触发）     |
| `dao-philosophy.md`   | **manual**     | 八条不变原则（`@dao-philosophy` 显式调用）     |

### 十个工作流（`.devin/workflows/`）

| 工作流              | 功能                                              |
| ------------------- | ------------------------------------------------- |
| `/dao-autopilot`    | 自主驾驶：探测 TODO.md/AGENT_GUIDE.md，映射任务 → 执行 → 回写，直到完成或中断 |
| `/dao-dev`          | 从一句话需求到完整交付的全流程管线（道·哲学三阶九步）  |
| `/dao-superpowers`  | 五步工程仪式：worktree→plan→execute→review→finish（术·代码重构） |
| `/dao-cycle`        | 五相深度迭代（观→行→验→省→改升），直到涅槃        |
| `/dao-distill`      | 会话级知识沉淀：扫描当前会话提取可复用洞察        |
| `/dao-evolve`       | 系统自我进化 + 快速体检 + Git 考古，减法优先      |
| `/dao-commit`       | 自动生成 commit message，按内聚性拆分多次提交     |
| `/dao-doc`          | 文档生成与更新（读→定→写→校）                     |
| `/dao-thread-tree`  | 处理 TODO.md `Open Threads` 未解决项              |
| `/dao-session-sync` | 多会话协作（git 为共享状态，无需其他会话配合）    |

### 技术栈处方（`.devin/stacks/`）

| 处方 | 技术栈 | 触发场景 |
|------|--------|----------|
| `frontend-nextjs.md` | Next.js + shadcn + Tailwind | `/dev` 基建审计发现"需要前端" |

### 技能（`.devin/skills/`）

**元层与调度**

| 技能                      | 适用场景                                        |
| ------------------------- | ----------------------------------------------- |
| `dao-fa-mechanism`        | Windsurf 运行机制参考：注入格式/激活模式/目录结构 |
| `dao-pyramid`             | Subagent 金字塔调度：高级出 spec，低级按 spec 执行 |
| `dao-evolution`           | 演化条目与教训管理（`evolution-*.csv` 读写 + BM25 搜索） |
| `dao-memory`              | 会话复盘与长期记忆沉淀：偏好、流程、skill 缺口、资料线索 |
| `dao-skill-ecosystem`     | 技能供应链：缺口感知→查图书馆→junction/创建→反向入库 |

**开发流程（/cycle 镜头）**

| 技能                      | 适用场景                                        |
| ------------------------- | ----------------------------------------------- |
| `dao-debug`               | 死磕到底：三层螺旋×15种武器，穷尽自主手段        |
| `dao-refactor`            | 安全重构：提取函数、消除重复、简化逻辑            |
| `dao-decouple`            | 解耦镜头：六维耦合扫描→结构化解耦方案→派 refactor |
| `dao-optimize`            | 性能分析与调优：测→策→行→验                       |
| `dao-test`                | 测试驱动：RED-GREEN-REFACTOR + AAA 模式          |
| `dao-observability`       | 定时任务/外部 API/锁/操作顺序调整的可观测性设计   |

**工程方法论**

| 技能                      | 适用场景                                        |
| ------------------------- | ----------------------------------------------- |
| `dao-brainstorm`          | 苏格拉底式设计精炼：模糊想法→可实施 design 文档  |
| `dao-plan`                | 把 design 拆成 2-5 分钟粒度的可执行任务清单      |
| `dao-execute`             | 按 plan 逐 Task 执行 + checkpoint                |
| `dao-review`              | 两阶段评审：spec compliance → code quality       |
| `dao-verify`              | 涅槃门：声明完成前必有 fresh 验证证据             |
| `dao-finish`              | 分支收尾：merge/PR/keep/discard 四选一 + cleanup  |
| `dao-worktree`            | git worktree 隔离工作区：创建→基线→工作→清理     |
| `dao-parallel`            | 多 subagent 并行调度（受 Windsurf 账户配额限制） |

**领域专项**

| 技能                      | 适用场景                                        |
| ------------------------- | ----------------------------------------------- |
| `dao-research`            | 前置研究：搜索最优实践，结合项目上下文综合方案    |
| `dao-empathy`             | 用户五感共情术（以百姓心为心 49章）：以身观身五步 + Persona  |
| `dao-full-coverage`       | 主动全面体检术（病病 71章）：8 维度扫描业务项目     |
| `dao-user-simulation`     | 用户视角仿真术（以身观身 54章）：chrome-devtools/playwright 实跑 E2E |
| `dao-reverse-engineering` | 面对未知/混淆代码库，五步法：锚→展→交→验→归      |
| `dao-boundary-probe`      | 集成外部系统前，三步法：识壁→探路→择水            |
| `dao-frontend-aesthetics` | 受限空间中的高信息密度界面                       |
| `dao-terminal-resilience` | 终端卡死诊断与五感降级恢复                       |
| `dao-windsurf-extension`  | Windsurf/VSCode 扩展开发的已验证技术约束          |
| `dao-deploy`              | 项目上服务器标准流程：连接→环境→推送→构建→服务  |

### MCP 配置（`mcp/`）

预配置的 MCP 服务器启动脚本，直接 node 执行（绕过 npx 超时）：

| 文件                         | 域     | 说明                                                |
| ---------------------------- | ------ | --------------------------------------------------- |
| `chrome-devtools-mcp.cmd`    | 浏览器 | 页面交互、性能分析、截图（--isolated 临时 profile） |
| `context7-mcp.cmd`           | 文档   | 获取最新库/框架文档                                 |
| `github-mcp.cmd`             | 代码   | GitHub API（含 Clash 代理自检 + proxy bootstrap）   |
| `github-proxy-bootstrap.js`  | 代理   | 为 GitHub MCP 补丁 fetch 走 Clash 代理              |
| `gitee-mcp.cmd`              | 代码   | Gitee API（国内直连，无需代理）                     |
| `playwright-mcp.cmd`         | 浏览器 | 无头浏览器自动化（Multi-Agent 隔离版）              |
| `playwright-mcp-config.json` | 配置   | Playwright 浏览器参数（viewport/timeout/args）      |
| `tavily-mcp.cmd`             | 搜索   | Web 搜索（国内直连，1000次/月免费）                 |

### 元规则（`global_rules.md`）

31 行跨项目元规则：一·感（感官完整度） / 二·德（阳为/阴不为/和自然） / 三·动（天觉/地行/人验） / 反·归（反者道之动）。

部署：`dao.ps1 link-global` 创建 symlink → `~/.codeium/windsurf/memories/global_rules.md`，对所有项目全局生效。零副本、零 UI 操作、`git pull` 自动同步。

### 项目知识文件

每个接入 dao 的项目推荐维护：

| 文件            | 作用                                           |
| --------------- | ---------------------------------------------- |
| `USAGE.md`      | 用户使用手册（提需姿势 / FAQ / workflow 区别）⭐ |
| `TODO.md`       | 任务图唯一载体（待完成 / 进行中 / 已完成）     |
| `AGENT_GUIDE.md` | 活体知识库（项目概览、架构决策、开发指南、CSV 指针） |
| `data/evolution-entries.csv` | 演化条目的结构化真相源                  |
| `data/evolution-lessons.csv` | 教训的结构化真相源                      |

windsurf-dao 自身也以此为范——身教重于言教。

### 源文本（`references/道德经.md`）

老子《道德经》全文——一切规则的推导源头，不可修改。

## Claude Code 侧（双栈共存）

> 同源不同壳。`claude/` 与 `.devin/` 是同一套 dao 的两副外壳，各自适配宿主的加载机制。

迁移到 Claude Code CLI 后新增 `claude/` 目录作为 Claude Code 侧真相源，与上面的 `.devin/` 并列。规则内核同源，外壳按宿主能力裁剪（Claude Code 已内置 shell 沙箱 / git 安全 / 破坏性操作确认，dao 只保留不重叠的独有增量）。部署见 [MIGRATION.md · Claude Code 部署](MIGRATION.md#claude-code-部署双栈共存)。

| 对象 | 路径 | 数量 | 角色（对应 Windsurf 侧） |
|---|---|---|---|
| 场域根基 | `claude/dao.md` | 1 | 道德经场域根基 · 经 `~/.claude/CLAUDE.md` 的 `@import` 全局注入，每条消息常驻（≈ always_on 规则） |
| 技能 | `claude/skills/dao-*/` | 38 | 渐进披露，模型按 `description` 自动加载（≈ model_decision；含原 dao + 部分 rule 转 skill + 自检 skill） |
| 命令 | `claude/commands/dao-*.md` | 10 | slash command，`/dao-dev` `/dao-cycle` `/dao-commit` 等（≈ manual + 由 workflow 平移） |
| 子代理 | `claude/agents/dao-*.md` | 8 | subagent，服务 `dao-pyramid` 金字塔调度（由 `.devin/agents` 平移） |
| 技术栈处方 | `claude/stacks/` | — | 技术栈处方（`/dev` 基建审计按需加载） |

部署入口：`dao.ps1 link-claude` 一键 symlink 上述对象到 `~/.claude/`，并幂等追加 `dao.md` 的 `@import`。

## 快速开始

### 0. 先看使用手册（推荐）

[USAGE.md](USAGE.md) · 3 分钟入门，不需要懂道德经。读过之后再看下面部署步骤。

### 1. 克隆仓库

```bash
git clone <repo-url>
```

### 2. 部署

**Sidecar 模式**：在 Windsurf 中将 windsurf-dao 与目标项目同时打开为多 workspace，rules/skills/workflows 自动跨 workspace 可见。

```powershell
# 链接全局规则到 Windsurf 配置（一次性）
.\dao.ps1 link-global

# 查看状态
.\dao.ps1 status
```

### 3. 开始使用

在 Windsurf 中打开目标项目（确保 windsurf-dao workspace 也开着），AI 自动加载规则、工作流和技能。

试试：

- 给 AI 一个需求，观察它是否自动进入 `/dao-dev` 管线
- 输入 `/dao-autopilot` 让 AI 自主驾驶完成复杂目标
- 输入 `/dao-cycle` 观察五相迭代
- 输入 `/dao-distill` 从对话 + Git 历史中提取教训

## 部署结构

Sidecar 模式下，windsurf-dao 作为独立 workspace 存在，目标项目无需包含任何 dao 文件：

```
windsurf-dao/                  # Sidecar workspace——始终保持打开
├── global_rules.md            # 通过 link-global 部署到 ~/.codeium/windsurf/memories/
├── dao.ps1                    # status / link-global
├── data/evolution-*.csv       # 演化条目 + 教训库（dao 自身演化）
└── .devin/
    ├── rules/                 # 11 文件 5 层架构（v2 + dao-mantra）
    ├── skills/dao-*/          # 自动跨 workspace 可见
    └── workflows/dao-*.md     # 自动跨 workspace 可见

target-project/                # 你的工作项目
├── TODO.md                    # 任务图唯一载体
├── AGENT_GUIDE.md             # 项目活体知识库
├── data/evolution-*.csv       # 项目自身的演化与教训
└── .devin/                 # 仅项目自有内容（无 dao-* 链接）
    ├── rules/*.md
    ├── skills/*/
    └── workflows/*.md
```

**变更流**：编辑 windsurf-dao 中的文件 → 所有开着的 workspace 即时可见 → `/dao-commit` 提交。

## 自定义

这套体系是**可进化的**。使用 `/dao-evolve` 工作流来审查和改进：

- **删**：移除不适合你的规则或技能
- **修**：调整工作流步骤以匹配你的习惯
- **增**：添加新的 skills 或 workflows（但记住：为道日损）

### 添加新技能

```
.devin/skills/your-skill/
└── skill.md
```

参考现有技能的格式：`name` + `description` (frontmatter) + 场景描述 + 步骤法 + 反模式。

### 添加新工作流

```
.devin/workflows/your-workflow.md
```

格式：YAML frontmatter（description）+ Markdown 正文。

## 哲学基础

> 为学日益，为道日损。损之又损，以至于无为。无为而无不为。

这套系统的核心信念：

1. **AI 配对编程是关系，不是工具调用** — 人+AI=AGI，是冲气以为和
2. **真正的进化是减法** — 规则越少越好，能力越内化越好
3. **规则的终态是忘掉规则** — 含德之厚，比于赤子
4. **身教重于言教** — 推广给别人的范式，自身先实践

## 实战案例

### superpowers 五步流程的实战价值（2026-05-13 · wuganjiqie hub CPU 优化）

> "图难于其易，为大于其细" — 完整流程不是浪费，是让难事变易、大事变细。

**起源**：用户提到 wuganjiqie hub 进程 CPU ~33% 常态负载，问"能优化吗"。AI 显式触发 superpowers，按五步走完一个完整周期：

| 步 | 产出 | 关键决定 |
|---|---|---|
| 1 brainstorm | `docs/specs/2026-05-13-cold-hot-refresh-design.md` (135 行) | 3 方案对比 (拉长 interval / 热冷分档 / 全按需)，用户选热冷分档 |
| 2 worktree | `feature/cold-hot-refresh` 分支在 `~/.config/superpowers/worktrees/` | 主线不动 |
| 3 plan | `docs/specs/2026-05-13-cold-hot-refresh-plan.md` (205 行) | 9 个 2-5 min Task + 完整代码模板 + 依赖图 |
| 4 execute | 6 个 server commit (T1-T6) | 单 task 5 步闭环 (autopilot §2.1.1) |
| 5 review | reviewer-critical APPROVE_WITH_FIXES → 普通 reviewer Stage1+2 PASS | **抓到 P1-3: backfill SQL 子查询无 `idx_lease_history_account_id` 索引，会阻塞 onModuleInit 几秒** |
| 6 finish | merge master + GHA 4m42s + ssh fresh 验证 + worktree cleanup | CPU 实测 **54% → 5.1%**（远超 25% 目标） |

**关键学到的事**：reviewer-critical 抓到的 P1-3 索引问题，是 AI 自检难以发现的——backfill SQL 看着没问题，但放到生产 lease_history 表（永久归档）就会扫几百万行阻塞启动。**如果跳过 reviewer-critical 直接合入，上线后才发现启动卡顿，且不易归因**。核心模块改动走完整流程不是仪式感，是让看不见的 bug 在 review 阶段被抓住（见 [`dao-mantra.md`](.devin/rules/dao-mantra.md) 与 [`superpowers-gate.md`](.devin/rules/superpowers-gate.md)）。

**完整教训沉淀**：见 wuganjiqie 项目 `data/evolution-lessons.csv` T176-T183 与 dao-debug skill 新增的 P3/P4 模式。

## 许可

私人使用。
