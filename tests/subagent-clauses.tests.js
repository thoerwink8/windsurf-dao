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
  // **这一条同时是「stale 不退官种」那支的负控**（issue #162）：它证明「退官种」这个行为
  // 本身还活着 —— 少了它，把 staleOf 改成恒真也不会有任何断言变红（反向 mutation R1 验的就是这个）。
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

  // ── issue #162 用户拍板「塞指针」：stale 那一支补的三格，逐格钉住 ──────────────
  // 改之前的实况照直写：stale **本来就有注入**（它落在「通用节也渲染不出 → 只给指针」那一支），
  // 缺的是下面这三格。所以这几条断言不是「从无到有」，是「从含混到指得动人」。
  check("stale ①：官种不退（过期对每个官种都一样，退了就再也说不出「你那一节」是哪一节）",
    /官种=implementer/.test(c.ctx) && !/官种=general/.test(c.ctx), JSON.stringify(c.ctx.split("\n")[0]));
  check("stale ②：指针把两节都点名（协议是「通用节 + 你那一节」，只给文件名指不动人）",
    /通用节/.test(c.ctx) && /官种那一节/.test(c.ctx) && /Read/.test(c.ctx), JSON.stringify(c.ctx.slice(-420)));
  check("stale ③：渲染端末行原样带进注入，stale=1 仍看得见（帅事后 Grep 得出断供次数）",
    /CLAUSE_RENDER_SUMMARY[^\n]*\bstale=1\b/.test(c.ctx), JSON.stringify(c.ctx.slice(-420)));
  check("stale ④：修法命令来自渲染端报文原话，本文件里不另存一份字面量（双写必漂移）",
    /gen-clause-index/.test(c.ctx), JSON.stringify(c.ctx.slice(-300)));
  check("stale ⑤：仍然说清没渲染出正文（别让读者以为条款已全给）",
    /没有渲染出/.test(c.ctx), JSON.stringify(c.ctx.slice(-420)));
  {
    // 心跳这一格是本次改动的**可数化**收益：改之前 stale 恒 false（那个字段取自渲染结果，
    // 而这条路径压根没有渲染结果）⇒「条款断供了几次」在日志上数不出来。
    const firedLog = path.join(REPO, "_tmp", "subagent-clauses", "fired.log");
    const recs = fs.readFileSync(firedLog, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const last = recs[recs.length - 1];
    check("stale ⑥：心跳记 stale=true 且 mode=stale-pointer（断供数得出来，不再是 0 与没样本同形）",
      last && last.stale === true && last.mode === "stale-pointer", JSON.stringify(last));
  }

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
  // 行尾**必须归一化**（dao 官侧条款「mutation 的锚点要扛得住行尾差异」，2026-08-07 当场实测坐实）：
  // 本仓 `core.autocrlf=true`，工作树里这个文件是 CRLF，于是任何跨行锚点用 `\n` 写都**找不到**，
  // 而失败的样子是「靶点出现 0 次」——看起来像源码结构变了，实际只是行尾。
  // 归一化后写出的变异体是 LF，node 照跑不误。
  const src = fs.readFileSync(HOOK, "utf8").replace(/\r\n/g, "\n");

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
  // 靶点 2026-08-07 随 issue #162 换过一次：原先钉的是那句括号里的脚注文案，它已被祈使句指针取代。
  const t2 = `      text: clamp(head.concat(tail, ptr).join("\\n")),`;
  check("M2 靶点在源码里唯一存在", src.split(t2).length === 2, `出现 ${src.split(t2).length - 1} 次`);
  const m2 = writeMutant("empty-degrade", t2, `      text: clamp(head.concat(tail, ptr).join("\\n")).slice(0, 0),`);
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

  // ── M3 · issue #162 那条新判据（stale ⇒ 指针且不退官种）的三形态 + 反向 ──────────
  // 三形态照 dao 官侧条款「mutation 的改坏要试不止一种形态」：①移除 ②保留字面但不执行
  // ③保留计算与副作用、只让结果不被消费。**三个红集刻意各不相同**，谁也不是谁的子集 ——
  // 若三者红集相同，那说明这批断言其实只在测一件事，多写两个形态是自我安慰。
  const staleMutFiles = [];
  {
    const FIXTURE_BYTES = fs.readFileSync(FIXTURE_MD);
    fs.appendFileSync(FIXTURE_MD, "\n- 夹具新增：把索引弄过期，好让 stale 那一支跑起来。 [n=1 @07-30 触发:无] [仅判据·无触发]\n", "utf8");
    const lastBeat = () => {
      const p = path.join(REPO, "_tmp", "subagent-clauses", "fired.log");
      const recs = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
      return JSON.parse(recs[recs.length - 1]);
    };

    const base = fire("mousse-implementer");
    const baseBeat = lastBeat();
    check("M3 基线：真文件在过期索引下保住官种 + 记 stale 心跳（变异体的对照面是活的）",
      /官种=implementer/.test(base.ctx) && baseBeat.stale === true && baseBeat.mode === "stale-pointer",
      JSON.stringify(baseBeat));

    // ①移除：判据整段拿掉 ⇒ 退回旧行为（退官种），且 stale 那三格全灭
    const t3a = `  const staleFail = !r.ok && r.stale === true;`;
    check("M3a 靶点唯一", src.split(t3a).length === 2, `出现 ${src.split(t3a).length - 1} 次`);
    const m3a = writeMutant("stale-removed", t3a, `  const staleFail = false;`);
    staleMutFiles.push(m3a);
    const a3 = fire("mousse-implementer", { script: m3a });
    const beat3a = lastBeat();
    check("M3a（①移除）：官种掉回 general + 心跳 stale 灭 ⇒ 「不退官种」与「心跳可数」两格都被测着",
      /官种=general/.test(a3.ctx) && beat3a.stale !== true && a3.code === 0,
      `head=${a3.ctx.split("\n")[0]} beat=${JSON.stringify(beat3a)}`);

    // ②保留字面但使其不执行：`staleFail` 这个标识符还在源码里，分支却永不进
    //   ⇒ 文本匹配型的检查（「源码里有没有 staleFail」）对这一形态天然失明，只有行为断言抓得到。
    const t3b = `\n  if (staleFail) {\n    degraded.push(`;
    check("M3b 靶点唯一", src.split(t3b).length === 2, `出现 ${src.split(t3b).length - 1} 次`);
    const m3b = writeMutant("stale-dead-branch", t3b, `\n  if (false && staleFail) {\n    degraded.push(`);
    staleMutFiles.push(m3b);
    const b3 = fire("mousse-implementer", { script: m3b });
    check("M3b（②保留字面但不执行）：官种照样掉回 general ⇒ 抓得住「分支还在但没人走」",
      /官种=general/.test(b3.ctx) && b3.code === 0, `head=${b3.ctx.split("\n")[0]}`);

    // ③保留计算与副作用、结果不被消费：判据照算、degraded 照写、官种照保，
    //   只是**渲染那一侧收不到这个答案** ⇒ 指针少掉「拒投旧版」的说明与修法命令，心跳 stale 灭。
    //   这一形态最像没事：注入还在、长度正常、官种也对，人眼扫一遍看不出任何异常。
    const t3c = `    staleFail,\n    regenHint: r.hint,`;
    check("M3c 靶点唯一", src.split(t3c).length === 2, `出现 ${src.split(t3c).length - 1} 次`);
    const m3c = writeMutant("stale-unconsumed", t3c, `    staleFail: false,\n    regenHint: r.hint,`);
    staleMutFiles.push(m3c);
    const c3 = fire("mousse-implementer", { script: m3c });
    const beat3c = lastBeat();
    check("M3c（③结果不被消费）：官种仍对、注入仍在，但修法命令与 stale 心跳双双消失 ⇒ 红集与 ①② 不同",
      /官种=implementer/.test(c3.ctx) && !/gen-clause-index/.test(c3.ctx) && beat3c.stale !== true,
      `head=${c3.ctx.split("\n")[0]} hasHint=${/gen-clause-index/.test(c3.ctx)} beat=${JSON.stringify(beat3c)}`);

    fs.writeFileSync(FIXTURE_MD, FIXTURE_BYTES);
    check("M3 夹具已复原（索引重新对得上）", fire("mousse-implementer").ctx.includes("## implementer 节"));

    // 反向 mutation：**上面三次全在「让 stale 支失灵」这一侧**，那样「非 stale 的失败仍要退官种」
    //   那条负控一次都不会红 —— 它可能只是因为 stale 支本来就没被触发才通过的。
    //   故把 staleOf 改成恒真：③成因一（官种 0 条）会被误当成索引过期 ⇒ 那条负控必须当场红。
    const t4 = `  return m ? m[1] === "1" : null;`;
    check("R1 靶点唯一", src.split(t4).length === 2, `出现 ${src.split(t4).length - 1} 次`);
    const r1 = writeMutant("stale-always-true", t4, `  return true;`);
    staleMutFiles.push(r1);
    const zeroClauses = { index: IDX_GENERAL_ONLY };
    const beforeR = fire("mousse-implementer", zeroClauses);
    const afterR = fire("mousse-implementer", Object.assign({ script: r1 }, zeroClauses));
    check("R1（反向）：staleOf 恒真后「官种 0 条 → 退通用节」这条负控真的红了 ⇒ 那条负控有判别力",
      /官种=general/.test(beforeR.ctx) && /官种=implementer/.test(afterR.ctx),
      `before=${beforeR.ctx.split("\n")[0]} after=${afterR.ctx.split("\n")[0]}`);
  }

  cleanupMutants();
  check("变异体已清理（ccswitch/hooks/ 下不留残骸，否则死闸检测会把它报成孤儿）",
    !fs.existsSync(m1) && !fs.existsSync(m2) && staleMutFiles.every((p) => !fs.existsSync(p)));
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
