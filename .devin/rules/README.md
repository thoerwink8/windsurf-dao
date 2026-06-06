# .windsurf/rules/ · 13 文件导航

> 给人看的总览。AI 自动通过 trigger 加载，不读本文件。

## 5 层架构

```
第 1 层 · 跨项目根基（用户级 user_global Memory）
└─ ../../../global_rules.md（41 行元规则）
   ↓ dao.ps1 link-global（一次性 symlink）
   ~/.codeium/windsurf/memories/global_rules.md
   → Windsurf 自动加载到所有项目（每条消息注入）

第 2 层 · always_on（每条消息注入，仅 dao sidecar）
├─ 2a · 心怀
│  └─ dao-mantra.md      ← 道德经八句根基 + 场景速查表
└─ 2b · 铁律
   ├─ execution.md        ← 项目级血泪经验
   ├─ shell.md            ← 命令安全·全面防卡死
   ├─ knowledge-routing.md ← 知识/中间物/Memory 归位
   └─ superpowers-gate.md ← superpowers 触发门控（与 Windsurf Plan Mode 解耦）

第 3 层 · 操作领域（AI 按场景判断）
├─ cli.md                ← 用什么工具
├─ workflow-system.md    ← 用哪个工作流
├─ project-structure.md  ← 文件放哪里
└─ design-assets.md      ← 怎么做设计

第 4 层 · 精准触发（系统自动）
├─ quality.md  ← 编辑代码文件
└─ dao-meta.md ← 编辑 dao 元层文件

第 5 层 · 深度知识（用户显式）
└─ dao-philosophy.md（manual: @dao-philosophy）
```

## 触发速查

| Trigger | 文件 | 何时加载 |
|---|---|---|
| `user_global`（symlink） | `../../../global_rules.md` | 每条消息（跨所有项目，无需 dao sidecar） |
| `always_on` | `dao-mantra.md` | 每条消息（心怀八句根基，仅 dao sidecar） |
| `always_on` | `execution.md` | 每条消息（仅 dao sidecar 打开时） |
| `always_on` | `superpowers-gate.md` | 每条消息（仅 dao sidecar 打开时） |
| `always_on` | `shell.md` | 每条消息（命令安全为底层铁律） |
| `always_on` | `knowledge-routing.md` | 每条消息（知识/Memory 归位为底层铁律） |
| `model_decision` | `cli.md` | 选择工具时 |
| `model_decision` | `workflow-system.md` | 决策用哪个工作流 |
| `model_decision` | `project-structure.md` | 创建文件/新项目/讨论文件位置 |
| `model_decision` | `design-assets.md` | 涉及 UI 设计/组件/样式 |
| `glob` | `quality.md` | 编辑代码文件（.ts/.py/...） |
| `glob` | `dao-meta.md` | 编辑 dao 元层文件 |
| `manual` | `dao-philosophy.md` | 用户输入 `@dao-philosophy` |

## 重构收益（v2 · 2026-04-26）

废除"道德法术四层"概念，对齐 Windsurf 4 trigger 机制。详见 `data/evolution-lessons.csv` T20-T22。

| 维度 | 旧（5 文件混杂层） | 新（13 文件 5 层架构） |
|---|---|---|
| 触发精准度 | 低（model_decision 全量加载） | 高（4 trigger 各得其所） |
| 单一职责 | 弱（多领域混杂） | 强（每文件单职责） |
| 可演化性 | 难（变更牵一发动全身） | 易（按文件独立演化） |

## 变更治理

完整变更规则见 `dao-philosophy.md` 末尾「变更规则」表。

核心原则：**法不违德，德不违道，道法自然**。
