---
name: dao-commit
description: 提交时按 conventional commits 判断语义、调用 bump.mjs 维护版本号。用户说「dao-commit」「按语义提交」「bump 版本号」或即将 git commit 且项目有版本号时读。跨项目通用。
---

# dao-commit

提交时维护版本号。判据是 conventional commits 的**语义类型**，不是 diff 行数。本目录自带 `bump.mjs`，不依赖任何仓内脚本。

## 动作（按序，不许跳）

1. **判断类型**：这次改动对用户意味着什么？`feat` / `fix` / `breaking` / 其他（docs、chore、test、refactor、ci…）。`breaking` 与 `feat` 同现 → `breaking`。看不清就问用户，不许猜。
2. **探测载体**：仓库根的 `package.json`（`version` 字段）或 `VERSION` 文件。两个都有就两个都改成同一个新号。都没有 → 问用户要不要建、建哪种；禁止默默跳过，也禁止默默新建。
3. **调用纯函数**（本 skill 目录下，无 IO）：

   ```bash
   node bump.mjs <当前版本号> <类型>
   ```

   stdout 是 JSON：`{ shouldBump, bumpType, from, to }`。`shouldBump=false` 且无 `error` → 不改版本号。有 `error` → 停手，载体里的号不合法，先问用户。
4. **该 bump 就跟代码同一个 commit** 把载体写成 `to`。不要单独开「chore: bump version」。非语义 commit 不动版本号。
5. **补丁位走 tag 锚定的仓**（仓内 version 脚本含 `rev-list --count v<base>.0` 即是）：minor/major bump 的提交上**同时打锚点 tag** `v<to>` 并随收工推远端——补丁位 = 自锚点以来的提交数，锚点一挪自然归零（SemVer 的 patch 归零 MUST；setuptools-scm/GitVersion 同族，2026-09-02 拍板，windsurf-dao#795）。纯手管 SemVer 的仓无此步。

判据：`feat`→minor，`fix`→patch，`breaking`→major，其他→不 bump。
版本号是 SemVer 2.0.0（可带可选 `v` 前缀）：`1.2.3-beta.1` / `1.2.3+build.7` 合法；核心段前导零、空标识符、数字预发布前导零非法。

**从「总提交数做补丁位」迁移到 tag 锚定的仓**：切换那次必须同时 bump minor——旧口径补丁位可能很大（如 0.7.36），新口径从 0.7.1 数起会比它小，自动更新类比较器（electron-updater 按 semver）将永远判不出新版。

## 双通道

- 项目有「版本号变化必须合法、不倒退」的检查：它只拦乱 bump（非法 / 倒退），**不判该不该 bump**。忘了 bump，检查不会替你发现。
- 没有这种检查：全靠本 skill 主动调。

## 不要做的

- 不要按改动大小决定 bump（小 feat 也是 minor）。
- 不要让 `bump.mjs` 读文件或解析 commit 消息——类型是你判断的。
- 不要把本 skill 常驻注入；按需读。
