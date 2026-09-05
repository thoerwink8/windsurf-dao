## 目标

量化帅位 claude 会话每轮 cacheRead 的构成，按实测给出削减方案。只查证、出报告，不直接改任何注入面（CLAUDE.md / skills / settings 属改规则，砍哪行由用户拍）。署名 issue #981，关单交给 `scripts/close-issues.mjs`。

## 验收标准

- [ ] 静态面：两份 CLAUDE.md、MEMORY.md、skills 元数据清单、settings 各占多少 token（标明估算方法）
- [ ] 动态面：从 usage ndjson 的 cacheRead 增长曲线反推单会话上下文增长速率；说明 autoCompactWindow=800000 的长尾含义
- [ ] 输出一张「注入项 × token/轮 × 削减建议 × 预期节省」表，落本单评论
- [ ] 判别性实验：同形态请求改造前后各测一次，贴两次 usage 账对比
- [ ] 只读不改：不碰 CLAUDE.md、settings、skills 正式文件

## 进展

- 空提交撑分支并推送
- 正在读 `~/.mirasim/insights/usage-*.ndjson` 与注入面文件，量化构成
