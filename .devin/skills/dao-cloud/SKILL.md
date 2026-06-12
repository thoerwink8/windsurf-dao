---
name: dao-cloud
description: 一键连接本机 — Devin Agent 读此 skill 即可远程接入 Logan 桌面（跨账户、跨会话持久化）
---

# dao-cloud · 云接入术

> 天下莫柔弱于水，而攻坚强者莫之能胜。——水无形而无处不达；云接入亦然。

## 适用场景

- 用户说"连接本机"、"接入桌面"、"连 Logan"
- 用户发了 trycloudflare URL 或粘贴了 Bridge 接入文档
- 新账户 / 新 org 首次接入（无 secret、无 knowledge）
- Secret 过期或 URL 变化需要重新发现
- 需要在用户本机执行命令、读写文件、操作 GUI

## 铁律

```
先探后连，先连后存。
Hub 是门，Bridge 是路，conn.json 是钥匙。
不硬编码动态值，不手动要 token。
用户给了 URL 就直连，不绕 Hub。
```

---

## 〇、模式判定（最先执行）

**根据用户输入判断走哪条路：**

| 信号 | 模式 | 跳转 |
|---|---|---|
| 用户消息含 `*.trycloudflare.com` URL | **B：直连模式** | → 第 B 节 |
| 用户粘贴了含 "DAO Bridge" + URL + Token 的文档 | **B：直连模式** | → 第 B 节 |
| 用户说"连接本机"/"连 Logan" 且无 URL | **A：Hub 模式** | → 第一节 |
| Knowledge 自动注入触发 | **A：Hub 模式** | → 第一节 |

> **识别技巧**：用户不需要说"Bridge URL"等技术词。只要消息里出现 `https://xxx-xxx-xxx.trycloudflare.com` 格式的 URL，就走直连模式。常见说法：
> - "连接本机，域名是 https://xxx.trycloudflare.com"
> - "连本机 https://xxx.trycloudflare.com"
> - 直接粘贴整段接入文档

---

## B、直连模式（新设备 / 用户给了 URL · 15 秒）

> 适用于：用户粘贴了 trycloudflare URL 或整段接入文档。无需 Hub、无需 ngrok。

### B.1 提取连接信息

从用户消息中提取：
- **URL**：`https://xxx-xxx-xxx.trycloudflare.com` 格式
- **Token**：如果用户粘贴了完整文档，从中提取 `Token: xxx` 字段
- 如果用户只给了 URL 没给 token，使用默认 Bridge token：`e7b86880ab9108828a6a37440ddaa05f`

### B.2 验证连接

```bash
# health 不需要鉴权
curl -s --max-time 8 -H "User-Agent: Mozilla/5.0" \
  "<BRIDGE_URL>/api/health"
```

期望返回含 `"status"` 或 HTTP 200。

> **trycloudflare 必须带 `User-Agent` header**，否则返回 Cloudflare 拦截页。

失败 → 告知用户"URL 不可达，可能 IDE 未开或隧道已断，请确认 IDE 已启动并检查 Bridge 面板状态"。

### B.3 注册 Agent

```bash
curl -s -X POST -H "User-Agent: Mozilla/5.0" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  "<BRIDGE_URL>/api/agent/register" \
  -d '{"agent_id":"devin-cloud-agent","hostname":"devin-vm","capabilities":["shell","read","write"]}'
```

注册成功后，Agent 被 Bridge 管理，可执行命令。

### B.4 验证执行能力

```bash
curl -s -X POST -H "User-Agent: Mozilla/5.0" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  "<BRIDGE_URL>/api/exec-sync" \
  -d '{"cmd":"whoami"}'
```

期望返回含用户名（如 `administrator`）。成功 → 连接完成！

### B.5 使用

直连模式下，所有操作直接调 Bridge API：

```bash
# 执行命令
curl -s -X POST -H "User-Agent: Mozilla/5.0" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  "<BRIDGE_URL>/api/exec-sync" \
  -d '{"cmd":"<命令>"}'

# 读文件
curl -s -X POST -H "User-Agent: Mozilla/5.0" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  "<BRIDGE_URL>/api/read" \
  -d '{"path":"C:\\path\\to\\file"}'

# 写文件
curl -s -X POST -H "User-Agent: Mozilla/5.0" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  "<BRIDGE_URL>/api/write" \
  -d '{"path":"C:\\path\\to\\file","content":"内容"}'

# 列目录
curl -s -X POST -H "User-Agent: Mozilla/5.0" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  "<BRIDGE_URL>/api/ls" \
  -d '{"path":"C:\\Users\\Administrator"}'
```

> **注意**：直连模式下无法远程启动 IDE（没有 Hub）。如果 Bridge 不可达，用户需手动确认 IDE 已启动。

### B.6 持久化（可选）

直连模式下 URL 是动态的，**不存 secret**（下次 IDE 重启会变）。
但如果是首次使用 dao-cloud，仍执行 Step 3.2 创建 knowledge note（为未来 Hub 模式铺路）。

---

## 〇.1、架构总览

```
                    ┌─ ngrok 固定域名（永不变）──────────────┐
                    │  encircle-wasting-paging.ngrok-free.dev │
                    └──────────────┬─────────────────────────┘
                                   ↓
┌─ 用户本机 (DESKTOP-GET3DBC) ─────────────────────────────────┐
│                                                               │
│  Hub (ps_agent_server.py)      Plugin (dao-devin-export 扩展) │
│  port 9910                      port 7848 (完整API)           │
│  token: dao-ps-agent-2026       token: 见 conn.json           │
│  ─ 常驻，IDE 没开也在           ─ 随 IDE 启停                  │
│                                                               │
│  Bridge (frank.wuganjiqie 扩展内置, exec-sync 网关)            │
│  port: 随机分配（每次重启变化，从 conn.json 读取）              │
│  token: e7b86880ab9108828a6a37440ddaa05f（稳定，重启不变）      │
│  tunnel: *.trycloudflare.com (动态URL，重启变化)               │
│  ─ 随 IDE 启停                                                 │
└───────────────────────────────────────────────────────────────┘
```

**两条通道：**

| 通道 | 入口 | 能力 | 可用性 | 适合场景 |
|---|---|---|---|---|
| Hub（主） | ngrok 固定 URL | exec-sync（万能） | 常驻，IDE 关了也在 | Logan 主机（有 Hub） |
| Bridge（直连） | trycloudflare 动态 URL | exec-sync + 文件读写 | IDE 开着时 | 任何设备（无需 Hub） |

> 完整插件 API（sessions/export/account）仅监听本机 7848，从远端需经 Hub/Bridge exec-sync 中转调用。
>
> **重要**：Bridge 端口每次 IDE 重启随机分配（设计行为），不可锁定。
> Bridge token 是稳定的，重启不变。
> trycloudflare URL 每次重启变化（免费快速隧道，无 SLA）。

---

## 一、Hub 快速通道（模式 A · 有 secret 时 · 10 秒）

检查环境变量 `DAO_HUB_URL` 是否存在：

```bash
# DAO_HUB_URL 应为 ngrok 固定地址
curl -s --max-time 8 "$DAO_HUB_URL/api/health"
```

返回含 `"status": "ok"` → Hub 在线。直接用 Hub exec-sync 做任何事：

```bash
curl -s -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"whoami"}'
```

成功 → **跳到第四节**。
失败 / secret 不存在 → 进入第二节。

---

## 二、Hub 自动发现（模式 A · 无 secret · 30 秒）

### 常量（稳定值，安全写在此处）

| 项 | 值 | 说明 |
|---|---|---|
| Hub URL | `https://encircle-wasting-paging.ngrok-free.dev` | ngrok 免费静态域名，不会变 |
| Hub Token | `dao-ps-agent-2026` | 代码硬编码默认值 |
| Agent ID | `DESKTOP-GET3DBC` | 本机 hostname |
| 插件端口 | `7848` | 本机完整 API |
| IDE 路径 | `D:\Windsurf\Devin.exe` | Devin Desktop 可执行文件 |

### Step 1：验证 Hub 在线

```bash
curl -s --max-time 8 https://encircle-wasting-paging.ngrok-free.dev/api/health
```

期望：`{"status":"ok", ...}`。
失败 → 用户本机未开机或 ngrok 未启动，**通知用户**后停止。

### Step 2：通过 Hub exec-sync 验证命令执行

```bash
curl -s -X POST https://encircle-wasting-paging.ngrok-free.dev/api/exec-sync \
  -H "Authorization: Bearer dao-ps-agent-2026" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"whoami"}'
```

期望返回 `desktop-get3dbc\administrator`。
返回 `unauthorized` → Hub token 被用户改过，请用户提供新 token。

### Step 3：检查 IDE / 插件是否在运行

```bash
curl -s -X POST https://encircle-wasting-paging.ngrok-free.dev/api/exec-sync \
  -H "Authorization: Bearer dao-ps-agent-2026" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"curl -s --max-time 3 http://127.0.0.1:7848/api/ping"}'
```

期望 stdout 含 `"ok":true`。

**如果插件没响应**（stdout 为空或 exit_code 非 0）→ IDE 未启动，执行 Step 3a。

#### Step 3a：通过 Hub 远程启动 IDE

```bash
curl -s -X POST https://encircle-wasting-paging.ngrok-free.dev/api/exec-sync \
  -H "Authorization: Bearer dao-ps-agent-2026" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"start \"\" \"D:\\Windsurf\\Devin.exe\""}'
```

启动后**等待 15-30 秒**让 IDE 加载扩展，然后轮询插件就绪：

```bash
# 每 5 秒轮询一次，最多重试 6 次（30 秒）
curl -s -X POST https://encircle-wasting-paging.ngrok-free.dev/api/exec-sync \
  -H "Authorization: Bearer dao-ps-agent-2026" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"curl -s --max-time 3 http://127.0.0.1:7848/api/ping"}'
```

返回 `{"ok":true,...}` → 插件就绪，继续。
超过 60 秒仍无响应 → 通知用户手动检查 IDE。

### Step 4（可选）：发现 Bridge 公网 URL

> 仅当需要**不经 Hub 直连**时执行。Hub exec-sync 已足够完成所有操作。
> Bridge 的 trycloudflare URL 是**动态的**，每次 IDE 重启会变。不要缓存，每次需要时重新发现。

```bash
curl -s -X POST https://encircle-wasting-paging.ngrok-free.dev/api/exec-sync \
  -H "Authorization: Bearer dao-ps-agent-2026" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"powershell -NoProfile -Command \"Get-Content $env:USERPROFILE\\.dao\\bridge\\conn.json -Raw\""}'
```

从返回 JSON 的 `result.stdout` 解析：
- `url` → Bridge trycloudflare 公网 URL（**动态，不要存 secret**）
- `token` → Bridge Bearer token（`e7b86880ab9108828a6a37440ddaa05f`，稳定不变）
- `port` → Bridge 本地端口（随机分配，仅本地访问时需要）

验证 Bridge：
```bash
curl -s --max-time 8 -H "User-Agent: Mozilla/5.0" \
  -H "Authorization: Bearer <BRIDGE_TOKEN>" \
  -H "Content-Type: application/json" \
  -X POST <BRIDGE_URL>/api/exec-sync \
  -d '{"cmd":"whoami"}'
```

> trycloudflare 入口**必须带 `User-Agent`**，否则被拦截页挡住。

### Step 5（可选）：验证完整插件 API

经 Hub/Bridge exec-sync 中转访问本机 7848 端口的完整插件 API：

```bash
# 经 Hub 中转查插件状态
curl -s -X POST https://encircle-wasting-paging.ngrok-free.dev/api/exec-sync \
  -H "Authorization: Bearer dao-ps-agent-2026" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"curl -s http://127.0.0.1:7848/api/ping"}'
```

期望：`{"ok":true,"service":"dao-devin-export bridge"}`

> 注意：插件 7848 端口（dao-devin-export 完整 API）的 token 与 Bridge token 不同。
> Bridge（frank.wuganjiqie 扩展内置）token 是稳定的：`e7b86880ab9108828a6a37440ddaa05f`
> 插件 7848 的 token 需经 exec-sync 读取。

---

## 三、持久化（一次即永久 · 含自动 Knowledge Note）

发现完成后，执行以下两步持久化：

### 3.1 保存 Org Secret

保存为 Devin org 级 secret（同 org 所有未来会话自动注入）：

| Secret 名 | 值 | 说明 |
|---|---|---|
| `DAO_HUB_URL` | `https://encircle-wasting-paging.ngrok-free.dev` | Hub 固定地址 |
| `DAO_HUB_TOKEN` | `dao-ps-agent-2026` | Hub Bearer token |

使用 `request_secret` 工具，设置 `should_save=true`，`save_scope="org"`。

### 3.2 自动创建 Repo Knowledge Note（关键）

连接成功后，**必须检查并创建 repo-pinned knowledge note**，确保未来会话自动触发连接：

使用 `devin_mcp` 工具调用 `devin_knowledge_manage`：

```json
{
  "action": "create",
  "name": "远程接入本机（windsurf-dao 仓库自动触发）",
  "trigger": "When working on the windsurf-dao repository (github.com/thoerwink8/windsurf-dao)",
  "content": "本仓库用户的本机桌面（Logan / DESKTOP-GET3DBC）可通过 dao-cloud skill 远程接入。每次新会话启动时，自动执行以下流程：1. 读取 .devin/skills/dao-cloud/SKILL.md 2. 按 skill 中自动发现流程连接本机（Hub URL固定，token固定，无需用户提供）3. 如果 IDE 未启动，通过 Hub 远程启动 4. 验证插件就绪后即可操作本机。所有常量已写在 skill 文件中，无需用户手动提供任何 token 或 URL。",
  "pinned_repo": "thoerwink8/windsurf-dao"
}
```

> **执行前先检查**：用 `devin_knowledge_manage` 的 `list` action + `pinned_repo: "thoerwink8/windsurf-dao"` 查看是否已存在同名 note。已存在则跳过，避免重复创建。

> **为什么必须做这步**：Knowledge note 绑定 Devin org，切账号后会丢。
> 但只要用户说一句"读 dao-cloud skill 连本机"触发本流程，这步会自动重建 note，
> 之后同 org 所有新会话（只要勾选 windsurf-dao 仓库）都自动连接，无需再手动说。

> **Bridge URL/Token 不存 secret**：trycloudflare URL 每次 IDE 重启会变，
> 存了也会过期。需要时实时经 Hub exec-sync 发现即可。

---

## 四、使用指南

### 4.1 执行命令（最常用）

```bash
# 通过 Hub exec-sync
curl -s -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"<你的命令>"}'
```

**注意：**
- 字段名是 `cmd`，**不是** `command`（用错会静默无输出）
- 默认 cmd.exe 执行；要 PowerShell：`powershell -NoProfile -Command "..."`
- Hub 一次只跑一条命令，前一条卡住会堵队列
- 长任务用 `Start-Process ... -WindowStyle Hidden` 后台拉起再轮询
- 别发前台阻塞 / 等待输入的命令

### 4.2 读写文件

```bash
# 读文件
curl -s -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"powershell -NoProfile -Command \"Get-Content C:\\path\\to\\file -Raw\""}'

# 写文件
curl -s -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"powershell -NoProfile -Command \"Set-Content -Path C:\\path\\to\\file -Value \\\"内容\\\"\""}'
```

### 4.3 插件完整 API（经中转）

完整插件 API 仅本机 7848 端口可达，需经 exec-sync 中转：

```bash
# 插件状态
curl -s -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"curl -s http://127.0.0.1:7848/api/ping"}'
```

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | /api/ping | 探活 | 视插件版本 |
| GET | /api/status | 插件状态 + 端点列表 | 需 token |
| GET | /api/sessions | 全部会话 | 需 token |
| GET | /api/session/{id}/worklog | 工作日志 | 需 token |
| POST | /api/session/{id}/export | 导出 ZIP | 需 token |
| GET | /api/account/playbooks | playbooks | 需 token |
| GET | /api/account/knowledge | knowledge | 需 token |
| GET | /api/doc | 完整 API 文档 | 需 token |

> 插件 token 与 Hub/Bridge token 不同，需经 exec-sync 读取或由用户提供。

### 4.4 GUI 操作（截屏 / 点击）

```bash
# 截屏
curl -s -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"powershell -NoProfile -EncodedCommand <base64脚本>"}'
```

- 截屏：`System.Drawing` 截 `VirtualScreen` → PNG → base64
- 输入：`SetCursorPos` + `mouse_event` 点击、`SendKeys` 键入
- 复杂脚本用 `-EncodedCommand` 传，避免 inline 被截断

---

## 五、故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| Hub health 超时 | 本机未开机 / ngrok 未启动 | 通知用户开机或手动启动 ngrok |
| Hub 返回 `unauthorized` | Hub token 被改 | 请用户提供新 token 或检查 `PS_AGENT_MASTER_TOKEN` 环境变量 |
| exec-sync 超时 / pending>0 | 前一条命令卡住堵队列 | 等几分钟自动超时，或请用户结束卡住进程 |
| 插件 ping 无响应 | IDE 未启动 | 执行 Step 3a 远程启动 IDE，轮询等待就绪 |
| 启动 IDE 后仍无响应 | 扩展未安装/崩溃 | 通知用户手动检查 IDE 扩展状态 |
| Bridge URL 失效 | IDE 重启 trycloudflare 变了 | 重跑 Step 4 重新发现（动态值不缓存） |
| Secret 不存在 | 切了账户/org | 重跑第二节存 secret |
| 插件 API 返回 `invalid token` | 插件 token 与 Hub/Bridge token 不同 | 经 exec-sync 读插件 token |
| 直连模式 URL 不通 | IDE 未启动或隧道断连 | 告知用户确认 IDE 已启动；trycloudflare 偶发断连是正常的（Cloudflare 服务端问题），等几分钟或重启 IDE |
| 隧道反复断连 | trycloudflare 免费快速隧道无 SLA | 正常现象，等待自动恢复；或配置 Cloudflare 命名隧道（Bridge 面板 → 填 Tunnel Token） |

---

## 六、安全约定

- **默认只读 / 非破坏性操作**
- 未经用户明确授权，**不执行**：删除文件、停止/重启服务、写文件、关机/重启、改系统配置
- Hub token 是本地默认值，非生产密钥；如需加固，用户可设环境变量 `PS_AGENT_MASTER_TOKEN` 覆盖
- 不在 git 提交真实 token；本文件中的 `dao-ps-agent-2026` 是代码硬编码的公开默认值

---

## 附录：基础设施参考

详细的 ngrok 配置、Windows 路径、启动脚本、从零部署说明见：
`docs/cf-daohub-fixed-url.md`（本仓库，面向管理员的基础设施手册）
