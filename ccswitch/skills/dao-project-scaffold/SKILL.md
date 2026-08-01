---
name: dao-project-scaffold
description: 开工处方统一入口——项目标准结构 + 技术栈门控（前端/桌面调试基建/CI 成本）。默认只读审计；带 --init 时对有 canonical 的缺项一键物化，删除/搬移类仍只建议。
disable-model-invocation: true
---

# 器 · 项目脚手架

> 朴散则为器。圣人用之，则为官长。——《道德经》第 28 章

## 触发时机

- 首次进入一个项目，检测到缺少标准文件时
- 用户手动调用 `/dao-project-scaffold` 进行结构审计
- 创建新项目时 / 让一个既有项目接入 dao ⇒ `/dao-project-scaffold --init`

## 参数路由

| 参数 | 做什么 |
|---|---|
| （无） | **只读审计**：核对下方检查清单 + 技术栈门控，报缺项与理由，一个文件都不动 |
| `--init` | **一键物化**：带 canonical 的缺项直接落地，不可物化项写进项目 `docs/USER-ACTIONS.md`。流程见本文件末尾 §`--init` 一键物化。范围限**增量创建**——删除/搬移/拆分类永远只建议 |

`<dao 根>` 在本机为 `D:/frank/windsurf-dao`（同 dao.md 对 `stacks/` 的消歧约定）；下文出现的
`ccswitch/...` 相对路径一律从它起算。

## Supporting Files

本 skill 包含以下 supporting files（按需 Read，不预加载）：

| 文件 | 职责 | 何时读取 |
|---|---|---|
| [design-assets.md](design-assets.md) | Open Design 项目结构（design/ 目录树、代码层映射、PROTOTYPE-SPEC 生成、OD 协议 symlink）+ 检查清单 | 检测到 `design/` 目录时 |
| [desktop-debug-gate.md](desktop-debug-gate.md) | 桌面端（Tauri/Electron）调试基建门控 + migrations 跨层一致性 + 检查清单 | 检测到 `src-tauri/` 或 electron 依赖时 |
| [frontend-gate.md](frontend-gate.md) | 前端技术栈门控（A 样式路线 → frontend-style.md rule 派生；B UI 测试分层 → frontend-ui-testing.md 处方选层）+ 检查清单 | 检测到 react/vue/svelte 依赖或前端目录时 |
| [ci-cost-gate.md](ci-cost-gate.md) | CI 成本门控（PR 多平台矩阵检测）+ 检查清单 | 检测到 `.github/workflows/*.yml` 时 |

## 标准结构

```
根目录/
  README.md              ← 人看的项目介绍
  CLAUDE.md              ← AI 入口（<80 行，精简指向 rules）

  .claude/
    rules/               ← AI 自动加载的领域规范
      *.md               ← 按领域拆分，paths: frontmatter 条件加载

  docs/
    PROJECT.md           ← 项目仪表盘（替代遗留型 TODO.md；与「在役候选池」型 TODO.md 并存，Loop 状态变更时自动更新）
    prd.md               ← 产品需求文档（如有）
    plans/               ← 实施计划（按日期命名：YYYY-MM-DD-主题.md）
    specs/               ← Loop 工作区（dao-loop 管理）
      _archive/          ← 已完成 Loop 归档 + INDEX.md
      <topic>/           ← 活跃 Loop（spec.md + acceptance.md + plan.md + STATUS.json）
```

## 原则

### 根目录法则

根目录只放**活文档**——每天可能打开的文件：
- `README.md`：给人看的项目介绍
- `CLAUDE.md`：给 AI 看的入口（<80 行）

历史文档、参考资料、产品文档全部进 `docs/`。项目追踪用 `docs/PROJECT.md`（Loop 体系自动更新）；根目录的 `TODO.md` **不一刀切**——幽灵型（遗留静态清单）该清，在役候选池型是活账本、属于「每天可能打开」的活文档，合法留在根目录。两者怎么分见下一节「TODO.md 存废判据」。

### TODO.md 存废判据

> **唯一真相源**：本 skill 检查清单、`dao-loop` §0 预飞、`dao-loop` closing.md §8 三处都指向这里，改判据只改本节。

根目录的 `TODO.md` 有两种身份，**先判身份再谈存废**：

- **在役候选池（活账本）** —— 下列任一成立即是，**不得建议清理**：
  1. 被项目 `CLAUDE.md` / `.claude/rules/**` / `PROGRESS.md` 引用（一次 Grep `TODO\.md` 即可判）
  2. 近 30 天内有过提交改动（`git log -1 --since="30 days ago" -- TODO.md` 有输出）
  3. 条目带来源标记（`[用户]` / `[dogfood]` / `[AI推测]` / `[竞品]` 之类），说明它在跑候选池准入流程
- **幽灵 TODO.md（遗留静态清单）** —— 上述三条**全不成立**才算，此时才建议清理，且**只建议不代删**。

**建议清理前必须先报这三条的实测值**，不许只给「应清理」这个结论——结论不可复核，三行实测值可以。

**这是近似判据，两个方向都构造得出反例**：刚建立、还没被任何文件引用过的活账本会被误判成幽灵；早已死透但仍被 `CLAUDE.md` 提过一嘴的幽灵会被放过。**失败方向刻意选「留」**——误删活账本丢的是候选池与 dogfood 记账（不可从别处重建），多留一个幽灵文件只是碍眼。

**为什么要有这一节**：`dao.md` 帅节「TODO 候选池三级准入」与 Shell 节「dogfood 发现写入 TODO.md」**要求**部分项目把它当活账本主动维护，而本 skill 与 `dao-loop` 预飞曾**无条件**建议清理它——两条同级规则在同一触发条件下给出相反指令。2026-07-22 查冲突 spike 首次抓获，当时只给下方检查清单那一条打了补丁；2026-07-27 复核发现另外四处（本文件 §根目录法则、检查清单 PROJECT.md 条、`dao-loop` SKILL.md §0 预飞、`dao-loop` closing.md §8）仍是无条件表述，**其中 `dao-loop` §0 预飞恰好就是 spike 点名「下次跑 loop 就会撞上」的那条路径**——补丁打在了不会被触发的地方。本节的存在是为了让「多处各说一半」在结构上不可能再发生；`tests/skills-todo-ledger.tests.js` 扫 `ccswitch/skills/**` 钉住这一点。

### 唯一 AI 通道

`CLAUDE.md` + `.claude/rules/` 是唯一的 AI 上下文通道。禁止在根目录堆积 `AGENT.md` / `AGENT_GUIDE.md` / `KNOWLEDGE.md` 等冗余入口——它们的内容应归入 `CLAUDE.md` 或 `.claude/rules/`。

### 项目类型必答题（建 `CLAUDE.md` 时的必填槽位）

> **唯一真相源**：本节。检查清单那一条、`--init` 流程第 ③ 步都指向这里，改判据只改本节。

新建（或首次补齐）项目 `CLAUDE.md` 时，**必须当场问出并写下一个答案**：这是**产品型项目**，还是**内部工具 / 基建仓**？

- **产品型** ⇒ 保留 canonical 骨架里那一行自我声明。此后 SessionStart 会查产品型那一档共性 rule（PR 真机证据三态 / PR 模板 / issue 模板目录）。
- **内部工具 / 基建 / 一次性脚本仓** ⇒ **删掉那一行**（连同骨架里的说明注释）。那一档不查。

**这一问必须问用户，不许 AI 替答**：它改用户可见面、且「这算不算产品型」是语义判断——按 dao.md 反·归的分档判据，两条否决项各命中一条，属**判断档**。骨架把它做成必答题，AI 只负责把问题端到眼前并落笔。

**为什么非要有这道题**（2026-08-01 审计实测，不是设计偏好）：那一档检查的开关是项目 `CLAUDE.md` 里一句纯子串自我声明（唯一定义处 `ccswitch/lib/scaffold-manifest.js` 的 `PRODUCT_TYPE_WHEN`）。全生态 grep 那五个字，命中的**全是 dao 自己的机件**——skills / commands / templates / 任何项目骨架里零命中 ⇒ **新项目结构上永远开不了那一档**。缺的既不是判据也不是授权，是「**没有任何东西会把那句声明写进新项目**」。

**这是对既定取舍的补完，不是推翻它**：声明仍由项目自己给（dao 不替项目判类型），只是把「没人会想起来写」这一层堵掉。

**照直写它仍然做不到的那一半**：走 `--init` 才有这道题；**手工建 `CLAUDE.md` 的路径它管不到**——那时既没有骨架也没有提问者，声明照旧会缺，而缺了之后一切照常运转（漏报侧），没有任何东西会响。

### Rules 文件规范

- 按**关注点**拆分，不按层级：`design-tokens.md`、`testing.md`、`architecture.md`
- 加 `paths:` frontmatter 做条件加载，减少 context 噪音
- 不加 frontmatter 则无条件加载（慎用，只用于全局规范）
- 中等项目 3-5 个文件；不要为拆而碎片化

### Docs 组织

- `docs/PROJECT.md`：项目仪表盘（活跃 Loop + Backlog + 里程碑，dao-loop 自动更新）
- `docs/prd.md`：产品需求
- `docs/plans/`：实施计划，按日期命名 `YYYY-MM-DD-主题.md`
- `docs/specs/`：Loop 工作区（活跃 loop 目录 + `_archive/` 归档），由 dao-loop 管理

## 跨层一致性门控索引（技术栈检测）

> 不知常，妄作凶。——跨层注册是"常"，忘注册是"妄"。

某些技术栈天然存在**跨层注册缝隙**——Layer A 的文件存在 ≠ Layer B 知道它存在；某些工程配置天然存在**默认值陷阱**——默认全平台矩阵 ≠ 账单可承受。静态类型检查和编译器都无法捕获这类断路，必须有专用检测。

首次进入项目时，按下表指纹检测，命中则 Read 对应 supporting file 执行详细检查：

| 技术栈指纹 | 缝隙/陷阱 | 详见 |
|-----------|---------|------|
| `design/` 目录存在 | 设计资产结构完整性 | [design-assets.md](design-assets.md) |
| `src-tauri/` 或 electron 依赖 | 调试基建 + `migrations/*.sql` ↔ Rust 注册 | [desktop-debug-gate.md](desktop-debug-gate.md) |
| `react`/`vue`/`svelte` 依赖或前端目录 | 样式技术路线未固化为 rule；UI 测试分层缺失（改动无自动回归面） | [frontend-gate.md](frontend-gate.md) |
| `.github/workflows/*.yml` 存在 | PR 触发多平台矩阵烧穿计费额度 | [ci-cost-gate.md](ci-cost-gate.md) |
| _(未来按需扩展)_ | | |

**扩展模式**：发现新的跨层断路或配置陷阱时，先问「这条能不能机器判」——

- **能机器判**（文件/目录存在、`package.json` 键位、行数、子串包含）→ 往 `ccswitch/scaffold-manifest.json` 加一条，**不要在本表加行、也不要往 `dao.md` 加「首次进项目静默执行」条款**。清单由 `dao-scaffold-check` hook 每次 SessionStart 自动求值，不依赖任何人记得跑本 skill。
- **需语义理解**（判断 rule 内容对不对、资产结构是否自洽、workflow 收敛得精不精确）→ 才在此表追加一行 + 对应 supporting file。

原则：**能自动检测的不写文档提醒，能测试的不写 check 脚本**。

## 检查清单

> **下列带 🤖 的条目已由共性 rule 备案清单 `ccswitch/scaffold-manifest.json` 机器化**：`dao-scaffold-check` hook 每次 SessionStart 自动求值并报缺项，本 skill 手动跑时不必重复核对（核对了也无害，只是冗余）。未带 🤖 的仍需人判。

首次进入项目时逐项检查：

- [ ] 🤖 `CLAUDE.md` 存在且 <80 行。**缺了就不只是补个文件——「项目类型」是必填槽位**：
      从 canonical `ccswitch/templates/CLAUDE.md.template` 派生后，骨架里那道必答题
      （**产品型项目 / 内部工具仓**，二选一）必须当场问出答案并写进去，不许留着两态并存就交差。
      判据与失败方向见 §项目类型必答题
- [ ] 🤖 `.claude/rules/` 存在（可空，但目录要有）
- [ ] 🤖 根目录无冗余 AI 入口文件（AGENT.md / AGENT_GUIDE.md 等。清单当前只机器化了 `AGENT_GUIDE.md` / `KNOWLEDGE.md` 两个具名文件，其他变体仍靠人眼）
- [ ] 🤖 `.gitignore` 含 `**/_tmp/`（AI 临时产出不入库，见 `dao.md` Shell §临时文件归项目）
- [ ] **开工包白名单**：根目录存在 `kit.json` manifest → `docs/kit/`（DECISIONS / STACK / INIT / FRONTEND / BACKEND / OPEN-QUESTIONS + acceptance/ + design-prompts/）视为合规结构，不判冗余；kit 文件散落根目录 → 建议按上述映射归位到 `docs/kit/`，不建议删除
- [ ] `docs/PROJECT.md` 存在（替代遗留型 TODO.md；与在役候选池型 TODO.md 并存不冲突，判据见 §TODO.md 存废判据）
- [ ] `docs/specs/` 存在（Loop 工作区）
- [ ] 根目录的 `TODO.md` **先判身份再谈存废**：三条判据全不成立才是幽灵、才建议清理；在役候选池型是活账本，不得建议清理。判据与实测报法见 §TODO.md 存废判据（本条不重述，避免两处各说一半）
- [ ] 上表命中的每个技术栈指纹，其对应 supporting file 的检查清单已过一遍

## 缺项怎么处置（三档，判据取自清单数据本身）

> 这一节 2026-08-01 替掉了原来那句「缺项不自动创建，而是**建议用户创建**并说明理由」。
> **为什么换掉**：canonical 模板齐了、`template:` 字段能自动生成零编辑复制指令之后，那句话
> 就成了把 AI 路径也堵死的最后一块砖——**手里握着一条粘贴即跑的指令，却被规定只能建议**。
> 换掉的不是「谨慎」，只是「一刀切」：下面第三档比原来那句更硬（永远只建议），
> 松的只有第一档，而第一档恰恰是零现场判断的那一档。

| 档 | 判据（机器可判） | 动作 |
|---|---|---|
| **甲 · 物化** | 清单条目带 `template:` | 跑报文里那条零编辑复制指令。执行时零现场判断 |
| **乙 · 代做** | 其余缺项（要新建一个 dao 没有 canonical 的文件，或往既有文件补一行） | 可代写，但**每条都要说清写什么、依据是哪一句**；与甲**分开计数**——两者可靠性不是一回事 |
| **丙 · 只建议** | `require` 顶层是 `not`（删除/搬移类）或 `maxLines`（拆分类） | **永远只建议不代做**。不是能力问题，是授权问题：删除与搬移不可逆、改的是用户既有内容 ⇒ 判断档 |

**分档以 `dao-scaffold-report.mjs` 打印的「档」列为准**，本节只解释判据——机器报事实、人（或 `--init` 流程）据此行动，别在两处各算一遍。

**乙里有个看着像甲的反例，照直写**：`.gitignore` 少一行 `**/_tmp/` 看起来是纯照做，其实不是——`_tmp/` 与 `**/_tmp/` 都能过闸而处方是后者，**机器判不出该写哪个**，所以它落在乙不落在甲。

dao-loop 预飞检查会自动处理 spec/plan 类迁移，不在本 skill 范围。

## `--init` 一键物化（增量创建）

> 为大于其细。一键补齐的价值不在「快」，在于**它可以重复跑到零**——一个只能跑一次的补齐动作，
> 补完之后没人说得清还剩什么。

**边界先写在前面**（读完再执行）：

- 范围限**增量创建**。删除 / 搬移 / 拆分（上表丙档）**一律只建议**，`--init` 不代做。
- 判断档的问题**必须问用户**，不许 AI 替答——目前只有一个：§项目类型必答题。
- 只对**当前项目根**动手。跨项目、跨仓的物化不在此列。
- 与 SessionStart hook 的分工别搞混：hook **只生成指令绝不动手**（静默改用户文件是另一个授权量级）；`--init` 是用户显式发起的动作，动手的是执行者。

**执行流程**：

① **核对**——跑

```
node <dao 根>/ccswitch/scripts/dao-scaffold-report.mjs [项目根]
```

退出码：`0` 零缺项 / `1` 有缺项（**不是错误，是有活要干**）/ `2` **没查成**（清单加载失败、项目根不存在）。
判「跑完没事」写 `-eq 0`，别写 `-le 1`——那个区间把「有缺项」也算成通过了。`2` 与 `0` 必须区分得开。

② **物化甲档**——对每条标 `[物化]` 的缺项，原样执行报文里那条 `↳ 零编辑复制 canonical:` 指令。
不要手抄内容、不要「参考它写一份」——那正是本批要治的病（同一条共性 rule 在每个项目里长得都不一样）。

③ **答必答题**——若本轮物化了 `CLAUDE.md`，**立刻**按 §项目类型必答题问出答案并落笔（产品型 ⇒ 留声明行；内部工具 ⇒ 删那一行连同注释）。骨架里其余占位（项目名 / 这是什么 / 铁律 / 验证入口）一并填掉，别留一份全是尖括号的文件。

④ **重跑核对**——回 ①。**这一步不是保险，是必需**：产品型那一档的检查条目**以 `CLAUDE.md` 里的声明为开关**，第一次核对时 `CLAUDE.md` 还不存在，那一档条目结构上**不可能**出现在报文里。不重跑就永远看不见它们。（同理，物化任何一个 `when` 指纹涉及的文件都可能翻出新条目——所以是「跑到两次结果相同」，不是「跑两次」。）

⑤ **乙档代做**——逐条说清写什么、依据哪一句，再动手。拿不准就降级为建议，别硬写。

⑥ **丙档 + 不可物化项 → 写进项目 `docs/USER-ACTIONS.md`**——**不可物化 ≠ 不用做**，义务转移必须落到一个有编号、有 owner、有解冻条件的账目上，否则等于销账。追加格式（没有该文件就新建）：

```markdown
## <YYYY-MM-DD> · dao 接入待用户动作

- [ ] **<一句话动作>**
  - 为什么机器做不了：<如「GitHub Projects v2 的自动化 API 建不了，只能网页点一次」/「删除不可逆，属判断档」>
  - 怎么做：<零编辑可执行的步骤或链接>
  - 做完怎么验：<一条可复核的判据，如「重跑 dao-scaffold-report 该条消失」>
```

> `docs/USER-ACTIONS.md` 是**可编辑的仓内文件**，故这里允许 `- [ ]`；同样的复选框**禁止**写进 PR body / commit message 等只读载体（dao.md 言·名之则）。

⑦ **收尾打印**——固定打这一行，三个数缺一不可：

```
🧱 dao 接入：已物化 <N> 项 / 已代做 <M> 项 / 待用户 <K> 项（docs/USER-ACTIONS.md）→ 复核 `node <dao 根>/ccswitch/scripts/dao-scaffold-report.mjs`
```

**为什么物化与代做要分开报**：混成一个数就把「粘贴即跑的复制」和「AI 现场写的内容」说成同一种可靠性了。
**为什么末尾要带复核命令**：这一行是给人看的自陈，而自陈不构成证据——把复核入口摆在同一行，读的人才有机会不信它。
