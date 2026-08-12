// dao-hard-gates.js — 不可逆动作的拦截闸（PreToolUse · exit 2 阻断）
//
// 改这个文件前必须知道的四条：
//
// 1. **准入判据只有一条**：它防的失败是不可逆的。可逆的、会被使用发现的失败一律不设闸，
//    退回文字层。按这条判据，这里只剩两道闸——
//      G2-live-settings  覆写 live `~/.claude/settings.json` 可触发 401 device revoked
//                        强制登出，把文件改回去也恢复不了。
//      G3-publish        对外发布没有撤销键（gh release / npm|pnpm|yarn|bun publish / cargo publish）。
//    （2026-08-12 三问梳理删掉了 G1 windows-mcp、G4 截图路径、G5 只读载体打勾、G6 心跳签名、
//    G7 shell 搜索：前者的靶子已从机器卸载，中间三条是格式要求不是不可逆，G7 已由宿主自带的
//    `permissions.deny` 承载。为什么删、删了什么，去 git 历史查这一批的 commit。）
//
// 2. **本 hook 自己崩掉时放行（fail-open），不是拦截。** 一道会因自身 bug 把 Edit/Write 全部
//    拦死的闸没有逃生通道 = 会话直接砖掉。代价是「放行」与「通过」在退出码上长得一样，
//    故 catch 里必打一行显眼 stderr。**唯一的例外**是 G2 候选侧的「饿死」那一格
//    （见 `g2Phases` 末尾）：那里的放行不是「崩了」而是「没查完」，两者必须分开。
//
// 3. **逃生阀一律是环境变量，不是文件。** 凡 agent 自己够得着的旁路，禁令即退化回没有。
//    env 只有用户能在启动会话前设，agent 在 Bash 里 export 影响不到 hook 进程。
//
// 4. **判据是近似的，两侧都有反例。** 命中判据是段首正则 + 路径归一：漏报如
//    `for x in ...; do npm publish; done`（段首不是 npm）；误报如 `echo "npm publish"`。
//    刻意不去真解析 shell 语法——那会把一道守卫变成一个解析器，而解析器错了会让
//    「违例数与样本数一起归零」。
//
// 自检：`node ccswitch/hooks/dao-hard-gates.js --selfcheck`（它在 live settings.json 的
// PreToolUse 里注册了没有 / matcher 覆不覆盖每道闸声明要拦的工具名；未注册或失覆盖 exit 1）。
// 闸的自测：`node tests/irreversible-gates.tests.js`，由 `node scripts/dao-check.mjs` 统一跑。
//
// ⚠ **注册的写入面是 cc-switch DB `providers` 表各 provider 的 `settings_config`，且每个
//   provider 都要写**（切 provider 时 live 被目标 provider 的配置整体覆盖 ⇒ 只写一个等于没写）。
//   写 `config-sync/common/settings.json`（git 快照层）或 DB 的 `common_config_*` 键（镜像层）
//   **都不会让它生效**——两层都不在下发路径上（#49 实测）。**属用户动作**：AI 侧写 DB 被权限
//   分类器全路径拦截，这是「AI 不得改自己 hook 注册」的意图级保护。
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
// 有界 realpath 走子进程（见 g2RealpathBounded）：同步 realpath 卡住时线程杀不掉，
// 宿主杀的是进程，所以界必须落在进程之外。
const childProcess = require("child_process");

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const LIVE_SETTINGS = path.join(HOME, ".claude", "settings.json");

// 归一化：反斜杠转正斜杠 + 去掉末尾斜杠。**不做大小写折叠**——只在比较时按需 toLowerCase，
// 因为要原样回显给被拦的人看（回显一个被改过大小写的路径会让人以为拦错了对象）。
function norm(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

// 把命令拆成「命令段」，让段首判据成立。**引号感知**：裸 split 碰上多行正文会把正文本身
// 切开，于是 `git commit -m "…\n…"` 的第二段段首不再是 git。
// 这不是一个 shell 解析器，也刻意不做成解析器：只跟踪单/双引号、反斜杠转义与 `$(...)` 深度，
// 认不出 heredoc 正文、嵌套引号里的引号、反引号命令替换。已知漏报面见头注 4。
// `sep` 是这一段前面那个分隔符（`|` / `&&` / `;` / 换行）。
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

// G3 用的薄包装：只要段文本。
function shellSegments(cmd) {
  return shellSegmentsRaw(cmd).map((o) => o.seg);
}


// ── G2 的判据材料 ───────────────────────────────────────────────────────────
// 只看**写目标位**，源位一律放行（备份是正路）。

// live 那一份的目录与文件名。**闸自测拿它当 mutation 靶**（tests/irreversible-gates.tests.js
// 把这个数组改成不存在的文件名，断言正控从 exit 2 掉到 exit 0）。改名要同步改那条锚点。
const G2_LIVE_NAMES = ["settings.json", "settings.local.json"];

// 🔴 **常量侧与候选侧必须归一到同一深度。** 「归一后再比」是两侧对称的动作，只改一侧即半成品——
//    每一半单独看都对，错的是不在同一深度，而那会让整道闸对所有输入一起静默放行。
//    ⇒ 改了比较的一边，就去看另一边。
//
// **为什么惰性 + 记忆化，不在模块加载期算**：归一在含 `~<数字>` 时会落一次 realpath I/O，
// 而 G2 只在一部分工具调用里才用得到它。缓存只在单次 hook 进程内有效，进程短命、不存在陈旧问题。
//
// 🔴 **两层比，第一层零 I/O**：`fs.realpathSync.native` 是**同步不可中断**的，try/catch 接得住
//    「抛错」、接不住「卡住」（实测不可路由地址上阻塞 21044 ms，而注册的 timeout 是 10 秒
//    ⇒ 真卡住时炸的是整个 hook）。故：① 零 I/O 快筛（按文件名尾巴筛，筛不过直接 false）
//    ② 语法层比（path.join + norm）③ 都不中才走有界 realpath。
//    ⚠ 快筛**不是**「能匹配」的必要条件：归一会改写末段（`.claude` 或 settings.json 自己是链时），
//    所以快筛只作用在归一前的串上，别拿归一后的值去做归一前的假设。
// ── 常量侧那一次 realpath 的有界实现 ─────────────────────────────────────────
// **为什么是子进程，不是 worker**：worker 版界本身成立，但进程寿命一点没变——
// `process.exit()` 要等每条线程从各自的 syscall 里回来，卡在内核态的线程回不来，
// `terminate()` 同样无效。**宿主杀的是进程**，所以界必须落在进程之外。
//
// 🔑 **没有预算、没有 sticky 死标记、没有任何跨调用状态。** 早期版本在「预算耗尽后怎么办」
//    这个岔口上连出过两条绕过（诱饵耗尽预算 ⇒ 降级态被缓存一整个进程 ⇒ 整把尺子失准）。
//    这一版让那个岔口在结构上不存在：常量侧输入与 payload 无关（`path.join(HOME, ".claude")`）、
//    记忆化后每进程最多求值一次 ⇒ 攻击者没有任何输入能让它多跑一次。
// 🔑 **失败方向是 fail-open**（realpath 抛错 ⇒ 按原样比）。fail-closed 不是「更安全的默认」，
//    它是把漏报换成误伤：一次 `ENAMETOOLONG` 就足以把合法的**项目级** `.claude/settings.json`
//    从 exit 0 翻到 2，而 G2 的逃生阀只有用户设得了 ⇒ 撞上即会话卡死。
// ⚠ **界以子进程杀得掉为前提**：不可路由 UNC 卡在 connect 阶段可杀（实测）；断连映射盘卡的是
//    已建立又断掉的 SMB 会话，Windows 上经典的「杀不掉」，本机造不出那种盘，这一格至今没测。

// 缺省实现恒抛 ⇒ 落回 `g2LongPath` 既有的「按原样比」。**缺省不落 I/O 是刻意的**：
// 忘了传解析器的代价是漏一格，不是整个会话卡死。
const G2_RP_NONE = () => { throw new Error("G2 未提供 realpath 实现（缺省不落 I/O）"); };

// 单次上界。**改小**：健康路径成本是「node 冷启 + 一次本地 realpath」，压到 ~200 ms 以下时
// 杀毒软件扫一次 node.exe 就够让健康调用超时 ⇒ G2 静默失明，而失明与没有违例在退出码上一样。
// **改大**：超过百毫秒级就说明文件系统不答话，再等换不到更好的答案，只会吃掉宿主预算。
// 绝对毫秒是本机数字，可移植的结论是上面两句、不是 800 这个值。
const G2_CONST_REALPATH_MS = 800;

// 子进程正文。**刻意只做一次 realpath、不把 `g2LongPath` 的两级退化逻辑复制进来** ——
// 两份实现必漂移，而两级退化的真相源只该有一处（就在 `g2LongPath` 里）。
// 代价：常量侧最坏起 **2** 个子进程（上界 2×`G2_CONST_REALPATH_MS`），已写进上面 ②。
const G2_RP_CHILD = "process.stdout.write(require('fs').realpathSync.native(process.argv[1]))";

// 失败 / 超时 / 卡住一律**抛** —— 让 `g2LongPath` 既有的 `try/catch` 走它原来那条
// 「按原样比」（fail-open，头注设计取舍②）。**降级路径因此只有一条，而且是本来就有的那条。**
function g2RealpathBounded(p) {
  const r = childProcess.spawnSync(process.execPath, ["-e", G2_RP_CHILD, p], {
    timeout: G2_CONST_REALPATH_MS,
    windowsHide: true,          // 少了它每次触发都闪一个控制台窗（第二轮点名过：无守护）
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    // 清 `NODE_OPTIONS`：免得父进程的 preload（含量它的探针自己）改变被测对象
    env: Object.assign({}, process.env, { NODE_OPTIONS: "" }),
  });
  if (r.error) throw r.error;                                   // 含 ETIMEDOUT
  if (r.status !== 0) throw new Error(`G2 有界 realpath 子进程 exit=${r.status}`);
  const got = String(r.stdout || "").trim();
  if (!got) throw new Error("G2 有界 realpath 子进程空输出");
  return norm(got);
}

// ── 候选侧的有界化：零 I/O 前筛 + 每进程一次的批量子进程 ──────────────────────────
// **这一格与常量侧不是同一个问题**：常量侧输入与 payload 无关，候选侧的触发次数**由 payload 控**
// ——一条命令想塞几个诱饵路径就塞几个。所以「上子进程」在这一侧必须先回答「N 个诱饵 × timeout」。
//
// 🔑 **答案是让那个乘法里的 N 与子进程数脱钩，而不是给 N 设上限**：
//   ㈠ 零 I/O 前筛（`g2TailCouldBeLive`）：末段不可能是 live 的候选连 realpath 都不试；
//   ㈡ 批量：过了前筛的一次性交给一个子进程，上界是一次 timeout，与 N 无关。
//
// ⚠ **诚实边界**：批量是**一批候选共享一个界**，排在卡住那一条之后的解不开 ⇒ 攻击者把毒路径
//   放最前面，可以让同批的真目标退回「按原样比」。**这是本版引入的面**（逐条独立解析没有这件事）。
//   兜住它的是下面两件：相③ 用 8.3 短名规则零 I/O 反推一大类，剩下的由饿死 fail-close 拦。
// ⚠ **孙进程**：下面两个子进程正文都是写死的字面量、只 `require('fs')`、不 spawn
//   ⇒ 结构上没有进程树可杀；路径一律走 stdin 当数据、不进代码字符串。
// 候选侧那一次**批量**解析的上界。**刻意与 `G2_CONST_REALPATH_MS` 分成两个常量**：两侧成本
// 模型不同（常量侧每进程最多 2 次单路径、候选侧每进程最多 1 次批量），合成一个就没法分开调。
// 调大调小的两侧代价与常量侧那条逐字相同。
const G2_CAND_REALPATH_MS = 800;

// 批量子进程正文。四条刻意的写法，别「顺手简化」：
//   ① 路径走 **stdin** 不走 argv——诱饵多时会撞 Windows 命令行长度上限，而那个失败是静默的；
//   ② 只 `require('fs')`，不起任何孙进程；
//   ③ **逐条 `writeSync` 立刻落**，不攒 buffer——超时被杀时部分结果仍拿得到；
//   ④ 输出与输入**逐行对位**，解不开的那条写空行；
//   ⑤ **刻意写成一行**：mutation 要拿它当锚点，跨行锚点碰上 CRLF 恒不命中，
//      而「锚点没命中」与「被测守卫真的没塌陷」逐字节相同。
const G2_RP_BATCH_CHILD = "const fs=require('fs');let d='';process.stdin.on('data',function(c){d+=c}).on('end',function(){var a=d.split('\\n');for(var i=0;i<a.length;i++){if(!a[i])continue;var r='';try{r=fs.realpathSync.native(a[i])}catch(e){r=''}fs.writeSync(1,r+'\\n')}})";

// 候选侧**每个 hook 进程最多一次**的批量解析。**本函数自己从不抛。**
//
// 🔴 **返回 `{map, fed, tried, untried}` 而不是只回一个 Map**：只回 Map 会把两件完全不同的事
//    压成同一个「查不到」——㈠ 试过了、文件系统说没有（ENOENT，写新文件的常态，fail-open 是对的）
//    ㈡ **压根没轮到它**（共享界被前面的候选吃光）。分不开这两件，调用方就只能一视同仁地
//    「按原样比」，而那正是真目标漏过去的机制。
//    **分辨判据是「这一条有没有回来过一行」**：子进程逐条 writeSync、解不开写空行
//    ⇒ 收到行 = 试过（空行 = 试过且失败）· 没收到行 = 没轮到。
// ⚠ 只认**以换行收尾的完整行**：被杀时最后一行可能是半截，半截按「没轮到」算，往保守一侧数。
function g2RealpathBatch(paths) {
  const map = new Map();
  const list = paths.filter((p) => p && p.indexOf("\n") < 0);
  const out = { map, fed: list.length, tried: 0, untried: [] };
  if (!list.length) return out;
  const r = childProcess.spawnSync(process.execPath, ["-e", G2_RP_BATCH_CHILD], {
    input: list.join("\n") + "\n",
    timeout: G2_CAND_REALPATH_MS,
    windowsHide: true,          // 同常量侧：少了它每次触发都闪一个控制台窗
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
    // 清 `NODE_OPTIONS`：免得父进程的 preload（含量它的探针自己）改变被测对象
    env: Object.assign({}, process.env, { NODE_OPTIONS: "" }),
  });
  const raw = String(r.stdout || "");
  const cut = raw.lastIndexOf("\n");
  const lines = cut < 0 ? [] : raw.slice(0, cut).split("\n");
  out.tried = Math.min(lines.length, list.length);
  for (let i = 0; i < out.tried; i++) {
    const got = lines[i].trim();
    if (got) map.set(list[i], norm(got));
  }
  out.untried = list.slice(out.tried);   // **压根没轮到的那些**，顺序与喂进去的一致
  return out;
}

// ── 8.3 短名的零 I/O 投机展开（相③）────────────────────────────────────────────
// 🔑 **它答的是「realpath 拿不到时，还能不能不靠 I/O 说出这条路径可能是谁」。** 8.3 短名不是
//    随机串：Windows 生成规则是「主名前 6 字符 + `~N` + 扩展名前 3 字符」（同前缀冲突多了改用
//    「前 2 字符 + 4 位 hex」），还会把长名里 `+ , ; = [ ]` 这几个短名非法的字符换成 `_`。
//    ⇒ 一条候选的每一段**能不能是**基准那一段的短名，是纯字符串判得出来的。
// ⚠️ **它是过近似，所以射程被刻意收到最窄的一格**：真短名归属由文件系统说了算——同一台机器上
//    `ADMINI~1` 与 `ADMINI~2` 可以分别是 `Administrator` 与 `Administrator.DOMAIN`。
//    ⇒ 相③ **只作用在「压根没轮到 realpath」的候选上**（`batch.untried`）；
//    「试过了、文件系统说没有」的一律不碰——那一格本来就是 fail-open，铺过去等于凭空造新误伤
//    （实测：不收窄的话 `C:\Users\ADMINI~9\.claude\settings.json` 会在健康路径上被拦）。
const G2_SHORT_COMP = /^(.{1,6})~(\d+)(\.(.{1,3}))?$/;
// 长名 → 它「按 8.3 规则」该有的主名前缀与扩展名前缀（都不含点，已按调用侧约定小写）。
// 空格与 `+ , ; = [ ]` 都要换成 `_`：实测长名 `Ad+min,istra[tor]` 的真短名是 `AD_MIN~1`，
// 漏掉这一档则对这类 HOME 展不开（漏报方向）。
function g2ShortStemOf(l) {
  const s = String(l || "").replace(/\s+/g, "").replace(/[+,;=[\]]/g, "_");
  const i = s.lastIndexOf(".");
  const base = (i > 0 ? s.slice(0, i) : s).replace(/^\.+/, "");   // `.claude` ⇒ `claude`
  const ext = i > 0 ? s.slice(i + 1) : "";
  return { base: base.slice(0, 6), ext: ext.slice(0, 3) };
}
// 候选的这一段 `c`，**有没有可能**就是 live 那一侧的这一段 `l`。**方向刻意不对称**：
// 只认「候选写的是短名」，不认反过来（live 侧短、候选侧长那一格由常量侧那次有界 realpath
// 负责，它每进程最多两次、与 payload 无关 —— 把那一格也做成过近似只会白添一格误伤）。
function g2CompCouldBe(c, l) {
  if (c === l) return true;
  const m = G2_SHORT_COMP.exec(c);
  if (!m) return false;
  const st = g2ShortStemOf(l);
  if ((m[4] || "") !== st.ext) return false;
  if (m[1] === st.base) return true;
  // NTFS 在同前缀短名冲突到一定数量后改用「前 2 字符 + 4 位 hex」（`ad1b2c~1`）—— 不收这一格
  // 的话，短名一多本函数就静默失效，而失效与「这条确实不是 live」输出一模一样。
  return m[1].length === 6 && m[1].slice(0, 2) === st.base.slice(0, 2) && /^[0-9a-f]{4}$/.test(m[1].slice(2));
}
// 段数（记忆化：两条 live 基准每进程只有两个取值，别在十万次循环里反复 split）
const _g2SegCache = new Map();
function g2SegCount(s) {
  let n = _g2SegCache.get(s);
  if (n === undefined) { n = s.split("/").length; _g2SegCache.set(s, n); }
  return n;
}
// 把一条含 8.3 段的候选路径，按 live 那两条基准**投机展开**成它可能的长名形态；
// 展开不出来返回 null（＝这条路径不可能是 live 的短名写法，与它无关）。
// 只处理两种长度：与基准同段数（候选就是那个目录）、比基准多一段（目录 + 文件名）。
function g2ShortExpand(p, syn, real) {
  const s = norm(String(p || ""));
  if (!/~\d/.test(s)) return null;                  // 没有 8.3 段 ⇒ 没有可展开的东西
  // 🔑 **先数斜杠再决定要不要 split**：本函数在大 payload 下会被喂十万级候选（`g2Phases`
  //    的相③ 预判要逐条问一遍），而绝大多数候选**段数根本对不上**、连 split 都不值得做。
  //    数一遍字符比 `split` 少一次数组分配 —— 这一格是实测出来的（相③ 首版在 2.8 MB payload
  //    上把 hook 寿命从 5.0 s 顶到 9.7 s，宿主 10 s 预算差点就烧掉了）。
  let segs = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 47) segs++;
  const synN = syn ? g2SegCount(syn) : -9, realN = real ? g2SegCount(real) : -9;
  if (segs !== synN && segs !== synN + 1 && segs !== realN && segs !== realN + 1) return null;
  const a = s.toLowerCase().split("/");
  for (const L of [syn, real]) {
    if (!L) continue;
    const b = L.split("/");
    if (a.length !== b.length && a.length !== b.length + 1) continue;
    let ok = true, changed = false;
    for (let i = 0; i < b.length; i++) {
      if (a[i] === b[i]) continue;
      if (g2CompCouldBe(a[i], b[i])) { changed = true; continue; }
      ok = false; break;
    }
    if (!ok) continue;
    if (a.length === b.length) { if (changed) return L; continue; }
    let tail = a[b.length];
    for (const n of G2_LIVE_NAMES) {
      if (tail === n) break;
      if (g2CompCouldBe(tail, n)) { tail = n; changed = true; break; }
    }
    // `changed` 为假 = 逐段字面相等 ⇒ 相① 早就拦下了，展开是多余的（返回 null 不掩盖任何东西）
    if (changed) return `${L}/${tail}`;
  }
  return null;
}

// 「一条命令里最多允许有多少个待归一的候选，超了还没验完就不许静默放行」。
// 🔴 **这里的「候选」计的是 `fed`，不是写目标数**：`g2LongPath` 的两级退化会让一个写目标最多
//    进候选**两次**（整条路径 + 父目录退化一级），故 fed ≈ 2 × 写目标数，真实触发线是 33 个写目标。
// **改小** ⇒ 更容易走到 fail-close，误伤面变大；下界是「合法命令的候选数上限」，日常形态是 0-3 条。
// **改大** ⇒ 只是把攻击者可用的窗口开大，收益为零。
// ⚠ 这条线本身没有边界行为断言，只有常量文本被改动时锚点会红。
const G2_CAND_STARVE_N = 64;

// 多相判定。**判决 = 相①（归一前）∨ 相②（归一后）∨ 相③（8.3 投机展开），任一命中即拦；
// 都不中而且「有候选压根没验过」时按饿死 fail-close。**
//
// ⚠️ **三相都要跑，别「优化」掉任何一相**：
//    相① 独有的覆盖面是「末段被链改写」那一类（`settings.json` 自己是符号链接）——它压根不归一，
//         末段就是用户写的那个末段，不存在「归一改写末段」这件事；
//    相② 独有的是「候选路径里有链、只有真 realpath 解得开」那一类；
//    相③ 独有的是「realpath 没验成，而候选是 8.3 短名形态」那一类。
// 🔑 **相① 拦下就不起子进程**：真违例的常见形态（`~/.claude/settings.json`、
//    `$env:USERPROFILE\.claude\settings.json`）在相① 就命中 ⇒ 一次 I/O 都不落。
//
// 🔴 **饿死 fail-close 是全文件唯一的 fail-close，别读成「G2 改成 fail-closed 了」**：
//    它要同时满足「这一批有候选压根没验过」且「候选数 > `G2_CAND_STARVE_N`」。
//    理由是那一格的「放行」不是「崩了」而是「没查完」，而**没查完与没有违例在退出码上一样**。
//    单条候选解不开（文件不存在 / 毒路径卡住 / 界太紧）照旧 fail-open，理由见头注 2。
// `blocked(what)` 由调用方给——拦截文案的三条正路那一半须与两个分支逐字同一份（抄第二份必漂移）。
const G2_HOST_TIMEOUT_MS = 10000;         // 宿主对本 hook 的注册超时（换算成 ms）。只读它来算
                                          // 「还剩多少预算」，**不是它的真相源**——改注册值不会
                                          // 同步到这里，取不准的方向刻意保守。
const G2_RERUN_SAFETY_MARGIN_MS = 2000;   // signal 投递 / stderr 写出 / 进程退出的固定开销边际。
const G2_RERUN_DEADLINE_MS = G2_HOST_TIMEOUT_MS - G2_RERUN_SAFETY_MARGIN_MS;
// 相③ 重跑的估价系数：相① 的真实耗时先乘这个系数，再判「还来不来得及重跑一遍」。
// **为什么不是 1**：实测 12 组样本 v3/v1 = 1.88–2.64（均值 ≈2.22），当 1 用会在一段 N 上误判
// 「还来得及」而实际越过宿主界。**数值由用户 2026-08-09 拍板（issue #254），不是 AI 自定。**
const G2_RERUN_COST_FACTOR = 2.5;
function g2Phases(judge, blocked) {
  const t0 = Date.now();   // 量的是这一次 g2Phases 调用的墙钟，不是整个 hook 进程的。
  const wanted = [];
  const seen = new Set();
  const v1 = judge((p) => {
    if (!seen.has(p)) { seen.add(p); wanted.push(p); }
    throw new Error("G2 相①：本相不落 I/O");
  });
  if (v1) return v1;
  // 这一次相① 的真实耗时，当「再跑一遍要多贵」的估价——相③ 的重跑与相① 做的是同一件事
  // （把全部 segment 重新走一遍 g2WriteTargets），量级天然接近，且随机器速度与 payload 大小
  // 自动跟着变，不需要为换机再调一次常量。它是估价不是精确解，故要乘上面那个系数。
  const v1CostMs = Date.now() - t0;
  if (!wanted.length) return null;          // 没有任何候选想 realpath ⇒ 零 I/O 收工
  const batch = g2RealpathBatch(wanted);
  const starved = batch.fed - batch.tried;  // 压根没轮到的那些（≠「试过但文件不存在」）
  if (starved > 0) {
    // **fail-open / 降级都不许静默**（同常量侧那行自陈）。射程一样照直写：宿主对 exit 0 的
    // stderr 不回喂给 agent ⇒ 它是给读日志的人看的，判决通道仍然只有退出码。
    process.stderr.write(
      `[dao-hard-gates G2] ⚠ 候选侧批量 realpath 没跑完：喂进去 ${batch.fed} 条、只解到第 ` +
      `${batch.tried} 条（界 ${G2_CAND_REALPATH_MS}ms/批）⇒ 还有 ${starved} 条**这次没验过**。` +
      `相③ 会对其中 8.3 短名形态的做零 I/O 投机展开；展开不出来的那些**是「没验」不是「没事」**。\n`);
  }
  if (batch.map.size) {
    const v2 = judge((p) => {
      const v = batch.map.get(p);
      if (!v) throw new Error("G2 相②：这一条没解开");
      return v;
    });
    if (v2) return v2;
  }
  // ── 相③：只对**压根没轮到**的候选做 8.3 投机展开 ──────────────────────────────
  //    🔴 **射程是 `batch.untried`，不是「map 里查不到的」**：后者含 ENOENT（写新文件的常态），
  //       把过近似铺到它上面等于凭空造一格新误伤。
  // 🔴 **分「直判」与「重跑 judge」两条路，不是一律重跑**：第三遍 judge 要把整条命令重走一遍，
  //    大 payload 上单独就值数秒，能顶穿宿主预算 ⇒ 能不重跑就不重跑。
  //    ㈠ **直判**：展开后自己就是一条 live 文件路径 ⇒ 判决已定，不必再跑 judge。
  //    ㈡ **重跑**：展开后是 live **目录**（`cp <源> <目标目录>` 合成的候选是「目标目录 + 源文件名」）
  //       ⇒ 拦不拦还要看源文件名叫什么，只有 judge 知道。
  //       这条路的开关握在攻击者手里（末位塞一个「展开后恰是 live 目录」的候选即可打开），
  //       所以它必须有自己的开销上界——见下面那行预算闸，不够就退回饿死 fail-close。
  if (batch.untried.length) {
    const syn = g2LiveDirSyntactic(), real = g2LiveDirReal();
    const expand = (p) => g2ShortExpand(p, syn, real);
    const untried = new Set(batch.untried);
    let direct = null, dirForm = false;
    for (const p of batch.untried) {
      const g = expand(p);
      if (!g) continue;
      if (g2IsLive(g)) { direct = { p, g }; break; }
      if (g === syn || g === real) dirForm = true;
    }
    if (direct) {
      return blocked(
        `要写用户级 live 配置 —— 候选 \`${direct.p}\` 的 8.3 短名投机展开是 \`${direct.g}\`` +
        `（相③：这一条压根没轮到 realpath，故按短名规则反推）`);
    }
    if (dirForm) {
      // 预算闸：重跑一遍的代价按「相① 实测耗时 × 系数」估价，不够就不硬跑——退回饿死
      // fail-close（诚实说「没验完」），而不是硬跑到宿主把整个 hook 杀掉
      // （那样连这一格 fail-close 本身都没机会说出口）。
      const elapsed = Date.now() - t0;
      if (elapsed + G2_RERUN_COST_FACTOR * v1CostMs > G2_RERUN_DEADLINE_MS) return g2Starved(batch.fed, starved);
      const v3 = judge((p) => {
        const v = batch.map.get(p);
        if (v) return v;                      // **精确优先**：解开过的候选不吃过近似
        const g = untried.has(p) ? expand(p) : null;
        if (g) return g;
        throw new Error("G2 相③：既没解开、也做不出 8.3 投机展开");
      });
      if (v3) return v3;
    }
  }
  // ── 饿死 fail-close（#214）：三相都没拦下，而这一批里有候选压根没验过 ────────────────
  if (starved > 0 && batch.fed > G2_CAND_STARVE_N) return g2Starved(batch.fed, starved);
  return null;
}

// 饿死那一格的拦截文案。**它说的不是「查出你在写 live 配置」，是「这次没查完」** ——
// 两件事分开说，否则被拦的人会去找一个并不存在的违例目标。
function g2Starved(fed, starved) {
  return {
    what:
      `一条命令里产生了 ${fed} 条待归一的候选（每个写目标最多计 2 条：整条路径 + 父目录退化` +
      `一级，故候选数 ≈ 写目标数的 2 倍），界内只验完 ${fed - starved} 条 ` +
      `⇒ 还有 ${starved} 条**这次没验过**（不是「验过没事」）`,
    how:
      "这一格是 **fail-close**，理由是它与别处不同：候选侧那次归一是**一批共享一个时间界**的，" +
      "候选数量够大时排在后面的压根轮不到 ⇒ 退回「按原样比」就会把真目标放过去" +
      "（issue #214 的回归带，实测同一条命令改动前拦得住）。**「没验完」不等于「没有违例」。**" +
      "正路二选一：①**把这条命令拆小**——一条命令里几十上百个 8.3 短名写目标不是日常形态，" +
      "日常形态是 0-3 个；②确实要一次写这么多、且确认不碰 `~/.claude/settings.json` 时，" +
      "由**用户**设 `DAO_SETTINGS_EDIT_APPROVED=1` 后重开会话（agent 自己 export 影响不到本 hook）。",
  };
}

const _g2LiveDirCache = { syn: null, real: null };
// ① 语法层：零 I/O
function g2LiveDirSyntactic() {
  if (_g2LiveDirCache.syn === null) {
    _g2LiveDirCache.syn = norm(path.join(HOME, ".claude")).toLowerCase();
  }
  return _g2LiveDirCache.syn;
}
// ② realpath 层：有 I/O，**只在语法层没命中时才求值**。惰性 + 记忆化在这一版是安全的：
// 它的输入与 payload 无关，而且没有任何会被耗尽的共享资源。
function g2LiveDirReal() {
  if (_g2LiveDirCache.real === null) {
    // 零 I/O 归一（`//?/` 前缀 / `..` / `.` / 重复分隔符）—— 这一步刻意不落 I/O，
    // 故传恒抛的 `G2_RP_NONE`，realpath 那一步下面单独做。
    const syn = g2Canon(norm(path.join(HOME, ".claude")), G2_RP_NONE);
    // **无条件过一次有界 realpath**，不借「含 `~N` 才解」那个条件——那个条件是候选侧为了省 I/O
    // 才有的；常量侧每进程最多算一次，省不出什么，却让「`~/.claude` 自己是链」这一格在长名
    // HOME 上漏掉（攻击者直接写链目标路径即可绕过）。变的只是「什么时候解」，不是「解几次」。
    let solved = 0;
    _g2LiveDirCache.real = norm(g2LongPath(syn, (p) => {
      const v = g2RealpathBounded(p);
      solved++;
      return v;
    })).toLowerCase();
    // **fail-open 不许静默**（头注 2）：一次都没解成 ⇒ 本次是拿**未归一**的 HOME 在比，
    // 8.3 短名家目录 / `.claude` 是链时这道闸此刻是瞎的，而「瞎」与「没有违例」在退出码上一样。
    // 判据是数**成功次数**，不是看进出串里有没有 `~N`——长名 HOME 上后者恒假、静默。
    // ⚠ 射程照直写：宿主对 exit 0 的 stderr 不回喂给 agent ⇒ 这行是给读日志的人看的。
    if (solved === 0) {
      process.stderr.write(
        `[dao-hard-gates G2] ⚠ 常量侧 realpath 没验成（有界子进程超时或失败，界 ` +
        `${G2_CONST_REALPATH_MS}ms/次）⇒ 本次按未归一的 HOME 比对，8.3 短名家目录或 ` +
        `\`.claude\` 是链时这道闸**可能拦不住** live 配置写入。**这不是「通过」，是「没验」。**\n`);
    }
  }
  return _g2LiveDirCache.real;
}
// 两层依次比。**次序是判据的一部分，别调换**：调换之后第一层的「零 I/O」就白设了。
function g2MatchesLiveDir(low) {
  if (low === g2LiveDirSyntactic()) return true;
  return low === g2LiveDirReal();
}

function g2IsLive(p) {
  if (!p) return false;
  const low = norm(p).toLowerCase();
  return G2_LIVE_NAMES.some((n) => {
    if (!low.endsWith(`/${n}`)) return false;              // 先按文件名快筛，零 I/O
    return g2MatchesLiveDir(low.slice(0, low.length - n.length - 1));
  });
}
// 「这个文件名**有没有可能**落地成 live 那两个文件之一」——纯字符串，零 I/O。
// 两种放行：①名字本身就是 ②它是个 8.3 短名（`~<数字>`，零 I/O 判不出，放行到 realpath 层定案
// ——本卷上 `settings.json` 的真短名是 `SETTIN~1.JSO`，8 位主名 + **3 位**扩展名）。
const g2BaseCouldBeLive = (b) => {
  const low = String(b || "").toLowerCase();
  return /~\d/.test(low) || G2_LIVE_NAMES.indexOf(low) >= 0;
};

// 「这条路径**有没有可能**是 live（或 live 目录）」——纯字符串，零 I/O，候选侧唯一的 I/O 闸门。
// 放行面刻意宽（含 `.claude` 目录形态与任何 8.3 短名末段），因为它只决定「要不要花那次 I/O」，
// **拦不拦仍由 `g2MatchesLiveDir` 的精确比对说话** ⇒ 放宽这里只会多花 I/O，不会多拦一条。
const g2TailCouldBeLive = (s) => {
  const low = norm(s).toLowerCase();
  const i = low.lastIndexOf("/");
  const tail = i < 0 ? low : low.slice(i + 1);
  return tail === ".claude" || g2BaseCouldBeLive(tail);
};

// 🔴 **前筛必须落在 `g2Canon` 的「零 I/O 串处理之后、realpath 之前」**（唯一调用点就在那里）：
//   落在 realpath 之后 = 归一会改写末段，问了个被改写过的末段；
//   落在字符串处理之前 = `::$DATA` / `//?/` 前缀还没剥，问了个假末段
//   （实测：`…/.claude/settings.json::$DATA` 的末段既不是 live 名也没有 `~N` ⇒ 被筛掉、漏过）。
//   一句话：**前筛问的是「归一前」，但那指的是 realpath 前，不是字符串处理前。**

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
// **本机不是理论形态**：真语料 27365 条去重命令里 `~<数字>` 路径 1196 条，而 `ADMINI~1` 正是 HOME 的短名。
// 三条刻意的收窄，别读成「顺手加个 realpath」：
//   ㈠ **只在盘符绝对路径 + 真含 `~<数字>` 时才落 I/O**——否则 `//server/share/...` 会把网络 SMB
//      超时（可达数十秒）拖进一个 PreToolUse 钩子里，等于用会话卡死换覆盖面；
//   ㈡ **失败一律按原样比**（fail-open）：文件还不存在是正常的（Write 新建）；
//   ㈢ 整条解不开时退到**目录级**（`C:\Users\ADMINI~1\.claude` 解得出）。
// ⚠ 它顺带会解开 symlink/junction——那是 realpath 的语义、不是本函数想要的；因为它只在
//   `~<数字>` 路径上跑，而那类路径此前一律不匹配，任何改变都只会往「更准」的方向走。
// **realpath 的实现由调用方给，且刻意做成参数而不是模块级开关**：开关是**有状态**的，而历史上
// 两条绕过都长在「一个会被改写并缓存一整个进程的降级状态」上。参数没有状态。
function g2LongPath(p, rp) {
  const realpath = rp || G2_RP_NONE;
  try { return realpath(p); } catch (_) { /* 文件不存在是常态；有界版超时也走这里 */ }
  try {
    const i = p.lastIndexOf("/");
    if (i > 0) return realpath(p.slice(0, i)) + p.slice(i);
  } catch (_) { /* 目录也不存在 ⇒ 按原样比 */ }
  return p;
}

// 绝对路径归一。**没有这一步的话** `..` / `.` / `//` / 8.3 短名 / `\\?\` 全部绕开精确比对。
//
// **为什么按根的形态分派两个归一器，而不是统一用一个**（本机逐一验过，别改成「更简洁」的写法）：
//   · `path.posix.normalize("C:/../Users/x")` → `Users/x`——**把盘符当成普通段吃掉了**；
//   · `path.win32.resolve("/../home/x")` → `D:/home/x`——**凭空补上当前进程的盘符**。
//   ⇒ 盘符绝对走 win32.resolve（在盘根处夹住 `..`），POSIX 绝对走 posix.normalize（在 `/` 处夹住）。
// **`//` 开头（UNC）刻意不归一**：normalize 会把前导 `//` 折成 `/`，而那条路径要原样回显给被拦的人看。
//
// **NTFS 备用数据流**：`<path>::$DATA` 是默认数据流的显式写法，写它就是写原文件本身（实测写入后
// 原文件内容确实被改）；而 `<path>:$DATA` 与 `<path>:mystream` 是**另一条**流，不碰原文件。
// ⇒ **只剥 `::$DATA` 这一种，且必须锚在末尾**。剥多了就是误伤。零误伤面：Windows 文件名里 `:` 本就非法。
// `rp` 只往下传给 `g2LongPath`：**两侧必须共用同一个归一器**，否则又掉进「两侧不在同一深度」那个病。
function g2Canon(s, rp) {
  if (!s) return s;
  // Win32 扩展长度前缀是**纯字符串**前缀，剥它不需要任何 I/O：`//?/C:/…` → `C:/…`
  if (/^\/\/[?.]\/[A-Za-z]:\//.test(s)) s = s.slice(4);
  // NTFS 默认数据流的显式写法 ⇒ 等价于原文件（三种流形态的实测差别见上方注释）
  s = s.replace(/::\$DATA$/i, "");
  if (/^[A-Za-z]:\//.test(s)) {
    try { s = norm(path.win32.resolve(s)); } catch (_) { /* 解析不了就按原样比 */ }
    // 🔴 **`g2TailCouldBeLive(s)` 是 #199 的零 I/O 前筛，也是本闸唯一的 I/O 闸门**：
    //   末段不可能是 live 的候选**一次 realpath 都不试**（`Z:\dead~1\f.md` 这类诱饵到此为止）。
    //   它必须问**这里的** `s` —— win32.resolve、`//?/` 剥离、`::$DATA` 剥离都已经做完，
    //   realpath 还没做（理由见上方那段「前筛必须落在零 I/O 串处理之后」）。
    if (/~\d/.test(s) && g2TailCouldBeLive(s)) s = g2LongPath(s, rp);
  } else if (/^\/(?!\/)/.test(s)) {
    try { s = path.posix.normalize(s); } catch (_) { /* 同上 */ }
  }
  return norm(s);
}

// 展开 + 归一 + 相对路径按 cwd 解析，**但不含 `g2Canon`**（那一步才有 realpath）。
// Git Bash 的 `/c/Users/...` 与 cygwin 的 `/cygdrive/c/...` 都要还原成盘符形态——真语料里
// 备份命令就是用 `/c/...` 写的。
// **它单独拆出来是因为零 I/O 快筛必须看得见「归一前」的末段**，也是相① 的输入。
function g2ResolvePre(raw, cwd, vars) {
  let s = g2Expand(raw, vars);
  if (!s) return "";
  s = norm(s);
  s = s.replace(/^\/cygdrive\/([A-Za-z])(?=\/|$)/, (m, d) => `${d}:`);
  s = s.replace(/^\/([A-Za-z])(?=\/)/, (m, d) => `${d}:`);
  const abs = /^[A-Za-z]:(\/|$)/.test(s) || /^\//.test(s);
  if (!abs) {
    try { s = norm(path.resolve(cwd || process.cwd(), s)); } catch (_) { /* 解析不了就按原样比 */ }
  }
  return s;
}
// 第四个参数 `rp` 由 `g2Phases` 给（相①=收集并抛 / 相②=查表）。**不传就是零 I/O**
// （`g2Canon` → `g2LongPath` → `G2_RP_NONE` → 按原样比），这个缺省方向是刻意的（#199）。
function g2Resolve(raw, cwd, vars, rp) {
  // ⑨：绝对路径此前直接 return，一步归一都没有 —— 两个分支现在都过这里。
  return g2Canon(g2ResolvePre(raw, cwd, vars), rp);
}

// 段内 token 化。与 shellSegmentsRaw 是两层不同的事：那层切**命令段**，这层切**参数**。
// 三个刻意的行为：
//   ① **引号里的 `>` 不算重定向**——否则任何一句提到重定向的文本都会被当成写操作；
//   ② **双引号里的反斜杠不当转义吃掉**：`"$env:USERPROFILE\.claude\settings.json"` 里的 `\.`
//      若按 POSIX 转义规则处理会变成 `.`，整条路径当场毁掉。只剥 `\"` `\\` `\$` 这三种；
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
//   dest-last  —— 复制/移动/改名：**末位正参**（或 -Destination/-NewName）是目标，其余是源。
//   all-target —— 写入类：没有「源路径」概念，所有路径参数都是目标。
// **`sc` 刻意不收**：它同时是 `C:\windows\system32\sc.exe`（服务控制），本机两个都在。
const G2_DEST_LAST = new Set(["copy-item", "copy", "cpi", "cp", "move-item", "move", "mi", "mv", "rename-item", "ren", "rni"]);
const G2_ALL_TARGET = new Set(["out-file", "set-content", "add-content", "ac", "tee-object", "tee", "new-item", "ni"]);
// 取值型参数（会吃掉下一个 token）；不在表里的 `-Xxx` 一律当开关，不吃下一个。
// 取值型参数（会吃掉下一个 token）；不在表里的 `-Xxx` 一律当开关，不吃下一个。
// ⚠ **`lp` 不在表里是刻意的**：`Copy-Item -lp` 根本不是合法参数（`-LiteralPath` 的唯一别名是
//   `PSPath`），而 bash 侧 `cp -lp a b` 是**捆绑短选项**、不吃取值——留着它会让 `-lp` 吃掉源。
const G2_VALUE_PARAM = /^-{1,2}(path|literalpath|filepath|destination|dest|newname|target|value|inputobject|encoding|itemtype|name|filter|include|exclude|delimiter|width|erroraction)$/i;
// 目标位参数：复制类只认这几个；写入类另加 -Path/-LiteralPath/-FilePath。
const G2_DEST_PARAM = /^-{1,2}(destination|dest|newname|target)$/i;
const G2_TARGET_PARAM = /^-{1,2}(path|literalpath|filepath|destination|dest|target)$/i;
// **源**位参数（只对 dest-last 类有意义）。issue #112 甲⑥：`-Path` 具名之后，PowerShell 的
// 参数绑定把**剩下的第一个正参绑到 position 1 = `-Destination`** —— 即"只剩 1 个正参"这件事
// 本身就是目标位存在的证据，而旧判据恰恰在这里早退。
const G2_SRC_PARAM = /^-{1,2}(path|literalpath)$/i;
// 🔴 **rename 族不吃「具名源 ⇒ 门槛降到 1 个正参」那条放宽**：`Rename-Item` 的 `-NewName`
//   **相对源目录解析，不是相对 cwd**（实测：cwd 在 A、源在 B，`Rename-Item B\foo.json bar.json`
//   的落点是 B\bar.json）。本闸整条解析链按 cwd 解 ⇒ 对 rename 这一族**基准就是错的**，
//   两个方向都错：按 cwd 解会误伤，不解会漏报。把门槛降到 1 等于把这个错基准扩到具名源形态上。
// ⚠ **已知代价，照直写**：这个排除退掉了 4 格真拦截——PS **接受**目录部分与源目录字面相同的
//   绝对 `-NewName`（`Rename-Item -Path <liveDir>\evil.json <liveDir>\settings.json` 实测通过）。
//   方向是漏报。窄修法（末位正参是绝对路径时照常吃门槛下降）挂 issue #132，不在这里改：
//   它动的是同一条共享解析链，而在同一批里再动一次共享解析链是制造退化最省事的办法。
//   严重性上限：`Rename-Item` **覆盖不了已存在的目标，`-Force` 也不行** ⇒ 这条绕过只能在
//   `settings.json` 尚不存在时把它创建出来。别读成「所以可以不管」：`settings.local.json`
//   在很多机器上本来就不存在，而 G2 的职责正是不让 AI 写这两个文件。
const G2_NO_SRC_THRESHOLD = new Set(["rename-item", "ren", "rni"]);

const g2CmdName = (t) =>
  String(t == null ? "" : t).replace(/^["']|["']$/g, "").replace(/^.*[\/\\]/, "").replace(/\.exe$/i, "").toLowerCase();

// 一个命令段里所有**写目标**的候选路径（已解析）。返回 [{ why, path }]。
// 第四个参数 `rp` 是 `g2Phases` 那一相的 realpath 实现（#199），一路透传到
// `g2Canon`；不传 = 零 I/O（缺省方向刻意如此，见 `g2LongPath` 上方）。
function g2WriteTargets(seg, cwd, vars, rp) {
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
      // 「目标位」存在的门槛：
      //   · 源在正参上（`Copy-Item <源> <目标>`）⇒ 要 ≥2 个正参，单个正参是源
      //     （`Copy-Item x` 是复制到当前目录，没有目标位）；
      //   · 源已被**具名**吃掉（`Copy-Item -Path <源> <目标>`）⇒ **1 个正参就是目标位**。
      //     别读成「具名形态本来就已覆盖」：已覆盖的是**具名目标**（-Destination），
      //     这里是**具名源 + 位置目标**，正好落在两边之外。
      //   ⚠ rename 族除外，理由见 `G2_NO_SRC_THRESHOLD` 上方。
      const needed = (namedSrcs.length && !G2_NO_SRC_THRESHOLD.has(head)) ? 1 : 2;
      const hasDestPos = positional.length >= needed;
      if (hasDestPos) {
        out.push({ why: "末位参数（目标位）", raw: positional[positional.length - 1] });
        destRaws.push(positional[positional.length - 1]);
      }
      // 目标位给的是 `~/.claude` **目录**时，落地文件名由源的 basename 决定。
      // 具名 `-Destination <目录>` 与位置目标位共用同一段展开，源也含具名源。
      const srcs = namedSrcs.concat(hasDestPos ? positional.slice(0, -1) : positional);
      // 🔴 **前筛问的是「源文件名」，不是「目标目录末段像不像 `.claude`」**：`~/.claude` 是链时
      //   真实目录可以叫任何名字 ⇒ 后者既拦不住该拦的，又是「用归一后的值做归一前假设」的载体。
      //   目录侧一律交给 `g2IsLive` → `g2MatchesLiveDir` 的精确比对定案，拦截面没有放宽。
      for (const dRaw of destRaws) {
        const destPre = g2ResolvePre(dRaw, cwd, vars);
        const destDir = g2Canon(destPre, rp);
        for (const src of srcs) {
          const base = norm(g2Expand(src, vars)).split("/").pop();
          if (base && g2BaseCouldBeLive(base)) out.push({ why: "目标目录 + 源文件名", raw: `${destDir}/${base}` });
        }
      }
    } else {
      for (const p of positional) out.push({ why: "位置参数", raw: p });
    }
  }
  return out.map((h) => ({ why: h.why, path: g2Resolve(h.raw, cwd, vars, rp) }));
}

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


// ── 各道闸（数量以 GATES.length 为准，此处刻意不写死数字）──────────────────
// 每条 gate：
//   id / why（判据出处，进 stderr）/ escapeEnv（null=无逃生阀）
//   tools（本闸要拦的工具名样本，供 --selfcheck 核对 matcher 覆盖面）
//   test(input) → null 放行 / { what, how } 阻断（what=拦了什么，how=合法路径）

const GATES = [
  {
    id: "G2-live-settings",
    why: "dao.md Shell 节「settings.json 运行时改动 · 确认门禁」+「改配置先认源与投影」（`~/.claude/settings.json` 是 cc-switch 下发的**投影**——真实下发源是 DB `providers` 表各 provider 的 `settings_config`，下发只挂在 GUI「切换 provider」这个动作上；改投影立即生效但不持久、下次切 provider 即被整体覆盖且无告警）",
    escapeEnv: "DAO_SETTINGS_EDIT_APPROVED",
    // Bash/PowerShell 也要收：绕过 Edit/Write 那条走的就是 shell。**声明面窄，自检就跟着一起瞎**
    // ——`--selfcheck` 核的是「matcher 覆不覆盖这道闸声明要拦的工具名」。
    tools: ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "PowerShell"],
    test(input) {
      const tool = input.tool_name || "";
      const cwd = input.cwd || process.cwd();

      // 🔴 **两个分支都走 `g2Phases`**：它把整条判定跑三遍——相①归一前（零 I/O，同时收集哪些
      //    候选想 realpath）· 相②归一后（查那一次批量子进程的结果）· 相③ 8.3 短名投机展开
      //    （只对没验成的候选，零 I/O），**任一相命中即拦**；三相都不中而且有候选压根没验过时
      //    按饿死 fail-close。

      // ① 编辑器类：目标文件就是 file_path 本身
      if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
        const ti = input.tool_input || {};
        const raw = ti.file_path || ti.notebook_path;
        if (!raw) return null;
        return g2Phases((rp) => {
          if (!g2IsLive(g2Resolve(raw, cwd, null, rp))) return null;
          return g2Blocked(`要写用户级 live 配置 \`${norm(raw)}\``);
        }, g2Blocked);
      }

      // ② shell 类（2026-08-02 #87 新增）：重定向目标 + 写入类命令的**目标位**。
      //    源位一律放行（备份是正路，理由与真语料分布见头注 G2）。
      if (/^(Bash|PowerShell)$/.test(tool)) {
        const cmd = (input.tool_input || {}).command || "";
        const segs = shellSegments(cmd);
        const vars = g2VarMap(segs);
        return g2Phases((rp) => {
          for (const seg of segs) {
            for (const hit of g2WriteTargets(seg, cwd, vars, rp)) {
              if (!g2IsLive(hit.path)) continue;
              return g2Blocked(
                `要用 shell 写用户级 live 配置 —— ${hit.why}解析出 \`${hit.path}\`` +
                `（这一段：\`${seg.slice(0, 90)}\`）`
              );
            }
          }
          return null;
        }, g2Blocked);
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
    why: "dao.md 帅节留守判据 ㈣「自主边界（永不进自主窗）」（正文见 ccswitch/rules/dao-dispatch.md §七「自主边界」）——对外发布属不可逆决策 + 需用户在场件",
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
