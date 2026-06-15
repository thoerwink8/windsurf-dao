---
name: dao-finish
description: 开发分支收尾铁律：所有 Task 完成 + review 通过后,决定集成方式(merge / PR / keep / discard 四选一)。必走 verification + cleanup worktree。"功遂身退,天之道"——完工即退,不逗留,不占资源。
---

# 收 · Finishing Lens

> 功遂身退，天之道。
> 持而盈之，不如其已。
> ——《道德经》第 9 章

道家把"退"放在"成"之后——成就完了就退出,不赖着。
持续注水的杯子终会溢出;完工不清理的分支终会变成技术债。
**完工 = 归根**,分支该归主线,worktree 该删,临时物该清。

## 铁律

```
不过 dao-review,不进 finish。
不决定 merge/PR/keep/discard 路线,不算 finish。
不跑最终 verification,不敢宣布完工。
worktree 不 remove,task 不算结束。
```

## 何时激活

- dao-execute 所有 Task 完成
- dao-review 两阶段评审全 PASS
- 用户显式说"结束 / 收尾 / 收工"
- /dao-dev §三·成·书 最后阶段

**不激活**:
- 还有未完成 Task(回 dao-execute)
- dao-review 有未修的 P0/P1(回 worker / spec-writer)
- verification 未过(回 dao-verify)

## 入参(必须)

```
□ dao-execute 所有 Task 已 DONE + 贴 verification 证据
□ dao-review 两阶段全 PASS(或所有 P0/P1 已修)
□ 所有改动已在本地 commit(未 push 无所谓,但 working tree 必须干净)
□ 所属分支 / worktree 位置清晰
```

未满足 → 回对应阶段。

## 四选一路线

完工后**必须**在以下四种之一做决策。不允许"先放着":

```
┌─────────────────────────────────────────────────────┐
│ 选项 A: MERGE(合入主分支)                           │
│   场景:个人项目 / 小团队 / 无需 review              │
│   动作:                                             │
│     1. git checkout main                            │
│     2. git merge <feature-branch> (或 rebase)       │
│     3. 跑主分支测试确认全绿                         │
│     4. git branch -d <feature-branch>               │
│     5. git worktree remove <feature-worktree>       │
│   归根 = 分支回主线 + worktree 删除                 │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ 选项 B: PR(走审批流程)                             │
│   场景:团队项目 / 需他人 review / 生产代码          │
│   动作:                                             │
│     1. git push origin <feature-branch>             │
│     2. 开 PR(gh pr create 或 web)                 │
│     3. 填 PR 描述(派 plan-writer 写,含背景/目标/测试)│
│     4. worktree 保留到 PR merge 后                  │
│     5. PR merge 后:git worktree remove + 删分支     │
│   归根 = PR 合入后清理                              │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ 选项 C: KEEP(保留分支不合)                         │
│   场景:实验性 / 长期存在的 WIP / 依赖未成熟         │
│   动作:                                             │
│     1. 写 BRANCH-NOTES.md(为何保留 + 什么时候合)   │
│     2. worktree 可留,但须记录                      │
│     3. 加日历提醒(2 周后 review 是否仍保留)        │
│   归根 = 记录保留原因,不让分支变成孤儿               │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ 选项 D: DISCARD(丢弃)                              │
│   场景:实验失败 / 方向错了 / 被更好方案替代         │
│   动作:                                             │
│     1. 记录教训(可写 evolution-lessons)            │
│     2. git worktree remove --force <worktree>       │
│     3. git branch -D <feature-branch>               │
│     4. 如已 push:git push origin --delete           │
│   归根 = 失败也是归根,不占资源不留尾巴              │
└─────────────────────────────────────────────────────┘
```

### 决策判据

| 场景 | 选哪个 |
|------|--------|
| 个人项目 / 已全验证 | A (merge) |
| 团队项目 / 需 review | B (PR) |
| 还在实验 / 依赖未就绪 | C (keep) + 记录 |
| 方向错 / 被替代 | D (discard) + 教训 |
| 不确定 | 问用户,不要默认 |

## 最终 verification(必跑)

选任一路线前,**必跑一次完整验证**:

```bash
# 1. 跑全测试
<test command>
# exit 0? 否则回 dao-execute 修

# 2. 跑构建
<build command>  
# exit 0? 否则回 dao-debug

# 3. 关键路径手动 smoke test
<end-to-end 关键流程>
# 功能正常?

# 4. git 状态
git status          # 必须 clean
git log --oneline -5  # 看最近 commit 历史清晰
```

任一失败 = **不进 finish**,回对应阶段。

## Cleanup 清单(归根)

不管选 A/B/D(C 除外),完成后检查:

```
□ 本地分支已删(git branch -d)
□ worktree 已 remove(git worktree list 确认)
□ 远端分支已删(如 push 过)
□ 本地 _tmp / _scratch 无遗留
□ docs/specs/<topic>-{design,plan}.md 保留(作历史记录)
□ evolution-entries.csv 有 entry(重大产出)
□ AGENT_GUIDE 有更新(如引入新架构/约定)
```

## 反模式表

| 病 | 症状 | 道德经诊断 | 对治 |
|----|------|-----------|------|
| 不过 review 就合 | 跳过 dao-review | 慎终反 | 必过 review |
| 死分支 | feature 分支永不 merge 也不 delete | 不身退 | 选 KEEP 必记录,或选 DISCARD |
| 死 worktree | task 完了 worktree 不删 | 不归根 | 必 git worktree remove |
| 合完不删分支 | merge 后 feature branch 还在 | 不慎终 | git branch -d 立即 |
| 含糊 merge | main 合入前不跑测试 | 不慎终如始 | 必跑主分支测试 |
| 空 PR 描述 | PR 只写"see diff" | 多言数穷反 | 5 段式必填 |
| 丢弃不留教训 | DISCARD 不记 evolution | 企者不立 | 失败也是教训 |
| 永远 keep | 说"先留着"然后忘了 | 不知止 | KEEP 必加 review 日期 |

## 涅槃门(工作真的结束前)

- [ ] dao-review 两阶段全 PASS
- [ ] 最终 verification 全跑过(test + build + smoke)
- [ ] 四选一决策已做(A/B/C/D 显式选一)
- [ ] Cleanup 清单全过
- [ ] 教训 / 架构变化已写入 evolution / AGENT_GUIDE

全过 = 真正的涅槃。**不再"差不多"**。

## 与其他 dao-* 协作

```
dao-execute (所有 Task DONE)
   ↓
dao-review (两阶段 PASS)
   ↓
dao-verify (最终 verification)
   ↓
dao-finish (你) ── 四选一 ── merge/PR/keep/discard
   ↓
dao-worktree cleanup + evolution 记录 + AGENT_GUIDE 更新
   ↓
🏁 涅槃(真正结束)
```

## 反原则(保留 dao 风格)

- **功遂身退**——完工即退出,不赖着说"我改的很好你看"
- **不为仪式而仪式**——个人快速脚本不必走 PR,选 A merge 就好
- **不合就不合**——KEEP 也是一种完成,只要记录原因
- **DISCARD 不是失败**——及时认错是强者,"持而盈之"反而崩盘
- **留痕不留尾**——记录教训可留,无用代码不留

