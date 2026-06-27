---
trigger: model_decision
description: 设计资产管理——Open Design HTML 原型工作流、Token 同步、组件添加策略、foundation-standard.md 的定位。涉及 UI 设计、创建组件、修改样式时读取
---

# 设计资产 · 怎么做设计

> 道生一（Token），一生二（基础件），二生三（业务件），三生万物（页面）。

## 设计工作流

dao-brainstorm → design spec → **Open Design 设计阶段**（HTML 原型为唯一视觉真相源：① Token 层 CSS 变量 → ② 业务组件 HTML 原型 → ③ 页面设计稿 light/dark）→ dao-plan → 代码实现（shadcn add 按需装 + 业务组件照原型 + 页面组合组件）。

## 三层分责

| 层 | 谁管 | 你维护什么 |
|---|---|---|
| **shadcn 通用交互** | Radix UI 内核 | 不管——键盘导航、ARIA、焦点管理已内置 |
| **Token + 交互定制** | foundation-standard.md | Token 全表 + 暗色规则 + 对 shadcn 默认值的覆盖 |
| **业务组件** | Open Design HTML 原型 + 代码 | 设计稿 → 代码实现 → 规范文档 |

## 组件添加策略

**shadcn 按需 add，不提前装**。Token 层保证任何新组件装进来都自动继承设计规范。

| 时机 | 操作 |
|---|---|
| 页面设计稿需要 Tabs | `npx shadcn add tabs` → 自动放入 `components/ui/` |
| 页面需要 Skeleton | `npx shadcn add skeleton` → 装完即用 |
| 想浏览有什么可用 | 查 shadcn 官网或 `npx shadcn add --help` |
| 业务组件（PoolColumn 等） | 先在 HTML 原型设计 → 再写代码到 `components/` 根层 |

**铁律**：
- 不提前装不用的 shadcn 组件（YAGNI）
- 装完后跑 foundation-standard.md 的自检清单验证 Token 继承
- 业务组件不放 `ui/` 子目录

## foundation-standard.md 的定位

**它是什么**：Token 规范 + 交互定制 + 业务组件规范 + 新组件自检清单
**它不是什么**：不重复写 shadcn 已有的通用交互逻辑

### 推荐结构

Token 规范 → 交互定制（对 shadcn 默认值的覆盖）→ 组件选型指南（业务场景→shadcn 映射）→ 业务组件规范 → 无障碍补充 → 决策日志 → 新组件自检清单。**不含**逐个 shadcn 组件的 API/交互/键盘快捷键（查官方文档）。

## 屏幕状态覆盖 · Screen State Coverage

> 大成若缺，其用不敝。一个只展示"happy path"的设计稿是残缺的。

**铁律：每个屏幕必须在同一画面内展示该场景的所有关键交互状态。**

开发者打开设计稿时，不需要在多个屏幕间切换就能看到：默认态、加载态、空态、错误态、成功态、禁用态的完整表现。

### 状态覆盖清单

每个屏幕逐项过：default / loading（骨架屏/spinner）/ empty（插图+CTA）/ error / hover·active / disabled / 多实例不同状态（如侧栏：选中/完成/进行中/归档）。

**实现**：每种状态独立画布帧并排摆放（禁止嵌套进同一组件尾部）。命名：`屏 N[a/b/c] · <功能名> · <状态名> · Light/Dark`。不穷举排列组合（每态至少一次即可），Dark 通过 theme 切换。

## 设计资产管理

- 设计产物统一存放在 `design/` 目录（HTML 原型 + 截图）
- HTML 原型是 source of truth，代码实现必须对齐原型
- 通过 `dao-design-open` skill 读取 Open Design 产出并执行三维对齐（结构/样式/交互）
- 设计变更时先改 HTML 原型 → 再改代码

## 与快速原型的关系

HTML mockup（dao-design-standards 探索产物）= 一次性快速原型，brainstorm 阶段多方向让用户选。Open Design HTML 原型 = 正式设计源，确定方向后持续维护。两者互补。
