---
name: dao-user-simulation
description: 用户视角端到端仿真术——以身观身 (54 章)，用 chrome-devtools/playwright MCP 模拟真实用户走完所有交互路径。功能上线前、UI 重大改动后、用户反馈"卡住了"时自动加载。与 dao-test (TDD 红绿) 互补——那是开发者视角，本 skill 是用户视角。
---

# 用户仿真术 · User Simulation Lens

> 修之于身，其德乃真...
> 故以身观身，以家观家...以天下观天下。
> 吾何以知天下然哉？以此。——《道德经》第 54 章

**核心**：不靠分析、不靠假设——**真的代入用户身体，走一遍他的所有路径**。

## 与现有测试概念的边界

| 概念 | 文件 | 视角 | 颗粒 | 工具 |
|---|---|---|---|---|
| TDD 红绿 | `dao-test` skill | **开发者视角** | 函数/模块 | Jest / Vitest / pytest |
| E2E 单测 | `dao-test` 提及 | 开发者视角 | 关键路径 | Playwright（开发者写） |
| **用户仿真** | **本 skill** | **用户视角** | **全交互路径** | **chrome-devtools / playwright MCP（AI 实跑）** |

dao-test 是 spec 验证（"这功能符合需求吗"）；本 skill 是体验验证（"用户用着顺吗"）。

## 何时激活

**必激活**：
- 功能上线前（验收阶段必走一遍）
- UI 重大改动后（按钮挪位、布局变、组件升级）
- 用户反馈"卡住了"/"不对劲"/"用着别扭"
- 跨浏览器/跨设备发布（PC + 移动 + 平板）
- bug 复现需要看实际操作流程

**不必激活**：
- 纯后端无 UI 项目
- 内部脚本/CLI 工具
- 已有完善 E2E 自动化套件且最近一周内运行过

## 工具栈

### 主用：chrome-devtools MCP

最常用工具集（前缀 `mcp0_`）：

```
导航：navigate_page / new_page / list_pages / select_page
快照：take_snapshot（结构 + uid，AI 看的）/ take_screenshot（视觉 + 用户看的）
交互：click / fill / fill_form / press_key / hover / drag / type_text
验证：list_console_messages / list_network_requests / get_network_request
等待：wait_for（出现指定文字）
设备：emulate（视口 + 移动模式 + 网络节流）
性能：performance_start_trace / performance_stop_trace
```

### 辅用：playwright MCP

跨浏览器（Firefox / Safari）测试时切到 playwright MCP。

## 仿真五步（54 章"以身观身"工程化）

```
1. 列 · 列出用户旅程清单（从 dao-empathy 拿 Persona + 路径）
2. 起 · 启动浏览器到目标 URL
3. 走 · 链式 click/fill/snapshot 走完每条路径
4. 听 · 听 console/network 的回响（不仅看 UI）
5. 记 · 记问题对应到 dao-full-coverage 的某维度
```

### 1. 列路径

从 `dao-empathy` skill 取 Persona，穷举用户旅程：

```
□ 主路径：登录 → 主功能 → 完成 → 退出
□ 边界：空状态 / 满状态 / 极限输入
□ 异常：网络断开 / 服务器 500 / 认证过期
□ 跨设备：PC + 移动 + 平板
□ 跨浏览器：Chrome + Firefox + Safari（如必要）
```

每条路径配一个 Persona（"小王第一次用"、"老李天天用"），不要泛泛"用户走主流程"。

### 2. 起浏览器

```javascript
// chrome-devtools MCP
mcp0_new_page({ url: "https://target.example.com" })
mcp0_resize_page({ width: 1280, height: 800 })  // 桌面
// 或移动端：
mcp0_emulate({ viewport: "375x812x3,mobile,touch" })
```

### 3. 走流程

每一步 = `take_snapshot` → 找 uid → `click/fill` → `take_snapshot` 看变化。

```
□ 每个交互前 take_snapshot（拿到当前页面 uid 表）
□ 每个交互后 take_snapshot（验证状态变了）
□ 关键节点 take_screenshot（视觉记录）
□ 复杂路径 wait_for("成功" / 期望文字)
```

**绝不**用脑补的 uid——必须从最新 snapshot 读出来。

### 4. 听回响

UI 看到没问题不代表系统没问题。**必须听这两个声音**：

```javascript
// 走完一条路径后
const consoleMsgs = mcp0_list_console_messages({ types: ["error", "warn"] })
const networkReqs = mcp0_list_network_requests()
```

**红色信号**：
- console error / warn（除非已知豁免）
- network 4xx/5xx（除非是测试 401 等故意场景）
- 接口超时（> 3s 不返回）
- 重复请求（10 秒内同一接口被打多次）

### 5. 记问题

走完一条路径出一份小报告：

```markdown
## 路径：小王首次注册并完成首单

### 问题清单
1. [视] 步骤 3 提交按钮颜色与背景对比度不够，老花眼用户看不清
   → 维度：性能（用户感知）/ 严重度：中
2. [听] 注册后 console 报 "useEffect cleanup leaked" warning（共 3 次）
   → 维度：代码 / 严重度：低（不影响功能但污染日志）
3. [触] 提交后页面跳转有 1.2s 白屏
   → 维度：性能 / 严重度：中
4. [推] "下一步"按钮在禁用时不解释为什么禁用，小王不知道还差什么
   → 维度：UX/empathy / 严重度：高
```

每条问题对应到 `dao-full-coverage` 的某个维度，便于后续聚类。

## 反模式

| 病 | 症状 | 道德经诊断 | 对治 |
|---|---|---|---|
| 只走主流程 | 跑过登录→主功能→退出就声称"测过了" | 不全则不全 | 必跑边界 + 异常 + 跨设备 |
| 看截图就行 | take_screenshot 一张就走 | 看不见底层 | 必听 console + network |
| 脑补 uid | 不 take_snapshot 就 click | 妄作凶 | snapshot → 找 uid → click，链式必走 |
| 用户假设 | "用户肯定先点这里" | 不知常 | 真走 Persona 路径，不走自己习惯路径 |
| 一次性 | 走完不沉淀 | 不归根 | 报告归位 evolution-entries 或体检报告 |
| 跳过 wait_for | 直接 click 下一步 | 不慎终 | 异步操作必 wait_for 期望文字 |

## 与其他 dao-* 协作

- `dao-empathy`（强协作）— empathy 出 Persona 和路径清单，simulation 用 MCP 实跑
- `dao-test`（互补）— TDD 是开发者视角，simulation 是用户视角；可同时跑
- `dao-full-coverage`（数据源）— simulation 报告填到 8 维度的"测试 + 性能"维度
- `dao-debug` — simulation 发现的高严重度 bug 派给 dao-debug 死磕
- `dao-design-taste` — simulation 发现的"视"维度问题反馈给 taste 基石

## 反原则

- **不为仿真而仿真**——纯后端项目无仿真意义
- **不替代单元测试**——simulation 是 E2E 用户视角，不是单元粒度
- **不沉浸过度**——挑核心 3-5 条路径深跑，不要 100 条都跑（违反"图难于其易"）

法不违德，德不违道，道法自然。
