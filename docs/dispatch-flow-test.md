# 派单链路实战验证记录

2026-08-26（#771，工人 devin-deepseek-v4-flash-max，审官 gpt-5.6-sol）

链路环节清单：

1. 建卡：dispatch 按 `--repo` 选择符定位 worker 卡 worktree，卡名由 `assembleCardName` 生成
2. 派工：`dao.mjs dispatch` 经哑终端 coordinator 起 `devin --model deepseek-v4-flash-max`，`terminal wait --for tui-idle` 就绪后 `worker-start` 注入任务书（#762 修复验证点）
3. 开工：工人读 soldier-book，git 身份确认 `dao-worker[bot]`，空提交撑分支并推送
4. 写码：新增本文件
5. 开 PR：`gh-as worker pr create --draft`，三段式正文（目标/验收标准/进展），打 `model/` 与 `type/` 标签
6. 自检：`node scripts/dao-check.mjs` + 测试套通过后 `pr ready`
7. 完工：`dao.mjs worker-done` 发完工 comment 并起审官
8. 审官 gpt-5.6-sol 评审通过后由帅合并归档
