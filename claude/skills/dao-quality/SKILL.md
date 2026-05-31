---
name: dao-quality
description: 代码质量门——编写或审查代码(.ts/.tsx/.js/.py/.go/.rs/.java/.sql/.vue 等)时按任务领域逐项过的检查清单:安全/数据库/测试/错误处理/性能/前端。匹配领域而非全扫,关卡只提醒"想到了吗",深入交给对应 skill。写代码时加载。
---

# 质量关卡 · Code Quality Gate

> 治大国若烹小鲜。不可不察，不可过察。

> 注:Windsurf 下本规则靠 glob(匹配代码文件类型)自动注入。Claude Code 无原生 glob trigger——本 skill 靠模型按 description 判断加载(软触发);若要强保证"编辑代码文件时必注入",见 dao-fa-mechanism「glob 缺口」的 PreToolUse hook 方案。

## 域检查

编写/审查代码时，**匹配任务领域**逐项过：

| 域 | 关键问题 | 深入 skill |
|---|---|---|
| 安全 | 输入验证了吗？认证授权正确吗？密钥硬编码了吗？ | security-audit |
| 数据库 | 有 N+1 吗？索引合理吗？Migration 可逆吗？ | database-patterns |
| 测试 | 核心路径有测试吗？边界情况覆盖了吗？ | dao-test, webapp-testing |
| 错误处理 | 异常不吞没？用户看到友好消息？服务端日志够？ | express-typescript-api |
| 性能 | 大数据集分页了吗？重复计算？ | dao-optimize |
| 前端 | 响应式？视觉层次？**写前端代码 → 有 pencil 设计稿时照稿实现（`docs/design/*.pen` 为 source of truth）；无设计稿时走 dao-ui-mockup 快速原型**。shadcn 组件按需 add（见 dao-design-assets）；a11y 字号 / shadcn ui/* wrap / html 16px 锚定 / 跟 spec 不估算。typecheck pass ≠ 视觉一致 ≠ 体系一致 | dao-design-assets, dao-ui-mockup, ui-ux-pro-max |

## 原则

- **匹配，不全扫**：写 CSS 不查数据库，改 README 不查安全。匹配当前任务的域
- **知止不殆**：改变量名 / 修 typo 等机械操作不经过关卡
- **做到底**：发现问题当场修，不写 TODO 后续补
- **关卡 → skill**：关卡只提醒"想到了吗"，skill 告诉"怎么做"。有疑问时从图书馆对应 skill
