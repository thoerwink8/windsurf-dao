# Node 应用薄层

给「Node 应用」类项目（web 后端、桌面端、CLI 工具）的起点。与 `base/` 拼装，见文末。

## 这层给什么

- 一套**推荐的目录结构**（src 下按职责分，不是按文件类型分）
- 一份 **package.json 骨架**（dev/test/typecheck/check 脚本齐全，直接能跑）
- **测试框架建议：Vitest**（和 TypeScript 同生态，零配置启动快；纯逻辑测试用 node 环境，测 React 组件再加 happy-dom）

技术选型参考了 `TraceyU`（Tauri 2 + React + TS + SQLite，pnpm workspace + Turborepo + Vitest 实盘验证过的组合）。

## 怎么和 base 拼出新项目

1. 拷 `base/` 全部 + 本目录全部到新仓库根目录。
2. **改 `package.json`**：`name` 改成项目名（kebab-case），删掉不需要的依赖和 scripts。
3. 装依赖：`pnpm install`（骨架默认 pnpm；包管理器换成 npm/yarn 也行，删掉 `packageManager` 行即可）。
4. 把 `src/` 下的 `{{占位}}` 换成真实代码。
5. 按 `base/README-骨架.md` 填 README；跑通 `pnpm check` 后开第一个 draft PR。

## 推荐目录结构

```
新项目根/
  src/
    index.ts        ← 入口（启动服务/CLI）
    lib/            ← 纯逻辑，无副作用（能直接单测）
    services/       ← 外部依赖：数据库、API 客户端、第三方 SDK
    types.ts        ← 跨模块共享类型
  tests/            ← 集成/端到端测试（单元测试建议和被测代码放一起）
  scripts/          ← 一次性脚本、运维工具（备份、迁移）
  docs/             ← 设计、决策记录（有的话）
```

规则：**纯逻辑进 `lib/`，沾外部依赖的进 `services/`**——这样单元测试只测 `lib/`，快且不依赖环境。

## package.json 骨架说明

| 命令 | 干什么 |
|---|---|
| `pnpm dev` | 开发模式（node --watch，改代码自动重启） |
| `pnpm build` | 编译到 `dist/` |
| `pnpm test` / `test:watch` / `test:coverage` | Vitest 跑一次 / 监听 / 带覆盖率 |
| `pnpm typecheck` | TypeScript 类型检查（不产出文件） |
| `pnpm lint` | ESLint（需另配 eslint.config 才可用，见下） |
| `pnpm format` | Prettier 全量格式化 |
| `pnpm check` | **一把过命令：typecheck + test**（本地跑通才算完） |

- `lint` 骨架里默认不挂进 `check`——装上 ESLint 并配好 `eslint.config.js` 后，把 `npm run lint` 加进 `check`。
- 项目变大要拆多包时，往 pnpm workspace + Turborepo 演进（参考 TraceyU 的 `packages/` + `turbo.json`）：逻辑层拆到 `packages/shared-*`，应用层留 `apps/`。

## Vitest 怎么配

用本目录的 `vitest.config.ts` 骨架：

- **纯逻辑**（`src/lib/`）：默认 node 环境，零配置。
- **React 组件**：装 `@vitejs/plugin-react` + `happy-dom`，config 里加 `plugins: [react()]`、`environment: 'happy-dom'`（骨架里注释了写法）。
- 测试文件命名 `xxx.test.ts` 或 `xxx.spec.ts`，放被测文件旁边（colocated）或 `tests/` 都行，config 的 include 两种都认。
