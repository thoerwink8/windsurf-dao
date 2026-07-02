---
name: dao-stack-frontend-react-vite
description: 前端技术栈处方:React 19 + TypeScript + Vite。开工包（kit）孵化项目的默认前端,配 backend-ts 成端到端 TS。
---

# React + Vite 前端处方（默认）

> 大道甚夷。不上全家桶元框架，SPA 用最直的路：Vite 起、React 写、类型链贯通。

**默认地位**：开工包（kit）孵化项目的默认前端。相对 `frontend-nextjs.md`（SSR/SEO/路由约定场景），本处方面向工具型 SPA / 内部应用 / 桌面 WebView——无 SEO 诉求时不背元框架的复杂度。与 `backend-ts.md` 组合为端到端 TS（shared-types 全链类型流）。

## 触发

- kit STACK.md 声明 `stack: frontend-react-vite`
- `/dao-dev` 基建审计发现"需要前端 + 工具型 SPA / 无 SEO 诉求"
- 需要 SSR / SEO / 文件路由 → 改挂 `frontend-nextjs.md`

## 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | React 19 + TypeScript | kit 锁定项；并发特性/Actions 按需用，不为用而用 |
| 构建 | Vite | 秒级 HMR，配置面小，AI 代理不易配错 |
| 状态 | zustand（默认，可换） | 轻量、贴合单人工具；服务端状态用 TanStack Query |
| 样式 | Tailwind + 设计 token CSS 变量 | 与 dao-design 管线（design-prompts / DESIGN-BRIEF token 意向）直接对接 |
| 校验 | Zod（与后端同源 schema） | 边界校验与 shared-types 一致 |

## 结构骨架

```
apps/
  web/               ← Vite 入口 + 页面 + 组件（components/ui 基础层分离）
packages/
  shared-types/      ← 与后端共享（见 backend-ts.md）
```

## 铁律

- **token 先行**：色彩/字号/圆角/间距走 CSS 变量 token，禁止散落硬编码值（对接 kit 的 DESIGN-BRIEF.md）
- **类型链不断**：API 消费只从 shared-types 导入，禁止前端手抄接口类型
- **组件分层**：`components/ui/`（无业务基础件）与业务组件分离，杜绝一次性手写重复件

## 验证

依次运行：`pnpm typecheck` → `pnpm test:run` → `pnpm build`。三者全绿才算就绪。
