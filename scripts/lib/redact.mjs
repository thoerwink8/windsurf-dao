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
// ── 🚧 路径这一层的安全边界（PR #894 审官 P1 咬出来的，别读成全包）───────────
// 首版三条路径正则用「段内不许有空格」的字符类，于是**在空格处截断**：
//   `C:\Users\Jane Doe\windsurf dao\notes.txt` → `[REDACTED:win-path] Doe\windsurf dao\notes.txt`
// 用户名 `Jane Doe` 的后半截、连同其余目录名照样进了事件。UNC 更是整条漏过。
// 现在的做法：**段内允许空格**，但空格只在「这一段后面还跟着分隔符」时才算路径的一部分
// （即**中间段**可以带空格），末段带空格时要求它以扩展名收尾（`my notes.txt`）。
// 这条规则是可判定的，代价写在下面。
//
// **仍然漏的两格（明确写死，不冒充覆盖）**：
//   · **末段带空格且没有扩展名**：`C:\Users\Jane Doe\my secret folder` ⇒ 只脱到
//     `C:\Users\Jane Doe\my`，剩下 ` secret folder` 留在文本里。**敏感的那一半（用户名）
//     已经脱掉**，残留的是目录名尾巴。
//   · **正斜杠 UNC**（`//server/share`）**刻意不认**：那个形状与 URL（`https://host/path`）
//     无法用正则分开，认它就会把每条链接都吃掉。UNC 只认反斜杠形。
// 为什么不干脆贪婪吃到行尾：那会把路径后面的整句话一起打码，事件正文就没法读了；而
// 「多脱一句」和「漏一个用户名」不是同一量级的错，**但也不能拿它当借口不测**——上面两格
// 各有一条负向测试钉着现状（tests/redact-session.test.js ⑦ 组），哪天有人收紧了正则，
// 那两条会红，红的时候是好事：照着改断言即可。
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
// 拼字符串而不是写一条长正则字面量：段规则（「中间段可带空格、末段带空格须有扩展名」）
// 在三条路径模式里逐字相同，抄三遍必然有一遍抄错——这正是 canonical 头注在说的漂移，
// 只是尺度小了一号。零件在此处只有一份。
//
// WSEG/PSEG：一段路径名，**不含空格**（`\s` 排除）。两套字符类不同是因为分隔符不同：
//   Windows 段还要排掉 `:*?"<>|`（文件名非法字符），POSIX 段排掉会把句子粘进来的标点。
const WSEG = '[^\\s\\\\/:*?"<>|]+';
const PSEG = '[^\\s/:;,"\'`)\\]}]+';
/** 允许段内空格的形态：`Jane Doe`。段本身不含空格 ⇒ 这个嵌套没有歧义，不会指数回溯。 */
const spaced = seg => `${seg}(?:[ ]+${seg})*`;
/** 末段：带空格时必须以扩展名收尾（`my notes.txt`），否则退回不含空格的那一段。 */
const tail = seg => `(?:${spaced(seg)}\\.[A-Za-z0-9]{1,8}|${seg})`;

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
    re: new RegExp(`\\\\{2}(?:${spaced(WSEG)}[\\\\/])*${tail(WSEG)}`, 'g'),
    replace: '[REDACTED:unc-path]',
  },
  {
    name: 'win-path',
    // D:\frank\... / d:/frank/...（盘符 + 至少一段）。两种分隔符都吃，混用也吃。
    // `\b` 挡住 URL scheme：`https:` 里 `:` 前是 `s`，但 `p`→`s` 之间没有词边界 ⇒ 不命中。
    re: new RegExp(`\\b[A-Za-z]:[\\\\/](?:${spaced(WSEG)}[\\\\/])*(?:${tail(WSEG)})?`, 'g'),
    replace: '[REDACTED:win-path]',
  },
  {
    name: 'posix-path',
    // 前面的 lookbehind 要求这个 `/` 真是路径开头：`foo/home/bar` 这种相对路径里的
    // `/home/bar` 不该被当成家目录（首版没有这道守卫）。
    re: new RegExp(`(?<![\\w.\\-])/${POSIX_ROOTS}/(?:${spaced(PSEG)}/)*${tail(PSEG)}`, 'g'),
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
