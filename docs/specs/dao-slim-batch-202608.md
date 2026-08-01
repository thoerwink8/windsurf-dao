# dao.md 瘦身批 · 契约文档（2026-08-02 用户拍板「八项全批」）

> 拍板执行批，按 `ccswitch/rules/dao-change-batch.md` 八步铁序执行。
> 本文档是唯一契约真相源：派单令引用它，验收对照它，禁止凭会话记忆拼需求。

## 目标与原则

把 dao.md 中「非每轮必用」的内容按性质分流到四通道（hook 硬闸正文压缩 / 作用域档 / 存根 rules/ / 心跳载荷），
使 always-on 注入只付给每轮都要用的判断。**迁移不是删除：语义零丢失，只换投递通道**。
每笔迁移必须同笔配触发器，或在存根行诚实标注「纯文字兜底」——防的唯一真风险是投递缺口。

## 基线（①'后②'开工前采，2026-08-02）

- 预算闸：total=71379B / limit=71680B / headroom=301B（占 99.6%）
- 条款索引：sources=6 / clauses=27 / observation=0
- 批末目标：占用 ≤75%（≈53.8KB），八项预估合计约 -20KB
- 本批返工数/回滚数从 0 起记，作为下一批基线

## ⓪ 影响面速评（全批共性三行）

- 反向依赖：dao.md 被 `~/.claude/CLAUDE.md` @import 注入一切会话；`ccswitch/rules/*.md` 被存根行 Read 指向；`clause-index.json` 是派生物（改完必重新 gen）
- 守卫/配置源触及：#5 新增 nudge 触发器（提醒型非拦截型）；其余纯文档迁移，不碰 hook 判定逻辑、不碰配置源
- 可逆性：八项全部双向门（单 PR revert 完全恢复、无外部副作用）；「改 AI 行为规则」的单向门呈审已由用户逐项清单拍板完成

## 八项清单（定位用节名+条款名锚文本，不用行号——先合并的项会使行号漂移）

| # | 内容（dao.md 定位锚） | 去向 | 触发器 | 预估 |
|---|---|---|---|---|
| 1 | 帅节「长窗自主排程」下刻意留正文的四条：③.5 收官简报四铁律 / 长窗防停摆四层 / 在途水位线（含彻底解决三层） / ⑤自主边界 | 并入既有 `ccswitch/rules/dao-longwindow.md` | **心跳载荷**（新通道）：ScheduleWakeup prompt 模板固定携带「醒来第一动作 Read dao-longwindow.md §心跳节」；迁移前先读 `docs/evolution/incident-narratives-202607.md` N10 核对 compaction 连续性结论 | ~5KB |
| 2 | 知识归位节「工作项三态归位」整段（issue/看板/文件三态+hub+条件化） | 新建 `ccswitch/rules/dao-workitem.md` | 标记时刻=建单/建看板/立面板文件那一刻；dao.md 留一句判据（「关闭条件+owner→issue；聚合视图→看板；流水→文件」）+存根行 | ~3.5KB |
| 3 | 反·归节「立法与护栏准则」整段（编辑准则/谁来定规矩两档+否决项/立法必带基线数字） | 新建 `ccswitch/rules/dao-legislation.md` | 标记时刻=要立新条款/修条款那一刻；dao.md 留存根行 | ~3KB |
| 4 | 品节「心法六条+透镜库+运转时机+支柱工作法」细则 | 新建 `ccswitch/rules/dao-product.md` | 标记时刻=用户抛功能设想那一刻；dao.md 留「场景先行，有用为度」判据行+存根行 | ~2.5KB |
| 5 | 动·目·观「GUI 工具决策树」+「防断路规则」 | 新建 `ccswitch/rules/dao-gui-verify.md` | `dao-tool-nudge.js` 增 chrome-devtools/playwright 首调提醒（PostToolUse 既有模式）；dao.md 留决策树一行判据+存根行 | ~2KB |
| 6 | Shell 节「PR 合并期机械链」正文两段（三个不由脚本兜住的边界 + patch-id 三判据） | 并入 `ccswitch/scripts/dao-pr-merge.ps1` 头注（该处已是「唯一真相源」宣称地）或 rules 新档，官选定并说明理由 | 既有 dao-tool-nudge 裸手 merge 提醒已在；dao.md 留存根行 | ~2KB |
| 7 | 已出硬闸段落压缩：Shell 节「settings.json 运行时改动」「截图路径强制」、动节「windows-mcp 禁令」段 | 正文压至一行指针（硬闸 stderr 与 hook 头注已承载全文） | 硬闸本身就是触发器（拦截时 stderr 给全文） | ~1.5KB |
| 8 | 帅节「判定 subagent 越权之前先 Grep」整条 | 并入既有 `ccswitch/rules/dao-dispatch.md` | 派单契约门存根已含「写派单令前 Read」；越权判定发生在多 agent 场景，dispatch 是最近必经点；dao.md 留一句「判越权先 Grep 官自己的记录，细则见 dispatch」 | ~1KB |

## 验收判据（冻结，每项 PR 全过才合）

1. dao.md 对应段替换为存根行：格式对齐既有五个存根（**必经动作 = Read <路径> 全文** + 判据一句话 + 触发器说明/纯文字兜底声明 + 原有元字段保留）
2. 正文完整迁入目标文件：语义零丢失（迁移 diff 中删除的每句话必须在新文件 diff 中出现或有等价表述；纯搬动优先，改写需在 PR body 说明）
3. `node ccswitch/scripts/check-alwayson-budget.mjs` exit 0 且 total 较上一项合并后下降
4. `node ccswitch/scripts/gen-clause-index.mjs --check` exit 0（迁移后条款归属文件变化属预期，clause-index 同 PR 重新生成提交）
5. `node scripts/run-tests.mjs` 全套真退出码全绿
6. **锚先破再验**（每项至少一次）：把该项存根行指向的路径故意改错 → 交叉引用检查（dao-smoke 或补充的存根路径存在性检查）变红 → 复原变绿；若现有检查器不覆盖「存根指向文件必须存在」，第一个做到该情形的官补一个最小检查并入 run-tests 扫描面
7. 一项 = 一 PR，止步 `gh pr create`，merge 归指挥官（走 `ccswitch/scripts/dao-pr-merge.ps1`，含合并态门）

## 回退判据（冻结）

- 投递缺口实证：任一会话在「该用条款的时刻」拿不到正文（存根路径断/触发器没响）→ revert 该项 PR，回到 always-on
- 批末预算闸 >75% → 审视未迁干净项，不追加新项救数字
- #1 特别条款：N10 结论不足以支撑 compaction 后心跳载荷连续性时，#1 只做正文迁移+心跳模板挂载，连续性验证**带解冻条件挂账**（下一个长窗实测第一轮 compaction 后条款可达性），不许「随后补」

## 拆分与合并次序

- **波 1 并行两官**（多将拆分三判据：dao.md 为共享触点但各官改动落在不同节，段落远离；真冲突留指挥官合并时统一解，属预期非事故）：
  - 官 A：#2 → #3 → #4（知识归位节 / 反·归节 / 品节），官内串行，每项一 PR
  - 官 B：#5 → #6 → #7 → #8（动节 / Shell 节 / 帅节），官内串行，每项一 PR
- **波 2 单官**：#1（帅节最大单笔+新通道判断），在波 1 全部合并后基于最新 master 开工
- worktree 隔离：官 A `../windsurf-dao-wt-slim-a`，官 B `../windsurf-dao-wt-slim-b`，波 2 `../windsurf-dao-wt-slim-c`；已存在的 `../windsurf-dao-wt-50`（#50 实现官）文件面不相交，互不干扰
- 真 revert 演练（③'）：批末由指挥官抽一项 revert → 该项锚变红 → 恢复，记录进批账

## 显式不覆盖

- 不动 hook 拦截判定逻辑（G1-G5 的 matcher/判定不改，#5 只加提醒型 nudge）
- 不动 `~/.claude/` 任何 live 文件（部署走 symlink 自动生效，无需重部署）
- 不改条款语义、不删条款、不做「顺手打磨」——瘦身批只搬家；发现的语义问题记 TODO.md 不夹带
- 不动 mousse-cli 仓
- #1 的 compaction 连续性长窗实测不在本批（挂账带解冻条件）

## 记账

每项 PR 合并后在本文件底部「批账」节追加一行：项号 / PR / 合并后 total / 返工数。
批末：⑤浸泡（下一窗把本批列为复审强制靶）+ 收官简报报预算前后对照。

## 批账

波 1 七项全部合并（2026-08-02），基线 **71379 → 62305 B（-9074，占用 99.6% → 86.9%）**，主干批末全量：22 套 node 测试 1247 断言全绿 / 预算闸 exit 0 / clause-index --check 无漂移（10 源 27 条款）/ dao-smoke 过 / 5 硬闸注册正常。

| 项 | PR | 结果 |
|---|---|---|
| #2 工作项三态 | #52 MERGED | 官 A 实测合并后 68779 B |
| #3 立法准则 + #4 品节 | #62 MERGED（承载被级联关闭的 #53 与错向合并的 #55） | 64250 B |
| #5 GUI 决策树 | #54 MERGED（含 clause-parser 双链冲突统一解） | — |
| #6 PR 合并链头注 | #59 MERGED | — |
| #7 硬闸段压缩 | #60 MERGED | — |
| #8 越权 Grep 迁 dispatch | #61 MERGED | 终态 62305 B |

**返工记录（下一批基线）**：
- 级联事故 1 起：`gh pr merge --delete-branch` 删掉叠放链 base 分支时，GitHub **直接 close 下游 PR（不 retarget）**，且 closed 后不能 reopen（base 已不存在）也不能改 base；#55 随后被合进自己的 base 分支而非 master。修复=承载 PR #62。**防复发做法已在官 B 链验证**：合并叠放链每级前先 `gh pr edit <下游> --base master` 再合上游，#54→#59→#60→#61 零级联损失。
- 派生物冲突 3 次（#59/#60/#61 的 clause-index.json，每链每项都重新生成过，两链必两两冲突）：机械解=merge 后重新 gen 覆盖。**下一批预案**：叠放链上派生物不逐项提交、批末一次生成，或接受机械解成本。
- `--delete-branch` 沉默失败第 3 次实证（#61 分支残留，补 `git push origin --delete`）。
- mergeability 缓存：push 冲突解后立即 merge 会吃 UNKNOWN 态失败，隔一拍重试即过。

**真 revert 演练（③'）**：抽 #52 在临时树 revert —— 产生冲突（已被 #62 叠加），锚有判别力（冲突态树 20 过 1 红），恢复 `revert --abort` 干净。结论实测确认③'判据：**已被后续叠加的项回退用前滚，不硬 revert**。

**预估口径校准**：官 B 四项实收 -1945 B，远低于预估 ~6.5KB——存根行本身有固定成本（必经动作+判据句+射程声明），#5 还付了投递缺口声明。后续预估按「原文 − 存根成本(每条 400-700B)」计。

**波 2（#1 长窗四条+心跳载荷）**：N10 预研结论——①compaction 是否清 armed 心跳未知（诚实边界维持），连续性验证挂账带解冻条件（下一个长窗实测第一轮 compaction 后条款可达性）；②N11 槽位档证据（[cc] 719/719）支持心跳 prompt 载荷通道；③自指风险（心跳纪律自身在被迁四条里）的解法=判据句压缩留守 dao.md 存根行，细则迁移。

**波 2 完成（2026-08-02）**：#1 = PR #66 MERGED，**批终态 59009 B（占用 82.3%，headroom 12671）**，八项全批累计 **-12370 B（99.6% → 82.3%）**。四条判据句留守自足性帅逐句核过；hook 三处指针文字同步裁为合规（引用面同批更新强制项，matcher/判定零动）；官漏的 PowerShell 套帅补跑（clause-structure 68/68 绿）。compaction 连续性挂账 = TODO.md `LW-1`（owner=下一个开长窗的人，两态都要写回）。⑤浸泡：下一窗把本批八项列为复审强制靶——重点抽「该用条款的时刻拿不拿得到正文」（存根投递缺口是本批唯一真风险）。
