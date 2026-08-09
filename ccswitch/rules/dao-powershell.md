# PowerShell 脚本坑 · 细则正文（dao.md Shell 节存根的展开面）

> **必经动作**：**新建或改动任何 `*.ps1` 之前 = Read 本文件全文**。
> 与 `dao-dispatch.md` / `dao-longwindow.md` / `dao-guard-writing.md` 同型存根化——
> always-on 每轮注入的配额只该付给「每轮都要用」的东西，而下面这几条**只在「我正要写/改一个 PowerShell 脚本」那一刻**用得上。
> （**刻意不写条数**：本文件 2026-08-05 由四条长到五条，而头注与末节原先三处都写死「四条」，一次增补三处同时过期
> ——同 `dao-officer-clauses.md` 通用节「改一条关于某个对象的陈述时，Grep 面要含那个对象自己的头注」那条记的形态。）
>
> **本文件与那三个存根的差别：它装了机器触发器。** 用户级 `~/.claude/rules/dao-scope-powershell.md`
> 带 `paths: ["**/*.ps1", ...]`，Read 任何 `.ps1` 时宿主自动把「去读本文件」这句话送到眼前——
> 那三个存根的「必经动作」四个字至今**只靠记性**（本仓实测无标记时刻的自由裁量携带率 9-24%）。
> 部署与漂移自检见 `ccswitch/scripts/dao-rules-deploy.mjs`。

> **刻意不迁进本文件、留在 dao.md Shell 节的**：**临时文件归项目**（每轮都要用）·
> **改配置先认源与投影**（高频判据）· **PR-first 节律** · 各存根行。
>
> ⚠️ **2026-08-02（批 3 续跑）订正了这份清单**：`路径锚点` / `验证加 marker` /
> `串行敏感验证` 三条**此前在这份「刻意不迁」清单里**，理由是「它们不是写 PS 脚本那一刻专属」。
> 那条理由仍然成立，**是 dao.md 的 10 KB 硬闸压过了它**——三条合计约 200 B，而 dao.md Shell 节
> 装不下。**代价照直写：本文件的触发器是「Read 一个 `.ps1`」，盖不住「我正要跑一条验证」
> 与「我正在跨 workspace 操作」那两刻**，迁进来等于这三条从此只在改脚本时才被送到眼前。
> `截图路径强制`（G4）与 `settings.json 门禁`（G2）同批从 dao.md 删去，**理由不同**：
> 它们由 `ccswitch/hooks/dao-hard-gates.js` 机械阻断，判据全文在该 hook 头注，
> 文字层是纵深不是唯一防线。

---

- **Windows PowerShell 假错**：用 `$LASTEXITCODE`（`Start-Process -PassThru` 那条路则用 `$proc.ExitCode`）判成败，不看输出有无 "error" 字样；中文「所在位置 行:X」是 ErrorRecord 非真错；禁 `2>&1`（混流致假错），噪音用 `2>$null`。**`2>&1` 具体怎么害人**：它把 native 命令的 stderr 包成 `NativeCommandError`，在 `$ErrorActionPreference='Stop'` 下把**正常的 stderr 进度行**（如 cargo 的 Locking/Updating）判成终止性错误、中断整个脚本；要捕获输出就用 `Start-Process -RedirectStandardOutput/-RedirectStandardError` 落真实文件。完整判据与出处：`ccswitch/rules/dao-officer-clauses.md` 通用节同名条款
- **禁改含中文/无 BOM 文件 —— 真凶是 `Get-Content` 本身，不是那条管道**（2026-08-02 射程订正）：本条原写作「**PS 管道**禁改含中文/无 BOM 文件」，于是两起真实事故从它的字面射程外溜了过去——两起的写侧都规范（`[IO.File]::WriteAllText` + 无 BOM UTF8），毁在读侧。判据是：**PS5.1 的 `Get-Content` 任何形态**（含 `-Raw`、含只读不写）读无 BOM UTF-8 时按本机 ANSI 代码页解码，**内容当场就毁了**，写侧再规范也救不回来；`Set-Content -Encoding utf8` 另会写出带 BOM 的文件、弄坏 JSON/TOML 消费方。文件内容替换一律用编辑工具，非用不可时读侧走 `[IO.File]::ReadAllText($p,[Text.Encoding]::UTF8)`。**连带一个静默失败**：字符串已成乱码后，后续 `-replace '<含中文的模式>'` 一律不命中且不报错、`$LASTEXITCODE` 照样 0。三起实证、逐字复现步骤与占位符没被替换那次的下场：`ccswitch/rules/dao-officer-clauses.md` 通用节「编码铁律」（2026-07-12 Cargo.toml/JSON 中招致 tauri dev 崩那次仍是本条最早的出处）
- **BOM 被写没时 `[Parser]::ParseFile` 报大量假语法错，别被诱导去改语法**（2026-08-09 · PR #206 对抗复核③节实证，用户 2026-08-09 #70 一揽子拍板收入）：与上一条是**近亲但不同的坑**——上一条讲**读取内容**被 `Get-Content` 误解码，这一条讲**脚本文件自身被 PowerShell 解析器解析**时同样要 BOM。无 BOM 的 UTF-8 `.ps1` 源文件里含中文字符串时，`[System.Management.Automation.Language.Parser]::ParseFile` 会产生看起来随机的假语法错（PS 5.1 按本机 ANSI 重解码源码里的中文字面量），长得像代码坏了，会诱导去改语法而不查编码。判定：`Get-Content <文件> -Encoding Byte -TotalCount 3` 看开头三字节是不是 `EF BB BF`。
- **消费侧也要钉编码 —— 生产侧钉了 UTF-8，不等于你读得对**（2026-08-05 · issue #131 实测）：PS 5.1 捕获**子进程** stdout（`$out = & powershell …`、`& <native>` 的返回值）时按 `[Console]::OutputEncoding` 解码，而这个值跟着**控制台代码页**走；与此同时本仓已有脚本把自己的 stdout **钉成 UTF-8**（`check-clauses-structure.ps1`，为的是让 node 消费方读得对，那个修法是对的）⇒ **两边只在控制台恰好是 65001 时才对得上**。对不上时捕获到的中文是乱码、`-match '<中文>'` 全部不命中，而**红的报文与退出码全都指向被测对象，没有任何东西指向控制台**。实测：`tests/clause-structure.tests.ps1` 同一份代码、同一个被测对象，CP936 下 51 FAIL / EXIT=1，65001 下 155 passed / EXIT=0，且它此前被五次当成「这套测试无条件绿」的证据。⇒ **写 PowerShell 消费方时 dot-source `ccswitch/lib/console-utf8.ps1`**（判据、已知副作用与射程边界的唯一真相源在那个文件头注，本行不复述）。⚠ **与上一条是两个坑，别混**：那条是 `Get-Content` 读无 BOM 文件（走 `[Text.Encoding]::Default`，**恒为本机 ANSI、与 `chcp` 无关**），这条是捕获子进程输出（走 `[Console]::OutputEncoding`，**跟 `chcp` 走**）；同一台机器上实测两者分别是 936 与随 `chcp` 变的值，处方也不同。
- **调 `.ps1` 要拿退出码，一律 `powershell -File`，禁 `-Command "& '<脚本>'"`**（2026-08-06 · mousse #539 批顺带实测，**官实测、帅未复跑**）：`-Command` 模式下 powershell.exe 只按「最后一条命令成败」返回 0/1，**不透传脚本内的 `exit N`**——实测同一个已知 exit 3 的用法错误，经 `-Command` 拿到 **1**，换 `-File` 如实拿到 **3**。危害分级比「假错」高一档：多态退出码（如 verify-all 的 0/1/2/3 四态）的消费方拿到的是**被抹平的假值**，「跳过了几道」与「硬闸失败」在它眼里同码——**红了看得见的病是缺陷，绿没绿看不出来的病是失明**。写调用侧（合并链 VerifyCommand、CI step、测试跑手）时逐处核这一格。
- **Inline 长命令**：PS 处理 `node -e "..."` >300 字符或含嵌套引号会被 PSReadLine 截断 → 写脚本文件再跑

---

## 三条通用 shell 实操（2026-08-02 批 3 续跑从 dao.md Shell 节迁入，身位差见上方头注）

- **路径锚点**：跨 workspace 或终端异常后，用 `git -C <repo>` / `pnpm --dir <repo>` /
  `npm --prefix <repo>`，**不只依赖 cwd**——subagent 的 cwd 在两次调用之间会被重置。
- **验证加 marker**：关键验证用 `VERIFY_BEGIN … VERIFY_EXIT=$LASTEXITCODE` 包裹；
  **marker 缺失、或来自错误目录 ⇒ 判为终端感知异常，不判业务失败**（配套见
  `ccswitch/rules/dao-officer-clauses.md` 通用节「切目录跑验证必须带目录守卫 + CWD marker」）。
- **串行敏感验证**：test / typecheck / install / build **串行执行**，并行只用于短只读命令——
  并行时多路输出会串线，读出来的「全绿」可能来自另一条命令。

---

## 射程边界（照直写，别读成全包）

**触发器是「Read 一个已存在的 `.ps1`」**，所以它覆盖**改**、不覆盖**从零新建**——
新建一个 `.ps1` 而全程没 Read 过任何 `.ps1` 时，这几条一条都不会被送到眼前。
这就是 dao.md Shell 节仍保留一行存根指针的理由：存根是那半的唯一兜底，而它是纯文字、靠记性。
**两半都不完整，合起来也不是 100%**——别把「有了作用域规则」读成「这几条现在有人管了」。
