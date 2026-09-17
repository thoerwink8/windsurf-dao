---
name: docs-lookup
description: 查资料选路：要查库文档、GitHub 内容或官方文档站连不上时读，或 WebSearch/WebFetch 断了想换路时读。库文档走 context7；GitHub 内容用 gh api；抓网页走 fetch MCP 不用 WebFetch；WebSearch 断在上游查本机没用；判断口诀「记目标+取数方式这一对」。
---

# 查资料选路

- 库文档走 context7。
- GitHub 上的内容（私有仓、原始文件、issues）用 `gh api`，不用 WebFetch。
- **抓某个已知 URL 走 `mcp__fetch__fetch`**（fetch MCP，本地直连 + HTML→markdown，带
  `start_index`/`max_length` 翻页）。别先试内置 WebFetch——它取页前要回连 claude.ai 做域名
  安全校验，本机网络挡这一跳。fetch MCP 默认遵守 robots.txt，撞 disallow 是站点规则不是链路故障。
- **WebSearch 断了不要查本机网络**：它是服务端工具，在 API 上游执行，本机只负责把请求送到
  `ANTHROPIC_BASE_URL`（本机指向 mirasim 本地中继）。断续 = 中继那一跳当时路由给了谁，
  重试一次常常就好；连两次失败就换路，别在同一个工具上磨。要搜索的替代路：
  `curl -sL -A "Mozilla/5.0 ..." "https://www.bing.com/search?q=..."`（2026-09-17 实测 200，
  DuckDuckGo html 端点回 202 反爬不可用）。
- 官方文档站报 `Socket is closed`：先按本机取数路径问题排查（代理、TLS、网关都可能是来源），不要据此断言站点下线。两条实测替代路：
  - context7 的 `/websites/code_claude`
  - 镜像仓 `pleaseai/claude-code-docs`
- 判断口诀：记的是「目标 + 取数方式」这一对，不是主机本身——一条路失败 ≠ 目标不可用，换条路比断言「站挂了」便宜。
