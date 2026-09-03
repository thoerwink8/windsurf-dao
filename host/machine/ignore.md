# 仓外路径忽略表

仓里出现、但不进 INDEX 的仓外路径。每条必须有 why。没有 why 的行闸会红。

| 路径 | why |
|---|---|
| process.env.HOME | 检查器读本机家目录变量，不是新品类；品类落在 ~/.claude / ~/.dao |
| os.homedir() | 代码 API 形态，不是新品类；join(homedir(), ...) 已收到 ~/.dao / ~/.pi |
| ~/.brand-new-cli | 回归夹具，故意不进 INDEX，只给闸验「漏写新家目录必须红」 |
| ~/AppData/Local/cursor-compile-cache | cursor shim 的 NODE_COMPILE_CACHE 缓存目录（跑 node.exe 的编译缓存，非产品配置，坏/空都会自建），仓内 shim（#648）声明它但不归类到产品路径 |
| ~/.dao/quickfix | quick-fix（#682）异步审官日志目录，运行时自建，非产品配置 |
| ~/.dao/server-check | server-check（NEW-MACHINE §9d）落盘目录，运行时自建，非产品配置；刻意在仓外——检查器的输出不许落进它自己会读的范围 |
| ~/.dao/commander | 服务器指挥官（#800）落盘目录：态势 situation-*.json / state.json / 报帅 body。运行时自建，非产品配置；与 ~/.dao/server-check 同性质，刻意在仓外（眼睛的输出不落进自己会读的范围） |
| ~/.agent-stall-watch.json | 撞死指纹垫片文件（#807/#833）：agent-stall-watch.mjs 写、指挥官（#800）只读消费。手工放的临时垫片，#833 撞限流探测正式落地时删——归 #833 退役，本仓不写装法 |
| ~/.dao/feishu-threads.json | 飞书适配器（#801）话题状态文件，运行时自建，非产品配置，可丢可重算 |
| ~/.bashrc | NEW-MACHINE §9d 只叫人往里加一行 PATH（~/.local/bin），本机 shell 配置，不拷不进 git，非 dao 品类 |
| ~/.profile | NEW-MACHINE §9d 记「Orca 终端不吃 login shell」的事实，本机 shell 配置，不拷不进 git，非 dao 品类 |
| ~/bin/agent-stall-watch.mjs | #833 退役的 Contabo 垫片路径（落地即删），不进 INDEX 不当产品落点；正式件是仓内 scripts/agent-stall-watch.mjs + host/machine/systemd/dao-agent-stall.* |
| ~/.dao/agent-stall-watch.json | #833 连红账本，运行时自建于仓外，可丢可重算 |
