---
name: dao-observability
description: 重大变更可观测性：判定变更是否需要追踪日志，设计日志方案（级别、位置、密度），生命周期管理。当代码变更涉及操作顺序调整、异步后台任务、外部API调用、共享状态竞争时自动加载。
---

# 可观测性 · Observability

> 知人者智，自知者明。代码不会说谎，但沉默的代码什么都不告诉你。

## 铁律

```
日志是给未来排查问题的自己看的。
写日志时假设：你已经忘了这段代码在做什么。
```

## 何时激活

**自动触发**（检测到以下代码模式时加载）：

- 新增/修改定时任务（`@Interval` / `setInterval` / cron）
- 新增外部 HTTP 请求（`fetch` / `https.request` / `axios`）
- 数据库 schema 变更（`ALTER TABLE` / `CREATE TABLE`）
- 涉及锁 / CAS / 事务的代码修改
- 新增后台异步任务（`Promise` 链、队列消费者）

**标记触发**（编码时主动判断）：

- AI 判断"这个改动改变了关键操作顺序" → 主动加载
- 用户说"加追踪" / "add tracing"

## 两级日志

### 永久日志 · `logger.log` / `warn` / `error`

业务事件的最终结果。永远需要知道的事。

```
用途：操作成功/失败、影响用户的状态变迁、错误和异常
特征：生产环境始终输出，不清退，是系统可观测性的一部分
```

### 追踪日志 · `logger.debug`

验证新功能、排查问题时需要的细节。

```
用途：关键路径耗时、中间状态数值、分支决策走向
特征：生产环境默认不输出（零开销），LOG_LEVEL=debug 时开启
```

## 日志点选择

### 记录什么

| 节点 | 内容 | 级别 |
|------|------|------|
| 外部 API 调用 | 耗时 + 成功/失败 + 关键参数 | debug（成功）/ warn（失败） |
| 状态变迁 | old → new 值 | log（业务）/ debug（中间状态） |
| 分支决策 | 走了哪条路 + 为什么 | debug |
| 定时任务 | 触发 + 处理量 + 耗时 | log（有动作）/ debug（空跑） |

### 不记录什么

```
× 函数进出（"entering function X"）
× 变量赋值（"setting x = 5"）
× 循环内部（除非怀疑是 bug 源头）
× 显而易见的事（"query returned results"）
```

### 密度控制

```
一般函数:         0-1 条 debug
关键流程函数:     2-4 条 debug
超过 5 条/函数 =  函数太复杂，应该拆分
```

## 日志结构

一条好的日志：**[模块] 事件 上下文**，一行包含所有排查信息。

```typescript
// ✅ 好：一行包含所有排查信息
this.logger.debug(`[switch] auth=${authMs}ms old=${oldEmail} new=${newEmail} D:${dOut}→${dIn}`);

// ❌ 差：信息碎片化
this.logger.debug(`[switch] auth complete`);
this.logger.debug(`[switch] took ${authMs}ms`);
this.logger.debug(`[switch] old: ${oldEmail}`);
```

## 生命周期

### 平时

debug 日志在代码里，生产不输出，零影响。**不需要管。**

### /dao-cycle 省阶段

审视当前文件时顺手检查：

1. `git blame` 文件中的 `logger.debug` 行
2. 加了超过 7 天的 → 检查这期间有没有相关 bug/排查
3. 没有 → 删掉
4. 有 → 保留

### /dao-evolve

全项目扫描 `logger.debug` 行，批量清退过期追踪日志。

### 排查模式

线上出问题时：`LOG_LEVEL=debug` 临时开启，排查完恢复。
