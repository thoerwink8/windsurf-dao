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

> 未来扩展：`mobile-expo.md` 等，按实际项目需要新增。kit STACK.md 的 `stack:` 声明按处方名挂载。
