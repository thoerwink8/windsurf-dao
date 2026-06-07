# 记忆索引

## 热记忆

- 跨会话或跨工具复盘时，先写清证据范围：已读取、未读取、只能推断、明确废弃。不要把 Codex、Claude Code、Claude Desktop、cc-switch、Pencil 混为一谈。
- 提交前必须按当前运行宿主选择前缀：Codex / Code X 用 `[codex]`，Claude Code 用 `[cc]`。提交后用 `git log -1 --oneline` 立即核对。
- 新增 dao skill 后不能只改源码和索引；必须跑部署链路验证 `~/.claude/skills/<skill>` 与 `~/.codex/skills/<skill>` 是否实际可见。

## 主题索引

- `workflow-rules.md`：跨宿主提交前缀、skill 部署验证。
- `sessions/2026-06-08-dao-memory-smoke.md`：本次 dao-memory 端到端验证复盘。
