# 技术栈处方 · Stacks

> 有之以为利，无之以为用。

固定的技术选型范式，跨 N 个项目通用。
`/dev` 管线基建审计时按需加载对应处方。

| 处方 | 技术栈 | 触发场景 |
|------|--------|----------|
| `frontend-nextjs.md` | Next.js + shadcn + Tailwind | 需要前端 + SSR/SEO/文件路由诉求 |
| `frontend-react-vite.md` | React 19 + Vite + zustand + Tailwind | 工具型 SPA/内部应用/桌面 WebView（kit 默认前端） |
| `desktop-tauri.md` | Tauri 2 + WebView2 调试 | 桌面端开发/调试/GUI 验证 |
| `backend-ts.md` | Hono + Drizzle + pnpm monorepo | 需要后端（**默认**，AI-agent-first 单语言链） |
| `backend-go.md` | go mod + net/http(chi) + sqlc | 高并发/CPU 密集/系统级/单二进制分发（任一信号即切） |
| `ci-github-actions.md` | GitHub Actions CI 矩阵/计费策略 | 项目含 `.github/workflows/*.yml`，尤其涉及 macOS/多平台矩阵 |

> 未来扩展：`mobile-expo.md` 等，按实际项目需要新增。kit STACK.md 的 `stack:` 声明按处方名挂载。

## 这些文件如何被强制执行

`stacks/` 全部按需加载（不进 always_on），单靠"存在"不会自动生效——必须有触发点把处方翻译成项目侧可持续加载的约束，否则规范形同虚设（2026-07-12 mousse-cli 血泪：`frontend-react-vite.md` 的 Tailwind 铁律从 v0.1 写到 v1.23 从未落地，手写 2000+ 行布局 CSS 才被发现）。

强制执行链：

1. **scaffold 门控**：`dao-project-scaffold` 首次进入项目时检测前端信号（`react`/`vue`/`svelte` 依赖等），检查 `.claude/rules/frontend-style.md` 是否存在
2. **派生**：缺失时提醒从对应处方（如 `frontend-react-vite.md`）派生该 rule——声明样式技术路线（Tailwind 优先，禁手写布局 CSS），frontmatter 带 `description` + `paths:` 条件加载（参考 TraceyU `.claude/rules/code-to-prototype.md` 形式）
3. **always_on 兜底**：`dao.md`「前端技术栈自检」条目每轮注入，跳过 scaffold 直接进项目的场景也能兜住

`.claude/rules/frontend-style.md` 派生后才是项目侧真正持续生效的约束；`stacks/` 本身只是处方库，不直接作用于项目会话。

**同一条链已扩展到 CI 成本门控**：`dao-project-scaffold` 检测到 `.github/workflows/*.yml` 含 PR 触发多平台矩阵且无条件跳过时（见 `ccswitch/skills/dao-project-scaffold/ci-cost-gate.md`），指向 `ci-github-actions.md` 处方收敛——PR 只跑主开发平台，交叉矩阵挂 main push / release tag / workflow_dispatch。出处：2026-07-13 mousse-cli 账单烧穿实证（`stacks/` 单靠存在不会自动生效，这条门控是唯一能拦住"处方写了但没人执行"的关卡，与前端 Tailwind 铁律同一断链模式）。
