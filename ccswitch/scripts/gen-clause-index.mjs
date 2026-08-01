#!/usr/bin/env node
// gen-clause-index.mjs — 生成 / 校验条款机器面索引（P6 第一步）
//
// ── 三个模式 ─────────────────────────────────────────────────────────────────
//   （缺省）生成    node ccswitch/scripts/gen-clause-index.mjs
//   --check  漂移   源变了而索引没跟上 ⇒ exit 1「索引过期」。**不写盘。**
//   --reconcile 对账 与 ccswitch/scripts/check-clauses-structure.ps1（一套**独立**解析）
//                   逐文件对 `clauses` 与 `notrigger` 两个数；不一致 ⇒ exit 1。
//
// ── 为什么要有 --reconcile（它不是「测试的一部分」，是这套派生物的存活条件）────
// 索引是派生物，而派生物最典型的死法是**它自己变瞎了却照样输出一份看起来正常的东西**：
// 解析漏掉一整节 ⇒ 条款少了 ⇒ 索引仍然是合法 JSON、仍然能渲染、`--check` 仍然绿
// （因为它拿自己的解析结果和自己的解析结果比）。唯一能戳破这一层的是**第二套独立读法**。
// PS 那个守卫恰好就是：同一份语料、不同的扫描面走法、各自数出一个数。两个数一致，
// 才叫「我没瞎」；不一致时**不判谁对**，只报差异清单 —— 判谁对是人的活。
//
// ── 三条对账时刻意做的取舍，写下来免得被读成 bug ─────────────────────────────
//   ① **对账只看数字，不看 PS 的退出码。** 零条款的源文件（ccswitch/rules/dao-powershell.md
//      等）会让 PS 守卫报 `zero-sample` 硬闸红 —— 那是它对「被检对象是条款库」这个前提的
//      合理防御，不是对账失败。故这里把 PS 退出码**原样打印在旁边**、不掺进裁定。
//   ② **但整批全零要红。** 每个文件都「0 == 0」的一致是空的一致：那正是「检测器数到 0 个
//      违例」与「检测器根本没看到样本」不可区分的形态。故总条款数为 0 ⇒ zero-sample 红。
//   ③ **PS 宿主不在 ⇒ exit 2，不是 exit 0。** 「跑不了」必须与「跑了且一致」分得开；
//      把它悄悄当成通过，等于亲手造一个死闸。
//
// ── 末行契约（机器读这一行，别去正则匹配上面的中文）──────────────────────────
//   生成/校验：CLAUSE_INDEX_SUMMARY exit=<n> sources=<n> clauses=<n> observation=<n> drift=<none|missing|content|source> wrote=<0|1>
//   对账：    CLAUSE_RECONCILE_SUMMARY exit=<n> host=<powershell|pwsh|none> files=<n> matched=<n> mismatched=<n> mine=<n> theirs=<n>
//   **每条路径都打印**（含失败路径）：只在成功时打摘要，等于让「没查成」在机器通道上
//   表现为「什么都没说」。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  buildIndex,
  serializeIndex,
  defaultSources,
  DEFAULT_INDEX_REL,
  SELECTOR,
  parseFile,
  normalizeText,
} from "../lib/clause-parser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const PS_SCRIPT_DEFAULT = path.join(REPO_ROOT, "ccswitch", "scripts", "check-clauses-structure.ps1");

// ── 参数 ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = {
    mode: "generate",
    out: null,
    sourcesJson: null,
    psScript: PS_SCRIPT_DEFAULT,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") o.mode = "check";
    else if (a === "--reconcile") o.mode = "reconcile";
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--sources-json") o.sourcesJson = argv[++i];
    else if (a === "--ps-script") o.psScript = argv[++i];
    else if (a === "--quiet") o.quiet = true;
    else if (a === "--help" || a === "-h") o.mode = "help";
    else {
      process.stdout.write(`未知参数：${a}\n`);
      o.mode = "help";
      o.bad = true;
    }
  }
  return o;
}

function loadSources(o) {
  if (!o.sourcesJson) return defaultSources();
  const p = path.isAbsolute(o.sourcesJson) ? o.sourcesJson : path.join(process.cwd(), o.sourcesJson);
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  const list = Array.isArray(doc) ? doc : doc.sources;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`源清单为空或格式不对：${p}（要一个数组，或 {"sources":[…]}）`);
  }
  for (const s of list) {
    if (!s.file) throw new Error(`源清单条目缺 file 字段：${JSON.stringify(s)}`);
    if (!Object.values(SELECTOR).includes(s.selector)) {
      throw new Error(`源清单条目 selector 非法：${JSON.stringify(s)}`);
    }
  }
  return list;
}

function summaryLine({ exit, sources, clauses, observation, drift, wrote }) {
  return `CLAUSE_INDEX_SUMMARY exit=${exit} sources=${sources} clauses=${clauses} observation=${observation} drift=${drift} wrote=${wrote}`;
}

function outPath(o) {
  if (o.out) return path.isAbsolute(o.out) ? o.out : path.join(process.cwd(), o.out);
  return path.join(REPO_ROOT, DEFAULT_INDEX_REL);
}

// ── 生成 / 校验 ──────────────────────────────────────────────────────────────
function runIndex(o) {
  const sources = loadSources(o);
  const target = outPath(o);
  let index;
  try {
    // repoRoot 恒为本仓：源清单可以指到仓外（测试的第三语料），仓内的源记相对路径、
    // 仓外的记绝对路径并标 external —— 由 buildIndex 自己判，这里不分叉。
    index = buildIndex(sources, { repoRoot: REPO_ROOT });
  } catch (e) {
    process.stdout.write(`✗ 构建索引失败：${e && e.message ? e.message : String(e)}\n`);
    process.stdout.write(
      summaryLine({ exit: 1, sources: sources.length, clauses: 0, observation: 0, drift: "missing", wrote: 0 }) + "\n"
    );
    return 1;
  }
  const text = serializeIndex(index);
  const g = index._generated;

  if (o.mode === "check") {
    if (!fs.existsSync(target)) {
      process.stdout.write(`✗ 索引不存在：${target}\n   ⇒ 跑一次 ${g.再生成}\n`);
      process.stdout.write(
        summaryLine({
          exit: 1, sources: sources.length, clauses: g.totals.clauses,
          observation: g.totals.observation, drift: "missing", wrote: 0,
        }) + "\n"
      );
      return 1;
    }
    // 比对**归一化后**的文本：索引由本脚本以 LF 写出，而 `core.autocrlf=true` 的机器
    // 一 checkout 就把它变成 CRLF ⇒ 逐字节比会让「刚 clone 完」表现为「索引过期」。
    // 判据是内容，不是行尾。（同 sha256File 那段的理由。）
    const onDisk = normalizeText(fs.readFileSync(target, "utf8"));
    if (onDisk === normalizeText(text)) {
      if (!o.quiet) {
        process.stdout.write(`OK：索引与真相源一致（${sources.length} 源 · ${g.totals.clauses} 条款 · ${g.totals.observation} 观察区条目）\n`);
        process.stdout.write("     未覆盖面：本检查只证明「索引 == 现在的 Markdown」，**不证明 Markdown 里的条款是对的**；\n");
        process.stdout.write("     条款自身的结构完整性归 check-clauses-structure.ps1，两套解析是否一致归 --reconcile。\n");
      }
      process.stdout.write(
        summaryLine({
          exit: 0, sources: sources.length, clauses: g.totals.clauses,
          observation: g.totals.observation, drift: "none", wrote: 0,
        }) + "\n"
      );
      return 0;
    }
    // 漂移了：先指名**哪个源**变了（拿盘上索引记的 sha256 对现在的文件），
    // 都没变则说明有人手改了索引本身 —— 两种病、两种处方，别混成一句「过期了」。
    let drift = "content";
    const named = [];
    try {
      const old = JSON.parse(onDisk);
      const oldSrc = new Map((old._generated?.sources || []).map((s) => [s.file, s.sha256]));
      for (const s of g.sources) {
        const before = oldSrc.get(s.file);
        if (before === undefined) named.push(`${s.file}（索引里原本没有这个源）`);
        else if (before !== s.sha256) named.push(`${s.file}（内容已变）`);
      }
      for (const f of oldSrc.keys()) {
        if (!g.sources.some((s) => s.file === f)) named.push(`${f}（已从源清单移除）`);
      }
      if (named.length) drift = "source";
    } catch (_) {
      named.push("（盘上索引不是合法 JSON，无法逐源比对）");
    }
    process.stdout.write("✗ 索引过期：与真相源不一致\n");
    if (named.length) for (const n of named) process.stdout.write(`   · 源变动：${n}\n`);
    else process.stdout.write("   · 所有源的 sha256 都没变 ⇒ 是**索引本身**被手改了（它是派生物，手改无效且会被下次生成覆盖）\n");
    process.stdout.write(`   ⇒ 跑一次 ${g.再生成}\n`);
    process.stdout.write(
      summaryLine({
        exit: 1, sources: sources.length, clauses: g.totals.clauses,
        observation: g.totals.observation, drift, wrote: 0,
      }) + "\n"
    );
    return 1;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf8");
  if (!o.quiet) {
    process.stdout.write(`✓ 已写 ${path.relative(REPO_ROOT, target) || target}\n`);
    for (const s of g.sources) {
      process.stdout.write(
        `   · ${s.file}  [${s.selector}]  条款 ${s.clauses} · 观察区 ${s.observation} · 无字段 ${s.fieldless} · 触发:无 ${s.no_trigger}\n`
      );
    }
    const roles = Object.entries(g.roles).map(([k, v]) => `${k}=${v}`).join(" · ");
    process.stdout.write(`   官种分布：${roles || "（空）"}\n`);
  }
  process.stdout.write(
    summaryLine({
      exit: 0, sources: sources.length, clauses: g.totals.clauses,
      observation: g.totals.observation, drift: "none", wrote: 1,
    }) + "\n"
  );
  return 0;
}

// ── 交叉对账 ─────────────────────────────────────────────────────────────────
const PS_SELECTOR = {
  [SELECTOR.MARKED]: "Marked",
  [SELECTOR.ALL_TOP_LEVEL]: "AllTopLevel",
};

function findPsHost() {
  for (const host of ["powershell", "pwsh"]) {
    const r = spawnSync(host, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8", timeout: 60000 });
    if (r.status === 0) return host;
  }
  return null;
}

function runPs(host, script, file, selector) {
  const r = spawnSync(
    host,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
      "-TargetFile", file, "-ClauseSelector", PS_SELECTOR[selector]],
    { encoding: "utf8", timeout: 300000 }
  );
  const out = String(r.stdout || "");
  const m = /CLAUSE_STRUCTURE_SUMMARY exit=(\d+) clauses=(\d+) violations=(\d+) notrigger=(\d+)/.exec(out);
  return {
    code: r.status,
    marker: m ? { exit: +m[1], clauses: +m[2], violations: +m[3], notrigger: +m[4] } : null,
    out,
    err: String(r.stderr || ""),
  };
}

function reconcileSummary({ exit, host, files, matched, mismatched, mine, theirs }) {
  return `CLAUSE_RECONCILE_SUMMARY exit=${exit} host=${host} files=${files} matched=${matched} mismatched=${mismatched} mine=${mine} theirs=${theirs}`;
}

function runReconcile(o) {
  let sources;
  try {
    sources = loadSources(o);
  } catch (e) {
    process.stdout.write(`✗ 源清单读不了：${e && e.message ? e.message : String(e)}\n`);
    process.stdout.write(reconcileSummary({ exit: 1, host: "none", files: 0, matched: 0, mismatched: 0, mine: 0, theirs: 0 }) + "\n");
    return 1;
  }
  if (!fs.existsSync(o.psScript)) {
    process.stdout.write(`✗ 对账不能跑：第二套解析（PS 守卫）不在 ${o.psScript}\n`);
    process.stdout.write("   「跑不了」不等于「一致」——不给绿灯。\n");
    process.stdout.write(reconcileSummary({ exit: 2, host: "none", files: sources.length, matched: 0, mismatched: 0, mine: 0, theirs: 0 }) + "\n");
    return 2;
  }
  const host = findPsHost();
  if (!host) {
    process.stdout.write("✗ 对账不能跑：本机找不到 PowerShell 宿主（试过 powershell / pwsh）\n");
    process.stdout.write("   「跑不了」不等于「一致」——不给绿灯；把它悄悄当通过就是亲手造一个死闸。\n");
    process.stdout.write(reconcileSummary({ exit: 2, host: "none", files: sources.length, matched: 0, mismatched: 0, mine: 0, theirs: 0 }) + "\n");
    return 2;
  }

  process.stdout.write("== 条款解析交叉对账（两套独立实现对同一份语料各数一遍）==\n");
  process.stdout.write(`   我方：ccswitch/lib/clause-parser.mjs      对方：${path.basename(o.psScript)}（${host}）\n`);

  const rows = [];
  let matched = 0, mismatched = 0, mine = 0, theirs = 0, missingSrc = 0;
  for (const s of sources) {
    const abs = path.isAbsolute(s.file) ? s.file : path.join(REPO_ROOT, s.file);
    if (!fs.existsSync(abs)) {
      // 语料缺席**必须出声**：静默跳过一份语料，与「这份语料一致」在输出上不可区分。
      rows.push({ file: s.file, state: "源缺席", detail: abs });
      missingSrc++;
      mismatched++;
      continue;
    }
    let parsed;
    try {
      parsed = parseFile(abs, { file: s.file, selector: s.selector, roleScheme: s.role_scheme });
    } catch (e) {
      rows.push({ file: s.file, state: "我方解析抛错", detail: e && e.message ? e.message : String(e) });
      mismatched++;
      continue;
    }
    const ps = runPs(host, o.psScript, abs, s.selector);
    if (!ps.marker) {
      rows.push({
        file: s.file, state: "对方没给末行",
        detail: `exit=${ps.code}；末行契约可能被改坏，或脚本没跑起来。stderr: ${ps.err.slice(0, 200)}`,
      });
      mismatched++;
      continue;
    }
    mine += parsed.stats.clauses;
    theirs += ps.marker.clauses;
    const okClauses = parsed.stats.clauses === ps.marker.clauses;
    const okNoTrig = parsed.stats.no_trigger === ps.marker.notrigger;
    if (okClauses && okNoTrig) {
      matched++;
      rows.push({
        file: s.file, state: "一致",
        detail: `条款 ${parsed.stats.clauses} · 触发:无 ${parsed.stats.no_trigger} · 对方硬闸 exit=${ps.marker.exit}`,
      });
    } else {
      mismatched++;
      rows.push({
        file: s.file, state: "不一致",
        detail:
          `条款 我方 ${parsed.stats.clauses} vs 对方 ${ps.marker.clauses}；` +
          `触发:无 我方 ${parsed.stats.no_trigger} vs 对方 ${ps.marker.notrigger}` +
          `（对方硬闸 exit=${ps.marker.exit}）`,
      });
    }
  }

  for (const r of rows) {
    const flag = r.state === "一致" ? "✓" : "✗";
    process.stdout.write(`  ${flag} [${r.state}] ${r.file}\n      ${r.detail}\n`);
  }

  // ② 整批全零要红：每个文件都「0 == 0」的一致是空的一致。
  let exit = mismatched > 0 ? 1 : 0;
  if (exit === 0 && mine === 0) {
    process.stdout.write("✗ zero-sample：所有源加起来一条条款都没有 —— 这种「一致」与「两边都瞎了」不可区分，判红。\n");
    exit = 1;
  }
  if (exit === 0) {
    process.stdout.write(`OK：${matched} 份语料两套解析逐一对上（合计条款 ${mine}）。\n`);
    process.stdout.write("     它证明的只是「两套读法数出同一个数」，**不证明这个数是对的** —— 两边同时漏掉一整个\n");
    process.stdout.write("     没人写过的形态时，差仍然是 0。这一面靠人读 diff。\n");
    process.stdout.write("     另：对方对零条款文件会报 zero-sample 硬闸红（上面的 exit=1），那是它的防御不是对账失败。\n");
  } else {
    process.stdout.write(`✗ 对账失败：${mismatched} 份语料对不上（缺席 ${missingSrc} 份）。\n`);
    process.stdout.write("   **不判谁对**：两套实现之一瞎了，判哪一套是人的活。先读上面的差异，再去看那份语料的 diff。\n");
  }
  process.stdout.write(
    reconcileSummary({ exit, host, files: sources.length, matched, mismatched, mine, theirs }) + "\n"
  );
  return exit;
}

// ── main ─────────────────────────────────────────────────────────────────────
const opts = parseArgs(process.argv.slice(2));
if (opts.mode === "help") {
  process.stdout.write(
    [
      "gen-clause-index.mjs — 条款机器面索引",
      "",
      "  node ccswitch/scripts/gen-clause-index.mjs              生成/覆写 ccswitch/clause-index.json",
      "  node ccswitch/scripts/gen-clause-index.mjs --check      漂移检查（源变了而索引没跟上 ⇒ exit 1）",
      "  node ccswitch/scripts/gen-clause-index.mjs --reconcile   与 check-clauses-structure.ps1 交叉对账",
      "",
      "  --sources-json <path>  用自带的源清单（JSON 数组或 {sources:[…]}），可指仓外语料",
      "  --out <path>           输出到别处（默认 ccswitch/clause-index.json）",
      "  --ps-script <path>     对账用的第二套解析（默认本仓 ccswitch/scripts/check-clauses-structure.ps1）",
      "  --quiet                只打末行",
      "",
      "索引是**派生物**：真相源是 Markdown 原文，改索引不会改变任何行为。",
    ].join("\n") + "\n"
  );
  process.exit(opts.bad ? 1 : 0);
}

try {
  process.exit(opts.mode === "reconcile" ? runReconcile(opts) : runIndex(opts));
} catch (e) {
  process.stdout.write(`✗ 未预期的失败：${e && e.stack ? e.stack : String(e)}\n`);
  process.stdout.write(
    opts.mode === "reconcile"
      ? reconcileSummary({ exit: 1, host: "none", files: 0, matched: 0, mismatched: 0, mine: 0, theirs: 0 }) + "\n"
      : summaryLine({ exit: 1, sources: 0, clauses: 0, observation: 0, drift: "missing", wrote: 0 }) + "\n"
  );
  process.exit(1);
}
