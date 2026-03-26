# 迁移指南 · 将 windsurf-dao 规则部署到目标项目

> 善行无辙迹。

## 设计原理

同步问题的根因是**文件有副本**。消除副本，问题就消失。

```
windsurf-dao (源仓库)            ← git repo，唯一真相
├── .windsurf/dao-*              ← 真实文件
├── global_rules.md              ← 全局规则真实文件
└── dao.ps1                      ← 链接管理工具

~/.codeium/windsurf/memories/
└── global_rules.md              ← symlink → windsurf-dao/

项目X/.windsurf/
├── rules/dao-*.md               ← symlink → windsurf-dao/
├── skills/dao-*/                ← junction → windsurf-dao/
├── workflows/dao-*.md           ← symlink → windsurf-dao/
└── (项目自有文件)                ← git tracked
```

**变更流**：在任意项目中编辑 dao-* 文件 → 物理修改的是 windsurf-dao → 所有项目即时可见 → 在 windsurf-dao 中 git commit。

## 核心架构

```
.windsurf/                      # 统一 AI 配置目录
├── rules/
│   ├── dao-*.md               # dao 元层（symlink，本地忽略）
│   └── *.md                   # 项目操作层（git 追踪）
├── skills/
│   ├── dao-*/                 # dao skills（junction，本地忽略）
│   └── */                     # 项目 skills（git 追踪）
└── workflows/
    ├── dao-*.md               # dao workflows（symlink，本地忽略）
    └── *.md                   # 项目 workflows（git 追踪）
```

**区分机制**：`dao-` 前缀 = 来自 windsurf-dao，通过 `.git/info/exclude` 本地忽略，不污染项目 git。

## 链接模式（推荐）

### 前提

- **Windows Developer Mode**：Settings → System → For developers → Developer Mode
- 文件符号链接需要 Developer Mode；目录联接（Junction）不需要

### 步骤

```powershell
# 1. 链接 dao 文件到目标项目（自动创建目录、配置 .git/info/exclude）
.\dao.ps1 link D:\your\project

# 2. 链接全局规则到 Windsurf 配置（一次性）
.\dao.ps1 link-global

# 3. 查看状态
.\dao.ps1 status D:\your\project
```

**完成。** 无需手动复制、无需同步、无需维护。

### dao.ps1 命令

| 命令 | 作用 |
|------|------|
| `link <path>` | 创建 symlink/junction 从目标项目指向 windsurf-dao |
| `unlink <path>` | 移除链接（不影响源文件） |
| `status [path]` | 显示链接/复制状态 |
| `link-global` | 链接 `global_rules.md` 到 `~/.codeium/windsurf/memories/` |

### 工作流

```
新项目接入：
  dao.ps1 link <project>  →  完成

在任意项目中改进 dao 规则：
  直接编辑  →  所有项目即时生效  →  去 windsurf-dao 仓库 git commit

从项目 A 回补到源仓库：
  无需操作（symlink，物理上就是同一文件）

从源仓库同步到所有项目：
  无需操作（symlink，已经是最新）
```

## 从复制升级到链接

已有复制副本的项目，直接运行 `dao.ps1 link` 即可升级：

```powershell
.\dao.ps1 link D:\your\existing-project
```

**自动处理流程**：

1. 检测每个 dao-* 文件是副本还是链接
2. 副本与源 SHA256 比对
3. **相同** → 删除副本，创建链接
4. **不同** → 备份到 `_dao_backup/` → 删除副本 → 创建链接
5. 输出报告，提示 review 备份

```
  [link]   rules/dao-layer.md
  [backup] rules/dao-de-layer.md (modified copy saved)
  [link]   rules/dao-de-layer.md
  [link]   skills/dao-boundary-probe/
  ...
  Done: 20 linked, 0 unchanged
  Backup: 1 modified copies saved to _dao_backup/
  Review backups, merge improvements back to windsurf-dao, then delete _dao_backup/
```

**备份处理**：`_dao_backup/` 保留了与源不同的副本。Review 后：
- 有价值的改进 → 合并回 windsurf-dao 源文件（链接模式下直接编辑即可）
- 无价值的差异 → 忽略
- 处理完毕 → 删除 `_dao_backup/`

## 复制模式（备用）

当 symlink 不可用时（无 Developer Mode、跨磁盘、网络共享），退化为手动复制：

```powershell
# 复制
Copy-Item "windsurf-dao\.windsurf\rules\dao-*.md" -Destination "target\.windsurf\rules\"
Copy-Item "windsurf-dao\.windsurf\skills\dao-*" -Destination "target\.windsurf\skills\" -Recurse
Copy-Item "windsurf-dao\.windsurf\workflows\dao-*.md" -Destination "target\.windsurf\workflows\"

# 配置本地忽略
@"

# windsurf-dao files (local only)
.windsurf/rules/dao-*
.windsurf/skills/dao-*
.windsurf/workflows/dao-*
"@ | Add-Content "target\.git\info\exclude"
```

**复制模式的代价**：变更不会自动传播，需手动重新复制。

**已知陷阱**：PowerShell `Copy-Item -Recurse` 对只含一个文件的目录可能扁平化。复制后验证 `skills/dao-*/skill.md` 目录结构。

## 命名空间

**所有 dao 来源的文件统一使用 `dao-` 前缀**：

| 类型 | dao 元层 | 项目操作层 |
|------|---------|------------|
| Rules | `dao-layer.md` 等 | `ask-next-step.md` 等 |
| Skills | `dao-boundary-probe/` 等 | `frontend-design/` 等 |
| Workflows | `dao-cycle.md` 等 | `commit.md`、`review.md` 等 |

**三原则**：dao 文件必须有 `dao-` 前缀 / 项目文件不加 `dao-` 前缀 / `skill.md` 的 `name` 字段与目录名一致。

## 本地忽略

**用 `.git/info/exclude`，不用 `.gitignore`**：

- `.gitignore` 是项目共享的，影响所有开发者
- `.git/info/exclude` 是本地的，只影响当前开发者
- dao 配置是个人的 AI 工作方式，不应强加给团队

`dao.ps1 link` 会自动配置此项。

## 项目规则归位

目标项目的项目特定规则应独立管理：

- `AGENT.md`（tracked）= 项目完整规范文档
- `.windsurf/rules/ask-next-step.md`（tracked）= AI 交互行为规则
- `.windsurf/rules/dao-*.md`（locally ignored）= dao 元层规则

## 迁移后的目录结构

```
target-project/
├── AGENT.md                         # (tracked) 项目完整规范
├── .git/info/exclude                # dao-* 本地忽略规则
└── .windsurf/
    ├── rules/
    │   ├── dao-layer.md             # → symlink (locally ignored)
    │   ├── dao-de-layer.md          # → symlink (locally ignored)
    │   ├── dao-fa-layer.md          # → symlink (locally ignored)
    │   ├── dao-shu-layer.md         # → symlink (locally ignored)
    │   └── ask-next-step.md         # ← 项目 (tracked)
    ├── skills/
    │   ├── dao-boundary-probe/      # → junction (locally ignored)
    │   ├── dao-frontend-aesthetics/ # → junction (locally ignored)
    │   ├── dao-reverse-engineering/ # → junction (locally ignored)
    │   ├── dao-terminal-resilience/ # → junction (locally ignored)
    │   ├── dao-windsurf-extension/  # → junction (locally ignored)
    │   └── project-skill/           # ← 项目 (tracked)
    └── workflows/
        ├── dao-cycle.md             # → symlink (locally ignored)
        ├── dao-dev.md               # → symlink (locally ignored)
        ├── ...                      # → symlink (locally ignored)
        └── project-workflow.md      # ← 项目 (tracked)
```

## 经验总结

1. **链接 > 复制**：symlink 消除同步问题，复制只是备用方案
2. **`dao-` 前缀**：唯一的命名空间策略，一眼分清来源
3. **本地忽略**：`.git/info/exclude` 不影响团队
4. **项目版优先**：同名冲突时保留项目版（元层规则的具体落地）
5. **版本控制在源仓库**：所有 dao 变更在 windsurf-dao 仓库 commit，通过链接传播
