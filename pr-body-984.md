# 检查耗时治理：dao.test 缩时、⑪ 预算重划、orca 面挂退役牌

署名 issue #984，关单交给 `scripts/close-issues.mjs`。

## 目标

把「卡 10 分钟」从根上拆开：超时模拟收到毫秒级；⑪ 嵌套 dao-check 预算收到 60s 并带上自身耗时；orca 面 9 项（①④⑤⑥⑦⑧⑨⑩⑬）只挂退役牌、现在不删。

## 验收标准

1. 原 `tests/dao.test.js` 全绿且 wall ≤10s；dao-check 全量 ≤20s。master 已把该文件拆成 6 套（`96a3d6e1`），本 PR 跟拆分后的套件：相关套全绿。缩时只注入超时常量，不把「等超时才判红」改成立即判红，不断言、不删测试。
2. 每处改动有变异自证：把注入的短超时改回长值，测试应变慢。
3. ⑪ 仍嵌套跑 dao-check，预算 60s；detail 带 dao-check 自己的耗时。
4. orca 面 9 项注释登记退役条件（mirasim 派工实跑 + orca 退役），本单不删检查。

## 进展

- **超时可注入**：`verifyStartedPolling` / `waitAndVerify` / `waitForOutJson` 都收 `timeoutMs` + `now` + `sleep`。测试给假钟，等超时才红，不是首拍即杀。变异：同一套粘贴 50ms vs 5000ms，长超时轮数必须多一个数量级。
- **70s 真源头**：不是粘贴超时，是 `dispatch --dry-run` 每次真打 LLM 探针。dry-run 声明 `preflight.skipped=true`，不探网；真派仍探。
- **⑪ 预算 180s→60s**，detail 带 `dao-check 自己 Nms`。常量 `DAO_CHECK_NESTED_TIMEOUT_MS`，改回 180s/600s 测试红。
- **orca 面 9 项挂退役牌**（①④⑤⑥⑦⑧⑨⑩⑬）：现在不删。
- 相关测试：`dao-startup-proof` / `dao-dispatch-gate` / `dao-launch` / `server-check` / `reviewer-vendor-gate`。

### 返工（审官红 3 条，原 head 7d4fe708）

1. **基底**：`git rebase origin/master`。master 已拆 `dao.test.js` 成 6 套 + harness（`96a3d6e1`）；正确动作是变基并迁改动，不是恢复被删文件。`waitForOutJson` 生产默认在 harness 里保持 60s。
2. **墙钟不许改口径**：catalog 自检有 orca 仍走 live `--help`（`prefetchLiveHelp` 并行预热 + 缓存）。dao-check 默认档跳过飞书 live 和 `gh label list`（样本闸仍跑，`--full` 才探网）；测试池开 `NODE_COMPILE_CACHE`。
3. **禁 mock**：有 orca → live；无 orca / ETIMEDOUT → 夹具。不许永远塞 ENOENT。

### 墙钟

拆分后原 70s 单套已不存在。本 PR 在拆开的套上补超时注入 / live `--help` / dry-run 不打网。空载下 `dao-startup-proof` + `dao-dispatch-gate` + `dao-launch` 应亚 10s；dao-check 全量贴命令末行。

### 机制判定

这错在制度生效前还会再犯吗？**会**——检查器嵌套跑完整自检、dry-run 顺手打网、超时常量写死墙钟、默认档打飞书/gh，任何一项都会再把调用方拖过 SIGKILL。机制改在本 PR：超时可注入、dry-run 不探网、⑪ 预算收到 60s 且 detail 带自身耗时、orca 面先挂牌不盲删、默认档出网检查只在 `--full`。不会再靠「卡 10 分钟没输出」当唯一信号。
