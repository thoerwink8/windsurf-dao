---
trigger: model_decision
description: 设计资产管理——pencil 设计工作流、Token 同步、组件添加策略、foundation-standard.md 的定位。涉及 UI 设计、创建组件、修改样式时读取
---

# 设计资产 · 怎么做设计

> 道生一（Token），一生二（基础件），二生三（业务件），三生万物（页面）。

## 设计工作流

```
dao-brainstorm → design spec (docs/specs/)
    ↓
pencil 设计阶段
    ├── ① Token 层（色板/字体/间距/圆角）   → pen 变量，一次性设定
    ├── ② 业务组件（reusable 组件）          → 在 pen 里定义，代码照着实现
    └── ③ 页面设计稿（完整屏幕 × light/dark）→ 组合组件成页面
    ↓
dao-plan → 任务清单
    ↓
dao-execute → 代码实现
    ├── shadcn add（按需装基础件）
    ├── 业务组件代码（照 pencil 实现）
    └── 页面代码（组合组件）
```

## 三层分责

| 层 | 谁管 | 你维护什么 |
|---|---|---|
| **shadcn 通用交互** | Radix UI 内核 | 不管——键盘导航、ARIA、焦点管理已内置 |
| **Token + 交互定制** | foundation-standard.md | Token 全表 + 暗色规则 + 对 shadcn 默认值的覆盖 |
| **业务组件** | pencil 设计 + 代码 | 设计稿 → 代码实现 → 规范文档 |

## 组件添加策略

**shadcn 按需 add，不提前装**。Token 层保证任何新组件装进来都自动继承设计规范。

| 时机 | 操作 |
|---|---|
| 页面设计稿需要 Tabs | `npx shadcn add tabs` → 自动放入 `components/ui/` |
| 页面需要 Skeleton | `npx shadcn add skeleton` → 装完即用 |
| 想浏览有什么可用 | 查 shadcn 官网或 `npx shadcn add --help` |
| 业务组件（PoolColumn 等） | 先在 pencil 设计 → 再写代码到 `components/` 根层 |

**铁律**：
- 不提前装不用的 shadcn 组件（YAGNI）
- 装完后跑 foundation-standard.md 的自检清单验证 Token 继承
- 业务组件不放 `ui/` 子目录

## foundation-standard.md 的定位

**它是什么**：Token 规范 + 交互定制 + 业务组件规范 + 新组件自检清单
**它不是什么**：不重复写 shadcn 已有的通用交互逻辑

### 推荐结构

```
foundation-standard.md
├── § Token 规范（色彩/暗色/字体/间距/圆角/阴影）      → 保留
├── § 交互定制（对 shadcn 默认值的覆盖，如 tooltip 延迟）→ 保留
├── § 组件选型指南（业务场景 → shadcn 组件映射表）       → 新增
├── § 业务组件规范（PoolColumn / RoundSection / ...）    → 新增
├── § 无障碍补充                                         → 保留
├── § 决策日志                                           → 保留
└── § 新组件自检清单                                     → 保留
```

**不包含的内容**：逐个 shadcn 组件的 API、交互状态、键盘快捷键（这些在 shadcn 官方文档里）。

## pencil 设计稿管理

- **一个项目一个 pen 文件**：`docs/design/<project>.pen`
- pen 内部结构：Design System（token）→ Reusable Components → Screen 1~N
- 每个屏幕做 light + dark 两版（通过 pen theme 切换）
- 导出 PNG 到同目录，用于 git diff 可视化
- 设计稿变更时先改 pen → 再改代码（pen 是 source of truth）

## 与 dao-ui-mockup 的关系

| | dao-ui-mockup（HTML） | pencil（.pen） |
|---|---|---|
| 用途 | **快速原型探索**：多套视觉方向让用户选 | **正式设计**：持续维护的设计源 |
| 时机 | brainstorm 阶段，探索视觉风格 | brainstorm 之后，确定方向后 |
| 产物 | 一次性 HTML，不持续维护 | .pen 文件，持续更新 |
| 组件 | HTML 里 copy-paste | reusable 组件，实例化引用 |

两者互补，不是替代。快速探索用 HTML mockup，确定后用 pencil 做正式设计。
