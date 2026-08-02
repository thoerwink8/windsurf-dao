// dao-design-sync-gate.js — 设计同步门控出文本层（Stop · decision:block，每会话每门至多一次）
//
// ── 它替掉的是什么 ──────────────────────────────────────────────────────────
// dao.md「动·三才之机 · 人·验」完成流水线的 **② 设计同步门控** 整段（含步骤 4 的
// OD 面板快照附属）。那一段是一个**自检步骤**：要求 AI 在声明完成之前，自己回想
// 「有没有 design/ 目录」「本轮改没改 UI 组件」，两条都满足就先去同步原型。
//
// 问题不在这条规则对不对，在**它挂在哪**：它要求在一个**没有标记的时刻**（「我正要
// 说做完了」）发起一次自由裁量的自检 —— 本仓实测这一类的携带率 9-24%。dao.md 那段
// 自己就记着一次静默空转（`Glob("design/*.html")` 少写一层 `**`，门控整段无声跳过）。
// ⇒ 这次把**全部机械判定**搬到 agent 之外：Stop 事件是「我正要说做完了」这个时刻的
// 机器投影，它每回合必到、不需要谁想起来。
//
// **本批刻意不动 dao.md 正文**（重写批 3 才删原段）。所以现在是**双通道并存**：
// 文字自检还在、hook 也在。两者同时命中时后果只是「AI 已经想同步了，又被拦了一次」，
// 无害；反过来 hook 没注册时文字仍是唯一兜底 —— 这正是「先立后破」的形态。
//
// ── 🔴 三通道分工（2026-08-02 补第三条；**本节是这三者关系的唯一真相源**）──────
// 「改 UI 必动 design/」现在有三个执行通道。**三条都留着是有意的，它们互补不互替** ——
// 但那也意味着同一条规则有三份措辞，而本文件末段记着的那两处分歧（closing.md 比 dao.md 宽、
// harvest-log 提议改判据）正是「三份各自漂移」的样品。故分工只写在这里一处，
// 另两处（`ccswitch/templates/githooks/pre-commit` 头注、scaffold 清单条目
// `design-sync-precommit` 的 why）**只留指针，不复述**。
//
//   ㈠ **散文判据**（dao.md 完成流水线 ②）
//      时刻：AI「正要说做完了」· 输入：AI 自己回想 · 覆盖：读到 dao.md 的一切 agent
//      够不到：无标记时刻的自由裁量 —— 本仓实测这一类携带率 9-24%
//   ㈡ **本 Stop hook**
//      时刻：同㈠，但由宿主事件投递 · 输入：**本轮改动**（分支级 diff ∪ staged ∪ unstaged ∪ 未跟踪）
//      覆盖：Claude **主**会话，每会话至多 block 一次
//      够不到：非 Claude 宿主；subagent（走 SubagentStop）；未注册时整条失效
//   ㈢ **git pre-commit 闸**（`ccswitch/templates/githooks/pre-commit`，2026-08-02 上移自 TraceyU）
//      时刻：`git commit` · 输入：**staged 内容**
//      覆盖：**所有宿主的所有提交**（Codex / Cascade / 裸 git / IDE）
//      够不到：`--no-verify`；未 `git add` 的改动；未接 `core.hooksPath` 时整条失效
//
// **为什么不能只留一条**（三个方向各试一次，三次都不成立）：
//   · 只留㈢ ⇒ 「本轮改了 UI 但这次提交只 staged 了别的文件」整类漏掉，且 AI 声明完成时无人拦。
//   · 只留㈡ ⇒ 换个宿主（本体系明确要服务 Codex/Cascade）后零覆盖，而**零覆盖与全过长得一样**。
//   · 只留㈠ ⇒ 那就是本 hook 存在的理由本身。
// **三者的判据允许不同，但分歧必须是有意的**：㈡按 dao.md 的窄判据（`.tsx` 且文件含 JSX），
// ㈢按路径形态（另含 `.vue`/`.svelte`/`index.css`，见其头注 UI_RE）。**这处不一致是选出来的、
// 不是漏出来的**：㈢在 pre-commit 那一刻只拿得到路径与 staged diff，只能按路径判；
// 把㈡放宽到㈢那样等于**改判据**，属立法，不搭迁移的车（同下方「迁移时不顺手统一」那两笔）。
//
// ── 🔴 为什么这次敢用 Stop（上一次结论是「砍掉 Stop」）───────────────────────
// docs/specs/_archive/auto-behavior-design.md 第 2 轮结论写着「**砍 Stop，全部归
// UserPromptSubmit**」，理由是 loop 风险，出处是 memory 里那条 ralph-loop 插件的
// Stop hook 无条件 block 把会话卡死。**那条结论没有被推翻，被推翻的是它的前提**：
// 那次的死法是「**无条件**且**无状态**地 block」。本 hook 有三道互相独立的止血：
//   ㈠ **once-latch**：每会话每门至多 block 一次，状态落盘（见下方 LATCH_FILE）。
//   ㈡ **stop_hook_active**：宿主在「上一轮是被 Stop hook 拦回来的」时把这个字段置真
//      （cli.js 实证：blockingErrors 非空 ⇒ 下一轮 stopHookActive:!0）。命中即绝不再 block。
//      这是官方给的那把锁，㈠是我们自己的那把，**两把锁的失效方式不一样**（㈠依赖状态
//      文件可写，㈡依赖宿主协议不变）⇒ 刻意都留着，不合并。
//   ㈢ **latch 写不成就不 block**（下面「反过来的那条」）。
// **诚实边界**：我在 cli.js 里**找不到任何「连续 block N 次即强制结束」的上限**
//   —— `if(k6.blockingErrors.length>0){...stopHookActive:!0...;continue}` 是一个裸的
//   `while(!0)`，没有计数器。派单令里那句「防官方 8 连 block 强制结束」**未被证实**；
//   真实情况比它更严：**没有上限**，所以三道锁不是保险而是唯一的东西。
//
// ── 判定逻辑（照 dao.md 现文，不改判据）─────────────────────────────────────
//   ① 有设计稿？  `design/**/*.html` 有结果（`**` 必须——单层 `*` 匹配不到 design/pages/，
//      曾致门控静默空转）；无结果时 fallback `git ls-files 'design/*.html'`（ls-files 的
//      pathspec 跨子目录），任一有结果即满足。
//   ② 改了 UI 组件？ 本轮改动含 `components/` 段，或 `.tsx` 且文件里有 JSX。
//      「本轮改动」：分支 ≠ 主干（Loop/worktree）→ `git diff <主干> --name-only`（分支级全量，
//      该命令比的是主干树 vs **工作区**，故已含 staged+unstaged）；否则 → unstaged ∪ staged。
//      **两种情况都并上 `git ls-files --others --exclude-standard`**（新建未跟踪的组件文件
//      `git diff` 一概看不见，而「新写了一个组件」恰恰是最该响的那种改动；受 .gitignore 约束）。
//   ③ 两条都满足**且本轮没碰 design/** → block 一次。
//   ④ 附属（与①②独立判）：本轮改动含 `design/**` 且存在 `design/.od-sync.json`
//      → 静默跑一次 od-panel-sync 增量同步，`$LASTEXITCODE >= 8` 才算失败。
//
// **「已同步」是怎么判的，照直说**：dao.md 只说「两条都满足 → 必须执行设计同步」，
// 没定义「已同步」。这里取的机械代理是 **本轮改动里有没有 `design/**`** —— 因为设计同步的
// 产出物就是「反向同步原型 + 更新 CONTEXT.md」，落到盘上就是 design/ 下的文件变更。
// **这个代理不是本文件发明的**：`ccswitch/skills/dao-loop/closing.md` §7.1.5 的「违反检测」
// 早就逐字这么写着 ——「Loop diff 含 UI 组件但 `design/` 目录无变更 commit → 强制回到此步」。
// **这是近似，两个方向都有反例**：为别的原因动了 design/ ⇒ 漏报；上一个会话已同步且
// 已并进主干 ⇒ 本轮 diff 里看不到 design/，可能多响一次。多响的代价被 latch 封顶在
// 「每会话一次」，漏报的代价则回落到 dao.md 那段文字兜底 —— 两侧都不是零，写在这里。
//
// ── ⚠️ 迁移时 Grep 引用面捞出的两处「同一条规则，三个版本」，本批一处都不动 ────────
// 本 hook 按 **dao.md 现文**实现。同批 Grep（两仓）发现另外两处在说同一件事而措辞不同，
// **刻意不顺手统一** —— 统一判据是立法不是迁移，且其中一处正等着用户拍板：
//   ① `dao-loop/closing.md` §7.1.5 步骤 2 写的是「含 `**/components/**` 或 `**/*.tsx`」，
//      **没有「中有 JSX」这个条件** ⇒ 它比 dao.md 宽，本 hook 跟 dao.md（窄的那个）。
//      两处的分歧早于本批，不是本批引入的。
//   ② mousse-cli `docs/ops/harvest-log.md` H6-4 提议把这一条改成**按本次 diff 是否含
//      JSX 判、而不是按文件是否含 JSX 判**（文件含 JSX 但 diff 全在 hook/逻辑段 ⇒ 不该命中），
//      状态是**待用户批**。若它获批，本 hook 的 `isUiChange()` 要跟着改成读 diff 而非读整文件。
//      **本批按未获批处理**（照现行 dao.md），把这一笔明写在这里，免得日后有人以为迁移时漏了。
//
// ── 三条判据都是近似（禁笃定措辞）──────────────────────────────────────────
// ① JSX 检测是正则（`<Tag`/`</`/`<>`），认不出模板字符串里的假 JSX，也认不出
//    `React.createElement` 写法 ⇒ 两向都有反例。**文件读不到时按命中算**（已删/未落盘），
//    宁可多响一次，因为多响有 latch 封顶而漏报没有。
// ② dao.md 写的是 `.tsx`，本 hook 就只认 `.tsx` —— `.jsx` / `.vue` / `.svelte` 明知在
//    射程之外，**刻意不扩**：这一批是迁移不是改判据，扩射程要另走立法。
// ③ `components/` 是按路径段匹配，`components/README.md` 也会命中。同样照 dao.md 字面。
//
// ── 反过来的那条：latch 写不成 ⇒ **不 block**（与 dao-tool-nudge 相反，是刻意的）──
// tool-nudge 的去重状态写不动时选择「仍然提醒（可能重复）」，理由是重复只是噪音而静默
// 等于规则消失。**本 hook 反过来**：这里重复的不是一段提醒，是一次 `decision:block`，
// 而上面已经写明宿主侧**没有连续 block 上限** ⇒ 重复 block 的最坏后果是会话卡死，
// 和「规则这次没生效」完全不是一个量级。故顺序是 **先把 latch 写成，再 block**；
// 写不成就降级到 stderr。代价：状态目录坏掉时本门静默失效 —— 由 `--selfcheck` 的心跳
// 陈旧告警和降级时的 stderr 自陈兜。
//
// ── Stop 事件的三条协议事实（从 2.1.76 的 cli.js 实读，不是从记忆）────────────
// ㈠ **输入**：`{session_id, transcript_path, cwd, permission_mode, agent_id, agent_type,
//    hook_event_name:"Stop", stop_hook_active:boolean, last_assistant_message?:string}`。
// ㈡ **输出**：能 block 的字段是**顶层** `{"decision":"block","reason":"…"}`（不是
//    `hookSpecificOutput`）。宿主把它转成 `blockingError`，注入形态是
//    `Stop hook feedback:\n<reason>`，然后**继续这一轮**。
// ㈢ 🔴 **Stop 事件没有 `additionalContext` 通道**：输出 schema 里 `hookSpecificOutput`
//    是一个联合类型，成员只有 PreToolUse / UserPromptSubmit / SessionStart / Setup /
//    SubagentStart / PostToolUse / PostToolUseFailure / Notification / PermissionRequest /
//    Elicitation / ElicitationResult —— **没有 Stop**。
//    ⇒ **一个不 block 的 Stop hook，够不到模型的上下文**。降级路径（stderr / systemMessage）
//    只到得了 transcript 与用户眼前，到不了 AI。这不是本 hook 的疏漏，是这个事件的形状；
//    别把「降级提醒」读成「AI 会看到」。
// ㈣ **matcher 对 Stop 无效**：宿主为 Stop 不设 matchQuery（`kr8()` 的 switch 里没有 Stop
//    分支）⇒ `(_ ? z.filter(…) : z)` 走的是不过滤那一支，任何 matcher 值都不会拦掉它。
//    别照 PostToolUse 的经验去担心「matcher 写窄一格就静默零覆盖」。
// ㈤ **不覆盖 subagent**：subagent 结束走 `SubagentStop`（另一个事件名，且它的 matchQuery
//    是 agent_type）。本注册收不到 —— 刻意如此，设计同步门控管的是主 agent 的完成流水线。
//    另有一道保险：输入里带 `agent_id` 时直接放行。
//
// ── fail-open ───────────────────────────────────────────────────────────────
// 本 hook 自身出错一律不阻断（脚手架的 fail() 三重留痕后 exit 0）。一道会因自身 bug
// 把每一次「结束回合」都拦住的闸 = 会话直接砖掉，而它没有任何逃生通道。
// 代价是「放行」与「通过」在退出码上长得一样 ⇒ 故有 `--selfcheck` 与心跳文件。
//
// ── 自检 ────────────────────────────────────────────────────────────────────
//   node ccswitch/hooks/dao-design-sync-gate.js --selfcheck
// 两段式：① live settings.json 的 hooks.Stop 里有没有引用本文件 ② 有没有**非 synthetic**
// 的真实触发记录（自测心跳标 synthetic，不予采信）。**不看「文件在不在盘上」** —— 那是
// 三例「55 天零生效」事故的共同误判。
//
// 回归网：tests/design-sync-gate.tests.js（正负控 + latch 两态 + fail-open + 双向 mutation）。
// 真相源：windsurf-dao/ccswitch/hooks/dao-design-sync-gate.js
// 注册：live `~/.claude/settings.json` 的 `hooks.Stop`（matcher 留空即可，见 ㈣）。
//       **写入面是 cc-switch DB `providers` 表各 provider 的 `settings_config`，每个 provider
//       都要写**（切 provider 时 live 被目标 provider 的配置整体覆盖 ⇒ 只写一个等于没写）。
//       **属用户动作** —— AI 侧写 DB 被权限分类器全路径拦截。注册片段见本批 PR body「注册项」。

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const H = require("../lib/hook-selfcheck.js").createHookScaffold({
  name: "dao-design-sync-gate",
  stateSubdir: "design-sync-gate",
  failTail: "本次设计同步门控与 OD 快照同步都没跑；回合照常结束（fail-open）",
  forceErrorEnv: "DAO_DESIGN_SYNC_GATE_FORCE_ERROR",
  selfTestEnv: "DAO_DESIGN_SYNC_GATE_SELFTEST",
});

const ROOT = path.resolve(__dirname, "..", ".."); // 本文件在 <root>/ccswitch/hooks/

// once-latch 状态。测试用 DAO_DESIGN_SYNC_GATE_STATE 覆写 —— 用真状态会让「本机今天
// 已经拦过了」把正控染绿，而「结论取决于机器当时的状态」正是回归网要防的东西。
const LATCH_FILE = process.env.DAO_DESIGN_SYNC_GATE_STATE ||
  path.join(ROOT, "_tmp", "design-sync-gate", "latch.json");
// 条目上限：session 只增不减，不封顶就长成一个没人看的大 JSON。超限保留最近的一半。
const LATCH_MAX = 200;

const GATE_DESIGN_SYNC = "design-sync";

// OD 项目工作目录的基址（od-panel-sync.md §1.1）。测试用环境变量覆写指向临时目录 ——
// 不覆写的话这份回归网会去写用户真实的 Open Design 数据目录，那是不可接受的副作用。
const OD_BASE = process.env.DAO_DESIGN_SYNC_GATE_OD_BASE ||
  path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "Open Design", "namespaces", "release-stable-win", "data", "projects");

// 单次 git / robocopy 的墙钟上限。Stop 每回合都触发，任何一个子进程挂住都会让
// 「结束回合」肉眼可见地卡一下 —— 宁可这一次判不出来，也不要每回合罚一次时间。
const GIT_TIMEOUT_MS = 5000;
const ROBOCOPY_TIMEOUT_MS = 20000;

const UI_DIR_RE = /(^|\/)components(\/|$)/i;
const TSX_RE = /\.tsx$/i;
// JSX 近似：开标签 / 闭标签 / Fragment。见头注「三条判据都是近似」。
const JSX_RE = /<[A-Za-z][A-Za-z0-9._:-]*[\s/>]|<\/[A-Za-z]|<>/;
// 递归找 design/**/*.html 时的深度上限与跳过目录。深度上限防的是符号链接环与
// 巨大的 node_modules —— 一个每回合都跑的 hook 不该有无界遍历。
const WALK_MAX_DEPTH = 8;
const WALK_SKIP = new Set([".git", "node_modules", "dist", "build", "target", "_tmp"]);

// ── git ─────────────────────────────────────────────────────────────────────
// 路径锚点用 `git -C <root>`，不依赖 cwd（dao Shell 路径锚点规则）。
// 判成败只看退出码，不看输出文案（dao Shell 假错规则）。
function git(root, args) {
  const r = spawnSync("git", ["-C", root].concat(args), {
    encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || "");
}

function gitRoot(cwd) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  const p = String(r.stdout || "").trim();
  return p ? p.replace(/\\/g, "/").replace(/\/+$/, "") : null;
}

function trunkOf(root) {
  // `--verify --quiet` 在 ref 不存在时退出码非 0 且无输出 ⇒ git() 返回 null
  for (const n of ["main", "master"]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", n]) !== null) return n;
  }
  return null;
}

function addLines(set, text) {
  if (!text) return;
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (t) set.add(t);
  }
}

// 返回本轮改动的仓相对路径集合（git 输出恒为正斜杠）。
function changedFiles(root) {
  const trunk = trunkOf(root);
  const branch = String(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) || "").trim();
  const out = new Set();
  let mode;
  if (trunk && branch && branch !== trunk && branch !== "HEAD") {
    // Loop / worktree：分支级全量。`git diff <trunk>` 比的是主干树 vs 工作区，含 staged+unstaged。
    addLines(out, git(root, ["diff", trunk, "--name-only"]));
    mode = "分支级全量（git diff " + trunk + "）";
  } else {
    // 主干上 / 游离 HEAD：当前工作区的 unstaged + staged
    addLines(out, git(root, ["diff", "--name-only"]));
    addLines(out, git(root, ["diff", "--cached", "--name-only"]));
    mode = "工作区 unstaged ∪ staged";
  }
  // 新建未跟踪文件：`git diff` 一概看不见，而「新写了一个组件」恰是最该响的那种改动
  addLines(out, git(root, ["ls-files", "--others", "--exclude-standard"]));
  return { files: out, mode: mode + " ∪ 未跟踪(--others --exclude-standard)" };
}

// ── ① 有设计稿？ ────────────────────────────────────────────────────────────
function walkForHtml(dir, depth) {
  if (depth > WALK_MAX_DEPTH) return false;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return false; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (WALK_SKIP.has(e.name)) continue;
      if (walkForHtml(path.join(dir, e.name), depth + 1)) return true;
    } else if (e.isFile() && /\.html$/i.test(e.name)) {
      return true;
    }
  }
  return false;
}

function hasDesignAssets(root) {
  // 主路：Glob("design/**/*.html")。`**` 必须——正式稿常在 design/pages/ 子目录，
  // 单层 `*` 匹配不到，曾致门控静默空转。
  if (walkForHtml(path.join(root, "design"), 0)) {
    return { ok: true, via: "design/**/*.html 递归命中" };
  }
  // fallback：worktree / 分支可能盘上缺文件，但 index 里有。
  // ls-files 的 pathspec 跨子目录（`ls-tree` 不带 -r 不列子树，禁用）。
  const ls = git(root, ["ls-files", "design/*.html"]);
  if (ls && ls.trim()) return { ok: true, via: "git ls-files 'design/*.html' 命中" };
  return { ok: false, via: "两路均无结果" };
}

// ── ② 改了 UI 组件？ ────────────────────────────────────────────────────────
function isUiChange(root, rel) {
  if (UI_DIR_RE.test(rel)) return true;
  if (!TSX_RE.test(rel)) return false;
  try {
    return JSX_RE.test(fs.readFileSync(path.join(root, rel), "utf8"));
  } catch (_) {
    // 读不到（已删 / 未落盘）⇒ 按命中算。多响一次由 latch 封顶，漏报则没有任何东西兜。
    return true;
  }
}

const isDesignPath = (rel) => rel === "design" || rel.startsWith("design/");

// ── ④ OD 面板快照同步（附属，静默无感）─────────────────────────────────────
// 退出码语义照 od-panel-sync.md §3.3：0/1/2/3/4-7 皆成功，**>=8 才是失败**。
// 用退出码判，不看输出文字（同 §6 反模式 3）。
function odExitOk(code) { return typeof code === "number" && code < 8; }

function runOdSync(root) {
  const cfgPath = path.join(root, "design", ".od-sync.json");
  if (!fs.existsSync(cfgPath)) return null; // 没配就没这回事，静默

  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (e) {
    return { ok: false, line: "design/.od-sync.json 解析失败（" + e.message + "）⇒ 本次未同步" };
  }
  const id = cfg && typeof cfg.odProjectId === "string" ? cfg.odProjectId.trim() : "";
  if (!id) return { ok: false, line: "design/.od-sync.json 缺 odProjectId ⇒ 本次未同步" };

  const projDir = path.join(OD_BASE, id);
  if (!fs.existsSync(projDir)) {
    // 不盲建：目录不存在说明 ID 错了（od-panel-sync.md §6 反模式 4）
    return { ok: true, skipped: true, line: "OD 项目目录不存在，跳过且不创建（ID 可能不对）：" + projDir };
  }
  if (process.platform !== "win32") {
    return { ok: true, skipped: true, line: "非 Windows，robocopy 不可用 ⇒ 跳过 OD 快照同步" };
  }

  const target = path.join(projDir, (cfg.targetSubdir && String(cfg.targetSubdir)) || "design");
  const src = path.join(root, "design");
  const r = spawnSync("robocopy", [src, target, "/E", "/XF", "*.artifact.json"], {
    encoding: "utf8", timeout: ROBOCOPY_TIMEOUT_MS, windowsHide: true,
  });
  if (r.error) return { ok: false, line: "robocopy 起不来/超时：" + r.error.message };
  const code = r.status;
  return odExitOk(code)
    ? { ok: true, line: "OD 快照已同步（robocopy exit=" + code + "，<8 即成功）→ " + target }
    : { ok: false, line: "OD 快照同步失败（robocopy exit=" + code + "，>=8 即失败）→ " + target };
}

// ── once-latch ──────────────────────────────────────────────────────────────
function readLatch() {
  try {
    const j = JSON.parse(fs.readFileSync(LATCH_FILE, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch (e) {
    return e && e.code === "ENOENT" ? {} : null; // null = 读不动，与「空表」分开
  }
}

// **先写成功再 block**：写不成即返回 false，调用方降级为不 block。理由见头注
// 「反过来的那条」—— 宿主侧没有连续 block 上限，重复 block 的最坏后果是会话卡死。
function persistLatch(latch, key) {
  try {
    const next = latch || {};
    next[key] = new Date().toISOString();
    const keys = Object.keys(next);
    if (keys.length > LATCH_MAX) {
      keys.sort((a, b) => String(next[a]).localeCompare(String(next[b])));
      for (const k of keys.slice(0, keys.length - Math.floor(LATCH_MAX / 2))) delete next[k];
    }
    fs.mkdirSync(path.dirname(LATCH_FILE), { recursive: true });
    fs.writeFileSync(LATCH_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
    return true;
  } catch (_) { return false; }
}

// ── --selfcheck ─────────────────────────────────────────────────────────────
function selfcheck() {
  let r;
  try {
    r = H.selfcheckLines({
      event: "Stop",
      scriptName: "dao-design-sync-gate.js",
      // Stop 忽略 matcher（头注 ㈣，cli.js kr8() 实读）⇒ 覆盖面这一问对本事件恒成立。
      // 刻意不编一个假判据来「显得更严」：一个恒真的检查若装成在检查什么，
      // 比没有检查更糟（读者会以为这一面有人看着）。
      covers: () => true,
      matcherLabel: (m) => (m === "" ? "（空）" : m) + " — 对 Stop 无效，见下方说明",
      coversFailNote: "",
      logPath: H.firedLog,
      missNote: "hook 进程根本起不来（node 路径 / 权限）",
      describeLast: (last) => "repo=" + (last.root || "?") + " 判定=" + (last.verdict || "?"),
      staleDays: 7, // Stop 每回合都触发，7 天没记录基本等于掉线了
      staleNote: (d) => "⚠ 末次真实触发在 " + d + " 天前 —— Stop **每回合**都该触发，" +
        "这么久没有记录多半是注册掉了、或状态目录 " + H.stateDir + " 写不动。",
      logReadFailLabel: "读取触发日志失败",
    });
  } catch (e) {
    process.stderr.write("[dao-design-sync-gate] selfcheck 异常：" + e.message + "\n");
    process.exit(1);
  }

  const lines = r.lines.slice();
  lines.push("· matcher 对 Stop 无效：宿主不为 Stop 计算 matchQuery（cli.js `kr8()` 的 switch 无 Stop 分支）⇒ " +
    "任何 matcher 值都不会把它过滤掉。别照 PostToolUse 的经验担心「matcher 写窄一格＝静默零覆盖」。");
  lines.push("· 收不到 subagent：subagent 结束走 `SubagentStop`（另一个事件名）。刻意如此——本门管主 agent 的完成流水线。");
  lines.push("· block 的射程：每会话每门至多一次，latch 落 " + LATCH_FILE + "；" +
    "**latch 写不成即降级为不 block**（宿主侧没有连续 block 上限，重复 block 会卡死会话）。");
  lines.push("· Stop 没有 additionalContext 通道 ⇒ **不 block 的那条路够不到模型**，只到 transcript 与用户眼前。");

  process.stdout.write("[dao-design-sync-gate --selfcheck]\n" + lines.map((s) => "  " + s).join("\n") + "\n");
  process.exit(r.bad ? 1 : 0);
}

if (process.argv.includes("--selfcheck")) selfcheck();

// ── 主流程 ──────────────────────────────────────────────────────────────────
function main() {
  const input = H.readStdinJson(); // 坏输入 → fail() 三重留痕后 exit 0（fail-open）
  // 数组补一刀：脚手架的守卫是 `!input || typeof input !== "object"`，而 `typeof [] === "object"`
  // ⇒ `[1,2,3]` 会被当成合法 payload 一路走下去（各字段全 undefined，最后静默 exit 0）。
  // 那是**协议对不上却没人出声**，正是本 hook 头注反复在防的那种死法。
  // **刻意只在这里补，不去改 ../lib/hook-selfcheck.js**：那个脚手架另有两个消费方，
  // 改共享库的守卫语义属另一件事，不搭本批的车。
  if (Array.isArray(input)) H.fail("解析 stdin JSON", new Error("payload 是数组，不是 Stop 事件对象"));
  const sessionId = String(input.session_id || "unknown-session");
  const stderrLines = [];
  const record = { at: new Date().toISOString(), synthetic: H.isSynthetic(input), event: "Stop" };

  // 保险：subagent 走的是 SubagentStop，正常收不到；真收到也放行。
  if (input.agent_id) {
    record.verdict = "skip:subagent";
    H.heartbeat(record);
    process.exit(0);
  }

  // 故障注入闸 —— **两个取值指向两条不同的路，别把它们当同一个开关**：
  //   `=1`    → 脚手架在 readStdinJson 里就抛，走的是 fail() 自己那条 exit 0；
  //   `=main` → 这里抛，走的是文件最末尾那个 **外层 catch**。
  // 分成两个取值是被覆盖面逼出来的：`=1` 永远到不了外层 catch（fail() 先 exit 了），
  // 于是那个「hook 崩了也不许砖会话」的最终兜底**一条断言都没有** —— 而它恰恰是
  // 整个 fail-open 设计里最不该无人看管的一段。
  if (process.env.DAO_DESIGN_SYNC_GATE_FORCE_ERROR === "main") {
    throw new Error("人为注入故障（DAO_DESIGN_SYNC_GATE_FORCE_ERROR=main）@主流程");
  }

  const cwd = String(input.cwd || process.cwd());
  const root = gitRoot(cwd);
  if (!root) {
    record.verdict = "skip:not-a-git-repo";
    H.heartbeat(record);
    process.exit(0);
  }
  record.root = root;

  // 最便宜的判别器放最前：绝大多数仓根本没有 design/ 目录，一次 statSync 就该退出，
  // 而不是先去跑几条 git diff —— 这个 hook 每回合都跑，代价乘以回合数。
  let hasDesignDir = false;
  try { hasDesignDir = fs.statSync(path.join(root, "design")).isDirectory(); } catch (_) {}
  if (!hasDesignDir) {
    record.verdict = "skip:no-design-dir";
    H.heartbeat(record);
    process.exit(0);
  }

  const { files: changed, mode } = changedFiles(root);
  const designTouched = [...changed].filter(isDesignPath);

  // ── ④ OD 附属：与 ①② 独立判 ───────────────────────────────────────────
  let od = null;
  if (designTouched.length > 0) od = runOdSync(root);
  if (od) stderrLines.push("[dao-design-sync-gate] " + od.line);

  // ── ①②③ 设计同步门控 ─────────────────────────────────────────────────
  const assets = hasDesignAssets(root);
  const uiChanged = [...changed].filter((p) => isUiChange(root, p));
  const conditionsMet = assets.ok && uiChanged.length > 0;
  const alreadySynced = designTouched.length > 0;
  const shouldFire = conditionsMet && !alreadySynced;

  record.verdict = shouldFire ? "fire" : (conditionsMet ? "skip:already-synced" : "skip:conditions-unmet");
  record.uiChanged = uiChanged.length;
  record.od = od ? (od.skipped ? "skipped" : od.ok ? "ok" : "failed") : "n/a";

  let payload = null;

  if (shouldFire) {
    const key = sessionId + "::" + GATE_DESIGN_SYNC;
    const latch = readLatch();
    const reentry = input.stop_hook_active === true;
    const latched = latch !== null && Object.prototype.hasOwnProperty.call(latch, key);

    let why = null;
    if (reentry) why = "stop_hook_active=true（上一轮已被 Stop hook 拦回来，官方 loop 锁）";
    else if (latched) why = "本会话已 block 过一次（once-latch）";
    else if (latch === null) why = "latch 状态读不动（" + LATCH_FILE + "）";
    else if (!persistLatch(latch, key)) why = "latch 写不成（" + LATCH_FILE + "）";

    const evidence =
      "触发条件：①有设计稿（" + assets.via + "）②本轮改了 UI 组件 " + uiChanged.length + " 个：" +
      uiChanged.slice(0, 8).join(" , ") + (uiChanged.length > 8 ? " …" : "") +
      "；③本轮 design/ 下零改动 ⇒ 判为「未同步」。改动面取法：" + mode + "。";

    if (why) {
      record.verdict = "degraded";
      record.degradedWhy = why;
      stderrLines.push(
        "[dao-design-sync-gate] 设计同步门控命中但**降级为不阻断**：" + why + "。" + evidence +
        " 该做的事没变：反向同步原型 + 更新 CONTEXT.md，或输入 /dao-design sync。" +
        "（注：Stop 事件没有 additionalContext 通道，这段话到不了模型上下文，只在 transcript 与本行 stderr 里。）"
      );
    } else {
      record.verdict = "blocked";
      payload = {
        decision: "block",
        reason:
          "【dao 设计同步门控】完成流水线 ② 未过，不能进 ③（声明完成）。\n" +
          evidence + "\n" +
          "→ 现在执行设计同步：**反向同步原型 + 更新 CONTEXT.md**；或输出交接信息 " +
          "`📋 代码改了 UI 组件且有 design/ 目录 → 请输入 /dao-design sync`。" +
          "Loop 场景的详细流程见 dao-loop closing.md §7.1.5。\n" +
          "若本轮确实不需要同步（例如改的是 design/ 射程外的组件），说明理由后照常收尾即可——" +
          "**本会话本门只拦这一次**，下次结束回合不会再拦。",
      };
    }
  }

  H.heartbeat(record);

  // OD 同步真失败要让人看见：静默失败正是 od-panel-sync 当初存在的理由（曾静默滞后一周）。
  if (od && !od.ok) {
    payload = payload || {};
    payload.systemMessage = "[dao] OD 面板快照同步失败：" + od.line;
  }

  for (const l of stderrLines) {
    try { process.stderr.write(l + "\n"); } catch (_) {}
  }

  if (payload) H.emit(payload);
  process.exit(0);
}

try {
  main();
} catch (e) {
  // fail-open：本 hook 崩了绝不能把「结束回合」拦死。fail() 三重留痕后 exit 0。
  H.fail("设计同步门控主流程", e);
}
