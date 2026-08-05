# 凭据集中存放 · 细则正文（issue #135 第二步的设计档）

> **必经动作**：**你正要给某个项目接一条「程序怎么拿到密钥」的路之前 = Read 本文件**。
> 触发时刻很具体：你在写 `.env` 的加载代码、在改一个 `process.env.X` / `os.LookupEnv` 的取值链、
> 或者在给一个新项目决定「密钥放哪」。
>
> ⚠️ **投递面照直写：这份档没有机器触发器。** 「我正要接一条取密钥的路」那一刻不 Read 任何特定
> 文件，构造不出路径锚点。它和 `dao-docs-lookup.md` 同型 —— **纯文字兜底**，别把「写下来了」
> 读成「从此有人管了」。

## 一句话：这件事要治的是什么

**只要密钥和代码住在一起，「哪些文件是密钥」就只能靠猜** —— 而这个猜必然两头出错：
猜多了改坏在用的配置（已实测：devin-byok 的 `.env`），猜少了漏掉真凭据（已实测：某仓 9 个
值级候选只看得见 2 个）。

**密钥集中之后，位置本身就是标识，不需要猜。**

这是业界标准不是临时想法：SSH → `~/.ssh/` · AWS → `~/.aws/credentials` ·
Docker → `~/.docker/config.json` · gcloud → `~/.config/gcloud/`。**没有一个放在项目目录里。**

## 凭据根的形态

```
%USERPROFILE%\.dao-secrets\
  ├── .sops.yaml          加密规则（只含 age **公钥** —— 公钥泄露无害，它只能加密）
  ├── age\keys.txt        🔴 age **私钥**：全套东西里唯一不可再生的
  ├── _backup\<时间戳>\    迁移时的明文备份（回滚材料，确认无恙后自己删）
  └── <项目 slug>.env     各项目的加密凭据：**键名明文可见、值加密**
```

建它跑 `ccswitch/scripts/dao-secrets-init.ps1`，搬凭据跑 `dao-secrets-migrate.ps1`。
**两个脚本都由用户跑，不由 AI 跑**（凭据的事交用户经手，用户既定约束）。

### 为什么选 SOPS + age（用户 2026-08-05 拍板）

因为**「加密存放」和「能带走」这两件事，Windows 的原生方案一条都满足不了**：
凭据管理器 / DPAPI / keyring **没有一条支持跨机迁移**。而「换机器不用逐个找密钥」
是 issue #135 四个目标里的第 3 个。SOPS + age 是同时满足两者的那一个：
完全本地、免费、不需账号不需联网。

### 为什么是「一个项目一个文件」而不是「一个大文件 + `项目 :: 字段` 前缀」

侦察报告建议沿用 dao 自己 `common-secrets.json` 的 `<项目 slug> :: <字段路径>` 命名空间。
**这里刻意没照抄，理由是实的不是风格**：

- 一个项目一个文件时，**文件名就是命名空间** ⇒ 各项目的键名（`GITHUB_USER`、`DATABASE_URL`）
  **一个字都不用改** ⇒ 消费方代码零改动，`sops exec-env` 还能把它们**直接**喂进子进程环境。
- 合成一个大文件才需要 `::` 前缀，而那个前缀**反过来要求每个消费方都改读法** ——
  用一次改造成本换一个这里根本不存在的问题。

`common-secrets.json` 用 `::` 是因为它只有一个文件、且**它是恢复端不是读取端**（见下节）。

### 🔴 那「同一把 key 给好几个项目用」怎么办（2026-08-06 补 · 本方案原先的真空白）

上面那个取舍解的是「两个项目各有一个叫 `API_KEY` 的键」，**解不了「两个项目共用同一把 key」**：
一项目一文件的形态下，共享的那把只能**抄进 N 个文件** ⇒ 双份必漂移 ⇒ 轮换要改 N 处
⇒ **issue #135 的第 4 个目标（「说不清一共有几处」）在这一格原样复活。**

**这不是假想**：`config-sync/common-secrets.json` 里已经有 provider 的 API key，
而本批 P4 那份里有 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`、P1 那份里有 `MOUSSE_TEST_API_KEY`
——**键名不同，底下是不是同一把，本档不去比也不该去比**。但「同一把 key 服务多个项目」
这个形态在这台机器上**结构上已经存在**。

**形态：一份 `_shared.env` + 各项目自己那份，两层注入。**

```powershell
# 凭据根里：
#   _shared.env        跨项目共享的那几把
#   <slug>.env         项目专有的
```

🔴 **但直接嵌套写不通 —— 这一条是实测的，别照直觉写**（2026-08-06，真 sops 3.13.3 + 真 age，
PowerShell 与 cmd **两个 shell 各跑一遍，结论相同**，故不是某一个 shell 的转义问题）：

| 写法 | 结果 |
|---|---|
| `sops exec-env A.env "sops exec-env ""B.env"" ""node x.js"""`（内层带引号） | ❌ `error: missing file to decrypt`，exit 1 |
| `sops exec-env A.env "sops exec-env B.env node x.js"`（内层不带引号） | ❌ 外层跑起来了，**内层** `missing file to decrypt`，exit 1 |
| **命令串里只要含一个双引号**（哪怕跟嵌套无关，如 `node x.js a "b c"`） | ❌ 同样 `missing file to decrypt`，exit 1 |
| ✅ **内层那条命令住进一个 `.cmd` 包装脚本** | ✅ exit 0，两份的键都进了子进程环境 |

**病根是「命令串必须是一个参数，而把它变成一个参数要靠引号」这对矛盾**：
外层 `exec-env` 只收 2 个参数（文件 + 命令串），内层要成为**一个**参数就得加引号，
而**含引号的命令串本身就过不了外层那一关**。⇒ 两头堵死，除非把引号挪出命令串。

```powershell
# 可行形态：inner.cmd 里写内层那条，外层只喂一个不含引号的路径
#   inner.cmd:  sops exec-env "<凭据根>\<slug>.env" "<你的启动命令>"
sops exec-env "$env:USERPROFILE\.dao-secrets\_shared.env" "<绝对路径>\inner.cmd"
```

**实测到的语义**：键名撞车时 **内层（项目那份）覆盖外层（共享那份）** ——
这个方向是对的（项目专有值应当压过共享默认值），但它是**跑出来的，不是设计出来的**，
sops 没有文档承诺这个次序。

**边界照直写**：①只在 Windows + 真 sops 3.13.3 上跑过，其他平台没验；
②包装脚本这条路把「命令怎么起的」从命令行挪进了一个文件，**调试时要多看一个地方**；
③本批四处**没有一处真的需要共享**，所以这一节是**为下一次准备的，不是已经在用的**。

## 🔴 注入器：让运行中的进程读到值

**这是真正的设计点，不能靠抄现成。** dao 那份 `common-secrets.json` 卡住的地方正在这里 ——
它只在 restore 那一刻把值合并回 cc-switch，**没有任何让进程在运行时读到它的通道**。
把凭据加密存起来是容易的一半；难的一半是「加密之后程序还怎么拿到它」。

两条路，**都需要，因为它们服务的是两类结构不同的消费方**：

### 路 A · 环境变量注入（`sops exec-env`）

```powershell
# 这是 PowerShell 写法。cmd 里把 $env:USERPROFILE 换成 %USERPROFILE%——
# **第一个参数（文件路径）是由你敲命令的那个 shell 展开的**，不是由 sops 展开的，写错就找不到文件。
sops exec-env "$env:USERPROFILE\.dao-secrets\<slug>.env" "<你的启动命令>"
```

解密后的值**只进子进程的环境，不落盘**。

**适用**：读 `process.env` / `os.LookupEnv` / `os.environ` 的程序 —— 也就是绝大多数。

**代价 / 边界**：
- 值在子进程的环境块里，同机上有权限的进程可以读到（`Get-Process` 级别的窥探）。这是环境变量的固有属性，不是 SOPS 的缺陷。
- 命令是**一整个字符串**传进去的，引号规则要当心（见下面「Windows 硬事实」）。
- 🔴 **值不要用引号包起来，也别留首尾空格**（2026-08-05 实测）：`sops exec-env` 把值**原样**注入环境 —— 源文件里写 `K="abc"`，子进程拿到的就是**带引号的** `"abc"`；尾随空格同理保留。而**搬走之前**，消费方读的是它自己那个 trim + 去引号的解析器（`claimer.ts` 的 `parseEnvInto`、迁移脚本的 `Read-DotEnvMap`、mousse 的 `extract_env_value` 都是这么写的）。⇒ **恰恰是这条被推荐的路把消费方自己的解析器整个绕过去了**，两边不等价。sops 本身一个字节都不改（加解密后逐字节相同，LF/CRLF 两个 fixture 都验过），差别全在消费方那一侧。**失败长得像「密码错了」**，极难归因。迁移脚本现在会在第 1 节当场报个数（只报个数，不报是哪个键、更不报值）。
- **它救不了「程序坚持要读一个文件」那一类** —— 那是路 B。

### 路 B · 按需吐值（临时文件，用完即删）

```powershell
# 同上，PowerShell 写法；cmd 里换成 %USERPROFILE%
sops exec-file --no-fifo "$env:USERPROFILE\.dao-secrets\<slug>.env" "<命令，用 {} 代表临时文件路径>"
```

解密到一个临时文件，把路径替换进 `{}`，**子进程退出后文件即消失**。

**适用**：**结构上只认文件、又能接受「文件路径由外部告诉我」的消费方。**
⚠ **这两个条件是「与」不是「或」，而第二个才是它真正的接口**：`exec-file` 给你的是
**一个随机临时目录里的随机文件名**（实测形如 `%TEMP%\.sops<随机>\tmp-file<随机>`），
它靠把这个**路径**替换进 `{}` 交给你。**消费方若不接受路径，路 B 就接不上。**

🔴 **本批四处里没有一个走路 B。** 这里原先举的例子（mousse-cli）**是错的，已订正** ——
详见下面「各消费方的形态」表底下那段。留着路 B 是因为它是一类真实存在的通用能力，
不是因为这一批用得上它。

**代价 / 边界**：
- 明文在进程活着的这段时间**确实落在磁盘上**（临时目录）。比路 A 弱。
- 进程被强杀时临时文件可能残留。
- 🔴 **临时目录路径里有空格时，`{}` 会给出一个不存在的路径，而 sops 退出码仍然是 0**
  （2026-08-05 实测，**加引号也没用**）：`exec.go` 对 `{}` 做的是**纯文本替换、零转义**，
  随后整串交给 `cmd.exe /C`，而 Go 的参数转义把内层引号写成 `\"`、cmd 不认这个写法。
  本机 `%TEMP%` 是 8.3 短名（`C:\Users\ADMINI~1\...`）不含空格所以不发作，
  **用户名带空格的机器上路 B 会静默给错路径**。⇒ 用路 B 前先确认 `TMP`/`TEMP` 不含空格；
  `dao-secrets-init.ps1` 第 7 节会在检测到空格时当场提醒。
- **`--no-fifo` 在 Windows 上不是必须，但建议显式加**（见下节第 2 条 —— 原先这里写「不加会当场死」，**已证伪**）。

### 怎么选（判据一句话）

**要问两句，不是一句**（2026-08-05 订正 —— 原先只写了第一句，于是 mousse-cli 那一行判错了）：

1. **「入口是环境变量还是文件」** —— 答环境变量走 A。
2. 答文件的，**还要再问「它接受别人告诉它路径吗」** —— 接受才走 B。
   **不接受的（路径写死、或按固定文件名从 cwd 往上找）两条都不适用**，
   得另找出路（OS keyring / 改那个程序 / 挂账）。

答不上来就去读它的取值链，别猜 —— 本批四处里踩到过两次：
**侦察报告对 P4 的消费方判断是错的**（报「未查到消费方」，实际消费方 `start-proxy.bat:7`
用 Node 原生 `--env-file` 就在同一个目录里）；**本档自己对 mousse-cli 的判断也是错的**
（漏了第 2 问，见下面表格底下那节）。

## 🔴 头号坑：sops 找 `.sops.yaml` 是从「你当前所在的目录」往上找

**不是从被加密文件所在的目录往上找。** 这条跟平台无关，但它是本方案第一次真跑时唯一的阻断项，
所以摆在最前面。四组对照实测（2026-08-05 甲路对抗查出，2026-08-06 复现并修）：

| 当前目录 | 被加密文件在 | 结果 |
|---|---|---|
| 凭据根里 | 凭据根**外** | ✅ exit 0 |
| 仓库根 | 凭据根**内** | ❌ exit 1 |
| 仓库根 / 用户主目录 | 任意 | ❌ exit 1 |
| 任意 + `--config <路径>`（或 `SOPS_CONFIG`） | 任意 | ✅ exit 0 |

**第二行是关键**：文件放在凭据根里也救不了 —— 所以这不是「路径没写对」，是发现机制本身。
报错长这样，看不出跟当前目录有关系：
`config file not found, or has no creation rules, and no keys provided through command line options`

⇒ **凡是脚本里调 sops，一律显式钉 `--config <凭据根>\.sops.yaml`。**
⚠ 它是**全局位标志，必须放在 `encrypt` / `decrypt` 前面**；放后面 sops 直接
`flag provided but not defined: -config` 退出 1（本机实测两种位置都跑过）。
`decrypt` 其实不需要它（实测不钉也 exit 0 —— 解密用的是文件自带的元数据），
两个脚本照样钉，是为了让「当前目录上方有没有**别人的** `.sops.yaml`」这个变量彻底离开等式。

**连带的一格比失败本身更该记**：迁移脚本原先的次序是「先明文备份 → 再加密」，
于是**每一次失败的迁移都会在磁盘上多留一份明文口令**，而用户只看到一行红字。
现在的次序是「加密 → 复核 → 备份 → 删原件」：**搬不成功就一个字节都不多写**
（负控实测：改坏 recipient 让加密必失败 ⇒ 退出码 1、原件还在、备份目录里 **0 个文件**；
同一个负控在改之前量到的是 **1 个明文文件**）。

## Windows 硬事实（一手出处，别按 Linux 经验推）

三条原先都是**读 sops 源码与官方文档**得来的。2026-08-05 用真 sops 逐条实跑之后：
**第 1、3 条成立，第 2 条被证伪并已改写。**
⇒ 本节这句引子刻意保留这段订正史，因为它本身就是判据：
**「读源码」比「凭回忆」硬，但仍然不是「跑过」** —— 而错的那一条，源码读的还是对的那个文件，
漏的是**调用方**。

1. **age 私钥的默认位置在 Windows 上是 `%AppData%\sops\age\keys.txt`**，
   不是 Linux 的 `~/.config/sops/age/keys.txt`。覆写用 `SOPS_AGE_KEY_FILE`
   （出处：getsops.io/docs/usage/identities/age）。
2. **`--no-fifo` 在 Windows 上是「显式但无害」，不是「必须」**（2026-08-05 实测**订正**了本条
   原先的说法）。原文写的是「`exec-file` 的 FIFO 在 Windows 上直接 `log.Fatal` ⇒ 不加
   `--no-fifo` 会当场死」，出处是 `exec_windows.go` 里 `GetPipe` / `WritePipe` 的函数体确实
   就是 `log.Fatal`。**但调用方在调到它们之前就把开关关了** —— `cmd/sops/subcommand/exec/exec.go`
   （v3.13.3）：

   ```go
   if runtime.GOOS == "windows" && opts.Fifo {
       log.Warn("no fifos on windows, use --no-fifo next time")
       opts.Fifo = false          // 这一句让下面那两个 log.Fatal 在 Windows 上永远够不着
   }
   ```

   实测（3.13.3 与 3.13.2 两个版本）：**warning + 自动降级，exit 0，功能正常**。
   ⇒ 建议照旧显式写 `--no-fifo`（少一行 warning、语义明确），但**别把它当成「不写就崩」**。
   🔴 **这一格的教训比这一格本身值钱**：原结论是**读源码读出来的**，读的还是对的那个文件 ——
   **漏掉的是调用方**。`读源码 ≠ 跑过`，而漏的位置几乎总是「谁调它」。
   同一个文件里 `ExecSyscall`（`--same-process`）与 `SwitchUser`（`--user`）**确实不可用**，
   两条都实测复核成立（分别报 `not supported on Windows` 与 `user switching not available on windows`，均 exit 1）。
3. **`exec-env` 在 Windows 上走的是 `cmd.exe /C`**（同一文件的 `BuildCommand`）——
   **不是 PowerShell**。你传进去的那个命令串按 **cmd 的引号规则**解析，
   照 PowerShell 的写法写会得到难归因的失败。

## 各消费方的形态（本批四处，查证到行）

| 项目 | 取值入口 | 该走哪条 | 出处 |
|---|---|---|---|
| devin-credit-claimer | `process.env`（自写加载器回填） | **A** | `src/claimer.ts` `loadEnvLocal()` / 消费点 GitHub 登录与 TOTP 两处 |
| devin-byok 的 windsurf-proxy 副本 | `process.env`（Node 原生 `--env-file`） | **A** | `start-proxy.bat:7-8` + `src/handlers/*.js` |
| resume-project/server | `os.LookupEnv` | **A —— 🔴 但现在先别用，见下** | `internal/config/config.go:57` |
| mousse-cli | 只认文件，**且不接受路径** | **两条都不适用 ⇒ 走 OS keyring** | `prompt_store/decompose.rs` `resolve_llm_key_optional()` / `find_env_local()` |

### 🔴 resume-project/server 那一行为什么标「先别用」（2026-08-06 补，本表的第二处内部矛盾）

这一格**技术判断是对的**（它确实读 `os.LookupEnv`，路 A 确实喂得进去），但把它当成推荐路径与
本批的另一个决定**直接打架**：

- 本批对 P2 的处置是「**只搬走，不修加载链**」，理由写在 `dao-secrets-migrate.ps1` 的 P2 段：
  `config.go:39-40` 的 `JWT_SECRET` / `ADMIN_PASSWORD` 有**静默的弱默认值**，
  **先把加载链修好会让「配了就生效」成立，从而让那个缺陷更难被发现**（已挂账 **#136**）。
- 而**路 A 恰恰就是一条能让加载链生效的路** —— `sops exec-env` 注入的环境变量，
  `os.LookupEnv` 读得到。⇒ **一边说不修，一边在表里发了一条会修好它的推荐路径。**

⇒ 在 #136 定案之前，这一行**只作形态判定用（它属于 A 类），不作操作建议用**。
真要跑之前先读 #136。

**顺带一格实测**（只报键名）：`server/.env` 里的键是
`PORT, DATABASE_URL, JWT_SECRET, RESEND_API_KEY, EMAIL_FROM` —— **没有 `ADMIN_PASSWORD`**。
所以就算真走了路 A，`config.go:40` 那个 `"admin"` 默认值照样在，一个字都没变。

### 🔴 mousse-cli 那一行为什么是「两条都不适用」（2026-08-05 订正）

本表原先写它走 **B**，理由是「它只认文件」。**那个理由只答对了一半，而漏掉的那一半是决定性的**：

- **路 A 不成立**：`resolve_llm_key_optional()` 取 key 只有 **vault（OS keyring）→ `.env.local` 文件**
  两条，`base_url` 有 `MOUSSE_LLM_BASE_URL` 环境变量入口而 **key 没有**。
- **路 B 也不成立**：`exec-file` 的接口是「把临时文件的**路径**通过 `{}` 交给你的命令」，
  而 `find_env_local()` 是**从当前目录逐级向上最多 8 层、找一个名字固定叫 `.env.local` 的文件**，
  **没有任何参数能把路径喂给它**。`--filename` 能改文件名，改不了「它在一个随机临时目录里」这件事。

⇒ **正路是 OS keyring**：app 的「设置 → 模型服务」里重填 key。迁移脚本的 `After` 文案一直是对的，
错的是本表。

#### 🔴 「删了 P1 会怎样」有非破坏性验法 —— 别再写成「验不了」（2026-08-06 补）

第一轮与甲路都判过「验它等于真删用户的开发凭据，不该由 AI 做」。**那个判断是错的**，
而它错在漏看了一件本表自己刚写下的事：**`find_env_local()` 是 cwd 相对的** ——
换一棵工作树，取值面就跟着换了。

- `.env.local` **未被 git 跟踪**（`git ls-files --error-unmatch` 报 not known to git）、
  被 mousse-cli `.gitignore:23` 的 `*.local` 忽略；
- 上溯链实测（`find_env_local()` 从 cwd 向上最多 8 层）**唯一命中在 `D:\frank\mousse-cli`**，
  `D:\frank` 那一层没有；
- ⇒ **任何新建的 mousse-cli worktree 里天然就没有它** ⇒ 在那棵树里跑 dev，
  **逐字节就是「删除后」的状态，而真文件毫发无损。**

三条验法，从便宜到贵：

1. **判定捷径（决定性，但这一条要用户自己跑）**：整件事取决于 **OS keyring 里有没有那个条目**
   —— 取值顺序是 vault → vault 旧槽 → 文件，**vault 里有值的话，删掉 `.env.local` 什么都不会发生**。
   条目名 `mousse-cli/llm_key_anthropic`（service `mousse-cli`，出处 `vault/mod.rs:38/92`、
   `decompose.rs:51-55`）。⚠ **AI 查不了这一条**：凭据枚举被 Claude Code 权限分类器拦下，
   而**那一拦是对的**（凭据的事交用户经手）。⚠ `cmdkey /list` 的零命中**不能当证据** ——
   它列不全应用私有条目，那个 0 分不清「真没有」和「它压根看不见」。
2. **worktree 就是「已删状态」**（AI 就能跑，真文件一个字节不碰）：新建一棵 mousse-cli worktree，
   在里面跑 dev，观察点是 `decompose.rs:278-284` 那句
   「未配置 {provider} API key：请在「模型服务」设置中配置」。
3. **连 vault 那半也一起验（悲观上界）**：在 2 的基础上套 `scripts/start-isolated-dev.ps1` ——
   它设 `MOUSSE_DATA_DIR`，keyring service 随之变成 `mousse-cli-isolated-<slug>`
   （`vault/mod.rs:107 service_name()`），是个空命名空间。
   ⚠ **它验的是「vault 空 + 文件无」这个最坏情形，不是用户的真实删除后状态**，两者别混。

**照直写它此刻的状态：验法写下来了，没有人执行过。**
「做不到」和「没去做」是两回事 —— 写成前者会让后面的人不再去想办法。

<details>
<summary>还有第三条弯路，机制实测可行，但不推荐（写出来是为了让下一个人不用重走一遍）</summary>

`sops exec-file --no-fifo --filename .env.local <加密文件> "<包装脚本> {}"`，包装脚本先
`cd` 到 `{}` 的所在目录再启动应用 —— 这样 cwd 就是那个临时目录，**`find_env_local()` 从 cwd
往上找就能找到**。2026-08-06 用一个模仿 `find_env_local()` 的探针实测通过：
临时文件名确实是 `.env.local`，cwd 切过去之后 `FOUND=<临时目录>\.env.local`、内容是解密后的明文。

**但不推荐，三条代价都是实的**：①**没在 mousse 本体上跑过**，只证到机制层；
②应用整个生命周期的 cwd 落在一个临时目录里，任何按相对路径解析的行为都跟着变；
③需要一个包装脚本（`{}` 给的是文件路径，切目录要自己从中取 dirname，而直接在命令串里嵌
`Split-Path` 那种写法实测会让 sops 解析失败）。⇒ 除非将来 mousse 长出一个「key 文件路径」
入口，否则 OS keyring 仍是正路。

</details>

## 已知不覆盖的面（照直写，别读成全包）

- **Vite 的 `VITE_*` 值在 build 时被编译进产物**（官方文档明写不应放敏感信息）——
  **把 `.env` 挪到项目外一寸都解决不了「密钥进 bundle」**。这是判据不是迁移任务：
  前端构建期变量**不属于**本方案的射程。
- **主目录里那约 13 处**（`~/.ssh/`、`~/.aws/`、`gh`、Claude Code、Codex、cc-switch……）
  **结构上就不该搬** —— 它们是各工具按业界标准写死的落点，`~/.ssh/` 正是本方案举的第一个
  正面例子。**改它们不是合规化，是把工具弄坏。**
- **不是 `key=value` 形态的凭据本方案不管**：成批账号清单（JSON/TXT）、浏览器登录态目录、
  证书文件。它们同样是凭据，但 dotenv 的搬法套不上去，要另设计。
- **本方案不提供「谁在读我的密钥」的审计**，也不提供轮换。
