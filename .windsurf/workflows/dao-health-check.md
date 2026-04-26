---
description: 系统健康检查：global_rules.md 链接 + 规则 frontmatter 校验 + Memory 清理 + 教训统计。感觉行为异常或用户显式调用时触发。
---

# 健康检查 · Health Check

> 知人者智，自知者明。胜人者有力，自胜者强。

## 触发条件

- 感觉系统行为异常（规则未生效、skill 消失、Memory 残留）
- 用户显式调用 `/health-check`

## 流程

### 一、全局规则链接

```powershell
Get-Item "$env:USERPROFILE\.codeium\windsurf\memories\global_rules.md" | Select-Object LinkType, Target
```

- 🟢 链接 → 正常
- � 副本 → 修复：`<windsurf-dao-path>\dao.ps1 link-global`
- 🔴 不存在 → 修复：同上

### 二、规则 frontmatter 校验（静默失效风险）

非法 `trigger:` 值 = 规则对 AI 完全隐身。合法值：`always_on` / `model_decision` / `glob` / `manual`。

```powershell
Get-ChildItem "$env:USERPROFILE\.codeium\windsurf\workspaces\*\rules" -Filter "*.md" -ErrorAction SilentlyContinue |
ForEach-Object {
  $c = Get-Content $_.FullName -Raw
  if ($c -match 'trigger:\s*(\S+)') {
    $v = $Matches[1]
    if ($v -notin @('always_on','model_decision','glob','manual')) { "🔴 $($_.Name) → trigger: $v (非法!)" }
  } else { "🔴 $($_.Name) → 无 trigger frontmatter" }
}
```

### 三、Memory 清理

- 残留 Memory → 确认后删除（理想态：Memory 为空，知识归文件）

### 四、教训统计

```
py search.py stats --data-dir <project>/data
```

输出 `教训已装载：N 条 active（draft: X, mature: Y）`。

> 迁移由 `execution.md` §项目感知自动触发，此处只读统计。

## 报告格式

```
## 🏥 健康检查
| 全局规则 | 🟢/🟡/🔴 | linked / copy / missing |
| 规则校验 | 🟢/🔴    | all valid / N 个非法值  |
| Memory   | 🟢/🟡    | 已清空 / N 条残留       |
| 教训     | 🟢/⬜    | N 条 active / 未初始化  |
```
