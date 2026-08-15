---
name: orca-worker-launch-conventions
description: 起 Orca 工兵/树帅的三条硬约定:启动命令用 reclaude 不用裸 claude;独立任务建树必带 --no-parent;传特殊字符文本走文件
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 03006e89-cb66-4771-84fa-1485065b577b
  modified: 2026-08-12T20:23:21.061Z
---

2026-08-13 夜窗用户两次纠偏落定(windsurf-dao,但全项目适用):

1. **Claude Code 终端启动命令是 `reclaude` 不是裸 `claude`**(用户明设:`C:\Users\Administrator\AppData\Local\Programs\reclaude\bin\reclaude.exe`,2.1.228,先 Syncing config 再起,--model/--autocompact/--disallowedTools 全透传)。实证:裸 `claude` 起的 orca 终端曾静默 exited(0 token),reclaude 起的正常。

2. **独立任务的 orca worktree create 必带 `--no-parent`**:默认会从当前上下文推父级 ⇒ 树变成子工作区挂在别人名下,用户看侧栏即抓。只有真正叠在当前工作之上的才用默认/--parent-worktree。

3. **给 orca 传多行/含反引号等特殊字符的文本,一律先落文件再 `--spec "$(cat file)"`,禁双引号裸拼**(反引号会被 bash 命令替换吃掉,一次消息有损、一次派单令直接报错——树帅 340v2 实咬)。

**How to apply**:低层配方标准链 = `node scripts/dao-pre-dispatch.mjs`(追平闸)→ `worktree create --no-parent --issue N --comment "形态 · 棒次 · 等什么"` → `terminal create --command "reclaude --model X --autocompact 350k [--disallowedTools ...]"` → `dispatch --task --to --inject` → sleep 数秒无条件补回车。相关:[[dispatch-regex-corpus-and-stall]]
