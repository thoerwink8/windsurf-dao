# 统一执行、额度与升级：任务清单

用户授权：2026-09-09，直接由主会话与子代理实现/验证，不依赖旧工人—审官派单链；旧仓规可按目标调整。保留 GitHub 前置任务清单、身份审计、代码与上线证据。Devin/Windsurf 按用户确认的共享额度池归集，实际计费来源另保留。

统领 Issue：[#1174](https://github.com/thoerwink8/windsurf-dao/issues/1174)。上位目标：#816 自动流水线、#818 看板与成本；承接 #1145 渠道容量、#1151 Mirasim 服务稳定性。历史任务不因本单启动自动关单，逐条以实证收口。

## 验收清单（只有证据成立才勾选）

- [x] T0 调研：原生 Grok/Cursor/Devin 可运行，三者 ACP 握手和创建会话成功；已有探针证据 `/tmp/mirasim-executor-study/`。
- [ ] T1 共用 ACP：Cursor/Devin 持久执行、读写工具、模型校验、进程回收、并发租约和跨命令读取；负责人 Kant。
  - [x] T1a Cursor 真实工作树闭环：worktree 里读文件→改文件→`git add`/`git commit`，两次 `session/request_permission` 全由 worktree 作用域自动放行（`answerSource: worktree_scope`），0 次人工回答，`stopReason: end_turn`，`cleanup.verified` 且 survivors 为空，产出真实提交 `ef26cf2`（data.txt +1 行）。模型经 `session/set_model` 校验为 `composer-2.5[fast=true]`。证据 `docs/evidence/1174-cursor-worktree-commit.json`。
  - [x] T1b Devin 真实工作树闭环：同一套 runtime 与放行判据，读→改→`git add`/`git commit`/`git rev-parse` 一次放行，0 次人工回答，`stopReason: end_turn`，cleanup 干净，产出真实提交 `2219daf`（notes.txt +1 行）。证据 `docs/evidence/1174-devin-worktree-commit.json`。
  - 放行判据只认「落在受管 worktree 内」：文件工具的每个路径 realpath 后必须在 workdir 内（符号链接外逃被拒）；命令按 `&&` 分段，每段要么是 `cd <workdir>`、要么命中 argv 前缀白名单，管道/重定向/后台/命令替换一律拒。三处厂商差异按实测补齐：Cursor 命令在 `toolCall.title`（反引号包裹，有时带 `cd <workdir> &&`）、提交信息用 `"$(cat <<'EOF' … EOF)"`（单引号 heredoc 不展开，故提升为字面量）；Devin 权限请求不带 kind/title/rawInput，用先前 `session/update` 记下的同 toolCallId 补 kind，命令取 `_meta['cognition.ai/editableCommand']`，`git -C <dir>` 的目录必须等于 workdir；shell 词按「相邻引号段拼接」解析（`--format="%H %s"` 是一个词，早先版本把它当解析错误而拒掉）。
  - [ ] T1c 仍缺：Devin 用的是 agent 默认模型 `swe-1-7-medium`，**`devin-acp-deepseek` 的 `deepseek-v4-flash-max` 钉模型这条路没验过**，profile 因此仍留 unverified；并发租约（同一 workdir 二次 startSession 被拒）与 `session/load` 跨命令续跑未单独验；`ensureGitWorkspace` 已补测试但未在真实派工链上跑过。
- [x] T2 Cursor 真问答：共用 MCP 真实问题→任务策略 JSON 回答→读随机文件→退出；注入工具精确权限自动放行，0 次人工回答，cleanup verified。证据 `docs/evidence/1174-cursor-question.json`。原生接口仍支持，当前 CLI 未开放的原生 AskQuestion 不冒充已验证。
- [ ] T3 统一用量：Mirasim/ACP/原生来源进入同一账本，增量/累计去重，共享额度池、unknown、估价/实扣分开；负责人 Maxwell。
- [ ] T4 Mirasim 周期升级：官方最新版发现、候选契约验证、在途排空、原子切换、故障回退；部署 orca 用户并验证定时器；负责人 Boyle。
- [ ] T5 扩展执行目录：模型、agent、后端、渠道、账户池、角色、成本分开；确认真实供应商模型列表及 DeepSeek V4.1 Flash 是否可用；负责人 Chandrasekhar。
- [ ] T6 指挥官接线：一套调度消费 Mirasim/ACP；首帧透传 local/cloud，完成判据不再要求 direct 必须有 relay 账本；负责人主会话。
- [ ] T7 直接渠道：实际模型请求不用旧 2核2G New API；Windsurf/OpenCode/CommandCode 优先性价比模型，有权限/协议/计费证据才启用；负责人主会话。
- [ ] T8 自动交互：任务内已知答案自动回应、必要人工问题持久 waiting_user；等待不被当卡死重派，取消和恢复验证通过；负责人主会话。
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
