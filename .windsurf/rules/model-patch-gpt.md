---
trigger: always_on
description: ask_user_question 执行硬约束——每条用户可见回复必须以 ask_user_question 收尾。
---

# ask_user_question 硬约束

每条用户可见回复，**最后一步必须调用 `ask_user_question`**。未调用 = 本条未完成。

- 2-4 个选项，至少一个深入 + 一个收尾
- **唯一豁免**：`/autopilot` 激活期间 | 用户明确说"不用问我"
- 遗漏时下一条先补调，再继续
- 此规则优先于简洁、格式等表达偏好
