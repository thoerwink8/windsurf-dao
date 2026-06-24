---
name: dao-design-fidelity
description: 设计还原度五层金字塔——从 token 语义到视觉像素到跨主题的完整验证体系。UI 变更声明完成前、Loop 归档前、设计审计时触发
---

# 设计还原度 · Design Fidelity

> 大成若缺，其用不弊。大盈若冲，其用不穷。
> ——《道德经》第 45 章

"Pixel-perfect" 已被行业抛弃（W3C Design Tokens 2025.10 stable）。
但 token 对齐 ≠ 视觉对齐。真正的还原度是**五层金字塔**——逐层叠加，缺一不可。

**流水线位置**：Design Pipeline **Phase 2（验证）**。上游是 `dao-design-open`（Phase 1，翻译完成后必须通过本 skill L1+L2），下游是 `dao-component-radar`（Phase 3，fidelity 发现组件级问题时触发）。L1 合规基线来自 `dao-design-system`（Phase 0）的不变层规则。详见 `dao-design-system` §7。

---

## §1 · 五层金字塔

每层有明确的 pass 判据和验证方式。下层不过，上层无意义。

### L1 · Token 语义（Semantic Tokens）

**判据**：所有视觉属性使用项目 design token，零硬编码。

| 维度 | pass 条件 | 验证手段 |
|------|----------|---------|
| 字号 | `text-[Npx]` 零结果 | `grep -r "text-\[" src/` |
| 颜色 | 无硬编码 hex/hsl/rgb | `grep -rE "#[0-9a-fA-F]{3,8}\b" --include="*.tsx"` |
| 圆角 | 使用项目 rounded-* token | 契约测试 |
| 阴影 | 使用项目 shadow-* token | 契约测试 |

**自动化**：100% CI。契约测试（`*contract*.spec.*`）断言组件 className 包含正确 token class。

### L2 · 结构布局（Structural Layout）

**判据**：DOM 层级/嵌套与设计原型 HTML 对应，间距误差 ≤ 2px。

| 维度 | pass 条件 | 验证手段 |
|------|----------|---------|
| 层级 | React 组件树 ↔ 设计 HTML 层级一一映射 | 人工比对 or DOM snapshot |
| 间距 | padding/margin/gap 与设计 CSS 值差 ≤ 2px | DevTools 量取 or 截图标注 |
| 尺寸 | width/height 与设计一致（或 responsive 等效） | 同上 |

**自动化**：Storybook 组件级 + snapshot 测试可覆盖，无 Storybook 项目则人工走查。

### L3 · 视觉像素（Visual Pixels）

**判据**：设计原型截图 vs 实现截图，像素差异率 ≤ 阈值。**必须覆盖状态矩阵中的所有态，不只是默认态**（详见 §6.4）。

| 页面类型 | 阈值 | 说明 |
|----------|------|------|
| 核心页面（首页/工作区） | ≤ 0.05% | 高频使用，用户感知强 |
| 次要页面（设置/日志） | ≤ 0.1% | 低频使用 |
| 动态内容区（markdown） | ≤ 0.3% | 内容不可控，只检查容器 |

**真相源**：`design/*.html` 原型截图（通过 HTTP server + Playwright 截图）。

**验证流程**：
1. **枚举状态矩阵**（§6.4）——列出每个页面的所有数据量/流程态/条件分支
2. 启动 HTTP server 托管 `design/` 目录
3. Playwright 以固定 viewport（项目默认窗口尺寸）截图每个 `design/*.html`
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
| UI 任务声明完成前 | L1 + L2 + L3 | dao-verify 涅槃门前置 |
| Loop 归档前 | L1 ~ L5 全覆盖 | 归档是承诺，不留债 |
| 设计稿更新后 | 更新 L3 基线 + L1 ~ L3 | 基线随设计演化 |
| 新页面首次实现 | L1 ~ L4 | 建立基线 + 状态矩阵 |
| 发版前 | L1 ~ L5 全覆盖 | 最终门控 |

---

## §3 · 工具链能力要求

每层需要的**能力**，具体工具由项目 `.claude/rules/design-fidelity.md` 指定：

| 层级 | 需要的能力 | 自动化目标 |
|------|----------|-----------|
| L1 | 源码文本搜索 + 单元/契约测试 | 100% CI |
| L2 | DOM 结构快照 or 人工量取 | 按需 |
| L3 | 固定 viewport 截图 + 像素级 diff + 阈值判定 | 90% CI |
| L4 | 可编程 UI 交互（hover/focus/click）+ 逐状态截图 | 80% CI |
| L5 | 主题切换 + L3 能力的双套执行 | 100% CI |

---

## §4 · 设计交付验收清单（通用模板）

每个 UI 变更提交前，过这张清单：

```markdown
## Design Fidelity Checklist

### L1 · Token
- [ ] 所有颜色使用语义 token，无硬编码 hex
- [ ] 所有字号使用项目 token，无 text-[Npx]
- [ ] 圆角/阴影使用项目 token
- [ ] 契约测试通过

### L2 · 结构
- [ ] 组件层级与设计原型对应
- [ ] 间距与设计误差 ≤ 2px

### L3 · 视觉
- [ ] 截图 diff 率 ≤ 阈值（核心 0.05% / 次要 0.1%）
- [ ] 新页面已建立截图基线

### L4 · 交互
- [ ] hover/focus/active/disabled 四态视觉正确
- [ ] empty/loading/error 三态覆盖

### L5 · 主题
- [ ] Light + dark 双主题截图通过
```

---

## §5 · 项目落地指南

本 skill 定义方法论（WHAT + WHY），项目侧定义实现（HOW）。

每个有 `design/` 目录的项目，应在 `.claude/rules/design-fidelity.md` 中写明：

1. **页面清单**：哪些 design/*.html 对应哪些 app 路由/组件
2. **阈值配置**：每个页面属于哪一档（核心/次要/动态）
3. **Viewport**：截图的固定尺寸（通常是项目默认窗口尺寸）
4. **基线位置**：截图基线文件存放路径
5. **运行命令**：一键执行全量对比的命令

### 与 dao-design-open 的关系

`dao-design-open` 负责 **design → code 翻译**（读设计资产 → 产出 React 代码）。
`dao-design-fidelity` 负责 **code → design 验证**（对比实现是否忠于设计）。

两者构成闭环：翻译 → 验证 → 偏差修复 → 再验证。

### 与 dao-loop 的关系

Loop 的 UI 任务在造线阶段，每个 Task 完成后应至少过 L1 + L3。
Loop 归档前（§6.5 验收比对）应 L1 ~ L5 全覆盖。

---

## §6 · 截图对比标准流程

> 不知常妄作凶。看到截图才有发言权。

**标准工具：Playwright headless**（dao.md 目·观门控的硬覆盖场景——像素级 diff 强制 playwright，不论用户会话偏好）。所有 L3~L5 验证统一使用 Playwright headless browser 截图 + `toHaveScreenshot()` 像素级 diff。不使用人工截图、浏览器插件或其他非 headless 方式——可复现性是自动化的前提。

### 6.1 建立基线

1. Playwright `webServer` 自动启停 HTTP server 托管 `design/` 目录
2. 以项目固定 viewport（`playwright.config.ts` 中配置）逐页截图
3. 基线存入 `*-snapshots/` 目录，纳入版本管理
4. **基线更新（设计稿变更后）**：`npx playwright test --update-snapshots --config <config>`，人工确认截图合理后 commit

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

**L3~L5 截图前的强制前置步骤**。不枚举状态就截图 = 只验了冰山一角。

每个页面截图前，必须先生成该页面的状态矩阵：

| 维度 | 枚举内容 | 示例 |
|------|---------|------|
| 数据量 | empty(0) / single(1) / normal / overflow(100+) | 项目列表：0 个项目 / 1 个 / 5 个 / 50 个 |
| 流程态 | idle / loading / error / complete | 生成中 / 生成失败 / 生成完成 |
| 条件分支 | 页面内不同模式或条件渲染 | 当前轮 vs 历史轮、有候选 vs 无候选 |
| 组合态 | 上述维度的关键交叉 | 当前轮 + 0 候选 = 空工作区（截图中的大面积空白） |

**执行流程**：

1. **枚举**：对照代码中的条件渲染逻辑（`if/else`、`length === 0`、`&&` 短路），列出每个页面的所有视觉分支
2. **标注设计覆盖**：标记每个状态在 `design/*.html` 中是否有对应原型
   - 有原型 → 截图对比
   - 无原型 → 标记为「代码独有态」，检查是否有合理的空态/错误态视觉处理
3. **截图**：逐态截图，不只截默认态
4. **判定**：
   - 有原型的状态：按 L3 阈值判定
   - 无原型但代码有渲染的状态：检查是否有合理的视觉处理（不能是空白大面积留空）
   - 代码未处理的状态：标记为 **缺失态**，作为 fidelity issue 上报

**项目落地**：每个项目的 `.claude/rules/design-fidelity.md` 应包含完整的状态矩阵表。新页面首次实现时必须同步建立。

**为什么这一步不能省**：Token diff 只能查「值对不对」，不能查「有没有」。一个页面在 0 数据时渲染出巨大空白，token 全对但体验全错——只有状态矩阵能系统性地暴露这类问题。

### 6.5 Playwright 脚本验证标准流程

**Playwright headless 是 L3~L5 视觉验证的默认路径**，不依赖桌面窗口状态。windows-mcp Screenshot 降为「调试辅助」——仅用于查看 Tauri 原生窗口行为、系统级 UI 或桌面交互调试。

#### 工具定位

| 工具 | 定位 | 使用场景 |
|------|------|---------|
| Playwright headless | **主路径** · 验证/回归/审计 | L3~L5 全部视觉验证、CI 回归、Loop 归档验收 |
| windows-mcp Screenshot | 辅助 · 调试 | Tauri 原生窗口边框/系统托盘/菜单栏等 headless 无法触及的场景 |
| toHaveScreenshot() | 回归门 · CI | 捕捉 diff（基线 vs 当前），阻止视觉退化 |

**互补关系**：`toHaveScreenshot()` 是自动化回归门（CI 跑、diff 判定、阻止合入），验证脚本是人可读审计产出（截图存 `_tmp/qa/`、供人工审阅、覆盖全状态矩阵）。两者互补而非替代。

#### 优势（为什么不用桌面截图）

- **可复现**：不受桌面遮挡、分辨率缩放、窗口焦点影响
- **可自动化**：CI 可跑，Loop 验收可批量执行
- **可控数据**：通过 mock 注入控制每个页面每个状态的展示数据
- **可编程遍历**：状态矩阵（§6.4）中的所有态一次脚本全覆盖

#### 脚本必须步骤（工具无关）

项目从此规范派生具体脚本（Playwright / Puppeteer / Cypress 等均可）。以下步骤定义的是**不可省略的结构**——项目可以加步骤，不能减。

**数据结构**——脚本必须维护一个页面-状态清单，每条记录包含：

| 字段 | 含义 |
|------|------|
| 页面标识 | 如 `dashboard`、`report` |
| 状态标识 | 如 `empty`、`loading`、`overflow` |
| 导航方式 | 路由或操作序列 |
| 状态注入 | mock 数据注入 / 触发条件的操作 |
| 设计原型路径 | 对应 `design/*.html`（无则为代码独有态） |
| 阈值档位 | core(0.05%) / secondary(0.1%) / dynamic(0.3%) |

清单从项目 `.claude/rules/design-fidelity.md` 的状态矩阵提取。**清单为空或只有一个态 = 脚本不合规**。

**执行步骤**（每条记录顺序执行）：

1. **状态注入**：有 setup 则执行（注入 mock 数据 / 触发 loading / 设置条件）
2. **导航**：进入目标页面，等待渲染稳定（网络空闲或关键元素可见）
3. **截图**：存入 `_tmp/qa/fidelity/verify-<page>-<state>.png`（人可读审计产出）
4. **有原型 → 像素 diff**：与设计原型基线对比，超阈值则 fail
5. **无原型（代码独有态）→ 空白检测**：内容区面积占比 > 30%，否则判为大面积空白 fail
6. **设计原型截图**：由自动化工具启停 `design/` HTTP server 截图，存为基线（`*-snapshots/`，tracked），不存 `_tmp/`

**项目落地**：项目在 `.claude/rules/` 或 `tests/` 目录下维护具体的验证脚本文件，脚本语言/框架/API 由项目技术栈决定。skill 层不规定实现细节。

#### 执行规范

1. **必须覆盖状态矩阵全部态**——不是只截 "看起来正常的" 默认态。`PAGE_STATES` 为空或只有一个态 = 脚本不合规
2. **输出路径**：审计截图 → `_tmp/qa/fidelity/`；回归基线 → `*-snapshots/`（tracked）
3. **命名**：`<type>-<page>-<state>.png`，type 从 `audit|compare|verify` 三选一
4. **Loop 场景**：造线 Task 完成后跑子集（该 Task 涉及的页面），归档前跑全量
5. **CI 场景**：全量脚本纳入 CI，PR 合入前必须绿

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
