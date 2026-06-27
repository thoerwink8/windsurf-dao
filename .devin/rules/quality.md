---
trigger: glob
globs: **/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,c,cpp,h,hpp,cs,rb,php,swift,kt,scala,vue,svelte,sql}
---

# 质量关卡 · Code Quality Gate

> 治大国若烹小鲜。不可不察，不可过察。

## 域检查

编写/审查代码时，**匹配任务领域**逐项过：

| 域 | 关键问题 | 深入 skill |
|---|---|---|
| 安全 | 输入验证了吗？认证授权正确吗？密钥硬编码了吗？ | security-audit |
| 数据库 | 有 N+1 吗？索引合理吗？Migration 可逆吗？ | database-patterns |
| 测试 | 核心路径有测试吗？边界情况覆盖了吗？ | test-driven-development, webapp-testing |
| 错误处理 | 异常不吞没？用户看到友好消息？服务端日志够？ | express-typescript-api |
| 性能 | 大数据集分页了吗？重复计算？ | —（已内化到 dao.md） |
| 前端 | 响应式？视觉层次？**写前端代码 → 有 Open Design HTML 原型时照稿实现（`design/` 目录为 source of truth）；无设计稿时走 dao-design-standards 快速原型**。shadcn 组件按需 add（见 `design-assets.md`）；a11y 字号 / shadcn ui/* wrap / html 16px 锚定 / 跟 spec 不估算。typecheck pass ≠ 视觉一致 ≠ 体系一致 | design-assets, dao-design-standards, ui-ux-pro-max |

## 原则

- **匹配，不全扫**：写 CSS 不查数据库，改 README 不查安全。匹配当前任务的域
- **知止不殆**：改变量名 / 修 typo 等机械操作不经过关卡
- **做到底**：发现问题当场修，不写 TODO 后续补
- **关卡 → skill**：关卡只提醒"想到了吗"，skill 告诉"怎么做"。有疑问时从图书馆 Junction 对应 skill
