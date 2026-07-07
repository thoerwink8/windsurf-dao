---
name: dao-project-scaffold
description: 项目标准结构模板。首次进入项目时对照检查，缺则建议创建。也可手动调用进行结构审计。
disable-model-invocation: true
---

# 器 · 项目脚手架

> 朴散则为器。圣人用之，则为官长。——《道德经》第 28 章

## 触发时机

- 首次进入一个项目，检测到缺少标准文件时
- 用户手动调用 `/dao-project-scaffold` 进行结构审计
- 创建新项目时

## 标准结构

```
根目录/
  README.md              ← 人看的项目介绍
  CLAUDE.md              ← AI 入口（<80 行，精简指向 rules）

  .claude/
    rules/               ← AI 自动加载的领域规范
      *.md               ← 按领域拆分，paths: frontmatter 条件加载

  docs/
    PROJECT.md           ← 项目仪表盘（替代 TODO.md，Loop 状态变更时自动更新）
    prd.md               ← 产品需求文档（如有）
    plans/               ← 实施计划（按日期命名：YYYY-MM-DD-主题.md）
    specs/               ← Loop 工作区（dao-loop 管理）
      _archive/          ← 已完成 Loop 归档 + INDEX.md
      <topic>/           ← 活跃 Loop（spec.md + acceptance.md + plan.md + STATUS.json）
```

## 原则

### 根目录法则

根目录只放**活文档**——每天可能打开的文件：
- `README.md`：给人看的项目介绍
- `CLAUDE.md`：给 AI 看的入口（<80 行）

历史文档、参考资料、产品文档全部进 `docs/`。项目追踪用 `docs/PROJECT.md`（Loop 体系自动更新），不在根目录放 TODO.md。

### 唯一 AI 通道

`CLAUDE.md` + `.claude/rules/` 是唯一的 AI 上下文通道。禁止在根目录堆积 `AGENT.md` / `AGENT_GUIDE.md` / `KNOWLEDGE.md` 等冗余入口——它们的内容应归入 `CLAUDE.md` 或 `.claude/rules/`。

### Rules 文件规范

- 按**关注点**拆分，不按层级：`design-tokens.md`、`testing.md`、`architecture.md`
- 加 `paths:` frontmatter 做条件加载，减少 context 噪音
- 不加 frontmatter 则无条件加载（慎用，只用于全局规范）
- 中等项目 3-5 个文件；不要为拆而碎片化

### Docs 组织

- `docs/PROJECT.md`：项目仪表盘（活跃 Loop + Backlog + 里程碑，dao-loop 自动更新）
- `docs/prd.md`：产品需求
- `docs/plans/`：实施计划，按日期命名 `YYYY-MM-DD-主题.md`
- `docs/specs/`：Loop 工作区（活跃 loop 目录 + `_archive/` 归档），由 dao-loop 管理

## Open Design 项目附加结构（条件触发）

**触发条件**：项目根存在 `design/` 目录（即由 Open Design 产出设计资产的项目）。

此类项目除上述通用结构外，`design/` 内必须遵循设计稿生命周期结构：

```
design/
  pages/                   ← 页面设计稿（对应代码路由）
    {page}.html            ← 正式稿（稳定基准，代码侧唯一参考）
  components/              ← 组件/弹窗设计稿（覆盖层，非独立页面）
    {component}.html
  ref/                     ← 参考工具（不对应代码，辅助开发）
    gallery.html
    component-gallery.html
  css/{project}.css        ← 共享样式
  js/{project}.js          ← 共享行为
  workspaces/              ← 草稿区（临时，升格后整目录删除）
    README.md              ← 草稿区说明（onboarding）
    {name}/                ← 单个工作区（草稿原型 + WORKSPACE.md）
  archive/                 ← 旧正式稿降格保留（永不删除）
    README.md              ← 归档说明
    {page}-{YYYYMMDD}.html
  handoff/                 ← 交接包（一次升格一个目录）
    {scope}-{YYYYMMDD}/    ← _index / components / types / prompts / acceptance
  CONTEXT.md               ← 会话对齐（新开会话第一眼读）
  PROTOTYPE-SPEC.md        ← OD 原型输出规范（三层 Tailwind 策略 + 项目 config 映射）
  CHANGELOG.md             ← 升格日志
```

> **结构与升格流程的单一真相源 = `dao-design`（asset.md）**。本 skill 只在进项目时做存在性检查，不重复定义流程。完整命名约定、升格三步、交接包模板均见 asset.md §B。

**双向闭环**：`design/` 同时支持正向（设计→代码，`dao-design` open.md 消费）与反向（代码→设计，`dao-design` asset.md §A 生成）。两向草稿都汇入 `workspaces/`，共用 asset.md §B 升格——`workspaces/` 是收敛点。

### 代码层映射（设计侧消费，写入 CONTEXT.md 或 CLAUDE.md）

交接包按代码层分文件（components / types / store / prompts / i18n），各层对应的**实际代码目录因技术栈而异**，必须声明一次供 `dao-design` asset.md §B 生成 handoff 时填对路径：

- **设计/代码同仓（monorepo）** → 写项目根 `CLAUDE.md`
- **设计/代码分仓**（design/ 与代码在不同目录，如本类 Open Design 项目）→ 写 `design/CONTEXT.md`（升格在设计侧运行，读 CONTEXT.md）

```markdown
## 设计交接代码层映射
- components → <项目实际组件目录>
- types → <项目实际类型目录>
- prompts → <项目实际 prompt 目录>
```

## 跨层一致性脚手架（技术栈检测）

> 不知常，妄作凶。——跨层注册是"常"，忘注册是"妄"。

某些技术栈天然存在**跨层注册缝隙**——Layer A 的文件存在 ≠ Layer B 知道它存在。静态类型检查和编译器都无法捕获这类断路，必须有专用校验脚本。

首次进入项目时，按技术栈指纹检测并脚手架对应的一致性检查：

| 技术栈指纹 | 跨层缝隙 | 需要的检查 |
|-----------|---------|-----------|
| `src-tauri/migrations/*.sql` 存在 | SQL 迁移文件 ↔ Rust `lib.rs` 注册 | `check-migrations` vitest 测试 |
| _(未来按需扩展)_ | | |

### Tauri 项目检测

若检测到 `apps/*/src-tauri/migrations/` 或 `src-tauri/migrations/`：

1. 检查 `scripts/check-migrations.ts` 存在
2. 检查 `scripts/__tests__/check-migrations.spec.ts` 存在
3. 检查 `package.json` 含 `check:migrations` 脚本
4. 缺项 → 建议创建，提供 TraceyU 参考模板

### 桌面端调试基建检测

若检测到 `apps/*/src-tauri/` 或 `src-tauri/`（Tauri 项目）：

1. 检查 `package.json` 含 `dev:debug` 脚本（设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`）
2. 检查 `.claude/rules/desktop-debugging.md` 存在（含工具选择铁律 + 启动命令表）
3. 检查 `CLAUDE.md` 记录了 `dev:debug` 命令
4. 缺项 → 建议创建，参考 `stacks/desktop-tauri.md` 处方

**为什么必须在 scaffold 阶段就位**：桌面端调试工具选择（chrome-devtools vs playwright vs windows-mcp）是高频决策。没有规则文件 → AI 每次会话自行判断 → 选错工具 → 排障循环 → 烧 context + 烧钱。一次 scaffold 省百次重试。

模板（`dev:debug` 脚本内容，Windows cmd.exe 语法）：
```
"dev:debug": "set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222&& pnpm tauri dev"
```

若检测到 `electron` / `electron-builder` 依赖（Electron 项目），同理检测 `dev:debug` 脚本，但环境变量不同：
```
"dev:debug": "set ELECTRON_EXTRA_LAUNCH_ARGS=--remote-debugging-port=9222&& electron ."
```

### 扩展模式

发现新的跨层断路时（如 Next.js route ↔ middleware、Prisma schema ↔ seed 等），在此表中追加一行。原则：**能自动检测的不写文档提醒，能测试的不写 check 脚本**。

## 检查清单

首次进入项目时逐项检查：

- [ ] `CLAUDE.md` 存在且 <80 行
- [ ] `.claude/rules/` 存在（可空，但目录要有）
- [ ] 根目录无冗余 AI 入口文件（AGENT.md / AGENT_GUIDE.md 等）
- [ ] **开工包白名单**：根目录存在 `kit.json` manifest → `docs/kit/`（DECISIONS / STACK / INIT / FRONTEND / BACKEND / OPEN-QUESTIONS + acceptance/ + design-prompts/）视为合规结构，不判冗余；kit 文件散落根目录 → 建议按上述映射归位到 `docs/kit/`，不建议删除
- [ ] `docs/PROJECT.md` 存在（替代旧 TODO.md）
- [ ] `docs/specs/` 存在（Loop 工作区）
- [ ] 根目录无遗留 `TODO.md`（已完成的静态清单应清理）
- [ ] **跨层一致性检查**脚手架就位（按上方技术栈检测结果）

**若检测到 `design/` 目录，额外检查：**

- [ ] `design/pages/` 存在（页面设计稿）
- [ ] `design/components/` 存在（组件/弹窗设计稿）
- [ ] `design/ref/` 存在（参考工具）
- [ ] `design/workspaces/` 存在（含 README.md）
- [ ] `design/archive/` 存在（含 README.md）
- [ ] `design/handoff/` 存在
- [ ] `design/CONTEXT.md` 存在（会话对齐入口）
- [ ] `design/CHANGELOG.md` 存在
- [ ] `design/PROTOTYPE-SPEC.md` 存在（OD 原型输出规范：三层 Tailwind 策略 + 项目 tailwind.config 映射 + 类名速查。缺项时从项目 `tailwind.config.*` 自动生成骨架——见下方模板）
- [ ] 「设计交接代码层映射」已声明（同仓→CLAUDE.md；分仓→CONTEXT.md）
- [ ] `design/.od-skills/` 两个 symlink 有效（README.md + dao-design-protocol.md，`Get-Item` 的 LinkType=SymbolicLink 且目标存在——symlink 不入 git，换机/克隆后必然缺失，本检查是唯一恢复触发点；创建步骤见下方「OD 协议 symlink」节）
- [ ] `design/.od-sync.json` 存在且 `odProjectId` 指向的 OD 工作目录存在（配置了 OD 面板同步的项目；指针过期——如 OD 项目重建后 UUID 变化——同步会静默落到废弃目录）
- [ ] `.vscode/settings.json` 用 `files.exclude` 隐藏 Open Design 生成的 `*.artifact.json`（及同类工具自动生成、已在 `.gitignore` 但仍会出现在 Explorer 树里的文件）。这类文件不受 git 追踪，属于本地视觉干扰而非仓库结构债务，不要误判为"目录混乱"去做大规模重排——`.vscode/settings.json` 已在多数项目 `.gitignore` 中被显式排除跟踪（`!.vscode/settings.json`），可安全共享（TraceyU project-structure-overhaul Loop 实证：`design/` 根目录 19 个 `.artifact.json` 全部已 gitignore，真正需要改的只有这一个 IDE 配置文件）

**若检测到 `src-tauri/` 或 `electron` 依赖，额外检查：**

- [ ] `package.json` 含 `dev:debug` 脚本（WebView2 远程调试端口）
- [ ] `.claude/rules/desktop-debugging.md` 存在（MCP 工具选择 + 启动命令）
- [ ] `CLAUDE.md` 记录了 `dev:debug` 命令及说明

缺项不自动创建，而是**建议用户创建**并说明理由。dao-loop 预飞检查会自动处理迁移。

### PROTOTYPE-SPEC.md 生成指引

`design/PROTOTYPE-SPEC.md` 缺失时，按以下方式生成骨架：

1. 探测项目 `tailwind.config.*`
2. 有 config → 提取 `theme.extend`（colors / borderRadius / fontSize / spacing / boxShadow / transitionDuration / transitionTimingFunction），生成包含三层 HTML 模板 + Tailwind 类名速查的 SPEC
3. 无 config → 生成最小骨架（三层模板 + 标准 Tailwind 类名，无自定义映射），标注 `<!-- 项目成熟后补充自定义 config -->`

三层结构原则（所有项目通用）：

```
层 1 — 项目 CSS 变量（<link> 引用共享 CSS，含主题 token + 组件基类）
层 2 — Tailwind CDN + 项目 tailwind.config（CSS 变量 → 语义类名映射）
层 3 — 补丁 <style>（仅 Tailwind 无法覆盖的，如 keyframes）
```

SPEC 文件内容由项目填充（不由 dao 固化），但结构必须包含：核心原则、三层 HTML 模板、Tailwind 类名速查（颜色/圆角/字号/阴影/动效）、组件模式、禁止项。

### OD 端协议（symlink → windsurf-dao）

OD 不会自动加载协议——需在会话开头发送 `/dao-design` 手动激活（README.md 路由到 dao-design-protocol.md）。激活后 OD 感知完整 dao-design 方法论（三层输出策略、工作区模型、完成门控、HANDOFF.md 模板、CLI 协作模型、维护命令）。

**唯一真相源**：`windsurf-dao/ccswitch/skills/dao-design/protocol-od.md`。
**项目侧**：`design/.od-skills/dao-design-protocol.md` 是 symlink，不是副本。

创建 symlink（scaffold 自动执行）：
1. 发现 windsurf-dao 路径——从 `~/.claude/CLAUDE.md` 解析 `@<path>/ccswitch/dao.md` 提取根目录
2. 创建目录：`mkdir design/.od-skills`（如不存在）
3. 创建 symlink（两个）：
   - `cmd /c mklink "design\.od-skills\README.md" "<daoRoot>\ccswitch\skills\dao-design\od-readme.md"`
   - `cmd /c mklink "design\.od-skills\dao-design-protocol.md" "<daoRoot>\ccswitch\skills\dao-design\protocol-od.md"`

README.md 是路由入口——用户在 OD 发送 `/dao-design` 时，OD 搜索 `.od-skills/` 发现 README → 被指引读取 `dao-design-protocol.md`。

`.od-skills/` 整个目录 gitignore（symlink 是机器本地指针，不入库）。换机器重跑 scaffold 即恢复。

此文件与 `PROTOTYPE-SPEC.md` 互补：protocol 定义**流程**（怎么工作），SPEC 定义**内容**（具体的 config 和类名映射）。
