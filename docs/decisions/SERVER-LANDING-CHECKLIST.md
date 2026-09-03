# 服务器落地清单（买到机器那天，从这里开始）

> 入口文档：用户说「服务器买好了 / 按原定计划走」时，先读本页，再按序读它点名的文档。
> 本页只排顺序与前置，不复制别处的内容（值会过期）。2026-09-01 建立。

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
| 4 | 删冻结件（五层判活链 / flow 常驻 / powershell 依赖等），用 systemd + automations 顶替 | `2026-08-24-...-from-zero.md` 的保留/删除清单；`2026-08-31-local-guards-retire-with-server.md` 恢复路径 | 故意 kill 进程后自动拉起的记录；被删机制的测试同 PR 删（孤儿测试闸会拦） | 待拍板，见 #807 |
| 5 | 选型收拢：渠道降级唯一归网关，仓内 JSON 只留职责层；价目改从网关用量取数 | `2026-08-31-land-check-slim-review-standard.md` §4 | `docs/model-routing.json` 无 pipes 层且 dao-check 绿 | 职责层收拢见 PR #830（价目/fx 另开单） |
| 6 | 群聊机器人 Phase 1→3（前置「审官质量标准」已于 2026-08-31 完成） | `2026-08-31-groupchat-triage-dispatch.md` | 按该文四阶段表逐阶段验收 | Phase 2 见 #801 |
| 7 | land 接上 automations（合并后自动清理） | `2026-08-31-land-check-slim-review-standard.md` §3 | 服务器上 automations 调 `node scripts/land.mjs`，与本机同一条命令 | |

## 两条不许绕的

- **不要 `git revert` 停派工态那个 commit**（dbfa323）来「恢复本机编排」——服务器落地走的是上面第 3 步，
  守卫用 systemd/automations 原生件重建；revert 只在「决定继续本机编排」时才用。
- **第 4 步删冻结件之前不要删 revert 路径**：先跑通第 3 步的端到端一单，再动删除。

## 在途挂账（落地时一并处理）

- PR #788（agent-first：worktree create --agent，OPEN）——编排回岗后审合，它的分支 land 会一直留着。
- `policy/models.yml` 的 fx / 价目字段自 2026-08-22 待补，第 5 步一并处理。

## 落地记录

全程指针：`2026-09-03-server-landing-night.md`（不在本页抄值）。

- 2026-09-02：机器到位（Contabo Cloud VPS 6，EU；中转站不搬，A/B 见 ai-gateway-stack DECISIONS §56）。无头六坑全文在 PR #796（当时未合）。
- 2026-09-03：第 1–3 步已达成——`kill -9` orca-serve 自动拉起（§9d / PR #796）；首单端到端 #797 / PR #798。第 4 步见 #807（待拍板）。第 6 步 Phase 2 见 #801。
