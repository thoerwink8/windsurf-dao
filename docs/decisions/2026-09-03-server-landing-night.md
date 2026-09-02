# 2026-09-03 夜班：服务器编排回岗 + 飞书 Phase 2

> 全程记录。**只写去哪查，不复制会过期的值**（IP、chat_id、open_id、app_id、令牌、env）。
> 用户拍板原话与验收清单在 issue #811。本页是指针索引，不是第二份正文。

## 谁提的，什么场景

用户 2026-09-03 03:45（#811 原话）：今晚把服务器编排回岗、飞书机器人接上了，这些信息和有价值的过程要存进项目，以后建整条流程都要有记录。

方向前提：`2026-08-24-linux-server-runtime-from-zero.md`（运行时搬 Linux）→ `2026-08-31-orchestration-linux-only-no-local-worktree.md`（本机不编排）→ `SERVER-LANDING-CHECKLIST.md`（落地顺序）。本机停派工见 `2026-08-31-local-guards-retire-with-server.md`。

## 当晚时间线（按落点）

| 事 | 去哪查 |
|---|---|
| 机器到位、A/B、无头六坑 | PR #796（当时 OPEN draft）；清单第 1 步 |
| 首单闭环（deepseek 走自建网关） | #797 / PR #798（已合） |
| 审官跳断链 + merge-policy 不继承 | #799 / PR #804（已合） |
| `start=agent` 落裸 shell（handle 指错） | #802 / PR #805（当时 OPEN） |
| 飞书 Phase 2（消歧/块 A/块 B/接线） | #801 / PR #803（已合）/ PR #806（当时待合） |
| 指挥官 + 发布列车 | #800（过夜复看，未开工） |
| 步骤 4 删 Windows 编排层 | #807（待拍板） |
| 运维 skill 收整 | #808 / PR #809（已合；`server-ops` / `feishu-ops`） |
| 本记录 | #811 / 本文件 |

## 服务器：选型与 A/B

- 编排机：Contabo Cloud VPS 6（EU）。**中转站不搬**——A/B 结论是网关慢在上游不在机房。
- 去哪查：PR #796 落地记录；网关侧细节在 **ai-gateway-stack DECISIONS §56** 与 memory（本仓 INDEX 把 `~/.config/ai-gateway` / `~/.mirasim` 标 E 类，**本仓不写装法、不写值**）。
- 无头装机步骤与验收：`NEW-MACHINE.md` §9d。

## orca 无头装机六坑

全文在 PR #796 对 `NEW-MACHINE.md` §9d「坑」的补丁（当时未合）。本树 §9d 只点名三条，不抄命令、包名、env 路径：

1. systemd drop-in 注入 agent 的网关 env 与 PATH。
2. Claude Code 信任框：`~/.claude.json` 的 `projects` 预置工位树父目录（`IS_SANDBOX=1` 这版不认）。
3. Orca 终端不吃 login shell 的 `~/.profile` / `~/.bashrc`。

日常改 drop-in / 探活：`host/skills/server-ops/SKILL.md`。

## 首单闭环时间账（#797 / PR #798）

数字的权威出处是 **#811 正文**（当晚实测，不是会漂的 SLA）：

- 派工 14s / 写码 13min / 审 6min / 端到端 ~20min / 编排开销 ~2min
- CLI 冷启动 1.3–3.1s ⇒ **不预热、靠并发**

可对的 GitHub 时间戳：PR #798 `createdAt` 16:51Z → `mergedAt` 17:05Z（审官判定绿见该 PR 的 review）。

清单第 3 步判据（一单端到端：卡 → PR → 审官判绿 → 合并）由此达成。

## 六条工人通道怎么接的

只记接法类型，不写密钥、URL、账号。

| CLI | 接法 | 去哪查 |
|---|---|---|
| claude | 网关 env drop-in（agent 继承服务环境；人开的壳不继承） | PR #796；`server-ops`；INDEX E 类 |
| codex | pqapi | 本仓不写第三方 URL；无头登录见 §9d「无头机上的交互式登录」 |
| pi | 自建网关（七组） | ai-gateway-stack DECISIONS §56；仓内通道 #797 / PR #798、`docs/cli-notes/pi.md` |
| grok | 令牌拷贝到服务器 | INDEX C 类；`docs/cli-notes/grok.md` |
| cursor | 浏览器登录 | §9d 无头登录（device-code vs localhost-callback） |
| devin | 浏览器登录 | 同上；无头 `start=agent` 坑见 #802 |

## 两个洞与修法

1. **#799 / PR #804（已合）**：`worker-done` 因士兵 dispatch 已结算而整跳失败；`reviewer-attach` 不继承 `merge-policy`，#798 按默认 auto 自合。修法与测试在 PR #804。
2. **#802 / PR #805（当时 OPEN）**：无头 Linux 上 `worker-start --agent` 把 agent 起在另一张终端，记账 `workerHandle` 却指向 worktree 空壳，任务书打进 bash。真因与修法在 issue #802 / PR #805（按 `agentIdentity` 校准 handle；没有目标 agent 才回退 `--command`）。帅当晚的「先送 launch 再注入」是垫片，**PR #805 合并时退役**。

## 拍板三件（当晚只落文字或施工，状态不同）

| 单 | 拍了什么 | 状态 |
|---|---|---|
| #800 | 服务器指挥官 + 发布列车：合并进列车、攒够再切版本、大小版本按提交类型 | **过夜复看**，未写代码（8-24 S4 过夜闸） |
| #801 | 飞书 Phase 2：一机器人两角色、话题内消歧、两档放行、主动汇报四段式；后改普通群聊模式 | 块 B PR #803 已合；块 A PR #806 当时待合；接线见下 |
| #807 | 步骤 4 删 Windows 本机编排层 | **待拍板**（不可逆，过夜闸） |

主动汇报四段式原文在 #801 消歧补充 4：**要做什么 / 为什么（依据规则或信号）/ 影响哪张单 / 下一步等什么**。只在状态迁移时发，不发心跳。实现归 #800，本页不抄。

一机器人两角色：#801 消歧补充 3——同一个应用、同一条长连接、同一个进程；角色由群映射表 `kind`（`project` / `hub`）决定。

## 飞书接线路径（可复现，值在评论里）

命令序列（#811 正文；身份与坑见 `docs/cli-notes/feishu.md`）：

```bash
npm i -g @larksuite/cli
lark-cli config init --new          # 浏览器授权，自动建应用、配长连接与事件
lark-cli auth login --recommend     # 用户身份
lark-cli auth list                  # 取 open_id（本页不抄）
lark-cli im +chat-create --chat-mode group --users <ou_> --set-bot-manager
```

- **实况接线**（应用名、当时 chat_id、映射落点、凭据文件形状）：#801「实况接线记录」评论。chat_id 已换过一次（话题群 → 普通群），**本页不抄**。
- 映射表仓内形状：随 PR #806 入仓（本树未合入）；日常加一行见 `feishu-ops`。
- 凭据：INDEX E 类 `~/.mirasim/keys`（归 ai-gateway-stack），不进 git。
- 适配器长连接：node-sdk 独立 `WSClient` + `EventDispatcher`（#801 块 A / PR #806）。备选事件源：`lark-cli event consume im.message.receive_v1`（secret 不出 CLI），见 cli-notes。

踩坑摘要（细节只在 cli-notes）：

- 话题群 ≠ Discord 式线性群 → 已改 `--chat-mode group`，追问走回复串。
- `im:chat:delete` 未开通，旧话题群解散不了。
- `send_as_user` 未开通，用户身份发不了消息（接线用 `--as bot`）。

## issue 大清理

2026-09-03 值守态审查关了一批。**判据在各单最后一条帅关单评论**，本页只记三类依据，不把名单当第二真相源。

| 依据 | 意思 | 代表 |
|---|---|---|
| 8-24 运行时搬迁 | Windows 保活/看门狗/flow 层缺陷改为整层删除，不再修补 | #361 #348 #336 #743；伞单 #807。关单评论当时误写伞单 #805（那是 agent handle 的修），以 #807 为准 |
| 8-14 规则层退役 | `ccswitch/` 已不在仓内，改动无落点 | #417 #413 #412 #409 #408 #405 #332 #292 #284 #275 #266 |
| Windows 本机层 | pwsh / doctor / config-sync / roster 不再是承重面 | #387 #385 #381 #376 #366 #344 #338 |

当晚关了 **34** 张。复算命令：`gh issue list --state closed --search 'closed:>=2026-09-02'`（含 #797/#799/#801 完工关单）。#811 初稿写「37 张」是估数，已纠正；不以仍 OPEN 的单补差。名单不在本页复述，三类依据见上表与各单关单评论。

另有「已做 / 过期 / 并入」类（#565 #325 #340 #304 #360 #350 #324 #314），依据写在各自关单评论。

## 清单状态

见 `SERVER-LANDING-CHECKLIST.md`：第 1–3 步已达成（2026-09-03，#797/#798）；第 4 步 → #807；第 6 步 Phase 2 → #801。
