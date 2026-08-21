# 2026-08-21 拍板：关单自动化从零重做——删赦免层，只留合后 per-PR

> 拍板记录。起因：grill-ai 复盘今日关单补丁链（#657 → #702 相对绿 → #703/#704 祖父条款），同目标连打三层；全量 sweep 误重开 58 个远古 issue。用户拍板：**都改成制度，删整层赦免，从零重来**。

## 第一性原理

关单自动化只做一件事：**某个 PR 刚合进 master 时，对它署名的那一张 issue 判一次——MERGED 且 check 全绿才关，否则不关、已关则重开。** 没查成 ≠ 绿。

它**不做**：扫全部历史 merged PR、用规则赦免基线红、用祖父线赦免无 check 时代。

## 为什么删相对绿 + 祖父条款

| 层 | 做法 | 所修副作用 | 判决 |
|---|---|---|---|
| 0 | #657 绝对绿 | — | **保留** |
| 1 | #702 相对绿 | 基线红时新 PR 永远关不了单 | **删**——基线红靠修 CI（#701 已做），不靠关单赦免 |
| 2 | #703/#704 祖父条款 | 全量 sweep 误重开远古单 | **删**——禁止 agent 跑全量 sweep；CI 前历史靠一次性人工清单 |

补丁已到第二层，再补「多 PR 聚合消抖动」是第三层——**禁止**。

## 新世界（制度）

### 1. 唯一生产入口

- **flow.mjs 合后钩**：PR MERGED 退役处理里 `closeIssueForPr({ pr })`，只判**这一张** PR。
- **人工单 PR**：`node scripts/close-issues.mjs --pr <N>`（运维/调试）。

### 2. 禁止全量 sweep（硬制度）

- `close-issues.mjs` 默认无参 / `--sweep`：**不得**在生产或 agent 会话里实跑改 issue 状态。
- 若保留 sweep：必须 `--dry-run` 默认，实跑要 `--i-know-what-im-doing` 且 PR/issue 留痕说明原因。
- **agent 红线**：未经用户当轮明确授权，禁止 `close-issues.mjs --sweep`（含实跑与 dry-run 以外任何批量扫 merged PR）。

### 3. 判定语义（回到 #657）

- MERGED + check 全绿 → `issue close`
- MERGED + check 红 / 无 check / 没查成 → `reopen`（若已关）或 `none`（若未关）
- 署名目标是 PR 号 / 不存在 → 跳过（#703 误中防护保留）
- **无**相对绿、**无**祖父豁免

### 4. CI 建立前的历史 issue

- 一次性人工关单清单（或用户拍板「留着开放当考古」），**不**写进自动化赦免。
- 清单落 issue 评论或本文件附录，做完即归档。

### 5. 基线红时的正确做法

- 修 CI / 修测试，让 master 转绿——不是改关单规则。
- 基线红期间合进的 PR：等 master 绿后由 `--pr N` 补关，或等下次同 issue 新 PR 合入时关。

## 体系类三问

1. **谁提的、什么场景？** 用户 grill-ai 拍板；全量 sweep 误伤 + 补丁链三层。
2. **删哪一层能让问题不存在？** 删「扫历史 merged PR」和「赦免层」——只留合后 per-PR，误重开和补丁链都无宿主。
3. **从零重做还会造吗？** 会造 #657 的 per-PR 关单 + flow 合后钩；不会造相对绿、祖父、sweep 实跑。

## 验收（实现 PR）

- [ ] `close-issue.mjs` 删 `grandfatherExempt` / `baselineRedChecks` / `relativeGreen` 及 `GRANDFATHER_NO_CHECK_BEFORE`
- [ ] `close-issues.mjs` sweep 实跑需显式 flag 或默认 dry-run；注释与 NEW-MACHINE 若有提及则同步
- [ ] `tests/close-issue.test.js` 对齐 #657 语义，删赦免相关用例
- [ ] `dao-check` 零新增红；PR CI 全绿
- [ ] flow 合后钩路径 smoke：mock PR 绿 → close；红 → reopen
- [ ] 不在本 PR 里实跑全量 sweep

## 附录：待人工审的真信号（不自动化关）

- #633（PR #634）：合并时 check 真 FAILURE
- #565（PR #566）：合并时 check 真 FAILURE
