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
// ── 第三个面：per-provider 漂移（`--providers`；hooks=issue #50 · deny=issue #56）─
// 上面那条数据流图**画漏了一层**，#49 的实测把它补上了：`common_config_claude` 是**镜像层**，
// 并不在下发路径上；cc-switch 真正下发到 `~/.claude/settings.json` 的是
// **`providers` 表里当前 provider 那一行的 `settings_config`**，而且是**整体覆盖**。
// ⇒ 每个 provider 各带一份自己的 hooks 段，彼此独立、天然会漂：
//   · #49 实测：PostCompact 钩子就是这样被「切 provider」这一个动作静默抹掉的；
//   · 2026-08-02 的修复是**手动**把两个 provider 对齐的 —— 新 provider 加入、
//     或某个 provider 被单独改一次，漂移必然复发，而当时没有任何机制会发现它。
// 本面因此比两组差异：
//   ① provider ↔ canonical（应注册的清单）
//   ② provider ↔ provider（各自那一段互相之间）
//
// ── 比对面里装了什么（issue #56 把 `permissions.deny` 加了进来）───────────────
// 「整体覆盖」这个性质对 `settings_config` 里的**每一个键**都成立，不是 hooks 专有。
// 本机实测（2026-08-02，13 行 providers）：两个 `app_type=claude` 的行**各自带着一份
// 完整的 `permissions.deny`**（6 条，与 canonical 逐条相同）—— 即 Grep-first 铁律的
// 落地面（`Bash(grep:*)` / `Bash(find:*)` / `PowerShell(Select-String:*)` …）
// 就住在这里，**切一次 provider 就会被整体覆盖**。少掉一条的后果与 hooks 少一个的
// 后果不同、更糟：hook 没了会有人察觉行为变了，而 deny 少一条只是**护栏悄悄回退**
// —— 那道闸从此放行，且没有任何输出会提到它。#50 的未尽处点的就是这件事。
//
// **纳入 / 不纳入，逐条写清楚（这是刻意的射程边界，不是「还没做完」）**：
//   · ✅ `permissions.deny` —— 纳入。全库唯一「所有 provider 都该逐字相同」的权限面：
//        它是安全护栏，没有任何按 provider 分化的理由，且无运行时写入者往里追加。
//   · ❌ `permissions.allow` —— 不纳入。宿主的「always allow」会往里自动追加（本机实测
//        34 条），它天然按你在哪个 provider 下点过什么而分化 ⇒ 拉进来就是每天唠叨，
//        而生下来就吵的检查一定会被静音。live↔快照那一面已把它降为 soft，同一理由。
//   · ❌ `permissions.additionalDirectories` / `defaultMode` —— 不纳入。**不是因为它们
//        该分化**，而是零证据：本机两个 provider 上恒同，没有任何一次实测的漂移出处。
//        照「新增覆盖面须先有真实事故出处」的既定政策，不为假想敌立判据。要加的话
//        改一行（把 id 加进 DENY_FACE_IDS）+ 补一组正负控即可。
//   · ❌ `env` / `statusLine` / `model` —— 不纳入，**设计如此**：env 里就装着各家的
//        base_url 与密钥，按 provider 不同才是对的。
//
// **canonical 真相源选定 = git 快照 `config-sync/common/settings.json` 的
// `common_config_claude` 行**，理由与被否掉的备选（都写下来，免得下一个人重走一遍）：
//   · 选它：它是 git 追踪的、有历史、可 review 的**声明层**——唯一一处「应该注册什么」
//     是被人写下并审过的，而不是某个运行时状态；且它已经是本文件 live↔快照 那一面的
//     参照侧，两面共用同一个 canonical ⇒ 两个面不可能对「什么才是 canonical」各执一词。
//   · 否掉 `ccswitch/hooks/` 目录列表：它表达不了挂载点/matcher/timeout，只答得出
//     「该不该存在」答不出「该挂哪」；且 check-dead-gates 已确立孤儿文件可能是刻意存货。
//   · 否掉 live `~/.claude/settings.json`：它是投影，内容由「你最后切到哪个 provider」决定
//     ⇒ 拿它当 canonical 等于让病灶自己定义健康。
//   · 否掉「新写一份 manifest」：那是第七种载体，它自己又要跟快照对齐 ⇒ 凭空多一个漂移面。
//   · 否掉 `dao-hard-gates.js --selfcheck`：它只知道自己那 5 道闸，管不到另外 8 个挂载点。
//   ⚠ **这个选择自带一个弱点，照直写**：#49 已证 `common_config_claude` **不在下发路径上**
//     ⇒ 没有任何机制强制它是对的。若它本身陈旧，本检查会把**全部** provider 报成漂移
//     —— 形态是对的（确实需要人来对账），但它**判不出哪一侧才是真相**，与 VALUE_DIFF
//     同属「方向不定，需人判」。报文里逐次声明，不许被读成「provider 错了」。
//
// ── 不造第七种载体 ───────────────────────────────────────────────────────────
// 产出是「检测脚本 + 接入既有入口」，不落任何 git 追踪的状态文件。
// 运行痕迹只写 `_tmp/settings-drift/`（已 gitignore，与 dao-rule-echo 同惯例）。
// `--providers` 这一面**一个字节都不落盘**：它的扫描面是 cc-switch DB + 那份 git 快照，
// 而报文只走 stdout ⇒ 报告不可能落进自己的扫描面（守卫铁律③：检查器的输出不能落在
// 它自己的扫描面内，否则每跑一次命中更多，增长看起来像「问题在恶化」）。
// 对 DB 是**结构性只读**，不是纪律性只读：走 `runSql(..., { readonly: true })`，
// sqlite3 以 `-readonly` 打开 ⇒ 写不了，而不是「我们说好不写」。
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
// issue #50 补入 per-provider hooks 面 17 条（负例 6 · 正例 8 · 零样本 1 · 自检 1 ·
// 范围判据 1 · 解析失败 1）后由 11 抬到 28。其中 3 条（P4b/P4c/P4d）是首跑真数据
// 撞出两个假阳性后补的——它们钉的是「仓库根归一化」与「statusLine 也算 command 条目」
// 这两个口径，改回去当场变红。
// issue #56 补入 permissions.deny 面 11 条（D1-D9：负例 3 · 正例 5 · 自检 1 ·
// 零样本 1 · 普查健壮性 1）后由 28 抬到 39。
const MIN_PROBE_CHECKS = 39;

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

  // ── per-provider hooks 面（issue #50）· 纯内存，无 I/O ──────────────────────
  // 为什么这批也放进 runSelfProbe 而不是只放进 tests/：这里是**每次 SessionStart 都跑**
  // 的那一半。provider 比对的 DB 读取进不了 SessionStart（同步 CJS 路径，见 loadProviderRows
  // 头注），但**比对逻辑本身**可以每次都被验一遍 —— 逻辑被改瞎时，
  // SessionStart 当场报「功能探针失败」，而不是等到某天有人手动跑 `--providers` 才发现。
  {
    const P = ROOT.replace(/\\/g, "/");
    // canonical 用占位符形态（git 快照就是这样），provider 用展开态（DB 里就是这样）——
    // 这一对本身就是最重要的负控：真实数据每天都是这个形状，判错就是每次都误报。
    // deny fixture 用真实形态（Grep-first 那几条就是本机 DB 里的原样），
    // 两侧逐字相同 —— 这一对是 deny 面最重要的负控：真实数据每天都是这个形状。
    const DENY_FIXTURE = ["Bash(grep:*)", "Bash(find:*)", "PowerShell(Select-String:*)"];
    const canonicalFixture = {
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: 'node "' + PH_PROJECT + '/ccswitch/hooks/dao-probe-alpha.js"', timeout: 10 }] }],
        PostCompact: [{ hooks: [{ type: "command", command: 'node "' + PH_PROJECT + '/ccswitch/hooks/dao-probe-compact.js"', timeout: 10 }] }],
      },
      permissions: { deny: DENY_FIXTURE.slice(), allow: ["Read"], defaultMode: "default" },
    };
    const providerSettings = (over) => {
      const base = {
        env: { ANTHROPIC_BASE_URL: "https://a.example" },
        model: "opus[1m]",
        hooks: {
          SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: 'node "' + P + '/ccswitch/hooks/dao-probe-alpha.js"', timeout: 10 }] }],
          PostCompact: [{ hooks: [{ type: "command", command: 'node "' + P + '/ccswitch/hooks/dao-probe-compact.js"', timeout: 10 }] }],
        },
        permissions: { deny: DENY_FIXTURE.slice(), allow: ["Read"], defaultMode: "default" },
      };
      return over ? over(clone(base)) : base;
    };
    const row = (id, name, over, appType) => ({
      id, name, app_type: appType || PROVIDER_APP_TYPE,
      settings_config: JSON.stringify(providerSettings(over)),
    });
    const twoAligned = () => [row("p1", "Alpha"), row("p2", "Beta")];

    // 负例 P1：两 provider 对齐 + canonical 对齐（占位符 vs 展开态）⇒ 零差异、零 cross
    {
      const r = compareProviderHooks({ providers: twoAligned(), canonical: canonicalFixture });
      t("负例·provider 全对齐（占位符 vs 展开态）→ 零漂移零 cross",
        r.driftCount === 0 && r.crossCount === 0 && !r.uncheckable && r.selfIssues.length === 0,
        "drift=" + r.driftCount + " cross=" + r.crossCount + " uncheckable=" + r.uncheckable +
        " self=" + JSON.stringify(r.selfIssues) + " vs=" + JSON.stringify(r.vsCanonical.map((x) => x.kind + ":" + x.id)));
    }
    // 负例 P2：provider 之间 env / model 不同（本就该不同）⇒ 不许报
    {
      const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
        s.env.ANTHROPIC_BASE_URL = "https://b.example"; s.model = "claude-fable-5[1m]"; return s;
      })];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("负例·provider 间 env/model 不同 → 零漂移（hooks 面之外不管）",
        r.driftCount === 0 && r.crossCount === 0,
        "drift=" + r.driftCount + " cross=" + r.crossCount);
    }
    // 负例 P3：某 provider 多一个**第三方**（非 dao）hook ⇒ 不许误伤，且不许被当成扫描面塌陷
    {
      const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
        s.hooks.PreToolUse = [{ matcher: "*", hooks: [{ type: "command", command: 'node "C:/Program Files/OtherTool/their-hook.js"', timeout: 5 }] }];
        return s;
      })];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("负例·第三方非 dao hook 不误伤、不误判扫描面塌陷",
        r.driftCount === 0 && r.crossCount === 0 && r.selfIssues.length === 0,
        "drift=" + r.driftCount + " cross=" + r.crossCount + " self=" + JSON.stringify(r.selfIssues));
    }
    // 负例 P4：非 claude 型 provider（claude-desktop / codex）⇒ 不进比对面，也不制造噪音
    {
      const providers = [row("p1", "Alpha"), row("p2", "Beta"),
        { id: "d1", name: "Desktop", app_type: "claude-desktop", settings_config: JSON.stringify({ env: { X: "1" } }) },
        { id: "c1", name: "Codex", app_type: "codex", settings_config: JSON.stringify({ auth: {}, config: {} }) }];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("负例·非 claude 型 provider 不进比对面（零噪音）",
        r.driftCount === 0 && r.crossCount === 0 && r.skipped.length === 2 && r.notes.length === 0,
        "skipped=" + r.skipped.length + " notes=" + JSON.stringify(r.notes));
    }
    // 负例 P4b：provider 的仓库根 ≠ 本次运行的仓库根（从 worktree 里跑就是这个形状）
    // ⇒ 面①**不许**因此报 26 条假阳性。这一条钉的是首跑真数据当场撞到的那个坑。
    {
      const other = "d:/some/other/windsurf-dao";
      const providers = [row("p1", "Alpha", (s) => {
        s.hooks.SessionStart[0].hooks[0].command = 'node "' + other + '/ccswitch/hooks/dao-probe-alpha.js"';
        s.hooks.PostCompact[0].hooks[0].command = 'node "' + other + '/ccswitch/hooks/dao-probe-compact.js"';
        return s;
      }), row("p2", "Beta", (s) => {
        s.hooks.SessionStart[0].hooks[0].command = 'node "' + other + '/ccswitch/hooks/dao-probe-alpha.js"';
        s.hooks.PostCompact[0].hooks[0].command = 'node "' + other + '/ccswitch/hooks/dao-probe-compact.js"';
        return s;
      })];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("负例·仓库根前缀不同（worktree 里跑）→ 面①零假阳性，且仓库根仍被打印出来",
        r.driftCount === 0 && r.crossCount === 0 && r.repoRoots.length === 1 && r.repoRoots[0] === other,
        "drift=" + r.driftCount + " roots=" + JSON.stringify(r.repoRoots));
    }
    // 正例 P4c：两个 provider 指着**不同 checkout** ⇒ 面①看不见（已归一化），
    // 面②必须报 —— 这条是上一条那个代价的**兜底证明**，两条必须成对存在。
    {
      const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
        s.hooks.SessionStart[0].hooks[0].command = 'node "d:/old/windsurf-dao/ccswitch/hooks/dao-probe-alpha.js"';
        return s;
      })];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("正例·两 provider 指向不同 checkout → 面①看不见但面②报出（归一化代价的兜底）",
        r.driftCount === 0 && r.crossProvider.some((c) => c.script === "dao-probe-alpha.js"),
        "drift=" + r.driftCount + " cross=" + JSON.stringify(r.crossProvider.map((c) => c.script)));
    }
    // 负例 P4d：statusLine 也是 `"type":"command"` ⇒ 普查数得到它，结构化那半也必须数
    // （首跑真数据 13 vs 14 恒报假「扫描面塌陷」的成因）。
    {
      const providers = [row("p1", "Alpha", (s) => {
        s.statusLine = { type: "command", command: "node " + P + "/ccswitch/statusline.js" }; return s;
      }), row("p2", "Beta", (s) => {
        s.statusLine = { type: "command", command: "node " + P + "/ccswitch/statusline.js" }; return s;
      })];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("负例·带 statusLine 时两半口径一致（不报假扫描面塌陷）",
        r.selfIssues.length === 0 && r.scoped.every((s) => s.structural === s.census),
        "self=" + JSON.stringify(r.selfIssues) + " counts=" + JSON.stringify(r.scoped.map((s) => s.structural + "/" + s.census)));
    }
    // 正例 P5：某 provider **少一个** hook —— #49 里 PostCompact 被切 provider 抹掉的原形
    {
      const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => { delete s.hooks.PostCompact; return s; })];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("正例·provider 少一个 hook → 面①报 CANONICAL_ONLY 且点名该脚本",
        r.vsCanonical.some((f) => f.kind === "CANONICAL_ONLY" && f.id === "hook:dao-probe-compact.js" && /Beta/.test(f.provider)),
        "实得：" + JSON.stringify(r.vsCanonical.map((x) => x.provider + "/" + x.kind + ":" + x.id)));
      t("正例·provider 少一个 hook → 面②同时报 cross 不一致",
        r.crossProvider.some((c) => c.script === "dao-probe-compact.js" && c.missing.some((m) => /Beta/.test(m))),
        "实得：" + JSON.stringify(r.crossProvider.map((c) => c.script + " missing=" + c.missing.join(","))));
    }
    // 正例 P6：挂载点（matcher）漂移 ⇒ VALUE_DIFF
    {
      const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
        s.hooks.SessionStart[0].matcher = "resume"; return s;
      })];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("正例·挂载点漂移 → 面①VALUE_DIFF + 面②cross",
        r.vsCanonical.some((f) => f.kind === "VALUE_DIFF" && f.id === "hook:dao-probe-alpha.js") &&
        r.crossProvider.some((c) => c.script === "dao-probe-alpha.js"),
        "vs=" + JSON.stringify(r.vsCanonical.map((x) => x.kind + ":" + x.id)) + " cross=" + JSON.stringify(r.crossProvider.map((c) => c.script)));
    }
    // 正例 P7：同名**不同路径**（basename 判据的原盲区）⇒ 必须报
    {
      const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
        s.hooks.SessionStart[0].hooks[0].command = 'node "' + HOME.replace(/\\/g, "/") + '/.claude/hooks/dao-probe-alpha.js"';
        return s;
      })];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("正例·同名不同路径 → 面①hook-cmd VALUE_DIFF",
        r.vsCanonical.some((f) => f.id === "hook-cmd:dao-probe-alpha.js" && /脚本路径/.test(f.detail)),
        "实得：" + JSON.stringify(r.vsCanonical.map((x) => x.kind + ":" + x.id)));
    }
    // 正例 P8：timeout 漂移（软）⇒ 仍要报出来，不许因为「只是软的」而消失
    {
      const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
        s.hooks.PostCompact[0].hooks[0].timeout = 60; return s;
      })];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("正例·timeout 漂移 → 面①报出（tier=soft 但计入 drift）",
        r.vsCanonical.some((f) => f.id === "hook-timeout:dao-probe-compact.js") && r.driftCount > 0,
        "实得：" + JSON.stringify(r.vsCanonical.map((x) => x.tier + "/" + x.id)));
    }
    // 正例 P9：canonical 缺失时，面②仍然能答话，且整批判为 uncheckable（≠ 通过）
    {
      const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => { delete s.hooks.PostCompact; return s; })];
      const r = compareProviderHooks({ providers, canonical: null });
      t("正例·canonical 缺失 → uncheckable=true 且面②仍报 cross",
        r.uncheckable === true && r.canonicalOk === false && r.crossCount > 0 && providerExitCode(r) === 1,
        "uncheckable=" + r.uncheckable + " cross=" + r.crossCount + " exit=" + providerExitCode(r));
    }
    // 零样本 P10：一个可比对 provider 都没有 ⇒ **不许**报成通过（exit 2 而非 0）
    {
      const r = compareProviderHooks({ providers: [{ id: "c1", name: "Codex", app_type: "codex", settings_config: "{}" }], canonical: canonicalFixture });
      t("零样本·没有 claude 型 provider → uncheckable 且 exit=2（不是「无漂移」）",
        r.uncheckable === true && providerExitCode(r) === 2 && r.notes.some((n) => /零样本/.test(n)),
        "uncheckable=" + r.uncheckable + " exit=" + providerExitCode(r) + " notes=" + JSON.stringify(r.notes));
    }
    // 自检半边 P11：主解析瞎掉（hooks 键被改名）而普查仍看得见样本 ⇒ 必须报扫描面塌陷。
    // 这一条是守卫铁律②的**可执行形式**：两半若共用解析逻辑，这里会一起归零、差恒为 0。
    {
      const blinded = JSON.stringify({ hooksV2: providerSettings().hooks });
      const providers = [{ id: "p1", name: "Alpha", app_type: PROVIDER_APP_TYPE, settings_config: blinded }];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("自检·hooks 键被改名（主解析瞎掉）→ 报扫描面塌陷 + exit=1",
        r.selfIssues.some((s) => /undercount@/.test(s)) && providerExitCode(r) === 1,
        "self=" + JSON.stringify(r.selfIssues) + " exit=" + providerExitCode(r));
    }
    // 范围判据 P12：出范围的行里普查数到 command 条目 ⇒ 出声（判据可能过期），但不判红
    {
      const providers = [row("p1", "Alpha"), row("p2", "Beta"),
        { id: "x1", name: "Weird", app_type: "claude-desktop", settings_config: JSON.stringify(providerSettings()) }];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("范围·出范围行带 hooks → 出 scope-surprise 备注但不判红",
        r.notes.some((n) => /scope-surprise/.test(n)) && r.driftCount === 0 && r.crossCount === 0,
        "notes=" + JSON.stringify(r.notes) + " drift=" + r.driftCount);
    }
    // 解析失败 P13：settings_config 不是合法 JSON ⇒ uncheckable，绝不静默当成对齐
    {
      const providers = [row("p1", "Alpha"),
        { id: "bad", name: "Broken", app_type: PROVIDER_APP_TYPE, settings_config: '{"hooks": ' }];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("解析失败·坏 JSON → uncheckable 且不计为对齐",
        r.uncheckable === true && r.notes.some((n) => /解析失败/.test(n)) && providerExitCode(r) === 2,
        "uncheckable=" + r.uncheckable + " exit=" + providerExitCode(r) + " notes=" + JSON.stringify(r.notes));
    }

    // ── permissions.deny 面（issue #56）· 同样纯内存 ──────────────────────────
    // 上面 P1-P13 的 fixture 现在两侧都带着同一份 deny ⇒ 它们**顺带**成了 deny 面的
    // 负控（任何一条报出 deny 漂移都会让它们变红）。下面这批钉的是 deny 独有的判据。

    // 负例 D1：两侧 deny 逐条一致 ⇒ 零 deny 漂移、零 deny cross、且确实比对过（sampled）
    {
      const r = compareProviderHooks({ providers: twoAligned(), canonical: canonicalFixture });
      t("负例·deny 两侧逐条一致 → 零漂移零 cross 且 denySampled=true（确实比过，不是空转）",
        r.denyDriftCount === 0 && r.denyCrossCount === 0 && r.denySampled === true &&
        r.canonicalDenyCount === DENY_FIXTURE.length,
        "denyDrift=" + r.denyDriftCount + " denyCross=" + r.denyCrossCount +
        " sampled=" + r.denySampled + " canonDeny=" + r.canonicalDenyCount);
    }
    // 正例 D2：某 provider 少一条 deny —— issue #56 要治的原形（护栏静默回退）
    {
      const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
        s.permissions.deny = s.permissions.deny.filter((x) => x !== "Bash(grep:*)"); return s;
      })];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("正例·provider 少一条 deny → 面①CANONICAL_ONLY 且点名 permissions.deny + 那条规则",
        r.denyVsCanonical.some((f) => f.kind === "CANONICAL_ONLY" && f.id === "permissions.deny" &&
          /Beta/.test(f.provider) && /Bash\(grep:\*\)/.test(f.detail)),
        "实得：" + JSON.stringify(r.denyVsCanonical.map((x) => x.provider + "/" + x.kind + ":" + x.id)));
      t("正例·provider 少一条 deny → 面②denyCross 逐条点名（缺的是哪一条、谁缺）",
        r.denyCross.some((c) => c.entry === "Bash(grep:*)" && c.missing.some((m) => /Beta/.test(m)) &&
          c.has.some((h) => /Alpha/.test(h))),
        "实得：" + JSON.stringify(r.denyCross.map((c) => c.entry + " missing=" + c.missing.join(","))));
      t("正例·deny 漂移把退出码判红（与 hooks 漂移同级，不是「只是软的」）",
        providerExitCode(r) === 1 && r.driftCount === 0 && r.crossCount === 0,
        "exit=" + providerExitCode(r) + " hooksDrift=" + r.driftCount + " hooksCross=" + r.crossCount);
    }
    // 正例 D3：某 provider **多**一条 canonical 没有的 deny ⇒ PROVIDER_ONLY（方向不能与 D2 混淆）
    {
      const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
        s.permissions.deny.push("Bash(rg:*)"); return s;
      })];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("正例·provider 多一条 deny → PROVIDER_ONLY（方向与「少一条」分得开）",
        r.denyVsCanonical.some((f) => f.kind === "PROVIDER_ONLY" && f.id === "permissions.deny" &&
          /Bash\(rg:\*\)/.test(f.detail)) &&
        !r.denyVsCanonical.some((f) => f.kind === "CANONICAL_ONLY"),
        "实得：" + JSON.stringify(r.denyVsCanonical.map((x) => x.kind + ":" + x.detail)));
    }
    // 负例 D4：allow / additionalDirectories / defaultMode 不同 ⇒ deny 面**必须**零报。
    // 这条钉的是射程边界本身：把它们放进来就是每天唠叨（allow 会被宿主自动追加）。
    {
      const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
        s.permissions.allow = ["Read", "Write", "Bash(ls:*)"];
        s.permissions.additionalDirectories = ["d:/somewhere"];
        s.permissions.defaultMode = "acceptEdits";
        return s;
      })];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("负例·allow/additionalDirectories/defaultMode 不同 → deny 面零报（射程边界）",
        r.denyDriftCount === 0 && r.denyCrossCount === 0 && providerExitCode(r) === 0,
        "denyDrift=" + r.denyDriftCount + " denyCross=" + r.denyCrossCount +
        " vs=" + JSON.stringify(r.denyVsCanonical.map((x) => x.id)));
    }
    // 负例 D5：deny 顺序不同 ⇒ 不许报（集合语义，顺序在权限系统里无意义）
    {
      const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
        s.permissions.deny = s.permissions.deny.slice().reverse(); return s;
      })];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("负例·deny 顺序不同 → 零报（集合语义）",
        r.denyDriftCount === 0 && r.denyCrossCount === 0,
        "denyDrift=" + r.denyDriftCount + " denyCross=" + r.denyCrossCount);
    }
    // 正例 D6：deny 只有大小写不同 ⇒ **必须**报。deny 是逐字匹配的，`Bash(Grep:*)` 拦不住
    // `grep`；这里若做了大小写归一化，一次真实的失效会被静默吃掉（与 normCommand 的
    // toLowerCase 是刻意相反的取舍，理由见 denySetOf 头注）。
    {
      const providers = [row("p1", "Alpha"), row("p2", "Beta", (s) => {
        s.permissions.deny = s.permissions.deny.map((x) => (x === "Bash(grep:*)" ? "Bash(Grep:*)" : x));
        return s;
      })];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("正例·deny 仅大小写不同 → 仍报（逐字匹配，不做归一化）",
        r.denyDriftCount > 0 && r.denyCross.some((c) => c.entry === "Bash(Grep:*)"),
        "denyDrift=" + r.denyDriftCount + " cross=" + JSON.stringify(r.denyCross.map((c) => c.entry)));
    }
    // 自检 D7：`permissions` 键被改名（deny 面的主解析瞎掉）⇒ 必须报 deny-undercount。
    // 这一条是守卫铁律②在 deny 面的可执行形式：command 那一对此时**完全正常**
    //（它俩不看 permissions），所以搭便车是不够的 —— 每个面都要自带两半。
    {
      const blinded = clone(providerSettings());
      blinded.permissionsV2 = blinded.permissions; delete blinded.permissions;
      const providers = [{ id: "p1", name: "Alpha", app_type: PROVIDER_APP_TYPE, settings_config: JSON.stringify(blinded) }];
      const r = compareProviderHooks({ providers, canonical: canonicalFixture });
      t("自检·permissions 键被改名（deny 主解析瞎掉）→ 报 deny-undercount + exit=1",
        r.selfIssues.some((s) => /deny-undercount@/.test(s)) && providerExitCode(r) === 1 &&
        r.scoped[0].structural === r.scoped[0].census,
        "self=" + JSON.stringify(r.selfIssues) + " exit=" + providerExitCode(r) +
        " command 两半=" + r.scoped[0].structural + "/" + r.scoped[0].census);
    }
    // 零样本 D8：两侧一条 deny 都没有 ⇒ denySampled=false，但**退出码仍是 0**
    //（不许劫持 exit 2 的「没查成」语义；两个不同状态不共用一个信号）
    {
      const noDeny = (s) => { delete s.permissions; return s; };
      const canon = clone(canonicalFixture); delete canon.permissions;
      const providers = [row("p1", "Alpha", noDeny), row("p2", "Beta", noDeny)];
      const r = compareProviderHooks({ providers, canonical: canon });
      t("零样本·两侧都无 deny → denySampled=false + 出声，但 exit 仍 0（不劫持 exit 2）",
        r.denySampled === false && providerExitCode(r) === 0 && r.uncheckable === false &&
        r.notes.some((n) => /deny 面零样本/.test(n)),
        "sampled=" + r.denySampled + " exit=" + providerExitCode(r) +
        " uncheckable=" + r.uncheckable + " notes=" + JSON.stringify(r.notes));
    }
    // 普查健壮性 D9：含方括号/引号的 deny 规则不许把括号配对扫描提前截断（漏估=危险方向）
    {
      const tricky = '{"permissions":{"deny":["Bash(ls[a-z]:*)","Bash(echo \\"x]\\":*)","Read(//x)"]}}';
      t("普查·含 ] 与转义引号的 deny 规则仍数得准（不漏估）",
        censusDenyEntries(tricky) === 3 && countDenyEntries(JSON.parse(tricky)) === 3,
        "census=" + censusDenyEntries(tricky) + " structural=" + countDenyEntries(JSON.parse(tricky)));
    }
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

// ══════════════════════════════════════════════════════════════════════════════
// per-provider hooks 漂移（issue #50）· 判据与 canonical 选定理由见本文件头注
// ══════════════════════════════════════════════════════════════════════════════

// 只有这个 app_type 的 `settings_config` 会被 cc-switch 投影到 `~/.claude/settings.json`。
// 本机全域分布实测（2026-08-02，13 行）：claude 2 · claude-desktop 5 · codex 5 · gemini 1
// —— 后三类的 settings_config 里**一个 hooks 键都没有**（claude-desktop 只有 env，
// codex 是 auth/config 的 TOML 面，gemini 是空壳），把它们拉进 hooks 面比对只会
// 造出 11 条恒定噪音，而生下来就吵的检查一定会被静音。
// **但「按 app_type 划范围」本身是个判据，不是事实**，所以出范围的行也不静默丢：
// 逐行跑一遍独立普查，普查数到 command 条目就出声（下面的 scope-surprise 备注）。
const PROVIDER_APP_TYPE = "claude";

// 纳入 per-provider 权限比对的 `compare()` face==='keys' 条目 id（issue #56）。
// 目前只有 `permissions.deny` —— **逐条的纳入/不纳入理由是文件头注「比对面里装了什么」，
// 那里是唯一真相源，此处不复述**。要再加一个面：把 id 加进这个 Set + 补一组正负控，
// 面①/末行/报文都不用动（面②的互比是逐条 deny 规则做的，加别的 id 需另写，见 denyCross）。
const DENY_FACE_IDS = new Set(["permissions.deny"]);

// ── 自检那一半：独立普查 ────────────────────────────────────────────────────
// 刻意**不 JSON.parse、不认识 hooks 结构**：它与主逻辑唯一的共同前提是「这里有文本」。
// 守卫铁律②——自检那一半必须能在主逻辑瞎掉时仍然看得见样本。复用 hookIndex 会让两半
// 一起瞎：解析漏掉一整段时违例数与样本数**同时归零**，二者之差恒为 0 ⇒ 自检永远为真。
// 它是钝的，钝的方向是刻意选的：**高估**（任何字符串值里恰好出现这几个字都会被计一次）
// 比**漏估**安全 —— 高估只会误报一次「扫描面塌陷」逼人来看一眼，漏估让「零漂移」
// 变成一句没有分母的空话。
function censusCommandEntries(text) {
  const s = String(text == null ? "" : text);
  const plain = (s.match(/"type"\s*:\s*"command"/g) || []).length;
  const escaped = (s.match(/\\"type\\"\s*:\s*\\"command\\"/g) || []).length;
  return plain + escaped;
}

// 主逻辑那一半：结构化遍历，数**全部** command 条目（不做 dao 归属过滤）。
// 与 hookIndex 的分工别混：hookIndex 只留 dao 自有脚本（那是**比对面**），
// 这里数的是**样本量**——拿 hookIndex 的条数去对普查数，会把「多了一条第三方 hook」
// 误读成「扫描面塌陷」，把一个正常状态报成检测器坏了。
//
// ⚠ **`statusLine` 必须一起数，这是首跑真数据当场撞出来的**（2026-08-02）：
// 普查是在原始文本上数 `"type":"command"`，而 `statusLine` 也长这个样子
// ⇒ 只数 hooks 段时真实数据恒为 13 vs 14，**每一次跑都报一条假的「扫描面塌陷」**。
// 分母口径对不上比数错更糟：一道生下来就吵的闸一定会被静音，而它被静音之后，
// 真正的扫描面塌陷就再也没人看得见了。同 check-dead-gates 的 walkGates 口径。
function countCommandEntries(obj) {
  let n = 0;
  const hooks = obj && obj.hooks && typeof obj.hooks === "object" ? obj.hooks : {};
  for (const event of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    for (const g of groups) {
      const entries = g && Array.isArray(g.hooks) ? g.hooks : [];
      for (const h of entries) if (h && h.type === "command") n++;
    }
  }
  const sl = obj && obj.statusLine;
  if (sl && sl.type === "command") n++;
  return n;
}

// ── deny 面的两半（issue #56）· 与上面 command 条目那两半同构 ────────────────
// 为什么 deny 也要自带一对「主逻辑 / 独立普查」而不是搭 command 那一对的便车：
// 两半之差是**按面**成立的。command 那一对若都数得对，只证明 hooks 段没瞎；
// `permissions` 整个键被改名时它俩仍然一致（都不看 permissions）⇒ deny 的
// 「结构化数到 0」会被读成「本来就没有」。守卫铁律②要的是**自检那一半能在
// 主逻辑瞎掉时仍然看得见样本**，而「瞎掉」是逐面发生的。

// 主逻辑那一半：结构化取 `permissions.deny` 的条数。
function countDenyEntries(obj) {
  const p = obj && obj.permissions;
  return p && Array.isArray(p.deny) ? p.deny.length : 0;
}

// 独立普查那一半：在**原始文本**上数，刻意不 JSON.parse、不认识 permissions 结构。
// 与 censusCommandEntries 唯一的共同前提同样是「这里有文本」。
//
// 钝的方向同样刻意选**高估**：任何字符串值里恰好出现 `"deny":[` 都会被计一次
// —— 误报一次「扫描面塌陷」逼人来看一眼，好过让「deny 零漂移」变成没有分母的空话。
// 具体形态：
//   · 逐处找 `"deny"\s*:\s*[`，从那个 `[` 起做括号配对扫描，数其中的字符串字面量；
//     串内的 `[` `]` 不参与配对，`\` 转义的下一个字符整体跳过 ⇒ 含方括号或引号的
//     deny 规则（如 `Bash(ls[a-z]:*)`）不会把扫描提前截断（截断＝漏估＝危险方向）。
//   · 同时在**去掉一层反斜杠转义**的副本上再扫一遍取 max：DB 里 settings_config 是
//     普通 JSON 串，而快照/嵌套载体里可能是被转义过的形态（`\"deny\":[…]`）。
//     取 max 而非二选一 ⇒ 两种形态都看得见，且永远偏高估那一侧。
function scanDenyArrays(s) {
  let total = 0;
  const re = /"deny"\s*:\s*\[/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    let depth = 1, inStr = false, count = 0;
    for (let i = m.index + m[0].length; i < s.length && depth > 0; i++) {
      const ch = s[i];
      if (inStr) {
        if (ch === "\\") { i++; continue; }   // 转义字符：连同下一个字符整体跳过
        if (ch === '"') { inStr = false; count++; }
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "[") depth++;
      else if (ch === "]") depth--;
    }
    total += count;
  }
  return total;
}
function censusDenyEntries(text) {
  const s = String(text == null ? "" : text);
  return Math.max(scanDenyArrays(s), scanDenyArrays(s.split('\\"').join('"')));
}

// deny 集合。与 compare() 的 `permissions.deny` 面**共用 toSet**，两面因此不可能
// 对「什么算一条 deny」各执一词（面①走 compare、面②走这里，判据必须是同一个）。
// 刻意不做大小写/空白归一化：deny 规则是逐字匹配的，`Bash(Grep:*)` 与 `Bash(grep:*)`
// 是两条不同的规则，抹掉这个差异等于替权限系统做了一个它自己不做的假设。
function denySetOf(obj) {
  return toSet(obj && obj.permissions ? obj.permissions.deny : []);
}

// ── 仓库根归一化（只用在面①）────────────────────────────────────────────────
// canonical 那份是**占位符化**的（`${PROJECT_ROOT}/ccswitch/hooks/x.js`），而
// `decodePaths` 把占位符展开成的是**当前这个 checkout 的根**——从 worktree 里跑，
// 展开出来就是 worktree 路径，而 DB 里存的是主树部署时写进去的路径。
// 这不是漂移，是「我从哪儿跑的」，但两者在字符串上完全一样地不同。
// **首跑真数据当场撞到**：在 `windsurf-dao-wt-50` 里跑，13 个 hook 全部被报成
// 「同名不同路径」——26 条满屏假阳性，而真实状态是完全对齐的。
//
// 故面①把「仓库根 + /ccswitch/」整段换成一个固定 token 再比。**代价照直写**：
// provider 指向**另一个 checkout**（如某次从 worktree 部署过去）这一格，面①看不见了。
// 那一格不是没人管——①面②（provider 互比）**刻意不做这个归一化**，两个 provider
// 指向不同 checkout 会被它当场报出；②目标文件到底存不存在归 check-dead-gates。
// 归一化只吃 `/ccswitch/` 这一段：`${HOME}/.claude/hooks/` 形态的路径不受影响
// （HOME 是机器级的，两侧展开一致），所以「hook 被改回旧的 ~/.claude 副本」仍报得出。
const REPO_TOKEN = "<repo>";
function agnosticCommand(cmd) {
  if (cmd == null) return cmd;
  const s = String(cmd).replace(/\\/g, "/");
  return s.replace(/[^\s"']*\/ccswitch\//gi, REPO_TOKEN + "/ccswitch/");
}
function withAgnosticRoots(obj) {
  const o = clone(obj);
  const hooks = o && o.hooks && typeof o.hooks === "object" ? o.hooks : null;
  if (!hooks) return o;
  for (const event of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    for (const g of groups) {
      const entries = g && Array.isArray(g.hooks) ? g.hooks : [];
      for (const h of entries) if (h && h.type === "command") h.command = agnosticCommand(h.command);
    }
  }
  return o;
}

// 各 provider 的 hook 命令串里出现过的「仓库根」集合。它不参与判红——只是把
// 「这些 hook 到底指着哪棵树」端到眼前：面①已经把这个前缀归一化掉了，
// 不打印出来的话，那条信息就在报文里彻底消失了。
function repoRootsOf(obj) {
  const roots = new Set();
  const hooks = obj && obj.hooks && typeof obj.hooks === "object" ? obj.hooks : {};
  for (const event of Object.keys(hooks)) {
    for (const g of (Array.isArray(hooks[event]) ? hooks[event] : [])) {
      for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) {
        if (!h || h.type !== "command") continue;
        const m = String(h.command).replace(/\\/g, "/").match(/([^\s"']*)\/ccswitch\//i);
        if (m) roots.add(m[1]);
      }
    }
  }
  return roots;
}

// provider 的 hooks 指纹：script → 归一化后的 {mounts, timeouts, cmds}。
// 复用 hookIndex ⇒ 占位符 / 分隔符 / 引号 / 大小写差异已被抹掉（近似性见 normCommand 头注）。
function hookSignatures(obj) {
  const sig = new Map();
  for (const [script, rec] of hookIndex(obj)) {
    sig.set(script, stable({
      mounts: [...rec.mounts].sort(),
      timeouts: [...rec.timeouts].sort(),
      cmds: [...rec.cmds].sort(),
    }));
  }
  return sig;
}

function providerLabel(row) {
  const name = row && row.name != null && String(row.name).trim() ? String(row.name).trim() : "(无名)";
  const id = row && row.id != null ? String(row.id) : "(无 id)";
  return `${name} [${id}]`;
}

function parseSettingsConfig(v) {
  if (v && typeof v === "object") return { ok: true, obj: v, raw: JSON.stringify(v) };
  if (typeof v !== "string") return { ok: false, obj: null, raw: "", why: `settings_config 既不是字符串也不是对象（typeof=${typeof v}）` };
  const raw = v.charCodeAt(0) === 0xfeff ? v.slice(1) : v;
  try { return { ok: true, obj: JSON.parse(raw), raw }; }
  catch (e) { return { ok: false, obj: null, raw, why: `settings_config JSON 解析失败：${e.message}` }; }
}

/**
 * 纯函数比对：只吃已取出的行 + 已解析的 canonical 对象，**不碰 DB、不读文件**
 * ⇒ 可用内存 fixture 直测（正控/负控都不必造真库）。
 *
 * @param {{providers: Array<Object>, canonical: Object|null, canonicalLabel?: string}} input
 * @returns {{
 *   total:number, appTypeCounts:Object, scoped:Array, skipped:Array,
 *   vsCanonical:Array, crossProvider:Array, selfIssues:Array<string>, notes:Array<string>,
 *   canonicalOk:boolean, uncheckable:boolean, driftCount:number, crossCount:number
 * }}
 */
function compareProviderHooks(input) {
  const o = input || {};
  const rows = Array.isArray(o.providers) ? o.providers : [];
  const canonical = o.canonical || null;
  const canonicalLabel = o.canonicalLabel || "canonical";

  const appTypeCounts = {};
  for (const r of rows) {
    const t = r && r.app_type != null ? String(r.app_type) : "(空)";
    appTypeCounts[t] = (appTypeCounts[t] || 0) + 1;
  }

  const scoped = [];
  const skipped = [];
  const notes = [];
  const selfIssues = [];
  let uncheckable = false;

  for (const r of rows) {
    const label = providerLabel(r);
    const appType = r && r.app_type != null ? String(r.app_type) : "(空)";
    const parsed = parseSettingsConfig(r ? r.settings_config : null);
    const census = censusCommandEntries(parsed.raw);
    const denyCensus = censusDenyEntries(parsed.raw);

    if (appType !== PROVIDER_APP_TYPE) {
      // 出范围但普查数到 command 条目 ⇒ 「按 app_type 划范围」这个判据可能已经过期。
      // 不静默丢，也不判红：机器判不出该不该纳入，只负责端到眼前。
      if (census > 0) {
        notes.push(`scope-surprise：${label}（app_type=${appType}）不在 hooks 比对范围内，` +
          `但独立普查在它的 settings_config 里数到 ${census} 条 command 条目 ` +
          `⇒ 「只有 app_type=${PROVIDER_APP_TYPE} 才带 hooks」这个划范围判据可能已过期，请人复核`);
      }
      // deny 面同理，且这一格更该出声：出范围的行里带着 deny，意味着有一份**没人在看的
      // 安全护栏**（本机实测非 claude 型的 5+5+1 行里一条 deny 都没有，故此格恒静默）。
      if (denyCensus > 0) {
        notes.push(`scope-surprise(deny)：${label}（app_type=${appType}）不在 deny 比对范围内，` +
          `但独立普查在它的 settings_config 里数到 ${denyCensus} 条 deny 规则 ` +
          `⇒ 划范围判据可能已过期，且那份护栏此刻无人核对，请人复核`);
      }
      skipped.push({ label, appType, census, denyCensus });
      continue;
    }

    if (!parsed.ok) {
      // 解析不动 ≠ 对齐。它进不了比对面，故整批判为「没查全」。
      notes.push(`${label}：${parsed.why}（独立普查在同一文本上数到 ${census} 条 command 条目、` +
        `${denyCensus} 条 deny 规则 ⇒ 它们此刻不可核验）`);
      uncheckable = true;
      scoped.push({ label, appType, obj: null, census, structural: 0, denyCensus, denyStructural: 0, parsed: false });
      continue;
    }

    const structural = countCommandEntries(parsed.obj);
    if (structural < census) {
      selfIssues.push(`undercount@${label}：结构化遍历数到 ${structural} 条 command 条目，` +
        `独立普查在同一文本上数到 ${census} 条 ⇒ 有样本没被看见（扫描面塌陷）`);
    }
    const denyStructural = countDenyEntries(parsed.obj);
    if (denyStructural < denyCensus) {
      selfIssues.push(`deny-undercount@${label}：结构化取 permissions.deny 得 ${denyStructural} 条，` +
        `独立普查在同一文本上数到 ${denyCensus} 条 ⇒ deny 面有样本没被看见（扫描面塌陷）`);
    }
    scoped.push({
      label, appType, obj: parsed.obj, census, structural, denyCensus, denyStructural,
      parsed: true, roots: [...repoRootsOf(parsed.obj)].sort(),
    });
  }

  const live = scoped.filter((s) => s.parsed);

  // 零样本：一个可比对的 provider 都没有 ⇒ **不是「通过」**。
  if (live.length === 0) {
    uncheckable = true;
    notes.push(`零样本：${rows.length} 行 providers 里没有任何 app_type=${PROVIDER_APP_TYPE} ` +
      `且可解析的行 ⇒ 本次什么都没比对到（这不是「无漂移」）`);
  }

  // ── 面 ① provider ↔ canonical ──────────────────────────────────────────────
  // 复用 compare() 的两组判据：hooks 面（basename 身份 · 挂载点 · 归一化命令串 · timeout）
  // 与 `permissions.deny` 面（集合差）。**只留这两组**，其余 face/id 一律丢——
  // 纳入与不纳入的逐条理由见本文件头注「比对面里装了什么」，那里是唯一真相源。
  const vsCanonical = [];
  const denyVsCanonical = [];
  const canonicalOk = !!(canonical && typeof canonical === "object");
  if (!canonicalOk) {
    uncheckable = true;
    notes.push(`canonical 不可用（${canonicalLabel}）⇒ 「与应注册清单的差异」这一面本次没查成，` +
      `**不等于查过且没差异**（hooks 与 deny 两面都没查成）；下面只剩 provider 互比那一面`);
  } else {
    // 两侧都先过仓库根归一化再比（理由与代价见 withAgnosticRoots 头注）。
    // deny 不含路径 ⇒ 这一步对它是恒等变换，不影响判据。
    const canonicalAgnostic = withAgnosticRoots(canonical);
    for (const s of live) {
      for (const f of compare(withAgnosticRoots(s.obj), canonicalAgnostic, { otherLabel: canonicalLabel })) {
        const isHook = f.face === "hooks";
        const isDeny = f.face === "keys" && DENY_FACE_IDS.has(f.id);
        if (!isHook && !isDeny) continue;
        (isDeny ? denyVsCanonical : vsCanonical).push({
          provider: s.label,
          tier: f.tier,
          // 换名：compare() 的 LIVE/SNAP 是它自己那一面的措辞，照抄过来会让读者
          // 以为在说 `~/.claude/settings.json`。这一面的两侧是 provider 与 canonical。
          kind: f.kind === "LIVE_ONLY" ? "PROVIDER_ONLY" : f.kind === "SNAP_ONLY" ? "CANONICAL_ONLY" : "VALUE_DIFF",
          id: f.id,
          detail: f.detail.replace(/\blive\b/g, "provider"),
        });
      }
    }
  }

  // ── 面 ② provider ↔ provider ───────────────────────────────────────────────
  // 为什么两面都要（面①绿不蕴含面②绿的反面也成立）：canonical 自己陈旧时，各 provider
  // 可能彼此一致却齐齐偏离 canonical（面①全红面②全绿）；反过来 canonical 缺失时面①
  // 根本跑不了，而面②仍答得出「这几份配置互相还一样吗」。
  const crossProvider = [];
  if (live.length >= 2) {
    const sigs = live.map((s) => ({ label: s.label, sig: hookSignatures(s.obj) }));
    const allScripts = new Set();
    for (const p of sigs) for (const k of p.sig.keys()) allScripts.add(k);
    for (const script of [...allScripts].sort()) {
      const bySig = new Map();
      const missing = [];
      for (const p of sigs) {
        const v = p.sig.get(script);
        if (v === undefined) { missing.push(p.label); continue; }
        if (!bySig.has(v)) bySig.set(v, []);
        bySig.get(v).push(p.label);
      }
      const groups = [...bySig.entries()].map(([signature, providers]) => ({ signature, providers }));
      if (groups.length > 1 || (missing.length > 0 && groups.length > 0)) {
        crossProvider.push({ script, groups, missing });
      }
    }
  }

  // ── 面 ② provider ↔ provider · deny（issue #56）─────────────────────────────
  // 与 hooks 那一面**刻意不同的形态**：hooks 按脚本分组给签名，deny 逐条规则点名。
  // 理由是可操作性——hooks 的差异是「这个钩子挂哪、跑什么」，看签名才说得清；
  // deny 的差异永远是「**哪一条规则**在这边有、在那边没有」，而那一条规则的字面
  // 就是人接下来要去补的东西。给它一个签名 hash 等于让人自己去 diff 两个数组。
  const denyCross = [];
  if (live.length >= 2) {
    const sets = live.map((s) => ({ label: s.label, set: denySetOf(s.obj) }));
    const allRules = new Set();
    for (const p of sets) for (const e of p.set) allRules.add(e);
    for (const entry of [...allRules].sort()) {
      const missing = sets.filter((p) => !p.set.has(entry)).map((p) => p.label);
      if (!missing.length) continue;
      denyCross.push({ entry, has: sets.filter((p) => p.set.has(entry)).map((p) => p.label), missing });
    }
  }

  // ── deny 面的零样本：**刻意不并进 uncheckable / exit 2** ─────────────────────
  // 两侧一条 deny 都没声明时，「✓ 0 差异」是句谎话（什么都没比到），但它也**不是
  // 「没查成」**——DB 读到了、canonical 读到了、结构也解析了，只是内容为空。
  // 把它塞进 exit 2 等于让「读不到源」与「读到了但里面是空的」共用一个信号，
  // 而**两个不同的状态挤进一个通道**正是本文件从头到尾在治的那个病（见末行契约头注）。
  // 故它单独走一个末行字段 `denySampled=0`，由报文与 SessionStart 那一行各说一句。
  const canonicalDenyCount = canonicalOk ? denySetOf(canonical).size : 0;
  const providerDenyTotal = live.reduce((n, s) => n + denySetOf(s.obj).size, 0);
  const denySampled = canonicalDenyCount > 0 || providerDenyTotal > 0;
  if (live.length > 0 && !denySampled) {
    notes.push(`deny 面零样本：${live.length} 个可比对 provider 与 canonical 里` +
      `**一条 permissions.deny 都没有** ⇒ 本次 deny 面什么都没比对到（这不是「已对齐」）。` +
      `若你预期这里应该有 Grep-first 那几条护栏，那么它此刻在每一侧都不存在`);
  }

  // 面①把仓库根归一化掉了 ⇒ 这个信息只剩这里还留着，报文必须打出来。
  const repoRoots = [...new Set(live.flatMap((s) => s.roots || []))].sort();

  return {
    total: rows.length,
    appTypeCounts,
    repoRoots,
    scoped,
    skipped,
    vsCanonical,
    crossProvider,
    denyVsCanonical,
    denyCross,
    denySampled,
    canonicalDenyCount,
    selfIssues,
    notes,
    canonicalOk,
    uncheckable,
    driftCount: vsCanonical.length,
    crossCount: crossProvider.length,
    denyDriftCount: denyVsCanonical.length,
    denyCrossCount: denyCross.length,
  };
}

// ── DB 读取（结构性只读）──────────────────────────────────────────────────
// sqlite.mjs 是 ESM 且 findSqlite3 找不到 sqlite3 会抛、cc-switch 运行时 DB 可能被锁
// ⇒ 这一路只在 CLI 走，绝不进 SessionStart 的进程内路径（那条路是同步 CJS，
// 为它整体 async 化不是最小改动，理由同 compareWithDb 头注）。
async function loadProviderRows(dbPath) {
  const { runSql } = await import("../../config-sync/lib/sqlite.mjs");
  // 只选四列：settings_config 已经很大，别把 meta/notes 一起拖进内存与报文。
  const sql = "SELECT id, app_type, name, settings_config FROM providers;";
  return runSql(sql, dbPath ? { dbPath, json: true, readonly: true } : { json: true, readonly: true });
}

// canonical 载入：git 快照的 common_config_claude 行（选它的理由见文件头注）。
function loadCanonicalClaude(file) {
  return loadSnapshotClaude(file || SNAPSHOT_SETTINGS);
}

// ── 退出码 / 末行契约（消费方按字段名取值，勿按位置；新字段一律追加在末尾）──────
//   PROVIDER_HOOKS_SUMMARY exit=<0|1|2> providers=<N> scoped=<S> drift=<D> cross=<C>
//                          selfcheck=<ok|fail> uncheckable=<0|1>
//                          denyDrift=<DD> denyCross=<DC> denySampled=<0|1>
//   末行**键名保持 `PROVIDER_HOOKS_SUMMARY` 不变**，尽管它现在也报 deny：改名会让每一个
//   现有消费方（dao-scaffold-check 的正则、tests、任何人的 grep）在同一秒静默失配，
//   而失配的表现是「拿不到末行」⇒ 报「契约被改坏了」。为一个更贴切的名字换一次全面误报
//   不划算；`drift`/`cross` 与 `denyDrift`/`denyCross` 分列，语义不含混。
//   · deny 的两个计数**刻意不并进 `drift`/`cross`**：那两个字段现存的含义是「hooks 面」，
//     悄悄把 deny 加进去会让一个读 `drift=0` 的旧消费方以为它问的还是原来那个问题。
//   · `denySampled=0` 表示「两侧一条 deny 都没声明」——它**不影响退出码**，理由见
//     compareProviderHooks 里那段（不许让「没查成」与「查了是空的」共用一个信号）。
//   · exit 0 —— 全部比对完且零差异（**只有这一个值叫「通过」**）
//   · exit 1 —— 有差异，或自检半边失败（此时「零差异」不可信，先修检测器）
//   · exit 2 —— **没查成**：DB 不在/读不了/无 providers 表/零可比对 provider/canonical 缺
//   `exit 2` 单独存在的全部理由：一个检查器数到 0 个违例，和它根本没看到样本，
//   在只读退出码的消费方眼里必须**长得不一样**。本仓 verify-all 那条退出码教训
//   （`-Skip` 掉 5 道硬闸与全绿逐字节相同）就是同一个病换了个身位。
//   末行**每条路径都打印**，含 DB 读不到的失败路径 —— 只在成功时打摘要，
//   等于让「没查成」在机器通道上表现为「什么都没说」。
function providerSummaryLine(exitCode, r) {
  const scopedParsed = r ? r.scoped.filter((s) => s.parsed).length : 0;
  return "PROVIDER_HOOKS_SUMMARY exit=" + exitCode +
    " providers=" + (r ? r.total : 0) +
    " scoped=" + scopedParsed +
    " drift=" + (r ? r.driftCount : 0) +
    " cross=" + (r ? r.crossCount : 0) +
    " selfcheck=" + (r && r.selfIssues.length === 0 ? "ok" : "fail") +
    " uncheckable=" + (r && !r.uncheckable ? "0" : "1") +
    " denyDrift=" + (r ? r.denyDriftCount : 0) +
    " denyCross=" + (r ? r.denyCrossCount : 0) +
    " denySampled=" + (r && r.denySampled ? "1" : "0");
}

function providerExitCode(r) {
  if (!r) return 2;
  // deny 的差异与 hooks 的差异同级判红：少一条 deny 是**护栏静默回退**，
  // 后果不比少一个 hook 轻（见文件头注「比对面里装了什么」）。
  if (r.driftCount > 0 || r.crossCount > 0 ||
      r.denyDriftCount > 0 || r.denyCrossCount > 0 ||
      r.selfIssues.length > 0) return 1;
  if (r.uncheckable) return 2;
  return 0;
}

function printProviderReport(r, meta) {
  const L = [];
  const m = meta || {};
  L.push("");
  L.push("=== per-provider 漂移：hooks + permissions.deny（cc-switch DB providers.settings_config）===");
  L.push("  DB        : " + (m.dbPath || "(默认)") + (m.readonly === false ? "" : "  [-readonly 打开]"));
  L.push("  canonical : " + (m.canonicalPath || "(未指定)") + (r && r.canonicalOk ? "" : "  ✗ 不可用"));
  const dist = Object.keys(r.appTypeCounts).sort().map((k) => k + "=" + r.appTypeCounts[k]).join(" · ");
  L.push("  全域分布  : 共 " + r.total + " 行 —— " + (dist || "(空)") +
    "；纳入 hooks 比对的是 app_type=" + PROVIDER_APP_TYPE + " 那 " + r.scoped.length + " 行");
  for (const s of r.scoped) {
    L.push("     · " + s.label + (s.parsed
      ? "  结构化 " + s.structural + " 条 command / 普查 " + s.census + " 条" +
        "；deny 结构化 " + s.denyStructural + " 条 / 普查 " + s.denyCensus + " 条"
      : "  ✗ 解析不动（普查 " + s.census + " 条 command、" + s.denyCensus + " 条 deny）"));
  }
  // 面①比之前把「仓库根 + /ccswitch/」归一化成 <repo> 了 ⇒ 这条信息只剩这里还留着。
  // 不打出来的话，「hook 指着哪棵树」就在报文里彻底消失（而那正是它值得看一眼的时候）。
  L.push("  仓库根    : " + (r.repoRoots.length ? r.repoRoots.join(" · ") : "(未出现 /ccswitch/ 形态的路径)") +
    "；本次运行于 " + ROOT.replace(/\\/g, "/") +
    (r.repoRoots.length === 1 && r.repoRoots[0].toLowerCase() !== ROOT.replace(/\\/g, "/").toLowerCase()
      ? "  ⓘ 两者不同是正常的（你多半在 worktree 里跑），面①已按 <repo> 归一化，不据此判红"
      : ""));

  L.push("");
  if (!r.canonicalOk) {
    L.push("⚠ 面① provider ↔ canonical：**本次没查成**（canonical 不可用），不等于没差异");
  } else if (r.driftCount === 0) {
    L.push("✓ 面① provider ↔ canonical：0 条差异（" + r.scoped.filter((s) => s.parsed).length + " 个 provider 逐个比过）");
  } else {
    L.push("✗ 面① provider ↔ canonical：" + r.driftCount + " 条差异 —— " +
      "**方向不定，需人判**：canonical 本身不在下发路径上（#49 实证），" +
      "它陈旧时也会长成这个样子，别默认是 provider 错了");
    for (const f of r.vsCanonical) {
      const kindCn = f.kind === "PROVIDER_ONLY" ? "⬆ provider 有 / canonical 无"
        : f.kind === "CANONICAL_ONLY" ? "⬇ canonical 有 / provider 无（切到这个 provider 就会被静默抹掉）"
        : "⚙ 两侧都有但不同";
      L.push("    · [" + f.provider + "] " + kindCn + "（" + f.tier + "）：" + f.detail);
    }
  }

  L.push("");
  const parsedCount = r.scoped.filter((s) => s.parsed).length;
  if (parsedCount < 2) {
    L.push("ⓘ 面② provider ↔ provider：只有 " + parsedCount + " 个可比对 provider，互比无从谈起（不是「已对齐」）");
  } else if (r.crossCount === 0) {
    L.push("✓ 面② provider ↔ provider：" + parsedCount + " 个 provider 的 dao hook 段逐项一致");
  } else {
    L.push("✗ 面② provider ↔ provider：" + r.crossCount + " 个 hook 在各 provider 之间不一致 —— " +
      "切 provider 会整体覆盖 live settings ⇒ 切到缺的那一侧，这些 hook 当场静默消失：");
    for (const c of r.crossProvider) {
      L.push("    · " + c.script);
      for (const g of c.groups) {
        L.push("        有（" + g.providers.join("、") + "）：" + short(g.signature, 220));
      }
      if (c.missing.length) L.push("        无：" + c.missing.join("、"));
    }
  }

  // ── deny 面（issue #56）· 两面各自成段，与 hooks 面并列 ────────────────────
  L.push("");
  if (!r.denySampled) {
    L.push("ⓘ deny 面：**零样本** —— provider 与 canonical 里一条 permissions.deny 都没有，" +
      "本次什么都没比对到（这不是「已对齐」；它不影响退出码，理由见末行契约头注）");
  } else {
    if (!r.canonicalOk) {
      L.push("⚠ deny 面① provider ↔ canonical：**本次没查成**（canonical 不可用），不等于没差异");
    } else if (r.denyDriftCount === 0) {
      L.push("✓ deny 面① provider ↔ canonical：0 条差异（canonical 声明 " + r.canonicalDenyCount +
        " 条 deny，" + parsedCount + " 个 provider 逐个比过）");
    } else {
      L.push("✗ deny 面① provider ↔ canonical：" + r.denyDriftCount + " 条差异 —— " +
        "deny 是安全护栏，**少一条就是那道闸从此放行、且没有任何输出会提到它**；" +
        "方向仍需人判（canonical 不在下发路径上，它陈旧时也长这样）：");
      for (const f of r.denyVsCanonical) {
        const kindCn = f.kind === "PROVIDER_ONLY" ? "⬆ provider 有 / canonical 无"
          : f.kind === "CANONICAL_ONLY" ? "⬇ canonical 有 / provider 无（切到这个 provider，这几条护栏当场静默回退）"
            : "⚙ 两侧都有但不同";
        L.push("    · [" + f.provider + "] " + kindCn + "（" + f.tier + "）：" + f.detail);
      }
    }

    if (parsedCount < 2) {
      L.push("ⓘ deny 面② provider ↔ provider：只有 " + parsedCount + " 个可比对 provider，互比无从谈起（不是「已对齐」）");
    } else if (r.denyCrossCount === 0) {
      L.push("✓ deny 面② provider ↔ provider：" + parsedCount + " 个 provider 的 deny 规则逐条一致");
    } else {
      L.push("✗ deny 面② provider ↔ provider：" + r.denyCrossCount + " 条 deny 规则在各 provider 之间不一致 —— " +
        "切 provider 会整体覆盖 live settings ⇒ 切到缺的那一侧，这几条拦截当场失效：");
      for (const c of r.denyCross) {
        L.push("    · " + c.entry);
        L.push("        有：" + c.has.join("、"));
        L.push("        无：" + c.missing.join("、"));
      }
    }
  }

  if (r.notes.length) {
    L.push("");
    L.push("⚠ 备注 " + r.notes.length + " 条（**不等于通过**）：");
    for (const n of r.notes) L.push("    · " + n);
  }

  L.push("");
  if (r.selfIssues.length === 0) {
    L.push("✓ 自检半边：每个 provider 的结构化遍历数 ≥ 独立普查数（扫描面没塌）");
  } else {
    L.push("✗ 自检半边失败 " + r.selfIssues.length + " 条 —— **此时「零漂移」不可信，先修检测器**：");
    for (const i of r.selfIssues) L.push("    · " + i);
  }

  L.push("");
  L.push("ⓘ 射程边界（照直写，别当全包）：比两个面 —— hooks 面的 **dao 自有脚本**、" +
    "以及 **permissions.deny**（issue #56）；permissions 的其余子键（allow / " +
    "additionalDirectories / defaultMode）与 env / statusLine / model **未纳入**" +
    "（allow 会被宿主自动追加、env 按 provider 不同是设计如此，逐条理由见本文件头注" +
    "「比对面里装了什么」）；第三方 hook 不进比对面（否则每装一个工具就唠叨一次）；" +
    "本检查**只读不修**，对齐动作归人。");
  process.stdout.write(L.join("\n") + "\n");
}

async function runProviderCheck(argv) {
  const dbPath = argOfCli(argv, "--db-file", null);
  const canonicalPath = argOfCli(argv, "--canonical-file", SNAPSHOT_SETTINGS);
  const asJson = argv.includes("--json");

  let rows = null, canonical = null;
  const loadErrors = [];
  try { rows = await loadProviderRows(dbPath); }
  catch (e) { loadErrors.push("读 cc-switch DB providers 表失败：" + (e && e.message ? e.message : String(e))); }
  try { canonical = loadCanonicalClaude(canonicalPath); }
  catch (e) { loadErrors.push("读 canonical 失败（" + canonicalPath + "）：" + (e && e.message ? e.message : String(e))); }

  if (rows == null) {
    // DB 这一侧都没读到 ⇒ 什么都没比对。**这一条路径同样打末行**，否则「没查成」
    // 在机器通道上表现为「什么都没说」，而那正是本文件要治的病。
    for (const e of loadErrors) process.stderr.write("[settings-drift --providers] ✗ " + e + "\n");
    process.stdout.write("\n=== per-provider 漂移：hooks + permissions.deny ===\n" +
      "✗ 没查成（两个面都没查成）：" + loadErrors.join("；") + "\n" +
      "  （这不是「无漂移」。手动复核：node ccswitch/lib/settings-drift.js --providers）\n");
    process.stdout.write(providerSummaryLine(2, null) + "\n");
    return 2;
  }

  const r = compareProviderHooks({ providers: rows, canonical, canonicalLabel: "canonical(git 快照)" });
  for (const e of loadErrors) r.notes.push(e);
  const code = providerExitCode(r);

  if (asJson) {
    process.stdout.write(JSON.stringify({
      exit: code,
      total: r.total,
      appTypeCounts: r.appTypeCounts,
      scoped: r.scoped.map((s) => ({
        label: s.label, parsed: s.parsed, structural: s.structural, census: s.census,
        denyStructural: s.denyStructural, denyCensus: s.denyCensus,
      })),
      skipped: r.skipped,
      vsCanonical: r.vsCanonical,
      crossProvider: r.crossProvider,
      denyVsCanonical: r.denyVsCanonical,
      denyCross: r.denyCross,
      denySampled: r.denySampled,
      canonicalDenyCount: r.canonicalDenyCount,
      selfIssues: r.selfIssues,
      notes: r.notes,
      canonicalOk: r.canonicalOk,
      uncheckable: r.uncheckable,
    }, null, 2) + "\n");
  } else {
    printProviderReport(r, { dbPath: dbPath || "(默认 ~/.cc-switch/cc-switch.db)", canonicalPath });
  }
  process.stdout.write(providerSummaryLine(code, r) + "\n");
  return code;
}

function argOfCli(argv, name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt;
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
  // `--providers` 是**独占模式**（同 --selfcheck）：它有自己的末行契约与三态退出码，
  // 混进 live↔快照 那一面的退出码会让两个不同的问题共用一个信号，
  // 而「两个信号挤进一个通道」正是本文件反复在治的病。
  if (argv.includes("--providers")) { process.exit(await runProviderCheck(argv)); }

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
  // per-provider hooks 面（issue #50）。compareProviderHooks 是纯函数（不碰 DB / 不读文件）
  // ⇒ 正控/负控都能用内存 fixture 直测；loadProviderRows 才是那条要 sqlite 的路。
  compareProviderHooks, providerExitCode, providerSummaryLine,
  loadProviderRows, loadCanonicalClaude, censusCommandEntries, countCommandEntries,
  PROVIDER_APP_TYPE,
  // permissions.deny 面（issue #56）。两半分别导出，测试要能各自换靶做 mutation：
  // 只导出比对结果的话，「census 与 structural 是不是真的两套实现」就不可测。
  censusDenyEntries, countDenyEntries, denySetOf, DENY_FACE_IDS,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[settings-drift] CLI 异常：${e && e.stack ? e.stack : e}\n`);
    appendErrorLog("CLI 异常", e);
    process.exit(3);
  });
}
