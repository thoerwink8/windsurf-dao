// tmp-redact-sweep.js — 让「新落盘的 dump 自动脱敏」成为**机制**而不是纪律
//
// ── 它补的是哪一格（issue #101 的第 2 条方向）─────────────────────────────────
// PR #98 把脱敏两层防线上移进了 `ccswitch/lib/redact.js`，但那是一个**库**：
// 只有**调用它**的那条链受保护。而 2026-08-02 摸底捞出来的 22 处真凭据，产出者是
// **住在 `_tmp/` 里、根本不在仓内的一次性 ops 脚本** ⇒ 它们永远不会去 import 那个库，
// 也永远进不了任何「项目脚本要调 redact」的清单。**那条链接不上它们。**
//
// 关键观察：那些脚本虽然不在仓内，却**全都经由一次工具调用被跑起来**（`node _tmp/xxx.mjs`）。
// ⇒ 唯一对**所有**产出者都成立的收口点，不是产出者本身，而是**它们跑完之后那一刻**。
// 本文件就挂在那一刻：PostToolUse 之后扫一遍 `_tmp/`，新落盘的裸凭据当场就地脱敏。
// **产出者不需要合作，也不需要知道这套东西存在**——这正是「机制 vs 纪律」的分界。
//
// ── 为什么不新起一个 hook 文件 ───────────────────────────────────────────────
// 新 hook 要注册，而注册面是 cc-switch DB 的 `providers.settings_config`，**属用户动作**
// （AI 侧被权限分类器全路径拦截，dao.md Shell 节「源与投影」）。一个没注册的 hook
// 与不存在**在任何日志里长得一模一样**——本仓已有实证（`dao-tool-nudge.js` 第 ④ 类曾因
// matcher 覆盖不到而静默零投递）。故本文件**不自带 hook**，由已注册的
// `ccswitch/hooks/dao-tool-nudge.js`（PostToolUse，实测 matcher 覆盖 Bash）调用。
//
// ══ 2026-08-04 修订批（PR #108 被对抗验证判「不可合」后的第二版）══════════════
// 四个阻断项 + 一件现行危害，逐条对应到下面的判据 ⑤⑥⑦⑧ 与 ④'：
//   B1 改盘无台账、无用户可见通道  → 判据 ⑧（追加式台账）+ hook 侧 systemMessage
//   B2 预算用尽 ⇒ 水位线永久冻结   → 判据 ⑥（keyset 游标）
//   B3 目录联接改到 `_tmp/` 之外   → 判据 ⑦（realpath 圈定）
//   B4 误伤面 379                  → 判据 ⑤（白名单）
//   跑测试会改开发者真仓 `_tmp/`   → 不在本文件，在 tests/dao-tool-nudge.tests.js 的 payload
//
// ── 🔴 判据 ⑤ 白名单：唯一决定「会改哪些文件」的东西（用户 2026-08-04 拍板）─────
// 第一版扫**整个** `_tmp/`，对抗验证实测误伤 dao 2 个 / mousse-cli **379 个**（多为第三方
// skill/plugin 的文档与源码，它们只是**在文档里教人怎么填 key**）。用户拍板接受误伤时
// 看到的基数是 2。⇒ 现在改盘面由 `ccswitch/lib/tmp-sweep-scope.js` 的白名单决定。
// **「怎么表达 / 默认值是什么 / 谁能改它」三个问题的答案全在那个文件的头注，本文件不复述。**
// 本文件只承担一句判据：**不在扫描面内的文件，连读都不读。**
// 实测（2026-08-04，两个真仓只读普查）：会被改写的文件 dao 33→29（且那 29 个全部命中
// 判据 ④ 的夹具豁免 ⇒ 真实改盘 0）· mousse-cli **381→0**；扫一遍的耗时 mousse 314ms→4ms。
//
// ── 🔴 八条设计判据（改本文件前逐条读一遍，它们各自防一个具体的死法）──────────
//
// ① **幂等判据用 `redactText(t) === t`，不用「scanText 有没有命中」**。
//    脱敏后的文本里留着 `[REDACTED:json-kv]` 这样的标记，而 `json-kv` 那条正则**照样命中它**
//    （命中后替换成同样的内容）。若拿「有命中」当触发条件，每次 Bash 调用都会把同一批文件
//    重写一遍 ⇒ mtime 变新 ⇒ 下次仍是候选 ⇒ **无限churn + 每次调用都刷一行噪音**。
//    用「脱敏后内容是否真的变了」做判据，已经脱过的文件天然沉默。
//    （空值同理：`"api_key": ""` 第一次会被打成标记，第二次起就不动了。）
//
// ② **「我是不是瞎了」那一半，走的是目录遍历而不是正则**（dao-guard-writing 第二条）。
//    `walked` / `scopeSkipped` / `binarySkipped` / `unreadable` / `tooLarge` 全部由 walker
//    产出，与模式表毫无关系 ⇒ 「零处置」与「一个文件都没看到」在返回值里分得开。
//    **2026-08-04 补 `scopeSkipped` / `scopePruned`**：加了白名单之后又多出**第三种 0** ——
//    「看到了但都不在扫描面里」。它与前两种在旧返回值里长得一模一样，而它恰恰是
//    白名单配错时的表现 ⇒ 必须单独有个数。
//
// ③ **本 sweep 自己的输出不落进自己的扫描面**（dao-guard-writing 第三条）。
//    状态文件与台账都住在 `_tmp/tool-nudge/` 里，故**显式跳过它们自己**；且两者
//    **从不存凭据值**，只存路径、模式名与计数。
//    （默认白名单本来就不覆盖 `tool-nudge/`，这里的显式跳过是纵深防御：某个仓若声明了
//    `**` 这种放宽模式，没有这一步就会自噬。）
//
// ④ **夹具豁免不是白名单，是一条有依据的判断**：一个值如果**逐字写在 git 跟踪的源文件里**，
//    它就已经对每个有仓库权限的人公开了，按定义不是秘密（本仓 `tests/settings-drift.tests.js`
//    落在 `_tmp/settings-drift-tests/live-*.json` 的 29 份夹具正是这一类）。
//    这与「默认排除某个目录」有本质区别——后者是给自己开永久豁免口（PR #98 拒绝把
//    `--exclude` 做成默认，同一个理由）。**判据自维护**：夹具一旦从源码里删掉，豁免自动失效。
//    **失败方向朝多脱**：取不到语料（非 git 仓 / git 不可用）⇒ 语料为空 ⇒ 什么都不豁免 ⇒ 全脱。
//    **只有值级模式**（sk / jwt / bearer / 各家 vendor 前缀）的命中参与豁免判定；
//    若一个文件只有**键名级**命中而取不到值级样本（例如不透明的 `refresh_token`），
//    **一律不豁免、直接脱** —— 拿不准就按最坏算。
//
// ⑥ **水位线是 keyset 游标 `(mtime, 相对路径)`，不是 wall-clock 时刻**（B2 的正解）。
//    旧版写的是 `lastSweepMs: res.truncated ? since : now` —— 本意「没看完就别推进」，
//    实际是：候选数只要长期 > 预算，`truncated` 恒真 ⇒ 水位线**永远停在 0** ⇒ 目录遍历
//    顺序确定 ⇒ **每次读同一批**。实测 30 文件 / 预算 5 连跑 10 次，候选恒 `[5,5,…]`，
//    25/30 从未被处理。
//    🔴 **病根不是「该不该推进」，是两侧不在同一语义深度**：读侧按**文件 mtime** 过滤，
//    写侧却记**墙上时钟**。两个量纲不同的东西被当成同一条线用，于是「推进」这个动作
//    在读侧根本无法表达「我处理到哪儿了」。
//    正解：候选按 `(mtime, rel)` 升序排，取前 budget 个处理，游标记**最后一个被真正处理
//    的那个 key**；读侧过滤 `mtime > 游标.mtime || (mtime === 游标.mtime && rel > 游标.path)`。
//    读写两侧现在是同一个 key 空间 ⇒ 单调推进、不跳过、不重复，预算再小也必然收敛。
//    （`rel` 做次序第二维不是装饰：同一毫秒落盘的文件多于预算时，只按 mtime 排会
//    卡死在同一个 mtime 上 —— 那是同一个 bug 换个地方复发。）
//
// ⑦ **扫描面用 realpath 圈定，目录联接一律拒绝并单独记账**（B3 的正解）。
//    `readdirSync(...,{withFileTypes:true})` 对 Windows 目录联接（junction）**既不报
//    isDirectory() 也不报 isFile()**，而 `statSync` 跟随链接说它是目录 ⇒ 旧版递归进去，
//    把 `_tmp/` **之外**的文件就地改写了，**而且 `redacted` 里报的是 `_tmp\link\config.json`
//    这个根本不存在的路径** —— 唯一那点痕还是错的。
//    现在：非普通文件/目录的条目一律先 `realpathSync`，落在 `realpath(_tmp)` 之外的
//    进 `res.outOfScope`（记 link 与 real 两个路径）并**不进栈**。
//
// ⑧ **改盘必须留下追加式台账**（B1 的正解；用户 2026-08-03 拍板「接受误伤」时附的义务）。
//    旧版唯一的持久记录是状态文件里的一个**计数**（无文件名、无模式名），而且**下一次
//    sweep 直接覆写** —— 实测跑第二次后 `redacted` 变回 0，盘上从此零记录。
//    现在每改一个文件追加一行 JSONL 到 `_tmp/tool-nudge/tmp-redact-sweep-audit.jsonl`：
//    时间 / 相对路径 / 命中的模式名 / 动作。**永不改写既有行**，只 append。
//    **它不含值、不含片段、不含长度、不含哈希** —— 台账是给人查「动过谁」的，不是给人
//    恢复凭据的；能从台账反推出凭据的台账本身就是新的泄漏面。
//    ⚠ **照直写它的上限**：单文件超过 `AUDIT_MAX_BYTES` 时轮转为 `.1`，`.1` 会被下一次
//    轮转覆盖 ⇒ **极旧的记录最终会掉**。这是有界磁盘占用的对价，不是「不可覆写」的例外
//    ——但轮转只在跨过阈值时发生，且白名单生效后改盘频率接近 0。
//
// ⑨ **脱敏写入之后把 mtime 还原**，否则「本 sweep 自己的写入」会变成「它下一轮的新工作」。
//    这是 dao-guard-writing 第三条（检查器的输出不能落在它自己的扫描面内）**换了个维度
//    复发**：那一条讲路径，这一条是 mtime —— 而 ⑥ 的游标恰恰是按 mtime 排的。
//    实测：不还原时 30 文件 / 预算 5 的收敛轮数从 6 涨到 12+，且每轮白读一遍已经干净的文件。
//    **对价**：下游若靠 mtime 判「这文件动没动」会看不见这次脱敏；可发现性改由 ⑧ 的台账、
//    systemMessage 与文件里的 `[REDACTED:*]` 标记三条通道担保，且那三条都比 mtime 说得更全。
//
// ── 射程与已知不覆盖面（照直写，别读成全包）─────────────────────────────────
// · **只覆盖白名单内的文件**。判据 ⑤ 买来的东西有价签：ops 脚本往一个没被覆盖的新目录
//   导出凭据时，本机制看不见它。推荐做法是导出到 `_tmp/dump/`（约定落点，无条件递归覆盖）。
// · **只覆盖文本**。二进制（截图/录屏）跳过并单独计数 —— 密钥在 PNG 里是像素，正则看不见。
// · **事后而非事前**：dump 在盘上**真实存在过**一小段时间（命令执行 → hook 触发）。
//   它买的是「不会一直躺在那儿」，不是「从未落过盘」。真正的事前解是产出者自己调 redact。
// · **只覆盖跑过工具调用的产出者**。用户手工跑的脚本、外部进程写的文件，下一次任意
//   Bash 调用时才会被扫到（预算内）。
// · **投递依赖宿主 hook 真的被调用**。宿主侧是否注册用
//   `node ccswitch/hooks/dao-tool-nudge.js --selfcheck` 核，别凭记忆判断。
// · **模式表的漏脱面不归本文件**：`redact.js` 的 PATTERNS 有已知漏脱形态（PowerShell
//   `$env:X = "..."`、URL 查询串、连接串、SQL INSERT 元组等）。**别把「`_tmp/` 有自动
//   脱敏」读成「`_tmp/` 现在安全了」。**
//
// 逃生阀：环境变量 `DAO_TMP_SWEEP_OFF=1`（同 G7 的 `DAO_SHELL_SEARCH_OK`，**实际只有用户
// 设得了** —— agent 在 Bash 里 export 影响不到 hook 进程）。
//
// 回归网：tests/tmp-redact-sweep.tests.js（判据网）
//         tests/tmp-redact-sweep.acceptance.tests.js（B1-B4 验收判据，对抗验证官所立）
// 真相源：windsurf-dao/ccswitch/lib/tmp-redact-sweep.js

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const R = require(path.join(__dirname, "redact.js"));
const SCOPE = require(path.join(__dirname, "tmp-sweep-scope.js"));

// 值级模式：命中的是**凭据自身的形状**，故它的匹配串就是「那个值」，可直接拿去与源码语料比对。
// 键名级模式（json-kv / yaml-kv / env-assign / *-line）匹配的是整行，不能这么比 —— 见判据 ④。
const VALUE_LEVEL = new Set([
  "sk-key", "jwt", "bearer", "google-api-key", "github-token", "slack-token",
  "aws-access-key-id", "private-key-block",
]);

const DEFAULT_BUDGET = 2000;          // 一次最多**读**多少个候选文件（walk 不受此限，见 ②）
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const STATE_REL = path.join("tool-nudge", "tmp-redact-sweep.json");
const AUDIT_REL = path.join("tool-nudge", "tmp-redact-sweep-audit.jsonl");
const AUDIT_MAX_BYTES = 2 * 1024 * 1024;

// 从任意目录向上找「既有 .git 又有 _tmp 的那一层」。**纯 fs，不 spawn**：
// 本函数在每次 Bash 调用后都要跑，起子进程的代价不该由每次调用来付。
function findRepoRoot(startDir) {
  let cur = path.resolve(startDir || ".");
  for (let i = 0; i < 60; i++) {
    try {
      if (fs.existsSync(path.join(cur, ".git"))) return cur;
    } catch (_) { /* 权限问题当作没找到，继续上溯 */ }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

// 取「git 跟踪的文本文件」全文，作为夹具豁免的语料（判据 ④）。
// 失败一律返回空数组 ⇒ 什么都不豁免 ⇒ 失败方向朝多脱。
function loadTrackedCorpus(root, opts) {
  const o = opts || {};
  if (o.corpus) return o.corpus;                 // 测试注入
  let list;
  try {
    list = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split(/\r?\n/).filter(Boolean);
  } catch (_) {
    return [];
  }
  const corpus = [];
  let budget = 64 * 1024 * 1024;                 // 语料总字节上限，防某个仓把内存吃光
  for (const rel of list) {
    if (budget <= 0) break;
    try {
      const buf = fs.readFileSync(path.join(root, rel));
      if (R.isProbablyBinary(buf)) continue;
      budget -= buf.length;
      corpus.push(buf.toString("utf8"));
    } catch (_) { /* 读不到就不进语料：等于不豁免，方向安全 */ }
  }
  return corpus;
}

// 抽出文件里全部**值级**命中串（原始值）。**只在进程内用于比对，绝不返回给调用方、
// 更不打印** —— 调用方拿到的永远只有模式名。
function valueLevelMatches(text) {
  const out = [];
  for (const p of R.PATTERNS) {
    if (!VALUE_LEVEL.has(p.name)) continue;
    const re = R._internal.freshRe(p);
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push(m[0]);
      if (m[0] === "") break;
    }
  }
  return out;
}

function readState(stateFile) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (s && typeof s === "object" && typeof s.lastSweepMs === "number") return s;
  } catch (_) { /* 读不动 ⇒ 当首次跑：宁可多扫一遍，不可漏扫 */ }
  return null;
}

function writeState(stateFile, state) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
    return true;
  } catch (_) {
    return false;                                // 写不动 ⇒ 下次全量重扫：多做功，不少做功
  }
}

// 判据 ⑧：追加式台账。**只 append，绝不改写既有行**；不含任何凭据值/片段/长度/哈希。
function appendAudit(auditFile, records) {
  if (!records.length) return false;
  try {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    try {
      const st = fs.statSync(auditFile);
      if (st.size > AUDIT_MAX_BYTES) fs.renameSync(auditFile, auditFile + ".1");
    } catch (_) { /* 没有旧台账 ⇒ 直接新建 */ }
    fs.appendFileSync(auditFile, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    return true;
  } catch (_) {
    return false;
  }
}

// 判据 ⑦ 的圈定判定：`p` 的真实位置是否仍在 `realTmp` 之内。
function insideReal(realTmp, p) {
  let real;
  try { real = fs.realpathSync(p); } catch (_) { return null; }   // 解析不了 ⇒ 调用方按拒绝处理
  const a = path.resolve(real);
  const b = path.resolve(realTmp);
  return { real: a, inside: a === b || a.startsWith(b + path.sep) };
}

/**
 * 扫一遍 <root>/_tmp/ 中**落在白名单内**的文件，把新落盘的裸凭据就地脱敏。
 * 返回的对象里**只有路径、模式名与计数，没有任何凭据值**。
 */
function sweep(opts) {
  const o = opts || {};
  const now = typeof o.now === "number" ? o.now : Date.now();
  const root = o.root || findRepoRoot(o.cwd || process.cwd());
  const res = {
    root: root || null, ran: false, reason: null,
    walked: 0, scopeSkipped: 0, scopePruned: 0, candidates: 0, pending: 0,
    binarySkipped: 0, unreadable: 0, tooLarge: 0, outOfScope: [],
    redacted: [], fixtureSkipped: [], failed: [],
    truncated: false, budgetLeft: 0, firstRun: false, statePersisted: false,
    auditPersisted: false, scopeSource: null, scopePatterns: 0, scopeWarnings: [],
  };
  if (!root) { res.reason = "no-repo-root"; return res; }

  const tmpDir = path.join(root, "_tmp");
  try {
    if (!fs.statSync(tmpDir).isDirectory()) { res.reason = "no-tmp"; return res; }
  } catch (_) { res.reason = "no-tmp"; return res; }

  // 判据 ⑦：整趟遍历的圈以 `_tmp/` 的**真实路径**为准（`_tmp/` 本身是链接时也成立）。
  let realTmp;
  try { realTmp = fs.realpathSync(tmpDir); } catch (_) { realTmp = path.resolve(tmpDir); }

  // 判据 ⑤：先定扫描面，再决定走哪些目录。
  const scopeInfo = SCOPE.loadScope(root, o);
  const matcher = SCOPE.compile(scopeInfo.patterns);
  res.scopeSource = scopeInfo.source;
  res.scopePatterns = scopeInfo.patterns.length;
  res.scopeWarnings = scopeInfo.warnings.slice();

  const stateFile = o.stateFile || path.join(tmpDir, STATE_REL);
  const auditFile = o.auditFile || path.join(tmpDir, AUDIT_REL);
  const state = readState(stateFile);
  res.firstRun = state === null;
  // 判据 ⑥：游标是 (mtime, 相对路径) 二元组，读写两侧同一个 key 空间。
  const sinceMs = res.firstRun ? 0 : state.lastSweepMs;
  const sincePath = res.firstRun ? "" : String(state.lastPath || "");

  const budgetMax = typeof o.budget === "number" ? o.budget : DEFAULT_BUDGET;
  const maxBytes = typeof o.maxBytes === "number" ? o.maxBytes : DEFAULT_MAX_BYTES;
  const skipDirs = o.skipDirs || R.DEFAULT_SKIP_DIRS;

  const selfFiles = new Set([path.resolve(stateFile), path.resolve(auditFile), path.resolve(auditFile + ".1")]);

  // ── 第一趟：遍历（只收集，不读内容）。分母全部在这里产出（判据 ②）──────────
  const eligible = [];
  const stack = [""];                                   // 相对 `_tmp/` 的目录路径
  while (stack.length) {
    const relDir = stack.pop();
    const absDir = relDir ? path.join(tmpDir, relDir) : tmpDir;
    let ents;
    try { ents = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch (_) { res.unreadable++; continue; }

    for (const e of ents) {
      const rel = relDir ? relDir + "/" + e.name : e.name;
      const abs = path.join(tmpDir, rel);

      let isDir = e.isDirectory();
      let isFile = e.isFile();

      // 判据 ⑦：**凡不是普通文件的条目，一律先圈定**。
      // 刻意不按「dirent 把它报成什么」来决定要不要检查 —— Windows 目录联接在
      // `withFileTypes` 下 `isDirectory()` 与 `isFile()` **两个都报 false**（旧版正是
      // 从这一格漏出去的），而这个报法随宿主/Node 版本而变。**靠报法分派，就是把正确性
      // 押在一个我们不控制的实现细节上**；靠 realpath 圈定则与报法无关。
      if (!isFile) {
        const chk = insideReal(realTmp, abs);
        if (!chk || !chk.inside) {
          res.outOfScope.push({ link: rel, real: chk ? chk.real : null });
          continue;                                                      // 不进栈、不处理
        }
        if (!isDir) {                                                    // 联接/符号链接指向圈内
          let st;
          try { st = fs.statSync(abs); } catch (_) { res.unreadable++; continue; }
          isDir = st.isDirectory();
          isFile = st.isFile();
        }
      }

      if (isDir) {
        if (skipDirs.has(e.name)) continue;
        if (!matcher.canDescend(rel)) { res.scopePruned++; continue; }   // 判据 ⑤ 的剪枝
        stack.push(rel);
        continue;
      }
      if (!isFile) continue;                                             // 设备/管道等，不是我们的事

      res.walked++;                                 // ← 分母：由 walker 产出，与正则无关（判据 ②）
      if (selfFiles.has(path.resolve(abs))) continue;                    // 判据 ③
      if (!matcher.matchFile(rel)) { res.scopeSkipped++; continue; }     // 判据 ⑤
      let st;
      try { st = fs.statSync(abs); } catch (_) { res.unreadable++; continue; }
      if (st.size > maxBytes) { res.tooLarge++; continue; }
      // 判据 ⑥：keyset 游标过滤 —— 读侧与写侧同一个 (mtime, rel) key 空间
      if (st.mtimeMs < sinceMs) continue;
      if (st.mtimeMs === sinceMs && rel <= sincePath) continue;
      eligible.push({ rel, abs, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs });
    }
  }

  // ── 第二趟：按游标次序处理前 budget 个（判据 ⑥）────────────────────────────
  eligible.sort((a, b) => (a.mtimeMs - b.mtimeMs) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const take = eligible.slice(0, Math.max(0, budgetMax));
  res.pending = eligible.length - take.length;
  res.truncated = res.pending > 0;
  res.budgetLeft = Math.max(0, budgetMax - take.length);

  // 语料是**懒加载**的：只有真出现「内容会被改」的文件时才付这份代价。
  let corpus = null;
  const corpusOf = () => (corpus === null ? (corpus = loadTrackedCorpus(root, o)) : corpus);

  const auditRecords = [];
  let cursor = null;                              // 只有**真正走完一个文件**才推进
  for (const f of take) {
    res.candidates++;
    cursor = { mtimeMs: f.mtimeMs, rel: f.rel };  // 走到这里即视为已处理（含跳过类结局）

    let buf;
    try { buf = fs.readFileSync(f.abs); } catch (_) { res.unreadable++; continue; }
    if (R.isProbablyBinary(buf)) { res.binarySkipped++; continue; }

    const text = buf.toString("utf8");
    let redacted;
    try { redacted = R.redactText(text); } catch (_) { res.failed.push({ file: f.abs, code: "EREDACT" }); continue; }

    // 判据 ①：脱敏后内容没变 ⇒ 本来就干净，或者已经脱过了。两种都不该动、也不该报。
    if (redacted === text) continue;

    // 判据 ④：值级命中若**全部**能在 git 跟踪的源码里逐字找到 ⇒ 合成夹具，不是秘密。
    const vals = valueLevelMatches(text);
    if (vals.length) {
      const src = corpusOf();
      const allInSource = vals.every((v) => src.some((c) => c.includes(v)));
      if (allInSource) { res.fixtureSkipped.push(f.abs); continue; }
    }

    try {
      const r = R.redactFileInPlace(f.abs, {});     // 默认 quarantine：失败即隔离，fail-closed
      // 🔴 判据 ⑨：**把 mtime 还原成脱敏前的值** —— 否则「本 sweep 自己的写入」会变成
      // 「本 sweep 下一轮的新工作」。这就是 dao-guard-writing 第三条（检查器的输出不能落在
      // 它自己的扫描面内）**换了个维度复发**：那一条讲的是路径，这一条是 mtime。
      // 不还原的实测后果：30 文件 / 预算 5 连跑，每一轮处理完的 5 个都因为 mtime 变新而重新
      // 排到队尾，收敛所需轮数从 6 涨到 12+，且每轮都白读一遍已经干净的文件。
      // **对价照直写**：下游若靠 mtime 判「这文件动没动」，会看不见这次脱敏。可发现性由
      // 另外三条通道担保（追加式台账 ⑧ + systemMessage + 文件里的 `[REDACTED:*]` 标记），
      // 而那三条都比 mtime 说得更清楚（谁、什么时候、命中哪条模式）。
      // 还原失败不影响正确性，只是退回到上面那种多做功的形态，故吞掉不报。
      try { fs.utimesSync(f.abs, new Date(f.atimeMs), new Date(f.mtimeMs)); } catch (_) { }
      res.redacted.push({ file: f.abs, patterns: r.hits });
      auditRecords.push({ ts: new Date(now).toISOString(), action: "redacted", file: f.rel, patterns: r.hits });
    } catch (e) {
      res.failed.push({ file: f.abs, code: e.code || "EFAIL", quarantine: e.quarantine || null });
      auditRecords.push({ ts: new Date(now).toISOString(), action: "failed", file: f.rel, code: e.code || "EFAIL" });
    }
  }

  res.ran = true;
  // 判据 ⑧：台账先落盘再写水位线 —— 次序有意如此。水位线一旦推进，这批文件下次不再被看，
  // 那么「改过它们」这件事就只剩台账这一份记录了；先写记录、后推进，崩在中间也只是多扫一遍。
  res.auditPersisted = appendAudit(auditFile, auditRecords);
  // 判据 ⑥：游标推进到**最后一个真正处理过的文件**，与读侧同一个 key 空间。
  // 一个都没处理时保持原样（而不是跳到 now），否则又回到旧版那个量纲错位。
  res.statePersisted = writeState(stateFile, {
    lastSweepMs: cursor ? cursor.mtimeMs : sinceMs,
    lastPath: cursor ? cursor.rel : sincePath,
    lastRunIso: new Date(now).toISOString(),
    walked: res.walked, candidates: res.candidates, redacted: res.redacted.length,
    pending: res.pending, truncated: res.truncated,
  });
  return res;
}

/** 把 sweep 结果渲染成给 agent 看的一段话。**只出现路径与模式名，永不出现值。** */
function renderNotice(res, root) {
  if (!res || !res.ran) return null;
  const rel = (p) => path.relative(root || res.root || ".", p).replace(/\\/g, "/");
  const parts = [];
  if (res.redacted.length) {
    parts.push(
      "【dao 凭据脱敏】刚落盘的工件里有 " + res.redacted.length + " 个文件含裸凭据，**已就地脱敏**（值已换成 " +
      "`[REDACTED:*]` 标记，文件其余内容原样保留）：" + res.redacted.map((r) => "`" + rel(r.file) + "`").join("、") + "。" +
      "命中的模式：" + [...new Set(res.redacted.flatMap((r) => r.patterns))].join(" / ") + "（**此处只报模式名，不报值**）。" +
      "改了哪些文件有**追加式台账**可查：`_tmp/" + AUDIT_REL.replace(/\\/g, "/") + "`（只记路径与模式名，不记值）。" +
      "为什么自动做而不是问你：`_tmp/` 的内容经常被整段贴进 PR body / issue / 交付报告，" +
      "而那条路上此前一个过滤器都没有。**需要那个值排障就去读没脱敏的源**（cc-switch DB / live 配置），" +
      "别把工件当真相源 —— 工件是派生物，重跑一次就有，密钥进了 git 历史是不可逆的。"
    );
  }
  if (res.failed.length) {
    parts.push(
      "⚠ 另有 " + res.failed.length + " 个文件**脱敏失败**（" +
      res.failed.map((f) => rel(f.file) + ":" + f.code).join("、") +
      "）。失败的那些已按 fail-closed 隔离；`quarantine=failed` 的**此刻可能仍是裸的**，需要人手处置。"
    );
  }
  // C1：「有文件没读」必须说出口 —— 否则它与「读完了很干净」在调用方眼里逐字节相同。
  if (res.tooLarge || res.unreadable) {
    const bits = [];
    if (res.tooLarge) bits.push(res.tooLarge + " 个**过大跳过**（超过单文件上限，一个字节都没读）");
    if (res.unreadable) bits.push(res.unreadable + " 个**读不到**（权限/占用/竞态）");
    parts.push(
      "⚠ 本次有文件**没读**：" + bits.join("、") + "。这不是「零命中」，是「没看」——" +
      "要补就手动跑 `node ccswitch/scripts/dao-redact.mjs --scan _tmp`。"
    );
  }
  if (res.outOfScope.length) {
    parts.push(
      "⚠ 本次拒绝了 " + res.outOfScope.length + " 个**指向 `_tmp/` 之外**的链接/目录联接（未跟随、未改动）：" +
      res.outOfScope.map((x) => "`_tmp/" + x.link + "`" + (x.real ? " → `" + x.real + "`" : " → 解析失败")).join("、") +
      "。自动脱敏的改盘面**只在 `_tmp/` 之内**，链接指到外面就不是它该动的东西了。"
    );
  }
  if (res.truncated) {
    parts.push(
      "⚠ 本次扫描**预算用尽、没看完**（walked=" + res.walked + "，还有 " + res.pending + " 个在排队）。" +
      "这不是「零命中」，是「没扫完」—— 水位线已推进到本次处理完的位置，**下次接着往后扫**（不会重读这一批）；" +
      "要一次补全跑 `node ccswitch/scripts/dao-redact.mjs --scan _tmp`。"
    );
  }
  for (const w of (res.scopeWarnings || [])) {
    parts.push("⚠【dao 凭据脱敏 · 扫描面声明】" + w);
  }
  if (!res.statePersisted && (res.redacted.length || res.failed.length)) {
    parts.push("（⚠ 水位线没写成，下次会全量重扫：多做功而非少做功，顺手看一眼 `_tmp/tool-nudge/` 的权限。）");
  }
  if (!res.auditPersisted && (res.redacted.length || res.failed.length)) {
    parts.push(
      "（🔴 **台账没写成** —— 本次改了盘却没能留下记录，而「改盘必须可事后发现」正是这套东西" +
      "被允许自动跑的前提。看一眼 `_tmp/tool-nudge/` 的权限；在修好之前，本次改动只有上面这段话作数。）"
    );
  }
  return parts.length ? parts.join("\n\n") : null;
}

/** 本次 sweep 有没有真的动过用户的盘。hook 侧据此决定要不要走 systemMessage（用户可见通道）。 */
function changedDisk(res) {
  return !!(res && res.ran && (res.redacted.length || res.failed.length));
}

/** 给用户看的一句话（systemMessage）。**比 additionalContext 短，且只说「动了什么」。** */
function renderUserMessage(res, root) {
  if (!changedDisk(res)) return null;
  const rel = (p) => path.relative(root || res.root || ".", p).replace(/\\/g, "/");
  const bits = [];
  if (res.redacted.length) bits.push("已就地脱敏 " + res.redacted.length + " 个：" + res.redacted.map((r) => rel(r.file)).join("、"));
  if (res.failed.length) bits.push("脱敏失败 " + res.failed.length + " 个（已隔离）：" + res.failed.map((f) => rel(f.file)).join("、"));
  return "[dao 凭据脱敏] 自动改了你 `_tmp/` 里的文件 —— " + bits.join("；") +
    "。台账：`_tmp/" + AUDIT_REL.replace(/\\/g, "/") + "`。不想要就设 DAO_TMP_SWEEP_OFF=1。";
}

module.exports = {
  sweep, renderNotice, renderUserMessage, changedDisk, findRepoRoot, valueLevelMatches,
  VALUE_LEVEL, STATE_REL, AUDIT_REL, AUDIT_MAX_BYTES, DEFAULT_BUDGET,
};
