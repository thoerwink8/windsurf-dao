## 目标

收口跨宿主 GitHub Issue 写权限：Claude / Codex / MiraSim / Linux 协调服务只经唯一网关写 Issue，身份固定 `dao-marshal[bot]`，不能自选个人 `gh`、token 或任意 shell。署名 issue #792。关单交给 `scripts/close-issues.mjs`。

事故样本是 #790：MiraSim/Codex 聊天入口裸 `gh issue create`，作者记成用户个人账号。本单把正确性从「某个宿主有没有读到 skill」挪到写入网关和凭据边界。

## 验收标准

- [ ] 存在跨宿主可调用的唯一 Issue 写入入口（`node scripts/issue-gateway.mjs`），业务契约 create / comment / close / edit-labels 同一份。
- [ ] 调用者无法选择个人身份、传入 token 或执行任意 shell；网关固定 `dao-marshal[bot]`。
- [ ] 网关分别完成 create、comment、label edit、close；可验证写入作者均为 `app/dao-marshal`。
- [ ] 身份错误、Bot 凭据缺失、GitHub 查询失败、作者回读失败均 fail-closed；没有任何路径退回个人 `gh`。
- [ ] 同一 `idempotency_key` 重放 create/comment 不产生重复对象，并返回原结果。
- [ ] 故意从 Claude / Cursor 入口跑裸 `gh issue` 写动作：hook 当场拒绝；无 hook 的后台服务只暴露网关且不读个人 token。
- [ ] 自动化服务单元不注入个人 `GH_TOKEN`；写入只走 GitHub App 凭据。
- [ ] 每次调用生成可查询的结构化审计记录（宿主、动作、幂等键、目标、Bot 身份、URL、失败阶段）。
- [ ] #790 回归：作者验证不是 Bot 时调用结果必须失败。
- [ ] 遍历全部宿主配置面的闸：少接一处就红；「扫完 0 条」和「没查成」分开。
- [ ] `node --test tests/issue-gateway.test.js tests/issue-gateway-check.test.js tests/dispatch-gate.test.js tests/marshal-issue-identity.test.js` 绿；`node scripts/dao-check.mjs` 新增身份链检查通过。

## 进展

- [x] 空提交撑分支并推送
- [ ] 网关 lib + CLI（允许列表、禁传身份/token/shell、幂等、回读作者、审计）
- [ ] dispatch-gate 拦裸 `gh issue` 写动作（Claude + Cursor 挂载面）
- [ ] 全宿主配置面闸（少接一处就红）
- [ ] 飞书 triage / 指挥官 / 关单 / 熔断开单 等写入点接网关
- [ ] 常驻指令与 skill 改指向网关（文字只作迁移护栏）
- [ ] 真实 GitHub 验收 + 负控
- [ ] 自查 / dao-check / handoff-check

## 体系类改动

1. 谁提的，发生在什么场景？用户在 MiraSim/Codex 主聊天发现 #790 作者是个人账号，要求从零收口身份链。
2. 删哪一层能让问题不存在？删除「AI 可以自由选择个人 gh 或 Bot 写入入口」这一层。
3. 如果从零重做，今天还会造它吗？会保留 GitHub App 三身份，但正确性从一开始就固化在写入网关和凭据边界，不寄托于某个宿主是否读到 skill。

## 设计阶段记录

本单 issue 正文已含体系类三问与验收判据，消歧评论（2026-09-06）判无岔路可派。豁免盲设计题：按 issue 正文施工，不另开设计岔路。

## 机制判定

#790 这类错在制度生效前还会再犯吗？**会**——规范只写在 Claude 专用 skill 时，别的宿主照样裸 `gh issue create`。机制改在：唯一写入网关 + hook 拦裸写 + 遍历全部宿主配置面的闸（少接一处就红）+ 后台服务不继承个人 token。文字提醒只作迁移护栏，不承重。
