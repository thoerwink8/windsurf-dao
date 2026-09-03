# 2026-09-03 AI 拍代码内一切，人只确认四样

拍板原文与默认配置在 issue #817。本页不复制会过期的配置值。

## 起因

用户 2026-09-03 拍板：代码里的决定（修不修、怎么修、何时进哪个版本）由 AI 拍；人只守四样确认。要把这条约定写成仓内决策，并给一份默认配置，将来看板后台读写那份文件。

## 拍板

- **AI 拍代码内的一切**（修不修、怎么修、何时进哪个版本）。
- **人只确认四样**：**对用户发布（minor/major）、花钱、删数据、改规则（协作约定 / 本策略文件 / model-routing）**。
- 大版本一个管理员确认即可。
- 临时模型策略（复看日 2026-09-13，grok 新模型发布后）：三环节各用各的模型，不是同一个。
  - **方案**：1–3 个模型**并行盲写**（默认三家：gpt-5.6-sol、deepseek-v4-flash、glm-5.2；小改动可只 1 家），然后**机器人整合**成一份 spec（整合者 = 指挥官/写码工人 grok-4.6，因为它接着写码，上下文连续）。这就是仓内 `design-exam` 盲平行设计技能的自动化版：由指挥官（#800）在派工前自动触发，不再等人叫。触发条件：issue 带 `type/体系` 或方案栏为空的写码单；`type/写码` 小修（fix/docs）跳过方案环节直接写码。
  - **代码**：grok-4.6。
  - **审核**：审官换厂商，主路 gpt-5.6-sol（Codex / pqapi）。**pqapi 不可用时降级到顺位 2 gpt-5.6-luna**（厂商 gw / pi，`gw-windsurf/gpt-5.6-luna`；credit 5 vs sol 50）。luna 属 GPT，与 grok 工人不同厂，厂商闸合规。DS 降为辅助。
  - **worker-done 前必须做一轮自查**（跑目标测试 + dao-check + 对照验收标准逐条打勾），审官只审自查之后的版本。
- 提需求两入口：飞书 @机器人 / 本地 Mirasim 侧；本地可直接修走 PR；PR 流程参照 #749 形态（结构化正文：目标/验收/进展/体系类必答/设计阶段）。**不加新机器人**：服务器指挥官（#800）+ dao-worker/dao-reviewer 身份即是。
- 分级确认 / 回滚 / 预算闸 全部由 `docs/release-policy.json` 驱动，将来看板后台管理读写该文件（改动走 PR，GitHub 唯一真相源）。
- 看板项目本身走本流程。
- 值守态（dao-mode standby）保留但不再是主形态。

## 边界

- 本单只落文件与检查；发布列车 / 确认闸 / 方案盲写自动触发的机制接入在 #800，这里不改脚本行为。
- 「改规则」含协作约定、本决策文档、`docs/release-policy.json`、`docs/model-routing.json`。
- 写码首选 grok-4.6 不动。审官主路仍 gpt-5.6-sol；顺位 2 只是 pqapi 不可用时的降级，本单不实现探活切换。方案/方案整合只登记选型，不在本单接指挥官。
- 配置值只认 `docs/release-policy.json`，改那份文件走 PR。选型顺位只认 `docs/model-routing.json`。

## 怎么验

不复制配置值。去这两处看当下是否还成立：

- `node --test tests/release-policy.test.js`（schema：四个顶层键、confirm 三级、bump 表、每项目 demo）
- `node scripts/dao-check.mjs` 的 release-policy 项（可解析且过 schema；红/绿/空夹具有判别力）

工人交卷前自查落在 `host/skills/dispatch/templates/soldier-book.md`「交卷前自查（必做）」。方案/方案整合/审官顺位去 `docs/model-routing.json` 看，不复制。

审官降级探活（#800 实现，本单不写代码）：指挥官派审官前先探 pqapi（一条 `max_tokens=5` 的请求，429/5xx 即用审官顺位 2）。顺位本身以 JSON 为准。
