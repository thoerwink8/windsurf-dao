# hook 注册作业 · 2026-08-02（dao 重写批 1 通电）

> **这份文档解决的问题**：批 1 写好并合并了三个新 hook，但它们**一个都没接线**——脚本躺在盘上，
> 宿主从来不会调它们。接线动作（写 live settings.json / 写 cc-switch DB）是硬闸 G2 与权限分类器
> 明令拦下的 AI 动作，只能由用户执行。所以 AI 这一侧的交付是**一整套备好料、验过、能直接粘的材料**。
>
> 材料本体在 `_tmp/hook-register-202608/`（gitignore，不进仓）。本文档留在仓里的是
> **怎么生成的 + 做完怎么验**，好让这套东西下次能重跑、也让「当时到底改了什么」有据可查。

## 一、为什么要有这次作业（情境）

三件事各自都是「已经写好但零生效」：

1. **G6 心跳签名闸**（`dao-hard-gates.js` 第 6 道）——`PreToolUse` 的 matcher 里没有 `ScheduleWakeup`，
   宿主根本不会为这个工具调用 hook ⇒ 这道闸**零覆盖**，而它的 `--selfcheck` 会当场明说并 exit 1。
2. **浏览器工具的三器选择提醒**（`dao-tool-nudge.js` 第 ④ 面）——matcher 是 `Bash`，
   而 `mcp__chrome-devtools__take_screenshot` 不匹配 `Bash` ⇒ 这类提醒**从来没投递过一次**（issue #64）。
3. **两个新 hook 压根没有挂载点**——`dao-subagent-clauses.js`（SubagentStart）与
   `dao-design-sync-gate.js`（Stop）在 `check-dead-gates` 里表现为 **orphan=2**：文件在、没人注册。

## 二、改了什么（行动）

四项，一次做完：

| # | 位置 | 变更 |
|---|---|---|
| C1 | `PreToolUse` · dao-hard-gates 那组 | matcher 末尾追加 `\|ScheduleWakeup` |
| C2 | `PostToolUse` · dao-tool-nudge 那组 | matcher `Bash` → `Bash\|mcp__chrome-devtools__.*\|mcp__playwright__.*` |
| C3 | 新增 `SubagentStart` 挂载点 | `{"matcher":"*","hooks":[{"type":"command","command":"node \"<repo>/ccswitch/hooks/dao-subagent-clauses.js\""}]}` |
| C4 | `Stop` · dao-timecode 所在那组的 `hooks` 数组 | 追加 `{"type":"command","command":"node \"<repo>/ccswitch/hooks/dao-design-sync-gate.js\"","timeout":15}`（dao-timecode 原样保留） |

### 🔴 关键结论：要写的是**三个面**，不是一个

issue #49 已经坐实「`~/.claude/settings.json` 是投影不是源」。本次作业把这条链走完整之后发现，
**只写下发源仍然不够**——还有一层是漂移检查器的对照基准：

```
cc-switch DB · providers 表（app_type=claude 的每一行）   ← 真下发源，切 provider 时整份覆盖 live
~/.claude/settings.json                                    ← 宿主真读的投影，写了即刻生效
cc-switch DB · settings.common_config_claude               ← 镜像层，不在下发路径上
     └─ config-sync export ⟶ config-sync/common/settings.json（git 快照）
                                 ↑ settings-drift 两个面的 canonical
```

**只写前两个的后果是实测出来的，不是推的**（沙箱预跑，见下节）：
`settings-drift` 硬发现 **0 → 6 条**、`settings-drift --providers` **`drift=0` → `drift=8`**，
而这两个都会在每次 SessionStart 跳出来。所以第三面必须一起写。

## 三、怎么验的（结果）

### 生成与自验的做法

- **只读盘点**：`runSql(..., { readonly: true })` ⇒ sqlite3 以 `-readonly` 打开，
  是它自己拒绝写入，不是「我们保证不写」（结构性只读，非纪律性只读）。
- **幂等施加**：四项各自先查「是否已是目标态」，是则跳过；
  「引用某脚本的组」命中 0 个或 >1 个一律**抛错拒绝改**，绝不猜。
- **字节保真**：先证「原文经 parse→stringify(同缩进/同行尾/同末尾换行) 能逐字节还原」，
  再证「结构化 diff 恰好只含四项」⇒ 两条合起来才推得到「非改动区一个字节没动」。
  实测两份文件面的既有约定并已对齐：**live = LF + 无末尾换行**，**git 快照 = CRLF + 有末尾换行**。
- **占位符**：git 快照层的路径是 `${PROJECT_ROOT}` / `${HOME}` 形态，新增条目同样过 `encodePaths`，
  不把本机绝对路径写进 git。
- **SQL 试执行**：对一份 35 MB 的 DB **副本**跑，真库全程只读。

### 沙箱预跑：把「注册之后会怎样」变成实测

做法是造一个假 HOME（`USERPROFILE`/`HOME` 指过去），把合并后的 live settings 放进去、
把 DB 复制过去并在副本上跑注册 SQL，然后以那个环境起子进程跑全部检查器。
真库、真 live 一个字节没动。

| 命令 | 未注册 | 写完 DB+live | 三面全写 |
|---|---|---|---|
| `dao-hard-gates.js --selfcheck` | EXIT=1（G6 ✗ 零覆盖） | **EXIT=0，六闸全 ✓** | EXIT=0 |
| `dao-tool-nudge.js --selfcheck` | EXIT=1（④ ✗） | **EXIT=0，两面全 ✓** | EXIT=0 |
| `dao-subagent-clauses.js --selfcheck` | EXIT=1（两条 ✗） | **EXIT=1**，注册行转 ✓ | 同左 |
| `dao-design-sync-gate.js --selfcheck` | EXIT=1（两条 ✗） | **EXIT=1**，注册行转 ✓ | 同左 |
| `check-dead-gates.mjs` | `hooks=56 orphan=2` | `hooks=62 **orphan=0**` | `hooks=**64** orphan=0` |
| `settings-drift.js` | 硬发现 0 | **硬发现 6** | 本次四项不再出现 |
| `settings-drift.js --providers` | `drift=0 exit=0` | **`drift=8 exit=1`** | `drift=0 exit=0` |

### 🔴 两个新 hook 的 selfcheck 注册后仍 EXIT=1，这是正确结果

它们的自检是**两段**：①注册了吗 ②被宿主真的调用过吗。
第 ② 段只有真实会话能满足，故**判据看第一行文字不看退出码**：
看到 `✓ 已注册于 SubagentStart，matcher="*"` 即注册成功；`✗ 无真实触发记录` 是等它自己响。

<details>
<summary>展开：完整自验记录与材料清单（技术细节）</summary>

材料目录 `_tmp/hook-register-202608/`，重跑顺序：`00-read-current.mjs` → `01-build-package.mjs`
→ `02-verify.mjs` → `04-dryrun-postregister.mjs` → `05-crosscheck-export.mjs`。

| 文件 | 字节 | 作用 |
|---|---|---|
| `00-read-current.mjs` | 2,310 | 只读盘点（DB `-readonly`） |
| `00-db-providers-summary.json` | 9,803 | 13 行 provider 现状摘要（`claude=2` 带 hooks，其余 11 行零 hooks） |
| `01-build-package.mjs` | 15,860 | 生成器 |
| `01-merged.provider.claude-official.json` | 3,940 | provider 合并后完整配置 |
| `01-merged.provider.dulays-1784385029046.json` | 3,891 | 同上 |
| `01-merged.db-settings.common_config_claude.json` | 3,862 | DB 镜像行合并后的值 |
| `02-update-providers.sql` | 12,625 | 三条 UPDATE（事务包裹）+ 两条核验 SELECT，**纯 ASCII 零非 ASCII 字节** |
| `02-verify.mjs` | 14,865 | 自验（30 条断言，含负控） |
| `03-merged.live-settings.json` | 5,903 | live 合并后完整文件 |
| `04-merged.common-settings-snapshot.json` | 8,864 | git 快照合并后完整文件 |
| `04-dryrun-postregister.mjs` / `.log` | 3,873 / 12,172 | 沙箱预跑脚本与完整输出 |
| `05-crosscheck-export.mjs` | 3,562 | 独立重建对账 |

**自验四道全绿**（`02-verify.mjs` → `VERIFY_SUMMARY exit=0 failures=0`；
`05-crosscheck-export.mjs` → `CROSSCHECK_SUMMARY exit=0 failures=0`）：

- **V1** 5 份产物逐份 `JSON.parse` 通过；结构化 diff 恰好 4 条且四项签名 C1–C4 各命中一次。
  签名按取值特征识别、**不写死数组下标**（三个面的 hooks 组顺序不同）。
- **V1b** 序列化无损 + 行尾/末尾换行与原文一致 + 快照未把本机绝对路径写进 git。
- **V2** SQL 在副本上执行成功；providers 13 行不变、**恰好 2 行被改**且与产物逐字节相同、
  其余 11 行连同 id/name/app_type 一字节没动；settings 7 行不变、**恰好 1 行被改**；
  副本上重跑 V1 断言仍绿。
- **V3 负控** 故意①多一个第五项变更 ②把 C4 的 timeout 从 15 偷偷改成 5 ③撤掉 C1
  ⇒ 三种都变红；未改坏的产物仍绿 ⇒ 上面那些绿有判别力，不是恒绿。
- **V4 独立重建对账** 用 config-sync 自己的 `redactSettings`+`encodePaths` 从「DB 合并后的值」
  重建快照 value，与 `01` 生成的那份**逐字节相同**；`decodePaths` 反向可还原；
  同一条链在**改动前**的数据上也成立（排除「两边一样地错」）。

</details>

## 四、这次作业顺手挖出来的两个坑（值得留档）

### ⚠️ 坑一：`config-sync export` 在 worktree 里跑会静默丢掉全部路径占位符

`encodePaths` 用的「项目根」由**脚本自己所在的那棵树**推导。在 worktree 里那个根是
`windsurf-dao-wt-xxx`，于是 `D:/frank/windsurf-dao/...` 一处都替换不掉
⇒ 导出的 git 快照里写满本机绝对路径，**而退出码是 0、输出一切正常**。
2026-08-02 实测：17 处路径全裸（14 个 hook command + `statusLine.command` + `additionalDirectories`
+ `common_config_codex` 里的 `${HOME}`）。

⇒ **判据：`config-sync export` 只在主仓 `D:/frank/windsurf-dao` 跑，永远不在 worktree 跑。**

### ⚠️ 坑二：`$?` 接在管道后面读的是管道最后一个命令的退出码

本次首轮采基线时 `node hook.js --selfcheck 2>&1 | tail -20; echo $?` 报了 `EXIT=0`，
而四个 selfcheck 的真退出码全是 **1**。差点把「四道闸都没接线」记成「都好着呢」。
这和本仓 `verify-all` 退出码那条是同一个病的另一个身位：**真信号被一层无害的包装吃掉，
而输出看起来完全正常**。⇒ 要真退出码就别接管道，或用 `${PIPESTATUS[0]}`。

## 五、未尽处

- **「宿主真的会在那个事件上调它」没证到**：沙箱只跑了各脚本的 CLI 自检。
  `SubagentStart` 事件本身是读宿主 cli.js 实证存在的（见 `dao-subagent-clauses.js` 头注），
  但「注册之后它真的响了」这句话现在没有人有资格说——要等真实会话产生第一条非 synthetic 记录。
  **✅ 2026-08-07 已还（issue #162 回测批）**：真实派单的官在开场收到了注入，回报的渲染末行是
  `CLAUSE_RENDER_SUMMARY exit=0 role=general general=70 role_clauses=0 stale=0`。
  上面那句话**保留原文不改**（这份是当日作业记录，它记的是那一刻为真的东西），只在此处补一行结清。
  仍未还的是**注入率**（派 N 个官、几个真收到）：已证「响过」不等于「每次都响」。
- **`settings-drift` 的 live↔快照 那一面，第三面写完后的效果是在 worktree 里量的**，
  输出里还剩一批「脚本路径不一致」——那是 worktree 路径与主仓路径的差异造成的**测量假象**
  （`--providers` 那一面做了根路径归一化，所以它干净地到了 `drift=0`）。
  能确定的只是：本次四项引发的那 4 条硬发现在第三面写完后消失了。
- **`SubagentStart` 条目没写 `timeout`**，照派单令的字面形态；其余 dao hook 都显式写了。
  要统一加 `"timeout": 10` 是一行的事，但那属于改派单令定下的东西，没有自作主张。
- **cc-switch 开着时写 DB 会不会被它退出时盖掉**——没实测，用「动手前先关掉」绕过去了。
- **per-provider 漂移的长期解仍未做**：本次是手动把两个 provider 一起写。
  新 provider 加入、或某个 provider 被单独改一次，漂移必然复发（issue #50 记着这笔）。
  现在有 `settings-drift --providers` 能**发现**它，但对齐动作仍归人。
