---
name: dispatch-regex-corpus-and-stall
description: 派正则/判定类任务必带真实语料格;工兵屏面指纹两次相同即换人不救
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 977a9262-9e2b-482c-a805-8d66d9e84602
  modified: 2026-08-15T14:43:38.040Z
---

2026-08-13 两条派工教训(#339 批实咬,当天返工×2+卡死×2 纯浪费约 1 小时):

1. **派单涉及正则/文案匹配/启发式判定时,派单书必须原文带上 dao-dispatch.md §四第 6 格**(语料来自外部真实环境,禁内生构造正反例)。codex 用 mock 英文 stderr 做负控,测试 7/7 绿但中文 Windows 真机全失效(真实 stderr 是 GBK 乱码,任何文案正则都死,最终解法是 where/which 退出码交叉验证——**判定优先用退出码/结构化信号,文案匹配是最后手段**)。

**Why**:内生语料只能证明"构造的样本已覆盖",证不了真实环境形态;验收面独立复跑才抓得住。

**2026-08-15 同一条第二次实咬,这次代价整条通道**:#485 统一命令库 CLI 的 `extractTerminalText` 认 `result.text`/`result.output`/`result.preview`/`result.lines`,而 `orca terminal read --json` 真实返回在 `result.terminal.tail`(字符串数组)——一条都不匹配,永远返回空串,`dao.mjs dispatch` 从合并那一刻起任何工人都派不出去。**审官判绿 + CI 绿 + 197 断言全绿**,因为 fixture 全是自造 JSON(仓里只存了 `--help` 文本,没存过一份真实 `--json` 返回)。

结论升级:**解析外部工具输出的函数,测试必须包含至少一份该工具真实输出的存档**,fixture 里写清采集命令与日期。自造的 JSON 必然长成解析函数认识的样子——这是"自己查自己查不出错"在数据侧的同一种失效,静态断言数量再多也拦不住。制度化挂 issue #499。

2. **工兵卡死判定**:原判据「读屏指纹连续两次相同(≥10 分钟)= 死」**2026-08-15 被证不足,不要单用**。当天 pi 工人 `git rebase --continue` 拉起 vim 等 stdin,挂死 27 分钟,而**三种探头全瞎**:门铃 `check --wait` 等 worker_done/escalation(挂死的工人两个都不发);屏面指纹(屏面在动,`⠼ Working...`→`⠴ Working...`,spinner 每次重绘指纹都不同,**永不触发**);cursor 增量(spinner 重绘也算新输出,45 秒涨 21 行像活的)。三个全是**屏面代理指标,被一个转圈动画整体打败**。

**修正判据**:①正向轻量——只数**非 spinner 的真实输出行**(实测区分度极大:挂死 45 秒/21 行全 spinner,恢复 30 秒/143 行真内容);②真判据——**「该发生的事有没有发生」**(接活超 N 分钟无新 commit、push 后超 N 分钟无新 review)。指纹相同仍是死的充分条件,但**不是必要条件**,不能当唯一探头。诊断挂死用 `Get-Process` 找挂起的 `vim`/`git`/pager,比读屏可靠。制度化挂 issue #500(含根因:工人终端缺 `GIT_EDITOR=true`,任何拉编辑器的 git 命令都会挂死)。见 [[monitor-self-check-design]]。

接手令四格(树/前任提交/未提交物/死前最后动作)在 [[dao-claude-migration]] 同仓 dao-dispatch.md §四。

**How to apply**:派单前检查任务是否含判定面,含则贴第 6 格原文;判工人死活**禁用屏面形态**(指纹/cursor/tui-idle),先看有没有该发生而没发生的事,再 `Get-Process` 找挂起进程。看门狗自动化已挂 issue #348。

3. **心跳 prompt 禁点名枚举,必须全量对账**(2026-08-13 实咬:心跳只点名树帅单路,三棵完工树的验收被漏一小时)。心跳醒来第一动作=全部在途/暂摆件对账(§七 本有此要求);"暂摆"件的解冻条件挂在阻塞消失(机器可判)上,禁挂"用户点头"(人肉解冻必漏)。用户下的优先级令≠冻结令。
