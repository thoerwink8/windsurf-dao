---
name: docs-lookup
description: 查资料选路：要查库文档、GitHub 内容或官方文档站连不上时读。库文档走 context7；GitHub 内容用 gh api 不用 WebFetch；官方文档站报 Socket is closed 的两条实测替代路；判断口诀「记目标+取数方式这一对」。
---

# 查资料选路

- 库文档走 context7。
- GitHub 上的内容（私有仓、原始文件、issues）用 `gh api`，不用 WebFetch。
- 官方文档站报 `Socket is closed`：先按本机取数路径问题排查（代理、TLS、网关都可能是来源），不要据此断言站点下线。两条实测替代路：
  - context7 的 `/websites/code_claude`
  - 镜像仓 `pleaseai/claude-code-docs`
- 判断口诀：记的是「目标 + 取数方式」这一对，不是主机本身——一条路失败 ≠ 目标不可用，换条路比断言「站挂了」便宜。
