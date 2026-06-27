---
name: dao-worktree
description: 隔离工作区铁律：开始一项独立工作前,用 git worktree 创建干净分支沙箱,跑测试基线确认 clean。完工后必 cleanup 归根。借助"致虚极守静笃"的道家观,把每次工作变成可隔离、可丢弃、不污染主线的独立沙盒。
disable-model-invocation: true
---

# 隔离工作区 · Worktree Lens

> 致虚极，守静笃。万物并作，吾以观复。
> 夫物芸芸，各复归其根。
> ——《道德经》第 16 章

道家"虚静观复"四字诀:
- **虚**:从空处起——不带主分支的脏状态
- **静**:守一不二——一个 worktree 只做一件事
- **观**:在隔离中看清因果——避免主线噪音干扰
- **复**:做完归根——清理 worktree,返回主分支

## 铁律

```
不在脏分支上开新工作。
不让一个 worktree 同时背两个目的。
不留死 worktree。完成必归根。
```

## 何时激活

**必激活**:
- 开始一项**多步骤独立功能**的开发
- 进行可能**大量改动**的重构(改动易污染主线)
- 复现 bug **需要切到旧 commit** 同时主线还在开发
- **同时跑 PR review**(看别人代码)和自己的开发
- **消耗性实验**——预期可能整个分支丢弃

**不必激活**:
- 一行级别的小改动
- 只读探索(直接搜索/读取即可,不需要新工作区)
- 已经在干净独立分支且任务单一

## 核心命令(Windows / 跨平台一致)

### 1. 创建新 worktree(从主分支拉出)

```bash
# 在主项目根目录
git worktree add ../<feature-name> -b <branch-name>
# 例:
git worktree add ../my-feature -b feature/auth-refactor
```

**结果**:
- `../<feature-name>/` 新目录,独立工作区
- 自动 checkout 到新分支
- 主项目目录不变,主分支不动

### 2. 进入并跑测试基线

```bash
cd ../<feature-name>
# ⚠ 干净进场 · 清理继承的 node_modules（教训 e163）
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue    # PowerShell
# 或：rm -rf node_modules                                                # bash
<跑项目的安装命令,如 npm install / pnpm install>
<跑测试基线,如 npm test / pnpm test>
```

> **⚠ worktree 首次 install 前必清 node_modules**（e163 教训）：继承的旧 node_modules 会导致 lockfile 残缺——本地绿但 CI `npm ci` 挂。对治：先删 node_modules 或 `npm install --force`。校验：`npm ci --dry-run` 本地跑通。

**确认 clean**:测试基线必须**全绿**才能开工——否则你不知道后续 bug 是新引入的还是旧问题。

### 3. 工作期间

- 在 `../<feature-name>/` 里随便折腾
- 主项目目录的 git 状态完全不受影响
- 多个 worktree 可同时存在,互不干扰

### 4. 完工归根(必做)

任务结束后**必须**走完整 cleanup:

```bash
# 选项 A:成果合入主分支
cd <主项目目录>
git merge feature/auth-refactor    # 或走 PR 流程
git worktree remove ../<feature-name>
git branch -d feature/auth-refactor  # 如已合并

# 选项 B:成果丢弃
git worktree remove ../<feature-name> --force
git branch -D feature/auth-refactor
```

### 5. 状态查询(随时可用)

```bash
git worktree list   # 看当前所有 worktree
git branch          # 主分支视角看分支
```

## 完整工作流

虚（worktree add）→ 静（install + test 全绿）→ 观（隔离开发）→ 复（merge/丢弃 + worktree remove）。每关有"止"——基线不绿不开工、worktree 不删不算结束。

## 反模式表

| 病 | 症状 | 道德经诊断 | 对治 |
|----|------|-----------|------|
| 脏分支开工 | 直接在主分支改东改西 | 不致虚 | 必从 worktree 起 |
| 一棵两用 | 一个 worktree 同时改两个 feature | 不守静 | 一 worktree 一目的 |
| 不验基线 | 跳过 test baseline 直接写代码 | 不知静 | 先跑测试,全绿才动 |
| 死 worktree | 完工后留着 worktree 不删 | 不归根 | 任务完必 remove |
| 强删未合并 | `worktree remove --force` 没 merge 的成果 | 慎终如始 | 先 merge 再 remove |
| 嵌套 worktree | 在 worktree 里再 add 新 worktree | 失虚静 | 回主目录再开新的 |
| 同名分支冲突 | branch 已存在用同名 add | 不知名 | 先 `git branch -a` 确认 |
| node_modules 继承污染 | lockfile 残缺，本地绿 CI 挂 | 不致虚 | install 前必清（e163） |

## 涅槃门(完工前)

- [ ] 改动已 merge / 已通过 PR / 或确认丢弃
- [ ] `git worktree list` 不再显示这个 worktree
- [ ] 临时分支已删除(`git branch -d` / `-D`)
- [ ] 主分支测试仍全绿(merge 后跑一遍)
- [ ] 没有遗留的 untracked 文件在主目录

任一未通 = 任务未结束。

## 与其他 dao-* 的协作

- **dao-verify**：`worktree remove` 不是终点,必须 `worktree list` 确认归根
- **dao-review**：worktree 内完成后派 reviewer 评审再归根

## 反原则(保留 dao 风格)

- **不为隔离而隔离**——单文件改动不必上 worktree
- **不为多 worktree 而多 worktree**——一个就够时,别开第二个
- **过度复杂化 = 企者不立**——worktree 是工具,不是目的

## Windows 注意

- Windows 上 `git worktree add ../foo` 路径用相对路径或正斜杠均可
- 删除 worktree 时如遇 "in use" 错误,先关掉 IDE 中打开的 worktree 目录再 remove
- Junction/Symlink 通过 `git worktree add` 自动处理,不用手动 mklink