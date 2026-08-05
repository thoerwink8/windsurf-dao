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

## 🔴 注入器：让运行中的进程读到值

**这是真正的设计点，不能靠抄现成。** dao 那份 `common-secrets.json` 卡住的地方正在这里 ——
它只在 restore 那一刻把值合并回 cc-switch，**没有任何让进程在运行时读到它的通道**。
把凭据加密存起来是容易的一半；难的一半是「加密之后程序还怎么拿到它」。

两条路，**都需要，因为它们服务的是两类结构不同的消费方**：

### 路 A · 环境变量注入（`sops exec-env`）

```
sops exec-env "%USERPROFILE%\.dao-secrets\<slug>.env" "<你的启动命令>"
```

解密后的值**只进子进程的环境，不落盘**。

**适用**：读 `process.env` / `os.LookupEnv` / `os.environ` 的程序 —— 也就是绝大多数。

**代价 / 边界**：
- 值在子进程的环境块里，同机上有权限的进程可以读到（`Get-Process` 级别的窥探）。这是环境变量的固有属性，不是 SOPS 的缺陷。
- 命令是**一整个字符串**传进去的，引号规则要当心（见下面「Windows 硬事实」）。
- **它救不了「程序坚持要读一个文件」那一类** —— 那是路 B。

### 路 B · 按需吐值（临时文件，用完即删）

```
sops exec-file --no-fifo "%USERPROFILE%\.dao-secrets\<slug>.env" "<命令，用 {} 代表临时文件路径>"
```

解密到一个临时文件，把路径替换进 `{}`，**子进程退出后文件即消失**。

**适用**：**结构上只认文件、没有环境变量入口的消费方。** 这不是假想 ——
**mousse-cli 就是**：它取 key 的唯一真相源 `resolve_llm_key_optional()`
（`crates/mousse-core/src/prompt_store/decompose.rs:234`）只有两条路，
**vault（OS keyring）→ `.env.local` 文件**，`base_url` 有 `MOUSSE_LLM_BASE_URL` 环境变量入口
而 **key 没有** ⇒ **路 A 对它结构上无效**。

**代价 / 边界**：
- 明文在进程活着的这段时间**确实落在磁盘上**（临时目录）。比路 A 弱。
- 进程被强杀时临时文件可能残留。
- 🔴 **Windows 上 `--no-fifo` 不是可选项，是必须**（见下节）。

### 怎么选（判据一句话）

**问「这个程序拿密钥的入口是环境变量还是文件」** —— 答环境变量走 A，答文件走 B。
答不上来就去读它的取值链，别猜：本批四处里，
**侦察报告对其中一处的消费方判断就是错的**（P4 报「未查到消费方」，实际消费方
`start-proxy.bat:7` 用 Node 原生 `--env-file` 就在同一个目录里）。

## Windows 硬事实（一手出处，别按 Linux 经验推）

三条都是从 sops 源码与官方文档核过的，不是回忆：

1. **age 私钥的默认位置在 Windows 上是 `%AppData%\sops\age\keys.txt`**，
   不是 Linux 的 `~/.config/sops/age/keys.txt`。覆写用 `SOPS_AGE_KEY_FILE`
   （出处：getsops.io/docs/usage/identities/age）。
2. 🔴 **`exec-file` 的 FIFO 在 Windows 上直接 `log.Fatal`。**
   `cmd/sops/subcommand/exec/exec_windows.go` 里 `GetPipe` / `WritePipe` 两个函数体
   就是 `fifos are not available on windows` ⇒ **不加 `--no-fifo` 会当场死**。
   同一个文件里 `ExecSyscall`（`--same-process`）与 `SwitchUser`（`--user`）**同样不可用**。
3. **`exec-env` 在 Windows 上走的是 `cmd.exe /C`**（同一文件的 `BuildCommand`）——
   **不是 PowerShell**。你传进去的那个命令串按 **cmd 的引号规则**解析，
   照 PowerShell 的写法写会得到难归因的失败。

## 各消费方的形态（本批四处，查证到行）

| 项目 | 取值入口 | 该走哪条 | 出处 |
|---|---|---|---|
| devin-credit-claimer | `process.env`（自写加载器回填） | **A** | `src/claimer.ts` `loadEnvLocal()` / 消费点 GitHub 登录与 TOTP 两处 |
| devin-byok 的 windsurf-proxy 副本 | `process.env`（Node 原生 `--env-file`） | **A** | `start-proxy.bat:7-8` + `src/handlers/*.js` |
| resume-project/server | `os.LookupEnv` | **A** | `internal/config/config.go:57` |
| mousse-cli | **只认文件**（key 无环境变量入口） | **B** | `prompt_store/decompose.rs:234` `resolve_llm_key_optional()` |

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
