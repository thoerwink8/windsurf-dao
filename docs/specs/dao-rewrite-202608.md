# dao 体系整体重写 · 实施规划（终稿 2026-08-02）

## Context

dao.md（57KB）+ 用户级 CLAUDE.md（2KB）经 @import 每轮全量注入。用户诊断：dao.md 从「道」（道德经式简洁原则场域）退化成了「法」（条款/元字段/基线堆积=法令滋彰），且 persona 已注入两部经全文、哲学表达双份。授权整体重写：**性能更好、功能不丢、改完自测**。

实测病因：33.6% 是论证叙事（19.3KB，已验证的档案指针形态只要 1/73 的字节）；16.6% 是存根自身（11 条×868B 的目录复刻）；台账字段 2.9KB 消费≈0；三重投递冗余。外部硬事实：**@import 不省 token**（官方：launch 时全量展开）——省的开关只有 hook（本体零上下文成本）/ `paths:` 作用域档（命中才加载）/ skill（body 按需）；官方硬指标 CLAUDE.md <200 行；「工具能强制的别写散文」；无关条款主动伤害（context rot）。

**用户已拍板四条**：①台账搬家、正文零台账 ②全套一起重设计（dao.md+用户级+投递体系）③目标 **always-on ≤10KB（硬闸）** ④重写授权+自测。

## 目标形态

### 新 dao.md（**≤10KB 硬闸、≤190 行**；设计概算 12.5KB 为保守上界——落笔以 10KB 为闸，砍不进的部分列清单呈用户裁）

13 节骨架（**H2 节名全部冻结不改**，两仓 33+ 处节名引用零失效）：

| 节 | 目标 | 留什么 |
|---|---|---|
| 头部+八句根基 | ~950B | **八句原样保留**（经文→工程行为的操作化翻译层，persona 经文替代不了；双份消解=删各节散落的经文引言 ~400B，不删八句） |
| 动·三才之机 | ~2.0KB | 天觉七问一行；目的否/位分否/归属层判据句；完成流水线骨架；**设计同步门控整段删**（→Stop hook）；打磨自曝/微复盘压判据句 |
| 续力 | ~1.2KB | 每答必续+两豁免+「除 stop:true 每轮必有心跳」（每轮用）；「说人话」判据句；选项细则→新档 dao-askuser.md |
| 知识归位 | ~1.3KB | 层级判据/dao 先行/三选一各压判据句；共性 rule 备案整段删（manifest+scaffold-check 已承载） |
| 谋/品/路由 | ~1.3KB | 三管线三选一；品心法一句+存根；路由四条压三行 |
| 帅 | ~2.2KB | 三职/对话席/亲历上限（压缩版，每轮用）/⚔️模板（槽位）；派单/拍板批/长窗三存根各 200B；长窗留守四句压 450B；合验证/越权/资源独占/热重载/对抗前置**迁 dao-dispatch.md**，各留一句判据 |
| 器·命令表 | ~800B | 8 行精简表；附注迁各 skill description（本就每轮注入，零新增成本） |
| Shell | ~1.4KB | 存根+判据行；PR 合并链 2 行指针；已出硬闸段全压一行指针 |
| 言/反·归 | ~1.2KB | commit 前缀；G5 判据句；纠偏三动作；立法/写守卫存根；预算护栏判据句+指针 |

每条款行尾只留 `[#slug]`（~10B），零 `[n=]`/`[基线:]`/`[自定@]`/长叙事。

### 新用户级 CLAUDE.md（≤700B）

留：中文回复 2 行 + compact 摘要中文 1 行（PostCompact 不能注入，文字是唯一通道）+ 合规检查≠身份询问 1 行 + 经文位置 1 行 + @import 行。
删：标题中文段（dao-cn-title.js 已确定性兜住）、Grep-first 整节（**删前先核 permission deny 清单覆盖 sed/awk/Select-String，缺则先补 deny**）。

### 预算闸新值（呈批项）：建议总闸 **16KiB**（dao.md ≤10KB + 用户级 ≤1KB + 生长余量 ~5KB；现 70KiB）

## 分流去向（六类）

1. **论证叙事 19.3KB → 档案化**：迁 `docs/evolution/incident-narratives-202607.md` + `dao-clause-rationales.md`（已存在已被引用，差额补录），正文只留 `[#slug]`
2. **台账 2.9KB → 机器面**：新档 `ccswitch/clause-ledger.json`（按 slug 存 n/first_seen/trigger/self_authored/baseline/出处/status）——升格/退役审查/`[自定@]` 整批撤回全走 ledger；两套独立解析器（clause-parser.mjs / check-clauses-structure.ps1）**同批各自改契约、互不抄**，双向孤儿检测（正文有 slug 无账 / 账有无正文均红）；ledger 只存元数据不存全文（Markdown 仍是正文真相源）
3. **机械流程 → hook 化**（本体零上下文成本）：
   - `dao-design-sync-gate.js`（**Stop**）：设计同步门控 2KB 全机械判定迁入；**once-latch 每会话每门至多 block 1 次**（防 8 连 block 强杀）；含 od-panel-sync 静默分支
   - `dao-subagent-clauses.js`（**SubagentStart**）：接通已有 `render-clauses.mjs` 按官种渲染条款注入（Quote 形态=遵守率 17-40%→76-77% 的变量）；映射不出→注入 Read 指令，永不静默空过；**与 dispatch-clauses 首行 Read 双通道过渡**，审计 ≥20 次注入率 100% 后才裁退役
   - 心跳投递机器化：心跳 prompt 强制 `[dao-heartbeat]` 签名开头（PreToolUse[ScheduleWakeup] 新闸 G6 校验，呈批项）+ dao-rhythm.js 加 WAKEUP 信号：命中签名→注入留守四句+Read 指令——**与 compaction 正交**，顺带把「载荷被清?」的未验风险兜住
   - tool-nudge 扩展：⑤ dev-server 裸起非 worktree 提醒；⑥ 新建 .ps1 提醒；**MCP matcher 扩展是用户动作**（cc-switch DB，已有单 windsurf-dao #64）
4. **有 Read 锚点的 → 作用域档**：新增 `dao-scope-legislation.md`（paths: dao.md/ccswitch/rules/**/dispatch-clauses.md/.claude/rules/*——立法改条款前必 Read，锚点真实）；7 份无触发器 rules 按「必然 Read 某类文件吗」逐份补齐或**诚实标纯文字兜底**（dao-product/dao-change-batch 无锚点，不造假触发器）
5. **细则正文 → rules/ 迁移**：合·分级验证/越权 Grep/资源独占/热重载→dao-dispatch.md；对抗验证前置→dao-guard-writing.md（scoped 档已覆盖其路径）；Dogfood/TODO 准入→dao-product.md；选项细则→新档 dao-askuser.md
6. **存根统一极简模板**（~200B/条）：`**<域>·存根**：<触发时刻> = Read <路径> 全文。判据一句：<15-30字>。〔投递：<通道>〕 [#slug]`

## 分批次序（每批独立验证独立回退）

- **批 0 基线**：/context 实测 token、可达性矩阵 v0、`git tag pre-rewrite`
- **批 1 投递基建先行（正文一字不动=安全网）**：三个新 hook + G6 + scoped 档 + dao-askuser.md + PreToolUse[Task]/[AskUserQuestion] additionalContext 能力实测；每 hook selfcheck+正负控实弹+check-dead-gates 扩面。回退=撤注册零影响
- **批 2 台账机器面**：slug 上正文、clause-ledger.json、双解析器 v2 双轨对账全绿后才许删旧元字段
- **批 3 dao.md 重写**：先立后破（R 类先落 rules/档案再删正文）；10KB 硬闸验收；`check-dao-refs.mjs`（一次性引用面扫描）+ reconcile
- **批 4 用户级重写+闸值落定**：deny 核对前置；LIMIT_BYTES 写用户拍板值；**「每个项目自动检肥」通用检查项**（用户拍板 2026-08-02，治「靠提醒会失忆」）：scaffold-manifest 加 universal 条目+字节/token 求值器——任何项目的常驻注入面（项目级 CLAUDE.md + .claude/rules 无 paths 档）超基准 → SessionStart 报一行+瘦身方子指针；基准值以 dao 重写后的最佳形态为参照（呈批数字）；**边界：检测全自动，改造须用户点头**（删什么留什么是判断档）；**体检清单的自我生长机制**（用户点名 2026-08-02 第二笔）：①条款层——重写后 dao.md「归属层」判据补「发现可机器化检查的跨项目问题形态 → 默认动作=提议进 scaffold-manifest 体检清单（附条目草案）呈拍板，单次 issue 只是补充」（首证：mousse CLAUDE.md 超标被帅处理成单仓待办而非清单候选，用户当场纠正反应层级）②机器兜底——tool-nudge 在 `gh issue create` 后轻提醒「这问题所有项目都会有吗？是→提议进体检清单」，每会话至多一次；③新检查项的准入仍归用户拍板（改所有项目的开工检查面）
- **批 5 全量自测+双通道退役裁决**（依审计数据呈用户，不预拍）

## 自测方案（「功能不丢」的操作化验收）

1. `/context` 批 0 vs 批 4 对比（目标 Δ≈-45KB≈-12k~15k token/session）
2. `claude --safe-mode` 演练：hook 全关时每条 H 类的正文存根仍指得到正文（静默失败终极兜底）
3. **条款可达性矩阵逐时刻实弹**：改 .ps1→scoped 到达；改守卫→guard-writing 到达；改 dao.md→legislation 档到达；派官→SubagentStart 渲染到达（**取证 Grep subagent transcript 注入签名，不问 subagent 本人**）；gh pr merge/issue create/dev 裸起→nudge 到达；UI 改动收尾→Stop 门 block 一次；心跳唤醒→WAKEUP 注入。每项配负控（不命中→零注入）
4. hook 实弹正负控+心跳文件真实触发记录+fail-open 验证（喂坏输入不砖会话）
5. InstructionsLoaded 审计（能力确认后挂）：验证 paths 门控真的命中才加载
6. 预算闸新值全绿+gen-clause-index --check --reconcile 双解析器同数
7. **不宣称遵守率改善**（调研反证在案；正当收益=attention budget+token）

## 风险与兜底（要点）

- hook 静默失败→selfcheck+心跳文件+check-dead-gates+正文存根文字兜底+--safe-mode 演练
- Stop 门 8 连 block→once-latch
- SubagentStart 能力不符→批 1 先实测，失败路径注入 Read 指令，首行双通道不退役
- ledger 双写漂移→ledger 唯一真相源+双向孤儿检测，正文只持 slug 不持数据
- **丢判据（最大风险）→分流表逐块 sign-off 白名单+可达性矩阵实弹+先立后破+git tag 逐批回退**
- 判断档不自定：闸值 16KiB、G6 新闸、首行退役——实施中逐项呈批

## 关键文件

- `D:/frank/windsurf-dao/ccswitch/dao.md`（重写主体）
- `ccswitch/rules/dao-dispatch.md`（R 类最大承载档，头注「刻意留正文」清单同步改）
- `ccswitch/hooks/dao-tool-nudge.js` / 新 hook×3（dao-design-sync-gate / dao-subagent-clauses / G6）
- `ccswitch/scripts/render-clauses.mjs`（SubagentStart 接线渲染端）、`check-alwayson-budget.mjs`（新闸值）
- `ccswitch/lib/clause-parser.mjs` + `scripts/check-clauses-structure.ps1`（契约 v2 双改）
- 新档：`ccswitch/clause-ledger.json` / `ccswitch/rules/dao-askuser.md` / `ccswitch/rules/scoped/dao-scope-legislation.md`
- `C:/Users/Administrator/.claude/CLAUDE.md`（用户级重写）

## 批 0 基线（2026-08-02 实测，用户亲跑 /context）

- **dao.md：28.1k tokens**（盘上 57,343B——实测比率 ≈2.0B/token，中文密集）
- 用户级 CLAUDE.md：888 tokens（2,068B）
- **本次改造目标面合计 ≈29.0k tokens/session**
- 按 ≤10KB 硬闸推算：重写后 dao.md ≈5k tokens，**每 session 预计净省 ≈24k tokens（-83%）**
- 批 4 后用户再跑一次 /context 同口径对比，即自测方案第 1 项的两个端点
- 参考（本契约不覆盖，仅记录）：mousse 项目级 CLAUDE.md 7.1k tokens、pr-evidence 1.3k——项目级面是潜在的下一批候选
- git tag：`pre-rewrite` @ fa4ce0e（四 PR 收口后的 master，23 套 1,375 断言全绿）

## 实施形态

多官分批派单（帅终审每批），批间用户可中断；预计批 1-2 与批 3-4 各一个执行波；全程 PR-first，windsurf-dao 仓。
