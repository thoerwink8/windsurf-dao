# 目标

署名 issue #881，关单交给 `scripts/close-issues.mjs`。

把 Contabo 上 mirasim-server 烧掉的云端额度推进 MiraQuota 多机页：每 10 分钟采一次 getRelay 的 usage windows，按 MiraQuota 已有的 `machine/<名>` 分片约定推 `machine/contabo`。多机页要能看到第三台机器 `contabo`，额度数与服务器 getRelay 读回一致。

# 验收标准

- [x] 归属写清：采样器落哪个仓、依据是 `grep` 的结果，不是印象。
- [x] 分片格式不是手写常量：从 miraquota-win 同步代码 + 远端已有 `machine/<名>` 分支实物对出来。
- [x] Contabo 上有 systemd timer 模板，每 10 分钟推一次 `machine/contabo`（单元写 `User=orca`，有 `OnCalendar=`）。装机脚本 `scripts/install-miraquota-contabo.sh`（要 root；工人 sudo 只有 feishu-triage 一条，合入后由人装）。
- [x] 账本仓已出现 `machine/contabo`，额度数与本机 getRelay 读回一致。

# 归属（动手第一件事）

`grep -rn "machine/"`：

| 仓 | 命中 | 结论 |
|---|---|---|
| `miraquota-win` | `provider/lib/ledger-sync.mjs` 写 `HEAD:machine/${machineId}`；`docs/MULTI-MACHINE.md` 是契约 | **分片格式与 git 通道的家在这边** |
| `windsurf-dao` | 零实现（只有 INDEX / 运维便签提到仓外路径） | **本仓不发明格式** |
| 本机 `~/.miraquota/sync.json` | 不存在（帅位已查证；在用户 Windows 上） | 不能从本机配置读 remote |
| 远端 `thoerwink8/miraquota-ledger` | 已有 `machine/c02957cxy`、`machine/desktop-get3dbc`、`machine/vmi3551059` | 格式从实物反推 |

所以本仓只做 Contabo 这一台的薄封装：问本机 mirasim-server 的 getRelay，收成那边已经在跑的 schemaVersion 1 分片，force-push `machine/contabo`。systemd 单元是这台机器的事，落本仓 `host/machine/systemd/`。

# 格式从哪来（两条都走了）

1. **代码**：miraquota-win `CostLedger.exportShard`（schemaVersion / machineId / installId / generatedAt / coverage / buckets / scoped / family / unpriced）+ `Engine#shardLimits`（limits.capturedAt + windows[{label,used,budget,resetAt,modelScoped?}]）。
2. **实物**：`machine/vmi3551059` 的 `shard.json` 就是上面那份；`machine/c02957cxy` 没有 limits 块（老客户端）。新分片带 limits 合法（v0.9.28，schemaVersion 仍是 1，老客户端忽略）。

getRelay 真机帧（2026-09-06 Contabo，`{type:'relay', relay:{usage:{ok,windows}}}`）：windows 带 `label/used/budget/resetAt`（ISO 字符串）以及 `7d_fable.modelScoped`。不是 fake-mirasim.py 那套 mac 百分比协议。

`DEFAULT_REMOTE` 逐字抄 miraquota-win `ledger-sync.mjs`：`https://github.com/thoerwink8/miraquota-ledger.git`。没有 sync.json 就用它，不许另造地址。

# 进展

- 采样器：`scripts/lib/miraquota-contabo.mjs`（纯判官）+ `scripts/miraquota-contabo-sync.mjs`（连线 / git）。
- 单元：`host/machine/systemd/miraquota-contabo.{service,timer}`，`User=orca`，`OnCalendar=*:4/10`（错开 :01/:02/:07/:23）。
- 装机：`scripts/install-miraquota-contabo.sh`（验 NEXT + 以 orca dry-run）。
- 测试：`tests/miraquota-contabo.test.js` 12 过（真机 used/budget 原样进 limits；无 sync.json 退 DEFAULT_REMOTE；force-push 目标是 `HEAD:machine/contabo`）。
- 真机：`--dry-run` 与 `--once` 都跑过。远端 `machine/contabo` 已在：

  ```
  5h  6096.252725 / 171852
  7d  523002.669314 / 613756
  7d_fable  322156.15205 / 325291
  ```

  与同轮 getRelay 读回一致。machineId 钉死 `contabo`（不是 hostname `vmi3551059`，那台已经在账本仓占一行）。installId 走 `~/.miraquota/contabo-install.json`，不跟 hostname 那行共用（合并按 installId 去重）。
- 账本四件套保持空对象：getRelay 是账号级窗口点数，填进 buckets 会把整池算到 contabo 头上，「谁花的」会撒谎。多机页「额度数」走 limits.windows，验收对的是这一列。

# 机制判定

这不是某一行代码偶发算错，是 Contabo 上 mirasim-server 一直在烧额度、多机页却没有第三台。

制度生效前还会再犯吗？

- **会（miraquota-win 那条旧路）**：机器上活着的 `miraquota-sync.service` 没写 `User=`、以 root 跑、orca 的 `~/.miraquota/sync.json` 又不存在，所以它空转不发分片。生成它的是 miraquota-win `deploy-linux.mjs`，本仓不写那份装法。已有观察 `docs/observations/2026-09-06-miraquota-sync-root-checkout.md`。本单不修那个单元（会跟 hostname 那行抢 `machine/vmi3551059`）。
- **不会（本单这条路）**：新单元强制 `User=orca` + `OnCalendar=`，`tests/unit-privilege.test.js` / `tests/timer-armed.test.js` 扫得到；分片 machineId 钉死 `contabo`，测试盯 used/budget 原样和 DEFAULT_REMOTE 不许手写。缺 sudo 装不上 timer 是操作步骤，合入后 `sudo bash scripts/install-miraquota-contabo.sh`。

# 回流

产物是 `parseRelayUsage` / `shardFromRelay`：把 mirasim-server 回环 ws 的 getRelay usage windows 收成 MiraQuota schemaVersion 1 分片。

为什么通用：① 再加一台无界面 Linux（第二台 VPS）只换 machineId；② 本仓其它脚本若要「现在额度点是多少」可以对同一份 windows，不必再探协议。

建议落点：留本仓 `scripts/lib/miraquota-contabo.mjs`。miraquota-win 已有完整 provider，不往那边倒灌一条只服务 Contabo 的采样器。
