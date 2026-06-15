---
name: dao-evolution
description: 演化记录搜索与管理。当任务涉及教训、经验、回顾历史问题、知识积累、演化记录时加载。关键词：教训、经验、evolution、回顾、之前遇到过、历史问题、踩坑、T编号。
---

# dao-evolution · 演化记录

> 知常曰明。历史教训 = 已付代价的真。

## 架构

```
windsurf-dao/ccswitch/skills/dao-evolution/   ← 引擎（共享）
  ├── SKILL.md（本文件）
  ├── scripts/search.py, core.py               ← BM25 搜索
  └── schema/README.md                         ← 列定义

每个项目/data/                                  ← 数据（项目自有）
  ├── evolution-entries.csv                     ← 演化条目
  └── evolution-lessons.csv                     ← 教训
```

引擎在 windsurf-dao，数据在每个项目。首次使用时通过 `ensure` 自动判断：迁移旧记录或初始化空 CSV。

## 初始化

 首次进入项目前，先运行：

 ```powershell
 python <skill>/scripts/search.py ensure --data-dir <project>/data
 ```

 `ensure` 行为：
- 已有 `docs/evolution/evolution-entries.csv` → 不做任何事
- 无 CSV 但有 `AGENT_GUIDE.md` / `docs/evolution.md` → 自动运行 `migrate.py <project_root>` 迁移旧记录
- 无 CSV 且无旧记录 → 自动初始化空 CSV

## 搜索（回顾历史教训）

```powershell
 python <skill>/scripts/search.py ensure --data-dir <project>/data
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

## 上提评估（每条 lesson 写入后必走）

> "各复归其根" — 知识归位是 dao-evolution 的硬步骤。CSV 是历史可追溯,**不等于该 lesson 已经"被使用"**。重要 lesson 必须上提到能在未来主动注入的位置。

每次 `write_lesson()` 后,**必须**对该 lesson 走一次上提评估,即便结论是"仅留 CSV"也要**显式说出来**。

### 评估三问

1. **跨项目可复用方法论？** → 上提到 `windsurf-dao/ccswitch/skills/dao-*/SKILL.md`
2. **项目反复会撞的特定坑？** → 上提到该项目 `AGENT.md` 「项目特定坑」段
3. **打破现有不变量 / 修改流程信念？** → 上提到 `windsurf-dao/ccswitch/dao.md` 对应规则

### 归位映射表

| lesson 性质 | 上提位置 |
|---|---|
| 跨项目通用调试模式 | `ccswitch/skills/dao-debug/SKILL.md` |
| 跨项目通用执行模式 | `ccswitch/skills/dao-execute/SKILL.md` |
| 跨项目通用 review/finish | `ccswitch/skills/dao-review/dao-finish/SKILL.md` |
| 项目反复会撞的坑 | 项目 `AGENT.md` 「项目特定坑」段(无则新建) |
| 流程规则修订/补充 | `ccswitch/dao.md` 对应段落 |
| 实战案例展示 | `windsurf-dao/README.md` 「实战案例」段 |
| 仅历史可追溯 | 仅 CSV 即可,无需上提 |

### 显式输出格式

```
### lesson 上提评估
- T<id> "<title>": [上提到 <位置> | 仅留 CSV 因 <理由>]
- T<id> "<title>": [上提到 <位置> | 仅留 CSV 因 <理由>]
- ...
```

### 与上层流程的协作

- **dao-autopilot §5.2.5**: autopilot 收尾时强制走本评估关卡(详见 `commands/dao-autopilot.md`)
- **/dao-cycle 涅槃后合成**: 合成 mature 条目时同步评估每个被合并 lesson 是否需上提
- **/dao-distill 主动整理**: distill 阶段批量走上提评估

### 反模式

| 病 | 症状 | 对治 |
|---|---|---|
| 写 CSV 就跑 | 调 `write_lesson` 完直接 return,不评估上提 | 上提评估是 `write_lesson` 的硬后置,等同流程的一部分 |
| 全判"无需上提" | 默认全部 skip,跳过显式评估 | 必须**逐条**说出判定依据,即便结论"仅留 CSV" |
| 自我审视盲区 | "我不确定是不是跨项目通用,先不提" | 用户视角问: "另一个项目踩到同样坑时,这条 lesson 帮得上吗?" 帮得上 = 上提 |
| 滥提 | 把所有 lesson 都上提到 skill | 仅 CSV 是合理大多数;只有**跨项目方法论 / 项目特定反复踩 / 流程修订**才上提 |

## 遗忘机制

### 写入时
新教训推翻旧教训 → 调用 `deprecate_lesson(old_id, new_id)`

### 搜索时
- `active` → 正常显示
- `deprecated` → 默认隐藏，用 `--include-deprecated` 显示
- `review` → 带 ⚠️ 警告显示

### /dao-evolve 审查时
```powershell
python <skill>/scripts/search.py stale --data-dir <project>/data --threshold 5
```
距最新版本 ≥5 个大版本的 active 教训 → 自动标记为 `review`。

## 合成触发器

| 触发 | 条件 |
|------|------|
| 事件驱动 | /dao-cycle 涅槃、/dao-distill、deploy 完成 |
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
