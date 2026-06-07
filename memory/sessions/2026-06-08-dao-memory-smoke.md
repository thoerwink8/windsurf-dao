# 任务复盘：dao-memory 端到端验证

## 证据范围

- 已读取：`claude/skills/dao-memory/SKILL.md`、`dao.ps1 status`、`~/.claude/skills`、`~/.codex/skills`、`cc-switch.db` 的 `skills` 表、当前仓库 `git status`。
- 已执行：`dao.ps1 link-claude`、`dao.ps1 link-codex`、读取 `~/.codex/skills/dao-memory/SKILL.md`。
- 未读取：重启后的下一轮 Codex skill 注入列表；当前会话的可用 skill 列表是在会话开始时注入的，新增 symlink 后需要重启会话才能自然出现。
- 只能推断：下次新会话会从 `~/.codex/skills/dao-memory` 发现该 skill；当前证据证明文件级部署已完成，但不等于已在当前会话动态注入。
- 明确废弃：Pencil 方案不是当前记忆机制默认路径，只作为历史背景。

## 本次目标

用户指出 `dao-memory` 可能还没有从头到尾跑过，要求确认它是否能正常运行。

## 实际过程

1. 读取 `dao-memory` skill 本体，确认 frontmatter、触发场景、复盘流程、完成门存在。
2. 查询 `cc-switch.db` 的 `skills` 表，发现 `dao-memory` 不在 cc-switch 本地 skill 表里。
3. 检查 `~/.claude/skills` 和 `~/.codex/skills`，发现 `dao-memory` 初始没有被用户级部署。
4. 执行 `dao.ps1 link-claude`，输出显示 `[link] dao-memory`。
5. 执行 `dao.ps1 link-codex`，输出显示 `[link] dao-memory`。
6. 读取 `~/.codex/skills/dao-memory/SKILL.md`，确认 Codex 侧软链接可读且内容正确。
7. 按 `dao-memory` 流程写入本复盘，并更新热记忆与流程规则。

## 遇到的问题

- 之前只验证了源码和索引，没有验证用户级部署入口。
- `dao.ps1 status` 显示源码有 38 个 skills，但 Claude Code deploy 只有 35/36 个 dao skills，暴露出新增 skill 没实际 link。
- Codex 的 `link-codex` 以 `~/.claude/skills` 为源；如果没先跑 `link-claude`，Codex 也拿不到新增 dao skill。

## 解决方式

- 先跑 `dao.ps1 link-claude`，把 `dao-memory` 链到 `~/.claude/skills`。
- 再跑 `dao.ps1 link-codex`，把 Claude 用户级 skill 镜像到 `~/.codex/skills`。
- 用 `Get-Item` 和 `Get-Content` 验证 `~/.codex/skills/dao-memory` 是软链接，且 `SKILL.md` 可读。

## 长期记忆候选

### 协作流程

- 新增 dao skill 后，必须验证源码、Claude 用户级部署、Codex 用户级部署三层，而不是只看仓库文件。
- Codex 侧 dao skill 可见性依赖 `link-codex`，而 `link-codex` 又依赖 `~/.claude/skills`；新增 skill 时应先 `link-claude` 再 `link-codex`。

### skill 缺口

- 暂无新 skill 缺口；这是 `dao-memory` 自身流程验证缺口，已通过本次复盘补入流程规则。

### 不进入长期记忆

- `dao.ps1 status` 的具体计数 35/36/38 是当前机器状态，不写成长期规则。

## 未解决事项

- 当前 Codex 会话不会动态刷新可用 skill 列表；需要新开或重启 Codex 会话后，才能验证 `dao-memory` 在系统注入的 `Available skills` 列表中自然出现。
