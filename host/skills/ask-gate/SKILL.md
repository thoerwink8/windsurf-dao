---
name: ask-gate
description: 问人闸——「什么时候该问用户、什么时候自己拍」的判据与触发。想知道这个闸怎么判、为什么某次提问被注了字、或要改判据时读；日常不用调，它挂在 PreToolUse 上自己会响。
---

# 问人闸

**承重的不是这一页字，是 PreToolUse hook。** 这页只在被调用的那一轮进上下文；真正在「正要提问的那一刻」起作用的，是 `hooks/ask-gate.mjs`。

## 判据

真相源是 `docs/release-policy.json`（用户 2026-09-03 拍板），不在本页复制：

- `human_holds` —— 永远问人的全集，不论大小。
- `confirm.<级>.who` —— 各级谁拍板；`patch.who = auto` 就是「小变动自己拍」那句话的出处。
- `version.bump_by_commit_type` —— 把 commit 类型换算成级（fix→patch / feat→minor / feat!→major）。

判定顺序是硬的：**红线优先于分级**。一个 fix 级的改动只要碰了删数据，照样得问。

三态，一个都不许并：`ask`（命中红线或这一级要人确认）/ `auto`（不在红线里，按 patch 级自己拍）/ `unscanned`（策略读不到或字段对不上）。**`unscanned` 绝不许退回 `auto`**——那个方向是「AI 替用户拍了不该拍的」，不可逆。

## 怎么触发

调 `AskUserQuestion` 或 `mcp__mirasim__im_ask_user` 时自动跑，注入一段判定结果。它**不拦**：拦错了就问不了用户，而用户可能正等着被问。

- 命中红线 ⇒ 一行「该问」，放行不啰嗦。
- 不在红线里 ⇒ 注入四条红线原文，要求交代依据；真属于其中一条，就在问题里带一句 `依据：<四条里的原话>`，下次这段字不再出现。
- 没查成 ⇒ 明说没查成，并当场否掉「那就自己拍吧」这条读法。

语义那部分机器不判：「这件事算不算花钱」由 AI 自己写依据交代，机器只验依据在不在四条里。跟 `dao-mode` 的 `selfie --basis` 同一个思路。

## 起因

2026-09-05 实测：帅位当天问了用户 5 次，2 次不该问（拦一个明显切错基线的 PR、关一张四轮没过的单，两件都不在 `human_holds` 里）。判据早就写好了，只是从没进过每轮注入面，名字又叫 release-policy，看起来像发布策略不像「该不该问用户」。用户原话：**「是不是要固化成机制呀？而不是作为文档，文档就会不遵守」**。

## 改判据

改 `docs/release-policy.json` 本身就在 `human_holds` 的「改规则」里 ⇒ 必须问用户。判定代码在 `scripts/lib/ask-gate.mjs`（纯函数，`tests/ask-gate.test.js` 单测）；关键词从 JSON 现算，红线改一个字判据跟着改，不必动代码。

## 挂在哪：实证结论（别再走一遍插件那条路）

**挂随仓 `.claude/settings.json` 的 PreToolUse——插件目录那条路不响。**

2026-09-05 实测：本 skill 按 `dao-mode` 的形做成了插件（`.claude-plugin/plugin.json` + `hooks/hooks.json`），
宿主 `claude plugin details ask-gate` 报 `Status: ✔ loaded`、`Hooks (1) PreToolUse`——**但它一次都没响**。
同形探针在无头会话里跑了 6 轮（PreToolUse 与 UserPromptSubmit、有无 matcher、临时目录与 skills 下真目录、
连跑 3 个会话、带与不带跳过权限），哨兵文件一个字都没写。

同一套环境下**随仓 `.claude/settings.json` 的 PreToolUse 真跑**（派工闸一直在那儿拦人）。
改挂过去之后当场验通：一次真提问，注入文本进了上下文。

推测差别在「新装的插件要交互式会话跑一次 `/reload-plugins` 才注册 hook」，但**没证实**——
`hasTrustDialogAccepted` 与 `enabledPlugins` 两条都排除了（dao-mode 压根不在 enabledPlugins 里却照样响）。

代价：随仓挂载**只在本仓生效**，别的项目里这道闸不响。要做到跨仓，得等插件那条路查清楚，
或者把它写进全局 `~/.claude/settings.json`——而那个文件会被 cc-switch 覆写（memory `claude-settings-self-heal`），
不是能随手改的地方。**这条限制是已知的，不是漏的。**
