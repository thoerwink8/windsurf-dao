# MCP 配置说明（配 .mcp.json 前先读）

## 这是什么

`.mcp.json` 是**项目级**的 MCP（Model Context Protocol）配置。Claude Code 等 AI 编程工具会读仓库根目录的这个文件，给 AI 接上项目需要的工具（读文件、查数据库、开浏览器、调 API 等）。

**clone 即生效**：这份配置跟着仓库走，任何人拉下来代码，AI 就自动有这些工具，不需要每台机器单独配。

## 怎么用

1. 把 `.mcp.json` 拷到新项目仓库根目录（如果项目里已经有，就合并内容，别覆盖）。
2. 把 `example-filesystem` 整段换成你项目真正需要的 server。
3. 每个 server 加一行 `"description"` 写清楚**这个工具是干嘛的、项目里谁用**，别留无注释的死配置。
4. 改完在本地让 AI 重新加载 MCP 配置再验证一次能不能连上。

## 能配什么（常见三种）

| 类型 | 写法要点 | 什么时候用 |
|---|---|---|
| npm 包形式 | `"command": "npx", "args": ["-y", "包名"]` | 官方/社区现成 server，最省事 |
| 本地脚本 | `"command": "node", "args": ["./scripts/my-mcp.js"]` | 项目私有工具，自己写 server |
| 远程 HTTP | `"command": "npx", "args": ["-y", "@modelcontextprotocol/server-remote"], "env": { "URL": "..." }` | server 部署在别处，项目只管连 |

## 红线

- **密钥类参数（token、密码、内网地址）不写进 `.mcp.json`**——这文件进 git，所有人都看得到。用环境变量，或用机器的用户级配置。
- 不需要的工具别配：每个 server 都会占 AI 的注意力，配少不配多。
