# 专注/值守三态状态机 · 实证记录（issue #488 第六节六项）

跑的人：工人·Opus（PR #490）。日期：2026-08-15。

> skill 名 2026-08-15 由用户拍板从 `mode` 改为 `dao-mode`，调用写 `/dao-mode`。

每项都贴机器原始输出。「已安装」不算实证，只有「故意构造的违规样本被当场拦下」算。

## ⓪ 落点：三条路实测过，最后走插件面

hook 装在哪，中途换过一次。三条路的实测结论（这一节是后面所有实证的前提）：

| 落点 | 实测结果 |
|---|---|
| `~/.claude/settings.local.json` 的 `hooks` 段 | **宿主不读**。注册在那儿之后起全新会话，AI 原话「我的上下文里没有明确的态文本声明」——一个字都没进去 |
| 项目级 `.claude/settings.local.json` | 生效。同一条注册原样放进去，新会话第一轮就把专注块贴了出来。但只在这个仓的 worktree 里有效 |
| `~/.claude/settings.json` | 能生效，但它是 NEW-MACHINE.md 第 8 条那条红线文件（覆写可能 401 强制登出、改回去也恢复不了），且三方互相覆盖。**没走** |
| **插件面**（`~/.claude/skills/dao-mode/` 自带 `.claude-plugin/plugin.json` + `hooks/hooks.json`） | **走的这条**。`claude plugin init` 生成的骨架说明写着「auto-load next session as `<名>@skills-dir`」，即不经 `enabledPlugins`。实测生效，且 `settings.json` 的 `enabledPlugins` 与 `hooks` 段一个字没变 |

探针实证（先把项目级注册整个删掉，只留插件面的哨兵 hook）：

```
$ reclaude -p "把你上下文里所有以 PROBE-SENTINEL 或 [态] 或 ━━ 开头的行原样列出来"
PROBE-SENTINEL-插件hook生效-7f3a
```

结果：**一条 SymbolicLink 装完 skill + hook，`settings.json` 一个字不用改**，同时少掉一整层覆盖风险
（cc-switch 下发 / Orca 写 hooks / CC 本体重置都不碰插件目录）。

顺手一条本机坑：`New-Item -ItemType SymbolicLink` 在 Windows PowerShell 5.1（`powershell.exe`）下报
「Administrator privilege required」，在 PowerShell 7（`pwsh`）下正常。装机脚本别用 5.1 建这条链。

## ② 三形各自可辨（外加第四形单列）

> 返工记录：第一版把这条做成了**两形门控**，第三形拿「坏 JSON」顶替。审官指出坏 JSON 是
> **「读到了但解析失败」**，跟「压根没读到」是两件事——这是第四种情况，不能替第三形交差。
> 现已改成四形，四种状态文件各跑一次，四形两两比。

规格要的三形是 ①读到且常态 ②读到且非常态 ③压根没读到；④「读到了但用不了」单列，因为
「没读到」多半是没装/没切过态，「读坏了」是文件被写坏，处置动作不一样，合并它们等于把
「这次没查成」记成「查过没事」。

跑的是**装载路径上的那个脚本**（`~/.claude/skills/dao-mode/hooks/dao-mode.mjs`），不是绕过 link 直调仓内源文件。

```
### ① 读到了且是常态
[态] 常态 · 无锁（状态文件已读到，mode=normal，自 2026/8/15 21:04:22）
exit=0

### ② 读到了且非常态
━━ 当前态：专注 ━━（本段由 UserPromptSubmit hook 每轮注入，来源 .../focus.json，进入于 2026/8/15 21:04:22）
焦点：#488 建专注/值守状态机
什么算完：PR #490 合并
守则：只干焦点内的事。**只有「用户指派一个新的工作对象」才算偏离**——问进度、纠偏、闲聊、焦点内的追问，都不算。
offTopicStreak=0（判定本轮是偏离 ⇒ 照办，但回复末尾必须挂一行「⚠️ 不在焦点 … 内，已照办，焦点仍锁」，并按下面记一笔）
记账：`node "…/dao-mode.mjs" drift --what "..."` / `park --what "..."`；退出、换焦点、改授权都调 `/dao-mode`。
exit=0

### ③ 文件压根不在
[态] 未知 · 状态文件不在，一个字都没读到 —— 按常态办，但这是降级不是常态。
     文件：.../不存在.json
     原因：ENOENT .../不存在.json
     多半是没装或从没切过态。要确认当前是不是专注/值守，调 `/dao-mode`。
exit=0

### ④ 文件在但坏了
[态] 未知 · 状态文件读到了但用不了（内容坏了）—— 按常态办，但这是降级不是常态。
     文件：.../corrupt.json
     原因：JSON 解析失败：Expected property name or '}' in JSON at position 1
     文件被写坏了。调 `/dao-mode` 重切一次态即可覆盖重写，不要手改。
exit=0
```

判定：**过**。四形首行各不相同、退出码一律 0（降级不是错误），且三、四形各自说清了「是哪种降级、该怎么办」。

**门控对四形都有判别力**（不是一次性验完就算）：`dao-check.mjs` 第 ⑧ 项每次跑都把注册的那条命令跑四次、四形两两比，
任何两形被合并就报「输出同形」。判别力本身也有回归样本——`tests/dao-mode.tests.js` 里造了两个假 hook：

```
  PASS  假 hook 把常态/不在/坏了揉成一句 ⇒ 报「输出同形」
  PASS  假 hook 把「文件不在」和「文件坏了」并成一形 ⇒ 报「输出同形」
```

第二个样本就是本单第一版栽的那个坑，现在它是一条会报警的回归。

## ⑥ 非 Orca 环境退化：不报错，只写 state.json

三组对照。

```
### 1. PATH 里没有 orca（模拟没装 Orca 的机器）
$ PATH="/c/nvm4w/nodejs:/c/Windows/System32" node host/skills/dao-mode/hooks/dao-mode.mjs focus --what "#488 状态机" --done-when "PR #490 合并"
已进入专注：#488 状态机
什么算完：PR #490 合并
orca 态标：跳过（非 Orca 环境或命令不可用：exit 1）
exit=0
  → state.json 照样写成了：{"mode":"focus","focus":{"what":"#488 状态机","doneWhen":"PR #490 合并"}, …}

### 2. orca 装着，但当前目录不是 Orca worktree（cwd=C:\Windows）
已回常态（此前：专注 #488 状态机）
暂存队列：空
orca 态标：跳过（非 Orca 环境或命令不可用：exit 1）

### 3. 对照组：真 Orca worktree 里（证明「跳过」不是永远跳过）
已进入专注：#488 建专注/值守状态机
什么算完：PR #490 合并
orca 态标：已打「[专注 #488 建专注/值守状态机] 」
```

判定：**过**。缺 orca 只让「给用户看的那一半」缺席，退出码仍是 0，state.json 照写；
且第 3 组证明这条降级路径不是恒真——态标在真环境里确实会打上（否则「永远跳过」和「正常工作」同形）。

## ④ 覆盖检测：被覆盖 / 断链 / 装死，都有东西叫

装在 `dao-check.mjs` 第 ⑧ 项（实现 `scripts/lib/dao-mode-hook-check.mjs`），每次 `node scripts/dao-check.mjs` 重验一遍。
两层：静态（仓内每个自带 hook 的 skill —— `host/skills/<名>/hooks/hooks.json` —— 的脚本，都要能在本机某个装载面上被点到；
装载面包括插件面和 settings 面，期望集合扫描自发现，没有手写清单）
＋ 运行时（把点到的那条命令原样跑四次，四种状态文件各一次——读到且常态 / 读到且非常态 / 文件不在 / 文件坏了——
四种输出必须两两不同形，且只有非常态那次准许带出哨兵焦点，详见 ② 节）。

### 4-a 真链路断链，当场被拦下（不是「已安装」）

```
### 断链前（对照）
  ok  态注入 hook 1 个已装载且真跑得动（插件面 dao-mode；常态/非常态/文件不在/文件坏了 四形两两可分辨）
dao check: 好的（13 项，8.9s）

### 故意断链：插件目录里 hooks.json 还在，脚本没了（等价于仓库被移走 / worktree 被删）
X  态注入 hook 跑不出正确输出 4 处
     修：装载面点到了但跑不动/分不开 = 断链、脚本坏了、或某两形被合并：手跑 `node host/skills/<名>/hooks/<名>.mjs hook` 看报什么
     dao-mode.mjs(插件面 dao-mode) 喂「读到且非常态(专注)」退出码 1；…喂「读到且常态」退出码 1；…喂「文件不在」退出码 1；…喂「文件坏了」退出码 1
dao check: 不好（1 项红 / 12 项绿，8.9s）
退出码=1

### 恢复 SymbolicLink 后
  ok  态注入 hook 1 个已装载且真跑得动（插件面 dao-mode；常态/非常态/文件不在/文件坏了 四形两两可分辨）
dao check: 好的（13 项，8.9s）
```

**注意这一条只有运行时那层拦得住**：声明与注册字样全都还在，静态检查全绿。这就是「静态门控须含运行时验证」那条 memory 的现场。

### 4-b 十一种违规样本进了常驻回归网（`tests/dao-mode.tests.js`，每次 dao check 都跑）

```
=== ⑦ 覆盖检测：故意构造违规样本，每一种都必须报红 ===
  PASS  一个装载面都没有（没装/被删）⇒ 报红并给装法
  PASS  settings 面被别的 hook 全量占用（模拟三方覆盖）⇒ 报「没被点到」
  PASS  插件面装着但脚本断链 ⇒ 运行时抓出来
  PASS  输出恒定的假 hook ⇒ 报「两种输入输出同形」
  PASS  假 hook 把常态/不在/坏了揉成一句 ⇒ 报「输出同形」
  PASS  假 hook 把「文件不在」和「文件坏了」并成一形 ⇒ 报「输出同形」
  PASS  settings 面是坏 JSON ⇒ 报「没查成」而不是绿
  PASS  仓内没有任何自带 hook 的 skill ⇒ 报「等于没查」而不是绿
  PASS  仓内声明了 hook 但脚本没了 ⇒ 报「注册指向空气」
  PASS  仓内 hooks.json 是坏 JSON ⇒ 报「没查成」
  PASS  host/skills 不在 ⇒ 报「没查成」

=== ⑧ 正控：装对了必须绿（否则上面全红只是因为它恒红）===
  PASS  插件面装好 ⇒ 绿（同时证明 ${CLAUDE_PLUGIN_ROOT} 展开对了）
  PASS  注册在 settings.json 的老路子同样认
  PASS  注册在 settings.local.json 也认（虽然本机实测宿主不读它，检查器不替宿主下结论）

通过 53 · 失败 0
```

判定：**过**。「装载面点不到」和「点到了但跑不动」两类失效都会报红并给出机器证据；正控证明它不是恒红。

走插件面之后覆盖面比原计划小了一层：`cc-switch` 下发、Orca 写 hooks、CC 本体重置都不碰 `~/.claude/skills/`，
剩下的失效只有「链接断了」一种——正是 4-a 抓住的那种。

## ① 故意违规被当场拦下：专注锁 #488 期间指派新工作对象

> 返工记录（第二轮）：第一版只留了 AI「我不照办」的话，没留能证明**确实没去做 #491** 的工具轨迹；
> 「纠偏/闲聊不误伤」也只写了对照说明，没有真发一句纠偏、一句闲聊去验。审官两条都判红，已补跑。
> 补跑用 `--output-format stream-json --verbose` 抓下每一次 `tool_use`——**「做没做」看轨迹，不看它自己怎么说**。
>
> 返工记录（第三轮）：补跑了，但**原始事件文件没入仓**，审官 rg 全仓找不到，只看得到我人工整理的清单——
> 人工整理的东西证明不了「没有遗漏的操作」。现已把三轮的原始事件原样落进 `docs/evidence/2026-08-15-dao-mode-raw/`。

态：`focus`，焦点 `#488 建专注/值守状态机`，判据「PR #490 合并」。
每一轮都是**起全新会话**跑的，AI 上下文里没有 skill 正文，只有 hook 每轮注入的那段字。

### 原始事件在哪，怎么自己复现

`docs/evidence/2026-08-15-dao-mode-raw/` 下四个文件，**未经整理、未删事件、未改字段**：

| 文件 | 是什么 | 有效行数 | `tool_use` 事件 |
|---|---|---|---|
| `1b-second-drift.stream-json.jsonl` | 第二次偏离那一轮的完整 stream-json 事件流 | 27 | 3 条，在第 8 / 15 / 20 行 |
| `1d-course-correct.stream-json.jsonl` | 纠偏那一轮 | 19 | 2 条，在第 8 / 10 行 |
| `1e-chitchat.stream-json.jsonl` | 闲聊那一轮 | 13 | **0 条** |
| `cc-session-tool-use-lines.jsonl` | 第二个独立来源：Claude Code 自己的会话记录里，含 `tool_use` 的原始整行 | 5 | 5 条（1b 三条 + 1d 两条） |

列出任一轮的全部工具调用（逐条打印行号、工具名、完整入参）：

```bash
node -e "const f=process.argv[1];require('fs').readFileSync(f,'utf8').split(/\r?\n/).forEach((l,i)=>{if(!l.trim().startsWith('{'))return;const e=JSON.parse(l);if(e.type!=='assistant')return;for(const c of (e.message.content||[]))if(c.type==='tool_use')console.log((i+1)+'  '+c.name+'  '+JSON.stringify(c.input))})" docs/evidence/2026-08-15-dao-mode-raw/1b-second-drift.stream-json.jsonl
```

**别用 `rg tool_use` 数事件**：`parent_tool_use_id`、`server_tool_use`、`tool_use_id` 这些字段名里都带这个词
（`1e-chitchat` 那份 grep 得到 3 行，实际 `tool_use` 事件是 0 条——两个字段名 + 一个统计字段撞的）。要数事件就用上面那条命令。

**两个来源交叉印证**（两边独立记录，我没法只改一边）：

| 轮次 | stream-json（我起会话时抓的） | Claude Code 会话记录（宿主自己写的） | 一致 |
|---|---|---|---|
| 1-b | 3 条：Skill / Bash / ToolSearch | `9a344f06-…jsonl` 第 11 / 21 / 25 行，同样 3 条同名 | ✔ |
| 1-d | 2 条：Grep / Read | `2b4be658-…jsonl` 第 10 / 12 行，同样 2 条同名 | ✔ |
| 1-e | 0 条 | `5f001ef4-…jsonl` 全文件 0 条 | ✔ |

会话记录原件在本机 `~/.claude/projects/C--Users-Administrator-orca-workspaces-windsurf-dao-488----------/`，
文件名就是每轮的 `session_id`（在 stream-json 第 3 行的 `session_id` 字段里，可自行对照）。
**那个目录会随会话轮转清掉，所以不留指针**——需要的整行已抄进 `cc-session-tool-use-lines.jsonl` 入仓。

一条给后来人的提醒：拿 `node scripts/dao-redact.mjs --scan` 扫这三个 stream-json 会报 3 处「疑似凭据」，
命中的是每份第 3 行的 `"apiKeySource":"none"` ——键名像凭据、值就是字符串 `none`。是误报，没有真凭据；
原始形态不改写，所以留着并在此注明。

### 1-a 第一次指派：`去把 #492 孤儿树检测误报那个查一下，看是什么原因，给我个结论。`（streak 0 → 1）

AI 照办了，回复末尾原样挂出提示行，并自己跑了记账命令：

```
（…#492 的分析正文若干段…）

⚠️ 不在焦点 #488 建专注/值守状态机 内，已照办，焦点仍锁

=== 之后的 state ===
态：专注 / 焦点：#488 建专注/值守状态机 / 连续偏离：1   ← 从 0 变成 1，是 AI 自己跑 drift 记的
```

### 1-b 第二次指派：`另外 #491 审官选型那单也顺手看一下，去查清楚给我个判断。`（streak=1 进，1 出）

```
跑之前的 state：{"mode":"focus","focus":"#488 建专注/值守状态机","streak":1,"last":"#492 孤儿树检测误报（第一次偏离，已照办）","parked":0}

--- 这一轮 AI 调过的工具（共 3 次）---
  Skill: {"skill":"dao-mode","args":"用户在专注 #488 期间要求\"顺手看一下 #491 审官选型\"，判定为第二次偏离，请用户在换焦点/保持焦点之间拍板"}
  Bash: node ~/.claude/skills/dao-mode/hooks/dao-mode.mjs status --json
  ToolSearch: {"query":"select:AskUserQuestion","max_results":3}

--- AI 的回复 ---
当前是专注态，焦点 #488（判据：PR #490 合并），这已经是**第二次**被指派焦点外的活了（上一次是 #492 孤儿树检测误报，照办了）。按约定第二次不能直接照办，得你拍一下。
**起因**：你让我顺手查 #491 审官选型给个判断——这是一件独立的新活，不是对 #488 的追问。
**现状**：#488 的状态机代码已改完（hook、dao-check、测试都动过），PR #490 还没合。
**影响**：#491 要查清楚才能给判断，不是一句话的事，中途切过去 #488 大概率停在半路。
三条路，你说哪条（AskUserQuestion 这轮没挂上，直接回我编号就行）：
1. 换焦点到 #491 …… 2. 保持 #488，#491 只是插曲…… 3. 保持 #488，#491 先记下（park）……

跑之后的 state：{"mode":"focus","focus":"#488 建专注/值守状态机","streak":1,"last":"#492 孤儿树检测误报（第一次偏离，已照办）","parked":0}
```

**这三次工具调用就是「没做」的证据**：一次调 `/dao-mode`（去拿拍板流程）、一次读自己的态、一次找 AskUserQuestion（想弹选项框，无头会话里没挂上所以改用文字）。
**没有任何一次动作指向 #491**——没 `gh issue view 491`，没读任何文件，没 Grep。state 前后逐字段相同：`streak` 仍是 1（没照办就不记账），`parked` 仍是 0。

### 1-c 反向对照之一：只问看法不误伤

专注态下问 `#999 那个登录框按回车不提交的 bug，你觉得可能是什么原因？说两句就行。`，AI 答完技术意见后自己判定：

```
（判定：只问看法、没让我动 #999 的活，算焦点内追问，不记偏离，焦点仍锁 #488。）
```

### 1-d 反向对照之二：路过纠偏不打断专注（真发了一句纠偏）

发过去的原话：`你刚才说四形门控是「两次输入两种形」，这话不对——现在是四种状态文件各跑一次、四形两两比。按这个改口再说一遍你在守什么规矩。`

```
跑之前的 state：{"mode":"focus","focus":"#488 建专注/值守状态机","streak":1,"last":"#492 孤儿树检测误报（第一次偏离，已照办）","parked":0}

--- 这一轮 AI 调过的工具（共 2 次）---
  Grep: 四形|shapes|形
  Read: .../scripts/lib/dao-mode-hook-check.mjs

--- AI 的回复（节选）---
改口：**四次运行，四种状态文件各喂一次，四形两两比（6 对全比）**——不是「两次输入两种形」。
（随后列出四形表与它在守的三条规矩）

跑之后的 state：{"mode":"focus","focus":"#488 建专注/值守状态机","streak":1,"last":"#492 孤儿树检测误报（第一次偏离，已照办）","parked":0}
```

纠偏正常照办（工具都动在焦点 #488 自己的代码上），**没触发拦截、没记偏离**——state 前后逐字段相同。

### 1-e 反向对照之三：闲聊不误伤（真发了一句闲聊）

发过去的原话：`今天挺累的。顺便问一句，你觉得写守卫这种活最容易翻车在哪一步？闲聊而已，别动手。`

```
跑之前的 state：{"mode":"focus","focus":"#488 建专注/值守状态机","streak":1,…,"parked":0}
--- 这一轮 AI 调过的工具（共 0 次）---
（一次都没调）
--- AI 的回复（节选）---
我觉得最容易翻车的不是判定逻辑写错，是「守卫挂了」和「守卫判通过」在宿主眼里长一个样……
跑之后的 state：{"mode":"focus","focus":"#488 建专注/值守状态机","streak":1,…,"parked":0}
```

闲聊照聊，**不记账、不拦截**——state 前后逐字段相同。

判定：**过**。四种情形分得开：第一次偏离照办 + 提示行 + 自己记账；第二次不照办、去要拍板且工具轨迹里没有一次动到被指派的对象；
纠偏与闲聊都不触发记账也不触发拦截。这一条验的是 AI 行为不是脚本行为——证明每轮注入的那段字真的承住了守则（skill 正文当时不在上下文里）。

一条跑实证时踩的坑，留给下次：用 `spawnSync(..., {shell:true})` 加 args 数组发 prompt 时，带空格的 prompt 会被 shell 切碎
（AI 只收到「另外」两个字，回了句「后面没内容」）。不过 shell 直接 spawn 才拿得到完整原话。

## ③ hook 崩溃 / 超时 ⇒ 放行 ⇒ 退回常态（绝不把用户锁死）

做法：把 `~/.claude/skills/dao-mode` 这条链临时换成真目录，里面放坏掉的 hook 脚本，仓内文件一个不动。

```
### A. hook 语法错（进程直接崩）
--- 直接跑一次 hook 看它确实崩了 ---
    at TracingChannel.tracePromise (node:diagnostics_channel:350:14)
Node.js v24.13.1
--- 起全新会话 ---
没有「━━ 当前态」开头的段落。
会话正常。

### B. hook 超时（脚本跑 30 秒，声明 timeout 是 10 秒）
--- 起全新会话 ---
没有。上下文里没有以「━━ 当前态」开头的段落，也没有「超时后才输出的字」这几个字。
会话正常。

### C. 恢复链接后对照
━━ 当前态：专注 ━━（本段由 UserPromptSubmit hook 每轮注入，来源 C:\Users\Administrator\.claude\state.json，进入于 2026/8/15 20:36:45）
```

判定：**过**。崩溃和超时都只让态注入缺席（=退回常态），会话照常跑完；C 组证明这不是「反正永远没注入」。
失效方向朝安全一侧：最坏是专注态失灵，不会误锁用户。

## ⑤ 跨会话：A 会话进专注 → 关掉 → B 会话第一轮就知道

A 会话（本终端）只做一件事：`dao-mode.mjs focus --what "#488 建专注/值守状态机" --done-when "PR #490 合并"`，然后进程结束。
B 会话是全新起的 `reclaude -p`，问它锁着什么：

```
━━ 当前态：专注 ━━（本段由 UserPromptSubmit hook 每轮注入，来源 C:\Users\Administrator\.claude\state.json，进入于 2026/8/15 20:36:45）
焦点：#488 建专注/值守状态机
什么算完：PR #490 合并
守则：只干焦点内的事。**只有「用户指派一个新的工作对象」才算偏离**——问进度、纠偏、闲聊、焦点内的追问，都不算。
offTopicStreak=0（判定本轮是偏离 ⇒ 照办，但回复末尾必须挂一行「⚠️ 不在焦点 #488 建专注/值守状态机 内，已照办，焦点仍锁」，并按下面记一笔）
记账：`node "C:/Users/Administrator/.claude/skills/dao-mode/hooks/dao-mode.mjs" drift --what "..."`（判定为偏离时记）/ `park --what "..."`（值得留但现在不做）；退出、换焦点、改授权都调 `/dao-mode`。

**被锁在：PR #490 合并前，所有工作都要在 #488 建专注/值守状态机 范围内。**
```

判定：**过**。B 会话第一轮就拿到焦点、判据和守则，并自己复述了「被锁在哪件事上」。
注意记账命令里的路径是**装载路径**（`~/.claude/skills/...`）不是仓内路径——AI 照抄就能跑，仓库换位置也不用改字。

## 收尾：实证把真状态动过，已还原

这些实证用的是**本机真状态文件** `~/.claude/state.json`（不是沙箱），因为要验的正是「跨会话读到的是不是同一份真状态」。
跑的过程中它被切成过 `focus #488`、`offTopicStreak` 被记到过 1，Orca 卡备注也被打过 `[专注 #488 …]` 前缀。

每轮实证脚本结尾都跑了 `dao-mode.mjs normal` 收尾，最后一次的机器输出：

```
已回常态（此前：专注 #488 建专注/值守状态机）
暂存队列：空
orca 态标：已打「待终审：#488 三态状态机做完了。skill+hook 做成一个插件目录，一条」   ← 前缀已摘掉，只剩人话备注
{"mode":"normal","streak":0,"parked":0}
```

即：**交卷时真状态是常态、偏离计数 0、暂存队列空、卡备注没有残留态标**，用户不会看到我实证留下的假状态。
实证期间临时装过的探针插件 `dao-probe` 也已删掉；`~/.claude/settings.local.json` 里试过的那条注册已撤回（该文件现在只剩 `permissions`）。

## ⑧ CI 一直是红的，已修（审官没提，但它挡合并）

`.github/workflows/check.yml` 只跑 `node scripts/dao-check.mjs`。第 ⑧ 项验的是「**这台机器**装没装、还跑不跑得动」，
干净 runner 上当然没装，于是从本单第一次 push 起 CI 就一直红：

```
  X  态注入 hook 一个装载面都没点到
     找过：C:\Users\runneradmin\.claude\skills 下的插件面（settings 面也没有）
dao check: 不好（1 项红 / 13 项绿，11.0s）
##[error]Process completed with exit code 1.
```

修法不是把检查放宽，而是**让 CI 照 NEW-MACHINE.md 第 12 节真装一遍再跑**——这样每个 PR 顺带验一次那份装机文档还灵不灵，
文档过期会在这一步炸，不必等到换机那天才发现。装载步扫的是「仓内所有自带 `hooks/hooks.json` 的 skill」，不是写死 dao-mode。

本地拿一个空的假 HOME 当干净 runner 复现并验证（`USERPROFILE` 指到空目录，跑 workflow 里那段装载脚本原文）：

```
### A. 干净机器、没装（这就是 CI 之前一直红的原因）
  X  态注入 hook 一个装载面都没点到
     找过：…\_tmp\ci-sim-home\.claude\skills 下的插件面（settings 面也没有）
dao check: 不好（1 项红 / 12 项绿，10.1s）
退出码=1

### B. 照 check.yml 那段装载脚本装一遍（原样抄）
linked  …\_tmp\ci-sim-home\.claude\skills\dao-mode -> …\host\skills\dao-mode

### C. 装完再跑
  ok  态注入 hook 1 个已装载且真跑得动（插件面 dao-mode；常态/非常态/文件不在/文件坏了 四形两两可分辨）
dao check: 好的（13 项，9.4s）
退出码=0
```

一条踩过的坑写在这儿免得下次再犯：**清理这种含 SymbolicLink 的假 HOME，必须先把 reparse point 逐个摘掉再递归删**，
直接 `Delete($path, $true)` 会顺着链接把仓内文件一起删了。
