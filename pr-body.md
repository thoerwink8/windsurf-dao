## 目标

#682 微通道：几行改动 20 秒合完。做 `scripts/quick-fix.mjs` 原子脚本（一步完成 分支 → dao-worker[bot] commit → push → 非 draft PR → label → 异步 attach 异厂审官；任一步失败整体回滚并留痕），#679 同厂硬闸在微通道口照走（`--model` 必须显式声明，查不到 / 同厂拒绝起审官），dispatch SKILL 主会话红线加微通道唯一例外。

## 验收标准

- [x] `scripts/quick-fix.mjs` 存在且原子：一步完成 分支 → commit → push → PR → label → attach 审官；任一步失败整体退出并留痕（fail-visible），不留半成品分支
- [x] 审官 attach 的 #679 闸生效：主会话模型未声明 / 与审官同厂 / 模型查不到 → 非零退出
- [x] 人的操作 = 1 个命令 + 确认（实测计时写入 PR 正文）
- [x] 故意构造「几行改动」跑一遍，20 秒内产出 PR，审官异步起；构造「同厂审官」样本被当场拦
- [x] dispatch SKILL 红线处已改并注明例外；`node scripts/dao-check.mjs` 全绿（仅余既有 #711 账本断流红，本单未动）

## 进展

- [x] 开工：空提交撑分支 + draft PR
- [x] `scripts/lib/quick-fix.mjs` 纯函数层（闸计划 / 审官解析 / 分支名 / label / PR 正文 / issue 补标）
- [x] `scripts/quick-fix.mjs` CLI：preflight（分支碰撞预检 / master 前置）→ #679 闸 → 分支 → commit（dao-worker[bot]）→ push → 删本地分支 → PR → label → 异步 attach（壳卡 + 信箱台 Run + reviewer-attach + 冷启动重试）→ 失败整体回滚 + PR 留痕
- [x] dispatch SKILL 主会话红线加微通道例外
- [x] `scripts/lib/quick-fix-check.mjs` + dao-check 注册（㉕）+ 红/绿/空样本
- [x] `tests/quick-fix.test.js`（50 断言：纯函数三态 + CLI 故意同厂/缺 model/gh 失败/不一致 + 检查器判别力）
- [x] 实跑验收（issue #732 样本，见下方验收记录）
- [x] dao-check 全绿（仅余既有 #711）→ ready

### 实跑验收记录（issue #732，样本 PR #740）

- **同厂样本当场拦**：`quick-fix --dry-run --model grok-4.6 --reviewer grok-4.6` → exit 1 + 「同厂（grok），审查必须换厂商」。
- **20 秒内产出 PR**：`quick-fix --issue 732 --model devin-deepseek-v4-flash-max --reviewer gpt-5.6-sol --yes` → PR #740 落地 15.5s（脚本自测 14.8s），label 齐（model/devin-deepseek-v4-flash-max、type/微修、reviewer/gpt-5.6-sol）。
- **审官异步起**：attach 子进程建壳卡（挂在微修分支）→ 信箱台 Run（coordinator=常驻台）→ `reviewer-attach --skip-wait` → Codex 审官 dispatch `ctx_726074414ac8`，审官卡 PR-#740 审官·gpt-5.6-sol 在盘。日志 `~/.dao/quickfix/quickfix-732.log`。
- **原子回滚实测**：验收调试中多次中途失败（PR create 旗标 / 壳卡派生分支 / 审官 Run / codex 冷启动），每次失败均：删远端分支 / 关 PR / 删壳卡 / 回 master / 删本地分支，无半成品残留。
- **环境教训（写进 PR 给后人）**：codex TUI 冷启动注入会落在「model: loading」窗口导致 `agent_prompt_stalled`；本机实测与残留 codex 进程堆积强相关（全清后首启必成，堆叠后连败）。attach 子进程已做 5 次重试 + 30s 间隔兜底；根治需 orca/codex 侧（注入等 TUI 就绪）。

署名 issue #682，关单交给 `scripts/close-issues.mjs`。

体系类改动（改协作约定：主会话红线例外 + 新通道），合门 merge-policy: manual。
