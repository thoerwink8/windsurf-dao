## 目标

收口跨宿主 GitHub Issue 写权限：Claude / Codex / MiraSim / Linux 协调服务只经唯一网关写 Issue，身份固定 `dao-marshal[bot]`，不能自选个人 `gh`、token 或任意 shell。署名 issue #792。关单交给 `scripts/close-issues.mjs`。

事故样本是 #790：MiraSim/Codex 聊天入口裸 `gh issue create`，作者记成用户个人账号。本单把正确性从「某个宿主有没有读到 skill」挪到写入网关和凭据边界。

## 验收标准

- [x] 存在跨宿主可调用的唯一 Issue 写入入口（`node scripts/issue-gateway.mjs`），业务契约 create / comment / close / edit-labels 同一份。
- [x] 调用者无法选择个人身份、传入 token 或执行任意 shell；网关固定 `dao-marshal[bot]`。负控：`--identity worker` → exit 2「禁止旗标」。
- [x] 网关分别完成 create、comment、label edit、close；可验证写入作者均为 `app/dao-marshal`。真机样本 #1120：create `author: app/dao-marshal`；comment `author: dao-marshal[bot]`（https://github.com/thoerwink8/windsurf-dao/issues/1120）。
- [x] 身份错误、Bot 凭据缺失、GitHub 查询失败、作者回读失败均 fail-closed；没有任何路径退回个人 `gh`。缺幂等键 → `missing_idempotency` exit 1。
- [x] 同一 `idempotency_key` 重放 create/comment 不产生重复对象，并返回原结果。#1120 create/comment 第二次均为 `"replay":true`，number/url 不变。
- [x] 故意从 Claude / Cursor 入口跑裸 `gh issue` 写动作：hook 当场拒绝；无 hook 的后台服务只暴露网关且不读个人 token。`dispatch-gate` 含单个 `&` 拆分；Claude + Cursor 入口均有负控。
- [x] 自动化服务单元不注入个人 `GH_TOKEN`；写入只走 GitHub App 凭据。仓内 `host/machine/systemd/*.service` 11/11 均 `UnsetEnvironment=GH_TOKEN GITHUB_TOKEN`（含合入后新进的 refiner / nudge / board-gc / land / progress-watch / gh-events / sync / miraquota）。少一处就红；0 个文件 = 没查成。
- [x] 每次调用生成可查询的结构化审计记录（宿主、动作、幂等键、目标、Bot 身份、URL、失败阶段）。落 `~/.dao/issue-gateway/audit/audit.ndjson`（不进 git）。
- [x] #790 回归：作者验证不是 Bot 时调用结果必须失败。`tests/issue-gateway.test.js`「作者是个人账号必须失败」。
- [x] 遍历全部宿主配置面的闸：少接一处就红；「扫完 0 条」和「没查成」分开。dao-check：`跨宿主 Issue 写入面 11/11 已接到网关（少一处就红）；裸 gh issue 写动作 0 处（扫了 44 个面）；生产 Issue 写点 0 处绕过网关（扫了 171 个脚本）；自动化单元不继承个人 token 11/11（少一处就红）`。
- [x] `node --test tests/issue-gateway.test.js tests/issue-gateway-check.test.js tests/dispatch-gate.test.js tests/marshal-issue-identity.test.js` 绿；`node scripts/dao-check.mjs` 新增身份链检查通过。

## 进展

- [x] 空提交撑分支并推送
- [x] 网关 lib + CLI（允许列表、禁传身份/token/shell、幂等、回读作者、审计）
- [x] dispatch-gate 拦裸 `gh issue` 写动作（Claude + Cursor 挂载面；含后台 `&`）
- [x] 全宿主配置面闸（少接一处就红）+ 生产脚本扫描
- [x] 飞书 triage / 指挥官 / 关单 / 熔断开单 / 消歧官 / 派工打标 / 完工评论 / 前置提醒 接网关
- [x] 常驻指令与 skill 改指向网关（文字只作迁移护栏）
- [x] 真实 GitHub 验收 + 负控（#1120）
- [x] 自查 / dao-check / handoff-check

## 审官 8 条（head `2584003b` 打回）怎么修的

1. 飞书卡片拍板：`handleCardAction` 带 `idempotency_key=feishu-card:<messageId>:<choice>`，`applyCardActions` 传给真实 `makeGhDeps`；测试用真 deps，缺键 `rejects`。
2. 熔断 6h 重报：`breakerAllOpenIdempotencyKey(now)` 按 `ALL_OPEN_DEDUP_MS` 窗口换键；同窗口 replay、跨窗口新建。走真实网关幂等账。
3. 生产写点：refiner / stampIssueLabels / postIssueComment / closeIssueForPr / notify-blocked / worker-done / dao-amend 一律 `applyIssueWrite`；没注入写入器 fail-closed，不许退回裸 `gh issue`。`checkNoBareIssueWriteInCode` 扫 `scripts/`，0 文件 = 没查成。
4. `splitShellStatements` 拆单个 `&`；Claude/Cursor 入口负控 `gateway & gh issue create` → block。
5. close/reopen 回读 `{}` 缺 `state` → `gh_readback`，不是绿。
6. `fail()` 里 `ok:false` 压过 extra；幂等账写失败返回 `landed:true` + 「需人工按 URL 处置」。
7. 审计写失败 fail-closed，不得报告成功。
8. 本段贴交卷闸输出。

## 自查证据

目标测试（issue-gateway / issue-gateway-check / dispatch-gate / marshal-issue-identity / feishu-triage / provider-breaker / close-issue / dao-reviewer / notify-blocked / refiner / five-holes-815 / commander-verbs）：402 pass / 0 fail。另跑 close-issue / unit-privilege / nudge-stalled / gh-events / miraquota / progress-stall / close-issues-timer：231 pass / 0 fail。

`node scripts/dao-check.mjs`：好的（191 项，5 条可见，13 项跳过，65.2s）。身份链检查绿，见上。

真机：#1120 create/comment/edit-labels/close 均 ok；create+comment 重放 `replay:true`；`--identity` exit 2；缺幂等键 exit 1。验完已关。

## 交卷闸（返工：跟上 origin/master + 合入后单元全卸个人 token）

上一轮审官红项是交卷闸钉旧 head。本轮再合入 `origin/master`（#1102/#1104），并补上合入后新进单元没卸个人 token 的洞。SHA 不钉死当前 tip（随后续 docs 提交会过期，#971）；以合入点 + 判定末行为准，GitHub `headRefOid` 是审官所见。

最终基线：`origin/master` = `918d0108e0c236e650e57530459f286838604421`
合入点：`32c4a27b4`（`[cc] merge: origin/master into dao-792`，merge-base = origin/master）

合入并卸 token 推送后、工作区干净时实测 `node scripts/handoff-check.mjs`（交卷档）：

```
交卷闸：dao-792 vs origin/master（已拉远端）
  ✓  ② 相对 master 零删除 —— 相对 origin/master 零删除
  ✓  ④ 本分支新写的仓内指针都存在 —— 新增 2076 行里的 20 条仓内路径指针都真实存在
  ✓  ⑤ 自证基线＝审官所见 —— 工作区干净，本地与 origin/dao-792 同点（c51e60d）

合并前还要过的（查了，但不进本次判定）：
  ✓  ① 基底含最新 master —— 基底含最新 origin/master
  ↑ 这几条归合并闸：`node scripts/handoff-check.mjs --gate merge`。
    它们红不挡交卷，也不该被审官拿来判红——基底新旧在审查期间必然会过期（#1117）。

判定：通（3 通 / 0 红 / 0 没查成）——可以交卷
```

同点 `node scripts/handoff-check.mjs --gate merge`（合并档）末行：

```
判定：通（4 通 / 0 红 / 0 没查成）——可以合并
```

## 体系类改动

1. 谁提的，发生在什么场景？用户在 MiraSim/Codex 主聊天发现 #790 作者是个人账号，要求从零收口身份链。
2. 删哪一层能让问题不存在？删除「AI 可以自由选择个人 gh 或 Bot 写入入口」这一层。
3. 如果从零重做，今天还会造它吗？会保留 GitHub App 三身份，但正确性从一开始就固化在写入网关和凭据边界，不寄托于某个宿主是否读到 skill。

## 设计阶段记录

本单 issue 正文已含体系类三问与验收判据，消歧评论（2026-09-06）判无岔路可派。豁免盲设计题：按 issue 正文施工，不另开设计岔路。

## 机制判定

#790 这类错在制度生效前还会再犯吗？**会**——规范只写在 Claude 专用 skill 时，别的宿主照样裸 `gh issue create`。机制改在：唯一写入网关 + hook 拦裸写 + 遍历全部宿主配置面的闸（少接一处就红）+ 生产脚本扫描 + 后台服务不继承个人 token。文字提醒只作迁移护栏，不承重。
