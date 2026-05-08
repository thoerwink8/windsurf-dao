---
name: dao-review
description: 代码评审铁律：两阶段评审(spec compliance → code quality),失败方向决定回打到哪一层。普通模块用 reviewer profile,核心模块(支付/认证/安全)派 reviewer-critical。同时含"受国之垢"——接受批评比给批评更难。
---

# 评审 · Review Lens

> 知人者智，自知者明。胜人者有力，自胜者强。
> 受国之垢，是谓社稷主；受国不祥，是为天下王。
> ——《道德经》第 33、78 章

道家把"自知"放在"知人"之上、"自胜"放在"胜人"之上——
**评审最难的不是给批评,是接受批评**。两面都做到才算闭环。

## 铁律

```
不对照 spec 不进入质量评审。
不分级(P0/P1/P2/P3) 不算评审。
不指明回打方向 不算 verdict。
受批评者必逐条回应,不擅自驳回。
```

## 何时激活

- 每个 worker 完成任务后(派 reviewer subagent)
- 自己写的代码声明"完成"前(自审)
- 接 PR / merge 前
- 接收他人 / subagent 评审反馈时

**强制激活**:
- 任何核心模块改动(支付/认证/权限/加密/数据 schema)
- 跨多文件强耦合改动
- 改了关键不变量的代码

## Two-Stage Review · 两阶段评审

来自 Superpowers `subagent-driven-development` 核心:**review 必须分两阶段**,失败方向不同回打到不同层。

```
worker 完成
   ↓
Stage 1: SPEC COMPLIANCE  →  做的是不是 spec 要求的事?
   ↓ PASS
判断:核心模块?
   ├─ 否 → Stage 2 普通版 (reviewer / Sonnet)
   └─ 是 → Stage 2 升级版 (reviewer-critical / Opus High)
   ↓ PASS
进入 finishing
```

### Stage 1 · 知人(对照 spec)

> 知人者智。先看清要做的事,再判它做没做。

**只问一个问题:**做的是不是 spec 要求的事?**

不评价好不好,不挑代码风格,不找 bug。只对照 spec 逐条勾掉。

#### 检查清单

```
□ spec.Files to Change 列的文件,worker 都改了吗?
□ spec.Code Templates 给的代码,worker 是否照搬?(diff 比对)
□ spec.Out of Scope 列的边界,worker 有没有越界?
□ spec.Verification 命令,worker 跑了吗?输出贴了吗?
□ worker 的 Status 是 DONE 吗?(BLOCKED/FAILED 直接打回)
```

**Stage 1 失败 → 直接回打 worker,不进 Stage 2**(没必要评审一个根本没按 spec 做的产物)。

### Stage 2 · 自明(看代码本身)

> 自知者明。深看代码本身,不靠表面。

**问 4 类问题:**

#### 1. 明显 bug(P0)

- 空指针、未处理 error、边界条件遗漏
- 类型不匹配、async 未 await
- 资源未释放(连接/句柄/锁)

#### 2. 测试质量(P1)

- 测试覆盖了主路径吗?
- 测试覆盖了边界条件吗?
- 测试是否在测**行为**还是测**实现**?(测实现 = 脆弱测试)
- 是否有"测试 pass 但啥也没测"的水分测试?

#### 3. 代码风格(P2)

- 命名清晰吗?
- 函数长度 / 嵌套深度合理吗?
- 注释是否多余或缺失?
- 与项目现有风格一致吗?

#### 4. 架构嗅觉(P3)

- 这个改动是否埋了未来债?
- 是否复用了不该复用的抽象?
- 是否引入了不必要的复杂度?(违反 YAGNI)

#### Verdict 输出

```markdown
### Severity Summary
- P0: <count>  (必须修)
- P1: <count>  (应该修)
- P2: <count>  (建议修)
- P3: <count>  (可忽略 / 备记)

### Verdict
- [ PASS ]                → finishing
- [ FAIL - 普通 ]          → 回打 spec-writer(spec 没说清)
- [ FAIL - worker 错 ]    → 回打 worker(spec 已清,worker 没做对)
- [ ESCALATE ]             → 升级 reviewer-critical 或 strategist
```

## 升级判据

升级到 **reviewer-critical** (Opus High):

- ✅ 改动涉及支付 / 认证 / 权限 / 加密 / 存储 schema
- ✅ 改动涉及核心抽象(改一次动全栈)
- ✅ Stage 2 发现 P0 但你不确定根因
- ✅ 改动跨 5+ 文件且强耦合

升级到 **strategist** (Opus XHigh):

- ✅ 你发现"这个 PR 修的不是问题本身,问题在上游"
- ✅ 你发现"这个改动暴露了架构本身的设计缺陷"
- ✅ 同一关键模块第 3 次出现 P0(架构嫌疑)

## 接受批评 · 受国之垢(receiving-code-review)

> 受国之垢，是谓社稷主。能受批评者，方为强者。

接到 review 反馈(无论来自人还是 subagent),按以下流程响应:

### 1. 全读不抢话

读完所有 issue,**先不辩解**。让批评在你脑子里待一会儿。

### 2. 逐条分类

对每条 issue 标注:

- **同意 + 修**:接受,准备改
- **同意但本次不修**:有理由(如范围外),记下来后续做
- **不同意**:你必须给出**反证**(代码 / 文档 / 数据),不只是"我不觉得"

### 3. 修不是辩论

P0 / P1 默认修,不要为"看起来合理但要改的"辩论。**辩论一秒 = 修复一秒,选成本低的**。

### 4. 验证修复(必走 dao-verify)

修完后**必须**重新跑 verification 证据,贴给 reviewer。不允许"应该好了"。

### 5. 闭环回 reviewer

汇总响应:

```markdown
## Response to Review

### Accepted + Fixed
- P0-1 [file:line] → 已改 [commit/diff]
- P1-2 [file:line] → 已改 [commit/diff]

### Accepted, Deferred
- P3-1 [file:line] → 同意但范围外,已开 issue #N

### Disagreed
- P2-1 [file:line] → 不改,因 [反证:文档/数据/代码引用]

### Verification Re-run
$ <跑测试 / 构建>
<完整输出>
Exit code: 0
```

## 反模式表

| 病 | 症状 | 道德经诊断 | 对治 |
|----|------|-----------|------|
| 跳 Stage 1 | 直接看代码质量 | 不知人 | 强制顺序,Stage 1 不过不进 Stage 2 |
| 把 P3 当 P0 | "这里可以更好"标必须修 | 不分级 | 严格按 P0/P1/P2/P3 分类 |
| 只夸不批 | "看起来不错"完事 | 不胜人 | 你的价值是挑刺,不是鼓励 |
| 没行号 | "这里有 bug"不指具体位置 | 不智 | 每条 issue 必含 `[file:line]` |
| Noise 建议 | "可以更好但说不清更好在哪" | 多言数穷 | 删掉,这是噪音 |
| 不指方向 | verdict 是"FAIL"但不说回打谁 | 不智 | 必须明确回打 worker / spec-writer / 升级 |
| 接批评辩论 | 收到 review 第一反应是辩 | 不受垢 | 先读,后分类,慎辩 |
| 修复无证据 | "改好了"不贴新输出 | 假涅槃 | 必走 dao-verify 流程 |
| 反驳无反证 | 不同意但说不出"为什么" | 不强 | 反证(代码/文档/数据)或修 |
| 把 review 看作攻击 | 把 reviewer 当对手 | 失自胜 | reviewer 是镜,不是敌 |

## 涅槃门(每次 review 完成)

### 给评审者的涅槃门

- [ ] Stage 1 / Stage 2 顺序对
- [ ] 每个 issue 有 `[file:line]` 锚点
- [ ] 每个 issue 标了 P0/P1/P2/P3
- [ ] Verdict 明确(PASS / FAIL - 方向 / ESCALATE)
- [ ] 失败的话,回打方向(worker / spec-writer / 升级)清楚

### 接收评审者的涅槃门

- [ ] 全部 P0 + P1 已处理(修 / 同意延后 / 不同意有反证)
- [ ] 修复后重跑 verification,新输出已贴
- [ ] Response 文档完整(Accepted / Deferred / Disagreed 三类齐)
- [ ] 没有"已读不回"的 issue

## 与其他 dao-* 的协作

- **dao-pyramid**:reviewer / reviewer-critical 是金字塔指挥层成员
- **dao-verify**:每次评审反馈、每次修复都必走 verification gate
- **dao-debug**:Stage 2 发现 bug 但根因不清 → 派 debugger 走 4 phases
- **dao-test**:测试质量评审是 Stage 2 的核心维度

## 反原则(保留 dao 风格)

- **不为 review 而 review**——评审是为了交付质量,不是为了表演
- **不为 P 数多而 P 数多**——10 条 P3 不如 1 条 P0
- **批评是镜**——照人也照己
- **被批不是耻**——「受国之垢」才是强者底色
