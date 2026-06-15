---
name: dao-memory
description: 任务结束、会话复盘、定时回顾、用户反馈后，用于沉淀长期记忆、协作偏好、流程经验、skill 缺口和资料线索；帮助下一次对话更懂用户意图、工作方式和项目演化。
---

# dao-memory · 会话记忆

> 记忆不是聊天记录仓库，而是下一次行动的改进系统。
> 少则得，多则惑。只记能改变未来行为的东西。

## 何时加载

- 用户要求“总结这次任务”“复盘”“沉淀经验”“记录记忆”
- 一项任务、绘画、设计、编码、调试、部署、研究结束后
- 用户纠正了 agent 的工作方式、表达方式或判断方式
- 发现缺少某个 skill、自动化、资料路径或流程规则
- 定时回顾近期任务，整理长期记忆
- 上下文压缩、会话迁移、交接前需要保留关键经验

## 记忆分层

| 类型 | 归位 | 判断标准 |
|---|---|---|
| 任务事件 | `memory/sessions/` | 本次发生了什么，只对当前任务有意义 |
| 长期偏好 | `memory/user-profile.md` | 用户稳定、明确、可复用的偏好 |
| 协作流程 | `memory/workflow-rules.md` | 下次类似任务应改变执行方式 |
| skill 缺口 | `memory/skill-backlog.md` | 需要安装、创建、合并或改进的 skill |
| 资料线索 | `memory/research-log.md` | 查过且未来可能复用的链接、项目、方法论 |

`memory/MEMORY.md` 只放热记忆索引，不放长篇细节；建议不超过 200 行。

## 写入门槛

先问一句：

```text
这是一时事件，还是下次也应该影响 agent 行为的规则？
```

只有满足至少一条才进入长期记忆：

- 用户明确表达了偏好或禁忌
- 同类问题反复出现
- 该经验能明显减少下次沟通成本
- 该流程能稳定提高任务成功率
- 该 skill 缺口未来会重复影响工作

## 防污染规则

- 不根据一次行为推断用户性格。
- 不把项目临时细节写入 `user-profile.md`。
- 不把未经验证的猜测写成长期规则。
- 不把不同工具、产品、项目或会话来源混为一谈；例如 Codex、Claude Code、Claude Desktop、cc-switch、Pencil 是不同对象，必须按用户原话和证据分清边界。
- 不把已被用户废弃的方案继续作为默认路径；只能作为历史背景或反例记录。
- 不自动安装 skill，只记录到 `skill-backlog.md`。
- 不写空泛结论，例如“注意沟通”“提高效率”。
- 长期记忆必须短、具体、可执行、可删除。

## 证据来源与边界

复盘跨会话、跨工具或跨项目内容时，先写清楚证据范围：

```markdown
## 证据范围

- 已读取：<线程、日志、文件、数据库、截图、工具输出>
- 未读取：<不可访问、未命中、被截断或未授权的来源>
- 只能推断：<基于现有证据的判断，不写成事实>
- 明确废弃：<用户已经否定或弃用的方案>
```

如果用户要求“读历史”“继续会话”“从上次接着做”，优先按实际可访问入口恢复上下文：

- Codex 线程：用线程列表和 `read_thread` 读取最近 turn 摘要。
- Claude Code / Claude Desktop：查 `~/.claude/projects/**.jsonl`、桌面端配置和 cc-switch 同步索引。
- cc-switch：查 `cc-switch.db`、`session_log_sync`、skills/prompts/settings 等表，只读定位来源。
- 本地项目：查 `git status`、相关文档、最近改动和会话中提到的产物。

边界不清时，不要直接沉淀偏好；先把“可见证据不足”写入 session 复盘。

## 用户纠偏优先

用户纠正 agent 时，优先沉淀“下次不要再错的边界”，而不是为当前错误找解释。

需要记录：

- 用户原话纠偏了什么。
- agent 当时错把什么对象当成了什么对象。
- 下次遇到同类请求时应该先验证哪个边界。
- 这条规则应该进 `collaboration-style.md`、`workflow-rules.md`，还是只保留在 `sessions/`。

示例：

```markdown
- 用户问 Claude Code 桌面端配置时，不要默认查 Codex 的 `.codex/config.toml`；应先区分 Codex、Claude Desktop、Claude Code CLI 和 cc-switch 的配置路径。
```

## 推荐目录

若当前项目没有记忆目录，建议使用：

```text
memory/
  MEMORY.md
  user-profile.md
  collaboration-style.md
  workflow-rules.md
  skill-backlog.md
  research-log.md
  sessions/
  patterns/
    coding.md
    debugging.md
    design.md
    drawing.md
```

## 工作流

### 一、捕获本次任务

先整理事实，不急着抽象：

```markdown
# 任务复盘：<任务名>

## 本次目标
<用户原始目标和实际完成目标>

## 实际过程
<关键步骤、工具、skills、资料、决策变化>

## 遇到的问题
<卡点、误判、缺上下文、工具限制、失败尝试>

## 解决方式
<最终怎么解决，哪些方法有效>

## 未解决事项
<仍需用户确认、后续跟进或单独处理的内容>
```

### 二、提炼长期记忆候选

从任务复盘里抽取候选项：

```markdown
## 长期记忆候选

### 用户偏好
- <明确、稳定、可复用的偏好>

### 协作流程
- <下次类似任务应该怎么做>

### skill 缺口
- <缺什么 skill，为什么需要>

### 资料线索
- <链接、项目、关键词、方法论>

### 不进入长期记忆
- <一次性事件或噪音，说明为什么不写入>
```

### 三、合并记忆

- `MEMORY.md`：只写最重要、最常用、下次要默认读取的索引。
- `user-profile.md`：只写用户稳定偏好。
- `collaboration-style.md`：写用户希望 agent 如何沟通和配合。
- `workflow-rules.md`：写可执行流程规则。
- `skill-backlog.md`：写 skill 候选，不自动创建。
- `research-log.md`：写外部资料和结论。
- `sessions/`：保留完整任务复盘。

### 四、冷热分层

| 层级 | 说明 | 处理 |
|---|---|---|
| Hot | 下次几乎一定要用 | 保留在 `MEMORY.md` |
| Warm | 偶尔需要，按主题可查 | 放入 topic 文件 |
| Cold | 历史记录，当前不影响行为 | 保留在 `sessions/` |
| Dead | 过期、重复、错误 | 删除或标记废弃 |

## skill 缺口格式

写入 `memory/skill-backlog.md`：

```markdown
## <skill 名称候选>

- 触发场景：
- 要解决的问题：
- 复用频率：
- 可替代方案：
- 建议优先级：高 / 中 / 低
- 状态：候选 / 设计中 / 已创建 / 放弃
```

## 输出格式

复盘时优先输出高信号内容：

```markdown
## 本次沉淀

### 任务经验
- ...

### 长期记忆更新
- ...

### skill 缺口
- ...

### 下次协作建议
- ...
```

如果没有值得写入长期记忆的内容，明确说：

```text
本次只有任务事件，没有足够稳定的长期记忆候选。
```

## 与其他 dao skill 协作

- 设计模糊时先用 `dao-brainstorm`，不要让记忆替代需求澄清。
- 需要外部资料时用 `dao-research`，再把可靠结论写入 `research-log.md`。
- 遇到 bug 时用 `dao-debug`，复盘阶段再用本 skill 沉淀调试经验。
- 教训/踩坑需要可搜索、可追溯时，用 `dao-evolution` 写入 `docs/evolution/evolution-*.csv`。
- 发现 skill 缺口时，联动 `dao-skill-ecosystem` 判断查库、安装还是创建。
- 创建或修改 skill 时用 `skill-creator` 和 `dao-meta`。
- 声明完成前用 `dao-verify` 确认实际结果。

## 完成门

使用本 skill 后，至少说明：

- 本次是否写入长期记忆
- 写入了哪些记忆文件
- 哪些内容只保留为 session 事件
- 是否发现 skill 缺口
