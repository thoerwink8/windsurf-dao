---
name: cross-project-tmp-root
description: "跨项目操作时 _tmp/截图必须放目标项目而非会话 cwd 项目,MCP 写不进去就先写再 Copy-Item"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dddd5bf1-0559-49e9-9fad-39f41793662a
---

`<项目根>/_tmp/` 中的 `<项目根>` = **被操作的目标项目**，不是 windsurf-dao 会话的 cwd。

**Why:** 在 windsurf-dao 会话中操作 TraceyU 时，截图被错放到 `windsurf-dao/_tmp/qa/` 而非 `TraceyU/_tmp/qa/`。用户找不到截图，且违反"跟项目走"原则。

**How to apply:** 每次截图/写临时文件前，先确认目标项目根目录。若 chrome-devtools/playwright MCP 的 workspace roots 限制阻止直接写入目标项目，先写到可写位置（如 scratchpad），然后立即 `Copy-Item` 到目标项目 `_tmp/` 并清理临时副本。
