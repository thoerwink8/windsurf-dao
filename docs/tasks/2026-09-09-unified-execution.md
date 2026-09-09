# 统一执行、额度与升级：任务清单

用户授权：2026-09-09，直接由主会话与子代理实现/验证，不依赖旧工人—审官派单链；旧仓规可按目标调整。保留 GitHub 前置任务清单、身份审计、代码与上线证据。Devin/Windsurf 按用户确认的共享额度池归集，实际计费来源另保留。

统领 Issue：[#1174](https://github.com/thoerwink8/windsurf-dao/issues/1174)。上位目标：#816 自动流水线、#818 看板与成本；承接 #1145 渠道容量、#1151 Mirasim 服务稳定性。历史任务不因本单启动自动关单，逐条以实证收口。

## 验收清单（只有证据成立才勾选）

- [x] T0 调研：原生 Grok/Cursor/Devin 可运行，三者 ACP 握手和创建会话成功；已有探针证据 `/tmp/mirasim-executor-study/`。
- [ ] T1 共用 ACP：Cursor/Devin 持久执行、读写工具、模型校验、进程回收、并发租约和跨命令读取；负责人 Kant。
- [ ] T2 Cursor 真问答：出现结构化问题，自动回复任务书已有答案，回答后继续产物；计划批准/权限提示不吞、不假完成；负责人主会话。
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
- 尚有外部依赖：New API 实时全表与部分上游原始凭据需要合法管理入口；不把分组 key 当上游 key。

## 上线完成判据

不能以“代码已写”“进程活着”“HTTP 200”或“模型声称完成”勾选业务闭环；必须关联实际工具/工作树产物、正确 PR head、验证结果、真实账户路径和账本。故障实验保留拒绝/回退证据，未知字段必须可见。
