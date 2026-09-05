目标
堵 #815 第 6 洞（2026-09-03 13:50 实咬）：`reviewer-attach` 对 pi 类审官注入失败后把整棵树回滚，下次 `start --worktree path:` 直接 selector_not_found。注入改走与工人相同的 #805 start 路径（`--agent` + 探就绪/回退）；树已建成后失败不回滚，留着让人接手。署名 issue #815，关单交给 scripts/close-issues.mjs。

验收标准
- 判别测试：注入/开工验证失败 → keepTree，rollback=false，树仍在；未建树才允许回滚
- dao.mjs：`审官注入后开工验证失败` 不再 failCreated；create/attach 走 keepCreated
- launchAgentInWorktree：daoTrace 不得把 pi 审官逼成 --command，start=agent 仍 deferred（#805 校准/回退覆盖审官）
- reviewer-book 写明「失败不回滚树」和接手命令
- node scripts/dao-check.mjs 绿；`node --test tests/five-holes-815.test.js` 过

进展
- [x] 开工：空提交撑分支 + draft PR
- [x] `planReviewerKeepOnFail` + `keepCreated`：树已建成失败不回滚
- [x] 审官 create/attach 传 `preferAgent`，daoTrace 不再把 pi 审官逼成 --command
- [x] 判别测试 tests/five-holes-815.test.js ⑥ + reviewer-book「失败不回滚树」
- [x] `node --test tests/five-holes-815.test.js` 7/7；相关套 160 过。dao-check 本单改动无关红：云 Linux 缺 `~/.codex/skills`（仓外路径闸环境差），非本单引入
