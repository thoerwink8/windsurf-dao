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

### 2. 情境感知 + 孤儿检测

#### 2a. 参数解析

解析 `$ARGUMENTS`，判断是否匹配已有 Loop 名称（即 `docs/specs/<name>/STATUS.json` 存在）：

- **匹配已有 Loop** → 标记为"恢复目标"，进入续做流程（§3 恢复）
- **不匹配** → 视为新需求，进入孤儿检测

#### 2b. 孤儿检测（🔒 开新 Loop 前必过）

扫描所有 `docs/specs/*/STATUS.json`，收集 `status !== "archived"` 的 Loop（恢复目标排除在外）。

**无孤儿** → 展示已归档 Loop 总览表 → 进入 §2.5

**有孤儿** → 展示总览表后**逐个**处理。对每个孤儿 Loop 用 `AskUserQuestion` 询问：

```
⚠️ 检测到未归档 Loop：<name>
状态: <status> | 进度: <completed>/<total> | 上次活动: <日期>
描述: <description>

请选择处理方式：
```

四个选项：

| 选项 | 行为 |
|---|---|
| **续做** | 生成续做提示词（含 Loop 上下文），用户拿到新会话执行。**不中断当前流程**，继续处理下一个孤儿 |
| **归档** | 当场执行 §6.5 验收 + §7 完整归档 |
| **废弃** | 标 `status: "abandoned"`，记录废弃原因到 STATUS.json |
| **暂不处理** | 保留原样，跳过此 Loop |

**续做提示词模板**（copy-ready，含上下文）：

```
/dao-loop <name>

---上下文---
描述: <description>
状态: <status> | 进度: <completed>/<total>
上次活动: <日期>
当前阶段: <current_phase（如有）>
```

**全部处理完 → 汇总展示**：

```
📋 孤儿处理汇总：
| Loop | 决定 | 备注 |
| design-xxx | 续做 | 提示词已生成 ↑ |
| design-yyy | 归档 | 已归档到 _archive/ |
...
```

如有"续做"项，统一列出所有续做提示词方便复制。汇总后 → 进入 §2.5，执行用户的原始新需求。

> 递归安全：当 §2a 识别到参数是已有 Loop 名（续做意图），该 Loop 不进入孤儿检测。其他非 archived Loop 仍正常检测。这打断了"续做提示词 → 新会话 → 又检测到同一孤儿"的递归。

#### 2c. Loop 总览表

无论是否有孤儿，都展示：

```
📋 当前项目 Loop 总览：
| Loop | 描述 | 状态 | 进度 | 上次活动 |
```

### 2.5 Loop 计划确认 + 提示词分发（🔒 必止）

展示 Loop 计划（名称/描述/分支/文件集/间隔），用户确认后**生成 copy-ready 提示词**，当前 session 暂停此 loop。用户复制提示词到新会话执行。单 loop 场景可选择当前 session 直接继续。

### 3. 创建或恢复 Loop

**新建**（用户已确认计划后）：
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

**Spec 三文件同步**：每个 Task commit 后必须同步更新 STATUS.json + plan.md + acceptance.md 三个文件，不能只更新 STATUS.json。

### 6.5 验收比对（🔒 归档前必须）

plan.md 所有 Task 标 ✅ ≠ 真完成。必须插入验收比对：对照 acceptance.md 逐条核验 → 有新偏差则追加 Task 继续造线 → 无偏差才进入归档。详见 skill §7。

### 7. 归档

验收比对通过后归档到 `_archive/`，生成 HANDOFF.md + 更新 INDEX.md + 刷新 PROJECT.md。

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
