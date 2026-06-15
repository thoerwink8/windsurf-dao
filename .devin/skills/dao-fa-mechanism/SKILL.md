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

## dao 项目目录结构（v3 · 2026-06 重构后）

> 废除"道德法术四层"概念，对齐 Windsurf 4 trigger 机制。详见 `.devin/rules/README.md`。

```
windsurf-dao/
├── dao.ps1                     # 链接管理（部署 dao 到各宿主）
├── dao-sync.bat                # 配置同步四合一（export/restore/doctor/inventory）
├── global_rules.md             # 31 行元规则（symlink → ~/.codeium/windsurf/memories/）
├── .devin/                     # Windsurf 侧
│   ├── rules/                  # always_on/model_decision/glob/manual 规则
│   ├── workflows/              # 9 个工作流
│   ├── stacks/                 # 技术栈处方
│   └── skills/                 # 24+ skills（4 类）
├── ccswitch/                   # 多客户端部署源（Claude Code / Codex / 未来平台）
│   ├── dao.md                  # 道德经场域根基（@import 注入）
│   ├── skills/dao-*/           # 技能
│   ├── commands/dao-*.md       # slash command
│   ├── agents/dao-*.md         # subagent profiles
│   ├── hooks/                  # commit-msg + PostToolUse hooks
│   ├── mcp/                    # MCP 服务器启动脚本
│   └── stacks/                 # 技术栈处方
├── config-sync/                # cc-switch 配置同步引擎
│   ├── lib/                    # sync.mjs + 子模块
│   └── common/                 # 结构模板
├── docs/
│   ├── evolution/              # 演化 CSV
│   ├── specs/                  # 设计文档
│   └── classics/               # 道德经等原典（推导源头，不可修改）
├── scripts/hub/                # dao-hub 隧道（ngrok）
└── tests/                      # 测试
```
