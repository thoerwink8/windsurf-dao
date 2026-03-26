# 迁移指南 · 将 windsurf-dao 规则复制到目标项目

> 善行无辙迹。

## 前提

windsurf-dao 是**元层规则源**（道/德/法/术 + 通用 skills/workflows），目标项目有自己的**操作层规则**（代码规范、样式约定、项目特定工作流等）。两层正交，互不覆盖。

## 核心架构

```
.windsurf/                      # 统一 AI 配置目录
├── rules/
│   ├── dao-*.md               # dao 元层（本地忽略，不入 git）
│   └── *.md                   # 项目操作层（git 追踪）
├── skills/
│   ├── dao-*/                 # dao skills（本地忽略）
│   └── */                     # 项目 skills（git 追踪）
└── workflows/
    ├── dao-*.md               # dao workflows（本地忽略）
    └── *.md                   # 项目 workflows（git 追踪）
```

**区分机制**：`dao-` 前缀 = 来自 windsurf-dao，通过 `.git/info/exclude` 本地忽略，不污染项目 git。

## 迁移步骤

### 1. 冲突扫描

复制前，对比两个项目的 `.windsurf/` 目录：

```powershell
# 列出 dao 的文件
Get-ChildItem -Recurse "windsurf-dao\.windsurf\rules","windsurf-dao\.windsurf\skills","windsurf-dao\.windsurf\workflows" -Name

# 列出目标项目的文件
Get-ChildItem -Recurse "target-project\.windsurf\rules","target-project\.windsurf\skills","target-project\.windsurf\workflows" -Name
```

**检查维度：**

- **文件名冲突**：同名文件（如 `review.md`）
- **概念域重叠**：不同名但覆盖同一领域（如 `dao-frontend-aesthetics` vs `frontend-design`）

### 2. 冲突处理原则

| 冲突类型   | 处理方式       | 理由                                 |
| ---------- | -------------- | ------------------------------------ |
| 零冲突     | 直接复制       | 大多数情况                           |
| 文件名冲突 | **项目版优先** | 项目版是元层规则的具体落地，更完善   |
| 概念域重叠 | **保留两者**   | 元层=方法论，项目层=实操，互补不互斥 |

### 3. 命名空间策略

**所有 dao 来源的文件统一使用 `dao-` 前缀**，防止当前和未来的碰撞：

- **Rules**: `de-layer.md` → `dao-de-layer.md`，`fa-layer.md` → `dao-fa-layer.md`，`shu-layer.md` → `dao-shu-layer.md`（`dao-layer.md` 天然已有前缀）
- **Skills**: `boundary-probe/` → `dao-boundary-probe/`
- **Workflows**: `cycle.md` → `dao-cycle.md`，`review.md` → `dao-review.md` 等

**命名空间三原则：**

1. 所有 dao 来源文件必须有 `dao-` 前缀
2. 项目自有文件**不加** `dao-` 前缀
3. `skill.md` 内的 `name` 字段必须与目录名一致

### 4. 复制执行

```powershell
# Rules
Copy-Item "windsurf-dao\.windsurf\rules\dao-*.md" -Destination "target\.windsurf\rules\"

# Skills（整个目录复制）
Copy-Item "windsurf-dao\.windsurf\skills\dao-*" -Destination "target\.windsurf\skills\" -Recurse

# Workflows
Copy-Item "windsurf-dao\.windsurf\workflows\dao-*.md" -Destination "target\.windsurf\workflows\"
```

### 5. 复制后验证

```powershell
# 确认 skills 目录结构正确（每个 dao-* 下应有 skill.md）
Get-ChildItem "target\.windsurf\skills\dao-*" -Recurse

# 确认无散落文件（PowerShell 复制单文件目录时可能扁平化）
Get-ChildItem "target\.windsurf\skills\*.md" -File  # 应为空
```

**已知陷阱**：PowerShell `Copy-Item -Recurse` 对只含一个文件的目录，可能将文件扁平化到父目录而非保留目录结构。验证后手动修复。

### 6. 配置本地忽略

**关键步骤**：在目标项目的 `.git/info/exclude` 中添加 dao 文件忽略规则：

```powershell
# 写入本地忽略规则
@"

# windsurf-dao bootstrapped files (local only)
# dao-* prefixed files come from windsurf-dao, not tracked in project git
.windsurf/rules/dao-*
.windsurf/skills/dao-*
.windsurf/workflows/dao-*
"@ | Add-Content "target\.git\info\exclude"
```

**为什么用 `.git/info/exclude` 而非 `.gitignore`**：

- `.gitignore` 是项目共享的，会影响所有开发者
- `.git/info/exclude` 是本地的，只影响当前开发者
- dao 配置是个人的 AI 工作方式，不应强加给团队

### 7. 项目规则归位

目标项目的**项目特定规则**（代码规范、样式约定等）应合并到 `AGENT.md`：

1. 将项目特定的 `.windsurf/rules/*.md` 内容按域合并到 `AGENT.md` 对应章节
2. `ask-next-step.md` 的知识沉淀路由表更新为指向 `AGENT.md` 章节
3. 删除已合并的项目规则文件（避免重复加载）

**结果**：

- `AGENT.md`（tracked）= 项目的完整自包含规范文档
- `.windsurf/rules/ask-next-step.md`（tracked）= AI 交互行为规则
- `.windsurf/rules/dao-*.md`（locally ignored）= dao 元层规则

### 8. 合并 .agents/ skills

如果目标项目原本在 `.agents/skills/` 中有 skills，应迁入 `.windsurf/skills/`：

```powershell
# 移动 .agents/skills 内容到 .windsurf/skills
Copy-Item "target\.agents\skills\*" -Destination "target\.windsurf\skills\" -Recurse -Force

# 从 git 移除 .agents
git rm -r --cached .agents

# .gitignore 加入 .agents
Add-Content "target\.gitignore" "`n.agents"

# 删除空目录
Remove-Item "target\.agents" -Recurse -Force

# 更新 AGENT.md 中的引用
# .agents/skills/ → .windsurf/skills/
```

### 9. 完整启动流程总结

```
1. 复制 dao 文件到 target/.windsurf/          （步骤 1-5）
2. 验证目录结构                                 （步骤 5）
3. 配置 .git/info/exclude 本地忽略 dao-* 文件   （步骤 6）★
4. 项目规则合入 AGENT.md                        （步骤 7）
5. 合并 .agents/ skills 到 .windsurf/skills/    （步骤 8）
6. 提交
```

## 迁移后的目录结构示例

```
target-project/
├── AGENT.md                         # (tracked) 项目完整规范
├── .gitignore                       # .agents/.claude ignored
├── .git/info/exclude                # dao-* 本地忽略规则
└── .windsurf/
    ├── rules/
    │   ├── dao-layer.md             # ← dao（locally ignored）
    │   ├── dao-de-layer.md          # ← dao（locally ignored）
    │   ├── dao-fa-layer.md          # ← dao（locally ignored）
    │   ├── dao-shu-layer.md         # ← dao（locally ignored）
    │   └── ask-next-step.md         # ← 项目（tracked）
    ├── skills/
    │   ├── dao-boundary-probe/      # ← dao（locally ignored）
    │   ├── dao-frontend-aesthetics/ # ← dao（locally ignored）
    │   ├── dao-reverse-engineering/ # ← dao（locally ignored）
    │   ├── dao-terminal-resilience/ # ← dao（locally ignored）
    │   ├── dao-windsurf-extension/  # ← dao（locally ignored）
    │   ├── frontend-design/         # ← 项目（tracked）
    │   ├── vitest/                  # ← 项目（tracked）
    │   └── ...                      # ← 项目其他 skills（tracked）
    └── workflows/
        ├── dao-cycle.md             # ← dao（locally ignored）
        ├── dao-dev.md               # ← dao（locally ignored）
        ├── dao-review.md            # ← dao（locally ignored）
        ├── ...                      # ← dao 其他 workflows（locally ignored）
        ├── commit.md                # ← 项目（tracked）
        ├── review.md                # ← 项目（tracked）
        └── ...                      # ← 项目其他 workflows（tracked）
```

## 经验总结

1. **两层正交**：dao 元层（方法论）与项目操作层（具体规范）天然不冲突，绝大多数文件可直接复制
2. **`dao-` 前缀是唯一的命名空间策略**：rules/skills/workflows 全部统一，一眼分清来源
3. **本地忽略优于 .gitignore**：`.git/info/exclude` 不影响团队，dao 配置是个人 AI 工作方式
4. **项目版优先**：同名冲突时保留项目版，因为它是元层规则在该项目的具体落地
5. **PowerShell 陷阱**：`Copy-Item -Recurse` 对单文件目录可能扁平化，复制后必须验证目录结构
6. **skill.md 的 name 字段必须与目录名一致**：重命名目录后别忘更新文件内容
7. **AGENT.md 是项目知识的归宿**：项目特定规则写入 AGENT.md（tracked），dao 规则通过 `dao-` 前缀本地忽略
8. **统一到 .windsurf/**：项目 skills 从 `.agents/` 迁入 `.windsurf/skills/`，一个目录管理所有 AI 配置
