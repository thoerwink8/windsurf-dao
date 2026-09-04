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
// 两类 canonical **刻意没有**的模式，加成**独立的第二层**（EXTRA_PATTERNS）：
//   ① **绝对路径**（`D:\frank\...` / `/home/orca/...` / `/c/Users/...`）
//   ② **43+ 字符高熵串**（无前缀的裸 token）
// 为什么不塞进 canonical 的 PATTERNS：canonical 的消费方是 **QA 工件与 `--scan` 全仓扫描**
// （scripts/dao-redact.mjs）。把「绝对路径」加进那张表，等于让全仓扫描把每个文件里的每条
// 路径都报成命中——判据一旦开始大量误报，读的人就会开始忽略它，那正是 `286c9b3` 砍掉的
// 四支软提醒的死法。⇒ 分层：工件面用 canonical，**会话态/播报面用本文件的 `redact()`**。
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
// 真相源：本文件（ESM 面 + EXTRA 两类）；凭据模式表的真相源在 scripts/lib/redact.js。

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const canonical = require('./redact.js');

/**
 * 第二层模式表：canonical 刻意不收的两类。顺序有意义——路径先跑（`\` `/` 会把高熵串的
 * 连续段切断，反过来跑会让高熵层先吃掉路径里的某一段，留下半条路径）。
 */
export const EXTRA_PATTERNS = [
  {
    name: 'win-path',
    // D:\frank\... / d:/frank/...（盘符 + 至少一段）。两种分隔符都吃，混用也吃。
    re: /\b[A-Za-z]:[\\/](?:[^\s\\/:*?"<>|]+[\\/]?)+/g,
    replace: '[REDACTED:win-path]',
  },
  {
    name: 'posix-path',
    // 只吃**会暴露机器布局/用户名**的那几个根：家目录、git-bash 盘符挂载、常见服务根。
    // 刻意不吃 `/usr/...` `/etc/...`（公共布局，无身份信息，且它们大量出现在正常叙述里）。
    re: /(?:\/(?:[a-z]\/Users|Users|home|root|mnt|media|srv|opt\/[^\s/]+|var\/(?:log|lib)))(?:\/[^\s:;,"'`)\]}]+)+/g,
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
 * 会话态/播报面的脱敏纯函数。= canonical 凭据模式表（委派，不重写）+ EXTRA 两类。
 * 幂等：`redact(redact(s)) === redact(s)`（有断言钉着）。
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  if (text === null || text === undefined) return text;
  // ① 凭据：整表委派 canonical。这里**一条正则都不写** ⇒ 无从漂移。
  let out = canonical.redactText(String(text));
  // ② 会话态那一层 canonical 刻意不收的两类。
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
