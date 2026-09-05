---
title: 帅位 cacheRead 注入面构成（#981）
status: open
issue: 981
date: 2026-09-06
---

# 帅位每轮 cacheRead 注入面构成（只查证）

署名 issue #981。本页是查证报告，**没改** `CLAUDE.md` / `settings.json` / skills。砍哪一行由用户拍。

## 0. 覆盖面（先读这段）

数据源按任务书：`/home/orca/.mirasim/insights/`。root 侧账本这台读不到。

| 项 | 本机实测 | issue 正文引用 |
|---|---|---|
| 文件 | `usage-2026-09.ndjson` 701 行（530604 B）；`session-usage-2026-09.ndjson` 16 行且全是 codex | 同路径 |
| 时间窗 | 2026-09-04T06:40Z → 2026-09-05T11:31Z | 7d 订阅对账，113 次 |
| claude/opus 调用 | **13 次 / 11 会话** | **113 次** |
| opus 输出合计 | 2,591 token | 6.3 万 |
| opus cacheRead 合计 | 73,598 | 484 万（77×） |
| opus cacheWrite 合计 | 461,196 | （正文未给） |
| 单条 reqBytes 最大（claude） | 142,851 | 「255KB 可直接佐证」 |
| 本机 reqBytes≥200KB | 574 条，**全是 codex / gpt-5.6-luna**，最大 990,420 | — |

结论：issue 里那组「113 次、输出 6.3 万、cacheRead 484 万、77 倍」**不在这台 orca 的 insights 里**。本机 opus 样本是短探针（PONG / RELAY_OK / sleep 1200 / printenv），不是长跑帅位会话。下面的构成表用本机能量到的注入面 + 这 13 次的 cacheWrite 地板；77 倍长尾只能从 autoCompactWindow 和「每轮重读」机制外推，不能拿本机 ndjson 复算。

本机 claude 会话 cwd：`/home/orca/mirasim-work`（空、无 CLAUDE.md）、`/tmp/wt880a-scratch`、两棵 dao worktree。**没有**挂在 `/home/orca/windsurf-dao` 主树上、真正跑指挥官/值守的长会话。

## 1. 估算方法

本机无 `tiktoken` / Anthropic tokenizer。三套数并列，表里主列用 **B（混合启发）**，对账用 **C（API 实数）**。

- **A. bytes/4**：UTF-8 字节 ÷ 4。拉丁偏乐观、汉字偏高。
- **B. 混合**：非汉字 ÷ 4 + 汉字 ÷ 1.5。中文文档更接近 Claude tokenizer。
- **C. 实测 cacheWrite / cacheRead**：Anthropic 账单字段，单位就是 token。本机 13 次全部 `input=2`（可见用户字几乎全进了 cache 创建/读取）。

交叉：空 cwd 首轮 `reqBytes≈99042`、`cacheWrite≈36314`，reqBytes/token ≈ 2.73。这是 **HTTP 请求体字节 / 账单 token**，不是「文件字节 = token」。文件侧仍用 A/B。

## 2. 静态面（每轮都在的那一层）

「每轮重读」在 Anthropic 侧表现为：首轮 `cacheWrite=地板`，第二轮起 `cacheRead≈上一轮地板`、`cacheWrite=本轮增量`。本机唯二的两轮会话：

| session | 轮1 cw / cr | 轮2 cw / cr | cr/out |
|---|---|---|---|
| `41649d5c`（mirasim-work，sleep 1200） | 36361 / 0 | 797 / 36361 | 39× |
| `eae321b5`（mirasim-work，printenv） | 37237 / 0 | 938 / 37237 | 37× |

第二轮把整份 36k–37k 的前缀又读了一遍，增量不到 1k。这就是「77 倍」的微型版：轮数一长，cacheRead 线性叠，输出几乎不涨。

### 2.1 注入项 × 体积

| 注入项 | 落点 | 字节 | A token | B token | 每轮是否进模型 | 削减建议 | 预期节省（B，每轮） |
|---|---|---|---|---|---|---|---|
| Claude Code 内置 system + 工具 schema | CLI 2.1.260，改不了约定文件 | （残差，见下） | — | **~29,000** | 是（地板） | 不在本单拍板范围；`--bare` 会砍 hooks/LSP/plugin/auto-memory，工具 schema 大多还在 | 未测 |
| 用户 CLAUDE.md | `~/.claude/CLAUDE.md` = `docs/global-CLAUDE.md` | 6,102 | 1,526 | **1,281** | 是 | 文末已自限「2000 token 以内」；实测 B≈1281，还没超。加行前先删。最大块是「重大决策 / AskUserQuestion 顺序」段 | 砍半段 ≈ 400–600 |
| 项目 CLAUDE.md | 仓根 `CLAUDE.md` | 3,179 | 795 | **669** | 仅 cwd 在 dao 树时 | 停派工态说明可再压成指针 | 200–400 |
| AGENTS.md | 仓根（Claude 也会捞） | 3,456 | 864 | ~800 | 仅 dao 树 | 与项目 CLAUDE 重叠，留一份 | ~800 |
| MEMORY.md 索引 | `~/.claude/projects/-home-orca-windsurf-dao/memory` → `/home/orca/windsurf-dao-memory`；索引 40,647 B（issue 写 22.9KB，**已涨到 40.6KB**），仓内 185 个 md / 673KB | 40,647 | 10,162 | **8,936** | **只在 cwd 链到这份 memory 时**。本机 13 次 opus **全部不在** windsurf-dao 主树，cacheWrite 里看不到这 9k | 索引改成「按需 skill」，或按 strikes/日期裁到最近 N 条。185 篇正文不应进每轮 | **8.9k**（若帅位 cwd 真挂了这条 junction） |
| skills 元数据清单 | 会话 jsonl `attachment.skill_listing`：**59 条 / 21,610 B**（实测 eae321b5） | 21,610 | 5,403 | **~4,400** | 是 | **最大可砍的约定面**。28 条 `lark-*` 占 11,937 B（约 55%）。dao 自己的 19 条约 9.7KB | 卸 lark 清单 **~2.5–3.0k**；再卸内置 12 条（dataviz/loop/init…）约 0.5–1k |
| 内置 slash skills 12 条 | 打进 CLI 二进制，不在 `~/.claude/skills` | listing 里约 4.5KB | ~1,100 | ~900 | 是 | `--disable-slash-commands` 可关（本机没跑成活对照，见 §4） | ~900（未活测） |
| 用户 skills 正文 | `~/.claude/skills` 49 链，SKILL.md 合计 441,827 B；整树 5.5MB（lark-slides 单独 1.6MB） | 441,827 | 110k | — | **否**（只在点名时读） | 清单瘦了，正文体积不影响每轮。lark 整树是「点名才贵」 | 0 / 轮 |
| `~/.claude/settings.json` | 30,185 B；hooks 12 个事件 × 同一段 2165 B 脚本 = 27,415 B | 30,185 | 7,546 | 7,546 | **基本不进模型**（本地执行）。权限/statusLine 可忽略 | 不要为了 cacheRead 去改 hooks；那是执行面 | ~0 |
| 项目 `.claude/settings.json` | 三道 hook：dispatch-gate / ask-gate / tool-use-gate + SessionStart onboard | 1,055 | 264 | 264 | 不进模型 | 同左 | ~0 |
| autoCompactWindow | **不在** live `~/.claude/settings.json`。Mirasim 一次性 `--settings /tmp/mirasim-claude-settings-*.json` 写入 **`800000`**（本机读到 12 份可读副本，值全是 800000）。NEW-MACHINE 仍写 500k；memory `autocompact-window-is-absolute-tokens` 记 2026-08-17 写过 500000，已被这条启动链盖掉 | 配置标量 | — | — | 决定**何时**压，不占每轮 token | 见 §3。这是长尾主因，不是静态体积 | 压窗口 → 少轮数，不是少地板 |
| agent 清单 | `agent_listing_delta` 6 条 / 2,553 B | 2,553 | 638 | ~600 | 是 | 低优先 | ~300 |
| 动态 git / cwd / env | CLI `--exclude-dynamic-system-prompt-sections` 管的那截 | 未拆开 | — | **dao 树相对空 cwd 实测 +18.3k（C）** | 是 | 见 §4 对照。项目 CLAUDE.md 解释不了这笔（3.2KB 文件 ≠ 18k token） | **18k**（帅位若在仓内 cwd） |

**地板残差（C − 已点名文件）**：空 cwd 首轮 cacheWrite 中位 **36,315**。扣掉用户 CLAUDE（B 1.3k）+ skill 清单（B 4.4k）+ agent 清单（0.6k）≈ 6.3k，**剩下 ~29k 是 CLI 内置 system/工具定义**。这是每轮 cacheRead 的硬地板，砍约定文件砍不到它。

### 2.2 skills 清单构成（59 = 47 用户链 + 12 内置）

实测 listing（eae321b5，2026-09-05）：

- dao 仓链（`~/.claude/skills` → `host/skills`）：admit-push … worker-brief，**缺 webview-debug**（断链，无 SKILL.md）
- lark-* 28 条，listing 11,937 B
- CLI 内置 12 条：dataviz, update-config, keybindings-help, code-review, simplify, fewer-permission-prompts, loop, claude-api, workflow-authoring, run, init, security-review

`dispatch` 的 SKILL.md 单独 39,998 B——点名才读，不进每轮清单。

## 3. 动态面（长尾）

### 3.1 `autoCompactWindow=800000` 是什么意思

- 单位是 **绝对 token，不是百分比**（memory 已证）。
- 800,000 在 opus[1m] 上 = 窗口的 80%，不是 NEW-MACHINE 写的 50%/500k。
- 低于阈值不自动压。会话可以一直长到 ~80 万才 compact。
- 本机 live `~/.claude/settings.json` **没有**这个键；生效值来自 Mirasim 起 claude 时的 `--settings` 临时文件。改用户 settings 也挡不住这条启动链（除非 Mirasim 改模板）。
- 本机 13 次 opus 全是 1–2 轮，**没有 compact 样本**，自动压缩行为未在本账本验证。

### 3.2 本机 opus 增长（样本太短）

两轮会话：轮 2 的 cacheRead = 轮 1 的 cacheWrite，增量 cw < 1k。外推：

- 每多一轮，cacheRead 账单 ≈ 地板 + Σ历史增量
- N 轮、地板 F、每轮增量 d：cacheRead 合计 ≈ (N−1)·F + 三角数(d)
- 输出合计 ≈ N·o。当 o≪F，比值 ≈ F/o × (N−1)/N → 逼近 F/o

本机 F/o：空 cwd 短回复 o≈5–9，比值 4,000–7,000×（没意义，回复太短）；带工具的两轮 o≈500–650，比值 ~37–39×。issue 的 77× 对应「F 更大（仓内 cwd + memory）且 N 更大、输出仍短」。

用 issue 数反推（**不是本机账**）：cacheRead 484 万 / 113 次 ≈ **4.3 万 / 轮**，接近本机空 cwd 地板 3.6 万，略低于 dao 树 5.5 万。若那 113 次真是帅位仓内会话，4.3 万/轮说得通（仓内地板 5.5 万，但部分轮在 compact 后或 cache 未满）。**本机无法复核。**

### 3.3 本机能看到的「慢」

空 cwd 首包 2.0–3.9s；dao 树 3.6–9.2s。和 issue「中位 2.9s、链路 0.18s」同方向：时间在提示词体积，不在网络。本机没有 255KB 的 claude 请求；那种体积在本机是 **codex 审官会话**（cacheRead 单会话 600 万级，比值 180–350×）。若对账把 codex 和 opus 混在一起，77× 会被审官会话拉大——**请对账时按 agent=claude 过滤**。

### 3.4 本机 codex 长尾（对照，不是本单对象）

最长 `d7760077`：55 轮，cacheRead 6,892,800，输出 30,898，比值 223×。cacheRead 中位 150k、末轮 214k，每轮 +3k 量级。说明「每轮重读前缀」不是 claude 独有；claude 只是订阅额度更疼。

## 4. 判别性实验

任务书要求：同形态请求，改造前后各一次，贴 usage。

### 4.1 活实验：没做成（fail-visible）

试图起一次性 claude，**不改** live settings / CLAUDE.md / skills：

1. `claude -p` + 当前环境 `ANTHROPIC_MODEL=claude-5-fable-medium` → `[claude-code:unrecognized_model]`
2. `--model opus` / `claude-opus-5` / `claude-fable-5[1m]` → 上游 **503** `No available channel for model claude-opus-5 under group windsurf (distributor)`（debug 文件 `/tmp/issue981-claude-debug.txt`，attempt 1–4 同错）
3. `/v1/models` 在当前 `ANTHROPIC_BASE_URL` 上 **没有**任何 claude/opus/fable id（48 个模型全是 ds/glm/gpt/grok/kimi/gemini）
4. Mirasim 本地 `127.0.0.1:<临时口>` 代理当时全部不在听；`--settings` 临时文件里能读到 `autoCompactWindow=800000`，但端口已死，不能复用别人的会话令牌去打

**没有**改 `~/.claude/settings.json`，**没有**改 CLAUDE.md。live 对照（关 skill 清单 / 缩小 autocompact）欠一笔，等订阅通道能起 opus 再补。

### 4.2 账本对照（同形态、已发生、可复核）

筛选：`agent=claude`、`model=claude-opus-5`、首轮（`cacheRead=0`）、短指令（PONG / RELAY_OK / 一次性探针）。唯一差别是 **cwd 是不是 dao git 树**。

**组 A — 空 cwd（无项目 CLAUDE.md）**

| ts | session | cwd | reqBytes | cacheWrite | output | durationMs |
|---|---|---|---|---|---|---|
| 09-04 06:40 | 3e2d2f9e | mirasim-work | 99042 | 36314 | 9 | 3859 |
| 09-04 06:43 | a8d67849 | mirasim-work | 99042 | 36314 | 9 | 1990 |
| 09-04 07:44 | ca7195c7 | /tmp/wt880a-scratch | 102366 | 37646 | 5 | 3214 |
| 09-04 07:52 | c7a12373 | /tmp/wt880a-scratch | 102366 | 37648 | 5 | 3593 |
| 09-04 10:17 | 41649d5c | mirasim-work | 99174 | 36361 | 654 | 12310 |
| 09-04 11:33 | dc022de3 | mirasim-work | 99033 | 36307 | 5 | 2103 |
| 09-04 12:23 | 944e9520 | mirasim-work | 99033 | 36307 | 5 | 3067 |
| 09-05 11:31 | eae321b5 | mirasim-work | 101332 | 37237 | 428 | 8115 |

组 A 中位 **cacheWrite = 36,338**（去掉两条带工具的 36361/37237，纯 PONG 中位 36314）。

**组 B — dao worktree**

| ts | session | cwd | 该树有 CLAUDE.md? | reqBytes | cacheWrite | output | durationMs |
|---|---|---|---|---|---|---|---|
| 09-04 09:48 | 80ab93a6 | dao-880b-probe | 否 | 142851 | 55178 | 191 | 5427 |
| 09-04 15:07 | f2e8c0dc | dao-review-pr-885 | 是（3179 B） | 142630 | 55072 | 306 | 9204 |
| 09-04 15:08 | d5dd7632 | dao-review-pr-885 | 是 | 142648 | 55077 | 117 | 3579 |

组 B 中位 **cacheWrite = 55,077**。

**差：+18,739 token / 轮**（+52% 地板），reqBytes +43,608。两条有项目 CLAUDE.md 的和没有的只差 ~100 token，所以这笔 **不是** 3.2KB 的 CLAUDE.md。更像 git 状态 / 仓结构 / AGENTS.md / 动态 system 段。CLI 有 `--exclude-dynamic-system-prompt-sections`，活实验欠的就是这一刀。

第二轮（同会话、同形态续跑）见 §2 表：cacheRead 完整回放地板，增量 <1k。这是「改造前」的重读证据；「改造后」需要一次成功的 `--disable-slash-commands` 或 `--exclude-dynamic-system-prompt-sections` 首轮，本机通道做不到。

## 5. 建议削减顺序（只建议，未改）

按「每轮 token / 改动是否动约定」排序。全部要用户拍，因为 CLAUDE.md / skills 属改规则。

| 优先级 | 动作 | 每轮预期 | 风险 | 谁拍 |
|---|---|---|---|---|
| 1 | 帅位 cwd 不要落在大 git 树；或开 `--exclude-dynamic-system-prompt-sections` | **~18k**（本机 C） | 少看到 git status | 用户 |
| 2 | 清单卸 lark-*（28 条），需要时再装 | **~2.5–3k** | 飞书活要点名才有 skill | 用户 |
| 3 | MEMORY 索引不进每轮：改成 dao-inbox 式「超 N 条才提醒」，或只留最近 20 条标题 | **~9k**（若帅位真挂了 memory junction） | 少了判例索引 | 用户 |
| 4 | Mirasim `--settings` 的 `autoCompactWindow` 800k → 500k（回到 NEW-MACHINE / #443）或更低（如 200k） | 不减地板，减 **N**。113 轮若在 20 万就压，cacheRead 总量按轮数砍，不是按 18k 砍 | 长任务中途丢上下文 | 用户（且要改 Mirasim 启动模板，改 `~/.claude/settings.json` 无效） |
| 5 | 用户 CLAUDE.md 已 1281 B-token，先别加。若要砍，合并「决策工具顺序」段 | 400–600 | 行为变 | 用户 |
| 6 | `--disable-slash-commands` 去掉 12 条内置 listing | ~0.9k | `/compact` `/init` 等要手打 | 用户 |
| 7 | 不要幻想 settings.json 30KB 进了模型 | 0 | — | — |

不建议：为省 cacheRead 去删 hook（那 27KB 不进模型）；扇出降载 / 扩额度（已拍不做）。

若目标是「接近 issue 的 484 万 cacheRead」：静态砍满（18k+3k+9k≈30k）只能把每轮地板从 ~4–5.5 万降到 ~2–3 万，**总量仍随轮数线性涨**。真正打 77× 的是 **N × 地板**。不压窗口、不换会话，砍文件只能打七折，打不掉数量级。

## 6. 机制判定

问：制度生效前还会再犯吗？

**会。** 不是某次提示词写长了，是三条启动默认叠在一起：

1. Claude Code 每轮把 system+工具+CLAUDE.md+skill 清单放进 prompt cache，下一轮 `cacheRead` 整份重读——这是产品行为，不是我们写错一行。
2. 帅位经 Mirasim 起会话时 **强制** `autoCompactWindow=800000`，live settings 里看不见、NEW-MACHINE 的 500k 被盖掉。察觉不到违反（窗口绝对值，换模型/换启动链会静默失效）——正是 `autocompact-window-is-absolute-tokens` 那条 memory 警告的现场。
3. 对账用的 insights 在工人这台只有短探针；113 次长会话若在别的机器 / 已轮转的文件，本仓没有「账单对得上注入面」的例行检查。

会再犯的条件：Mirasim 继续用 800k 起 opus、帅位 cwd 继续在仓内、lark 清单继续常驻。本单只查证，**机制改动不在范围内**。若拍板要固：

- 垫片：Mirasim 启动模板把 `autoCompactWindow` 打回 500000（或更低），并加一道检查：临时 settings 与 NEW-MACHINE 不一致就报警。
- 开单：skill 清单元数据卸 lark（改规则，需拍）；memory 索引不进每轮（改规则，需拍）。
- 本 PR 只落报告，不改那三处。

## 7. 本机未改动的证明

- `~/.claude/CLAUDE.md` / 仓内 `CLAUDE.md` / `host/skills/**` / `~/.claude/settings.json` / 项目 `.claude/settings.json`：查证过程只读。
- 工作树相对 master 的代码 diff 只有本报告与 PR 正文。
