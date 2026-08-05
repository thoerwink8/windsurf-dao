# 只有你能做的事（USER-ACTIONS）

> 这个文件装的是**AI 做不到、必须你本人动手**的事。每条都写清楚：为什么非你不可、
> 具体怎么做、做完怎么确认真的生效了。
>
> 做完一条就在这里划掉（把 `- [ ]` 改成 `- [x]` 并补一句「已做，某月某日」），
> 别只在对话里说一声——对话会滚走，这个文件不会。
>
> 也可以在 GitHub 上看同一批事：置顶单 **#71 📌 需用户总览**。两边说的是一回事，
> 那边方便你在手机上回一句，这里方便你照着做。

---

## 一、issue 看板的三件收尾（2026-08-02，共约 4 分钟）

**背景**：这天给本仓装了一套 issue 派单中枢——标签、四张常设单、一个看板。
命令行能建的都建完了，但有三件事 GitHub 只允许在网页上点，命令行没有对应接口。
**不点这三下，看板会停在建好的那一刻，此后新开的 issue 一张都不会进去。**

看板地址：<https://github.com/users/thoerwink8/projects/1>（标题「windsurf-dao 观测中心」）

### - [ ] 1. 打开「新 issue 自动入板」（约 2 分钟）· 三件里最重要的

**为什么必须你来**：GitHub Projects v2 的内建自动化没有 API，`gh` 命令行建不了。

**为什么重要**：不开这个，新建的 issue 不会自己进板。看板会安安静静地过期——
它不会报错、不会变红，只是永远显示着建板那天的样子，而你以为它是最新的。
（在你点之前，AI 每建一张单都要手动 `gh project item-add` 灌一次，漏一次就少一张。）

**怎么做**：
1. 打开看板 <https://github.com/users/thoerwink8/projects/1>
2. 右上角 `⋯` → `Workflows`
3. 选 `Auto-add to project`
4. 过滤条件填：`is:issue is:open repo:thoerwink8/windsurf-dao`
5. `Save` 并确认它是启用状态（Enabled）

**怎么确认真的生效了**：下次有人（你或 AI）新建一张 issue 之后，跑这条命令看板上应该多一项：

```
gh project item-list 1 --owner thoerwink8 --format json
```

（现在跑它返回的是 `{"items":[],"totalCount":0}` —— 板是空的，这是当前实况。）

### - [ ] 2. 把内建的 `Status` 字段从视图里隐掉（约 1 分钟）

**为什么**：GitHub 新建看板时会自带一个叫 `Status` 的字段，选项是 Todo / In Progress / Done。
本仓这套用的是自己的六列（候选 / 待办 / 在途 / 待验 / 蓄水池 / 完成）。
两个状态字段并排摆着，你会不知道该看哪个——而它们会各说各的。

**怎么做**：看板视图 → 列头 `⋯` → `Hide field` → 选 `Status`；
然后把视图的 `Group by` 设成本仓那个六列字段。

**确认**：板上只剩一个状态类字段，分组按六列走。

### - [ ] 3. 核对三个置顶单的顺序（约 1 分钟）

**为什么**：GitHub 按置顶时间排序，脚本是按「待拍板 → 需用户 → 总览」依次置顶的。
顺序不合你的习惯可以自己调。

**怎么做**：打开 <https://github.com/thoerwink8/windsurf-dao/issues>，看顶部三个置顶单：

- **#70 📌 待拍板总览** —— AI 攒的、等你拍板的事，你在评论区回一句就算拍了
- **#71 📌 需用户总览** —— 只有你能做的事（就是这个文件的 GitHub 版）
- **#72 📌 总览 hub** —— 一眼对齐全局：看板链接 + 各收件箱 + 谁在跑

不合意就在对应 issue 页面 unpin / repin 调整。

## 二、把开会话体检的超时从 10 秒抬到 30 秒（2026-08-04 你拍板，约 1 分钟）

**背景**：`dao-scaffold-check.js` 是每次开会话时跑的那套体检（七项检查）。它注册的超时是 **10 秒**。
issue #127 实测：这套检查整跑 **4.4–5.4 秒**，其中**一项就占 94%**（条款库结构闸，7 次 PowerShell 冷起）；
而它检查的文件数**会自己长** —— 当前 7 个、目录里共 13 份，**全长满约 8.8 秒，贴着 10 秒线**。

⇒ 10 秒不是「留了余量」，是「刚好还没撞上」。

🔴 **撞上会怎样（实测，不是推测）**：宿主超时会**把整个进程树杀掉** ⇒ **七项检查一起消失**，
连**已经打印出去的输出也作废**。而痕迹的方向恰好最坏：transcript 里有 `hook_cancelled`，
**但 agent 上下文里逐字节相同** —— 而那是这套检查唯一的消费方。**它死了，读它的人看不出来。**

**为什么必须你来**：要改的是 cc-switch 数据库里各 provider 的配置。AI 侧被权限分类器全路径拦截，
那是「AI 不得改自己的 hook 注册」的意图级保护。（改 `~/.claude/settings.json` 也没用 ——
那是**投影**，下次切 provider 就被覆盖，且无告警。）

### 🔴 - [ ] 暂缓（2026-08-05 加）：先别跑，等 PR #130 的一格修好

PR #130 的对抗验证查出：那道新的自检（`unreachableConstants`）**比的是总预算，不是有效截止线**。

⇒ **你照下面把注册 10 改到 30 之后，两个 30000 的常量会从它的报文里消失 —— 而它们仍然够不着。**
**这个建议会关掉那道自检当前三分之二的发现。**

**这一格不修就跑，等于用「看不见问题」换「问题变少」。** 修好后本节的暂缓标记会撤掉。

### - [ ] 1. 跑这一行（**暂缓中，见上**）

```
powershell -File D:\frank\windsurf-dao\_tmp\raise-scaffold-timeout.ps1
```

脚本会：**先备份数据库** → 只改锚点含 `dao-scaffold-check.js` 那一处（**不碰同一份配置里
`dao-codegraph-ensure` 的 120**）→ **独立复查一次**（不信 UPDATE 的沉默）→ 打出恢复命令。
想先看它要做什么，加 `-DryRun`（已跑过，命中 `claude-official` 与 `dulays-1784385029046` 两个 provider）。

### - [ ] 2. 在 cc-switch GUI 里切一次 provider（切走再切回也行）

**为什么还要这一下**：数据库是真源，但它**不会自己下发**到 `~/.claude/settings.json`。
下发只挂在 GUI 的「切换 provider」动作上。

**怎么确认真的生效了**：切完之后看 `~/.claude/settings.json` 里 `dao-scaffold-check` 那一行的
`timeout` 是不是 `30`。⚠️ **没切之前它仍是 10 —— 那不是脚本没生效，是还没下发。**

<details>
<summary>不做会怎样（照直写）</summary>

**能活**。代码侧兜底已随 PR #130 落地：预算不够时它**自己看表**、提前退出，
并逐项打印 `⏱ X 没跑 …这不是「通过」，是「没测」`。
不抬只是极端情况下少跑几项，**并且明说少跑了哪几项** —— 而不是像以前那样整批静默蒸发。

</details>

<details>
<summary>技术出处（给复核与 AI 看）</summary>

三条人工步骤的定义在 `ccswitch/templates/project-board.json` 的 `manual_steps` 数组
（`auto-add-workflow` / `hide-builtin-status` / `verify-pins`），由
`ccswitch/scripts/dao-issue-bootstrap.ps1` 在实跑末尾打印。本文件是它那份打印输出的落档——
按脚本自己的说法：「不落进一个会被翻回来的地方就等于没交接」。

bootstrap 实跑结果（2026-08-02）：13 个标签、常设单 #69-#72、看板 `PVT_kwHODKDpbs4BfH2C`。
`auto:true` 在 project-board.json 里的诚实含义是「这一列的归属可由标签机械判定」，
**不是**「GitHub 会自动把单放进来」——后者正是上面第 1 条要点的那一下。

派生副本 `docs/ops/DISPATCH-HUB.md` 的 §六.5 末尾也指着本文件第 1 条。

</details>

## 三、把 4 处明文密钥搬出项目目录（2026-08-05 你拍板，约 10 分钟）

**背景**：issue #135 摸底查出，你这台机器上**项目工作树里的活密钥只有 4 处**
（主目录那约 13 处是 ssh / gh / Claude Code 各自的标准落点，**不该搬也搬不动**）。
这一节就是把那 4 处搬进一个统一的、加密的**凭据根**，并把项目里的原件删掉。

🔴 **四处里有一处特别急**：`D:\frank\devin-credit-claimer\.env.local` 装的是
**一个真人 GitHub 账号的登录口令** —— 不是 token，不能限权、不能按仓库收窄，泄露就是整个账号。
而**那个目录压根不是 git 仓库**，里面那行 `.gitignore` 其实什么都没挡住：
**复制一次那个目录，就是复制一次明文口令。**

用 **SOPS + age** 加密（你 2026-08-05 拍的「能带走优先」）：完全本地、免费、不需账号不需联网。
之所以不用 Windows 凭据管理器 / DPAPI，是因为**那几条没有一条支持跨机迁移** ——
而「换机器不用逐个找密钥」正是你要的四件事之一。

**为什么必须你来**：**凭据的事交你经手，AI 不碰**（你的既定约束）。
AI 已经把方案、脚本、代码改动都做完了，**按下去那一下是你的**。

### - [ ] 1. 装两个工具（约 3 分钟）

```
winget install SecretsOPerationS.SOPS
winget install FiloSottile.age
```

🔴 **sops 那个包 ID 别选错**：winget 里有两个，`Mozilla.SOPS` 是 3.7.3 的陈货
（项目早已从 Mozilla 迁到 getsops），要装的是 `SecretsOPerationS.SOPS`（3.13.2）。

装完**开一个新终端**（PATH 要重新加载）。

### - [ ] 2. 建凭据根（约 2 分钟）

```
powershell -File D:\frank\windsurf-dao\ccswitch\scripts\dao-secrets-init.ps1 -DryRun
```

看一眼它要做什么，然后去掉 `-DryRun` 真跑。它会：检查两个工具 → 建
`%USERPROFILE%\.dao-secrets\` 并**用 icacls 收成只有你能读** → 生成 age 私钥
（**已存在则绝不覆盖** —— 覆盖等于所有加密文件永久打不开）→ 写 `.sops.yaml` →
**拿一个一次性探针值真跑一遍「加密→解密→比对」**，链路不通就当场停。

跑完它会告诉你要设一个环境变量；想让它自动设就加 `-SetUserEnvVar`。

### - [ ] 3. 搬那 4 处（约 3 分钟）

```
powershell -File D:\frank\windsurf-dao\ccswitch\scripts\dao-secrets-migrate.ps1 -DryRun
```

同样先看再真跑。每一处它都：**先明文备份** → 加密进凭据根 → **独立解密回来逐键比对**
（比不上就**不删原件**并当场停）→ 通过了才删项目里的原件 → **打印这一处的恢复命令**。

想只搬最急的那一处：加 `-Item P3`。

### 怎么确认真的生效了

跑完之后这四条应该都成立：

1. `dir %USERPROFILE%\.dao-secrets\*.env` 能看到 4 个文件
2. 随便打开一个，**键名看得见、值是 `ENC[AES256_GCM,...]`**（看得见键名是有意的：
   不解密也能知道里面存了什么）
3. 这四个路径**都不存在了**：
   `D:\frank\devin-credit-claimer\.env.local` · `D:\frank\mousse-cli\.env.local` ·
   `D:\frank\resume-project\server\.env` ·
   `D:\frank\devin-byok\_tmp\windsurf-proxy-反代项目 自行扩展\.env`
4. 领额度脚本照旧能用：
   `sops exec-env "%USERPROFILE%\.dao-secrets\devin-credit-claimer.env" "npm run claim"`
   （在 `D:\frank\devin-credit-claimer` 目录里跑。**代码已经改好了**：它默认从凭据根读，
   读到加密文件会提示你走上面这条命令，读到老的明文文件会打印告警但仍然能跑 ——
   所以**你还没跑迁移之前，它照样是好的**。）

### - [ ] 4. 确认一切正常后，删掉明文备份

```
Remove-Item -Recurse -Force "$env:USERPROFILE\.dao-secrets\_backup"
```

那里面是**明文**（回滚材料）。它在已收紧权限的凭据根内，但确认无恙后就该删掉。

<details>
<summary>🔴 这套方案防住了什么、没防住什么（照直写，别当成万能）</summary>

**防住的**：密钥不再随项目目录被复制 / 提交 / 分享出去 —— 这是 #135 四个目标里的第 2 个，
也是 devin-credit-claimer 那个明文口令的实际风险面。

**没防住的（重要）**：默认模式（`Portable`）把**私钥和密文放在同一个文件夹里**
⇒ **谁整包拷走这个文件夹，谁就同时拿到了密文和解密它的钥匙** —— 对「整包拷走」这个动作，
加密等于不设防。这是你拍「能带走优先」的直接后果，不是脚本的疏漏。
想换成「整包拷走也没用」就传 `-KeyLocation Separate`（私钥放 `%AppData%`），
代价是换机要搬两个地方、且容易只搬一个。

**这个必须单独说**：`%USERPROFILE%\.dao-secrets\age\keys.txt` **丢了就没了** ——
没有找回、没有客服、没有备用钥匙，所有加密文件永久打不开。
**建议单独复制一份到密码管理器或离线介质。**

**还有两件本节没解决、已单独挂账的**：

- **#136** —— resume-project 的 JWT 密钥和管理员口令有**静默的弱默认值**，
  而叫人配置的那个 `.env` **从来没被程序读过**。搬不搬凭据，那个默认值都在。
- **#137** —— devin-credit-claimer 目录里**还有成批账号口令**（`data/trial-accounts.json`）
  **和浏览器登录态**（`.auth/`）没搬。它们不是 `key=value`，dotenv 的搬法套不上去。
  ⇒ **别把「4 处清完」读成「那个目录安全了」。**

</details>

<details>
<summary>技术出处（给复核与 AI 看）</summary>

设计档 `ccswitch/rules/dao-secrets.md`（凭据根形态 / 注入器两条路 / Windows 三条硬事实 /
各消费方的取值入口逐一到行）。四处的处置理由写在两个脚本各自的 `.DESCRIPTION` 里
（那是逐处的唯一真相源，含「谁读它、删了会怎样」）。

**已实测的**：两个脚本的完整控制流（用 sops/age 桩件跑通 init 全流程 + migrate 全流程）、
**两组负控**（桩件静默丢一个键 / 静默改一个值 ⇒ 两次都被复核抓住、退出码 1、原件未删）、
claimer.ts 四种取值情形（环境已有值 / 凭据根加密 / 凭据根明文 / 回落老路径）、
claimer.ts 改动前后 `tsc --noEmit` 错误数一致（2 个，均为改动前就有的 `appendClaimed` 未定义）。

**未实测的**：**真 sops 与真 age 一次都没跑过**（本机两者都没装，而安装属用户动作）⇒
「桩件下全绿」不等于「真 sops 下全绿」。第 2 步那个自证探针就是为这个准备的 ——
它跑通了才说明真链路通。

</details>
