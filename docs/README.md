---
reviewed: 2026-09-19
---

# docs/ 地图：什么住哪、怎么进、怎么退

任务与知识的分层（2026-09-08 用户拍板：问题在读取面，不再造第二本账）。**同一件事只住一层**，
其余层只放指针。每层都有「录入触发 → 读取面 → 退出机制」三件套，缺一就会变成没人读的死文档。

| 层 | 住哪 | 装什么 | 读取面（谁被迫看见） | 退出机制 |
|---|---|---|---|---|
| 工作项 | GitHub issues | 一切要派工的活（唯一工作账本） | 指挥官每 20 分钟扫盘 | close（`close-issues.mjs` 按 done_when 自动关） |
| 长期目标 | `docs/initiatives.json`（西瓜清单） | 丢了会疼的长期事，WIP ≤ 3 | SessionStart hook 开场念 active 条目；dao-check 每次念 | 见下「联动退出」 |
| 拍板与计划 | `docs/decisions/`（ADR 式，日期开头） | 判例档案（不改历史）+ 进行中的计划文档 | 计划文档 `status: in-progress` 时 SessionStart hook 开场念 | 见下「联动退出」 |
| 跨会话发现 | `docs/observations/`（收件箱） | 别的会话留给帅的发现 | 每轮全局 hook 提醒，超 24h 硬指令 | `处置：#单号` / `status: done|wontfix` |
| 决策数据 | `docs/*.json`（model-routing / release-policy / dispatch-policy …） | 机器要读的拍板结果 | 各消费脚本直接读 | 改字段走 PR |
| CLI 坑 | `docs/cli-notes/` | 各家 CLI 的已知行为与坑 | 按需查 | 过时就删行 |
| **活文档** | `docs/` 其余（`decisions/` `observations/` `exams/` `retired/` **除外**） | 会随代码漂移的说明与教学 | `repo-hygiene` 每轮念 | 见下「活文档复核与退役」 |
| 草稿 | `_tmp/` | 探针脚本、临时产物，**不进 git** | 无 | 随手删；真相源必须进 git |


## 计划文档约定（decisions/ 里带任务板的那种）

frontmatter 必带两个字段（2026-09-08 起新计划文档适用，存量不回填）：

```yaml
---
status: in-progress   # 或 done；in-progress 会被 SessionStart hook 开场念出来
issues: [1133]        # 统领单/挂钩单号；退出机制靠它联动
---
```

## 活文档复核与退役（T47，用户 2026-09-19 提「落后的文档要能清掉，要有机制」）

活文档会随代码漂移，所以每条二选一：

```yaml
---
reviewed: 2026-09-19   # 最近一次复核过；超期（默认 90 天）→ 红
---
```

或者**退役**（不删文件——判例档案原则，删掉等于篡改历史）：

```yaml
---
status: retired
---
```

- **没标过 = 没复核过**，计入待处置（不许当已读）；待处置堆到 5 条 → 红。
- 三态：读不到 = 没查成（退出码 2），不许当「没有落后文档」。
- 跑法：`node scripts/docs-retire.mjs`（0=绿 / 1=红 / 2=没查成）；并入 `repo-hygiene` 同出口。
- 档案目录（`decisions/` `observations/` `exams/` `retired/`）**永不进判据**。
- 与 #1487 的边界：#1487 管**引用腐烂**（指针指向空气）；本机制管**文档本体落后**。

## 联动退出（开了 GitHub 单之后，清单怎么收摊）

原则：**活一旦进了 issue，文档层就只剩指针**——不许在两处各维护一份进度（#880 进度表骗人两次的判例）。

- 西瓜条目、计划文档都可挂 `issues: [...]`。西瓜条目的 `done_when` 里写的 `#单号` 会并进挂钩集合——漏挂统领单不得把仍在推的目标误报该收摊。
- `dao-check --full` 跑「清单退场闸」：active 西瓜 / in-progress 计划文档挂的单**全部关闭**却还没标 done → 红。
  红的意思是「该收摊了」：人工核一眼 done_when，一行 commit 把 status 翻成 done——翻状态是拍板动作，不自动代拍。
  单个计划文档读失败标 `unscanned`（没查成），不得当零目标放行；开场 hook 同步打「没查成」。
  坏的 `issues` 挂钩（非正整数）原样保留，状态查询落到 `unscanned`，不得滤成「0 个对象」绿。
- 状态翻成 done 后，SessionStart hook 自然停念（读取面与退出机制共用同一个字段，不会漂）。

## 为什么不大搬家

model-routing.json 等机器读的 JSON 有几十个消费点钉着路径，搬 = 检查面半失效
（判例 memory `migration-half-done-breaks-checks`）。本次整理是**加约定与读取面**，不挪真相源。
