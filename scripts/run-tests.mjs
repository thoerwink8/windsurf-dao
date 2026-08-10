// run-tests.mjs — windsurf-dao 自有测试的聚合入口
//
// ── 为什么有这个文件 ─────────────────────────────────────────────────────────
// 本仓无 test runner 框架，测试各自 `node tests/xxx.tests.js` 独立可跑。问题在于
// **没有任何地方枚举得全**：CLAUDE.md 的「自检与测试」段长期只列了两个 .ps1 测试，
// 三套 JS 测试（dao-rule-echo / dao-compact-log / settings-drift）从未被列进去
// ⇒ 写了却没人跑，与 D5 修的那个「写了没挂」是同一个病，只是换了个身位。
//
// 故这里**不维护清单，而是扫目录**：`tests/*.tests.js` 一律纳入。手维护的清单会过期
// （本仓已被过期清单咬过两次：marshal-guard 14 天、compact-log 6 周），扫出来的不会。
//
// **`.ps1` 测试从 2026-08-08（issue #179）起由本入口代跑**，不再只是列出来提醒。
// 此前那句「本入口不代跑，只如实列出并提示」把「跑不了」说了出来，但说出来之后仍然没人跑：
// 合并链的 `-VerifyCommand` 拿到 exit 0 就放行，而那 6 套 PowerShell 测试**一套都没进那个 0**。
// ⇒ 「跑不了要说出来」是下限，不是终点；能代跑就代跑，跑不了的那部分上退出码通道（见下）。
//
// ══════════════════════════════════════════════════════════════════════════
// ── 分层：默认层 / 环境敏感层（2026-08-04 · issue #116）─────────────────────
// ══════════════════════════════════════════════════════════════════════════
// 有一类断言**不制造污染，却被别人的正常活动污染**：它对**别人拥有的机器级可变状态**
// 做不变量断言（真实 `~/.claude/settings.json`、cc-switch GUI 的库、指向共享主仓的命令）。
// 前两种互染机制的修法（夹具名加唯一后缀 / 假家目录，见 PR #115）对它**结构上不适用**
// —— 它要断言的就是「真实那一份现在长什么样」，换成假的就什么都没测。
//
// 这类断言留在日常回归网里只有两个结局：偶发红（于是所有人学会「红了先重跑」，这道闸
// 从此形同虚设），或者被整体删掉（于是真退化也没人管）。故本入口把它**分层**：
//
//   默认层（`node scripts/run-tests.mjs`）
//     跑全部测试文件，但声明了环境敏感层的文件会**自己 defer 掉**那几节断言。
//   环境敏感层（`node scripts/run-tests.mjs --env`）
//     把 `--env` 透传给每个测试文件，那几节照跑。**要求串行环境**：没有别的官在跑测试、
//     cc-switch GUI 没在写库、没人在改 `~/.claude/settings.json`。
//
// 🔴 **「没跑」与「跑了全过」必须在退出码上分得开** —— 这正是被分层的那些断言自己要治的病
// （零检出 ≠ 零存在）。一个分层机制若让默认跑法照旧返回 0，等于把那个病搬到了分层机制上。
// 判据抄自 mousse-cli `scripts/lib/verify-exit.ps1` 的四态退出码（那里的 `2` 专门表示
// 「无失败但有硬闸被跳过」）。
//
// ── 退出码契约（本文件是唯一真相源）────────────────────────────────────────
//
//   **六态**（2026-08-08 订正：此前这张表与 CLAUDE.md 都写「五态」，漏了 5 —— 而代码里
//   `EXIT_NO_TESTS_DIR` 与回归网 ⑥ 的断言从一开始就有它。头注是唯一真相源却漏记了一态，
//   于是「六态」这件事只有读代码的人知道。issue #179 对抗官坐实，本批补记。）
//
//   | 码 | 含义                                             | 消费方该怎么读        |
//   |----|--------------------------------------------------|-----------------------|
//   | 0  | 全跑、全过：**且零 defer、零未跑 PS 套**（只有 --env 拿得到） | 可以放行     |
//   | 1  | 有测试文件红（node 侧或 PowerShell 侧），**或某套断言条数跌破基线** | 拦住，去读失败详情 |
//   | 2  | 无红，但有断言被 defer / 有 PS 套没跑 —— **本次没跑完** | 默认跑法的正常码 |
//   | 3  | 用法错误（不认识的参数）——**一套都没跑**           | 拦住，改命令行        |
//   | 4  | 分层自检失败：静态声明与运行期 defer 计数对不上，或某 PS 套 exit 0 却零输出 | 拦住，先修分层机制 |
//   | 5  | 找不到 tests/ 目录（**一套都没跑**，与「有 defer」刻意不共用 2） | 拦住，核 --tests-dir |
//
//   优先级：3 / 5（开跑前判） > 1 > 4 > 2。
//   ⚠ **1 从 2026-08-10 起多了一个来源**（issue #268 · 用户拍板 issue #70 第 9 件）：
//     「一条断言都没红，但这一套比基线少跑了 N 条」也走 1。理由见下面那一节 ——
//     那种情形下**没有任何断言失败**，若不并进 1，它会掉进 0 或 2 里，与「全跑全过」不可区分。
//   ⚠ **谓词写 `=== 0`，别写 `<= 2`** —— 那个区间把 1（真失败）也放了进来。
//   ⚠ **别把 2 当成绿**。`@(0,2)` 这种放行谓词一写，分层就退化成「接受偶发红」的另一种
//     形态（issue #116 里那条最危险的路），只是危害从"无视红"变成"无视没跑"。
//     没有任何程序在核这一点 —— 这是本机制已知最弱的一环，照直写在这里。
//
// ── 自检半边：为什么不能只数运行期的 DEFER ─────────────────────────────────
// 「一个检查器数到 0 个违例，和它根本没看到样本，输出长得一模一样」（dao-guard-writing）。
// 若只靠解析各测试自报的 `DEFER=n`：解析一坏 ⇒ 全场 defer=0 ⇒ 退出码 0 ⇒ 「没跑」又变回
// 「跑了全过」，而输出看起来完全正常。
// 故这里跑**三套互不共享实现的判据**，任意两套对不上即警报（exit 4）：
//   ① 静态：扫每个测试文件**源码头部**有没有 `@dao-test-tier: env` 标记（读文件字节）
//   ② 运行期·结构化：解析该文件 stdout 汇总行里的 `DEFER=n`（读一个聚合数字）
//   ③ 运行期·笨计数器：数该文件 stdout 里有几行以 `DEFER ` 开头的明细
//      （形态照抄 `ccswitch/scripts/check-mutation-anchor.mjs` 的独立笨计数器对拍：
//       主解析瞎掉时给一个专门的非零码，而不是静默 0）
// ① 与 ②③ 的**输入源**不同（文件字节 vs 进程输出）；② 与 ③ 同源但**两套写法**——
// ② 读一个聚合数字、③ 数一堆明细行，聚合那半算错时明细那半仍是对的。
// 五种不一致都判红：标记在而没 defer（标记过期 / defer 机制坏了）· defer 了却没标记
// （标记漏加 ⇒ 静态那半从此看不见它）· 有明细行却没 DEFER= 字段（人看得见、机器看不见）·
// **②③ 两个数对不上**（聚合与明细至少有一个错了）· `--env` 下仍在 defer（`--env` 没透传到）。
//
// ⇒ **测试文件的契约**：报 `DEFER=n` 就必须同时打印 n 行 `DEFER <名字>  ->  <理由>` 明细。
//    这不只是给自检用的 ——「只报个数字等于没报」，人得知道**哪几组**没跑。
//
// ══════════════════════════════════════════════════════════════════════════
// ── PowerShell 层的契约（2026-08-08 · issue #179）──────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// ① **自声明标记，不是入口硬编码清单**：`.tests.ps1` 头部 60 行内出现
//    `# @dao-test-tier: env` ⇒ 该套**整套只在 `--env` 跑**；无标记者默认层也跑。
//    刻意不在本文件里写「哪几套算慢」的清单 —— 本仓的手维护枚举被咬过三次。
//
//    🔴 **PS 标记与 JS 标记的语义不同，别当同一个东西读**（故判定也**另起一份**，不共用）：
//      · JS 侧 `// @dao-test-tier: env` = 「这个文件**内部有几节断言**在默认层自己 defer 掉」
//        —— 文件照跑，跑完报 `DEFER=n`，粒度是**断言组**。
//      · PS 侧 `# @dao-test-tier: env` = 「**整套**在默认层压根不起进程」
//        —— 粒度是**整个文件**，它不产生也不可能产生 `DEFER=n`。
//    为什么 PS 侧只能做到整套粒度：那几套是独立可直跑的 PowerShell 脚本，没有共同的
//    「defer 某几节」协议，也不该为了这个去改它们的正文（改每一份脚本 vs 加几行标记）。
//    ⇒ 两侧的计数**各走各的字段**：JS 的进 `defer=/deferfiles=/declared=`，
//      PS 的进 `psfiles=/psred=/psskip=`。混在一起会让「哪一半没跑」重新变得看不出来。
//
//    ①′ **「块注释外才算声明」这一判据的底座是 PowerShell 官方 parser**
//    （2026-08-09 · issue #203 起判据，PR #213 返工换底座）。判定不在本文件里做，
//    外包给 `scripts/scan-ps-tier-marker.ps1`（`Parser::ParseFile` 的 token 流）。
//    **两次翻车才走到这一步，两次都是近似判据，方向相反**：
//      · 假阳性（PR #200）：旧版只锚「行首 # + 标记名」，不问那一行是不是身处块注释内 ——
//        `.NOTES` 里一句描述句被当成真声明，整套被静默判成 env 层、全仓零红。
//        当时的应对是把散文**搬出**头 60 行窗口，那是文本约定，下一次编辑就会打破它。
//      · 假阴性（PR #213 首版）：改成自写的开合记号扫描，**不认行注释、也不认字符串
//        字面量** ⇒ 一行「注释里提到开块记号」或一句 `$re = '<#'` 就把其后整段变成死区，
//        死区里的**真**标记一律失效。对抗实测：往 `tests/dao-pr-merge.tests.ps1` 第 2 行
//        插一条语法完全合法的标记 ⇒ 不生效，而 116 条回归断言一条都不红。
//    ⇒ **补漏—再漏的解法是换底座，不是把近似补得更细**：「这一行是不是块注释」有唯一
//      权威答案，那个答案属于 PowerShell 自己。**本文件不许再长出第三版自写扫描。**
//    ⚠ 换底座**没有**把「标记落在块注释里」变成合法声明（那正是 #200 要治的病）；
//      它改的是**那件事从此会出声**：判定器另报一个 `prose` 位，入口据此打一行提示，
//      指出「这条标记不生效、想生效就挪到块注释之外」。此前它是静默的。
//    ⚠ **JS 侧未同步换底座，这是刻意留白不是漏做**：本仓 `tests/*.tests.js` 头部普查未发现
//    散文提及会落在 `//` 紧跟 `@dao-test-tier:` 这个精确形态的活口（既有写法都在 `@` 前多插了
//    文字，如"上面那行 `@dao-test-tier: env`"）。**照直写它现在的不对称**：PS 侧有权威
//    parser 兜底，JS 侧仍是一条裸正则、块注释里的散文照样能冒充声明（今天零活口是普查
//    结论，不是护栏）。若未来出现 JS 侧同型事故，处方是同一个（找 JS 那侧的权威解析），
//    不是重新发明一版记号扫描。
//
// ② **没跑的 PS 套上退出码通道**（F1）：`psskip > 0` ⇒ 最终退出码**至少 2**。
//    此前默认层那个恒 2 是**挂在 dead-gates 一个文件的 DEFER 上**的偶然 —— 那个文件哪天
//    摘了标记，默认层就悄悄变回 0，而 PS 套照旧没跑。现在两条路各自都能把 2 顶起来。
//
// ③ **spawn 形态**：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File <绝对路径>`，
//    cwd 钉仓根。每套超时 `PS_TIMEOUT_MS`（默认 300s，可用环境变量 `DAO_PS_TIMEOUT_MS`
//    覆盖 —— 那个口子是**给回归网注入短超时用的**，不是给人调松的）。
//    ⚠ **「真套超时会怎样」只有合成夹具的证据，2026-08-08 显式接受**（issue #186 第三格之一，
//    与 ④ 那格并列）：回归网 ㈤ 用 `Start-Sleep` 夹具 + 注入短超时验到了三条（超时判红 ·
//    打孤儿进程/半写沙盒警告 · 汇总表打 `⏱超时` 标），但那是**造出来的**超时；真套里
//    **没有一套会自然超时**（最慢那套实测 55-81s vs 300s 闸）⇒「某套真卡住时这条路径长什么样」
//    结构上拿不到真语料。要造它就得往一套真测试里塞死循环 —— 那是把生产测试改坏去喂闸。
//    ⇒ 照直写这是**已知缺口不是已验**：合成夹具证的是「判红这条代码路径通」，
//    没证「真套卡住时子进程那一侧的行为与夹具一致」。
//
// ④ **红判据**（F2）：`status !== 0 || error || signal` ⇒ 红。超时走 `error`/`signal` 那一格，
//    **判红不判跳过**，并额外打一句警告：`spawnSync` 不杀进程树 ⇒ 可能残留孤儿 powershell
//    进程与半写的 `_tmp` 沙盒，**下一次跑同一套可能因此失败**（那个红的成因在上一次跑里）。
//    ⚠ **「不杀进程树」这一格 2026-08-08 显式接受，不做 `taskkill /T`**（issue #186 第三格）：
//    收拾它要拿 `spawnSync` 返回的 pid 去杀整棵树，而那一刻 node 已经 SIGTERM 过它、
//    pid 可能已被系统回收并复用 ⇒ 一条「清理」命令有概率杀掉无关进程，**代价方向比它治的
//    病更差**。现状是 fail-loud（判红 + 上面那三行指名 `_tmp` 沙盒与残留进程），不是静默 ——
//    接受的是「留下垃圾要人收」，没有接受「静默」。
//
// ⑤ **PS 层总预算 900s**：串行累计墙钟超过它 ⇒ 剩余套判「未跑」（逐套打明细）、退出码至少 2。
//    预算是给「某套卡住把整个入口拖死」兜底的，不是性能指标。
//    注入口 `DAO_PS_BUDGET_MS`（形态同 ③ 的 `DAO_PS_TIMEOUT_MS`，**给回归网注入短预算用，
//    不是给人调松的旋钮**）—— 2026-08-08 · issue #186 补。**它补的是一格真空**：这个数
//    此前是硬编码常量、没有任何注入口，而真套合计才 ≈100-150s（issue #186 当时 6 套实测）⇒ 回归网**结构上**造不出
//    「预算耗尽」场景。PR #185 对抗官把这道闸整个关掉（`if (false && spent >= …)`），
//    全场 `PASS=95 FAIL=0` **一条都没红**。有了注入口，「预算闸被改坏」才必红。
//
// ⑥ **零输出自检**（F4）：某套 `status === 0` 而 stdout 去空白后为空 ⇒ 计入 `tierProblems`
//    （exit 4 通道）。「exit 0 + 零输出」与「绿」必须分得开 —— 一个没跑到任何断言就返回 0 的
//    脚本（被 `-ExecutionPolicy` 挡掉、头部就 return、文件被清空）在退出码上与全过一模一样。
//
// ⑦ **计数解析**：沿用既有的 `PASS=(\d+)\s+FAIL=(\d+)`；取不到只标「未报计数」，
//    判定以真退出码为准（现状机制，本批不新造）。**多数套不打这个汇总行** —— 具体哪几套
//    以汇总表里那几行「（未报计数）」为准，此处刻意不写数字（这一句被咬过一次：写死「6 套里
//    有 4 套」，套数变成 7 之后两处数字一起过期）。
//
// ══════════════════════════════════════════════════════════════════════════
// ── 断言条数基线（2026-08-10 · issue #268，用户拍板 issue #70 第 9 件）──────
// ══════════════════════════════════════════════════════════════════════════
// 治的病：**绿灯可能只是「有几条根本没跑」**。本仓有一类写法是
//   `check("锚点恰好命中 1 次", n === 1); if (n === 1) { …一批真有判别力的断言… }`
// 锚点漂了之后，**前置断言红 1 条，壳里那一批整块不执行**（不是变红）⇒ 日志上
// `FAIL=1` 而 `PASS` 从 659 掉到 653。**只盯 FAIL 数发现不了少跑 6 条**，
// 而读日志的人会把它读成「就一个小毛病」。
// 上面第 ⑦ 条早就在逐套解析 `PASS=(\d+)\s+FAIL=(\d+)` —— **缺的从来不是数字，是基线**：
// 没有任何东西回答「这一套今天本该有多少条」。
//
// 机制三句话：
//   ① **基线是派生物**：`scripts/assertion-baseline.json`，由
//      `node scripts/run-tests.mjs [--env] --write-baseline` 从**真实一跑**的计数写出来。
//      手改无效（下次 `--write-baseline` 覆盖），但它**不会自己更新** —— 见下面「代价」。
//   ② **分层各记一个数**：默认层与 `--env` 的条数本来就不同（defer 掉的不计入 PASS、
//      标了 env 的 PS 套整套不跑）⇒ 一个数会让两层互相污染。故每套两格：`default` / `env`。
//      **拿不到数的那一格写字符串说明**（`未报计数` / `本层不跑`），不写 0 也不留空 ——
//      `0` 会变成一个恒真的闸，留空会让「这套没人守」看不出来（同 `[#官抗-调用点覆盖率]`
//      的分母为 0 那一格：照直写比编一个数好）。
//   ③ **比的是 `PASS + FAIL`（本次跑了几条），不是 `PASS`**。用 PASS 会把「正常的红」
//      也判成「少跑了」，而那是另一件事、已经有 1 号退出码在管。
//
// 🔴 **它自己的「我是不是瞎了」那一半**（`ccswitch/rules/dao-guard-writing.md` 第 2 条）：
//   一个基线档里若一套都对不上（改名、路径 key 写法变了、JSON 被清空成 `{"suites":{}}`），
//   本闸会**一条都不查而全绿** —— 与「全都守住了」逐字节相同。故：真跑了 ≥1 套、
//   基线档也读到了，却**零匹配** ⇒ 走 `tierProblems`（exit 4），不是静默放行。
//   （这一格与同批 issue #272 的「存在性闸不是基数闸」是同一个病的两处，刻意用同一个判据。）
//
// 🔴 **它现在还关不住的那一格，照直写（issue #293）**：上面 ② 那条「不写 0、不留空」的原则
//   **只在写基线那一侧兑现了，读的那一侧没有**。某套本次一条计数都没报（`obs.total == null`，
//   例如有人加了句提前 `process.exit(0)`）时，即便基线那一格明明记着数字，也一律并进
//   `baseBlind` 那张观察清单 ⇒ **退出码 0**。⇒ **跑了 0 条与跑够 N 条，在这道闸上不可区分**，
//   而那正是本段通篇要治的病。⚠️ 别把「有这道闸」读成「少跑一定会被逮到」。
//
// ⚠️ **代价照直写，用户拍板时明知**：这是**多一个必须有人同步的派生物**，而它自己也会漂。
//   配的三个触发器（都不是「靠人记得」）：
//     ㈠ **正当缩减 ⇒ 当场判红**：删测试 / 合并断言之后不重生成基线，下一跑就红，
//        报文直接给重生成命令。红的成本 ≈ 一条命令，比静默失守便宜。
//     ㈡ **基线老得没用了 ⇒ 观察线出声**：实际条数高出基线 `BASELINE_STALE_SLACK` 以上时
//        打一行「这一套的闸已经形同虚设（掉 N 条以内它都看不见）」。
//     ㈢ **名册双向对账在回归网里**（`tests/assertion-baseline.tests.js`）：新套没进基线、
//        基线里留着已删的套，**都判红**。那道对账不跑测试、只比对目录与 JSON，秒级。
//   ⚠ **阈值 `BASELINE_STALE_SLACK` 是 AI 自定的初值、待用户拍板**（`dao-legislation.md`：
//     定及格线属判断档）。它只影响㈡那条观察线，不进退出码。
//
// ── 跑法 ────────────────────────────────────────────────────────────────────
//   node scripts/run-tests.mjs                默认层（预期 exit 2）：JS 全跑 + 无标记 PS 套跑
//   node scripts/run-tests.mjs --env          含环境敏感层 + 全部 PS 套（全绿 exit 0）；要求串行环境
//   node scripts/run-tests.mjs --list         只列清单不跑，带分层标注（js/ps 两侧都标）
//   node scripts/run-tests.mjs [--env] --write-baseline
//                                             用**本次这一跑**的条数重写基线档的那一层
//                                             （**红的那几套逐套跳过**、其余照写：从红的一跑
//                                              取条数等于把缺陷焊进基线。首次生成要跑两轮才收敛）
//   node scripts/run-tests.mjs --tests-dir P  换一个测试目录（**给本入口的自测用**，
//                                             见 tests/run-tests-tier.tests.js）
//   环境变量 DAO_ASSERTION_BASELINE           把基线档指到别处（**给回归网注入合成基线用的**，
//                                             形态与理由同 DAO_PS_TIMEOUT_MS 那几个）

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// 退出码常量：本文件与 tests/run-tests-tier.tests.js 共用语义，避免两处各写一份魔数。
const EXIT_OK = 0;
const EXIT_RED = 1;
const EXIT_DEFERRED = 2;
const EXIT_BAD_USAGE = 3;
const EXIT_SELFCHECK = 4;
const EXIT_NO_TESTS_DIR = 5;

// ── PowerShell 层的两个时间闸（见文件头 PS 契约 ③⑤）────────────────────────
// 单套超时：默认 300s ≈ 本仓最慢那套（clause-structure 实测 55-81s，同机不同次波动）的 3.7-5.5 倍余量。
// `DAO_PS_TIMEOUT_MS` 这个口子是**给回归网注入短超时用的**（造一个必然超时的夹具，
// 否则「超时判红」这条只能靠读代码相信）——不是给人把闸调松的旋钮。
const PS_TIMEOUT_MS = (() => {
  const raw = process.env.DAO_PS_TIMEOUT_MS;
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 300_000;
})();
// PS 层总预算：串行累计墙钟超过它，剩余套判「未跑」。兜的是「某套卡住把整个入口拖死」，
// 不是性能指标 —— 实测合计 ≈100-150s（同机不同次波动：选型批 149s、落地批 101s、对抗批三采 100.8-104.1s；三次采样时都是 6 套），900s 至少 6 倍余量。
// `DAO_PS_BUDGET_MS` 与上面那个口子同型、同理由：**给回归网注入一个毫秒级预算用的**，
// 因为真 6 套合计离 900s 差一个数量级 ⇒ 「预算耗尽」这个场景**结构上**造不出来。
// 🔴 **它有意做成「直接取环境值」而不是 `Math.min(env, 900_000)`（只减不增），照直写为什么**：
//   min 那一版更好听（「不是调松旋钮」这句话就落到机器上了），但它**加进来的那个分支
//   结构上无法端到端验证** —— 它只在注入值 > 900s 时才起作用，而要观察到差别就得造一个
//   真的花掉 900s 以上的夹具，那正是本注入口存在的理由所在（造不出来）。
//   一个没有断言守着的分支，与它想防的那句自陈是同一个东西（dao-guard-writing：数到 0
//   和没看到样本，输出一模一样）⇒ 与其加一个自己也没人验的闸，不如**把话说清楚**：
//   **调大这个值等于把「某套卡住拖死入口」的兜底关掉**，它不是给「闸太紧」用的。
//   形态与 `DAO_PS_TIMEOUT_MS` 保持逐字一致，也是刻意的：两个口子一个语义，别让读者
//   以为其中一个「更安全」。
const PS_BUDGET_MS = (() => {
  const raw = process.env.DAO_PS_BUDGET_MS;
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 900_000;
})();

// ── 参数解析（不认识的参数一律 fail-fast，一套都不跑）──────────────────────
// 判据同 verify-exit.ps1 边界②：`-Skip` 是显式意图，不兑现显式意图没有「大致对」的余地。
// 这里同理 —— 打错的参数若被静默忽略，你以为跑了 --env，实际跑的是默认层。
const KNOWN_FLAGS = new Set(["--list", "--env", "--all", "--write-baseline"]);
const rawArgs = process.argv.slice(2);
let testsDirArg = null;
let testsDirGivenEmpty = false;
const flags = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--tests-dir") {
    const v = rawArgs[i + 1];
    if (v == null || v.startsWith("--")) { testsDirGivenEmpty = true; } else { testsDirArg = v; i++; }
    continue;
  }
  if (a.startsWith("--tests-dir=")) {
    const v = a.slice("--tests-dir=".length);
    if (!v) { testsDirGivenEmpty = true; } else { testsDirArg = v; }
    continue;
  }
  flags.push(a);
}
const unknownFlags = flags.filter((f) => !KNOWN_FLAGS.has(f));
// `--list --write-baseline` 是**互斥意图**：--list 不跑任何测试，也就没有条数可写。
// 静默忽略其中一个，就会出现「我以为重生成了基线，其实只列了个清单」——同上一段的判据。
const listAndWrite = flags.includes("--list") && flags.includes("--write-baseline");
if (unknownFlags.length || testsDirGivenEmpty || listAndWrite) {
  const why = unknownFlags.length
    ? "不认识的参数：" + unknownFlags.join(", ")
    : (listAndWrite
      ? "--list 与 --write-baseline 不能同时给（--list 一套都不跑，写不出条数）"
      : "--tests-dir 后面没给路径");
  process.stderr.write("[run-tests] 用法错误 —— " + why + "\n");
  process.stderr.write("  合法参数：--list / --env（别名 --all）/ --write-baseline / --tests-dir <路径>\n");
  process.stderr.write("  **一套测试都没跑**（打错的参数不静默忽略，否则你以为跑了 --env，实际跑的是默认层）\n");
  // 末行的字段集与正常收尾那条**必须一致**（两处独立字面量，改一处忘一处就会让只读末行的
  // 消费方在用法错误时解析不到新字段）。issue #179 追加 psfiles/psred/psskip 时同批加在这里，
  // issue #268 追加 baselow/basegate 时同理。
  process.stdout.write(`RUN_TESTS_SUMMARY exit=${EXIT_BAD_USAGE} tier=none files=0 red=0 pass=0 fail=0 defer=0 deferfiles=0 declared=0 selfcheck=n/a psfiles=0 psred=0 psskip=0 baselow=0 basegate=off\n`);
  process.exit(EXIT_BAD_USAGE);
}
const ENV_TIER = flags.includes("--env") || flags.includes("--all");
const LIST_ONLY = flags.includes("--list");
const WRITE_BASELINE = flags.includes("--write-baseline");

const DEFAULT_TESTS_DIR = path.join(ROOT, "tests");
const TESTS_DIR = testsDirArg ? path.resolve(testsDirArg) : DEFAULT_TESTS_DIR;

// ── 断言条数基线的三个常量（契约正文见文件头「断言条数基线」那一节）─────────
const BASELINE_PATH = process.env.DAO_ASSERTION_BASELINE
  || path.join(ROOT, "scripts", "assertion-baseline.json");
// **闸什么时候是必须的**：跑真 tests/ 目录时（日常与合并链走的都是这条），
// 或回归网显式注入了基线档路径时。**只有「拿合成 tests 目录自测、又没注入基线」这一种**
// 才允许关闸 —— 而且关了要出声（见下面 `basegate=off` 那一行），不许静默。
const BASELINE_REQUIRED = !!process.env.DAO_ASSERTION_BASELINE || TESTS_DIR === DEFAULT_TESTS_DIR;
// 实际条数高出基线这么多 ⇒ 打一行「这道闸已形同虚设」。**AI 自定初值，待用户拍板**
// （`dao-legislation.md`：定及格线属判断档）。只进观察线，恒不进退出码。
const BASELINE_STALE_SLACK = 20;
const BASELINE_TIER_KEY = ENV_TIER ? "env" : "default";

if (!fs.existsSync(TESTS_DIR)) {
  process.stderr.write(`[run-tests] 找不到 tests/ 目录：${TESTS_DIR}\n`);
  process.exit(EXIT_NO_TESTS_DIR);
}

const entries = fs.readdirSync(TESTS_DIR).sort();
const jsTests = entries.filter((f) => f.endsWith(".tests.js"));
const psTests = entries.filter((f) => f.endsWith(".tests.ps1"));
// 既不是 .tests.js 也不是 .tests.ps1 的文件：可能是命名不合规的测试，宁可报出来让人看一眼
const strays = entries.filter((f) => !f.endsWith(".tests.js") && !f.endsWith(".tests.ps1"));

// ── 自检半边 ①：静态标记扫描（读文件字节，与运行期输出解析不共享任何实现）──────
// 只扫头部若干行：标记是「文件级声明」，写在头注里；扫全文会把正文里提到这个标记的
// 文字（比如本机制自己的回归网）也算进来 —— 检查器的输出不该落在它自己的扫描面内。
const TIER_MARKER_HEAD_LINES = 60;
const TIER_MARKER_RE = /^[ \t]*\/\/[ \t]*@dao-test-tier:[ \t]*env\b/m;
function declaresEnvTier(file) {
  try {
    const head = fs.readFileSync(path.join(TESTS_DIR, file), "utf8")
      .split(/\r?\n/).slice(0, TIER_MARKER_HEAD_LINES).join("\n");
    return TIER_MARKER_RE.test(head);
  } catch (_) {
    return false;   // 读不到就是读不到；它随后会以「跑不起来」的形态变红
  }
}
const declaredEnv = new Set(jsTests.filter(declaresEnvTier));

// ── PowerShell 侧的标记扫描：**外包给 PowerShell 官方 parser，不在这里自写** ──────
// 判据与两次翻车的完整因果在 `scripts/scan-ps-tier-marker.ps1` 头注（唯一真相源），
// 这里只留 node 侧要知道的三件：
//   ① **两侧刻意各写一份**：JS 标记 = 「文件内部分断言 defer」，文件照跑；
//      PS 标记 = 「整套只在 --env 起进程」。语义不同（见文件头 PS 契约 ①），共用一份会
//      诱使后来者把两侧的计数也并进一个字段，那正好把「哪一半没跑」重新弄没。
//   ② **BOM 不再由这边操心**：`Parser::ParseFile` 自己按 BOM 定编码。此前这里手剥 U+FEFF，
//      是因为 `readFileSync(...,"utf8")` 会把它留成首字符、让行首锚**当场落空而毫无症状**
//      （本仓 .ps1 里除 `link-codex` 外均带 UTF-8 BOM——刻意不写套数：写死的数字已过期两次，以 `--list` 实扫为准）。
//   ③ **判定跑不起来 ⇒ fail-closed 且出声**（见下面 `scanPsTier()` 里的 `bad()`）：
//      「这套没标记」与「我没看成」在退出码上分不开，那正是本文件通篇在治的病。
const PS_TIER_SCANNER = process.env.DAO_PS_TIER_SCANNER
  || path.join(HERE, "scan-ps-tier-marker.ps1");
// 那个注入口同 `DAO_PS_TIMEOUT_MS` 那两个的形态与理由：**给回归网用的**（把它指到一个
// 不存在或必崩的脚本，才验得到「判定器自己坏掉」那条路），不是给人换实现的旋钮。
const PS_SCAN_TIMEOUT_MS = 60_000;

// 分层自检的问题清单：**在这里就建好**，因为标记判定失败是第一个可能往里写的东西
// （它原先建在下面运行期那一段，而那时判定早已发生过了）。
const tierProblems = [];

// 一次 spawn 判定全部 PS 套（真仓实测 ≈0.3s，含 powershell 启动；套数以 `--list` 实扫为准），
// 返回 { declared:Set<file>, prose:string[] }。判定不可信时改判 fail-closed 并往
// tierProblems 里写一条 ⇒ 退出码走 4 那一档，而不是悄悄把 env 套拉回默认层跑。
function scanPsTier(files) {
  if (!files.length) return { declared: new Set(), prose: [] };   // 没有 PS 套就不起进程
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS_TIER_SCANNER,
    "-HeadLines", String(TIER_MARKER_HEAD_LINES), ...files.map((f) => path.join(TESTS_DIR, f))];
  const r = spawnSync("powershell.exe", args,
    { encoding: "utf8", cwd: ROOT, timeout: PS_SCAN_TIMEOUT_MS });
  const out = String(r.stdout || "");
  const lines = out.split(/\r?\n/);
  const head = /^PSTIER_SCAN v1 head=(\d+) files=(\d+)$/.exec(lines[0] || "");
  const declared = new Set();
  const prose = [];
  const bad = (why) => {
    tierProblems.push(`PS 分层标记判定没跑成（${why}）⇒ 「哪几套算 env 层」这次是不可信的。`
      + `按 fail-closed 处理：${files.length} 套 PS 测试一律当作**已声明**（默认层一套都不跑），`
      + `不是当作没标记 —— 后者会把带 winget install / 动真 %USERPROFILE% 的那几套悄悄跑起来。`
      + `${r.error ? ` spawn 错误：${r.error.message || r.error.code}；` : ""}`
      + `${r.status != null && r.status !== 0 ? ` 判定器 exit ${r.status}；` : ""}`
      // ⚠ **刻意不往这里贴子进程的 stderr 原文**：PS 5.1 写 stderr 按 `[Console]::OutputEncoding`
      //   （跟控制台代码页走），node 这边按 utf8 解 ⇒ 中文当场成乱码，贴出来只会让人去查
      //   一个不存在的编码问题（`ccswitch/rules/dao-powershell.md` 第三条记的正是这个坑）。
      //   改为给一条**自己重跑**的命令，原文去那里看。
      + `${String(r.stderr || "").trim() ? " 它写了 stderr（内容按控制台代码页编码，这里读不准）；" : ""}`
      + ` 自己重跑看原文：powershell -NoProfile -ExecutionPolicy Bypass -File ${PS_TIER_SCANNER}`
      + ` -HeadLines ${TIER_MARKER_HEAD_LINES} ${path.join(TESTS_DIR, files[0])}`);
    return { declared: new Set(files), prose: [] };
  };
  if (r.error || r.status !== 0) return bad("判定器进程没能正常退出");
  if (!head || Number(head[2]) !== files.length) return bad("输出的表头对不上（文件数或格式不符）");
  if (Number(head[1]) !== TIER_MARKER_HEAD_LINES) return bad("判定器用的扫描窗口与本入口不一致");
  if (!lines.includes("PSTIER_SCAN_END")) return bad("输出没有收尾标记 —— 它多半跑到一半断了");
  let seen = 0;
  for (const line of lines) {
    const m = /^(\d+) decl=([01]) prose=([01]) perr=(-?\d+)$/.exec(line);
    if (!m) continue;
    const idx = Number(m[1]);
    if (idx >= files.length) return bad("输出里的下标越界");
    seen++;
    if (m[2] === "1") declared.add(files[idx]);
    if (m[3] === "1") prose.push(files[idx]);
    if (Number(m[4]) !== 0) {
      // 语法有错 / 文件没读成：**不吞**。它不改判定（token 流是尽力而为的），但要让人看见——
      // 一个读不成的文件被判「无声明」，与它真的没标记长得一样。
      process.stdout.write(`  ⚠ tests/${files[idx]}：PowerShell parser 报`
        + `${Number(m[4]) < 0 ? "这份文件没读成" : ` ${m[4]} 条语法错误`}（本次按判定结果`
        + `${m[2] === "1" ? "已声明" : "无声明"}处理，但这份文件本身先得能跑起来）\n`);
    }
  }
  if (seen !== files.length) return bad(`只解析出 ${seen} 行结果，少于 ${files.length} 个文件`);
  return { declared, prose };
}
const psTierScan = scanPsTier(psTests);
const declaredEnvPs = psTierScan.declared;

process.stdout.write(`[run-tests] tests/ 下发现 ${jsTests.length} 套 node 测试、${psTests.length} 套 PowerShell 测试\n`);
process.stdout.write(`[run-tests] 本次层级：${ENV_TIER ? "--env（含环境敏感断言 + 全部 PS 套，要求串行环境）" : "默认层（环境敏感断言不跑、标了 env 的 PS 套不跑 → 预期 exit 2）"}`
  + `；声明了环境敏感层的文件 ${declaredEnv.size} 个（node）/ ${declaredEnvPs.size} 个（pwsh）\n`);
if (strays.length) {
  process.stdout.write(`  ⚠ 另有 ${strays.length} 个不符 *.tests.{js,ps1} 命名的文件，未纳入：${strays.join(", ")}\n`);
}

// ── 「标记写进了块注释里」的可见提示（PR #213 对抗官 F1 那一格的 fail-loud 半边）───
// PowerShell 认块注释正文是散文，那里的标记**不生效** —— 而「想标 env 却标进了块注释」
// 与「随口写了一句散文」在盘上长得一模一样。差别只在代价：前者会让一套本该摘出去的测试
// 被真的跑起来。故这里**只出声、不判红**（`[#官通-闸位判断]`：这是「人该判断一件事」，
// 不是「代码错了」—— 文档里正当地引用这个语法也会落在这个形态上）。
// 🔴 它不是散文，回归网 ⑪ 有断言钉着它出声；那条断言就是它的退役触发器。
if (psTierScan.prose.length) {
  process.stdout.write(`  ⚠ 有 ${psTierScan.prose.length} 份 .tests.ps1 在头 ${TIER_MARKER_HEAD_LINES} 行的`
    + `**块注释内部**出现了层级标记字面量 —— PowerShell 认为那是散文，**它不生效**：\n`);
  for (const f of psTierScan.prose) {
    process.stdout.write(`    · tests/${f}  ⇒ 若本意是声明，把它挪到块注释**之外**的独立 # 行`
      + `（通常是文件第一个 <# 之前）；若本意就是散文，忽略本行\n`);
  }
}

if (LIST_ONLY) {
  for (const f of jsTests) process.stdout.write(`  node  tests/${f}${declaredEnv.has(f) ? "   [有环境敏感层 · 默认不跑那几节]" : ""}\n`);
  for (const f of psTests) process.stdout.write(`  pwsh  tests/${f}${declaredEnvPs.has(f) ? "   [标了 env · 整套默认层不跑]" : ""}\n`);
  // 判定跑不成时这张清单是**猜的**（fail-closed 把每一套都标成 env）——不许拿 0 退出去，
  // 否则「列不出来」与「列出来了」在退出码上又分不开（本文件通篇治的就是这个）。
  if (tierProblems.length) {
    process.stdout.write(`\n✗ 分层自检失败 ${tierProblems.length} 条 —— 上面这张分层清单不可信：\n`);
    for (const p of tierProblems) process.stdout.write(`    · ${p}\n`);
    process.exit(EXIT_SELFCHECK);
  }
  process.exit(EXIT_OK);
}

const results = [];
for (const f of jsTests) {
  const t0 = Date.now();
  // cwd 钉在仓根，**不继承调用者的**（2026-08-04 实测：从别的仓的目录敲这个入口，
  // subagent-clauses 那套里一条依赖 process.cwd() 的断言会红，而同一份代码在仓根下全绿
  // ⇒ 红绿取决于你在哪个目录敲的命令，且失败信息里没有任何东西指向 cwd）。
  const argsForChild = ENV_TIER ? ["--env"] : [];
  const r = spawnSync(process.execPath, [path.join(TESTS_DIR, f), ...argsForChild], { encoding: "utf8", cwd: ROOT });
  const ms = Date.now() - t0;
  const out = String(r.stdout || "");
  // 从各测试自己的汇总行取断言数（格式统一为 `=== 汇总: PASS=n FAIL=m ===`，
  // 有环境敏感层的文件再追加 ` DEFER=k`）；取不到不当成通过，只标「未报计数」，
  // 判定仍以真退出码为准 —— 但对**声明了环境敏感层**的文件，取不到 DEFER 本身就是
  // 分层自检失败（见下面第 ② 半），不是「那一格没事」。
  const m = out.match(/PASS=(\d+)\s+FAIL=(\d+)(?:\s+DEFER=(\d+))?/);
  // ③ 笨计数器：不解析任何结构，只数「以 DEFER 开头的明细行」有几行。
  // 它与上面那个聚合字段是两套写法，对拍不上就说明至少有一半算错了（见文件头自检半边）。
  const deferLines = (out.match(/^[ \t]*DEFER[ \t]/gm) || []).length;
  results.push({
    file: f,
    code: r.status,
    pass: m ? Number(m[1]) : null,
    fail: m ? Number(m[2]) : null,
    defer: m && m[3] != null ? Number(m[3]) : null,
    deferLines,
    ms,
    out,
    err: String(r.stderr || ""),
  });
}

// ── PowerShell 层：串行代跑（见文件头 PS 契约）──────────────────────────────
// 串行是硬要求，不是保守。**理由 2026-08-08（issue #187）换了一个，别读成原来那个**：
// 原文写的是「本仓有两套用**固定** `_tmp/` 路径当沙盒（dao-pr-merge / pr-body-scan），
// 并行跑必互踩」——那两套已随机化并回到默认层，那条理由对它们不再成立。
// ⚠ 而**同一句话原本就是不完整的**：`dao-secrets` 也用固定 `_tmp/dao-secrets-test`，
// 它是第三套（它另有更硬的 env 理由：对真 `%USERPROFILE%`/`%APPDATA%` 做机器级断言，
// 那一格随机化治不了）。「两套」那个数字从写下那天起就漏了一个。
// ⇒ 现在的理由：①`dao-secrets` 仍是固定沙盒 + 真机器级状态 ②各套都起真 `powershell.exe`
// 与真 `git` 子进程，并行只是把墙钟换成 CPU 争抢 ③总预算（下面 ㈡）是按串行累计算的。
// **刻意不在这里列「哪几套是固定沙盒」的清单** —— 本仓手维护的枚举被咬过三次，
// 而这一句自己就是刚被咬的那一次。
const psResults = [];
{
  const psT0 = Date.now();
  for (const f of psTests) {
    // ㈠ 标记跳过：整套不起进程（默认层 + 有标记）
    if (!ENV_TIER && declaredEnvPs.has(f)) {
      psResults.push({ file: f, ranAt: false, why: "头部标了 @dao-test-tier: env ⇒ 只在 --env 跑" });
      continue;
    }
    // ㈡ 预算跳过：串行累计墙钟已超总预算，剩下的一律判「未跑」而不是排队等
    const spent = Date.now() - psT0;
    if (spent >= PS_BUDGET_MS) {
      // 报文里必须**带得出归因**：「标记跳过」与「预算跳过」在汇总表上都是一行 `⊘ 未跑`，
      // 而处置完全不同（前者去跑 --env，后者去查是谁把预算吃光了）。故这一行显式否认前者。
      psResults.push({ file: f, ranAt: false,
        why: `PS 层总预算 ${PS_BUDGET_MS}ms 已用尽（已花 ${spent}ms）⇒ 本次未跑 `
          + `—— **不是标记跳过**，是排在前面的某套吃掉了预算（多半有一套卡住了）` });
      continue;
    }
    const t0 = Date.now();
    const r = spawnSync("powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(TESTS_DIR, f)],
      { encoding: "utf8", cwd: ROOT, timeout: PS_TIMEOUT_MS });
    const ms = Date.now() - t0;
    const out = String(r.stdout || "");
    // 红判据（F2）：三条通道任一命中即红。`status` 单看不够 —— 超时与被信号打断时
    // `status` 是 null，而 `null !== 0` 虽然也为真，但把 error/signal 显式写出来是为了
    // **报文能说清是哪一种**（超时要额外警告孤儿进程，普通红不需要）。
    const timedOut = !!(r.error && String(r.error.code || r.error.message).includes("ETIMEDOUT")) || r.signal === "SIGTERM";
    const red = r.status !== 0 || !!r.error || !!r.signal;
    // 计数解析沿用现状：多数套不打这个汇总行，取不到标「未报计数」、判定看退出码（见头注 ⑦）。
    const m = out.match(/PASS=(\d+)\s+FAIL=(\d+)/);
    psResults.push({
      file: f, ranAt: true, code: r.status, red, timedOut,
      signal: r.signal || null,
      errMsg: r.error ? String(r.error.message || r.error.code) : null,
      pass: m ? Number(m[1]) : null,
      fail: m ? Number(m[2]) : null,
      emptyOut: !red && out.trim() === "",
      ms, out, err: String(r.stderr || ""),
    });
  }
}

// 失败者的完整输出要打出来，否则「哪一条红了」得重跑一遍才知道
for (const r of results) {
  if (r.code !== 0) {
    process.stdout.write(`\n──── 失败详情 tests/${r.file}（exit ${r.code}）────\n`);
    process.stdout.write(r.out);
    if (r.err.trim()) process.stdout.write(`[stderr]\n${r.err}\n`);
  }
}
for (const r of psResults) {
  if (!r.ranAt || !r.red) continue;
  process.stdout.write(`\n──── 失败详情 tests/${r.file}（pwsh · exit ${r.code}${r.signal ? ` signal=${r.signal}` : ""}）────\n`);
  process.stdout.write(r.out);
  if (r.err.trim()) process.stdout.write(`[stderr]\n${r.err}\n`);
  if (r.errMsg) process.stdout.write(`[spawn error] ${r.errMsg}\n`);
  if (r.timedOut) {
    process.stdout.write(`  ⚠ 这一套是**超时**被打断的（上限 ${PS_TIMEOUT_MS}ms），判红不判跳过。\n`);
    process.stdout.write(`    ⚠ **spawnSync 不杀进程树**：被 kill 的只是 powershell.exe 本身，它起的子进程可能还活着，\n`);
    process.stdout.write(`      而这套测试的 _tmp 沙盒此刻多半是半写状态 ⇒ **下一次跑同一套可能因此失败，成因在这一次**。\n`);
    process.stdout.write(`      收拾干净再重跑：核一遍残留的 powershell 进程，并清掉该套用的 _tmp 目录。\n`);
  }
}

process.stdout.write("\n──── 汇总表（判定以真退出码为准）────\n");
let totalPass = 0, totalFail = 0, totalDefer = 0, bad = 0;
const deferringFiles = [];
for (const r of results) {
  if (r.pass != null) { totalPass += r.pass; totalFail += r.fail; }
  if (r.defer) { totalDefer += r.defer; deferringFiles.push(r); }
  if (r.code !== 0) bad++;
  const counts = r.pass != null ? `PASS=${String(r.pass).padStart(3)} FAIL=${r.fail}` : "（未报计数）";
  const deferTag = r.defer ? ` DEFER=${r.defer}` : "";
  const tierTag = declaredEnv.has(r.file) ? " ⚑env" : "";
  process.stdout.write(`  ${r.code === 0 ? "✓" : "✗"} exit=${String(r.code).padStart(2)}  ${counts}${deferTag}  ${String(r.ms).padStart(5)}ms  tests/${r.file}${tierTag}\n`);
}
process.stdout.write(`  ── ${results.length} 套 node 测试：${results.length - bad} 过 / ${bad} 红；断言合计 PASS=${totalPass} FAIL=${totalFail}${totalDefer ? ` DEFER=${totalDefer}` : ""}\n`);

// ── PowerShell 层进同一张汇总表（前缀 pwsh）──────────────────────────────────
// 刻意与 node 那几行同表：分两张表的话，「PS 那半这次跑没跑」又变成得往下翻才看得到的事。
let psRed = 0, psRan = 0, psNotRun = 0, psPass = 0, psFail = 0;
const psSkipped = [];
for (const r of psResults) {
  const tierTag = declaredEnvPs.has(r.file) ? " ⚑env" : "";
  if (!r.ranAt) {
    psNotRun++; psSkipped.push(r);
    process.stdout.write(`  ⊘ 未跑            （${r.why}）        tests/${r.file}${tierTag}\n`);
    continue;
  }
  psRan++;
  if (r.red) psRed++;
  if (r.pass != null) { psPass += r.pass; psFail += r.fail; }
  const counts = r.pass != null ? `PASS=${String(r.pass).padStart(3)} FAIL=${r.fail}` : "（未报计数）";
  const timeoutTag = r.timedOut ? " ⏱超时" : "";
  process.stdout.write(`  ${r.red ? "✗" : "✓"} exit=${String(r.code == null ? "?" : r.code).padStart(2)}  ${counts}${timeoutTag}  ${String(r.ms).padStart(5)}ms  pwsh tests/${r.file}${tierTag}\n`);
}
if (psTests.length) {
  process.stdout.write(`  ── ${psTests.length} 套 PowerShell 测试：${psRan - psRed} 过 / ${psRed} 红 / ${psNotRun} 未跑`
    + `${psPass || psFail ? `；断言合计 PASS=${psPass} FAIL=${psFail}（只统计打了汇总行的那几套）` : ""}\n`);
}

// ── 自检半边 ②：静态声明 vs 运行期计数，差值即警报 ────────────────────────
// （`tierProblems` 建在文件上方 —— PS 标记判定失败会比这里更早往里写。）
for (const r of results) {
  // 红的文件另有专门通道（上面已打全量输出），不在这里重复判 —— 它可能压根没跑到汇总行。
  if (r.code !== 0) continue;
  const declared = declaredEnv.has(r.file);
  const observed = r.defer == null ? null : r.defer;
  const dumb = r.deferLines;
  if (declared && observed === null) {
    tierProblems.push(`tests/${r.file} 头部声明了 @dao-test-tier: env，运行期却没打出 DEFER= 字段 `
      + `⇒ 无从判断那几节跑没跑（「没跑」与「跑了全过」在这个文件上已经分不开了）`);
    continue;
  }
  if (!declared && observed) {
    tierProblems.push(`tests/${r.file} 运行期 DEFER=${observed}，头部却没有 @dao-test-tier: env 标记 `
      + `⇒ 静态那半从此看不见它，标记漏加`);
    continue;
  }
  if (observed === null && dumb > 0) {
    tierProblems.push(`tests/${r.file} 正文里有 ${dumb} 行 DEFER 明细，汇总行却没有 DEFER= 字段 `
      + `⇒ 人看得见它 defer 了，机器看不见（退出码照旧 0）`);
    continue;
  }
  if (observed !== null && observed !== dumb) {
    tierProblems.push(`tests/${r.file} 汇总行 DEFER=${observed}，而正文里的 DEFER 明细有 ${dumb} 行 `
      + `⇒ 两套独立计数对不上，聚合与明细至少有一半算错了（笨计数器对拍，见 run-tests.mjs 头注 ③）`);
    continue;
  }
  if (declared && !ENV_TIER && observed === 0) {
    tierProblems.push(`tests/${r.file} 声明了环境敏感层，默认层跑却 DEFER=0 `
      + `⇒ 要么标记过期（那几节已删/已不敏感，该摘标记），要么 defer 机制坏了`);
    continue;
  }
  if (declared && ENV_TIER && observed > 0) {
    tierProblems.push(`tests/${r.file} 在 --env 下仍 DEFER=${observed} `
      + `⇒ --env 没透传到它（于是你以为跑了环境敏感层，其实没跑）`);
  }
}

// ── 自检半边 ②′：PowerShell 侧的「exit 0 + 零输出」（F4）────────────────────
// 一个**跑到了断言**的 PS 套必然吐东西（各套都打进度/汇总行）。exit 0 而 stdout 全空，
// 说明它多半根本没跑到断言：被执行策略挡掉、头部就 return、文件被清空、dot-source 的
// 依赖抛在最前面又被吞。**这与「全过」在退出码上一模一样** —— 正是本文件通篇在治的那个病
// （「一个检查器数到 0 个违例，和它根本没看到样本，输出长得一样」）。故它走 exit 4 通道，
// 不走红：红的语义是「有断言失败」，而这里的问题是「没有断言」。
for (const r of psResults) {
  if (r.ranAt && r.emptyOut) {
    tierProblems.push(`tests/${r.file}（pwsh）exit 0 但 stdout 是空的 `
      + `⇒ 它多半没跑到任何断言（「exit 0 + 零输出」与「全过」在退出码上分不开），先查它到底起没起来`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ── 断言条数基线：本次每套跑了几条 vs 基线下界（issue #268）──────────────────
// ══════════════════════════════════════════════════════════════════════════
// 位置刻意排在两段自检**之后**、退出码之前：它吃的是上面算好的全部计数，
// 而它自己发现的「基线档瞎了」要能进同一个 `tierProblems` 通道（exit 4）。
const baselineObserved = new Map();   // 文件名 → { kind, total, why }；total=null 表示这一跑拿不到数
for (const r of results) {
  baselineObserved.set(r.file, {
    kind: "node",
    total: r.pass == null ? null : r.pass + r.fail,   // 比的是「跑了几条」＝ PASS+FAIL，不是 PASS
    why: r.pass == null ? "未报计数" : null,
  });
}
for (const r of psResults) {
  baselineObserved.set(r.file, {
    kind: "pwsh",
    total: (r.ranAt && r.pass != null) ? r.pass + r.fail : null,
    why: !r.ranAt ? "本层不跑" : (r.pass == null ? "未报计数" : null),
  });
}

function loadBaseline() {
  let raw;
  try { raw = fs.readFileSync(BASELINE_PATH, "utf8"); }
  catch (e) { return { ok: false, why: `读不到基线档（${(e && (e.code || e.message)) || "未知原因"}）：${BASELINE_PATH}` }; }
  let j;
  try { j = JSON.parse(raw); }
  catch (e) { return { ok: false, why: `基线档不是合法 JSON（${e && e.message}）：${BASELINE_PATH}` }; }
  if (!j || typeof j !== "object" || !j.suites || typeof j.suites !== "object") {
    return { ok: false, why: `基线档缺 suites 段 —— 拿它当基线等于一条都不查：${BASELINE_PATH}` };
  }
  return { ok: true, json: j, suites: j.suites };
}

const baseBelow = [];      // 跌破基线（判红）
const baseStale = [];      // 基线老得没用了（观察线）
const baseUnlisted = [];   // 这一跑有、基线里没有（观察线；机器闸在 tests/assertion-baseline.tests.js）
const baseGone = [];       // 基线里有、盘上没有（观察线，同上）
const baseBlind = [];      // 这一层拿不到数的套（未报计数 / 本层不跑）—— 必须可见，不许当成"守住了"
let baseGate = "off";      // on | off | fail | write
let baseMatched = 0;
let baselineJson = null;

// 🔴 **闸只在"该它管"的时候才装载**（2026-08-10 首轮真跑当场撞到，记在这里）：
//   `BASELINE_REQUIRED` 判的是"这一跑归不归它管"，此前却把它只用在**读失败**那一支上，
//   于是「拿合成 tests 目录自测 + 真基线档恰好存在」这一格里，闸照样开、当然零匹配、
//   于是走 exit 4 —— `tests/run-tests-tier.tests.js` 一次红 33 条。
//   **它的症状随"基线档存不存在"变**：档还没生成时全绿，生成完当场红，
//   而这两次跑的是同一份代码。判据必须写在**装载**这一步，不是失败处置那一步。
if (!LIST_ONLY && BASELINE_REQUIRED) {
  const b = loadBaseline();
  if (!b.ok && WRITE_BASELINE) {
    // 首次生成：档还不存在是正常的，从空档起步
    baselineJson = { suites: {} };
    baseGate = "write";
    process.stdout.write(`\n  ⓘ 基线档尚不存在，本次 --write-baseline 从空档起步：${BASELINE_PATH}\n`);
  } else if (!b.ok) {
    // 🔴 fail-closed：该它管却读不到 ⇒ 「有没有几条根本没跑」这件事本次**一条都没查**，
    //    而那与「查了都没事」在退出码上必须分得开（本文件通篇治的就是这个病）。
    baseGate = "fail";
    tierProblems.push(`断言条数基线没读成 ⇒ **本次「有没有几条根本没跑」一条都没查**。${b.why} `
      + `⇒ 重生成：node scripts/run-tests.mjs ${ENV_TIER ? "--env " : ""}--write-baseline`);
  } else {
    baselineJson = b.json;
    baseGate = WRITE_BASELINE ? "write" : "on";
  }
} else if (!LIST_ONLY) {
  // 唯一允许关闸的一种：拿合成 tests 目录自测、又没注入基线档。**关了也要出声。**
  process.stdout.write(`\n  ⓘ 断言条数基线未启用（--tests-dir 指到了合成目录且没注入 DAO_ASSERTION_BASELINE）——本次不查条数\n`);
}

if (baselineJson) {
  const suites = baselineJson.suites || (baselineJson.suites = {});
  for (const [file, obs] of baselineObserved) {
    const entry = suites[file];
    if (!entry) { baseUnlisted.push({ file, obs }); continue; }
    const base = entry[BASELINE_TIER_KEY];
    if (obs.total == null) { baseBlind.push({ file, why: obs.why || "拿不到数" }); continue; }
    if (typeof base !== "number") { baseBlind.push({ file, why: `基线档这一层记的是「${String(base)}」，不是数` }); continue; }
    baseMatched++;
    if (obs.total < base) baseBelow.push({ file, total: obs.total, base });
    else if (obs.total - base >= BASELINE_STALE_SLACK) baseStale.push({ file, total: obs.total, base });
  }
  for (const file of Object.keys(suites)) {
    if (!baselineObserved.has(file)) baseGone.push(file);
  }
  // 🔴 「我是不是瞎了」那一半：真跑了套、基线也读到了，却**一套都没对上**
  //    （key 写法变了 / 档被清成 `{"suites":{}}` / tests 目录换了）⇒ 本闸一条都没查，
  //    而那与「全都在基线之上」输出一模一样。故走 exit 4，不静默放行。
  //    同批 issue #272 的「存在性闸不是基数闸」是同一个病的另一处，判据刻意取同一个。
  const numericObserved = [...baselineObserved.values()].filter((o) => o.total != null).length;
  if (!WRITE_BASELINE && baseMatched === 0 && numericObserved > 0) {
    baseGate = "fail";
    tierProblems.push(`断言条数基线**一套都没对上**（本次有 ${numericObserved} 套报了计数，基线档里 `
      + `${Object.keys(suites).length} 个条目，匹配 0）⇒ 这道闸本次一条都没查，而那与"全都守住了"长得一模一样。`
      + `核 ${BASELINE_PATH} 里的键是不是还叫这些名字。`);
  }
}

// ── --write-baseline：用**本次这一跑**的条数重写基线档的那一层 ────────────────
if (WRITE_BASELINE && baselineJson) {
  // 🔴 **拒写是逐套的，不是整跑的**（2026-08-10 实测改的）：
  //   原写法是「本跑有任何一套红 ⇒ 整个档不写」，理由没错（红的一跑可能半途崩，条数偏低），
  //   但它在**首次生成**那一刻自锁死：`tests/assertion-baseline.tests.js` 因为基线档还不存在
  //   而红 ⇒ 整档不写 ⇒ 它永远红。**判据本身是对的，颗粒度错了**，故改为逐套：
  //     · 红的那一套 —— 不采信它这次的条数；有旧值就留旧值（绝不因为一次红而下调基线），
  //       没有旧值就照直写一句说明（**不编数字**，同 `[#官抗-调用点覆盖率]` 分母为 0 那一格）；
  //     · 其余套照写。
  //   代价照直写：首次生成要跑**两轮**才收敛（第一轮把档写出来 ⇒ 那一套转绿 ⇒ 第二轮才拿到它的真条数）。
  const redFiles = new Set([
    ...results.filter((r) => r.code !== 0).map((r) => r.file),
    ...psResults.filter((r) => r.ranAt && r.red).map((r) => r.file),
  ]);
  {
    const suites = baselineJson.suites;
    const deltas = [];
    const heldBack = [];
    for (const [file, obs] of baselineObserved) {
      const prev = suites[file] || {};
      const old = prev[BASELINE_TIER_KEY];
      let now;
      if (redFiles.has(file)) {
        now = typeof old === "number" ? old : "上次生成时这一套是红的，条数未采信";
        heldBack.push(`${file}（本次红，${typeof old === "number" ? `保留旧基线 ${old}` : "此层暂无闸"}）`);
      } else {
        now = obs.total == null ? (obs.why || "拿不到数") : obs.total;
      }
      if (old !== now) deltas.push(`${file}: ${JSON.stringify(old === undefined ? null : old)} → ${JSON.stringify(now)}`);
      suites[file] = Object.assign({}, prev, { kind: obs.kind, [BASELINE_TIER_KEY]: now });
    }
    for (const file of baseGone) delete suites[file];
    baselineJson._doc = baselineJson._doc || {
      "这是什么": "每套测试「本次跑了几条断言」（PASS+FAIL）的下界基线。**派生物** —— 手改无效，下次 --write-baseline 覆盖。",
      "治的病": "绿灯可能只是有几条根本没跑：mutation 锚点一漂，壳里那一批断言是消失不是变红，日志上只多 1 条 FAIL。",
      "谁在消费它": "scripts/run-tests.mjs 每跑一次逐套比一次；跌破即判红（exit 1）。",
      "再生成": "node scripts/run-tests.mjs --write-baseline（默认层那一格） / 加 --env（env 那一格）—— 两层各写各的",
      "名册对账": "tests/assertion-baseline.tests.js —— 新套没进基线、基线里留着已删的套，都判红",
      "为什么有字符串值": "那一层拿不到数（未报计数 / 本层不跑）。刻意不写 0：0 会变成一个恒真的闸，留空会让「这套没人守」看不出来。",
    };
    baselineJson._generated = Object.assign({}, baselineJson._generated, {
      [BASELINE_TIER_KEY]: new Date().toISOString(),
    });
    const ordered = { _doc: baselineJson._doc, _generated: baselineJson._generated, suites: {} };
    for (const k of Object.keys(baselineJson.suites).sort()) ordered.suites[k] = baselineJson.suites[k];
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(ordered, null, 2) + "\n", "utf8");
    process.stdout.write(`\n✓ 已写基线档（${BASELINE_TIER_KEY} 那一层）：${BASELINE_PATH}\n`);
    process.stdout.write(`  本层收录 ${baselineObserved.size} 套；与上一版有出入 ${deltas.length} 处${baseGone.length ? `；删掉盘上已不存在的 ${baseGone.length} 套` : ""}\n`);
    for (const d of deltas) process.stdout.write(`    · ${d}\n`);
    if (heldBack.length) {
      process.stdout.write(`  ⚠ 有 ${heldBack.length} 套本次是红的，**它们这次的条数没被采信**`
        + `（红的一跑可能半途崩，条数天然偏低 —— 拿它当基线等于把缺陷焊进去）：\n`);
      for (const h of heldBack) process.stdout.write(`    · ${h}\n`);
      process.stdout.write(`    ⇒ 先把红修掉再跑一次 --write-baseline，这几格才拿得到真数。\n`);
    }
  }
}

if (baseBelow.length && !WRITE_BASELINE) {
  process.stdout.write(`\n✗ 断言条数跌破基线 ${baseBelow.length} 套 —— **「没红」不等于「都跑了」**：\n`);
  for (const b of baseBelow) {
    process.stdout.write(`    · tests/${b.file}  本次 ${b.total} 条 / 基线 ${b.base} 条  ⇒ **这一套比基线少跑了 ${b.base - b.total} 条**\n`);
  }
  process.stdout.write(`  最常见的成因：mutation 锚点漂了 ⇒ 那条「锚点还在吗」的前置断言红 1 条，\n`);
  process.stdout.write(`  而它壳里的一整批断言**不执行**（不是变红）—— 日志上看起来「就一个小毛病」。\n`);
  process.stdout.write(`  确认是正当缩减（删了测试 / 合并了断言）⇒ 重生成基线：\n`);
  process.stdout.write(`    node scripts/run-tests.mjs ${ENV_TIER ? "--env " : ""}--write-baseline\n`);
}
if (baseStale.length && !WRITE_BASELINE) {
  process.stdout.write(`\n⚠ 基线老了 ${baseStale.length} 套（实际条数高出基线 ${BASELINE_STALE_SLACK} 条以上）—— 这几套的闸已形同虚设：\n`);
  for (const b of baseStale) {
    process.stdout.write(`    · tests/${b.file}  本次 ${b.total} 条 / 基线 ${b.base} 条  ⇒ 掉 ${b.total - b.base} 条以内它都看不见\n`);
  }
  process.stdout.write(`  重生成：node scripts/run-tests.mjs ${ENV_TIER ? "--env " : ""}--write-baseline（这行是观察线，不进退出码）\n`);
}
if ((baseUnlisted.length || baseGone.length) && !WRITE_BASELINE) {
  process.stdout.write(`\n⚠ 基线名册与盘上实况对不上（观察线；判红的那道在 tests/assertion-baseline.tests.js）：\n`);
  for (const u of baseUnlisted) process.stdout.write(`    · tests/${u.file}  盘上有、基线里没有 ⇒ **这一套目前没有条数闸**\n`);
  for (const g of baseGone) process.stdout.write(`    · tests/${g}  基线里有、盘上没有 ⇒ 是刻意删的还是被顺手删掉的？\n`);
}
if (baseBlind.length && !WRITE_BASELINE) {
  process.stdout.write(`\nⓘ 本层条数闸看不见的 ${baseBlind.length} 套（照直列出来，别把"没报"读成"守住了"）：\n`);
  for (const b of baseBlind) process.stdout.write(`    · tests/${b.file}  —— ${b.why}\n`);
}

if (tierProblems.length) {
  process.stdout.write(`\n✗ 分层自检失败 ${tierProblems.length} 条 —— 「本次跑了什么」这个账本本身不可信了：\n`);
  for (const p of tierProblems) process.stdout.write(`    · ${p}\n`);
}

if (totalDefer && !ENV_TIER) {
  process.stdout.write(`\n⚠ 本次未跑：环境敏感断言 ${totalDefer} 条（分布 ${deferringFiles.length} 个文件）—— **「没跑」不等于「跑了全过」**\n`);
  for (const r of deferringFiles) process.stdout.write(`    · tests/${r.file}  DEFER=${r.defer}\n`);
  process.stdout.write(`  为什么摘出去：那几节对**别人拥有的机器级可变状态**做不变量断言（真 ~/.claude/settings.json、cc-switch GUI 的库），\n`);
  process.stdout.write(`  它不制造污染、只被别人的正常活动污染 ⇒ 并行期偶发红，而「红了先重跑」会训练所有人无视这道闸（issue #116）。\n`);
  process.stdout.write(`  跑完整层：node scripts/run-tests.mjs --env\n`);
  process.stdout.write(`    ⚠ 要求串行环境：没有别的官在跑测试 · cc-switch GUI 没在写库 · 没人在改 ~/.claude/settings.json\n`);
  process.stdout.write(`  退出码 ${EXIT_DEFERRED} 就是这个意思：本次没跑完。**要 0 必须带 --env。**\n`);
}

if (psNotRun) {
  // F1：**不再只靠这段散文**。它下面的退出码那一格会把 psNotRun 顶到至少 2 ——
  // 「有 PS 套没跑」从此走机器通道，而不是指望人读到这几行。
  process.stdout.write(`\n⚠ 本次未跑：PowerShell 测试 ${psNotRun} 套（共 ${psTests.length} 套）—— **「没跑」不等于「跑了全过」**\n`);
  for (const r of psSkipped) process.stdout.write(`    · tests/${r.file}  —— ${r.why}\n`);
  process.stdout.write(`  跑全部 PS 套：node scripts/run-tests.mjs --env\n`);
  process.stdout.write(`    ⚠ 要求串行环境：仍有套用固定 _tmp 沙盒 + 对真 %USERPROFILE%/%APPDATA% 做机器级断言\n`);
  process.stdout.write(`  退出码至少 ${EXIT_DEFERRED} 就是这个意思：本次没跑完。**要 0 必须带 --env。**\n`);
}

// ── 退出码 + 机器可读末行（照 DEAD_GATES_SUMMARY 的路数：只读末行的消费方也拿得到全貌）──
// 优先级 1 > 4 > 2 不变；本批只是把 PS 侧的红并进 1、把 PS 侧的未跑并进 2。
let exitCode = EXIT_OK;
// issue #268：跌破基线并进 1。**它必须在 2 之前**——默认层恒 2，若把它放进 2 那一档，
// 「这一套少跑了 6 条」在日常跑法里就与「正常的默认层」逐字节相同了。
if (bad || psRed || (baseBelow.length && !WRITE_BASELINE)) exitCode = EXIT_RED;
else if (tierProblems.length) exitCode = EXIT_SELFCHECK;
else if (totalDefer || psNotRun) exitCode = EXIT_DEFERRED;

// 末行三个新字段（psfiles/psred/psskip）**追加在尾部**，既有字段顺序一字未动 ——
// 现有消费方的正则没有行尾锚，追加不破坏它们（回归网里有一条负控专门钉这一点）。
// psfiles = 本次**真的跑了**几套（不是发现了几套）；psskip = 没跑几套（标记跳过 + 预算跳过）。
process.stdout.write(`RUN_TESTS_SUMMARY exit=${exitCode} tier=${ENV_TIER ? "env" : "default"}`
  + ` files=${results.length} red=${bad} pass=${totalPass} fail=${totalFail}`
  + ` defer=${totalDefer} deferfiles=${deferringFiles.length} declared=${declaredEnv.size}`
  + ` selfcheck=${tierProblems.length ? "fail" : "ok"}`
  + ` psfiles=${psRan} psred=${psRed} psskip=${psNotRun}`
  // issue #268 追加两个字段，仍然**只追加在尾部**（同上，不动既有字段的顺序）。
  // baselow = 跌破基线的套数；basegate = 这道闸本次的状态（on 查了 / off 没启用 /
  // fail 想查却没查成 / write 这一跑是去重写基线的）。**三种"没查"刻意不合流成一个 0**。
  + ` baselow=${baseBelow.length} basegate=${baseGate}\n`);
process.exit(exitCode);
