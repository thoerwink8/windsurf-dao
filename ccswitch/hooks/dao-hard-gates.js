// dao-hard-gates.js — 门控出文本层（PreToolUse · exit 2 阻断）
//
// ── 为什么存在这个文件 ───────────────────────────────────────────────────────
// arxiv 2607.26819（RepoComplianceBench，49 仓 / 106 issue / 4 前沿模型）实测：
//   · Refuse（禁止 X）类规则       无干预 0%，引原文仍 0%（最好 10%）
//   · Handoff（关键步骤交人）类     无干预 0%，引原文 0%，一轮反馈 0%
//   · agent 仅 3.5% 的运行打开过策略文件；97.6% 的违规发生在策略文件从未被打开时
// 原文结论："Bans and human gates need enforcement **outside** the agent."
// Anthropic 官方同句："A real guardrail needs to be deterministic, and the
// enforcement methods are hooks and permissions."
// ⇒ dao.md 里的「🚫 禁令 / 一票否决 / 永不 / 必须先问用户」写成文字 = 等于不存在。
//    本文件把其中**机器判得了、且没有合法例外**的那几条搬到 agent 之外。
//
// ── 这里只放「甲类」：可机械判定 + 无合法例外 ────────────────────────────────
// 有合法例外的（如 push 主干——文档微改允许直推）走 ccswitch/hooks/dao-tool-nudge.js
// 的软提醒分支；机器根本判不了的（审美拍板 / 打磨到位 / 不许留空未尽处）**留在文本里**，
// 判定表与逐条理由见本批 PR body 与 docs/specs/dao-arch-optimization-202608.md P1 行。
//
// ── 六道闸（逐条的判据出处写在各自的 GATES 条目里）──────────────────────────
//   G1 windows-mcp 全面禁令          dao.md「目·观」§windows-mcp 禁令（一票否决）
//   G2 live ~/.claude/settings.json  dao.md Shell 节「确认门禁」+「改配置先认源与投影」
//   G3 对外发布类命令                dao.md 帅节留守判据 ㈣自主边界「对外发布 / 需用户在场」
//                                    （正文 2026-08-02 迁 ccswitch/rules/dao-longwindow.md §心跳对账节 · 丁）
//   G4 浏览器 MCP 截图落盘路径        dao.md Shell 节「截图路径强制」
//   G5 只读载体未勾待办               dao.md「言·名之则」§只读载体禁写待办
//   G6 心跳 prompt 缺 `[dao-heartbeat]` 签名  docs/specs/dao-rewrite-202608.md 分流表第 3 类
//                                    「心跳投递机器化」（2026-08-02 新增 · **呈批项**，见下）
//   G7 shell 里跑搜索/读文件工具      dao.md「八、工具使用铁律（Grep-first）」（2026-08-02 新增）
//
// ── 各闸的判据全文（2026-08-02 dao.md 瘦身批 #7 迁入；dao.md 那三段已压成一行指针）──
// 迁入前逐段核对过：dao.md 当时写着「全文见该 hook 头注，本行不复述」，而**头注里其实没有**
// —— 一个指向空气的指针比没有指针更糟（读者以为有兜底）。下面补的就是那几句。
// 拦截判定逻辑（各 gate 的 test()）与 stderr 文案（why / how）**#7 那一批**一字未动，只加注释。
// ⚠️ 后续动过的照直记：**瘦身批 #1（2026-08-02）改了 G3 的 why 与 how 里的三处指针文字**——
// 「dao.md 帅节 ⑤自主边界」在 #1 之后已不是 dao.md 里的编号（⑤ 随正文迁去
// ccswitch/rules/dao-longwindow.md §心跳对账节 · 丁，dao.md 只剩留守判据 ㈣）。
// **test() 的 matcher 与判定分支仍未动过一个字符**，改的只有指向哪里的那几句话。
// ⚠️ **第二次改文案（2026-08-02，issue #63）：G2 的 why 与 how ② 教的是一条已被证伪的路径**——
// 原文写「正路是改 git 快照层 `config-sync/common/settings.json`，再由用户跑 `dao.bat
// --direction=down`」，而 #49 的下发链实测证明快照层与 `common_config_claude` 镜像层**都不在
// 下发路径上**，照它做改动**永不生效**（PR #43 即如此：写满两层而 live 始终未注册）。
// **一道闸给出走不通的合法路径，比不给更糟**：被拦的人会照做，然后以为自己已经做完了。
// 现改为指向真实下发源 `providers.settings_config`（每个 provider 都要改）。
// **G2 的 tools/matcher 与 test() 判定分支同样一个字符未动**，改的只有被拦时打给人看的那段话。


//
// G1 · windows-mcp 禁令 —— **弃用理由**：用户 2026-07-25 一票否决，该 MCP 已从机器卸载
//   （完整因果链见 docs/evolution/dao-clause-rationales.md §动-2）。**替代分工**见下方 G1 的
//   `how`（DOM 与截图 → chrome-devtools / playwright；进程与注册表 → 内置 PowerShell 工具；
//   文件读写搜索 → 内置 Read / Grep / Glob；纯 Win32 且脚本也不可行 → 诚实挂账「需用户目视」）。
//   ⚠ **仍归文本、本闸拦不到的那半**：dao.md、各 skill、各 stacks 里**提到 windows-mcp 的历史
//   段落**，一律读作「已弃用，不得选用」—— 那是一种**读法**不是一个动作，没有任何工具调用
//   与之对应，所以它只能靠文字。别把「G1 已上闸」读成「这条已经全被兜住了」。
//
// G2 · live settings.json —— **为什么不是「小心点就行」**：改 live 那一份的已知风险是
//   **可能触发 `401 device was revoked` 强制登出**（会话当场断，且不是把文件改回去就能恢复的）。
//   三条合法路径的全文在下方 G2 的 `how`。⚠ **config-sync 同理**：它写的也是配置面，
//   动它之前同样先问用户授权 —— **问了就做**，不必来回请示，卡住不动不是谨慎是停摆。
//
//   ── 2026-08-02 扩面（issue #87）：原版有两处结构性失明，同一条命令一次踩中两处 ──────
//   实测绕过命令**原文**（本机 2026-08-02，用户已授权、结果无害，但同一形态在未授权时同样放行）：
//     `Copy-Item "<源>" "$env:USERPROFILE\.claude\settings.json" -Force; "COPY_EXIT=$LASTEXITCODE $?"`
//   ㈠ **它是 PowerShell 工具调用，根本进不了 Edit/Write 分支** —— G2 的 test() 第一行
//      `if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/...) return null` 当场返回。
//      matcher 里一直有 `PowerShell`，`--selfcheck` 也一直报 G2 覆盖 ✓ —— **「闸被调用了」
//      与「闸看得见这个形态」是两件事**，而它们在任何日志里都长得一样。
//   ㈡ 路径是 `$env:USERPROFILE` **变量形态**，就算进了分支也比不上展开后的 home。
//   ⇒ 本次两处都补：①新增 shell 分支（Bash/PowerShell）②路径判据换成「先展开变量再比」。
//
//   🔴 **最要紧的一条设计取舍：只看目标位，源位一律放行**。复制/移动类命令的**源位**出现
//   live settings 是**读**（备份），而真语料里那才是主流形态 —— 全量普查
//   `~/.claude/projects/**/*.jsonl` 里 shell 触到 live settings.json 的命令：
//     · **写**（目标位）**1 条** = 本次这条绕过；
//     · **读/备份**（源位）**4 条**：`Copy-Item "$env:USERPROFILE\.claude\settings.json"
//       "$env:USERPROFILE\.claude\settings.json.bak-20260801-hardgates" -Force`、
//       `cp "C:/Users/.../settings.json" "....bak-20260712-marshal-scout"`、
//       `cp ~/.claude/settings.json "D:\frank\windsurf-dao\_tmp\settings-live-backup-$TS.json"`、
//       `Copy-Item 'C:\Users\Administrator\.claude\settings.json' (Join-Path $dst 'settings.json')`。
//   **若判据写成「这一段里出现了 live settings 就拦」，上面 4 条真实命令全部误伤，而备份恰恰是
//   本闸 `how` 里劝人走的那条路**（先备份再请用户改源）。误伤代价还不对称：逃生阀只有用户设得了
//   ⇒ 会话当场卡住（G7 已经为这个形态付过 4% 的学费，见头注 G7 ㈥）。故：**源位放行是刻意的**，
//   它的对价是「先 `cp live x.tmp`、改 `x.tmp`、再 `cp x.tmp live`」这条两步绕法本闸拦第二步、
//   拦得住；而单纯把 live 读走的，本来就没改任何东西。
//
//   **已知漏报面，照直写（近似判据，不是判定）**：
//     ①**程序化写入**——`node -e "fs.writeFileSync(...)"` / `python -c` / 调一个自己写的
//       `.ps1`/`.bat`：段首是 `node`/`python`/脚本名，本闸看都不看。这是最大的一格。
//     ②**表达式右值的变量**——`$p = Join-Path $env:USERPROFILE '.claude/settings.json'` 之后
//       `Copy-Item x $p`：变量表只认**字面量**右值（`$p = "…"`），表达式一律解不出。
//     ③**`cd` 不传播**——`cd ~ && cp x .claude/settings.json`：切分器把 `cd` 那一段扔了，
//       相对路径按**工具的 cwd** 解析，不按 `cd` 后的目录。
//     ④`cp -t <目录> <源>` / `robocopy` / `New-Item -Path X -Name Y` 这类「目标位不在末位、
//       也不在已知参数名下」的形态。
//     ⑤混淆写法（base64 / `Invoke-Expression` / 反引号命令替换）—— 本闸刻意不追。
//   ── 以下四格由**对抗验证官**在合并前夹击查出（2026-08-03，issue #87），实现官未列 ──
//     ⑥ ✅ **已修，见 issue #112**（2026-08-03）——**具名源吃掉正参**：
//       `Copy-Item -Path <源> <目标>` / `-LiteralPath <源> <目标>` / `-lp`，具名参数吃掉一个正参后
//       只剩 1 个，撞上「单正参不算目标位」的早退 ⇒ 一个候选都产不出。
//       **修法**：目标位存在的门槛由「恒 ≥2 个正参」改成「具名源在场时 ≥1 个」（`needed`）——
//       依据是 PowerShell 的参数绑定语义（`-Path` 具名后，剩下的第一个正参绑到 position 1
//       = `-Destination`），不是正则猜的。
//       ⚠ **别读成「具名形态已覆盖」这句话当初错在哪**：PR #106 的 body 正控清单写着
//       「`-Destination` 具名参数」，而**具名的是源、位置的是目标**这一种混合形态落在两边之外。
//       ⚠ **收窄面照直写**：只有 `-Path`/`-LiteralPath`/`-lp` 算源位（`G2_SRC_PARAM`）。
//       收宽成「任意具名取值参数」会让 `Copy-Item -Filter *.json <live>` 这类**单正参=源**的
//       合法命令被误伤 —— 回归网有两条负控 + 一条反向 mutation 钉着这个决定。
//     ⑦ ✅ **已修，见 issue #112** —— **具名 `-Destination <目录>` 没有 basename 展开**：
//       该展开原先只写在正参分支里。**修法**：具名目标与位置目标一起进 `destRaws`，
//       basename 展开对两者跑同一段（源也含具名源）。
//     ⑧ ❌ **未修，判断档，留给用户拍板（issue #112 甲⑧ 原样挂着）** —— **单正参 + cwd 恰在
//       `~/.claude`** ⇒ 隐式目标就是 live。`~/.claude` 是本机常用工作目录，这一格不是理论洞。
//       **不修的理由不是"不要紧"**：把 cwd 当隐式目标位会引入**一整类新误伤面**（所有在
//       `~/.claude` 下的单正参写入命令都会进入判定），给 AI 自己定这条及格线属结构性利益冲突。
//     ⑨ ✅ **已修，见 issue #112**（本格优先级最高，因为它**不是 #106 引入的**）——
//       **绝对路径一步归一都不过**：`..` / `.` / `//` / 8.3 短名 / `\\?\` 全部绕开精确比对。
//       ⚠ 这一格**穿透改动前就有的 Edit/Write/MultiEdit/NotebookEdit 分支**，不是 shell 分支
//       独有 —— 即**本闸自诞生起就漏**，两个分支现在都过 `g2Canon()`。
//       **修法与它自己的两个坑**见 `g2Canon` 的头注（为什么按根的形态分派 win32/posix 两个
//       归一器，而不是图省事统一用一个 —— 两种统一写法各自会制造一个新漏报，本机实测过）。
//       ⚠ **仍不覆盖：UNC 共享形态**（`\\localhost\C$\…`）。它的唯一解法是 `realpath`，
//       而对网络路径 realpath 会把 SMB 超时（可达数十秒）拖进一个 PreToolUse 钩子 ⇒
//       **拿会话卡死换覆盖面，刻意不换**。登记表里有一条钉着它。
//   ── 以下一格由 **issue #112 的实现官**在攻 ⑦ 的边界时撞出（2026-08-03），#106 那份清单里没有 ──
//     ⑩**双引号里的尾反斜杠吞掉闭引号** —— `-Destination "$env:USERPROFILE\.claude\"`：
//       `g2Tokens` 按 **bash** 语义把 `\"` 当转义，而 PowerShell 里反斜杠不是转义符、
//       `"C:\x\"` 是一个合法的、以 `\` 结尾的字符串 ⇒ 闭引号被吃掉，整条命令剩余部分并进一个
//       token，目标位解不出来。**位置目标与具名目标同时中招**（证明它在 tokenizer 层，不在某个分支）。
//       **不在 #112 范围内**：修它等于让 tokenizer 按工具名分叉 bash/PowerShell 两套转义语义，
//       是设计改动、且两侧都有误伤代价，属判断档。登记表里有两条钉着它。
//   **别把「G2 现在管 shell 了」读成「shell 写 live 已经被兜住了」**：兜住的是**直白写法**，
//   而直白写法正是真实违例的形态（本次那条就是）。
//   ⚠ **两处已知误伤**（真语料上当前零发生，但逃生阀只有用户设得了 ⇒ 撞上即会话卡死）：
//     heredoc 正文里写着那条命令会被当成真命令（G5 早为同一个病做过行首锚点收窄，G2 shell 分支
//     没照一遍）· 写入类命令的 `-Value (表达式)` 吞掉取值后 live 路径掉进正参。
//     **两处均未修（issue #112 乙节，判断档，与 ⑧ 一同呈用户拍板）。**
//   **上面十格 + 两处误伤在 `tests/hard-gates.tests.js` 有登记表断言**：哪天有人补上某一格，
//   那条会红并点名，逼他同批更新这份清单 —— **这份头注不是承诺，是一张有守卫的账**。
//   （#112 就是被它逼着回来改这段的：修完三格后登记表当场红并逐条点名那 6 行。）
//
// G4 · 浏览器 MCP 截图路径 —— ⚠ **射程只到浏览器 MCP 这一种工具调用**：
//   PowerShell / .NET 的截图脚本（System.Drawing CopyFromScreen 那条路）走的**不是工具调用**，
//   本闸看不见它，那一半仍然只是判据。同样别把「G4 已上闸」读成「截图路径已经有人管了」。
//
// G6 · 心跳签名（2026-08-02 新增，dao 重写批 1-C）——**它拦的不是一个坏动作，是一个坏格式**，
//   这在本文件里是头一遭，所以理由要写清楚：
//   ㈠ **它是另一件事的前置条件，本身不是禁令**。dao-rhythm.js（UserPromptSubmit）新增的
//      WAKEUP 信号靠 `[dao-heartbeat]` 这个前缀认出「这一轮是心跳唤醒」，据此注入长窗留守四句
//      + 「Read dao-longwindow.md §心跳对账节」。**没有签名 ⇒ 那一轮什么都不注入**，而心跳轮
//      恰恰是留守四句唯一的投递时刻（dao.md 帅节长窗存根：「投递通道 = 开窗仪式 Read（第一轮）
//      + 心跳 prompt 载荷（后续每一轮）」）。⇒ 漏一次签名 = 那一轮的留守判据静默缺席，
//      而「缺席」与「注入了但没照做」在任何日志里长得一样。
//   ㈡ **为什么不能靠「记得写签名」这句话**：写签名这个动作发生在**每一轮心跳**，是典型的
//      「无标记时刻的自由裁量」——本仓实测这类携带率 9-24%。跟着模板走的才是 100%。
//   ㈢ **stop:true 豁免**：收窗那一次调用没有 prompt、也不会产生下一轮，签它没有意义。
//      真实语料里 `{"stop":true}` 是**唯一**的无 prompt 形态（993 次调用里 31 次，prompt 缺失 0 次）。
//   ㈣ **误伤面：实测为零，但不等于不存在**。全量语料普查（`~/.claude/projects/**/*.jsonl`，
//      2026-08-02，993 次 ScheduleWakeup tool_use）：非 stop 的 962 次**全部**是 dao 自主窗心跳，
//      零次来自 `/loop` 或其他非 dao 用途。**「零观察」不是「零存在」**——若将来内置 `/loop`
//      或别的功能自己构造 ScheduleWakeup 的 prompt（调用方拿不到那段文字），本闸会拦下它。
//      故 G6 **给逃生阀**（G4 不给，因为 G4 拦错顶多少一张截图；G6 拦的是驱动自主循环的那个
//      工具，两侧代价不对称）。逃生阀仍然只有用户设得了 —— 见下方设计取舍①。
//   ㈤ **本闸未经用户拍板**（spec 里标着「呈批项」）。**它现在是惰性的**：live settings 的
//      PreToolUse matcher 不含 `ScheduleWakeup` ⇒ 宿主根本不会为这个工具调本 hook。
//      **注册那一下就是用户的批准动作**；在那之前 `--selfcheck` 会把它报成
//      「✗ G6：matcher 覆盖不到 ScheduleWakeup ⇒ 这道闸静默零覆盖」并 exit 1 —— 刻意如此，
//      「没接上」要在机器通道上说出来，而不是安静地等着。
//
// G7 · shell 里跑搜索/读文件 —— **它拦的不是一个坏动作，是一条本来就会被拦、只是不说
//   为什么的路**。这一条与 G1-G6 都不同，理由要写清楚：
//   ㈠ **它治的是「拒绝消息不给替代写法」，不是「没人拦」**。`~/.claude/settings.json` 的
//      `permissions.deny` 已经有 `Bash(grep:*)` / `Bash(find:*)` / `Bash(rg:*)` / `Bash(ag:*)` /
//      `Bash(ack:*)` / `PowerShell(Select-String:*)`；agent 撞上去只收到一句
//      「Permission to use Bash with command grep -iE … has been denied.」——**拦对了，但不说该改用什么**，
//      于是每个 subagent 各自摸索。实测（62 份 subagent 转录 / 186 个报错）：命令被权限拦下 65 次，
//      是所有报错里最大的一类。**同级 agent 之间没有横向通道，一个官的教训传不给下一个官** ⇒
//      唯一的出路是把那句「该用什么」搬到闸的 stderr 里，让它跟着每一次违例走。
//   ㈡ **顺序是实测的，不是推的**：`docs/permissions.md` 写着「PreToolUse hooks run before the
//      permission prompt」，且「Hook decisions don't bypass permission rules」。2026-08-02 本机
//      实跑一条**同时命中 deny 规则与 G5** 的命令（`grep zzz && git commit -m "…- [ ] …"`），
//      收到的是 **G5 的 stderr 而不是权限拒绝** ⇒ **hook 先于 deny 规则求值**，G7 的话说得出去。
//      ⚠ 反过来那半也照直记：**hook 返回 allow 不能解开 deny 规则**（文档明写），
//      所以 G7 **不去、也不能去**「放行」任何东西，它只负责在被拦的那一刻把话说清楚。
//   ㈢ **收哪几个词是被真语料定的**（dao-guard-writing ①「建护栏前先摸全域分布」）：
//      全量普查 `~/.claude/projects/**/*.jsonl` 的 32721 条 Bash/PowerShell 命令、26402 条唯一命令。
//      独立段段首命中量前二是 **`ls`(3266)** 与 **`wc`(1032)**，两个**都不收**，
//      **收进来等于凭空造 4298 次必然误伤**，而「生下来就吵的检查一定会被静音」。
//      理由分别是：
//        · `ls` —— Glob 只给路径，给不出 `ls -la` 的时间戳、大小与权限位。
//        · `wc` —— ⚠️ **这条理由 2026-08-02 订正过一次**：原写「Read 也数不了行数」，
//          说 Read 没错，**但 Grep 数得了**（`pattern="^"` + `output_mode="count"`，
//          本机两次实测与 `wc -l` 逐字相等：`dao.md` 268=268）。**决定仍站得住，换个理由**——
//          `wc -c`/`-w` 的字节与词计数没有对应、多文件一次汇总没有对应，
//          且 `wc` 在真语料里 **290 次是在管道位**（`… | wc -l`），本就豁免。
//          留着这处订正：**一个正确的决定配一个错误的理由，日后照那个理由推广就会推错。**
//   ㈣ **判据是「段首 + 前一个分隔符」，不是「命令里出现过这个词」**。五类合法用法结构性豁免：
//      ①管道过滤（`node t.js | grep FAIL` —— 吃的是上一条命令的 stdout，Grep 工具结构上替代不了）
//      ②stdout 落真实文件（在造给下一步吃的产物，Grep/Read 写不出文件；`2>/dev/null` 不算）
//      ③命令替换 `$(…)` 内部（切分器不进去）④`sed -i` / `find -exec` / `tail -f`
//      ⑤`head`/`tail` 的 `-c` 字节模式（**Read 是按行的，没有字节语义**，真语料 114 例）。
//      外加两个**天然**豁免：`git log --grep=` 段首是 `git`（看都不看）、
//      `until grep -q …; do …; done` 段首是 `until`（轮询，Grep 工具没有"等到出现为止"这个语义）。
//   ㈤ **数字（2026-08-02 第二版，复现脚本 `_tmp/measure-g7-v2.mjs`，语料是当日全量
//      26646 条唯一命令 / 1385 条被权限拒）。第一版的数字失真过，成因写在末尾，别删。**
//      · **新增拦截面 1002 条**（此前**能跑**——`sed`/`head`/`tail`/`cat` 不在 deny 列表里）：
//        `tail` 378 / `cat` 307 / `sed` 215 / `head` 73 / `grep` 23 / `find` 6，**段首解析不出 0 条**。
//        **最大一格是 `tail -n N <日志>` 378 条**（新增面的 38%）—— 这是本闸最大的一处摩擦。
//        **不给它豁免是刻意的**：真正替代不了的三格（`-c` 字节 / `-f` 流式 / 管道位）已全豁免，
//        剩下的全是读静态文件，而豁免这一格等于掏空这道闸。配方见 `SEARCH_TOOL_ALT.tail`
//        （两步、零浪费，**不是**"先整份 Read 一次看行数"——那条最贵的路已被换掉）。
//      · **召回 54.7%**（758 / 1385）。分母口径核过一次：被拒命令里 **1380 条确实含搜索类词**、
//        只有 5 条是别的 deny 规则拦的 ⇒ **换成"含搜索词的被拒"当分母也只有 54.9%，不是分母问题**。
//        未命中 627 条，确定性抽样 40 条人读：**36 条是管道过滤或 `until`/`while` 轮询**
//        （刻意放行、内置工具无替代），4 条本身不含独立搜索命令。
//        ⚠️ **但"未命中的全是刻意放行"这句话不成立**：抽样看不见低频形态，对抗验证官在全量上
//        找出 **13 条真漏报**，其中大部分正是由下面那两个过宽豁免造成的（都已修）。
//        ⇒ **这批的主体仍是"deny 规则拦错了"，正解是收窄 deny 规则**（用户动作：改 cc-switch DB
//        的 `providers.settings_config`），本批不动。
//      · 🔴 **一处未调和的分歧，照直写**：对抗验证官同日独立实测报的是 **84.1%（1167/1388）**，
//        分母与我一致（1388≈1385），**分子差 409 条**。我用真 hook 进程重跑仍是 758，
//        **无法复现 1167**，也说不出成因（推测是两侧对"命中"的取数口径不同）。
//        **不采信我复现不了的数字，也不假装两边一致** —— 谁要引用召回率，先跑一遍
//        `_tmp/measure-g7-v2.mjs` 自己看，或去问对抗官要他那份脚本对一遍。
//      · **第一版为什么失真（成因留档，这是本批最该记住的方法论）**：总数取自真 hook 没错，
//        但**分桶用的是分析脚本自己的正则**——那条正则要求 stderr 里 seg 部分不含反引号，
//        于是 122 条被判成"解不出"、当作未知处理，实际大部分是真命中 ⇒ `tail` 一格少报约 60 条、
//        总数少报约 30 条。**教训：测一道闸，每一个数字都必须来自那道闸本身，
//        中间只要插进一条自己写的正则，那条正则就成了新的被测对象而没人测它。**
//   ㈥ **逃生阀 `DAO_SHELL_SEARCH_OK`（仅用户可设）**。给它的理由与 G6 同型——两侧代价不对称：
//      G7 覆盖的 `cat`/`head`/`tail`/`sed` **不在 deny 列表里**，即本闸是它们唯一的拦截者，
//      而内置工具的能力边界（字节语义、流式、写文件）我只枚举到了我看得见的那些。
//      🔴 **已知代价，别读成"误伤已清零"（对抗验证官量化，2026-08-02）**：G7 拦下的 1722 条里
//      **约 69 条（4.0%）是硬误伤** —— 被拦那一段的下游是 `awk`/`wc`/`sort`/`jq` 之类聚合，
//      **内置工具没有替代品**，撞上就只能走逃生阀，而逃生阀**只有用户设得了** ⇒ **会话当场卡住**。
//      且 `--selfcheck` 显示 G7 已被现役 matcher 覆盖 ⇒ **合并即生效，那 4% 第一天就会撞上**。
//      这一格是**明知的取舍不是疏漏**，但它是本闸最该被用户知情的代价：
//      要么接受 4% 的卡顿、要么给这几种下游形态开豁免（那要先摸它们的分布，本批没做）。
//   ㈦ **PowerShell 的读文件命令刻意只收 `Select-String`，不收 `Get-Content`/`gc` —— 这是一个
//      显式的范围决定，不是漏了**（2026-08-02 由对抗验证官指出后补写；不写下来就是自相矛盾）。
//      **矛盾在哪**：本闸自称「收词由全域分布定」，而 `get-content` 独立段实测 **351 次**，
//      比已收的 `head`（131）还多；且 **`cat` 在 PowerShell 里就是 `Get-Content` 的别名** ——
//      同一个动作、两种拼法、本闸给出两种判决。**不收的理由**（判断，可被推翻）：
//      ①派单令点名的词表里没有它，扩词是扩范围，属判断档、该由用户拍；
//      ②`Get-Content` 的形态比 `cat` 杂得多（`-Raw`/`-Tail`/`-Encoding`/管道喂 `ConvertFrom-Json`），
//      而本闸已知有 ~4% 硬误伤、逃生阀又只有用户设得了，多收 351 条的误伤代价我估不准；
//      ③dao 另有一条更该先生效的规则：`Get-Content` 读无 BOM 文件按 CP936 解码会把中文
//      **静默**读成乱码（`dao-officer-clauses.md` 编码铁律），那条要的是"别用它读"而不是
//      "改用 Read"，两条掺在一起给建议会互相冲淡。
//      ⇒ **决定交帅/用户**：要收就把 `Get-Content`/`gc` 加进 `SEARCH_TOOL_ALT` 并补真语料负控；
//      在那之前，本闸对 PowerShell 面的覆盖是**部分覆盖**，别当成全覆盖读。
//      （**`Select-String` 那 78 条赋值式漏报是缺陷、已修**，见下面 `segHead` 的注释——
//      它与本条不是一回事：那是"声明收了却没收到"，这条是"声明不收"。）
//
// ── 三条设计取舍，别读成疏漏 ────────────────────────────────────────────────
// ① **逃生阀一律是环境变量，不是 agent 能创建的哨兵文件**。理由就是上面那份实证：
//    凡 agent 自己够得着的旁路，禁令即退化回 0%。env 只有用户能在启动会话前设，
//    agent 在 Bash 里 export 影响不到 hook 进程（hook 的 env 继承自 Claude Code 本体）。
//    G1/G4 连 env 都不给——G1 是用户一票否决且工具已卸载，G4 的正路只是换个路径。
// ② **本 hook 自己崩掉时是放行的（fail-open），不是拦截**。一道会因自身 bug 把
//    Edit/Write 全部拦死的闸没有任何逃生通道 = 会话直接砖掉。代价是「放行」与
//    「通过」在退出码上长得一样 —— 故 catch 里必打一行显眼 stderr，且 `--selfcheck`
//    专门用来把「它到底有没有接上」摆出来（见下）。这是明知的两害相权，不是没想到。
// ③ **判据是近似的，两侧都有反例**。命中判据基本是段首正则 + 路径归一，已知：
//    漏报——`for x in ...; do npm publish; done` 段首不是 npm；`$(...)` 里的命令。
//    误报——`echo "npm publish"` 这类字面量（已上负控断言，见回归网）。
//    刻意不去真解析 shell 语法：那会把一道守卫变成一个解析器，而解析器错了会
//    「违例数与样本数一起归零」（dao-guard-writing.md ②）。
//
// ── 自检 ────────────────────────────────────────────────────────────────────
//   node ccswitch/hooks/dao-hard-gates.js --selfcheck
// 打印：①它在 live settings.json 的 PreToolUse 里注册了没有 ②注册用的 matcher 是什么
// ③**逐闸核对该 matcher 覆不覆盖这道闸要拦的工具名**（matcher 写窄一格 = 那道闸静默
// 零覆盖，而零覆盖与零违例在任何日志里都长得一模一样）。未注册或有闸失覆盖 → exit 1。
//
// 回归网：tests/hard-gates.tests.js（每闸正控+负控双向 + mutation 判别力 + canary 恒等）。
// 真相源：windsurf-dao/ccswitch/hooks/dao-hard-gates.js
// 注册：live `~/.claude/settings.json` 的 PreToolUse（matcher 见 REQUIRED_MATCHER_COVERAGE）。
//       ⚠ **2026-08-02 新增 G6 后，现役 matcher 还差一格**：它当前是
//       `Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|mcp__windows.*|mcp__chrome-devtools__take_screenshot|mcp__playwright__browser_take_screenshot`，
//       **不含 `ScheduleWakeup`** ⇒ G6 此刻零覆盖（`--selfcheck` 会明说并 exit 1）。
//       补法：在该正则末尾追加 `|ScheduleWakeup`（一处追加，不新增 hook 组）。**属用户动作**，
//       且那一下**同时就是对 G6 的批准**（spec 里 G6 标着「呈批项」）。
//       **注册的写入面是 cc-switch DB `providers` 表各 provider 的 `settings_config`，且每个
//       provider 都要写**（切 provider 时 live 被目标 provider 的配置整体覆盖 ⇒ 只写一个等于没写；
//       判据见 dao.md「改配置先认源与投影」，长期对齐机制挂 issue #50）。**属用户动作**——
//       AI 侧写 DB 被权限分类器全路径拦截，这是「AI 不得改自己 hook 注册」的意图级保护。
//       ⚠ `config-sync/common/settings.json`（快照层）与 DB 的 `common_config_claude` 键（镜像层）
//       **都不在下发路径上**：2026-08-02 已注册完毕（#49），此前 PR #43 把注册写满这两层而 live
//       始终未注册，正是这个原因。别再据此建议跑 `dao.bat --direction=down` 来「让它生效」。

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const LIVE_SETTINGS = path.join(HOME, ".claude", "settings.json");

// 归一化：反斜杠转正斜杠 + 去掉末尾斜杠。**不做大小写折叠**——只在比较时按需 toLowerCase，
// 因为要原样回显给被拦的人看（回显一个被改过大小写的路径会让人以为拦错了对象）。
function norm(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

// 把命令拆成"命令段"，让段首判据成立。切分符与 dao-tool-nudge.js 相同（; 换行 && || |），
// **但这里是引号感知的，nudge 那边是裸 split** —— 这处分歧是被一次实测逼出来的，不是随手写的：
// nudge 的裸 `split(/;|\n|&&|\|\|?/)` 碰上多行正文会把正文本身切开，于是
//   git commit -m "[cc] feat: x
//   - [ ] 随后补测试"
// 被切成两段，第二段段首不是 `git commit` ⇒ G5 **对最常见的那种形态直接漏报**
// （回归网首跑当场红，见 tests/hard-gates.tests.js G5 正控）。
// nudge 那边不改：它只认段首命令、不看正文内容，裸 split 对它够用，
// 而两个 hook 的判据本就该各自演进（同 hook-selfcheck 库「只抽形态不抽判据」）。
//
// 这不是一个 shell 解析器，也刻意不做成解析器：只跟踪单/双引号、反斜杠转义与 `$(...)` 深度，
// 认不出 heredoc 正文、嵌套引号里的引号、反引号命令替换。已知漏报面写在头注③。
//
// ── 2026-08-02（G7 批）改了两处，为什么改、对 G3/G5 有没有影响，照直写 ──────────
// ① **返回 `{seg, sep}`，`sep` 是这一段前面那个分隔符**。G7 必须分开
//    「`grep foo file`（独立命令，该用 Grep 工具）」与「`cmd | grep foo`（管道过滤，
//    内置工具替代不了）」——这两者**段首一模一样**，唯一的区别就在前面那个分隔符上。
//    G3/G5 不关心 sep，故留 `shellSegments()` 薄包装原样吐字符串数组，
//    **它们的判定路径一个字符没动**（回归网有一组恒等断言钉着这句话）。
// ② **新增 `$(...)` 深度跟踪，命令替换内部不再切分**。对 G3/G5 是零行为变化：
//    命令替换里的命令**本来**就进不了它们的射程（`echo $(npm publish)` 整条只有一段、
//    段首是 `echo`），头注③早把「`$(...)` 里的命令」写成已知漏报面。真正变的只有
//    `echo "$(ls | head -1)"` 这类——以前在 `|` 处被切开（第二段段首 `head`），
//    现在是一段。**这正是 G7 要的**：命令替换里的 `head -1` 是取一行输出，不是读文件。
function shellSegmentsRaw(cmd) {
  const src = String(cmd || "");
  const out = [];
  let cur = "";
  let quote = null; // null | '"' | "'"
  let sep = "";     // 当前这一段**前面**的分隔符： "" | ";" | "\n" | "&&" | "||" | "|"
  let sub = 0;      // `$(` 深度
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      // 单引号里反斜杠不转义（POSIX 语义）
      if (c === "\\" && quote === '"' && i + 1 < src.length) { cur += c + src[++i]; continue; }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === "\\" && i + 1 < src.length) { cur += c + src[++i]; continue; }
    if (c === "$" && src[i + 1] === "(") { sub++; cur += "$("; i++; continue; }
    if (sub > 0) {
      if (c === "(") sub++;
      else if (c === ")") sub--;
      cur += c;
      continue;
    }
    if (c === "\n" || c === ";") { out.push({ seg: cur, sep }); cur = ""; sep = c === "\n" ? "\n" : ";"; continue; }
    if ((c === "&" && src[i + 1] === "&") || (c === "|" && src[i + 1] === "|")) {
      out.push({ seg: cur, sep }); cur = ""; sep = c === "&" ? "&&" : "||"; i++; continue;
    }
    if (c === "|") { out.push({ seg: cur, sep }); cur = ""; sep = "|"; continue; }
    cur += c;
  }
  out.push({ seg: cur, sep });
  return out
    .map((o) => ({
      // 去掉前导 `cd <path> ` 与 `VAR=x ` 形式的环境变量前缀，让段首露出来
      seg: o.seg.trim().replace(/^cd\s+\S+\s+/, "").replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ""),
      sep: o.sep,
    }))
    .filter((o) => o.seg);
}

// G3/G5 用的薄包装：只要段文本。判定路径与改造前等价，回归网 §恒等 有断言钉着。
function shellSegments(cmd) {
  return shellSegmentsRaw(cmd).map((o) => o.seg);
}

// 未勾选的待办框：行首（或紧跟引号 / 字面 `\n` 转义）的 `- [ ]` / `* [ ]` / `+ [ ]`。
// 已勾的 `- [x]` 是陈述过去，允许。
//
// **为什么要加这个前缀约束，而不是裸匹配** —— 这是把 dao-guard-writing.md ③「检查器的
// 输出不能落在它自己的扫描面内」拿来照自己一遍时发现的：本闸的**判据本身**要被写进 PR body、
// 写进 dao.md、写进 commit message 去解释它拦什么，而那些正文里必然出现反引号包着的
// 那个记号。裸匹配 ⇒ **每一份讨论本条规则的 PR body 都会被本条规则拦下**，而拦下的理由
// 恰恰是「它提到了自己」。这不是理论风险：本批 PR body 首稿当场命中。
//
// 于是判据收窄成「它出现在**待办项该出现的位置**」：真的 checklist 项永远在行首
// （markdown 列表语法要求），而散文里的引用永远跟在反引号/汉字/括号后面。
// 允许的前缀里加引号与字面 `\n`，是因为单行 `--body "- [ ] x"` 这种形态里正文的
// 第一行紧跟在引号后，没有真换行 —— 漏掉它就漏掉了最常见的那种写法。
// **两侧仍有反例**：`echo '- [ ] x'` 之类会误报（但它不在 gh pr / git commit 段里，够不着）；
// 正文里用 HTML 实体或全角写的复选框会漏报。近似，不是判定。
const UNCHECKED_TODO = /(^|\n|\\n|["'])[ \t]*[-*+][ \t]+\[[ \t]\]/;

// 心跳签名：ScheduleWakeup 的 prompt 必须以 `[dao-heartbeat]` 开头（trim 之后，大小写敏感）。
//
// **判据刻意写得死板，因为它两边各有一份**：这里一份，dao-rhythm.js 的 WAKEUP 信号一份。
// 两份必须**逐字节同判**——闸放行的每一个 prompt，rhythm 都要认得出来，否则会出现
// 「过了闸却没注入」这种最难查的静默失败（闸绿、注入无，两者各自看都正常）。
// 故：①同一条正则字面量 ②两边都只对 `String(prompt).trim()` 求值，不做别的归一
// ③回归网 tests/hard-gates.tests.js 有一组**跨文件一致性**断言，把同一批 prompt 同时喂给
// 两个 hook，钉「G6 放行 ⇔ rhythm 注入 WAKEUP」这个双向等价。判据一改而只改一边，那组当场红。
//
// **一处本来会不对齐的地方，是怎么消掉的**：rhythm 有几道前置早退（`^/` 开头的纯 slash 命令、
// strip 后 <4 字符），本闸没有。原可以论证「`[dao-heartbeat]` 开头的 prompt 既不以 `/` 开头
// 也不短于 4 字符 ⇒ 恒不触发」——但那是**推出来的**，不是测出来的，且会随那几道早退被改而失效。
// 故 rhythm 侧把 WAKEUP 判定**排在所有早退之前**、且同样只对 `String(prompt).trim()` 求值，
// 直接不给不对齐留机会。别把那个位置当成随手放的：它是判据对齐的一部分。
const HEARTBEAT_SIG = /^\[dao-heartbeat\]/;

// ── G2 的判据材料（2026-08-02 issue #87 扩面）───────────────────────────────
// 判据出处、真语料分布、「只看目标位」这个取舍的理由与五条已知漏报面，全在头注 G2。
// 这里只放实现，注释只解释**这一行为什么这么写**。

// live 那一份的目录与文件名。**`--selfcheck` 与 mutation 都拿它当靶**（回归网里
// 有一条把这个数组改成不存在的文件名、断言承重正控从 exit 2 掉到 exit 0）。
const G2_LIVE_NAMES = ["settings.json", "settings.local.json"];
const G2_LIVE_DIR = norm(path.join(HOME, ".claude")).toLowerCase();

function g2IsLive(p) {
  if (!p) return false;
  const low = norm(p).toLowerCase();
  return G2_LIVE_NAMES.some((n) => low === `${G2_LIVE_DIR}/${n}`);
}
// 目标位给的是 `~/.claude` **目录**时（`cp x ~/.claude/`），文件名由源的 basename 决定。
function g2IsLiveDir(p) {
  return !!p && norm(p).toLowerCase() === G2_LIVE_DIR;
}

// 把 home 的各种变量形态展开成真实路径。
// **替换一律用函数形式**——HOME 是从环境读来的字符串，直接当替换串会让其中的 `$&`/`$1`
// 被 String.replace 当成引用（本机 HOME 里没有 `$`，但那是运气不是判据）。
function g2Expand(raw, vars) {
  let s = String(raw == null ? "" : raw).trim();
  while (/^(["'])([\s\S]*)\1$/.test(s)) s = s.replace(/^(["'])([\s\S]*)\1$/, "$2");
  // 同一条命令内的字面量变量（见下方 g2VarMap）。`$env` 是命名空间前缀不是变量名，跳过。
  if (vars && vars.size) {
    s = s.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, name) => {
      if (/^env$/i.test(name)) return m;
      const v = vars.get("$" + name);
      return v == null ? m : v;
    });
  }
  const H = () => HOME;
  return s
    .replace(/\$env:HOMEDRIVE\$env:HOMEPATH/gi, H)          // PowerShell 拼接形态
    .replace(/\$\{env:(?:USERPROFILE|HOME)\}/gi, H)         // ${env:USERPROFILE}
    .replace(/\$env:(?:USERPROFILE|HOME)(?![A-Za-z0-9_])/gi, H) // $env:USERPROFILE ← 本次绕过用的就是它
    .replace(/%HOMEDRIVE%%HOMEPATH%/gi, H)                  // cmd 拼接形态
    .replace(/%(?:USERPROFILE|HOME)%/gi, H)                 // %USERPROFILE%
    .replace(/\$\{(?:HOME|USERPROFILE)\}/g, H)              // ${HOME}
    .replace(/\$(?:HOME|USERPROFILE)(?![A-Za-z0-9_])/g, H)  // $HOME（PowerShell 的 $HOME 同义）
    .replace(/^~(?=[\\/]|$)/, H);                           // ~/...
}

// 8.3 短名（`C:/Users/ADMINI~1/...`）在 path 层面解不开——它是文件系统的别名，只能问文件系统。
// **本机不是理论形态**：全量语料普查 27365 条去重命令里 `~<数字>` 路径 **1196 条**
// （scratchpad 一律走 `C:\Users\ADMINI~1\AppData\...`），而 `ADMINI~1` 正是 HOME 的短名。
// 三条刻意的收窄，别读成"顺手加个 realpath"：
//   ㈠ **只在盘符绝对路径 + 真含 `~<数字>` 时才落 I/O** —— 不这么收窄的话，`//server/share/...`
//      会把网络 SMB 超时（可达数十秒）拖进一个 PreToolUse 钩子里，等于用会话卡死换覆盖面。
//   ㈡ **失败一律按原样比**（fail-open，同头注设计取舍②）：文件还不存在是正常的（Write 新建）。
//   ㈢ 整条解不开时退到**目录级** —— 本机实测 `C:\Users\ADMINI~1\.claude` 解得出，
//      故文件名本身是短名（`SETTIN~1.JSON`）以外的形态都接得住。
// ⚠ 它顺带会解开 symlink/junction，这是 realpath 的语义、不是本函数想要的；因为它只在
//   `~<数字>` 路径上跑，而那类路径此前**一律不匹配**，任何改变都只会往"更准"的方向走。
function g2LongPath(p) {
  try { return norm(fs.realpathSync.native(p)); } catch (_) { /* 文件不存在是常态 */ }
  try {
    const i = p.lastIndexOf("/");
    if (i > 0) return norm(fs.realpathSync.native(p.slice(0, i))) + p.slice(i);
  } catch (_) { /* 目录也不存在 ⇒ 按原样比 */ }
  return p;
}

// 绝对路径归一（issue #112 甲⑨）。**改前这一步整个不存在** —— 只有相对路径过 `path.resolve`，
// 绝对路径原样拿去跟 live 精确比对 ⇒ `..` / `.` / `//` / 8.3 短名 / `\\?\` 全部绕开。
// 🔴 **这一格穿透的是改动前就有的 Edit/Write 分支，不是 shell 分支独有** —— 即 G2 自诞生起就漏。
//
// **为什么按根的形态分派两个归一器，而不是统一用一个**（本机实测逐一验过，别改成"更简洁"的写法）：
//   · `path.posix.normalize("C:/../Users/x")` → `Users/x` —— **把盘符当成普通段吃掉了**，
//     于是 `C:/../Users/Administrator/.claude/settings.json` 归一成一个相对路径、彻底比不上 live。
//     用它处理盘符路径 = 把一个漏报换成另一个漏报。
//   · `path.win32.resolve("/../home/x")` → `D:/home/x` —— **凭空补上当前进程的盘符**，
//     在 HOME 是 POSIX 形态的机器上会把路径改写成别的东西。
//   ⇒ 盘符绝对走 win32.resolve（在盘根处夹住 `..`），POSIX 绝对走 posix.normalize（在 `/` 处夹住）。
// **`//` 开头（UNC）刻意不归一**：posix.normalize 会把前导 `//` 折成 `/`，而那个路径要原样回显
// 给被拦的人看，折了会让人以为闸拦错了对象。UNC 共享形态本来就在覆盖面外（见头注 G2 ⑨）。
function g2Canon(s) {
  if (!s) return s;
  // Win32 扩展长度前缀是**纯字符串**前缀，剥它不需要任何 I/O：`//?/C:/…` → `C:/…`
  if (/^\/\/[?.]\/[A-Za-z]:\//.test(s)) s = s.slice(4);
  if (/^[A-Za-z]:\//.test(s)) {
    try { s = norm(path.win32.resolve(s)); } catch (_) { /* 解析不了就按原样比 */ }
    if (/~\d/.test(s)) s = g2LongPath(s);
  } else if (/^\/(?!\/)/.test(s)) {
    try { s = path.posix.normalize(s); } catch (_) { /* 同上 */ }
  }
  return norm(s);
}

// 展开 + 归一 + 相对路径按 cwd 解析。Git Bash 的 `/c/Users/...` 与 cygwin 的
// `/cygdrive/c/...` 都要还原成盘符形态——真语料里备份命令就是用 `/c/...` 写的。
function g2Resolve(raw, cwd, vars) {
  let s = g2Expand(raw, vars);
  if (!s) return "";
  s = norm(s);
  s = s.replace(/^\/cygdrive\/([A-Za-z])(?=\/|$)/, (m, d) => `${d}:`);
  s = s.replace(/^\/([A-Za-z])(?=\/)/, (m, d) => `${d}:`);
  const abs = /^[A-Za-z]:(\/|$)/.test(s) || /^\//.test(s);
  if (!abs) {
    try { s = norm(path.resolve(cwd || process.cwd(), s)); } catch (_) { /* 解析不了就按原样比 */ }
  }
  // ⑨：绝对路径此前直接 return，一步归一都没有 —— 两个分支现在都过这里。
  return g2Canon(s);
}

// 段内 token 化。与 shellSegmentsRaw 是两层不同的事：那层切**命令段**，这层切**参数**。
// 三个刻意的行为：
//   ① **引号里的 `>` 不算重定向**（`echo "a > b"` 只有两个 token）——重定向必须是**未被
//      引号包住**的，否则任何一句提到重定向的文本都会被当成写操作。
//   ② **双引号里的反斜杠不当转义吃掉**：Windows 路径 `"$env:USERPROFILE\.claude\settings.json"`
//      里的 `\.` 若按 POSIX 转义规则处理会变成 `.`，整条路径当场毁掉。只有 `\"` `\\` `\$`
//      这三种在 bash 双引号里真有转义语义的才剥。
//   ③ 重定向符前的 `1`/`2`/`&`（`2>` `&>>`）连着上一个 token，切之前先摘掉。
function g2Tokens(seg) {
  const src = String(seg || "");
  const out = [];
  let cur = "", quote = null, quoted = false;
  const flush = () => { if (cur !== "" || quoted) { out.push({ k: "arg", v: cur }); cur = ""; quoted = false; } };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\" && quote === '"' && (src[i + 1] === '"' || src[i + 1] === "\\" || src[i + 1] === "$")) {
        cur += src[++i]; continue;
      }
      if (c === quote) { quote = null; continue; }
      cur += c; continue;
    }
    if (c === '"' || c === "'") { quote = c; quoted = true; continue; }
    if (c === ">") {
      cur = cur.replace(/[\d&]+$/, "");
      flush();
      if (src[i + 1] === ">") i++;
      out.push({ k: "redir" });
      continue;
    }
    if (c === "<") { flush(); if (src[i + 1] === "<") i++; out.push({ k: "in" }); continue; }
    if (/\s/.test(c)) { flush(); continue; }
    cur += c;
  }
  flush();
  return out;
}

// `(Join-Path A B [C])` 折成一个 token。真语料里这是本机最常见的路径拼法
// （`Join-Path $env:USERPROFILE '.claude\projects'` 在转录里到处都是），不折就解不出。
// 只认**带括号**的形态：裸 `$p = Join-Path a b` 是表达式右值，见头注 G2 漏报面②。
function g2FoldJoinPath(seg) {
  let s = String(seg || "");
  for (let n = 0; n < 4; n++) {
    const m = /\(\s*Join-Path\s+((?:"[^"]*"|'[^']*'|[^\s()]+)(?:\s+(?:"[^"]*"|'[^']*'|[^\s()]+))+)\s*\)/i.exec(s);
    if (!m) break;
    const parts = (m[1].match(/"[^"]*"|'[^']*'|\S+/g) || [])
      .map((x) => x.replace(/^(["'])([\s\S]*)\1$/, "$2"));
    s = s.slice(0, m.index) + '"' + parts.join("/") + '"' + s.slice(m.index + m[0].length);
  }
  return s;
}

// 同一条命令里的**字面量**赋值：`$p = "…"`（PowerShell）/ `P=…`（bash 独立段）。
// 只做一层、只认字面量右值——表达式右值不解析（头注 G2 漏报面②，别读成已覆盖）。
function g2VarMap(segs) {
  const map = new Map();
  for (const raw of segs) {
    const s = String(raw || "").trim();
    const m = /^\$([A-Za-z_]\w*)\s*=\s*("[^"]*"|'[^']*'|\S+)$/.exec(s)
           || /^([A-Za-z_]\w*)=("[^"]*"|'[^']*'|\S+)$/.exec(s);
    if (m) map.set("$" + m[1], m[2].replace(/^(["'])([\s\S]*)\1$/, "$2"));
  }
  return map;
}

// 命令分两类，因为「目标位在哪」不一样：
//   dest-last —— 复制/移动/改名：**末位正参**（或 -Destination/-NewName）是目标，其余是源。
//   all-target —— 写入类：没有「源路径」概念，所有路径参数都是目标。
// **`sc` 刻意不收**：它同时是 `C:\windows\system32\sc.exe`（服务控制），本机
// `Get-Command sc -All` 实测两个都在 —— 与条款「加规则/别名前必须实测该词在其他语境的含义」
// 里对 `sc` 的处置一致，回归网有一条负控钉着它。`ac`/`cpi`/`mi`/`ni`/`rni` 实测只是别名。
const G2_DEST_LAST = new Set(["copy-item", "copy", "cpi", "cp", "move-item", "move", "mi", "mv", "rename-item", "ren", "rni"]);
const G2_ALL_TARGET = new Set(["out-file", "set-content", "add-content", "ac", "tee-object", "tee", "new-item", "ni"]);
// 取值型参数（会吃掉下一个 token）；不在表里的 `-Xxx` 一律当开关，不吃下一个。
const G2_VALUE_PARAM = /^-{1,2}(path|literalpath|lp|filepath|destination|dest|newname|target|value|inputobject|encoding|itemtype|name|filter|include|exclude|delimiter|width|erroraction)$/i;
// 目标位参数：复制类只认这几个；写入类另加 -Path/-LiteralPath/-FilePath。
const G2_DEST_PARAM = /^-{1,2}(destination|dest|newname|target)$/i;
const G2_TARGET_PARAM = /^-{1,2}(path|literalpath|lp|filepath|destination|dest|target)$/i;
// **源**位参数（只对 dest-last 类有意义）。issue #112 甲⑥：`-Path` 具名之后，PowerShell 的
// 参数绑定把**剩下的第一个正参绑到 position 1 = `-Destination`** —— 即"只剩 1 个正参"这件事
// 本身就是目标位存在的证据，而旧判据恰恰在这里早退。
const G2_SRC_PARAM = /^-{1,2}(path|literalpath|lp)$/i;

const g2CmdName = (t) =>
  String(t == null ? "" : t).replace(/^["']|["']$/g, "").replace(/^.*[\/\\]/, "").replace(/\.exe$/i, "").toLowerCase();

// 一个命令段里所有**写目标**的候选路径（已解析）。返回 [{ why, path }]。
function g2WriteTargets(seg, cwd, vars) {
  const folded = g2FoldJoinPath(seg);
  const toks = g2Tokens(folded);
  const out = [];
  const args = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].k === "redir") {
      const nxt = toks[i + 1];
      // `2>&1` 这类 dup 不是文件；`> &foo` 也不是
      if (nxt && nxt.k === "arg" && !/^&/.test(nxt.v)) out.push({ why: "重定向目标", raw: nxt.v });
      continue;
    }
    if (toks[i].k === "in") { i++; continue; }   // 输入重定向/heredoc：读，不是写
    args.push(toks[i].v);
  }

  const head = segHead(folded);
  const destLast = G2_DEST_LAST.has(head);
  const allTarget = G2_ALL_TARGET.has(head);
  if (destLast || allTarget) {
    // 从命令名之后开始读参数（段首可能带 sudo / `$x =` / `&` 之类前缀）
    let start = args.findIndex((a) => g2CmdName(a) === head);
    start = start >= 0 ? start + 1 : 1;
    const positional = [];
    const namedSrcs = [];      // 具名源（`-Path <源>`）的取值 —— basename 展开要用（甲⑦）
    const destRaws = [];       // dest-last 类的**所有**目标位候选（具名 + 位置），供 basename 展开统一走一遍
    for (let i = start; i < args.length; i++) {
      const a = args[i];
      const inline = /^(-{1,2}[A-Za-z][\w-]*)[:=]([\s\S]+)$/.exec(a);
      let name = null, val = null;
      if (inline) { name = inline[1]; val = inline[2]; }
      else if (/^-{1,2}[A-Za-z]/.test(a)) {
        name = a;
        const nv = args[i + 1];
        if (G2_VALUE_PARAM.test(name) && nv != null && !/^-{1,2}[A-Za-z]/.test(nv)) { val = nv; i++; }
      } else { positional.push(a); continue; }
      if (val == null) continue;
      const isTarget = destLast ? G2_DEST_PARAM.test(name) : G2_TARGET_PARAM.test(name);
      if (isTarget) { out.push({ why: `参数 ${name}`, raw: val }); if (destLast) destRaws.push(val); }
      else if (destLast && G2_SRC_PARAM.test(name)) namedSrcs.push(val);
    }
    if (destLast) {
      // 「目标位」存在的门槛（issue #112 甲⑥）：
      //   · 源在正参上（`Copy-Item <源> <目标>`）⇒ 要 ≥2 个正参，单个正参是源
      //     （`Copy-Item x` 是复制到当前目录，没有目标位）。
      //   · 源已被**具名**吃掉（`Copy-Item -Path <源> <目标>`）⇒ **1 个正参就是目标位**。
      //     旧判据一律要 ≥2，于是这种混合形态**一个候选都产不出**。
      //     ⚠ 别读成「具名形态本来就已覆盖」：已覆盖的是**具名目标**（`-Destination`），
      //     这里是**具名源 + 位置目标**，正好落在两边之外。
      const needed = namedSrcs.length ? 1 : 2;
      const hasDestPos = positional.length >= needed;
      if (hasDestPos) {
        out.push({ why: "末位参数（目标位）", raw: positional[positional.length - 1] });
        destRaws.push(positional[positional.length - 1]);
      }
      // 目标位给的是 `~/.claude` **目录**时，落地文件名由源的 basename 决定。
      // issue #112 甲⑦：这一段原先只写在**位置**目标位的分支里，具名 `-Destination <目录>`
      // 拿不到它 ⇒ `Copy-Item .\settings.json -Destination ~/.claude` 整条漏过。
      // 现在具名与位置两种目标位共用同一段展开，源也含具名源。
      const srcs = namedSrcs.concat(hasDestPos ? positional.slice(0, -1) : positional);
      for (const dRaw of destRaws) {
        const destDir = g2Resolve(dRaw, cwd, vars);
        if (!g2IsLiveDir(destDir)) continue;
        for (const src of srcs) {
          const base = norm(g2Expand(src, vars)).split("/").pop();
          if (base) out.push({ why: "目标目录 + 源文件名", raw: `${destDir}/${base}` });
        }
      }
    } else {
      for (const p of positional) out.push({ why: "位置参数", raw: p });
    }
  }
  return out.map((h) => ({ why: h.why, path: g2Resolve(h.raw, cwd, vars) }));
}

// ── G7 的判据材料（段首命令名 → 该改用哪个内置工具）─────────────────────────
// **收哪几个词是被真语料定的，不是照 dao.md 的措辞抄的**（全域普查见头注 G7 ㈠）：
// 32721 条真实 Bash/PowerShell 命令里，独立段段首命中量前二的是 `ls`(3266) 与 `wc`(1032)，
// 两个都**刻意不收** —— Glob 给不出 `ls -la` 的时间戳与权限位，Read 也数不了行数，
// 内置工具替代不了它们。收进来等于凭空制造 4298 次必然误伤，而
// 「生下来就吵的检查一定会被静音」（dao-guard-writing §建护栏前先摸全域分布）。
const SEARCH_TOOL_ALT = {
  grep: "内容搜索 → **Grep 工具**：`pattern`（正则）+ `path` + 可选 `glob`/`type` 过滤 + " +
        "`output_mode`（`content` 出行 / `files_with_matches` 出文件名 / `count` 出计数）+ " +
        "`-n` `-i` `-A` `-B` `-C` `multiline` `head_limit`。它底层就是 ripgrep，跨平台且不吃引号转义的亏。",
  rg: "内容搜索 → **Grep 工具**（它底层就是 ripgrep，`glob`/`type`/`output_mode` 一一对应，无需自己拼命令行）。",
  ag: "内容搜索 → **Grep 工具**（底层 ripgrep，比 ag 快且跨平台）。",
  ack: "内容搜索 → **Grep 工具**（底层 ripgrep）。",
  "select-string": "内容搜索 → **Grep 工具**。PowerShell 的 `Select-String` 在本机会撞引号/编码坑" +
        "（无 BOM 文件按 CP936 解码，中文模式静默不命中且退出码为 0）。",
  find: "找路径 → **Glob 工具**：`pattern` 用 glob 语法（`**/*.test.ts`、`src/**/index.*`），" +
        "结果按修改时间排序。要按内容找用 Grep，要看某个目录里有什么用 Read 读目录。",
  sed: "读文件片段 → **Read 的 `offset`/`limit`**（`sed -n '10,40p' f` ≡ Read(f, offset:10, limit:31)）；" +
       "**改**文件用 **Edit 工具**（`old_string`/`new_string`，或 `replace_all`）——别用 `sed` 生成 diff。",
  head: "读文件开头 → **Read 的 `limit`**（`head -50 f` ≡ Read(f, limit:50)），带行号且可点击跳转。",
  // ⚠️ 这条配方 2026-08-02 换过一次，**换掉的那条是最贵的一条路**：原文写「先 Read 一次
  // 看总行数，再 offset 到尾部」——对小文件那等于**把全文灌进上下文**，正是本条规则要防的事。
  // 现配方两步、零浪费，端到端实测过：`Grep(pattern="^", output_mode="count")` 拿行数，
  // 再 `Read(offset)` 精确取末尾（实测 `dao.md` count=267 与 `wc -l` 逐字相等）。
  tail:
    "读文件末尾 → **两步，别整份读**：" +
    "① `Grep(pattern=\"^\", output_mode=\"count\", path=<文件>)` 拿总行数 N（不返回正文，零浪费）；" +
    "② `Read(<文件>, offset=N-100, limit=100)` 精确取末 100 行。" +
    "要跟随增长中的日志用 `tail -f`（本闸放行），要按字节取用 `tail -c`（也放行）。",
  cat: "读文件 → **Read**（带行号、可点击跳转、大文件用 `offset`/`limit` 分页，不会把全文灌进上下文）。",
};

// 段首取命令名：剥掉 `sudo`/`time`/`command`/`nohup` 前缀与路径、`.exe` 后缀，转小写。
// **刻意不剥 `until`/`while`/`if`/`for`/`do`/`then`** —— 那些构造下的 `grep -q ... ` 是**轮询/判断**，
// 内置工具做不了（Grep 工具没有"等到出现为止"这个语义），保持段首是 `until` 即天然豁免。
// 真语料里这个形态确实存在（`until grep -q "VERIFY_ALL_EXIT=" f; do sleep 10; done`）。
//
// 🔴 **2026-08-02 补 PowerShell 赋值式段首（对抗验证官测出）**：`$x = Select-String …` 的段首
// 被 `$x` 占住 ⇒ `Select-String`（**它在词表里**）实测 78 条整批漏过。这不是"要不要收"的
// 范围问题，是**已声明收了却没真收到** —— 故按缺陷修。同批剥掉 PowerShell 的调用操作符 `&`
// （`$out = & powershell -File x.ps1` 这种形态真语料里有）。
function segHead(seg) {
  let s = String(seg);
  for (let i = 0; i < 4; i++) {
    const t = s
      .replace(/^(?:sudo|time|command|nohup)\s+/i, "")
      // PowerShell 赋值：`$x = ` / `$script:x = `（只剥赋值，不剥比较——`-eq` 不长这样）
      .replace(/^\$[A-Za-z_][\w:]*\s*=\s*/, "")
      // PowerShell 调用操作符
      .replace(/^&\s+/, "");
    if (t === s) break;
    s = t;
  }
  const m = s.match(/^([^\s]+)/);
  if (!m) return "";
  return m[1]
    .replace(/^["']|["']$/g, "")
    .replace(/^.*[\/\\]/, "")   // /usr/bin/grep → grep
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

// stdout 被重定向到**真实文件**（不是 /dev/null / $null / NUL，也不是 `2>&1` 这种 dup）。
// 这类段是在**造一个产物给下一步吃**，而 Grep/Read 只会把结果交回模型上下文、写不出文件
// —— 是内置工具的真实能力缺口，故豁免。`2>/dev/null` 不算（前面是 `2` 不是空白/行首）。
const STDOUT_TO_FILE = /(^|\s)1?>>?\s*(?!&)(?!\/dev\/null)(?!\$null\b)(?!NUL\b)(?!nul\b)\S/;
// heredoc：输入来自内联文本而不是文件（`cat > f <<'EOF'`），Read 无从替代。
//
// 🔴 **2026-08-02 修一个过宽豁免（对抗验证官测出）**：原判据是裸 `/<</`，**匹配整段任意位置**，
// 于是 `grep -n "^<<<<<<<\|^=======" f`（查 git 冲突标记）**正文里**的 `<<` 被当成 heredoc
// ⇒ 整条放行。真语料里这个形态命中 5 条，而其中**真 heredoc 占 0 条** —— 即这条豁免在真实
// 数据上从未接住过它本来要接的东西，只接住了误伤。
// 现锚定真 heredoc 语法：`<<` + 可选 `-` + 可选引号 + 标识符首字符。
// `"^<<<<<<<"` 里 `<<` 后面是 `<`，不是标识符字符 ⇒ 不再命中。
// **两侧仍有反例**（近似不是判定）：漏报——`<<` 后面直接跟数字或别的奇异写法；
// 误报——正文里恰好写着 `<<EOF` 这样的字面串。已知，不再收窄。
//
// ⚠️ **它在真语料上是一条死分支，照直记（2026-08-02 实测）**：拿真 hook 对全库
// **1147 条含 `<<` 的命令**跑原版 vs「把本分支改成永假」的变异体，**判决差集 0 条** ——
// 即每一条都已被 `STDOUT_TO_FILE`（`cat > f <<'EOF'` 里的 `> f`）或别的分支先放行了。
// **仍然保留它**：`sed 's/a/b/' <<EOF` 这种「输入是内联文本、没有输出重定向」的形态是真实
// shell 语义，砍掉就是一个真误伤；但它**只测得到构造语料**，回归网里那条负控因此标着"构造"。
// 别把"它存在"读成"它被真实数据验证过"——这两件事在全绿的输出里长得一样。
const HEREDOC = /<<-?\s*['"]?[A-Za-z_]/;

// ── 各道闸（数量以 GATES.length 为准，此处刻意不写死数字）──────────────────
// 每条 gate：
//   id / why（判据出处，进 stderr）/ escapeEnv（null=无逃生阀）
//   tools（本闸要拦的工具名样本，供 --selfcheck 核对 matcher 覆盖面）
//   test(input) → null 放行 / { what, how } 阻断（what=拦了什么，how=合法路径）

const GATES = [
  {
    id: "G1-windows-mcp",
    why: "dao.md「目·观 · GUI 工具决策树」§🚫 windows-mcp 禁令（用户 2026-07-25 拍板，一票否决；该 MCP 已从用户机器卸载）",
    escapeEnv: null, // 用户一票否决，不给旁路
    tools: ["mcp__windows-mcp__Screenshot", "mcp__windows-mcp__Click", "mcp__windows_mcp__PowerShell"],
    test(input) {
      if (!/^mcp__windows[-_]?mcp?[-_]*__/i.test(input.tool_name || "")) return null;
      return {
        what: `调用了 windows-mcp 工具 \`${input.tool_name}\``,
        how:
          "改走替代分工（dao.md 决策树）：DOM 与截图 → chrome-devtools MCP（WebView 应用）" +
          "或 playwright MCP（纯 Web）；进程与注册表 → 内置 PowerShell 工具；" +
          "文件读写搜索 → 内置 Read / Grep / Glob。" +
          "纯 Win32/无 Web 层且脚本也不可行时，诚实挂账「需用户目视」——**不得为此复活 windows-mcp**。",
      };
    },
  },

  {
    id: "G2-live-settings",
    why: "dao.md Shell 节「settings.json 运行时改动 · 确认门禁」+「改配置先认源与投影」（`~/.claude/settings.json` 是 cc-switch 下发的**投影**——真实下发源是 DB `providers` 表各 provider 的 `settings_config`，下发只挂在 GUI「切换 provider」这个动作上；改投影立即生效但不持久、下次切 provider 即被整体覆盖且无告警）",
    escapeEnv: "DAO_SETTINGS_EDIT_APPROVED",
    // Bash/PowerShell 是 2026-08-02（#87）加的：绕过那条走的就是 PowerShell 工具，
    // 而 `--selfcheck` 之前**照报 G2 覆盖 ✓** —— 它核的是「matcher 覆不覆盖这道闸声明要拦的
    // 工具名」，而这道闸当时压根没声明要拦 shell。**声明面窄，自检就跟着一起瞎**。
    tools: ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "PowerShell"],
    test(input) {
      const tool = input.tool_name || "";
      const cwd = input.cwd || process.cwd();

      // ① 编辑器类：目标文件就是 file_path 本身
      if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
        const ti = input.tool_input || {};
        const raw = ti.file_path || ti.notebook_path;
        if (!raw) return null;
        if (!g2IsLive(g2Resolve(raw, cwd, null))) return null;
        return g2Blocked(`要写用户级 live 配置 \`${norm(raw)}\``);
      }

      // ② shell 类（2026-08-02 #87 新增）：重定向目标 + 写入类命令的**目标位**。
      //    源位一律放行（备份是正路，理由与真语料分布见头注 G2）。
      if (/^(Bash|PowerShell)$/.test(tool)) {
        const cmd = (input.tool_input || {}).command || "";
        const segs = shellSegments(cmd);
        const vars = g2VarMap(segs);
        for (const seg of segs) {
          for (const hit of g2WriteTargets(seg, cwd, vars)) {
            if (!g2IsLive(hit.path)) continue;
            return g2Blocked(
              `要用 shell 写用户级 live 配置 —— ${hit.why}解析出 \`${hit.path}\`` +
              `（这一段：\`${seg.slice(0, 90)}\`）`
            );
          }
        }
        return null;
      }
      return null;

      // 三条合法路径的文案对两个分支是同一份 —— 拦的是同一件事，只是入口不同。
      function g2Blocked(what) {
        return {
          what,
          how:
          "三条正路，按你到底想要什么三选一：" +
          "①**未获用户明确授权** → 不要动它。把改动写成 `_tmp/settings-patch.json`，" +
          "并把会话外的执行命令交给用户（dao.md Shell 节原文即此路）。" +
          "②**只是要让改动持久** → 改的对象错了：这个文件是 cc-switch 下发的投影，" +
          "真实下发源是 **cc-switch DB `providers` 表各 provider 自带的 `settings_config`**。" +
          "正路：请用户在 cc-switch GUI 里编辑 provider 配置（或由用户执行 SQL）写进那一列，" +
          "**且每个 provider 都要改**——切 provider 时 live 会被目标 provider 的配置整体覆盖，" +
          "只改一个等于没改（per-provider 漂移，长期对齐机制挂 issue #50）。" +
          "写 DB 属**用户动作**：AI 侧被权限分类器全路径拦截，这是「AI 不得改自己 hook 注册」的意图级保护。" +
          "⚠ **改 `config-sync/common/settings.json`（git 快照层）或 DB 的 `common_config_*` 键（镜像层）都不会生效**——" +
          "两者都不在下发路径上（#49 实测；PR #43 曾把 hooks 注册写满这两层而 live 始终未注册），" +
          "所以也**不要建议跑 `dao.bat --direction=down/up` 来让它生效**。判据见 dao.md「改配置先认源与投影」。" +
          "③用户已当面授权、且确实要改 live 那一份 → 由**用户**设 `DAO_SETTINGS_EDIT_APPROVED=1` 后重开会话（agent 自己 export 影响不到本 hook）。",
        };
      }
    },
  },

  {
    id: "G3-publish",
    why: "dao.md 帅节留守判据 ㈣「自主边界（永不进自主窗）」（正文见 ccswitch/rules/dao-longwindow.md §心跳对账节 · 丁）——对外发布属不可逆决策 + 需用户在场件",
    escapeEnv: "DAO_PUBLISH_APPROVED",
    tools: ["Bash", "PowerShell"],
    test(input) {
      if (!/^(Bash|PowerShell)$/.test(input.tool_name || "")) return null;
      const cmd = (input.tool_input || {}).command || "";
      for (const seg of shellSegments(cmd)) {
        // --dry-run / -WhatIf 是真演练，放行（负控在回归网里钉着）
        if (/--dry-run\b|-WhatIf\b/i.test(seg)) continue;
        const m =
          /^gh\s+release\s+(create|delete|upload)\b/.test(seg) ? seg :
          /^(npm|pnpm|yarn|bun)\s+publish\b/.test(seg) ? seg :
          /^cargo\s+publish\b/.test(seg) ? seg :
          null;
        if (m) {
          return {
            what: `要跑对外发布命令 \`${m.slice(0, 80)}\``,
            how:
              "对外发布是不可逆的、且是「需用户在场」件：" +
              "①先向用户说明要发什么版本、发到哪、怎么回滚，拿到当场同意；" +
              "②要先演练就加 `--dry-run`（本闸对 `--dry-run` 放行）；" +
              "③用户同意后由**用户**设 `DAO_PUBLISH_APPROVED=1` 再跑，或直接由用户执行该命令。" +
              "自主窗内一律不发布——`自主边界` 的原文是「永不进自主窗」。",
          };
        }
      }
      return null;
    },
  },

  {
    id: "G4-screenshot-path",
    why: "dao.md Shell 节「截图路径强制」：浏览器 MCP 截图**必须**落 `<项目根>/_tmp/qa/<context>/`，禁项目根或其他非 `_tmp/` 位置",
    escapeEnv: null, // 正路只是换个路径，给逃生阀等于把规则删了
    tools: [
      "mcp__chrome-devtools__take_screenshot",
      "mcp__playwright__browser_take_screenshot",
    ],
    test(input) {
      if (!/take_screenshot$/.test(input.tool_name || "")) return null;
      const ti = input.tool_input || {};
      // 不给路径 = 内联返回图片、不落盘 ⇒ 与本条无关，放行
      const raw = ti.filePath || ti.filename || ti.path || "";
      if (!raw) return null;
      const p = norm(raw);
      if (/(^|\/)_tmp\/qa\//i.test(p)) return null;
      return {
        what: `截图要落到 \`${p}\`，不在 \`_tmp/qa/\` 下`,
        how:
          "改成 `<项目根>/_tmp/qa/<context>/<type>-<description>.png`。" +
          "`<项目根>` 指**被操作的目标项目**（不是会话 cwd），`<context>` 是本次走查的名字；" +
          "命名规格见 dao-design standards.md §截图规格。项目 `.gitignore` 里 `**/_tmp/` 已兜住，" +
          "落别处的截图会进版本库或散在系统 temp 里找不回来。",
      };
    },
  },

  {
    id: "G5-readonly-todo",
    why: "dao.md「言 · 名之则」§只读载体禁写待办：PR body / commit message 等**事实只读**的载体禁用 `- [ ]`（`- [x]` 允许，它陈述过去）——复选框承诺「以后有人来勾」，而那个账本没有写入端",
    escapeEnv: "DAO_ALLOW_READONLY_TODO",
    tools: ["Bash", "PowerShell"],
    test(input) {
      if (!/^(Bash|PowerShell)$/.test(input.tool_name || "")) return null;
      const cmd = (input.tool_input || {}).command || "";
      const cwd = input.cwd || process.cwd();
      for (const seg of shellSegments(cmd)) {
        const isPrBody = /^gh\s+pr\s+(create|edit)\b/.test(seg);
        const isCommit = /^git\s+commit\b/.test(seg);
        if (!isPrBody && !isCommit) continue; // issue / comment 是可编辑载体，不在射程内

        // ① 正文直接写在命令里
        if (UNCHECKED_TODO.test(seg)) {
          return mk(seg, "命令里的正文");
        }
        // ② 正文在文件里（gh --body-file/-F、git commit -F/--file）
        const fm = seg.match(/(?:--body-file|--file|\s-F)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
        if (fm) {
          const rel = fm[1] || fm[2] || fm[3];
          const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
          let body = null;
          try { body = fs.readFileSync(abs, "utf8"); } catch (_) { body = null; }
          // 读不到就放行：拿「我没读到」当「它违规了」是本体系点名的那种错
          // （L31「我没看到 ≠ 它不存在」）。这是明写的漏报面，不是遗漏。
          if (body != null && UNCHECKED_TODO.test(body)) {
            return mk(seg, `正文文件 \`${rel}\``);
          }
        }
      }
      return null;

      function mk(seg, where) {
        return {
          what: `${where}里有未勾选的 \`- [ ]\`，而目标载体（${/^git/.test(seg) ? "commit message" : "PR body"}）是只读的`,
          how:
            "三选一：①这几项**你已经做了** → 改成 `- [x]`（陈述过去，允许）；" +
            "②**还没做** → 从这里删掉，写进一个**可编辑**的账本（issue / TODO.md / 问题树面板），" +
            "只读载体里只留指针（`见 <文件>#<锚点>` 或 `#<issue 编号>`）；" +
            "③**这一项本批不适用** → 直接删行，别留个没人会来勾的框。" +
            "（确有理由要原样保留——例如正文在引用一段模板样例——由用户设 `DAO_ALLOW_READONLY_TODO=1`。）",
        };
      }
    },
  },

  {
    id: "G6-heartbeat-signature",
    why:
      "docs/specs/dao-rewrite-202608.md 分流表第 3 类「心跳投递机器化」——" +
      "心跳 prompt 必须以 `[dao-heartbeat]` 开头，这是 dao-rhythm.js 的 WAKEUP 信号**唯一**的识别面；" +
      "没有签名 ⇒ 那一轮不注入长窗留守四句 + `Read dao-longwindow.md §心跳对账节`，" +
      "而心跳轮是这份载荷唯一的投递时刻（dao.md 帅节长窗存根「投递通道」）",
    escapeEnv: "DAO_WAKEUP_UNSIGNED_OK", // 见头注 G6 ㈣：误伤面实测为零但不等于不存在
    tools: ["ScheduleWakeup"],
    test(input) {
      if ((input.tool_name || "") !== "ScheduleWakeup") return null;
      const ti = input.tool_input || {};
      // 收窗调用豁免：`{"stop":true}` 没有 prompt、也不产生下一轮，签它没有意义。
      // **只认布尔 true**，不认 "true"/1 —— 放宽这一格等于给出一个 agent 自己够得着的旁路
      // （设计取舍①：凡 agent 自己够得着的旁路，禁令即退化回 0%）。
      if (ti.stop === true) return null;
      const p = String(ti.prompt == null ? "" : ti.prompt).trim();
      if (HEARTBEAT_SIG.test(p)) return null;
      return {
        what:
          p
            ? `ScheduleWakeup 的 prompt 没有以 \`[dao-heartbeat]\` 开头（现在开头是 \`${p.slice(0, 40)}…\`）`
            : "ScheduleWakeup 既没有 `stop:true`，也没有 prompt —— 这一轮唤醒无从签名、也无从对账",
        how:
          "把 `[dao-heartbeat]` 原样加在 prompt 最前面（大小写敏感，前面不要有别的字符），" +
          "例如：`[dao-heartbeat] 高性能目标窗心跳。对账：① …`。" +
          "**它不是装饰**：dao-rhythm.js 靠这个前缀认出「这一轮是心跳唤醒」，" +
          "据此把长窗留守四句 + 「醒来第一动作 Read `ccswitch/rules/dao-longwindow.md` §心跳对账节」" +
          "注入到你醒来的那一轮；漏了签名，那一轮就什么都收不到，而「没收到」和「收到了没照做」" +
          "在日志上长得一模一样。" +
          "真要收窗就调 `ScheduleWakeup{stop:true}`（本闸对它放行）——" +
          "但别拿它绕开签名：dao.md 续力节的原话是「除了那一轮明确 stop:true，每一轮都要有心跳」。" +
          "（若确有一个**不由你构造 prompt** 的合法调用方——如内置 `/loop`——由**用户**设 " +
          "`DAO_WAKEUP_UNSIGNED_OK=1`；实测语料里这种形态出现 0 次，见本文件头注 G6 ㈣。）",
      };
    },
  },

  {
    id: "G7-shell-search",
    why:
      "dao.md「八、工具使用铁律（Grep-first）」：搜索用 Grep/Glob、读大文件用 Read 的 offset/limit，" +
      "不用 Bash/PowerShell 的 grep/find/rg/sed/head/tail/cat/Select-String —— " +
      "Grep 底层 ripgrep 跨平台快且内存友好，shell 版在 Windows 下常见引号/转义/编码/卡死问题",
    escapeEnv: "DAO_SHELL_SEARCH_OK",
    tools: ["Bash", "PowerShell"],
    test(input) {
      if (!/^(Bash|PowerShell)$/.test(input.tool_name || "")) return null;
      const cmd = (input.tool_input || {}).command || "";
      for (const { seg, sep } of shellSegmentsRaw(cmd)) {
        // 豁免①：管道过滤（`ps | grep x`、`git log | head -20`）。这一段吃的是上一条命令的
        // stdout，不是文件 —— 内置工具结构上替代不了。判据就是它前面那个分隔符是 `|`。
        if (sep === "|") continue;
        const head = segHead(seg);
        const alt = SEARCH_TOOL_ALT[head];
        if (!alt) continue;
        const rest = seg.slice(seg.toLowerCase().indexOf(head) + head.length);
        // 豁免②：stdout 落到真实文件 —— 在造给下一步吃的产物，内置工具写不出文件
        if (STDOUT_TO_FILE.test(rest)) continue;
        // 豁免③：heredoc（`cat > f <<'EOF'`）—— 输入是内联文本，不是文件
        if (HEREDOC.test(rest)) continue;
        // 豁免④：这几个不是"读"，是别的动作，替代工具对不上
        if (head === "sed" && /(^|\s)-i(\s|$)|(^|\s)--in-place\b/.test(rest)) continue;      // 原地改文件
        // 🔴 2026-08-02 从这张清单里删掉了 `-prune`（对抗验证官测出）：
        // **`-prune` 是谓词不是动作** —— `find . -path ./node_modules -prune -o -name X -print`
        // 是**纯文件搜索**、100% 可 Glob 替代（Glob 本来就不进 node_modules 那类目录），
        // 却因为它在这张清单里而被整条豁免。真语料命中 8 条。
        // 留在清单里的三个才是真动作：`-exec`/`-execdir`/`-ok` 起子进程、`-delete` 改文件系统。
        if (head === "find" && /(^|\s)-(exec|execdir|ok|delete)(\s|$)/.test(rest)) continue; // 动作而非查找
        if ((head === "tail" || head === "head") && /(^|\s)-(f|F|-follow)(\s|$)/.test(rest)) continue; // 流式跟随
        // 豁免⑤：`-c` 字节模式（`tail -c 3000 f`）—— **Read 是按行的，没有字节语义**，
        // 这是内置工具的结构性缺口，不是用法问题。真语料里 114 例（tail 92 / head 22）。
        if ((head === "tail" || head === "head") && /(^|\s)-c(\s|=|\d)/.test(rest)) continue;
        return {
          what: `\`${head}\` 被当成主命令跑（这一段：\`${seg.slice(0, 90)}\`）`,
          how:
            alt +
            "\n\n合法的 shell 用法本闸不拦，别误以为这几个命令被禁了：" +
            "**①管道过滤**（`ps | grep node`、`node t.js | head -40`——吃的是上一条命令的输出，不是文件）；" +
            "**②输出落文件**（`grep -c x f > _tmp/n.txt`——在造给下一步吃的产物）；" +
            "**③命令替换**（`v=$(head -1 f)`）；**④`sed -i` 原地改 / `find -exec` / `tail -f`**；" +
            "**⑤`git log --grep=` / `git log -S` 这类自带参数**（段首是 `git`，本闸看都不看）；" +
            "**⑥`until grep -q ...; do ...; done` 这类轮询**（段首是 `until`）。" +
            "\n判据是**段首 + 前一个分隔符**，不是「命令里出现过这个词」。",
        };
      }
      return null;
    },
  },
];

// --selfcheck 要核对的覆盖面：闸 id → 该闸要拦的工具名样本
const REQUIRED_MATCHER_COVERAGE = GATES.map((g) => ({ id: g.id, tools: g.tools }));

// ── --selfcheck：把「它到底接上没有」摆出来 ─────────────────────────────────
// 「一道没跑的闸」与「一道跑了且零违例的闸」在任何日志里都长得一样，
// 所以覆盖面必须能被独立问一次，而不是靠「没报错」推断。
function selfcheck() {
  const lines = [];
  let bad = 0;

  let matchers = [];
  let regNote = "";
  try {
    const s = JSON.parse(fs.readFileSync(LIVE_SETTINGS, "utf8"));
    const pre = (s.hooks && s.hooks.PreToolUse) || [];
    for (const grp of pre) {
      const cmds = (grp.hooks || []).map((h) => String(h.command || ""));
      if (cmds.some((c) => /dao-hard-gates\.js/.test(c))) {
        matchers.push(grp.matcher == null ? "*" : String(grp.matcher));
      }
    }
    regNote = matchers.length
      ? `✓ 已注册于 PreToolUse，matcher=${matchers.map((m) => JSON.stringify(m)).join(" , ")}`
      : `✗ 未注册：${LIVE_SETTINGS} 的 hooks.PreToolUse 里没有引用 dao-hard-gates.js 的 command。` +
        `本 hook 此刻**一道闸都不生效**。修法：请用户把这组 PreToolUse 注册写进 cc-switch DB ` +
        `\`providers\` 表**每个** provider 的 \`settings_config\`（GUI 编辑 provider 配置或执行 SQL）——` +
        `切 provider 会用目标 provider 的配置整体覆盖 live，只写一个 provider 会在下次切换时静默失效（issue #50）。` +
        `⚠ 写 git 快照层 config-sync/common/settings.json 或 DB 的 common_config_* 镜像层**不会让它生效**（两层都不在下发路径上，#49 实测）。`;
    if (!matchers.length) bad++;
  } catch (e) {
    regNote = `✗ 读不到 live settings.json（${LIVE_SETTINGS}）：${e.message} —— 无从判定是否注册，按未注册计。`;
    bad++;
  }
  lines.push(regNote);

  // 逐闸核 matcher 覆盖面。matcher 是正则串，宿主侧按正则匹配工具名。
  for (const { id, tools } of REQUIRED_MATCHER_COVERAGE) {
    const uncovered = tools.filter((t) => !matchers.some((m) => matcherCovers(m, t)));
    if (!matchers.length) {
      lines.push(`  · ${id}：未注册 ⇒ 覆盖面无从谈起`);
    } else if (uncovered.length) {
      bad++;
      lines.push(`  ✗ ${id}：matcher 覆盖不到 ${uncovered.join(" , ")} ⇒ **这道闸静默零覆盖**`);
    } else {
      lines.push(`  ✓ ${id}：matcher 覆盖 ${tools.length} 个工具名样本`);
    }
  }

  lines.push(`共 ${GATES.length} 道闸；逃生阀（仅用户可设）：` +
    GATES.filter((g) => g.escapeEnv).map((g) => g.escapeEnv).join(" , ") + "。");

  process.stdout.write(lines.join("\n") + "\n");
  process.exit(bad ? 1 : 0);
}

function matcherCovers(matcher, tool) {
  if (matcher === "*" || matcher === "") return true;
  try {
    // 宿主对 matcher 是全串匹配还是子串匹配未被文档担保，两种都试过才算覆盖
    const re = new RegExp(matcher);
    if (re.test(tool)) return true;
    return new RegExp("^(?:" + matcher + ")$").test(tool);
  } catch (_) {
    return false;
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
if (process.argv.includes("--selfcheck")) selfcheck();

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
} catch (_) {
  process.exit(0); // 读不到/解析不了输入 → 放行（见头注②）
}

try {
  for (const gate of GATES) {
    const hit = gate.test(input);
    if (!hit) continue;
    if (gate.escapeEnv && process.env[gate.escapeEnv] === "1") continue;

    process.stderr.write(
      `\n🔒 [dao-hard-gates ${gate.id}] 这一步被拦下了。\n\n` +
      `拦的是什么：${hit.what}\n\n` +
      `判据出处：${gate.why}\n\n` +
      `合法路径：${hit.how}\n\n` +
      (gate.escapeEnv
        ? `逃生阀：环境变量 ${gate.escapeEnv}=1（**只有用户设得了**——你在 Bash 里 export 影响不到本 hook 进程）。\n`
        : `本闸无逃生阀：它拦的事没有合法例外。\n`) +
      `为什么是一道闸而不是一句提醒：禁令类规则写在文本里的实测遵守率是 0%（arxiv 2607.26819），` +
      `所以这一条被搬到了 agent 之外。别绕它——绕过去就等于这条规则不存在。\n`
    );
    process.exit(2);
  }
} catch (e) {
  // fail-open（见头注②）：一道会因自身 bug 拦死一切的闸没有逃生通道。
  // 但绝不静默——放行与通过在退出码上长得一样，这行 stderr 是唯一的区分。
  process.stderr.write(
    `[dao-hard-gates] ⚠ 守卫自身出错，本次**放行**（fail-open）：${e && e.stack ? e.stack : e}\n` +
    `⇒ 这一刻它没有在守。跑 \`node ccswitch/hooks/dao-hard-gates.js --selfcheck\` 看接线，并修掉这个错。\n`
  );
  process.exit(0);
}

process.exit(0);
