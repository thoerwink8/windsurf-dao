---
description: 演化记录搜索与管理。当任务涉及教训、经验、回顾历史问题、知识积累、演化记录时加载。关键词：教训、经验、evolution、回顾、之前遇到过、历史问题、踩坑、T编号。
---

# dao-evolution · 演化记录

> 知常曰明。历史教训 = 已付代价的真。

## 架构

```
windsurf-dao/.windsurf/skills/dao-evolution/   ← 引擎（共享）
  ├── SKILL.md（本文件）
  ├── scripts/search.py, core.py               ← BM25 搜索
  └── schema/README.md                         ← 列定义

每个项目/data/                                  ← 数据（项目自有）
  ├── evolution-entries.csv                     ← 演化条目
  └── evolution-lessons.csv                     ← 教训
```

引擎在 windsurf-dao，数据在每个项目。首次使用时自动初始化。

## 初始化

skill 被加载时，检查当前项目 `data/evolution-entries.csv`：
- 不存在 → 运行 `python search.py init --data-dir <project>/data`
- 已存在 → 正常工作

## 搜索（回顾历史教训）

```powershell
python <skill>/scripts/search.py search "heartbeat async race" --data-dir <project>/data
python <skill>/scripts/search.py lessons "race condition" --data-dir <project>/data
python <skill>/scripts/search.py stats --data-dir <project>/data
```

搜索结果按相关度排序，deprecated 教训默认隐藏。三级回顾深度：
- **L1 提醒**（1-2 条匹配）：一句话提及
- **L2 展示**（3+ 条或高相关度）：展示教训摘要
- **L3 阻断**（critical 且直接匹配）：阻断式警告

## 写入（记录新教训）

使用 `core.py` API 直接调用：

```python
from core import write_entry, write_lesson, deprecate_lesson, mark_synthesized

# 写草稿条目
eid = write_entry(data_dir, "draft", "v1.23.1", "ext",
    "心跳间隔suspend后不重置", "setInterval累积", "T144", "heartbeat;timer")

# 写教训
lid = write_lesson(data_dir, "suspend后timer累积", "v1.23.1", "ext",
    "系统休眠期间setInterval不暂停...", "heartbeat;timer", eid)

# 废弃旧教训
deprecate_lesson(data_dir, "T120", "T138")

# 合成草稿
mark_synthesized(data_dir, ["e001", "e002", "e003"], "e004")
```

## 遗忘机制

### 写入时
新教训推翻旧教训 → 调用 `deprecate_lesson(old_id, new_id)`

### 搜索时
- `active` → 正常显示
- `deprecated` → 默认隐藏，用 `--include-deprecated` 显示
- `review` → 带 ⚠️ 警告显示

### /evolve 审查时
```powershell
python <skill>/scripts/search.py stale --data-dir <project>/data --threshold 5
```
距最新版本 ≥5 个大版本的 active 教训 → 自动标记为 `review`。

## 合成触发器

| 触发 | 条件 |
|------|------|
| 事件驱动 | /cycle 涅槃、/distill、deploy 完成 |
| 密度触发 | 同一标签 3+ 条 draft |
| 时间触发 | 会话结束检查点 |

合成流程：相关草稿 → AI 分析共同模式 → 生成 mature 条目 + 教训 → 原草稿标记 synthesized。

## 日制节律

**会话开始**：skill 加载时运行 `stats`，内心记录草稿数量。未合成草稿 ≥5 → 等任务间隙提醒合成。

**会话结束**：本次有值得记录的观察？→ 写入 draft 条目。达到合成阈值？→ 提议合成。

## CSV 列定义

详见 `schema/README.md`。

**entries 关键列**：id, status(draft/mature/synthesized), date, version, title, root_cause, tags
**lessons 关键列**：id, title, detail, tags, status(active/deprecated/review), superseded_by
