---
name: ccswitch-env-gap
description: env 的源是 cc-switch DB 的 common_config_claude,会随下发进 live;旧说法「下发不含 env/跑 merge-settings.mjs」已过时
metadata: 
  node_type: memory
  type: project
  originSessionId: 274cfaf2-c1cf-47e3-87d9-473732a79950
  modified: 2026-08-08T04:23:20.659Z
---

(2026-08-07 实测修正)cc-switch 下发 `common_config_claude` 到 `~/.claude/settings.json` **包含 env 字段**——live 的 env 键与 DB 里 common_config_claude.env 逐键一致。旧结论「下发不含 env、切 provider 后跑 merge-settings.mjs 补充」已过时,且 `merge-settings.mjs` 已不存在于仓库。

**Why:** doctor 报 `settings.json.env.CLAUDE_CODE_*` 缺失的真实原因是**源(DB 的 common_config_claude.env)里本来就没有这些键**,不是下发丢字段。

**How to apply:** 要改 claude 的 env(如 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`),三处同落保持一致:① cc-switch DB `settings` 表 `common_config_claude`(源)② live `~/.claude/settings.json`(立即生效,否则要等下次下发)③ `node config-sync/lib/export.mjs --scope=settings` 导出 git 快照后 commit。settings-drift 对 env 键集做 hard 比对,只改一处会红。相关:[[dao-claude-migration]] [[claude-settings-self-heal]]

⚠️ **hooks 面与 env 面下发源不同(2026-08-08 实测,#184 验证批)**:上面三处是 env 面;**hooks 注册要四处同落**——真下发源是 cc-switch DB **`providers` 表 app_type=claude 那 2 行各自的 `settings_config`**(整体覆盖,漏改即被切 provider 静默抹掉),`common_config_claude` 只是镜像/对账层;`config-sync/lib/restore.mjs` **从不写 providers 表**(无自动化管道,2026-08-02 那次是手动对齐)。四处=live + providers×2 + common_config_claude 镜像 + git 快照。出处 `ccswitch/lib/settings-drift.js:29-36`。
