---
name: dao-commit
description: 提交时按 conventional commits 判断语义、调用 bump.mjs 维护版本号。用户说「dao-commit」「按语义提交」「bump 版本号」或即将 git commit 且项目有版本号时读。跨项目通用。
---

# dao-commit

提交时把 conventional commits 的**语义类型**判对、写进标题。判据是语义，不是 diff 行数。

**版本号不在提交阶段动**（windsurf-dao#800 发布列车拍板）：合并只是「进列车」，版本号只由发布动作产生——`scripts/release-train.mjs release`（到周日或攒够即切一版，按自上次 tag 以来合并的 PR 标题类型汇总档位）。所以**提交时你唯一的版本相关职责，是把标题的类型写对**，让列车能汇总。本目录的 `bump.mjs` 不再由提交阶段调用，保留为发布列车复用的纯函数库（版本号语义只此一份）。

## 动作（按序，不许跳）

1. **判断类型**：这次改动对用户意味着什么？`feat` / `fix` / `breaking` / 其他（docs、chore、test、refactor、perf、ci…）。`breaking` 与 `feat` 同现 → `breaking`。看不清就问用户，不许猜。
2. **写进标题**：conventional 前缀 + 宿主标。形如 `[cc] feat(scope): …` / `[grok] fix: …` / `[cc] feat!: …`（破坏性）。宿主标（`[cc]`/`[grok]`/`[pi]`/`[codex]`）在最前，发布列车会剥掉它再认类型。**标题类型是列车汇总档位的唯一依据**——写错=版本切错。
3. **不动版本号载体**：不要改 `package.json` 的 `version` / `VERSION` 文件，不要打 tag。这些是发布动作（`release-train.mjs release`）的活，提交阶段动它们会被 dao-check ㉗ 的溯源判红（「非发布提交动了版本号」）。

判据：`feat`→minor，`fix`→patch，`breaking`→major，其他→不抬版本。发布列车按这套把一批 PR 标题汇总成一个档位（含 feat⇒minor / 只有 fix 类⇒patch / 标 breaking⇒major / 一个都没有⇒不发）。
版本号是 SemVer 2.0.0（可带可选 `v` 前缀）：`1.2.3-beta.1` / `1.2.3+build.7` 合法；核心段前导零、空标识符、数字预发布前导零非法。

## 版本号闸（dao-check ㉗）

- **合法/不倒退**：载体存在时变化必须是合法 SemVer、不比基线小。
- **溯源**（#800）：载体的任何变化只允许出现在 `release:` 前缀提交 / 打了 tag 的提交上；普通提交动了版本号 = 红。这正是新口径的「乱 bump」——提交阶段就不该碰版本号。
- 两道都只拦「乱 bump」，**不判该不该 bump**——该不该发、发什么档，是发布列车按标题算的。

## 不要做的

- 不要在提交里 bump 版本号或打 tag（那是 `release-train.mjs release` 的活）。
- 不要按改动大小决定类型（小 feat 也是 feat→minor）。
- 不要让 `bump.mjs` 读文件或解析 commit 消息——类型是你判断的、写进标题的。
- 不要把本 skill 常驻注入；按需读。
