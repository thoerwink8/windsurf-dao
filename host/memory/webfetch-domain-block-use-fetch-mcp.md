---
name: webfetch-domain-block-use-fetch-mcp
description: "内置 WebFetch 的域名安全校验被本机网络挡住,抓网页优先直接用 fetch MCP"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 692fedef-e2d8-4a6a-9476-e2e30bb1738f
---

本机抓网页优先直接用 `mcp__fetch__fetch`（fetch MCP),不要先试内置 WebFetch。

内置 WebFetch 在抓非白名单域名前会回连 `claude.ai` 做一次域名安全校验,本机网络/企业策略挡了这个回连,所以抓国内站点(腾讯云等)会报 `Unable to verify if domain ... is safe to fetch`。fetch MCP 走的是直连,不做这道校验,能正常抓到。两个 MCP server(`pencil`、`fetch`)已装在全局 `~/.claude.json` 顶层 mcpServers,无需安装。

**Why:** 这是确定性的网络限制,不是偶发——每个新会话都会重新撞墙。写成记忆让我开会话就预先知道,主动走 MCP,而不是先失败一次再临场换工具(那是概率性的,无保证)。用户明确否决了写 skill 的方案(skill 靠显式调用/description 匹配触发,对"失败后自动兜底"这种被动行为不触发)。

**How to apply:** 需要抓取网页内容时直接调 `mcp__fetch__fetch`。仅当 fetch MCP 也失败时,才回退试内置 WebFetch。
