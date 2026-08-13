// redact.js — 凭据脱敏两层防线（canonical，跨项目通用）
//
// ── 这是什么、从哪来 ─────────────────────────────────────────────────────────
// 两层防线，上移自 devin-byok（2026-08-02 三仓「自上而下」审计第 8 件）：
//   **第一层 · 工件层**：QA / 诊断工件**落盘前**过一道脱敏（`redactText` / `redactFileTo`）。
//   **第二层 · 渲染层**：UI 渲染面「密钥不得出现」的自动断言（`assertNoSecretLeak`）——
//   它与第一层**不是冗余**：第一层管的是「写进文件的东西」，第二层管的是「屏幕上显示的
//   东西」，后者会经由截图、录屏、结对演示离开本机，而那条路上没有任何过滤器。
// 原实现散在那个仓的三处（`internal/capture/redact.go` / `scripts/qa-full.ps1` 的
// `Redact-Text` / `scripts/ui-smoke.js` 的 `assertNoSecretLeak`），三份判据各自演进、
// 已实证漂移过一次（Go 侧补了 `api_key` snake_case 命名，PS 侧至今只认 4 个键名）。
// **本文件是这两层的唯一真相源**；项目侧持有的是调用，不是副本。
//
// ── 风险模型（照核验官的降级后表述写，别写成更吓人的那版）───────────────────
// 那些仓是**私有**的 ⇒ 风险**不是**「密钥被发到公网上了」。真实风险是：
//   **密钥被 commit 进 git 历史之后就永久留在那里** —— 后来删掉那个文件也删不掉历史里的
//   那一份，除非 rewrite 全仓历史（而那要求每个 clone 重来）。仓一旦转公开、或某天多一个
//   协作者、或某次 `git bundle` 出去，那份历史整个跟着走。
// 换言之：这道防线买的是**「别把它写进去」**，不是「写进去了再补救」——后者没有便宜的补救。
//
// ── 🚧 射程：只管**文本**，不管截图（核验官点名要求注明，别读成全包）───────────
// 本文件的全部能力都建立在「内容是可解码的文本」之上。**截图 / 录屏 / PDF / 任何二进制
// 工件里的密钥，这套一个字都挡不住**——密钥在 PNG 里是像素，正则看不见它。
// 这不只是一句免责声明，它被做成了**行为**：`redactFileTo` / `redactFileInPlace` 遇到
// 二进制内容**当场拒绝并抛错**（不是「跳过」也不是「原样复制」）。理由：一个静默跳过的
// 二进制文件，和一个真的被脱敏过的文本文件，在调用方眼里长得一模一样，而前者是裸的。
// ⇒ 截图那一面归**流程**管（dao.md Shell 节 G4 截图落盘闸 + 截图前先把密钥输入框清空 /
//   用假 key），不归本文件管。别因为「工件走过 redact 了」就认为截图也安全了。
//
// ── fail-closed：本次上移**修掉的最危险的一格** ──────────────────────────────
// 原 PS 实现是：把原始文件**先复制到工件目录**，再对副本 in-place 脱敏，而那一步包在
// `try { ... } catch { }` 里 —— **catch 是空的**。于是脱敏一旦抛错（文件被占用 / 编码异常 /
// 磁盘满），**裸的那一份原样留在工件目录里，没有任何人会知道**：函数返回、脚本继续、
// 退出码 0、日志上什么都没有。这是「静默失效」最纯的形态，而它守的恰好是密钥。
// 本文件的三条 fail-closed 契约：
//   ① **绝不先落裸副本**：`redactFileTo` 是「读源 → 脱敏 → 写目标」，目标位置从来没有过
//      未脱敏的内容（原 PS 的 `Copy-Item` + in-place 那个次序，中间有一个真空窗口）。
//   ② **失败一律抛错**，且抛出的 Error 带 `code`（`EBINARY` / `EREDACT` / `EIO`）——
//      调用方可以决定怎么办，但**没有一条路径是「安静地什么都不做」**。
//   ③ **in-place 失败即隔离**：`redactFileInPlace` 走到一半失败时，那个文件**已经在盘上
//      且可能是裸的** ⇒ 默认把它覆写成一行说明（`onFailure:"quarantine"`）；覆写也失败就
//      删；删也失败才抛「需要人手处置」。**宁可毁掉一份工件，不留一份裸密钥** —— 工件是
//      派生物（重跑一次就有），密钥进了 git 历史是不可逆的。这条是**判断**不是照做，故
//      做成显式参数，且 `onFailure:"throw"` 可关掉（关掉时调用方自己负责那个文件）。
//
// ── 失败方向：宁多勿漏（over-redact 优于 under-redact）──────────────────────
// 判据类库都要声明失败方向。本文件选**多脱**：`"max_tokens": "1024"` 这类键名含 `token`
// 的无辜字段会被打码（devin 原版同病，刻意不修），因为工件是给人读排障的，多几个
// `[REDACTED:*]` 只是不方便；漏一个是不可逆的。**需要那个值的排障场景，去读没脱敏的源**
// （`redactFileTo` 不动源文件），不要为了好读而放宽这里的正则。
//
// ── 为什么是一份 Node 实现，而不是 Node + PowerShell 两份 ────────────────────
// 消费方跨语言（devin 的 QA 链是 PS + Go，mousse 是 PS + mjs）。两个选项：
//   (a) 每种语言一份端口 —— **被否**：两份安全过滤器必然漂移，而漂移的方向是**看不见的**：
//       弱的那一份不会报错，它只是少认几个模式，输出看起来完全正常（devin 现状即实证：
//       Go 侧认 5 类、PS 侧认 4 类，PS 那份少认的恰好是 `x-api-key` 与 snake_case）。
//   (b) 一份实现 + 一个 CLI 入口，别的语言 `node ...` 调它 —— **选它**。Node 已是 dao 的硬
//       依赖（全部 hook 都是 .js/.mjs），不引入新依赖；CLI 见 scripts/dao-redact.mjs。
//
// ── 全域分布摸底（建护栏前先摸，dao-writing-rules.md 第二节第一条）─────────────────
// 2026-08-02 用本文件的 `--scan` 对四个仓的工件面实扫一遍（**数字、分类与命令的唯一真相源
// 在 `scripts/dao-redact.mjs` 头注的「摸底」段，本处只留结论，不复述数字**）。
// 结论两句，两句都要读：
//   ① **dao 自己的 `_tmp/` 里此刻就有真凭据**（cc-switch provider 配置的 live dump + 一份 MCP
//      配置文档），产出它们的那条链一个脱敏步都没有 —— 即本条不是纸面风险。
//   ② **但它们没有进 git 历史**（`_tmp/` 是 gitignore 第一行、`git ls-files _tmp` 为空）
//      ⇒ 真实暴露面是「`_tmp/` 的内容被整段贴进 PR / issue / 交付报告」，不是「已经泄漏了」。
// 照直记 —— 既别说成「上线当天救了火」，也别说成「纯粹纸上谈兵」。
//
// ── 自检那一半（dao-writing-rules.md 第二节「自检不复用被守对象的解析」「输出不落在自己扫描面内」）────────────────────────────
// · **「我是不是瞎了」不能靠同一套正则回答**：`scanTree` 的分母（看了几个文件）由**目录遍历**
//   产出，与正则毫无关系，且 `binarySkipped` / `unreadable` **分开计数、分开打印**。
//   「零命中」与「一个样本都没看到」因此在输出上分得开——后者 `scanned=0`，且 unreadable>0
//   会让 CLI 走 fail-closed 退出码。
// · **检查器的输出不能落进自己的扫描面**：`scanTree` 的命中项**只报路径 + 行号 + 模式名 +
//   打码预览**，**从不回显密钥原文**。否则扫描报告本身成了新的泄漏面，而且下一轮扫它自己
//   会越扫越多（那正是「每跑一次命中更多」那条实证）。同理 `findLeaks` 只返回打码值。
//
// 真相源：windsurf-dao/scripts/lib/redact.js

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// ── 模式表 ──────────────────────────────────────────────────────────────────
// 每条：{ name, re, replace }。**顺序有意义**：行级模式（cookie/header/env）先跑，
// 值级模式（sk/jwt/...）后跑 —— 反过来会让行级模式匹配到已经打过码的行，结果一样但
// 少一次替换。`replace` 里的标记形如 `[REDACTED:<name>]`，刻意**不含**任何模式认得的
// 字符形状 ⇒ `redactText` 幂等（重复跑输出逐字节相同，有断言钉着）。
const PATTERNS = [
  // —— 行级：HTTP 头 / 环境变量 / YAML 键 ——
  {
    name: "cookie-line",
    re: /^([ \t]*(?:set-cookie|cookie)[ \t]*:[ \t]*).*$/gim,
    replace: "$1[REDACTED:cookie-line]",
  },
  {
    name: "auth-header-line",
    re: /^([ \t]*(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token)[ \t]*:[ \t]*).*$/gim,
    replace: "$1[REDACTED:auth-header-line]",
  },
  {
    name: "env-assign",
    // FOO_API_KEY=... / export ANTHROPIC_AUTH_TOKEN=... / SOME_SECRET="..."
    re: /^([ \t]*(?:export[ \t]+|set[ \t]+)?[A-Za-z0-9_]*(?:API[_-]?KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*[ \t]*=[ \t]*)\S.*$/gim,
    replace: "$1[REDACTED:env-assign]",
  },
  {
    name: "yaml-kv",
    // yaml/ini 形态的 `api_key: xxx`（值不带引号也要吃到）
    re: /^([ \t]*[A-Za-z0-9_-]*(?:api[_-]?key|apikey|token|secret|password|passwd|credential|authorization)[A-Za-z0-9_-]*[ \t]*:[ \t]+)(?!\[REDACTED)\S.*$/gim,
    replace: "$1[REDACTED:yaml-kv]",
  },
  // —— 结构化：JSON 键值 ——
  {
    name: "json-kv",
    re: /("[A-Za-z0-9_-]*(?:api[_-]?key|apikey|authorization|cookie|token|secret|password|passwd|credential)[A-Za-z0-9_-]*"[ \t]*:[ \t]*)"(?:[^"\\]|\\.)*"/gi,
    replace: '$1"[REDACTED:json-kv]"',
  },
  // —— 值级：按凭据自身的形状 ——
  {
    name: "private-key-block",
    re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
    replace: "[REDACTED:private-key-block]",
  },
  {
    name: "bearer",
    re: /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: "Bearer [REDACTED:bearer]",
  },
  {
    // sk- 系：OpenAI / Anthropic（sk-ant-…）/ 各类兼容网关
    name: "sk-key",
    re: /\bsk-[A-Za-z0-9._~+/=-]{8,}/g,
    replace: "[REDACTED:sk-key]",
  },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replace: "[REDACTED:jwt]",
  },
  {
    name: "google-api-key",
    re: /\bAIza[A-Za-z0-9_-]{20,}/g,
    replace: "[REDACTED:google-api-key]",
  },
  {
    name: "github-token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
    replace: "[REDACTED:github-token]",
  },
  {
    name: "slack-token",
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    replace: "[REDACTED:slack-token]",
  },
  {
    name: "aws-access-key-id",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: "[REDACTED:aws-access-key-id]",
  },
];

// 正则带 /g ⇒ 有 lastIndex 状态。全部调用点都用 String.replace（它自己会重置 lastIndex），
// 唯独 `scanText` 要逐条 exec ⇒ 那里现克隆一份，绝不复用模块级对象（复用会让第二次扫描
// 从上次的 lastIndex 开始，表现为**随机漏报**，且只在多次调用时出现）。
function freshRe(p) {
  return new RegExp(p.re.source, p.re.flags);
}

class RedactError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = "RedactError";
    this.code = code;
    Object.assign(this, extra || {});
  }
}

// ── 第一层 · 工件层 ─────────────────────────────────────────────────────────

// 纯函数。幂等（有断言钉着）。失败方向：宁多勿漏，见头注。
function redactText(s) {
  if (s === null || s === undefined) return s;
  let out = String(s);
  if (out === "") return out;
  for (const p of PATTERNS) {
    out = out.replace(freshRe(p), p.replace);
  }
  return out;
}

// 只报**哪一类命中了**，不报值本身（自检那一半的第三条：输出不落进自己的扫描面）。
function patternsHit(s) {
  const hits = [];
  if (!s) return hits;
  for (const p of PATTERNS) {
    if (freshRe(p).test(String(s))) hits.push(p.name);
  }
  return hits;
}

// 打码预览：留头 2 尾 2，中间一律 `…`。任何回显密钥的地方都必须过它。
function maskValue(v) {
  const s = String(v == null ? "" : v);
  if (s.length <= 6) return "*".repeat(s.length);
  return s.slice(0, 2) + "…" + "*".repeat(Math.min(6, s.length - 4)) + "…" + s.slice(-2);
}

// 二进制判据：前 8KiB 里有 NUL 字节即判二进制。**近似**，两个方向都构造得出反例
// （全 ASCII 的 .bin 会被当文本；前 8KiB 恰好没有 NUL 的大二进制会被当文本）。
// 选它是因为它零依赖且对 PNG/JPEG/PDF/exe 这些**真实的截图类工件**判得准，
// 而那正是本条要挡的东西。失败方向：判成文本 ⇒ 后面 UTF-8 解码会产出替换字符，
// 内容毁掉但**不会静默留裸文件**；判成二进制 ⇒ 抛错，调用方当场知道。
function isProbablyBinary(buf) {
  if (!Buffer.isBuffer(buf)) return false;
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function readTextOrThrow(p) {
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch (e) {
    throw new RedactError("EIO", `读不到文件（fail-closed：读不到就不能声称脱敏过）：${p} —— ${e.message}`, { path: p });
  }
  if (isProbablyBinary(buf)) {
    throw new RedactError(
      "EBINARY",
      `二进制工件不在本防线射程内（截图/录屏里的密钥正则看不见）：${p} —— ` +
        "别把它当已脱敏；截图那一面归流程管（截图前清空密钥输入框 / 用假 key）",
      { path: p }
    );
  }
  return buf.toString("utf8");
}

// 原子写：同目录 tmp + rename。**不落半截文件** —— 半截的脱敏结果与完整的长得一样，
// 而它可能恰好在密钥那一行被截断之前。
function writeAtomic(dest, text) {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.redact-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* tmp 清不掉不影响正确性：它本身是脱敏后的内容 */ }
    throw new RedactError("EIO", `写目标失败（fail-closed：目标位置不会留下任何未脱敏内容）：${dest} —— ${e.message}`, { path: dest });
  }
}

// 【推荐用法】读源 → 脱敏 → 写目标。**源文件不动**，目标位置从来没有过裸内容。
// opts.redactFn：可注入的转换（项目要额外脱自己的东西时用；回归网也靠它注入失败）。
// 返回 { bytesIn, bytesOut, hits }。任何失败都抛 RedactError，**没有安静的失败路径**。
function redactFileTo(src, dest, opts) {
  const o = opts || {};
  const fn = o.redactFn || redactText;
  const text = readTextOrThrow(src);
  let redacted;
  try {
    redacted = fn(text);
  } catch (e) {
    throw new RedactError("EREDACT", `脱敏抛错，拒绝落盘（原 PS 实现在这里是空 catch ⇒ 裸文件留在工件目录）：${src} —— ${e.message}`, { path: src });
  }
  if (typeof redacted !== "string") {
    throw new RedactError("EREDACT", `脱敏函数返回了非字符串（${typeof redacted}），拒绝落盘：${src}`, { path: src });
  }
  writeAtomic(dest, redacted);
  return { bytesIn: Buffer.byteLength(text, "utf8"), bytesOut: Buffer.byteLength(redacted, "utf8"), hits: patternsHit(text) };
}

// 隔离：把一个可能是裸的文件变成不可读。三级降级，每级都比「留着」强。
function quarantine(target, reason) {
  const note =
    "[dao-redact] 本文件已被隔离：脱敏未能完成，原始内容含未知凭据风险，已按 fail-closed 覆写。\n" +
    `原因：${reason}\n` +
    "工件是派生物，重跑一次即可；密钥进了 git 历史是不可逆的。\n";
  try {
    fs.writeFileSync(target, note, "utf8");
    return "overwritten";
  } catch (_) { /* 落到下一级 */ }
  try {
    fs.unlinkSync(target);
    return "deleted";
  } catch (_) { /* 落到下一级 */ }
  return "failed";
}

// 【就地脱敏】文件已经在盘上时用。opts.onFailure：
//   "quarantine"（缺省）—— 失败即把该文件覆写/删除，然后抛错。
//   "throw"            —— 只抛错，文件原样留着（**调用方自己负责它**，别默认选这个）。
function redactFileInPlace(target, opts) {
  const o = opts || {};
  const onFailure = o.onFailure || "quarantine";
  if (onFailure !== "quarantine" && onFailure !== "throw") {
    throw new RedactError("EARG", `onFailure 只能是 "quarantine" 或 "throw"，收到：${String(onFailure)}`);
  }
  const fn = o.redactFn || redactText;
  let text;
  try {
    text = readTextOrThrow(target);
  } catch (e) {
    // 读不到 / 是二进制 ⇒ **我们不知道它里面有什么**。fail-closed 的定义就是「不知道时按最坏算」。
    // 但二进制这一路刻意**不隔离**：那多半是有人把截图喂进来了，毁掉它没有意义且是误伤
    // （它本来就不在射程内，见头注 🚧）。只有「读失败」才隔离。
    if (e.code === "EBINARY" || onFailure === "throw") throw e;
    e.quarantine = quarantine(target, e.message);
    throw e;
  }
  let redacted;
  try {
    redacted = fn(text);
    if (typeof redacted !== "string") throw new Error(`脱敏函数返回了非字符串（${typeof redacted}）`);
    writeAtomic(target, redacted);
  } catch (e) {
    const err = e instanceof RedactError ? e : new RedactError("EREDACT", `就地脱敏失败：${target} —— ${e.message}`, { path: target });
    if (onFailure === "throw") throw err;
    err.quarantine = quarantine(target, err.message);
    throw err;
  }
  return { bytes: Buffer.byteLength(redacted, "utf8"), hits: patternsHit(text) };
}

// ── 扫描（检出，不改盘）────────────────────────────────────────────────────
// 返回 [{ line, pattern, preview }]，**preview 是打码后的**（见头注自检第三条）。
function scanText(text) {
  const out = [];
  if (!text) return out;
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const p of PATTERNS) {
      const re = freshRe(p);
      let m;
      // 行级模式带 m 标志，逐行喂给它照样成立
      while ((m = re.exec(lines[i])) !== null) {
        out.push({ line: i + 1, pattern: p.name, preview: maskValue(m[0]) });
        if (m[0] === "") break; // 防零宽匹配死循环
      }
    }
  }
  return out;
}

const DEFAULT_SKIP_DIRS = new Set([
  ".git", "node_modules", "target", "dist-newstyle", "vendor", ".venv", "venv",
  "__pycache__", ".next", ".nuxt", ".turbo", "coverage",
]);

// 目录树扫描。**分母（scanned）由遍历产出，与正则无关**；binarySkipped / unreadable
// 分开计数 ⇒「零命中」与「一个样本都没看到」在输出上分得开（自检那一半的第一条）。
function scanTree(root, opts) {
  const o = opts || {};
  const skip = o.skipDirs || DEFAULT_SKIP_DIRS;
  const maxBytes = o.maxBytes || 4 * 1024 * 1024;
  const res = { root, scanned: 0, binarySkipped: 0, unreadable: 0, tooLarge: 0, findings: [], unreadablePaths: [] };
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = fs.statSync(cur); } catch (_) { res.unreadable++; res.unreadablePaths.push(cur); continue; }
    if (st.isDirectory()) {
      let ents;
      try { ents = fs.readdirSync(cur, { withFileTypes: true }); }
      catch (_) { res.unreadable++; res.unreadablePaths.push(cur); continue; }
      for (const e of ents) {
        if (e.isDirectory() && skip.has(e.name)) continue;
        stack.push(path.join(cur, e.name));
      }
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > maxBytes) { res.tooLarge++; continue; }
    let buf;
    try { buf = fs.readFileSync(cur); }
    catch (_) { res.unreadable++; res.unreadablePaths.push(cur); continue; }
    if (isProbablyBinary(buf)) { res.binarySkipped++; continue; }
    res.scanned++;
    for (const f of scanText(buf.toString("utf8"))) {
      res.findings.push({ file: cur, line: f.line, pattern: f.pattern, preview: f.preview });
    }
  }
  return res;
}

// ── 第二层 · 渲染层 ─────────────────────────────────────────────────────────

const SECRET_KEY_RE = /(api[_-]?key|apikey|authorization|cookie|token|secret|password|passwd|credential)/i;
// 值本身长得像凭据（即使键名平平无奇）。与 SECRET_KEY_RE 是**两条独立的路**：
// 键名认不出的靠形状认，形状认不出的靠键名认。
const SECRET_VALUE_RE = /^(sk-|Bearer\s|eyJ[A-Za-z0-9_-]{4,}\.|AIza|gh[pousr]_|github_pat_|xox[abprs]-|AKIA|ASIA)/;

// 从「喂给被测程序的那份配置」里收集**真值**，供第二层做精确子串断言。
// 精确值断言比正则强：它连「被 UI 截断成前 8 位显示」这种半泄漏都夹得住吗？——不，
// 截断后的子串它夹不住（诚实边界，见 assertNoSecretLeak 的注释）。
function collectSecretValues(value, out) {
  const acc = out || [];
  const walk = (v, keyHint) => {
    if (v == null) return;
    if (typeof v === "string") {
      if (!v) return;
      if ((keyHint && SECRET_KEY_RE.test(keyHint)) || SECRET_VALUE_RE.test(v)) acc.push(v);
      return;
    }
    if (Array.isArray(v)) { v.forEach((c) => walk(c, keyHint)); return; }
    if (typeof v === "object") {
      for (const [k, c] of Object.entries(v)) walk(c, k);
    }
  };
  walk(value, null);
  return Array.from(new Set(acc));
}

// 只返回**打码**信息，绝不回显原值（自检第三条）。
function findLeaks(text, secrets) {
  const t = String(text == null ? "" : text);
  const out = [];
  for (const s of secrets || []) {
    if (!s || typeof s !== "string") continue;
    const at = t.indexOf(s);
    if (at !== -1) out.push({ masked: maskValue(s), index: at, length: s.length });
  }
  return out;
}

// 【第二层的断言】渲染面（DOM innerText / 终端输出 / 报告正文）里不得出现任何配置里的真密钥。
//
// 🔴 **本函数比 devin 原版多两道 fail-closed，那两道治的是同一个病**：
//   ① `secrets` 为空 ⇒ **抛错**（除非显式 `allowEmpty:true`）。一个没有样本的断言恒为真，
//      它照常打印 PASS、照常被写进交付 —— 「零违例」与「零样本」不可区分的教科书形态。
//      devin 原版靠**手工 push 三个固定值**兜底（`secretValues.push("sk-smoke", ...)`），
//      那是对的做法但没有护栏：哪天种子配置换了、那三行被删了，断言就静默退化成永真。
//   ② `text` 为空 ⇒ **抛错**（除非 `allowEmpty:true`）。页面没加载出来时 innerText 是 ""，
//      而 "" 里当然不含任何密钥 —— 于是**渲染失败会伪装成安全**。
//
// 诚实边界（本函数**不**保证的事）：
//   · 只做**精确子串**匹配。UI 把 key 截断显示（`sk-abc…`）、或分片渲染（每字符一个 span、
//     innerText 里被空格隔开）时**夹不住**。要覆盖那一面得再加一条「渲染面跑一遍 scanText」
//     的断言 —— 那条**误报率高**（页面上出现 `sk-` 开头的示例文案就红），故不做成默认。
//   · 它证明的是「这一帧没泄漏」，不是「这个页面永远不泄漏」。
function assertNoSecretLeak(text, secrets, opts) {
  const o = typeof opts === "string" ? { label: opts } : (opts || {});
  const label = o.label || "assertNoSecretLeak";
  const list = (secrets || []).filter((s) => typeof s === "string" && s.length > 0);
  if (!o.allowEmpty && list.length === 0) {
    throw new RedactError("ENOSAMPLE",
      `${label}: 密钥样本为空 ⇒ 这条断言恒为真（零违例与零样本不可区分）。` +
      "要么真的收集到样本，要么显式传 allowEmpty:true 并说明为什么这里没有样本。");
  }
  const t = String(text == null ? "" : text);
  if (!o.allowEmpty && t.length < (o.minTextLength || 1)) {
    throw new RedactError("ENOSAMPLE",
      `${label}: 被检文本为空 ⇒ 渲染失败会伪装成「没泄漏」。若确要允许空文本，显式传 allowEmpty:true。`);
  }
  const leaks = findLeaks(t, list);
  if (leaks.length) {
    throw new RedactError("ELEAK",
      `${label}: 渲染面出现了配置里的真密钥（${leaks.length} 处，只打码显示）：` +
      leaks.map((l) => `${l.masked}@${l.index}`).join(", "), { leaks });
  }
  return { checked: list.length, textLength: t.length };
}

module.exports = {
  // 第一层
  redactText, redactFileTo, redactFileInPlace, patternsHit, quarantine,
  // 扫描
  scanText, scanTree, isProbablyBinary,
  // 第二层
  collectSecretValues, findLeaks, assertNoSecretLeak,
  // 公共
  maskValue, RedactError, PATTERNS, DEFAULT_SKIP_DIRS,
  _internal: { freshRe, writeAtomic, readTextOrThrow, SECRET_KEY_RE, SECRET_VALUE_RE, tmpdir: os.tmpdir },
};
