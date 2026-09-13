# 故意违规：现役手册把已退役动词写成可照抄入口（#1150 应红）

人工补审官：

```bash
node scripts/dao.mjs reviewer-attach --pr 1153 --worktree x --reviewer gpt-5.6-sol
```

通知走 `node scripts/dao.mjs notify --subject review-proof`。
吞注入才走 terminal send 补救。
orca terminal send --text "<任务书>" --enter
