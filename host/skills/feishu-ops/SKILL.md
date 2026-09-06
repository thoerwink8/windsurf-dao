---
name: feishu-ops
description: 飞书机器人日常。加群↔仓映射、改放行名单、用 lark-cli 建群或发消息、查 persona、看出问题日志时读。人格规则在 #801 的 feishu-triage skill，本页不复制。
---

# 飞书机器人日常

人格与规则随 #801 PR #803 入仓（feishu-triage skill 的 persona 文件，`deps.llm` 的 system 段全文）。本树未合入，改语气去那份 PR，本页不复制。

## 群↔仓映射：加一行

仓内 `host/machine/feishu-groups.json` 是占位模板（真实 chat_id 不进仓）。实机映射在 `~/.mirasim/keys/feishu-groups.json`（600，与凭据同目录，换机手动带）。加一行用这个形状：

- key = 群 `chat_id`（`oc_` 开头）
- 项目群：`{ "repo": "owner/name", "kind": "project" }`
- 总控群：`{ "kind": "hub" }`（不填 repo）
- `_` 开头的键是注释，不参与映射
- 占位 key 等真实 `chat_id` 下来再替换

dao-check 的 feishu-groups 项优先读实机映射，用 `lark-cli im chats get --as bot` 确认群还在；没有实机映射则 SKIP「本机未接飞书」。红了改实机那份：把失效 chat_id 换成还活着的（`lark-cli im +chat-list --as bot`），或删掉已解散的那一行。

改完重启才吃到：`sudo systemctl restart feishu-triage`。

## 放行名单

`~/.mirasim/keys/feishu-app.json` 的 `allowOpenIds` 数组（`ou_` 开头）。名单里 → 建单带「已消歧」；否则「待拍板」并给总控群卡片。只改这个字段，不要把值写进仓。文件权限 600，不进 git。目录归属见 `host/machine/INDEX.md`。

## 常用两条（机器人身份）

```bash
lark-cli im +chat-create --as bot --name "<群名>" --users ou_xxx
lark-cli im +messages-send --as bot --chat-id oc_xxx --text "<正文>"
```

建群后把返回的 `chat_id` 写进映射表。别的飞书操作走 `lark-cli im --help`。

## 出问题先看

1. `journalctl -u feishu-triage -e`（stdout 是 JSONL：`inbound` / `reply` / `action` / `done`；诊断在 stderr）
2. 实机映射是否缺这一群、`chat_id` 是否还是占位（`~/.mirasim/keys/feishu-groups.json`；仓内 `host/machine/feishu-groups.json` 只是占位）
3. 凭据文件是否在、权限是否 600
4. `lark-cli` 是否用了 `--as bot`

话题状态在 `~/.dao/feishu-threads.json`（运行时自建，可丢可重算）。日报队列在 `~/.dao/broadcast-digest.json`。

## 私聊

手机飞书点开机器人即可问答（`chat_type=p2p`，走总帅对话，不进群映射）。开发者后台要勾上「接收私聊消息」——事件仍是 `im.message.receive_v1`，代码已经收。

## 日报

总控群每天最多一张 Card JSON 2.0「道·日报」。心跳/发布/熔断先入队，换日且有变化才发；完全没变化一个字都不发。看待拍板按钮和群菜单走同一条取数（GitHub「待拍板」标签）。
