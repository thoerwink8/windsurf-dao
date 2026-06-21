# Phase 2 · 波次规划（Wave Planning）

> 合抱之木，生于毫末；九层之台，起于累土。

### 2.1 波次拆分原则

**核心思想：按依赖顺序拆分，每波独立可验证。**

```
Wave 依赖图：

Token 层变更（改 CSS 变量值）
    ↓ 级联到
基础组件变更（button/input/badge...）
    ↓ 影响
组合组件变更（card-option/nav-row...）
    ↓ 影响
页面级变更（overview/brainstorm...）
```

**波次拆分四原则**：

1. **Token 先行**：能通过改 1 处 CSS 变量级联到全局的变更，单独成一波（如 `--radius-control: 6px → 8px`）。这种变更投入最小、影响最大。

2. **同类聚合**：影响相同类型组件的变更合并为一波（如"移除所有 inset shadow"影响 10 个组件，是同一种操作的批量执行）。

3. **测试隔离**：每波的测试影响可预估且可控。一波改完后跑全量测试，绿了才进下一波。

4. **视觉可验**：每波完成后都能启动 dev server 截图验证，不存在"要等下一波才能看到效果"的半成品状态。

### 2.2 典型波次模板

以下是基于 TraceyU 飞书改造经验总结的通用波次模板：

```
Wave 0: Token 层（0 测试影响）
  - 圆角值调整
  - 颜色值调整
  - 阴影值调整
  → 测试全绿（token 改值不影响 className 断言）

Wave 1: 按钮系统（最核心的交互原子）
  - hover 模式统一
  - active 反馈调整
  - focus ring 样式
  - transition duration
  → 更新 button-contract 测试

Wave 2: 阴影清理（批量同类操作）
  - 移除 inset shadow
  - 统一外阴影层级
  → 更新相关 contract 测试

Wave 3: 状态标签/徽章（视觉身份变化大的组件）
  - 圆角策略（rounded-control → rounded-full）
  - 填充策略（border → 纯色背景）
  → 更新 badge/status contract 测试

Wave 4: Hover/Transition 全局统一
  - 所有 hover 统一为目标值
  - 所有 duration 统一
  → 更新 navigation/table contract 测试

Wave 5: 拖拽系统（如有）
  - 拖拽预览样式
  - Drop zone 指示器
  
Wave 6: Focus 系统
  - ring-offset 统一
  - focus-visible 策略

Wave 7: 动画系统
  - 加载动画（pulse → shimmer）
  - 入场动画
  - 骨架屏样式

Wave 8: 边框与分隔
  - 边框透明度统一
  - 分隔线策略

Wave 9: 浮层系统
  - Popover/Select/Dialog 圆角统一
  - 浮层阴影调整
```

### 2.3 测试影响估算

每波规划时必须预估测试影响：

| 变更类型 | 测试影响 | 示例 |
|---------|---------|------|
| CSS 变量值变更 | **零** — 测试断言 className 不检查 computed style | `--radius-control: 6px → 8px` |
| className token 名变更 | **直接** — 需更新 contract 测试中的 toContain 断言 | `rounded-control → rounded-full` |
| 组件结构变更 | **广泛** — 可能需更新 render + query 逻辑 | 重构组件 slot 结构 |
| 新增 CSS class | **零** — 新增不影响已有断言 | 添加 `duration-200` |
| 移除 CSS class | **可能** — 如果有 toContain 该 class 的断言 | 移除 `shadow-[inset...]` |

**估算公式**：`影响的断言数 ≈ 变更的 className token 数 × 引用该 token 的 contract 测试数`

### 2.4 每波执行检查清单

```
□ 代码修改完成
□ pnpm test:run — 全绿（contract 测试同步更新）
□ pnpm typecheck — 类型安全
□ 启动 dev server — 亮色模式截图验证
□ 切换暗色模式 — 暗色模式截图验证
□ git commit — 一波一个 commit，message 描述本波改动
□ 无半成品状态 — 本波是完整的、可回滚的
```
