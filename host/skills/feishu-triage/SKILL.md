---
name: feishu-triage
description: 飞书 triage 机器人的人格与规则（persona.md 是 deps.llm 的 system 段全文，issue #801）。块 A（scripts/feishu-triage.mjs）与块 B（scripts/lib/feishu-triage-core.mjs）工作时读；改人格/规则只改本目录。
---

# feishu-triage

飞书机器人消歧建单的人格与规则文件（Phase 2，issue #801）。

- `persona.md` —— 机器人人格与九条规则。**deps.llm 的 system 段 = 此文件全文**（消歧记录·补充 2），块 B 在模块装载时读入 `PERSONA` 常量。改这里 = 改机器人语气与行为边界。
- 判重、三问、建单、两档放行的逻辑在 `scripts/lib/feishu-triage-core.mjs`（纯函数 + 注入 deps，测试在 `tests/feishu-triage.test.js`）。
- #875：hub 意图层（问候不甩盘点）+ 群 profile（`host/machine/feishu-groups.json`）+ 待拍板卡片回传（`scripts/lib/feishu-hub-card.mjs`，测试 `tests/feishu-intent-card.test.js`）。

## 维护纪律

- 九条规则（先结论后细节 / 单子必带编号 / 回执说清落点 / 状态如实 / 追问一次问清 / 给操作给步骤 / 不越权 / 外人一致对待 / 一条回复 ≤ 8 行）不许删，只许改措辞；删规则要先改测试。
- 本目录只有文件，不跑常驻进程；常驻是块 A（systemd `feishu-triage.service`）的事。
