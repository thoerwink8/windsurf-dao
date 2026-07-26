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

## SessionStart 超时预算表（fortify2-20260726 D8）

`SessionStart` 是每次进项目/新会话都会触发的高频挂载点，超时是**串行叠加**的（宿主逐个跑完
才继续），加新 hook 前先看这张表还有没有余量：

| hook | matcher | timeout | 备注 |
|---|---|---|---|
| dao-config-guard.js | startup | 5s | |
| dao-remove-session.js | startup\|clear\|resume | 5s | |
| dao-codegraph-ensure.js | startup | 120s | 独占绝大部分预算，正当理由：CodeGraph 索引首次构建/校验本身就是分钟级操作，超时设太短会在慢机器上把正常初始化误判成故障 |
| dao-scaffold-check.js | startup | 10s | |
| dao-playwright-cleanup.js | startup | 15s | |

**合计 155s**（当前实测值，随 `config-sync/common/settings.json` 的 `common_config_claude.hooks.SessionStart`
快照演进，此表可能过期——改动前先重新核对快照里的真实 timeout 值，不要凭这张表的旧数字判断余量）。
新增 SessionStart hook 前，评估是否真需要在这条高频路径上再加等待，能挪到别的挂载点（如
`PostToolUse`/按需触发）就不要挤占 SessionStart 预算。
