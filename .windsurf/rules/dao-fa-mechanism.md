---
trigger: model_decision
description: Windsurf运行机制参考：注入格式、激活模式、symlink陷阱、AGENTS.md、Cascade Hooks、Skills渐进披露、dao项目目录结构。健康检查/元分析/部署时读取。
---

# Windsurf 天层机制感知

> 知人者智，自知者明。

- 规则文件（always_on）注入 `<user_rules>`，用户规则优先于系统默认
- `// turbo` 注释可让工作流中的安全命令自动执行

## 注入格式

Windsurf 将 `always_on` 规则文件渲染为 `<MEMORY[filename]>` 标签注入 `<user_rules>`——这是 Windsurf 的**渲染格式**，不是 Memory MCP 的条目。当 Memory MCP 图为空、但 `<user_rules>` 中出现 `<MEMORY[...]>` 标签时，说明规则文件链接正常。

## 符号链接读取陷阱

Windows 符号链接/目录联接在不同工具下报告不一致：
- `list_dir` / PowerShell `Get-Item .Length` → 显示 **0**（链接本身大小，非目标内容）
- `mcp2_list_directory_with_sizes` → 显示**实际内容大小**（穿透链接读目标）
- `mcp2_directory_tree` → 目录联接(Junction)可能被识别为"file"类型

**判断文件是否有效**：用 `mcp2_list_directory_with_sizes` 或直接读取内容，不依赖 `list_dir` 的大小报告。

## 全局规则链接状态

`~/.codeium/windsurf/memories/global_rules.md` 应为指向 `windsurf-dao/global_rules.md` 的符号链接，而非副本。副本不会随源更新。用 `/health-check` 定期验证，用 `dao.ps1 link-global` 修复。

## 四类激活模式（Rules）

| trigger 值 | 行为 | 上下文消耗 |
|-----------|------|-----------|
| `always_on` | 每条消息都注入完整内容 | 每轮 |
| `model_decision` | 仅注入 description，模型决定是否读全文 | 按需 |
| `glob` | 匹配到指定文件类型时注入 | 按需 |
| `manual` | 不在提示词中，需 @rule-name 触发 | 手动 |

单个规则文件上限：12,000 字符。全局规则文件上限：6,000 字符。

## AGENTS.md（新机制）

根目录 `AGENTS.md` = always-on，子目录 `AGENTS.md` = glob（按文件位置自动范围）。无需 frontmatter。适合目录级约定，与 `.windsurf/rules/` 互补。

## Cascade Hooks（新机制）

`.windsurf/hooks.json` — 在 Cascade 动作前后执行自定义脚本：`pre_write_code`、`post_run_command`、`pre_user_prompt`、`post_cascade_response` 等。pre-hook 返回 exit code 2 可阻断操作。

## Skills 渐进披露

Skills 只向模型展示 `name` + `description`，完整内容在模型决定调用时才加载。`trigger` 字段在 skills 中无效——需要始终注入的内容应写在 Rules 文件中。

## dao 项目目录结构

```
<project>/
└── .windsurf/
    ├── rules/                   # 项目规则（道·德·法·术四层）
    │   ├── dao-layer.md         # 道层·不变的原则
    │   ├── dao-de-layer.md      # 德层·如何为人（行为协议）
    │   ├── dao-fa-layer.md      # 法层·怎么做
    │   ├── dao-fa-mechanism.md  # 法层参考·Windsurf机制（model_decision）
    │   ├── dao-ask-next-step.md # 续力·每次回答后 ask_user_question
    │   └── dao-shu-layer.md     # 术层·用什么
    ├── workflows/               # 工作流（法层实践）
    │   ├── dao-autopilot.md         # 自动驾驶·自主执行 TODO 中的任务图
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
