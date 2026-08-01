#!/usr/bin/env node
// check-dead-gates.mjs — 死闸检测：settings 里注册的那些闸，指向的脚本还活着吗
//
// ── 治的是什么病 ─────────────────────────────────────────────────────────────
// 「a dead gate silently no-ops」——一个指向已不存在（或语法已坏）脚本的 hook，
// 与一个真的跑过且全过的 hook，**在机器可读通道上完全不可区分**：宿主静默跳过它，
// 没有红、没有告警、没有任何一行输出会因此缺席。这与本仓 verify-all 退出码那条
// （`-Skip` 掉 5 道硬闸的退出码与全绿逐字节相同）是同一个病换了个身位。
//
// 而 dao 正在把身家往 hook 上压（门控类条款逐条迁到 hook 层 = P1，见
// docs/specs/dao-arch-optimization-202608.md）。**押注越重，这道安全网越必要**：
// 迁过去的条款一旦落在一个死 hook 上，它的遵守率从「文字档 9-24%」直接掉到 0，
// 而台账上看起来和「已经 hook 化了」一模一样。
//
// 外部同构：ctxlint 的 `dead hooks` 检查（YawLabs, MIT）。dao 侧另有一次本机实证——
// dao-scaffold-check.js 的 `isMetaRepo` 原判据 `basename === "windsurf-dao"` 在任何
// worktree 里恒为假，模式 A 整块从未跑过，而它的输出与「跑了且没问题」完全一样。
//
// ── 扫什么（三个面 + 一个反向面）────────────────────────────────────────────
//   ① live  `~/.claude/settings.json` —— 宿主真正读的那一份（投影层）
//   ② 快照  `config-sync/common/*.json` —— git 里的那一份（cc-switch DB 导出格式，
//           `rows[].value` 里嵌着各宿主的完整配置字符串）。**两层都要扫**：只扫 live
//           会漏掉「快照里指着一个已删脚本、下次 restore 下发就把 live 也带死」这一形态。
//   ③ permissions 的 deny/allow/ask 里**路径形态**的条目（今天一条都没有，但 P1 之后
//           permissions 会成为门控载体之一，先把面开出来）
//   ④ 反向：`ccswitch/hooks/` 里**存在但没被任何一层注册**的孤儿文件 —— 提示不报错，
//           它可能是刻意存货（写了还没挂），也可能是挂漏了，机器判不出，只负责端到眼前
//
// ── 判「活着」的两层 ────────────────────────────────────────────────────────
//   存在性：解析出脚本路径 → 文件在不在。**这是硬判据。**
//   语法可载：`.js/.mjs/.cjs` 再过一道解析（script goal 走进程内 vm.Script，module goal
//            走权威的 `node --check`）——一个存在但语法坏掉的 hook 同样是静默死闸，
//            宿主 spawn 它、它崩、宿主吞掉，与「跑过且没意见」在输出上不可区分。
//   `.ps1/.sh/.py` 等**只查存在性不查语法**（要各自的解析器 + 平台依赖）。这是已知缺口，
//   在报文里如实标 `syntax=skipped`，不假装查过。
//
// ── 自检半边为什么必须另起一套读取路径 ──────────────────────────────────────
// dao 守卫铁律：一个检查器若同时负责「找出违例」与「确认自己真的看到了样本」，两半
// **必须走两套独立实现**——复用同一个解析器会让两半一起瞎：解析漏掉一整段时，违例数与
// 样本数**同时归零**，二者之差恒为 0 ⇒ 自检永远为真，退化成一句废话。
// 故这里的分母由 `censusCommandEntries()` 产出：它**不 JSON.parse、不认识 hooks 结构**，
// 只在原始文本上数 `"type": "command"`（含被转义一层的 `\"type\": \"command\"`，快照层
// 就是这个形态）。主逻辑的结构化遍历若哪天被改瞎（键名改了 / 早退了 / 层级判错），
// 结构数会掉到普查数以下 ⇒ `selfcheck=fail`，而普查这一半仍然看得见样本。
//
// ── 退出码 / 末行契约 ───────────────────────────────────────────────────────
//   DEAD_GATES_SUMMARY exit=<0|1> hooks=<N> dead=<M> orphan=<K> selfcheck=<ok|fail> unverifiable=<U>
//   · exit  —— 与进程退出码恒等；1 = 有死闸 **或** 自检半边失败
//   · hooks —— 本次实际扫到的闸条目总数（hooks 各挂载点 + statusLine，live+快照合计）
//   · dead  —— 存在性/语法任一不过的条目数
//   · orphan—— 反向面：hooks 目录里没被注册的文件数（**不参与退出码**）
//   末行**每条路径都打印**（含读不到文件的失败路径）：只在成功时打摘要，等于让「没查成」
//   在机器通道上表现为「什么都没说」。
//
//   ⚠ 后两个字段是对派单契约（四字段）的**刻意扩展**，两条理由都指向同一件事——
//   本脚本不该在自己的输出契约上重犯它要治的病：
//   · `selfcheck` —— 不给第二个信号的话，`dead=0 exit=1` 读者无从分辨「查了没事」
//     与「压根没看到样本」；
//   · `unverifiable` —— 只报 `dead=0` 会让消费方（SessionStart hook 只读末行、不读中文正文）
//     说出「零死闸」，而其中 U 条其实**根本没被核验**。「没查成」与「查了没事」必须分得开。
//   消费方按字段名取值，勿按位置取；未来加字段一律追加在末尾。
//
// ── 跑法 ────────────────────────────────────────────────────────────────────
//   node ccswitch/scripts/check-dead-gates.mjs
//   node ccswitch/scripts/check-dead-gates.mjs --json
//   测试用覆写：--live <settings.json> --snapshot-dir <dir> --hooks-dir <dir> --project-root <dir>
//
// 真相源：windsurf-dao/ccswitch/scripts/check-dead-gates.mjs
// 调用方：ccswitch/hooks/dao-scaffold-check.js（SessionStart 模式 A，零新增注册）
// 自证：node tests/dead-gates.tests.js

import fs from "fs";
import os from "os";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();

// ── 参数 ────────────────────────────────────────────────────────────────────
const ARGV = process.argv.slice(2);
function argOf(name, dflt) {
  const i = ARGV.indexOf(name);
  return i >= 0 && ARGV[i + 1] != null ? ARGV[i + 1] : dflt;
}
const PROJECT_ROOT = path.resolve(argOf("--project-root", ROOT));
const LIVE_SETTINGS = path.resolve(argOf("--live", path.join(HOME, ".claude", "settings.json")));
const SNAPSHOT_DIR = path.resolve(argOf("--snapshot-dir", path.join(ROOT, "config-sync", "common")));
const HOOKS_DIR = path.resolve(argOf("--hooks-dir", path.join(ROOT, "ccswitch", "hooks")));
const AS_JSON = ARGV.includes("--json");

// 脚本形态扩展名。`.exe` 也收：一个指向已卸载 exe 的 hook 同样静默死掉，
// 「不是我们写的」不改变它是死闸这个事实（谁去修是另一回事，报文里标了归属）。
const SCRIPT_EXT = "mjs|cjs|js|ps1|psm1|sh|bash|py|rb|bat|cmd|exe";
const JS_EXT = /\.(mjs|cjs|js)$/i;
// 文档类：孤儿扫描时排除（它们本来就不该被注册）
const DOCISH_EXT = new Set([".md", ".json", ".txt", ".yml", ".yaml", ".lock"]);

function out(s) { process.stdout.write(s + "\n"); }

// ── 占位符还原 ──────────────────────────────────────────────────────────────
// 快照层的路径是占位符化的（config-sync/lib/paths.mjs 的方案）。用普通字符串拼接
// 而非模板串——普通引号里 `${...}` 不会被插值，但写成拼接可免去下一个读者的怀疑。
const PH_PROJECT = "$" + "{PROJECT_ROOT}";
const PH_HOME = "$" + "{HOME}";
function decodePlaceholders(s) {
  return String(s)
    .split(PH_PROJECT).join(PROJECT_ROOT.replace(/\\/g, "/"))
    .split(PH_HOME).join(HOME.replace(/\\/g, "/"));
}

// ── 命令串 → 脚本引用 ───────────────────────────────────────────────────────
// 四种归类，**只有 `path` 一种能被核验**，其余三种一律进「无法核验」桶并打印出来：
//   path     —— 绝对路径形态，可查存在性（唯一能下硬结论的）
//   relative —— 相对路径：hook 的 cwd 由宿主决定（随项目变），此处无从解析
//   bare     —— 光一个文件名没有路径（靠 PATH 找），同样无从解析
//   none     —— 命令串里根本没有脚本形态的 token（内联命令 / 纯 shell）
// 「无法核验」**不等于**「核验通过」——这是本脚本自己也必须守的那条判据，
// 故它们恒被打印（`⚠` 行），只是不参与退出码：把 PATH 型命令判红会让这道闸
// 生下来就吵，而生下来就吵的检查一定会被静音。
function extractRef(command) {
  if (command == null) return { kind: "none", token: null, decoded: "" };
  const decoded = decodePlaceholders(String(command));
  const s = decoded.replace(/\\/g, "/");
  // ① 引号内整段优先：Windows 路径可能含空格，引号是唯一可靠的边界
  const q = s.match(new RegExp('"([^"]+?\\.(?:' + SCRIPT_EXT + '))"', "i"));
  let token = q ? q[1] : null;
  // ② 否则取第一个「像脚本路径」的 token。用 `(?![A-Za-z0-9])` 收尾而非 `\s`，
  //    是为了让 `Bash(node scripts/x.js:*)` 这类 permissions 条目也切得出来。
  if (!token) {
    const m = s.match(new RegExp("([^\\s\"']*\\.(?:" + SCRIPT_EXT + "))(?![A-Za-z0-9])", "i"));
    token = m ? m[1] : null;
  }
  if (!token) return { kind: "none", token: null, decoded };
  const pathish = token.includes("/") || /^[A-Za-z]:/.test(token);
  if (!pathish) return { kind: "bare", token, decoded };
  if (!path.isAbsolute(token)) return { kind: "relative", token, decoded };
  return { kind: "path", token, abs: path.normalize(token), decoded };
}

// dao 自有 vs 外部：只影响报文措辞（该找谁修），不影响判红。
function ownerOf(ref) {
  const s = String(ref.token || "").toLowerCase();
  return /ccswitch\//.test(s) || /\.claude\/hooks\//.test(s) || /(^|\/)dao-/.test(s) ? "dao" : "外部";
}

// ── 语法可载性 ──────────────────────────────────────────────────────────────
// script goal 走进程内 vm.Script（同一个 V8 解析器、同一个 goal ⇒ **不是近似**，
// 且零 spawn：本机实测 13 个文件全走 `node --check` 要 ~400ms，全走 vm 是毫秒级）。
// module goal 走权威的 `node --check`（module goal 的严格模式差异 vm.Script 表达不了）。
// script goal 侧解析失败时**不下结论**，回退到 `node --check` 复判——
// 常见成因是「.js 文件其实是 ESM」或 shebang，让权威路径说了算，宁可多付一次 spawn。
const goalCache = new Map();
function goalOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".mjs") return "module";
  if (ext === ".cjs") return "script";
  let dir = path.dirname(file);
  for (let i = 0; i < 64; i++) {
    if (goalCache.has(dir)) return goalCache.get(dir);
    const pj = path.join(dir, "package.json");
    let g = null;
    try {
      if (fs.existsSync(pj)) {
        try {
          const t = JSON.parse(fs.readFileSync(pj, "utf8")).type;
          g = t === "module" ? "module" : "script";
        } catch (_) {
          // package.json 读不动/坏了 ⇒ 判不出 goal，取 module 让权威路径接管
          g = "module";
        }
      }
    } catch (_) { g = null; }
    if (g) { goalCache.set(dir, g); return g; }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return "script";
}

function nodeCheck(file) {
  const r = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8", timeout: 20000, windowsHide: true,
  });
  if (r.error) return { ok: false, how: "node --check", msg: String(r.error.message) };
  if (r.status === 0) return { ok: true, how: "node --check" };
  const msg = String(r.stderr || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 2).join(" / ");
  return { ok: false, how: "node --check", msg: msg || ("exit " + r.status) };
}

function syntaxCheck(file) {
  if (goalOf(file) !== "script") return nodeCheck(file);
  let src;
  try { src = fs.readFileSync(file, "utf8"); }
  catch (e) { return { ok: false, how: "read", msg: "读不出来：" + (e && e.message ? e.message : String(e)) }; }
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  try { new vm.Script(src, { filename: file }); return { ok: true, how: "vm" }; }
  catch (_) { return nodeCheck(file); }   // 不下结论，交权威路径
}

function verifyTarget(abs) {
  let exists = false;
  try { exists = fs.existsSync(abs) && fs.statSync(abs).isFile(); } catch (_) { exists = false; }
  if (!exists) return { ok: false, why: "missing", syntax: "n/a" };
  if (!JS_EXT.test(abs)) return { ok: true, why: "exists", syntax: "skipped" };
  const r = syntaxCheck(abs);
  return r.ok ? { ok: true, why: "exists", syntax: r.how }
              : { ok: false, why: "syntax", syntax: r.how, detail: r.msg };
}

// ── 结构化遍历（主逻辑那一半）───────────────────────────────────────────────
function walkGates(obj, origin, sink) {
  const hooks = obj && typeof obj.hooks === "object" && obj.hooks ? obj.hooks : {};
  for (const event of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    for (const g of groups) {
      const matcher = g && g.matcher != null && String(g.matcher) !== "" ? String(g.matcher) : "*";
      const list = g && Array.isArray(g.hooks) ? g.hooks : [];
      for (const h of list) {
        if (!h || h.type !== "command") continue;
        sink.push({ origin, where: "hooks." + event + "[" + matcher + "]", command: h.command, face: "hook" });
      }
    }
  }
  const sl = obj && obj.statusLine;
  if (sl && sl.type === "command") {
    sink.push({ origin, where: "statusLine", command: sl.command, face: "hook" });
  }
}

// permissions 面单独走：它不带 `"type":"command"`，故**不进普查分母**，
// 也不计入 `hooks=`（那个数与普查数是配对的，掺进别的东西会让下限断言失去意义）。
function walkPermissionRefs(obj, origin, sink) {
  const p = obj && obj.permissions;
  if (!p || typeof p !== "object") return;
  for (const face of ["deny", "allow", "ask"]) {
    const arr = Array.isArray(p[face]) ? p[face] : [];
    for (const item of arr) {
      const ref = extractRef(item);
      if (ref.kind !== "path") continue;   // 绝大多数是 `Bash(grep:*)` 形态，无路径可查
      sink.push({ origin, where: "permissions." + face, command: String(item), face: "permission" });
    }
  }
}

// ── 自检那一半：独立的最小读取路径 ──────────────────────────────────────────
// 刻意**不 JSON.parse、不认识 hooks 结构**——它与主逻辑唯一的共同前提是「文件里有文本」。
// 两种形态都数：live 层是裸 JSON（`"type": "command"`），快照层是嵌在字符串里的
// 转义形态（`\"type\": \"command\"`）。
// ── 它是钝的，而且钝的方向是刻意选的 ────────────────────────────────────────
// 已知近似两向都有：**低估** —— 更深层嵌套（`\\\"type\\\"`）数不出来（本仓两层配置里
// 不存在该形态）；**高估** —— 任何字符串值里恰好出现这几个字（含本文件被别人扫时）都会
// 被计一次。高估会让下限断言**误报**一次「扫描面塌陷」，那是**可接受的方向**：
// 误报逼人来看一眼，漏报让「零死闸」变成一句没有分母的空话。
// 一个自指提醒：本脚本自己的报告若落进它的扫描面，就会一跑一涨——故扫描面固定为
// live settings + `config-sync/common/*.json`，**不含任何本脚本会写出的东西**（它不落盘）。
function censusCommandEntries(text) {
  const s = String(text);
  const plain = (s.match(/"type"\s*:\s*"command"/g) || []).length;
  const escaped = (s.match(/\\"type\\"\s*:\s*\\"command\\"/g) || []).length;
  return plain + escaped;
}

// ── 一个配置文件 → 闸条目 + 普查数 ─────────────────────────────────────────
// 两种形态：cc-switch DB 导出（顶层 `rows[]`，每行 `value` 是嵌套 JSON 字符串）
// 与裸 settings 对象。两者都走同一个 walkGates。
function scanConfigFile(file, label) {
  const res = { file, label, gates: [], perms: [], census: 0, notes: [], parsedUnits: 0, unparsedUnits: 0 };
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) {
    res.notes.push("读不出来：" + (e && e.message ? e.message : String(e)));
    return res;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  res.census = censusCommandEntries(raw);

  let doc = null;
  try { doc = JSON.parse(raw); }
  catch (e) {
    res.notes.push("JSON 解析失败：" + (e && e.message ? e.message : String(e)) +
      "（普查在同一文件上数到 " + res.census + " 条 command 条目 ⇒ 它们此刻不可核验）");
    res.unparsedUnits++;
    return res;
  }

  if (doc && Array.isArray(doc.rows)) {
    for (const row of doc.rows) {
      // `rows` 这个键在 config-sync 里不止一种形态：settings 那份是 `{key,value}`，
      // mcp_servers / prompts 那两份是业务表行（`{id,name,...}`）。**只有前者是配置单元**。
      // 后者不报警告——但也不静默丢：普查一遍，数到 command 条目才出声。
      // （初版对每个业务行都打一条「value 不是字符串」，那是把「不是这类东西」误报成「读不动」。）
      const hasKV = row && typeof row.key === "string" && Object.prototype.hasOwnProperty.call(row, "value");
      if (!hasKV) {
        let c = 0;
        try { c = censusCommandEntries(JSON.stringify(row)); } catch (_) { c = 0; }
        if (c > 0) res.notes.push(label + "：一个非 settings 形态的行里普查数到 " + c + " 条 command 条目 ⇒ 不可核验");
        continue;
      }
      const key = String(row.key);
      const origin = label + ":" + key;
      let val = row.value;
      if (typeof val !== "string") {
        // 值不是字符串（导出格式变了）——不静默跳过
        if (val && typeof val === "object") { res.parsedUnits++; walkGates(val, origin, res.gates); walkPermissionRefs(val, origin, res.perms); }
        else res.notes.push(origin + "：value 既不是字符串也不是对象，跳过");
        continue;
      }
      let obj = null;
      try { obj = JSON.parse(val); } catch (_) { obj = null; }
      if (obj && typeof obj === "object") {
        res.parsedUnits++;
        walkGates(obj, origin, res.gates);
        walkPermissionRefs(obj, origin, res.perms);
      } else {
        // 非 JSON 的行（如 codex 那行是 TOML）——只有在普查数到 command 条目时才值得说
        res.unparsedUnits++;
        const c = censusCommandEntries(val);
        if (c > 0) res.notes.push(origin + "：不是 JSON 但普查数到 " + c + " 条 command 条目 ⇒ 不可核验");
      }
    }
  } else if (doc && typeof doc === "object") {
    res.parsedUnits++;
    walkGates(doc, label, res.gates);
    walkPermissionRefs(doc, label, res.perms);
  }
  return res;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const scans = [];
scans.push(scanConfigFile(LIVE_SETTINGS, "live"));

let snapFiles = [];
let snapDirErr = null;
try {
  snapFiles = fs.readdirSync(SNAPSHOT_DIR).filter((f) => f.toLowerCase().endsWith(".json")).sort();
} catch (e) { snapDirErr = e && e.message ? e.message : String(e); }
for (const f of snapFiles) scans.push(scanConfigFile(path.join(SNAPSHOT_DIR, f), "快照/" + f));

const gates = [];
for (const s of scans) for (const g of s.gates) gates.push(g);
const permRefs = [];
for (const s of scans) for (const p of s.perms) permRefs.push(p);

const dead = [];
const unverifiable = [];
const alive = [];
const registeredNames = new Set();   // 供孤儿反查：basename 与去扩展名的 basename

function judge(entry) {
  const ref = extractRef(entry.command);
  const rec = Object.assign({}, entry, { ref });
  // 登记「被引用过的名字」要在分流**之前**做：孤儿反查问的是「这个文件有没有被谁提到」，
  // 而一条相对路径 / 光文件名的注册**也是一次提及**。只登记可核验的那一支，会把
  // 「注册了但路径写法核不了」误报成「压根没注册」——两种完全不同的病，处方也不同。
  if (ref.token) {
    const base = path.basename(ref.token).toLowerCase();
    registeredNames.add(base);
    registeredNames.add(base.replace(/\.[^.]+$/, ""));
  }
  if (ref.kind !== "path") { rec.status = "unverifiable"; unverifiable.push(rec); return; }
  const v = verifyTarget(ref.abs);
  rec.verify = v;
  rec.owner = ownerOf(ref);
  if (v.ok) { rec.status = "alive"; alive.push(rec); } else { rec.status = "dead"; dead.push(rec); }
}
for (const g of gates) judge(g);
for (const p of permRefs) judge(p);

// ── 反向面：孤儿 hook ───────────────────────────────────────────────────────
const orphans = [];
let hooksDirErr = null;
let hookFileTotal = 0;
try {
  for (const name of fs.readdirSync(HOOKS_DIR).sort()) {
    const full = path.join(HOOKS_DIR, name);
    let isFile = false;
    try { isFile = fs.statSync(full).isFile(); } catch (_) { isFile = false; }
    if (!isFile) continue;
    if (DOCISH_EXT.has(path.extname(name).toLowerCase())) continue;
    hookFileTotal++;
    const lower = name.toLowerCase();
    const noExt = lower.replace(/\.[^.]+$/, "");
    if (!registeredNames.has(lower) && !registeredNames.has(noExt)) orphans.push(name);
  }
} catch (e) { hooksDirErr = e && e.message ? e.message : String(e); }

// ── 下限断言（自检半边）─────────────────────────────────────────────────────
// 形态取**集合差**不取魔数阈值：「低于 N 条即红」要维护一个会过期的数字，
// 「比上次少 M% 即红」要持久化基线，而基线文件不在时会静默跳过——正是本闸要防的病。
const selfIssues = [];
let censusTotal = 0, structTotal = 0;
for (const s of scans) {
  censusTotal += s.census;
  structTotal += s.gates.length;
  if (s.gates.length < s.census) {
    selfIssues.push("undercount@" + s.label + "：结构化遍历数到 " + s.gates.length +
      " 条闸，独立普查在同一文本上数到 " + s.census + " 条 ⇒ 有样本没被看见（扫描面塌陷）");
  }
}
if (censusTotal > 0 && structTotal === 0) {
  selfIssues.push("zero-sample：普查数到 " + censusTotal + " 条 command 条目，而结构化遍历一条都没拿到 ⇒ 主解析已瞎");
}
if (scans.length && scans[0].notes.length && scans[0].gates.length === 0) {
  selfIssues.push("live-unreadable：live settings 一条闸都没扫到（" + scans[0].notes.join("；") + "）");
}
if (snapDirErr) selfIssues.push("snapshot-unreadable：快照目录读不了（" + SNAPSHOT_DIR + "：" + snapDirErr + "）");
if (hooksDirErr) selfIssues.push("hooksdir-unreadable：hooks 目录读不了（" + HOOKS_DIR + "：" + hooksDirErr + "）");

const selfOk = selfIssues.length === 0;
const exitCode = (dead.length > 0 || !selfOk) ? 1 : 0;

// ── 输出 ────────────────────────────────────────────────────────────────────
function summaryLine() {
  return "DEAD_GATES_SUMMARY exit=" + exitCode +
    " hooks=" + structTotal +
    " dead=" + dead.length +
    " orphan=" + orphans.length +
    " selfcheck=" + (selfOk ? "ok" : "fail") +
    " unverifiable=" + unverifiable.length;
}

if (AS_JSON) {
  out(JSON.stringify({
    exit: exitCode,
    scans: scans.map((s) => ({ file: s.file, label: s.label, gates: s.gates.length, census: s.census, parsedUnits: s.parsedUnits, unparsedUnits: s.unparsedUnits, notes: s.notes })),
    dead: dead.map((d) => ({ origin: d.origin, where: d.where, command: d.command, token: d.ref.token, why: d.verify.why, detail: d.verify.detail || "", owner: d.owner })),
    unverifiable: unverifiable.map((u) => ({ origin: u.origin, where: u.where, command: u.command, kind: u.ref.kind })),
    alive: alive.map((a) => ({ origin: a.origin, where: a.where, token: a.ref.token, syntax: a.verify.syntax })),
    orphans, hookFileTotal, selfIssues,
  }, null, 2));
  out(summaryLine());
  process.exit(exitCode);
}

out("");
out("=== dao 死闸检测 ===");
// 有内容的逐个打；零闸零普查零备注的**仍然点名**（只是并成一行）——
// 扫描面必须可见：省掉名字，下一次有人把某个文件挪出扫描面时就是静默缩面。
const quiet = [];
for (const s of scans) {
  if (s.gates.length === 0 && s.census === 0 && s.notes.length === 0) { quiet.push(s.label); continue; }
  out("  " + s.label.padEnd(24) + " 闸 " + String(s.gates.length).padStart(3) +
      " · 普查 " + String(s.census).padStart(3) +
      " · 可解析单元 " + s.parsedUnits + (s.unparsedUnits ? "（另 " + s.unparsedUnits + " 个非 JSON 单元）" : "") +
      "  " + s.file);
  for (const n of s.notes) out("      ⚠ " + n);
}
if (quiet.length) out("  （另 " + quiet.length + " 份零闸零普查：" + quiet.join("、") + "）");
if (snapDirErr) out("  ✗ 快照目录读不了：" + SNAPSHOT_DIR + "（" + snapDirErr + "）");

out("");
if (dead.length === 0) {
  out("✓ 死闸：0（存在性 + 语法可载两层都过）");
} else {
  out("✗ 死闸 " + dead.length + " 条 —— 它们此刻在宿主里静默 no-op，与「跑过且没意见」不可区分：");
  for (const d of dead) {
    const why = d.verify.why === "missing" ? "脚本不存在" : "语法不可载（" + d.verify.syntax + "）";
    out("    · [" + d.origin + " " + d.where + "] " + why + "：" + d.ref.token + "（归属：" + d.owner + "）");
    if (d.verify.detail) out("        " + d.verify.detail);
  }
}

if (unverifiable.length) {
  out("");
  out("⚠ 无法核验 " + unverifiable.length + " 条（**不等于通过**，只是此处判不了，故不计入 dead）：");
  const kindCn = { relative: "相对路径（cwd 随宿主变）", bare: "光文件名（靠 PATH 解析）", none: "命令串里没有脚本形态的 token" };
  for (const u of unverifiable) {
    out("    · [" + u.origin + " " + u.where + "] " + (kindCn[u.ref.kind] || u.ref.kind) + "：" + String(u.command).slice(0, 120));
  }
}

if (permRefs.length === 0) {
  out("");
  out("ⓘ permissions 面：deny/allow/ask 里零条路径形态条目（当前形态都是 `Bash(x:*)` 类，无路径可查）");
}

out("");
if (hooksDirErr) {
  out("✗ 孤儿反查跑不了：" + HOOKS_DIR + "（" + hooksDirErr + "）");
} else if (orphans.length === 0) {
  out("ⓘ 孤儿 hook：0（" + HOOKS_DIR + " 下 " + hookFileTotal + " 个文件全部在某一层被注册）");
} else {
  out("ⓘ 孤儿 hook " + orphans.length + "/" + hookFileTotal + " 个（存在但没被任何一层注册）——" +
      "**这是提示不是错误**：可能是刻意存货（写了还没挂），也可能是挂漏了，机器判不出：");
  for (const o of orphans) out("    · " + o);
}

out("");
if (selfOk) {
  out("✓ 自检半边：结构化遍历 " + structTotal + " 条 ≥ 独立普查 " + censusTotal + " 条（扫描面没塌）");
} else {
  out("✗ 自检半边失败 " + selfIssues.length + " 条 —— **此时「零死闸」不可信，先修检测器**：");
  for (const i of selfIssues) out("    · " + i);
}

out("");
out("── 合计：闸 " + structTotal + " 条（另 permissions 路径条目 " + permRefs.length + " 条）· 死 " + dead.length +
    " · 无法核验 " + unverifiable.length + " · 孤儿 " + orphans.length + " · 自检 " + (selfOk ? "ok" : "fail"));
out(summaryLine());
process.exit(exitCode);
