---
name: dao-cloud
description: 一键连接本机 — Devin Agent 读此 skill 即可远程接入 Logan 桌面（跨账户、跨会话持久化）
---

# dao-cloud · 云接入术

> 天下莫柔弱于水，而攻坚强者莫之能胜。——水无形而无处不达；云接入亦然。

## 适用场景

- 用户说"连接本机"、"接入桌面"、"连 Logan"
- 新账户 / 新 org 首次接入（无 secret、无 knowledge）
- Secret 过期或 URL 变化需要重新发现
- 需要在用户本机执行命令、读写文件、操作 GUI

## 铁律

```
先探后连，先连后存。
Hub 是门，Bridge 是路，conn.json 是钥匙。
不硬编码动态值，不手动要 token。
```

---

## 〇、架构总览

```
                    ┌─ ngrok 固定域名（永不变）──────────────┐
                    │  [REDACTED:hub-host] │
                    └──────────────┬─────────────────────────┘
                                   ↓
┌─ Logan ([REDACTED:machine]) ────────────────────────────────────┐
│                                                               │
│  Hub (ps_agent_server.py)      Plugin (dao-devin-export 扩展) │
│  port 9910                      port 7848 (完整API)           │
│  token: [REDACTED:hub-token]       token: 见 conn.json           │
│  ─ 常驻，IDE 没开也在           ─ 随 IDE 启停                  │
│                                                               │
│  Bridge (exec-sync 精简网关)                                   │
│  port: 动态 (见 conn.json)                                     │
│  token: 见 conn.json                                           │
│  tunnel: *.trycloudflare.com (动态URL)                         │
│  ─ 随 IDE 启停                                                 │
└───────────────────────────────────────────────────────────────┘
```

**两条通道：**

| 通道 | 入口 | 能力 | 可用性 |
|---|---|---|---|
| Hub（主） | ngrok 固定 URL | exec-sync（万能） | 常驻，IDE 关了也在 |
| Bridge（辅） | trycloudflare 动态 URL | exec-sync | IDE 开着时 |

> 完整插件 API（sessions/export/account）仅监听本机 7848，从远端需经 Hub/Bridge exec-sync 中转调用。

---

## 一、快速通道（有 secret 时 · 10 秒）

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
  -d '{"agent_id":"[REDACTED:machine]","cmd":"whoami"}'
```

成功 → **跳到第四节**。
失败 / secret 不存在 → 进入第二节。

---

## 二、自动发现（无 secret · 30 秒）

### 常量（稳定值，安全写在此处）

| 项 | 值 | 说明 |
|---|---|---|
| Hub URL | `https://[REDACTED:hub-host]` | ngrok 免费静态域名，不会变 |
| Hub Token | `[REDACTED:hub-token]` | 代码硬编码默认值 |
| Agent ID | `[REDACTED:machine]` | 本机 hostname |
| 插件端口 | `7848` | 本机完整 API |

### Step 1：验证 Hub 在线

```bash
curl -s --max-time 8 https://[REDACTED:hub-host]/api/health
```

期望：`{"status":"ok", ...}`。
失败 → 用户本机未开机或 ngrok 未启动，**通知用户**后停止。

### Step 2：通过 Hub exec-sync 验证命令执行

```bash
curl -s -X POST https://[REDACTED:hub-host]/api/exec-sync \
  -H "Authorization: Bearer [REDACTED:hub-token]" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"[REDACTED:machine]","cmd":"whoami"}'
```

期望返回 `desktop-get3dbc\administrator`。
返回 `unauthorized` → Hub token 被用户改过，请用户提供新 token。

### Step 3（可选）：发现 Bridge 公网 URL

> 仅当需要**不经 Hub 直连**时执行。Hub exec-sync 已足够完成所有操作。

```bash
curl -s -X POST https://[REDACTED:hub-host]/api/exec-sync \
  -H "Authorization: Bearer [REDACTED:hub-token]" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"[REDACTED:machine]","cmd":"powershell -NoProfile -Command \"Get-Content $env:USERPROFILE\\.dao\\cf-hub-conn.json -Raw\""}'
```

从返回 JSON 的 `result.stdout` 解析：
- `url` → Bridge trycloudflare 公网 URL
- `token` → Bridge Bearer token

验证 Bridge：
```bash
curl -s --max-time 8 -H "User-Agent: Mozilla/5.0" \
  -H "Authorization: Bearer <BRIDGE_TOKEN>" \
  -H "Content-Type: application/json" \
  -X POST <BRIDGE_URL>/api/exec-sync \
  -d '{"cmd":"whoami"}'
```

> trycloudflare 入口**必须带 `User-Agent`**，否则被拦截页挡住。

### Step 4（可选）：验证完整插件 API

经 Hub/Bridge exec-sync 中转访问本机 7848 端口的完整插件 API：

```bash
# 经 Hub 中转查插件状态
curl -s -X POST https://[REDACTED:hub-host]/api/exec-sync \
  -H "Authorization: Bearer [REDACTED:hub-token]" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"[REDACTED:machine]","cmd":"curl -s http://127.0.0.1:7848/api/ping"}'
```

期望：`{"ok":true,"service":"dao-devin-export bridge"}`

> 注意：插件 7848 端口的 token 与 conn.json 中 Bridge 的 token **不同**。
> 如需调用需鉴权的插件接口（/api/status, /api/sessions 等），先经 exec-sync 读取 7848 的 token，
> 或让用户在 IDE 设置 `daoDevin.accessToken` 锁定为已知值。

---

## 三、持久化（存 Devin secret · 一次即永久）

发现完成后，保存为 Devin org 级 secret（同 org 所有未来会话自动注入）：

| Secret 名 | 值 | 说明 |
|---|---|---|
| `DAO_HUB_URL` | `https://[REDACTED:hub-host]` | Hub 固定地址 |
| `DAO_HUB_TOKEN` | `[REDACTED:hub-token]` | Hub Bearer token |

使用 `request_secret` 工具，设置 `should_save=true`，`save_scope="org"`。

> **跨 org 须知**：secret 绑定 org，切换 Devin 账户/org 后需重存。
> 但只要能读到本 skill（git 仓库跨账户不丢），重跑第二节 < 30 秒即可恢复。

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
  -d '{"agent_id":"[REDACTED:machine]","cmd":"<你的命令>"}'
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
  -d '{"agent_id":"[REDACTED:machine]","cmd":"powershell -NoProfile -Command \"Get-Content C:\\path\\to\\file -Raw\""}'

# 写文件
curl -s -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"[REDACTED:machine]","cmd":"powershell -NoProfile -Command \"Set-Content -Path C:\\path\\to\\file -Value \\\"内容\\\"\""}'
```

### 4.3 插件完整 API（经中转）

完整插件 API 仅本机 7848 端口可达，需经 exec-sync 中转：

```bash
# 插件状态
curl -s -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"[REDACTED:machine]","cmd":"curl -s http://127.0.0.1:7848/api/ping"}'
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
  -d '{"agent_id":"[REDACTED:machine]","cmd":"powershell -NoProfile -EncodedCommand <base64脚本>"}'
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
| Bridge URL 失效 | IDE 重启 trycloudflare 变了 | 重跑 Step 3 重新发现 |
| Secret 不存在 | 切了账户/org | 重跑第二节存 secret |
| 插件 API 返回 `invalid token` | 插件 token 与 Hub/Bridge token 不同 | 经 exec-sync 读插件 token 或锁定 `daoDevin.accessToken` |

---

## 六、安全约定

- **默认只读 / 非破坏性操作**
- 未经用户明确授权，**不执行**：删除文件、停止/重启服务、写文件、关机/重启、改系统配置
- Hub token 是本地默认值，非生产密钥；如需加固，用户可设环境变量 `PS_AGENT_MASTER_TOKEN` 覆盖
- 不在 git 提交真实 token；本文件中的 `[REDACTED:hub-token]` 是代码硬编码的公开默认值

---

## 附录：基础设施参考

详细的 ngrok 配置、Windows 路径、启动脚本、从零部署说明见：
`docs/cf-daohub-fixed-url.md`（本仓库，面向管理员的基础设施手册）
