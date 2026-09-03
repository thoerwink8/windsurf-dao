目标：把「撞限流/卡死」探测从本机 watchdog 搬到服务器定时面，补 429 指纹，接回自动换人，落地即删 Contabo 垫片 timer。署名 issue #833，关单交给 `scripts/close-issues.mjs`。

验收标准：
- 服务器上探测由定时面拉起（`systemctl list-timers` 能看到 `dao-agent-stall.timer`）
- 判别性实验①：今天这段 429 屏面报、正常工作屏面不报
- 判别性实验②：探到审官撞限流后真换人（或报帅停手），两者必居其一
- 审官选型序走完时报帅停手，不自动降级同厂
- Contabo 垫片 `/home/orca/bin/agent-stall-watch.mjs` 与 timer 已删
- `node scripts/dao-check.mjs` 绿、相关测试绿

进展：
- 判据：`scripts/lib/agent-stall-detect.mjs`；CLI：`scripts/agent-stall-watch.mjs`（一条命令两处用）
- systemd：`host/machine/systemd/dao-agent-stall.{service,timer}`，15 分钟 + 连红 2 轮；安��：`sudo bash scripts/install-agent-stall-watch.sh`
- 指纹补 `exceeded retry limit` / `429`（watchdog 表同步补）
- 换人走 `planCapacitySwitch`（跳过工人那一厂）；走完报帅停手
- `server-check` ⑮ 另起一项（不改 #829 automations 行；⑭ 是指挥官自检）
- 夹具 `tests/agent-stall-watch.test.js` 绿；`node scripts/dao-check.mjs` 绿
- live ①：`term_fd909a60`（PR-#827 审官·gpt-5.6-sol）屏面仍是今天这段 429；连红 2 轮报 `exceeded retry limit`
- live ②：工人 grok-4.6 与剩余审官同厂 → **报帅停手**（不许降级同厂）。证据：`命中 exceeded retry limit → 报帅停手：选型序剩余 4 位全部与工人同厂，没法再换（不许降级同厂）`
- **欠账（没查成）**：工人无 sudo，`dao-agent-stall.timer` 未装，垫片 `agent-stall-watch.timer` 仍在 `/etc/systemd/system/`。合并后由有 sudo 的人跑安装脚本。
