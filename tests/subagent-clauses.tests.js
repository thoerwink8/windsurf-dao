// dao-subagent-clauses hook 回归网 — 映射正控 / 泛型降级 / 渲染失败降级 / fail-open / mutation 双向
//
// 跑法：node tests/subagent-clauses.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 这份回归网真正盯着的那一条 ───────────────────────────────────────────────
// 本 hook 的第一原则是「永不静默空过」：**零注入与注入成功在 transcript 上长得一样**。
// 所以断言的重点不是「渲染对不对」（那是 render-clauses 自己的测试的事），而是
// **每一条路径都还有输出、且输出带得出签名**：映射不出、索引过期、索引根本不在、
// stdin 坏掉、hook 自己抛异常 —— 五条路径逐条验一遍。
//
// ── 两处刻意的做法 ───────────────────────────────────────────────────────────
// ① 全程 `DAO_SUBAGENT_CLAUSES_SELFTEST=1`：心跳因此标 synthetic，`--selfcheck` 不会
//    把测试跑出来的心跳当成「宿主真的调过它」。**测试把自己的接线染绿**是这套脚手架
//    点名要防的假绿，别为了让自检好看而拿掉这个变量。
// ② 语料用**自建夹具**而不是仓里的真索引。**原因 2026-08-02 变了，做法没变**：
//    此前是「真索引里各官种恒为 0 条（默认源清单全是 role_scheme=general 的仓内文件）」，
//    拿它当正控等于永远测不到官种分支；现在 dao-officer-clauses.md 进了默认源清单，
//    真索引里六个官种都有条款了 —— 但**仍然用夹具**：真索引的条数随条款库增删而变，
//    拿它当正控会让这份回归网每次立法都得改一遍数字，而那种数字过期时长得跟通过一样。
//    夹具在 _tmp/ 下现建现用，跑完就是垃圾，不进 git。
//
// ── 判据是近似的，别把全绿读成「官种一定判得对」──────────────────────────────
// agent_type → 官种是两段近似（精确名 + 关键词），而实测 93.8% 的派单用的是通用底座
// （general-purpose / claude），**根本不含官种信息**。这份测试能证明的只有「表里写了的
// 那些名字会被映射成表里写的那个官种」，证明不了「本次派的那个官真的是那个官种」。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-subagent-clauses.js");
const RENDERER = path.join(REPO, "ccswitch", "scripts", "render-clauses.mjs");
const GEN = path.join(REPO, "ccswitch", "scripts", "gen-clause-index.mjs");
const TMP = path.join(REPO, "_tmp", "subagent-clauses-tests");

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

// ── 夹具语料：带官种分节的条款库（形态照 ccswitch/rules/dao-officer-clauses.md）──
const FIXTURE_MD = path.join(TMP, "clauses.md");
fs.writeFileSync(FIXTURE_MD, [
  "# 夹具条款库（测试用，非真语料）",
  "",
  "## 通用节（任意官种派单都应带）",
  "",
  "- 夹具通用一：随便写一句判据。 [n=1 @07-24 触发:模板首行]",
  "- 夹具通用二：另一句判据。 [n=? @07-24 触发:无] [仅判据·无触发]",
  "",
  "## 复审官节",
  "",
  "- 夹具复审：range 要实算。 [n=2 @07-25 触发:模板首行]",
  "",
  "## 实现官节",
  "",
  "- 夹具实现：进 worktree 先核基点。 [n=2 @07-24 触发:模板首行]",
  "",
  "## 对抗验证官节",
  "",
  "- 夹具对抗：mutation 两态都要看到。 [n=1 @07-24 触发:模板首行]",
  "",
  "## 侦察官节",
  "",
  "- 夹具侦察：论断带出处。 [n=1 @07-25 触发:模板首行]",
  "",
  "## dogfood 官节",
  "",
  "- 夹具 dogfood：起隔离实例走脚本。 [n=1 @07-25 触发:start-isolated-dev]",
  "",
].join("\n"), "utf8");

function buildIndex(outName, roleScheme) {
  const srcJson = path.join(TMP, `sources-${outName}.json`);
  fs.writeFileSync(srcJson, JSON.stringify([
    { file: FIXTURE_MD, selector: "all-top-level", role_scheme: roleScheme },
  ], null, 2), "utf8");
  const out = path.join(TMP, outName);
  const r = spawnSync(process.execPath, [GEN, "--sources-json", srcJson, "--out", out, "--quiet"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`夹具索引没建成：exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  return out;
}

// ① 分官种索引（正控用）；② 全 general 索引（「官种节 0 条 ⇒ 退到通用节」那一支的确定性语料）
const IDX_ROLES = buildIndex("index-roles.json", "dispatch-sections");
const IDX_GENERAL_ONLY = buildIndex("index-general.json", "general");

// ── 喂一次 SubagentStart 输入 ───────────────────────────────────────────────
function fire(agentType, opts = {}) {
  const input = JSON.stringify({
    session_id: opts.session || "sess-test",
    transcript_path: opts.transcript === null ? undefined : (opts.transcript || "/fake/main.jsonl"),
    cwd: opts.cwd || REPO,
    hook_event_name: "SubagentStart",
    agent_id: opts.agentId || "agent-test",
    agent_type: agentType,
  });
  return fireRaw(opts.raw != null ? opts.raw : input, opts);
}

function fireRaw(stdin, opts = {}) {
  const env = Object.assign({}, process.env, {
    DAO_SUBAGENT_CLAUSES_SELFTEST: "1",
    DAO_CLAUSE_INDEX: opts.index === null ? "" : (opts.index || IDX_ROLES),
  });
  if (opts.index === null) delete env.DAO_CLAUSE_INDEX;
  if (opts.max) env.DAO_SUBAGENT_CLAUSES_MAX = String(opts.max);
  if (opts.forceError) env.DAO_SUBAGENT_CLAUSES_FORCE_ERROR = opts.forceError;
  if (opts.clauseFile) env.DAO_CLAUSE_FILE = opts.clauseFile;
  // cwd **必须显式给**，不许继承调用者的（2026-08-04 实测事故，见 ④ 组开头那段注释）：
  // stdin 解析不出来时 hook 拿不到输入里的 cwd，退到 process.cwd() 去探项目侧条款库，
  // 于是「在哪个目录敲的命令」会改变断言的结果。默认钉在仓根；要验按 cwd 探到的那一态，
  // 用 opts.spawnCwd 显式指一个。
  const r = spawnSync(process.execPath, [opts.script || HOOK], {
    input: stdin, encoding: "utf8", env, cwd: opts.spawnCwd || REPO,
  });
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch (_) {}
  const hs = out.hookSpecificOutput || {};
  return {
    code: r.status,
    ctx: String(hs.additionalContext || ""),
    event: String(hs.hookEventName || ""),
    sys: String(out.systemMessage || ""),
    raw: String(r.stdout || ""),
    err: String(r.stderr || ""),
  };
}

const SIG = "[dao-subagent-clauses v1]";

console.log("\n──── ① 官种映射正控（夹具索引里六个官种都有语料）────");
{
  const cases = [
    ["Explore", "scout", "精确名"],
    ["dao-reviewer-critical", "reviewer", "关键词 review"],
    ["mousse-implementer", "implementer", "关键词 implement"],
    ["对抗验证官", "adversary", "关键词 对抗"],
    ["dogfood-officer", "dogfood", "关键词 dogfood"],
    ["scout-recon", "scout", "关键词 scout"],
  ];
  for (const [agentType, role, how] of cases) {
    const r = fire(agentType);
    check(`正控：${agentType} → ${role}（${how}）`,
      r.code === 0 && new RegExp(`官种=${role}`).test(r.ctx) && new RegExp(`## ${role} 节`).test(r.ctx),
      `exit=${r.code} head=${JSON.stringify(r.ctx.split("\n")[0])}`);
  }
  const one = fire("mousse-implementer");
  check("正控：注入首行带签名（审计取证靠 Grep 这个签名，不靠问 subagent）", one.ctx.startsWith(SIG));
  check("正控：hookEventName 回填 SubagentStart（宿主 schema 只认这个事件名）", one.event === "SubagentStart");
  check("正控：通用节与官种节同时给（协议是「通用节 + 你那一节」）",
    /## 通用节/.test(one.ctx) && /## implementer 节/.test(one.ctx));
  check("正控：每条带得出出处行号区间（要全文按行号读原文，不发副本）",
    /clauses\.md:\d+-\d+/.test(one.ctx), JSON.stringify(one.ctx.slice(0, 200)));
  check("正控：官种是推断的这件事写在注入里（误判时官那侧当场可纠）",
    /按你所属官种那一节读/.test(one.ctx));
}

console.log("\n──── ② 映射不出（实测占历史派单 93.8%，是主路径不是异常）────");
{
  const generics = ["general-purpose", "claude", "Plan", "dao-plan-writer", "dao-spec-writer", "dao-strategist", "claude-code-guide", ""];
  for (const t of generics) {
    const r = fire(t);
    check(`泛型：${t || "(空 agent_type)"} → 通用节 + 指针，不静默空过`,
      r.code === 0 && /官种=general/.test(r.ctx) && /## 通用节/.test(r.ctx) && /dao-officer-clauses\.md/.test(r.ctx),
      `exit=${r.code} head=${JSON.stringify(r.ctx.split("\n")[0])}`);
  }
  const g = fire("general-purpose");
  check("泛型：注入里写明「官种没映射出来」（不假装这是完整投递）", /映射不出/.test(g.ctx));
  // 2026-08-02：降级目标从「某个项目仓的绝对路径」改为**本仓**官侧档 ⇒ 断言跟着契约改，
  // 且**新断言的通过集是旧断言通过集的真子集**：旧的 `/dispatch-clauses\.md/` 对两种文件名
  // 都放行，新的钉死到具体那一个。放松与收紧在 diff 上长得一样，故此处明写方向。
  check("泛型：Read 指令指向条款库正文路径（本仓官侧档，不是某个项目仓的绝对路径）",
    /dao-officer-clauses\.md/.test(g.ctx) && !/D:\/frank\/mousse-cli/.test(g.ctx), JSON.stringify(g.ctx.slice(-300)));
  // cwd 探测这一支原先拿真实的 mousse-cli 仓当语料 —— dao 的回归网依赖另一个仓存在，
  // 正是本批在拆的倒置依赖（那个仓不在的机器上这条会红，且红得毫无道理）。改用自带夹具目录。
  {
    const projDir = path.join(TMP, "fake-project", "docs", "rules");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "dispatch-clauses.md"), "# 夹具项目条款库\n", "utf8");
    const probed = fire("general-purpose", { cwd: path.join(TMP, "fake-project") });
    check("泛型：条款库路径按 cwd 探得到时用探到的那个（跨项目资产不写死某个仓）",
      /〔按本次 cwd 探到〕/.test(probed.ctx) && /dispatch-clauses\.md/.test(probed.ctx),
      JSON.stringify(probed.ctx.slice(-400)));
  }
  check("泛型：env DAO_CLAUSE_FILE 覆写优先（换机/换项目的逃生口）",
    /\/tmp\/somewhere\/clauses\.md/.test(fire("claude", { clauseFile: "/tmp/somewhere/clauses.md" }).ctx));
}

console.log("\n──── ③ 渲染端 fail-closed 时的降级（三种成因，逐条不许空过）────");
{
  // 成因一：官种合法但这份索引里 0 条（真索引的常态：默认源清单全是 general）
  const a = fire("mousse-implementer", { index: IDX_GENERAL_ONLY });
  check("官种节 0 条 → 退到通用节并写明，不给一份看起来正常的空节",
    a.code === 0 && /官种=general/.test(a.ctx) && /渲染不出/.test(a.ctx) && /## 通用节/.test(a.ctx),
    JSON.stringify(a.ctx.slice(-300)));
  check("降级说明里带渲染器原话（可核验，不是「出错了」三个字）",
    /0 条/.test(a.ctx) || /CLAUSE_RENDER_SUMMARY/.test(a.ctx), JSON.stringify(a.ctx.slice(-300)));

  // 成因二：索引根本不在
  const b = fire("mousse-implementer", { index: path.join(TMP, "no-such-index.json") });
  check("索引不存在 → 仍然注入指针（永不静默空过）",
    b.code === 0 && b.ctx.startsWith(SIG) && /dao-officer-clauses\.md/.test(b.ctx) && b.ctx.length > 100,
    `exit=${b.code} ctx=${JSON.stringify(b.ctx.slice(0, 200))}`);
  check("索引不存在 → 注入里说清没渲染出正文（不让读者以为条款已全给）",
    /渲染不出|没能渲染|没有渲染出/.test(b.ctx), JSON.stringify(b.ctx.slice(0, 300)));

  // 成因三：索引过期（源动了、索引没跟上）—— 渲染端 fail-closed，本 hook 不推翻它
  // 复原用**原字节**而不是正则回删：首版用 `replace(/…\n$/,"\n")` 复原，多留了一个换行 ⇒
  // sha256 仍对不上 ⇒ 此后每个用例都在过期索引上跑，连挂 5 条。整份文件存下来再写回是唯一稳的做法。
  const FIXTURE_BYTES = fs.readFileSync(FIXTURE_MD);
  fs.appendFileSync(FIXTURE_MD, "\n- 夹具新增：源动了但索引没跟上。 [n=1 @07-30 触发:无] [仅判据·无触发]\n", "utf8");
  const c = fire("mousse-implementer");
  check("索引过期 → 渲染端拒绝渲染，本 hook 降级为指针而不是切错行的正文",
    c.code === 0 && c.ctx.startsWith(SIG) && /dao-officer-clauses\.md/.test(c.ctx),
    JSON.stringify(c.ctx.slice(0, 240)));
  check("索引过期 → 注入里点名「过期」这个成因（成因可指认才修得动）",
    /过期/.test(c.ctx), JSON.stringify(c.ctx.slice(0, 300)));
  // 复原夹具，后面的用例继续用它
  fs.writeFileSync(FIXTURE_MD, FIXTURE_BYTES);
  check("夹具已复原（索引重新对得上）——这条一红，后面全部用例都在过期索引上跑，别只修它自己",
    fire("mousse-implementer").ctx.includes("## implementer 节"));
}

console.log("\n──── ④ fail-open：喂什么都不砖会话，且仍然留得下痕 ────");
{
  // ⚠ 本组的期望值依赖**进程 cwd**，这一格 2026-08-04 实测咬过一次：stdin 解析不出来时
  //   hook 拿不到输入里的 cwd，退到 process.cwd() 去探项目侧条款库
  //   （`docs/rules/dispatch-clauses.md` 等）。于是同一份代码 **在 dao 仓目录下全绿、
  //   在某个自带那份文件的项目仓目录下红一条** —— 红绿取决于你在哪个目录敲的命令，
  //   而失败信息里没有任何东西指向「cwd」。三处一起收口：①fireRaw 现在显式给 spawn 一个 cwd
  //   ②scripts/run-tests.mjs 把 cwd 钉在仓根 ③这里把前提本身钉成断言。
  const PROJECT_SIDE_CANDIDATES = ["docs/rules/dispatch-clauses.md", ".claude/rules/dispatch-clauses.md"];
  check("前提：dao 仓自己没有项目侧条款库（哪天有了，下面那条该期望的就不是官侧档）",
    PROJECT_SIDE_CANDIDATES.every((rel) => !fs.existsSync(path.join(REPO, rel))),
    JSON.stringify(PROJECT_SIDE_CANDIDATES));

  const bad = fireRaw("这不是 JSON");
  check("stdin 不是 JSON → exit 0（SubagentStart 拦不了创建，砖掉的只会是这次注入）", bad.code === 0);
  check("stdin 不是 JSON → 仍注入签名 + 条款库指针", bad.ctx.startsWith(SIG) && /dao-officer-clauses\.md/.test(bad.ctx));

  // 正控（另一态）：cwd 里**有**项目侧条款库时，指针必须指那一份 —— 「先按 cwd 探项目侧、
  // 探不到才退官侧档」是设计行为不是缺陷。只验退档那一态的话，这条探测被改成写死也照样全绿。
  const fakeProj = path.join(TMP, "fake-project");
  fs.mkdirSync(path.join(fakeProj, "docs", "rules"), { recursive: true });
  fs.writeFileSync(path.join(fakeProj, "docs", "rules", "dispatch-clauses.md"), "# 假的项目侧条款库\n", "utf8");
  const inProj = fireRaw("这不是 JSON", { spawnCwd: fakeProj });
  check("fail-open 时按 cwd 探到项目侧条款库 ⇒ 指针指它，不再指官侧档（探测真的在跑）",
    inProj.code === 0 && inProj.ctx.startsWith(SIG) &&
      /docs[\\/]rules[\\/]dispatch-clauses\.md/.test(inProj.ctx) && !/dao-officer-clauses\.md/.test(inProj.ctx),
    JSON.stringify(inProj.ctx.slice(0, 300)));
  check("stdin 不是 JSON → systemMessage 留痕（stderr+日志+systemMessage 三重）", /解析 stdin 失败/.test(bad.sys), JSON.stringify(bad.sys));

  const empty = fireRaw("");
  check("空 stdin → exit 0 且仍有注入", empty.code === 0 && empty.ctx.startsWith(SIG));

  const forced = fire("mousse-implementer", { forceError: "1" });
  check("故障注入 @parse → exit 0 + 指针 + 留痕", forced.code === 0 && forced.ctx.startsWith(SIG) && forced.sys.length > 0);

  const forcedRender = fire("mousse-implementer", { forceError: "render" });
  check("故障注入 @render（走最外层 catch）→ exit 0 + 指针 + 留痕",
    forcedRender.code === 0 && forcedRender.ctx.startsWith(SIG) && /注入失败/.test(forcedRender.sys),
    `exit=${forcedRender.code} sys=${JSON.stringify(forcedRender.sys)}`);
  check("故障注入 @render → 注入里不谎称有条款正文", !/## 通用节/.test(forcedRender.ctx));

  const stray = { agent_type: "mousse-implementer" }; // 缺 cwd / agent_id / transcript_path
  const s = fireRaw(JSON.stringify(stray));
  check("输入缺字段（只有 agent_type）→ 照常渲染，不因缺字段崩", s.code === 0 && /官种=implementer/.test(s.ctx));
}

console.log("\n──── ⑤ 注入上限：宁可截断也不越 10,000，且截断这件事必须写在文里 ────");
{
  const r = fire("mousse-implementer", { max: 600 });
  check("超限时硬截断在上限以内", r.ctx.length <= 600, `实际 ${r.ctx.length}`);
  check("超限时签名仍在首行（截断从尾部切，审计锚不丢）", r.ctx.startsWith(SIG));
  check("超限时明说被截断了（静默截断＝无从核验型误裁）", /截断|未列进本次注入/.test(r.ctx), JSON.stringify(r.ctx.slice(-160)));

  // ── 前置探针：真索引新鲜吗（issue #121）─────────────────────────────────────
  // 下面两条读的是**仓里那份真索引**，而它是派生物 —— 它一过期，渲染端 fail-closed，
  // 本 hook 每次都只能退成纯指针，于是这两条会红。**那是连带红，病因不在注入侧。**
  // 不加这个探针的话，读者看到的报文指向的是「注入没给全条款」，
  // **离真正的病因隔了两层**（注入不全 ← 渲染拒绝 ← 索引过期），而第三层才是修法。
  // 实测 2026-08-06：一个分支 merge 主干后（`drift=source`），这套连带红了 1 条。
  // 探针只在**真的过期时**出声（干净时一个字不打：恒响的提示会被训练成盲区）。
  //
  // 🔴 **判据读 `drift=`，不读退出码**（2026-08-06 对抗验证阻断 2）：
  //    `runIndex` 返回的是 `Math.max(indexCode, ledgerCode)` ⇒ 读退出码等于在问
  //    「索引**或**台账有没有事」，而这里要问的是「索引新鲜吗」。首版读了退出码，于是
  //    **台账红 + 索引新鲜**时它谎报「索引已过期（cause=none）」——`cause=none` 就印在
  //    「已过期」旁边，按末行契约那正是「没过期」的意思 —— 并给出**本 PR 自己判定为错的
  //    那条处方**（跑生成器解决不了台账红）。线上 hook 没有这个病（`dao-subagent-clauses.js`
  //    读的是渲染端的漂移专属信号），只有这个探针混过两件事。
  {
    const probe = spawnSync(process.execPath, [GEN, "--check", "--quiet"], { encoding: "utf8", cwd: REPO });
    const out = String(probe.stdout || "");
    const drift = (/CLAUSE_INDEX_SUMMARY [^\n]*?\bdrift=(\S+)/.exec(out) || [])[1] || null;
    if (drift === null) {
      // 取不到 drift 本身要出声：那说明末行契约坏了或它根本没跑起来，**不等于「没漂」**。
      console.log("  ⚠ 前置：读不到 `CLAUSE_INDEX_SUMMARY … drift=` ⇒ 索引新不新鲜**无从判断**（不当成新鲜）。");
      console.log("     exit=" + probe.status + "；先手跑一次 node ccswitch/scripts/gen-clause-index.mjs --check 看它到底怎么了。");
    } else if (drift !== "none") {
      const cause = (/\bcause=(\S+)/.exec(out) || [])[1] || "?";
      console.log("  ⚠ 前置：**仓里那份真索引已过期**（drift=" + drift + " cause=" + cause + "）——");
      console.log("     本节下面若红，多半是**连带**：索引过期 → 渲染端 fail-closed → 注入退成纯指针。");
      console.log("     修法：node ccswitch/scripts/gen-clause-index.mjs（成因与处方见它自己的报文，别在注入侧找）");
    }
  }

  const big = fire("mousse-implementer", { index: null }); // 真索引：通用节 20+ 条，正文上万字
  check("真索引下默认注入不超过 9000（宿主超 10,000 会改成落文件+预览）",
    big.ctx.length <= 9000, `实际 ${big.ctx.length}`);
  check("真索引下退成判据句形态并说明理由（不是悄悄少给）",
    /判据句/.test(big.ctx) || /## 通用节/.test(big.ctx),
    JSON.stringify(big.ctx.slice(0, 300)) + "  ← 若上面打了「真索引已过期」，这条是连带红，先跑生成器");
}

console.log("\n──── ⑥ 心跳：真被调用过才写得出来，且自测心跳不许冒充真实 ────");
{
  const fired = path.join(REPO, "_tmp", "subagent-clauses", "fired.log");
  check("心跳文件写出来了", fs.existsSync(fired));
  const recs = fs.readFileSync(fired, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const last = recs[recs.length - 1];
  check("心跳带得出官种/形态/字符数（自检末次摘要靠它）",
    last && last.role && last.mode && typeof last.chars === "number", JSON.stringify(last));
  check("本测试跑出来的心跳全部标 synthetic（不许把接线染绿）",
    recs.slice(-20).every((r) => r.synthetic === true), JSON.stringify(recs.slice(-3)));
}

console.log("\n──── ⑦ 契约：映射表里的官种必须是渲染端认识的合法取值 ────");
{
  // 合法取值从 `--list-roles` 这条**独立通道**取，不从 hook 源码里再解析一遍 ——
  // 两边读同一份词表才有判别力；抄一遍就是两边一起错、差恒为 0。
  const probe = spawnSync(process.execPath, [RENDERER, "--list-roles", "--index", IDX_ROLES], { encoding: "utf8" });
  const m = String(probe.stdout || "").match(/合法官种：(.+)/);
  const legal = m ? m[1].split("/").map((s) => s.trim()) : [];
  check("渲染端报得出合法官种词表", legal.length >= 5, JSON.stringify(String(probe.stdout || "").slice(0, 120)));
  // 只在**两张映射表那一段**里取值。首版扫全文，把 `"--format", "json"]` 里的 json 与
  // `["--list-roles"]` 也当成了官种 —— 一条契约断言把无关字面量拉进分母，等于自己制造噪音。
  const src = fs.readFileSync(HOOK, "utf8");
  const seg = src.slice(src.indexOf("const AGENT_ROLE_EXACT"), src.indexOf("const S = createHookScaffold"));
  check("映射表那一段定位得到（源码结构变了这条要跟着改）", seg.length > 100 && seg.length < 4000, `seg=${seg.length}`);
  const roles = [...new Set([...seg.matchAll(/"([a-z][a-z-]*)"\]/g)].map((x) => x[1]))];
  check("映射表用到的官种全部在词表内（写错一个字就是每次静默降级，而降级看起来很正常）",
    roles.length >= 5 && roles.every((r) => legal.includes(r)), `映射表=${roles.join(",")} 词表=${legal.join(",")}`);
}

console.log("\n──── ⑦′ 接线：仓里那四个官种型 profile 的名字真的映射得出官种（issue #122 ②）────");
{
  // **这一节测的不是 hook，是「写了有没有挂上」**：件② 的全部机制是「派单时选一个
  // agent type，宿主把它的 name 当 agent_type 下发」⇒ profile 的 name 与映射表之间
  // 有一条**没有任何东西在核**的缝。改个文件名、把 name 写成别的、映射表关键词被改窄，
  // 三种改法都不会让上面任何一条断言变红，而后果是**官种那一节恒 0 条**——
  // 与「本来就没有这一节」在注入文本里长得一样（零检出 ≠ 零存在的又一个实例）。
  //
  // ⚠ 它证不了的：**帅有没有真的去选这个 type**（那是槽位档，没有程序在核，
  //    判据见 `ccswitch/rules/dao-dispatch.md` 的 `[#派-官种底座]`）。
  const AGENTS_DIR = path.join(REPO, "ccswitch", "agents");
  const EXPECT = [
    ["dao-implementer", "implementer"],
    ["dao-adversary", "adversary"],
    ["dao-scout", "scout"],
    ["dao-dogfood", "dogfood"],
    ["dao-reviewer", "reviewer"], // 复审官那一格由既有能力型 profile 承载，不另建
  ];
  for (const [stem, role] of EXPECT) {
    const p = path.join(AGENTS_DIR, stem + ".md");
    const exists = fs.existsSync(p);
    check(`${stem}.md 在盘上（没有 profile 就没有 agent type 可选）`, exists, p);
    if (!exists) continue;
    const text = fs.readFileSync(p, "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const nameLine = fm ? /^name:\s*(\S+)\s*$/m.exec(fm[1]) : null;
    check(`${stem}：frontmatter 的 name 与文件名一致（宿主下发的 agent_type 取的是 name）`,
      !!nameLine && nameLine[1] === stem, nameLine ? nameLine[1] : "没解析出 name");
    const r = fire(nameLine ? nameLine[1] : stem);
    check(`${stem} → 官种 ${role}（映射表命中，官种节真的渲染出来）`,
      r.code === 0 && new RegExp(`官种=${role}`).test(r.ctx) && new RegExp(`## ${role} 节`).test(r.ctx),
      `exit=${r.code} head=${JSON.stringify(r.ctx.split("\n")[0])}`);
  }
  // 负控：同目录下的能力型 profile 不该被误判成官种（它们按能力档分，不按官种分）
  for (const stem of ["dao-strategist", "dao-spec-writer", "dao-plan-writer"]) {
    if (!fs.existsSync(path.join(AGENTS_DIR, stem + ".md"))) continue;
    check(`负控：${stem} 仍走泛型降级（能力型与官种型是两个正交维度，别硬映）`,
      /官种=general/.test(fire(stem).ctx));
  }
  // 四个官种型 profile 的两条设计决定，各钉一条——它们都是「改了不会有任何东西变红」的那类。
  const OFFICER_STEMS = ["dao-implementer", "dao-adversary", "dao-scout", "dao-dogfood"];
  for (const stem of OFFICER_STEMS) {
    const p = path.join(AGENTS_DIR, stem + ".md");
    if (!fs.existsSync(p)) continue;
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(p, "utf8"));
    check(`${stem}：刻意不写 model:（不传 = 继承主会话最贵档；写死一档会把兜底方向反过来）`,
      !!fm && !/^model:/m.test(fm[1]), fm ? fm[1] : "没有 frontmatter");
  }
  {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(path.join(AGENTS_DIR, "dao-scout.md"), "utf8"));
    const tools = fm ? (/^tools:\s*(.+)$/m.exec(fm[1]) || [])[1] || "" : "";
    check("dao-scout：tools 里没有 Edit/Write/Bash（把只读红线从纯文字往机器上挪的那一半）",
      !/\b(Edit|Write|MultiEdit|Bash)\b/.test(tools), JSON.stringify(tools));
  }
}

console.log("\n──── ⑧ --selfcheck：自洽 + 逐面报 + 给得出修法 ────");
{
  // 不断言本机是绿是红（取决于用户注册没注册），断言的是**自检自身自洽**
  const r = spawnSync(process.execPath, [HOOK, "--selfcheck"], {
    encoding: "utf8",
    env: Object.assign({}, process.env, { DAO_CLAUSE_INDEX: IDX_ROLES }),
  });
  const out = String(r.stdout || "");
  check("自检打印注册面与心跳面", /注册/.test(out) && /触发记录/.test(out), JSON.stringify(out.slice(0, 200)));
  check("自检打印当前索引各官种条数（映射表退役的那条观察线）", /各官种条数/.test(out), JSON.stringify(out.slice(-300)));
  check("自检点明双通道过渡（未注册 ≠ 零投递，别误判成条款没人管）", /双通道|首行/.test(out));
  check("自检结论与退出码一致（有 ✗ 即 exit 1，全 ✓ 即 exit 0）",
    /✗/.test(out) ? r.status === 1 : r.status === 0, `exit=${r.status}`);
  check("自检不读 stdin、不挂住", typeof r.status === "number");
}

console.log("\n──── ⑨ mutation 双向：上面那些断言真的在测这两处判据吗 ────");
{
  const src = fs.readFileSync(HOOK, "utf8");

  // 变异体必须落在 **ccswitch/hooks/ 自己那一层**：这个 hook 用 __dirname 定位仓根
  // （ROOT = ../../）并 require("../lib/hook-selfcheck.js")。首版把变异体写进 _tmp/ 子目录，
  // 结果它 MODULE_NOT_FOUND 当场崩掉、输出为空 —— 而「输出为空」恰好是 M2 想断言的现象，
  // **一个环境错误差点被读成一次成功的 mutation**。所以变异体同层放、跑完即删。
  const MUT_DIR = path.dirname(HOOK);
  const mutants = [];
  function writeMutant(tag, from, to) {
    const p = path.join(MUT_DIR, `_tmp-mutant-${tag}.js`);
    fs.writeFileSync(p, src.replace(from, to), "utf8");
    mutants.push(p);
    return p;
  }
  const cleanupMutants = () => { for (const p of mutants) { try { fs.rmSync(p, { force: true }); } catch (_) {} } };
  process.on("exit", cleanupMutants);

  // M1 · 关键词映射：改成永不命中 ⇒ implementer 正控必须掉成 general，而泛型路径不受影响
  const t1 = `[/实现官|implement/i, "implementer"],`;
  check("M1 靶点在源码里唯一存在", src.split(t1).length === 2, `出现 ${src.split(t1).length - 1} 次`);
  const m1 = writeMutant("keyword", t1, `[/__NEVER_MATCHES__/i, "implementer"],`);
  const before1 = fire("mousse-implementer");
  const after1 = fire("mousse-implementer", { script: m1 });
  check("M1：真文件映射到 implementer、改坏后掉成 general ⇒ ① 那批断言有判别力",
    /官种=implementer/.test(before1.ctx) && /官种=general/.test(after1.ctx),
    `before=${before1.ctx.split("\n")[0]} after=${after1.ctx.split("\n")[0]}`);
  check("M1：改坏映射后 hook 仍然注入（证明变的是映射，不是整个 hook 崩了）",
    after1.code === 0 && after1.ctx.startsWith(SIG));

  // M2 · 「渲染不出也要给指针」那一支：改成返回空文 ⇒ ③ 的降级断言必须变红
  const t2 = `["（本次没有渲染出任何条款正文，上面那条路径是唯一入口。）"]).join("\\n")),`;
  check("M2 靶点在源码里唯一存在", src.split(t2).length === 2, `出现 ${src.split(t2).length - 1} 次`);
  const m2 = writeMutant("empty-degrade", t2, `[]).join("\\n")).slice(0, 0),`);
  const noIndex = { index: path.join(TMP, "no-such-index.json") };
  const before2 = fire("mousse-implementer", noIndex);
  const after2 = fire("mousse-implementer", Object.assign({ script: m2 }, noIndex));
  check("M2：真文件在渲染全失败时仍给指针、改坏后注入变空 ⇒ 「永不静默空过」是被测着的",
    /dao-officer-clauses\.md/.test(before2.ctx) && after2.ctx === "",
    `before=${JSON.stringify(before2.ctx.slice(0, 60))} after=${JSON.stringify(after2.ctx.slice(0, 60))}`);
  // 这一条是 M2 的**环境负控**：变异体必须是"跑起来了但注入变空"，不是"根本没跑起来"。
  // 两者的 ctx 都是空串，只有退出码分得开 —— 少了它，一次 MODULE_NOT_FOUND 会被读成 mutation 成功。
  check("M2：改坏后 exit 仍是 0（说明变异体真的跑起来了，空注入是判据被改坏所致而非崩溃）",
    after2.code === 0, `exit=${after2.code} stderr=${JSON.stringify(after2.err.slice(0, 160))}`);

  cleanupMutants();
  check("变异体已清理（ccswitch/hooks/ 下不留残骸，否则死闸检测会把它报成孤儿）",
    !fs.existsSync(m1) && !fs.existsSync(m2));
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
