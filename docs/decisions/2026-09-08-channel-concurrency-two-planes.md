# 2026-09-08 渠道并发两平面：请求级归网关，会话级归指挥官，看板只做控制面

用户 2026-09-08 拍板（起因链 `channel-concurrency`）。本文是拍板档案与数据底稿，口径以
当日 06:11 最终拍板为准（中间评论里的 windsurf=4、opencode 立即禁用已作废）。
实现三件套（上限 / 顺位分流 / 熔断）与病腿贴标的代码验收在实现单，不在本文档 PR。
网关侧同日更新：`thoerwink8/ai-gateway-stack@a55e9c45822100ec23bbc92c2d185ee69a03c650`
（[ROUTING 并发两口径与调度边界](https://github.com/thoerwink8/ai-gateway-stack/blob/a55e9c45822100ec23bbc92c2d185ee69a03c650/docs/ROUTING.md)）。

## 拍板内容

1. **两平面分工（不搬降级池）**：请求级降级留在网关（组=降级池，优先级逐级降，new-api 现状即正确形）；
   会话级调度（每腿会话上限、满员按顺位分流、429/中继死熔断退避）做在指挥官循环；
   看板后台只做控制面（看在途/改上限/停腿），**调度逻辑不进 web 后台**——web 挂了不能挡派工。
2. **上限是「会话级」数字**，填路由表「腿」节 `并发上限` 字段（外部账号事实，人填/实测填，
   与「机器余量不许填死数」不冲突——那条管的是机器容量）。
3. **渠道生命周期**：
   - opencode / commandcode 均标「到期不续」。
   - **opencode 到期前保留为溢流腿**：不立即禁用、不拒绝新会话；主腿满员或熔断时当补位，到期自然死（不续费）。
   - commandcode 不作溢流，填 0 / 到期。
   - Windsurf 换账号 = 多号并行成多条腿（keys/ 现读天然支持轮换）。
4. **扩展目标**：换大 VPS 后同时几十个 issue（跨项目）。腿是活的集合，加腿删腿改数零代码；
   机器闸保持比例式（0.85×核数）；总并发 = min(负载准入, Σ在役腿会话上限, 网关机吞吐)。
5. **病腿自动识别 / 贴标 / 摘标**（06:11 新增，实现验收挂实现单）：
   - 已知死因（quota / payment / expired / 401 / 403 等）→ 按类别标腿（`到期` / `欠费` / `鉴权失效`），调度跳过并报总控群；
   - 未知死因不靠指纹全集（判例：whitelist-fingerprints-cannot-find-unseen-failures）：同腿连败过阈值即判通用「病腿」，不猜错误长什么样；
   - 死因样本两处采：gw-remote-probe（请求级）+ 会话死因（execDispatch / 审官会话 error 字段）；
   - 恢复：探针转绿 N 轮自动摘标；到期类除外，摘标要人。

## 三道天花板（谁先到顶谁说了算）

| 天花板 | 现值（2026-09-08） | 怎么扩 |
|---|---|---|
| 编排机负载准入 | 0.85×6 核 ≈ 7-9 个活跃会话 | 换大 VPS，比例自动扩 |
| 渠道会话上限之和 | ≈15+（见下表；grok 不限） | 加账号/加渠道/升 plan，看板改数 |
| **网关机 CPU**（本次实测新发现） | 总并发长流 ~12-14 条即触发 90% CPU 保护整机 503 | 升网关机规格，或重流量渠道直连不过网关 |

第三道是本次探测撞出来的：windsurf 8 条 + pqapi 6 条长流并行时，网关机 CPU 98%，
后续所有渠道整批 503 `system cpu overloaded`。**扩并发时网关机必须一起扩，否则渠道账面余量是假的。**

## 并发两口径（混谈会自相矛盾）

- **请求级**：一瞬间能同时处理几个一次性 HTTP 调用（2-3 秒/个）。
- **会话级**：同时活着几条 agent 长会话（几十分钟持续流+工具回合）。供应商按账号另行计量
  （concurrent runs）。长流探针（N 条并行流式长输出）是最接近的 HTTP 可观测代理，但
  codex 实咬证明 CLI/中继层还有更紧的墙。
  **最终判据永远是真实派工的会话死因统计（看板回调），探针只定初值。**

## 实测数据与填入路由表的初值

| 渠道（组） | 请求级实测 | 长流实测 | 会话经验值（实咬） | **填入初值（会话级）** |
|---|---|---|---|---|
| pqapi（codex sol/luna） | ≥8 | 6 | CLI 会话 3-4；当天三次中继死 | **2**（瓶颈在 mirasim 中继/CLI 层） |
| windsurf（luna/kimi 等 48 模型） | ≥10 | 8 | 中间口径曾记用户经验 4，已作废 | **6**（06:11 按长流 8 全绿拍板；风险由看板死因统计兜底） |
| mirasim 中继 | 未测 | 未测 | — | **5**（用户拍板） |
| grokpool（xAI 直连） | 未测（用户判不限） | ≥8 全绿（复测，网关降温后） | 工人无限做没出过问题 | **不限**（受负载闸与网关机约束） |
| cursor | 2（4 并发整批挂起） | 2（3 条时 agent 进程崩退出码 1） | — | **2**（硬墙，ACP 常驻单代理） |
| dspool（走 windsurf） | ≥8 | ≥8 全绿（复测） | — | 跟 windsurf 共享账号预算 |
| opencode | 修复后可用 | ≥4 全绿（复测） | — | 到期不续；**到期前作溢流腿**（主腿满员/熔断时用，不立即禁用） |
| commandcode | 未测（到期不续） | — | — | **0/到期**（不作溢流） |

opencode 2026-09-08 修复记录：上游（Console Go）强制 `x-opencode-session` 头、new-api 不透传
未知头 → 整条 503 MissingSessionID。修法：渠道级 `header_override` 注入（同 grok 渠道先例），
已进 `thoerwink8/ai-gateway-stack@a55e9c45822100ec23bbc92c2d185ee69a03c650`
（[30-channels.sh](https://github.com/thoerwink8/ai-gateway-stack/blob/a55e9c45822100ec23bbc92c2d185ee69a03c650/deploy/30-channels.sh)）。**不是 key 的问题。**

## 证据与限制

数字来自 2026-09-08 帅位探针，已落实现单评论（持久、与提交无关的 GitHub 证据）：

- 请求级梯度 2→4→6→8、每档小请求：https://github.com/thoerwink8/windsurf-dao/issues/1145#issuecomment-5579609402
- 会话级长流终值：https://github.com/thoerwink8/windsurf-dao/issues/1145#issuecomment-5580070552
- 最终拍板（windsurf=6、opencode 溢流、病腿机制）：https://github.com/thoerwink8/windsurf-dao/issues/1145#issuecomment-5580161859

方法（可复述，不依赖本仓脚本）：请求级是对网关渠道并行打短 HTTP；会话级代理是 N 条并行流式长输出。
一次性探针脚本当时写在本机临时目录，**不在本仓库、本提交也没有**，不能从本 HEAD 复跑实验。
限制：HTTP 长流 ≠ 真实 agent 会话（codex 已证明 CLI/中继更紧）；初值以看板死因回调为准。

## 看板接口预留（控制面契约，按 2026-09-07 7A：代码放本仓子目录，不新开仓）

看板后端只消费四个已有读源、只走两条写路，不新造状态：

**读（全部已存在或在实现单验收内）：**
1. `docs/model-routing.json` 腿节——cap / 顺位 / 状态 / 到期 / 病腿标（实现单加字段）
2. 指挥官态势快照（`~/.dao/commander/` 下 situation）——sessions / lease / 在途
3. `~/.dao/provider-health.json`（gw-remote-probe 每小时落）——请求级健康 / 红腿
4. board-watch 表（PR #1108）——每单阶段 / 耗时 / 模型

**写（只有这两条，都可审计）：**
1. 路由表字段（cap/状态/顺位）——commit 进本仓（配置即代码）
2. 网关渠道配置——new-api admin API（渠道启停/key 轮换）

后端形态：本仓 `board/` 子目录一个小 HTTP 服务，部署本机（Contabo），飞书登录（7A 原案）。
不新开仓、不引数据库——四个读源都是文件/JSON，直接读。

## 关联

- 实现单：渠道并发三件套 + 病腿贴标；装载面自愈；draft 泵（均另开，不由本文档 PR 关单）
- 跨项目射程：dispatch `--repo`（另单）
- 看板：既有 board-watch 表
- 网关侧：`thoerwink8/ai-gateway-stack@a55e9c45822100ec23bbc92c2d185ee69a03c650`
  （ROUTING 并发节 + 30-channels.sh header_override）
