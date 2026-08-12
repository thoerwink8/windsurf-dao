# windsurf-dao · TODO

> 唯一的"要做什么"清单。架构/教训见 AGENT_GUIDE.md，部署机制见 MIGRATION.md。

---

## ✅ 已完成

### Rules 系统重构 v2 · 9 文件 5 层架构 *(2026-04-26)*

废除"道德法术四层"概念（dao-de-layer/dao-fa-layer/dao-shu-layer/dao-quality-gate/dao-layer 5 个旧文件），对齐 Windsurf 4 种 trigger 机制重构为 9 文件单一职责架构：

- **always_on**：execution.md（项目铁律）+ global_rules.md(symlink, 跨项目元规则)
- **model_decision**：cli.md / workflow-system.md（2 个领域决策；shell.md 与 knowledge-routing.md 已升级 always_on；skills.md 已并入 knowledge-routing.md）
- **glob**：quality.md（代码文件触发）/ dao-meta.md（dao 元层文件触发）
- **manual**：dao-philosophy.md（深度哲学，@dao-philosophy 调用）

**收益**：总字符 18,900 → 6,700（减 65%），每次注入 ~10,000 → ~1,400（**减 86%**），触发精准度大幅提升，符合 Windsurf 12K 字符限。

**教训**：见 `docs/evolution/evolution-lessons.csv` T20-T22（先读 AGENT_GUIDE.md / model_decision 拆分 / 4 trigger 各得其所）。e019。

### dao-autopilot.md 真融合重构 *(2026-03-29)*

废除 plan.md / archive/ 平行系统。TODO.md 为任务唯一载体，AGENT_GUIDE.md 为知识唯一归宿，state.json 仅存执行元数据。

### dao-commit.md 无为化 *(2026-03-29)*

移除"禁止 AI 自动执行 git commit"显式禁令和"推荐模式"章节。回归原则表达：commit 是用户对历史的主动声明，流程自然引导。

### windsurf-dao 自身接入 TODO.md + AGENT_GUIDE.md *(2026-03-29)*

身教重于言教。windsurf-dao 推广的范式，自身先实践。

### 同步前自审门 *(2026-03-29)*

AGENT_GUIDE.md §三 新增"同步前自审"工作流约定（无为审视 / 知识归位 / 减法确认），固化"修道先于传道"原则。教训 T7：流程约定写进 AGENT_GUIDE.md，不靠"记住"来执行。

### W1: 工作流无为化审查 *(2026-03-29)*

11个工作流全部审查。dao-cycle.md 和 dao-dev.md 两处违反无为原则，其余9个干净。教训：不为减法而减法——“大多数是好的”同样是有价值的结论。

### W2: dao-dev.md 接入知识归位 *(2026-03-29)*

dao-dev.md 涅槃阶段补入“若项目有 AGENT_GUIDE.md，写入演化条目”，与 autopilot 范式一致。

### W3: dao.ps1 sync 变更摘要 *(2026-03-29)*

sync 完成后显示 `git diff --stat` 摘要（源文件有未提交变更时），否则显示最新版本 commit。解决“全 [skip] 无可见性”问题。

### W4: dao.ps1 status 健康状态矩阵 *(2026-03-29)*

`dao.ps1 status`（无参数）扩展为显示所有注册项目的 TODO.md / AGENT_GUIDE.md 存在状态矩阵，便于查看新范式落地情况。

---

## 🎯 当前 Goal · 迁移至 Claude Code CLI *(2026-05-31 起)*

**原始目标**:把 windsurf-dao 整体迁移到 Claude Code CLI,融入社区优秀方案,修复 dao 体系孤岛。理想态——**每次提问会下意识用《道德经》作为规则场域回答**。

**成功标准**:
- `ccswitch/` 成为 Claude Code 侧真相源,`dao.ps1 link-claude` 一键全局部署(symlink + @import),幂等可用。
- 道德经场域 `ccswitch/dao.md` 经 `~/.claude/CLAUDE.md` @import 每条消息常驻。
- 28 skills + 10 workflows + 8 subagents 全部平移,无 Windsurf 专有名残留,交叉引用无断链。
- ~~双栈共存~~ `.devin/` 已于 2026-06-29 退役删除，ccswitch 为唯一真相源。

**四个决策**:① symlink 真相源 ② 借机精简(为道日损,删与 Claude Code 内置 shell/git 安全重叠项) ③ 双栈共存 ④ 续力铁律降级为「路歧则问」(对齐 Claude Code 克制原则)。

**进度**:
- [x] T1 骨架:`ccswitch/{skills,commands,agents}` + `dao.ps1 link-claude`(跑通+幂等验证)
- [x] T2 道德经场域:`ccswitch/dao.md`(486→126 行,砍 74%)+ @import 接通
- [x] T3 skills:37 个全平移(28 dao + 6 rules转skill + windsurf-extension + smoke),frontmatter 全检通过
- [x] T4 commands:11 个(10 workflows 平移)→ `ccswitch/commands/dao-*.md`
- [x] T5 收尾:8 subagents 平移 + stacks 迁移 + 修孤岛 15 项 + 文档更新(README/MIGRATION/USAGE)+ status 双栈显示 + 全量部署(55 链接)+ 端到端验证全绿

**✅ 迁移完成 (2026-05-31)**:Claude Code 侧 skills + commands + agents + stacks 全部就位并 symlink 到 `~/.claude/`,`ccswitch/dao.md` 经 @import 每条消息常驻——理想态「每次提问下意识用道德经回答」已落地。（历史注：当时为双栈共存；Windsurf 侧已于 2026-06-29 退役，`ccswitch/` 为唯一真相源。现状：9 skills + 10 commands，设计管线七合一进 dao-design。）

---

## 🚧 待实现

### LW-1 · 心跳载荷通道的 compaction 连续性实测 *(2026-08-02 挂账 · owner=帅（下一个长窗的开窗者）)*

**背景**：dao.md 瘦身批 #1 把长窗四条（防停摆 / 收官简报铁序 / 在途水位线 / 自主边界）迁进
`ccswitch/rules/dao-longwindow.md` §心跳对账节，投递改为「开窗仪式 Read（第一轮）+ 心跳 prompt 载荷（后续轮）」。

**为什么是欠账而不是缺陷**：叙事 N10 的诚实边界原话是「compaction 会不会清掉已 armed 的心跳，我不知道」——
载荷是搭心跳走的，心跳若被清、载荷同去。**这一段至今零实测**，故上线时就按「未验证」标注，没有当成已确认。

**解冻条件（做完这一件即销账）**：下一个长窗里，**compaction 发生之后的第一轮**自查两件事并把结果写回
`ccswitch/rules/dao-longwindow.md` §📮 投递通道——㈠心跳是否仍 armed；㈡载荷那两句是否仍在 prompt 里。
**两态都要写**（只写成功那态等于没测）。

**在此之前的兜底**：dao.md 帅节存根行的四句留守判据（每句自足，不依赖该文件被读到）。
**若实测为「载荷被清」**：按 git 历史中 `docs/specs/dao-slim-batch-202608.md` 的回退判据处理该项（文件已随 2026-08-12 零清理删除），不是打补丁。

### LW-2 · cron 常驻心跳兜底的 compaction 连续性实测 *(2026-08-09 挂账 · owner=帅（下一个长窗的开窗者）· 出处：PR #208 对抗复核)*

**背景**：issue #194 落地的 `[dao-heartbeat]` cron 常驻心跳兜底（`ccswitch/rules/dao-longwindow.md`
一·开窗节①）与 ScheduleWakeup 一样是 **session-only**——它防的是"殿后心跳因限流/API 错/工具报错/
用户打断没调成"，但它自己扛不扛得住 compaction，与 LW-1 问的是同一个问题，此前一直没有独立编号。

**为什么是欠账而不是缺陷**：cron 兜底本身是 2026-08-08 才试点、当天两次观测都在同一个未经 compaction
的窗口内，"compaction 之后 cron 是否仍在跑"这一段**零实测**。

**解冻条件（做完这一件即销账）**：下一个长窗里，**compaction 发生之后**核实该 session 的
`[dao-heartbeat]` cron 是否仍能触发（可用下一发唤醒的时间戳与预期间隔比对），把结果写回
`ccswitch/rules/dao-longwindow.md` §📮 投递通道 LW-2 这一格。**与 LW-1 各自独立销账**，不因其中一条
测完就假设另一条同态。

**在此之前的兜底**：ScheduleWakeup 心跳（甲①）仍是主驱动，cron 只是补充信道；两路都断才是真正的
零 armed 唤醒。
