目标
- 删掉 GitHub `Closes` 自动关单；关单只走脚本：署名 issue 的 PR 已 MERGED **且** check 全绿才 `issue close`；合进但 check 红的不关（已关的重开）。
- 关联：署名 issue #657（本单关单交给 `scripts/close-issues.mjs`，不走自动关键词）。

验收标准
1. 士兵/审官任务书模板不再教写 `Closes`（改写「署名 issue #N，关单交给关单脚本」），`Claude.md` / dispatch「落地即关」改为指向关单脚本指针。
2. `dao-check` 扫仓内会进 PR 正文的 dispatch 模板：再出现 `Closes #` / `Fixes #` 就红（含红/绿样本判别）。
3. 关单脚本/合后钩：`gh pr view --json state,statusCheckRollup` → MERGED 且全部 check 绿（没查成 ≠ 绿）才 `issue close`；若单已关但关它的 PR check 红 → `issue reopen`。
4. 故意违规：造一条 Closes 模板被拦；造「合进但 check 红」样本被重开。`dao-check` 全绿。
5. `Claude.md` / dispatch「落地即关」改成指针：关单只认本脚本，不认 Closes。

进展
- soldier-book.md 改写「署名 issue #N，关单交给 `scripts/close-issues.mjs`」，明令禁止 GitHub 关单关键词；dispatch SKILL.md「落地即关」改指关单脚本，多 issue 署名规范同步更新。
- 新建 `scripts/close-issues.mjs`（关单 CLI）/ `scripts/lib/close-issue.mjs`（判定纯函数，可测）：MERGED 且 `statusCheckRollup` 全绿才 `issue close`；合进但 check 红（FAILURE/未完成/无 check/没查成）不关，若单已关而关它的 PR check 红 → `issue reopen`。合后钩接入 `flow.mjs` 的 PR MERGED 退役处理。
- 各署名解析器（dao-cmd `linkedIssueNumbers` / flow `ticketIssueNumber` / dao-check `closesNumbers` / ready-queue / watchdog）认新规范「署名 issue #N」并兼容旧关单词。
- `dao-check` 新增 ㉑「关单不改走 GitHub 自动关键词」：红/绿样本判别 + live 扫 dispatch 模板，模板再出现 Closes #/Fixes # 就红。
- 新测试 `tests/close-issue.test.js`（25 断言）：署名解析、全绿判定、close/reopen 落动作。全套 33 套 / 2043 断言过，0 红。
- 验收自证：`tests/fixtures/close-auto/red` 造 Closes 模板被㉑拦；`tests/close-issue.test.js` 的「红且单已关→reopen」样本覆盖「合进但 check 红被重开」。`dao-check` 本 PR 相关检查全绿（唯一现存红是 open 单积压超阈值，属仓存量、与 #657 无关）。
