---
name: skills-add-large-repo-timeout
description: npx skills add 对大仓必然 clone 超时 300s，正解是自己 sparse+blobless 浅克隆再把本地路径传给它
metadata: 
  node_type: memory
  type: reference
  originSessionId: b36cf576-4711-43b6-88b8-7fd82b426dfa
  modified: 2026-08-10T15:55:49.704Z
---

`npx skills add <repo-url>` 内置 **300s clone 超时**，几百 MB 的仓库必然跑不完（报 `Failed to clone repository` / `Clone timed out after 300s`，与权限无关）。

**正解**——自己浅克隆再传本地路径（CLI 自己提示的路径，比抬 `SKILLS_CLONE_TIMEOUT_MS` 快得多）：

```bash
git clone --depth 1 --filter=blob:none --sparse <repo-url> <tmp>
git -C <tmp> sparse-checkout set skills
npx skills add <tmp> --skill <name1> --skill <name2> --global --agent claude-code -y
```

466 MB 的仓库这样只拉 `skills/` 一小块，秒完。多个 skill 用多个 `--skill` 一次装完。

**`--agent` 必须传**：不传时 `skills add` 走自己的 agent 检测，**零检测分支会装进它认识的全部 ~75 个 agent**，在机器上撒一堆用不到的 agent 配置目录（出处：orca 仓 `src/shared/agent-feature-install-commands.ts` 的注释）。Claude Code 的 key 是 `claude-code`。

**装完要验二进制那一关**：配套 CLI 的 skill 常常只是「发现存根」，真手册由二进制按自身版本吐出（如 `orca skills get orchestration`）。落盘成功 ≠ 能用。

**写文件安全**：`~/.claude/skills/` 本身是真实目录、只有 dao-* 子项是 Junction，外部工具往里写不会落进 git 仓库。

相关：[[github-not-found-vs-auth]]、[[codex-claude-shared-skills]]
