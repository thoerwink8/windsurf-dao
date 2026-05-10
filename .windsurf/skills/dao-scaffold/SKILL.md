---
name: dao-scaffold
description: 脚手架优先铁律：新项目启动前判定复用路径（已有 starter → 组合 CLI → 手搓）。CLI 交互 prompt 必须由 Cascade 代答，用户无感。2 次以上才反提通用 starter。"合抱之木，生于毫末"——从用过的蒸馏，不从想象中预设。
---

# 架 · Scaffold Lens

> 合抱之木，生于毫末；九成之台，作于累土；千里之行，始于足下。
> 是以圣人欲不欲，不贵难得之货；学不学，而复众人之所过。
> ——《道德经》第 64 章

道家告诫的正是**脚手架的反面**：
- **毫末生大木** —— 脚手架应从真实项目蒸馏，不从"未来可能用到"预设。
- **众人之所过** —— 不重复别人（官方 CLI / 社区模板）已经做好的事。
- **欲不欲** —— 别贪图"做一个平台"的虚荣，先解决眼前。

## 铁律

```
1. 不手搓已有脚手架能做的事——官方 CLI / 社区模板覆盖 80% 即用。
2. 没用过 2 次，不抽象成通用 starter——从想象抽象 = 盲动。
3. CLI 交互 prompt 必由 Cascade 代答，用户无感——plan 阶段已决策完。
4. plan 首条 Task 前必跑 dao-scaffold 决策——不跑 = 跳步。
```

## 何时激活

- 创建**新仓库** / **新 monorepo** / **新 app** 之前
- dao-plan 第 0 步（写 plan 之前必问）
- 看到 plan 里 > 3 个 task 是纯 boilerplate（`.gitignore` / 包配置 / lint 配置）—— 回头 dao-scaffold
- `/cycle` 开新产品线之前

**不激活**:
- 既有项目内部加功能（不是新脚手架）
- 写单个脚本、单个 notebook（不需要骨架）
- bug 修复 / 重构（派 dao-debug / dao-refactor）

## 入参（必须）

```
□ 项目类型（web app / desktop / CLI / 小程序 / 移动 / lib / ...）
□ 技术栈（至少已在 design 或 platform-strategy 中定下）
□ 是否已有 platform-starter-kit / 对标 template 仓库？
□ 是第 N 个用此栈的项目（N ≥ 2 才允许讨论 "抽为 starter"）
```

## 决策树

```
开始新项目
│
├─ Q1: 公司 / 个人已有 platform-starter-kit（此栈专用 template）吗？
│    ├─ 有 → 【Path A: Fork Starter】
│    │       1. fork / copy starter → 改项目名/标识
│    │       2. 差异化魔改（仅项目特有部分）
│    │       3. 1-5 分钟起步
│    │       → 写 plan 跳过 boilerplate task
│    │
│    └─ 无 → Q2
│
├─ Q2: 官方 CLI + 社区模板组合能覆盖 ≥80%？
│    ├─ 能 → 【Path B: Compose CLI】（最常见情形）
│    │       1. 识别覆盖组合（见下方"主流 CLI 索引"）
│    │       2. 预填所有 CLI 交互答案（见"CLI Prompt 代答协议"）
│    │       3. 跑组合命令链 → 90% 骨架生成
│    │       4. 手工补 10%（商用接缝 / 项目特有）
│    │       → 写 plan 时 boilerplate task ≤ 2 个
│    │
│    └─ 不能 → Q3
│
├─ Q3: 需求真的如此独特？还是没找够？
│    ├─ 再搜一遍 GitHub / awesome 列表 / dev.to 文章
│    │   （常见情况：90% 需求被人做过，只是名字不一样）
│    └─ 真独特 → 【Path C: Handcraft】
│            1. 写 plan 时明示"此项目独特，手搓脚手架"
│            2. 做完一次后，进入"蒸馏节奏"（见下方）
│
└─ Q4: 项目跑通 dogfood 后：此栈已用过 N 次？
     ├─ N = 1 → 项目内 `template/` 或 `bin/new-app.*`（本项目用）
     ├─ N = 2 → 抽独立 starter 仓库 + 写 dao-scaffold 预设脚本
     ├─ N ≥ 3 → 考虑开源 / 公开 template
```

## CLI Prompt 代答协议（核心）

> **分工哲学**：design/plan 阶段是用户参与的决策。execute 阶段 CLI 弹出的交互 prompt **必须由 Cascade 代答**——所有预期 prompt 和答案写进 plan task 里。

### 三级代答策略（优先级从高到低）

**Level 1: non-interactive flags**

查 CLI 的 `--help`，把所有选项做成 flag 一次性传入：
```powershell
# 例：create-turbo
pnpm dlx create-turbo@latest TraceyU --package-manager pnpm --skip-install --example basic

# 例：create-tauri-app
pnpm create tauri-app desktop --yes --template react-ts --manager pnpm --identifier com.frank.traceyu

# 例：shadcn init
pnpm dlx shadcn@latest init --yes --defaults
```

**Level 2: 环境变量 / 配置文件预填**

```powershell
$env:CI = "true"          # 很多 CLI 在 CI=true 下走默认
$env:FORCE_COLOR = "0"    # 避免彩色转义污染
$env:NPM_CONFIG_YES = "true"  # npm/pnpm 全部 confirm 走 yes
```

或提前写 config 文件（如 `.yo-rc.json` / `shadcn-ui.json`）让 CLI 读而非问。

**Level 3: stdin 管道预填答案**

CLI 实在只能交互（罕见），用 here-string 喂序列答案：

```powershell
@"
desktop
com.frank.traceyu
TypeScript
pnpm
React
TypeScript
"@ | pnpm create tauri-app
```

⚠️ 此路风险：CLI 改版后 prompt 顺序变，答案错位 → 在 plan 里明示 "CLI 版本锁定 vX.Y"。

### 红线

```
❌ 不把 CLI 抛给用户让用户亲自回答
❌ 不在 plan task 里写"（根据 CLI 提示回答）"
❌ 不在 execute 中"临时决定"CLI 问题的答案
❌ 不使用交互式 wizard 要求用户鼠标点击
```

### 必写到 plan task 里

每个含 CLI 的 task 必须包含：

```markdown
### Task X: 用 create-tauri-app 初始化 desktop
- 命令：`pnpm create tauri-app desktop --yes --template react-ts --manager pnpm --identifier com.frank.traceyu`
- 预期 prompt 及代答：
  | Prompt | 答案 | 方式 |
  |---|---|---|
  | Project name | desktop | --flag |
  | Identifier | com.frank.traceyu | --flag |
  | Frontend language | TypeScript | --template |
  | Package manager | pnpm | --flag |
- 未预料 prompt 应对：停执行 → 返用户 blocker
- 验证：`Test-Path desktop/src-tauri/Cargo.toml` = True
```

### 例外：遇到 plan 未预料的新 prompt

- **停 execute**，不要猜
- 收集 prompt 原文 + 可选项 → 作为 blocker 返给用户
- 用户决策后 → 回 dao-plan 更新 task → 再 execute

这是 `dao-terminal-resilience` 的兄弟原则：终端阻塞 → 降级 → 求助，不盲猜。

## 脚手架蒸馏节奏

```
┌─ 第 1 次用某栈 ──────────┐
│  手搓 / 组合 CLI         │ ← 允许 boilerplate
│  记录痛点与重复          │
│  项目内 template/ 目录   │
└──────────┬───────────────┘
           │ dogfood 跑完
           ▼
┌─ 第 2 次用某栈 ──────────┐
│  发现 60%+ 来自第 1 个？ │
│  是 → 抽 starter repo    │ ← 此时才允许"通用化"
│  写 dao-scaffold 脚本    │
│  更新 platform-strategy  │
└──────────┬───────────────┘
           │ 第 2 个项目跑通
           ▼
┌─ 第 3 次及以后 ──────────┐
│  starter 稳定打磨        │
│  可考虑开源 / 公开 template│
└──────────────────────────┘
```

**数学核心**：**2 次真实用例** = 通用性的最小证据。1 次样本不够，3 次以上收益递减。

## 主流 CLI 索引（参考）

| 用途 | 推荐 CLI | Non-interactive 能力 |
|------|---------|---------------------|
| Monorepo | `pnpm dlx create-turbo@latest` | 好（flag 全） |
| Next.js | `pnpm create next-app@latest` | 好 |
| Vite + React | `pnpm create vite@latest` | 中（需 flag） |
| Tauri | `pnpm create tauri-app@latest` | 好 |
| Expo (RN) | `pnpm create expo-app` | 中 |
| NestJS | `pnpm dlx @nestjs/cli new` | 好 |
| shadcn/ui | `pnpm dlx shadcn@latest init` | 好（`--yes --defaults`） |
| Tailwind | `pnpm dlx tailwindcss init -p` | 好 |
| Taro 小程序 | `pnpm create taro` | 差（交互多，备 Level 3） |
| Astro | `pnpm create astro` | 好 |
| Go | `go mod init` | 好 |

**查新 CLI 的步骤**：
1. `<cli> --help` 看 flag 列表
2. 搜 "\<cli\> non-interactive" / "\<cli\> ci mode"
3. 看项目 GitHub issues / discussions
4. 所有 flag 写进 plan

## 反模式表

| 病 | 症状 | 道德经诊断 | 对治 |
|----|------|-----------|------|
| 手搓 boilerplate | plan 里 > 3 个 task 是创建 `.gitignore` / `package.json` 之类 | 不学"众人之所过" | 先查官方 CLI |
| 过早抽象 | 第 1 个项目就想做通用 starter | 为大于其大 | 用过 2 次再说 |
| 用户回答 CLI | plan 说"按提示选 TypeScript" | 不代劳 | 预填 flag / stdin |
| 猜未预料 prompt | 看到新 prompt 随手选 | 妄作 | 停 execute 返用户 |
| 永不蒸馏 | 每次项目都重搓一遍 | 不反哺 | 第 2 次必抽 starter |
| 假通用 | 把项目特有逻辑塞 starter | 失边界 | 只抽真正通用部分 |
| 脚手架跟不上 | starter 半年没更新依赖 | 不慎终 | 每季度健康检查 |
| 为脚手架而脚手架 | "做个平台"口号大 | 难得之货 | 解决眼前最小痛点 |

## 涅槃门（进 dao-plan 前必答）

```
□ Q1: 有现成 starter 吗？（Y → Path A，N → Q2）
□ Q2: 官方 CLI 覆盖 80%+？（Y → Path B + 预填答案，N → Q3）
□ Q3: 确认真独特？（再搜一次 GitHub）
□ Q4: 所有 CLI 交互 prompt 已预填答案？
□ Q5: plan 里 boilerplate task ≤ 2 个？
```

任一未通 = 回头优化，不进 dao-plan 写任务。

## 与其他 dao-* 协作

```
dao-brainstorm (design 已批)
   │
   ▼
dao-scaffold (你 · 判脚手架路径)
   │ 输出：组合 CLI 命令链 / starter fork 方案
   ▼
dao-plan (依据脚手架路径写 task)
   │ boilerplate task 最小化
   ▼
dao-execute (worker 代答 CLI prompt)
   │ 遇新 prompt → 返用户 blocker
   ▼
dao-verify → dao-review → dao-finish
   │
   ▼
[dogfood 跑通后]
dao-scaffold 反哺：
   N=1 → 项目内 template/
   N=2 → 抽独立 starter + 更新 platform-strategy
   N≥3 → 考虑开源
```

## 与 platform-strategy 的关系

```
platform-strategy（宪章）
  定义：每端栈选型、接缝规约、组织模式
     ↓
dao-scaffold（执行器）
  决定：每次新项目如何最小成本起步
     ↓
platform-starter-kit（物化产出，2 次用例后生成）
  实体：fork 即起步的模板仓库
```

**没有 starter 时**：dao-scaffold 靠官方 CLI 组合 + 写死在 plan。
**有 starter 后**：dao-scaffold 默认 Path A（fork），plan 大幅简化。

## 反原则（保留 dao 风格）

- **不为脚手架而脚手架** —— 目标是最小成本起步，不是"做个平台"。
- **不追最新 CLI** —— 锁定版本（plan 里写明），避免 CLI 改版破坏预填。
- **脚手架可以丑** —— 第一次手搓 / 第二次抽 starter，允许不完美，dogfood 跑通优先。
- **反哺不义务** —— 第 2 次发现重合度 < 50%，说明栈其实没那么统一，老实手搓，别硬抽。
- **CLI 代答不是 bypass 用户** —— 是把用户的决策权集中到 design/plan 阶段，避免 execute 时频繁打断。
