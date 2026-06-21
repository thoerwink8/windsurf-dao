---
paths:
  - ccswitch/hooks/**
  - dao.ps1
---

# Hooks 部署闭环

新增或修改 `ccswitch/hooks/dao-*` 文件时，必须完成三步闭环：

1. **写入** `ccswitch/hooks/dao-<name>.js`（真相源）
2. **注册** 确认 `~/.claude/settings.json` 的 `hooks.[EventName]` 中有对应条目（command 指向 `~/.claude/hooks/dao-<name>.js`）
3. **部署** 运行 `dao.bat link-claude` 自动复制到 `~/.claude/hooks/`（或手动复制）

`Invoke-LinkClaude`（dao.ps1）会自动把 `ccswitch/hooks/dao-*` 复制到 `~/.claude/hooks/`，MD5 比对幂等。

交付 hook 产物时，末尾必须追加归位提醒（如果 hook 是在 `~/.claude/hooks/` 直接创建的，提醒同步回 `ccswitch/hooks/`）。
