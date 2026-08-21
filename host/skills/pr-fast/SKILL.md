---
name: pr-fast
description: 小活直开 draft PR、不走 issue。用户说「快速模式」「极速模式」「pr-fast」「直开PR」「快单」时读。Cursor Desktop 必须在新建 Agent 会话里动 git；当前帅窗只写任务书、验收、指 PR 链接。
---

# 快速模式 / 极速模式（pr-fast）

**承重层已是 PR-first**（`docs/decisions/2026-08-14-rules-retirement-native-mechanisms.md`）：任务 = draft PR，跨会话接力 = `gh pr list --draft`（见 `host/skills/resume/SKILL.md`）。本 skill 只补**显性入口**和**执行面路由**，不造脚本、不造 `_flow` 状态、不开 issue。

## 何时触发

用户说以下任一即读本 skill：

- **快速模式**、**极速模式**
- **pr-fast**、**直开PR**、**快单**

## 准入（过不了就停，改走 issue 或 `docs/ideas.md`）

同时满足才走本 skill：

1. **说得出做到什么算完**——验收能写进 PR 正文（可勾选清单或可执行命令）。
2. **单块小活**——一块 PR 能装下，不需要项化（`host/skills/dao-project/SKILL.md`）或多工人 `--split`。
3. **非体系类快路**——不改协作约定、不长驻机制、不需要审官乒乓闭环。体系类仍走 issue + `dispatch`（`merge-policy: manual`）。

任一条不过：按 `CLAUDE.md` 开单三问决定开 issue 或记 ideas；大块活走 `host/skills/dispatch/SKILL.md`。

## 帅窗 vs 执行面（硬规矩）

`host/skills/dispatch/SKILL.md` 主会话红线：**帅窗不碰 git**（branch / commit / push / 开 PR 都算）。

| 环境 | 动 git 的执行面 |
| --- | --- |
| **Cursor Desktop** | **新建 Agent 会话**（同项目）。当前会话只写任务书、贴验收、收 PR 链接。 |
| Claude Code 帅位 | 新开终端，或 `node scripts/dao.mjs dispatch`（可无 `--issue`，仍走工人+审官）。 |
| 只读查证、不进 git | 帅窗可直接做，不必开快路。 |

**Cursor Desktop 禁止**：在当前帅会话里 `git commit` / `gh pr create`——即使用户催，也先说明「请新开 Agent 会话执行下面任务书」。

## 流程（按序）

### 1. 帅窗：写任务书（不进 git）

用下面模板跟用户对齐，或写入 `_flow/` 临时 md 再交给新会话——**不要**把任务书当 git 产物提交：

```markdown
## 目标
（为什么做，一句话）

## 验收标准
- [ ] （可执行命令或可勾选项）

## 进展
- [ ] 待开工
```

### 2. 开执行面

- **Cursor**：请用户新开 Agent 会话，把任务书 + 本 skill 路径 `host/skills/pr-fast/SKILL.md` 一并附上（或 `@` 引用）。
- **CC / 终端**：在新终端执行；要审官闭环时用 `dispatch`，不要假装是快路。

### 3. 执行面：branch → 改 → 检 → draft PR

在**执行面**（不是帅窗）：

```bash
# 先验不在 master 上直接改（在途分支上干）
git checkout -b thoerwink8/<短名>

# 改完
node scripts/dao-check.mjs

# draft PR（多行正文用 --body-file）
node scripts/gh-as.mjs worker -- pr create --draft --title "[cursor] <标题>" --body-file <文件>
# 无 worker 凭据时：gh pr create --draft …（PR 仍须含 目标/验收/进展 三段）

git push -u origin HEAD
```

PR 正文必须含 **目标 / 验收标准 / 进展**（与 `CLAUDE.md` 一致）。**不写 issue 号、不署名 issue**——本路没有 issue；关单脚本不适用。

commit 标题带宿主标识；Cursor 执行面用 **`[cursor]`** 前缀。

### 4. 帅窗：验收与收口

- 执行面回报 PR 号后，帅窗只读 diff / CI / `dao-check` 结果，不在帅窗补 commit。
- 执行面自查通过后：`gh pr ready <N>`（或 `gh-as.mjs worker -- pr ready <N>`）。
- 合并与归档仍按 dispatch 帅侧规矩（#709 等现行拍板）；快路**不**省略终审，只省略 issue + 派工仪式。

### 5. 接力

下次任意会话：`gh pr list --draft` 或触发 `host/skills/resume/SKILL.md`——**不需要**席位租约或「交棒」机制。

## 与别的 skill 分工

| skill | 干什么 |
| --- | --- |
| **pr-fast（本页）** | 小活、无 issue、直 draft PR、执行面分离 |
| **resume** | 查在途 draft PR / issue / 工人 |
| **dispatch** | 要工人+审官、要 `--issue`、体系类、大块活 |
| **dao-project** | 多块相关活项化 |
| **admit-push** | 承认错误 → 开 issue 派工，不是快路 |

## 不要做的

- 不要为快路加 hook、dao-check 新项、租约文件、接力状态。
- 不要在帅窗（Cursor 当前会话）里动 git。
- 不要把体系类改动包装成「极速模式」绕过 manual merge 与 PR 三问。
- 不要开 issue「为了有个号」——要么真走开单三问，要么 PR 正文自洽。
