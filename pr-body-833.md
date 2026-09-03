目标：把「撞限流/卡死」探测从本机 watchdog 搬到服务器定时面，补 429 指纹，接回自动换人，落地即删 Contabo 垫片 timer。署名 issue #833，关单交给 `scripts/close-issues.mjs`。

验收标准：
- 服务器上探测由定时面拉起（`systemctl list-timers` 能看到 `dao-agent-stall.timer`）
- 判别性实验①：今天这段 429 屏面报、正常工作屏面不报
- 判别性实验②：探到审官撞限流后真换人（或报帅停手），两者必居其一
- 审官选型序走完时报帅停手，不自动降级同厂
- Contabo 垫片 `/home/orca/bin/agent-stall-watch.mjs` 与 timer 已删
- `node scripts/dao-check.mjs` 绿、相关测试绿

进展：
- 判据抽到 `scripts/lib/agent-stall-detect.mjs`；CLI `scripts/agent-stall-watch.mjs` 一条命令两处用
- systemd 单元 `host/machine/systemd/dao-agent-stall.{service,timer}`，15 分钟 + 连红 2 轮
- 指纹补 `exceeded retry limit` / `429`（watchdog 表同步补，#807 删常驻前本机也能认）
- 换人走既有 `planCapacitySwitch`（跳过工人那一厂）；走完报帅停手，不降级同厂
- `server-check` ⑮ 另起一项（不改 #829 automations 行；⑭ 是指挥官自检）：正式 timer 不在 / 垫片还在 = 红
- 夹具：`tests/agent-stall-watch.test.js`（改之前不报、改之后报；假 orca 两轮换人；grok 工人序走完报帅不调换人钩子）
- `node scripts/dao-check.mjs` 绿（106 通 / 7 跳过）
- **欠账（没查成）**：工人无 sudo，`dao-agent-stall.timer` 还没装上，垫片 `agent-stall-watch.timer` 仍在 `/etc/systemd/system/`。装法：`sudo bash scripts/install-agent-stall-watch.sh`
