# 迁移指南 · 将 windsurf-dao 规则复制到目标项目

> 善行无辙迹。

## 前提

windsurf-dao 是**元层规则源**（道/德/法/术 + 通用 skills/workflows），目标项目有自己的**操作层规则**（代码规范、样式约定、项目特定工作流等）。两层正交，互不覆盖。

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
- **概念域重叠**：不同名但覆盖同一领域（如 `frontend-aesthetics` vs `frontend-design`）

### 2. 冲突处理原则

| 冲突类型   | 处理方式       | 理由                                 |
| ---------- | -------------- | ------------------------------------ |
| 零冲突     | 直接复制       | 大多数情况                           |
| 文件名冲突 | **项目版优先** | 项目版是元层规则的具体落地，更完善   |
| 概念域重叠 | **保留两者**   | 元层=方法论，项目层=实操，互补不互斥 |

### 3. 命名空间策略

**dao 来源的文件统一使用 `dao-` 前缀**，防止当前和未来的碰撞：

- Skills: `boundary-probe/` → `dao-boundary-probe/`
- Workflows: `review.md` → `dao-review.md`
- Rules: 已天然使用 `dao-layer.md`、`de-layer.md` 等独特命名，无需前缀

**命名空间三原则：**

1. 已有独特命名的不改（如 `dao-layer.md`、`fa-layer.md`）
2. 通用命名加 `dao-` 前缀（如 `review` → `dao-review`）
3. skill.md 内的 `name` 字段必须与目录名一致

### 4. 复制执行

```powershell
# Rules（直接复制，dao 规则文件名天然不冲突）
Copy-Item "windsurf-dao\.windsurf\rules\dao-layer.md","windsurf-dao\.windsurf\rules\de-layer.md","windsurf-dao\.windsurf\rules\fa-layer.md","windsurf-dao\.windsurf\rules\shu-layer.md" -Destination "target\.windsurf\rules\"

# Skills（整个目录复制）
Copy-Item "windsurf-dao\.windsurf\skills\dao-*" -Destination "target\.windsurf\skills\" -Recurse

# Workflows（逐个复制，跳过已存在的同名文件）
Get-ChildItem "windsurf-dao\.windsurf\workflows\*.md" | ForEach-Object {
    $dest = Join-Path "target\.windsurf\workflows" $_.Name
    if (-not (Test-Path $dest)) {
        Copy-Item $_.FullName $dest
        Write-Host "复制: $($_.Name)"
    } else {
        Write-Host "跳过（已存在）: $($_.Name)"
    }
}
```

### 5. 复制后验证

```powershell
# 确认 skills 目录结构正确（每个 dao-* 下应有 skill.md）
Get-ChildItem "target\.windsurf\skills\dao-*" -Recurse

# 确认无散落文件（PowerShell 复制单文件目录时可能扁平化）
Get-ChildItem "target\.windsurf\skills\*.md" -File  # 应为空
```

**已知陷阱**：PowerShell `Copy-Item -Recurse` 对只含一个文件的目录，可能将文件扁平化到父目录而非保留目录结构。验证后手动修复。

### 6. shu-layer.md 适配

复制到目标项目的 `shu-layer.md` 中的项目结构和 MCP 列表需要适配目标项目的实际情况：

- 项目路径（`d:\frank\道\` → 目标项目路径）
- MCP 工具列表（目标项目可能有不同的 MCP 配置）
- Skills 列表（合并 dao skills + 项目已有 skills）

## 迁移后的目录结构示例

```
target-project/.windsurf/
├── rules/
│   ├── dao-layer.md          # ← dao 元层
│   ├── de-layer.md           # ← dao 元层
│   ├── fa-layer.md           # ← dao 元层
│   ├── shu-layer.md          # ← dao 元层
│   ├── code-conventions.md   # ← 项目操作层
│   ├── libraries.md          # ← 项目操作层
│   └── ...
├── skills/
│   ├── dao-boundary-probe/   # ← dao（dao- 前缀）
│   ├── dao-frontend-aesthetics/
│   ├── dao-reverse-engineering/
│   ├── dao-terminal-resilience/
│   └── dao-windsurf-extension/
└── workflows/
    ├── dao-review.md         # ← dao（dao- 前缀，避免与项目 review.md 冲突）
    ├── cycle.md              # ← dao
    ├── dev.md                # ← dao
    ├── review.md             # ← 项目特定版本
    ├── commit.md             # ← 项目特定
    └── ...
```

### 7. 项目规则归位

目标项目的**项目特定规则**（代码规范、样式约定等）不应留在 `.windsurf/rules/` 中，而应合并到 `AGENT.md`：

1. 将项目特定的 `.windsurf/rules/*.md` 内容按域合并到 `AGENT.md` 对应章节
2. `ask-next-step.md` 的知识沉淀路由表更新为指向 `AGENT.md` 章节（而非 `.windsurf/rules/` 文件）
3. `.windsurf/` 目录整个加入 `.gitignore`
4. `git rm -r --cached .windsurf` 从追踪中移除

**结果**：

- `AGENT.md`（tracked）= 项目的完整自包含规范文档
- `.windsurf/`（gitignored）= 从 windsurf-dao 启动的 AI 配置，不入项目 git

### 8. 完整启动流程总结

```
1. 复制 windsurf-dao/.windsurf/ → target/.windsurf/  （步骤 1-5）
2. 验证目录结构                                        （步骤 5）
3. 项目规则合入 AGENT.md                               （步骤 7）
4. .gitignore 加入 .windsurf                           （步骤 7）
5. git rm -r --cached .windsurf                        （步骤 7）
6. 提交
```

## 经验总结

1. **两层正交**：dao 元层（方法论）与项目操作层（具体规范）天然不冲突，绝大多数文件可直接复制
2. **唯一冲突点是通用命名的 workflow**：如 `review.md`、`test.md` 等——用 `dao-` 前缀解决
3. **项目版优先**：同名冲突时保留项目版，因为它是元层规则在该项目的具体落地
4. **PowerShell 陷阱**：`Copy-Item -Recurse` 对单文件目录可能扁平化，复制后必须验证目录结构
5. **skill.md 的 name 字段必须与目录名一致**：重命名目录后别忘更新文件内容
6. **AGENT.md 是项目知识的归宿**：项目特定规则写入 AGENT.md（tracked），`.windsurf/` 只存 dao 启动配置（gitignored）
7. **dao 作为参考层不改不动**：复制到项目后不适配 shu-layer.md 的路径/MCP，保持原样作为哲学参考
