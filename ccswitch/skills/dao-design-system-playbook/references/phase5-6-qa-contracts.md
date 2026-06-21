# Phase 5-6 · 视觉 QA + 契约测试

## Phase 5 · 视觉 QA 自动化（Visual QA Automation）

> 明白四达，能无知乎？看了才知道，不看只是猜。

### 5.1 截图驱动验证工作流

**核心理念：代码改完不截图就不算完。** 

视觉改动的验证不能只靠测试通过——测试检查 className，不检查最终渲染效果。

```
修改代码
    ↓
跑测试（className 正确性）
    ↓
启动 dev server
    ↓
Playwright/Chrome DevTools 截图
    ↓
亮色模式检查 → 暗色模式检查
    ↓
发现问题？→ 修复 → 回到截图
    ↓
无问题 → commit
```

### 5.2 截图覆盖清单

**每次设计改动后，至少覆盖以下视图**：

| 视图 | 检查点 | 优先级 |
|------|--------|--------|
| 概览页 | 指标卡、池标签、空态 | 高 |
| 工作区 | 卡片、拖拽区、操作按钮 | 高 |
| 侧栏 | 导航项、hover 态、选中态 | 高 |
| 对话框 | 设置、新建项目、确认 | 中 |
| 报告视图 | 排版、表格、代码块 | 中 |
| 空态/引导 | Welcome 卡片、Empty state | 中 |
| 加载态 | Skeleton、Spinner、进度条 | 低 |

### 5.3 Playwright 截图自动化

```typescript
// 基本截图验证脚本
const { chromium } = require('playwright')

async function visualQA() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  
  await page.goto('http://localhost:5173')
  
  // 亮色模式截图
  await page.screenshot({ path: 'qa-light.png', fullPage: true })
  
  // 切换暗色模式
  await page.evaluate(() => {
    document.documentElement.classList.add('dark')
  })
  await page.screenshot({ path: 'qa-dark.png', fullPage: true })
  
  await browser.close()
}
```

### 5.4 Chrome DevTools MCP 验证

有 Chrome DevTools MCP 时的增强验证：

```
1. evaluate_script 量测关键元素的 computed style：
   - 按钮 padding、border-radius、font-size
   - 间距值是否与 token 定义一致
   - 颜色值是否正确引用 CSS 变量

2. 多视口验证：
   - 默认窗口（1280×820）
   - 最小窗口（如 1180×720）
   
3. 交互态验证：
   - hover 元素截图
   - focus 元素截图
   - 打开 popover/dialog 截图
```

## Phase 6 · 契约测试守护（Contract Test Guardianship）

> 知常曰明。不知常妄作凶。

### 6.1 什么是契约测试

**契约测试断言组件的 className 包含正确的 design token class。** 它们是设计系统的自动化守卫——防止未来的修改无意中破坏设计一致性。

```typescript
// 典型的契约测试断言
expect(button.className).toContain('rounded-control')
expect(button.className).toContain('duration-200')
expect(button.className).toContain('hover:bg-foreground/[.04]')
expect(button.className).not.toContain('shadow-[inset')
expect(button.className).not.toContain('rounded-lg') // 禁止非 token 圆角
```

**契约测试 ≠ 快照测试**：
- 快照测试（snapshot）记录完整输出，任何变化都报警 → 噪音大、维护成本高
- 契约测试只断言关键 token → 精准、低维护、高信号

### 6.2 契约测试文件命名约定

```
components/ui/
├── button.tsx
├── button-system-contract.spec.tsx     ← 按钮系统契约
├── nav-row.tsx
├── navigation-system-contract.spec.tsx ← 导航系统契约
├── semantic-badge.tsx
├── status-system-contract.spec.tsx     ← 状态系统契约
└── ...
```

### 6.3 修改 UI 后同步契约测试的流程

```
1. 修改组件 className
    ↓
2. 跑 pnpm test:run — 预期某些 contract 测试失败
    ↓
3. 检查失败的断言：
   - 如果是旧值 → 更新为新值（如 hover:bg-muted → hover:bg-foreground/[.04]）
   - 如果是被移除的 class → 改为 not.toContain 或删除断言
   - 如果是新增的 class → 添加新的 toContain 断言
    ↓
4. 再跑 pnpm test:run — 全绿
    ↓
5. 一起 commit（代码改动 + 测试更新在同一个 commit）
```

### 6.4 契约测试的设计覆盖维度

| 维度 | 断言什么 | 示例 |
|------|---------|------|
| 圆角 | token class 名 | `toContain('rounded-control')` |
| hover | 叠加色 class | `toContain('hover:bg-foreground/[.04]')` |
| transition | duration class | `toContain('duration-200')` |
| 阴影 | 不含 inset shadow | `not.toContain('shadow-[inset')` |
| slot 标识 | data-slot 属性 | `toHaveAttribute('data-slot', 'toolbar-surface')` |
| asset 标识 | data-asset 属性 | `toHaveAttribute('data-asset', 'toolbar-surface')` |
| 布局 | 关键 flex/grid class | `toContain('overflow-x-auto')` |
| 否定 | 禁止的 class | `not.toContain('flex-wrap')` |
