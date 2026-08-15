---
name: evolution-symlink-silent-break
description: "Windows symlink/Junction 会静默断开(更新/权限/工具操作),定期 dao.ps1 status 自检"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 54958f16-8057-4087-9e28-72c3efd87573
---

Symlink 和 Junction 可能在 Windows 更新、权限变更、工具操作后静默断开，且不会报错——skill/command 悄悄失效。

**Why:** 实际遭遇过 symlink 脱轨持续未知时长才被发现。cc-switch 用 Junction 分发 skill，删 skill 后旧 Junction 变悬空空壳（ReparsePoint + 0 文件）也无报错。

**How to apply:** 遇到"某 skill/command 不生效"时，先跑 `dao.ps1 status` 看链接健康矩阵。link-claude 已内置悬空 Junction 自愈（扫 ReparsePoint + 0 文件 → cmd /c rmdir）。与 [[codex-claude-shared-skills]] 相关。
