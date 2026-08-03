// clause-index 回归网 — ccswitch/lib/clause-parser.mjs + gen-clause-index.mjs + render-clauses.mjs
//
// 跑法：node tests/clause-index.tests.js     （全绿 exit 0，任一红 exit 1）
//       node scripts/run-tests.mjs           （自动发现本文件，无需登记）
//
// ── 这个回归网要钉住什么 ─────────────────────────────────────────────────────
// 被测对象是一份**派生物**（索引）+ 两个生成它/消费它的脚本。派生物最典型的死法不是崩，
// 而是**它自己变瞎了却照样输出一份看起来正常的东西**：解析漏一整节 ⇒ 条款少了 ⇒ 索引
// 仍是合法 JSON、仍渲染得出、`--check` 仍绿（它拿自己的解析和自己的解析比）。
// 故断言分四类，缺一不可：
//   正控 —— 三类语料都要解析得出，且关键字段（跨行块的块首行号、官种归属）逐个钉住
//   对账 —— 与 check-clauses-structure.ps1（**另一套独立实现**）逐文件对数；不一致即红
//   负控 —— 不认识的官种 / 认识但零条 / 缺参数 / 索引过期 一律报错，**不许空过**
//   mutation + canary —— 把解析正则**双向**改坏，对账必须变红；且每次先确认变异体还活着
//
// ── mutation 为什么要双向 ────────────────────────────────────────────────────
// 「12 次 mutation 全在让门变松这一侧 ⇒ 5 条负控一次都没红过」是本仓实证过的形态。
// 这里两向各一个：① 元字段正则收窄 ⇒ 我方少数（0 条）② 观察区节判定失效 ⇒ 我方多数
// （观察区条目被当成条款）。只做①的话，「多数」那一侧的判别力从未被验过。
//
// ── canary：读红集之前先回答「这一版还跑得起来吗」──────────────────────────
// 一个把被测对象弄死的 mutation 会让每条断言都红，而那正是「判别力强」的表象。
// 故每个变异体都先验两件事：㈠进程仍打得出末行契约（没崩）㈡**对方**（PS 侧）数出的数
// 与基线逐字相同（靶子没被动过）。两条都成立时，红才是我方解析真的变瞎了。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");

const REPO = path.resolve(__dirname, "..");
const LIB = path.join(REPO, "ccswitch", "lib", "clause-parser.mjs");
const GEN = path.join(REPO, "ccswitch", "scripts", "gen-clause-index.mjs");
const RENDER = path.join(REPO, "ccswitch", "scripts", "render-clauses.mjs");
const PS_SCRIPT = path.join(REPO, "ccswitch", "scripts", "check-clauses-structure.ps1");
const TMP = path.join(REPO, "_tmp", "clause-index-tests");
const FIX = path.join(TMP, "fixtures");
// 第三语料：**带官种分节**的真实条款库。它是验解析器通用性最硬的一份 —— 其余两类语料
// （dao.md 与自带夹具）一个没有官种分节、一个规模太小。
//
// **2026-08-02 换了语料**：这里原先指的是 `D:/frank/mousse-cli/docs/rules/dispatch-clauses.md`
// —— 一个**本机绝对路径 + 另一个仓的文件**，于是这一段只在「那台机器上恰好有那个仓」时
// 才真的跑；换台机器它走 else 分支，输出一行「本轮未验」然后照常绿。**dao 的回归网不该
// 由某个项目仓的存在与否决定跑不跑**（也正是同日拆分批要拆的倒置依赖）。官侧条款库搬进本仓后，
// 这份语料随仓走、无条件在场，缺席分支连带消失。
// 代价照直写，**两格**：①它**不带观察区**（观察区仍在项目侧），那一格改由自带夹具覆盖，
// 见 FIX_ROLES；②它**没有 `## 📌` 节**，于是原语料那条「📌 节里的样例全在反引号内 ⇒ 遮罩后
// 跳过数恰为 0」的**真数据**正控在它身上恒真、判别力为 0 —— 已用合成夹具把两态补回来（见 ①
// 那一组末尾），但合成夹具证不了真文件里那几行长什么样，这一格是**降级**不是等价替换。
const OFFICER = path.join(REPO, "ccswitch", "rules", "dao-officer-clauses.md");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ->  " + String(detail).slice(0, 700) : "")); }
}

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function w(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}
function runNode(script, args, opts) {
  const r = spawnSync(process.execPath, [script].concat(args || []), {
    encoding: "utf8", timeout: 600000, cwd: (opts && opts.cwd) || REPO,
  });
  const out = String(r.stdout || "");
  return {
    code: r.status, out, err: String(r.stderr || ""),
    index: /CLAUSE_INDEX_SUMMARY exit=(\d+) sources=(\d+) clauses=(\d+) observation=(\d+) drift=(\S+) wrote=(\d+)/.exec(out),
    rec: /CLAUSE_RECONCILE_SUMMARY exit=(\d+) host=(\S+) files=(\d+) matched=(\d+) mismatched=(\d+) mine=(\d+) theirs=(\d+) myslugs=(\d+) theirslugs=(\d+)/.exec(out),
    render: /CLAUSE_RENDER_SUMMARY exit=(\d+) role=(\S+) general=(\d+) role_clauses=(\d+) stale=(\d+) unclassified=(\d+)/.exec(out),
  };
}
const idx = (m) => (m ? { exit: +m[1], sources: +m[2], clauses: +m[3], observation: +m[4], drift: m[5], wrote: +m[6] } : null);
const rec = (m) => (m ? { exit: +m[1], host: m[2], files: +m[3], matched: +m[4], mismatched: +m[5], mine: +m[6], theirs: +m[7], myslugs: +m[8], theirslugs: +m[9] } : null);
const ren = (m) => (m ? { exit: +m[1], role: m[2], general: +m[3], role_clauses: +m[4], stale: +m[5], unclassified: +m[6] } : null);

// ── 夹具 ────────────────────────────────────────────────────────────────────
// 刻意不拿真实条款库做 mutation / drift 的靶：改真文件是有副作用的动作，而一个回归网
// 不该在跑的过程中动被守对象。夹具是自带的、可随便改的。
const FIX_A = path.join(FIX, "corpus-a.md");
const FIX_ROLES = path.join(FIX, "corpus-roles.md");
const FIX_A_TEXT = [
  "# 夹具条款库 A",
  "",
  "## 通用节",
  "",
  "- **甲条**：一条普通条款。 [n=1 @07-01 触发:无] [仅判据·无触发]",
  "- **乙条**：另一条。 [n=2 @07-02 触发:PR流程] [基线:未测]",
  "",
  "## 实现官节",
  "",
  "- **丙条**：实现官专属。 [n=? @07-03 触发:模板首行] [自定@07-03]",
  "",
  "## 观察区（判断类候选 · 复发即升格）",
  "",
  "- **丁候选**：还不是条款。 [n=1 @07-04 触发:无] [观察中]",
  "",
].join("\n");
const FIX_ROLES_TEXT = [
  "# 夹具条款库 · 多官种",
  "",
  "## 通用节（任意官种派单都应带）",
  "",
  "- **通用甲**：MARK-GENERAL 内容。 [n=1 @07-01 触发:模板首行]",
  "",
  "## 实现官节",
  "",
  "- **实现甲**：MARK-IMPL 内容。 [n=1 @07-02 触发:PR流程]",
  "",
  "## 对抗验证官节",
  "",
  "- **对抗甲**：MARK-ADV 内容。 [n=1 @07-03 触发:模板首行]",
  "",
  "## 杂项节",
  "",
  "- **杂项甲**：MARK-STRAY 内容。 [n=1 @07-05 触发:无] [仅判据·无触发]",
  "",
  "## 观察区（判断类候选 · 复发即升格）",
  "",
  "- **候选甲**：MARK-OBS 内容。 [n=1 @07-04 触发:无] [观察中]",
  "",
  // 📌 特殊节：整节跳过但**要报数**（静默跳过与零命中在输出上不可区分）。
  // 这一格 2026-08-02 前只由「项目仓那份真语料」覆盖 —— 那台机器上没有那个仓就静默不验，
  // 正是本条自己在防的病。移进自带夹具后它无条件跑。
  "## 📌 条款元字段（元文档节，整节不算条款）",
  "",
  "- **这行长得像条款但住在 📌 节里**：不该被算进去。 [n=1 @07-06 触发:无] [仅判据·无触发]",
  "",
].join("\n");

// 「行内只有 `[基线:]`/`[自定@]`、没有完整签名」这个形态的专用夹具。
//
// ── 2026-08-04 换语料，照直写为什么 ─────────────────────────────────────────
// 下面 ①.4 那组断言原先拿**真仓 dao.md** 当语料，判据写死「no_meta_field === 3」与
// 「dao.md 有一行写着两个日期」。批 3 把 dao.md 正文清成**单轨**（`[n= @ 触发:]`/`[基线:]`/
// `[自定@]` 整批删掉、只留 `[#slug]`）之后，那个形态在 dao.md 里**一条都不剩**
// （实测 clauses:20 / no_meta_field:20 / self_declared:0）⇒ 两条断言必红。
//
// **红的是语料，不是解析器**：`ccswitch/rules/*.md` 与各项目仓里这种行仍大量存在，
// 解析器必须继续读得出它们（v2 把选择器从「只认 `[n=`」放宽到「任一台账字段或 slug」正是
// 为了它们）。故把语料换成夹具 —— 测的仍是**解析能力**，不再是「dao.md 此刻长什么样」，
// 而后者随每一次重写批变动，本就不该被一条断言当成判据钉死。
//
// **删掉断言、或把它改成恒真**是另外两条路，都没走：那等于用「守卫看不到样本」冒充
// 「守卫没发现问题」—— 本仓守卫铁律第一句点名的就是这个病。夹具之外另加一条**真语料
// 前提检查**（见 ①.4 末），让「这个形态在真语料里彻底没了」出声而不是静默。
const FIX_META = path.join(FIX, "corpus-meta.md");
const FIX_META_TEXT = [
  "# 夹具条款库 · 单轨形态（v1 选择器结构上看不见的那几格）",
  "",
  "## 通用节",
  "",
  "- **甲条**：只带基线、没有完整签名。 [基线:未测] [#夹-仅基线]",
  "- **乙条**：只带自定、没有完整签名。 [自定@07-30] [#夹-仅自定]",
  "- **丙条**：一行写了两个自定日期。 [自定@07-29] [自定@07-30] [#夹-双自定]",
  "- **丁条**：对照条，签名完整（负控：它不该被算进 no_meta_field）。 [n=1 @07-05 触发:PR流程] [基线:未测] [#夹-完整签名]",
  "- **戊条**：只带基线且连 slug 都没有 —— 两条路都不通，该落 fieldless 而不是静默消失。 [基线:未测]",
  "",
].join("\n");

function sourcesJson(file, list) {
  w(file, JSON.stringify({ sources: list }, null, 2) + "\n");
  return file;
}

async function main() {
  rm(TMP);
  w(FIX_A, FIX_A_TEXT);
  w(FIX_ROLES, FIX_ROLES_TEXT);
  w(FIX_META, FIX_META_TEXT);

  const lib = await import(pathToFileURL(LIB).href);

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ① 解析基本面：三类语料都要读得出 ────");
  {
    const dao = lib.parseFile(path.join(REPO, "ccswitch", "dao.md"), {
      file: "ccswitch/dao.md", selector: lib.SELECTOR.MARKED, roleScheme: lib.ROLE_SCHEME.GENERAL,
    });
    check("dao.md 解析出条款（零条 = 扫描面塌了）", dao.stats.clauses > 0, JSON.stringify(dao.stats));
    // v2（批 2 · 台账搬家）改了这一条的契约：台账真相源搬进 clause-ledger.json 之后，
    // 一条条款可以**只有 slug 没有行内元字段**。故判据从「三件套齐全」改成「两条路必居其一」。
    // ⚠ 这不是放宽：另一半由 ⑦ 的双向孤儿检测夹住（slug 必须在台账里找得到条目）。
    check("每条要么有行内元字段三件套、要么有 slug（v2 双轨）",
      dao.clauses.every((c) =>
        (c.n && /^\d{2}-\d{2}$/.test(c.first_seen) && c.trigger) || (c.slug && !c.has_meta_field)),
      JSON.stringify(dao.clauses.find((c) =>
        !((c.n && c.first_seen && c.trigger) || (c.slug && !c.has_meta_field))) || {}));
    check("每条条款都带 slug（dao.md 已整体接入台账）",
      dao.stats.no_slug === 0 && dao.stats.slug === dao.stats.clauses, JSON.stringify(dao.stats));
    // 批 3 之后 dao.md 是**单轨**语料：20 条条款全部只有 slug、零行内元字段。
    // 这不是缺陷而是那一批的终态，故这里把它钉成正面断言 —— 哪天有人往 dao.md 回填
    // 行内字段，本条会红并把「双轨又回来了」摆到眼前（而 v1 盲区那组已迁去 ①.4 的夹具）。
    check("dao.md 是单轨语料：条款全部只有 slug、零行内元字段",
      dao.stats.no_meta_field === dao.stats.clauses && dao.stats.clauses > 0, JSON.stringify(dao.stats));
    check("行号自洽：line <= meta_line <= line_end",
      dao.clauses.every((c) => c.line <= c.meta_line && c.meta_line <= c.line_end),
      JSON.stringify(dao.clauses.find((c) => !(c.line <= c.meta_line && c.meta_line <= c.line_end)) || {}));
    check("dao.md 全归 general（这份语料没有官种分节）",
      dao.clauses.every((c) => c.role === "general"), JSON.stringify(dao.clauses.map((c) => c.role)));
    check("散文形态的条款也捞得到（不止列表项）",
      dao.clauses.some((c) => c.shape === "prose"), JSON.stringify(dao.stats));
    check("缩进形态的条款也捞得到", dao.clauses.some((c) => c.shape === "indent"), JSON.stringify(dao.stats));

    // 跨行块：这条条款的判据句首在第 17 行、元字段在第 19 行。只认元字段那一行的话，
    // title 会取到「⚠️ ②的覆盖面必须按…」这句**补充说明**，而不是条款本身。
    const gw = lib.parseFile(path.join(REPO, "ccswitch", "rules", "dao-guard-writing.md"), {
      file: "x", selector: lib.SELECTOR.MARKED, roleScheme: lib.ROLE_SCHEME.GENERAL,
    });
    const multi = gw.clauses.find((c) => c.line_end > c.line);
    check("跨行条款：块首行号 < 元字段行号（title 取的是判据句首不是末行的补充说明）",
      !!multi && multi.line < multi.meta_line, JSON.stringify(multi || gw.clauses.map((c) => [c.line, c.meta_line])));
    check("跨行条款的 title 是判据句首", !!multi && /规则集只增不减/.test(multi.title), JSON.stringify(multi || {}));
  }

  // ══════════════════════════════════════════════════════════════
  // 语料：**夹具**（换语料的完整理由见 FIX_META_TEXT 上方那段注释）。
  console.log("\n──── ①.4 v2 选择器：只带 [基线:]/[自定@] 的行也要看得见 ────");
  {
    const meta = lib.parseClauses({
      text: FIX_META_TEXT, file: "corpus-meta.md",
      selector: lib.SELECTOR.MARKED, roleScheme: lib.ROLE_SCHEME.GENERAL,
    });
    check("v1 盲区已修：带 [基线:]/[自定@] 却无 [n= @ 触发:] 的行解析得出（3 条 + 1 条对照）",
      meta.stats.clauses === 4 && meta.stats.no_meta_field === 3, JSON.stringify(meta.stats));
    // 负控：证明这份夹具**确实在测那件事**。少了这一条，上面那条也可能只是在测一份普通语料 ——
    // 而「测的东西其实已经不在语料里」正是本组这次红掉的成因，同一个病不该在修法里重演。
    const blind = FIX_META_TEXT.split("\n").filter(
      (l) => lib.LEDGER_SIGNATURE_RE.test(l) && !lib.CLAUSE_SIGNATURE_RE.test(l));
    check("负控：那 4 行确实不带 v1 签名（旧判据只认 `[n=`，对它们结构上失明）",
      blind.length === 4, JSON.stringify(blind));
    check("两条路都不通的那行落 fieldless，不是静默消失",
      meta.stats.fieldless === 1, JSON.stringify(meta.stats));
    const dual = meta.clauses.find((c) => c.slug === "夹-双自定") || {};
    check("`[自定@]` 收全部不只收第一个（一行两个日期，只收首个会静默丢一个）",
      JSON.stringify(dual.self_declared_all) === JSON.stringify(["07-29", "07-30"]),
      JSON.stringify(meta.clauses.map((c) => [c.slug, c.self_declared_all])));
    check("`self_declared` 仍是首个（老消费方契约不变）",
      dual.self_declared === "07-29", JSON.stringify(meta.clauses.map((c) => [c.slug, c.self_declared])));

    // ── 真语料侧的**前提检查** ────────────────────────────────────────
    // 判别力在上面那组夹具；这一条只负责让「这个形态在真语料里彻底没了」出声。
    // 它归零时该做的是确认「形态真的退役了、v2 那半选择器可以退役了吗」，**不是删断言**。
    const shaped = [];
    for (const s of lib.defaultSources()) {
      const p = lib.parseFile(path.join(REPO, s.file), {
        file: s.file, selector: s.selector, roleScheme: s.role_scheme,
      });
      for (const c of p.clauses) {
        if (!c.has_meta_field && (c.baseline !== null || (c.self_declared_all || []).length > 0)) {
          shaped.push(`${c.file}:${c.meta_line}`);
        }
      }
    }
    // 样本数无条件打印：过了也要看得见有几个样本 —— 「零样本」与「零违例」在只看红绿时一样。
    console.log(`  ⓘ 真语料里这个形态现有 ${shaped.length} 处：${shaped.join(" / ") || "（无）"}`);
    check("前提仍成立：真语料里这个形态还在（归零 ⇒ 本组只剩夹具在测，得有人知道）",
      shaped.length > 0, `样本 ${shaped.length} 处`);
  }
  {
    const r = lib.parseClauses({
      text: FIX_ROLES_TEXT, file: "corpus-roles.md",
      selector: lib.SELECTOR.ALL_TOP_LEVEL, roleScheme: lib.ROLE_SCHEME.DISPATCH_SECTIONS,
    });
    const roles = r.clauses.map((c) => c.role).sort().join(",");
    check("官种归属按节名映射", roles === "adversary,general,implementer,unclassified", roles);
    check("观察区条目单独分堆、不混进条款", r.stats.clauses === 4 && r.stats.observation === 1, JSON.stringify(r.stats));
    check("未归类条款**不**并进 general（并进去等于让没人认领的条款混进每一份派单）",
      r.stats.unclassified === 1, JSON.stringify(r.stats));
    check("`## 📌` 节里长得像条款的行被跳过**且报了数**（静默跳过与零命中不可区分）",
      r.stats.skipped_in_special_sections === 1, JSON.stringify(r.stats));
  }
  {
    const m = lib.parseFile(OFFICER, {
      file: "ccswitch/rules/dao-officer-clauses.md",
      selector: lib.SELECTOR.ALL_TOP_LEVEL, roleScheme: lib.ROLE_SCHEME.DISPATCH_SECTIONS,
    });
    const set = new Set(m.clauses.map((c) => c.role));
    check("第三语料：六个官种全解析得出",
      ["general", "reviewer", "implementer", "adversary", "scout", "dogfood"].every((r) => set.has(r)),
      JSON.stringify([...set]));
    check("第三语料：零未归类（所有条款都落在已知官种节里）", m.stats.unclassified === 0, JSON.stringify(m.stats));
    check("第三语料：规模够大，够当通用性靶（条款 > 50）", m.stats.clauses > 50, JSON.stringify(m.stats));
    // **不钉死条数**（换语料时这里原本写着「= 76」）。理由不是嫌维护麻烦 —— 是这份语料
    // 现在**进了默认源清单也进了台账**，于是「两边一起少一条」由一个更硬的东西夹着：
    // 某条被静默吞掉时它的 slug 从正文消失，而台账里那条还在 ⇒ `orphan_ledger` 判红（见 ③）。
    // 那个不变量不随条款增删过期，而一个手写的数字会 —— 且过期的那一版长得跟通过一模一样。
    check("第三语料：条款全部上了 slug（台账对它零失明）",
      m.stats.no_slug === 0 && m.stats.slug === m.stats.clauses, JSON.stringify(m.stats));
    check("第三语料：零 fieldless（all-top-level 下没有整条丢台账的顶层行）",
      m.stats.fieldless === 0, JSON.stringify(m.stats));

    // 「源缺席必须出声」这条行为**不能**靠"某个仓恰好不在这台机器上"来验 —— 那是不可控的
    // 语料。指一个确定不存在的路径，两态都跑得到。
    const sj = sourcesJson(path.join(TMP, "src-missing.json"),
      [{ file: path.join(TMP, "no-such-corpus.md"), selector: "all-top-level", role_scheme: "dispatch-sections" }]);
    const r = rec(runNode(GEN, ["--reconcile", "--sources-json", sj]).rec);
    check("语料缺席时：对账必须报「源缺席」且不给绿灯", !!r && r.exit !== 0 && r.mismatched > 0, JSON.stringify(r));
  }
  {
    // 换语料**丢掉了一条真数据正控**，照直补上而不是默默算了：原第三语料（mousse）的
    // `## 📌` 节里有 4 处长得像条款的样例、且全写在反引号里 ⇒ 遮罩后 `skipped` 恰为 0，
    // 那一条同时钉着「📌 节判定」与「代码 span 遮罩」两件事。官侧档**没有 📌 节**，
    // 那条断言在它身上恒真、判别力为 0。故这里用**合成夹具**把两态都摆出来。
    // 弱处照直写：合成夹具不是真语料，它证不了「真文件里那 4 行长什么样」。
    const BT = "`";
    const mk = (sample) => [
      "# 夹具 · 📌 节里的样例", "", "## 📌 条款元字段", "",
      sample, "", "## 通用节", "",
      "- **真条款**：正文。 [n=1 @07-01 触发:无] [仅判据·无触发]", "",
    ].join("\n");
    const inCode = lib.parseClauses({
      text: mk("- 已用值：" + BT + "[n=<数|?> @<MM-DD> 触发:<…>]" + BT + " 这样写。"),
      file: "corpus-special-quoted.md",
      selector: lib.SELECTOR.ALL_TOP_LEVEL, roleScheme: lib.ROLE_SCHEME.GENERAL,
    });
    check("📌 节里的样例**写在反引号内** ⇒ 遮罩后跳过数为 0（遮罩坏掉会变成 1 而变红）",
      inCode.stats.skipped_in_special_sections === 0 && inCode.stats.clauses === 1,
      JSON.stringify(inCode.stats));
    const bare = lib.parseClauses({
      text: mk("- 已用值：[n=1 @07-01 触发:无] 这样写。"),
      file: "corpus-special-bare.md",
      selector: lib.SELECTOR.ALL_TOP_LEVEL, roleScheme: lib.ROLE_SCHEME.GENERAL,
    });
    check("📌 节里的样例**不带反引号** ⇒ 被跳过且报了数（静默跳过与零命中不可区分）",
      bare.stats.skipped_in_special_sections === 1 && bare.stats.clauses === 1,
      JSON.stringify(bare.stats));
  }

  // ══════════════════════════════════════════════════════════════
  // 未闭合反引号游程（2026-08-02 反转处置）。缺陷原貌与判据见 clause-parser.mjs
  // 的 maskCodeSpans 头注；这里钉的是**行为**，不是实现。
  //
  // ⚠ 本组与 PS 侧 tests/clause-structure.tests.ps1 同名一组是**刻意的双份**：
  //   两套解析是独立实现，共享的只是「未闭合游程当字面文本」这个外部契约，
  //   所以两侧各钉各的；只钉一侧，另一侧改坏了要等 --reconcile 才发现，
  //   而 --reconcile 的默认源清单里**没有**含这种形态的语料（dao.md 零行未闭合游程）。
  console.log("\n──── ①.5 遮罩契约：未闭合反引号游程当字面文本 ────");
  {
    const BT = "`";
    // ── 单元层：等长不变量 ──────────────────────────────────────────
    // 等长是硬要求：下游按遮罩串的 group 下标回原始串切值。改成按区间切片重拼之后，
    // 这条**尤其**要验代理对（📌/🔴 是两个码元），按码点切会当场错位。
    const emo = "📌 前 " + BT + "code" + BT + " 后 🔴 " + BT + "x";
    check("等长不变量：遮罩串与原始串码元数相同（含 emoji 代理对）",
      lib.maskCodeSpans(emo).length === emo.length,
      `masked=${lib.maskCodeSpans(emo).length} raw=${emo.length}`);

    // ── 单元层：游程配对 ────────────────────────────────────────────
    check("闭合 span 仍被遮罩（原防护不变）",
      lib.maskCodeSpans("a " + BT + "b" + BT + " c") === "a     c",
      JSON.stringify(lib.maskCodeSpans("a " + BT + "b" + BT + " c")));
    const triple = "x " + BT.repeat(3) + "bash y";
    check("未闭合游程当字面文本（不再吃到行尾）",
      lib.maskCodeSpans(triple) === triple, JSON.stringify(lib.maskCodeSpans(triple)));
    check("未闭合游程被单独报出来（模糊地带可见）",
      lib.backtickSpans(triple).unmatched.length === 1 && lib.backtickSpans(triple).spans.length === 0,
      JSON.stringify(lib.backtickSpans(triple)));
    // 长度 3 的游程只能被另一个长度 3 的游程闭合 —— 不是「碰到下一个反引号就闭合」。
    const paired3 = BT.repeat(3) + "a" + BT.repeat(3);
    check("等长游程才闭合：```a``` 整段遮罩",
      lib.maskCodeSpans(paired3) === " ".repeat(paired3.length), JSON.stringify(lib.maskCodeSpans(paired3)));
    check("未闭合游程之后的闭合 span 照常遮罩（扫描不中断）",
      lib.maskCodeSpans(BT.repeat(3) + "u " + BT + "v" + BT) === BT.repeat(3) + "u    ",
      JSON.stringify(lib.maskCodeSpans(BT.repeat(3) + "u " + BT + "v" + BT)));

    // ── 解析层：两种后果各一条正控 ──────────────────────────────────
    // 后果②（静默少一条）比后果①（假阳性）险 —— 它不改退出码，只改计数。
    const oddLine = "- **奇数反引号条款**：正文写了一处 " + BT.repeat(3) +
      "bash 写法示例，还有 " + BT + "a" + BT + " 这种。 [n=1 @07-09 触发:无] [仅判据·无触发]";
    const oddText = [
      "# 夹具条款库 · 奇数反引号", "", "## 通用节", "",
      "- **甲条**：普通条款。 [n=1 @07-01 触发:无] [仅判据·无触发]",
      oddLine,
      "- **丙条**：普通条款。 [n=2 @07-02 触发:PR流程] [基线:未测]", "",
    ].join("\n");
    const odd = lib.parseClauses({
      text: oddText, file: "corpus-odd.md",
      selector: lib.SELECTOR.ALL_TOP_LEVEL, roleScheme: lib.ROLE_SCHEME.GENERAL,
    });
    check("正控：奇数反引号那条进得了扫描面（3 条，旧实现 2 条且不报错）",
      odd.stats.clauses === 3, JSON.stringify(odd.stats));
    const oc = odd.clauses.find((c) => /奇数反引号/.test(c.title));
    check("正控：它的元字段被正确解析（旧实现整段被遮成空格）",
      !!oc && oc.n === "1" && oc.first_seen === "07-09" && oc.trigger === "无",
      JSON.stringify(oc || odd.clauses.map((c) => c.title)));

    // ── 负控：原本要防的代码 span 假阳性，防护必须仍在 ────────────────
    // 单向断言（只验「合法条款不再被误判」）夹不住「遮罩被整个关掉」——
    // 本批 PS 侧实现初版正是那样：一个 return 写法把遮罩全线关成 no-op，而正控全绿。
    const negText = [
      "# 夹具条款库 · 代码 span 负控", "", "## 通用节", "",
      "- **甲条**：正文写着 " + BT + "[自定@<月日>]" + BT + " 模板字面量。 [n=1 @07-01 触发:PR流程]",
      "- **乙条**：正文写着 " + BT + "[#测-不存在]" + BT + " 假 slug。 [n=2 @07-02 触发:PR流程]", "",
    ].join("\n");
    const neg = lib.parseClauses({
      text: negText, file: "corpus-neg.md",
      selector: lib.SELECTOR.ALL_TOP_LEVEL, roleScheme: lib.ROLE_SCHEME.GENERAL,
    });
    check("负控：闭合 span 里的 [自定@…] 不算真标记",
      neg.clauses.every((c) => (c.self_declared_all || []).length === 0),
      JSON.stringify(neg.clauses.map((c) => c.self_declared_all)));
    check("负控：闭合 span 里的假 slug 不算真 slug",
      neg.stats.slug === 0, JSON.stringify(neg.stats));
    check("负控：恰 2 条（假元字段没把条款数撑大）", neg.stats.clauses === 2, JSON.stringify(neg.stats));
  }

  // ══════════════════════════════════════════════════════════════
  // 两套解析对**含未闭合游程的真实语料**逐一对数。这一组原先指的是 mousse 那份条款库
  // （本机绝对路径 + 另一个仓），换语料后指官侧档 —— 那条奇数反引号的条款是**逐行搬过来的**，
  // 所以原始现场随语料一起进了本仓，不再靠"某台机器上恰好有那个仓"。
  //
  // ⚠ 这一组有一个**会随时间静默失效**的前提：官侧档里那行未闭合游程一旦被人"顺手修好"，
  //   本组照样全绿，而它测的东西已经没了 —— 零检出与零存在又一次不可区分。故第一条断言
  //   钉的就是那个前提本身（语料里确实还有未闭合游程），前提没了当场变红。
  console.log("\n──── ①.6 双解析器对账：含未闭合游程的真实语料（原始现场）────");
  {
    const raw = fs.readFileSync(OFFICER, "utf8").split(/\r\n|\n|\r/);
    const unclosed = raw.filter((l) => lib.backtickSpans(l).unmatched.length > 0);
    check("前提仍成立：官侧档里确有未闭合反引号游程（没有它，本组测的东西就没了）",
      unclosed.length > 0, `unclosed=${unclosed.length}`);

    const sj = sourcesJson(path.join(TMP, "src-officer.json"),
      [{ file: "ccswitch/rules/dao-officer-clauses.md", selector: "all-top-level", role_scheme: "dispatch-sections" }]);
    const r = rec(runNode(GEN, ["--reconcile", "--sources-json", sj]).rec);
    check("第三语料双解析器对账打得出末行", r !== null);
    check("第三语料双解析器一致（PS 与 JS 对未闭合游程的处置必须同契约）",
      r && r.exit === 0 && r.mismatched === 0 && r.mine === r.theirs, JSON.stringify(r));
    // 「两边一起少一条」不靠手写数字夹（那个数字会过期），靠 slug 数：两侧各自数 slug，
    // 一条被吞掉时它的 slug 也跟着消失 ⇒ myslugs/theirslugs 与条款数脱钩，③ 的台账侧再补一刀。
    check("两侧 slug 数也逐字相同，且与条款数相等（吞掉一条时这两个数会一起塌）",
      r && r.myslugs === r.theirslugs && r.myslugs === r.mine && r.mine > 0, JSON.stringify(r));
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ② 交叉对账：两套独立解析对同一份语料各数一遍 ────");
  {
    const r = rec(runNode(GEN, ["--reconcile"]).rec);
    check("默认源清单对账打得出末行", r !== null);
    check("对账通过（exit 0）", r && r.exit === 0, JSON.stringify(r));
    check("零不一致", r && r.mismatched === 0, JSON.stringify(r));
    check("两侧总数逐字相同", r && r.mine === r.theirs && r.mine > 0, JSON.stringify(r));
    check("对方确实跑起来了（host 不是 none）", r && r.host !== "none", JSON.stringify(r));
  }
  {
    // 官侧档尚未进默认源清单（`ccswitch/lib/clause-parser.mjs` 的 defaultSources 由另一批改），
    // 故这里自带一份清单把它纳进来对账 —— 交叉对账的价值在于「两套独立解析对同一份语料各数一遍」，
    // 不依赖它有没有被登记。登记之后这一段仍成立（届时它只是与默认清单重合）。
    const sj = sourcesJson(path.join(TMP, "src-officer.json"), [
      { file: "ccswitch/dao.md", selector: "marked", role_scheme: "general" },
      { file: "ccswitch/rules/dao-officer-clauses.md", selector: "marked", role_scheme: "dispatch-sections" },
    ]);
    const r = rec(runNode(GEN, ["--reconcile", "--sources-json", sj]).rec);
    check("含第三语料的对账通过（跨语料类型的通用性）", r && r.exit === 0 && r.mismatched === 0, JSON.stringify(r));
    check("第三语料条款数量级对得上（两侧同数且 > 50）", r && r.mine === r.theirs && r.mine > 50, JSON.stringify(r));
  }
  {
    // 「跑不了」必须与「跑了且一致」分得开：第二套解析不在 ⇒ exit 2，不是 0。
    const r = runNode(GEN, ["--reconcile", "--ps-script", path.join(TMP, "no-such-guard.ps1")]);
    const s = rec(r.rec);
    check("第二套解析不在 ⇒ exit 2（不给绿灯）", r.code === 2 && s && s.exit === 2, JSON.stringify(s) + r.out.slice(0, 300));
    check("说清「跑不了不等于一致」", /不等于/.test(r.out), r.out.slice(0, 400));
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ③ 幂等：两次生成逐字节相同 ────");
  {
    const out1 = path.join(TMP, "idem-1.json");
    const out2 = path.join(TMP, "idem-2.json");
    runNode(GEN, ["--quiet", "--out", out1]);
    runNode(GEN, ["--quiet", "--out", out2]);
    check("默认源：两次生成逐字节相同",
      fs.readFileSync(out1).equals(fs.readFileSync(out2)), "长度 " + fs.statSync(out1).size + " vs " + fs.statSync(out2).size);
    check("索引里没有时间戳（有它就没有幂等）", !/\d{4}-\d{2}-\d{2}T\d{2}:/.test(fs.readFileSync(out1, "utf8")));

    const sj = sourcesJson(path.join(TMP, "src-fix.json"),
      [{ file: FIX_A, selector: "all-top-level", role_scheme: "dispatch-sections" }]);
    const f1 = path.join(TMP, "idem-fix-1.json"), f2 = path.join(TMP, "idem-fix-2.json");
    runNode(GEN, ["--quiet", "--sources-json", sj, "--out", f1]);
    runNode(GEN, ["--quiet", "--sources-json", sj, "--out", f2]);
    check("夹具源：两次生成逐字节相同", fs.readFileSync(f1).equals(fs.readFileSync(f2)));
    const doc = JSON.parse(fs.readFileSync(f1, "utf8"));
    check("id 全局唯一", new Set(doc.clauses.map((c) => c.id)).size === doc.clauses.length,
      JSON.stringify(doc.clauses.map((c) => c.id)));
    check("id 与行号无关（同内容同 id）", doc.clauses.every((c) => /^[0-9a-f]{12}(-\d+)?$/.test(c.id) || /^[0-9a-f]{24}(-\d+)?$/.test(c.id)),
      JSON.stringify(doc.clauses.map((c) => c.id)));
  }
  {
    // 行尾无关性 —— 本仓 core.autocrlf=true 且 .gitattributes 只钉了 *.sh，于是**同一个
    // commit 在不同机器上 checkout 出的字节不同**。拿原始字节做哈希/比对的话，`--check`
    // 会在换台机器时全红，而红的原因与条款无关 —— 一个 clone 完就红的闸必然被静音。
    const lf = path.join(TMP, "eol", "lf.md");
    const crlf = path.join(TMP, "eol", "crlf.md");
    w(lf, FIX_A_TEXT);
    w(crlf, FIX_A_TEXT.replace(/\n/g, "\r\n"));
    check("CRLF 夹具确实是 CRLF（负控：这个测试自己得先是真的）",
      fs.readFileSync(crlf, "utf8").includes("\r\n") && !fs.readFileSync(lf, "utf8").includes("\r\n"));
    check("源哈希与行尾无关", lib.sha256File(lf) === lib.sha256File(crlf),
      lib.sha256File(lf) + " vs " + lib.sha256File(crlf));
    const pLf = lib.parseFile(lf, { file: "x", selector: lib.SELECTOR.ALL_TOP_LEVEL, roleScheme: lib.ROLE_SCHEME.DISPATCH_SECTIONS });
    const pCrlf = lib.parseFile(crlf, { file: "x", selector: lib.SELECTOR.ALL_TOP_LEVEL, roleScheme: lib.ROLE_SCHEME.DISPATCH_SECTIONS });
    check("解析结果与行尾无关（条款数 + 行号 + title 全同）",
      JSON.stringify(pLf.clauses.map((c) => [c.line, c.meta_line, c.title])) ===
      JSON.stringify(pCrlf.clauses.map((c) => [c.line, c.meta_line, c.title])),
      JSON.stringify(pLf.stats) + " vs " + JSON.stringify(pCrlf.stats));

    // 索引文件本身被 checkout 成 CRLF 时，--check 不许因此判红。
    const sj = sourcesJson(path.join(TMP, "eol", "src.json"),
      [{ file: lf, selector: "all-top-level", role_scheme: "dispatch-sections" }]);
    const ix = path.join(TMP, "eol", "index.json");
    runNode(GEN, ["--quiet", "--sources-json", sj, "--out", ix]);
    w(ix, fs.readFileSync(ix, "utf8").replace(/\n/g, "\r\n"));
    const r = runNode(GEN, ["--check", "--quiet", "--sources-json", sj, "--out", ix]);
    check("索引被 checkout 成 CRLF ⇒ 仍判绿（判据是内容不是行尾）",
      r.code === 0 && idx(r.index).drift === "none", JSON.stringify(idx(r.index)) + r.out.slice(0, 300));
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ④ drift 两态：源变了要红，没变要绿（不许恒红也不许恒绿）────");
  {
    const src = path.join(TMP, "drift", "corpus.md");
    w(src, FIX_A_TEXT);
    const sj = sourcesJson(path.join(TMP, "drift", "src.json"),
      [{ file: src, selector: "all-top-level", role_scheme: "dispatch-sections" }]);
    const out = path.join(TMP, "drift", "index.json");

    const missing = runNode(GEN, ["--check", "--sources-json", sj, "--out", out]);
    check("索引不存在 ⇒ 红 + drift=missing", missing.code === 1 && idx(missing.index).drift === "missing",
      JSON.stringify(idx(missing.index)));

    runNode(GEN, ["--quiet", "--sources-json", sj, "--out", out]);
    const green0 = runNode(GEN, ["--check", "--sources-json", sj, "--out", out]);
    check("刚生成完 ⇒ 绿 + drift=none", green0.code === 0 && idx(green0.index).drift === "none",
      JSON.stringify(idx(green0.index)) + green0.out.slice(0, 300));

    w(src, FIX_A_TEXT + "\n- **戊条**：新加的。 [n=1 @07-06 触发:无] [仅判据·无触发]\n");
    const red = runNode(GEN, ["--check", "--sources-json", sj, "--out", out]);
    check("源变了而索引没跟上 ⇒ 红 + drift=source", red.code === 1 && idx(red.index).drift === "source",
      JSON.stringify(idx(red.index)) + red.out.slice(0, 400));
    check("红报里指名是哪个源变了（只说「过期了」等于没说）", red.out.includes("corpus.md") && /内容已变/.test(red.out),
      red.out.slice(0, 500));

    w(src, FIX_A_TEXT);
    const green1 = runNode(GEN, ["--check", "--sources-json", sj, "--out", out]);
    check("源改回去 ⇒ 又绿（负控：不是恒红）", green1.code === 0 && idx(green1.index).drift === "none",
      JSON.stringify(idx(green1.index)) + green1.out.slice(0, 300));

    // 手改派生物：所有源的 sha256 都没变，说明动的是索引本身。两种病、两种处方。
    const doc = JSON.parse(fs.readFileSync(out, "utf8"));
    doc.clauses[0].title = "我手改了这个派生物";
    w(out, JSON.stringify(doc, null, 2) + "\n");
    const red2 = runNode(GEN, ["--check", "--sources-json", sj, "--out", out]);
    check("手改索引本身 ⇒ 红 + drift=content（与「源变了」分得开）",
      red2.code === 1 && idx(red2.index).drift === "content", JSON.stringify(idx(red2.index)) + red2.out.slice(0, 400));
    check("红报点明「索引是派生物，手改无效」", /手改/.test(red2.out), red2.out.slice(0, 400));

    // 源文件没了：不许当成「零条款」悄悄生成一份缺一节的索引。
    const sjGone = sourcesJson(path.join(TMP, "drift", "src-gone.json"),
      [{ file: path.join(TMP, "drift", "not-here.md"), selector: "marked", role_scheme: "general" }]);
    const gone = runNode(GEN, ["--sources-json", sjGone, "--out", path.join(TMP, "drift", "gone.json")]);
    check("源文件不存在 ⇒ 红并指名（不静默少一节）", gone.code === 1 && /not-here\.md/.test(gone.out), gone.out.slice(0, 400));
  }
  {
    // 真实语料自跑：committed 索引与现在的 Markdown 一致吗。**这是本回归网唯一的真数据断言**
    // —— 合成夹具证明不了它在真语料上跑得动（本仓有过「47 条合成断言全绿、真语料一份都没扫成」的实证）。
    const r = runNode(GEN, ["--check", "--quiet"]);
    check("真仓 committed 索引与真相源一致（红了就是有人改了 dao.md/rules 没重新生成）",
      r.code === 0 && idx(r.index) && idx(r.index).drift === "none", JSON.stringify(idx(r.index)) + r.out.slice(0, 400));
    check("真仓索引条款数 > 0（零条 = 扫描面塌了，那时上面那个绿是空的）",
      idx(r.index) && idx(r.index).clauses > 0, JSON.stringify(idx(r.index)));
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ⑤ 按官种渲染：过滤正确 + 报错不空过 ────");
  {
    const sj = sourcesJson(path.join(TMP, "render", "src.json"),
      [{ file: FIX_ROLES, selector: "all-top-level", role_scheme: "dispatch-sections" }]);
    const ix = path.join(TMP, "render", "index.json");
    runNode(GEN, ["--quiet", "--sources-json", sj, "--out", ix]);

    const mdPath = path.join(TMP, "render", "impl.md");
    const r = runNode(RENDER, ["--index", ix, "--role", "implementer", "--out", mdPath]);
    const s = ren(r.render);
    const md = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, "utf8") : "";
    check("implementer 渲染 exit 0", r.code === 0 && s && s.exit === 0, JSON.stringify(s) + r.out.slice(0, 300));
    check("含通用节条款", md.includes("MARK-GENERAL"), md.slice(0, 300));
    check("含本官种条款", md.includes("MARK-IMPL"), md.slice(0, 300));
    check("**不**含别的官种条款（这是本功能的全部意义）", !md.includes("MARK-ADV"), md);
    check("**不**含观察区条目（协议：它们还不是条款）", !md.includes("MARK-OBS"), md);
    check("**不**含未归类条款", !md.includes("MARK-STRAY"), md);
    check("未归类条款被显式点名（不是悄悄丢掉）", /未归类/.test(md) && s.unclassified === 1, md.slice(0, 800));
    check("计数进末行契约", s.general === 1 && s.role_clauses === 1, JSON.stringify(s));
    check("正文是**全文**不是摘要（索引只存行号，正文回原文现切）", md.includes("MARK-IMPL 内容。 [n=1 @07-02 触发:PR流程]"), md);
    check("每条带出处锚点（file:line）", /出处 .+:\d+/.test(md), md.slice(0, 900));

    const adv = runNode(RENDER, ["--index", ix, "--role", "adversary", "--out", path.join(TMP, "render", "adv.md")]);
    const advMd = fs.readFileSync(path.join(TMP, "render", "adv.md"), "utf8");
    check("换个官种 ⇒ 换一批条款（负控：不是恒定输出）",
      adv.code === 0 && advMd.includes("MARK-ADV") && !advMd.includes("MARK-IMPL"), advMd.slice(0, 400));

    const jr = runNode(RENDER, ["--index", ix, "--role", "implementer", "--format", "json",
      "--out", path.join(TMP, "render", "impl.json")]);
    let jdoc = null;
    try { jdoc = JSON.parse(fs.readFileSync(path.join(TMP, "render", "impl.json"), "utf8")); } catch (_) {}
    check("--format json 可解析且分两栏",
      jr.code === 0 && jdoc && jdoc.general.length === 1 && jdoc.role_clauses.length === 1, JSON.stringify(jdoc && Object.keys(jdoc)));
    check("json 里带 body 全文", jdoc && /MARK-IMPL/.test(jdoc.role_clauses[0].body), JSON.stringify(jdoc && jdoc.role_clauses[0]));

    // ── 负控三连：报错不空过 ──
    const bad = runNode(RENDER, ["--index", ix, "--role", "厨子"]);
    check("不认识的官种 ⇒ exit 1", bad.code === 1 && ren(bad.render).exit === 1, bad.out.slice(0, 300));
    check("并列出合法取值（只报错不给出路等于没报）", /implementer/.test(bad.out) && /adversary/.test(bad.out), bad.out.slice(0, 300));

    const none = runNode(RENDER, ["--index", ix, "--role", "scout"]);
    check("认识但这份索引里 0 条 ⇒ exit 1（零条 ≠ 零存在）", none.code === 1, none.out.slice(0, 400));
    check("并说清「多半是源清单里没有那份语料」而不是「这个官种没有条款」",
      /源清单/.test(none.out) && /0 条/.test(none.out), none.out.slice(0, 500));

    const noRole = runNode(RENDER, ["--index", ix]);
    check("缺 --role ⇒ exit 1（不给缺省值）", noRole.code === 1, noRole.out.slice(0, 300));

    const obs = runNode(RENDER, ["--index", ix, "--role", "observation"]);
    check("observation 不可渲染 ⇒ exit 1 并说明理由", obs.code === 1 && /还不是条款/.test(obs.out), obs.out.slice(0, 300));

    // ── 索引过期 ⇒ 拒绝渲染（正文是按行号现切的，源动了就可能切到隔壁条款）──
    const before = fs.readFileSync(FIX_ROLES, "utf8");
    w(FIX_ROLES, "# 换了个头\n\n" + before);
    const stale = runNode(RENDER, ["--index", ix, "--role", "implementer"]);
    check("索引过期 ⇒ 拒绝渲染 exit 1", stale.code === 1 && ren(stale.render).stale === 1, stale.out.slice(0, 400));
    const forced = runNode(RENDER, ["--index", ix, "--role", "implementer", "--allow-stale",
      "--out", path.join(TMP, "render", "stale.md")]);
    const staleMd = fs.readFileSync(path.join(TMP, "render", "stale.md"), "utf8");
    check("--allow-stale 可强渲，但正文与末行两处留痕",
      forced.code === 0 && /索引已过期/.test(staleMd) && ren(forced.render).stale === 1,
      staleMd.slice(0, 600) + " | " + JSON.stringify(ren(forced.render)));
    w(FIX_ROLES, before);
    const back = runNode(RENDER, ["--index", ix, "--role", "implementer", "--out", path.join(TMP, "render", "back.md")]);
    check("源改回去 ⇒ 又能渲（负控：过期判定不是恒红）", back.code === 0 && ren(back.render).stale === 0,
      JSON.stringify(ren(back.render)));

    const lr = runNode(RENDER, ["--index", ix, "--list-roles"]);
    check("--list-roles 按词表逐个报数（缺席的官种报 0，不是不出现）",
      lr.code === 0 && /scout\s+0/.test(lr.out) && /implementer\s+1/.test(lr.out), lr.out.slice(0, 500));
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ⑥ mutation 双向 + canary ────");
  {
    const sj = sourcesJson(path.join(TMP, "mut", "src.json"),
      [{ file: FIX_A, selector: "all-top-level", role_scheme: "dispatch-sections" }]);

    // 基线：未变异副本在同一夹具上必须绿 —— 否则下面的红全都不算数（恒红的断言 = 废话）。
    function mutantDir(name, mutate) {
      const root = path.join(TMP, "mut", name);
      rm(root);
      fs.mkdirSync(path.join(root, "ccswitch", "lib"), { recursive: true });
      fs.mkdirSync(path.join(root, "ccswitch", "scripts"), { recursive: true });
      let libSrc = fs.readFileSync(LIB, "utf8");
      let applied = 0;
      if (mutate) { const r = mutate(libSrc); libSrc = r.text; applied = r.applied; }
      w(path.join(root, "ccswitch", "lib", "clause-parser.mjs"), libSrc);
      w(path.join(root, "ccswitch", "scripts", "gen-clause-index.mjs"), fs.readFileSync(GEN, "utf8"));
      return { script: path.join(root, "ccswitch", "scripts", "gen-clause-index.mjs"), applied };
    }
    function runMutant(m) {
      return rec(runNode(m.script, ["--reconcile", "--sources-json", sj, "--ps-script", PS_SCRIPT]).rec);
    }

    const baseM = mutantDir("baseline", null);
    const base = runMutant(baseM);
    check("负控：未变异副本在同一夹具上对账绿（下面的红才算数）",
      base && base.exit === 0 && base.mismatched === 0 && base.mine === base.theirs && base.mine > 0, JSON.stringify(base));
    const THEIRS = base ? base.theirs : -1;

    // ── mutation A（收窄）：元字段正则认不出 `[n=` ⇒ 我方一条都数不出来 ──
    const mA = mutantDir("narrow", (t) => {
      const before = t;
      const text = t.replace("/\\[n=(\\d+|\\?) @(\\d{2}-\\d{2}) 触发:([^\\]]+)\\]/",
        "/\\[nZZ=(\\d+|\\?) @(\\d{2}-\\d{2}) 触发:([^\\]]+)\\]/");
      return { text, applied: text === before ? 0 : 1 };
    });
    check("mutation A 真的改到了那一行（改不动的 mutation 等于没做）", mA.applied === 1, "applied=" + mA.applied);
    const rA = runMutant(mA);
    check("canary A：变异体仍跑得起来（打得出末行契约，不是崩了）", rA !== null, "无末行");
    check("canary A：对方数出的数与基线逐字相同（靶子没被动过）", rA && rA.theirs === THEIRS,
      JSON.stringify(rA) + " baseline theirs=" + THEIRS);
    check("mutation A ⇒ 对账变红", rA && rA.exit !== 0 && rA.mismatched > 0, JSON.stringify(rA));
    check("mutation A 的方向是**少数**（我方 < 对方）", rA && rA.mine < rA.theirs, JSON.stringify(rA));

    // ── mutation B（放宽）：观察区节判定失效 ⇒ 观察区条目被当成正式条款 ⇒ 我方多数 ──
    const mB = mutantDir("widen", (t) => {
      const before = t;
      const text = t.replace("/^##\\s*观察区/", "/^##\\s*观察区ZZNEVER/");
      return { text, applied: text === before ? 0 : 1 };
    });
    check("mutation B 真的改到了那一行", mB.applied === 1, "applied=" + mB.applied);
    const rB = runMutant(mB);
    check("canary B：变异体仍跑得起来", rB !== null, "无末行");
    check("canary B：对方数出的数与基线逐字相同", rB && rB.theirs === THEIRS, JSON.stringify(rB) + " baseline theirs=" + THEIRS);
    check("mutation B ⇒ 对账变红", rB && rB.exit !== 0 && rB.mismatched > 0, JSON.stringify(rB));
    check("mutation B 的方向是**多数**（我方 > 对方）—— 两向都验过，不是只验松的那侧",
      rB && rB.mine > rB.theirs, JSON.stringify(rB));

    // ── mutation C（形态三：保留调用但结果不被消费）──
    // 前两向改的是「判据本身」；这一向不动判据，只把 `## 📌` 整节跳过那一步的**结果**吞掉
    // ——「门还在、也还在算，只是没人听它的答案」。它对文本匹配型守护天然是盲区，
    // 故必须单独试一次而不是假定前两向已覆盖。
    const mC = mutantDir("unconsumed", (t) => {
      const before = t;
      const text = t.replace(
        "    if (sec && sec.kind === \"special\") {",
        "    if (false && sec && sec.kind === \"special\") {"
      );
      return { text, applied: text === before ? 0 : 1 };
    });
    check("mutation C 真的改到了那一行", mC.applied === 1, "applied=" + mC.applied);
    const rC = runMutant(mC);
    check("canary C：变异体仍跑得起来", rC !== null, "无末行");
    check("canary C：对方数出的数与基线逐字相同", rC && rC.theirs === THEIRS, JSON.stringify(rC));
    // ⚠ 照直记阴性：本夹具**没有 `## 📌` 节**，故 C 在它身上差额必为 0。
    // 换一份**含 📌 节**的语料再跑一次 C，它才有靶。这一段是那个「换靶」。
    const fixSpecial = path.join(FIX, "corpus-special.md");
    w(fixSpecial, [
      "# 夹具 · 带 📌 元文档节",
      "",
      "## 📌 怎么写条款（这一节是元文档，里面的样例长得和条款一样）",
      "",
      "- **样例条**：这不是真条款，它住在 📌 节里。 [n=1 @07-09 触发:无] [仅判据·无触发]",
      "",
      "## 通用节",
      "",
      "- **真条款**：这条才算。 [n=1 @07-10 触发:PR流程]",
      "",
    ].join("\n"));
    const sjS = sourcesJson(path.join(TMP, "mut", "src-special.json"),
      [{ file: fixSpecial, selector: "all-top-level", role_scheme: "dispatch-sections" }]);
    const runOn = (m, s) => rec(runNode(m.script, ["--reconcile", "--sources-json", s, "--ps-script", PS_SCRIPT]).rec);
    const baseS = runOn(baseM, sjS);
    check("负控：未变异副本在 📌 夹具上也绿", baseS && baseS.exit === 0 && baseS.mine === 1, JSON.stringify(baseS));
    const rCS = runOn(mC, sjS);
    check("canary C（📌 夹具）：变异体仍跑得起来且靶子没动", rCS && rCS.theirs === baseS.theirs, JSON.stringify(rCS));
    check("mutation C ⇒ 对账变红（📌 节里的样例被当成条款数了进来）",
      rCS && rCS.exit !== 0 && rCS.mine > rCS.theirs, JSON.stringify(rCS));

    // ── mutation D（v2 加）：slug 判据被写坏 ⇒ 两侧 slug 数分岔 ──
    // 前三向全落在「条款数」这个量上，对 slug 这一层**结构上失明**：把 slug 正则改坏，
    // 条款数与触发:无 可以逐字不变。这一向验的正是 `--reconcile` 新加的第三个对账量。
    const mD = mutantDir("slug-blind", (t) => {
      const before = t;
      const text = t.replace("export const SLUG_RE = /\\[#([^\\]\\s]+)\\]/;",
        "export const SLUG_RE = /\\[#ZZNEVER([^\\]\\s]+)\\]/;");
      return { text, applied: text === before ? 0 : 1 };
    });
    check("mutation D 真的改到了那一行", mD.applied === 1, "applied=" + mD.applied);
    const fixSlug = path.join(FIX, "corpus-slug.md");
    w(fixSlug, [
      "# 夹具 · 带 slug 的条款库",
      "",
      "## 通用节",
      "",
      "- **甲条**：判据。 [n=1 @07-01 触发:PR流程] [#测-甲]",
      "- **乙条**：只有 slug，台账在 ledger 里。 [基线:合成] [#测-乙]",
      "",
    ].join("\n"));
    const sjSlug = sourcesJson(path.join(TMP, "mut", "src-slug.json"),
      [{ file: fixSlug, selector: "all-top-level", role_scheme: "dispatch-sections" }]);
    const baseSlug = runOn(baseM, sjSlug);
    check("负控：未变异副本在 slug 夹具上绿且两侧 slug 数相同（2 == 2）",
      baseSlug && baseSlug.exit === 0 && baseSlug.myslugs === 2 && baseSlug.theirslugs === 2, JSON.stringify(baseSlug));
    const rD = runOn(mD, sjSlug);
    check("canary D：变异体仍跑得起来（打得出末行）", rD !== null, "无末行");
    check("canary D：对方的 slug 数与基线逐字相同（靶子没被动过）",
      rD && baseSlug && rD.theirslugs === baseSlug.theirslugs, JSON.stringify(rD));
    check("mutation D ⇒ 对账变红（slug 数分岔，而条款数那一层看不见它）",
      rD && rD.exit !== 0 && rD.myslugs < rD.theirslugs, JSON.stringify(rD));

    // ════════════════════════════════════════════════════════════════════
    // ⑥.5 **两侧同时错同一处**（issue #91）—— 本组是这批改动最承重的一组
    //
    // ── 它要钉住的形态 ──────────────────────────────────────────────────
    // A~D 四向全都是「只改我方一侧」。它们证明的是「一侧坏了另一侧会顶出来」，
    // **证不了**「两侧一起坏会不会被发现」—— 而后者不是假想敌：2026-08-02 之前，
    // 本侧 `backtickSpans` 与 PS 侧 `Get-BacktickSpans` 是**逐行直译**（变量名 / 循环形状 /
    // 分支顺序完全对应），改一处几乎必然被照抄到另一处，届时两边数出来的三个数**逐字节相同**、
    // 对账全绿。那正是那个未闭合反引号缺陷能一路静默过去的原因之一。
    //
    // ── 现在靠什么抓住它 ────────────────────────────────────────────────
    // 不是靠"两边写得不一样"（那只解掉"照抄"这条路径），是靠**第三套实现**：
    // PS 侧 `Get-MaskedLineAlt`（逐字符扫描，普查专用）与主实现逐字节互核，结论走末行
    // `maskdiv=`，由本脚本的 okMask 判红。下面 E/F/G 三向分别验：
    //   E 两侧同坏 ⇒ 条款数/触发:无/slug **三个量全相等**，唯 maskdiv 分岔 ⇒ 必须红
    //   F 把 maskdiv 这一栏从对账里摘掉（"对账坏"）⇒ 同一个 E 场景**变绿**
    //     ⇒ 反证这条通道是承重的，而不是一条陪跑的断言
    //   G 三套一起坏 ⇒ 全绿（已知残余，钉成断言；n 套互核抓不到 n 套同错）
    // ════════════════════════════════════════════════════════════════════
    console.log("\n──── ⑥.5 两侧同时错同一处：maskdiv 通道（issue #91）────");

    // PS 脚本的变异副本。**必须写 BOM** —— PS 5.1 读无 BOM 的脚本本体时按系统 ANSI 代码页
    // 解码，整份中文脚本当场报废 ⇒ 每个 mutation 都"全红"，而那是「判别力满分」的表象。
    // 每个变异体下面都配 canary，先确认它还跑得起来再读红集。
    function psMutant(name, edits) {
      const dir = path.join(TMP, "mut", name, "ccswitch", "scripts");
      fs.mkdirSync(dir, { recursive: true });
      let src = fs.readFileSync(PS_SCRIPT, "utf8").replace(/^﻿/, "");
      let applied = 0;
      for (const e of edits) {
        if (!src.includes(e.from)) continue;
        src = src.split(e.from).join(e.to);
        applied++;
      }
      const p = path.join(dir, "check-clauses-structure.ps1");
      fs.writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(src, "utf8")]));
      return { script: p, applied };
    }

    // ── 三处锚（各在各的实现里，语义同一个：未闭合游程 ⇒ 从它遮到行尾）──────
    // 这不是凭空编的坏法，是 2026-08-02 之前**真实存在过的行为**，原样装回去。
    // JS 侧：未闭合 ⇒ 吐一个"到行尾"的 span 并**收工**。`cursor = runs.length` 那一半不是
    // 多余的 —— 2026-08-02 之前那一版就是 `break`（见 git 里 maskCodeSpans 的旧形态），
    // 不停下的话后面的闭合 span 会让 maskCodeSpans 把行尾**原样拼回去**，缺陷就自我抵消了
    //（本批实测踩到：不带 `cursor = runs.length` 时真实语料上 JS 侧计数纹丝不动，
    //  而 PS 侧照样少一条 —— 那时测的就不再是"两侧同坏"了）。
    const JS_EDIT = {
      from: "    if (closer < 0) { unmatched.push(runs[cursor].start); cursor += 1; continue; }",
      to: "    if (closer < 0) { unmatched.push(runs[cursor].start); spans.push({ from: runs[cursor].start, to: raw.length - 1 }); cursor = runs.length; continue; }",
    };
    const PS_MAIN_EDIT = {
      from: "            $unmatched += $open.Start",
      to: "            $unmatched += $open.Start; $spans += [PSCustomObject]@{ From = $open.Start; To = ($Raw.Length - 1) }",
    };
    const PS_ALT_EDIT = {
      from: "        if ($closeAt -lt 0) {",
      to: "        if ($closeAt -lt 0) { for ($z = $openAt; $z -lt $n; $z++) { $c[$z] = ' ' }; $i = $n; continue } elseif ($false) {",
    };

    // 靶语料：第二条带**未闭合游程** + 行尾完整元字段。缺陷态下 Marked 选择器读的就是
    // 遮罩串 ⇒ 该行整条退出扫描面，两侧同时少一条 ⇒ 条款数仍然相等（这正是可怕之处）。
    const fixUnclosed = path.join(FIX, "corpus-unclosed.md");
    w(fixUnclosed, [
      "# 夹具 · 未闭合游程（两侧同坏的靶）",
      "",
      "## 通用节",
      "",
      "- **甲条**：普通条款。 [n=1 @07-01 触发:无] [仅判据·无触发]",
      "- **乙条**：正文写了一处 " + "`".repeat(3) + "bash 写法示例。 [n=2 @07-02 触发:PR流程]",
      "",
    ].join("\n"));
    const sjU = sourcesJson(path.join(TMP, "mut", "src-unclosed.json"),
      [{ file: fixUnclosed, selector: "marked", role_scheme: "general" }]);
    // canary 语料：只有**闭合** span ⇒ 遮罩路径照走，但 unmatched 那一支到不了。
    // 变异体在它上面必须仍绿 —— 证明改动精确落在那一个分支，而不是把整套遮罩弄死了
    //（"把靶弄死"会让每条断言都红，那正是「判别力满分」的表象）。
    const fixClosed = path.join(FIX, "corpus-closed.md");
    w(fixClosed, [
      "# 夹具 · 只有闭合 span",
      "",
      "## 通用节",
      "",
      "- **甲条**：正文写着 `[自定@01-01]` 字面量。 [n=1 @07-01 触发:无] [仅判据·无触发]",
      "- **乙条**：正文写着 `[#测-不存在]` 假 slug。 [n=2 @07-02 触发:PR流程]",
      "",
    ].join("\n"));
    const sjC = sourcesJson(path.join(TMP, "mut", "src-closed.json"),
      [{ file: fixClosed, selector: "marked", role_scheme: "general" }]);
    const runWith = (jsM, psScript, srcJson) =>
      rec(runNode(jsM.script, ["--reconcile", "--sources-json", srcJson, "--ps-script", psScript]).rec);

    // 负控：干净的两侧在这份靶上必须绿且两边都数到 2 —— 否则下面的红全都不算数。
    const psClean = psMutant("ps-clean", []);
    const baseU = runWith(baseM, psClean.script, sjU);
    check("负控：干净副本（含 PS 拷贝）在未闭合游程靶上绿，两侧各 2 条",
      baseU && baseU.exit === 0 && baseU.mine === 2 && baseU.theirs === 2, JSON.stringify(baseU));

    // ── E：JS 配对层 + PS 主实现**同时**改坏 ────────────────────────────
    const mE = mutantDir("both-sides", (t) => {
      const before = t;
      const text = t.split(JS_EDIT.from).join(JS_EDIT.to);
      return { text, applied: text === before ? 0 : 1 };
    });
    const psE = psMutant("ps-main-broken", [PS_MAIN_EDIT]);
    check("E：JS 侧 mutation 真的改到了", mE.applied === 1, "applied=" + mE.applied);
    check("E：PS 侧 mutation 真的改到了", psE.applied === 1, "applied=" + psE.applied);
    // canary 两条：①零反引号语料 —— 证明变异体还跑得起来（没被 BOM/编码弄死）；
    //              ②只有闭合 span 的语料 —— 证明改动精确落在 unmatched 那一支。
    // 只做①不够：一个把整套遮罩弄死的变异体在①上照样绿（那条路径压根不走）。
    const canaryE = runWith(mE, psE.script, sj);
    check("canary E①：变异体对在零反引号语料上仍绿且两侧同数（活着）",
      canaryE && canaryE.exit === 0 && canaryE.mine === canaryE.theirs && canaryE.mine > 0, JSON.stringify(canaryE));
    const canaryEc = runWith(mE, psE.script, sjC);
    check("canary E②：只有闭合 span 的语料上仍绿且两侧各 2 条（只坏在 unmatched 那一支）",
      canaryEc && canaryEc.exit === 0 && canaryEc.mine === 2 && canaryEc.theirs === 2, JSON.stringify(canaryEc));
    const rE = runWith(mE, psE.script, sjU);
    check("E：两侧同坏后**条款数仍然逐字相等**（这就是旧结构下对账全绿的原因）",
      rE && rE.mine === rE.theirs && rE.mine === 1, JSON.stringify(rE));
    check("E：而对账仍然变红 —— 红的唯一来源是对方的 maskdiv（第三套实现顶出来的）",
      rE && rE.exit !== 0 && rE.mismatched === 1, JSON.stringify(rE));

    // ── F：把 maskdiv 从对账里摘掉（"对账坏"）⇒ E 必须变绿 ────────────────
    // 这一向验的不是被测逻辑，是**上面那条断言到底是谁在承重**。不做它的话，
    // 「E 变红」可以被别的原因解释（比如 PS 退出码碰巧被算进去了），断言就只是巧合。
    // F 的 JS 侧必须与 E 完全一样地坏（否则测的就不是同一个场景了），
    // 差别只在**对账那一步**：把 maskdiv 那一栏摘掉。
    const mF = mutantDir("recon-blind", (t) => {
      const before = t;
      const text = t.split(JS_EDIT.from).join(JS_EDIT.to);
      return { text, applied: text === before ? 0 : 1 };
    });
    check("F：JS 侧与 E 同样地坏（锚命中）", mF.applied === 1, "applied=" + mF.applied);
    // ⚠ 「摘掉 maskdiv」这一处落在 gen-clause-index.mjs 而不是 clause-parser.mjs，
    //   而 mutantDir 的 mutate 只改 lib ⇒ 这里手工覆写那一份（它就在 mF 的目录里）。
    {
      const genSrc = fs.readFileSync(GEN, "utf8");
      const patched = genSrc.split("    const okMask = ps.marker.maskdiv === 0;")
        .join("    const okMask = true; void ps.marker.maskdiv;");
      check("F：对账侧 mutation 真的改到了（锚还在）", patched !== genSrc, "锚没命中");
      w(mF.script, patched);
    }
    const rF = runWith(mF, psE.script, sjU);
    check("F：摘掉 maskdiv 那一栏后，同一个「两侧同坏」当场变绿 ⇒ 反证这条通道承重",
      rF && rF.exit === 0 && rF.mismatched === 0, JSON.stringify(rF));

    // ── G：三套一起坏 ⇒ 全绿（已知残余，钉成断言）────────────────────────
    // 钉住它的两个理由（同 PS 回归网 C 组）：①这一格从"没人知道"变成"写下来了"；
    // ②将来有人加了第四道独立判据、这一格能红了，本条会当场失败，逼着来人回来改注释。
    // 一个没有断言的已知弱点，与一个没人知道的缺陷没有区别。
    const psG = psMutant("ps-both-broken", [PS_MAIN_EDIT, PS_ALT_EDIT]);
    check("G：PS 两处 mutation 都改到了", psG.applied === 2, "applied=" + psG.applied);
    const canaryG = runWith(mE, psG.script, sj);
    check("canary G：三变异体在零反引号语料上仍绿（活着）",
      canaryG && canaryG.exit === 0 && canaryG.mine === canaryG.theirs, JSON.stringify(canaryG));
    const rG = runWith(mE, psG.script, sjU);
    check("G：三套同错 ⇒ 对账**全绿**（已知残余：n 套互核抓不到 n 套同错，是算术不是疏漏）",
      rG && rG.exit === 0 && rG.mismatched === 0, JSON.stringify(rG));
    check("G：而两侧确实都少数了一条（1 条，非 2 条）—— 残余的代价长这样",
      rG && rG.mine === 1 && rG.theirs === 1, JSON.stringify(rG));

    // ── 负控：对方是"没有 maskdiv 栏的老版本"时不许静默放行 ────────────────
    // 「跑不了 ≠ 一致」在本文件是既定政策（见头注取舍③）。少一栏＝那一层无人在看，
    // 与「看过且零分歧」必须分得开。
    // 只摘**格式串**里的占位符、不动 `-f` 后面的实参：`String.Format` 允许实参多于占位符，
    // 于是这个 mutation 是单行的、且产出的脚本仍是合法 PowerShell。
    const psOld = psMutant("ps-no-maskdiv", [{ from: " maskdiv={9} maskcmp={10}", to: "" }]);
    check("老版本负控：锚命中（marker 里那两栏被摘掉了）", psOld.applied === 1, "applied=" + psOld.applied);
    const rOld = runWith(baseM, psOld.script, sjU);
    check("老版本负控：对方末行没有 maskdiv 栏 ⇒ 判红，不当成一致",
      rOld && rOld.exit !== 0 && rOld.mismatched === 1, JSON.stringify(rOld));
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ⑦ 条款台账（clause-ledger.json）：双向孤儿 + 双轨对账 ────");
  {
    const LDIR = path.join(TMP, "ledger");
    const corpus = path.join(LDIR, "corpus.md");
    const CORPUS_TEXT = [
      "# 夹具 · 台账语料",
      "",
      "## 通用节",
      "",
      "- **甲条**：行内字段齐全。 [n=1 @07-01 触发:PR流程] [基线:合成甲] [#测-甲]",
      "- **乙条**：只有基线 + slug（`[n= @ 触发:]` 那一栏正文没写）。 [基线:合成乙] [#测-乙]",
      "- **丙条**：正文里写着 `[自定@<月日>]` 这个模板字面量（在反引号内，不该被当成真标记）。 [n=2 @07-02 触发:无] [仅判据·无触发] [#测-丙]",
      // 丁 / 戊是 v3（批 3 · 单轨期）加的两个夹具，**两个都要**才夹得住新契约的两侧：
      //   丁 = 批 3 之后 dao.md 的常态（行尾只剩 slug）⇒ 它证「正文没写就不比」；
      //   戊 = 行内确实写着 `[自定@]` ⇒ 它证「正文写了就还是要比」那一半**没被放松掉**。
      //   只留丁会让「对账被整个关掉」和「新契约」在测试里长得一样。
      "- **丁条**：单轨形态，行尾只剩 slug。 [#测-丁]",
      "- **戊条**：行内带真的自定标记。 [n=1 @07-05 触发:PR流程] [自定@07-05] [#测-戊]",
      "",
    ].join("\n");
    const sj = sourcesJson(path.join(LDIR, "src.json"),
      [{ file: corpus, selector: "all-top-level", role_scheme: "dispatch-sections" }]);
    const ledgerPath = path.join(LDIR, "ledger.json");
    const IDX = path.join(LDIR, "index.json");
    const baseLedger = () => ({
      schema_version: 1,
      clauses: {
        "测-甲": { file: corpus, n: "1", first_seen: "07-01", trigger: "PR流程", judge_only: false, self_authored: [], baseline: "合成甲", source_refs: [], status: "active" },
        "测-乙": { file: corpus, n: null, first_seen: null, trigger: null, judge_only: false, self_authored: [], baseline: "合成乙", source_refs: [], status: "active" },
        "测-丙": { file: corpus, n: "2", first_seen: "07-02", trigger: "无", judge_only: true, self_authored: [], baseline: null, source_refs: [], status: "active" },
        // 丁：台账**有**全套值而正文一栏都没写 —— 批 2 的旧契约判这是红，v3 判绿（台账为准）。
        "测-丁": { file: corpus, n: "7", first_seen: "07-06", trigger: "PR流程", judge_only: false, self_authored: ["07-06"], baseline: "合成丁", source_refs: [], status: "active" },
        "测-戊": { file: corpus, n: "1", first_seen: "07-05", trigger: "PR流程", judge_only: false, self_authored: ["07-05"], baseline: null, source_refs: [], status: "active" },
      },
    });
    const writeLedger = (doc) => w(ledgerPath, JSON.stringify(doc, null, 2) + "\n");
    // 台账检查跑在**生成模式**：--check 会先因索引过期而红，两个信号混在一个退出码里就分不开谁红了。
    const runLedger = () => {
      const r = runNode(GEN, ["--quiet", "--sources-json", sj, "--ledger", ledgerPath, "--out", IDX]);
      // v3 两栏（compared / ledgeronly）**必须捕到**：它们是 mismatch 的分母与「以台账为准」的计数。
      // 写成必需分组而不是可选，是刻意的 —— 少了那两栏就说明有人把分母摘掉了，
      // 那一刻 `led` 会变成 null，下面每条断言都红，而不是静默按老格式跑下去。
      const m = /CLAUSE_LEDGER_SUMMARY exit=(\d+) state=(\S+) entries=(\d+) slugs=(\d+) missing_slug=(\d+) orphan_slug=(\d+) orphan_ledger=(\d+) dup_slug=(\d+) mismatch=(\d+) file_mismatch=(\d+) out_of_scope=(\d+) compared=(\d+) ledgeronly=(\d+)/.exec(r.out);
      return {
        code: r.code, out: r.out,
        led: m ? {
          exit: +m[1], state: m[2], entries: +m[3], slugs: +m[4], missing_slug: +m[5],
          orphan_slug: +m[6], orphan_ledger: +m[7], dup_slug: +m[8], mismatch: +m[9],
          file_mismatch: +m[10], out_of_scope: +m[11], compared: +m[12], ledgeronly: +m[13],
        } : null,
      };
    };

    // ── 负控先行：干净态必须绿。否则下面每个红都不算数（恒红的断言 = 废话）──
    w(corpus, CORPUS_TEXT);
    writeLedger(baseLedger());
    const clean = runLedger();
    check("负控：干净态 exit 0 且末行 state=ok",
      clean.code === 0 && clean.led && clean.led.exit === 0 && clean.led.state === "ok",
      JSON.stringify(clean.led) + clean.out.slice(0, 500));
    check("负控：5 条 slug 全对上、六个违规计数全 0",
      clean.led && clean.led.slugs === 5 &&
      [clean.led.missing_slug, clean.led.orphan_slug, clean.led.orphan_ledger,
        clean.led.dup_slug, clean.led.mismatch, clean.led.file_mismatch].every((x) => x === 0),
      JSON.stringify(clean.led));
    check("代码 span 假阳性负控：反引号里的 `[自定@<月日>]` 没被当成真标记（当成了的话 self_authored 会不等）",
      clean.led && clean.led.mismatch === 0, clean.out.slice(0, 600));
    // ── v3 分母断言：`mismatch=0` 有两种读法，只有分母能分开它们 ──────────────
    // 逐条手算（改夹具就要一起改这个数，这是刻意的棘轮）：
    //   甲 hasMeta ⇒ n/first_seen/trigger/judge_only 4 比 + baseline 1 比；self 空 ⇒ 1 记台账
    //   乙 无 meta ⇒ 4 记台账 + baseline 1 比；self 空 ⇒ 1 记台账
    //   丙 hasMeta ⇒ 4 比；baseline 空 1 记台账；self 空 1 记台账
    //   丁 只剩 slug ⇒ 4+1+1 = 6 全记台账，0 比
    //   戊 hasMeta ⇒ 4 比 + self 1 比；baseline 空 1 记台账
    //   合计 compared = 5+1+4+0+5 = 15 · ledgeronly = 1+5+2+6+1 = 15
    check("v3 分母：compared=15 / ledgeronly=15（写死是刻意的——把对账整个关掉时这一条先红）",
      clean.led && clean.led.compared === 15 && clean.led.ledgeronly === 15, JSON.stringify(clean.led));

    // ── 方向一：正文删掉一个 slug ⇒ 台账那条成孤儿，且该条款失去 slug ──
    w(corpus, CORPUS_TEXT.replace(" [#测-甲]", ""));
    const dropSlug = runLedger();
    check("正文删一个 slug ⇒ 红，且 orphan_ledger 与 missing_slug 各报一次（两个方向各说各的）",
      dropSlug.code === 1 && dropSlug.led && dropSlug.led.orphan_ledger === 1 && dropSlug.led.missing_slug === 1,
      JSON.stringify(dropSlug.led) + dropSlug.out.slice(0, 700));
    w(corpus, CORPUS_TEXT);
    check("改回去 ⇒ 又绿（负控：不是恒红）", runLedger().code === 0);

    // ── 方向二：台账删掉一条 ⇒ 正文那个 slug 成了指向空气的指针 ──
    {
      const d = baseLedger(); delete d.clauses["测-乙"]; writeLedger(d);
      const r = runLedger();
      check("台账删一条 ⇒ 红且报 orphan_slug（正文有 slug 而台账无此条）",
        r.code === 1 && r.led && r.led.orphan_slug === 1 && r.led.orphan_ledger === 0,
        JSON.stringify(r.led) + r.out.slice(0, 600));
      writeLedger(baseLedger());
    }

    // ── 方向三：台账值被改 ⇒ 双轨不等。**逐字段各验一次** ——
    //    只验一个字段就宣称「对账有效」，是本仓明训里那种「改法方向单一」的错。
    for (const [field, bad] of [["n", "9"], ["first_seen", "12-31"], ["trigger", "改配置"], ["baseline", "被改过的基线"]]) {
      const d = baseLedger(); d.clauses["测-甲"][field] = bad; writeLedger(d);
      const r = runLedger();
      check("台账改 " + field + " ⇒ 红且 mismatch=1",
        r.code === 1 && r.led && r.led.mismatch === 1, JSON.stringify(r.led) + r.out.slice(0, 400));
    }
    {
      const d = baseLedger(); d.clauses["测-丙"].judge_only = false; writeLedger(d);
      const r = runLedger();
      check("台账改 judge_only ⇒ 红（布尔字段也在对账面里）",
        r.code === 1 && r.led && r.led.mismatch === 1, JSON.stringify(r.led));
      // ── v3 单轨契约的两侧，各夹一次 ──────────────────────────────────────────
      // 🔴 下面头两条**在批 2 是反过来的断言**（那时判红），批 3 起判绿。照直记，别当成新写的：
      //    旧契约「行内没写 ⇒ 台账侧应为 null，台账有值即红」只在双轨期成立；批 3 把 dao.md
      //    的行内元字段整批删掉、只留 slug 之后，那一条会把设计要的终态判成 84 处违例。
      //    **这是放松**（新通过集是旧的真超集），补偿是上面那条 compared/ledgeronly 分母断言。
      const d2 = baseLedger(); d2.clauses["测-甲"].self_authored = ["07-09"]; writeLedger(d2);
      const r2 = runLedger();
      check("v3：正文没写 [自定@] 而台账有值 ⇒ 绿（台账是真相源）",
        r2.code === 0 && r2.led && r2.led.mismatch === 0, JSON.stringify(r2.led));
      const d3 = baseLedger(); d3.clauses["测-乙"].n = "3"; writeLedger(d3);
      const r3 = runLedger();
      check("v3：正文没写 [n= @ 触发:] 而台账有值 ⇒ 绿（同上）",
        r3.code === 0 && r3.led && r3.led.mismatch === 0, JSON.stringify(r3.led));
      const d3b = baseLedger(); d3b.clauses["测-丁"].n = "99"; d3b.clauses["测-丁"].baseline = "改过"; writeLedger(d3b);
      const r3b = runLedger();
      check("v3：单轨条款（只剩 slug）台账怎么改都不判红 —— 这正是批 3 之后 dao.md 的常态",
        r3b.code === 0 && r3b.led && r3b.led.mismatch === 0, JSON.stringify(r3b.led));
      // ── 保留的那一半：正文**写了**就还得比。缺了这三条，上面三条会被读成「对账关掉了」──
      const d4 = baseLedger(); d4.clauses["测-戊"].self_authored = ["07-09"]; writeLedger(d4);
      const r4 = runLedger();
      check("v3 反向：正文写了 [自定@07-05] 而台账不同 ⇒ 仍然红",
        r4.code === 1 && r4.led && r4.led.mismatch === 1, JSON.stringify(r4.led));
      const d5 = baseLedger(); d5.clauses["测-乙"].baseline = "被改过的基线"; writeLedger(d5);
      const r5 = runLedger();
      check("v3 逐字段而非整条：乙条正文只写了 [基线:]，改它 ⇒ 红（同一条上 n 改了却不红，见上）",
        r5.code === 1 && r5.led && r5.led.mismatch === 1, JSON.stringify(r5.led));
      const d6 = baseLedger(); d6.clauses["测-戊"].trigger = "无"; writeLedger(d6);
      const r6 = runLedger();
      check("v3 反向：正文写了 触发:PR流程 而台账写 无 ⇒ 仍然红",
        r6.code === 1 && r6.led && r6.led.mismatch === 1, JSON.stringify(r6.led));
      writeLedger(baseLedger());
    }

    // ── 方向四：file 指错 / 一行两个 slug / status=retired ──
    {
      const d = baseLedger(); d.clauses["测-甲"].file = "ccswitch/根本不存在的文件.md"; writeLedger(d);
      const r = runLedger();
      check("台账 file 指错 ⇒ 红（file_mismatch 或 out_of_scope 至少一个响）",
        r.code === 1 && r.led && (r.led.file_mismatch === 1 || r.led.out_of_scope === 1), JSON.stringify(r.led) + r.out.slice(0, 500));
      writeLedger(baseLedger());
    }
    {
      w(corpus, CORPUS_TEXT.replace(" [#测-甲]", " [#测-甲] [#测-又甲]"));
      const r = runLedger();
      check("一行两个 slug ⇒ 红且报 dup_slug（关联键必须唯一）",
        r.code === 1 && r.led && r.led.dup_slug === 1, JSON.stringify(r.led) + r.out.slice(0, 500));
      w(corpus, CORPUS_TEXT);
    }
    {
      // retired：正文里确实没有它，而这是**预期**，不该报孤儿。
      const d = baseLedger();
      d.clauses["测-已退役"] = { file: corpus, n: "1", first_seen: "06-01", trigger: "无", judge_only: true, self_authored: [], baseline: null, source_refs: [], status: "retired" };
      writeLedger(d);
      const r = runLedger();
      check("status=retired 的条目不判孤儿（退役的定义就是正文里没有它）",
        r.code === 0 && r.led && r.led.orphan_ledger === 0, JSON.stringify(r.led) + r.out.slice(0, 500));
      writeLedger(baseLedger());
    }

    // ── 台账本身不在 / 坏掉：不许静默变绿 ──
    {
      const gone = path.join(LDIR, "no-such-ledger.json");
      const r = runNode(GEN, ["--quiet", "--sources-json", sj, "--ledger", gone, "--out", IDX]);
      check("台账文件不在而正文有 slug ⇒ 红 + state=missing（「读不了」不等于「没问题」）",
        r.code === 1 && /state=missing/.test(r.out), r.out.slice(0, 500));
      const broken = path.join(LDIR, "broken.json");
      w(broken, "{ 这不是 JSON");
      const r2 = runNode(GEN, ["--quiet", "--sources-json", sj, "--ledger", broken, "--out", IDX]);
      check("台账不是合法 JSON ⇒ 红 + state=bad（与「不在」分得开：两种病两种处方）",
        r2.code === 1 && /state=bad/.test(r2.out), r2.out.slice(0, 500));
    }

    // ── 不适用：零 slug 的语料 + 台账里也没有它 ⇒ state=na 且 exit 0（负控：不是恒红）──
    {
      const sjPlain = sourcesJson(path.join(LDIR, "src-plain.json"),
        [{ file: FIX_A, selector: "all-top-level", role_scheme: "dispatch-sections" }]);
      const r = runNode(GEN, ["--quiet", "--sources-json", sjPlain, "--ledger", ledgerPath,
        "--out", path.join(LDIR, "plain-index.json")]);
      check("零 slug 语料 ⇒ state=na（不适用），不因整本台账把它判成一堆孤儿",
        /state=na/.test(r.out) && r.code === 0, r.out.slice(0, 500));
    }

    // ── 真数据自跑：本节唯一的真语料断言（合成夹具证明不了它在真语料上跑得动）──
    {
      const r = runNode(GEN, ["--check", "--quiet"]);
      check("真仓：索引与台账双绿（红了就是有人动了正文或台账而没跟上另一半）", r.code === 0, r.out.slice(0, 800));
      const m = /CLAUSE_LEDGER_SUMMARY exit=(\d+) state=(\S+) entries=(\d+) slugs=(\d+)/.exec(r.out);
      check("真仓：台账条数 == 正文 slug 数，且 > 0（零条 = 这一节的绿是空的）",
        !!m && +m[3] === +m[4] && +m[4] > 0, m ? m[0] : r.out.slice(0, 400));
    }
  }

  console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " ===");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.log("  FAIL  测试自身抛错  ->  " + (e && e.stack ? e.stack : String(e)));
  console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + (fail + 1) + " ===");
  process.exit(1);
});
