# 协作流程规则

## 跨宿主提交前缀

- 每次由 AI 创建 commit 前，先确认当前执行宿主。
- Codex / Code X 中创建的 commit 必须使用 `[codex]`，即使改动目标是 `claude/`、`.devin/` 或 `.windsurf/`。
- Claude Code 中创建的 commit 使用 `[cc]`。
- 提交后立即运行 `git log -1 --oneline` 核对前缀；不匹配且未 push 时立刻 amend，已 push 后不改历史，另起修正并沉淀教训。

## dao skill 部署验证

- 新增或修改 dao skill 后，不只检查 `claude/skills/<skill>/SKILL.md` 是否存在。
- 必须验证用户级部署入口：
  - Claude Code：`~/.claude/skills/<skill>` 存在且指向仓库源。
  - Codex：`~/.codex/skills/<skill>` 存在且能读到 `SKILL.md` frontmatter。
- 如果 Codex 侧依赖 Claude 用户级 skills 镜像，先跑 `dao.ps1 link-claude`，再跑 `dao.ps1 link-codex`。
- 验证完成前不要声称 skill “能正常运行”。
