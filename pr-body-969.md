# 工具使用闸：heredoc 吞转义 / python 是 stub（#969）

署名 issue #969，关单交给 `scripts/close-issues.mjs`。

## 目标

把两条已经存在、但每轮只注入索引行所以到点不出现的 memory（`heredoc-eats-backslash-escapes`、`python-stub-use-py`）做成 PreToolUse 提示：只看 Bash 命令文本，命中就注一句判据，**不拦动作**。与 ask-gate 同口径、同挂载面（随仓 `.claude/settings.json`）。

## 验收标准

1. 不拦动作，只注文本（命中走 `hookSpecificOutput.additionalContext`，exit 恒 0）。
2. 反证测试两头都有判别力：违规 heredoc / 裸 `python` 必须被注中；不含转义的 heredoc / `py` / `python3` 必须不注。
3. 任何 spawn 都带 `windowsHide: true`（本闸尽量不 spawn；检查器 spawn 必带）。
4. 上线证据是「故意违规被当场注中」的记录，不是「已安装」。
5. 落点 A 类：`host/skills/<名>/hooks/`，onboard 用 Junction 链过去；注册面写进 NEW-MACHINE（`~/.claude/settings.json` 归宿主自己，onboard 不能动）。真响的挂载面是随仓 `.claude/settings.json`（ask-gate 2026-09-05 实证：插件 hooks.json 不响）。

## 进展

开工：空提交撑分支并推送，开 draft PR。
