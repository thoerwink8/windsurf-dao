# 机制巡检：server-check 22 项活体闸写了、装了、测了，机器上没人跑

## 结论

`scripts/server-check.mjs` 是这台机器上「已知失败形态」的活体闸（timer 死态、单元仓机不一致、root 属主污染、腿表对账、撞限流探测在册……共 22 项）。装机文档把它写成「调通期整晚侦测」的 `while` 循环，落地之后没有转成 timer、没有 cron、没有进程、输出目录从来没建过。闸在仓里绿着，机器上等于没装。

## 证据

### 1. 装机文档只给了调通期手搓循环，没有常驻单元

`NEW-MACHINE.md:349-353`（2026-09-06 本轮读到的原文）：

```
退出码三态，**没查成不许当通过**：`0` 全通 / `1` 有真红 / `2` 有没查成。调通期整晚侦测：

while :; do node scripts/server-check.mjs --json --out; sleep 300; done
# 落 ~/.dao/server-check/checks.jsonl（仓外，不会成为下一轮输入）
```

同文件把 orca-serve / dao-agent-stall / 指挥官 / 发布列车都写成 `sudo … install` + systemd。server-check 这一条停在「调通期 while」。

`host/machine/ignore.md:10` 把 `~/.dao/server-check` 登记成「运行时自建」——目录要有人跑 `--out` 才会出现。

### 2. 这台机器上它没在跑，输出目录不存在

本轮（2026-09-06 06:40 CST）实测：

```
$ ls /etc/systemd/system/*server-check* /etc/systemd/system/*check*.timer
ls: cannot access '/etc/systemd/system/*server-check*': No such file or directory
ls: cannot access '/etc/systemd/system/*check*.timer': No such file or directory

$ crontab -l
no crontab for orca

$ ls /home/orca/.dao/server-check
ls: cannot access '/home/orca/.dao/server-check': No such file or directory

$ grep -l 'server-check.mjs' /etc/systemd/system/*.service /etc/systemd/system/*.timer
(none)

$ pgrep -af 'scripts/server-check'
# 0 行（只有本巡检自己的 grep）
```

`/home/orca/.dao/` 里有 `commander/`、`provider-health.json`、`agent-stall-watch.json` 等运行时产物，独缺 `server-check/`。`--out` 落盘路径从未被创建过，不是「跑过又清掉」。

`scripts/server-sync.sh`、`scripts/commander.mjs`、`scripts/lib/commander-inventory.mjs`、`scripts/dao-check.mjs`、`scripts/onboard.mjs`、全部 `scripts/install-*.sh`、`host/machine/systemd/` 全文搜 `server-check.mjs`：**0 命中**（只有 `commander.mjs` 注释里写「供 server-check 一行引用」）。指挥官盘点 8 项（`commander-inventory.mjs:287-294`）不含这 22 格。

### 3. 闸本身在，测试也在，只是没有触发面

`scripts/server-check.mjs:1202-1229` 的 `CHECKS` 现有 22 项，含此前巡检点名过、处置里写「server-check ⑱ / ⑳ 会红」的那些：

- ⑮ 撞限流探测 timer 在册
- ⑱ 每个 dao timer 都有下一次 + OnCalendar
- ⑳ 仓里的 systemd 单元与机器上装着的一致
- (21) 家目录没有 root 属主文件
- (22) mirasim 侧实跑腿与选型腿表对得上

`tests/server-check.test.js`、`tests/timer-armed.test.js` 守的是这些函数的判别力，CI / `dao-check` 跑的是夹具，不是这台机器上的 `systemctl`。

落地清单 `docs/decisions/SERVER-LANDING-CHECKLIST.md:279` 记「2026-09-05：server-check 第一次全绿（20 通 / 0 红 / 0 没查成）」——那是调通期有人跑了一遍。本轮目录不存在，说明那一次没有 `--out`，之后也没有循环接上。

本轮没跑完整 `node scripts/server-check.mjs`（没验证此刻 22 项打出来是红是绿）。本条不依赖那一格：依赖的是「没有触发面」。

### 4. 不是已经报过的那几条

已有观察里，`2026-09-05-systemd单元仓改未装.md` 管的是「仓改了单元、机器没装、⑱⑳ 仍绿」；`2026-09-05-stall单元failed闸仍绿.md` 管的是 ⑮ 的判据盲区；`2026-09-05-gw-remote-probe单调时钟.md` 管的是扫描面按名字圈定。它们都默认 server-check **有人在跑**，所以才讨论它绿不绿。本条是更底下一层：那 22 项在这台机器上根本没有心跳。

## 建议的最小改造

删掉「调通期手搓 `while` 循环 = 落地后还在看」这一层。

要么给 server-check 配一个和指挥官盘点同级的 oneshot timer（退出码 1/2 进 `--failed`，扫不到上一轮也红），要么让已经在跑的 `commander-inventory` 直接调它、红项走现有开单通道。扫描面扫出 0 次运行（输出目录不存在、timer 不在册）必须红，不能靠人想起才跑。
