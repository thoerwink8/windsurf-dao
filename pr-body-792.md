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
- [x] 自动化服务单元不注入个人 `GH_TOKEN`；写入只走 GitHub App 凭据。仓内 `host/machine/systemd/*.service` 11/11 均 `UnsetEnvironment=GH_TOKEN GITHUB_TOKEN`。写 Issue 的 10 个单元另设 `GH_CONFIG_DIR=/var/empty`（token 卸了 `~/.config/gh` 个人登录还能用）；`dao-gh-events` 反过来——不许设空目录，webhook forward 仍读个人 gh 登录。少一处就红；0 个文件 = 没查成。
- [x] 每次调用生成可查询的结构化审计记录（宿主、动作、幂等键、目标、Bot 身份、URL、失败阶段）。落 `~/.dao/issue-gateway/audit/audit.ndjson`（不进 git）。
- [x] #790 回归：作者验证不是 Bot 时调用结果必须失败。`tests/issue-gateway.test.js`「作者是个人账号必须失败」。
- [x] 遍历全部宿主配置面的闸：少接一处就红；「扫完 0 条」和「没查成」分开。dao-check：`跨宿主 Issue 写入面 13/13 已接到网关（少一处就红）；裸 gh issue 写动作 0 处（扫了 44 个面）；生产 Issue 写点 0 处绕过网关（扫了 171 个脚本）；自动化单元不继承个人 token 11/11（写 Issue 的不读 ~/.config/gh；少一处就红）`。
- [x] `node --test tests/issue-gateway.test.js tests/issue-gateway-check.test.js tests/dispatch-gate.test.js tests/marshal-issue-identity.test.js tests/gh-as.test.js tests/machine-path.test.js` 绿；`node scripts/dao-check.mjs` 新增身份链检查通过（云环境仅剩 `~/.claude/skills` 不是目录，非本单回归）。

## 进展

- [x] 空提交撑分支并推送
- [x] 网关 lib + CLI（允许列表、禁传身份/token/shell、幂等、回读作者、审计）
- [x] dispatch-gate 拦裸 `gh issue` 写动作（Claude + Cursor 挂载面；含后台 `&`）
- [x] 全宿主配置面闸（少接一处就红）+ 生产脚本扫描
- [x] 飞书 triage / 指挥官 / 关单 / 熔断开单 / 消歧官 / 派工打标 / 完工评论 / 前置提醒 接网关
- [x] 常驻指令与 skill 改指向网关（文字只作迁移护栏）
- [x] 现役士兵书（orca + mirasim）接上网关，闸少接一面就红
- [x] 真实 GitHub 验收 + 负控（#1120）
- [x] gh-as CLI / hook 拦 Issue 写（身份不能自选）；单元不读 ~/.config/gh
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

本轮目标测试：`issue-gateway` 17 pass；`issue-gateway-check` + `dispatch-gate` + `gh-as` + `machine-path` 174 pass / 0 fail；`marshal-issue-identity` 绿。

`node scripts/dao-check.mjs`：190 项绿 / 1 项红 / 13 项跳过。红的是云环境 `~/.claude/skills` 不是目录（AGENTS.md 写明的环境差，非本单回归）。身份链检查绿：`跨宿主 Issue 写入面 13/13 已接到网关（少一处就红）；裸 gh issue 写动作 0 处（扫了 44 个面）；生产 Issue 写点 0 处绕过网关（扫了 171 个脚本）；自动化单元不继承个人 token 11/11（写 Issue 的不读 ~/.config/gh；少一处就红）`。

真机：#1120 create/comment/edit-labels/close 均 ok；create+comment 重放 `replay:true`；`--identity` exit 2；缺幂等键 exit 1。验完已关。

## 交卷闸（返工：现役士兵书接上网关）

本轮把工人第一份指令（`soldier-book.md` / `soldier-book-mirasim.md`）列入宿主面清单；少接一面就红。身份闸对齐：同一行已指向 `issue-gateway` 的禁止句不算教裸写。

SHA 不钉死当前 tip（随后续 docs 提交会过期，#971）；以合入点 + 判定末行为准，GitHub `headRefOid` 是审官所见。

最终基线：`origin/master` = `c3673ad9617805d3b9dc0c4dcc0068b23934aefd`
合入点：`c43287e34`（`[cc] merge: origin/master into dao-792`，merge-base = origin/master）
代码点：`9daf5644e`（`[cc] fix(issue-gateway): 现役士兵书接上网关，少接一面就红`）

推送后、工作区干净时实测 `node scripts/handoff-check.mjs`（交卷档）末行：

```
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
