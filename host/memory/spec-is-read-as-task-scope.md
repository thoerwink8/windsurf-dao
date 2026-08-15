---
name: spec-is-read-as-task-scope
description: 工人把 task-create --spec 的短摘要当任务边界，terminal send 的长任务书里超出 spec 的职责会被当背景略过
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d702bd60-19b9-4036-9ffc-973a75a4c0c8
  modified: 2026-08-15T16:15:42.541Z
---

2026-08-15 PR #505 实测：审官（gpt-5.6-sol）完成技术核验后直接发 worker_done，任务书里明写的四条 PR 侧动作（提交判定行 / `gh pr ready` / 重查 mergeable+CI / 自己 squash 合并）**一条都没做**，PR 上零落痕。

续活追问真因，它自己的原话：

> 上一轮漏做是我误把**派发摘要**理解为仅需完成技术核验，过早发送了 worker_done，并非 gh、沙箱或权限故障。

当时 `--spec` 写的是「短摘要：#505 链C活性判据换真证据 审读」——只有技术目标，没有 PR 侧职责。长任务书走 `terminal send` 直写 TUI，工人读到了，但把 spec 当成权威范围界定。

**Why:** dispatch skill 写着「`--spec` 只用短编排摘要，不是任务指令载体」——那是对协调者说的，工人侧没有这条约定，它看到编排里有一句正式的任务描述，自然当成任务定义。任务书再长也压不过它。

**How to apply:** `--spec` 必须**枚举全部职责类别**，不能只写技术目标。合并权类的单尤其要写进去，例如「审读 + 判定行落 PR + 自合」。另一条更硬的做法：spec 首句写「以终端内长任务书为准」。判断某个职责有没有被执行，不看工人的完工报告怎么说，看**外部可验证的落点**（这次是 `gh pr view --json reviews` 为空）——完工报告说「已完成核验」是真的，只是范围不对。相关：[[green-tests-vs-goal-met]]（报告为真、目标未达）、[[worker-resume-vs-reengage]]（已完工工人续活要新建任务注入原终端，这次照此补做成功）。
