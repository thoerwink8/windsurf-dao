# Open Design 项目结构 · design-assets

> 朴散则为器。design/ 目录是设计资产的生命周期容器，结构对了，升格与同步才有地可循。

**触发条件**：项目根存在 `design/` 目录（即由 Open Design 产出设计资产的项目）。

## 目录结构

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

> **结构与升格流程的单一真相源 = `dao-design`（asset.md）**。本文件只在进项目时做存在性检查，不重复定义流程。完整命名约定、升格三步、交接包模板均见 asset.md §B。

**双向闭环**：`design/` 同时支持正向（设计→代码，`dao-design` open.md 消费）与反向（代码→设计，`dao-design` asset.md §A 生成）。两向草稿都汇入 `workspaces/`，共用 asset.md §B 升格——`workspaces/` 是收敛点。

## 代码层映射（设计侧消费，写入 CONTEXT.md 或 CLAUDE.md）

交接包按代码层分文件（components / types / store / prompts / i18n），各层对应的**实际代码目录因技术栈而异**，必须声明一次供 `dao-design` asset.md §B 生成 handoff 时填对路径：

- **设计/代码同仓（monorepo）** → 写项目根 `CLAUDE.md`
- **设计/代码分仓**（design/ 与代码在不同目录，如本类 Open Design 项目）→ 写 `design/CONTEXT.md`（升格在设计侧运行，读 CONTEXT.md）

```markdown
## 设计交接代码层映射
- components → <项目实际组件目录>
- types → <项目实际类型目录>
- prompts → <项目实际 prompt 目录>
```

## 检查清单

- [ ] `design/pages/` 存在（页面设计稿）
- [ ] `design/components/` 存在（组件/弹窗设计稿）
- [ ] `design/ref/` 存在（参考工具）
- [ ] `design/workspaces/` 存在（含 README.md）
- [ ] `design/archive/` 存在（含 README.md）
- [ ] `design/handoff/` 存在
- [ ] 🤖 `design/CONTEXT.md` 存在（会话对齐入口。本条已进共性 rule 备案清单 `ccswitch/scaffold-manifest.json`；本清单其余各条**刻意未机器化**——十条存在性检查一次性全报会淹没其他项，且 symlink 有效性需 lstat + 目标可达判定，属深度检查，理由记在清单的 `_doc.rejected`）
- [ ] `design/CHANGELOG.md` 存在
- [ ] `design/PROTOTYPE-SPEC.md` 存在（OD 原型输出规范：三层 Tailwind 策略 + 项目 tailwind.config 映射 + 类名速查。缺项时从项目 `tailwind.config.*` 自动生成骨架——见下方模板）
- [ ] 「设计交接代码层映射」已声明（同仓→CLAUDE.md；分仓→CONTEXT.md）
- [ ] `design/.od-skills/` 两个 symlink 有效（README.md + dao-design-protocol.md，`Get-Item` 的 LinkType=SymbolicLink 且目标存在——symlink 不入 git，换机/克隆后必然缺失，本检查是唯一恢复触发点；创建步骤见下方「OD 协议 symlink」节）
- [ ] `design/.od-sync.json` 存在且 `odProjectId` 指向的 OD 工作目录存在（配置了 OD 面板同步的项目；指针过期——如 OD 项目重建后 UUID 变化——同步会静默落到废弃目录）
- [ ] `.vscode/settings.json` 用 `files.exclude` 隐藏 Open Design 生成的 `*.artifact.json`（及同类工具自动生成、已在 `.gitignore` 但仍会出现在 Explorer 树里的文件）。这类文件不受 git 追踪，属于本地视觉干扰而非仓库结构债务，不要误判为"目录混乱"去做大规模重排——`.vscode/settings.json` 已在多数项目 `.gitignore` 中被显式排除跟踪（`!.vscode/settings.json`），可安全共享（TraceyU project-structure-overhaul Loop 实证：`design/` 根目录 19 个 `.artifact.json` 全部已 gitignore，真正需要改的只有这一个 IDE 配置文件）

缺项处置见 SKILL.md §缺项怎么处置。目录与文档类缺项属**乙档**（可代建，但要说清依据）；**搬移既有资产、删除误判为冗余的文件属丙档，一律只建议**。

## PROTOTYPE-SPEC.md 生成指引

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

## OD 端协议（symlink → windsurf-dao）

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

## design-spirit.md 模板（rule 脚手架，迁移自 `dao-design` open.md §B）

> 各复归其根。设计精神归 rule 文件，不归会话。原属 `dao-design` open.md §B——因该文件按"消费引擎"单一职责瘦身（fortify2-20260726 skills F2），脚手架模板迁移至此：本节服务的是项目脚手架场景，归属 scaffold 家族比归属消费引擎更贴切。触发条件、模板内容、更新时机原样保留。

**当 `dao-loop` planning.md §4 谋线步骤 9（rule 检查）检测到 design Loop 缺少 `design-spirit.md` 时，按以下模板自动创建。**

模板路径：`.claude/rules/design-spirit.md`，`paths:` 设为 `apps/*/src/**`（或项目实际前端路径）。

```markdown
---
paths:
  - "apps/*/src/**"
  - "packages/*/src/**"
---

# 设计精神（四维检查清单）

> 本文件由 dao-design 谋线自动创建，造线过程中持续更新。

## 视觉维度
- [ ] 所有色彩使用语义 token，禁止硬编码 hex/hsl
- [ ] 字号使用 design-tokens.md 定义的 token
- [ ] 圆角/阴影/间距使用项目 token 体系
- [ ] 亮暗双主题视觉一致

## 交互维度
- [ ] 所有可交互元素有 hover/focus/active/disabled 四态
- [ ] 动效尊重 prefers-reduced-motion
- [ ] Loading/Empty/Error 三态有设计覆盖
- [ ] 键盘可达性（Tab 序 + Enter/Escape 响应）

## 导航维度
- [ ] 页面间导航形成闭环（去得了就回得来）
- [ ] 深层页面有返回上级路径
- [ ] 导航矩阵（下方）覆盖所有页面跳转

## 无障碍维度
- [ ] 图标按钮有 aria-label
- [ ] 对话框有 aria-modal + aria-labelledby
- [ ] 进度指示有 role="progressbar" + aria-valuenow
- [ ] 状态变更有 aria-live 通知

## 组件策略判据

| 场景 | 策略 | 判断标准 |
|------|------|---------|
| 设计稿结构简单，直接翻译 | native | 无交互、无状态、无复用 |
| 项目已有组件可扩展 | extend | 增加 variant/size 即可覆盖 |
| 需要组合或添加动效 | wrap | 单个基础组件不够，需封装 |
| 全新独特交互 | custom | 无现有组件可复用 |

## 导航闭环矩阵

<!-- 造线过程中持续填写 -->
| 起点页 | 终点页 | 触发元素 | 实现状态 |
|--------|--------|---------|---------|
```

**更新时机**：
- 谋线创建（`dao-loop` planning.md §4 步骤 9）：初始化模板
- 造线 Phase 检查点（`dao-loop` execution.md §5 造线）：更新导航矩阵 + 勾选已覆盖的检查项
- 归档规范同步（`dao-loop` closing.md §7.4 规范同步）：最终更新，标记未覆盖项为 deferred
