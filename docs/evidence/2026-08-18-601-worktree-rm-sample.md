# #601 / PR #603：`worktree-rm` 当场退役关台

安全样本，不是本 PR 自己的树。2026-08-18 本机实跑。

- 树：`601-归档样本2`（`--no-parent`）
- Run：`run_81f4e9e7ca72`
- 信箱台：`term_951cf989-f5f1-42d3-88db-9400dd943776`
- 工人映射：`ctx_cfce5982e5d7`（agent 已 done，不占 occupancy）

归档前租约：

```json
{"pid":41980,"runId":"run_81f4e9e7ca72","handle":"term_951cf989-f5f1-42d3-88db-9400dd943776"}
```

`node scripts/dao.mjs worktree-rm --worktree name:601-归档样本2`（先于任何 `retire --run`）：

```json
{"ok":true,"removed":[{"id":"1770a430-983a-4e86-9277-9f1e5c376b83::C:/Users/Administrator/orca/workspaces/windsurf-dao/601-归档样本2","name":"601-归档样本2"}],"runs":{"ok":true,"retired":[{"ok":true,"state":"retired","runId":"run_81f4e9e7ca72","closed":{"handle":"term_951cf989-f5f1-42d3-88db-9400dd943776","ok":true,"alreadyGone":false},"removed":["D:\\frank\\windsurf-dao\\_flow\\inbox-81f4e9e7ca72.lease","D:\\frank\\windsurf-dao\\_flow\\inbox-81f4e9e7ca72.cmd","D:\\frank\\windsurf-dao\\_flow\\inbox-81f4e9e7ca72.log"]}],"failed":[],"skipped":[]}}
```

随后 `node scripts/inbox-station.mjs retire --run run_81f4e9e7ca72`：

```json
{"ok":true,"state":"retired","runId":"run_81f4e9e7ca72","closed":{"handle":null,"ok":true,"alreadyGone":true},"removed":[]}
```

租约文件不存在。工人终端未被关。
