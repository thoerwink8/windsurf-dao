---
name: codex-claude-shared-skills
description: "codex 和 claude 共用 dao skills 的部署架构,以及 cc-switch 用 Junction 不是 symlink 的坑"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6bfa8d8e-a4b9-40c9-8a84-e9cea6028678
---

dao skills 走 git 单一真相源:仓库 `ccswitch/skills/`(原 `claude/skills/`)是唯一源,`dao.ps1 link-claude` 软链到 `~/.claude/skills/`。**~/.codex/skills 的写入方已归 cc-switch store**(用户 2026-07-27 拍板,判据与归属注释见 dao.ps1:89 起)——dao.ps1 对它只剩 status 报告与 unlink-codex 删除方向,不再主动建链。

**cc-switch 的坑**:它管理的 skill 分发到 `~/.codex/skills/` / `~/.claude/skills/` 用的是 **Junction(目录联接点),不是 SymbolicLink**。PowerShell 判断链接类型时 `$_.LinkType -eq "SymbolicLink"` 会漏掉 Junction,导致误判为"用户真实文件"。正确写法:`$_.LinkType -in "SymbolicLink","Junction"`(加括号避免 `-and` 优先级问题)。

**为什么 cc-switch 之前显示 Claude:0**:它的 skill 扫描不跟随 symlink,而 dao skill 在 `~/.claude/skills/` 全是软链 → 计数 0。它的库模型是 `skills` 表 + per-agent 开关(enabled_claude/enabled_codex/...),GUI「导入已有」对跨盘 symlink 会报"不受信任的装入点"无法导入。最终选择不走 cc-switch 托管,git 单源 + dao.ps1 双链。

仓库里原 `codex/skills/` 是空壳(从未填充),已删除。codex 不再维护独立 skill 源。

相关:[[dao-claude-migration]] [[traceyu-test-env-trap]]
