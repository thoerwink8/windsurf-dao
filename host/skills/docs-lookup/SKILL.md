---
name: docs-lookup
description: 查资料选路。**搜索一律先用 `ddgs`，不要先试 WebSearch**（WebSearch 跑在 API 上游，慢或断的时候本机无解）。库文档走 context7；GitHub 内容走 gh api；抓已知 URL 走 fetch MCP 不用 WebFetch。要查库/框架文档、GitHub 内容、文档站连不上，或 WebSearch/WebFetch 卡住想换路时读全文。
---

# 查资料选路

## 搜索：默认走 `ddgs`，不是 WebSearch

```bash
ddgs text -q "关键词" -m 5 -nc          # 默认 auto，一家被挡自动换下一家
ddgs text -q "关键词" -m 5 -nc -b brave # 指定后端更快
```

内置 WebSearch 是**服务端工具**——模型发出调用，由 API 上游去搜再回传，本机只负责把请求送到
`ANTHROPIC_BASE_URL`。所以它慢或断的时候，查本机代理/DNS/TLS 全是白费，本机也没有任何补救手段。
`ddgs` 走本机出网，不碰那条链，这是它当默认的唯一理由。WebSearch 留作对照，不当首选。

- `~/.local/bin` **不在 PATH 上**（两台机器都是），调用写全路径或先 `uv tool update-shell`。
- **`-o json` 不是打到标准输出，是存成文件**，会在当前目录落一个 `text_<query>_<时间戳>.json`；
  在共用主树里那就是等着被别人 `git add -A` 卷走的垃圾。要机器读就解析 stdout。
- `-b google` 两台机器都回 0 条，别用。装法见 `NEW-MACHINE.md` §13。

## 其余按目标选路

- 库/框架文档走 context7，不要搜。
- GitHub 上的内容（私有仓、原始文件、issues）用 `gh api`，不用 WebFetch。
- **抓某个已知 URL 走 `mcp__fetch__fetch`**（本地直连 + HTML→markdown，带 `start_index`/`max_length`
  翻页）。别先试内置 WebFetch——它取页前要回连 claude.ai 做域名安全校验，本机网络挡这一跳。
  fetch MCP 默认遵守 robots.txt，撞 disallow 是站点规则不是链路故障（搜索引擎的 `/search` 基本都禁，
  所以它抓不了搜索结果页，那是 `ddgs` 的活）。
- 官方文档站报 `Socket is closed`：先按本机取数路径问题排查（代理、TLS、网关都可能是来源），
  不要据此断言站点下线。两条实测替代路：context7 的 `/websites/code_claude`、镜像仓 `pleaseai/claude-code-docs`。

## 两条已经死掉的路（别再写进方案）

- `r.jina.ai`：**全线 401**，`bad network reputation (AS30058)`。它 2026-09-17 上午还能用，同一天下午
  连 `example.com` 都拒——匿名额度是按出口 IP 给的，验证通过一次不等于它是条能依赖的路。
- 裸 `curl` 打搜索引擎：bing 能回 200，但是 96KB 裸 HTML；`html.duckduckgo.com/html/` 回 202 反爬。
  用 `ddgs`，别自己解析搜索结果页。

## 口诀

记的是「目标 + 取数方式」这一对，不是主机本身——一条路失败 ≠ 目标不可用，换条路比断言「站挂了」便宜。
反过来也成立：一条路**成功一次**也不等于它可依赖（见上面 `r.jina.ai`）。
