# 干净样本：点名退役入口但同一行交代调用即拒（#1150 应绿）

`dao.mjs reviewer-attach` 已退役，调用即拒。补派审官走 `reviewer-create`。
`dao.mjs notify` 已退役，不要调；通知走 GitHub 评论 + 飞书 hub。
`dispatch --batch` 已随 orca 编排退役，当场拒。
没有 `terminal send` 可补（orca 已退役，调用即拒）。吞注入就停手报未送达。
