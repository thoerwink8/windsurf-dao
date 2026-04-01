---
description: 自动驾驶模式：AI 自主分解目标、递归执行、反思间隙、语义回退，直到目标完全达成或用户中断。当用户说"自动驾驶"、"autopilot"、"帮我自动完成"时触发。
---

# 自动驾驶 · Autopilot

> 为无为，则无不治。知常曰明，益生曰祥，心使气曰强。

**此工作流是隔离模式**：激活期间 `ask_user_question` 豁免（等同于内观模式），退出后完全恢复正常。

---

## 设计哲学

> TODO.md 是任务图的唯一载体。AGENT_GUIDE.md 是知识的唯一归宿。
> autopilot 不创建平行系统——它直接操作这两个文件。

| 文件 | 角色 | autopilot 行为 |
|------|------|---------------|
| `TODO.md` | 任务图（待做 / 已做） | 读取 `- [ ]` 作为任务源；执行后回写 `- [x]` |
| `AGENT_GUIDE.md` | 演化知识库 | 收尾时追加版本演化条目 |
| `state.json` | 执行元数据（仅回退用） | 只存 commit hash 和 rollback_cmd；完成后删除 |

两个文件不存在时 autopilot **创建**（初始化为标准格式），而非另建 plan.md / archive。

---

## 激活条件

- 用户显式说"自动驾驶"、"autopilot"、"帮我自动完成"
- 用户给出模糊目标，期望 AI 自主推进到完成

---

## 核心原则

| 原则 | 含义 |
|------|------|
| **目标锚** | 原始用户目标是不变的参照系，所有判断都对照它，防止漂移 |
| **单一载体** | TODO.md 是任务的唯一来源和状态，AGENT_GUIDE.md 是知识的唯一归宿，不建平行文件 |
| **任务图** | 任务有依赖关系，不是线性队列；移除一个任务需分析级联影响 |
| **一任务一 commit** | 每个 task 对应一个 git commit，是语义回退的最小单位 |
| **feature branch** | 所有工作在独立分支，主干不受影响 |
| **新鲜用户启发** | 反思时以"只读过原始需求的用户"为视角，防止 AI 完成偏误 |
| **隔离** | 本模式行为只在工作流激活期间有效，不污染全局规则 |

---

## 流程

### 一、激活（☲视 · 建立意图锚）

#### 1.1 初始化项目文件

读取或创建两个核心文件：

**TODO.md**（若不存在则创建）：
```markdown
# [项目名] · TODO

> 任务清单。

## ✅ 已完成

## ❌ 已作废

## 🚧 待实现

```

**AGENT_GUIDE.md**（若不存在则创建）：
```markdown
# [项目名] · Agent 指南

> 活体知识库。每次修改必须记录演化条目。

## 一、项目概览

[待补充]

## 二、演化记录

```

#### 1.2 意图建模

读取 TODO.md 中 `🚧 待实现` 下的 `- [ ]` 条目，结合用户当前目标，建立**意图模型**：

```
原始目标：[用户原话，不改动]
成功标准：[具体可验证的完成条件，与 TODO.md 条目对应]
范围：[本次执行哪些 TODO 条目，ID 列表]
范围外：[明确不做什么]
风险容忍：[从上下文推断：保守/正常/激进]
```

- TODO.md 有对应条目 → 直接映射，保留原 ID（如 `N1`、`F4`）
- 目标是全新内容 → 先在 TODO.md `🚧 待实现` 区追加条目，再映射

小缺失 → AI 自行补全并注明。大缺失（影响方向）→ 一轮 `ask_user_question`。

#### 1.2.1 Open Threads 扫描

如果 TODO.md 存在 `## 🌳 Open Threads` 区域（由 `/thread-tree` 沉淀），扫描其中的 `- [ ]` 条目并按类型前缀分类：

| 前缀 | 权限 | autopilot 行为 |
|------|------|---------------|
| 🔀 | 🔴 红灯 | **绝不自动执行**。跳过，累积到"需人类决策"报告 |
| ✋ | 🟡 黄灯 | 评估置信度：高置信→执行并标注 `⚡ AI assumed` + 理由；低置信→跳过，加入待决报告 |
| 🔨 | 🟢 绿灯 | 纳入任务图，正常自动执行 |

**置信度评估标准**（仅 ✋ 黄灯项）：
- **高置信**：上下文中有强暗示用户倾向某方案，或方案是讨论中的唯一候选
- **低置信**：存在多个未排除的方案，或用户曾表达犹豫

Open Threads 中的 🔨 项与 `🚧 待实现` 中的普通任务同等对待，合并进任务图。

#### 1.3 构建任务图（写入 state.json）

```json
{
  "mode": "autopilot",
  "goal": "[原始目标]",
  "branch": "autopilot/[goal-slug]",
  "started": "[ISO timestamp]",
  "success_criteria": ["标准A", "标准B"],
  "tasks": [
    {
      "id": "N1",
      "desc": "对应 TODO.md 中的描述",
      "todo_line": "- [ ] **N1**: ...",
      "depends_on": [],
      "status": "pending",
      "commit": null,
      "rollback_cmd": null
    }
  ]
}
```

> `todo_line` 记录 TODO.md 中对应行的原文，用于精确定位回写位置。

依赖关系从任务语义推断（"需先完成 X 才能做 Y"）；无明确依赖则设为空。

**分解原则**：
- 每个 Task 是独立的逻辑单元（一个功能、一个模块、一个修复）
- 依赖关系尽量扁平（宽而浅，优于深依赖链）
- Task 粒度：≤ 1 小时工作量，确保 context 内可完成

#### 1.4 创建工作分支

```powershell
git checkout -b autopilot/[goal-slug]

# 确保 state.json 不进入 git 历史
$excludeFile = ".git\info\exclude"
$excludeEntry = ".windsurf/autopilot/"
if (-not (Select-String -Path $excludeFile -Pattern [regex]::Escape($excludeEntry) -Quiet)) {
    Add-Content $excludeFile "`n# autopilot state (generated)`n$excludeEntry"
}
New-Item -ItemType Directory -Force ".windsurf\autopilot" | Out-Null
```

#### 🔒 唯一激活关卡

向用户展示：

```
## 🚗 自动驾驶准备就绪

### 意图模型
目标：[原始目标]
成功标准：
  - [ ] 标准A（对应 TODO.md N1）
  - [ ] 标准B（对应 TODO.md N2）
范围外：[明确不做的事]

### 任务图（共 N 个，来自 TODO.md）
N1 → N2 → N4
N1 → N3 → N4

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
3. Git commit：
   ```powershell
   git commit -m "autopilot([ID]): [task description]"
   ```
4. **回写 TODO.md**：将 `- [ ]` 改为 `- [x]`（定位用 `todo_line` 字段）
5. 更新 `state.json`：`status: "done"`，记录 commit hash 和 rollback_cmd

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
- 有缺口 → 在 TODO.md `🚧 待实现` 追加新条目，加入任务图，继续循环

**防止无限循环**：连续 2 轮 Gap Analysis 后新增 Task 数为 0 且仍有缺口 → 退出并报告，让用户决策。

---

### 三、用户中断（☵坎 · 随时响应）

用户在执行期间发送任何消息：

1. 读取 `state.json` + 当前 `TODO.md` 状态
2. 展示当前进度摘要（TODO.md 中 `[x]` vs `[ ]` 数量即是进度）：
   ```
   ## 📊 自动驾驶当前状态
   完成：N1 N2 N3（3/7，见 TODO.md ✅ 区）
   进行中：N4
   待执行：N5 N6 N7
   
   当前分支：autopilot/[goal-slug]
   ```
3. 处理用户消息（可能是：查看/调整/回退/停止）
4. `ask_user_question`：继续/调整/回退/停止

---

### 四、语义回退（☴巽 · 精确撤除）

用户说"移除 N2 和 N4"时：

#### 4.1 依赖影响分析

```
N2 被移除
  直接影响：N4（依赖 N2）→ 已标记移除
  间接影响：N5（依赖 N2+N3）→ 待重新评估
  无影响：N1 N3 N6
```

展示影响分析，`ask_user_question` 确认移除范围。

#### 4.2 技术回退

```powershell
git revert [N2-commit-hash] --no-edit
git revert [N4-commit-hash] --no-edit
```

#### 4.3 同步 TODO.md

回退后，将 TODO.md 中对应 `- [x]` 改回 `- [ ]`（或标记为 `- [~] 已移除`）。

#### 4.4 目标重推演

移除后重新执行 Gap Analysis：
- 原始目标是否仍可达成（不含 N2 N4）？
- 是 → 追加新 Task 到 TODO.md，继续
- 否 → 告知用户，等待决策

---

### 五、收尾（☶艮 · 涅槃交付）

退出执行循环后：

#### 5.1 最终验证

对照成功标准逐条验证（同 Gap Analysis，但这是最终核查）。

#### 5.2 写入 AGENT_GUIDE.md 演化条目

在 `AGENT_GUIDE.md` 的 `## 二、演化记录` 区域**最前面**插入：

```markdown
### v[X.Y.Z] · [日期] · [目标摘要]

**变更**：
- [文件]: [具体改动描述]
- [文件]: [具体改动描述]

**根因**：
- [为什么做这些改动，原来的问题是什么]

**教训**：
- [这次执行中发现的可复用经验]
```

> 版本号规则：若项目有 `package.json` 则读取并递增 patch 版本；否则按日期格式 `YYYY.MM.DD`。

#### 5.3 最终报告

```
## 🏁 自动驾驶完成

### 原始目标
[用户原话]

### 完成情况（见 TODO.md）
✓ 已完成：N1 N2 N3 N5（共 4 个，已标记 [x]）
～ 已移除：N4（用户决策，已标记 [~]）
✗ 未完成：N6（blocked，已保留 [ ] 待下次）

### Open Threads 处理（若有）
🟢 已执行：🔨 [任务标题]（已标记 [x]）
🟡 已推进：✋ [确认项]（⚡ AI assumed：[理由]，请验证）
🔴 需你决策：🔀 [决策项]（未触碰，仍为 [ ]）

### 成功标准验证
✓ 标准A：[验证方式 + 结果]
✓ 标准B：[验证方式 + 结果]

### 工作产物
分支：autopilot/[goal-slug]
Commits：[hash 列表]
合并到主干：git merge autopilot/[goal-slug] --no-ff

### 撤销整个 autopilot 的方式
git checkout main && git branch -D autopilot/[goal-slug]
```

`ask_user_question`：合并到 main / 继续完善 / 回退某些任务 / 保持现状

#### 5.4 清理

```powershell
# 删除执行元数据（任务状态已在 TODO.md，知识已在 AGENT_GUIDE.md）
Remove-Item ".windsurf\autopilot\state.json"
```

**退出自动驾驶模式，ask_user_question 规则恢复正常。**

---

### 六、跨 Session 恢复

如果 session 中断，下次对话开始时：

1. 检查 `.windsurf/autopilot/state.json` 是否存在
2. 有 → 读取 state.json + TODO.md 当前状态，告知用户：
   ```
   检测到未完成的自动驾驶任务（目标：[...]）
   TODO.md 进度：N/M 已完成（见 [x] 数量）
   ```
3. `ask_user_question`：继续 / 查看进度 / 放弃

恢复执行时：从第一个 `status: pending` 且依赖已满足的 Task 继续（state.json 与 TODO.md 双重确认）。

---

## 文件规范

### 目录结构

```
项目根/
├── TODO.md              ← 任务图（激活前存在或新建，永久保留）
├── AGENT_GUIDE.md       ← 知识库（激活前存在或新建，永久保留）
└── .windsurf/
    └── autopilot/
        └── state.json   ← 执行元数据（激活期间存在，完成后删除）
```

`.windsurf/autopilot/` 通过 `.git/info/exclude` 本地排除，不进入 git 历史。

### `state.json`（仅执行元数据，不含任务定义）

```json
{
  "mode": "autopilot",
  "goal": "[原始目标]",
  "branch": "autopilot/[goal-slug]",
  "started": "[ISO timestamp]",
  "success_criteria": ["标准A", "标准B"],
  "tasks": [
    {
      "id": "N1",
      "todo_line": "- [ ] **N1**: ...",
      "status": "done|pending|blocked|removed",
      "commit": "abc123",
      "rollback_cmd": "git revert abc123 --no-edit"
    }
  ]
}
```

> **注意**：任务描述、依赖关系、完成状态的权威来源是 `TODO.md`。`state.json` 仅记录 commit hash 以支持回退。

---

## 任务评分标准（决定是否自动执行）

| 维度 | 3 | 2 | 1 | 0 |
|------|---|---|---|---|
| **相关性** | 达成原始目标必须 | 直接改善目标 | 松散相关 | 不相关 |
| **可逆性** | 完全可逆（加代码） | 基本可逆（有依赖） | 难以逆转 | 不可逆 |
| **置信度** | 明确要求/强烈暗示 | 合理推断 | 不确定 | 纯猜测 |

**自动执行**：相关性 ≥ 2 AND 可逆性 ≥ 1 AND 置信度 ≥ 2

其余 → 追加到 TODO.md 候选区，不自动执行，最终报告时呈现给用户。

---

## 反模式

| 病 | 对治 |
|----|------|
| 目标漂移（执行中忘记原始目标） | 每次 Gap Analysis 重读原始目标原文 |
| 完成偏误（AI 觉得完成了但没有） | 新鲜用户测试 + 成功标准逐条验证 |
| 无限延伸（不断生成新任务） | 连续 2 轮无缺口新增 → 强制退出 |
| 双重追踪（另建 plan.md / archive/） | TODO.md 是唯一任务载体，禁止创建平行任务文件 |
| 知识遗失（执行完不写演化记录） | 5.2 写 AGENT_GUIDE.md 是强制步骤，不可跳过 |
| 全局污染（autopilot 行为渗漏到正常对话） | 退出时删除 state.json，ask_user_question 规则恢复 |
| 越权执行（自动决策 🔀 红灯项） | 严格按 1.2.1 权限表：🔀 绝不碰，✋ 需标注假设，🔨 才可自动 |
