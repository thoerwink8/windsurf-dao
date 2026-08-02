# 只有你能做的事（USER-ACTIONS）

> 这个文件装的是**AI 做不到、必须你本人动手**的事。每条都写清楚：为什么非你不可、
> 具体怎么做、做完怎么确认真的生效了。
>
> 做完一条就在这里划掉（把 `- [ ]` 改成 `- [x]` 并补一句「已做，某月某日」），
> 别只在对话里说一声——对话会滚走，这个文件不会。
>
> 也可以在 GitHub 上看同一批事：置顶单 **#71 📌 需用户总览**。两边说的是一回事，
> 那边方便你在手机上回一句，这里方便你照着做。

---

## 一、issue 看板的三件收尾（2026-08-02，共约 4 分钟）

**背景**：这天给本仓装了一套 issue 派单中枢——标签、四张常设单、一个看板。
命令行能建的都建完了，但有三件事 GitHub 只允许在网页上点，命令行没有对应接口。
**不点这三下，看板会停在建好的那一刻，此后新开的 issue 一张都不会进去。**

看板地址：<https://github.com/users/thoerwink8/projects/1>（标题「windsurf-dao 观测中心」）

### - [ ] 1. 打开「新 issue 自动入板」（约 2 分钟）· 三件里最重要的

**为什么必须你来**：GitHub Projects v2 的内建自动化没有 API，`gh` 命令行建不了。

**为什么重要**：不开这个，新建的 issue 不会自己进板。看板会安安静静地过期——
它不会报错、不会变红，只是永远显示着建板那天的样子，而你以为它是最新的。
（在你点之前，AI 每建一张单都要手动 `gh project item-add` 灌一次，漏一次就少一张。）

**怎么做**：
1. 打开看板 <https://github.com/users/thoerwink8/projects/1>
2. 右上角 `⋯` → `Workflows`
3. 选 `Auto-add to project`
4. 过滤条件填：`is:issue is:open repo:thoerwink8/windsurf-dao`
5. `Save` 并确认它是启用状态（Enabled）

**怎么确认真的生效了**：下次有人（你或 AI）新建一张 issue 之后，跑这条命令看板上应该多一项：

```
gh project item-list 1 --owner thoerwink8 --format json
```

（现在跑它返回的是 `{"items":[],"totalCount":0}` —— 板是空的，这是当前实况。）

### - [ ] 2. 把内建的 `Status` 字段从视图里隐掉（约 1 分钟）

**为什么**：GitHub 新建看板时会自带一个叫 `Status` 的字段，选项是 Todo / In Progress / Done。
本仓这套用的是自己的六列（候选 / 待办 / 在途 / 待验 / 蓄水池 / 完成）。
两个状态字段并排摆着，你会不知道该看哪个——而它们会各说各的。

**怎么做**：看板视图 → 列头 `⋯` → `Hide field` → 选 `Status`；
然后把视图的 `Group by` 设成本仓那个六列字段。

**确认**：板上只剩一个状态类字段，分组按六列走。

### - [ ] 3. 核对三个置顶单的顺序（约 1 分钟）

**为什么**：GitHub 按置顶时间排序，脚本是按「待拍板 → 需用户 → 总览」依次置顶的。
顺序不合你的习惯可以自己调。

**怎么做**：打开 <https://github.com/thoerwink8/windsurf-dao/issues>，看顶部三个置顶单：

- **#70 📌 待拍板总览** —— AI 攒的、等你拍板的事，你在评论区回一句就算拍了
- **#71 📌 需用户总览** —— 只有你能做的事（就是这个文件的 GitHub 版）
- **#72 📌 总览 hub** —— 一眼对齐全局：看板链接 + 各收件箱 + 谁在跑

不合意就在对应 issue 页面 unpin / repin 调整。

<details>
<summary>技术出处（给复核与 AI 看）</summary>

三条人工步骤的定义在 `ccswitch/templates/project-board.json` 的 `manual_steps` 数组
（`auto-add-workflow` / `hide-builtin-status` / `verify-pins`），由
`ccswitch/scripts/dao-issue-bootstrap.ps1` 在实跑末尾打印。本文件是它那份打印输出的落档——
按脚本自己的说法：「不落进一个会被翻回来的地方就等于没交接」。

bootstrap 实跑结果（2026-08-02）：13 个标签、常设单 #69-#72、看板 `PVT_kwHODKDpbs4BfH2C`。
`auto:true` 在 project-board.json 里的诚实含义是「这一列的归属可由标签机械判定」，
**不是**「GitHub 会自动把单放进来」——后者正是上面第 1 条要点的那一下。

派生副本 `docs/ops/DISPATCH-HUB.md` 的 §六.5 末尾也指着本文件第 1 条。

</details>
