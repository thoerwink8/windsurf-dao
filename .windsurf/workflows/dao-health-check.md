---
description: 系统健康检查：检测规则/配置/Skills是否完整，发现缺失自动恢复。IDE重启后、新对话开始时触发。
---

# 健康检查 · Health Check

> 知人者智，自知者明。胜人者有力，自胜者强。

## 触发条件

- IDE 重启后首次交互
- 感觉系统行为异常
- 新对话开始且有 SYSTEM-RETRIEVED-MEMORY
- 用户显式调用 `/health-check`

## 流程

### 一、检测（☲离 · 视 · 照见缺失）

#### 1.1 文件完整性 + 链接状态（动态检测）

不硬编码文件列表。从 windsurf-dao 源仓库动态获取应有的 dao-* 文件，与当前项目比对：

**定位源仓库**：从任一现有 symlink 的 Target 反推，或询问用户。

```powershell
# 动态对比：源仓库有哪些 dao-* 文件，当前项目缺哪些
$daoSource = "<windsurf-dao-path>\.windsurf"
# Rules
diff (Get-ChildItem "$daoSource\rules" -Filter "dao-*.md" -Name) (Get-ChildItem ".windsurf\rules" -Filter "dao-*.md" -Name)
# Skills
diff (Get-ChildItem "$daoSource\skills" -Directory -Filter "dao-*" -Name) (Get-ChildItem ".windsurf\skills" -Directory -Filter "dao-*" -Name)
# Workflows
diff (Get-ChildItem "$daoSource\workflows" -Filter "dao-*.md" -Name) (Get-ChildItem ".windsurf\workflows" -Filter "dao-*.md" -Name)
```

有差异 → 源仓库新增了文件 → 需要重新 `dao.ps1 link`。

#### 1.2 链接状态

dao 文件应通过符号链接指向 windsurf-dao 源仓库，而非独立副本。

**检测方法**（AI 执行）：
```powershell
# 检查单个文件的链接状态
Get-Item ".windsurf\rules\dao-layer.md" | Select-Object Name, LinkType, Target
```

**状态判定**：
- `LinkType = SymbolicLink/Junction` → 🟢 已链接
- `LinkType` 为空（普通文件/目录）→ 🟡 副本（需升级）
- 文件不存在 → 🔴 缺失

#### 1.3 全局规则

```powershell
Get-Item "$env:USERPROFILE\.codeium\windsurf\memories\global_rules.md" | Select-Object LinkType, Target
```

- 链接 → 🟢 | 副本 → 🟡 | 不存在 → 🔴

#### 1.4 内容完整性

- 规则文件有 `trigger:` frontmatter，且值必须是四个合法值之一：`always_on` / `model_decision` / `glob` / `manual`。**非法值（如 `always`、`auto`、拼写错误）= 文件对 AI 完全隐身，是静默失效**
- 工作流文件有 `description:` frontmatter
- 四层架构一致：道/德/法/术 齐全

**校验命令**（AI 执行）：
```powershell
Get-ChildItem ".windsurf\rules" -Filter "*.md" | ForEach-Object {
  $c = Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue
  if ($c -match 'trigger:\s*(\S+)') {
    $v = $Matches[1]
    $ok = $v -in @('always_on','model_decision','glob','manual')
    if (-not $ok) { "🔴 $($_.Name) → trigger: $v (非法值!)" }
    else { "🟢 $($_.Name) → trigger: $v" }
  } else { "🔴 $($_.Name) → 无 trigger frontmatter" }
}
```

### 二、诊断（☵坎 · 听 · 听回响）

| 状态 | 含义 | 行动 |
|------|------|------|
| 🟢 | 已链接，内容完整 | 无需操作 |
| 🟡 | 副本或内容不全 | 升级为链接 |
| � | 缺失 | 部署链接 |

### 三、修复（☳震 · 触 · 自动恢复）

#### 定位 windsurf-dao 源仓库

**优先级**：
1. 从现有 symlink 的 Target 反推源仓库路径
2. 检查常见位置：当前驱动器下搜索 `windsurf-dao/dao.ps1`
3. 询问用户

#### 执行修复

```powershell
# 从 windsurf-dao 源仓库执行（AI 自动定位并运行）
// turbo
<windsurf-dao-path>\dao.ps1 link <current-project-path>

# 全局规则（如需要）
// turbo
<windsurf-dao-path>\dao.ps1 link-global
```

`dao.ps1 link` 会自动处理：
- 副本与源相同 → 替换为链接
- 副本与源不同 → 备份到 `_dao_backup/` 后替换
- 已是链接 → 跳过
- 配置 `.git/info/exclude`

#### Memory 清理

- 过时的 Memory → 归位后删除
- 不一致的引用 → 更新

### 四、报告（☶艮 · 味 · 总结）

```
## 🏥 健康检查报告
| 域 | 状态 | 发现 |
|----|------|------|
| 规则 | 🟢/🟡/🔴 | [N linked / N copy / N missing] |
| 工作流 | 🟢/🟡/🔴 | [同上] |
| 技能 | 🟢/🟡/🔴 | [同上] |
| 全局规则 | 🟢/🟡/🔴 | [linked/copy/missing] |
| Memory | 🟢/🟡/🔴 | [残留/已清空] |
| 教训 | 🟢/⬜ | [N 条已装载 / 无教训文件] |
```

### 五、教训装载（☴巽 · 嗅 · 历史渗透）

> 知常曰明。不读历史教训就开工，是重蹈覆辙的最快路径。

健康检查完成后，读取项目教训：

1. 查找 `AGENT_GUIDE.md §教训`（或等效项目教训文件）
2. 统计教训总数，输出 `教训已装载：N 条（最新：T[n]）`
3. 文件不存在或无教训章节 → 输出 `⬜ 无教训记录` 并跳过，不报错

**目的**：跨会话知识不依赖 Memory，依赖文件。健康检查 = 每次会话的教训刷新节点。

> 此步骤只读不写，不阻塞健康检查主流程。
