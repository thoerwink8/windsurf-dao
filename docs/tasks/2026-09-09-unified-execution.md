# 统一执行、额度与升级：任务清单

用户授权：2026-09-09，直接由主会话与子代理实现/验证，不依赖旧工人—审官派单链；旧仓规可按目标调整。保留 GitHub 前置任务清单、身份审计、代码与上线证据。Devin/Windsurf 按用户确认的共享额度池归集，实际计费来源另保留。

统领 Issue：[#1174](https://github.com/thoerwink8/windsurf-dao/issues/1174)。上位目标：#816 自动流水线、#818 看板与成本；承接 #1145 渠道容量、#1151 Mirasim 服务稳定性。历史任务不因本单启动自动关单，逐条以实证收口。

## 验收清单（只有证据成立才勾选）

- [x] T0 调研：原生 Grok/Cursor/Devin 可运行，三者 ACP 握手和创建会话成功；已有探针证据 `/tmp/mirasim-executor-study/`。
- [ ] T1 共用 ACP：Cursor/Devin 持久执行、读写工具、模型校验、进程回收、并发租约和跨命令读取；负责人 Kant。
  - [x] T1a Cursor 真实工作树闭环：worktree 里读文件→改文件→`git add`/`git commit`，两次 `session/request_permission` 全由 worktree 作用域自动放行（`answerSource: worktree_scope`），0 次人工回答，`stopReason: end_turn`，`cleanup.verified` 且 survivors 为空，产出真实提交 `ef26cf2`（data.txt +1 行）。模型经 `session/set_model` 校验为 `composer-2.5[fast=true]`。证据 `docs/evidence/1174-cursor-worktree-commit.json`。
  - [x] T1b Devin 真实工作树闭环：同一套 runtime 与放行判据，读→改→`git add`/`git commit`/`git rev-parse` 一次放行，0 次人工回答，`stopReason: end_turn`，cleanup 干净，产出真实提交 `2219daf`（notes.txt +1 行）。证据 `docs/evidence/1174-devin-worktree-commit.json`。
  - 放行判据只认「落在受管 worktree 内」：文件工具的每个路径 realpath 后必须在 workdir 内（符号链接外逃被拒）；命令按 `&&` 分段，每段要么是 `cd <workdir>`、要么命中 argv 前缀白名单，管道/重定向/后台/命令替换一律拒。三处厂商差异按实测补齐：Cursor 命令在 `toolCall.title`（反引号包裹，有时带 `cd <workdir> &&`）、提交信息用 `"$(cat <<'EOF' … EOF)"`（单引号 heredoc 不展开，故提升为字面量）；Devin 权限请求不带 kind/title/rawInput，用先前 `session/update` 记下的同 toolCallId 补 kind，命令取 `_meta['cognition.ai/editableCommand']`，`git -C <dir>` 的目录必须等于 workdir；shell 词按「相邻引号段拼接」解析（`--format="%H %s"` 是一个词，早先版本把它当解析错误而拒掉）。
  - [x] T1c Devin 钉模型：走仓内 `createAcpRuntime`，`requestedModel=model=validatedModel=deepseek-v4-flash-max`，`phase=done`，`error=null`，`stopReason=end_turn`。观测时刻 `2026-09-14T16:45:09.232Z`（UTC，会话 `acp:ce65fb6d-6b82-473c-8c78-5406b108afe3` / 后端 `tropical-hardhat`）。裸握手默认已是 `swe-2-high`（不是 2026-09-09 的 `swe-1-7-medium`），钉模型发生在握手之后。证据 `docs/evidence/1174-devin-acp-model-pinning.json`。profile `devin-acp-deepseek` 解封为 `available`。
  - [ ] T1 仍缺（不阻塞钉模型解封）：并发租约（同一 workdir 二次 startSession 被拒）与 `session/load` 跨命令续跑未单独验；`ensureGitWorkspace` 已补测试但未在真实派工链上跑过。
- [x] T2 Cursor 真问答：共用 MCP 真实问题→任务策略 JSON 回答→读随机文件→退出；注入工具精确权限自动放行，0 次人工回答，cleanup verified。证据 `docs/evidence/1174-cursor-question.json`。原生接口仍支持，当前 CLI 未开放的原生 AskQuestion 不冒充已验证。
- [ ] T3 统一用量：Mirasim/ACP/原生来源进入同一账本，增量/累计去重，共享额度池、unknown、估价/实扣分开；负责人 Maxwell。
- [ ] T4 Mirasim 周期升级：官方最新版发现、候选契约验证、在途排空、原子切换、故障回退；部署 orca 用户并验证定时器；负责人 Boyle。
- [ ] T5 扩展执行目录：模型、agent、后端、渠道、账户池、角色、成本分开；确认真实供应商模型列表及 DeepSeek V4.1 Flash 是否可用；负责人 Chandrasekhar。
- [ ] T6 指挥官接线：一套调度消费 Mirasim/ACP；首帧透传 local/cloud，完成判据不再要求 direct 必须有 relay 账本；负责人主会话。
  - [x] T6a 首帧透传 local/cloud：execution profile 命中时 `startSession` 带 `profileId`/`backend`/`route`；ACP 模型（composer-2.5）不得掉回 pi。无 profile 时 relay 腿 `route=cloud`、direct 腿 `route=local`。mirasim 第一帧 `prompt` 把 local/cloud 原样送出。证据：`scripts/lib/executor-binding.mjs` `wireExecutionRoute` / `resolveWorkerStartRoute`；`tests/executor-binding.test.js`「#1174 T6」；`tests/mirasim-runtime.test.js`「首帧透传 local / cloud」。
  - [x] T6b direct 完成不要求 relay 账本：`judgeCompletion` 在 `route=local|direct|native` 或 `backend=acp` 时快照 done + 无死因即 done；`route=cloud|relay` 仍要账本交叉核。#1121 死因仍优先。证据：`scripts/lib/mirasim-runtime.mjs` `completionSkipsRelayLedger`；`tests/mirasim-runtime.test.js`「direct/local/ACP 快照 done 不要求 relay 账本」。
- [ ] T7 直接渠道：实际模型请求不用旧 2核2G New API；Windsurf/OpenCode/CommandCode 优先性价比模型，有权限/协议/计费证据才启用；负责人主会话。
  - [x] T7a 周期探针/派前探默认不再对退役 newapi 发模型请求：`gw:` 池默认 skip（人工诊断 `--include-retired-gw`）；`planProbe(mirasim-relay)` 不拼 4317；sslip.io / `127.0.0.1:4317` 判退役。证据：`scripts/lib/retired-gateway-probe.mjs`、`tests/retired-gateway-probe.test.js`、`tests/provider-probe.test.js`。T7 顶层仍缺：Windsurf/OpenCode/CommandCode 有证据才启用；本机 `responses-chat-bridge` 仍在跑（不在本切片）。
- [ ] T8 自动交互：任务内已知答案自动回应、必要人工问题持久 waiting_user；等待不被当卡死重派，取消和恢复验证通过；负责人主会话。
  - [x] T8a 等待不被当卡死重派：`waiting_user` 进正典 `EXECUTION_WAITING`（不进终态）；`assessLiveness` 等十小时仍是 active；指挥官不停会话、不差集重派；租约按还在跑保留。证据：`tests/liveness.test.js`、`tests/commander.test.js`、`tests/session-reconcile.test.js`、`tests/lease-gc.test.js`。
  - [x] T8b 任务内已知答案自动回应：ACP 热路 `execution-runtime.startSession` 无显式策略时挂正典 worktree 默认策略（T1 放过的读/改 + git 前缀）；显式策略（含空规则）不合并；MCP 选择题不猜。证据：`scripts/lib/acp-interaction-policy.mjs`、`tests/acp-interaction-policy.test.js`、`tests/execution-runtime.test.js`。
  - [x] T8c 取消和恢复：ACP runtime 已有 cancel/resume；指挥官把 cancelled 当终态，不停会话、差集可再派短会话。证据：`tests/commander.test.js`「cancelled 会话 → 不停会话、同一张单可再派」、`tests/session-reconcile.test.js`、`tests/execution-runtime.test.js` resume。
- [ ] T9 真实容量：逐档运行多轮工具任务，记录成功数、耗时、实际模型/渠道、进程/请求/测试负载、用量；不照抄历史 2/3/4 上限；负责人主会话。
- [ ] T10 完整业务：至少一张真实 issue 由新机制产出可审 PR、完成独立验证与已授权合并；自动化运行观察无重复派工/假活，usage 可对账。
- [ ] T11 发布收口：代码提交/CI/PR、部署版本、定时器 NEXT、回退证据齐全；关联历史单逐条处置并同步本清单。

## 固定接口

统一 runtime：startSession / readSession / listSessions / interact / stopSession / waitForCompletion；执行后端为 mirasim 或 acp。ACP session 状态落 `~/.dao/execution/acp`；公共维护旗标 `~/.dao/execution/maintenance.json`；统一用量由 execution-usage 采集。

角色/模型选路只读 `docs/execution-profiles.json` 的显式配置及有时间戳的真实目录。任何后端不能独自决定加派、换收费性质或跳过独立验证。

## 代码落点与进度

- windsurf-dao：`codex/unified-execution-20260909` 独立 clone；ACP、统一 runtime、用量、目录、清单。
- ai-gateway-stack：`codex/mirasim-managed-upgrades` 独立 clone；周期升级、安装与回退。
- 当前：T1/T3/T4/T5 并行实现，主会话接入现有 runtime 并验证 T2。生产尚未切换。
- 2026-09-09 用户已在香港机安装专用公钥；SSH 读回通过，实时 9 条渠道已核对，原始配置安全存入服务用户私有目录。后续验证直连请求和余额归属，不把分组 key 当上游 key。

## 上线完成判据

不能以“代码已写”“进程活着”“HTTP 200”或“模型声称完成”勾选业务闭环；必须关联实际工具/工作树产物、正确 PR head、验证结果、真实账户路径和账本。故障实验保留拒绝/回退证据，未知字段必须可见。
