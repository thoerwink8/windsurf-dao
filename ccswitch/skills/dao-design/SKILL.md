---
name: dao-design
description: 设计工作双端统一入口——静默扫描上下文后识别模式，动态呈现最相关的操作选项。OD 端原型设计与 CLI 端实施同步从这里路由，用户无需记住子命令。
argument-hint: "[sync|实现 X|升格|反向生成|审计|系统|OD提示词]"
disable-model-invocation: true
---

# 设计工作统一入口 · dao-design

> 太上不知有之。最好的路由让用户感觉不到路由在运转——只看到「对，就是这个」的选项。

## Supporting Files

本 skill 包含以下 supporting files（按需 Read，不预加载）：

| 文件 | 原 skill | 职责 | 何时读取 |
|---|---|---|---|
| [asset.md](asset.md) | dao-design-asset | 设计资产生命周期（§A 反向生成 / §B 升格 / §C 一键实施） | 路由到实施/升格/反向生成时 |
| [open.md](open.md) | dao-design-open | Open Design 消费引擎（结构提取 + QA 循环） | UI 任务涉及 design/ 目录时 |
| [sync.md](sync.md) | Read [sync.md](sync.md) | 设计-代码漂移同步 | 路由到同步/漂移检测时 |
| [system.md](system.md) | Read [system.md](system.md) | 设计系统基础层生成器（10 类 token） | 路由到设计系统时 |
| [fidelity.md](fidelity.md) | Read [fidelity.md](fidelity.md) | 还原度五层金字塔 | 还原度验证/审计时 |
| [standards.md](standards.md) | dao-design-standards | 审美判据·体检表·布局方法论 | 需要设计判据时 |
| [component-radar.md](component-radar.md) | dao-component-radar | 结构健康门（组件提炼检测） | UI 文件编辑时 |

## 跨 skill 路由铁律

> 鱼不可脱于渊。跨 skill 调用必须走交接模式，绝不即兴发挥。

**当路由目标是本 skill 内的 supporting file**：直接 Read 对应文件，按其中的章节指令执行。

**当路由目标是外部 skill（如 dao-loop）**：输出交接信息 + 提示用户输入 `/命令名`。格式：

```
📋 {功能名} · 准备就绪

  {上下文摘要：草稿路径、状态、关键信息}

→ 请输入 `/dao-loop {功能名}` 启动双线程开发
```

**禁止**：尝试通过 Skill 工具调用不在可用列表的 skill、在无法加载目标 skill 时从记忆即兴发挥协议。

---

**没有固定子命令**。执行路径由参数决定：

```
/dao-design [args?]
     ↓
§P 前置意图解析
  ├── 有明确意图动词 ─→ 定位 + 快速确认（跳过 §0/§1）
  ├── 有功能名但无动词 ─→ 定位草稿 + 按状态给选项（跳过 §0/§1）
  └── 无参数 ─→ §0 静默扫描 → §1 模式识别
     ↓
AskUserQuestion（选项由上下文动态构建）
     ↓
§2 路由执行
```

---

## §P · 前置意图解析（Inline Intent Parse）

> 图难于其易。用户已经给出意图信号时，跳过完整扫描，直接验证 + 确认。

**命令有参数时，先过此节；无参数直接跳到 §0。**

### §P.1 · 意图动词识别

从参数里提取意图动词和功能名：

| 参数模式 | 识别结果 | 路由目标 |
|---|---|---|
| `实现 X` / `代码实施 X` / `跑 §C X` | intent=实施, scope=X | Read [asset.md](asset.md) §C |
| `同步` / `sync` / `漂移` / `检测` | intent=同步漂移 | Read [sync.md](sync.md) |
| `新建 X` / `开工作区 X` / `新增 X` | intent=新建, name=X | Read [asset.md](asset.md) §B.0 |
| `升格 X` / `合并 X` / `发布 X` | intent=升格, workspace=X | Read [asset.md](asset.md) §B |
| `验收 X` / `标记完成 X` | intent=验收, scope=X | 更新 CONTEXT.md 状态 |
| `反向生成` / `从代码生成` / `§A` | intent=反向生成 | Read [asset.md](asset.md) §A |
| `看状态` / `列草稿` / `状态` | intent=查看状态 | 读 CONTEXT.md 展示 |
| `设计系统` / `token` / `system` | intent=设计系统 | Read [system.md](system.md) |

提取到 intent 后，进入 §P.2 定位 scope；未能提取 intent，进入 §P.3 纯功能名解析。

### §P.2 · 有意图 + scope：定位草稿 + 快速确认

从 `design/CONTEXT.md` 活跃草稿区对 scope（功能名）做关键词模糊匹配：

**匹配唯一 → 呈现快速确认：**

```
✅ 找到草稿「{scope}」

  草稿路径：design/workspaces/{name}/workspace.html
  目标正式稿：design/{page}.html
  当前状态：{CONTEXT.md 状态列内容}

即将执行：{路由目标}（{路由动作描述}）

继续？
```

选项：
- 「确认，直接实施（§C）」→ Read [asset.md](asset.md) §C
- 「走 dao-loop 完整流程」→ **交接**：输出上下文摘要，提示用户输入 `/dao-loop {scope}`
- 「先看草稿摘要」→ 展示 WORKSPACE.md + HANDOFF.md 摘要后再次确认
- 「取消」→ 停止

**匹配多个 → 列出候选让用户选：**

```
找到多个匹配「{scope}」的草稿：
  1. 「{scope1}」→ design/workspaces/{name1}/
  2. 「{scope2}」→ design/workspaces/{name2}/

哪一个？
```

**零匹配 → 降级到 §P.3 纯功能名逻辑，再降级到 §0。**

### §P.3 · 只有功能名，无意图动词

参数看起来是功能名（如 `换个方向`、`round-regen`）但没有动词，对 CONTEXT.md 做关键词匹配，**按草稿当前状态决定选项**：

| 草稿状态 | 第一个选项 | 第二个选项 |
|---|---|---|
| ✅ 验收通过，待升格 + 代码实施 | 「实施「{scope}」代码」→ §C | 「先看草稿详情」 |
| 进行中 / 设计中 | 「查看「{scope}」完成标志」 | 「标记验收通过 → 升格实施」 |
| 未找到 | 「新建草稿工作区「{scope}」」→ §B.0 | 「重新描述功能名」 |

---

## §0 · 静默扫描（Scan Before Ask）

> 不知常妄作凶。先看现状，再问意图。

**并行读取（全部静默，不输出过程）**：

1. 当前工作目录路径（判断所在端）
2. `design/CONTEXT.md` 活跃草稿区（草稿条目 + 状态列）
3. `design/workspaces/` 目录列表（实际草稿目录）
4. `design/` 目录是否存在（判断项目结构）

**所在端判断**：

| cwd 特征 | 判断结果 |
|---|---|
| 路径含 `Open Design` 或 `AppData` 下的项目数据目录 | OD 端 |
| 路径含代码项目根（有 `src/` / `package.json` / `CLAUDE.md`） | CLI 端 |
| 路径含 `design/workspaces/` | CLI 端 |

无法判断时默认 CLI 端，选项里加「我在 OD 端」作为第一条。

---

## §1 · 模式识别

扫描完成后，按以下优先级依次匹配场景模式（取第一个命中的）：

### 模式 A · 有待实施草稿

**命中条件**：CONTEXT.md 活跃草稿区存在状态含「验收通过」的条目。

**输出**：

```
📋 发现 {N} 个草稿已验收通过，等待代码实施：
  「{scope1}」→ 目标：design/{page1}.html
  「{scope2}」→ 目标：design/{page2}.html  （若多个）
```

**动态选项**（按草稿数量构建）：
- 「实施「{scope1}」代码」→ Read [asset.md](asset.md) §C
- 「走 dao-loop 实施「{scope1}」」→ **交接**：输出上下文摘要，提示用户输入 `/dao-loop {scope1}`
- 「先看草稿详情再决定」→ 读 WORKSPACE.md + HANDOFF.md 摘要后再次呈现
- 若有多个：「依次实施全部 {N} 个」→ 串行 Read [asset.md](asset.md) §C
- 「做点别的」→ 展示模式 D 的选项

---

### 模式 B · 有进行中草稿（CLI 端）

**命中条件**：CONTEXT.md 有「进行中」条目，且所在 CLI 端。

**输出**：

```
🔧 发现 {N} 个设计草稿进行中：
  「{scope}」· design/workspaces/{name}/
  完成标志：{已完成 X / 共 Y 条}
```

**动态选项**：
- 「查看「{scope}」完成标志」→ 展示 WORKSPACE.md 升格条件列表
- 「标记验收通过 → 升格 + 实施」→ Read [asset.md](asset.md) §C
- 「只升格不实施代码」→ Read [asset.md](asset.md) §B
- 「做点别的」→ 展示模式 D 的选项

---

### 模式 C · 有进行中草稿（OD 端）

**命中条件**：workspaces/ 下有草稿目录，且所在 OD 端。

**输出**：

```
🎨 发现 {N} 个草稿工作区：
  {name1}/workspace.html
  {name2}/workspace.html  （若多个）
```

**动态选项**：
- 「继续迭代「{name1}」」→ 提示打开 workspaces/{name1}/workspace.html
- 「验收当前草稿 + 补充 HANDOFF.md」→ 走 §O.4 检查清单（Read [asset.md](asset.md) §O.4）
- 「新建功能原型」→ 走模式 E 新建流程
- 「做点别的」→ 展示模式 E/F 选项

---

### 模式 D · 无草稿，干净状态（CLI 端）

**命中条件**：无活跃草稿，所在 CLI 端。

**动态选项**：
- 「检测设计/代码漂移」→ Read [sync.md](sync.md)
- 「从代码反向生成设计原型」→ Read [asset.md](asset.md) §A
- 「新建功能工作区」→ Read [asset.md](asset.md) §B.0
- 「查看设计系统 token」→ Read [system.md](system.md)

---

### 模式 E · OD 端，无草稿（新功能）

**命中条件**：所在 OD 端，无进行中草稿（或用户选「新建」）。

**动态选项**：
- 「新建功能原型」→ 询问功能名 → 创建 workspaces/{name}/（§O.0）+ WORKSPACE.md（§O.1）
- 「迭代已有正式稿」→ 列出 design/*.html 供选择，复制为草稿起点
- 「查看当前所有正式稿状态」→ 读 design/CONTEXT.md 完整展示

---

### 模式 F · 无法判断端 / 首次使用

**命中条件**：无法确定所在端，或 design/ 目录不存在（项目未初始化设计结构）。

**动态选项**：
- 「我在 OD 端，要开始设计」→ 走模式 E
- 「我在 CLI 端，要实施/同步」→ 走模式 D
- 「帮我初始化项目设计结构」→ **交接**：提示用户输入 `/dao-project-scaffold`

---

## §2 · 路由执行

用户从动态选项中选择后，路由到对应章节或交接到外部 skill，**传递所需上下文**（草稿名、功能名、扫描结果），不让用户重复输入。

### 内部路由（Read supporting file）

| 意图 | 路由目标 | 传递上下文 |
|---|---|---|
| 实施草稿代码（轻量） | Read [asset.md](asset.md) §C | scope / 草稿路径 |
| 升格草稿 | Read [asset.md](asset.md) §B | 工作区名 |
| 反向生成设计原型 | Read [asset.md](asset.md) §A | 目标页面 |
| 同步漂移 | Read [sync.md](sync.md) | — |
| 新建工作区 | Read [asset.md](asset.md) §B.0 | 功能名 |
| 还原度验证 | Read [fidelity.md](fidelity.md) | 目标页面 |
| 设计系统 token | Read [system.md](system.md) | — |
| OD 新原型（§O.0） | Read [asset.md](asset.md) §O.0 | 功能名 |
| OD 验收 + HANDOFF（§O.4） | Read [asset.md](asset.md) §O.4 | 工作区名 |

### 外部交接（handoff to another `/` command）

| 意图 | 交接目标 | 输出内容 |
|---|---|---|
| 完整流程实施 | `/dao-loop {scope}` | scope + 草稿路径 + HANDOFF.md 摘要 |
| 初始化项目结构 | `/dao-project-scaffold` | — |

---

## §3 · 反模式

1. **扫描前就呈现固定选项** — 选项必须基于实际扫描结果构建，绝不硬编码「A 实施 B 同步 C 新建」
2. **忽略模式优先级** — 有待实施草稿（模式 A）时，第一个选项必须是「实施代码」，不能先推「同步漂移」
3. **OD/CLI 端判断错误** — 在 OD 端展示 CLI 命令、或在 CLI 端展示 OD 操作，会让用户困惑
4. **路由时不传上下文** — 用户选了「实施「换个方向」」后，路由到 §C 必须带上 scope，不让用户再输入一遍
5. **模式未命中时报错** — 无匹配模式时走模式 F（兜底选项），不报「无法识别场景」
6. **扫描失败时假装成功** — CONTEXT.md 读取失败时明确提示「无法读取草稿状态」，并提供手动指定选项

---

## §V · 验收截图标准（跨流程）

> 善行无辙迹。截图不是额外步骤，是 AI 完成 UI 改动后的自然收尾——用户看图验收，不看代码猜效果。

**触发条件**：本次会话通过 dao-design 任一流程（sync / 实施 / 升格后实施 / 还原度验证）修改了含 JSX 的 `.tsx` 文件或 CSS 文件。

### §V.1 · 截图目录

路径：`<项目根>/_tmp/qa/<context>/`。`<context>` 规则见 dao.md Shell 节"截图路径强制"——默认 `<branch>--<topic>` 双段标识。

### §V.2 · 执行步骤

1. **确认服务可用**：dev server（代码实现）+ 静态 HTTP server（设计原型，仅有 `design/` 目录时）。如未运行则启动
2. **Playwright 截图受影响页面**：每个受影响页面各截 `{page}-design.png`（设计稿）+ `{page}-code.png`（代码实现）。未改动的页面不截
3. **告知用户截图目录**：输出绝对路径，用户自行浏览验收

### §V.3 · 与子流程的关系

| 子流程 | §V 行为 |
|---|---|
| sync.md §4.2 快速模式 | 同步完成后执行 §V（替代 QA 循环） |
| sync.md §4.3 完整模式 | QA 循环已含截图，§V 补最终验收截图 |
| asset.md §C 一键实施 | 实施完成、typecheck 通过后执行 §V |
| fidelity.md 审计 | 审计本身产出截图，`<context>` 固定 `fidelity` |
| 非 dao-design 的 ad-hoc UI 改动 | 改了 UI 组件就截，不限于 `/dao-design` 触发 |

### §V.4 · 不做什么

- 不做自动 pixel diff（留给 fidelity.md L3 回归测试）
- 不阻塞流程（截图失败报错但不阻止提交）
- 不截未改动页面（避免噪音）
