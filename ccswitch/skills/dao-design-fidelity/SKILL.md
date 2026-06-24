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

**判据**：设计原型截图 vs 实现截图，像素差异率 ≤ 阈值。

| 页面类型 | 阈值 | 说明 |
|----------|------|------|
| 核心页面（首页/工作区） | ≤ 0.05% | 高频使用，用户感知强 |
| 次要页面（设置/日志） | ≤ 0.1% | 低频使用 |
| 动态内容区（markdown） | ≤ 0.3% | 内容不可控，只检查容器 |

**真相源**：`design/*.html` 原型截图（通过 HTTP server + Playwright 截图）。

**验证流程**：
1. 启动 HTTP server 托管 `design/` 目录
2. Playwright 以固定 viewport（项目默认窗口尺寸）截图每个 `design/*.html`
3. 启动 dev server
4. Playwright 以相同 viewport 截图对应的 app 页面
5. `toHaveScreenshot()` 或 pixel diff 工具对比，超阈值则 fail

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

## §6 · 截图对比的概念流程

> 不知常妄作凶。看到截图才有发言权。

### 6.1 建立基线

1. 将设计原型目录通过 HTTP 服务可访问
2. 以项目固定 viewport 逐页截图，存为**设计基线**
3. 基线纳入版本管理（或 CI 产物存储）

### 6.2 对比实现

1. 启动项目 dev server
2. 以相同 viewport 截图对应的 app 页面
3. 逐页与设计基线做像素 diff，超阈值则 fail

### 6.3 偏差分类与处置

截图 diff 产出三件套：expected（设计）、actual（实现）、diff（差异高亮）。

| 偏差类型 | 表现 | 处置 |
|----------|------|------|
| Token 偏差 | 字号/颜色/圆角不对 | 回到 L1 修复 |
| 布局偏差 | 间距/对齐/尺寸不对 | L2 修复 |
| 渲染差异 | 字体渲染/抗锯齿/亚像素 | 可接受，调高该页阈值 |
| 内容差异 | demo 数据不同 | 排除——用固定 mock 数据 |

具体命令和工具配置见项目 `.claude/rules/design-fidelity.md`。

---

## 参考

- W3C Design Tokens Format Module (2025.10 stable)
- Shopify Polaris: CI token enforcement + visual regression
- GitHub Primer: Design token contract tests
- 行业趋势：AI-assisted visual diff 将误报率降低约 40%（2025-2026）
