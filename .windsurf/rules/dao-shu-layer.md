---
trigger: model_decision
description: 术层工具——CLI-first原则、MCP配置、CLI工具箱、Skill调用时机（何时加载哪个skill）、中间物管理、项目集成、变更守卫。选择工具、加载skill、或管理项目集成时读取。
---

# 术层 · 用什么

> 朴散则为器，圣人用之，则为官长，故大制不割。
> 三十辐共一毂，当其无，有车之用。埏埴以为器，当其无，有器之用。
> 故有之以为利，无之以为用。

道层见 dao-layer.md，德层见 dao-de-layer.md，法层见 dao-fa-layer.md。目录结构见 dao-fa-mechanism skill。

## 工具哲学：CLI-first

> 一个 `run_command` ≈ 无限个 MCP。Shell 本身就是最通用的工具接口。

**原则**：MCP 仅保留 CLI 无法替代的能力。其余一律用 CLI 工具通过 `run_command` 调用。
**收益**：每减一个 MCP ≈ 节省 1,500-10,000 tokens/轮上下文。

### MCP（仅 CLI 无法替代的）

| MCP             | 域     | 用途                       | 不可替代原因                |
| --------------- | ------ | -------------------------- | --------------------------- |
| chrome-devtools | 浏览器 | DevTools 直连、性能 trace  | 需要 CDP 协议实时交互       |
| context7        | 文档   | 获取最新库/框架文档        | 结构化文档查询，CLI 无等价  |

### CLI 工具箱

| 工具      | 用途                 | 常用命令示例                              |
| --------- | -------------------- | ----------------------------------------- |
| `gh`      | GitHub 全功能        | `gh pr create`, `gh issue list`, `gh api` |
| `git`     | 版本控制             | 已内置                                    |
| `node`    | JS 脚本执行          | 查询脚本、数据处理                        |
| `nest`    | NestJS 脚手架        | `nest g resource`, `nest g module`        |
| `eas`     | Expo 构建/提交       | `eas build`, `eas submit`                 |
| `curl`    | HTTP 请求            | API 测试、webhook 调试                    |
| `npx`     | 临时包执行           | 按需运行任何 npm 包                       |

### gh CLI 代理配置（Windows/PowerShell）

GitHub API 在中国需要代理。使用前设置：
```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
gh api user --jq .login  # 验证连通性
```

**注**：MCP 配置见 `mcp_config.json`，按需恢复禁用项。

## 中间物管理

> 飘风不终朝，骤雨不终日。

分析脚本、临时查询、调试辅助——皆为中间物，用完即散：

- **生时有序**：集中放在 `_tmp/` 或 `_scratch/`，不散落项目根目录
- **用后即清**：任务完成或方向确定后清理，不留熵
- **知识不随器灭**：中间物的洞察归入项目文件或规则，脚本本身可弃

Memory与中间物同理——都是虚的表现，用完归位后消散。

## 项目集成

> 善行无辙迹，善言无瑕謫。

windsurf-dao 作为 **Sidecar workspace** 与目标项目同时打开，rules/skills/workflows 自动跨 workspace 可见。

**命名空间**：所有 dao 来源的文件统一使用 `dao-` 前缀，一眼分清来源。

| 类型 | dao 元层 | 项目操作层 |
|------|---------|------------|
| Rules | `dao-layer.md`、`dao-de-layer.md` 等 | 项目特定 rules |
| Skills | `dao-boundary-probe/` 等 | `frontend-design/` 等 |
| Workflows | `dao-cycle.md` 等 | `commit.md`、`review.md` 等 |

### 变更守卫

> 道文件是元层（怎么思考/工作），不是操作层（用什么技术栈）。两层正交，不可混淆。

**编辑 dao-* 文件前过三关**：
1. **通用性**：换到完全不同的项目还成立吗？不成立→写项目的 AGENT.md
2. **内容边界**：只允许思维方式/工作流程/行为准则。禁止：技术选型/框架/API/配置
3. **影响评估**：会让使用 dao 的其他项目行为变差吗？不确定→不改

**不通过 → 路由到项目的 AGENT.md。**

## Skill 调用时机

> 朴散则为器。Rules 是朴，Skills 是器。

### Rule 与 Skill 的边界

- `.windsurf/rules/*.md` 是 **rule**：通过读取文件生效，不通过 `skill()` 调用
- `.windsurf/skills/*/skill.md` 是 **skill**：仅当工具清单里存在对应 skill 名时才调用

| 场景 | 加载 skill |
|------|------------|
| 需要理解 Windsurf 内部机制 | `dao-fa-mechanism`（注入格式/激活模式/目录结构） |
| 任务属于特定领域 | 对应镜头 skill（见 cycle 镜头表） |
| 代码涉及定时任务/外部API/schema/锁/操作顺序调整 | `dao-observability`（日志设计） |
| 教训/经验/回顾历史/踩坑记录 | `dao-evolution`（BM25 搜索 + CSV 读写） |
| 感知 skill 缺口 | `dao-skill-ecosystem`（供应链） |
| 创建新 skill 后 | `dao-skill-ecosystem`（反向传播评估） |

## 器的减法

> 为学日益，为道日损。

每次 /evolve 审查：未用的Skill删、重叠的MCP留一、散落的中间物清。
器虽散，不忘朴。大制不割。
