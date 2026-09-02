# CLI 踩坑教学：飞书（`lark-cli`）

> 不是派工工人 CLI。日常加群、放行名单、启停适配器见 `host/skills/feishu-ops/SKILL.md`。
> 本页记接线命令、身份切换、事件消费和 2026-09-03 当晚踩的坑。决策与实况指针：`docs/decisions/2026-09-03-server-landing-night.md`、issue #801。

## 一句话特性

企业自建应用 + **长连接**收 `im.message.receive_v1`，不需要公网回调。CLI 同时可持 bot / user 两套身份，**发消息默认走 `--as bot`**。

## 坑

- **话题群 ≠ Discord 式线性群**（#801 消歧补充 4 原建成 `--chat-mode topic`）。用户要的是频道式线性对话，追问走回复串。四个群已改建成 `--chat-mode group`。chat_id 换过，**不要抄进仓**——当时值在 #801「实况接线记录」评论；当前映射表随 PR #806 入仓（本树未合入，合入前看 live 副本，不把 id 写入本页）。
- **`im:chat:delete` 未开通**：旧话题群解散不了。开通前不要假设能清掉误建的群。
- **`send_as_user` 未开通**：用户身份发不了消息。接线、回执、总控卡片一律 `--as bot`。
- **node-sdk 长连接是独立 `WSClient` + `EventDispatcher`**（#801 块 A / PR #806），不是 `lark-cli event consume`。后者是备选事件源：secret 不出 CLI，适配器可加 `--source lark-cli`（当时未做）。
- **身份混用**：`--as user` 用的是用户授权，bot 不在的群/没开的 scope 会空成功或权限错。动手前 `lark-cli auth status --as bot` / `--as user`。
- **凭据不进 git**：落点归 ai-gateway-stack（INDEX E 类 `~/.mirasim/keys`）。本页不写文件内容、不写 app_id。

## 正确起法（接线）

权威步骤在 #811 / #801，这里只留命令形状（占位符不要换成真值）：

```bash
npm i -g @larksuite/cli
lark-cli config init --new                 # 浏览器授权：自动建应用、配长连接与事件
lark-cli auth login --recommend            # 用户身份（推荐 scope，少一次审批）
lark-cli auth list                         # 取用户 open_id（ou_…），不要写进仓
lark-cli im +chat-create --as bot \
  --chat-mode group \
  --name "<群名>" \
  --users <ou_> \
  --set-bot-manager
```

建完把返回的 `chat_id` 写入映射表（形状见 `feishu-ops`），不要写进本页。

发消息：

```bash
lark-cli im +messages-send --as bot --chat-id oc_xxx --text "<正文>"
```

默认身份可查 / 可改：`lark-cli config default-as`。

## 事件消费（备选接法）

适配器主路是 node-sdk 长连接。CLI 备选：

```bash
lark-cli event consume im.message.receive_v1 --as bot
```

stdout 是 NDJSON；stderr 出现 `[event] ready event_key=…` 才算订阅成功。secret 不出 CLI。完整契约见 lark-event skill，本页不复制。

## 权限当天踩过才开

需要解散旧群 → 开 `im:chat:delete`。需要用户身份代发 → 开 `send_as_user`。没开就换 bot 身份或换手段，不要对着报错重试建群。
