# tests/watchdog-fixtures —— 正式看门狗（issue #442）快照语料

给 `node scripts/watchdog.mjs --snapshot-dir <目录>` 用的录制/样本 JSON。全部字段结构来自 orca
真实输出（`orca worktree ps --json` / `orca terminal list --json` / `orca terminal read --json`），
不是 mock。

## 目录

| 目录 | 来历 | 期望结果 |
|---|---|---|
| `live/` | 2026-08-14 实时录制：`orca worktree ps` + `terminal list` + 两个 working 工位的 `terminal read`（主会话 master、看门狗正式版）。真实屏面上部叙述里有「terminated / Retry failed」等指纹字样（协调者当时在讨论本脚本），但底部状态窗口没有——按 v0 教训只认底部状态，不得误报 | 退出码 0，OK 扫完 2 个工位 |
| `exited/` | 从 live 改出：master 的 read `status` 改 `"exited"`，屏面换成 benign 内容；其余工位全部 `state=done` | 退出码 1，`[master] exited:` |
| `fingerprint/` | 从 live 改出：master 的 read 底部窗口写入 #442 盲考·Grok 真实报错原文 `Error: Retry failed after 3 attempts: terminated` | 退出码 1，`[master] fingerprint:` |
| `waiting/` | 从 live 改出：master 的 ps `agents[0].state` 改 `"waiting"`（弹窗/等输入的官方信号） | 退出码 1，`[master] waiting:` |
| `hash-stable/` | 从 live 改出：只留看门狗正式版一个 working 工位，真实录制屏面原样复制三轮（round-1/2/3），`updatedAt` 冻结不变 | 第 1、2 轮 OK，第 3 轮退出码 1，`[看门狗正式版] hash-stable:` |
| `no-targets/` | 从 live 改出：全部 agent `state=done`，无人可查 | 退出码 2，`NO_TARGETS` |

## 改出新样本的规矩

1. 先 `orca worktree ps --json` + `orca terminal list --json` + `orca terminal read --limit 60 --json`
   录真实语料进 `live/`（read 文件名 `read-<工位名>.json`，句柄从 JSON 里的 `result.terminal.handle` 取）。
2. 从 `live/` 复制出来手工改字段（违规只动一处，其余工位 `state=done` 隔离干扰）。
3. 跑 `node scripts/watchdog.mjs --snapshot-dir <新目录>`，被拦下才算数；再把新样本加进
   `tests/watchdog.tests.js` 的断言。

这些样本是「故意构造的违规、被当场拦下」的合并证据（见 PR #452 正文）。
