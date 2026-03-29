---
description: 自动驾驶模式：AI 自主分解目标、递归执行、反思间隙、语义回退，直到目标完全达成或用户中断。当用户说"自动驾驶"、"autopilot"、"帮我自动完成"时触发。
---

# 自动驾驶 · Autopilot

> 为无为，则无不治。知常曰明，益生曰祥，心使气曰强。

**此工作流是隔离模式**：激活期间 `ask_user_question` 豁免（等同于内观模式），退出后完全恢复正常。

---

## 激活条件

- 用户显式说"自动驾驶"、"autopilot"、"帮我自动完成"
- 用户给出模糊目标，期望 AI 自主推进到完成

---

## 核心原则

| 原则 | 含义 |
|------|------|
| **目标锚** | 原始用户目标是不变的参照系，所有判断都对照它，防止漂移 |
| **任务图** | 任务有依赖关系，不是线性队列；移除一个任务需分析级联影响 |
| **一任务一 commit** | 每个 task 对应一个 git commit，是语义回退的最小单位 |
| **feature branch** | 所有工作在独立分支，主干不受影响 |
| **新鲜用户启发** | 反思时以"只读过原始需求的用户"为视角，防止 AI 完成偏误 |
| **隔离** | 本模式行为只在工作流激活期间有效，不污染全局规则 |

---

## 流程

### 一、激活（☲视 · 建立意图锚）

#### 1.1 意图建模

解析用户的模糊目标，建立**意图模型**：

```
原始目标：[用户原话，不改动]
成功标准：[具体可验证的完成条件，逐条列出]
范围边界：[明确不做什么]
风险容忍：[从上下文推断：保守/正常/激进]
```

小缺失 → AI 自行补全并注明。大缺失（影响方向）→ 一轮 `ask_user_question`。

#### 1.2 任务图分解

将目标分解为颗粒化任务，建立依赖关系：

```json
{
  "tasks": [
    {
      "id": "T1",
      "desc": "...",
      "depends_on": [],
      "produces": ["文件/功能/接口"],
      "status": "pending",
      "commit": null,
      "rollback_cmd": null
    },
    {
      "id": "T2",
      "desc": "...",
      "depends_on": ["T1"],
      "produces": ["..."],
      "status": "pending",
      "commit": null,
      "rollback_cmd": null
    }
  ]
}
```

**分解原则**：
- 每个 Task 是独立的逻辑单元（一个功能、一个模块、一个修复）
- 依赖关系尽量扁平（宽而浅，优于深依赖链）
- Task 粒度：≤ 1 小时工作量，确保 context 内可完成

#### 1.3 创建工作环境

```powershell
# 创建 feature branch（命名：autopilot/[goal-slug]-[date]）
git checkout -b autopilot/[goal-slug]

# 创建状态目录，并确保被 git 本地排除
New-Item -ItemType Directory -Force ".windsurf\autopilot" | Out-Null

# 将 .windsurf/autopilot/ 加入 .git/info/exclude（避免状态文件被追踪）
$excludeFile = ".git\info\exclude"
$excludeEntry = ".windsurf/autopilot/"
if (-not (Select-String -Path $excludeFile -Pattern [regex]::Escape($excludeEntry) -Quiet)) {
    Add-Content $excludeFile "`n# autopilot state files (generated, not for tracking)`n$excludeEntry"
}
# .windsurf/autopilot/state.json — 机器可读，驱动执行
# .windsurf/autopilot/plan.md — 人类可读，用户随时可查
```

#### 🔒 唯一激活关卡

向用户展示：

```
## 🚗 自动驾驶准备就绪

### 意图模型
目标：[原始目标]
成功标准：
  - [ ] 标准A
  - [ ] 标准B
范围外：[明确不做的事]

### 任务图（共 N 个）
T1 → T2 → T4
T1 → T3 → T4 → T5

### 工作分支：autopilot/[goal-slug]

→ 确认后开始，过程中静默执行，发任何消息可中断查看进度
```

用户确认 → 进入执行循环
用户调整 → 修订后重新确认

---

### 二、执行循环（☳触 · 静默推进）

> 大音希声。善行无辙迹。

**激活期间：不发 chat 消息，不调用 ask_user_question。进度只写文件。**

#### 2.1 单任务执行

对每个 `status: pending` 且依赖已满足的 Task：

1. 执行任务（编码/构建/测试，视任务而定）
2. 验证任务结果（构建通过、功能可运行）
3. Git commit（一个 Task = 一个 commit）：
   ```powershell
   # commit message 包含 Task ID，便于后续 cherry-pick
   git commit -m "autopilot(T[N]): [task description]"
   ```
4. 更新 `_autopilot_state.json`：
   - `status: "done"`
   - `commit: "[hash]"`
   - `rollback_cmd: "git revert [hash] --no-edit"`

#### 2.2 错误处理

| 错误类型 | 行为 |
|---------|------|
| 可恢复（构建失败、小 bug）| 自动修复，记录日志，继续 |
| 需判断（需求歧义，多种可行路径） | 跳过此 Task，标记 `blocked`，继续其他 Task |
| 系统级阻断（核心依赖缺失） | 写 checkpoint，**主动发消息**告知用户，等待 |
| Risk ≥ 2（不可逆操作） | 暂停，**必须**用户确认后才执行 |

#### 2.3 间隙分析（Gap Analysis）—— 每轮结束后

每完成一批 Task 后，AI 执行反思：

**新鲜用户测试**：
> "如果一个只读过原始目标的用户，现在看到系统/代码，他会说'是的，这就是我要的'吗？"

逐条检查成功标准：

```
✓ 标准A：[已达成/未达成/部分]
✗ 标准B：[缺口描述]
？标准C：[不确定，需要...]
```

- 全部 ✓ → 退出循环，进入「收尾」
- 有缺口 → 生成 Round N+1 Task，加入任务图，继续循环

**防止无限循环**：连续 2 轮 Gap Analysis 后新增 Task 数为 0 且仍有缺口 → 退出并报告，让用户决策。

---

### 三、用户中断（☵坎 · 随时响应）

用户在执行期间发送任何消息：

1. 读取 `_autopilot_state.json` + `_autopilot_log.md`
2. 展示当前进度摘要：
   ```
   ## 📊 自动驾驶当前状态
   完成：T1 T2 T3（3/7）
   进行中：T4
   待执行：T5 T6 T7
   已跳过/阻塞：（无）
   
   最近完成：T3 - [task description]
   当前分支：autopilot/[goal-slug]
   ```
3. 处理用户消息（可能是：查看/调整/回退/停止）
4. `ask_user_question`：继续/调整/回退/停止

---

### 四、语义回退（☴巽 · 精确撤除）

用户说"移除 T2 和 T4"时：

#### 4.1 依赖影响分析

```
T2 被移除
  直接影响：T4（依赖 T2）→ 已标记移除
  间接影响：T5（依赖 T2+T3）→ 待重新评估
  无影响：T1 T3 T6
```

展示影响分析，`ask_user_question` 确认移除范围。

#### 4.2 技术回退

```powershell
# 方法：git revert（保留历史，可追溯）
git revert [T2-commit-hash] --no-edit
git revert [T4-commit-hash] --no-edit

# 如果依赖 T2 的 T5 也需要移除：
git revert [T5-commit-hash] --no-edit
```

#### 4.3 目标重推演

移除后，AI 重新执行 Gap Analysis：
- 原始目标 G 是否仍可达成（不含 T2 T4）？
- 是 → 哪些新 Task 填补缺口？加入任务图继续
- 否 → 告知用户："移除 T2 T4 后，成功标准 B 无法达成，需要重新讨论目标或保留 T2"

---

### 五、收尾（☶艮 · 涅槃交付）

退出执行循环后：

#### 5.1 最终验证

对照成功标准逐条验证（同 Gap Analysis，但这是最终核查）。

#### 5.2 最终报告

```
## 🏁 自动驾驶完成

### 原始目标
[用户原话]

### 完成情况
✓ 已完成：T1 T2 T3 T5（共 4 个）
～ 已移除：T4（用户决策）
✗ 未完成：T6（blocked，原因：...）

### 成功标准验证
✓ 标准A：[验证方式 + 结果]
✓ 标准B：[验证方式 + 结果]

### 工作产物
分支：autopilot/[goal-slug]
Commits：[hash 列表]
合并到主干：git merge autopilot/[goal-slug] --no-ff

### 待用户决策
- [ ] 候选任务（低评分，未自动执行）：[列表]
- [ ] 是否合并分支到 main？
- [ ] 是否删除工作分支？

### 撤销整个 autopilot 的方式
git checkout main
git branch -D autopilot/[goal-slug]
```

5. `ask_user_question`：合并到 main / 继续完善 / 回退某些任务 / 保持现状

#### 5.3 清理

```powershell
# 将 plan.md 归档（保留历史记录）
$archiveDir = ".windsurf\autopilot\archive\[goal-slug]-[date]"
New-Item -ItemType Directory -Force $archiveDir | Out-Null
Move-Item ".windsurf\autopilot\plan.md" "$archiveDir\plan.md"

# 删除状态文件
Remove-Item ".windsurf\autopilot\state.json"
```

**退出自动驾驶模式，ask_user_question 规则恢复正常。**

---

### 六、跨 Session 恢复

如果 session 中断，下次对话开始时：

1. 检查 `.windsurf/autopilot/state.json` 是否存在
2. 有 → AI 读取状态，告知用户：
   ```
   检测到未完成的自动驾驶任务（目标：[...]，进度：N/M）
   ```
3. `ask_user_question`：继续 / 查看进度 / 放弃

恢复执行时：从第一个 `status: pending` 且依赖已满足的 Task 继续。

---

## 文件规范

### 目录结构

```
.windsurf/autopilot/
├── state.json      ← 激活期间存在，完成后删除
├── plan.md         ← 激活期间存在，完成后移入 archive
└── archive/
    └── [goal-slug]-[date]/
        └── plan.md ← 永久保留，历史记录
```

`.windsurf/` 已通过 `.git/info/exclude` 本地排除，状态文件不会进入项目 git 历史，项目根目录保持干净。

### `.windsurf/autopilot/state.json`（机器可读，驱动执行）

```json
{
  "mode": "autopilot",
  "version": 1,
  "goal": "[原始目标]",
  "branch": "autopilot/[goal-slug]",
  "started": "[ISO timestamp]",
  "intent_model": {
    "success_criteria": ["标准A", "标准B"],
    "out_of_scope": ["不做什么"],
    "risk_tolerance": "normal"
  },
  "tasks": [
    {
      "id": "T1",
      "desc": "...",
      "depends_on": [],
      "produces": [],
      "status": "done|pending|blocked|removed",
      "commit": "abc123",
      "rollback_cmd": "git revert abc123 --no-edit",
      "round": 1
    }
  ],
  "rounds_completed": 1,
  "gap_analysis_history": []
}
```

### `.windsurf/autopilot/plan.md`（人类可读，用户随时查阅）

```markdown
# Autopilot Plan
## 原始目标
[用户原话]

## 成功标准
- [ ] 标准A
- [x] 标准B（已达成）

## 任务图
### Round 1
- [x] T1: ... | commit: abc123 | 回退: git revert abc123 --no-edit
- [x] T2: ... | commit: def456 | 回退: git revert def456 --no-edit
- [~] T3: ... | 已移除（用户决策）

### Round 2（Gap 填补）
- [ ] T4: ... | 待执行

## 候选任务（未自动执行，供用户决策）
- T-C1: ... | 评分低（相关性1，置信度1）

## Gap Analysis 历史
### Round 1（完成后）
缺口：标准A未达成，原因...
新增：T4
```

---

## 任务评分标准（决定是否自动执行）

| 维度 | 3 | 2 | 1 | 0 |
|------|---|---|---|---|
| **相关性** | 达成原始目标必须 | 直接改善目标 | 松散相关 | 不相关 |
| **可逆性** | 完全可逆（加代码） | 基本可逆（有依赖） | 难以逆转 | 不可逆 |
| **置信度** | 明确要求/强烈暗示 | 合理推断 | 不确定 | 纯猜测 |

**自动执行**：相关性 ≥ 2 AND 可逆性 ≥ 1（≤ 2 即风险可接受）AND 置信度 ≥ 2

其余 → 写入候选任务，不自动执行，最终报告时呈现给用户。

---

## 反模式

| 病 | 对治 |
|----|------|
| 目标漂移（执行中忘记原始目标） | 每次 Gap Analysis 重读原始目标原文 |
| 完成偏误（AI 觉得完成了但没有） | 新鲜用户测试 + 成功标准逐条验证 |
| 无限延伸（不断生成新任务） | 连续 2 轮无缺口新增 → 强制退出 |
| 隐式依赖（Task 看似独立实则不是） | 建立任务图时显式声明 produces/depends_on |
| 全局污染（autopilot 行为渗漏到正常对话） | 退出时清理状态文件，ask_user_question 规则恢复 |
