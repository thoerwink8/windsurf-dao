// scripts/lib/redact.mjs —— 脱敏纯函数（ESM 面）：canonical redact.js 的门面 + 会话态那一层的补丁
//
// ── 为什么这不是第二份实现（读这段再动手改）─────────────────────────────────
// 本仓已有 `scripts/lib/redact.js`（CJS，canonical）。那份文件的头注里写着一条**实证过的
// 结论**：同一套脱敏判据做成两份，必然漂移，而漂移方向是**看不见的**——弱的那份不报错，
// 它只是少认几个模式，输出看起来完全正常（devin 三处实现漂移即实证：Go 侧认 5 类、
// PS 侧认 4 类，少认的恰好是 `x-api-key` 与 snake_case）。
// ⇒ 本文件**不重写任何一条已有模式**。`sk-` / `Bearer ` / `ghp_` / `ANTHROPIC_AUTH_TOKEN=`
//   这四条任务书点名的，canonical 里**本来就有**（PATTERNS 的 sk-key / bearer /
//   github-token / env-assign），本文件只是 import 过来。
//   验这件事的断言在 tests/redact-session.test.js 的「①委派」组：它直接比对
//   `redactText` 的输出，canonical 那边少认一类，这边跟着红。
//
// ── 那本文件加了什么 ────────────────────────────────────────────────────────
// 三类 canonical **刻意没有**的模式，加成**独立的第二层**（EXTRA_PATTERNS）：
//   ① **UNC 路径**（`\\server\share\...`）
//   ② **盘符绝对路径**（`D:\frank\...` / `d:/frank/...`）
//   ③ **POSIX 家目录类绝对路径**（`/home/...` / `/c/Users/...` / `/Users/...` / `/root/...`）
//   ④ **43+ 字符高熵串**（无前缀的裸 token）
// 为什么不塞进 canonical 的 PATTERNS：canonical 的消费方是 **QA 工件与 `--scan` 全仓扫描**
// （scripts/dao-redact.mjs）。把「绝对路径」加进那张表，等于让全仓扫描把每个文件里的每条
// 路径都报成命中——判据一旦开始大量误报，读的人就会开始忽略它，那正是 `286c9b3` 砍掉的
// 四支软提醒的死法。⇒ 分层：工件面用 canonical，**会话态/播报面用本文件的 `redact()`**。
//
// ── 🚧 路径这一层的安全边界（PR #894 审官 P1 + 大脑一轮红，别读成全包）───────
// 首版三条路径正则用「段内不许有空格」的字符类，于是**在空格处截断**：
//   `C:\Users\Jane Doe\windsurf dao\notes.txt` → `[REDACTED:win-path] Doe\windsurf dao\notes.txt`
// 用户名 `Jane Doe` 的后半截、连同其余目录名照样进了事件。UNC 更是整条漏过。
//
// 中间修法是「中间段可带空格、末段带空格须有扩展名」。**那一版仍然漏用户名**：
//   `C:\Users\Jane Doe` （路径就停在用户名这一段）→ `[REDACTED:win-path] Doe`
//   `/home/jane doe` → `[REDACTED:posix-path] doe`
// 也就是说「用空格当终止符」这条路本身是错的——只要用户名是末段，它就漏一半。
// ⇒ 现在**空格不是终止符**。终止符只认：引号（`"` `'` `` ` ``）、换行/制表这类空白、
//   以及 `; , < > | * ? :` 与「后面不接分隔符的 `)` `]` `}`」。空格一律算路径的一部分。
//
// **代价（明确写死，不冒充无损）**：路径后面紧跟的、没有句读隔开的字也会被一起打码——
//   `路径 C:\a\b.txt 已改好` → `路径 [REDACTED:win-path]`
// 这是刻意选的：「多脱一句话」与「漏半个用户名」不是同一量级的错，而本层的硬要求是
// 绝对路径不进事件（见下面「宁多勿漏」）。想让后面的话留下来，用引号或标点隔开。
// `)` `]` `}` 的那道前视是为 `C:\Program Files (x86)\app\x.txt` 留的：闭括号后面还接
// 分隔符时它属于路径，收尾时才算终止 ⇒ 不会在 `(路径)` 这种写法里留下 `)\app\x.txt` 残段。
//
// **仍然刻意不认的一格**：**正斜杠 UNC**（`//server/share`）——那个形状与 URL
// （`https://host/path`）无法用正则分开，认它就会把每条链接都吃掉。UNC 只认反斜杠形。
// 这一格与上面那条「吃掉后半句」的代价各有一条测试钉着现状
// （tests/redact-session.test.js ⑦ 组）；哪天有人收紧了，那里翻红是好事，照着改断言即可。
//
// ── 占位形状：沿用 `[REDACTED:<name>]`，没换成 `<redacted:key>` ───────────────
// 任务书举的例子是 `<redacted:key>`（原文「如」）。这里沿用 canonical 的 `[REDACTED:<name>]`，
// 理由是**幂等**：那个形状被刻意设计成「不含任何模式认得的字符形状」，于是重复跑输出逐字节
// 相同（canonical 有断言钉着，本文件的 EXTRA 也照这条设计并另有断言）。混两种占位形状 =
// 两套幂等性要各自验，且日后没人说得清哪个函数留下的是哪个。要求（形状可辨、内容无用）
// 两种都满足，取已经有回归网钉着的那个。
//
// ── 失败方向：宁多勿漏（继承 canonical 的声明）──────────────────────────────
// 路径整条替换、不保留末段文件名。想在事件里留文件身份，**传仓内相对路径**
// （`git diff --name-only` / `git log --name-only` 给出来的本来就是相对路径），
// 别传绝对路径再指望脱敏留一半。
// 高熵串这一层刻意**不吃**：纯小写十六进制（git sha 是这一类，40 字符且无大写 ⇒ 必须留，
// 它是 audit.bypass 的 evidence 本体）、含 `/` 的串（URL 路径段；真凭据那几类前缀模式已经吃掉）。
//
// 真相源：本文件（ESM 面 + EXTRA 四类）；凭据模式表的真相源在 scripts/lib/redact.js。

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const canonical = require('./redact.js');

// ── 路径正则的零件 ──────────────────────────────────────────────────────────
// 拼字符串而不是写一条长正则字面量：「路径体」的规则在三条路径模式里逐字相同，
// 抄三遍必然有一遍抄错——这正是 canonical 头注在说的漂移，只是尺度小了一号。
// 零件在此处只有一份，三条模式共用。
//
// 路径体 = 一串 ATOM。ATOM 三选一，每支只吃**一个字符**且三支互斥
// （PLAIN 排掉了 `)]}` 与空格，CLOSER 只吃 `)]}`，SPACE 只吃空格）⇒ 逐字符确定，
// 没有歧义分支，`ATOM*` 不会指数回溯。
//
// PLAIN：普通字符。排掉的就是终止符全集——空白、引号、`; , < > | * ?`、以及 `:`
//   （盘符那个冒号由锚点吃掉；路径段里本来就不许有 `:`，排掉它顺手挡住 `时间: 12` 这种粘连）。
const PLAIN = '[^\\s"\'`;,<>|*?:)\\]}]';
/** CLOSER：`)` `]` `}` 只在**后面还接分隔符**时算路径的一部分（`Program Files (x86)\app`）。 */
const CLOSER = '[)\\]}](?=[\\\\/])';
/**
 * 一条新路径的开头（盘符或 UNC）。SPACE 遇到它就**不吃这个空格**，把下一条路径让出去。
 * 不让的后果是残段而不是多脱：`C:\a\b.txt D:\c\d.txt` 里 `D` 会被当普通字符吃掉、
 * 而 `:` 是终止符 ⇒ 停在 `D` 后面，留下 `:\c\d.txt` 这半条路径。让出去则两条各自整条命中。
 */
const ROOT_AHEAD = '(?:[A-Za-z]:[\\\\/]|\\\\{2})';
/**
 * SPACE：空格算路径的一部分（空格不是终止符），但两条守卫——
 *   · 必须后接有效字符 ⇒ 尾随空格与「空格+标点」不吃进来
 *   · 后面不能是新路径的开头 ⇒ 见 ROOT_AHEAD
 */
const SPACE = `[ ](?!${ROOT_AHEAD})(?=${PLAIN}|[)\\]}])`;
/** 路径体：终止符之前的一切，空格在内。空格不是终止符（见头注 🚧 段）。 */
const BODY = `(?:${PLAIN}|${CLOSER}|${SPACE})`;

/** POSIX 只吃**会暴露机器布局/用户名**的那几个根。刻意不吃 `/usr` `/etc`（公共布局、无身份信息）。 */
const POSIX_ROOTS = '(?:[a-z]/Users|Users|home|root|mnt|media|srv|opt|var/(?:log|lib))';

/**
 * 第二层模式表：canonical 刻意不收的四类。
 * **顺序有意义**：UNC 先于盘符（`\\` 形不该被别的规则先咬一口），路径先于高熵串
 * （`\` `/` 会把高熵串的连续段切断，反过来跑会让高熵层先吃掉路径里的某一段，留下半条路径）。
 */
export const EXTRA_PATTERNS = [
  {
    name: 'unc-path',
    // \\server\Jane Doe\share\secret.txt。只认反斜杠形——正斜杠形与 URL 分不开，见头注 🚧。
    re: new RegExp(`\\\\{2}${BODY}+`, 'g'),
    replace: '[REDACTED:unc-path]',
  },
  {
    name: 'win-path',
    // D:\frank\... / d:/frank/...（盘符 + 至少一段）。两种分隔符都吃，混用也吃。
    // `\b` 挡住 URL scheme：`https:` 里 `:` 前是 `s`，但 `p`→`s` 之间没有词边界 ⇒ 不命中。
    re: new RegExp(`\\b[A-Za-z]:[\\\\/]${BODY}*`, 'g'),
    replace: '[REDACTED:win-path]',
  },
  {
    name: 'posix-path',
    // 前面的 lookbehind 要求这个 `/` 真是路径开头：`foo/home/bar` 这种相对路径里的
    // `/home/bar` 不该被当成家目录（首版没有这道守卫）。
    re: new RegExp(`(?<![\\w.\\-])/${POSIX_ROOTS}/${BODY}*`, 'g'),
    replace: '[REDACTED:posix-path]',
  },
  {
    name: 'high-entropy',
    // 43+ 字符、混大小写且含数字的连续串 = 裸 token 的形状。
    // 三个前视断言就是「高熵」的可判定近似：
    //   · 纯小写十六进制（git sha / 内容哈希）无大写 ⇒ 不命中（必须留，evidence 靠它）
    //   · 英文长句无 43 字符连续无分隔段 ⇒ 不命中
    //   · 含 `/` 的 URL 段不在字符集里 ⇒ 不命中（真凭据由前缀模式吃）
    re: /\b(?=[A-Za-z0-9_+=-]*[a-z])(?=[A-Za-z0-9_+=-]*[A-Z])(?=[A-Za-z0-9_+=-]*[0-9])[A-Za-z0-9_+=-]{43,}\b/g,
    replace: '[REDACTED:high-entropy]',
  },
];

// 正则带 /g 有 lastIndex 状态；`test`/`exec` 复用模块级对象会**随机漏报**（只在多次调用时
// 显形）。照 canonical 的做法：每次现克隆。
function freshRe(p) {
  return new RegExp(p.re.source, p.re.flags);
}

/**
 * 会话态/播报面的脱敏纯函数。= canonical 凭据模式表（委派，不重写）+ EXTRA 四类。
 * 幂等：`redact(redact(s)) === redact(s)`（有断言钉着）。
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  if (text === null || text === undefined) return text;
  // ① 凭据：整表委派 canonical。这里**一条正则都不写** ⇒ 无从漂移。
  let out = canonical.redactText(String(text));
  // ② 会话态那一层 canonical 刻意不收的四类。
  for (const p of EXTRA_PATTERNS) out = out.replace(freshRe(p), p.replace);
  return out;
}

/** 命中了**哪些类**（两层合起来），只报类名不报值——报告本身不许成为新的泄漏面。 */
export function redactHits(text) {
  if (text === null || text === undefined || text === '') return [];
  const s = String(text);
  const hits = canonical.patternsHit(s);
  for (const p of EXTRA_PATTERNS) if (freshRe(p).test(s)) hits.push(p.name);
  return hits;
}

/** 深度脱敏：对象/数组里的每个字符串过 `redact()`；键名原样（键名不是值，不含凭据）。 */
export function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

// canonical 的其余能力按需转出，别让调用方再去 createRequire 一次（那是第二个 import 面）。
export const { redactText, patternsHit, maskValue, PATTERNS, RedactError } = canonical;
