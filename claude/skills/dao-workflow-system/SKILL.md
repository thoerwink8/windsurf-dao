---
name: dao-workflow-system
description: 工作流的选择与协作机制——/dao-dev /dao-cycle /dao-autopilot /dao-commit /dao-distill /dao-evolve /dao-doc /dao-session-sync /dao-thread-tree 各自定位、深度工作模式判断(何时进入静默)、进化触点决策(何时该 /dao-evolve)。讨论"用哪个工作流"或"是否进入静默深度模式"时加载。
---

# 工作流生态 · 怎么协作

> 希言自然。故飘风不终朝，骤雨不终日。

**本 skill vs `commands/dao-*.md`**:本 skill 是**元协作层**(讨论"用哪个工作流/工作流如何配合");`commands/dao-*.md` 是**具体定义**(单个 slash command 的步骤)。本 skill 不重复 command 内容,只描述选择决策。

## 工作流定位

- `/dao-dev` — **主管线**,驱动 `/dao-cycle` 引擎执行各阶段
- `/dao-cycle` — **通用引擎**,通过镜头机制加载领域技能(dao skills + 图书馆 skills 互补)
- `/dao-autopilot` — **持续自主执行模式**,激活后进入扩展内观状态,退出后完全恢复正常
- `/dao-commit` — 从变更生成 commit message 并提交
- `/dao-distill` — 会话级知识沉淀(跨会话 Git 考古已并入 `/dao-evolve`)
- `/dao-evolve` — 审查一切(包括自身) + 快速体检,有感觉才触发
- `/dao-doc` — 按需触发,不强制每个项目都写完整文档
- `/dao-session-sync` — 多会话协作(git 为共享状态,无需其他会话配合)
- `/dao-thread-tree` — 处理 TODO.md Open Threads 未解决项

**技术栈处方**(`claude/stacks/` · 配合 `dao-scaffold` skill):`/dao-dev` 基建审计时按需加载,不是工作流。

## 通信原则

工作流中的执行格式是**参考模板**,不是强制脚本。当自然表达比模板更清晰时,从自然。
**善行无辙迹**——最好的工作流执行是用户感觉不到工作流在运转。

## 深度工作模式(静默执行)

> 大音希声,大象无形。

任务明确 + 用户信任执行时,进入静默深度工作:

- **触发**:复杂多步任务 + 方向已定(用户确认或需求本身足够清晰)
- **行为**:计划 → 静默执行(工具调用为主,文字输出趋近于零)→ 最终报告
- **收尾**:静默执行只减少过程中的打扰;按 `claude/dao.md`「续力·路歧则问」——路明直推不打断,路歧才问
- **`/dao-autopilot` 边界**:是独立隔离工作流,不属于"静默执行";是否调用 AskUserQuestion 以 `commands/dao-autopilot.md` 为准
- **关卡降级**:方向明确时直通,方向分歧时仍止
- **不适用**:方向不明 / 需求有歧义 / 首次合作(信任未建立)
- **本质**:不是跳过思考,是把思考内化

## 进化触点

> 天网恢恢,疏而不失。

不靠感觉,靠节点。以下时刻自问"此任务暴露了系统的哪些缺口?":

- `/dao-dev` 涅槃时
- debug 镜头问道(第四层)时
- 反者道之动触发时(长对话 10 轮+)
- 基础假设被推翻时(发现关键路径不通、核心机制理解有误)
- 逆向重实现时(AGENTS.md / changelog 是必读的第一手资料)

有缺口 → 记录并考虑即时 `/dao-evolve`。无 → 不留痕迹。
