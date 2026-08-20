目标
- 删掉「长驻进程绑死主树当下文件 + 可归档当归档必要门 + 失败只进自己 ack 的信箱」这一层。
- 守卫（信箱台 / 看门狗 / flow）必须跑 origin/master：落后或查不成即自停；合了就收树；可归档只加速。
- 关联：署名 issue #665（关单交给 `scripts/close-issues.mjs`，不走自动关键词）。

验收标准
1. 启动或每轮若代码落后 origin/master（或查不成），非零退出并写清原因，不许继续跑旧代码。推荐路径：`~/.dao/guard-mirror` 每次启动 fetch + reset --hard origin/master 再 exec；主树落后不影响关卡。
2. `gh pr view --json state` 为 MERGED 且盘面树对得上（路径 / 卡名 `PR-#N` / issue 号 / `linkedPR` 任一）→ 收根树。idle / done 终端不算占用；只有 working / waiting 才拒删。
3. 「可归档」只加速，不是门。信已经 ack、信箱台当时没删成，扫描器下一轮仍要收。
4. 归档失败写 GitHub issue/PR 评论（marshal），不只发会被信箱台自己 ack 掉的 orchestration escalation。
5. 测试分开「扫到 0」和「没查成」。上线前故意造一份落后样本，被当场拦住。
6. `node scripts/dao-check.mjs` 过。影响新机启动则同提交更新 NEW-MACHINE.md。
7. 不要 Closes。

体系类三问
1. 谁提的，发生在什么场景？2026-08-20 帅会话 /grill-ai。PR #664 已 MERGED、「可归档：664」已送达，盘面两张卡还在。信箱台 / 看门狗 / flow 都在跑未 pull 的主树，#664 里「归档认卡名」没加载；看门狗把树上终端当成占用；失败升信箱，信箱台自己 ack，帅聊天没回执。
2. 删哪一层能让这个问题不存在？删掉「长驻进程绑死主树当下文件 + 可归档当归档必要门 + 失败只进自己 ack 的信箱」。不要再给 linkedPR 匹配打第 4 层补丁。
3. 如果从零重做，今天还会造它吗？会造「一个关卡器」，不会造「绑在可能落后的主树、等人手重启才生效」的长驻进程。扳机只有 GitHub MERGED。可归档可留作加速。

进展
- [x] 开工五步：空提交、draft PR #666、卡状态、标签
- [x] 落后自停 + `~/.dao/guard-mirror` 只读镜像
- [x] MERGED 扫描（可归档只加速；idle/done 不算占用）
- [x] 归档失败写 GitHub 评论（marshal）
- [x] 测试 + NEW-MACHINE + dao-check（本单相关全绿；仓存量红：open 单积压超阈值，与 #665 无关）
