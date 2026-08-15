---
name: claude-settings-self-heal
description: "~/.claude/settings.json 的真实 owner 与 BOM 坑——cc-switch DB 下发通用配置；PS 5.1 的 Set-Content -Encoding UTF8 会写 BOM 把文件刷坏"
metadata: 
  node_type: memory
  type: project
  originSessionId: 63a59d85-078a-4cb2-830a-3707b6978338
---

> 失效（2026-08-15）：`dao.ps1` 已随 #425 退役、文件不存在，`ccswitch/` 已改名 `host/`。下文凡以 dao.ps1 为写入方/根治方向的部分不要照做。本条只留结论：settings.json 无单一 owner（cc-switch DB 下发 / CC 本体重置互相覆盖），PS 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM 把文件刷坏。

**2026-06-15 实地核实（修正旧记忆）**：旧版记忆描述的 `dao-settings-heal.js` + `claude/settings.template.json` + `claude-strip.mjs` + `strip-db-claude.mjs` + SessionStart 自愈 hook **全部不存在于代码**（Glob 全空，restore.mjs 无剥离逻辑）。那套重构只写进了记忆、从没落地（或在 claude/→ccswitch/ 重构里被删）。别再依赖它。

**settings.json 的真实写入方（无单一 owner，三方互相覆盖）**：
1. **cc-switch 切 provider** → 把 DB `common_config_claude` 整块下发到 settings.json（env / permissions / model / theme / outputStyle，**也包含 hooks/statusLine**）。
2. **dao.ps1 link-claude / unlink-claude** → 幂等加 outputStyle + dao-glob-gate(PostToolUse) + dao-cn-title(UserPromptSubmit)。
3. **Claude Code 本体** → settings.json 非法 JSON 时备份为 `.corrupt-*` 并重置成 `{}`。

**BOM 坑（已修，2026-06-15）**：dao.ps1 写 settings.json 用的是 `... | Set-Content $settingsPath -Encoding UTF8`，**Windows PowerShell 5.1 下这会写 UTF-8 BOM**（实证首字节 EF BB BF）。BOM → Claude 严格 JSON 解析失败 → 判 corrupt → 重置 `{}`。已把 6 处（link/unlink 各 3）改为 `[System.IO.File]::WriteAllText($p,$json,(New-Object System.Text.UTF8Encoding($false)))` 无 BOM 写。正确无 BOM 写法参 [[python-stub-use-py]] 同源的 `ccswitch/skills/dao-terminal-resilience` 用 `[Text.UTF8Encoding]::new($false)`。

**已知污染（待定 owner 后处理）**：DB `common_config_claude.hooks`/`statusLine` 仍是旧 `D:/frank/windsurf-dao/claude/...` 绝对路径（claude/ 已改名 ccswitch/，全 MISSING）。下次 cc-switch 切 provider 会用这套旧路径覆盖 settings.json，再次刷坏 hooks。根治方向：要么把 hooks/statusLine 从 DB 剥离改由 dao.ps1 全权写（机器特定不进 git），要么把 DB 里路径改对。两者都改 git 共享真相源，需先定 owner。

**触发器**：广撒网 `taskkill /F /IM node.exe` 会误杀 cc-switch（node/electron），正写 settings 时被杀留半截/坏文件。清队列别无差别杀 node。

关联 [[dao-claude-migration]] [[ralph-loop-disabled]] [[codex-claude-shared-skills]] [[python-stub-use-py]]。
