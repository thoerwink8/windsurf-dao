---
name: dao-stack-backend-ts
description: 后端技术栈处方:端到端 TypeScript——Hono + Drizzle + pnpm monorepo 共享类型。AI-agent-first 场景的默认后端。
---

# TypeScript 后端处方（默认）

> 道生一。一种语言、一条工具链，类型从 schema 到 UI 一以贯之。

**默认地位**：AI-agent-first 场景的默认后端处方。单语言单工具链让代理一把开到底——不切换语言心智、不维护两套构建、不跨语言对齐契约；shared-types 让类型流全程护栏（DB schema → API 契约 → 前端消费一条类型链，改一处全链报错）。除非命中 `backend-go.md` 的触发信号，后端一律用此处方。

## 触发

- `/dao-dev` 基建审计发现"需要后端 + 后端未就绪"，且无 `backend-go.md` 触发信号
- kit STACK.md 声明 `stack: backend-ts`
- 用户显式调用

## 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | Hono | 轻量、Web 标准 API、多运行时（Node/Bun/edge）；纯内部 API 且要端到端类型推导 → 可换 tRPC |
| ORM | Drizzle | schema 即 TS 类型，迁移可 diff，无 codegen 断层 |
| 校验 | Zod | 请求/响应 schema 与 shared-types 同源 |
| 结构 | pnpm monorepo | `packages/shared-types` 前后端共享 |

## 结构骨架

```
apps/
  server/            ← Hono 入口 + 路由 + 中间件
packages/
  shared-types/      ← 类型单源（前后端同引）
  shared-domain/     ← 业务逻辑（Repository 接口 + Zod schema，可选）
```

## 铁律

- **类型单源**：Drizzle schema → 推导 API 类型 → `shared-types` 导出。禁止前后端各写一份接口类型
- **校验进边界**：所有外部输入过 Zod，内部函数信任类型
- **标准优先**：Web 标准 API（Request/Response/fetch）优先于框架私有抽象，运行时可迁移

## 验证

依次运行：`pnpm typecheck` → `pnpm test:run` → `pnpm build`。三者全绿才算就绪。
