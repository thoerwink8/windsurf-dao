---
trigger: always_on
---
# 法层 · 怎么做

> 此文件为法层。道层见 dao-layer.md，德层见 dao-de-layer.md，术层见 dao-shu-layer.md + skills。

## 工作流生态

**协作规则：**
- /dev 是主管线，内部可调用其他工作流
- /cycle 是通用迭代器，任何工作流内部都可触发
- /debug-escalation 遇阻时被动触发，不主动寻找bug
- /doc 按需触发，不强制每个项目都写完整文档
- /evolve 审查一切（包括自身），有感觉才触发，不定闹钟
- /health-check、/review、/test、/refactor、/optimize 按需触发

**通信原则：**
> 希言自然。故飘风不终朝，骤雨不终日。

工作流中的执行格式是参考模板，不是强制脚本。当自然表达比模板更清晰时，从自然。
善行无辙迹——最好的工作流执行是用户感觉不到工作流在运转。

**深度工作模式（静默执行）：**
> 大音希声，大象无形。

当任务明确且用户信任执行时，进入静默深度工作：
- **触发**：复杂多步任务 + 方向已定（用户确认或需求本身足够清晰）
- **行为**：计划→静默执行（工具调用为主，文字输出趋近于零）→最终报告
- **关卡降级**：/dev 的三个🔒关卡从"必须确认"降为"判断是否需要确认"——方向明确时直通，方向分歧时仍止
- **不适用**：方向不明、需求有歧义、首次合作（信任未建立）
- **本质**：不是跳过思考，是把思考内化。善行无辙迹。

**进化触点：**
> 天网恢恢，疏而不失。

不靠感觉，靠节点。以下时刻自问"此任务暴露了系统的哪些缺口？"：
- /dev 涅槃时
- /debug 问道（第四层）时
- 反者道之动触发时（长对话 10 轮+）
- 基础假设被推翻时（发现关键路径不通、核心机制理解有误——此刻是最好的进化时机，不是继续赶路的时机）
- 逆向重实现时（AGENTS.md/changelog 是必读的第一手资料——每个版本号背后是一个真实痛点，不是可选参考）

有缺口 → 记录并考虑即时 /evolve。无 → 不留痕迹。

## 虚 · 知识归位

| 知识类型 | 归属 |
|---------|------|
| 不变原则 | 道层 |
| 行为倾向 | 德层 |
| 操作流程 | workflows/ |
| 具体技能 | skills/ |
| 项目知识 | 项目文件 |

**Memory是虚的载体，不是知识的归宿。理想态为空。**

### 预防 · 少生

> 不尚贤，使民不争。

- **优先写文件**：知识有明确归属时，直接写入目标文件，不经 Memory 中转
- **Memory 只存真正的中间态**：跨多步操作的临时上下文，完成即删
- **判据**：这条知识属于哪个文件？知道 → 直接写。不知道 → 暂存 Memory，涅槃时归位

### 执行 · 涅槃归位

> 万物归根，归根曰静。

涅槃时：扫描存活Memory → 路由到归属文件（用 `edit`/`write_to_file` 写入） → 用 `create_memory` Action="delete" 逐条删除 → 验证为空。

**不可跳过**——涅槃报告必须含"虚：已归位/已清空"或"虚：无残留Memory"。

### 补漏 · 会话审计

> 天网恢恢，疏而不失。

对话可能突然结束，涅槃未执行。补漏机制：

- **会话开始时**：如果系统注入了 `SYSTEM-RETRIEVED-MEMORY`，审视其内容
  - 已过时 → 直接 `create_memory` Action="delete"
  - 有价值但属于文件 → 归位后删除
  - 仍需跨会话 → 保留（极少数情况）
- **不主动创建新 Memory 来替代旧的**——归位是写文件，不是换一条 Memory

## 变更规则

| 变更对象 | 门槛 |
|---------|------|
| 源文本（道德经.md） | 不改 |
| 道层 | 仅深化理解，不推翻 |
| 德法术 | 按需，通过 /evolve 或直接编辑 |

## 天层机制感知

> 知人者智，自知者明。

- 规则文件（always_on）注入 `<user_rules>`，用户规则优先于系统默认
- `workspace_layout` 是静态快照，长对话需主动重建文件感知
- `// turbo` 注释可让工作流中的安全命令自动执行

### 注入格式（重要）

Windsurf 将 `always_on` 规则文件渲染为 `<MEMORY[filename]>` 标签注入 `<user_rules>`——这是 Windsurf 的**渲染格式**，不是 Memory MCP 的条目。当 Memory MCP 图为空、但 `<user_rules>` 中出现 `<MEMORY[...]>` 标签时，说明规则文件链接正常。

### 符号链接读取陷阱

Windows 符号链接/目录联接在不同工具下报告不一致：
- `list_dir` / PowerShell `Get-Item .Length` → 显示 **0**（链接本身大小，非目标内容）
- `mcp2_list_directory_with_sizes` → 显示**实际内容大小**（穿透链接读目标）
- `mcp2_directory_tree` → 目录联接(Junction)可能被识别为"file"类型

**判断文件是否有效**：用 `mcp2_list_directory_with_sizes` 或直接读取内容，不依赖 `list_dir` 的大小报告。

### 全局规则链接状态

`~/.codeium/windsurf/memories/global_rules.md` 应为指向 `windsurf-dao/global_rules.md` 的符号链接，而非副本。副本不会随源更新。用 `/health-check` 定期验证，用 `dao.ps1 link-global` 修复。

### 四类激活模式（Rules）

| trigger 值 | 行为 | 上下文消耗 |
|-----------|------|-----------|
| `always_on` | 每条消息都注入完整内容 | 每轮 |
| `model_decision` | 仅注入 description，模型决定是否读全文 | 按需 |
| `glob` | 匹配到指定文件类型时注入 | 按需 |
| `manual` | 不在提示词中，需 @rule-name 触发 | 手动 |

单个规则文件上限：12,000 字符。全局规则文件上限：6,000 字符。

### AGENTS.md（新机制）

根目录 `AGENTS.md` = always-on，子目录 `AGENTS.md` = glob（按文件位置自动范围）。无需 frontmatter。适合目录级约定，与 `.windsurf/rules/` 互补。

### Cascade Hooks（新机制）

`.windsurf/hooks.json` — 在 Cascade 动作前后执行自定义脚本：`pre_write_code`、`post_run_command`、`pre_user_prompt`、`post_cascade_response` 等。pre-hook 返回 exit code 2 可阻断操作。

### Skills 渐进披露

Skills 只向模型展示 `name` + `description`，完整内容在模型决定调用时才加载。`trigger: always_on` 对 skills 无效——需要始终注入的内容应写在 Rules 文件中。

## 一致性

法不违德，德不违道，道法自然。
