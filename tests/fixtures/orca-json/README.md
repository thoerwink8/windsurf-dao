# orca JSON 真语料

这些文件是某次真实 `orca <cmd> --json` 的落盘，不是按解析函数期望手写的假 JSON。
解析外部工具输出的函数必须至少喂一份这里的存档（#499：自造 JSON 让验开工全绿、真通道全死）。

刷新（本机有 orca，采集日期写进 `index.json` 的 `capturedAt`）：

```
orca terminal read --terminal $ORCA_TERMINAL_HANDLE --limit 10 --json
orca terminal create --worktree $ORCA_WORKTREE_ID --title fixture-capture --command "cmd /c echo fixture-probe" --json
orca worktree create --name _fixture-recapture --no-parent --setup skip --json
# create 完立刻 worktree rm --force，不要留孤儿树
orca orchestration task-create --spec "夹具采集" --json
# task-create 要已绑 Run；id 在 result.task.id，不是 result.id
orca terminal send --terminal $ORCA_TERMINAL_HANDLE --text probe-580 --json
# send --json 在 result.send.{handle,accepted,bytesWritten}；不带 --json 是纯文本 Sent N bytes to term_xxx.
orca orchestration send --to $ORCA_TERMINAL_HANDLE --subject fixture-capture --body "夹具采集" --json
# send 的消息 id 在 result.message.id；注意 delivered_at 对活着的收件人也是 null
```

`index.json` 把 `scripts/lib/dao-cmd.mjs` 里每个 `export function extract*` 映射到一份语料。
dao-check 扫源码里的 extract*，缺映射或缺文件就红。
检查器自己读 JSON 信封（`ok` + `result`），不调用 extract*——自己查自己查不出形状漂了。
