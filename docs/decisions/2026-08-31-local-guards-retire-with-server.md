# 2026-08-31 本机守卫/派工常驻面归零：方法论落服务器端，本机这套是脚手架不是资产

> 恢复 = `git revert` 本 commit（单 commit 收齐全部改动）。不造开关——一年切一次的状态不配常驻机制。

## 谁提的，什么场景

用户 2026-08-31：清完 26 条残留分支（全是 Orca 出问题时期半途而废的派工产物）后连提三步——
①大多数项目不需要派单流程；②windsurf-dao 大改期间也不走派单；③等 Linux 服务器无头编排落地才恢复。
随后点破方法论层面的错：**看门狗和自愈方案全是针对本机这台 Windows 的，而这套方法论未来全要落在服务器端。**

## 判决

本机守卫栈（watchdog 五层判活、flow 常驻、保活 hook、信箱台、盘面注入）是
「Windows 冒充无人值守运行时」的代偿——服务器上这些由 systemd + `orca automations` 原生提供
（8-24 决策文档原话：「systemd + orca automations 顶自研保活/flow」）。所以它们：

- **不是要搬去服务器的资产，是服务器落地即退役的脚手架**；
- 停派工期间守的是空气，还在制造要人解读的噪音（两次把用户带偏：
  「orca worktree ps 失败」被读成 worktree 大量残留；「主树非 master」引发对推送流程的怀疑）；
- **即日起冻结：不修、不加功能、不移植。** 服务器时代用原生件重建。
  连带取消同日「board-hook 只把信号分出来」的拍板——不注入盘面行，就没有信号可分。

## 本 commit 动了什么

| 动作 | 内容 |
|---|---|
| 删 | `.claude/settings.json` 的 SessionStart（拉守卫）与 UserPromptSubmit（盘面行+信箱台自愈）两个挂点 |
| 移 | `docs/global-CLAUDE.md`「## 派工时」13 条 → dispatch skill 尾部收编（常驻注入面 -16 行 ≈ -23%） |
| 留 | PreToolUse 派工闸（停派工期防手滑，零成本）；dispatch/dao-project/worker-brief skills；dao-check 的 SKIP 语义 |
| 死缓 | scripts/watchdog.mjs、flow.mjs、inbox-station.mjs、guard-*、board-hook.mjs 代码与测试原样留仓，不跑 |

本机 `~/.claude/CLAUDE.md` 已手动同步（顺带修掉 4 处历史漂移——全局约定没有自动下发机制，
真相源在本仓 `docs/global-CLAUDE.md`，换机/改后手动放置，见 NEW-MACHINE §3）。

## 体系类三问

1. **谁提的**：用户，场景见上。
2. **删哪一层**：删「派工体系常驻在每台机器每轮对话」这一层。代码不删（revert 成本最低），
   常驻面删干净。
3. **从零重做还造吗**：dispatch skill 会造；每轮 16 行注入 + 每会话三个守护进程不会——
   那是给天天派工的世界配的。

## 与在途方向文档的关系

`2026-08-31-orchestration-linux-only-no-local-worktree.md`（另一会话，尚未提交）写
「现在不删保活/flow/本机 hook——没有第二台 runtime，拆了就没闭环」。其前提是本机还在跑闭环；
用户今日拍板本机停派工，前提消失，本文覆盖那一句。该文档其余方向（编排只在专用 Linux 服务器、
本机只留人机）与本文一致。**服务器落地时的顺序仍按它：先起 runtime，再切流量，最后删本机编排层代码。**

## 恢复路径（写给搬家那天的人）

- 临时想在本机派一单：读 dispatch skill（约定都在），手动 `node scripts/dao.mjs ...`——闸还在，照拦旁路。
- 全面恢复本机编排：`git revert` 本 commit。
- 服务器落地：不要 revert——直接按 NEW-MACHINE §9d 起服务器 runtime，守卫用 systemd/automations 原生件，
  然后按 orchestration-linux-only 文档第 3 步删本机编排层代码（含本文死缓名单）。
