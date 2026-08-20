## 目标

删 2026-08-20 的 deepseek 全工种额度禁令，把 deepseek-v4-flash/pro 加回门闩名单；新增 Devin CLI 通道，写码路由优先级 **devin > opencode-go > 官方直连**。署名 issue #688（关单交给 `scripts/close-issues.mjs`）。

## 验收标准

- [x] 门闩名单（写码）首位 = `devin-deepseek-v4-flash-max`，og flash 在列
- [x] devin 非交互冒烟输出（贴）
- [x] og 冒烟输出（贴）
- [x] `node scripts/dao-check.mjs` 本单相关绿（不新增红项）
- [x] 2026-08-20 bans 已删、git 记录可见
- [x] PR 正文不写 GitHub 自动关单词

## 进展

- [x] 删 toml `[[bans]]` 额度全工种条 + `policy/bans.yml` 镜像 `ban-deepseek-额度`
- [x] 加 `[providers.devin]`（launch = TUI `devin --model {model} --permission-mode dangerous`，`start=command`；`--print` 只作冒烟）
- [x] 加模型 `devin-deepseek-v4-flash-max`；写码路由全日 `00:00-24:00`：model=devin，fallback=og flash
- [x] 直连保持应急语义，不进自动换管（撞顶报用户，见 `[providers.opencode-go].why`）
- [x] NEW-MACHINE「devin 怎么配」+ INDEX `~/AppData/Local/devin`
- [x] 点将台/派工测试从 #669 额度闸与峰谷 grok 切到新路由

### 门闩名单（工作区路由，本单生效后的真相）

`select({ workType: 写码, routes: 工作区 toml })`：

```
A: devin-deepseek-v4-flash-max
reason: route_beijing
fallback: deepseek-v4-flash
slate[0]: devin-deepseek-v4-flash-max
slate 含: deepseek-v4-flash
```

`dianjiangtai-select.mjs` 仍读 `origin/master` 路由（#533），合进 master 之前 A 仍是 grok；B 自选位已能看到 `devin/devin-deepseek-v4-flash-max` 和 `opencode-go/deepseek-v4-flash`（政策读工作区）。合后 CLI A 才会切到 devin。

### 冒烟

devin 非交互（14.4s，exit 0）：

```
devin --print --model deepseek-v4-flash-max --respect-workspace-trust false --permission-mode dangerous -- "只回复：OK"
OK
```

og（6.8s，exit 0）：

```
pi --no-tools --no-session --model opencode-go/deepseek-v4-flash -p "只回复：OK"
OK
```

### dao-check

本单相关绿。全仓两项红未动、不是本单引入：open 未在做超阈；账本断流 #671 #672 #674 #676。

### 起法说明（不改派工代码）

Orca 不认 `--agent devin`，走 `terminal create --command`（与 reclaude 同形态）。`--print` 跑完即退，不能当工人；工人 TUI 用 launch 里的 `--permission-mode dangerous`。

## 体系类改动

1. 谁提的，发生在什么场景？2026-08-21 用户拍板：推翻 8/20「两通道没额度停派」，加回 deepseek，且 Devin CLI 跑 deepseek-v4-flash-max（$0.14/MTok）优先于 og / 直连。

2. 删哪一层能让这个问题不存在？删掉 8/20 那条全工种额度禁令。通道优先级落在路由表，不另造选型逻辑。

3. 如果从零重做，今天还会造它吗？会造「一条路由 + 三通道优先级」这一层。不会造「额度空了就把模型整条禁掉、恢复还要再开单」的门闩。
