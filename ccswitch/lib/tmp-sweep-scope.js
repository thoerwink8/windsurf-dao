// tmp-sweep-scope.js — `_tmp/` 自动脱敏的**扫描面白名单**：它决定 sweep 会去看哪些文件。
//
// ── 为什么有这个文件（用户 2026-08-04 拍板）─────────────────────────────────────
// PR #108 的第一版扫**整个** `_tmp/`。对抗验证实测：hook 是全局注册的、扫的是「你当下所在
// 的那个仓」⇒ dao 自己 2 个误伤，**mousse-cli 379 个**（多为第三方 skill/plugin 的文档与
// 源码，它们只是**在文档里教人怎么填 key**）。用户拍板时看到的基数是 2，实测是 379。
//
// 用户的处置原话：「把扫描面收到你列出来的那几个目录。保住了『新导出的密钥落盘即打码』
// 这个价值，又把面收回到你看得见的范围。」⇒ **白名单是设计约束，不是可选项。**
//
// ── 三个设计问题的答案（这是本文件存在的全部内容）───────────────────────────────
//
// **① 怎么表达**：一组**相对 `_tmp/` 的 path glob**。`*` / `?` 不跨目录分隔符，`**` 跨。
//    刻意用 glob 而不是「目录名数组」：目录形态（`hook-register-*/**`）与文件名形态
//    （`*/00-current.*`）用同一套写法表达得出，读者只需要学一种东西。
//
// **② 默认值是什么**：见 `DEFAULT_SCOPE`，逐条的入选理由写在那里。**默认值的选取原则是
//    「失败朝窄」**——与 `redact.js` 的「宁多勿漏」**方向相反，这是刻意的**：
//      · `redact.js` 的过度脱敏发生在**人主动调它**的时候，代价是重跑一次；
//      · 本 sweep 的过度脱敏发生在**无人值守**时，代价是静默改坏别人的源码
//        （对抗验证实测：一个探针 `.js` 被改成语法错误，而汇总表照报全绿）。
//    收益相同（都是「别让裸凭据躺在盘上」）而代价不对称 ⇒ 取更保守的那一侧，
//    这正是官侧条款「调参三问」里 fail-closed 的原义。
//    **代价照直写**：ops 脚本往一个**没被覆盖的新目录**导出凭据时，本机制看不见它。
//    这不是 bug，是本次收窄买来的东西的价签。
//
// **③ 谁能改它**：三条通道，方向不同、门槛不同——
//      · **放宽**（让 sweep 多改盘）：只有两条路。㈠改 dao 的 `DEFAULT_SCOPE`（走 PR）；
//        ㈡在**被扫的那个仓**里放一份 `.dao-tmp-sweep.json` 并且**把它 git 跟踪起来**。
//        **未跟踪的那份一律不生效**（且会在通知里明说被忽略了，不静默）——因为 `_tmp/`
//        本身就是未跟踪、未经审查的地方，若一个落在那里的文件就能把改盘面重新放大到 379，
//        白名单等于没有。**放宽必须留下一个可审查的提交**，这是本设计的承重属性。
//      · **收窄到零**：环境变量 `DAO_TMP_SWEEP_OFF=1`（同 lib 头注，**实际只有用户设得了**
//        ——agent 在 Bash 里 export 影响不到 hook 进程）。
//    声明文件是 **extend 语义不是 replace**：它只能往上加，加不掉内置那几条。
//    理由：replace 允许「我以为我在收窄，实际把约定落点也关掉了」这类静默降级，
//    而收窄的正路已经有 `DAO_TMP_SWEEP_OFF` 了，不需要第二条。
//
// ── 白名单顺带解决的第二件事：目录剪枝 ────────────────────────────────────────
// `DEFAULT_SCOPE` 里**没有任何一条以 `**` 开头**，于是「这棵子树底下有没有可能命中」
// 可以在**进去之前**判出来（`canDescend`）⇒ 深层第三方树根本不会被 `readdir`。
// 实测依据（2026-08-04，只读普查）：mousse-cli `_tmp/` 里 381 个会被改写的文件中
// **370 个在深度 ≥7**（`gate0/synth-codex/.tmp/plugins/**` 那棵克隆树），
// 而 dao 自己 33 个全部在深度 ≤3。**误伤和成本都长在深处，收益全在浅处。**
// ⚠ 这条性质**依赖默认值的形状**：某个仓若声明了 `**/*.json` 这种以 `**` 开头的模式，
// 剪枝对它自动失效、退回全量遍历（`canDescend` 会照实返回 true，不是 bug）。
//
// 回归网：tests/tmp-redact-sweep.tests.js（⑪ 组）+ tests/tmp-redact-sweep.acceptance.tests.js（A7）
// 真相源：windsurf-dao/ccswitch/lib/tmp-sweep-scope.js

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/** 被扫仓里的声明文件名。**必须 git 跟踪才生效**（见头注 ③）。 */
const DECL_FILE = ".dao-tmp-sweep.json";

// 「活配置快照」的文件名形态。这些名字不是我编的，是**本仓真凭据实际用过的名字**
// （`00-current.*.json` 是 #101 那 22 处 provider dump 的文件名）加上同族的通用命名。
// 逐条的取舍：
//   · `.env` 系列 —— dotenv 落盘是凭据最经典的形态；
//   · `00-current.*` —— 本仓 ops 脚本导出「当前活配置」用的前缀（#101 实测落点）；
//   · `live-*.json` / `*-live.json` —— 同上，「live 快照」这个词在本仓两处独立出现过；
//   · `*provider*.json` / `*settings*.json` —— cc-switch providers 表与 settings.json 的导出；
//   · `*keyring*.json` / `*credential*.json` —— 直白命名。
// **刻意不收的**：`*secret*` / `*token*` / `*.key` 这类**光看名字分不出「是凭据」还是
//   「讲凭据」**的词。实测代价具体：`*secret*` 在 mousse-cli 上恰好捞进
//   `env-and-secrets.md` 与 `verify_capi_secret_not_exposed.py` 两个第三方**文档/脚本**
//   ——两个都是纯误伤，零收益。
const SNAPSHOT_NAMES = [
  ".env", ".env.*", "*.env",
  "00-current.*",
  "live-*.json", "*-live.json",
  "*provider*.json", "*providers*.json",
  "*settings*.json",
  "*keyring*.json", "*credential*.json", "*credentials*.json",
];

// 文件名形态覆盖 `_tmp/` 顶层与**其下一层**。为什么是两层而不是任意层：
//   · 收益侧 —— 本仓真 dump 在深度 2（`_tmp/hook-register-202608/00-current.*.json`），
//     两层把已知的全部真实落点都罩住了；
//   · 代价侧 —— 放开到任意层（`**/`）会让剪枝整个失效，且实测把 370 个深层第三方文件
//     重新拉回扫描面。
// **两侧由同一个 `SNAPSHOT_NAMES` 生成，不写两份**：写两份必然漂移，而「两侧对称的东西
// 只改一侧」正是本批 B2 那个 bug 的形态（读侧用 mtime、写侧用 wall-clock）。
const DEFAULT_SCOPE = [
  // ① 约定落点：ops 脚本要导出活配置快照，**写进这里就无条件递归覆盖**，不用管文件叫什么。
  //    这是本机制唯一「你主动配合就一定被保护」的入口，也是新增覆盖面的推荐做法。
  "dump/**", "dumps/**",
  // ② 本仓 #101 那 22 处 provider dump 的实测落点。留着是为了**出处可查**，
  //    不是说别的仓也会有这个目录。
  "hook-register-*/**",
  // ③ 文件名形态 × 两层
  ...SNAPSHOT_NAMES,
  ...SNAPSHOT_NAMES.map((n) => "*/" + n),
];

// ── glob 编译 ────────────────────────────────────────────────────────────────
// 段级实现：`**` 是独立一段、可吃任意多段；其余段内 `*`→`[^/]*`、`?`→`[^/]`。
// 大小写不敏感（Windows 文件系统如此，判据跟着平台走）。
function segRe(seg) {
  let s = "";
  for (const c of seg) {
    if (c === "*") s += "[^/]*";
    else if (c === "?") s += "[^/]";
    else s += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + s + "$", "i");
}

function compilePattern(p) {
  return String(p).split("/").filter((x) => x !== "").map((seg) => (seg === "**" ? "**" : segRe(seg)));
}

// 完整匹配：pat 是否恰好匹配整条相对路径。
function fullMatch(pat, i, segs, j) {
  while (i < pat.length) {
    if (pat[i] === "**") {
      for (let k = j; k <= segs.length; k++) if (fullMatch(pat, i + 1, segs, k)) return true;
      return false;
    }
    if (j >= segs.length) return false;
    if (!pat[i].test(segs[j])) return false;
    i++; j++;
  }
  return j === segs.length;
}

// 剪枝判据：以 dirSegs 为**目录**，这条 pattern 有没有可能匹配到它**下面**的某个文件。
// 答 false ⇒ 整棵子树不必 readdir。这是白名单带来的性能红利的来源。
function couldDescend(pat, dirSegs) {
  let i = 0, j = 0;
  while (i < pat.length && j < dirSegs.length) {
    if (pat[i] === "**") return true;              // ** 吃任意深度 ⇒ 更深处永远有可能
    if (!pat[i].test(dirSegs[j])) return false;
    i++; j++;
  }
  if (j < dirSegs.length) return false;            // pattern 段用完了、路径还没走完 ⇒ 不可能
  return i < pat.length;                           // pattern 还剩段 ⇒ 更深处可能命中
}

/**
 * 把一组 glob 编译成 matcher。
 * @returns {{patterns:string[], matchFile(relPath):boolean, canDescend(relDir):boolean, isEmpty:boolean}}
 */
function compile(patterns) {
  const raw = (patterns || []).map(String).filter(Boolean);
  const compiled = raw.map(compilePattern).filter((p) => p.length > 0);
  const split = (rel) => String(rel).replace(/\\/g, "/").split("/").filter((x) => x !== "");
  return {
    patterns: raw,
    isEmpty: compiled.length === 0,
    matchFile(rel) {
      const segs = split(rel);
      if (!segs.length) return false;
      return compiled.some((p) => fullMatch(p, 0, segs, 0));
    },
    canDescend(relDir) {
      const segs = split(relDir);
      return compiled.some((p) => couldDescend(p, segs));
    },
  };
}

/** 该仓的 `.dao-tmp-sweep.json` 是否被 git 跟踪。取不到答案一律当「没跟踪」（失败朝窄）。 */
function isTracked(root, rel) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", rel],
      { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 求出这个仓此刻实际生效的扫描面。
 * @returns {{patterns:string[], source:string, declared:string[], warnings:string[]}}
 *   source: "builtin" | "builtin+declared"
 *   warnings: 需要**让人看见**的降级说明（声明文件存在却没生效之类），调用方须原样透出。
 */
function loadScope(root, opts) {
  const o = opts || {};
  if (Array.isArray(o.scope)) {                    // 测试注入 / 调用方显式指定
    return { patterns: o.scope.slice(), source: "explicit", declared: [], warnings: [] };
  }
  const warnings = [];
  const declared = [];
  const declFile = path.join(root, DECL_FILE);
  let exists = false;
  try { exists = fs.statSync(declFile).isFile(); } catch (_) { exists = false; }

  if (exists) {
    const tracked = typeof o.declaredTracked === "boolean" ? o.declaredTracked : isTracked(root, DECL_FILE);
    if (!tracked) {
      // 静默忽略是本体系明令要防的形态：「被忽略了」与「本来就没有」必须分得开。
      warnings.push(
        "`" + DECL_FILE + "` 存在但**没有被 git 跟踪 ⇒ 本次未生效**（扫描面回落到内置默认）。" +
        "放宽改盘面必须留下一个可审查的提交：`git add " + DECL_FILE + "` 并提交后才算数。"
      );
    } else {
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(declFile, "utf8")); } catch (e) {
        warnings.push("`" + DECL_FILE + "` 解析失败（" + String((e && e.message) || e).slice(0, 120) +
          "）⇒ 本次未生效，扫描面回落到内置默认。");
      }
      if (parsed) {
        const arr = Array.isArray(parsed.scope) ? parsed.scope : null;
        if (!arr) {
          warnings.push("`" + DECL_FILE + "` 里没有 `scope` 数组 ⇒ 本次未生效，扫描面回落到内置默认。");
        } else {
          for (const p of arr) {
            const s = String(p || "");
            // 绝对路径 / 上溯段一律拒绝：扫描面永远只表达 `_tmp/` 内部的相对位置。
            if (!s || s.includes("..") || path.isAbsolute(s) || /^[a-zA-Z]:/.test(s)) {
              warnings.push("`" + DECL_FILE + "` 里的模式 `" + s.slice(0, 60) + "` 被拒绝（含上溯段或绝对路径）。");
              continue;
            }
            declared.push(s);
          }
        }
      }
    }
  }
  return {
    patterns: DEFAULT_SCOPE.concat(declared),
    source: declared.length ? "builtin+declared" : "builtin",
    declared,
    warnings,
  };
}

module.exports = { DEFAULT_SCOPE, SNAPSHOT_NAMES, DECL_FILE, compile, loadScope, isTracked };
