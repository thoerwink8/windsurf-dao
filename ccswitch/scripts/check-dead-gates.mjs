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
// ── 扫什么（三个配置层 + 一个横切面 + 一个反向面）───────────────────────────
//   ① live  `~/.claude/settings.json` —— 宿主真正读的那一份（投影层）
//   ② 快照  `config-sync/common/*.json` —— git 里的那一份（cc-switch DB 导出格式，
//           `rows[].value` 里嵌着各宿主的完整配置字符串）。**两层都要扫**：只扫 live
//           会漏掉「快照里指着一个已删脚本、下次 restore 下发就把 live 也带死」这一形态。
//   ③ providers  cc-switch DB `providers` 表各行的 `settings_config`（issue #57）——
//           **真正的下发源就是这一层**，理由见下一段。
//   ④ permissions 的 deny/allow/ask 里**路径形态**的条目（今天一条都没有，但 P1 之后
//           permissions 会成为门控载体之一，先把面开出来）。三个配置层都过这一面。
//   ⑤ 反向：`ccswitch/hooks/` 里**存在但没被任何一层注册**的孤儿文件 —— 提示不报错，
//           它可能是刻意存货（写了还没挂），也可能是挂漏了，机器判不出，只负责端到眼前
//
// ── 为什么必须有 providers 层（issue #57；#49/#50 已把事实坐实）──────────────
// 上面 ①② 两层画漏了一层：`common_config_claude` 是**镜像层**，并不在下发路径上。
// cc-switch 真正写进 `~/.claude/settings.json` 的，是 `providers` 表里**当前那个 provider
// 自己那一行**的 `settings_config`，而且是**整份覆盖**（#49 实证：PostCompact 钩子就是被
// 「切一次 provider」这一个动作抹掉的）。⇒ 每个 provider 各带一份 hooks 段。
// 于是「某个 provider 的钩子指着一个已被删掉的脚本」这一形态，在 ①② 两层上**完全看不见**：
// live 里是当前 provider 的内容（好的）、快照里是镜像层的内容（好的），而你一旦切到那个
// provider，那条钩子当场变成死闸 —— 正是本脚本要治的那个病，只是它此前发生在一个
// 本脚本看不到的层里，**于是「零死闸」这句话本身是有射程缺口的**。
//
// **不按 app_type 划范围，全表扫**（与 settings-drift `--providers` 的刻意分工，不是不一致）：
// 那一面比的是「各 provider 的 hooks 段互相之间还一不一样」，把不带 hooks 的行拉进去会造出
// 恒定噪音，故它按 `app_type='claude'` 收窄。本脚本问的是**每个条目自己的存在性**
// ⇒ 不带 hooks 的行天然贡献 0 个条目、0 条普查、**0 条噪音**，收窄反而是白付一个会过期的
// 判据（今天只有 claude 那类带 hooks，不等于明天也是）。同一份数据、两个问题、两种范围。
//
// **只读是结构性的不是纪律性的**：走 `config-sync/lib/sqlite.mjs` 的 `runSql(…, readonly:true)`，
// sqlite3 以 `-readonly` 打开 ⇒ 是它自己拒绝写入，而不是「我们保证不写」。
// 这一层也**一个字节都不落盘**（报文只走 stdout），故报告不可能落进自己的扫描面。
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
//   DEAD_GATES_SUMMARY exit=<0|1|2> hooks=<N> dead=<M> orphan=<K> selfcheck=<ok|fail>
//                      unverifiable=<U> providers=<P> providerscan=<ok|off|uncheckable>
//   · exit  —— 与进程退出码恒等；1 = 有死闸 **或** 自检半边失败；
//              2 = 无红，但 providers 层**没查成**（DB 读不到 / 无 providers 表 / 零行）
//   · hooks —— 本次实际扫到的闸条目总数（hooks 各挂载点 + statusLine，三层合计）
//   · dead  —— 存在性/语法任一不过的条目数
//   · orphan—— 反向面：hooks 目录里没被注册的文件数（**不参与退出码**）
//   · providers —— providers 表里实际读到并扫过的行数（`off`/`uncheckable` 时为 0）
//   · providerscan —— `ok` 查成了 / `off` 被 `--no-providers` 显式关掉 / `uncheckable` 没查成
//   末行**每条路径都打印**（含读不到文件的失败路径）：只在成功时打摘要，等于让「没查成」
//   在机器通道上表现为「什么都没说」。
//
//   ⚠ 这些字段是对派单契约（四字段）的**刻意扩展**，理由都指向同一件事——
//   本脚本不该在自己的输出契约上重犯它要治的病：
//   · `selfcheck` —— 不给第二个信号的话，`dead=0 exit=1` 读者无从分辨「查了没事」
//     与「压根没看到样本」；
//   · `unverifiable` —— 只报 `dead=0` 会让消费方（SessionStart hook 只读末行、不读中文正文）
//     说出「零死闸」，而其中 U 条其实**根本没被核验**。「没查成」与「查了没事」必须分得开。
//   · `providerscan` + `exit 2` —— 同一条判据用在**整整一层**上：providers 层没查成时，
//     「零死闸」这句话的射程比读者以为的小一层，而 `exit 0` 说不出这件事。
//     `off` 与 `uncheckable` 也刻意分开：前者是操作者显式选的范围，后者是环境没给成。
//   消费方按字段名取值，勿按位置取；未来加字段一律追加在末尾。
//
// ── 跑法 ────────────────────────────────────────────────────────────────────
//   node ccswitch/scripts/check-dead-gates.mjs
//   node ccswitch/scripts/check-dead-gates.mjs --json
//   node ccswitch/scripts/check-dead-gates.mjs --no-providers   （只扫 live+快照两层）
//   测试用覆写：--live <settings.json> --snapshot-dir <dir> --hooks-dir <dir>
//               --project-root <dir> --db-file <cc-switch.db>
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
// providers 层。`--db-file` 不给时走 config-sync 的 cc-switch DB 默认路径（**不在本文件
// 复刻那个路径**——它的唯一真相源是 config-sync/lib/paths.mjs，复刻一份就是新的漂移面）。
const DB_FILE = argOf("--db-file", null);
const NO_PROVIDERS = ARGV.includes("--no-providers");

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

// ── 一段配置文本 → 闸条目 + 普查数 ─────────────────────────────────────────
// 三种形态都走这里：cc-switch DB 导出（顶层 `rows[]`，每行 `value` 是嵌套 JSON 字符串）、
// 裸 settings 对象、以及 providers 表某一行的 `settings_config`（也是裸 settings 形态）。
// 三者共用同一个 walkGates —— **口径必须是同一个**：分母（普查）与分子（结构化遍历）
// 若在不同层用不同口径，下限断言会在某一层恒红或恒绿，两个方向都让自检失去意义。
// `layer` 只影响报文分节与 JSON 输出，不影响判据。
function scanConfigText(raw0, label, file, layer) {
  const res = { file, label, layer: layer || "file", gates: [], perms: [], census: 0, notes: [], parsedUnits: 0, unparsedUnits: 0 };
  let raw = String(raw0 == null ? "" : raw0);
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

function scanConfigFile(file, label) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) {
    return { file, label, layer: "file", gates: [], perms: [], census: 0, parsedUnits: 0, unparsedUnits: 0,
      notes: ["读不出来：" + (e && e.message ? e.message : String(e))] };
  }
  return scanConfigText(raw, label, file, "file");
}

// ── providers 层：cc-switch DB（结构性只读）─────────────────────────────────
// 返回 `{ state, why, scans, total, appTypeCounts, dbPath }`。
//   state=ok          —— 读到了 providers 表且至少一行，逐行已扫
//   state=off         —— `--no-providers`，操作者显式缩了扫描面（**不是没查成**）
//   state=uncheckable —— sqlite3 找不到 / DB 不在 / 无 providers 表 / 零行 / 查询报错
// **三态刻意分开**，因为它们的处方不同：off 该问「你为什么关掉它」，uncheckable 该问
// 「这台机器上 cc-switch 装了吗」，而两者都**不等于**「这一层查过了没事」。
// 两个 import 都是**动态**的：sqlite.mjs 是 ESM + 要 spawn sqlite3，静态 import 会让
// 「sqlite 那条路坏了」变成「整个死闸检测跑不起来」—— 一道检查不该被它的可选层拖死。
// 报错原文提取：stderr 优先（真原因在那里），message 首行只当上下文。
// 两侧都截断到可读长度 —— 但**截的是尾巴不是头**，成因永远在前几行。
function errWhy(e) {
  const stderr = e && e.stderr != null ? String(e.stderr) : "";
  const head = stderr.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 3).join(" / ");
  const msg = (e && e.message ? String(e.message) : String(e)).split(/\r?\n/)[0].trim();
  return (head ? head + "（" + msg + "）" : msg).slice(0, 600);
}

async function scanProviders() {
  const empty = { scans: [], total: 0, appTypeCounts: {}, dbPath: DB_FILE || "(config-sync 默认)" };
  if (NO_PROVIDERS) return Object.assign({ state: "off", why: "--no-providers" }, empty);

  let runSql = null, defaultDbPath = null;
  try {
    ({ runSql } = await import("../../config-sync/lib/sqlite.mjs"));
    ({ ccSwitchDbPath: defaultDbPath } = await import("../../config-sync/lib/paths.mjs"));
  } catch (e) {
    return Object.assign({ state: "uncheckable", why: "config-sync 的 sqlite/paths 模块加载失败：" + errWhy(e) }, empty);
  }
  const dbPath = DB_FILE ? path.resolve(DB_FILE) : defaultDbPath;

  let rows = null;
  try {
    // 只选四列：settings_config 已经很大，别把 meta/notes 一起拖进内存与报文。
    // `readonly: true` ⇒ sqlite3 `-readonly` 打开，写入由它自己拒绝（结构性只读）。
    rows = runSql("SELECT id, app_type, name, settings_config FROM providers;",
      { dbPath, json: true, readonly: true });
  } catch (e) {
    // DB 不在 / sqlite3 找不到 / 没有 providers 表 / DB 被锁 —— 全部走这里。
    // **不细分**：它们对读者是同一句话「这一层这次没查成」，而原始报错里已经带着到底是
    // 哪一种（原文照登，不做措辞转译，转译只会丢信息）。
    // ⚠ 这里**必须先读 `e.stderr`**：`execFileSync` 的 `e.message` 首行恒是
    // `Command failed: <整条命令行>`，真正的原因（`no such table: providers` 之类）在
    // stderr 里。首版只取了 `e.message` 的首行，于是「没查成」这一态**每一种成因都长得
    // 一模一样** —— 那正是本脚本要治的病，在它自己的降级路径上重演了一次（首跑 fixture
    // 当场撞出，已配一条钉死的断言：⑬「原因原文照登」）。
    return Object.assign({ state: "uncheckable", why: errWhy(e) }, empty, { dbPath });
  }
  if (!Array.isArray(rows)) {
    return Object.assign({ state: "uncheckable", why: "providers 查询没返回数组（sqlite3 -json 输出形态变了？）" }, empty, { dbPath });
  }
  if (rows.length === 0) {
    // 零行**不是**「全都活着」。一个检查器数到 0 个违例，和它根本没看到样本，
    // 在只读退出码的消费方眼里必须长得不一样 —— 这正是本脚本自己在治的病。
    return Object.assign({ state: "uncheckable", why: "providers 表里零行 ⇒ 没有任何样本可查（不等于「零死闸」）" }, empty, { dbPath });
  }

  const appTypeCounts = {};
  const scans = [];
  for (const r of rows) {
    const appType = r && r.app_type != null && String(r.app_type) !== "" ? String(r.app_type) : "(空)";
    appTypeCounts[appType] = (appTypeCounts[appType] || 0) + 1;
    const name = r && r.name != null && String(r.name).trim() ? String(r.name).trim() : "(无名)";
    const id = r && r.id != null ? String(r.id) : "(无 id)";
    const label = "provider/" + name + " [" + id + "]";
    const cfg = r ? r.settings_config : null;
    if (cfg != null && typeof cfg !== "string" && typeof cfg !== "object") {
      const s = { file: dbPath, label, layer: "provider", appType, gates: [], perms: [], census: 0,
        parsedUnits: 0, unparsedUnits: 1,
        notes: [label + "：settings_config 既不是字符串也不是对象（typeof=" + typeof cfg + "）⇒ 不可核验"] };
      scans.push(s);
      continue;
    }
    const raw = typeof cfg === "string" ? cfg : JSON.stringify(cfg == null ? {} : cfg);
    const s = scanConfigText(raw, label, dbPath + " › providers." + id, "provider");
    s.appType = appType;
    scans.push(s);
  }
  return { state: "ok", why: "", scans, total: rows.length, appTypeCounts, dbPath };
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

// providers 层追加在末尾（顺序有意义：`scans[0]` 恒为 live，下面的 live-unreadable 判据靠它）。
// 它与前两层**并进同一个 scans 数组**，而不是另起一套账：hooks= / 普查 / 下限断言三个数
// 都必须把这一层算进去，否则「零死闸」仍旧只覆盖两层，而末行看不出这件事。
const providerScan = await scanProviders();
for (const s of providerScan.scans) scans.push(s);

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
// 三态优先级：红（1）> 没查成（2）> 通过（0）。
// **`uncheckable` 不许把 `dead>0` 盖掉**——真发现永远比「有一层没查成」更该被看见；
// 反过来 `dead=0 && uncheckable` 也不许落成 0，那句「零死闸」的射程比读者以为的小一层。
// `off` 刻意不进退出码：它是操作者显式选的扫描范围（如本仓 fixture 测试只测前两层），
// 而它仍在末行 `providerscan=off` 里可见 —— 「显式缩面」与「环境没给成」是两种病。
const exitCode = (dead.length > 0 || !selfOk) ? 1 : (providerScan.state === "uncheckable" ? 2 : 0);

// ── 输出 ────────────────────────────────────────────────────────────────────
function summaryLine() {
  return "DEAD_GATES_SUMMARY exit=" + exitCode +
    " hooks=" + structTotal +
    " dead=" + dead.length +
    " orphan=" + orphans.length +
    " selfcheck=" + (selfOk ? "ok" : "fail") +
    " unverifiable=" + unverifiable.length +
    " providers=" + providerScan.scans.length +
    " providerscan=" + providerScan.state;
}

if (AS_JSON) {
  out(JSON.stringify({
    exit: exitCode,
    providerScan: { state: providerScan.state, why: providerScan.why, dbPath: providerScan.dbPath,
      total: providerScan.total, appTypeCounts: providerScan.appTypeCounts },
    scans: scans.map((s) => ({ file: s.file, label: s.label, layer: s.layer, gates: s.gates.length, census: s.census, parsedUnits: s.parsedUnits, unparsedUnits: s.unparsedUnits, notes: s.notes })),
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
function printScanLine(s, indent) {
  out(indent + s.label.padEnd(24) + " 闸 " + String(s.gates.length).padStart(3) +
      " · 普查 " + String(s.census).padStart(3) +
      " · 可解析单元 " + s.parsedUnits + (s.unparsedUnits ? "（另 " + s.unparsedUnits + " 个非 JSON 单元）" : "") +
      "  " + s.file);
  for (const n of s.notes) out(indent + "    ⚠ " + n);
}
const quiet = [];
for (const s of scans) {
  if (s.layer === "provider") continue;   // providers 层另起一节打，见下
  if (s.gates.length === 0 && s.census === 0 && s.notes.length === 0) { quiet.push(s.label); continue; }
  printScanLine(s, "  ");
}
if (quiet.length) out("  （另 " + quiet.length + " 份零闸零普查：" + quiet.join("、") + "）");
if (snapDirErr) out("  ✗ 快照目录读不了：" + SNAPSHOT_DIR + "（" + snapDirErr + "）");

// ── providers 层（真正的下发源）──────────────────────────────────────────────
out("");
if (providerScan.state === "off") {
  out("  ⊘ providers 层：被 --no-providers 显式关掉（**不是「查过了没事」**，本次只扫了 live+快照两层）");
} else if (providerScan.state === "uncheckable") {
  out("  ⚠ providers 层：**本次没查成**（不等于零死闸；真正的下发源就是这一层）");
  out("      DB   ：" + (providerScan.dbPath || "(未解析出路径)"));
  out("      原因 ：" + providerScan.why);
} else {
  const dist = Object.keys(providerScan.appTypeCounts).sort()
    .map((k) => k + "=" + providerScan.appTypeCounts[k]).join(" · ");
  out("  providers 层：cc-switch DB 共 " + providerScan.total + " 行 —— " + (dist || "(空)") +
      "  [-readonly 打开]");
  out("      " + providerScan.dbPath);
  const pQuiet = [];
  for (const s of providerScan.scans) {
    if (s.gates.length === 0 && s.census === 0 && s.notes.length === 0) { pQuiet.push(s.label.replace(/^provider\//, "").replace(/\s*\[.*$/, "")); continue; }
    printScanLine(s, "    ");
  }
  // 零闸的行同样点名（只是并成一行）：**范围没被收窄**这件事必须看得见 ——
  // 本层刻意不按 app_type 划范围，若哪天有人加了个过滤，这一行的行数会立刻对不上。
  if (pQuiet.length) out("      （另 " + pQuiet.length + " 行零闸零普查：" + pQuiet.join("、") + "）");
}

out("");
if (dead.length === 0) {
  // 「零死闸」这句话的射程必须跟着实际扫过的层数走，否则它就是本脚本要治的那句空话。
  const covered = providerScan.state === "ok" ? "live + 快照 + providers 三层" : "live + 快照两层";
  const caveat = providerScan.state === "ok" ? ""
    : "；**providers 层" + (providerScan.state === "off" ? "被显式关掉" : "没查成") + "，这一句不覆盖它**";
  out("✓ 死闸：0（" + covered + "，存在性 + 语法可载两道都过" + caveat + "）");
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
    " · 无法核验 " + unverifiable.length + " · 孤儿 " + orphans.length + " · 自检 " + (selfOk ? "ok" : "fail") +
    " · providers " + (providerScan.state === "ok" ? providerScan.scans.length + " 行" : providerScan.state));
out(summaryLine());
process.exit(exitCode);
