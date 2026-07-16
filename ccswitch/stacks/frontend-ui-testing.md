---
name: dao-stack-frontend-ui-testing
description: 前端 UI 测试分层处方:逻辑单测→组件语义冒烟→像素视觉回归→交互 E2E。vitest 4 Browser Mode 视觉回归实证 + AI 视觉测试工具负结论存档。
---

# 前端 UI 测试处方

> 治大国若烹小鲜。测试分层不过度加料——逻辑用最轻的锅，视觉用刚好够的像素比对，交互才上真机。

## 触发

- 前端项目（React/Vue 等）需要建立或补齐 UI 测试策略
- UI 改动后需验证视觉/交互回归

## 分层处方

| 层 | 验证什么 | 工具 | 说明 |
|---|---|---|---|
| ① 逻辑/store | 纯函数、状态机、hooks | Vitest + happy-dom | 无 UI，全自动最快 |
| ② 组件语义 | 渲染成功、关键文案/角色可查 | @testing-library 渲染冒烟 | IPC 调用用 `vi.mock` 掐断，不真连后端 |
| ③ 视觉回归 | 像素级样式/布局漂移 | **vitest 4 自带 Browser Mode `toMatchScreenshot()`** | 像素基线随仓，零 AI 零 key；mousse-cli 实证 12 基线连跑零抖动。**环境敏感**：基线绑定生成机器的渲染环境，CI 跨环境需另验（字体/DPI/GPU 渲染差异致假阳性） |
| ④ 交互 E2E | 真实用户操作链路 | playwright / chrome-devtools MCP | 真机 DOM 断言；Tauri 项目见 `desktop-tauri.md` 分层测试策略 |

**选择原则**：能用轻量层验证的不用重量层——逻辑改动到①即止，纯 CSS/布局改动到③，跨组件交互流程才上④。

## 关键坑（Browser Mode）

- **独立 config + 独立 setup**：Browser Mode 不能与 happy-dom 环境共用一份 vitest config/setup——`@testing-library` 的 cleanup 依赖链在真浏览器环境下会报 `global is not defined`，必须为 Browser Mode 建独立 setup 文件
- **render 是异步**：`vitest-browser-react` 的 `render()` 返回 Promise，调用处必须 `await`，漏 await 会导致断言在 DOM 挂载前跑，产生假阴性/假阳性

## AI 视觉测试工具 · 负结论存档（2026-07-16 评估，防重评）

已评估两类 AI 驱动视觉测试方案，均不采纳，不必重新评估：

- **Midscene.js**：技术上可接 CDP，但单步耗时 45s+、断言不稳定、需额外视觉模型 key——仅作人工试探用途，不进自动化链路
- **vercel agent-browser / browser-use harness**：无断言能力，只能驱动交互不能验证结果，不采纳

出处：mousse-cli `docs/research/ai-ui-testing-tools-eval.md`

## 验证

新增/改动测试后按改动范围选层跑（见「选择原则」），不必每次四层全跑：`pnpm test:run`（覆盖①②）→ Browser Mode 专属命令验③ → 需要④时手动或 CI 触发 E2E。
