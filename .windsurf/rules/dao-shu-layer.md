---
trigger: always_on
---

# 术层 · 用什么

> 朴散则为器，圣人用之，则为官长，故大制不割。
> 三十辐共一毂，当其无，有车之用。埏埴以为器，当其无，有器之用。
> 故有之以为利，无之以为用。

道层见 dao-layer.md，德层见 dao-de-layer.md，法层见 dao-fa-layer.md。

## 项目结构

```
<project>/
└── .windsurf/
    ├── rules/                   # 项目规则（道·德·法·术四层）
    │   ├── dao-layer.md         # 道层·不变的原则
    │   ├── dao-de-layer.md      # 德层·如何为人（行为协议）
    │   ├── dao-fa-layer.md      # 法层·怎么做
    │   └── dao-shu-layer.md     # 术层·用什么（本文件）
    ├── workflows/               # 工作流（法层实践）
    │   ├── dao-commit.md            # 提交·归藏
    │   ├── dao-cycle.md             # 转法轮·深度迭代
    │   ├── dao-debug-escalation.md  # 调试升级·逐层诊断
    │   ├── dao-dev.md               # 开发管线·全流程交付
    │   ├── dao-distill.md           # 知识沉淀·归虚
    │   ├── dao-doc.md               # 文档·传灯
    │   ├── dao-evolve.md            # 进化·自我审视
    │   ├── dao-health-check.md      # 健康检查·自知
    │   ├── dao-review.md            # 代码审查·纳谏
    │   ├── dao-test.md              # 测试·验证
    │   ├── dao-refactor.md          # 重构·安全优化
    │   └── dao-optimize.md          # 性能·调优
    └── skills/                  # 技能（术层实践）
        ├── dao-reverse-engineering/   # 逆向拆解术·锚展交验归
        ├── dao-boundary-probe/        # 边界探测术·识壁探路择水
        ├── dao-frontend-aesthetics/   # 前端审美术·约层色密器
        ├── dao-windsurf-extension/    # Windsurf扩展术·webview·存储·认证
        └── dao-terminal-resilience/   # 终端韧性术·五感降级恢复
```

## MCP 工具

外部连接的工具（肾·外联）：

| MCP             | 域     | 用途                               |
| --------------- | ------ | ---------------------------------- |
| chrome-devtools | 浏览器 | 页面交互、性能分析、截图           |
| context7        | 文档   | 获取最新库/框架文档                |
| filesystem      | 文件   | 文件操作（读写移动）               |
| github          | 代码   | GitHub API（含 Clash 代理自检）    |
| memory          | 记忆   | 虚的载体（临时，涅槃时归位后清空） |
| playwright      | 浏览器 | 无头浏览器自动化、JS渲染SPA交互    |

**注**：MCP 工具集因环境而异，每次对话可从工具调用的可用列表中确认实际加载了哪些工具。

## 中间物管理

> 飘风不终朝，骤雨不终日。

分析脚本、临时查询、调试辅助——皆为中间物，用完即散：

- **生时有序**：集中放在 `_tmp/` 或 `_scratch/`，不散落项目根目录
- **用后即清**：任务完成或方向确定后清理，不留熵
- **知识不随器灭**：中间物的洞察归入项目文件或规则，脚本本身可弃

Memory与中间物同理——都是虚的表现，用完归位后消散。

## 项目集成

> 善行无辙迹，善言无瑕謫。

dao 配置通过 `dao.ps1 link` 链接到目标项目（备用：复制），与项目自有文件和谐共存：

**命名空间**：所有 dao 来源的文件统一使用 `dao-` 前缀，一眼分清来源。

| 类型 | dao 元层 | 项目操作层 |
|------|---------|------------|
| Rules | `dao-layer.md`、`dao-de-layer.md` 等 | `ask-next-step.md` 等 |
| Skills | `dao-boundary-probe/` 等 | `frontend-design/` 等 |
| Workflows | `dao-cycle.md` 等 | `commit.md`、`review.md` 等 |

**本地忽略**：dao 文件通过 `.git/info/exclude` 本地忽略，不用 `.gitignore`（dao 配置是个人工作方式，不应强加给团队）。

**自动同步**：在 windsurf-dao 仓库中新增或删除 dao-* 文件后，执行 `dao.ps1 sync` 将变更传播到所有已注册项目。AI 在写完新 dao-* 文件后应自动执行此命令。

### 变更守卫

> 道文件是元层（怎么思考/工作），不是操作层（用什么技术栈）。两层正交，不可混淆。

**编辑 dao-* 文件前过三关**：
1. **通用性**：换到完全不同的项目还成立吗？不成立→写项目的 AGENT.md
2. **内容边界**：只允许思维方式/工作流程/行为准则。禁止：技术选型/框架/API/配置
3. **影响评估**：会让其他链接项目的 AI 行为变差吗？不确定→不改

**不通过 → 路由到项目的 AGENT.md。**

## 器的减法

> 为学日益，为道日损。

每次 /evolve 审查：未用的Skill删、重叠的MCP留一、散落的中间物清。
器虽散，不忘朴。大制不割。
