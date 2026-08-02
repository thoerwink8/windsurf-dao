// clause-parser.mjs — 条款的**机器面**解析器（P6 第一步）
//
// ── 治的是什么 ───────────────────────────────────────────────────────────────
// dao 的条款元字段（`[n=][基线:][自定@][触发:]`）在调研里被判为「领先业界任何公开规范」，
// 但它的**存储形态还是散文**：整个规则集只能 append，做不到 merge / delete / 按角色渲染。
// 一条条款要给某个官种看，今天的办法是让它把整份文件读完（`docs/rules/dispatch-clauses.md`
// 的派单必带首行），而实证说渲染成「只给你这一份」是把遵守率从 17-40% 推到 76-77% 的那个
// 变量（Quote 条件）。本文件是那条路的第一段：**把散文里已经存在的机器面抽出来**。
//
// ── 范围铁律（第一步只做这些，写在最前面免得被后来人扩写）─────────────────────
//   · 只解析**已经写在 Markdown 里**的元字段与官种归属，**条款正文一个字不动**。
//   · Markdown 是**唯一真相源**，本解析器与它生成的 `clause-index.json` 都是**派生物**。
//     索引里刻意**不存全文**，只存 `line`/`line_end` 指回原文 —— 存全文就是手工双写的开端，
//     而双写必漂移。要全文的消费方（render-clauses.mjs）回去读 Markdown。
//   · **不做**：改正文、合并条款、判断条款该不该退役、往 Markdown 回写任何东西。
//
// ── 为什么不复用 check-clauses-structure.ps1 的解析（这不是重复劳动）───────────
// dao 守卫铁律：「守卫里『我是不是瞎了』那一半，绝不能复用被守对象的解析逻辑」。
// 这里的关系是它的推论 —— 本解析器与那个 PS 守卫是**同一份语料的两套独立读法**，
// 于是「两边数出来的条款数一致」才构成一个有判别力的信号（`--reconcile`）。
// 若本文件转而去 spawn 那个 PS 脚本、或照抄它的状态机，两边会**一起瞎**：
// 解析漏掉一整节时，两边的数同时变小、差恒为 0，对账退化成一句永远为真的废话。
//
// **共享的是「契约」不是「实现」**，这条边界要说清楚，否则下一个人会以为独立性已被破坏：
// 元字段的**字面格式**（`[n=<数|?> @<MM-DD> 触发:<…>]`）是两边共同消费的**外部契约**，
// 就像两个独立的 JSON 解析器都得认识 `{`。独立性指的是**扫描面怎么走**：
//   · PS 侧：单趟行循环，用几个布尔状态位（inFence / inSpecialSection / …）边走边判。
//   · 本文件：**先建节区间表（两趟）**，再按行号查表定位所属节。
// 一个节判定写错时，两种走法的失败形态不同 —— 这正是要的。
//
// ── 已知的近似与弱处（照直写，别把「解析出来了」读成「解析对了」）──────────────
//   · `title` 取的是「加粗判据句首」，那是**启发式**：没有加粗的老条款回退到「首个全角冒号
//     之前」，再退回到「前 N 个字」。两个方向都构造得出反例（标题里带冒号的会被截短；
//     整条没有句首判据的会拿到一句半截话）。它只用于**人读的索引与渲染标题**，不参与任何判定。
//   · `id` 是**内容指纹**不是长期标识符：改一个字（含把 `n=1` 改成 `n=2`）id 就变。
//     要「同一条条款跨版本的稳定 id」得另立手工维护的 slug 字段 —— 本批不做（见 PR 未尽处）。
//   · `first_seen` 原样存 `MM-DD` 字符串，**刻意不补年份**：`@` 字段本来就没有年份，
//     补年份等于让派生物凭猜测产出原文里不存在的信息。要算年龄的消费方自己去挑年份
//     （PS 守卫的 `Resolve-ClauseDate` 就是那个判据，本文件不重造）。
//   · 「一行一条」是本解析器的**计数单位**：同一行出现两个元字段时只认第一个。
//     全库现无此形态，故不为它加判据（同 PS 守卫「不为假想敌立判据」的既定政策）。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ── 字面契约（与 PS 守卫共享的**格式**，不是共享的实现）──────────────────────
export const META_FIELD_RE = /\[n=(\d+|\?) @(\d{2}-\d{2}) 触发:([^\]]+)\]/;
export const CLAUSE_SIGNATURE_RE = /\[n=/;
export const BASELINE_RE = /\[基线:([^\]]+)\]/;
export const SELF_AUTHORED_RE = /\[自定@(\d{2}-\d{2})\]/;
export const JUDGE_ONLY_MARK = "[仅判据·无触发]";
export const OBSERVING_MARK = "[观察中]";

// H2 节标题：**恰两个 `#` 后跟空白**。`### 三级标题` 不重置节状态 —— 这一条与 PS 侧
// 的 `^##\s` 语义相同，是被检文件的组织约定，不是抄来的技巧。
const H2_RE = /^##\s/;
const SPECIAL_SECTION_RE = /^##\s*📌/;
const OBSERVATION_SECTION_RE = /^##\s*观察区/;
const FENCE_RE = /^```/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s/;

export const SELECTOR = {
  // 含条款签名 `[n=` 的行即条款候选，不论缩进、不论是不是列表项。
  // 适用于「条款与散文混装」的文件（dao.md / ccswitch/rules/*.md）。
  MARKED: "marked",
  // 零缩进 `- ` 行即条款候选（不论有没有字段 ⇒ 检得出「整条丢字段」）。
  // 适用于「整份文件就是条款列表」的文件（mousse dispatch-clauses.md）。
  ALL_TOP_LEVEL: "all-top-level",
};

export const ROLE_SCHEME = {
  // 整份文件归 general（dao.md 与 ccswitch/rules/* 没有官种分节）
  GENERAL: "general",
  // 按 `##` 节名映射官种（mousse dispatch-clauses.md 型）
  DISPATCH_SECTIONS: "dispatch-sections",
};

export const ZONE = { CLAUSE: "clause", OBSERVATION: "observation" };

// 官种节名 → role。**有序表**：先匹配先赢。
// 取值刻意用英文短名（文件名/CLI 参数友好），中文节名原样留在 `section` 字段里。
export const ROLE_TABLE = [
  [/通用节/, "general"],
  [/复审官/, "reviewer"],
  [/实现官/, "implementer"],
  [/对抗验证官/, "adversary"],
  [/侦察官/, "scout"],
  [/dogfood\s*官/i, "dogfood"],
];
// 观察区条目不是条款，单独一个 role 值，渲染侧一律不摘。
export const ROLE_OBSERVATION = "observation";
// 落在任何已知官种节之外的条款。**刻意不并进 general**：并进去等于让一条没人认领的条款
// 混进每一份派单渲染里，而「多给了一条」这种错在输出上看不出来。它要么被看见、要么不存在。
export const ROLE_UNCLASSIFIED = "unclassified";

const TITLE_MAX = 80;
const EXCERPT_MAX = 160;
const BLOCK_WALK_MAX = 12; // 向上/向下找块边界的行数上限，防病态文件把解析拖垮

function splitLines(text) {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // 去 BOM
  return t.split(/\r\n|\n|\r/);
}

// ── 第一趟：代码围栏遮罩 ──────────────────────────────────────────────────────
// 围栏内是文档样例（本仓真有把条款样例写进围栏的段落），两侧都必须一致地不算数。
function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (FENCE_RE.test(t)) {
      mask[i] = true; // 围栏行本身也不算内容
      inFence = !inFence;
      continue;
    }
    mask[i] = inFence;
  }
  return mask;
}

// ── 第二趟：节区间表 ─────────────────────────────────────────────────────────
// 与 PS 侧「边走边翻布尔位」的走法**结构上不同**：这里先把文件切成区间，再按行号查表。
// 节判定错了的时候，两种走法坏的样子不一样 —— 那是 `--reconcile` 有判别力的前提。
export function mapSections(lines, mask) {
  const sections = [];
  let cur = { start: 0, end: lines.length - 1, heading: null, kind: "preamble" };
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const t = lines[i].trim();
    if (!H2_RE.test(t)) continue;
    cur.end = i - 1;
    sections.push(cur);
    cur = {
      start: i,
      end: lines.length - 1,
      heading: t.replace(/^#+\s*/, "").trim(),
      kind: SPECIAL_SECTION_RE.test(t)
        ? "special"
        : OBSERVATION_SECTION_RE.test(t)
          ? "observation"
          : "normal",
    };
  }
  sections.push(cur);
  return sections;
}

function sectionOf(sections, lineIdx) {
  // 节数是个位数量级，线性扫足够；二分只会多一个可以单独写错的地方。
  for (const s of sections) if (lineIdx >= s.start && lineIdx <= s.end) return s;
  return null;
}

function selectorHit(raw, selector) {
  if (selector === SELECTOR.ALL_TOP_LEVEL) return raw.startsWith("- ");
  if (selector === SELECTOR.MARKED) return CLAUSE_SIGNATURE_RE.test(raw);
  throw new Error(`未知 selector：${selector}（合法值：${Object.values(SELECTOR).join(" / ")}）`);
}

function lineShape(raw) {
  if (raw.startsWith("- ")) return "top";
  if (/^\s+[-*+]\s/.test(raw)) return "indent";
  return "prose";
}

// 一条条款可以跨行：元字段常年住在**末行**，而判据句首在几行之上
// （实例：ccswitch/rules/dao-guard-writing.md 那条「规则集只增不减」占三行）。
// 故 title / body_excerpt 要先把这条条款的**块边界**找出来，不能只看元字段那一行。
function blockStart(lines, mask, i, sectionStart) {
  let j = i;
  for (let step = 0; step < BLOCK_WALK_MAX && j > sectionStart; step++) {
    if (LIST_ITEM_RE.test(lines[j])) break; // 本行自己就是列表项 ⇒ 块从这里开始
    const prev = lines[j - 1];
    if (mask[j - 1]) break;
    const pt = prev.trim();
    if (pt === "" || /^#{1,6}\s/.test(pt) || FENCE_RE.test(pt) || pt.startsWith(">")) break;
    j--;
  }
  return j;
}

function blockEnd(lines, mask, i, sectionEnd) {
  let j = i;
  for (let step = 0; step < BLOCK_WALK_MAX && j < sectionEnd; step++) {
    const next = lines[j + 1];
    if (next === undefined || mask[j + 1]) break;
    const nt = next.trim();
    if (nt === "" || /^#{1,6}\s/.test(nt) || FENCE_RE.test(nt) || nt.startsWith(">")) break;
    if (LIST_ITEM_RE.test(next)) break; // 下一条列表项 ⇒ 已经是别人的块
    j++;
  }
  return j;
}

function stripLeadMarker(s) {
  return s
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^[\s🔴🟢🔵⚠️⚡📌📍🗑🕳⏸✅❌❓⭐🔒🔓⚔️🌾🔄📸📋💡⬆⏳🚫🤖]+/u, "")
    .trim();
}

// 「加粗判据句首」是启发式，不是判定 —— 见文件头「已知的近似」。
export function extractTitle(blockText) {
  const head = stripLeadMarker(blockText.split(/\r?\n/)[0] || "");
  const bold = /^\*\*(.+?)\*\*/.exec(head);
  let t = bold ? bold[1] : null;
  if (!t) {
    const colon = head.indexOf("：");
    t = colon > 0 ? head.slice(0, colon) : head;
  }
  t = t.replace(/\s+/g, " ").trim();
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1) + "…" : t;
}

function excerptOf(blockText) {
  const one = blockText.replace(/\s+/g, " ").trim();
  return one.length > EXCERPT_MAX ? one.slice(0, EXCERPT_MAX - 1) + "…" : one;
}

function roleOf(section, roleScheme) {
  if (section && section.kind === "observation") return ROLE_OBSERVATION;
  if (roleScheme === ROLE_SCHEME.GENERAL) return "general";
  if (roleScheme !== ROLE_SCHEME.DISPATCH_SECTIONS) {
    throw new Error(
      `未知 role_scheme：${roleScheme}（合法值：${Object.values(ROLE_SCHEME).join(" / ")}）`
    );
  }
  const heading = section && section.heading ? section.heading : "";
  for (const [re, role] of ROLE_TABLE) if (re.test(heading)) return role;
  return ROLE_UNCLASSIFIED;
}

/**
 * 解析一份 Markdown 的条款面。
 *
 * @param {object} o
 * @param {string} o.text        原文
 * @param {string} o.file        用于填进记录的文件标识（相对路径优先）
 * @param {string} o.selector    SELECTOR.*
 * @param {string} o.roleScheme  ROLE_SCHEME.*
 * @returns {{clauses:object[], observation:object[], fieldless:object[], sections:object[], stats:object}}
 *   clauses     —— 正式条款（zone=clause 且元字段完整）。**它的条数就是对账的那个数**。
 *   observation —— 观察区条目（元字段完整）。不是条款，渲染侧不摘。
 *   fieldless   —— 合选择器但没有完整元字段的行（只可能出现在 all-top-level 模式）。
 *                  它**不是**违规判定 —— 判违规是 PS 守卫的活，这里只如实分堆。
 */
export function parseClauses({ text, file, selector, roleScheme }) {
  const lines = splitLines(text);
  const mask = fenceMask(lines);
  const sections = mapSections(lines, mask);

  const clauses = [];
  const observation = [];
  const fieldless = [];
  let skippedSpecial = 0;

  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const raw = lines[i];
    const t = raw.trim();
    if (H2_RE.test(t)) continue; // 标题行本身不是条款
    const sec = sectionOf(sections, i);
    if (sec && sec.kind === "special") {
      // `## 📌` 节整节跳过：那里是「怎么写条款」的元文档，里面的样例长得和条款一样。
      if (CLAUSE_SIGNATURE_RE.test(raw)) skippedSpecial++;
      continue;
    }
    if (!selectorHit(raw, selector)) continue;

    const m = META_FIELD_RE.exec(raw);
    const bs = blockStart(lines, mask, i, sec ? sec.start : 0);
    const be = blockEnd(lines, mask, i, sec ? sec.end : lines.length - 1);
    const blockText = lines.slice(bs, be + 1).join("\n");
    const zone = sec && sec.kind === "observation" ? ZONE.OBSERVATION : ZONE.CLAUSE;

    const base = {
      file,
      line: bs + 1, // 1-based，指向**块首**（判据句首那一行），不是元字段那一行
      line_end: be + 1,
      meta_line: i + 1,
      shape: lineShape(raw),
      section: sec && sec.heading ? sec.heading : null,
      zone,
      role: roleOf(sec, roleScheme),
      title: extractTitle(blockText),
      body_excerpt: excerptOf(blockText),
    };

    if (!m) {
      fieldless.push({ ...base, reason: "合选择器但无完整元字段" });
      continue;
    }
    const rec = {
      id: null, // 由 assignIds 填（要全局去重，单文件里定不了）
      ...base,
      n: m[1],
      first_seen: m[2],
      trigger: m[3],
      baseline: (BASELINE_RE.exec(raw) || [null, null])[1],
      self_declared: (SELF_AUTHORED_RE.exec(raw) || [null, null])[1],
      judge_only: raw.includes(JUDGE_ONLY_MARK),
      observing: raw.includes(OBSERVING_MARK),
      _fingerprint_src: blockText,
    };
    (zone === ZONE.OBSERVATION ? observation : clauses).push(rec);
  }

  const stats = {
    lines: lines.length,
    sections: sections.length,
    clauses: clauses.length,
    observation: observation.length,
    fieldless: fieldless.length,
    // 与 PS 守卫 `notrigger=` 对账的第二个信号。只数正式条款，与它一致。
    no_trigger: clauses.filter((c) => c.trigger === "无").length,
    unclassified: clauses.filter((c) => c.role === ROLE_UNCLASSIFIED).length,
    self_declared: clauses.filter((c) => c.self_declared).length,
    // 落在 `## 📌` 节里、长得像条款的行数。它**不该**参与任何判定，只是让「我跳过了什么」
    // 有个数字 —— 静默跳过与「跑了且零命中」在输出上不可区分，那正是本仓反复踩的病。
    skipped_in_special_sections: skippedSpecial,
  };
  return { clauses, observation, fieldless, sections, stats };
}

export function parseFile(absPath, { file, selector, roleScheme }) {
  const text = fs.readFileSync(absPath, "utf8");
  return parseClauses({ text, file: file || absPath, selector, roleScheme });
}

// ── id：内容指纹 ─────────────────────────────────────────────────────────────
// 「短址」取 12 位十六进制。撞了不静默截断也不抛 —— 按确定性顺序加长到 24 位。
// 两条**逐字节相同**的条款（真的复制粘贴了）加长也撞，那时退到 `<hash>-<序号>`：
// 这种情况本身就是该被发现的重复，id 里带序号正好让它在索引里现形。
export function assignIds(records) {
  const byHash = new Map();
  for (const r of records) {
    const full = crypto
      .createHash("sha256")
      .update(r._fingerprint_src.replace(/\s+/g, " ").trim(), "utf8")
      .digest("hex");
    r._full_hash = full;
    if (!byHash.has(full)) byHash.set(full, []);
    byHash.get(full).push(r);
  }
  const short = new Map(); // 12 位前缀 → 命中的完整 hash 集合
  for (const full of byHash.keys()) {
    const k = full.slice(0, 12);
    if (!short.has(k)) short.set(k, new Set());
    short.get(k).add(full);
  }
  for (const r of records) {
    const k = r._full_hash.slice(0, 12);
    const collided = short.get(k).size > 1;
    const base = collided ? r._full_hash.slice(0, 24) : k;
    const group = byHash.get(r._full_hash);
    r.id = group.length > 1 ? `${base}-${group.indexOf(r) + 1}` : base;
  }
  return records;
}

// ── 索引构建 ─────────────────────────────────────────────────────────────────
// 行尾归一化：**必须**，不是洁癖。本仓 `core.autocrlf=true` 且 `.gitattributes` 只钉了
// `*.sh`，于是同一个 commit 在不同机器/不同配置下 checkout 出来的 Markdown 字节**不同**
// （本机 dao.md 工作树里是 CRLF，仓里存的是 LF）。若拿原始字节做 sha256，索引里记的哈希
// 会在换一台机器时全部对不上 ⇒ `--check` 一 clone 就红，而它红的原因与条款没有半点关系。
// **生下来就红的检查一定会被静音**，静音之后它与不存在等价。
// 代价照直写：纯行尾变化因此**不算漂移** —— 这是对的，它一个条款都没改。
export function normalizeText(s) {
  return (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function sha256File(absPath) {
  return crypto
    .createHash("sha256")
    .update(normalizeText(fs.readFileSync(absPath, "utf8")), "utf8")
    .digest("hex");
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

/**
 * 把一份源清单变成索引对象。
 *
 * 源描述：{ file（绝对或相对 repoRoot）, selector, role_scheme }
 *
 * **仓外源（如 mousse 的 dispatch-clauses.md）刻意不进默认清单**：它的路径是这台机器上的
 * 绝对路径，写进一个提交到 git 的派生物里，会让 `--check` 在别的机器上必红 —— 一个
 * 生下来就红的检查会被立刻静音。它仍然是**测试里的第三语料**（验解析器通用性 + 对账），
 * 只是不进 committed 索引。要临时把它算进来：`--sources-json` 指一份自带的清单。
 */
export function buildIndex(sources, { repoRoot }) {
  const srcMeta = [];
  const all = [];
  for (const s of sources) {
    const abs = path.isAbsolute(s.file) ? s.file : path.join(repoRoot, s.file);
    if (!fs.existsSync(abs)) {
      throw new Error(`源文件不存在：${abs}（清单里写的是 ${s.file}）`);
    }
    const rel = toPosix(path.relative(repoRoot, abs));
    const external = rel.startsWith("..") || path.isAbsolute(rel);
    const label = external ? toPosix(abs) : rel;
    const parsed = parseFile(abs, {
      file: label,
      selector: s.selector,
      roleScheme: s.role_scheme,
    });
    srcMeta.push({
      file: label,
      external,
      selector: s.selector,
      role_scheme: s.role_scheme,
      sha256: sha256File(abs),
      lines: parsed.stats.lines,
      clauses: parsed.stats.clauses,
      observation: parsed.stats.observation,
      fieldless: parsed.stats.fieldless,
      no_trigger: parsed.stats.no_trigger,
      unclassified: parsed.stats.unclassified,
      skipped_in_special_sections: parsed.stats.skipped_in_special_sections,
    });
    all.push(...parsed.clauses, ...parsed.observation);
  }

  // 排序基底 = (file, line, meta_line)：与磁盘上的行序一致，且与 Map 迭代序无关 ⇒ 幂等。
  all.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.meta_line - b.meta_line
  );
  assignIds(all);

  const roles = {};
  for (const c of all) roles[c.role] = (roles[c.role] || 0) + 1;

  const clauses = all.map((c) => ({
    id: c.id,
    file: c.file,
    line: c.line,
    line_end: c.line_end,
    meta_line: c.meta_line,
    role: c.role,
    zone: c.zone,
    section: c.section,
    title: c.title,
    n: c.n,
    first_seen: c.first_seen,
    trigger: c.trigger,
    baseline: c.baseline,
    self_declared: c.self_declared,
    judge_only: c.judge_only,
    observing: c.observing,
    shape: c.shape,
    body_excerpt: c.body_excerpt,
  }));

  return {
    _generated: {
      这是什么: "条款的机器面索引。**派生物，不是真相源** —— 改这个文件不会改变任何行为。",
      真相源: srcMeta.map((s) => s.file),
      改条款要改哪里: "改上面那些 Markdown 原文，然后重新生成本文件。",
      再生成: "node ccswitch/scripts/gen-clause-index.mjs",
      漂移检查: "node ccswitch/scripts/gen-clause-index.mjs --check（源变了而索引没跟上 ⇒ exit 1）",
      交叉对账: "node ccswitch/scripts/gen-clause-index.mjs --reconcile（与 check-clauses-structure.ps1 两套解析对数）",
      按官种渲染: "node ccswitch/scripts/render-clauses.mjs --role <官种>",
      生成器: "ccswitch/scripts/gen-clause-index.mjs",
      解析器: "ccswitch/lib/clause-parser.mjs",
      为什么没有时间戳:
        "有时间戳就没有幂等 —— 两次生成的字节会不同，`--check` 也就分不出「源变了」与「又跑了一次」。" +
        "要知道它什么时候生成的，看 git log；那个记录比自报的时间戳更难伪造。",
      不存全文的理由:
        "索引只存 line/line_end 指回原文。存全文＝手工双写的开端，而双写必漂移；" +
        "要全文的消费方回去读 Markdown（render-clauses.mjs 就是这么做的）。",
      schema_version: 1,
      sources: srcMeta,
      roles,
      totals: {
        clauses: clauses.filter((c) => c.zone === ZONE.CLAUSE).length,
        observation: clauses.filter((c) => c.zone === ZONE.OBSERVATION).length,
      },
    },
    clauses,
  };
}

// 序列化：2 空格缩进 + 末尾换行。键序由构建顺序决定、全程无 Date/Map 迭代 ⇒ 逐字节幂等。
export function serializeIndex(index) {
  return JSON.stringify(index, null, 2) + "\n";
}

// 默认源清单：**只含仓内文件**（理由见 buildIndex 头注）。
export function defaultSources() {
  return [
    { file: "ccswitch/dao.md", selector: SELECTOR.MARKED, role_scheme: ROLE_SCHEME.GENERAL },
    { file: "ccswitch/rules/dao-dispatch.md", selector: SELECTOR.MARKED, role_scheme: ROLE_SCHEME.GENERAL },
    { file: "ccswitch/rules/dao-guard-writing.md", selector: SELECTOR.MARKED, role_scheme: ROLE_SCHEME.GENERAL },
    { file: "ccswitch/rules/dao-legislation.md", selector: SELECTOR.MARKED, role_scheme: ROLE_SCHEME.GENERAL },
    { file: "ccswitch/rules/dao-longwindow.md", selector: SELECTOR.MARKED, role_scheme: ROLE_SCHEME.GENERAL },
    // 下面几份当前**零条款**（纯细则正文，元字段一个都没有）。**刻意留在清单里**：
    // 移出去等于「这几份文件从此没人看着」，而它们随时可能长出条款。零条款不是问题，
    // 「零条款」与「没扫过」分不开才是问题 —— 索引里 clauses:0 就是那个区分。
    { file: "ccswitch/rules/dao-powershell.md", selector: SELECTOR.MARKED, role_scheme: ROLE_SCHEME.GENERAL },
    { file: "ccswitch/rules/dao-change-batch.md", selector: SELECTOR.MARKED, role_scheme: ROLE_SCHEME.GENERAL },
    { file: "ccswitch/rules/dao-gui-verify.md", selector: SELECTOR.MARKED, role_scheme: ROLE_SCHEME.GENERAL },
    { file: "ccswitch/rules/dao-workitem.md", selector: SELECTOR.MARKED, role_scheme: ROLE_SCHEME.GENERAL },
    { file: "ccswitch/rules/dao-product.md", selector: SELECTOR.MARKED, role_scheme: ROLE_SCHEME.GENERAL },
    { file: "ccswitch/rules/dao-askuser.md", selector: SELECTOR.MARKED, role_scheme: ROLE_SCHEME.GENERAL },
  ];
}

export const DEFAULT_INDEX_REL = "ccswitch/clause-index.json";
