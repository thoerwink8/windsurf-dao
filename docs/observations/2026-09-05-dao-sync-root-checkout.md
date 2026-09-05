# 机制巡检观察：dao-sync 以 root 执行可写 checkout 脚本

## 时间

2026-09-05 14:46（Asia/Shanghai）。

## 结论

发现一条新的服务器安全控制问题：`dao-sync.service` 未设置 `User=`，systemd 默认以 root 执行 `/home/orca/windsurf-dao/scripts/server-sync.sh`；而部署文档推荐该 checkout 由 `orca` 用户持有并可写。能够写入仓库的 agent 或进程可修改同步脚本，等待定时器触发后获得 root 权限。

## 证据

- `host/machine/systemd/dao-sync.service:16-18` 定义 `Type=oneshot`，没有 `User=`，并直接 `ExecStart=/bin/bash /home/orca/windsurf-dao/scripts/server-sync.sh`。
- `scripts/server-sync.sh:4-9` 明确说明 timer 以 root 运行，脚本随后用 `sudo -u orca` 执行 git，但第 25 行仍可调用 root 身份的 `systemctl try-restart`；脚本本身位于被执行的 checkout 内。
- `NEW-MACHINE.md:301-303` 推荐以 `orca` 用户 clone `/home/orca/windsurf-dao`，因此仓库脚本通常处于 `orca` 可写边界内。

## 复现步骤

1. 按 `NEW-MACHINE.md` 以 `orca` 用户取得 `/home/orca/windsurf-dao`。
2. 以 `orca` 修改 `scripts/server-sync.sh`，加入一个仅 root 可执行的命令（例如写入受保护目录或调用 `systemctl`）。
3. 执行 `sudo systemctl start dao-sync.service`，或等待 `dao-sync.timer` 触发。
4. 观察 systemd 以 root 解释 checkout 中被修改的脚本，新增命令获得 root 权限。

## 影响

- 任意能写服务器 checkout 的 agent、插件或本地进程可借同步定时器提权。
- 提权后可读取密钥、修改 systemd 单元、重启或篡改其他服务，突破 agent 与服务器控制面的安全边界。
- 现有“git 动作以 orca 身份执行”的注释只约束 git 子命令，不能约束被 root shell 解释的脚本内容。

## 建议

1. root 单元只执行 root-owned、不可由 `orca` 写入的固定 wrapper；wrapper 再以 `User=orca` 或显式降权方式运行同步逻辑。
2. 需要重启机器人的动作单独拆成最小化 sudoers 规则，仅允许固定的 `systemctl try-restart feishu-triage`，不要让 root 解释可变 checkout 脚本。
3. 为单元加 `User=`、`NoNewPrivileges=`、受限 `ReadWritePaths=` 等边界，并在部署时核对脚本/目录所有权。

## 验收方式

- `orca` 可以更新仓库并完成非特权同步，但修改 checkout 脚本不能影响任何 root 命令。
- `systemd-analyze security dao-sync.service` 与 journal 审计显示服务不再直接以 root 解释可写 checkout；机器人代码变更仍能按需重启。
- 用恶意脚本夹具触发 service 时，受保护文件、systemd 配置和其他服务状态均不发生变化；正常快进同步仍成功。

## 去重核对

已检索 `docs/observations/`、`docs/decisions/`、`NEW-MACHINE.md` 以及 `dao-sync`/`server-sync` 相关记录。未发现“root 定时单元直接执行 orca 可写仓库脚本”的既有观察；本问题也不同于会话活性、模型身份、resume 控制链和服务器漂移证据新鲜度问题。

## 上报

本文件即为已记录路径；本轮仅新增观察文档，未替帅位改代码、推送、部署或关闭会话。2026-09-05 14:54 通过 `list_sessions` 找到运行中的 `claude:80d8ab86-7e1a-4195-904b-94e76b88a873`，`send_session_message` 回执为**已送达**：消息已注入其当前 turn，将在下一个步骤读取（message id `sm-e838ed7ce97a4312`，one-way，不代表已读回复）。
