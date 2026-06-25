---
name: dao-evolution
description: 演化知识管理（三层归位）。当任务涉及教训沉淀、经验回顾、知识积累、踩坑记录、distill、evolve 时加载。
---

# dao-evolution · 演化知识管理

> 知常曰明。历史教训 = 已付代价的真。

## 三层架构

| 层 | 载体 | 注入方式 | 什么放这里 |
|---|---|---|---|
| **行为层** | `dao.md` / skill SKILL.md | always_on / 按需加载 | 已验证铁律，直接改变 AI 行为 |
| **记忆层** | `~/.claude/.../memory/` | MEMORY.md 索引每轮可见 | 跨会话有用的模式、踩坑、决策依据 |
| **档案层** | `docs/evolution/*.csv` | 不自动注入，按需搜索 | 完整因果链，Obsidian 数据源 |

行为层真正塑造 AI。记忆层让 AI 有机会想起来。档案层给人回溯用。

## 路由判据（每条教训必须显式走一次）

**档案层默认写入**——每条教训无条件写 CSV（5 字段低摩擦），然后追问两个加层问题：

1. **能直接改变 AI 行为？**（铁律级）→ **+行为层**：写入 dao.md 或对应 skill
2. **跨会话反复有用？**（模式、坑、决策依据）→ **+记忆层**：写 memory 文件

三层可叠加：大多数教训 = 档案层 + 记忆层。重要教训 = 三层全写。

### 显式输出格式

```
### 教训归位（CSV 已默认写入）
- "<title>": +行为层（写入 dao.md §XX）+记忆层
- "<title>": +记忆层（memory/evolution-xx.md）
- "<title>": 仅档案层
```

## 记忆层写入

按 Claude Code memory 规范写入 `~/.claude/projects/<project>/memory/`：

```markdown
---
name: evolution-<slug>
description: <一行摘要——用于 MEMORY.md 索引判断相关性>
metadata:
  type: feedback  # 或 project
---

<教训正文>

**Why:** <根因/背景>
**How to apply:** <未来什么场景下应用>
```

同步更新 `MEMORY.md` 索引（一行，<150 字符）。

## 档案层写入（Obsidian-ready）

CSV 默认写入，5 字段低摩擦。每条教训独立可读。

**`docs/evolution/evolution-lessons.csv`**（5 字段）：
```
id,date,title,insight,tags
```

- **id**: L1, L2...（递增序号）
- **date**: YYYY-MM-DD
- **title**: 一句话标题
- **insight**: 因果叙事——什么情况+为什么出错+怎么解决+可复用洞察（1-3 句）
- **tags**: 分号分隔（Obsidian #tag），交叉引用用 `→L<id>` / `→E<id>`

**`docs/evolution/evolution-entries.csv`**（6 字段）：
```
id,date,title,summary,lesson_ids,tags
```

- **id**: E1, E2...（递增序号）
- 演化条目是多条教训的聚合叙事，记录一次完整的演化事件

### 搜索

```powershell
py <skill>/scripts/search.py lessons "<关键词>" --data-dir <project>/docs/evolution
```

## 遗忘

- 新教训推翻旧教训 → 新条目 tags 加 `→L<旧id>(superseded)`，旧条目留原样（git 是审计轨迹）
- 记忆层：更新或删除对应 memory 文件
- 行为层：直接改写 dao.md / skill 正文

## 与上层流程的协作

- **/dao-distill**：会话级全量扫描 → 走本 skill 三层路由
- **/dao-evolve**：跨会话审查 → 检查档案层是否有该提升到记忆/行为层的遗漏
- **dao-dev §2.5 涅槃**：单次任务教训 → 走本 skill 三层路由

## 反模式

| 病 | 对治 |
|---|---|
| 跳过 CSV 只写 memory | CSV 是默认写入，不可跳过 |
| 全写 memory 不分层 | 铁律级写行为层，记忆层放模式/坑 |
| memory 索引写太长 | MEMORY.md 每条 <150 字符，详情在文件里 |
| insight 写一句话 | 要因果叙事（情况→根因→解法→洞察），1-3 句 |
