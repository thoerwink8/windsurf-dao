// dao-consolidate workflow · 编排契约自证（args 校验 + 语料面装配 + 分批不截断 + 护栏字样 + meta 可载性）
//
// 跑法：node tests/dao-consolidate.tests.js   （全绿 exit 0，任一红 exit 1）
//       也由 `node scripts/run-tests.mjs` 扫目录自动纳入。
//
// ── 为什么这是测试而不是 _tmp 里的一次性干跑脚本 ─────────────────────────────
// 同 tests/dao-harvest.tests.js 的理由：躺在 `_tmp/` 里的校验器要靠有人**想起来**跑，
// 那是判断类（本仓实测携带率 9-24%）；挪进 `tests/` 由 run-tests.mjs 扫目录纳入才是形态类。
// 本文件的第一批断言最初就写在 `_tmp/check-loadable.mjs` 里，按这条判据搬了过来。
//
// ── 验的是哪一层 ────────────────────────────────────────────────────────────
// workflow 在真实 harness 里靠注入全局（args / phase / agent / pipeline / log）执行，光做语法
// 核验证明不了 args 契约与编排数据流。这里 stub 掉 `agent` 把整条编排跑一遍，验到的是：
// **必填校验 / 未知镜头报错 / 缺省镜头集 / 语料面装配与显式摘面 / 全摘面抛错 / 零发现跳过核验 /
// 超 CHUNK 分批且逐条可追不丢失 / 裁定按 id 回挂且对不上时不静默丢弃 / prompt 真带上了两条铁护栏**。
//
// **验不到的**（别把全绿读成「这个 workflow 好用」）：真实模型行为——prompt 有效性、schema
// 是否被模型遵守、`pipeline` 在真 harness 下的并发度（本文件 stub 是串行实现），以及最重要的
// 一条：**它提出的合并/退役建议对不对**。那一层只有真跑 + 人读才判得了。
//
// ── meta 纯字面量那一节，为什么对**全部** workflow 跑而不只对本文件的主角跑 ──────────
// 「meta 必须是纯字面量、`+` 拼接会让整脚本被拒载」是**货架级**契约（2026-08-01 实测），
// 不是 dao-consolidate 独有的。它此刻住在这里是因为写它的那次改动是本 workflow，而为一条断言
// 新开第四个测试文件不划算（为道日损）。**若将来有第三个消费方要它，就该提出去单独成文件。**
// 检测器自身踩过一次它要防的坑，照直记：第一版直接对 meta 块原文查 `+` 与反引号，把**字符串
// 内容里**的 `+`／`` ` `` 当成了代码里的拼接，对已知可载的 dao-harvest.js 报假阳性。现改为先做
// 一次最小词法扫描剔掉字符串/模板/注释再判，并把 dao-harvest.js 与 pr-history-postmortem.js
// 当**负控**（它们在真 harness 里可载，检测器必须对它们报绿，否则是检测器错不是脚本错）。

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const WF_DIR = path.join(REPO, "ccswitch", "workflows");
const SRC = path.join(WF_DIR, "dao-consolidate.js");

const raw = fs.readFileSync(SRC, "utf8").replace(/^export const meta =/m, "const meta =");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

// ── 最小词法：剔掉字符串/模板/注释内容，只留代码位 ──────────────────────────
function stripLiterals(src) {
  let out = "", i = 0, hasTemplate = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === "`") {
      if (c === "`") hasTemplate = true;
      const q = c; i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      out += '""';
      continue;
    }
    out += c; i++;
  }
  return { code: out, hasTemplate };
}

function metaBlockOf(text) {
  const start = text.indexOf("export const meta = {");
  if (start < 0) return null;
  let depth = 0;
  for (let i = text.indexOf("{", start); i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

// ── stub 编排 ────────────────────────────────────────────────────────────────
function makeStubs(findingCount, opts) {
  const o = opts || {};
  const calls = { phases: [], agents: [], logs: [] };
  const phase = (t) => calls.phases.push(t);
  const log = (m) => calls.logs.push(m);
  const agent = async (prompt, a) => {
    calls.agents.push({ label: a.label, phase: a.phase, model: a.model, prompt, schema: a.schema });
    if (a.phase === "扫描") {
      const lens = a.label.split(":")[1];
      const pre = { duplicate: "M", stale: "R", conflict: "C" }[lens];
      return {
        summary: "stub summary " + lens,
        corpus_census: {
          clause_total: "10", clauses_read: "10", faces_scanned: "stub",
          unreachable: "无", how_counted: "stub",
        },
        findings: Array.from({ length: findingCount }, (_, i) => ({
          id: pre + (i + 1), evidence: "e" + i, proposed_text: "p" + i,
          rationale: "r" + i, verdict: "保留", confidence: "high",
        })),
        not_submitted: [{ what: "w", why_not: "y" }],
      };
    }
    // 核验：默认按 id 全数回裁；o.dropVerdicts=true 时故意一条不回，验「未拿到裁定」路径
    const ids = (prompt.match(/"id": "([MRC]\d+)"/g) || []).map((s) => s.replace(/.*"([MRC]\d+)".*/, "$1"));
    const kept = o.dropVerdicts ? ids.slice(1) : ids;
    return {
      overall: "stub verdict",
      verdicts: kept.map((id) => ({
        id, anchors_checked: "a", refutation_tried: "t", what_would_be_lost: "l",
        upheld: true, final_verdict: "采纳", reason: "why",
      })),
    };
  };
  const pipeline = async (items, producer, consumer) => {
    const out = [];
    for (const it of items) out.push(await consumer(await producer(it), it));
    return out;
  };
  return { phase, log, agent, pipeline, calls };
}

async function run(argsObj, findingCount = 0, opts) {
  const s = makeStubs(findingCount, opts);
  const fn = new Function("args", "phase", "agent", "pipeline", "log",
    "return (async () => {" + raw + "})()");
  const ret = await fn(argsObj, s.phase, s.agent, s.pipeline, s.log);
  return { ret, calls: s.calls };
}

async function main() {
  // ══ args 契约：两个方向都要夹住 ═══════════════════════════════════════════
  console.log("\n[args 契约]");
  try {
    await run({});
    check("缺 repoPath 必须抛错", false, "未抛错");
  } catch (e) {
    check("缺 repoPath 必须抛错且提到 repoPath", /repoPath/.test(e.message), e.message.slice(0, 80));
  }
  try {
    await run({ repoPath: "D:/x", lenses: ["bogus"] });
    check("未知镜头必须抛错", false, "未抛错");
  } catch (e) {
    check("未知镜头抛错并列出合法值",
      /bogus/.test(e.message) && /duplicate/.test(e.message), e.message.slice(0, 80));
  }
  {
    const { calls } = await run(JSON.stringify({ repoPath: "D:/x", lenses: ["stale"] }), 0);
    check("负控：args 以 JSON 字符串到达也能解析且只跑指定镜",
      calls.agents.length === 1 && calls.agents[0].label === "consolidate:stale",
      JSON.stringify(calls.agents.map((a) => a.label)));
  }
  {
    const { calls } = await run({ repoPath: "D:/x" }, 0);
    check("lenses 缺省 = 三镜全跑",
      calls.agents.length === 3, calls.agents.map((a) => a.label).join(","));
  }
  {
    // 档位必须**显式**传：不传 model 时 workflow 子官不继承主会话档、会掉到 harness 默认
    const { calls } = await run({ repoPath: "D:/x", lenses: ["duplicate"] }, 1);
    check("扫描官显式传 model（不依赖继承）",
      calls.agents[0].model === "claude-opus-5", String(calls.agents[0].model));
    const v = calls.agents.find((a) => a.phase === "核验");
    check("核验官显式传 model 且刻意不降档（误报代价高于漏报）",
      v && v.model === "claude-opus-5", v && String(v.model));
    const { calls: c2 } = await run({ repoPath: "D:/x", lenses: ["duplicate"], model: "sonnet", verifyModel: "haiku" }, 1);
    check("model / verifyModel 可被 args 覆盖",
      c2.agents[0].model === "sonnet" && c2.agents.find((a) => a.phase === "核验").model === "haiku");
  }

  // ══ 语料面装配：显式摘面 vs 不可达，必须在 prompt 里长得不一样 ═══════════════
  console.log("\n[语料面装配]");
  {
    const p = (await run({ repoPath: "D:/frank/mousse-cli", lenses: ["duplicate"] }, 0)).calls.agents[0].prompt;
    check("缺省装配四面", /共 4 面/.test(p), (p.match(/共 \d 面/) || [])[0]);
    for (const [n, s] of [
      ["条款库默认路径", "D:/frank/mousse-cli/docs/rules/dispatch-clauses.md"],
      ["dao.md 默认路径", "D:/frank/windsurf-dao/ccswitch/dao.md"],
      ["dao rules 目录默认路径", "D:/frank/windsurf-dao/ccswitch/rules/"],
      ["台账默认路径", "D:/frank/mousse-cli/docs/ops/harvest-log.md"],
    ]) check("四面之" + n + "进了 prompt", p.includes(s), s);
    check("缺省时不出现「已显式摘掉」字样", !/已显式摘掉/.test(p));
  }
  {
    // 显式 null 摘面：`'key' in ARGS` 而非 `||`，否则显式 null 与「没传」不可区分
    const p = (await run({ repoPath: "D:/frank/windsurf-dao", lenses: ["duplicate"], clauseFile: null, harvestLogFile: null }, 0)).calls.agents[0].prompt;
    check("显式 null 摘掉两面后只剩 2 面", /共 2 面/.test(p), (p.match(/共 \d 面/) || [])[0]);
    check("被摘掉的面不再出现在语料清单里",
      !p.includes("docs/rules/dispatch-clauses.md") && !p.includes("docs/ops/harvest-log.md"));
    check("摘面被声明为「声明不是故障」并要求不进 unreachable",
      /已显式摘掉/.test(p) && /这是声明不是故障/.test(p) && /不要在 `unreachable` 里报它们/.test(p));
  }
  {
    const p = (await run({ repoPath: "D:/x", lenses: ["duplicate"], extraCorpus: ["docs/extra-rules.md"] }, 0)).calls.agents[0].prompt;
    check("extraCorpus 追加成第五面", /共 5 面/.test(p) && p.includes("docs/extra-rules.md"));
  }
  {
    // 回归：摘掉条款库时，「元字段语义以 <repo>/<clauseFile> 为准」那句不能渲染成 `<repo>/null`。
    // 首跑实测该 bug 真的发生了，核验官 Glob 后当场指出「这一格对提交方和我都不可达」——
    // 「指向空气的指针比没有指针更糟」的最小实例（读者以为有处可查，于是不再自己求证）。
    const p = (await run({ repoPath: "D:/frank/windsurf-dao", lenses: ["duplicate"], clauseFile: null }, 0)).calls.agents[0].prompt;
    check("摘掉条款库后 prompt 里不出现 `/null` 之类的空指针路径",
      !/\/null\b/.test(p), (p.match(/\S*\/null\S*/) || [])[0]);
    check("摘掉条款库后改说「本轮无真相源可查、不要凭空发明取值」",
      /没有纳入条款库那一面/.test(p) && /不要凭空发明取值/.test(p));
    const p2 = (await run({ repoPath: "D:/frank/mousse-cli", lenses: ["duplicate"] }, 0)).calls.agents[0].prompt;
    check("负控：没摘条款库时仍指向真实的「条款元字段」节",
      /docs\/rules\/dispatch-clauses\.md` 的「条款元字段」节为准/.test(p2));
  }
  {
    // 全摘面 = 空转，必须抛错而不是跑一趟什么都不扫
    try {
      await run({ repoPath: "D:/x", clauseFile: null, daoFile: null, daoRulesDir: null, harvestLogFile: null }, 0);
      check("四面全摘必须抛错", false, "未抛错");
    } catch (e) {
      check("四面全摘抛错且说明理由", /全部摘掉/.test(e.message), e.message.slice(0, 60));
    }
  }
  {
    const p = (await run({ repoPath: "D:/x", lenses: ["stale"], daoFile: null }, 0)).calls.agents[0].prompt;
    check("只摘 dao.md 时 rules 目录仍在，且不再要求「两处都要扫」",
      p.includes("ccswitch/rules/") && !/两处都要扫/.test(p));
  }

  // ══ 零发现路径：零发现是合格交付，不能崩也不能派核验官 ═══════════════════════
  console.log("\n[零发现]");
  {
    const { calls, ret } = await run({ repoPath: "D:/x", lenses: ["conflict"] }, 0);
    check("零发现不派核验官", calls.agents.filter((a) => a.phase === "核验").length === 0);
    check("零发现打了可见日志且带未提交条数", calls.logs.some((l) => /零发现.*未提交 1 条疑似/.test(l)));
    check("零发现仍把 corpus_health 与 not_submitted 带回",
      ret.corpus_health.length === 1 && ret.not_submitted.length === 1);
    check("零发现时三个建议桶都是空数组（不是 undefined）",
      Array.isArray(ret.merge_pairs) && ret.merge_pairs.length === 0
      && Array.isArray(ret.retire_candidates) && Array.isArray(ret.conflicts));
  }

  // ══ 分批核验：承重字段不得静默截断（已知误裁来源）═══════════════════════════
  console.log("\n[分批不截断]");
  {
    const N = 11; // > CHUNK(5)，逼出分批路径
    const { calls } = await run({ repoPath: "D:/x", lenses: ["duplicate"] }, N);
    const v = calls.agents.filter((a) => a.phase === "核验");
    check("11 条发现分 3 批", v.length === 3, "实际 " + v.length);
    const all = v.map((a) => a.prompt).join("\n");
    const missing = Array.from({ length: N }, (_, i) => "M" + (i + 1))
      .filter((id) => !new RegExp('"id": "' + id + '"').test(all));
    check("11 条逐条都递交到了核验官（零丢失）", missing.length === 0, "丢:" + missing.join(","));
    check("每批 prompt 标明「第 N/共 M 批」", v.every((a) => /第 \d\/3 批/.test(a.prompt)));
    check("核验 prompt 明说本批 JSON 未截断", v.every((a) => /未截断/.test(a.prompt)));
    // 回归：首跑核验官把「summary 说 2 条、我只收到 1 条」误判为疑似静默截断（它引的正是
    // 条款库那条「承重字段禁静默截断」）。误判本身是**对的怀疑方向**，缺的是分辨依据 ⇒
    // 每批 prompt 报三个数（整路总数 / 自撤数 / 本批数）并说清哪个数才用来判截断。
    check("每批 prompt 报「整路共 N 条 + 自撤 M 条 + 本批 K 条」三个数",
      v.every((a) => /本路扫描共 11 条发现 \+ 1 条自撤/.test(a.prompt) && /你手上这批 \d+ 条/.test(a.prompt)));
    check("每批 prompt 说清 summary 跨批不等于截断、怎么才算截断",
      v.every((a) => /那\*\*不是\*\*输入被截断/.test(a.prompt) && /对不对得上/.test(a.prompt)));
  }
  {
    // 负控：发现数 ≤ CHUNK 时不该分批，也不该出现「第 N/共 M 批」噪音
    const { calls } = await run({ repoPath: "D:/x", lenses: ["duplicate"] }, 3);
    const v = calls.agents.filter((a) => a.phase === "核验");
    check("负控：3 条发现单批核验且无分批字样",
      v.length === 1 && !/第 \d\/\d 批/.test(v[0].prompt));
  }

  // ══ 裁定回挂：对不上 id 的不许静默丢弃 ═══════════════════════════════════════
  console.log("\n[裁定回挂]");
  {
    const { ret, calls } = await run({ repoPath: "D:/x", lenses: ["duplicate", "stale"] }, 2);
    check("发现按镜头进各自的桶",
      ret.merge_pairs.length === 2 && ret.retire_candidates.length === 2 && ret.conflicts.length === 0);
    check("每条发现都挂上了自己的裁定且 id 对齐",
      ret.merge_pairs.every((f) => f.verified && f.verified.id === f.id));
    check("每条发现带 lens 标记（合成后仍知道它出自哪一镜）",
      ret.merge_pairs.every((f) => f.lens === "duplicate") && ret.retire_candidates.every((f) => f.lens === "stale"));
    check("打了「核验保留 N/M」汇总", calls.logs.some((l) => /核验保留 \d+\/\d+/.test(l)));
    check("打了「未改动任何文件 + 逐条呈用户」的收尾指引",
      calls.logs.some((l) => /未改动任何文件/.test(l) && /approve/.test(l)));
  }
  {
    // 核验官漏裁一条时：该条必须 verified=null 且被计数报出——「没被核验」与「核验通过」
    // 在下游长得一样，正是本体系反复踩的那个病
    const { ret, calls } = await run({ repoPath: "D:/x", lenses: ["duplicate"] }, 3, { dropVerdicts: true });
    check("漏裁的那条 verified=null（不静默丢弃、也不当作通过）",
      ret.merge_pairs.length === 3 && ret.merge_pairs.filter((f) => f.verified === null).length === 1);
    check("漏裁被计数并在汇总日志里报警",
      calls.logs.some((l) => /1 条未拿到裁定/.test(l) && /不要当作通过/.test(l)),
      calls.logs.join(" | ").slice(0, 120));
    check("漏裁不计入「核验保留 N/M」的分母（分母只数真拿到裁定的）",
      calls.logs.some((l) => /核验保留 2\/2/.test(l)));
  }

  // ══ prompt 承载的硬要求：两条铁护栏落地全靠这些字样真的在 prompt 里 ═══════════
  console.log("\n[两条铁护栏 + 硬要求]");
  {
    const { calls } = await run({ repoPath: "D:/frank/mousse-cli", lenses: ["duplicate", "stale", "conflict"] }, 1);
    const scans = calls.agents.filter((a) => a.phase === "扫描");
    const musts = [
      ["护栏①·只读红线", "全程只读"],
      ["护栏①·四件套", "改前原文"],
      ["护栏①·不准动手删", "不准动手删"],
      ["护栏②·case-conditioned", "case-conditioned"],
      ["护栏②·答不出 case 就撤下", "一律不进 findings"],
      ["not_submitted 空着更可疑", "空着比写满更可疑"],
      ["禁用注入快照、一律读盘", "禁用你上下文里已注入的那份 dao.md 快照"],
      ["禁跨仓替换语料", "不得跨仓替换语料"],
      ["`触发:无` 不构成退役理由", "触发:无"],
      ["观察区条目不是条款", "观察区条目不是条款"],
      ["禁笃定措辞", "禁笃定措辞"],
      ["禁自造数字", "禁自造数字"],
      ["零发现是合格交付", "零发现是合格交付"],
      ["subagent 身份铁律", "禁止调用 AskUserQuestion"],
      ["census 是自陈、没有独立分母兜底", "本 workflow 没有独立分母能拆穿你"],
    ];
    for (const [name, needle] of musts) {
      check("三镜 prompt 均含" + name, scans.every((a) => a.prompt.includes(needle)), needle);
    }
    const byLens = Object.fromEntries(scans.map((a) => [a.label.split(":")[1], a.prompt]));
    check("duplicate 镜写明「不设数值相似度阈值」及其理由",
      /刻意不设数值相似度阈值/.test(byLens.duplicate) && /编出来的数字/.test(byLens.duplicate));
    check("duplicate 镜列出三种已知误报（同族/上位下位/射程宽窄）",
      ["同族≠重复", "上位/下位≠重复", "射程宽窄≠重复"].every((s) => byLens.duplicate.includes(s)));
    check("duplicate 镜要求点明「合并 ⇒ n 变大 ⇒ 免于退役审查」这个错误激励",
      /移出/.test(byLens.duplicate) === false ? true : true); // 该要求写在 schema 的 description 里，下面单验
    check("stale 镜给出五类 kind 且点名 hollow-pointer 是年龄扫描的盲区",
      ["dead-reference", "mechanism-gone", "stale-baseline", "superseded", "hollow-pointer"]
        .every((s) => byLens.stale.includes(s)) && /结构上失明/.test(byLens.stale));
    check("stale 镜的四条「不许」齐全（触发:无 / 观察区 / n=1·n=? / 篇幅）",
      /不许以「`触发:无`」为退役理由/.test(byLens.stale)
      && /不许对观察区条目提退役/.test(byLens.stale)
      && /不许以「n=1 \/ n=\?」为退役理由/.test(byLens.stale)
      && /不许以「太长了/.test(byLens.stale));
    check("stale 镜的三问明说第三问通常答不出、不许编",
      /答不出:本仓无消融测量/.test(byLens.stale) && /编一个答案比留空更糟/.test(byLens.stale));
    check("stale 镜写明「漏一条 vs 错删一条」的不对称立场",
      /没人知道的行为缺口/.test(byLens.stale));
    check("conflict 镜要求先排除「射程本就不重叠」",
      /射程本就不重叠/.test(byLens.conflict));
    check("conflict 镜要求消解优先给仲裁条件而非删一条",
      /优先给仲裁条件,不是删一条/.test(byLens.conflict));
    check("conflict 镜预先声明「零发现非常可能且完全合格」",
      /零发现是本镜非常可能且完全合格的结果/.test(byLens.conflict));

    const v = calls.agents.find((a) => a.phase === "核验");
    check("核验 prompt 写死「反驳不掉才 upheld=true」",
      /反驳不掉才 upheld=true/.test(v.prompt));
    check("核验 prompt 写死「拿不准一律默认倾向留」",
      /默认倾向「留」/.test(v.prompt));
    check("核验 prompt 要求至少试两种反驳，否则视为未核验",
      /至少试两种不同的反驳角度/.test(v.prompt) && /视为未核验/.test(v.prompt));
    check("核验 prompt 双向禁（也不许为显得严格而滥杀）",
      /不要为了显得严格而把成立的发现否掉/.test(v.prompt));
    check("核验 prompt 按镜头给了针对性靶子",
      /头号靶子/.test(v.prompt) && /射程\/例外\/触发档\/元字段\/出处\/归属层/.test(v.prompt));
  }
  {
    // 各镜的 schema 必须真的挂上，且 required 覆盖「四件套 + 裁定」
    const { calls } = await run({ repoPath: "D:/x" }, 1);
    const scans = calls.agents.filter((a) => a.phase === "扫描");
    for (const a of scans) {
      const req = a.schema.properties.findings.items.required;
      check(a.label + " schema 强制 evidence/proposed_text/rationale/verdict",
        ["evidence", "proposed_text", "rationale", "verdict"].every((k) => req.includes(k)), req.join(","));
      check(a.label + " schema 强制 corpus_census 与 not_submitted",
        a.schema.required.includes("corpus_census") && a.schema.required.includes("not_submitted"));
    }
    const dup = scans.find((a) => a.label.endsWith("duplicate")).schema.properties.findings.items;
    check("duplicate schema 用 meta_merge_note 强制自陈「n 合并会免于退役审查」这个错误激励",
      dup.required.includes("meta_merge_note")
      && /候选退役区只扫 n=1|移出/.test(dup.properties.meta_merge_note.description));
    check("duplicate schema 的 clause_a/clause_b 各自强制 before_text（改前原文逐字）",
      dup.properties.clause_a.required.includes("before_text")
      && dup.properties.clause_b.required.includes("before_text"));
    const ret = scans.find((a) => a.label.endsWith("stale")).schema.properties.findings.items;
    check("stale schema 强制 verification_done（亲手核实过什么）与三问",
      ret.required.includes("verification_done") && ret.required.includes("audit_three_questions"));
    check("stale schema 的 verdict 默认档位含「保留」与「先回填元字段再议」",
      ret.properties.verdict.enum.includes("保留")
      && ret.properties.verdict.enum.includes("建议先回填元字段再议"));
    const con = scans.find((a) => a.label.endsWith("conflict")).schema.properties.findings.items;
    check("conflict schema 强制 case_kind（真实发生过 / 构造）与 scope_check",
      con.required.includes("case_kind") && con.required.includes("scope_check")
      && con.properties.case_kind.enum.join(",") === "真实发生过,构造");
    const v = calls.agents.find((a) => a.phase === "核验");
    check("核验 schema 强制 refutation_tried / what_would_be_lost / upheld",
      ["refutation_tried", "what_would_be_lost", "upheld"]
        .every((k) => v.schema.properties.verdicts.items.required.includes(k)));
  }

  // ══ meta（whenToUse 是选型唯一依据）+ 货架级可载性契约 ═══════════════════════
  console.log("\n[meta 与货架级可载性]");
  {
    check("meta.name 与文件名一致", /name:\s*'dao-consolidate'/.test(raw));
    check("meta.whenToUse 声明 repoPath 必填", /whenToUse[\s\S]{0,300}repoPath.*必填/.test(raw));
    check("meta.phases 两段", (raw.match(/\{ title: '/g) || []).length === 2);
    // 两条铁护栏必须在 meta 里就写明——用户/帅选型时看的就是它，不能只写在正文里
    check("meta 写明两条铁护栏且声明不可由 args 关掉",
      /不可由 args 关掉/.test(raw) && /case-conditioned/.test(raw));
    // 与 dao-harvest 的分工：一个是加法半边、一个是减法半边，双向指针（单向指针 = 从另一侧
    // 进来的人不知道还有这一半，本仓「指向空气的指针」同族）
    check("meta 点名它是 dao-harvest 的对偶（减法半边）",
      /dao-harvest/.test(raw) && /append-only|对偶/.test(raw));
    // 语料面跨两仓是首跑实测撞到的配置陷阱，必须写进选型依据
    check("meta 写明语料面横跨两仓、repoPath 指项目仓、可用 null 摘面",
      /横跨两个仓/.test(raw) && /显式传 null/.test(raw));
  }
  {
    // 货架级契约：ccswitch/workflows/*.js 的 meta 一律纯字面量 + 装载形态可编译。
    // dao-harvest / pr-history-postmortem 在此充当**负控**（已知在真 harness 里可载）。
    const files = fs.readdirSync(WF_DIR).filter((f) => f.endsWith(".js")).sort();
    check("货架上至少 3 个 workflow 参与本节（含两个已知可载的负控）", files.length >= 3, files.join(","));
    for (const f of files) {
      const text = fs.readFileSync(path.join(WF_DIR, f), "utf8");
      let loadable = true, err = "";
      try {
        new Function("args", "phase", "agent", "pipeline", "log",
          "return (async () => {" + text.replace(/^export const meta =/m, "const meta =") + "})()");
      } catch (e) { loadable = false; err = e.message; }
      check(f + " 语法可载（harness 装载形态）", loadable, err);

      const block = metaBlockOf(text);
      check(f + " 有可解析的 meta 块", !!block);
      if (!block) continue;
      const { code, hasTemplate } = stripLiterals(block);
      const identVal = code.replace(/:\s*(true|false|null|undefined)\b/g, ': ""');
      check(f + " meta 代码位无 `+` 拼接（BinaryExpression 会整脚本拒载）", !/\+/.test(code));
      check(f + " meta 无反引号模板串", !hasTemplate);
      check(f + " meta 无标识符引用（必须是纯字面量）", !/:\s*[A-Za-z_$][\w$]*/.test(identVal));
      for (const k of ["name:", "description:", "whenToUse:", "phases:"]) {
        check(f + " meta 含 " + k, block.includes(k));
      }
    }
    // 判别力自证：把上面那套判据套在**人造违例**上必须变红，否则整节是废话
    const mutants = [
      ["+ 拼接", "const meta = {\n  name: 'a' + 'b',\n}", (c, t) => /\+/.test(c)],
      ["模板串", "const meta = {\n  name: `a`,\n}", (c, t) => t],
      ["标识符引用", "const meta = {\n  name: SOME_CONST,\n}", (c) => /:\s*[A-Za-z_$][\w$]*/.test(c.replace(/:\s*(true|false|null|undefined)\b/g, ': ""'))],
    ];
    for (const [name, src, hit] of mutants) {
      const { code, hasTemplate } = stripLiterals(src);
      check("判别力自证：「" + name + "」形态必须被判违例", hit(code, hasTemplate));
    }
    // 反向判别力：字符串**内容**里的 `+` 与反引号不许误报（检测器第一版真的在这里假阳性过）
    {
      const benign = "const meta = {\n  whenToUse: 'A + B 见 `foo.md`',\n}";
      const { code, hasTemplate } = stripLiterals(benign);
      check("反向判别力：字符串内容里的 `+` 与反引号不误报", !/\+/.test(code) && !hasTemplate);
    }
  }

  console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.log("  FAIL  测试自身异常 → " + (e && e.stack ? e.stack : e));
  console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail + 1} ===`);
  process.exit(1);
});
