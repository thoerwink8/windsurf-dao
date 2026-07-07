---
description: 一键在当前 worktree 启动 dev server。自动检测 worktree 路径、kill 旧进程、后台启动。
argument-hint: "[可选: worktree路径 或 'stop']"
---

用户输入：$ARGUMENTS

# 启 · Dev Server（在 worktree 中启动）

> 上善若水，水善利万物而不争。

## 流程

1. **检测 worktree**（优先级从高到低）：
   - 用户显式给了路径 → 用它
   - 当前项目有活跃 Loop → 读 `docs/specs/*/STATUS.json` 中的 worktree 字段
   - `git worktree list` 找非 main 的 worktree
   - 都没有 → 用当前项目目录

2. **检测 dev 命令**（按技术栈）：
   - `src-tauri/` 存在 → `pnpm tauri dev`（Tauri 桌面应用）
   - `package.json` 有 `"dev"` script → `pnpm dev`
   - 都没有 → 问用户

3. **清理旧进程**：
   - Tauri 项目：kill 匹配 `desktop|tauri` 的进程
   - Node 项目：kill 占用 dev server 端口的进程
   - 用户输入 `stop` → 只 kill 不启动

4. **启动**：
   - `run_in_background: true` 非阻塞启动
   - 报告：worktree 路径 + 分支名 + dev 命令 + 预计编译时间

5. **Tauri 特殊处理**：
   - Rust 重编译首次约 2-3 分钟，后续增量约 10-30 秒
   - 前端热重载即时生效，Rust 侧改动需等重编译

## 产出

一行状态：`🚀 dev server 已从 <worktree路径> (<分支>) 后台启动`
