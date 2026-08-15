---
name: pencil-mcp-flag-trap
description: Pencil MCP 连不上的根因——注册时多带了 server 不认识的 --agent 参数
metadata: 
  node_type: memory
  type: reference
  originSessionId: 7d3e4bb9-c83a-4a56-8638-3a201d001eba
---

Pencil MCP server(`D:\Program Files\Pencil\resources\app.asar.unpacked\out\mcp-server-windows-x64.exe`)只接受这些 flag:`-app` / `-conversation_id` / `-enable_spawn_agents` / `-http` / `-http-port`。

**坑**:曾被注册成 `--app desktop --agent claudeCodeCLI`,但 server 没有 `-agent` flag,一启动即报 `flag provided but not defined: -agent` 并退出,Claude Code 判为 `Failed to connect`。

**正确注册**(User scope):`claude mcp add pencil -s user -- "D:/Program Files/Pencil/resources/app.asar.unpacked/out/mcp-server-windows-x64.exe" --app desktop`

**前提**:Pencil 应用必须在运行中(MCP 连的是运行实例),否则照样连不上。

**关联**:项目推荐 MCP 配置在 `D:/frank/windsurf-dao/mcp_config.json`,其中 pencil 路径写成了 `C:\...`(错,实际在 `D:\...`);未 disabled 的三个 = pencil / chrome-devtools / context7。改 .pen 文件后 Pencil 不热重载,必须重开或经 pencil MCP 操作运行实例才实时刷新。
