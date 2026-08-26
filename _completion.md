完工：#633 agent-first 落地完成。

## 改动

建树时带 `--agent`（认识的 agent：cursor/grok/pi/codex/devin），第一个终端就是 agent，空壳 PowerShell 从源头不出生。`launchAgentInWorktree` 加 `preexistingHandle` 短路：agent-first 时直接用建树回包的 first terminal handle，跳过 close-then-create。不认识的 agent / command 型仍走原 fallback。

- `argsWorktreeCreate` 加 `--agent` 参数 + catalog
- `cmdDispatchExec`：slate 第一个候选 start=agent 有 agentId → 建树带 --agent
- `startWorkerBySlate`：接 preexistingHandle，第一次用后置 usedPreexisting（fallback 走原路）
- `cmdReviewerCreate` / `cmdReviewerAttach` / batch 同一套 agent-first
- 测试：新增 #633 agent-first 测试块（11 项绿），原 close-then-create 测试保留（验 fallback 仍在）

## 验证

- dao-check 测试部分全绿（628+ pass / 0 fail；盘面 2 项红为本机既有，非本单引入）
- 端到端实测：`orca worktree create --agent devin` 回包有 `agentTerminalHandle` + `startupTerminal.handle`，`extractHandleFromCreate` 抽出 handle，`terminal list` 该树只 1 个终端（devin TUI，空壳没出生），已清理测试树

## PR

#788 已 gh pr ready。
