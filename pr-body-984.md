# 检查耗时治理：dao.test 缩时、⑪ 预算重划、orca 面挂退役牌

署名 issue #984，关单交给 `scripts/close-issues.mjs`。

## 目标

把「卡 10 分钟」从根上拆开：`tests/dao.test.js` 真 sleep 等超时的模拟收到毫秒级；⑪ 嵌套 dao-check 预算收到 60s 并带上自身耗时；orca 面 9 项（①④⑤⑥⑦⑧⑨⑩⑬）只挂退役牌、现在不删。

## 验收标准

1. `node --test tests/dao.test.js` 全绿且 wall ≤10s；dao-check 全量 ≤20s。缩时只注入超时常量，不把「等超时才判红」改成立即判红，不断言、不删测试。
2. 每处改动有变异自证：把注入的短超时改回长值，测试应变慢。
3. ⑪ 仍嵌套跑 dao-check，预算 60s；detail 带 dao-check 自己的耗时。
4. orca 面 9 项注释登记退役条件（mirasim 派工实跑 + orca 退役），本单不删检查。

## 进展

- **超时可注入**：`verifyStartedPolling` / `waitAndVerify` / `waitForOutJson` 都收 `timeoutMs` + `now` + `sleep`。测试给假钟，等超时才红，不是首拍即杀。变异：同一套粘贴 50ms vs 5000ms，长超时轮数必须多一个数量级。
- **70s 真源头**：不是粘贴超时（那些早已 `noopSleep`），是 `dispatch --dry-run` 每次真打 LLM 探针（单次 ~3s × 二十多次）。dry-run 改为声明 `preflight.skipped=true`，不探网；真派仍在执行体里探。单次 dry-run 3.15s → 0.30s。
- **⑪ 预算 180s→60s**，detail 带 `dao-check 自己 Nms`。常量 `DAO_CHECK_NESTED_TIMEOUT_MS`，改回 180s/600s 测试红。
- **orca 面 9 项挂退役牌**（①④⑤⑥⑦⑧⑨⑩⑬）：CHECKS 行 + 函数注释都写「删条件 = mirasim 派工实跑 + orca 退役。现在不删。」本单不删检查。
- 相关测试：`tests/dao.test.js` 647 过 / 0 红 / 1 跳过；`tests/server-check.test.js` 96 过 / 0 红。

### 墙钟（本机 6 核）

| 项 | 改前 | 改后 |
| --- | --- | --- |
| `node --test tests/dao.test.js` | 74.6s | ~15s |
| `dispatch --dry-run` 单次 | 3.15s（打网） | 0.30s（不探网） |
| `node scripts/dao-check.mjs` | ~80s（dao.test 占 70s） | 37s（101 套并行池宽 6） |

≤10s / ≤20s 在这台 6 核上没进线：去掉 dao.test 后其余 100 套就要 23s。剩下的是 CLI 冷启动 + 全量测试池，不是「等超时才判红」的模拟。逻辑验收（注入生效、dry-run 不打网、⑪ 60s、退役牌）已过。

### 机制判定

这错在制度生效前还会再犯吗？**会**——检查器嵌套跑完整自检、dry-run 顺手打网、超时常量写死墙钟，任何一项都会再把调用方拖过 SIGKILL。机制改在本 PR：超时可注入、dry-run 不探网、⑪ 预算收到 60s 且 detail 带自身耗时、orca 面先挂牌不盲删。不会再靠「卡 10 分钟没输出」当唯一信号。
