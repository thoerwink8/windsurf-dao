#!/usr/bin/env bash
# 样本 4：`gh issue` 写动作带 `--body` 参数，正文里含命令替换 —— 与 issue-gateway（#792）
# 同口径：身份与正文都不该由现场拼，写动作只走网关、正文只走 `--body-file`。
# 判据比通用形状更严：`gh issue` 这一条连裸变量（`$名`）都报，因为它压根不该带 --body。
gh issue comment 42 --repo o/r --body "结论：$(git rev-parse --short HEAD) 这一版"
