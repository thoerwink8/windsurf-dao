#!/usr/bin/env bash
# 样本 3：`--body` 当参数传，正文里含命令替换 —— 正文与实测值不一致且不报错。
# 用 `gh pr comment` 写这条样本（`gh issue ...` 的形状另有一条更强的判据：写动作
# 只走网关，见 bad-gh-issue-body.sh）。正当做法：正文写进文件，`--body-file f.md`。
gh pr comment 42 --repo o/r --body "结论：$(git rev-parse --short HEAD) 这一版"
