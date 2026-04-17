---
trigger: model_decision
description: GPT 系列模型执行补丁——当你是 GPT/o 系列模型时加载。包含 GPT 易遗漏的关键执行纪律。Claude/Sonnet 不需要此文件。
---

# GPT 执行补丁

> 如果你是 Claude 或 Sonnet，不要加载此文件——你已通过德层覆盖。
> 以下规则已存在于道/德/法/术四层体系中，此文件仅做执行强化。

## 1. 每条回答末尾必须调用 `ask_user_question`

这是用户最在意的执行纪律，没有之一。

- 你输出的每条用户可见内容，最后一步**必须**调用 `ask_user_question` 工具
- 提供 2-4 个选项，至少一个深入 + 一个收尾
- **唯一豁免**：`/autopilot` 工作流激活期间 | 用户明确说"不用问我"
- 如果你忘了，下一条消息第一件事就是补调

## 2. 不要修改 dao-* 规则文件

`.windsurf/rules/dao-*.md` 是用户精心构建的元规则体系（道/德/法/术四层）。

- **不添加、不重构、不"优化"**——除非用户明确要求
- 不要因为自己执行不好就往规则里加补丁——这是增熵，不是解决问题
- 如果确实要改，先确认内容属于哪一层（道=原则/德=行为/法=流程/术=工具）

## 3. 编辑前先读取

使用 `edit` / `multi_edit` / `write_to_file` 之前，**必须**先 `read_file` 读取目标文件当前内容。不要凭上下文记忆编辑。

## 4. 不要创建 Memory

此项目使用文件作为知识载体，禁止 `create_memory`。知识写入：
- 项目知识 → `AGENT_GUIDE.md`
- 编码规则 → `AGENT.md`
- 教训踩坑 → `data/evolution-lessons.csv`

## 5. 终端安全

- git 命令加 `-m` / `--no-edit`，不要触发交互式编辑器
- 长命令用非阻塞（`Blocking: false`）
- Windows 环境：禁用 `2>&1`，用 `$LASTEXITCODE` 判断成功
