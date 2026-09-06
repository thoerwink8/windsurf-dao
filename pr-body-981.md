## 目标

量化帅位 claude 会话每轮 cacheRead 的构成，按实测给出削减方案。只查证、出报告，不直接改任何注入面（CLAUDE.md / skills / settings 属改规则，砍哪行由用户拍）。署名 issue #981，关单交给 `scripts/close-issues.mjs`。

## 验收标准

- [x] 静态面：两份 CLAUDE.md、MEMORY.md、skills 元数据清单、settings 各占多少 token（标明估算方法）——见 `docs/observations/2026-09-06-cacheRead-injection-surface.md` §1–2
- [x] 动态面：本机 opus 只有 1–2 轮，给了两轮 cacheRead=上一轮 cacheWrite 的曲线，以及 autoCompactWindow=800000 的长尾含义（§3）；issue 的 113 次 / 77× **不在本机 insights**，覆盖面写在文首
- [x] 「注入项 × token/轮 × 削减建议 × 预期节省」表在观察文件 §2.1 和 §5
- [x] 判别性实验：活实验因网关 503（group windsurf 无 opus/fable 通道）没做成，fail-visible 写在 §4.1；同形态账本对照（空 cwd 36.3k vs dao 树 55.1k cacheWrite）在 §4.2
- [x] 只读不改：未碰 CLAUDE.md、live settings、skills

## 进展

- 空提交撑分支并推送；draft PR #983
- 报告落 `docs/observations/2026-09-06-cacheRead-injection-surface.md`

## 机制判定

会再犯。不是某次提示词写长了：Claude Code 每轮重读 cache 前缀是产品行为；Mirasim 启动模板把 `autoCompactWindow` 钉成 800000（live settings 看不见，NEW-MACHINE 的 500k 被盖掉）；insights 在工人这台对不上 issue 的 113 次长会话。本单只查证，机制改动（启动模板 / 清单卸 lark / memory 不进每轮）要另拍。
