---
name: pr-fast
description: 小活直开 draft PR、不走 issue。快路 GitHub 写动作全走 marshal；写码在执行面（可派后台子代理，不必新开聊天）。用户说「快速模式」「极速模式」「pr-fast」「直开PR」「快单」时读。
---

# 快速模式 / 极速模式（pr-fast）

**承重层已是 PR-first**（`docs/decisions/2026-08-14-rules-retirement-native-mechanisms.md`）：任务 = draft PR，跨会话接力 = `gh pr list --draft`（见 `host/skills/resume/SKILL.md`）。本 skill 只补**显性入口**和**执行面路由**，不造脚本、不造 `_flow` 状态、不开 issue。

快路 PR 作者是 **`dao-marshal[bot]`**（帅窗用 marshal 开 PR；用户已接受）。

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

主会话红线精神保留：**帅窗禁止 git 写**（`commit` / `push` 等）。快路例外见 `host/skills/dispatch/SKILL.md`「主会话红线」旁指针——开 PR 等 GitHub 写动作走 **marshal**，不算「手碰 git」。

**执行面可以是后台子代理。** 帅窗（当前协调会话，含 Cursor Multitask）写完任务书后，直接派后台子代理干活。不要把「请用户新开 Agent 会话」当成唯一或必经路径。

| 谁 | 做什么 | 禁止 |
| --- | --- | --- |
| **执行面**（后台子代理；兜底才是新会话/新终端） | `checkout -b` → 改码 → `dao-check` → `push` | **`gh pr create`**、worker 开 PR、裸 `gh` 退路 |
| **帅窗** | 写任务书、派执行面；`gh-as.mjs marshal`：`pr create` / `pr ready` / `pr comment` / `pr merge` | 自己动手 git 写（commit/push）；**裸 `gh`**（必须 marshal） |

帅窗自己仍然禁止 `git commit` / `git push`——即使用户催，也不在帅窗手碰 git；派后台子代理当执行面去做。`create` / `ready` / `comment` / `merge` 留在帅窗走 marshal。不要把用户支去新开一个聊天窗口。

## 流程（按序）

### 1. 帅窗：写任务书（不进 git）

用下面模板跟用户对齐，再交给执行面（后台子代理，或兜底时的新会话）——**不要**把任务书当 git 产物提交，也不要为此造 `_flow` 状态：

```markdown
## 目标
（为什么做，一句话）

## 验收标准
- [ ] （可执行命令或可勾选项）

## 进展
- [ ] 待开工
```

### 2. 开执行面

按宿主选路，**不要默认让用户新开聊天**：

- **Cursor Multitask / 协调器（有子代理能力）**：写完任务书后，直接派**后台子代理**当执行面。把任务书 + 本 skill 路径 `host/skills/pr-fast/SKILL.md` 注入给子代理。子代理就是执行面：由它 `commit` / `push`。
- **用户不在 Multitask、也没有子代理能力（兜底）**：才退回「新开 Agent 会话或新终端」。把任务书 + 本 skill 一并附上（或 `@` 引用）。
- **CC / 终端**：在新终端执行；要审官闭环时用 `dispatch`，不要假装是快路。

### 3. 执行面：branch → 改 → 检 → push（不开 PR）

在**执行面**（后台子代理或兜底会话；不是帅窗）：

```bash
# 先验不在 master 上直接改（在途分支上干）
git checkout -b thoerwink8/<短名>

# 改完
node scripts/dao-check.mjs

git push -u origin HEAD
```

commit 标题带宿主标识；Cursor 执行面用 **`[cursor]`** 前缀。

执行面**只**做到 push；**禁止**执行面 `gh pr create`、禁止 `gh-as.mjs worker -- pr create`、禁止裸 `gh` 开 PR 退路。推完把分支名回报帅窗。

### 4. 帅窗：marshal 开 draft PR → 验收 → 收口

分支已在远端后，**帅窗**用 marshal（多行 body 用 `--body-file`；若当前在 master，加 `--head <branch> --base master`）：

```bash
node scripts/gh-as.mjs marshal -- pr create --draft --title "[cursor] <标题>" --body-file <文件> --head <branch> --base master
node scripts/gh-as.mjs marshal -- pr ready <N>
node scripts/gh-as.mjs marshal -- pr comment <N> --body-file <文件>
node scripts/gh-as.mjs marshal -- pr merge <N> --squash --delete-branch
```

命令以 `gh-as` / `gh` 实际能力为准。缺 marshal 凭据报「这台机器没装」，**不许**退回裸 `gh` 或 worker 装成做完。

PR 正文必须含 **目标 / 验收标准 / 进展**（与 `CLAUDE.md` 一致）。**不写 issue 号、不署名 issue**——本路没有 issue；关单脚本不适用。作者应为 **`dao-marshal[bot]`**。

- 开出 draft 后，帅窗只读 diff / CI / `dao-check` 结果，不在帅窗补 commit / push。
- 执行面自查通过、帅窗确认验收后：`marshal -- pr ready <N>`。
- **用户在触发快路时已拍板要做的活** ⇒ 执行面 push 后，帅窗 marshal 开 draft → 自查/`dao-check` → ready → **终审通过即** `pr merge --squash --delete-branch`，**不要**再问用户「要不要合」/「要合的话说一声」。
- **例外才停手问用户**：CI 红、本单 `dao-check` 新红、体系类、或用户当轮明说「先别合」。
- 快路**不**省略终审，只省略 issue + 派工仪式；合并一律走 marshal（#709 等现行拍板）。

### 5. 接力

下次任意会话：`gh pr list --draft` 或触发 `host/skills/resume/SKILL.md`——**不需要**席位租约或「交棒」机制。

## 与别的 skill 分工

| skill | 干什么 |
| --- | --- |
| **pr-fast（本页）** | 小活、无 issue、直 draft PR；写码在执行面（子代理优先），GitHub 写走 marshal |
| **resume** | 查在途 draft PR / issue / 工人 |
| **dispatch** | 要工人+审官、要 `--issue`、体系类、大块活 |
| **dao-project** | 多块相关活项化 |
| **admit-push** | 承认错误 → 开 issue 派工，不是快路 |

## 不要做的

- 不要为快路加 hook、dao-check 新项、租约文件、接力状态。
- 不要在帅窗里 `git commit` / `git push`；要写 git 就派执行面（后台子代理）。
- 不要把用户支去新开聊天当必经路径；有子代理就派子代理。
- 不要在执行面开 PR（含 worker / 裸 `gh`）；不要用裸 `gh` 做 create/ready/comment/merge。
- 不要把体系类改动包装成「极速模式」绕过 manual merge 与 PR 三问。
- 不要开 issue「为了有个号」——要么真走开单三问，要么 PR 正文自洽。
