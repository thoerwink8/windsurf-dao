# orca --help 语料

这些文件是某次真实 `orca <cmd> --help` 的落盘，不是手写假 help。
刷新（本机有 orca）：

```
orca terminal create --help > tests/fixtures/orca-help/terminal-create.txt
orca terminal read --help > tests/fixtures/orca-help/terminal-read.txt
orca terminal send --help > tests/fixtures/orca-help/terminal-send.txt
orca terminal close --help > tests/fixtures/orca-help/terminal-close.txt
orca worktree create --help > tests/fixtures/orca-help/worktree-create.txt
orca worktree rm --help > tests/fixtures/orca-help/worktree-rm.txt
orca orchestration task-create --help > tests/fixtures/orca-help/orchestration-task-create.txt
orca orchestration worker-start --help > tests/fixtures/orca-help/orchestration-worker-start.txt
orca orchestration send --help > tests/fixtures/orca-help/orchestration-send.txt
orca orchestration inbox --help > tests/fixtures/orca-help/orchestration-inbox.txt
orca orchestration run-show --help > tests/fixtures/orca-help/orchestration-run-show.txt
orca orchestration run-current --help > tests/fixtures/orca-help/orchestration-run-current.txt
```

自检优先跑 live `--help`；orca 不在 PATH（如 GitHub-hosted CI）才读这里。

**往 `catalogUsedFlags()` 加一条命令，必须同一次提交里补它的夹具**：漏了在本机全绿（走 live），
到 CI 才炸成「没查成」——`tests/dao.tests.js` 已加一条「每条命令都有夹具」的检查，本机就会报。
