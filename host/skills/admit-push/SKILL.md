---
name: admit-push
description: 用户发现 AI 承认了错误但当轮没处置时，调用本 skill 把那件事推进成一张单。用户说「推进」「把刚才承认的派出去」「承认即派」「admit-push」时读。这不是自动落账，也不会在没人叫的时候自己跑。
---

# 承认即派

用户要的是**推进**：承认了 → 当场变成一张走现有流水线的单。账本就是 GitHub issue，不要另造文件。

**已知限制（用户接受的取舍）：** 靠用户调用，防不住用户没发现的那些。本 skill 不假装全覆盖。

## 步骤（按序，不许跳）

### 1. 从本轮对话里找出欠账

读当前会话，列出「AI 承认了、当轮没处置」的问题。可能 0 条、可能多条。

- 0 条：直说「这轮对话里没扫到未处置的承认」，停。不要为了有产出硬编。
- 多条：逐条列出（一句话是什么 + 为什么当轮没做），再往下走。

只认本会话里已经说出口的承认。不要靠猜、不要扫别的会话、不要读不存在的账本文件。

### 2. 每条走 grill-ai

读 `host/skills/grill-ai/SKILL.md`，对**这一条**回答它的五条清单。至少要有：根因是什么、该不该做、删哪一层能让这个问题不存在。清单本体在那边，这里不抄。

拷问之后若结论是「这件事不该存在」，把「删哪层」写进给用户看的选项说明里，仍交用户拍，不替用户选不做。

### 3. 一条一问，当场执行

每条用 `AskUserQuestion`（硬限 2—4 项），选项固定这三套语义，推荐放第一：

1. **派优先单** — 开 issue，立刻 `dao.mjs dispatch` 派出去
2. **排期处理** — 只开 issue，不派工
3. **记一笔不做** — 不开单；`dao-mode park`，值得立判例再写 memory

用户选完**当场做完**，不攒「稍后」。多条就一条问完做完再问下一条。

本 skill 在跟**用户**说话时用 `AskUserQuestion`。若你身在 Orca 工人编排里、对面是协调者不是用户，不要调这个 skill 去问协调者。

### 4. 三个出口（全是现成机制，旗标以当时 `--help` 为准）

**派优先单**

1. 先过开单三问（`Claude.md`）：说得出做到什么算完、这批会做、不是 memory/docs。过不了就改问「排期」或「不做」，不要硬开。
2. `node scripts/gh-as.mjs marshal -- issue create`（帅写 issue 走 marshal，见 dispatch skill「帅操作 issue 的身份约定」）。正文写清目标、做到什么算完、grill-ai 那三句（根因 / 该不该 / 删哪层）。用户刚拍了「派」，消歧记录写「用户选派优先单，无未决岔路」，再 `node scripts/gh-as.mjs marshal -- issue edit <N> --add-label "已消歧"`（`dispatch --issue` 读不到这个 label 会拒派）。
3. `node scripts/dao.mjs dispatch --issue <N> --name "<动宾短语>" --spec "短摘要：<目标+职责类别>" --model <id> --reviewer <id>`。旗标以 `node scripts/dao.mjs --help` 为准；选谁读 `docs/model-routing.toml` / 点将台，不要默默定。
4. 派工细节见 `host/skills/dispatch/SKILL.md`，本页不复制。

**排期处理**

只 `node scripts/gh-as.mjs marshal -- issue create`（同样要过开单三问）。不 dispatch、不假装已消歧。

**记一笔不做**

```bash
node ~/.claude/skills/dao-mode/hooks/dao-mode.mjs park --what "<一句话：是什么，为何不做>"
```

仓内真相源是 `host/skills/dao-mode/hooks/dao-mode.mjs`。值得立制度判例的，按现有 memory 写法记一条。不开 issue。

## 不要做的

- 不要建 `DEFERRED.md`、不要打 `[[挂账:]]`、不要加 hook、不要加 dao-check 项。
- 不要在没人调用时自己跑本 skill。
- 不要把「承认」记到第二套账本。要留的东西进 issue，或 park / memory。
