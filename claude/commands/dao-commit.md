---
description: 从代码变更自动生成 commit message 并提交。当用户说"提交"、"commit"时触发。
---

# 归藏 · Commit

> 万物归根，归根曰静。代码变更归于 git 历史，是信息熵减的最后一步。

## 触发条件

- 用户显式调用 `/dao-commit`
- `/dao-dev` 管线的交付阶段
- 用户说"提交"、"commit"、"generate commit message"

## 流程

### 一、采（☲视·读取变更）

读取变更的命令是只读安全命令，按 settings.json 的 permissions 配置自动执行（无需逐条确认的命令已在 allow 列表）。

1. **并行**获取暂存区状态：
   - `git diff --cached --stat`
   - `git diff --cached`

2. 如果暂存区为空，检查未暂存改动（`git diff --stat`）：

- **有**未暂存改动 → 自动 `git add -A`，重新读取暂存区
- **无**任何改动 → 告知用户"工作区没有任何改动"，**停止**

### 二、析（☶味·理解与分组）

> 大制不割。同一逻辑变更不拆分，不相关的变更不混合。

根据 diff 内容，按**内聚性**判断是否拆分为多次提交：

- **同一模块/同一功能**的改动归为一组
- **跨模块但强关联**的改动归为一组（如共享配置 + 消费方更新）
- **不相关的模块/功能**拆分为不同组
- 所有改动属于同一逻辑变更 → **不拆分**

**版本检查门（硬门控，不可跳过）**：

分组完成后，对每一组执行以下检查：

1. **判断是否功能性变更**：type 属于 `feat`/`fix`/`refactor`/`perf` → 是功能性变更；`docs`/`chore`/`style`/`test` → 跳过版本检查
2. **如果是功能性变更**：检查该组的 diff 中是否包含对应组件的版本文件（`package.json` 的 `"version"` 字段、`app.json` 的 `version` 或 `runtimeVersion` 等）
3. **版本文件不在 diff 里** → **暂停提交流程**，先执行版本 bump：
   - 按 `AGENT.md §版本纪律` 的组件版本地图，找到该组件对应的版本文件
   - patch 级别：`"version": "x.y.z"` → `"version": "x.y.(z+1)"`（bug修复/小功能）
   - bump 完成后，将版本文件加入暂存区，再继续后续流程
4. **版本文件已在 diff 里** → 直接继续，commit message 尾部带 `(vX.Y.Z)`

### 三、铸（☳触·生成并提交）

> commit 是本地快照，可随时撤销；push 才是不可逆的发布。因此 commit 前展示预览，push 需用户显式触发。

对每一组执行：

1. （仅拆分时）`git reset HEAD` 取消暂存，然后 `git add <该组文件>`
2. 生成 commit message（见下方规范）
3. **展示预览**：

   ```
   📝 准备提交：
   <commit message 完整内容>

   涉及文件：<文件列表>
   ```

   - **单组、内聚清晰、用户已显式触发** `/dao-commit`（路明）→ 展示预览后直接提交，不打断。
   - **路歧则问**（多组拆分需用户确认分组方案 / message 需用户拍板 / 改动归类有歧义）→ 用 AskUserQuestion 工具给出选项：确认提交 / 修改消息 / 取消。
4. 提交：将 message 写入**系统临时目录**的临时文件（UTF-8，路径如 `$env:TEMP\dao-commit-msg.txt`，必须在仓库目录之外）→ `git commit -F <临时文件>` → 提交成功后**立即删除临时文件**
   用户修改 → 采纳修改后的消息 → 提交（同上，临时文件写系统临时目录，用后删除）
   用户取消 → 停止，暂存区保持不变（无需创建临时文件）

**单组时**跳过 reset/add，直接生成 message 后展示预览。

**注**：不自动执行 `git push`。push 是发布决策，由用户显式触发。

### 四、验（☵听·确认结果）

提交完成后，运行 `git log -<N> --oneline`（N = 提交数）+ `git status --short`，展示结果。

**每次提交后固定输出撤销指令**：

```
✓ 已提交 <N> 次
撤销最后一次：git reset --soft HEAD~1
撤销全部 N 次：git reset --soft HEAD~<N>
（代码变更保留，仅取消提交记录）
```

## Commit Message 规范

### 格式

```
[cc] <type>(<scope>): <简要描述> (vX.Y.Z)

- <要点1>
- <要点2>
```

> **`[cc]` 前缀铁律**：Claude Code 创建的每个 commit，subject 行必须以 `[cc] ` 开头（见 `claude/dao.md`「Commit 标识铁律」），一眼识别 AI 提交。
> **版本标记**：如果本次提交包含版本 bump（package.json / app.json 等版本文件变更），subject 尾部必须带 `(vX.Y.Z)`。版本和代码变更在同一个 commit 中，不单独提交。无版本变更时省略。

### type

| type       | 场景               |
| ---------- | ------------------ |
| `feat`     | 新功能             |
| `fix`      | 修复 bug           |
| `refactor` | 重构（不改变功能） |
| `style`    | 样式/格式调整      |
| `docs`     | 文档变更           |
| `test`     | 测试相关           |
| `chore`    | 构建/依赖/配置     |
| `perf`     | 性能优化           |

### scope

- 根据目录/模块推断
- 跨多个不相关模块时省略

### subject

- 必须以 `[cc] ` 前缀开头
- 中文描述，祈使语气，不加句号，不超过 72 字符
- 含版本 bump 时尾部加 `(vX.Y.Z)`，如 `[cc] fix(webview): 修复消耗展示 (v1.9.5)`

### body（可选）

- 仅当 subject 不足以说明时才添加
- 用 `-` 列出要点，每行不超过 72 字符
- 说明**为什么**改

## 平台适配

> 上善若水。不同环境有不同约束，适配而非对抗。

以下为常见平台约束，项目可在本地 `commit.md` 中覆盖：

- **Windows PowerShell**：用 `git.exe` 替代 `git`（避免路径空格问题）；commit message 通过文件写入工具确保 UTF-8（避免 PowerShell 编码截断中文）
- **Unix/macOS**：`git` 直接使用，`-m` 通常安全，但长消息仍建议用 `-F`
- **CI 环境**：可能需要配置 `user.name` / `user.email`

## 安全约束

- **禁止** `git push --force`，仅允许 `--force-with-lease`（保护他人工作）
- `--force-with-lease` 仅用于个人特性分支，**公共分支禁止 force push**
- commit message 不得包含敏感信息（密钥、token、密码）
