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
| 性能 | 大数据集分页了吗？重复计算？ | dao-optimize |
| 前端 | 响应式？无障碍？视觉层次？ | ui-ux-pro-max |

## 原则

- **匹配，不全扫**：写 CSS 不查数据库，改 README 不查安全。匹配当前任务的域
- **知止不殆**：改变量名 / 修 typo 等机械操作不经过关卡
- **做到底**：发现问题当场修，不写 TODO 后续补
- **关卡 → skill**：关卡只提醒"想到了吗"，skill 告诉"怎么做"。有疑问时从图书馆 Junction 对应 skill
