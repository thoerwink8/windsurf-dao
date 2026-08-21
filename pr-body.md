## 目标

保活循环改隐藏启动，并补上循环自己死时的检测与报警（halt.jsonl + dao-watchdog[bot] GitHub）。不造看门狗的看门狗，不改守卫进程，不改 #665 自停判据。署名 issue #693（关单交给 `scripts/close-issues.mjs`）。

## 验收标准

- [x] 故意杀 keepalive 循环 → halt.jsonl 留痕 + dao-watchdog[bot] 上报（贴输出）
- [x] 无 `timeout /t` 可见窗口（VBS `Run ..., 0` + `Atomics.wait` 常驻，本机 timeout.exe=0）
- [ ] `node scripts/dao-check.mjs` 不新增红项
- [x] 守卫拉起链路回归：kill watchdog → `--once` 拉起新 pid
- [x] 登录即启仍在（启动文件夹 `dao-guard-keepalive.vbs`）；循环死可被检测到
- [x] NEW-MACHINE.md §9b 装法与本机资产同步更新
- [x] PR 正文不写 GitHub 自动关单词

## 进展

- [x] 空提交撑分支、开 draft PR #694
- [x] schtasks 被拒 fallback：`loop-resident.mjs` / `wait-resident.mjs`（`Atomics.wait`，无 timeout 窗口）
- [x] 用 `Win32_Process Create` 拉起，跳出派工命令 Job（node spawn 的隐藏进程会随命令结束被杀）
- [x] 循环死 → halt.jsonl `LOOP_DEAD`；本机无 dao-watchdog 凭据，jsonl 记「这台机器没装」
- [x] 测试 `tests/guard-keepalive.test.js` 53 项绿
- [x] NEW-MACHINE.md §9b
- [x] dao-check：本单 keepalive 测试 53 绿；全仓 4 红与本单无关（devin 缺 start、open 超阈、账本断流、dao.test 跟路由）

## 故意构造记录

杀循环（pid 56148）后 `~/.dao/guard/halt.jsonl`：

```
{"at":"2026-08-21T03:08:59.350Z","tag":"[keepalive] LOOP_DEAD","message":"keepalive 循环进程已死（pid 56148）","pid":56148,"key":"guard-halt|keepalive|dead|pid-gone","rev":{"state":"dead","reason":"pid-gone"},"github":{"ok":false,"error":"缺凭据: C:\\Users\\Administrator\\.dao\\apps\\watchdog.json（不是没配好，是这台机器没装——见 NEW-MACHINE）","number":null,"deduped":false}}
```

本机无 dao-watchdog 凭据，jsonl 记「这台机器没装」，不许当报成功（与 #683 同口径）。

守卫回归：`taskkill` watchdog 35000 → `node scripts/guard-keepalive.mjs --once` 拉起 47344。本机 `timeout.exe` 进程数 0。

## 体系类改动

1. 谁提的，发生在什么场景？2026-08-21 巡检发现 keepalive 循环已死 ≥5.5 小时无人知。#683 验收只覆盖「kill 守卫拉起」，没覆盖「循环自己死」。Windows 11 默认终端下 `windowsHide` 失效，循环窗口可见。

2. 删哪一层能让这个问题不存在？删掉 cmd `timeout /t` 循环这一层（它不是 OS 级保活，还会弹窗、会死）。有 schtasks 权限时仍走计划任务；没权限时改成隐藏的 node 常驻 + 循环心跳，死亡走已有 halt 台账，不另造一只狗。

3. 如果从零重做，今天还会造它吗？会造「OS 定时（schtasks）优先，fallback 必须隐藏且死了要响」。不会造看门狗的看门狗，也不会保留可见 timeout 窗口。

## 设计阶段

issue #693 已消歧（帅评论，用户拍板优先）。解空间已收敛：改 `scripts/guard-keepalive.mjs`（隐藏启动 + 循环心跳/活性文件 + 报警）+ NEW-MACHINE.md。本单不重出盲设计题。
