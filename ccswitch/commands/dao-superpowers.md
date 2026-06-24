---
description: 五步工程仪式——隔离 worktree → 写 plan → 派 implementer → 派 reviewer → 归根 cleanup。代码类核心改动的标准化流程。与 /dao-dev（从需求到交付的全管线）形成"术 vs 道"互补。适合：核心重构、复杂 bug、架构级改动、多文件协调修改。
---

# 工程仪式 · Five-Step Pipeline

> 致虚极，守静笃。万物并作，吾以观复。——《道德经》第 16 章
>
> 慎终如始，则无败事。——第 64 章
>
> 受国之垢，是谓社稷主；受国不祥，是为天下王。——第 78 章

工程仪式 = obra superpowers 五步的 dao 本地化实现。心怀八句根基，按"虚→谋→造→审→归"五步走。

## 触发条件

### 显式触发（强信号 · 必走五步）

- 用户口头：「走 superpowers」「开 worktree 走」「走完整流程」「派 subagent」「启 dao 五步」
- 用户引用任一 dao 五步 skill 名（dao-worktree / dao-plan / dao-review）
- 用户输入 `/dao-superpowers`

### 复杂度触发（弱信号 · SHOULD 主动建议）

满足任一即应主动建议：「这事满足 X 条件，建议走 superpowers，要不要？」

- ≥3 文件改动
- ≥100 LOC 净增
- 涉及核心模块（auth / payment / security / core orchestration / 多端共享逻辑）
- 跨语言 / 跨服务边界
- 不可逆操作（DB migration / schema change / config wipe / 删除生产数据）
- 涉及双轨/多轨架构归一

用户拒绝即走轻量路径。详见 `ccswitch/dao.md` superpowers-gate 段。

## 与 /dao-dev 的差异（重要 · 别选错入口）

| 维度 | `/dao-dev` | **`/dao-superpowers`** |
|---|---|---|
| 切面 | 道（哲学三阶九步：析→设→编→筑→部→试→验→书） | 术（工程五步：worktree→plan→execute→review→finish） |
| 适用 | 从需求到交付的完整管线（含 UI 嗢架、文档生成等） | 代码类核心改动的标准化流程 |
| 含 UI/前端嗢架 | 是（基建审计 + 前端处方） | 否（纯代码改动） |
| 含文档生成 | 是（书阶段调 /dao-doc） | 否（commit 信息够用） |
| 产出关卡 | 🔒×3（方向 / 预览 / 验收） | worktree+plan+review+finish |
| 哲学源 | 道生一、一生二、二生三 | 致虚守静观复 + 受国之垢 |
| 适合任务 | 新功能、跨多层级改动、初创项目 | 核心重构、复杂 bug、架构归一、关键模块改动 |

**选哪个**：
- 任务包含"做一个新功能/页面/界面" → `/dao-dev`
- 任务包含"重构/修复/归一/优化代码" → `/dao-superpowers`
- 不确定？两个都适用 → `/dao-dev`（更全面，含 superpowers 步骤的精神）

## 五步详细

### 一·隔（dao-worktree · 致虚极守静笃）

> 把工作隔进沙盒，不污染主线。

**announce**：「开始 dao-superpowers 第 1 步 · 隔离 worktree」

```bash
# 优先 ~/.config/superpowers/worktrees/<topic>/，回落 .worktrees/<topic>/
git worktree add ~/.config/superpowers/worktrees/<topic> -b <topic-branch>

# !!! 干净进场（参 e163 教训）
cd ~/.config/superpowers/worktrees/<topic>
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
npm install --no-audit --no-fund

# 测试基线必须全绿才开工
npm test
```

详见 `dao-worktree` skill。

### 二·谋（dao-plan · 不知常妄作凶）

> 写出 plan 让用户审批。

**announce**：「开始 dao-superpowers 第 2 步 · 写 plan」

#### 2.0 · 形（dao-design-open 读取）⭐

> 道法自然。设计已成，代码当如水就形。——《道德经》第 25 章

**触发**：UI/视觉相关任务且项目有 `design/` 目录（Open Design 产出），先过 `dao-design-open` §1 读取设计资产，再写 plan。

**announce**：「开始 dao-superpowers 第 2.0 步 · 形（读取设计资产）」

```
dao-design-open §1 读取：
  1. 读 design/css/<project>.css — 提取设计系统（token/组件/布局）
  2. 读目标页面 design/*.html — 提取结构/视觉/交互规格
  3. 读 *.artifact.json — 确认页面状态（complete 才翻译）
  → 产出：设计系统速查 + 页面翻译清单 → 喂给 2.1 写 plan
```

**无 `design/` 目录时**：跳过本步，直接进 2.1 写 plan。

#### 2.1 · 写 plan

```
位置：docs/specs/<topic>-plan.md
内容：
  - 元信息（创建日期、触发、状态、文件改动估计）
  - 目标与范围（MVP / Nice-to-have / 不做）
  - 文件清单（路径 + 改动类型 + 关键内容点）
  - 风险与缓解
  - 验收条件
  - 执行顺序
  - UI 任务额外：plan 第一句话必须 "读 _tmp/design-tokens-<topic>.json"
```

**🔒 关卡**：plan 写完必须用户审批，不得跳过。

详见 `dao-plan` skill。

### 三·造（上善若水勤而行之）

> 按 plan 逐 task 执行，task 间 checkpoint。

**announce**：「开始 dao-superpowers 第 3 步 · 执行第 N 个 task」

```
逐 task：
  - 实施前 announce 当前 task
  - 实施中：写代码 + 跑测试（红→绿→refactor）
  - 实施后：fresh 验证（参 dao-verify）
  - task 间 checkpoint：让用户随时可调

subagent 调度（按需）：
  - 满足 ≥3 项才派（模板化? 不同模型? context 臃肿? rate limit 有预算? 值 15× token? 可并行?）
  - 否则主会话直接做（更快，无 rate limit 风险）
```

### 四·审（dao-review · 受国之垢）

> 接受批评是 master。普通模块用 reviewer，核心模块派 reviewer-critical。

**announce**：「开始 dao-superpowers 第 4 步 · 派 reviewer」

```
三阶段 review：
  1. spec compliance：是否实现了 plan 里的所有点？
  2. code quality：代码质量、命名、错误处理、边界
  3. visual compliance（UI 任务必加）：过 dao-design-open §4 验证——
     截图对比 Open Design 原型 vs 项目渲染，三维检查（结构/视觉/交互）。
     以 design/ 目录为唯一视觉真相源。

派活：
  - 普通模块 → reviewer profile
  - 核心模块 (auth/payment/security/core) → reviewer-critical profile
  - UI 模块 → reviewer 额外负责 visual compliance（过 §6，看真实渲染不是只看 git diff）
```

如 review 不通过，按"升级路径"回打到对应阶段：spec 不清→plan-writer / 需求不明→brainstormer / **视觉不达标→修代码或修 token**。

**铁律**：UI 任务跳 visual compliance review = 跳 reviewer，不可。原因：reviewer agent 看 git diff 看不见真实渲染，视觉断层 / a11y / 组件裂痕只在 preview 里暴露——故必过 §6 的 preview 验收。

详见 `dao-review` skill。

### 五·归（功遂身退）

> 完工即归根，不留死 worktree。

**announce**：「开始 dao-superpowers 第 5 步 · 归根」

**前置关卡**（UI 任务专需）：归根前必过 `dao-design-open` §4 验证（截图对比 + 三维对齐检查）。未过 = 未闭环，不可进本步。

```
四选一：
  A. 成果合入主分支：
     git checkout master && git merge <topic-branch>
     git worktree remove ~/.config/superpowers/worktrees/<topic>
     git branch -d <topic-branch>

  B. 走 PR 流程（远程 review）：
     git push origin <topic-branch>
     gh pr create --base master --title ... --body ...
     等 PR merge 后再清理 worktree

  C. 保留待续：worktree 暂存（罕见）

  D. 丢弃：
     git worktree remove --force ~/.config/superpowers/worktrees/<topic>
     git branch -D <topic-branch>
```

**铁律**：不可直推 master。merge / PR 二选一，仪式必走。

## 反模式

详见 `ccswitch/dao.md` superpowers-gate 段反模式表。核心几条：

| 病 | 对治 |
|---|---|
| 任务太小论 | 显式触发 = 流程承诺，与代码量无关 |
| 路径偷懒 | 必须 `docs/specs/<topic>-plan.md` 标准位置 |
| 跳 reviewer | reviewer subagent 是质量门；自检不算 |
| **UI 任务跳 visual compliance** | reviewer 只看 git diff 看不见真实渲染；UI 任务必过 dao-design-open §4 验证（截图对比 + 三维对齐） |
| **未过验证直进 finish** | UI 任务归根前必过 dao-design-open §4，未过 = 开环 = 后续新盲点 |
| 直推 master | merge / PR 二选一，仪式必须 |
| node_modules 继承污染 | worktree 首次 install 前必 rm -rf node_modules（参 e163） |

## 与 superpowers-gate 规则的协同

| 文件 | 角色 | 触发机制 |
|---|---|---|
| `ccswitch/dao.md` superpowers-gate 段 | 触发判定 + 反模式约束 | 随 dao.md 注入自动加载 |
| **本 command** | 主动唤起 + 步骤模板 | `/dao-superpowers` slash |

rule 是"什么时候走 + 不能怎么走"，command 是"怎么一步步走"。两者互补，不冲突。

## 反原则

- **不为五步而五步**——单文件 typo 不必走五步
- **不替代 /dao-dev**——新功能/新页面/含完整基建审计的任务走 /dao-dev；本 command 聚焦「现有代码核心改动」，含视觉对齐（2.0 步会自动读取 Open Design 资产）
- **不并行五步**——一步完成才进下一步，不可跳过
- **不跳 2.0 读取**——UI 任务有 design/ 目录时必先过 dao-design-open §1 读取设计资产，AI 不自行做设计判断

法不违德，德不违道，道法自然。
