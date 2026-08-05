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
// ⚠ **「独立」是逐层成立的，不是整份文件成立**（2026-08-02 issue #91 的教训，写在这里
// 免得下一个人再把它读成整体断言）：节状态机那一层从第一天就是独立的，而**遮罩的配对层
// 曾经是 PS 侧的逐行直译** —— 同一份文件里可以一层独立、另一层直译，而头注只写了前者。
// ⇒ 加新逻辑时问的不是「本文件独不独立」，是「**我正在写的这一层**，对面是怎么走的」。
//
// ── 已知的近似与弱处（照直写，别把「解析出来了」读成「解析对了」）──────────────
//   · `title` 取的是「加粗判据句首」，那是**启发式**：没有加粗的老条款回退到「首个全角冒号
//     之前」，再退回到「前 N 个字」。两个方向都构造得出反例（标题里带冒号的会被截短；
//     整条没有句首判据的会拿到一句半截话）。它只用于**人读的索引与渲染标题**，不参与任何判定。
//   · `id` 是**内容指纹**不是长期标识符：改一个字（含把 `n=1` 改成 `n=2`）id 就变。
//     「同一条条款跨版本的稳定 id」是 v2 加的**行内 slug**（`[#<域>-<短名>]`）；两者各管一件事 ——
//     指纹答「内容变没变」，slug 答「这还是不是那一条」。
//   · `first_seen` 原样存 `MM-DD` 字符串，**刻意不补年份**：`@` 字段本来就没有年份，
//     补年份等于让派生物凭猜测产出原文里不存在的信息。要算年龄的消费方自己去挑年份
//     （PS 守卫的 `Resolve-ClauseDate` 就是那个判据，本文件不重造）。
//   · 「一行一条」是本解析器的**计数单位**：同一行出现两个元字段时只认第一个。
//     全库现无此形态，故不为它加判据（同 PS 守卫「不为假想敌立判据」的既定政策）。
//     ⚠ **`[自定@]` 是例外，且是实测出来的例外**：dao.md 有一行写着 `[自定@07-29] [自定@07-30]`，
//     只认第一个会**静默丢一个日期**，而那个日期正是「按日期整批撤回」这份授权对价的抓手。
//     故 `self_declared_all` 收全部，`self_declared` 保留首个（老消费方不变）。
//
// ── v2（批 2 · 台账搬家）改了哪三件事 ────────────────────────────────────────
//   ① **行内 slug**：条款行尾 `[#<域>-<短名>]`，是条款与 `ccswitch/clause-ledger.json` 的关联键。
//      台账数字（n / 首次入库 / 触发点 / 基线 / 自定 / 出处）的真相源自此是 ledger，正文只持 slug。
//   ② **选择器盲区修掉**：MARKED 原判据是 `[n=`，于是「带 `[基线:]` 或 `[自定@]` 却没有完整签名」
//      的行**结构上看不见**。可达性矩阵实测 dao.md 有 3 条这种（心跳铁律 / 越权 Grep / 在途水位线，
//      全是承重条款），dao-longwindow.md 另有 2 条。判据改为「带任一台账字段**或** slug」。
//   ③ **行内代码 span 一律遮罩**：正文里写 `` `[自定@<月日>]` `` 是在讲**格式**，不是一个标记。
//      不遮罩会给立法存根凭空造一个 ledger 条目（矩阵实测的那个假阳性，dao.md L262）。
//      遮罩形态是**等长空格**：先在遮罩串上定位，再按 group 下标回**原始串**切值 ——
//      直接拿遮罩串取值会把基线正文里合法的反引号内容一起吃掉（`归-根路径消歧` 的基线就有）。
//
// ── v3（批 3 · dao.md 重写）改了一件事：双轨期 → 单轨期 ──────────────────────
//   批 2 的对账契约是「**行内没写的字段，台账侧应为 null；台账反而有值 ⇒ 判红**」。
//   那一条只在**双轨期**成立 —— 它防的是「台账替正文编了一个值」，前提是正文本来该写。
//   批 3 把 dao.md 正文的 `[n= @ 触发:]` / `[基线:]` / `[自定@]` 整批删掉、只留 `[#slug]`
//   （台账搬家的终点，`clause-ledger.json` 的 `_doc` 写着「这份对账全绿是批 3 删旧字段的
//   前置门」）⇒ 那 20 条会逐字段判红 84 处，而那正是**设计要的终态**，不是缺陷。
//   **新契约（两条，方向不对称）**：
//     · 正文**写了**该字段 ⇒ 必须与台账相等，不等即红。**这一半一个字没改**，
//       11 份仍带行内字段的语料（officer/dispatch/guard-writing/legislation/longwindow）照旧受保护。
//     · 正文**没写**该字段 ⇒ 以台账为准，**不比对**。
//   **照直说这是放松，不是加强**：旧契约里「正文空、台账有值」是红，新契约里是绿 ——
//   新断言的通过集是旧断言通过集的**真超集**，与「改断言须证明更难满足」那条相反。
//   之所以仍然是对的，是因为**被比较的契约本身变了**（双轨 → 单轨），不是断言被放松以求绿。
//   **代价照直写**：此后「有人把某条的行内字段悄悄删掉」在机器通道上与「批 3 的正常终态」
//   不可区分。补偿是两个计数进 marker（`compared` / `ledgeronly`）—— 让「一条都没比过」
//   与「比过且没分歧」在输出上分得开（同本仓「零检出 ≠ 零存在」）。**它只让事情可见，
//   不阻止**；真要拦住「悄悄删字段」得靠 ledger 侧记一个「本条正文该不该带字段」的位，
//   那属判断档（谁来定哪份语料算单轨），本批不自定。
//   ⚠ `judge_only` 是 boolean，**缺席与显式 false 不可分** ⇒ 它跟着 `has_meta_field` 走：
//   整行连 `[n= @ 触发:]` 都没有时不比对。这是近似，照直标。

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
// v2：行内 slug。取值刻意允许中文（`[#帅-热重载]` 比 `[#c17]` 可读得多，而这一串是给人看的）；
// 唯一的形式约束是**不含空白、不含右方括号** —— 那两样会让「一行两个 slug」与「一个带空格的
// slug」不可区分。
export const SLUG_RE = /\[#([^\]\s]+)\]/;
// 「这一行带台账」的签名。**比完整元字段弱是刻意的**（同 CLAUSE_SIGNATURE_RE 的理由）：
// 字段写坏的行仍要进得了扫描面，才轮得到判据去报它。
export const LEDGER_SIGNATURE_RE = /\[n=|\[基线:|\[自定@/;

// 带 `d`（hasIndices）/ `g` 的内部副本。**不给上面那几个导出常量加标志位**：`g` 会让 `.exec`
// 变成有状态的，而它们是被别处直接消费的公开契约；这里另建一份，改标志位不波及消费方。
const META_FIELD_RE_D = new RegExp(META_FIELD_RE.source, "d");
const BASELINE_RE_D = new RegExp(BASELINE_RE.source, "d");
const SELF_AUTHORED_RE_DG = new RegExp(SELF_AUTHORED_RE.source, "dg");
const SLUG_RE_DG = new RegExp(SLUG_RE.source, "dg");

/**
 * 反引号**游程**（连续反引号串）扫描：返回 [{ start, len }]，按出现次序。
 * `start`/`len` 都是 **UTF-16 码元**下标 —— 与正则 `indices` 同一套坐标系，
 * 这样遮罩串与原始串才对得上（正文里有 📌/🔴 这类代理对，按码点切会错位）。
 */
export function backtickRuns(raw) {
  const runs = [];
  const re = /`+/g;
  let m;
  while ((m = re.exec(raw)) !== null) runs.push({ start: m.index, len: m[0].length });
  return runs;
}

/**
 * 按 **CommonMark 的游程配对规则**把游程配成代码 span：长度为 L 的开启游程，
 * 由其后**第一个长度恰为 L** 的游程闭合；中间的游程都在 span 内部。
 * 找不到等长游程的开启游程是**普通文本**，扫描继续往后走（后面的游程照样能开新 span）。
 *
 * 返回 { spans: [{from,to}], unmatched: [start…] }（下标含首含尾）。
 *
 * ── 2026-08-02 重写了配对层（issue #91），照直写为什么 ─────────────────────────
 * **旧写法是 PS 侧 `Get-BacktickSpans` 的逐行直译**：变量名（runs/spans/unmatched/r/open/
 * closeIdx/close/k）、循环形状、分支顺序完全对应 —— 由对抗验证官逐行核出。于是
 * **`--reconcile` 对「配对规则本身对不对」判别力≈0**：两侧会以同一种方式一起错、差恒为 0。
 * 而本文件开头「为什么不复用 PS 那套解析」讲的正是禁止这件事。
 *
 * **新写法走另一条路**：先把游程**按长度分桶**（长度 → 该长度游程在 runs 里的下标队列），
 * 配对时**只在同长度那一桶里**取第一个下标大于游标的成员。对照 PS 侧那边是
 * 「从开启游程往后**逐个游程比长度**」—— 一个按位置筛、一个按长度筛，两边内层循环
 * 遍历的根本不是同一个集合：
 *   · 「长度比较写错」在本侧没有对应位置（长度已经是桶的键，不参与比较）；
 *   · 「桶的下标序写错」在 PS 侧没有对应位置（那边压根没有桶）。
 *
 * ⚠ **诚实边界，别把这次重写读成「从此两边不可能一起错」**：两侧仍在实现同一份 CommonMark
 * 契约，**契约本身被读错时两边照样一起错**（例如都以为"碰到下一个反引号就闭合"）。
 * 真正兜住「同错」的是**第三套实现**：PS 侧 `Get-MaskedLineAlt`（逐字符扫描，普查专用）
 * 与它对主实现的逐字节互核（check-clauses-structure.ps1 检查 5d），其结论经末行
 * `maskdiv=` 带进 `--reconcile` 判红。本次重写解掉的是另一条更现实的路径 ——
 * **两边代码长得一样时，改一处几乎必然被照抄到另一处**。
 */
export function backtickSpans(raw) {
  const runs = backtickRuns(raw);
  // 分桶：游程长度 → 该长度的游程在 runs 里的下标（按建表顺序天然升序）。
  const byLen = new Map();
  for (let idx = 0; idx < runs.length; idx++) {
    const size = runs[idx].len;
    if (!byLen.has(size)) byLen.set(size, []);
    byLen.get(size).push(idx);
  }
  const spans = [];
  const unmatched = [];
  let cursor = 0;
  while (cursor < runs.length) {
    // 桶必非空：游标所指的这个游程自己就在里面。
    const sameLen = byLen.get(runs[cursor].len);
    let closer = -1;
    for (const idx of sameLen) {
      if (idx > cursor) { closer = idx; break; }
    }
    if (closer < 0) { unmatched.push(runs[cursor].start); cursor += 1; continue; }
    spans.push({ from: runs[cursor].start, to: runs[closer].start + runs[closer].len - 1 });
    cursor = closer + 1;
  }
  return { spans, unmatched };
}

/**
 * 把行内代码 span（一对反引号之间的内容，含反引号本身）替换成**等长空格**。
 *
 * 等长是硬要求，不是讲究：下游按遮罩串上的 group 下标回原始串切值，长度一变下标就错位。
 *
 * ── 未闭合反引号：2026-08-02 反转了处置 ────────────────────────────────────
 * **旧行为**：从未闭合的那个反引号起到行尾一律当代码，注释里的理由是「宁可少认一个标记，
 * 多认会凭空造出一个 ledger 条目，而少认会被 missing-slug / orphan 从另一侧报出来」。
 * **实测两半都不成立**：
 *   ① 「少认」的实际后果不是漏报，是**合法条款被整条吃掉**。正文里写一处 ```bash
 *      这样的写法示例（游程长度 3、无等长游程闭合）就够了 —— 行尾元字段被遮成空格。
 *   ② 后果分两种，**静默那种更险**：选择器读的就是遮罩串 ⇒ 该行整条**退出扫描面**，
 *      条款数静默少一条而**退出码不变**（实测 mousse 条款库 clauses=75，实际 76，
 *      两次都是 exit 0）；只有当它恰好被 AllTopLevel 选中时才报成 missing-meta-field 假阳性。
 *   ③ 「会被另一侧报出来」只在接了 ledger 的文件上成立；没接 ledger 的条款库没有另一侧。
 *
 * **新行为**：未闭合游程 = 普通文本，不遮罩（见 backtickSpans）。判据优先级是
 * **「合法条款不许被误判」高于「代码 span 假阳性」**，且新行为与人在渲染页面上看到的一致。
 * 让出的那一格照直写：未闭合游程之后的模板字面量会被当成真标记 —— 但那要求正文本身是
 * 坏 markdown，且失败是**响的**（多一条 violation），不是静默的。
 * **闭合的** span 照旧遮罩，原先要防的假阳性防护不变。
 *
 * ⚠ **与 PS 侧的独立性是分层的，逐层读**（2026-08-02 由 issue #91 补齐配对层那一格；
 *   此前那一格是「逐行直译」，由对抗验证官核出）。当前实况：
 *     · **游程扫描器** —— 独立（本侧正则 `/`+/g`，PS 侧手写字符循环）
 *     · **配对层**（`backtickSpans` ↔ PS `Get-BacktickSpans`）—— **已重写为不同算法路径**：
 *       本侧按长度分桶后在桶内按位置取，PS 侧线性向后逐个比长度（见 `backtickSpans` 头注）。
 *     · **遮罩拼装**   —— 独立（本侧按区间切片重拼，PS 侧改 char 数组）
 *   ⇒ `--reconcile` 现在对配对规则**有**判别力（只改一侧必分岔）。
 *   🕳 **它仍然抓不到的那一格，照直写**：两侧**同时**按同一种方式错（同一个契约误读）时
 *     差仍为 0。兜它的是 PS 侧的**第三套遮罩实现** `Get-MaskedLineAlt` 与检查 5d 的逐字节
 *     互核，其结论经末行 `maskdiv=` 带进本侧对账判红（见 gen-clause-index.mjs 的 okMask）。
 *     再往上一层 —— **三套一起错** —— 没有任何对账抓得到，那是算术不是疏漏。
 */
export function maskCodeSpans(raw) {
  const { spans } = backtickSpans(raw);
  if (spans.length === 0) return raw;
  // 按区间切片重拼：`" ".repeat()` 的长度用码元数算，故 out.length === raw.length 恒成立。
  let out = "";
  let pos = 0;
  for (const s of spans) {
    out += raw.slice(pos, s.from);
    out += " ".repeat(s.to - s.from + 1);
    pos = s.to + 1;
  }
  return out + raw.slice(pos);
}

// 在遮罩串上定位、回原始串取值。`idx` 是 `m.indices[k]`（可能是 undefined —— 未参与匹配的组）。
function sliceByIndices(raw, idx) {
  return idx ? raw.slice(idx[0], idx[1]) : null;
}

// H2 节标题：**恰两个 `#` 后跟空白**。`### 三级标题` 不重置节状态 —— 这一条与 PS 侧
// 的 `^##\s` 语义相同，是被检文件的组织约定，不是抄来的技巧。
const H2_RE = /^##\s/;
const SPECIAL_SECTION_RE = /^##\s*📌/;
const OBSERVATION_SECTION_RE = /^##\s*观察区/;
const FENCE_RE = /^```/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s/;

export const SELECTOR = {
  // **v2 判据**：带任一台账字段（`[n=` / `[基线:` / `[自定@`）**或**行内 slug 的行即条款候选，
  // 不论缩进、不论是不是列表项；行内代码 span 内的一律不算。
  // 适用于「条款与散文混装」的文件（dao.md / ccswitch/rules/*.md）。
  // v1 判据只有 `[n=`，实测漏掉 5 条真条款（dao.md 3 · dao-longwindow.md 2）——见文件头 v2 ②。
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

function selectorHit(raw, masked, selector) {
  if (selector === SELECTOR.ALL_TOP_LEVEL) return raw.startsWith("- ");
  if (selector === SELECTOR.MARKED) return LEDGER_SIGNATURE_RE.test(masked) || SLUG_RE.test(masked);
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
    const masked = maskCodeSpans(raw);
    const t = raw.trim();
    if (H2_RE.test(t)) continue; // 标题行本身不是条款
    const sec = sectionOf(sections, i);
    if (sec && sec.kind === "special") {
      // `## 📌` 节整节跳过：那里是「怎么写条款」的元文档，里面的样例长得和条款一样。
      if (LEDGER_SIGNATURE_RE.test(masked) || SLUG_RE.test(masked)) skippedSpecial++;
      continue;
    }
    if (!selectorHit(raw, masked, selector)) continue;

    const m = META_FIELD_RE_D.exec(masked);
    const bs = blockStart(lines, mask, i, sec ? sec.start : 0);
    const be = blockEnd(lines, mask, i, sec ? sec.end : lines.length - 1);
    const blockText = lines.slice(bs, be + 1).join("\n");
    const zone = sec && sec.kind === "observation" ? ZONE.OBSERVATION : ZONE.CLAUSE;

    SLUG_RE_DG.lastIndex = 0;
    const slugHits = [...masked.matchAll(SLUG_RE_DG)].map((x) => sliceByIndices(raw, x.indices[1]));
    SELF_AUTHORED_RE_DG.lastIndex = 0;
    const selfAll = [...masked.matchAll(SELF_AUTHORED_RE_DG)].map((x) => sliceByIndices(raw, x.indices[1]));
    const b = BASELINE_RE_D.exec(masked);

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
      // slug：一行多个是**结构错**（关联键必须唯一），如实记全部由消费方判红，
      // 这里不替它挑一个 —— 挑一个等于把错误藏进派生物。
      slug: slugHits.length === 1 ? slugHits[0] : null,
      slugs: slugHits,
    };

    const rec = {
      id: null, // 由 assignIds 填（要全局去重，单文件里定不了）
      ...base,
      // v2：行内元字段可以缺席 —— 缺席时台账在 ledger 里，这三个字段如实为 null。
      // **不从 ledger 回填进来**：回填会让「正文说的」与「台账说的」在派生物里合流，
      // 而双轨对账要比的正是这两者。合流之后那个对账恒为真。
      n: m ? sliceByIndices(raw, m.indices[1]) : null,
      first_seen: m ? sliceByIndices(raw, m.indices[2]) : null,
      trigger: m ? sliceByIndices(raw, m.indices[3]) : null,
      has_meta_field: !!m,
      baseline: b ? sliceByIndices(raw, b.indices[1]) : null,
      self_declared: selfAll.length ? selfAll[0] : null,
      self_declared_all: selfAll,
      judge_only: masked.includes(JUDGE_ONLY_MARK),
      observing: masked.includes(OBSERVING_MARK),
      _fingerprint_src: blockText,
    };

    // 分堆判据（v2）：**有完整元字段 或 有 slug** ⇒ 它是一条条款。
    // 两者皆无 ⇒ fieldless。这一支只在 ALL_TOP_LEVEL 下够得着（那个选择器不看字段），
    // 它检的是「整条丢掉台账」，是 mousse 型条款库的真硬闸，v2 不动它。
    if (!m && slugHits.length === 0) {
      fieldless.push({ ...base, reason: "合选择器但无完整元字段、也无 slug" });
      continue;
    }
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
    // v2 三个：`slug` 是与 ledger 对得上的那批；`no_slug` 是**还没上 slug** 的条款；
    // `no_meta_field` 是行内元字段缺席、台账只在 ledger 里的那批（双轨期的另一头）。
    slug: clauses.filter((c) => c.slug).length,
    no_slug: clauses.filter((c) => !c.slug).length,
    no_meta_field: clauses.filter((c) => !c.has_meta_field).length,
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

// ── 台账（clause-ledger.json）────────────────────────────────────────────────
// ledger 是**台账字段的真相源**，Markdown 仍是**正文的真相源**。本文件只负责把两边对上，
// 不负责合并它们 —— 合并之后「两边说的不一样」这个信号就没了。
export const DEFAULT_LEDGER_REL = "ccswitch/clause-ledger.json";

export function loadLedger(absPath) {
  if (!fs.existsSync(absPath)) return { ok: false, why: "不存在", path: absPath, clauses: {} };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch (e) {
    return { ok: false, why: `不是合法 JSON：${e && e.message ? e.message : String(e)}`, path: absPath, clauses: {} };
  }
  if (!doc || typeof doc.clauses !== "object" || doc.clauses === null) {
    return { ok: false, why: "缺 clauses 字段（或它不是对象）", path: absPath, clauses: {} };
  }
  return { ok: true, path: absPath, schema_version: doc.schema_version, clauses: doc.clauses };
}

const arrEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * 正文 ↔ 台账的双向对账。
 *
 * @param {object[]} records  一批条款记录（parseClauses 的 clauses + observation）
 * @param {object}   ledger   loadLedger 的返回
 * @param {string[]} scope    本次**在扫描面里**的文件标识列表。ledger 里 file 不在这个集合中的
 *                            条目算 `out_of_scope`（不判红——守卫一次只看一份文件时它是常态），
 *                            由调用方决定要不要在「跑的是默认全量清单」时把它升成红。
 * @returns {{missingSlug, dupSlug, orphanSlug, orphanLedger, fileMismatch, mismatch, outOfScope, checked}}
 *
 * **判红面（四类结构错，两个方向都覆盖）**：
 *   · missing-slug   正文是条款却没 slug ⇒ 它进不了台账，等于台账对它失明
 *   · orphan-slug    正文有 slug 而台账无此条 ⇒ 指向空气的指针
 *   · orphan-ledger  台账有条目而正文找不到它的 slug ⇒ 条款被删/改名而台账没跟上
 *   · dup-slug / file-mismatch / 双轨值不等
 */
export function reconcileLedger(records, ledger, scope) {
  const inScope = new Set(scope || []);
  const missingSlug = [];
  const dupSlug = [];
  const orphanSlug = [];
  const fileMismatch = [];
  const mismatch = [];
  const seen = new Map();
  // v3 两个计数：`compared` = 真正比过的字段数（分母）· `ledgerOnly` = 正文没这一栏、以台账为准的字段数。
  // 两个都进 marker，是为了让「一条都没比过」与「比过且没分歧」在输出上分得开。
  let compared = 0;
  let ledgerOnly = 0;

  for (const r of records) {
    if (r.slugs && r.slugs.length > 1) {
      dupSlug.push({ file: r.file, line: r.meta_line, slug: r.slugs.join(" / "), why: "同一行两个 slug" });
      continue;
    }
    if (!r.slug) {
      missingSlug.push({ file: r.file, line: r.meta_line, title: r.title });
      continue;
    }
    if (seen.has(r.slug)) {
      dupSlug.push({
        file: r.file, line: r.meta_line, slug: r.slug,
        why: `与 ${seen.get(r.slug).file}:${seen.get(r.slug).line} 重名`,
      });
      continue;
    }
    seen.set(r.slug, { file: r.file, line: r.meta_line });

    const e = ledger.clauses[r.slug];
    if (!e) {
      orphanSlug.push({ file: r.file, line: r.meta_line, slug: r.slug });
      continue;
    }
    if (e.file !== r.file) {
      fileMismatch.push({ slug: r.slug, inText: r.file, inLedger: e.file, line: r.meta_line });
    }
    // ── 单轨对账（v3）：**正文写了才比，没写以台账为准** ──────────────────────
    // 契约与它为什么变了，见文件头 v3 段。`present` 是「正文这一栏在不在」，
    // 每个字段各自判 —— 不用一个总开关，因为一条可以有 `[基线:]` 而没有 `[n= @ 触发:]`。
    const cmp = (name, present, mine, theirs) => {
      if (!present) { ledgerOnly++; return; }
      compared++;
      if (mine === theirs) return;
      mismatch.push({ slug: r.slug, file: r.file, line: r.meta_line, field: name, inText: mine, inLedger: theirs });
    };
    const hasMeta = !!r.has_meta_field;
    cmp("n", hasMeta, r.n, e.n === undefined ? null : e.n);
    cmp("first_seen", hasMeta, r.first_seen, e.first_seen === undefined ? null : e.first_seen);
    cmp("trigger", hasMeta, r.trigger, e.trigger === undefined ? null : e.trigger);
    // judge_only 是 boolean，缺席与显式 false 不可分 ⇒ 跟着 has_meta_field 走（近似，见头注 v3）。
    cmp("judge_only", hasMeta, r.judge_only, !!e.judge_only);
    cmp("baseline", r.baseline !== null, r.baseline, e.baseline === undefined ? null : e.baseline);
    const theirSelf = Array.isArray(e.self_authored) ? e.self_authored : [];
    const mineSelf = r.self_declared_all || [];
    if (mineSelf.length === 0) {
      ledgerOnly++;
    } else {
      compared++;
      if (!arrEq(mineSelf, theirSelf)) {
        mismatch.push({
          slug: r.slug, file: r.file, line: r.meta_line, field: "self_authored",
          inText: mineSelf.join(","), inLedger: theirSelf.join(","),
        });
      }
    }
  }

  const orphanLedger = [];
  const outOfScope = [];
  for (const [slug, e] of Object.entries(ledger.clauses)) {
    if (e && e.status === "retired") continue; // 已退役：正文本就该没有它
    if (!inScope.has(e && e.file)) { outOfScope.push({ slug, file: e && e.file }); continue; }
    if (!seen.has(slug)) orphanLedger.push({ slug, file: e.file });
  }

  return {
    missingSlug, dupSlug, orphanSlug, orphanLedger, fileMismatch, mismatch, outOfScope,
    checked: seen.size, compared, ledgerOnly,
  };
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
      slug: parsed.stats.slug,
      no_slug: parsed.stats.no_slug,
      no_meta_field: parsed.stats.no_meta_field,
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
    slug: c.slug,
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
    self_declared_all: c.self_declared_all,
    has_meta_field: c.has_meta_field,
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
      再生成: REGEN_CMD,
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

// ── 派生物的**自洽性**审计（issue #121）──────────────────────────────────────
/**
 * 只看盘上这份索引**自己跟自己对不对得上**，**完全不读真相源**。
 *
 * ── 为什么非要有这么一个只看自己的检查 ───────────────────────────────────────
 * 索引是派生物，而 git 会把两份**各自正确**的派生物**文本合并**成一份不正确的：
 * 两侧各加一条条款 ⇒ `clauses` 数组把两条都收了（对），而 `_generated.totals.clauses`
 * 那一行**两侧改的是同一行、且改成同一个值**（95→96）⇒ git 认为「双方做了相同的修改」，
 * 无冲突地留下 96，而实际已经是 97。**于是合并产物的签名就是「它自己跟自己对不上」。**
 *
 * 这一格把「谁干的」从猜测变成判据（此前报文一律断言「是索引本身被手改了」——
 * 在合并场景那句话是**假的**，而它会把读者支去查一件从未发生的事）：
 *   · 自相矛盾            ⇒ **合并**制造的（没有人做错任何事）
 *   · 自洽但与真相源不符  ⇒ 手改，或生成器/解析器改了而索引没跟着重生成
 *
 * ── 判别力的方向照直写：有则必真，无则不知 ─────────────────────────────────
 * 反过来**不成立** —— 一次「两侧各改一条已有条款的正文、条数不变」的合并是**自洽的**，
 * 那时本函数报干净，归因会落到「手改」那一档。它能把一类合并**认出来**，
 * 不能证明「没报问题 ⇒ 不是合并」。别把 `problems.length === 0` 读成「排除了合并」。
 *
 * @returns {{readable:boolean, why:string|null, problems:string[], counted:object}}
 */
export function auditIndexSelfConsistency(doc) {
  const problems = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { readable: false, why: "不是一个 JSON 对象", problems, counted: {} };
  }
  if (!Array.isArray(doc.clauses)) {
    return { readable: false, why: "没有 clauses 数组", problems, counted: {} };
  }
  const g = doc._generated;
  if (!g || typeof g !== "object") {
    return { readable: false, why: "没有 _generated 段", problems, counted: {} };
  }
  const arrClause = doc.clauses.filter((c) => c && c.zone === ZONE.CLAUSE).length;
  const arrObs = doc.clauses.filter((c) => c && c.zone === ZONE.OBSERVATION).length;
  const counted = { array_clause: arrClause, array_observation: arrObs, array_total: doc.clauses.length };

  const t = g.totals && typeof g.totals === "object" ? g.totals : null;
  if (!t) problems.push("_generated.totals 段不在（这份索引缺了它自己的总账）");
  else {
    if (t.clauses !== arrClause) {
      problems.push(`_generated.totals.clauses 写着 ${t.clauses}，而 clauses 数组里 zone=clause 的有 ${arrClause} 条`);
    }
    if (t.observation !== arrObs) {
      problems.push(`_generated.totals.observation 写着 ${t.observation}，而数组里 zone=observation 的有 ${arrObs} 条`);
    }
  }

  if (Array.isArray(g.sources)) {
    const sumC = g.sources.reduce((a, s) => a + (Number(s && s.clauses) || 0), 0);
    const sumO = g.sources.reduce((a, s) => a + (Number(s && s.observation) || 0), 0);
    counted.sources_clause = sumC;
    if (sumC !== arrClause) problems.push(`各源自报的条款数加起来是 ${sumC}，而 clauses 数组里只有 ${arrClause} 条 zone=clause`);
    if (sumO !== arrObs) problems.push(`各源自报的观察区条目加起来是 ${sumO}，而数组里只有 ${arrObs} 条`);
  } else {
    problems.push("_generated.sources 不是数组（逐源账目缺席）");
  }

  if (g.roles && typeof g.roles === "object") {
    const sumR = Object.values(g.roles).reduce((a, v) => a + (Number(v) || 0), 0);
    counted.roles_sum = sumR;
    if (sumR !== doc.clauses.length) {
      problems.push(`_generated.roles 各官种加起来是 ${sumR}，而 clauses 数组一共 ${doc.clauses.length} 条`);
    }
  } else {
    problems.push("_generated.roles 不是对象（官种分布缺席）");
  }

  // id 重名：文本合并把同一条条款的两个版本都收进来时会长这样。
  const ids = doc.clauses.map((c) => c && c.id).filter((x) => x != null);
  const dup = ids.length - new Set(ids).size;
  counted.dup_id = dup;
  if (dup > 0) problems.push(`clauses 里有 ${dup} 个重复的 id（同一条被收了两遍，文本合并的典型形态）`);

  return { readable: true, why: null, problems, counted };
}

// 默认源清单：**只含仓内文件**（理由见 buildIndex 头注）。
export function defaultSources() {
  return [
    { file: "ccswitch/dao.md", selector: SELECTOR.MARKED, role_scheme: ROLE_SCHEME.GENERAL },
    { file: "ccswitch/rules/dao-dispatch.md", selector: SELECTOR.MARKED, role_scheme: ROLE_SCHEME.GENERAL },
    { file: "ccswitch/rules/dao-guard-writing.md", selector: SELECTOR.MARKED, role_scheme: ROLE_SCHEME.GENERAL },
    { file: "ccswitch/rules/dao-legislation.md", selector: SELECTOR.MARKED, role_scheme: ROLE_SCHEME.GENERAL },
    { file: "ccswitch/rules/dao-longwindow.md", selector: SELECTOR.MARKED, role_scheme: ROLE_SCHEME.GENERAL },
    // **唯一一份带官种分节的源**（2026-08-02 加）。此前带分节的语料只住在各项目仓，于是
    // `render-clauses.mjs --role implementer` 之类恒为 0 条 —— 那正是 dao-subagent-clauses
    // 这个 hook 的官种分支渲染不出东西的原因。它进清单同时打开三件事：索引里有官种、
    // 台账（clause-ledger.json）把它纳入扫描面（不纳入的话它的 59 条会全部落进 out_of_scope
    // 而在默认清单下判红）、`--reconcile` 拿它当第三份真语料对数。
    // selector 用 **all-top-level** 而不是 marked：这份文件「整份就是条款列表」，该选择器
    // 才检得出「某条整个丢掉台账」（marked 看不见没有字段的行，那条会静默不存在）。
    { file: "ccswitch/rules/dao-officer-clauses.md", selector: SELECTOR.ALL_TOP_LEVEL, role_scheme: ROLE_SCHEME.DISPATCH_SECTIONS },
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

// 再生成命令的**唯一真相源**：索引头注里的「再生成」栏与失败报文里的处方是同一条命令，
// 两处各写一份必漂移（而漂移出来的那条错命令，读者会照着敲）。
export const REGEN_CMD = "node ccswitch/scripts/gen-clause-index.mjs";
