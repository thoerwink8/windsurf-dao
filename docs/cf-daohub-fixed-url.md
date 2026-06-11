# CF-DaoHub 永久固定 URL（ngrok）—— 部署与运维

本机（DESKTOP-GET3DBC）通过 ngrok 把 CF-DaoHub 暴露成一个**永久固定的公网地址**，并在登录时自启。
解决的问题：以前用 Cloudflare Quick Tunnel，URL 每次重启都变；现在固定不变，无需每次重发连接信息。

> ⚠️ **安全：本文档不含真实密钥。** 下文中的 `<DAO_HUB_TOKEN>` 与 ngrok authtoken 均为占位符。
> 真实值只保存在本机，不要提交到 git：
> - hub token：`C:\Users\Administrator\.dao\cf-hub-conn.json` 的 `token` 字段
> - ngrok authtoken：`%LOCALAPPDATA%\ngrok\ngrok.yml`（由 `ngrok.yml.template` 填充）

---

## 一、连接参数
- **固定 URL：** `https://encircle-wasting-paging.ngrok-free.dev`
- **Token：** `<DAO_HUB_TOKEN>`（请求头 `Authorization: Bearer <DAO_HUB_TOKEN>`）
- **Agent ID：** `DESKTOP-GET3DBC`
- **本机 hub 端口：** `9910`（ngrok 把固定域名转发到 `localhost:9910`）

---

## 二、仓库内文件
| 文件 | 说明 |
|---|---|
| `docs/cf-daohub-fixed-url.md` | 本文档 |
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
curl -s https://encircle-wasting-paging.ngrok-free.dev/api/health
```
取消开机自启：删除 Startup 里的 `ngrok-daohub.vbs`。

---

## 七、API 用法

> ⚠️ **执行命令的字段名是 `cmd`，不是 `command`。** 用 `command` 会返回成功但实际没执行、stdout 为空。

```bash
# 健康检查（无需鉴权）
curl -s https://encircle-wasting-paging.ngrok-free.dev/api/health

# 列出 agent
curl -s -H "Authorization: Bearer <DAO_HUB_TOKEN>" \
  https://encircle-wasting-paging.ngrok-free.dev/api/agents

# 同步执行命令
curl -s -X POST https://encircle-wasting-paging.ngrok-free.dev/api/exec-sync \
  -H "Authorization: Bearer <DAO_HUB_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"whoami"}'
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
