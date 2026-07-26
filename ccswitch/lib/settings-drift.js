// settings-drift.js — live ↔ 快照 配置漂移检测器（库 + CLI 双模）
//
// ── 治的是什么病 ─────────────────────────────────────────────────────────────
// `~/.claude/settings.json` 是**投影**，不是源。真源是 cc-switch SQLite DB：
//
//   cc-switch DB  ← 唯一的源
//     │  config-sync/lib/export.mjs   selectRows('settings', "WHERE key LIKE 'common_config_%'")
//     ├──────→ config-sync/common/settings.json（git 快照）
//     │  config-sync/lib/restore.mjs  upsertStatements('settings', rows)
//     └──── restore 写回 DB ──→ 再由 cc-switch 投影到 ~/.claude/settings.json
//
// 直接改 live 文件「立即生效但不持久」——下次 cc-switch 下发就覆盖掉；
// 上行同步也救不了，因为 export 只从 DB 读、看不见 live 文件。
// 2026-07-26 实证：注册 dao-rule-echo hook 时先手改了 live，若不是恰好去查数据流，
// 这笔债会一直挂到某次 restore 把 hook 静默抹掉。**当时没有任何机制能发现它。**
//
// ── 与既有检查的分工（不重复造轮子）─────────────────────────────────────────
// · dao-config-guard.js（SessionStart）：查 DB → live 的**单向缺字段**（live 少了什么）。
//   它查不出反向（live 多出的、源里没有的），而反向正是本检测器要治的那笔债。
// · dao-scaffold-check.js 的「Hook 未注册」：查 hook **文件**是否被 settings 提及，
//   只看 live 一侧，不看快照，也不看方向。
// · 本文件：live ↔ git 快照 双向比对 + 方向判定，可选 `--db` 三方。
//   hook 面比三样：**是否都有**（basename 身份）· **挂载点/timeout** · **归一化命令串**。
//   最后一项是 fortify2-20260726 刀F F3 补的：原先只比 basename，于是「同名但路径被改回
//   旧值」静默通过（dao-timecode 实证：live/快照指仓库路径、DB 仍指已被删除的
//   ~/.claude/hooks 副本，三项旧判据全同 ⇒ 零发现）。判据与其近似性见 normCommand 头注。
//
// ── 不造第七种载体 ───────────────────────────────────────────────────────────
// 产出是「检测脚本 + 接入既有入口」，不落任何 git 追踪的状态文件。
// 运行痕迹只写 `_tmp/settings-drift/`（已 gitignore，与 dao-rule-echo 同惯例）。
//
// ── 谁来检查这个检查器（自指）───────────────────────────────────────────────
// 判据**不用「文件是否存在」**（那是三例 55 天零生效事故的共同死法）。三层：
//   ① 运行时功能探针 runSelfProbe()：拿一对内存 fixture、故意注入已知漂移，
//      断言「正例被检出且方向正确 / 负例零误报 / 噪音不误伤」。
//      比对逻辑若哪天被改瞎（如 dao 归属判据放宽到永不命中 ⇒ 永久报绿），探针立刻变红。
//      这正是 check-core-loc 被 `-Last 60` 截断致盲 5 天那类事故的对治：
//      光「跑了」不够，要断言「已知阳性仍被检出」。
//   ② 真实调用心跳（synthetic 标记）：只有真被 SessionStart 调用过才写得出非 synthetic 记录，
//      `--selfcheck` 只采信非 synthetic 并报陈旧天数。自测心跳不予采信，防自我染绿。
//   ③ 接线静态核对（**明说是弱判据**）：dao-scaffold-check.js 源码里是否有调用点、
//      它自己在 live settings 里是否注册。它证不了「调用点可达」——只有 ② 能证。
// 残余盲区在 `--selfcheck` 输出末尾与 PR 说明中如实列出，不声称已闭环。
//
// 真相源：windsurf-dao/ccswitch/lib/settings-drift.js
// 调用方：ccswitch/hooks/dao-scaffold-check.js（SessionStart，进程内 require，零新增注册）
// 自证：node tests/settings-drift.tests.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", ".."); // 本文件在 <root>/ccswitch/lib/
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();

const LIVE_SETTINGS = path.join(HOME, ".claude", "settings.json");
const SNAPSHOT_SETTINGS = path.join(ROOT, "config-sync", "common", "settings.json");
const PATHS_MJS = path.join(ROOT, "config-sync", "lib", "paths.mjs");
const SECRETS_MJS = path.join(ROOT, "config-sync", "lib", "secrets.mjs");
const RULE_ECHO_HOOK = path.join(ROOT, "ccswitch", "hooks", "dao-rule-echo.js");
const SCAFFOLD_HOOK = path.join(ROOT, "ccswitch", "hooks", "dao-scaffold-check.js");

// 运行痕迹目录。测试用 DAO_SETTINGS_DRIFT_STATE_DIR 改写，免得自测心跳污染生产判定
// ——「自测把自己染绿」正是本检测器要防的病，测试自己更不能犯。
function stateDir() { return process.env.DAO_SETTINGS_DRIFT_STATE_DIR || path.join(ROOT, "_tmp", "settings-drift"); }
function lastJsonPath() { return path.join(stateDir(), "last.json"); }
function firedLogPath() { return path.join(stateDir(), "fired.log"); }
function errorLogPath() { return path.join(stateDir(), "errors.log"); }
const FIRED_LOG_MAX_LINES = 2000;

// 探针最少断言条数。若哪天有人把探针清空/注释光，failed.length===0 会「真空为真」地报绿
// ——那正是 check-core-loc 被 `-Last 60` 截断致盲的同一形状（信号被削成空，却仍判通过）。
// 取值＝当前实际断言条数：任何**删除**都会跌破而变红；新增断言不受影响（count > floor）。
// F3 补入 3 条（同名不同路径正例 ×2 + 写法差异负例 ×1）后由 8 抬到 11。
const MIN_PROBE_CHECKS = 11;

// 软预算：超了就降级并把降级本身报出来（不静默截断 —— check-core-loc 的死法）
const DEADLINE_MS = 1500;
const RULE_ECHO_TIMEOUT_MS = 4000;
const MAX_HOOK_LINES = 6;

// ── 占位符 / 脱敏常量（与 config-sync 对齐，见下方 verifyContractLiterals 守卫）────
// 用普通字符串拼接，避免被 JS 模板串当插值吃掉。
const PH_PROJECT = "$" + "{PROJECT_ROOT}";
const PH_HOME = "$" + "{HOME}";
const SECRET_PLACEHOLDER = "__CONFIG_SYNC_SECRET__";

// 快照里的路径是占位符化的；这里做同构还原后再比。
function decodePaths(text) {
  return String(text)
    .split(PH_PROJECT).join(ROOT.replace(/\\/g, "/"))
    .split(PH_HOME).join(HOME.replace(/\\/g, "/"));
}

// 本文件复制了 config-sync 的占位符/脱敏字面量。方案一变，这份复制就悄悄过期
// ⇒ 读源文件核对字面量还在，不在就报「契约漂移」，不静默沿用旧假设。
function verifyContractLiterals() {
  const notes = [];
  try {
    const t = fs.readFileSync(PATHS_MJS, "utf8");
    if (!t.includes(PH_PROJECT) || !t.includes(PH_HOME)) {
      notes.push(`占位符方案可能已变更：${path.relative(ROOT, PATHS_MJS)} 里找不到 ${PH_PROJECT} / ${PH_HOME} 字面量，本检测器的还原逻辑可能已过期`);
    }
  } catch (e) {
    notes.push(`无法核对占位符契约（${path.relative(ROOT, PATHS_MJS)}）：${e.message}`);
  }
  try {
    const t = fs.readFileSync(SECRETS_MJS, "utf8");
    if (!t.includes(SECRET_PLACEHOLDER)) {
      notes.push(`脱敏占位符可能已变更：${path.relative(ROOT, SECRETS_MJS)} 里找不到 ${SECRET_PLACEHOLDER}`);
    }
  } catch (e) {
    notes.push(`无法核对脱敏契约（${path.relative(ROOT, SECRETS_MJS)}）：${e.message}`);
  }
  return notes;
}

// ── 比对面判据 ──────────────────────────────────────────────────────────────

// 命令串 → dao 自有脚本文件名；非 dao 命令（Coffee CLI 之类第三方写入）返回 null。
// 只取 basename ⇒ 天然免疫路径占位符化与正反斜杠差异。
// **注意**：basename 是「这两侧说的是不是同一个 hook」的身份判据，不是「它们内容相同」的
// 判据。后者由下面的 normCommand 负责——两者分工别混（混淆的后果见 normCommand 头注）。
function daoScriptOf(command) {
  if (command == null) return null;
  const s = String(command).replace(/\\/g, "/");
  const m = s.match(/[A-Za-z0-9_.-]+\.(?:js|mjs|cjs|ps1)/g);
  if (!m) return null;
  const base = m[m.length - 1];
  const daoish = /ccswitch\//i.test(s) || /\.claude\/hooks\//i.test(s) || /^dao-/i.test(base);
  return daoish ? base : null;
}

// ── 命令串全等判据（fortify2-20260726 刀F F3）─────────────────────────────────
// 治的病：此前 hook 比对**只看 basename**，于是「同名但路径被改回旧值」这类回归静默通过。
// 实证形态：刀D 把 dao-timecode 的注册从 `~/.claude/hooks/` 副本改为仓库路径（副本层已被
// 整体删除），而 DB 里仍是旧路径。两侧 basename 都是 dao-timecode.js、挂载点与 timeout 也
// 都一样 ⇒ 检测器零发现。此时若有人跑同步，旧路径会覆盖过来，hook 指向一个**已不存在的
// 文件** —— 静默死层，且本检测器看不见。
//
// 归一化要抹掉的是「同一件事的不同写法」，共四类，每类都在 runSelfProbe 里有负例钉着：
//   ① 占位符 vs 展开态（${PROJECT_ROOT}/${HOME}）—— 快照侧必然占位符化
//   ② 正反斜杠混用 —— DB 里实测存在 `C:/Users/Administrator\.claude\hooks\x.js` 这种混写
//   ③ 引号有无 —— `node "X"` 与 `node X` 指向同一文件
//   ④ 多余空白 / 重复斜杠
//
// ── 近似说明（两个方向都构造得出反例，勿当判定）──────────────────────────────
// · 归一化里的 `toLowerCase()` 是为 Windows 路径大小写不敏感而设，代价是**参数的大小写
//   差异也一并被抹掉**（`--Flag` vs `--flag` 不会被报出）。dao hook 现有参数均为小写，
//   故当下无损；将来若有大小写敏感的参数，这里会漏。
// · 去引号同理：一个**确实需要引号**的含空格路径若丢了引号，运行时会坏，但本判据看不出来。
// · 反方向：宿主/cc-switch 若哪天改变命令串的生成形态（换 node 绝对路径、加 --flag），
//   会被报成漂移——那是真差异，但可能属预期变更，需人判后同步两侧，不是误报。
// 结论：本判据抓的是「同名不同串」这一类回归，不声称覆盖全部命令串等价性判定。
function normCommand(command) {
  if (command == null) return null;
  let s = decodePaths(String(command));
  s = s.replace(/\\/g, "/");        // ② 分隔符
  s = s.replace(/"/g, "");          // ③ 引号
  s = s.replace(/\s+/g, " ").trim(); // ④ 空白
  s = s.replace(/\/{2,}/g, "/");     // ④ 重复斜杠
  return s.toLowerCase();
}

// 命令串 → 该 dao 脚本的解析后完整路径。只为让报文能说「差在路径」而不是笼统说
// 「命令串不同」——路径差异是会导致 hook 指向不存在文件的那一种，值得单独点名。
function scriptPathOf(command) {
  if (command == null) return null;
  const s = decodePaths(String(command)).replace(/\\/g, "/");
  // 优先取引号内整段：Windows 路径可能含空格，引号是唯一可靠的边界
  const quoted = s.match(/"([^"]*\.(?:js|mjs|cjs|ps1))"/i);
  const raw = quoted ? quoted[1] : (s.match(/\S*\.(?:js|mjs|cjs|ps1)/i) || [null])[0];
  return raw == null ? null : raw.replace(/\/{2,}/g, "/").toLowerCase();
}

// provider 运行态 env 键：cc-switch 切供应商时会往 live 写，且值在快照里被脱敏 ⇒ 不比对。
const SECRETISH_KEY = /(api[_-]?key|auth[_-]?token|access[_-]?token|secret|password|passwd|bearer|^token$|\.token$)/i;
const PROVIDER_RUNTIME_ENV = /^(ANTHROPIC_(BASE_URL|CUSTOM_HEADERS|MODEL)|CLAUDE_CODE_)/i;
function isVolatileEnvKey(k) {
  return SECRETISH_KEY.test(k) || PROVIDER_RUNTIME_ENV.test(k);
}

// 宿主会话内可改（/model、/config、主题切换等）⇒ 差异不算债，只在 CLI 里列，不进提醒。
const RUNTIME_KEYS = new Set([
  "model", "theme", "effortLevel", "outputStyle", "tui",
  "voice", "voiceEnabled", "showThinkingSummaries", "remoteControlAtStartup",
  "enabledPlugins", "alwaysThinkingEnabled", "autoUpdates", "feedbackSurveyState",
  "todoFeatureEnabled", "messageIdleNotifThresholdMs",
]);
const HANDLED_TOP_KEYS = new Set(["hooks", "permissions", "env", "statusLine"]);

function toSet(arr) {
  return new Set((Array.isArray(arr) ? arr : []).map((x) => String(x)));
}
function normDir(p) {
  return decodePaths(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
}
function stable(v) { return JSON.stringify(sortDeep(v)); }
function short(v, n) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s == null) return "null";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// hooks 面：script → 该脚本出现过的 "event|matcher" 集合 + timeout + 归一化命令串 + 脚本路径
function hookIndex(obj) {
  const idx = new Map();
  const hooks = obj && obj.hooks && typeof obj.hooks === "object" ? obj.hooks : {};
  for (const event of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    for (const g of groups) {
      const matcher = g && g.matcher != null && String(g.matcher) !== "" ? String(g.matcher) : "*";
      const entries = g && Array.isArray(g.hooks) ? g.hooks : [];
      for (const h of entries) {
        if (!h || h.type !== "command") continue;
        const script = daoScriptOf(h.command);
        if (!script) continue;
        if (!idx.has(script)) idx.set(script, { mounts: new Set(), timeouts: new Set(), cmds: new Set(), paths: new Set() });
        const rec = idx.get(script);
        rec.mounts.add(`${event}|${matcher}`);
        rec.timeouts.add(h.timeout == null ? "(无)" : String(h.timeout));
        rec.cmds.add(normCommand(h.command));
        const p = scriptPathOf(h.command);
        if (p) rec.paths.add(p);
      }
    }
  }
  return idx;
}

function setDiff(a, b) { return [...a].filter((x) => !b.has(x)); }

/**
 * 纯函数比对。live / snap 均为已解析的 settings 对象（snap 为快照里 common_config_claude 的 value）。
 * 返回 findings 数组：{ tier:'hard'|'soft', face, kind, id, detail }
 *   kind: LIVE_ONLY   ⬆ live 有 / 对侧无 —— 改了投影没进源，下次下发会静默抹掉
 *         SNAP_ONLY   ⬇ 对侧有 / live 无 —— 源已更新但投影没跟上（restore/下发未跑）
 *         VALUE_DIFF  ⚙ 两侧都有但内容不同 —— 方向不定，需人判
 */
function compare(live, snap, opts) {
  const o = opts || {};
  const otherLabel = o.otherLabel || "快照";
  const findings = [];
  const add = (tier, face, kind, id, detail) => findings.push({ tier, face, kind, id, detail });

  // ── Face A · dao 自有 hook 注册面（硬）──────────────────────────────────
  const L = hookIndex(live);
  const S = hookIndex(snap);
  for (const script of L.keys()) {
    if (!S.has(script)) {
      add("hard", "hooks", "LIVE_ONLY", `hook:${script}`,
        `live 已注册 ${script}（${[...L.get(script).mounts].join(", ")}），${otherLabel}里没有`);
    }
  }
  for (const script of S.keys()) {
    if (!L.has(script)) {
      add("hard", "hooks", "SNAP_ONLY", `hook:${script}`,
        `${otherLabel}有 ${script}（${[...S.get(script).mounts].join(", ")}），live 未注册`);
    }
  }
  for (const script of L.keys()) {
    if (!S.has(script)) continue;
    const lm = L.get(script).mounts, sm = S.get(script).mounts;
    if (stable([...lm].sort()) !== stable([...sm].sort())) {
      add("hard", "hooks", "VALUE_DIFF", `hook:${script}`,
        `${script} 挂载点不一致：live=[${[...lm].join(", ")}] ${otherLabel}=[${[...sm].join(", ")}]`);
    }
    // 命令串全等（F3）：basename 相同不代表内容相同。同名不同路径会让 hook 指向不存在的
    // 文件而本检测器此前完全看不见（dao-timecode 实证），故列**硬**发现。
    const lc = L.get(script).cmds, sc = S.get(script).cmds;
    if (stable([...lc].sort()) !== stable([...sc].sort())) {
      const lp = L.get(script).paths, sp = S.get(script).paths;
      const pathDiffers = stable([...lp].sort()) !== stable([...sp].sort());
      add("hard", "hooks", "VALUE_DIFF", `hook-cmd:${script}`,
        pathDiffers
          // 这一支是「静默死层」形态：同名不同路径，旧路径可能已不存在
          ? `${script} **脚本路径**不一致（同名不同路径，basename 判据看不出）：` +
            `live=[${[...lp].join(", ")}] ${otherLabel}=[${[...sp].join(", ")}]` +
            `。若指向已删除的旧位置，同步过去即成静默死 hook —— 请先确认哪一侧是现行真相再对齐`
          : `${script} 命令串不一致（脚本路径相同，差异在调用形态/参数）：` +
            `live=[${[...lc].join(" ; ")}] ${otherLabel}=[${[...sc].join(" ; ")}]`);
    }
    const lt = L.get(script).timeouts, st = S.get(script).timeouts;
    if (stable([...lt].sort()) !== stable([...st].sort())) {
      add("soft", "hooks", "VALUE_DIFF", `hook-timeout:${script}`,
        `${script} timeout 不一致：live=[${[...lt].join(", ")}] ${otherLabel}=[${[...st].join(", ")}]`);
    }
  }

  // ── Face B · dao 承重字面键（硬）────────────────────────────────────────
  // 选入判据：cc-switch DB 托管 + 不含密钥（不受脱敏影响）+ 宿主 UI 不会自动改写。
  const scalarFaces = [
    ["statusLine.command", (x) => {
      const c = x && x.statusLine ? x.statusLine.command : null;
      return c == null ? null : (daoScriptOf(c) || decodePaths(c)); // dao 脚本取 basename，免疫路径形态
    }],
    ["permissions.defaultMode", (x) => (x && x.permissions ? x.permissions.defaultMode : undefined) ?? null],
  ];
  for (const [id, get] of scalarFaces) {
    const lv = get(live), sv = get(snap);
    if (lv === sv) continue;
    if (lv != null && sv == null) add("hard", "keys", "LIVE_ONLY", id, `${id}：live="${short(lv, 80)}"，${otherLabel}缺`);
    else if (lv == null && sv != null) add("hard", "keys", "SNAP_ONLY", id, `${id}：${otherLabel}="${short(sv, 80)}"，live 缺`);
    else add("hard", "keys", "VALUE_DIFF", id, `${id}：live="${short(lv, 60)}" ≠ ${otherLabel}="${short(sv, 60)}"`);
  }

  const setFaces = [
    // deny 是 Grep-first 铁律的落地面，少一条就是安全回退；且没有任何运行时写入者会往 deny 追加。
    ["permissions.deny", (x) => toSet(x && x.permissions ? x.permissions.deny : []), "hard"],
    ["permissions.additionalDirectories",
      (x) => toSet(((x && x.permissions ? x.permissions.additionalDirectories : []) || []).map(normDir)), "hard"],
    // env 只比键集：值可能是 provider 运行态密钥，且快照侧已脱敏。
    ["env(键集)", (x) => toSet(Object.keys((x && x.env) || {}).filter((k) => !isVolatileEnvKey(k))), "hard"],
    // allow 会被宿主「always allow」自动追加 ⇒ 高频抖动，降为软报，免得把检查器变成噪音源被人删掉。
    ["permissions.allow", (x) => toSet(x && x.permissions ? x.permissions.allow : []), "soft"],
  ];
  for (const [id, get, tier] of setFaces) {
    const ls = get(live), ss = get(snap);
    const onlyL = setDiff(ls, ss), onlyS = setDiff(ss, ls);
    if (onlyL.length) add(tier, "keys", "LIVE_ONLY", id, `${id}：live 多出 ${onlyL.length} 项 [${short(onlyL.join(", "), 120)}]`);
    if (onlyS.length) add(tier, "keys", "SNAP_ONLY", id, `${id}：${otherLabel}多出 ${onlyS.length} 项 [${short(onlyS.join(", "), 120)}]`);
  }

  // ── Face C · 其余顶层键（软，只在 CLI 可见，永不进提醒）────────────────
  const keys = new Set([...Object.keys(live || {}), ...Object.keys(snap || {})]);
  for (const k of keys) {
    if (HANDLED_TOP_KEYS.has(k)) continue;
    const lv = live ? live[k] : undefined;
    const sv = snap ? snap[k] : undefined;
    const lvs = lv === undefined ? undefined : stable(lv);
    const svs = sv === undefined ? undefined : stable(sv);
    if (lvs === svs) continue;
    const face = RUNTIME_KEYS.has(k) ? "runtime" : "unclassified";
    const kind = lvs !== undefined && svs === undefined ? "LIVE_ONLY"
      : lvs === undefined && svs !== undefined ? "SNAP_ONLY" : "VALUE_DIFF";
    add("soft", face, kind, k,
      `${k}：live=${short(lv === undefined ? "(缺)" : lv, 60)} / ${otherLabel}=${short(sv === undefined ? "(缺)" : sv, 60)}`);
  }

  return findings;
}

// ── 运行时功能探针：已知阳性必被检出、已知阴性必零报 ────────────────────────
// 纯内存、无 I/O，~0.1ms。它是本检测器**不用「文件存在」当判据**的核心。
function fixtureBase() {
  return {
    hooks: {
      SessionStart: [{
        matcher: "startup",
        hooks: [{ type: "command", command: 'node "' + PH_PROJECT + '/ccswitch/hooks/dao-probe-alpha.js"', timeout: 5 }],
      }],
    },
    permissions: { deny: ["Bash(grep:*)"], allow: ["Read"], defaultMode: "default", additionalDirectories: [PH_HOME + "\\.claude"] },
    statusLine: { type: "command", command: "node " + PH_PROJECT + "/ccswitch/statusline.js" },
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "x" },
  };
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function hardOf(f) { return f.filter((x) => x.tier === "hard"); }

function runSelfProbe() {
  const checks = [];
  const t = (name, cond, detail) => checks.push({ name, ok: !!cond, detail: cond ? "" : detail || "" });

  // 负例 1：两侧同构（含占位符 vs 还原态）⇒ 零硬报
  {
    const live = clone(fixtureBase());
    live.hooks.SessionStart[0].hooks[0].command = 'node "' + ROOT.replace(/\\/g, "/") + '/ccswitch/hooks/dao-probe-alpha.js"';
    live.statusLine.command = "node " + ROOT.replace(/\\/g, "/") + "/ccswitch/statusline.js";
    live.permissions.additionalDirectories = [HOME.replace(/\\/g, "/") + "\\.claude"];
    const f = hardOf(compare(live, fixtureBase()));
    t("负例·同构两侧零硬报", f.length === 0, "误报 " + f.length + " 条：" + f.map((x) => x.id).join(","));
  }
  // 负例 2：live 多出**非 dao** 的 exe 命令（Coffee CLI 之类第三方写入）⇒ 不许误伤
  {
    const live = clone(fixtureBase());
    live.hooks.PreToolUse = [{ matcher: "*", hooks: [{ type: "command", command: '"C:/Program Files/Third/party.exe" __hook' }] }];
    const f = hardOf(compare(live, fixtureBase())).filter((x) => x.face === "hooks");
    t("负例·第三方 exe 命令不误伤", f.length === 0, "误报：" + f.map((x) => x.detail).join(" | "));
  }
  // 负例 3：live 多出**非 dao 的 .js** hook —— 别的工具也会往 live 注册 node 脚本。
  // 它不归 cc-switch 托管，快照里本就不该有；若误报就会永久唠叨，检查器随即被人删掉。
  // （此例专门守 daoScriptOf 的归属判据：上面的 .exe 例子由扩展名兜住，守不到归属判据。
  //   实证：mutation 把归属判据改成恒真时，只有本例变红。）
  {
    const live = clone(fixtureBase());
    live.hooks.PreToolUse = [{ matcher: "*", hooks: [{ type: "command", command: 'node "C:/Program Files/OtherTool/their-hook.js"', timeout: 5 }] }];
    const f = hardOf(compare(live, fixtureBase())).filter((x) => x.face === "hooks");
    t("负例·第三方非 dao 的 .js hook 不误伤", f.length === 0, "误报：" + f.map((x) => x.detail).join(" | "));
  }
  // 负例 3：运行态键（model/theme）差异不许进硬报
  {
    const live = clone(fixtureBase()); live.model = "opus[1m]"; live.theme = "custom:dao-dark";
    const snap = clone(fixtureBase()); snap.model = "claude-fable-5[1m]";
    t("负例·运行态键不进硬报", hardOf(compare(live, snap)).length === 0);
  }
  // 正例 1：live 多注册一个 dao hook（今日那笔债的形状）⇒ LIVE_ONLY
  {
    const live = clone(fixtureBase());
    live.hooks.PostToolUse = [{ matcher: "Edit|Write", hooks: [{ type: "command", command: 'node "' + PH_PROJECT + '/ccswitch/hooks/dao-probe-beta.js"', timeout: 10 }] }];
    const f = compare(live, fixtureBase());
    t("正例·live 独有 dao hook → LIVE_ONLY",
      f.some((x) => x.tier === "hard" && x.kind === "LIVE_ONLY" && x.id === "hook:dao-probe-beta.js"),
      "实得：" + JSON.stringify(f.map((x) => x.kind + ":" + x.id)));
  }
  // 正例 2：快照多一个 dao hook（restore 没跑）⇒ SNAP_ONLY，且方向不能与正例 1 混淆
  {
    const snap = clone(fixtureBase());
    snap.hooks.Stop = [{ hooks: [{ type: "command", command: 'node "' + PH_HOME + '/.claude/hooks/dao-probe-gamma.js"', timeout: 5 }] }];
    const f = compare(fixtureBase(), snap);
    t("正例·快照独有 dao hook → SNAP_ONLY",
      f.some((x) => x.tier === "hard" && x.kind === "SNAP_ONLY" && x.id === "hook:dao-probe-gamma.js"),
      "实得：" + JSON.stringify(f.map((x) => x.kind + ":" + x.id)));
  }
  // 正例 3：live 的 deny 少一条（Grep-first 护栏被摘）⇒ SNAP_ONLY
  {
    const live = clone(fixtureBase()); live.permissions.deny = [];
    t("正例·deny 缺项 → SNAP_ONLY",
      compare(live, fixtureBase()).some((x) => x.tier === "hard" && x.kind === "SNAP_ONLY" && x.id === "permissions.deny"));
  }
  // 正例 4：同一 hook 挂载点变了（matcher 漂移）⇒ VALUE_DIFF
  {
    const live = clone(fixtureBase()); live.hooks.SessionStart[0].matcher = "resume";
    t("正例·挂载点漂移 → VALUE_DIFF",
      compare(live, fixtureBase()).some((x) => x.tier === "hard" && x.kind === "VALUE_DIFF" && x.id === "hook:dao-probe-alpha.js"));
  }
  // 正例 5（F3 核心）：同名**不同路径** ⇒ 必须报出。这是 basename 判据的原盲区：
  // 挂载点、timeout、basename 三者全同，只有路径不同（dao-timecode 实证形态）。
  {
    const live = clone(fixtureBase());
    live.hooks.SessionStart[0].hooks[0].command = 'node "' + PH_HOME + '/.claude/hooks/dao-probe-alpha.js"';
    const f = compare(live, fixtureBase());
    t("正例·同名不同路径 → hook-cmd VALUE_DIFF（F3 原盲区）",
      f.some((x) => x.tier === "hard" && x.kind === "VALUE_DIFF" && x.id === "hook-cmd:dao-probe-alpha.js"),
      "实得：" + JSON.stringify(f.map((x) => x.kind + ":" + x.id)));
    t("正例·同名不同路径 → 报文点名「脚本路径」而非笼统说命令串不同",
      f.some((x) => x.id === "hook-cmd:dao-probe-alpha.js" && /脚本路径/.test(x.detail)),
      "实得 detail：" + JSON.stringify(f.filter((x) => x.id === "hook-cmd:dao-probe-alpha.js").map((x) => x.detail)));
  }
  // 负例 5：仅引号 / 分隔符 / 大小写写法不同（同一文件的不同写法）⇒ 不许报。
  // 少了这条，归一化一旦被削弱，检测器会对每个 hook 永久唠叨，随即被人删掉。
  {
    const live = clone(fixtureBase());
    live.hooks.SessionStart[0].hooks[0].command =
      "node " + ROOT.replace(/\//g, "\\") + "\\ccswitch\\hooks\\dao-probe-alpha.js"; // 无引号 + 反斜杠
    live.statusLine.command = "node " + ROOT.replace(/\\/g, "/") + "/ccswitch/statusline.js";
    live.permissions.additionalDirectories = [HOME.replace(/\\/g, "/") + "\\.claude"];
    const f = hardOf(compare(live, fixtureBase())).filter((x) => x.face === "hooks");
    t("负例·仅引号/分隔符写法不同 → 零硬报（归一化生效）",
      f.length === 0, "误报：" + f.map((x) => x.detail).join(" | "));
  }

  const failed = checks.filter((c) => !c.ok);
  // 真空守卫：断言条数被削到阈值以下 ⇒ 判失败，不许「没有失败」等于「通过」。
  if (checks.length < MIN_PROBE_CHECKS) {
    failed.push({
      ok: false,
      name: "探针真空守卫",
      detail: `断言条数 ${checks.length} < 下限 ${MIN_PROBE_CHECKS}，探针本身已被削弱，不予采信`,
    });
  }
  return { ok: failed.length === 0, total: checks.length, failed, checks };
}

// ── 失败留痕：stderr + 磁盘日志 + 返回值，绝不静默吞 ─────────────────────────
function appendErrorLog(msg, err) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const stack = err && err.stack ? "\n" + err.stack : "";
    fs.appendFileSync(errorLogPath(), `[${new Date().toISOString()}] ${msg}${stack}\n`, "utf8");
  } catch (_) { /* 日志盘不可写也不能让主流程失声：错误仍在返回值与 stderr 里 */ }
}
function noteError(bag, stage, err) {
  const detail = err && err.message ? err.message : String(err);
  const msg = `[settings-drift] ${stage} 失败：${detail}`;
  try { process.stderr.write(msg + "\n"); } catch (_) {}
  appendErrorLog(msg, err);
  bag.push(msg);
}

// 自检用故障闸（测试与人工验证「出错不静默」）
function maybeForceError(stage) {
  const want = process.env.DAO_SETTINGS_DRIFT_FORCE_ERROR;
  if (want && (want === "1" || want === stage)) {
    throw new Error(`人为注入故障（DAO_SETTINGS_DRIFT_FORCE_ERROR=${want}）@${stage}`);
  }
}

function heartbeat(rec) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(lastJsonPath(), JSON.stringify(rec, null, 2), "utf8");
    fs.appendFileSync(firedLogPath(), JSON.stringify(rec) + "\n", "utf8");
    const lines = fs.readFileSync(firedLogPath(), "utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length > FIRED_LOG_MAX_LINES) {
      fs.writeFileSync(firedLogPath(), lines.slice(-Math.floor(FIRED_LOG_MAX_LINES / 2)).join("\n") + "\n", "utf8");
    }
  } catch (_) { /* 心跳写不动不该拖垮检测本身 */ }
}

function readJson(p) {
  const t = fs.readFileSync(p, "utf8");
  return JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
}

// 快照 → common_config_claude 的已解析对象
function loadSnapshotClaude(file) {
  const doc = readJson(file);
  const rows = Array.isArray(doc && doc.rows) ? doc.rows : [];
  const row = rows.find((r) => r && r.key === "common_config_claude");
  if (!row) throw new Error(`快照里没有 common_config_claude 行（${path.relative(ROOT, file)}，共 ${rows.length} 行）`);
  return JSON.parse(row.value);
}

// ── 主检测 ──────────────────────────────────────────────────────────────────
/**
 * @param {{real?:boolean, livePath?:string, snapshotPath?:string, skipRuleEcho?:boolean, skipHeartbeat?:boolean}} opts
 */
function detect(opts) {
  const o = opts || {};
  const t0 = Date.now();
  const errors = [];
  const degraded = [];
  let findings = [];
  let ruleEcho = null;

  // ① 功能探针先跑：逻辑本身瞎了的话，后面所有「零发现」都不可信
  let probe = { ok: false, total: 0, failed: [{ name: "probe 未执行", ok: false, detail: "" }], checks: [] };
  try { maybeForceError("probe"); probe = runSelfProbe(); }
  catch (e) { noteError(errors, "功能探针", e); }

  // ② 契约字面量守卫
  try { maybeForceError("contract"); for (const n of verifyContractLiterals()) degraded.push(n); }
  catch (e) { noteError(errors, "契约字面量核对", e); }

  // ③ live ↔ 快照 比对
  const livePath = o.livePath || LIVE_SETTINGS;
  const snapPath = o.snapshotPath || SNAPSHOT_SETTINGS;
  try {
    maybeForceError("load");
    const live = readJson(livePath);
    const snap = loadSnapshotClaude(snapPath);
    maybeForceError("compare");
    findings = compare(live, snap, { otherLabel: "快照" });
  } catch (e) {
    noteError(errors, `读取/比对 settings（live=${livePath} / snap=${snapPath}）`, e);
  }

  // ④ 顺带核 dao-rule-echo 的接线（它自己写过：「靠人记得跑等于没有」）
  if (!o.skipRuleEcho) {
    if (Date.now() - t0 > DEADLINE_MS) {
      degraded.push(`已超 ${DEADLINE_MS}ms 预算，跳过 dao-rule-echo --selfcheck（降级，非通过）`);
    } else {
      try {
        maybeForceError("ruleecho");
        const r = spawnSync(process.execPath, [RULE_ECHO_HOOK, "--selfcheck"], {
          input: "", encoding: "utf8", timeout: RULE_ECHO_TIMEOUT_MS, windowsHide: true,
        });
        if (r.error) throw r.error;
        if (r.status === null) {
          degraded.push(`dao-rule-echo --selfcheck 超时（>${RULE_ECHO_TIMEOUT_MS}ms）未出结论（降级，非通过）`);
        } else {
          ruleEcho = {
            code: r.status,
            lines: String(r.stdout || "").split(/\r?\n/).filter((l) => l.trim()).slice(1).map((l) => l.trim()),
            stderr: String(r.stderr || "").trim(),
          };
        }
      } catch (e) { noteError(errors, "dao-rule-echo --selfcheck", e); }
    }
  }

  const elapsedMs = Date.now() - t0;
  const synthetic = o.real !== true || process.env.DAO_SETTINGS_DRIFT_SELFTEST === "1";
  if (!o.skipHeartbeat) {
    heartbeat({
      at: new Date().toISOString(),
      synthetic,
      elapsedMs,
      probeOk: probe.ok,
      hard: hardOf(findings).length,
      soft: findings.length - hardOf(findings).length,
      ruleEchoCode: ruleEcho ? ruleEcho.code : null,
      errors: errors.length,
      degraded: degraded.length,
      cwd: String(o.cwd || ""),
    });
  }

  return { findings, hard: hardOf(findings), probe, ruleEcho, errors, degraded, elapsedMs, livePath, snapPath };
}

// ── 给 SessionStart hook 的短行输出（只报硬发现 / 探针失败 / 错误 / 降级）──────
function hookLines(opts) {
  let r;
  try { r = detect(opts); }
  catch (e) {
    // detect 内部已分阶段兜住；这里是最后一道，仍然不许静默
    const msg = e && e.message ? e.message : String(e);
    try { process.stderr.write(`[settings-drift] 顶层异常：${msg}\n`); } catch (_) {}
    appendErrorLog(`顶层异常：${msg}`, e);
    return [`✗ dao 配置漂移自检崩溃：${msg}（见 _tmp/settings-drift/errors.log）`];
  }

  const lines = [];
  if (!r.probe.ok) {
    lines.push(`✗ 配置漂移自检器**功能探针失败** ${r.probe.failed.length}/${r.probe.total}：` +
      r.probe.failed.map((f) => f.name).join("；") + " —— 此时「无漂移」不可信，先修检测器");
  }
  for (const e of r.errors) lines.push(`✗ ${e}`);
  for (const d of r.degraded) lines.push(`⚠ ${d}`);

  const up = r.hard.filter((f) => f.kind === "LIVE_ONLY");
  const down = r.hard.filter((f) => f.kind === "SNAP_ONLY");
  const diff = r.hard.filter((f) => f.kind === "VALUE_DIFF");
  if (up.length) {
    lines.push(`⬆ live settings 多出 ${up.length} 项、git 快照没有 —— 改了投影没进源，下次 cc-switch 下发/restore 会**静默抹掉**：` +
      up.slice(0, 3).map((f) => f.id).join("、") + (up.length > 3 ? ` …+${up.length - 3}` : "") +
      "。修法：确认 DB 里也有 → 跑 `node config-sync/lib/export.mjs --scope=settings` 落快照");
  }
  if (down.length) {
    lines.push(`⬇ git 快照有 ${down.length} 项、live settings 没有 —— 源已更新但投影没跟上（restore/下发未跑）：` +
      down.slice(0, 3).map((f) => f.id).join("、") + (down.length > 3 ? ` …+${down.length - 3}` : "") +
      "。修法：退出会话后跑 dao.bat 下行同步（不要手改 live）");
  }
  if (diff.length) {
    lines.push(`⚙ live 与快照 ${diff.length} 项内容不同（方向不定，需人判）：` + diff.slice(0, 3).map((f) => f.detail).join("；"));
  }
  if (r.ruleEcho && r.ruleEcho.code !== 0) {
    lines.push(`✗ dao-rule-echo 接线自检未过（exit ${r.ruleEcho.code}）：` + r.ruleEcho.lines.join(" / "));
  }

  if (lines.length > MAX_HOOK_LINES) {
    const extra = lines.length - MAX_HOOK_LINES;
    return lines.slice(0, MAX_HOOK_LINES).concat([`…另有 ${extra} 条，跑 \`node ccswitch/lib/settings-drift.js\` 看全量`]);
  }
  return lines;
}

// ── --selfcheck：谁来检查这个检查器 ─────────────────────────────────────────
function readFiredLog() {
  if (!fs.existsSync(firedLogPath())) return [];
  return fs.readFileSync(firedLogPath(), "utf8").split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

function selfcheck() {
  const out = [];
  let bad = 0;

  // ① 运行时功能探针（强判据：证明比对逻辑此刻仍能检出已知阳性）
  const probe = runSelfProbe();
  if (probe.ok) out.push(`✓ 功能探针 ${probe.total}/${probe.total} 通过（已知阳性仍被检出、已知阴性零误报）`);
  else { bad++; out.push(`✗ 功能探针 ${probe.total - probe.failed.length}/${probe.total}：` + probe.failed.map((f) => `${f.name}${f.detail ? "（" + f.detail + "）" : ""}`).join("；")); }

  // ② 真实调用心跳（强判据：只有真被 SessionStart 调过才写得出非 synthetic 记录）
  const all = readFiredLog();
  const real = all.filter((r) => r.synthetic !== true);
  if (!real.length) {
    bad++;
    out.push(`✗ 无真实调用记录（日志 ${all.length} 条，全部为自测/手工）—— 接线可能从未生效。日志：${firedLogPath()}`);
  } else {
    const last = real[real.length - 1];
    const days = (Date.now() - Date.parse(last.at)) / 86400000;
    out.push(`✓ 有真实调用记录：末次 ${last.at}（${days.toFixed(1)} 天前）· ${last.elapsedMs}ms · 硬发现 ${last.hard}；真实 ${real.length} 条 / 共 ${all.length} 条`);
    if (days > 7) { bad++; out.push(`  ⚠ 末次真实调用距今 ${days.toFixed(0)} 天，而 SessionStart 应每次进项目都触发 ⇒ 接线大概率已断`); }
  }

  // ③ 接线静态核对（**弱判据**，明说其局限）
  try {
    const src = fs.readFileSync(SCAFFOLD_HOOK, "utf8");
    const wired = /settings-drift/.test(src);
    out.push(`${wired ? "✓" : "✗"} dao-scaffold-check.js 源码${wired ? "含" : "不含"}本检测器调用点` +
      "（弱判据：证不了调用点可达/未被提前 return 跳过，可达性只由 ② 的心跳证明）");
    if (!wired) bad++;
  } catch (e) { bad++; out.push(`✗ 读取 dao-scaffold-check.js 失败：${e.message}`); }
  try {
    const raw = fs.readFileSync(LIVE_SETTINGS, "utf8");
    const reg = /dao-scaffold-check/.test(raw);
    out.push(`${reg ? "✓" : "✗"} 宿主 live settings ${reg ? "已" : "未"}注册 dao-scaffold-check（本检测器的唯一入口）`);
    if (!reg) bad++;
  } catch (e) { bad++; out.push(`✗ 读取 live settings 失败：${e.message}`); }

  out.push("");
  out.push("残余盲区（不声称闭环）：");
  out.push("  · 「真实调用」判据是 payload 形状（hook_event_name + transcript_path），可被刻意伪造的 payload 骗过；");
  out.push("    它挡的是「顺手自测把自己染绿」，挡不住蓄意造假。");
  out.push("  · ③ 是静态判据，只有 ② 的非 synthetic 心跳能证明「真的被调用过」；而读 ② 的人是本命令，");
  out.push("    本命令由人手动触发（/dao-verify）⇒ 第三阶「谁记得跑 --selfcheck」未闭环。");
  out.push("  · 心跳只证明「跑过」，证明不了注入的提醒真被宿主投递给了模型/用户。");
  out.push("  · 比对面是白名单（hooks / statusLine / permissions.deny / additionalDirectories / env 键集）；");
  out.push("    白名单外的键只在本命令的软区可见，不触发 SessionStart 提醒。");
  out.push("  · hook 命令串比对（F3）走归一化后全等：占位符/分隔符/引号/空白/大小写差异被有意抹掉。");
  out.push("    代价是**参数**的大小写差异、以及「确实需要的引号丢了」这两类真差异看不出来（见 normCommand 头注）。");
  out.push("  · 只覆盖 common_config_claude ↔ ~/.claude/settings.json 一条腿；codex/opencode/openclaw 未覆盖。");
  out.push("  · 不查 DB（除非 --db）⇒ LIVE_ONLY 分不清「手改 live、DB 也没有」与「DB 已有、export 未跑」。");

  process.stdout.write("[settings-drift --selfcheck]\n" + out.map((s) => (s ? "  " + s : "")).join("\n") + "\n");
  return bad;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function compareWithDb(findingsLabel) {
  // DB 是真源。只在 --db 时查：单次 selectRows 实测 ~150ms（tableExists + select 两次 sqlite3 spawn），
  // 且 sqlite.mjs 是 ESM、findSqlite3 找不到 sqlite3 会抛、cc-switch 运行时 DB 可能被锁。
  // SessionStart 路径若引入它，dao-scaffold-check.js 就得整体改成 async —— 那不是最小改动。
  const { selectRows } = await import("../../config-sync/lib/sqlite.mjs");
  const rows = selectRows("settings", "WHERE key='common_config_claude'");
  if (!rows.length) throw new Error("DB 里没有 common_config_claude 行");
  const dbObj = JSON.parse(rows[0].value);
  const live = readJson(LIVE_SETTINGS);
  const snap = loadSnapshotClaude(SNAPSHOT_SETTINGS);
  return {
    liveVsDb: compare(live, dbObj, { otherLabel: "DB" }),
    snapVsDb: compare(snap, dbObj, { otherLabel: "DB" }),
    label: findingsLabel,
  };
}

function printReport(r) {
  const L = [];
  L.push("[settings-drift] live ↔ git 快照");
  L.push(`  live : ${r.livePath}`);
  L.push(`  快照 : ${r.snapPath}`);
  L.push(`  探针 : ${r.probe.ok ? "✓ " + r.probe.total + "/" + r.probe.total : "✗ " + r.probe.failed.map((f) => f.name).join("；")}`);
  L.push(`  耗时 : ${r.elapsedMs}ms`);
  for (const e of r.errors) L.push(`  ✗ ${e}`);
  for (const d of r.degraded) L.push(`  ⚠ ${d}`);

  const groups = [
    ["⬆ LIVE_ONLY（live 有 / 快照无 —— 改了投影没进源，下次下发会抹掉）", r.hard.filter((f) => f.kind === "LIVE_ONLY")],
    ["⬇ SNAP_ONLY（快照有 / live 无 —— 源已更新，投影没跟上）", r.hard.filter((f) => f.kind === "SNAP_ONLY")],
    ["⚙ VALUE_DIFF（两侧都有但不同 —— 方向不定）", r.hard.filter((f) => f.kind === "VALUE_DIFF")],
  ];
  L.push("");
  L.push(`── 硬发现（会触发 SessionStart 提醒）：${r.hard.length} 条 ──`);
  for (const [title, list] of groups) {
    if (!list.length) continue;
    L.push(`  ${title}`);
    for (const f of list) L.push(`    · [${f.face}] ${f.detail}`);
  }
  if (!r.hard.length) L.push("  （无）");

  const soft = r.findings.filter((f) => f.tier === "soft");
  L.push("");
  L.push(`── 软发现（仅本命令可见，不提醒；runtime=宿主会话内可改，unclassified=本检测器不判性质）：${soft.length} 条 ──`);
  for (const f of soft) L.push(`  · [${f.face}/${f.kind}] ${f.detail}`);
  if (!soft.length) L.push("  （无）");

  if (r.ruleEcho) {
    L.push("");
    L.push(`── dao-rule-echo 接线自检（exit ${r.ruleEcho.code}）──`);
    for (const l of r.ruleEcho.lines) L.push(`  ${l}`);
    if (r.ruleEcho.stderr) L.push(`  stderr: ${r.ruleEcho.stderr}`);
  }
  process.stdout.write(L.join("\n") + "\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selfcheck")) { process.exit(selfcheck()); }

  const r = detect({ real: false, skipRuleEcho: argv.includes("--no-rule-echo") });

  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(r, (k, v) => (v instanceof Set ? [...v] : v), 2) + "\n");
  } else {
    printReport(r);
  }

  if (argv.includes("--db")) {
    try {
      const d = await compareWithDb();
      const lines = ["", "── 三方（DB 为真源）──"];
      const lvd = hardOf(d.liveVsDb), svd = hardOf(d.snapVsDb);
      lines.push(`  live vs DB : ${lvd.length} 条硬差异`);
      for (const f of lvd) lines.push(`    · ${f.kind} ${f.detail}`);
      lines.push(`  快照 vs DB : ${svd.length} 条硬差异`);
      for (const f of svd) lines.push(`    · ${f.kind} ${f.detail}`);
      lines.push("  判读：live 独有且 DB 也没有 ⇒ 手改投影未进源（真债，下次下发即抹）；");
      lines.push("        live 独有但 DB 已有   ⇒ 只是 export 未跑（轻债，跑一次 export 即平）。");
      process.stdout.write(lines.join("\n") + "\n");
    } catch (e) {
      process.stderr.write(`[settings-drift] --db 查询失败：${e.message}\n`);
      appendErrorLog(`--db 查询失败：${e.message}`, e);
      process.exitCode = 2;
    }
  }

  const bad = !r.probe.ok || r.errors.length > 0 || r.hard.length > 0;
  process.exitCode = process.exitCode || (bad ? 1 : 0);
}

module.exports = {
  detect, hookLines, compare, runSelfProbe, daoScriptOf, hookIndex, selfcheck,
  LIVE_SETTINGS, SNAPSHOT_SETTINGS, MIN_PROBE_CHECKS,
  stateDir, firedLogPath, errorLogPath, lastJsonPath,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[settings-drift] CLI 异常：${e && e.stack ? e.stack : e}\n`);
    appendErrorLog("CLI 异常", e);
    process.exit(3);
  });
}
