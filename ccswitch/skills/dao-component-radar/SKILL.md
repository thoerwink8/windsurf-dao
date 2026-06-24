---
name: dao-component-radar
description: 结构健康门——检测原生 HTML 应提炼为组件、重复 className、token 冲突，在 UI 文件编辑时自动触发
---

# 组件雷达 · Component Radar

> 不知常妄作凶。未识别的原生 HTML 是隐性技术债。

本 skill 专注**结构健康**——组件是否被正确提炼、复用。

**流水线位置**：Design Pipeline **Phase 3（健康）**。上游是 `dao-design-fidelity`（Phase 2，fidelity 发现组件级问题时触发本 skill），token 冲突反馈回 `dao-design-system`（Phase 0）的豁免列表。详见 `dao-design-system` §7。

## 触发条件

编辑 `components/` 或 `src/` 下的 `.tsx` 文件时自动加载。不适用于纯逻辑文件、测试文件、类型文件。

## 检测模式（三关）

### 关一：原生 HTML 识别

在业务组件（非 `ui/` 目录）中搜索以下模式：

| 模式 | Grep 模式 | 阈值 |
|---|---|---|
| 原生 `<button>` 带手写 className | `<button[^>]*className` 排除 `ui/` | ≥ 1 即标记 |
| 原生 `<input>` 带手写 className | `<input[^>]*className` 排除 `ui/` | ≥ 1 即标记 |
| 原生 `<a>` 带手写样式 | `<a[^>]*className` 排除 `ui/` | ≥ 2 |

**判定**：每个标记项给出建议——使用哪个现有 `ui/` 组件替代，或建议新建。查项目配置（`.claude/rules/component-health.md`）的替代映射表获取项目级建议。

**豁免**（原生 HTML 合理的场景）：
- `role="tab"` / `role="option"` / `role="menuitem"` 等 ARIA 组合模式——有明确语义角色且不适合套 Button
- 第三方库包裹的内部元素
- 纯展示用途无交互行为的元素（如 `<div>`、`<span>` 做布局）

### 关二：重复 className 检测

同一 className 组合（≥ 3 个 token）出现在 2+ 个不同业务组件文件中：

```
Grep "rounded-full.*px-.*text-caption" 限定 components/ 排除 ui/
```

阈值：同一组合 2+ 文件即标记，建议提取为 CVA 组件或 `styles.ts` 常量。

### 关三：Token 冲突检测

读取项目配置（`.claude/rules/component-health.md`）的 `已知 Token 冲突对` 表，Grep 搜索当前编辑文件是否使用了冲突 token。

例：`bg-muted` 在 `bg-workspace` 容器内几乎透明——项目配置记录此冲突对，雷达发现时主动警告。

## 输出格式

扫描结果融入回答，不单独成段（除非问题严重）：

- **无问题**：一句话带过——"组件雷达扫描通过，无原生 HTML 需提炼。"
- **有问题**：列出发现并给出具体行动建议：

```
🔍 组件雷达：
- 原生 HTML：<N> 处（<文件:行号 → 建议替代>）
- 重复 className：<N> 处（<模式 → 建议提取>）
- Token 冲突：<N> 处（<冲突对 → 修复方案>）
```

## 与 dao-design-open 的关系

| skill | 关注点 | 触发时机 |
|---|---|---|
| dao-design-open | 设计翻译（Open Design 产出→项目代码三维对齐） | 涉及 design/ 目录 |
| dao-component-radar | 结构健康（组件提炼、原生 HTML、复用度） | UI 文件编辑 |

两者独立触发，可同时生效。design-open 侧重**设计→代码的忠实翻译**，component-radar 侧重**逐文件原生 HTML 识别和具体替代建议**。

## 演化机制

每次发现新的替代映射（"原生模式 X → 应用组件 Y"），更新项目级配置的替代映射表。这让雷达越跑越准——过去踩过的坑自动成为未来的检测规则。
