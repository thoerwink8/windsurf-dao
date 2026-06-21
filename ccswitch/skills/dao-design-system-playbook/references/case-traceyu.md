# 附录 B · 案例研究：TraceyU 飞书改造

### B.1 改造概况

| 项目 | TraceyU 决策工作台 |
|------|-------------------|
| 技术栈 | Tauri 2 + React 19 + TypeScript 5.9 + Vite 7 + Tailwind v3 |
| 组件系统 | shadcn/ui + CVA + cn() |
| 改造目标 | 对标飞书（Semi Design）组件风格 |
| 改造范围 | 全局 token + 30+ 组件 + 暗色模式 |
| 改造时长 | ~12 小时（AI 自主循环） |
| 波次数 | 9 波系统改造 + 3 波深度打磨 |
| 测试影响 | ~25 条 contract 测试断言更新 |
| commit 数 | 6 个改造 commit |

### B.2 飞书设计 DNA 提取

通过分析飞书产品和 Semi Design 文档，提取了以下设计决策：

| 维度 | 飞书设计决策 | 原理 |
|------|------------|------|
| hover | N900@4%（`bg-foreground/[.04]`） | 前景色的极低透明度，自适应亮暗模式 |
| inset shadow | **从不使用** | 飞书认为 inset shadow 是拟物残余 |
| 状态标签 | rounded-full pill，纯色无边框 | 药丸形状更现代、更易扫视 |
| 控件圆角 | 8px | 比 6px 更圆润柔和 |
| 过渡 | 200ms | 比 150ms 更丝滑、更有质感 |
| focus ring | ring-2 + ring-offset-2 | offset 让焦点环与元素有呼吸空间 |
| 拖拽 | 无旋转，scale ≤ 1.01 | 克制的拖拽预览，不分散注意力 |
| 骨架 | shimmer 横向扫光 | 比 pulse（明暗交替）更流畅 |
| 浮层圆角 | 12px（与 dialog 统一） | 浮层系统圆角统一感 |
| 边框 | 极轻（/[.30]） | 结构性分隔靠留白，边框只是辅助 |

### B.3 改造时间线

```
Wave 0: Token 层 → --radius-control: 8px               [5 min]
Wave 1: 按钮系统 → hover/active/focus/duration 统一     [15 min]
Wave 2: 移除 inset shadow（10 组件）                     [20 min]
Wave 3: 状态标签 → pill 化                               [15 min]
Wave 4: 全局 hover/transition 统一                       [15 min]
Wave 5: 拖拽系统 → 去旋转、减 scale                      [10 min]
Wave 6: Focus ring offset 统一                           [10 min]
Wave 7: 骨架动画 → shimmer                               [5 min]
Wave 8: 边框透明度统一                                   [5 min]
Wave 9: 浮层圆角统一 → 12px                              [5 min]
────────────────────────────────────────────────
深度打磨 Wave 1: 滚动条/侧栏/Dialog/暗色模式            [30 min]
深度打磨 Wave 2: 表格/工具栏/进度条/视图过渡            [20 min]
深度打磨 Wave 3: 暗色模式对比度修复                      [30 min]
深度打磨 Wave 4: 卡片池按钮飞书化                        [15 min]
```

### B.4 关键教训

1. **暗色模式是独立工程**：改完亮色后必须系统性检查暗色，不是"应该也行"。TraceyU 在暗色模式发现了三个严重问题（死黑背景、过饱和表面、隐身文字），需要额外 2 波修复。

2. **表面色饱和度是暗色模式最容易犯的错**：亮色下 `142 43% 94%`（几乎白色带一点绿）看起来很好，但暗色下如果饱和度仍保持 31%+，会变成刺眼的彩色块。**暗色表面饱和度 ≤ 16%。**

3. **语义色 vs 前景色变量的陷阱**：`text-warning-foreground` 在暗色下可能是深色（用于亮色 warning 背景上的文字），不适合在暗色背景上单独使用。需要用 `text-warning`（warning 色本身）。

4. **Contract 测试是改造的安全网**：9 波改造只需更新 ~25 条测试断言，没有遇到意外的级联破坏。Contract 测试让改造可以大胆推进。

5. **一波一 commit 是最佳粒度**：便于回滚、便于 review、便于理解改造历程。
