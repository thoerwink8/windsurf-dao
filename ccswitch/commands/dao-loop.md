---
description: 双线程循环开发——文档驱动的全自动开发闭环。谋线生成 spec/acceptance/plan，造线自动执行代码。支持多 loop 并发、跨 session 协调。
argument-hint: "[需求描述 或 loop名称]"
---

用户输入：$ARGUMENTS

# 环 · Loop Engineering

> 道生一，一生二，二生三，三生万物。

## 启动流程

### 1. 预飞检查

检查项目结构是否就绪（`docs/specs/`、`docs/PROJECT.md`），检测遗留物（`TODO.md`、散 plan 文件）。不合理 → 提出改造方案 → 用户确认后执行。

### 2. 情境感知

扫描所有 `docs/specs/*/STATUS.json`，展示 Loop 总览表：

```
📋 当前项目已有 Loop：
| Loop | 描述 | 阶段 | 模式 | 进度 | 锁定者 |
```

检测中断的 loop → 弹出警告 + 建议（继续/回退/废弃）。

### 3. 创建或恢复 Loop

**新建**：
- 从用户需求提取语义化命名（kebab-case, 2-4 词）
- 创建 `docs/specs/<topic>/STATUS.json`
- 评估与已有 loop 的关系（merge / parallel / depends_on）

**恢复**：
- 用户指定已有 loop 名称 → 读取 STATUS.json → 从中断点继续

### 4. 谋线

加载 `dao-loop` skill §4，AI 自动生成文档 → 用户确认：
- spec.md → acceptance.md → plan.md → 交叉校验
- 每完成一个文档更新 STATUS.json
- 全部 done + 校验通过 → `go_ready: true`

### 5. Go 检查点

所有必要文档 status = done + 覆盖矩阵完整 → 展示轮询计划 → 用户确认间隔 → 进入造线。

### 6. 造线

加载 `dao-loop` skill §5，按复杂度分诊到 dao-dev 或 dao-superpowers。

### 7. 归档

完成后归档到 `_archive/`，生成 HANDOFF.md + 更新 INDEX.md + 刷新 PROJECT.md。

## 轮询集成

通过 `/loop` + `ScheduleWakeup` 实现自动循环。prompt 模板：

```
执行 dao-loop：
1. 读取 docs/specs/<topic>/STATUS.json
2. 根据 thread + mode 执行对应动作
3. 更新 STATUS.json
4. ScheduleWakeup
目标：<需求>
```
