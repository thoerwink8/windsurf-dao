# dao-cloud · 连接速查（CONNECT）

> 这是 `SKILL.md` 的精简连接速查表，放在仓库里作为「换账号也不丢」的持久化备份。
> 完整说明以同目录 `SKILL.md` 为准。

## 一句话

用户本机桌面 **Logan / `DESKTOP-GET3DBC`**（Windows 11）通过 **DAO Hub** 远程接入；
连接所需的全部常量都在本文件 + `SKILL.md` 里，token 已存为 Devin org secret。

> 触发词：用户说"连接本机/连本机/接入桌面/连 Logan"，或"读 dao-cloud / dao-cloud / dao cloud" → 读 `SKILL.md` 走连接流程。

## 常量（稳定值）

| 项 | 值 |
|---|---|
| Hub URL（固定，不会变） | `https://encircle-wasting-paging.ngrok-free.dev` |
| Agent ID | `DESKTOP-GET3DBC` |
| Hub token —— org secret | `DAO_HUB_TOKEN` |
| Hub token 真相源（本机文件） | `C:\Users\Administrator\.dao\dao-hub\token.txt` |
| 本机 devin-byok 路径 | `D:\frank\devin-byok` |
| 插件完整 API 端口（本机） | `7848` |

> ⚠️ 旧默认 token `dao-ps-agent-2026` **已失效**（token 被轮换过）。以 `DAO_HUB_TOKEN` / 本机 `token.txt` 为准。

## 三步连上

```bash
# 1) Hub 在线？（期望 {"status":"ok",...}）
curl -s --max-time 8 https://encircle-wasting-paging.ngrok-free.dev/api/health

# 2) 执行命令（字段名是 cmd，不是 command；必须带 --max-time 防队列阻塞）
curl -s --max-time 15 -X POST "$DAO_HUB_URL/api/exec-sync" \
  -H "Authorization: Bearer $DAO_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"DESKTOP-GET3DBC","cmd":"whoami"}'

# 3) 发命令前先看队列健康（pending_commands > 0 就先等/清理）
curl -s --max-time 10 "$DAO_HUB_URL/api/agents" -H "Authorization: Bearer $DAO_HUB_TOKEN"
```

默认 `cmd.exe`；要 PowerShell 用 `powershell -NoProfile -Command "..."`。

## 防阻塞铁律

- 外层与内层（嵌套）curl 都必须带 `--max-time`，**禁止无超时请求**——一条卡住会堵整个队列。
- `git status` 在大工作区很慢，优先用定向命令：`git diff --name-status HEAD`、`git log @{u}..`。
- 队列卡死（`pending_commands` 长时间 > 0）：经 Hub 发 `taskkill /F /IM git.exe`（或对应进程）清理；Hub 自身堵了再切 Bridge 通道（见 `SKILL.md`）。

## 新账号 / 新 org 首次接入

1. 读本文件 + `SKILL.md`。
2. 若 `DAO_HUB_TOKEN` 缺失或 `unauthorized`：让用户本机运行 `type C:\Users\Administrator\.dao\dao-hub\token.txt`，把那一行原文存为 Devin org secret `DAO_HUB_TOKEN`（不要带引号 / `Bearer ` 前缀 / 换行）。
3. 持久化：org secret `DAO_HUB_TOKEN`（+ 可选 `DAO_HUB_URL`），并尽量在 org 知识库建一条「连本机」note（按 `SKILL.md` §3.2）。知识库 note 绑 org、换账号会丢——本文件就是它的仓库级兜底。

## 相关仓库的纪律

- **devin-byok**（`github.com/thoerwink8/devin-byok`）：功能性代码变更必须 bump `package.json` `version` + 在 `docs/evolution/evolution-entries.csv` 追加一行 + commit message 带 `(vX.Y.Z)` 后缀；PR 的 version 必须高于目标分支，否则 `version-check` CI 拒绝合并。首次克隆跑 `npm install` 装 git hooks（`core.hooksPath scripts/hooks`）。
