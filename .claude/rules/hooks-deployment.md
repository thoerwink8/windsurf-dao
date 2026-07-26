---
paths:
  - ccswitch/hooks/**
  - dao.ps1
---

# Hooks 部署闭环

新增或修改 `ccswitch/hooks/dao-*` 文件时，必须完成两步闭环（fortify2-20260726 D1 起单路径化，
不再有拷贝层）：

1. **写入** `ccswitch/hooks/dao-<name>.js`（真相源，唯一路径）
2. **注册** 确认 `~/.claude/settings.json` 的 `hooks.[EventName]` 中有对应条目（command 直指仓库
   路径 `<repo>/ccswitch/hooks/dao-<name>.js`，即 config-sync 快照里的 `${PROJECT_ROOT}/ccswitch/hooks/dao-<name>.js`）

`~/.claude/hooks/` 拷贝目录已废弃（旧版 `Invoke-LinkClaude` 会把 `ccswitch/hooks/dao-*` 复制过去，
但从未被任何注册消费——12/13 份长期死码、2 份与源 MD5 DIFF，唯一活的 timecode 也已改直指仓库路径）。
交付 hook 产物时，只需确认 settings.json 注册指向仓库路径，不需要（也不应该）复制文件到 `~/.claude/hooks/`。
