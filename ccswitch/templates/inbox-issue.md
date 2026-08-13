<!-- canonical 蓄水池 inbox 的 issue body 模板 · 真相源在 windsurf-dao ccswitch/templates/inbox-issue.md
     一份模板服务三个 inbox（待拍板 / 需用户 / 候选）。三者的差异——标题、一句话、怎么用、表头——
     **不写在这里**，写在 templates/labels.json 里对应池标签的 `inbox` 段（那里是唯一真相源），
     由 ccswitch/scripts/dao-issue-bootstrap.ps1 取出后填进下面的占位符。

     为什么这么分：三个 inbox 的**结构**完全一样（说明块 + 快照表 + 已消化段），只有措辞不同。
     把结构放模板、把措辞放标签定义，改一个 inbox 的说法时不用碰另外两个，也不会出现
     「模板里写一套、脚本里又写一套」的双份漂移。 -->

> **这是什么**：<INBOX_ONE_LINER>
>
> **你怎么用**：<INBOX_HOW_TO_USE>
>
> **修复类 PR body 必带**：`Fixes #单号`（确无对应单才写「无关联单」）——修复不回填，issue 池只进不出。
>
> <INBOX_EXTRA_NOTE>
>
> 实时清单筛 [`label:<INBOX_LABEL>`](<INBOX_LABEL_QUERY_URL>)（下面的快照可能滞后，以标签筛出来的为准）。
>
> 本单**永不关闭**（常设蓄水池入口）。维护责任在 AI：每次增减时刷新本 body 并标注快照时间。

## 当前清单（快照 <SNAPSHOT_DATE>）

| <INBOX_TABLE_HEADER> |
|<INBOX_TABLE_SEP>|
| — | *（建单时为空，AI 随后填入）* |<INBOX_TABLE_PAD>

## 已消化（留档）

（无——本单于 <SNAPSHOT_DATE> 建立）
