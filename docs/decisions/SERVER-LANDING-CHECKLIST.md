# 服务器落地清单（买到机器那天，从这里开始）

> 入口文档：用户说「服务器买好了 / 按原定计划走」时，先读本页，再按序读它点名的文档。
> 本页只排顺序与前置，不复制别处的内容（值会过期）。2026-09-01 建立。
>
> **执行方针（用户 2026-09-04 拍板）**：落地期一切**清单驱动 + 特事特办**——本页与
> ai-gateway-stack 的对应清单是唯一进度真相源；卡点当场由主会话/子代理闭环（写码→PR→审官照审），
> **不走派单链**，每次拍板即回写本页。直到整套流程（派工链/指挥官/审官/探针熔断）连续正常运转，
> 才回归全面走工人+审官派工流程。见记忆 fast-track-before-institutions-stabilize。
>
> **全权托管（用户 2026-09-04 01:50 拍板）**：用户不再逐项拍板，AI 把本清单全部做完。规则三条：
> ①凡阻碍主流程的，AI 当场自己改掉，不走派单；②「全流程」包括飞书机器人——机器人必须说人话、
> 运转流畅，AI 要像用户一样去读群消息、去验证；③等 AI 自判派单流程已完善、此前反馈全解决、
> 主流程通顺，才用一轮真实派单做验证收尾。每完成一段，向用户交一份三行摘要（干到哪、要决定什么、推荐哪个）。

## 用户只需要给三样

1. 服务器能连上的方式（IP / 主机名 + SSH 或 Tailscale，哪种都行）。
2. 谁有 ✅ 放行权（仅本人，还是指定伙伴也可）——Phase 2 才用，先记着。
3. 客户/伙伴主要在哪个平台（微信/飞书/Discord）——Phase 2 选首发渠道用。

其余不用交代：规格、装法、防火墙、systemd、验收标准都已写死在下面的文档里。
（若机器还没买：规格与已实测的支持面见 `../../NEW-MACHINE.md` §9d 开头。）

## 顺序（每步做完才进下一步）

| # | 做什么 | 照哪份文档 | 做完的判据 | 状态 |
|---|---|---|---|---|
| 0 | 对齐方向：为什么编排只在 Linux、本机为什么不编排 | `2026-08-31-orchestration-linux-only-no-local-worktree.md` → `2026-08-24-linux-server-runtime-from-zero.md` | 能说清「本机留 clone 但不起工位树」 | 已对齐 |
| 1 | 起 orca 无头运行时（AppImage + Xvfb + systemd + 防火墙） | `NEW-MACHINE.md` §9d（每条都在 Ubuntu 24.04 真跑过） | `orca serve --port 6768` 由 systemd 拉起；kill 后自动回来 | 已达成（2026-09-03，#797/#798） |
| 2 | 服务器上装本仓 + 接线 + 凭据 | `NEW-MACHINE.md`（`git clone` + `node scripts/onboard.mjs`；凭据手动带，onboard 不碰） | `node scripts/dao-check.mjs --full` 绿 | 已达成（2026-09-03，#797/#798） |
| 3 | 编排回岗：`--full` 设为常态；派工/审官流程整体恢复 | `host/skills/dispatch/SKILL.md`「编排态工作法」+ `host/skills/dispatch/review-standard.md` | 一单端到端：卡 → PR → 审官判绿 → 合并 | 已达成（2026-09-03，#797/#798） |
| 4 | 删冻结件（五层判活链 / flow 常驻 / powershell 依赖等），用 systemd + automations 顶替 | `2026-08-24-...-from-zero.md` 的保留/删除清单；`2026-08-31-local-guards-retire-with-server.md` 恢复路径 | 故意 kill 进程后自动拉起的记录；被删机制的测试同 PR 删（孤儿测试闸会拦） | 已消歧（#807）；前置 #833/PR#834 已合（2026-09-03），待拆块派 |
| 5 | 选型收拢：渠道降级唯一归网关，仓内 JSON 只留职责层；价目改从网关用量取数 | `2026-08-31-land-check-slim-review-standard.md` §4 | `docs/model-routing.json` 无 pipes 层且 dao-check 绿 | 已达成（PR #830 合并 2026-09-03）；价目/fx 另开单待拍 |
| 6 | 群聊机器人 Phase 1→3（前置「审官质量标准」已于 2026-08-31 完成） | `2026-08-31-groupchat-triage-dispatch.md` | 按该文四阶段表逐阶段验收 | Phase 2 见 #801；Phase 3 待用户拍 |
| 7 | land 接上 automations（合并后自动清理） | `2026-08-31-land-check-slim-review-standard.md` §3 | 服务器上 automations 调 `node scripts/land.mjs`，与本机同一条命令 | 已达成（PR #832 合并 2026-09-03） |
| 8 | 在途 PR 清零 + 指挥官派单闸重开 | #849/PR#850、#843/PR#851、#852/PR#854、#807/PR#857 | 四张合并；watch-loop 垫片退役。**派单闸（commander-act）不在这步开**——dry-run 实测一开就派 2 单+给 9 张旧单刷 9 条待拍板，留到第 10 步 | 进行中（2026-09-04）：PR#850 已合（8659c1e） |
| 9 | 机器人说人话 + 总控群能问「现状」 | `2026-08-31-groupchat-triage-dispatch.md` + 本页「说人话判据」 | 群里每条消息用户不查文档能看懂；在群里问「现状怎么样」30 秒内得到三行摘要 | 进行中（2026-09-04） |
| 10 | 派单流程验证收尾 | `host/skills/dispatch/SKILL.md` | 一单真实派工：卡 → 工人 → PR → 审官判绿 → land 合并，全程无人工干预 | 待 8、9 完成 |

### 说人话判据（第 9 步用，用户 2026-09-04 原话：「飞书机器人说黑话，并且运转不流畅」）

- 每条群消息三行以内：出了什么事 / 对我有什么影响 / 我打算怎么办（要不要你拍）。
- 不出现 pid、cwd、comm、timer、enabled、systemctl、路径、命令行、issue 编号以外的代号；修法一律放在「怎么修」行，不在正文。
- 同一轮盘点的多条发现合成一条发，不刷屏。
- 判断口诀：这个词用户自己说过吗？没有就换成日常说法。

## 两条不许绕的

- **不要 `git revert` 停派工态那个 commit**（dbfa323）来「恢复本机编排」——服务器落地走的是上面第 3 步，
  守卫用 systemd/automations 原生件重建；revert 只在「决定继续本机编排」时才用。
- **第 4 步删冻结件之前不要删 revert 路径**：先跑通第 3 步的端到端一单，再动删除。

## 在途挂账（落地时一并处理）

- PR #788（agent-first：worktree create --agent，OPEN）——编排回岗后审合，它的分支 land 会一直留着。
- `policy/models.yml` 的 fx / 价目字段自 2026-08-22 待补，第 5 步一并处理。

## 落地记录

全程指针：`2026-09-03-server-landing-night.md`（不在本页抄值）。

- 2026-09-02：机器到位（Contabo Cloud VPS 6，6C/12G/200G，EU 机房，ssh 别名 `contabo`；中转站不搬，A/B 见 ai-gateway-stack DECISIONS §56）。无头六坑全文在 PR #796（当时未合）。
- 2026-09-03：第 1–3 步已达成——`kill -9` orca-serve 自动拉起（§9d / PR #796）；首单端到端 #797 / PR #798。第 4 步见 #807（待拍板）。第 6 步 Phase 2 见 #801。
- 2026-09-03 晚：第 5、7 步达成（PR #830 / #832）。同晚服务器新增运行时件（本页只留指针）：
  - 撞限流探测进 systemd：`dao-agent-stall.timer`，15 分钟一轮 + 自动换人（#833 / PR #834；垫片已退役）。
  - 服务器指挥官（眼睛常驻、大脑按需醒）+ 发布列车（#800，PR #840 / #838）。指挥官 scan/inventory timer 在跑；
    **act 派单闸首轮实咬三洞后停用中**（单轮无上限、过时 model 标签照派、并发建树撞锁），修复 #849 / PR #850，合并后重开。
  - 派前探一针 + F15 接健康表（#842 / PR #845）；健康表由 ai-gateway-stack 探针写（其 DECISIONS §66）。
  - 编排层熔断 provider 级 cooldown（#843 / PR #851）；与网关侧熔断的边界见 ai-gateway-stack DECISIONS §67。
  - 审官首选临时切 gpt-5.6-luna（PR #844，pqapi 故障过渡；切回条件=#843 上线且 pqapi 恢复后再拍）。
