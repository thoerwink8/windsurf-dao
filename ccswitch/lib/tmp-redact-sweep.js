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
// ── 🔴 四条设计判据（改本文件前逐条读一遍，它们各自防一个具体的死法）──────────
//
// ① **幂等判据用 `redactText(t) === t`，不用「scanText 有没有命中」**。
//    脱敏后的文本里留着 `[REDACTED:json-kv]` 这样的标记，而 `json-kv` 那条正则**照样命中它**
//    （命中后替换成同样的内容）。若拿「有命中」当触发条件，每次 Bash 调用都会把同一批文件
//    重写一遍 ⇒ mtime 变新 ⇒ 下次仍是候选 ⇒ **无限churn + 每次调用都刷一行噪音**。
//    用「脱敏后内容是否真的变了」做判据，已经脱过的文件天然沉默。
//    （空值同理：`"api_key": ""` 第一次会被打成标记，第二次起就不动了。）
//
// ② **「我是不是瞎了」那一半，走的是目录遍历而不是正则**（dao-guard-writing 第二条）。
//    `walked` / `binarySkipped` / `unreadable` / `budgetLeft` 全部由 walker 产出，
//    与模式表毫无关系 ⇒ 「零处置」与「一个文件都没看到」在返回值里分得开。
//    预算用尽时 `truncated=true` 并如实报还剩多少没看——**「我没看完」必须说出口**，
//    否则它与「看完了没事」在调用方眼里一样。
//
// ③ **本 sweep 自己的输出不落进自己的扫描面**（dao-guard-writing 第三条）。
//    状态文件就住在 `_tmp/` 里（`_tmp/tool-nudge/`），故**显式跳过它自己**；且状态里
//    只存时间戳与计数，**从不存路径以外的任何内容、绝不存密钥值**。
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
// ── 射程与已知不覆盖面（照直写，别读成全包）─────────────────────────────────
// · **只覆盖文本**。二进制（截图/录屏）跳过并单独计数 —— 密钥在 PNG 里是像素，正则看不见。
// · **事后而非事前**：dump 在盘上**真实存在过**一小段时间（命令执行 → hook 触发）。
//   它买的是「不会一直躺在那儿」，不是「从未落过盘」。真正的事前解是产出者自己调 redact。
// · **只覆盖跑过工具调用的产出者**。用户手工跑的脚本、外部进程写的文件，下一次任意
//   Bash 调用时才会被扫到（预算内）。
// · **投递依赖宿主 hook 真的被调用**。宿主侧是否注册用
//   `node ccswitch/hooks/dao-tool-nudge.js --selfcheck` 核，别凭记忆判断。
//
// 逃生阀：环境变量 `DAO_TMP_SWEEP_OFF=1`（同 G7 的 `DAO_SHELL_SEARCH_OK`，**实际只有用户
// 设得了** —— agent 在 Bash 里 export 影响不到 hook 进程）。
//
// 回归网：tests/tmp-redact-sweep.tests.js
// 真相源：windsurf-dao/ccswitch/lib/tmp-redact-sweep.js

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const R = require(path.join(__dirname, "redact.js"));

// 值级模式：命中的是**凭据自身的形状**，故它的匹配串就是「那个值」，可直接拿去与源码语料比对。
// 键名级模式（json-kv / yaml-kv / env-assign / *-line）匹配的是整行，不能这么比 —— 见判据 ④。
const VALUE_LEVEL = new Set([
  "sk-key", "jwt", "bearer", "google-api-key", "github-token", "slack-token",
  "aws-access-key-id", "private-key-block",
]);

const DEFAULT_BUDGET = 2000;          // 一次最多**读**多少个候选文件（walk 不受此限，见 ②）
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const STATE_REL = path.join("tool-nudge", "tmp-redact-sweep.json");

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

/**
 * 扫一遍 <root>/_tmp/，把新落盘的裸凭据就地脱敏。
 * 返回的对象里**只有路径、模式名与计数，没有任何凭据值**。
 */
function sweep(opts) {
  const o = opts || {};
  const now = typeof o.now === "number" ? o.now : Date.now();
  const root = o.root || findRepoRoot(o.cwd || process.cwd());
  const res = {
    root: root || null, ran: false, reason: null,
    walked: 0, candidates: 0, binarySkipped: 0, unreadable: 0, tooLarge: 0,
    redacted: [], fixtureSkipped: [], failed: [],
    truncated: false, budgetLeft: 0, firstRun: false, statePersisted: false,
  };
  if (!root) { res.reason = "no-repo-root"; return res; }

  const tmpDir = path.join(root, "_tmp");
  try {
    if (!fs.statSync(tmpDir).isDirectory()) { res.reason = "no-tmp"; return res; }
  } catch (_) { res.reason = "no-tmp"; return res; }

  const stateFile = o.stateFile || path.join(tmpDir, STATE_REL);
  const state = readState(stateFile);
  res.firstRun = state === null;
  const since = res.firstRun ? 0 : state.lastSweepMs;

  const budgetMax = typeof o.budget === "number" ? o.budget : DEFAULT_BUDGET;
  const maxBytes = typeof o.maxBytes === "number" ? o.maxBytes : DEFAULT_MAX_BYTES;
  const skipDirs = o.skipDirs || R.DEFAULT_SKIP_DIRS;
  let budget = budgetMax;

  // 语料是**懒加载**的：只有真出现「内容会被改」的文件时才付这份代价。
  let corpus = null;
  const corpusOf = () => (corpus === null ? (corpus = loadTrackedCorpus(root, o)) : corpus);

  const stack = [tmpDir];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = fs.statSync(cur); } catch (_) { res.unreadable++; continue; }

    if (st.isDirectory()) {
      let ents;
      try { ents = fs.readdirSync(cur, { withFileTypes: true }); }
      catch (_) { res.unreadable++; continue; }
      for (const e of ents) {
        if (e.isDirectory() && skipDirs.has(e.name)) continue;
        stack.push(path.join(cur, e.name));
      }
      continue;
    }
    if (!st.isFile()) continue;

    res.walked++;                                 // ← 分母：由 walker 产出，与正则无关（判据 ②）
    if (path.resolve(cur) === path.resolve(stateFile)) continue;   // 判据 ③：不扫自己的输出
    if (st.mtimeMs <= since) continue;             // 上次扫过之后没动过
    if (st.size > maxBytes) { res.tooLarge++; continue; }

    if (budget <= 0) { res.truncated = true; continue; }
    budget--;
    res.candidates++;

    let buf;
    try { buf = fs.readFileSync(cur); } catch (_) { res.unreadable++; continue; }
    if (R.isProbablyBinary(buf)) { res.binarySkipped++; continue; }

    const text = buf.toString("utf8");
    let redacted;
    try { redacted = R.redactText(text); } catch (_) { res.failed.push({ file: cur, code: "EREDACT" }); continue; }

    // 判据 ①：脱敏后内容没变 ⇒ 本来就干净，或者已经脱过了。两种都不该动、也不该报。
    if (redacted === text) continue;

    // 判据 ④：值级命中若**全部**能在 git 跟踪的源码里逐字找到 ⇒ 合成夹具，不是秘密。
    const vals = valueLevelMatches(text);
    if (vals.length) {
      const src = corpusOf();
      const allInSource = vals.every((v) => src.some((c) => c.includes(v)));
      if (allInSource) { res.fixtureSkipped.push(cur); continue; }
    }

    try {
      const r = R.redactFileInPlace(cur, {});     // 默认 quarantine：失败即隔离，fail-closed
      res.redacted.push({ file: cur, patterns: r.hits });
    } catch (e) {
      res.failed.push({ file: cur, code: e.code || "EFAIL", quarantine: e.quarantine || null });
    }
  }

  res.budgetLeft = budget;
  res.ran = true;
  // 预算被用尽时**不推进水位线**：否则那些没看完的文件会因为「时间戳已过」而永远不再被看。
  res.statePersisted = writeState(stateFile, {
    lastSweepMs: res.truncated ? since : now,
    lastRunIso: new Date(now).toISOString(),
    walked: res.walked, redacted: res.redacted.length, truncated: res.truncated,
  });
  return res;
}

/** 把 sweep 结果渲染成给 agent 看的一段话。**只出现路径与模式名，永不出现值。** */
function renderNotice(res, root) {
  if (!res || !res.ran) return null;
  const parts = [];
  if (res.redacted.length) {
    const rel = res.redacted.map((r) => path.relative(root || res.root || ".", r.file).replace(/\\/g, "/"));
    parts.push(
      "【dao 凭据脱敏】刚落盘的工件里有 " + res.redacted.length + " 个文件含裸凭据，**已就地脱敏**（值已换成 " +
      "`[REDACTED:*]` 标记，文件其余内容原样保留）：" + rel.map((p) => "`" + p + "`").join("、") + "。" +
      "命中的模式：" + [...new Set(res.redacted.flatMap((r) => r.patterns))].join(" / ") + "（**此处只报模式名，不报值**）。" +
      "为什么自动做而不是问你：`_tmp/` 的内容经常被整段贴进 PR body / issue / 交付报告，" +
      "而那条路上此前一个过滤器都没有。**需要那个值排障就去读没脱敏的源**（cc-switch DB / live 配置），" +
      "别把工件当真相源 —— 工件是派生物，重跑一次就有，密钥进了 git 历史是不可逆的。"
    );
  }
  if (res.failed.length) {
    parts.push(
      "⚠ 另有 " + res.failed.length + " 个文件**脱敏失败**（" +
      res.failed.map((f) => path.relative(root || res.root || ".", f.file).replace(/\\/g, "/") + ":" + f.code).join("、") +
      "）。失败的那些已按 fail-closed 隔离；`quarantine=failed` 的**此刻可能仍是裸的**，需要人手处置。"
    );
  }
  if (res.truncated) {
    parts.push(
      "⚠ 本次扫描**预算用尽、没看完**（walked=" + res.walked + "，还有文件没读）。" +
      "这不是「零命中」，是「没扫完」—— 补全跑 `node ccswitch/scripts/dao-redact.mjs --scan _tmp`。"
    );
  }
  if (!res.statePersisted && (res.redacted.length || res.failed.length)) {
    parts.push("（⚠ 水位线没写成，下次会全量重扫：多做功而非少做功，顺手看一眼 `_tmp/tool-nudge/` 的权限。）");
  }
  return parts.length ? parts.join("\n\n") : null;
}

module.exports = { sweep, renderNotice, findRepoRoot, valueLevelMatches, VALUE_LEVEL, STATE_REL, DEFAULT_BUDGET };
