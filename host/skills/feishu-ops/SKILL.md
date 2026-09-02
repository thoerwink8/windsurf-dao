---
name: feishu-ops
description: 飞书机器人日常。加群↔仓映射、改放行名单、用 lark-cli 建群或发消息、查 persona、看出问题日志时读。人格规则在 feishu-triage skill，本页不复制。
---

# 飞书机器人日常

人格与规则在 `host/skills/feishu-triage/persona.md`（`deps.llm` 的 system 段全文，#801）。改语气只改那份。本页只管日常。

## 群↔仓映射：加一行

表：`host/machine/feishu-groups.json`。

- key = 群 `chat_id`（`oc_` 开头）
- 项目群：`{ "repo": "owner/name", "kind": "project" }`
- 总控群：`{ "kind": "hub" }`（不填 repo）
- `_` 开头的键是注释，不参与映射
- 占位 key 等真实 `chat_id` 下来再替换

改完重启才吃到：`sudo systemctl restart feishu-triage`。

## 放行名单

`~/.mirasim/keys/feishu-app.json` 的 `allowOpenIds` 数组（`ou_` 开头）。名单里 → 建单带「已消歧」；否则「待拍板」并给总控群卡片。只改这个字段，不要把值写进仓。文件权限 600，不进 git。

## 常用两条（机器人身份）

```bash
lark-cli im +chat-create --as bot --name "<群名>" --users ou_xxx
lark-cli im +messages-send --as bot --chat-id oc_xxx --text "<正文>"
```

建群后把返回的 `chat_id` 写进映射表。别的飞书操作走 `lark-cli im --help`。

## 出问题先看

1. `journalctl -u feishu-triage -e`（stdout 是 JSONL：`inbound` / `reply` / `action` / `done`；诊断在 stderr）
2. 映射表是否缺这一群、`chat_id` 是否还是占位
3. 凭据文件是否在、权限是否 600
4. `lark-cli` 是否用了 `--as bot`

话题状态在 `~/.dao/feishu-threads.json`（运行时自建，可丢可重算）。
