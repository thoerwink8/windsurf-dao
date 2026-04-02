---
name: dao-test
description: 测试镜头：需要为代码添加测试、验证功能正确性时，在 /cycle 中加载此镜头，按 AAA 模式编写高覆盖测试
---

# 测试 · Test Lens

> 名与身孰亲？身与货孰多？得与亡孰病？

## 测试类型选择

| 类型 | 场景 | 常用框架 |
|------|------|---------|
| 单元测试 | 纯函数、工具库 | Jest / Vitest / pytest |
| 集成测试 | 模块间交互 | Vitest / Mocha |
| E2E 测试 | 用户流程 | Playwright / Cypress |
| 回归测试 | Bug 修复验证 | 同上 |

## AAA 模式

每个测试遵循 **Arrange → Act → Assert**：

```javascript
// Arrange: 准备测试数据和环境
const input = createTestData();

// Act: 执行被测行为
const result = doSomething(input);

// Assert: 验证结果
expect(result).toBe(expected);
```

## 必须覆盖的场景

- ✅ **正常路径**（Happy Path）
- ✅ **边界条件**（空值、极值、零、最大长度）
- ✅ **错误路径**（无效输入、权限不足、网络失败）
- ✅ **并发场景**（如适用）

## 命名约定

`should_[预期行为]_when_[条件]`

## 覆盖优先级

核心逻辑优先，边界情况次之。不追求 100% 覆盖率——覆盖关键路径 > 覆盖行数。
