---
name: dao-mode
description: 切专注/值守/常态三态。用户说「进入专注」「我要专心搞 #N」「我睡了」「无人值守」「退出专注」「换焦点」「回常态」「现在什么态」时触发；专注期间连续第二次被指派新工作对象时，也由 AI 主动触发让用户拍板。
---

# 三态开关

常态 / 专注 / 值守，互斥，同一时刻只有一个。**值守可以带焦点**（「我睡了，今晚只把 #488 干完」）。

态怎么用不在这里：值守期间该怎么干已常驻在全局 CLAUDE.md，本 skill 只管切换。

**承重的不是这一页字，是 UserPromptSubmit hook。** 这页只在用户调用的那一轮进上下文，之后随对话滚走；让二十轮后的 AI 仍知道自己被锁着的，是每轮注入的那段态文本。所以本 skill 的唯一职责是：把用户的意图变成 `state.json` 里的字段，别的都别做。

状态的唯一读写入口是 `~/.claude/skills/dao-mode/hooks/dao-mode.mjs`（仓内真相源 `host/skills/dao-mode/hooks/dao-mode.mjs`）。**不要自己去读写 state.json**——绕过入口写的字段，hook 那边不认。

## 第一步：先问机器现在是什么态

```bash
node ~/.claude/skills/dao-mode/hooks/dao-mode.mjs status --json
```

第一问的选项**按当前态动态生成**，不是固定四项：

| status 报的 mode | 第一问给这些选项 |
|---|---|
| `normal` | 进入专注 / 进入值守 |
| `focus` | 退出专注 / 换焦点 / 转为值守 |
| `standby` | 退出值守 / 给值守加个焦点 |
| 读不出（`unreadable`） | 进入专注 / 进入值守 / 先修状态文件（把 status 的报错原样给用户看） |

用 AskUserQuestion 问（每问硬限 2—4 个选项）。

## 各岔路

### 进入专注

**两道追问，一道都不能删**——它们正是让专注可验的东西，删了就退化成「我说我专注了」：

1. **焦点是哪件**：先跑 `gh pr list --json number,title --limit 10` 和 `gh issue list --json number,title --limit 10`，把在途的列成选项让用户点；给一个「自己写」的口子。
2. **什么算完**（退出判据）：给 2—4 个具体选项（如「PR 合并」「跑通并验收」「拿到结论就停」），别给「你自己写吧」当唯一出路。

```bash
node ~/.claude/skills/dao-mode/hooks/dao-mode.mjs focus --what "#488 建专注/值守状态机" --done-when "PR #490 合并"
```

### 退出专注

1. 问一句：**完成**还是**中止**（两个选项）。
2. 跑 `node ~/.claude/skills/dao-mode/hooks/dao-mode.mjs normal`，它会把专注期间攒的暂存队列打印出来。
3. **把队列逐条回放给用户**，一条一行，附上是什么时候攒的。队列空就直说空。

### 换焦点

再走一遍「进入专注」的两道追问，然后同样跑 `focus`（它会把偏离计数归零，暂存队列保留）。

### 保持焦点（这只是插曲）

用户在第二次偏离时选了「不换」：

```bash
node ~/.claude/skills/dao-mode/hooks/dao-mode.mjs clear-drift
```

### 进入值守

只追问**授权边界**——哪些你自己拍、哪些恒挂起等用户。

**不问战报落点**：落点定死在 Orca worktree comment + 置顶单，每次答案都一样的问题等于收税。

```bash
node ~/.claude/skills/dao-mode/hooks/dao-mode.mjs standby --decide "选型；改动方案；返工调度" --hold "合并 master；删数据；对外发布"
# 带焦点（「今晚只把 #488 干完」）再加：--what "#488 状态机"
```

### 退出值守

跑 `node ~/.claude/skills/dao-mode/hooks/dao-mode.mjs normal`，然后按全局 CLAUDE.md 已有的那行格式吐批量三行摘要（干到哪 / 要决定什么 / 推荐哪个）——**格式不要另造**，暂存队列里的条目也一并回放。

## 违背检测（AI 自己遵守，判据每轮由 hook 注入）

- **什么算违背**：只有「用户指派一个新的工作对象」算。问进度、纠偏、闲聊、焦点内的追问，全不算（路过纠偏不打断专注/值守）。
- **第一次**：照办，回复末尾挂一行 `⚠️ 不在焦点 #N 内，已照办，焦点仍锁`，并 `node ~/.claude/skills/dao-mode/hooks/dao-mode.mjs drift --what "<被指派的事>"`。
- **连续第二次**：不要直接照办，先调 `/dao-mode`，只问一件事——「换焦点到 #M」还是「保持 #N，这只是插曲」。
- **为什么是第二次**：复用本仓已有判据「同一种办法连错两次就换路」。每次都弹会训练用户无脑点继续；只提示不弹会攒出假状态（连偏 5 次态标还挂着专注 #N），假状态比没状态更糟。

用户提到的、与焦点无关但值得留的想法：`node ~/.claude/skills/dao-mode/hooks/dao-mode.mjs park --what "..."`，退出时随队列回放。

## 装没装

这个 skill 目录同时是一个 Claude Code 插件：`.claude-plugin/plugin.json` + `hooks/hooks.json` 把 UserPromptSubmit hook 一并带上，
装载只要一条 SymbolicLink（`~/.claude/skills/dao-mode` → 仓内本目录），**不用改 `settings.json`**。装法见 `NEW-MACHINE.md` 第 12 节。

hook 没装上的话，这个 skill 就退化成「我说我专注了」——切完态之后没有任何东西会在后续轮次提醒 AI。
`node scripts/dao-check.mjs` 第 ⑧ 项专门查它：装载面点不点得到 + 把那条命令真跑四次（四种状态文件各一次）看四形分不分得开。
