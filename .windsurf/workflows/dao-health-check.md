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

#### 1.1 源仓库完整性（Sidecar 模式）

> Sidecar 模式下，windsurf-dao 作为 workspace 打开，rules/skills/workflows 自动跨 workspace 可见。
> 不再需要 link 到每个项目。健康检查焦点 = 源仓库自身是否完整。

```powershell
# 检查源仓库 rules/skills/workflows 存在性
$daoRoot = "<windsurf-dao-path>"
$ws = Join-Path $daoRoot ".windsurf"
Write-Host "Rules:"; Get-ChildItem "$ws\rules" -Filter "*.md" -Name
Write-Host "Skills:"; Get-ChildItem "$ws\skills" -Directory -Name
Write-Host "Workflows:"; Get-ChildItem "$ws\workflows" -Filter "*.md" -Name
```

**期望**：
- Rules: 5 个（dao-de-layer always_on + dao-layer/dao-fa-layer/dao-shu-layer/dao-quality-gate model_decision）
- Skills: 15 个 dao-* 目录
- Workflows: 12+ 个 dao-*.md

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

**Sidecar 模式**（推荐）：确保 windsurf-dao 作为 workspace 打开即可，无需 link。

**全局规则**（仍需 link）：
```powershell
// turbo
<windsurf-dao-path>\dao.ps1 link-global
```

**Legacy link 模式**（需要独立自足时）：
```powershell
<windsurf-dao-path>\dao.ps1 link <current-project-path>
```

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

健康检查完成后，加载 `dao-evolution` skill，读取项目教训：

1. 运行 `search.py stats --data-dir <project>/data`
2. CSV 存在 → 输出 `教训已装载：N 条 active（draft: X, mature: Y）`
3. CSV 不存在 → 运行 `search.py init --data-dir <project>/data` 初始化，输出 `⬜ 已初始化空教训库`
4. 兜底：查找 `AGENT_GUIDE.md §教训`（旧格式），存在则提示可运行 `migrate.py` 迁移

**目的**：跨会话知识不依赖 Memory，依赖文件。健康检查 = 每次会话的教训刷新节点。

> 此步骤只读不写（初始化除外），不阻塞健康检查主流程。
