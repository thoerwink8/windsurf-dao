# 派工体系融合改造：拍板裁定书（2026-08-15，用户已拍）

> 本文件是融合改造落地单（PR #463）的施工规格真相源，由临时目录 pilot-B/_analysis/fusion-verdict.md 转入 git 持久化（材料三去处：拍板记录进仓内 docs/，不留在临时树）。配套分析材料：四路报告、pilot-data.md 实测数据均随 pilot-B 工作树流转，本单落地后以本文件为准。

四路独立分析（3×Opus：省钱/可靠/删繁 + grok-4.6 自由裁量）+ A/B/C 实测后，用户拍板「中线：双瘦身」。本文件是落地单的施工规格，与 _analysis/ 下其余材料（四路报告、pilot-data.md、现行源码）配合使用。

## 已定案共识（不再讨论）

1. 启动默认 `orca orchestration worker-start` 一条命令（--worktree new-top-level --agent <id> 等）；`worker_done` 有效即自动结账。
2. 例外分支收口：需特殊 argv 的（reclaude 链路、pi 指定非默认模型）走 `terminal create --command` → `worker-start --terminal <handle>` 收口；裸 `terminal create + dispatch --inject` 旁路封死（release 认不到，会回到误关终端旧事故）。grok 已通过 regrok shim（~/.local/bin/grok.cmd 覆盖 PATH，内置 HTTPS_PROXY + -m grok-4.6）变回普通 agent，`--agent grok` 直接可用（2026-08-15 三证验收：shim 命中第一位、服务端确认默认 4.6、裸起探针 13 秒闭环）。
3. 完工信号：`worker_done` 是触发器，GitHub 是裁决器——帅收到 worker_done 后必查该分支 PR 存在才收卷（#459 闷头写码防线）；反向（GitHub 有完工信号但没 worker_done）照常流转、记校准。
4. 等待方式：`check --wait` 挂 Monitor 后台（零 token），帅不前台阻塞。旧「check --wait 禁手」改写为「禁前台长等」。
5. 收尾：worker-start 起的工位一律 `worker-release`；合并后 `worktree rm` 仍归帅终审。
6. 模型拍板（issue #462）：pi 派单默认 deepseek-v4-flash（~/.pi/agent/settings.json 已手改，本单在 model-routing.toml 固化），ds-pro 仅限重型任务。

## 分歧裁定（用户拍「中线」）

- **flow.mjs 瘦身保留**：删「发现完工」职责（让位门铃），轮询间隔 90s→300s 降为备份通道；保留审读状态机、判定行解析、存量重放、待帅常驻行。敏感路径越权报警已从本单撤出（#463 收口：从自由中文判断「是否声明过」连错四层，另开单用 PR 模板 checkbox 重做）。
- **watchdog.mjs 瘦身**：删单发即唤醒的宽错误指纹（'Error:'、'terminated'、'Connection error' 类），指纹一律两连同才报警；`--exclude-pane` 从整体排除改为分级（豁免指纹判据，保留 exited/waiting 死活判据）；新增活证否决（报警前读 cursor，前进则降级为日志行不唤醒——审官屏面讨论误报的止血阀）；停摆判据修盲区：整屏哈希会被 TUI 计时器动画骗过（2026-08-15 grok 卡流 3 分钟实证），改用「输出 cursor 三轮不前进」为主判据。
- 保留不动：主会话红线、拓扑与命名、头工人、终审即校准（calibrate.mjs + judgment.mjs）、合并即归档、issue 卫生、审读闭环边界。

## 垫片退役清单（PR 正文必登记，合并时核对）

- 完工监听 v2（已退，flow 接替——本单后 flow 只做备份）
- flow.mjs 临时停用（实验期垫片，本单合并后以新参数重启）
- 编排信箱守门人 Monitor（会话级垫片，长期形态待 Orca 通知开关确认后再议，PR 正文记「暂保留」）
- pi defaultModel 手改（本单 model-routing.toml 固化后垫片使命完成）
- regrok shim 本机文件（本单 NEW-MACHINE.md 收录后转正）
