# 工具使用闸：heredoc 吞转义 / python 是 stub（#969）

署名 issue #969，关单交给 `scripts/close-issues.mjs`。

## 目标

把两条已经存在、但每轮只注入索引行所以到点不出现的 memory（`heredoc-eats-backslash-escapes`、`python-stub-use-py`）做成 PreToolUse 提示：只看 Bash 命令文本，命中就注一句判据，**不拦动作**。与 ask-gate 同口径、同挂载面（随仓 `.claude/settings.json`）。

## 验收标准

1. 不拦动作，只注文本（命中走 `hookSpecificOutput.additionalContext`，exit 恒 0）。
2. 反证测试两头都有判别力：违规 heredoc / 裸 `python` 必须被注中；不含转义的 heredoc / `py` / `python3` 必须不注。
3. 任何 spawn 都带 `windowsHide: true`（本闸 hook 不 spawn；测试 spawnSync 必带）。
4. 上线证据是「故意违规被当场注中」的记录，不是「已安装」。
5. 落点 A 类：`host/skills/tool-use-gate/hooks/`，onboard 用 Junction 链过去；注册面写进 NEW-MACHINE（`~/.claude/settings.json` 归宿主自己，onboard 不能动）。真响的挂载面是随仓 `.claude/settings.json`（ask-gate 2026-09-05 实证：插件 hooks.json 不响）。

## 进展

- 纯函数 `scripts/lib/tool-use-gate.mjs` + hook `host/skills/tool-use-gate/hooks/tool-use-gate.mjs`。
- 随仓 `.claude/settings.json` PreToolUse matcher `^Bash$`。
- `tests/tool-use-gate.test.js` 24 条全绿（含真进程注中 / 反证闭嘴 / 坏 stdin 仍 exit 0）。
- `node scripts/dao-check.mjs` 好的（134 项，7 项跳过）。
- 本机 skill 发现面已链 `~/.claude/skills/tool-use-gate`。

### 上线证据（故意违规被当场注中）

喂 PreToolUse JSON 给 hook 进程（不是单元测试替身）：

```
command = cat > tests/foo.test.js <<'EOF'\nconst re = /\s+/;\nEOF
→ additionalContext 含「吞掉」，systemMessage 含 heredoc-escape，exit 0

command = python -c "open(r\"a.txt\",\"w\").write(\"x\")"
→ additionalContext 含 stub，systemMessage 含 python-stub，exit 0

不含转义的 heredoc / py -3 → stdout 空，exit 0
```

### 机制判定

这错在制度生效前还会再犯吗？**会**——memory 每轮只注入索引行，敲命令那一刻判据仍不在眼前。机制改在本 PR：PreToolUse 看命令文本、命中自动注。拦动作会挡住正常工作，所以只注不拦，与 ask-gate 同口径。插件 hooks.json 那条路 2026-09-05 已实证不响，本闸直接挂随仓 settings，不走第二层补丁。
