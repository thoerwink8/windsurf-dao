---
name: fidelity.md
description: 设计还原度五层金字塔——从 token 语义到视觉像素到跨主题的完整验证体系。UI 变更声明完成前、Loop 归档前、设计审计时触发
---

# 设计还原度 · Design Fidelity

> 大成若缺，其用不弊。大盈若冲，其用不穷。
> ——《道德经》第 45 章

"Pixel-perfect" 已被行业抛弃（W3C Design Tokens 2025.10 stable）。
但 token 对齐 ≠ 视觉对齐。真正的还原度是**五层金字塔**——逐层叠加，缺一不可。

**流水线位置**：Design Pipeline **Phase 2（验证）**。上游是 `open.md`（Phase 1，翻译完成后必须通过本 skill L1+L2），下游是 `component-radar.md`（Phase 3，fidelity 发现组件级问题时触发）。L1 合规基线来自 `system.md`（Phase 0）的不变层规则。视觉判据引用 `standards.md` §4。交接契约见 `system.md` §7。

---

## §1 · 五层金字塔

每层有明确的 pass 判据和验证方式。下层不过，上层无意义。

### L1 · Token 语义（Semantic Tokens）

**判据**：所有视觉属性使用项目 design token，零硬编码，且 **token 名属于规范词汇集**。

| 维度 | pass 条件 | 验证手段 |
|------|----------|---------|
| 字号 | `text-[Npx]` 零结果 | `grep -r "text-\[" src/` |
| 颜色 | 无硬编码 hex/hsl/rgb | `grep -rE "#[0-9a-fA-F]{3,8}\b" --include="*.tsx"` |
| 圆角 | 使用项目 rounded-* token | 契约测试 |
| 阴影 | 使用项目 shadow-* token | 契约测试 |
| **命名合规** | **每个 `var(--x)`/`--x:` 的名字都在规范集内，无自创名** | **见 L1.1** |

**自动化**：100% CI。契约测试（`*contract*.spec.*`）断言组件 className 包含正确 token class。

### L1.1 · Token 命名合规（Naming Compliance）

**判据**：设计稿与代码用**同一套 token 名**——单一词汇集，零映射表。

**为什么**：「无硬编码」不等于「名字对」。`--go`/`--r-md`/`--fs-xs` 是合法 token，能过 L1 硬编码检查，但它们是**自创短名**，代码侧不存在同名 → 交接时要么靠翻译映射表（脆弱、易错位），要么设计稿引用到代码不认的变量。两套词汇本身就是缺陷。

**唯一命名权威 = `system.md` §3.0**：`--{category}-{role}[-{modifier}]`（如 `--color-success`/`--radius-lg`/`--text-xs`/`--motion-duration-fast`/`--elevation-md`）。设计稿 CSS 和代码 CSS 都遵循它，谁都不许另起短名。

**pass 条件**：设计稿（`design/{pages,components,ref}/*.html` + `design/css/*.css`）里出现的每个 token 名，都能在项目规范 token CSS（代码侧 `index.css` 或设计侧等价物）的定义集中找到。出现规范集外的名字（`--go`/`--r-*`/`--fs-*`/`--sp-*`/`--ease`/`--shadow` 等旧式短名）= **P0 失败**。

**验证手段**：
```bash
# 抽取设计稿用到的所有 token 名，与规范集求差
grep -rhoE '\-\-[a-z0-9-]+' design/ | sort -u   > /tmp/used.txt
grep -rhoE '^\s*\-\-[a-z0-9-]+\s*:' <规范tokenCSS> | grep -oE '\-\-[a-z0-9-]+' | sort -u > /tmp/canon.txt
comm -23 /tmp/used.txt /tmp/canon.txt   # 输出 = 自创名，应为空（仅允许 --font-* 等约定豁免）
```

**改名修复铁律**：把自创名统一到规范名时，**按值映射，不按字面**——圆角/字号常有差级（设计 `--r-xs:6px` → 规范 `--radius-sm:6px`，不是 `--radius-xs:4px`）。改完必走 §6.6 截图实证 diff 为零（纯改名零像素变化）。

### L1.5 · 结构快照（Structural Snapshot）

**判据**：App 关键区块的 ARIA tree 与基线匹配，零结构偏差（元素存在性 + 唯一性 + 嵌套层级）。

**方法**：Playwright `toMatchAriaSnapshot()` 按语义区块拍快照（不拍整页），存为 YAML 基线（`*-snapshots/`，tracked）。结构变动（重复/缺失/嵌套错位）自动报出。

**为什么需要**：L1 查"值对不对"，L3 查"像素像不像"，都无法检测语义内容重复出现——ARIA 快照补上这个盲区。

**自动化**：100% CI。

### L2 · 结构布局（Structural Layout）

**判据**：DOM 层级/嵌套与设计原型 HTML 对应，间距误差 ≤ 2px。

| 维度 | pass 条件 | 验证手段 |
|------|----------|---------|
| 层级 | React 组件树 ↔ 设计 HTML 层级一一映射 | 人工比对 or DOM snapshot |
| 间距 | padding/margin/gap 与设计 CSS 值差 ≤ 2px | DevTools 量取 or 截图标注 |
| 尺寸 | width/height 与设计一致（或 responsive 等效） | 同上 |
| 布局完整性 | 窗口边缘无 >20px 死区（§6.4.1） | `assertNoLayoutGap` 自动化断言 |

**自动化**：Storybook 组件级 + snapshot 测试可覆盖，无 Storybook 项目则人工走查。布局完整性检查（§6.4.1）可全自动化 CI。

### L3 · 视觉像素（Visual Pixels）

**判据**：设计原型截图 vs 实现截图，像素差异率 ≤ 阈值。**必须覆盖状态矩阵中的所有态，不只是默认态**（详见 §6.4）。

| 页面类型 | 阈值 | 说明 |
|----------|------|------|
| 核心页面（首页/工作区） | ≤ 0.05% | 高频使用，用户感知强 |
| 次要页面（设置/日志） | ≤ 0.1% | 低频使用 |
| 动态内容区（markdown） | ≤ 0.3% | 内容不可控，只检查容器 |

**真相源**：`design/pages/*.html` 原型截图（通过 HTTP server + Playwright 截图）。

**验证流程**：
1. **枚举状态矩阵**（§6.4）——列出每个页面的所有数据量/流程态/条件分支
2. 启动 HTTP server 托管 `design/` 目录
3. Playwright 以固定 viewport（项目默认窗口尺寸）截图每个 `design/pages/*.html`
4. 启动 dev server
5. Playwright 以相同 viewport **逐态**截图对应的 app 页面
6. `toHaveScreenshot()` 或 pixel diff 工具对比，超阈值则 fail
7. **无原型的代码独有态**：检查是否有合理的视觉处理，空白大面积留空 = fail

**自动化**：90% CI。新页面首次需人工确认基线；后续 CI 自动回归。

### L4 · 交互状态（Interaction States）

**判据**：每个可交互元素的所有状态均有视觉覆盖。

| 状态 | 必须覆盖 |
|------|---------|
| 静态 | default / hover / focus / active / disabled |
| 数据 | empty / loading / error / success |
| 拖拽 | dragover / dragging（如适用） |

**验证方式**：
- Playwright 脚本逐状态截图，建立状态矩阵
- 对照设计原型的状态变体（如有）

**自动化**：80% CI。复杂交互态（拖拽）可能需人工触发。

### L5 · 跨主题（Cross-Theme）

**判据**：light + dark 双主题均通过 L3 阈值。

**验证方式**：
- 设计原型切换 `data-theme="dark"` 截图
- App 切换暗色模式截图
- 双套对比

**自动化**：100% CI。通过 Playwright `page.emulateMedia({ colorScheme })` 或 `data-theme` 属性切换。

---

## §2 · 何时执行

| 触发场景 | 必须覆盖的层级 | 说明 |
|----------|--------------|------|
| UI 组件修改后 | L1 + L3 | 最小验证集 |
| UI 任务声明完成前 | L1 + L1.5 + L2 + L3 | dao-verify 涅槃门前置 |
| Loop 归档前 | L1 ~ L5 全覆盖（含 L1.5） | 归档是承诺，不留债 |
| 设计稿更新后 | 更新 L3 基线 + L1 ~ L3 | 基线随设计演化 |
| 新页面首次实现 | L1 ~ L4 | 建立基线 + 状态矩阵 |
| 发版前 | L1 ~ L5 全覆盖 | 最终门控 |

---

## §3 · 工具链能力要求

每层需要的**能力**，具体工具由项目 `.claude/rules/design-fidelity.md` 指定：

| 层级 | 需要的能力 | 自动化目标 |
|------|----------|-----------|
| L1 | 源码文本搜索 + 单元/契约测试 | 100% CI |
| L1.5 | Playwright ARIA snapshot (`toMatchAriaSnapshot`) | 100% CI |
| L2 | DOM 结构快照 or 人工量取 | 按需 |
| L3 | 固定 viewport 截图 + 像素级 diff + 阈值判定 | 90% CI |
| L4 | 可编程 UI 交互（hover/focus/click）+ 逐状态截图 | 80% CI |
| L5 | 主题切换 + L3 能力的双套执行 | 100% CI |

---

## §4 · 设计交付验收清单

每个 UI 变更提交前，逐层过关：L1 token 零硬编码 + 契约测试通过 → L1.5 ARIA 快照 diff 通过 → L2 层级/间距与设计对应（误差 ≤2px）→ L3 截图 diff ≤ 阈值 → L4 四态+三态覆盖 → L5 双主题通过。按 §2 触发场景决定覆盖范围。

---

## §5 · 项目落地指南

本 skill 定义方法论（WHAT + WHY），项目侧在 `.claude/rules/design-fidelity.md` 定义实现（HOW），包含：页面清单（design/pages/*.html ↔ app 路由）、阈值配置（核心/次要/动态）、Viewport 尺寸、基线位置、运行命令。

**验证脚本**：项目必须在 `tests/fidelity/` 维护可执行脚本。数据从 design-fidelity.md 状态矩阵提取，覆盖全部态（不只默认态）。审计截图 → `_tmp/qa/fidelity/`，回归基线 → `*-snapshots/`（tracked）。命名：`<type>-<page>-<state>.png`。模板见 `templates/`。

**与其他 skill 的关系**：`open.md`（翻译）→ 本 skill（验证）→ 偏差修复 → 再验证，构成闭环。Loop 造线每 Task 至少过 L1+L3，归档前 L1~L5 全覆盖。

---

## §6 · 截图对比标准流程

> 不知常妄作凶。看到截图才有发言权。

**标准工具：Playwright headless**（dao.md 目·观门控的硬覆盖场景——像素级 diff 强制 playwright，不论用户会话偏好）。所有 L3~L5 验证统一使用 Playwright headless browser 截图 + `toHaveScreenshot()` 像素级 diff。不使用人工截图、浏览器插件或其他非 headless 方式——可复现性是自动化的前提。

### 6.1 建立基线

1. Playwright `webServer` 自动启停 HTTP server 托管 `design/` 目录
2. 以项目固定 viewport（`playwright.config.ts` 中配置）逐页截图
3. 基线存入 `*-snapshots/` 目录，纳入版本管理
4. **基线更新（设计稿变更后）**：`npx playwright test --update-snapshots --config <config>`，人工确认截图合理后 commit
5. **基线防假页面（L10 律二，两度血泪）**：建基线或重构路径后必须验证基线是**真页面**——曾有 13 张 404 截图入库当基线、套件以 404==404 恒等通过多日（2026-07-05）；又有 app 侧把字体未就绪的空白页存成基线、后续全部改动被判 2% diff（2026-07-07）。两道防线缺一不可：① 建基线后人工抽查截图内容（非只看测试绿）；② 结构 guard 前置——页面根容器（如 `[data-slot="app-shell"]`）不存在即 fail，白屏/错误页永远不允许静默成为基线；截图前等 `document.fonts.ready` + 双帧重绘

### 6.2 对比实现（代码 vs 设计）

1. Playwright 启动设计原型 HTTP server + 项目 dev server（双 webServer 或串行）
2. 以相同 viewport 分别截图：设计原型页面 + 对应 app 页面
3. 逐页像素 diff，超阈值则 fail，产出三件套：expected / actual / diff

**过程截图存放**：L3~L5 验证过程中产出的非基线截图（actual / diff / 审计截图）统一存放到 `<项目根>/_tmp/qa/fidelity/`。命名格式：`<type>-<page>-<state>.png`（type: `audit|compare|verify`）。基线截图仍存 `*-snapshots/`（tracked）。过程截图由 `dao-verify` 在体检/涅槃门通过后统一清理。

### 6.3 偏差分类与处置

| 偏差类型 | 表现 | 处置 |
|----------|------|------|
| Token 偏差 | 字号/颜色/圆角不对 | 回到 L1 修复 |
| 布局偏差 | 间距/对齐/尺寸不对 | L2 修复 |
| 渲染差异 | 字体渲染/抗锯齿/亚像素 | 可接受，调高该页阈值并备注原因 |
| 内容差异 | demo 数据不同 | 排除——用固定 mock 数据 |

### 6.4 状态矩阵枚举（State Matrix）

**L3~L5 截图前的强制前置步骤**——不枚举就截图 = 只验了默认态。

每页按四维度枚举：**数据量**（empty/single/normal/overflow）、**流程态**（idle/loading/error/complete）、**条件分支**（页面内不同模式/条件渲染）、**组合态**（关键交叉）。

**流程**：对照代码条件渲染逻辑列出所有视觉分支 → 标注每态是否有设计原型（有→截图对比，无→标记为代码独有态检查空白处理，代码未处理→上报缺失态）→ 逐态截图。

**项目落地**：`design-fidelity.md` 应含完整状态矩阵表，新页面首次实现时同步建立。

### 6.4.1 布局完整性检查（Layout Integrity）

L2 结构层自动化补充——检测窗口边缘死区（Grid/Flex 容器子元素未填满）。

**方法**：取最外层布局容器最后一个可见子元素的 `bottom`/`right` 与容器自身做差值，超 20px → fail。所有页面、所有状态均执行。模态对话框豁免。

**项目落地**：实现 `assertNoLayoutGap` 工具函数，fidelity 脚本每步截图后调用。容器选择器和阈值可在 `design-fidelity.md` 中覆盖。

### 6.5 验证脚本标准流程

**Playwright headless 是 L3~L5 主路径**（可复现/可 CI/可编程遍历状态矩阵）。windows-mcp Screenshot 仅限调试辅助（Tauri 原生窗口等 headless 无法触及的场景）。`toHaveScreenshot()` 是 CI 回归门，验证脚本是人可读审计产出——两者互补。

**脚本数据结构**：页面-状态清单，每条含页面标识 / 状态标识 / 导航方式 / 状态注入 / 设计原型路径 / 阈值档位。清单从 `design-fidelity.md` 状态矩阵提取。清单为空或只有一态 = 不合规。

**每条记录执行步骤**：① 状态注入 → ② 导航（等渲染稳定）→ ③ 截图（`_tmp/qa/fidelity/verify-<page>-<state>.png`）→ ④ 布局完整性检查（§6.4.1）→ ⑤ 有原型→像素 diff / 无原型→空白检测（内容区 >30%）→ ⑥ 设计原型截图存基线（`*-snapshots/`，tracked）

**执行规范**：覆盖状态矩阵全部态；审计截图 → `_tmp/qa/fidelity/`，基线 → `*-snapshots/`；命名 `<type>-<page>-<state>.png`（audit/compare/verify）；Loop 造线跑子集，归档跑全量。

### 6.6 Token 体系变更的特殊处理

**当 Loop 涉及 token 体系变更（收敛/重命名/值调整）时**：

1. **变更前**：用 Playwright 截图全量页面存为「变更前基线」
2. **变更后**：重新截图，与变更前基线 diff
3. **纯改名（值不变）**：diff 应为零。非零 → 说明改名过程引入了值变化，必须定位修复
4. **值变更（如字号收敛 19→6）**：diff 必然非零。逐页审查 diff 标红区域，判断是否可接受。不可接受 → 调整 token 值或组件用法

**禁止假设"只是改名不改值"**——必须用 Playwright 截图实证。

具体命令和工具配置见项目 `.claude/rules/design-fidelity.md`。

---

## 参考

- W3C Design Tokens Format Module (2025.10 stable)
- Shopify Polaris: CI token enforcement + visual regression
- GitHub Primer: Design token contract tests
- 行业趋势：AI-assisted visual diff 将误报率降低约 40%（2025-2026）
