# 目标

#807 块 2/3：删 Windows 本机信箱台 / 微通道 / 判定行协议。署名 issue #807，关单交给 `scripts/close-issues.mjs`。

父 PR：#857（任务分支 `ISSUE-807-工人-grok-4.6-步骤4-删-Windows-本机编排层-拆3块并行`）。本 PR 打到任务分支，不打 master。

# 验收标准

- [x] `scripts/inbox-station.mjs` 已删。实测：本机 `pgrep` inbox-station / watchdog / flow / guard-keepalive 全空；`_flow/inbox.lease` 不存在；服务器编排靠 systemd `orca-serve` + `dao-agent-stall.timer` + automations(land)。常开后中继不在跑 → 不需，可删。
- [x] `scripts/quick-fix.mjs` + `scripts/lib/quick-fix.mjs` + `tests/quick-fix.test.js` 已删；dispatch 主会话红线不再写微通道例外。检查器 `quick-fix-check.mjs` 留给块 C 的 dao-check。
- [x] 判定行协议从指挥官 / 校准 / 账本 / 审官任务书退役，改认 GitHub `APPROVED` / `CHANGES_REQUESTED`（`scripts/lib/review-state.mjs`）。`judgment.mjs` 暂留：块 A 的 flow/watchdog 仍 import，本块不改那两份文件。
- [x] 对应测试同 PR 删或改跟。本块相关套绿：commander / calibrate / archive-exec / ledger / dao / flow / completion-signal / guard-mirror / gh-as / dianjiangtai / shuai-scan / orphan-test。

# 进展

- 实测 inbox-station：服务器常开后进程/租约/systemd unit 都不在，结论=不需，已删。
- 删微通道脚本与测试；dispatch / pr-fast / NEW-MACHINE 去微通道入口。
- 指挥官、校准、账本、回填改 GitHub review 状态；审官任务书不再教判定行四种形态。
- dao.mjs 去掉对 inbox-station 的 import，租约路径内联，供 run-gc / retire 读历史文件。
