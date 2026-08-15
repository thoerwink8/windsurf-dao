---
name: github-not-found-vs-auth
description: GitHub 对不存在和没权限的仓库统一回 Repository not found，各种 CLI 会据此误报成认证失败——先验仓库存不存在再查权限
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b36cf576-4711-43b6-88b8-7fd82b426dfa
  modified: 2026-08-10T15:54:48.263Z
---

克隆/安装类 CLI 报 "Authentication failed" 时，**先验仓库存不存在，再查权限**。GitHub 对「仓库不存在」和「有仓库但你没权限」**统一回 `Repository not found`**（防止用私有仓名探测），CLI 拿到这个响应普遍猜成认证问题，给出的排查建议（配 SSH key、检查 token scope）会把人带偏。

**验的顺序**（前两条只读、秒回）：
1. `gh api repos/<owner>/<repo>` —— 404 就是不存在或无权限
2. `gh api orgs/<owner>` —— org 在但 repo 不在 ⇒ 多半是**仓库名写错了**
3. `gh search repos <关键词> --owner <org>` —— 找真名
4. 到这一步才轮到 `gh auth status` / `ssh -T git@github.com`

**2026-08-10 实例**：`npx skills add https://github.com/stablyai/orca--skill orchestration` 报认证失败，真因是命令里 `orca` 和 `--skill` 之间**丢了个空格**，粘成不存在的仓库名。认证从头到尾是好的。粘贴带 flag 的长命令时，这种丢空格的形态会伪装成权限问题。

相关：[[skills-add-large-repo-timeout]]
