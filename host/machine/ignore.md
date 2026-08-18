# 仓外路径忽略表

仓里出现、但不进 INDEX 的仓外路径。每条必须有 why。没有 why 的行闸会红。

| 路径 | why |
|---|---|
| process.env.HOME | 检查器读本机家目录变量，不是新品类；品类落在 ~/.claude / ~/.dao |
| os.homedir() | 代码 API 形态，不是新品类；join(homedir(), ...) 已收到 ~/.dao / ~/.pi |
| ~/.brand-new-cli | 回归夹具，故意不进 INDEX，只给闸验「漏写新家目录必须红」 |
