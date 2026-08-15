---
name: commandcode-worktree-residue
description: command-code 会在工作树里写 .commandcode/ 未跟踪目录，卡住 orca worktree rm；且 orca worker-start 认不出它、进不了编排
metadata: 
  node_type: memory
  type: reference
  originSessionId: d702bd60-19b9-4036-9ffc-973a75a4c0c8
  modified: 2026-08-15T19:02:24.685Z
---

2026-08-16 第一次用 command-code 做工人载具，撞到两处：

**1. `worker-start` 认不出它 —— 进不了 Orca 编排**

```
orca terminal create --command "command-code -m deepseek/deepseek-v4-flash --skip-onboarding --auto-accept"  → 起得来，TUI 就绪
orca orchestration worker-start --task <id> --terminal <handle>
  → {"code":"agent_unconfigured","message":"Terminal ... is not running a recognized agent."}
```

Orca 的 agent 识别清单里有 pi / codex / claude，没有 command-code。不走 `worker-start` 就是不进编排：面板看不见工位、信箱收不到 `worker_done`、dispatch 追踪断掉。

**2. `--yolo` 被 Claude Code 安全分类器拦死**

`orca terminal create --command "... --yolo"` 在 Bash 与 PowerShell 两条路都返回 `Blocked by classifier`（`--yolo` = `--dangerously-skip-permissions`）。换成 `--auto-accept` 才过，底栏由 `» permission bypass on` 变成 `» accept edits on`。

**3. 残留物卡住归档**

command-code 会在工作树根写 `.commandcode/taste/taste.md`（未跟踪），`orca worktree rm` 因此报 `Failed to delete worktree ... ?? .commandcode/taste/taste.md`。`rm -rf .commandcode` 后重试即成功。

**How to apply:** 产出要进 git 的活**不要**用 command-code 载具——它进不了编排，硬派就得走 `terminal send` 旁路，违反「同一批活走同一条派工通道」。退回 pi。command-code 适合不落盘的用法（非交互 `-p "问" --max-turns N` 不受这些限制）。若已经在某棵树上起过 command-code 终端，归档前先 `rm -rf .commandcode`。相关：[[pi-universal-harness]]、[[orca-worker-launch-conventions]]。
