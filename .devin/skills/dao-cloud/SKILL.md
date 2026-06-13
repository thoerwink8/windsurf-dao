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
Hub 是门（机器级），Bridge 是路（IDE 级）。
不硬编码动态值，不手动要 token。
所有 exec-sync 调用必须带 --max-time（防止队列阻塞）。
能通过命令解决的问题，Agent 自己解决，不问用户。
缺失信息时：提示用户提供一次 → 持久化 → 永不再问。
```

---

## 〇、架构总览

```
                    ┌─ ngrok 固定域名（永不变）──────────────┐
                    │  encircle-wasting-paging.ngrok-free.dev │
                    └──────────────┬─────────────────────────┘
                                   ↓
┌─ Logan (DESKTOP-GET3DBC) ────────────────────────────────────┐
│                                                               │
│  DAO Hub (ps_agent_server.py)   Plugin (dao-devin-export)    │
│  port 9910                      port 7848 (完整API)           │
│  token: dao-hub\token.txt       token: 见插件配置             │
│  role: machine-control          role: ide-bridge              │
│  ─ 常驻，IDE 没开也在           ─ 随 IDE 启停                  │
│                                                               │
│  DAO Bridge (dao.dao-bridge 扩展, exec-sync 网关)              │
│  port: daoBridge.localPort (已锁定)                             │
│  token: daoBridge.accessToken (已锁定,重启不变)                  │
│  tunnel: *.trycloudflare.com (动态URL)                         │
│  role: ide-bridge                                              │
│  ─ 随 IDE 启停                                                 │
└───────────────────────────────────────────────────────────────┘
```

**两条通道及角色：**

| 通道 | 角色 | 入口 | 能力 | 可用性 |
|---|---|---|---|---|
| **Hub（主）** | machine-control | ngrok 固定 URL | exec-sync（万能）| 常驻，IDE 关了也在 |
| **Bridge（辅）** | ide-bridge | trycloudflare 动态 URL | exec-sync | IDE 开着时 |

> **优先级规则：Hub 优先，Bridge 备用。** 需要机器级能力（shell/file/screenshot/multi-agent）时用 Hub；需要 IDE/workspace/plugin 能力时可用 Bridge。

> 完整插件 API（sessions/export/account）仅监听本机 7848，从远端需经 Hub/Bridge exec-sync 中转调用。

---

## 〇.一、全自动规范（核心行为准则）

**任何遵循本 skill 的 Agent 必须严格遵守以下规则：**

### 自主解决原则

1. **能通过命令解决的问题，自己解决。** 例如：队列阻塞 → 自己发 taskkill；进程挂了 → 自己重启；token 过期 → 自己通过文件发现。绝不让用户手动操作。
2. **所有经 exec-sync 中转的 curl/命令必须带超时。** Hub 直连用 `--max-time 10`，嵌套调用（exec-sync 里再发 curl）也要内层 `--max-time`。
3. **发命令前检查队列健康。** 先 `GET /api/agents` 看 `pending_commands`，>0 则等待或先清理。
4. **不发可能阻塞的命令。** 禁止：无超时的 curl、等待用户输入的交互程序、前台阻塞的 GUI 进程。

### 缺失信息时的处理流程

当 Agent 遇到缺失信息（token/URL/配置/权限）：

```
1. 先自己尝试自动发现（按"自动发现优先级"逐步试）
2. 全部失败 → 提示用户，给出具体命令让用户运行
3. 用户提供结果 → Agent 一步到位持久化：
   a. 存入 Devin org secret（跨会话可用）
   b. 更新知识库 knowledge note
   c. 如果合适，写回本机发现文件（如 dao-hub\token.txt）
4. 永不再问第二次
```

### 队列阻塞自恢复

```
检测：pending_commands > 0 持续超过 60 秒
恢复步骤：
1. 尝试等待（命令可能正在执行，给 30 秒）
2. 仍然阻塞 → 通过 Hub 发 taskkill：
   curl --max-time 10 -X POST $HUB/api/exec-sync \
     -d '{"cmd":"taskkill /F /IM curl.exe & taskkill /F /IM powershell.exe /FI \"WINDOWTITLE ne Administrator*\""}'
3. 如果 Hub 本身阻塞（新命令也排队）→ 切换到 Bridge 通道
4. Bridge 也不可用 → 通知用户重启 Hub agent
```

### Token 变更后的同步规则

```
任何 Agent 修改了 Hub token 后，必须：
1. 写回本机：C:\Users\Administrator\.dao\dao-hub\token.txt
2. 同步 Devin org secret：DAO_HUB_TOKEN
3. 更新知识库 note（如需要）
同理，Hub URL 变更后写回 dao-hub\conn.json + endpoints.json + org secret DAO_HUB_URL。
```

---

## 一、快速通道（有 secret 时 · 10 秒）

检查环境变量 `DAO_HUB_URL` 和 `DAO_HUB_TOKEN` 是否存在：

```bash
# DAO_HUB_URL 应为 ngrok 固定地址
curl -s --max-time 8 "$DAO_HUB_URL/api/health"
```

返回含 `"status": "ok"` → Hub 在线。直接用 Hub exec-sync 做任何事：

```bash
curl -s --max-time 15 -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"whoami"}'
```

成功 → **跳到第四节**。
失败 / secret 不存在 → 进入第二节。

---

## 二、自动发现（无 secret · 30 秒）

### 自动发现优先级（严格按顺序）

```
1. 先读本机文件（经 Hub health 验证后）：
   C:\Users\Administrator\.dao\dao-hub\conn.json + token_file
2. 再读统一注册表：
   C:\Users\Administrator\.dao\endpoints.json 中 role=machine-control 的 endpoint
3. 再试环境变量：
   DAO_HUB_URL / DAO_HUB_TOKEN
4. 最后 fallback：
   C:\Users\Administrator\.dao\dao-bridge\conn.json 或 legacy cf-hub-conn.json
```

### 常量（稳定值，安全写在此处）

| 项 | 值 | 说明 |
|---|---|---|
| Hub URL | `https://encircle-wasting-paging.ngrok-free.dev` | ngrok 免费静态域名，不会变 |
| Hub Token 真相源 | `C:\Users\Administrator\.dao\dao-hub\token.txt` | 本机文件，始终以此为准 |
| Hub Token（当前） | 存于 Devin org secret `DAO_HUB_TOKEN` | 随本机文件同步 |
| Agent ID | `DESKTOP-GET3DBC` | 本机 hostname |
| 插件端口 | `7848` | 本机完整 API |
| IDE 路径 | `D:\Windsurf\Devin.exe` | Devin Desktop 可执行文件 |
| Hub 代码仓库 | `https://github.com/thoerwink8/dao-hub` (private) | Hub 源码 |

### ⚠️ 重要：配置文件职责划分

| 文件 | 归属 | 内容 |
|---|---|---|
| `~\.dao\dao-hub\conn.json` | **DAO Hub 专用** | Hub URL + 连接信息 |
| `~\.dao\dao-hub\token.txt` | **DAO Hub 专用** | Hub master token（唯一真相源）|
| `~\.dao\endpoints.json` | **统一注册表** | 所有 endpoint 的 role/url/token_file |
| `~\.dao\cf-hub-conn.json` | **Legacy / DAO Bridge fallback** | ⚠️ 不要当 Hub 真相源！|
| `~\.dao\dao-bridge\conn.json` | **DAO Bridge 专用** | Bridge URL + token |

> **`cf-hub-conn.json` 现在只能视为 legacy / DAO Bridge fallback。** DAO Hub 的真相源已迁移到 `dao-hub\conn.json` + `dao-hub\token.txt`。

### Step 1：验证 Hub 在线

```bash
curl -s --max-time 8 https://encircle-wasting-paging.ngrok-free.dev/api/health
```

期望：`{"status":"ok", ...}`。
失败 → 用户本机未开机或 ngrok 未启动，**通知用户**后停止。

### Step 2：通过 Hub exec-sync 验证命令执行

先尝试 org secret 中的 token：

```bash
curl -s --max-time 15 -X POST https://encircle-wasting-paging.ngrok-free.dev/api/exec-sync \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"whoami"}'
```

如果 `DAO_HUB_TOKEN` 不存在或返回 `unauthorized`，**自动发现 token**：

```bash
# 通过 Hub /api/agents（无需 exec 权限）获取 agent 列表确认在线
curl -s --max-time 8 https://encircle-wasting-paging.ngrok-free.dev/api/agents

# 如果上面也需要认证，尝试读取本机 token 文件（需要已有某种通道）
# 如果有 Bridge 可用，经 Bridge 读取：
curl -s --max-time 10 -H "User-Agent: Mozilla/5.0" \
  -H "Authorization: Bearer <BRIDGE_TOKEN>" \
  -X POST <BRIDGE_URL>/api/exec-sync \
  -d '{"cmd":"type C:\\Users\\Administrator\\.dao\\dao-hub\\token.txt"}'
```

如果所有自动方式失败，提示用户：
```
请在本机运行以下命令并把结果贴给我：
type C:\Users\Administrator\.dao\dao-hub\token.txt
```
拿到后立刻持久化（org secret + knowledge note）。

### Step 3：检查 IDE / 插件是否在运行

```bash
curl -s --max-time 15 -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"curl -s --max-time 3 http://127.0.0.1:7848/api/ping"}'
```

期望 stdout 含 `"ok":true`。

**如果插件没响应**（stdout 为空或 exit_code 非 0）→ IDE 未启动，执行 Step 3a。

#### Step 3a：通过 Hub 远程启动 IDE

```bash
curl -s --max-time 15 -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"start \"\" \"D:\\Windsurf\\Devin.exe\""}'
```

启动后**等待 15-30 秒**让 IDE 加载扩展，然后轮询插件就绪：

```bash
# 每 5 秒轮询一次，最多重试 6 次（30 秒）
curl -s --max-time 15 -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"curl -s --max-time 3 http://127.0.0.1:7848/api/ping"}'
```

返回 `{"ok":true,...}` → 插件就绪，继续。
超过 60 秒仍无响应 → 通知用户手动检查 IDE。

### Step 4（可选）：发现 Bridge 公网 URL

> 仅当 Hub 不可用、需要 **IDE/workspace 能力**、或作为备用通道时执行。

```bash
curl -s --max-time 15 -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"powershell -NoProfile -Command \"if (Test-Path $env:USERPROFILE\\.dao\\dao-bridge\\conn.json) { Get-Content $env:USERPROFILE\\.dao\\dao-bridge\\conn.json -Raw } elseif (Test-Path $env:USERPROFILE\\.dao\\cf-hub-conn.json) { Get-Content $env:USERPROFILE\\.dao\\cf-hub-conn.json -Raw } else { Write-Output no-bridge-config }\""}'
```

从返回 JSON 的 `result.stdout` 解析：
- `url` → Bridge trycloudflare 公网 URL（**动态，不要存 secret**）
- `token` → Bridge Bearer token（已锁定，重启不变）

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
curl -s --max-time 15 -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"curl -s --max-time 5 http://127.0.0.1:7848/api/ping"}'
```

期望：`{"ok":true,"service":"dao-devin-export bridge"}`

> 注意：插件 7848 端口的 token 与 Hub/Bridge token **不同**。
> 本机有两个独立扩展：
> - `dao.dao-bridge`（exec-sync 网关，role: ide-bridge）
> - `dao-natural.dao-devin-export`（完整 API，端口 7848）
>
> 如需调用需鉴权的插件接口（/api/status, /api/sessions 等），先经 exec-sync 读取 7848 的 token。

---

## 三、持久化（一次即永久 · 含自动 Knowledge Note）

发现完成后，执行以下两步持久化：

### 3.1 保存 Org Secret

保存为 Devin org 级 secret（同 org 所有未来会话自动注入）：

| Secret 名 | 值来源 | 说明 |
|---|---|---|
| `DAO_HUB_URL` | `https://encircle-wasting-paging.ngrok-free.dev` | Hub 固定地址（不会变）|
| `DAO_HUB_TOKEN` | `~\.dao\dao-hub\token.txt` 的内容 | Hub master token |

使用 `request_secret` 工具，设置 `should_save=true`，`save_scope="org"`。

> **Token 变更同步规则：** Hub token 变更后必须同步写回 `dao-hub\token.txt`，并同步到 Devin org secret `DAO_HUB_TOKEN`。Hub URL 变更后必须同步写回 `dao-hub\conn.json` / `endpoints.json`，并同步到 org secret `DAO_HUB_URL`。

### 3.2 自动创建 Repo Knowledge Note（关键）

连接成功后，**必须检查并创建 repo-pinned knowledge note**，确保未来会话自动触发连接：

使用 `suggest_knowledge` 工具：

```
trigger: "When working on the windsurf-dao repository (github.com/thoerwink8/windsurf-dao)"
value: 本仓库用户的本机桌面（Logan / DESKTOP-GET3DBC）可通过 dao-cloud skill 远程接入。
      1. 读取 .devin/skills/dao-cloud/SKILL.md
      2. 按 skill 中自动发现流程连接（Hub 优先，Bridge 备用）
      3. Hub token 真相源：C:\Users\Administrator\.dao\dao-hub\token.txt
      4. 配置文件职责：dao-hub\conn.json = Hub，cf-hub-conn.json = legacy Bridge
      5. endpoints.json = 统一注册表
      所有常量已写在 skill 文件中，org secret DAO_HUB_TOKEN/DAO_HUB_URL 已持久化。
```

> **执行前先检查**：`list_knowledge_notes` 查看是否已存在同名 note。已存在则 update，避免重复。

> **为什么必须做这步**：Knowledge note 绑定 Devin org，切账号后会丢。
> 但只要用户说一句"读 dao-cloud skill 连本机"触发本流程，这步会自动重建 note，
> 之后同 org 所有新会话（只要勾选 windsurf-dao 仓库）都自动连接，无需再手动说。

> **Bridge URL/Token 不存 secret**：trycloudflare URL 每次 IDE 重启会变，
> 存了也会过期。需要时实时经 Hub exec-sync 发现即可。

---

## 四、使用指南

### 4.1 执行命令（最常用）

```bash
# 通过 Hub exec-sync（必须带 --max-time）
curl -s --max-time 15 -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"<你的命令>"}'
```

**⚠️ 超时与防阻塞规则（必须遵守）：**
- 外层 curl 必须带 `--max-time 15`（或更短）
- 内层嵌套 curl 必须带 `--max-time`（如 `curl -s --max-time 5 ...`）
- 禁止发无超时请求！一个无超时的命令会阻塞整个队列
- 发命令前检查 `pending_commands`（`GET /api/agents`），>0 则等待

**注意：**
- 字段名是 `cmd`，**不是** `command`（用错会静默无输出）
- 默认 cmd.exe 执行；要 PowerShell：`powershell -NoProfile -Command "..."`
- Hub 一次只跑一条命令，前一条卡住会堵队列
- 长任务用 `Start-Process ... -WindowStyle Hidden` 后台拉起再轮询
- 别发前台阻塞 / 等待输入的命令

### 4.2 读写文件

```bash
# 读文件
curl -s --max-time 15 -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"powershell -NoProfile -Command \"Get-Content C:\\path\\to\\file -Raw\""}'

# 写文件
curl -s --max-time 15 -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"powershell -NoProfile -Command \"Set-Content -Path C:\\path\\to\\file -Value \\\"内容\\\"\""}'
```

### 4.3 插件完整 API（经中转）

完整插件 API 仅本机 7848 端口可达，需经 exec-sync 中转：

```bash
# 插件状态
curl -s --max-time 15 -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"curl -s --max-time 5 http://127.0.0.1:7848/api/ping"}'
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
curl -s --max-time 30 -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"powershell -NoProfile -EncodedCommand <base64脚本>"}'
```

- 截屏：`System.Drawing` 截 `VirtualScreen` → PNG → base64
- 输入：`SetCursorPos` + `mouse_event` 点击、`SendKeys` 键入
- 复杂脚本用 `-EncodedCommand` 传，避免 inline 被截断

---

## 五、故障排查

| 现象 | 原因 | 自动处理（Agent 自己做）|
|---|---|---|
| Hub health 超时 | 本机未开机 / ngrok 未启动 | 尝试 Bridge 通道；都不通则通知用户 |
| Hub 返回 `unauthorized` | Token 变了 | 自动发现：经 Bridge 读 `dao-hub\token.txt`；失败则提示用户运行 `type` 命令 |
| exec-sync 超时 / pending>0 | 前一条命令卡住堵队列 | 等 30s → 发 `taskkill /F /IM curl.exe` → 仍阻塞则切 Bridge |
| 插件 ping 无响应 | IDE 未启动 | 执行 Step 3a 远程启动 IDE，轮询等待就绪 |
| 启动 IDE 后仍无响应 | 扩展未安装/崩溃 | 通知用户手动检查 IDE 扩展状态 |
| Bridge URL 失效 | IDE 重启 trycloudflare 变了 | 重跑 Step 4 重新发现（动态值不缓存）|
| Secret 不存在 | 切了账户/org | 重跑第二节 → 发现 → 存 secret |
| 插件 API 返回 `invalid token` | 插件 token 与 Hub token 不同 | 经 exec-sync 读插件 token |
| Agent offline (`agents_online: 0`) | Hub 进程在但 agent 未注册 | 经 Hub 或 Bridge 重启 agent：`py -3 D:\frank\dao-hub\cf_cloud_agent.py --auto` |
| 中文编码崩溃 (`NoneType not subscriptable`) | agent 处理含中文 stdout 崩溃 | 已修复于 dao-2.1-encoding；如复现，重启 agent |

---

## 六、安全约定

- **默认只读 / 非破坏性操作**
- 未经用户明确授权，**不执行**：删除文件、停止/重启服务、写文件、关机/重启、改系统配置
- Hub token 存于本机文件，不硬编码到 git；skill 中只引用路径和 secret 变量名
- 不在 git 提交真实 token；本文件只描述发现流程
- 自动恢复操作（taskkill 清理阻塞）属于非破坏性，可自主执行

---

## 七、多通道容灾流程

```
┌─ 尝试 Hub ─────────────────────────────────────────┐
│ 1. curl --max-time 8 $HUB_URL/api/health           │
│ 2. 成功 → 用 Hub exec-sync                         │
│ 3. 失败（超时/502/无响应）→ 转 Bridge               │
└───────────────────────────────────────────────┬─────┘
                                                ↓
┌─ 尝试 Bridge ─────────────────────────────────────┐
│ 1. 读取 Bridge URL（从 bs.json 或 dao-bridge\conn）│
│ 2. curl --max-time 8 $BRIDGE_URL/api/health        │
│ 3. 成功 → 用 Bridge exec-sync                      │
│ 4. 失败 → 两条通道都不可用                          │
└───────────────────────────────────────────────┬─────┘
                                                ↓
┌─ 双通道不可用 ────────────────────────────────────┐
│ 通知用户：本机可能未开机或网络异常                   │
│ 提供具体排查建议（开机 / 检查 ngrok / 检查 IDE）    │
└───────────────────────────────────────────────────┘
```

---

## 附录：基础设施参考

- Hub 代码仓库：`https://github.com/thoerwink8/dao-hub`（private）
- 详细的 ngrok 配置、Windows 路径、启动脚本、从零部署说明见：`docs/cf-daohub-fixed-url.md`（本仓库）
- Hub agent 启动：`py -3 D:\frank\dao-hub\cf_cloud_agent.py --auto`
- Hub server 启动：`py -3 D:\frank\dao-hub\ps_agent_server.py --host 127.0.0.1 --port 9910`
- Agent 版本：`dao-2.1-encoding`（已修复中文编码问题）
