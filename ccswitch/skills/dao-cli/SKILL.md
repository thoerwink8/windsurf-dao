---
name: dao-cli
description: 工具的选择与具体用法——CLI-first 哲学、MCP vs CLI 的边界判断、gh/git/node/nest/eas/curl/npx 工具箱、gh 代理配置(中国网络)。决定"用哪个工具"时加载,关注"用什么"而非"怎么不卡"。
---

# CLI · 用什么工具

> 朴散则为器。一个 Bash 工具 ≈ 无限个 MCP。

## 工具哲学:CLI-first

**原则**:MCP 仅保留 CLI 无法替代的能力。其余一律用 CLI 通过 Bash 工具调用。
**收益**:每减一个 MCP ≈ 节省 1,500-10,000 tokens/轮上下文。

## MCP(仅 CLI 无法替代的)

| MCP | 域 | 用途 | 不可替代原因 |
|---|---|---|---|
| chrome-devtools | 浏览器 | DevTools 直连 / 性能 trace | CDP 协议实时交互 |
| context7 | 文档 | 获取最新库/框架文档 | 结构化文档查询 |

> 需配置对应 MCP server;未配置时浏览器调试退回手动、文档查询退回 WebSearch + WebFetch。

## CLI 工具箱

| 工具 | 用途 |
|---|---|
| `gh` | GitHub 全功能(`gh pr create` / `gh issue list` / `gh api`) |
| `git` | 版本控制 |
| `node` | JS 脚本执行 |
| `nest` | NestJS 脚手架(`nest g resource`) |
| `eas` | Expo 构建 / 提交 |
| `curl` | HTTP 请求 / API 测试 / webhook 调试 |
| `npx` | 临时包执行 |

## gh CLI 代理配置(Windows/PowerShell)

GitHub API 在中国需要代理:

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
gh api user --jq .login  # 验证连通性
```
