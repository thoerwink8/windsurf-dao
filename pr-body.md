## 目标

#682 微通道：几行改动 20 秒合完。做 `scripts/quick-fix.mjs` 原子脚本（一步完成 分支 → dao-worker[bot] commit → push → 非 draft PR → label → 异步 attach 异厂审官；任一步失败整体回滚并留痕），#679 同厂硬闸在微通道口照走（`--model` 必须显式声明，查不到 / 同厂拒绝起审官），dispatch SKILL 主会话红线加微通道唯一例外。

## 验收标准

- [ ] `scripts/quick-fix.mjs` 存在且原子：一步完成 分支 → commit → push → PR → label → attach 审官；任一步失败整体退出并留痕（fail-visible），不留半成品分支
- [ ] 审官 attach 的 #679 闸生效：主会话模型未声明 / 与审官同厂 / 模型查不到 → 非零退出
- [ ] 人的操作 = 1 个命令 + 确认（实测计时写入 PR 正文）
- [ ] 故意构造「几行改动」跑一遍，20 秒内产出 PR，审官异步起；构造「同厂审官」样本被当场拦
- [ ] dispatch SKILL 红线处已改并注明例外；`node scripts/dao-check.mjs` 全绿

## 进展

- [x] 开工：空提交撑分支 + draft PR（本页）
- [ ] `scripts/lib/quick-fix.mjs` 纯函数层（闸计划 / 审官解析 / 分支名 / label / PR 正文）
- [ ] `scripts/quick-fix.mjs` CLI（preflight → 闸 → 分支 → commit → push → PR → label → 壳卡 → 异步审官 → 回滚）
- [ ] dispatch SKILL 主会话红线加微通道例外
- [ ] `scripts/lib/quick-fix-check.mjs` + dao-check 注册 + 红/绿/空样本
- [ ] `tests/quick-fix.test.js`（纯函数 + CLI 故意同厂样本）
- [ ] 实跑验收：同厂样本被拦 + 真 quick-fix 20 秒产出 PR + 审官异步起
- [ ] dao-check 全绿 → ready

署名 issue #682，关单交给 `scripts/close-issues.mjs`。

体系类改动（改协作约定：主会话红线例外 + 新通道），合门 merge-policy: manual。
