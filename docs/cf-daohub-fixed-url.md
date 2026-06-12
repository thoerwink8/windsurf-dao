# 远程接入本机：基础设施手册（管理员参考）

> ⚠️ **Agent 接入请读 skill**：Devin Agent 远程连接本机的操作流程已迁移到
> `.devin/skills/dao-cloud/SKILL.md`（dao-cloud 技能）。
> 本文件保留为**基础设施参考**——ngrok 配置、Windows 路径、启动脚本、从零部署说明。

> 本文档不含真实密钥。`<DAO_HUB_TOKEN>`、`<PLUGIN_TOKEN>` 与 ngrok authtoken 均为占位符。
> 真实值只保存在本机：
> - hub / 插件 token：`C:\Users\Administrator\.dao\cf-hub-conn.json` 的 `token` 字段
> - ngrok authtoken：`%LOCALAPPDATA%\ngrok\ngrok.yml`（由 `ngrok.yml.template` 填充）

---

## 〇、主通道：插件优先（DAO Bridge）

> 2026-06 决策：以 **DAO Bridge 插件**为主工作通道；下面的 ngrok+hub 作为**静默兜底 + 地址发现**保留，**不删不退役**。

### 为什么以插件为主
- 能力上插件 ≥ hub：全机 `exec`、工作区文件接口、PowerShell 截屏/GUI 操作均已实测可行；且**自描述**（自动写连接文件）、**随 IDE 自启**、cloudflared 隧道比 ngrok 免费版更稳。
- 唯一短板：插件只在 **Devin Desktop 开着时**在线。故保留 hub 当兜底，并可用 hub 在 IDE 没开时把它拉起来。

### 插件连接参数（动态，从本机自动发现，勿硬编码）
插件每次启动把当前连接信息写入两个文件（内容互为镜像）：
- `C:\Users\Administrator\.dao\cf-hub-conn.json`
- `C:\Users\Administrator\.dao\bridge\conn.json`

字段：`url`（公网入口）、`token`（Bearer）、`local_url` / `port`、`root`（IDE 工作区根，当前 `d:\frank\windsurf-dao`）、`host`。

- **URL**：quick 模式是 `*.trycloudflare.com`，**每次重启都会变** → 永远读上面文件里的 `url`，别硬编码。
- **Token**：复用 conn.json 里保存的值，**重启后稳定**；也可在 IDE 设置 `daoBridge.accessToken` 锁死。
- **API 契约**：与 hub **完全相同**（见第七节）。`/api/health` 免鉴权；`/api/exec-sync` 用 `cmd` 字段 + `Authorization: Bearer <token>`。
  - 注意：插件 `/api/ls /read /write` 被沙箱限制在工作区 `root`；要**全盘**读写，用 `/api/exec-sync` 跑 PowerShell 绕过。

### 标准接入流程（每次会话）
1. **经 hub 发现插件最新地址**（hub 常驻，IDE 没开它也在）：
   ```bash
   curl -s -X POST https://[REDACTED:hub-host]/api/exec-sync \
     -H "Authorization: Bearer <DAO_HUB_TOKEN>" -H "Content-Type: application/json" \
     -d '{"agent_id":"[REDACTED:machine]","cmd":"powershell -NoProfile -Command \"Get-Content $env:USERPROFILE\\.dao\\cf-hub-conn.json -Raw\""}'
   ```
2. 从返回里取 `url`+`token`，**直接连插件**：
   ```bash
   curl -s -X POST <PLUGIN_URL>/api/exec-sync \
     -H "Authorization: Bearer <PLUGIN_TOKEN>" -H "Content-Type: application/json" \
     -H "User-Agent: Mozilla/5.0" \
     -d '{"cmd":"powershell -NoProfile -Command \"whoami\""}'
   ```
   > trycloudflare 入口建议带 `User-Agent`，避免被拦插页。
3. **IDE 没开时**：先用 hub `Start-Process` 拉起 Devin Desktop → 轮询 conn.json 直到 `url` 刷新成 trycloudflare 地址，再走第 2 步。

### GUI / 截屏（操作软件、复现问题）
- 两条通道都**没有**原生鼠标/键盘/截屏，靠 PowerShell 脚本在 exec 通道补：
  - 截屏：`System.Drawing` 截 `VirtualScreen` 存 PNG → base64 回传。
  - 输入：`SetCursorPos`+`mouse_event` 点击、`SendKeys` 键入、滚轮、`AppActivate` 切焦点。
- 已实测：通过插件 exec 截到整屏（1920×1080）。复杂命令必须写成脚本文件经 `-EncodedCommand` 传，别拼长 inline（PSReadLine 会截断）。

### 彻底退役 hub 的前提（暂未做，需 Logan 拍板）
插件 quick 模式 URL 会变、发现它依赖读 conn.json；**退役 hub 前必须先给插件一个固定 URL**，否则冷启动连不进去：
- 路线 A：复用现有 ngrok 静态域名，转发到插件固定 `localPort`（$0，不需域名）。
- 路线 B：cloudflared 命名隧道（需自有 Cloudflare 域名，更稳、最终可彻底不要 ngrok）。

固定 URL 落定并验证稳定前，**保留 hub**。

---

## 一、连接参数（兜底通道：ngrok+hub）

> 本机（[REDACTED:machine]）通过 ngrok 把 CF-DaoHub 暴露成一个**永久固定的公网地址**，并在登录时自启。以前用 Cloudflare Quick Tunnel URL 每次重启都变，故用固定 ngrok 域名解决。现作为插件的兜底 + 地址发现通道保留。

- **固定 URL：** `https://[REDACTED:hub-host]`
- **Token：** `<DAO_HUB_TOKEN>`（请求头 `Authorization: Bearer <DAO_HUB_TOKEN>`）
- **Agent ID：** `[REDACTED:machine]`
- **本机 hub 端口：** `9910`（ngrok 把固定域名转发到 `localhost:9910`）

---

## 二、仓库内文件
| 文件 | 说明 |
|---|---|
| `docs/cf-daohub-fixed-url.md` | 本文档（基础设施参考） |
| `.devin/skills/dao-cloud/SKILL.md` | Agent 接入操作流程（dao-cloud 技能） |
| `scripts/ngrok/start-ngrok.ps1` | 启动脚本：杀掉旧 ngrok 并后台隐藏启动 |
| `scripts/ngrok/ngrok-daohub.vbs` | 开机自启入口（隐藏窗口调用上面的 ps1） |
| `scripts/ngrok/ngrok.yml.template` | ngrok 配置模板（authtoken 用占位符） |

## 三、本机实际路径（机器特定）
| 用途 | 路径 |
|---|---|
| ngrok 程序 | `C:\Users\Administrator\ngrok\ngrok.exe` |
| 启动脚本 | `C:\Users\Administrator\ngrok\start-ngrok.ps1` |
| 开机自启入口 | `…\Microsoft\Windows\Start Menu\Programs\Startup\ngrok-daohub.vbs` |
| ngrok 配置 | `%LOCALAPPDATA%\ngrok\ngrok.yml` |
| ngrok 日志 | `C:\Users\Administrator\ngrok\ngrok.log` |
| 旧 Cloudflare 兜底连接信息 | `C:\Users\Administrator\.dao\cf-hub-conn.json` |

---

## 四、自启原理
1. 登录 Windows → Startup 里的 `ngrok-daohub.vbs` 自动运行。
2. vbs 隐藏调用 `start-ngrok.ps1`。
3. 脚本先结束旧 ngrok，再用 `ngrok.yml` 后台启动，把固定域名连到本机 9910。

> 当前是「**用户登录后自启**」（非 Windows 服务，因远程 agent 未提权装服务被拒）。
> 影响：① 机器需开机并已登录；② ngrok 若中途崩溃，要到下次登录或手动跑脚本才恢复。

## 五、从零部署（换机/重装时）
1. 下载 ngrok 到 `C:\Users\Administrator\ngrok\`。
2. `ngrok config add-authtoken <YOUR_NGROK_AUTHTOKEN>`（或把 `ngrok.yml.template` 填好放到 `%LOCALAPPDATA%\ngrok\ngrok.yml`）。
3. 复制 `scripts/ngrok/start-ngrok.ps1` 到 `C:\Users\Administrator\ngrok\`。
4. 复制 `scripts/ngrok/ngrok-daohub.vbs` 到 Startup 文件夹。
5. 运行一次 ps1 验证（见下）。

---

## 六、常用操作

启动 / 重启：
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Administrator\ngrok\start-ngrok.ps1"
```
查看是否在跑：
```cmd
tasklist /fi "imagename eq ngrok.exe"
```
停止：
```powershell
Get-Process ngrok | Stop-Process -Force
```
验证地址是否通（任意联网设备）：
```bash
curl -s https://[REDACTED:hub-host]/api/health
```
取消开机自启：删除 Startup 里的 `ngrok-daohub.vbs`。

---

## 七、API 用法

> ⚠️ **执行命令的字段名是 `cmd`，不是 `command`。** 用 `command` 会返回成功但实际没执行、stdout 为空。

```bash
# 健康检查（无需鉴权）
curl -s https://[REDACTED:hub-host]/api/health

# 列出 agent
curl -s -H "Authorization: Bearer <DAO_HUB_TOKEN>" \
  https://[REDACTED:hub-host]/api/agents

# 同步执行命令
curl -s -X POST https://[REDACTED:hub-host]/api/exec-sync \
  -H "Authorization: Bearer <DAO_HUB_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"[REDACTED:machine]","cmd":"whoami"}'
```
返回：`{"status":"...","result":{"stdout":"...","stderr":"...","exit_code":0}}`
默认 cmd.exe 执行；要 PowerShell 时写 `powershell -NoProfile -Command "..."`。

> hub 一次只执行一条命令，前一条卡住会堵队列（`/api/agents` 的 `pending_commands` >0）。
> 别发前台阻塞/等待输入的命令；长任务用 `Start-Process ... -WindowStyle Hidden` 后台拉起再轮询。

---

## 八、故障排查
| 现象 | 处理 |
|---|---|
| `/api/health` 连不上 | 确认机器开机且已登录 → 跑启动脚本 → 看 `ngrok.log` |
| agent offline | 确认 hub（监听 9910）在运行 |
| 命令"成功"但无输出 | 是否误用了 `command` 字段，应为 `cmd` |
| 命令全部超时、pending>0 | 有命令卡住堵队列；等几分钟自动超时，或结束卡住进程 |
| 想换固定域名 | https://dashboard.ngrok.com/domains 领新域名，改 `ngrok.yml` 的 `url:` 再重启 |

## 九、安全约定
- 默认只读 / 非破坏性操作。
- 未经明确授权，不执行：删除文件、停止/重启服务、写文件、broadcast、关机/重启、改系统配置等。
