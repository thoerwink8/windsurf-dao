---
name: memory-commit-scope-per-file
description: 两帅共用 host/memory，commit memory 时必须 git add 具体文件名，add 整个目录会带走对方未提交的条目
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d702bd60-19b9-4036-9ffc-973a75a4c0c8
  modified: 2026-08-15T19:03:30.284Z
---

2026-08-16，memory 例外（#503 拍板、#515 写进 CLAUDE.md）生效当天就撞到：

```
git add host/memory/ && git commit -m "[cc] memory: command-code 三个坑"
→ add92f9 实际带了 4 个文件：我的 1 条 + MEMORY.md + 帅·A 的 2 条
  （pi-opencode-go-provider.md、process-alive-vs-signal-arriving.md）
```

Junction 把两位主帅的 memory 都指到同一个 `host/memory/`，`git add <目录>` 不区分谁写的。后果有两层：commit message 与实际内容不符（不诚实的历史）；对方若正写到一半，就被提交了半成品。

**How to apply:** 提交 memory 一律 `git add host/memory/<具体文件名>.md`，一个个点名，**不要 `git add host/memory/`**，更不要 `git add -A`。`MEMORY.md` 是共用索引、无法按人拆分，带上它时在 commit message 里说明「含他人索引行」。提交前先 `git status --short host/memory/` 看清有哪些未跟踪文件不是自己写的。相关：[[memory-relink-needs-content-diff]]（同属 memory 入仓后的新协作面）。
