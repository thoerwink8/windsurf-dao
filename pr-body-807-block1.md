目标

#807 步骤 4 拆 3 块并行的块 1/3：删 Windows 本机编排层里的 `scripts/flow.mjs`、`scripts/watchdog.mjs`（按 8-24 清单保留「agent 撞限流/卡弹窗」检测部分）、`scripts/guard-keepalive.mjs` / `scripts/lib/guard-keepalive.mjs`、保活类 hook，以及对应测试。署名 issue #807，关单交给 `scripts/close-issues.mjs`。

验收标准

- `scripts/flow.mjs` 与其测试/夹具已删，仓内引用改到 systemd + `orca automations` 承重面，不再当本机常驻轮询入口。
- `scripts/watchdog.mjs` 按 8-24 清单瘦身：保活/判活那半删掉；「agent 撞限流/卡弹窗」检测仍有人调（已有 `agent-stall-watch` / `agent-stall-detect` 则接到那条，不要留死代码）。
- `guard-keepalive.mjs`（scripts 根与 lib）和保活类 hook（SessionStart / UserPromptSubmit 那套）连同对应测试同 PR 删。
- 本块范围外的 inbox-station / quick-fix / judgment / windowsHide / dao-check ⑦⑧⑨⑳ 不动。
- `node --test tests/*.test.js` 与 `node scripts/dao-check.mjs` 不因本块删除引入新红（云 Linux 上原有环境红除外）。

进展

- 空提交撑分支并推送，开 draft PR。
- 正在按 8-24 保留/删除清单核对 watchdog 撞限流检测是否已被 #833 搬走，搬走则整段删干净并接到现有探测入口。
