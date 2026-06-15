---
name: dao-fa-mechanism
description: Windsurf运行机制参考：注入格式、激活模式、AGENTS.md、Cascade Hooks、Skills渐进披露、dao项目目录结构。健康检查/元分析/部署时加载。
---

# Windsurf 天层机制感知

> 知人者智，自知者明。

- 规则文件（always_on）注入 `<user_rules>`，用户规则优先于系统默认
- `// turbo` 注释可让工作流中的安全命令自动执行

## 注入格式

Windsurf 将 `always_on` 规则文件渲染为 `<MEMORY[filename]>` 标签注入 `<user_rules>`——这是 Windsurf 的**渲染格式**，不是 Memory MCP 的条目。当 Memory MCP 图为空、但 `<user_rules>` 中出现 `<MEMORY[...]>` 标签时，说明规则文件链接正常。

## 四类激活模式（Rules）

| trigger 值       | 行为                                   | 上下文消耗 |
| ---------------- | -------------------------------------- | ---------- |
| `always_on`      | 每条消息都注入完整内容                 | 每轮       |
| `model_decision` | 仅注入 description，模型决定是否读全文 | 按需       |
| `glob`           | 匹配到指定文件类型时注入               | 按需       |
| `manual`         | 不在提示词中，需 @rule-name 触发       | 手动       |

单个规则文件上限：12,000 字符。全局规则文件上限：6,000 字符。

## AGENTS.md（新机制）

根目录 `AGENTS.md` = always-on，子目录 `AGENTS.md` = glob（按文件位置自动范围）。无需 frontmatter。适合目录级约定，与 `.windsurf/rules/` 互补。

## Cascade Hooks（新机制）

`.windsurf/hooks.json` — 在 Cascade 动作前后执行自定义脚本：`pre_write_code`、`post_run_command`、`pre_user_prompt`、`post_cascade_response` 等。pre-hook 返回 exit code 2 可阻断操作。

## Skills 渐进披露

Skills 只向模型展示 `name` + `description`，完整内容在模型决定调用时才加载。`trigger` 字段在 skills 中无效——需要始终注入的内容应写在 Rules 文件中。

## dao 项目目录结构（v2 · 2026-04-26 重构后）

> 废除"道德法术四层"概念，对齐 Windsurf 4 trigger 机制。详见 `.windsurf/rules/README.md`。

```
windsurf-dao/
├── global_rules.md             # 31 行元规则（symlink → ~/.codeium/windsurf/memories/）
└── .windsurf/
    ├── rules/                   # 9 文件 5 层架构
    │   ├── execution.md         # always_on · 项目铁律
    │   ├── shell.md             # model_decision · 命令安全
    │   ├── cli.md               # model_decision · 工具选择
    │   ├── workflow-system.md   # model_decision · 工作流协作
    │   ├── knowledge-routing.md # model_decision · 知识归位
    │   ├── quality.md           # glob · 代码质量门
    │   ├── dao-meta.md          # glob · dao 元层守卫
    │   └── dao-philosophy.md    # manual · 八条不变原则
    ├── workflows/               # 9 个工作流
    │   └── dao-{autopilot,commit,cycle,dev,distill,doc,evolve,session-sync,thread-tree}.md
    ├── stacks/                  # 技术栈处方（/dev 基建审计按需加载）
    │   └── frontend-nextjs.md
    └── skills/                  # 24 个 skills（4 类）
        ├── 元层: dao-{fa-mechanism,pyramid,evolution,skill-ecosystem}/
        ├── 镜头: dao-{debug,refactor,optimize,test,observability}/
        ├── 方法论: dao-{brainstorm,plan,execute,review,verify,finish,worktree,parallel}/
        └── 专项: dao-{research,reverse-engineering,boundary-probe,frontend-aesthetics,terminal-resilience,windsurf-extension,deploy}/
docs/classics/
└── 道德经.md                    # 推导源头，不可修改
```
