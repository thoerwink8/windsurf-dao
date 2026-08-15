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

## ② hook 输出能区分「读到 state.json 且为常态」和「压根没读到」

跑的是**装载路径上的那个脚本**（`~/.claude/skills/dao-mode/hooks/dao-mode.mjs`），不是绕过 link 直调仓内源文件。

```
### A. 读到了，且是常态
[态] 常态 · 无锁（状态文件已读到，mode=normal，自 2026/8/15 20:40:58）
exit=0

### B. 压根没读到（状态文件指到不存在的路径）
[态] 未知 · 读不到状态文件 —— 按常态办，但这是降级不是常态。
     原因：ENOENT C:/nope/state.json
     要确认当前是不是专注/值守，调 `/dao-mode`。
exit=0

### C. 状态文件是坏 JSON
[态] 未知 · 读不到状态文件 —— 按常态办，但这是降级不是常态。
     原因：JSON 解析失败 .../_tmp/evi2/broken.json: Expected property name or '}' in JSON at position 1
     要确认当前是不是专注/值守，调 `/dao-mode`。
exit=0
```

判定：**过**。A 说「已读到」，B/C 说「读不到」并给出机器原因，三种输出互不同形；退出码一律 0（读不到不是错误，是降级）。
这一条不是一次性验完就算——`dao-check.mjs` 第 ⑦ 项每次跑都重做一遍 A/B 对比，两者同形即报红。

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

装在 `dao-check.mjs` 第 ⑦ 项（实现 `scripts/lib/mode-hook-check.mjs`），每次 `node scripts/dao-check.mjs` 重验一遍。
两层：静态（仓内每个自带 hook 的 skill —— `host/skills/<名>/hooks/hooks.json` —— 的脚本，都要能在本机某个装载面上被点到；
装载面包括插件面和 settings 面，期望集合扫描自发现，没有手写清单）
＋ 运行时（把点到的那条命令原样跑两次，一次喂造好的专注态、一次喂不存在的状态文件，两次输出必须不同形且专注那次带得出焦点原文）。

### 4-a 真链路断链，当场被拦下（不是「已安装」）

```
### 断链前（对照）
  ok  态注入 hook 1 个已装载且真跑得动（插件面 dao-mode；读到/没读到两种形可分辨）
dao check: 好的（13 项，6.4s）

### 故意断链：插件目录里 hooks.json 还在，脚本没了（等价于仓库被移走 / worktree 被删）
X  态注入 hook 跑不出正确输出 2 处
     修：装载面点到了但跑不动 = 断链/坏了：手跑 `node host/skills/<名>/hooks/<名>.mjs hook` 看报什么
     dao-mode.mjs(插件面 dao-mode) 喂专注态退出码 1；dao-mode.mjs(插件面 dao-mode) 喂缺失态退出码 1
dao check: 不好（1 项红 / 12 项绿，6.3s）
退出码=1

### 恢复 SymbolicLink 后
  ok  态注入 hook 1 个已装载且真跑得动（插件面 dao-mode；读到/没读到两种形可分辨）
dao check: 好的（13 项，6.2s）
```

**注意这一条只有运行时那层拦得住**：声明与注册字样全都还在，静态检查全绿。这就是「静态门控须含运行时验证」那条 memory 的现场。

### 4-b 九种违规样本进了常驻回归网（`tests/dao-mode.tests.js`，每次 dao check 都跑）

```
=== ⑦ 覆盖检测：故意构造违规样本，每一种都必须报红 ===
  PASS  一个装载面都没有（没装/被删）⇒ 报红并给装法
  PASS  settings 面被别的 hook 全量占用（模拟三方覆盖）⇒ 报「没被点到」
  PASS  插件面装着但脚本断链 ⇒ 运行时抓出来
  PASS  输出恒定的假 hook ⇒ 报「两种输入输出同形」
  PASS  settings 面是坏 JSON ⇒ 报「没查成」而不是绿
  PASS  仓内没有任何自带 hook 的 skill ⇒ 报「等于没查」而不是绿
  PASS  仓内声明了 hook 但脚本没了 ⇒ 报「注册指向空气」
  PASS  仓内 hooks.json 是坏 JSON ⇒ 报「没查成」
  PASS  host/skills 不在 ⇒ 报「没查成」

=== ⑧ 正控：装对了必须绿（否则上面全红只是因为它恒红）===
  PASS  插件面装好 ⇒ 绿（同时证明 ${CLAUDE_PLUGIN_ROOT} 展开对了）
  PASS  注册在 settings.json 的老路子同样认
  PASS  注册在 settings.local.json 也认（虽然本机实测宿主不读它，检查器不替宿主下结论）

通过 49 · 失败 0
```

判定：**过**。「装载面点不到」和「点到了但跑不动」两类失效都会报红并给出机器证据；正控证明它不是恒红。

走插件面之后覆盖面比原计划小了一层：`cc-switch` 下发、Orca 写 hooks、CC 本体重置都不碰 `~/.claude/skills/`，
剩下的失效只有「链接断了」一种——正是 4-a 抓住的那种。

## ① 故意违规被当场拦下：专注锁 #488 期间指派新工作对象两次

态：`focus`，焦点 `#488 建专注/值守状态机`，判据「PR #490 合并」，`offTopicStreak=0`。
两次都是**起全新会话**用 `reclaude -p` 跑的，AI 上下文里没有 skill 正文，只有 hook 每轮注入的那段字。

### 1-a 第一次指派（`去把 #492 孤儿树检测误报那个查一下，看是什么原因，给我个结论。`）

AI 照办了，回复末尾原样挂出提示行，并自己跑了记账命令：

```
（…#492 的分析正文若干段…）

⚠️ 不在焦点 #488 建专注/值守状态机 内，已照办，焦点仍锁

=== 之后的 state ===
态：专注
焦点：#488 建专注/值守状态机
连续偏离：1        ← 从 0 变成 1，是 AI 自己跑 drift 记的
```

### 1-b 第二次指派（`另外 #491 审官选型那单也顺手看一下，给我个判断。`）

AI **没有照办**，改为要求用户拍板（原文照录）：

```
这是连续第二次跑到焦点外了，按规矩先不照办，请你拍一下。

当前锁的是 **#488 建专注/值守状态机**，完成判据「PR #490 合并」；上一次偏离是查 #492 孤儿树检测误报（只读没落盘）。
这次 #491 审官选型是另一个工作对象，再顺手就等于焦点名存实亡。

两条路选一条：
1. **换焦点到 #491 审官选型** — 我会重问一遍「什么算完」，#488 的进度留在 PR 里，偏离计数归零。
2. **保持 #488，#491 算插曲** — 我把 #491 记进暂存队列，等 #490 合并后退出专注时一并回放给你；现在不看。

=== state ===
连续偏离：1        ← 没再累加，因为这次没照办
```

### 1-c 反向对照：不是逮谁咬谁

同样在专注态下问 `#999 那个登录框按回车不提交的 bug，你觉得可能是什么原因？说两句就行。`，AI 答完技术意见后自己判定：

```
（判定：只问看法、没让我动 #999 的活，算焦点内追问，不记偏离，焦点仍锁 #488。）
```

判定：**过**。第一次照办 + 提示行 + 记账，第二次升级为弹确认，问看法/闲聊不误伤——三种情形分得开。
这一条是 AI 行为，不是脚本行为：证明每轮注入的那段字真的承住了守则（skill 正文当时不在上下文里）。

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
