# exhausted 改成 PR 属性：打标认输，不再开单（#1000）

署名 issue #1000，关单交给 `scripts/close-issues.mjs`。

## 目标

`exhausted`（自动化试满仍没推动）不再走 `escalate` 开「待拍板」单。改成 PR 上的状态：打 `卡死/自动化认输`、幂等评论、指挥官跳过该 PR，看门狗按 `pushed:<pr>@<head>` 推帅位一次。`dao now` 的「待你拍」列出带该标（以及 `卡死/等用户`）的 PR。

硬边界：不许改 `escalate` 的去重逻辑。

## 验收标准

1. 故意把某张 PR 的 drain tries 灌到上限，跑一轮 `decide` → 当场产 `mark-exhausted`（打 `卡死/自动化认输` + 一条说明评论：动词、次数、head）。不产 `open-issue` / `escalate(drain-exhausted)`。
2. 第二轮：PR 已带该标 → 不重复评论、不对该 PR 再 `retry-drain` / `rereview` / `rework`（省额度）。
3. 判别性反例：tries 未满不得产 `mark-exhausted`。
4. 看门狗：同一 `(pr, head)` 只推一次；改 head 允许再推；帅位移除 label 或换成 `卡死/等用户` 后不再推。账本键必须带 `@head`。
5. `dao now`「待你拍」列出带这两个 label 的 PR。
6. `wake-exhausted`（终端，不是 PR）仍走 `open-issue`，本单不动那条路。

## 进展

- 纯函数 `scripts/lib/exhausted.mjs`：标名、评论模板、`exhaustedPushKey`（缺 head 不给键）、`planExhaustedPush`。
- `decide`：drain / rereview / rework 试满产 `mark-exhausted`，不再 `escalate`/`open-issue`。已贴认输/等用户标的 PR 整轮跳过。
- executor：`execMarkExhausted` 幂等（标已在不重复评论；labels 没查成 fail-closed 不打）。
- 看门狗 `agent-stall-watch` 接 `planExhaustedPush`，账本 `~/.dao/exhausted-push.json`，键 `pushed:<pr>@<head>`。
- `dao now`：`assessPr` 把两个卡死标送进「待你拍」。GraphQL / `gh pr list` 补采 PR labels。
- `OPEN_ISSUE_REASONS` 只留 `wake-exhausted`。`escalateLedger` / `escalateKey` 一字未动。

### 验收证据

```
node --test tests/exhausted.test.js tests/commander.test.js tests/commander-verbs.test.js tests/now-board.test.js tests/agent-stall-watch.test.js
# 215 过 / 0 红
```

`tests/exhausted.test.js` 20 条，对应验收 1–6：

- tries 到顶 → `mark-exhausted`，零 `open-issue` / `escalate(drain-exhausted)`
- 第二轮已带标 → 零 `mark-exhausted` / `retry-drain` / `rereview`
- tries=1 → 仍 `retry-drain`，不打标
- 看门狗：同 `(pr,head)` 不重推；新 head 再推；等用户/摘标/缺 head/缺 labels 都不推
- `dao now` 两个标各自进待你拍
- `OPEN_ISSUE_REASONS === ['wake-exhausted']`；`escalateLedger` 源码仍在

```
node scripts/dao-check.mjs
# 好的（159 项，10 项跳过，46.0s）
```

### 机制判定

这错在制度生效前还会再犯吗？**会**——`exhausted → escalate 开单` 叠上去重，同一 key 已开过就零日志永久卡死（PR #909 实测）。机制改在本 PR：认输做成 PR 属性（打标 + 跳过 + 看门狗按 `@head` 推一次），事件式告警被去重吞掉的形状不存在。escalate 去重一字未动（那是「怎么喊人」第四层，本单全部意义就是不走那条路）。

### 回流

产物：`scripts/lib/exhausted.mjs` 的状态式认输（标 / 跳过 / `@head` 推一次）。

为什么通用：① 任何「机械重试无解」的出口（drain / rework / rereview 三兄弟，以及以后同类 tries 上限）共用同一套属性，不必各写一份 escalate；② 盘面（`dao now`）和看门狗读同一份标，发现面不靠自报。

建议落点：留原仓。这是指挥官闭环的一块，不该上收成独立包。
