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

写完教训后，逐条回答三问：

1. **能直接改变 AI 行为？**（铁律级，每次都该遵守）→ **行为层**：写入 dao.md 或对应 skill
2. **跨会话反复有用但不是铁律？**（模式、坑、决策依据）→ **记忆层**：写 memory 文件
3. **需要详细记录因果链以备回溯？** → **档案层**：写 CSV

三层可叠加：重要教训同时写行为层 + 档案层。大多数教训至少写记忆层 + 档案层。

### 显式输出格式

```
### 教训归位
- "<title>": 行为层（写入 dao.md §XX） + 档案层
- "<title>": 记忆层（memory/evolution-xx.md） + 档案层
- "<title>": 仅档案层，因 <理由>
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

CSV 是未来 Obsidian vault 的数据源，每条必须详细到**独立可读**：

**`docs/evolution/evolution-lessons.csv`**：
```
id,date,title,context,root_cause,fix,lesson,tags,links,status
```

- **id**: L001, L002...（从 L001 重新编号）
- **date**: YYYY-MM-DD
- **title**: 一句话标题
- **context**: 什么场景触发了这个教训（完整描述）
- **root_cause**: 根因分析
- **fix**: 怎么修的
- **lesson**: 提炼出的可复用洞察
- **tags**: 分号分隔（未来直接转 Obsidian #tag）
- **links**: 相关条目 ID，分号分隔（未来转 `[[wikilink]]`）
- **status**: active / deprecated / superseded

**`docs/evolution/evolution-entries.csv`**：
```
id,date,title,summary,lesson_ids,tags
```

- **id**: E001, E002...
- 演化条目是多条教训的聚合叙事，记录一次完整的演化事件

### 搜索

```powershell
py <skill>/scripts/search.py lessons "<关键词>" --data-dir <project>/docs/evolution
```

## 遗忘

- 新教训推翻旧教训 → 旧条目 status 改为 `superseded`，新条目 links 列引用旧 ID
- 记忆层：更新或删除对应 memory 文件
- 行为层：直接改写 dao.md / skill 正文

## 与上层流程的协作

- **/dao-distill**：会话级全量扫描 → 走本 skill 三层路由
- **/dao-evolve**：跨会话审查 → 检查档案层是否有该提升到记忆/行为层的遗漏
- **dao-dev §2.5 涅槃**：单次任务教训 → 走本 skill 三层路由

## 反模式

| 病 | 对治 |
|---|---|
| 只写 CSV 不写 memory | CSV 是死档案，memory 才能被想起 |
| 全写 memory 不分层 | 铁律级写行为层，记忆层放模式/坑 |
| memory 索引写太长 | MEMORY.md 每条 <150 字符，详情在文件里 |
| 教训写一句话 | 档案层要完整因果链（context→root_cause→fix→lesson） |
