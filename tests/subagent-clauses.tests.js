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

// 重设计后（2026-08-11）渲染端现算、无索引派生物：夹具只需一份 sources-json 指向夹具 md。
function buildSources(outName, roleScheme) {
  const srcJson = path.join(TMP, `sources-${outName}.json`);
  fs.writeFileSync(srcJson, JSON.stringify([
    { file: FIXTURE_MD, selector: "all-top-level", role_scheme: roleScheme },
  ], null, 2), "utf8");
  return srcJson;
}

// ① 分官种语料（正控用）；② 全 general 语料（「官种节 0 条 ⇒ 退到通用节」那一支的确定性语料）
const IDX_ROLES = buildSources("roles", "dispatch-sections");
const IDX_GENERAL_ONLY = buildSources("general", "general");

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
    DAO_CLAUSE_SOURCES: opts.index === null ? "" : (opts.index || IDX_ROLES),
  });
  if (opts.index === null) delete env.DAO_CLAUSE_SOURCES;
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
  // 重设计后（2026-08-11）渲染端现算、无索引派生物：「索引过期」这一成因不复存在；
  // 剩下的三种成因：官种节 0 条 / 语料清单读不到 / 清单里的源文件读不到。

  // 成因一：官种合法但这份语料里 0 条（真仓默认清单的常态：全是 general）
  // **这一条同时是「读不到不退官种」那支的负控**（issue #162）：它证明「退官种」这个行为
  // 本身还活着 —— 少了它，把 sourceDead 判据改成恒真也不会有任何断言变红（反向 mutation 验的就是这个）。
  const a = fire("mousse-implementer", { index: IDX_GENERAL_ONLY });
  check("官种节 0 条 → 退到通用节并写明，不给一份看起来正常的空节",
    a.code === 0 && /官种=general/.test(a.ctx) && /渲染不出/.test(a.ctx) && /## 通用节/.test(a.ctx),
    JSON.stringify(a.ctx.slice(-300)));
  check("降级说明里带渲染器原话（可核验，不是「出错了」三个字）",
    /0 条/.test(a.ctx) || /CLAUSE_RENDER_SUMMARY/.test(a.ctx), JSON.stringify(a.ctx.slice(-300)));

  // 成因二：语料清单文件本身读不到
  const b = fire("mousse-implementer", { index: path.join(TMP, "no-such-sources.json") });
  check("语料清单读不到 → 仍然注入指针（永不静默空过）",
    b.code === 0 && b.ctx.startsWith(SIG) && /dao-officer-clauses\.md/.test(b.ctx) && b.ctx.length > 100,
    `exit=${b.code} ctx=${JSON.stringify(b.ctx.slice(0, 200))}`);
  check("语料清单读不到 → 注入里说清没渲染出正文（不让读者以为条款已全给）",
    /渲染不出|没能渲染|没有渲染出/.test(b.ctx), JSON.stringify(b.ctx.slice(0, 300)));

  // 成因三：清单里的**源文件**读不到 —— 渲染端 fail-closed，本 hook 不推翻它；
  // 且这一支**不退官种**（源读不到对每个官种都一样，退了也白退，反而说不出「你那一节」）
  const deadSources = path.join(TMP, "sources-dead.json");
  fs.writeFileSync(deadSources, JSON.stringify([
    { file: path.join(TMP, "no-such-clauses.md"), selector: "all-top-level", role_scheme: "dispatch-sections" },
  ]), "utf8");
  const c = fire("mousse-implementer", { index: deadSources });
  check("语料源读不到 → 渲染端拒绝渲染，本 hook 降级为指针而不是缺斤少两的正文",
    c.code === 0 && c.ctx.startsWith(SIG) && /dao-officer-clauses\.md/.test(c.ctx),
    JSON.stringify(c.ctx.slice(0, 240)));
  check("语料源读不到 → 注入里点名「读不到」这个成因（成因可指认才修得动）",
    /读不到/.test(c.ctx), JSON.stringify(c.ctx.slice(0, 300)));
  check("读不到 ①：官种不退（对每个官种都一样，退了就再也说不出「你那一节」是哪一节）",
    /官种=implementer/.test(c.ctx) && !/官种=general/.test(c.ctx), JSON.stringify(c.ctx.split("\n")[0]));
  check("读不到 ②：指针把两节都点名（协议是「通用节 + 你那一节」，只给文件名指不动人）",
    /通用节/.test(c.ctx) && /官种那一节/.test(c.ctx) && /Read/.test(c.ctx), JSON.stringify(c.ctx.slice(-420)));
  check("读不到 ③：渲染端末行原样带进注入（事后 Grep 得出断供次数）",
    /CLAUSE_RENDER_SUMMARY/.test(c.ctx), JSON.stringify(c.ctx.slice(-420)));
  check("读不到 ④：修法提示来自渲染端报文原话，本文件里不另存一份字面量（双写必漂移）",
    /clause-sources\.mjs|sources-json/.test(c.ctx), JSON.stringify(c.ctx.slice(-300)));
  check("读不到 ⑤：仍然说清没渲染出正文（别让读者以为条款已全给）",
    /没有渲染出/.test(c.ctx), JSON.stringify(c.ctx.slice(-420)));
  {
    // 心跳这一格：断供要在 fired.log 里数得出来（mode=source-dead-pointer）
    const firedLog = path.join(REPO, "_tmp", "subagent-clauses", "fired.log");
    const recs = fs.readFileSync(firedLog, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const last = recs[recs.length - 1];
    check("读不到 ⑥：心跳记 mode=source-dead-pointer（断供数得出来，不再是 0 与没样本同形）",
      last && last.mode === "source-dead-pointer", JSON.stringify(last));
  }

  // 正控复核：正常语料下 implementer 节渲得出
  check("正控复核：正常语料下官种节渲得出（这条一红，后面用例的语料有问题，别只修它自己）",
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
  // ⚠ **2026-08-07（issue #174）：这个前提翻面了，而下面那条断言的期望值没变** —— 照直写。
  //   本仓从此**有**项目侧档（补的脚手架缺件），但它是**指针档**（头部自带 dao-clause-pointer
  //   标记、不含条款正文）⇒ hook 把正文源退回官侧档。所以下面仍该期望官侧档，**但理由换了**：
  //   从「探不到项目侧档」变成「探到了、它自己声明是指针」。**两种理由在断言上长得一模一样**，
  //   故把新前提本身钉成两条断言 —— 标记哪天被删，是这里先红，不是下面那条莫名其妙地红。
  const PROJECT_SIDE_CANDIDATES = ["docs/rules/dispatch-clauses.md", ".claude/rules/dispatch-clauses.md"];
  const presentSide = PROJECT_SIDE_CANDIDATES.filter((rel) => fs.existsSync(path.join(REPO, rel)));
  check("前提：本仓项目侧档在盘上（2026-08-07 补的脚手架缺件，此前它确实不存在）",
    presentSide.length > 0, JSON.stringify(PROJECT_SIDE_CANDIDATES));
  // **标记用本文件自己写的字面量查，不去 require hook 的判断**（守卫铁律：自检那一半不许复用
  // 被守对象的解析 —— 复用了就是两边一起错、差恒为 0，自检退化成一句废话）。
  const POINTER_MARK_LITERAL = /^<!--\s*dao-clause-pointer\b/m;
  const PROBE_WINDOW = 4096; // 与 hook 的默认窗口同值，但**是独立写的一份**，不从它那里读
  check("前提：项目侧档头部（有界窗口内）带指针标记 ⇒ 下面仍期望官侧档，理由是「它是指针档」",
    presentSide.length > 0 && presentSide.every((rel) =>
      POINTER_MARK_LITERAL.test(fs.readFileSync(path.join(REPO, rel), "utf8").slice(0, PROBE_WINDOW))),
    JSON.stringify(presentSide));

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

console.log("\n──── ④′ 指针档自声明：正文源退官侧档 + 附项目侧那一行（issue #174 用户拍板）────");
{
  // 判据是「作者自己声明」而不是「机器猜这份文件里有没有正文」——后者是近似、两向都有反例。
  // 所以这一节验的是**标记在不在改变了什么**，两态都要看到：
  //   态一 标记在 ⇒ 正文源退官侧档 + 末尾附「项目侧（指针档）」那一行；
  //   态二 标记不在 ⇒ 旧行为一个字不变（别的项目那份装的就是条款正文，零影响）。
  // **合成样本一律自己造，绝不去改盘上那份真档** —— 改真档等于把被测对象与夹具混成一个，
  // 且改坏了会污染同时在跑的别人（本窗有并行官）。
  const MARK_LINE = "<!-- dao-clause-pointer: 合成样本，非真档 -->";
  function makeProj(name, content) {
    const dir = path.join(TMP, name, "docs", "rules");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "dispatch-clauses.md"), content, "utf8");
    return path.join(TMP, name);
  }
  const slash = (s) => String(s).replace(/\\/g, "/");

  // ── 态一：标记在（用盘上那份真档 —— 「真档带标记」正是 ④ 刚钉住的前提）────────────
  const real = fire("general-purpose", { cwd: REPO });
  check("态一：真档带标记 ⇒ 条款正文源退回官侧档（不再把官指向一份没有条款正文的文件）",
    /dao-officer-clauses\.md/.test(real.ctx) && /指针档/.test(real.ctx),
    JSON.stringify(real.ctx.slice(-420)));
  check("态一：末尾附「项目侧（指针档）：<路径>」那一行（协议是两份都读，少这行官不知道有第二份）",
    /项目侧（指针档）：[^\n]*docs\/rules\/dispatch-clauses\.md/.test(slash(real.ctx)),
    JSON.stringify(real.ctx.slice(-420)));

  // ── 态二：标记不在（合成样本）⇒ 旧行为。**这一态是本次改动对别的项目的零影响证明** ──
  const plainProj = makeProj("plain-project",
    "# 合成·真·项目侧条款库（无标记）\n\n## 通用节\n\n- 合成判据一句。 [n=1 @08-07 触发:无]\n");
  const plain = fire("general-purpose", { cwd: plainProj });
  check("态二：没标记 ⇒ 指针仍指项目侧那份，且不附指针行（别的项目行为一个字不变）",
    /plain-project\/docs\/rules\/dispatch-clauses\.md/.test(slash(plain.ctx)) &&
      !/项目侧（指针档）/.test(plain.ctx) && !/dao-officer-clauses\.md/.test(plain.ctx),
    JSON.stringify(plain.ctx.slice(-300)));

  // ── 边界一：标记必须落在**有界窗口内**。这一条同时是「有界读真的有界」的证据 ──────
  //   少了它，把 headOf 改成读全文也不会有任何断言变红，而那正是本判据刻意写窄的那一半。
  const farProj = makeProj("far-mark-project",
    "# 标记埋在头部窗口之外\n\n" + "x".repeat(9000) + "\n" + MARK_LINE + "\n");
  const far = fire("general-purpose", { cwd: farProj });
  check("边界一：标记在有界窗口之外 ⇒ 判为非指针档（证明它只读头部，没把整份文件读进来）",
    !/项目侧（指针档）/.test(far.ctx) &&
      /far-mark-project\/docs\/rules\/dispatch-clauses\.md/.test(slash(far.ctx)),
    JSON.stringify(far.ctx.slice(-300)));

  // ── 边界二：**「提到这个词」与「声明是它」必须分得开** ────────────────────────────
  //   判据要求行首是 `<!--`。少了这条负控，把正则放宽成 /dao-clause-pointer/ 也照样全绿，
  //   而那一版会把任何**讲解这个约定**的项目文档误判成指针档（正是本仓那份自己在讲解它）。
  const proseProj = makeProj("prose-mention-project",
    "# 只是提到这个约定，不是声明\n\n## 通用节\n\n- 本仓约定：指针档要在头部写 `" +
      "<!-- dao-clause-pointer" + "` 标记。 [n=1 @08-07 触发:无]\n");
  const prose = fire("general-purpose", { cwd: proseProj });
  check("边界二：正文里提到这个词但不在行首 ⇒ 不算声明（判据是结构，不是「出现过这个词」）",
    !/项目侧（指针档）/.test(prose.ctx) &&
      /prose-mention-project\/docs\/rules\/dispatch-clauses\.md/.test(slash(prose.ctx)),
    JSON.stringify(prose.ctx.slice(-300)));

  // ── 边界三：env 逃生口刻意不走这道判断（射程边界）──────────────────────────────
  // 🔴 **这一格 2026-08-07 被对抗验证官判为假锚并重做，成因照直写**：首版的样本是
  //   `/tmp/somewhere/clauses.md` —— **那个文件不存在**，而 `resolveClauseFile` 的 env 分支
  //   在任何存在性检查之前就返回了 ⇒ 这一格实际**零样本**：把 env 逃生口改成走指针推断，
  //   一个不存在的文件 `headOf` 恒返回 null、判非指针，输出**逐字节不变**，本条照绿。
  //   而它旁边的注释当时写着「改窄改宽都该有东西红」—— **那是一句假宣称**，
  //   正撞上本批入库的 `[#官抗-负控独立归因]` 第②款（宣称「挡在门 X」必须实测）。
  //   ⇒ 换成**真实存在、且带标记**的合成样本：只有这样，「env 走不走推断」这个差别才有
  //   可观测后果（走推断 ⇒ 退官侧档 + 附指针行；不走 ⇒ 原样指它）。
  //   **实测（在真实 hook 上先破再验，非变异体副本）**：把 env 分支改成走 `isPointerDoc`
  //   ⇒ 全套 exit=1、**仅本条红**（PASS=113 FAIL=1）；复原 ⇒ exit=0 PASS=114 FAIL=0。
  const envMarked = path.join(TMP, "env-escape-hatch-marked.md");
  fs.writeFileSync(envMarked, MARK_LINE + "\n\n# 合成样本：带标记，但由 env 显式指定\n", "utf8");
  check("前提：边界三的样本真实存在（首版那个不存在的路径让这一格零样本、恒绿）",
    fs.existsSync(envMarked), envMarked);
  const envHit = fire("claude", { clauseFile: envMarked });
  check("边界三：DAO_CLAUSE_FILE 显式指定时不做指针档推断（逃生口就该是「指了什么就是什么」）",
    slash(envHit.ctx).includes(slash(envMarked)) && !/项目侧（指针档）/.test(envHit.ctx) &&
      !/dao-officer-clauses\.md/.test(envHit.ctx),
    JSON.stringify(envHit.ctx.slice(-300)));
}

console.log("\n──── ⑤ 注入上限：宁可截断也不越 10,000，且截断这件事必须写在文里 ────");
{
  const r = fire("mousse-implementer", { max: 600 });
  check("超限时硬截断在上限以内", r.ctx.length <= 600, `实际 ${r.ctx.length}`);
  check("超限时签名仍在首行（截断从尾部切，审计锚不丢）", r.ctx.startsWith(SIG));
  check("超限时明说被截断了（静默截断＝无从核验型误裁）", /截断|未列进本次注入/.test(r.ctx), JSON.stringify(r.ctx.slice(-160)));

  // ── 前置探针：真仓默认语料渲得出吗 ─────────────────────────────────────────
  // 下面两条用真仓默认语料（index:null ⇒ 不传 DAO_CLAUSE_SOURCES）。渲染端现算化后
  // 「索引过期」不复存在，但「真仓某份源读不到」仍可能（文件被挪/被删）——那会让渲染端
  // fail-closed、本 hook 退成纯指针，下面两条连带红。探针只在出事时出声。
  {
    const probe = spawnSync(process.execPath, [RENDERER, "--list-roles"], { encoding: "utf8", cwd: REPO });
    const out = String(probe.stdout || "");
    if (probe.status !== 0 || !/CLAUSE_RENDER_SUMMARY exit=0/.test(out)) {
      console.log("  ⚠ 前置：真仓默认语料渲不出（exit=" + probe.status + "）——下面两条若红，多半是连带：源读不到 → 渲染端 fail-closed → 注入退成纯指针。");
      console.log("     先跑 node ccswitch/scripts/render-clauses.mjs --list-roles 看它报哪份源读不到。");
    }
  }

  const big = fire("mousse-implementer", { index: null }); // 真仓默认语料：通用节 90+ 条，正文上万字
  check("真仓语料下默认注入不超过 9000（宿主超 10,000 会改成落文件+预览）",
    big.ctx.length <= 9000, `实际 ${big.ctx.length}`);
  check("真仓语料下退成判据句形态并说明理由（不是悄悄少给）",
    /判据句/.test(big.ctx) || /## 通用节/.test(big.ctx),
    JSON.stringify(big.ctx.slice(0, 300)) + "  ← 若上面打了「渲不出」，这条是连带红，先核语料");
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
  const probe = spawnSync(process.execPath, [RENDERER, "--list-roles", "--sources-json", IDX_ROLES], { encoding: "utf8" });
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
  // ── dao-scout 的「只读红线」在机器上的那一半：**一格一样本一谓词**（issue #177）──────
  // 原先是**一条**断言「tools 里没有 Edit/Write/Bash」，而 `tools:` 解析不到时得**空串**，
  // 空串里当然没有那三个词 ⇒ **把整行 `tools:` 删掉照样全绿**。可 Claude Code 里
  // **没有 `tools:` 这一行 ＝ 继承全部工具** —— 最危险的那种改法恰好落在零样本那一格
  // （PR #175 对抗官三轮同族扫描扫出；`[#官抗-负控独立归因]` ②款的形态）。
  // 故拆两条，各自独立归因：①这一行在不在 ②它的内容干不干净。
  //
  // **2026-08-09 追加范围（issue #172 笔 A，用户拍板选项①）**：上面这段历史是「零写入」
  // 曾经结构性覆盖 `Bash` 的由来；现在 `Bash` 已合法加回 scout 的工具表（详见
  // `ccswitch/agents/dao-scout.md` 正文），「只读」这半从结构性保证退回纪律约束
  // （scout 的 `Bash` 只准跑只读命令，写命令违例，判据不在机器面）。本节因此变成三条断言：
  // ①这一行在不在且认得出 ②**真正的写入工具**（Edit 家族 + Write）仍不在表里 ③`Bash`
  // 现在**必须在**表里——判据见下。
  //
  // 判据在这里**独立写死**，不 require 被守对象那侧（hook / 渲染器）的任何解析器 ——
  // 与被守物共用一个解析器，会让「找违例」和「确认我真看到了样本」一起瞎掉（`[#守-自检独立]`）。
  // **2026-08-09 对抗返修追加（PR #234 评论 5230906744 F2）：这个解析器改名复用，不再叫
  // `scoutToolsOf`**——它的逻辑本来就与 scout 无关（纯粹解析 frontmatter 的 `tools:` 行），
  // 之前只服务 scout 一个 profile 是「调用点覆盖率 N=4/M=1=25%」的病灶本身：`dao-implementer`
  // / `dao-adversary` / `dao-dogfood` 三个官种型 profile 此前 0 覆盖，改坏它们的 `tools:`（删行 /
  // 塞脏值）不会有任何断言变红。改名为 `toolsLineOf` 后下面复用于全部四个 profile。
  const toolsLineOf = (text) => {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text));
    if (!fm) return { ok: false, value: null, why: "没解析出 frontmatter" };
    const m = /^tools:[ \t]*(\S[^\r\n]*?)[ \t]*$/m.exec(fm[1]);
    // 值为空的 `tools:` 按「没有这一行」判：YAML 里它是 null，宿主同样退回继承全部工具，
    // 而两者在这条红线上的后果一模一样 —— 判宽了就等于给最危险的形态开一个后门。
    if (!m) return { ok: false, value: null, why: "frontmatter 里没有非空的 tools: 行" };
    // **认不出的形态一律 fail-closed**（PR #178 对抗官 🟡，与上面「空值按没这行判」同理）：
    // 值必须是一张**逐项认得出**的工具表（工具名 / `mcp__服务__工具` 长名）。像 `tools: *`
    // 这种通配写法 —— **宿主认不认它本批未证**，所以这里不是按「它是后门」判的，
    // 是按「**认不出的形态不许判绿**」判的：判绿要有依据，而这一格没有。
    const items = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    const bad = items.filter((s) => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(s));
    if (!items.length || bad.length) {
      return { ok: false, value: m[1], why: `tools: 的值里有认不出的条目 ${JSON.stringify(bad)}（认不出即 fail-closed）` };
    }
    return { ok: true, value: m[1], why: "" };
  };
  // **`NotebookEdit` 必须单列**（PR #178 对抗官实测）：`\bEdit\b` 匹配**不到** `NotebookEdit` ——
  // `Edit` 前面那个 `k` 是词字符，两个词字符之间没有词边界，于是 `tools: Read, NotebookEdit`
  // 曾经两条全绿。而 NotebookEdit 是宿主真实存在的**写入**工具（会改 notebook 单元格），
  // 侦察官的红线是**全程零写入**，它当然在表里。长的排前面，匹配次序不留给引擎去猜。
  // **2026-08-09 摘掉 `Bash`（issue #172 笔 A，用户拍板选项①）**：侦察官条款自身要求收工写
  // 「本轮零写入（`git status` 空）」——没有 `Bash` 跑不出 `git status`，`Explore` 载体也一直
  // 有 `Bash`，同官种两个载体能力不该不一致。摘掉之后这条 regex 只再守**结构性写入工具**
  // （Edit 家族 + Write）；`Bash` 合法与否改由下面的独立断言判（判据从「不许出现」变成
  // 「必须出现」，两件事不能用同一条 regex 答，故分开）。
  const WRITE_TOOL_RE = /\b(NotebookEdit|MultiEdit|Edit|Write)\b/;

  // ── 最低限度覆盖：另外三个此前 0 覆盖的官种型 profile（2026-08-09，PR #234 评论 5230906744 F2）──
  // 不做语义判断（implementer/adversary 是「全权限官」，没有 scout 那种只读/写入的取舍要判），
  // 只钉「这一行在、且认得出」——这正是 F2 指出的最便宜也最要紧的那一格：`tools:` 整行被删掉
  // 时 Claude Code 会**继承全部工具**，这三个 profile 此前改坏了这一行不会有任何断言变红。
  for (const stem of ["dao-implementer", "dao-adversary", "dao-dogfood"]) {
    const p = path.join(AGENTS_DIR, stem + ".md");
    const v = fs.existsSync(p)
      ? toolsLineOf(fs.readFileSync(p, "utf8"))
      : { ok: false, value: null, why: `${stem}.md 不在盘上` };
    check(`${stem}：tools: 这一行在，且值是一张逐项认得出的工具表（**没有这一行 = 继承全部工具**；认不出的形态一律 fail-closed）`,
      v.ok, v.why);
  }

  {
    const SCOUT = path.join(AGENTS_DIR, "dao-scout.md");
    // existsSync 兜一道：直接 readFileSync 会在 profile 被删时**抛异常整份测试当场终止**，
    // 于是它后面的 ⑧⑨ 两节一条都跑不到 —— 红是红了，却红得没有归因、还顺手灭掉六十多条。
    const v = fs.existsSync(SCOUT)
      ? toolsLineOf(fs.readFileSync(SCOUT, "utf8"))
      : { ok: false, value: null, why: "dao-scout.md 不在盘上" };
    check("dao-scout：tools: 这一行在，且值是一张逐项认得出的工具表（**没有这一行 = 继承全部工具**；认不出的形态一律 fail-closed）",
      v.ok, v.why);
    // 本条**刻意不带 `v.ok &&`**：带上就与上一条同生同死 —— 两次破坏红出同一个集合，
    // 红的时候归因不出到底是哪一格坏了（`[#官抗-负控独立归因]` ①款）。
    // **代价照直写**：上一条已判红的那些形态（无行 / 空值 / 认不出）本条零样本、恒绿；
    // ~~那一格由上一条独占~~，且是实测的（issue #177 / PR #178 交付：四发破坏**各只红一条**，
    // 分落两个互不相交的归因面 —— 删行 / `tools: *` ⇒ ~~只红上一条~~；塞 NotebookEdit ⇒ 只红本条。
    // **塞 Bash 当时（PR #178 时点）也只红本条，但 2026-08-09 起 Bash 已合法化**——这句历史
    // 归因只作既往实证保留，今天再复现同一发破坏不会得到同样的红集，别拿它当现状核对。
    // **2026-08-09 对抗验证官订正（PR #234 评论 5230906744 F3）：上面画掉的两处已为假**——
    // 本 PR 新增③条（`Bash` 必须在表）之后，实测**删整行 `tools:` 与 `tools: * `通配这两发
    // 各红 2 条**（①与③同时红）：③用 `(v.value || "")` 兜底，`tools:` 缺失或认不出时得到的
    // 值里天然没有 `Bash`，`includes("Bash")` 自然为 false，于是①②③里的①③一起亮。「塞 Write /
    // 塞 NotebookEdit ⇒ 只红本条（②）」这半仍然成立，没被这次订正牵动。行为本身没错（没有
    // 工具表时说「Bash 不在表里」是对的），错的只是这段归因文字没跟着新断言重算一遍
    // （`[#官抗-断言名实核对]`：跑完一批变体后要核对谁本该红、谁的自陈已过期）。
    // **别把这句读成「四个红集两两互不相交」**：A 与 E 红的是同一条、B 与 D 红的是同一条，
    // 那是**设计如此**（同一格的两种形态，指的是①②两条规模下的旧四发实验），互不相交的
    // 是**两个面**——那段历史记录本身没错，错的只是上面单独摘出来复述的那一句没跟着更新。
    check("dao-scout：tools: 的内容里没有 NotebookEdit/MultiEdit/Edit/Write（结构性写入红线；Bash 见下一条，判据方向相反）",
      !WRITE_TOOL_RE.test(v.value || ""), JSON.stringify(v.value));
    // **新增（2026-08-09，issue #172 笔 A 落地，用户拍板选项①）**：`Bash` 现在是**必须在**的
    // 一格，不是必须不在——用户拍板「给 scout 加 Bash」，日后若有人手滑删掉，这条要能抓住。
    // 判据是逐项精确匹配 `Bash`（按 `,` 切分后逐项 trim），不是子串匹配，避免误判
    // `mcp__xxx-bash-runner` 这类形似长名（当前工具表里还没有这种名字，但判据先按误伤面写）。
    const scoutItems = (v.value || "").split(",").map((s) => s.trim());
    check("dao-scout：tools: 里含 Bash（2026-08-09 拍板：能力齐，只读改由正文用途限定 + 收工自陈兜底）",
      scoutItems.includes("Bash"), JSON.stringify(v.value));

    // ── 负控：形似长名不该被判成命中（issue #245 N1，PR #234 二核遗留）─────────────────
    // 上面这条判据是 `scoutItems.includes("Bash")`（split+trim 后的数组精确匹配），但全套
    // 现有语料里没有一份工具表同时含「形似长名」（`BashOutput` 之于 `Bash`）而不含精确名——
    // 若悄悄放宽成子串匹配（`(v.value||"").includes(tool)`），153 条断言零红：**先破再验**，
    // 本条加入前已实测——临时把这条与下面 dogfood 那条判据都改成子串匹配、用真实
    // `dao-scout.md`/`dao-dogfood.md` 语料重跑，PASS=153 FAIL=0 逐字不变（复原后同为
    // PASS=153 FAIL=0），证实了这个缺口确实存在、且真实语料测不出它。这里补一条合成负控
    // 样本，直接钉住「精确匹配 ≠ 子串匹配」这件事本身。
    const scoutDecoy = toolsLineOf("---\nname: x\ntools: Read, Grep, BashOutput\n---\n正文");
    const scoutDecoyItems = (scoutDecoy.value || "").split(",").map((s) => s.trim());
    check("负控：tools 表含 BashOutput（不含 Bash 本身）⇒ 逐项精确匹配判「不含 Bash」（子串匹配会误判成含）",
      scoutDecoyItems.includes("Bash") === false, JSON.stringify(scoutDecoy.value));
    check("负控：同一样本的原始串确实含子串 \"Bash\"（佐证上一条测的是精确匹配，不是巧合过关）",
      (scoutDecoy.value || "").includes("Bash") === true, JSON.stringify(scoutDecoy.value));
  }
  {
    // 合成语料：上面两条的判别力**不靠「真档此刻恰好长得对」兜着**。真档哪天被改成哪种形态，
    // 这几格都还在原地钉着，且期望值是逐条手写的 —— 判据自己瞎掉时它们会红，而不是跟着一起哑。
    // 样本自造、只在内存里，**不碰盘上任何真档**。
    const SAMPLES = [
      ["有 tools: 且干净", "---\nname: x\ntools: Read, Grep, Glob\n---\n正文", true, false],
      ["tools: 整行删掉（本 issue 的病灶）", "---\nname: x\ndescription: y\n---\n正文", false, false],
      // **2026-08-09 起 Bash 不再算「脏」（issue #172 笔 A 用户拍板）**：wantDirty 从 true
      // 改 false——WRITE_TOOL_RE 现在只守结构性写入工具，Bash 合法与否由另一条独立断言判
      // （方向相反：必须出现，不是必须不出现），这张合成样本只测 WRITE_TOOL_RE 这一侧。
      ["tools: 里塞了 Bash（2026-08-09 起对 WRITE_TOOL_RE 而言不算脏）",
        "---\nname: x\ntools: Read, Grep, Bash\n---\n正文", true, false],
      ["tools: 里塞了 NotebookEdit（\\bEdit\\b 匹配不到它：前面那个 k 挡掉了词边界）",
        "---\nname: x\ntools: Read, NotebookEdit\n---\n正文", true, true],
      ["tools: * 通配（宿主认不认未证 ⇒ 认不出即 fail-closed，不判绿）",
        "---\nname: x\ntools: *\n---\n正文", false, false],
      ["tools: 有行但值为空（YAML null，宿主同样继承全部工具）", "---\nname: x\ntools:\n---\n正文", false, false],
      ["压根没有 frontmatter", "tools: Read, Grep\n正文", false, false],
      // **误伤反例**（`[#官实-误伤反例]`：每补一类命中形态就配一条「形似但不该拦」）：
      // fail-closed 那一格收紧了判据，得证明合法的 MCP 长名（带 `__` 与连字符）不被它误判。
      ["误伤反例：合法 MCP 长名不该被 fail-closed 拦下",
        "---\nname: x\ntools: Read, mcp__chrome-devtools__take_screenshot\n---\n正文", true, false],
      ["CRLF 行尾也认得（本仓 core.autocrlf=true，工作树里就是 CRLF）",
        "---\r\nname: x\r\ntools: Read, Write\r\n---\r\n正文", true, true],
    ];
    for (const [tag, sample, wantOk, wantDirty] of SAMPLES) {
      const g = toolsLineOf(sample);
      check(`合成样本「${tag}」：这张表认不认得出，判得出 ${wantOk}`,
        g.ok === wantOk, `实得 ok=${g.ok} value=${JSON.stringify(g.value)} why=${g.why}`);
      check(`合成样本「${tag}」：内容含写入工具判得出 ${wantDirty}`,
        WRITE_TOOL_RE.test(g.value || "") === wantDirty, `实得 ${WRITE_TOOL_RE.test(g.value || "")}`);
    }
  }

  // ── dao-dogfood 的截图/导航工具在机器面也有断言了（issue #172 笔 B + F4 返修，2026-08-09，
  //    PR #234 评论 5230906744 F2/F4）：照笔 A 的断言形态写——对抗验证官实测 M8（把两个截图
  //    工具删回原状）与 M9（把整行 `tools:` 删掉）都是 PASS=134 FAIL=0，零回归网。本节补对等
  //    覆盖，且同批把 F4 新加的四个 chrome-devtools 工具与一个 playwright 导航工具也一并钉住——
  //    它们与截图工具同一次拍板落地的完整性（能截图但到不了目标页等于没加），不该比截图工具
  //    本身覆盖得更松。 ────────────────────────────────────────────────────────────────
  {
    const DOGFOOD = path.join(AGENTS_DIR, "dao-dogfood.md");
    const REQUIRED_DOGFOOD_TOOLS = [
      "mcp__chrome-devtools__list_pages",
      "mcp__chrome-devtools__select_page",
      "mcp__chrome-devtools__navigate_page",
      "mcp__chrome-devtools__take_snapshot",
      "mcp__chrome-devtools__take_screenshot",
      "mcp__playwright__browser_navigate",
      "mcp__playwright__browser_take_screenshot",
    ];
    const dv = fs.existsSync(DOGFOOD)
      ? toolsLineOf(fs.readFileSync(DOGFOOD, "utf8"))
      : { ok: false, value: null, why: "dao-dogfood.md 不在盘上" };
    // **2026-08-09 去重（issue #245 N2）**：本条此前与 OFFICER_STEMS 循环里 `dao-dogfood`
    // 那一条断言名逐字相同，是刻意留的"紧邻逐项断言、红时不用跳几十行"的便利重复——但
    // 它让红集读数虚高 1（同一件事被计成两条 PASS）。去重后若这一行真的没了，OFFICER_STEMS
    // 循环那条（约 100 行前）会先红，`dv.ok` 为 false 时下面 `dv.why` 已经带得出原因，
    // 归因并不会因为去掉这条本地副本而变差。
    const dogfoodItems = (dv.value || "").split(",").map((s) => s.trim());
    for (const tool of REQUIRED_DOGFOOD_TOOLS) {
      check(`dao-dogfood：tools: 里含 ${tool}（逐项精确匹配，不是子串匹配，防手滑删掉其中一个）`,
        dogfoodItems.includes(tool), JSON.stringify(dv.value));
    }

    // ── 负控：形似长名不该被判成命中（issue #245 N1，同上，dogfood 侧）─────────────────
    const dogfoodDecoy = toolsLineOf(
      "---\nname: x\ntools: Read, Grep, mcp__chrome-devtools__take_screenshot_v2\n---\n正文");
    const dogfoodDecoyItems = (dogfoodDecoy.value || "").split(",").map((s) => s.trim());
    check("负控：tools 表含 …take_screenshot_v2（不含精确名）⇒ 逐项精确匹配判「不含」（子串匹配会误判成含）",
      dogfoodDecoyItems.includes("mcp__chrome-devtools__take_screenshot") === false,
      JSON.stringify(dogfoodDecoy.value));
    check("负控：同一样本的原始串确实含子串（佐证上一条测的是精确匹配，不是巧合过关）",
      (dogfoodDecoy.value || "").includes("mcp__chrome-devtools__take_screenshot") === true,
      JSON.stringify(dogfoodDecoy.value));
  }
  {
    // 合成语料：证明上面的逐项断言判别力不靠「真档此刻恰好长得对」兜着——真档哪天被改成
    // 哪种形态，这几格都还在原地钉着。样本自造、只在内存里，不碰盘上任何真档。
    const REQUIRED_DOGFOOD_TOOLS = [
      "mcp__chrome-devtools__list_pages",
      "mcp__chrome-devtools__select_page",
      "mcp__chrome-devtools__navigate_page",
      "mcp__chrome-devtools__take_snapshot",
      "mcp__chrome-devtools__take_screenshot",
      "mcp__playwright__browser_navigate",
      "mcp__playwright__browser_take_screenshot",
    ];
    const DOGFOOD_SAMPLES = [
      ["有 tools: 且含全部 7 个截图/导航工具",
        `---\nname: x\ntools: Read, Grep, Glob, Bash, Write, ${REQUIRED_DOGFOOD_TOOLS.join(", ")}\n---\n正文`,
        true, REQUIRED_DOGFOOD_TOOLS],
      ["tools: 整行删掉（对抗 M9 实测过零红的那个形态）",
        "---\nname: x\ndescription: y\n---\n正文", false, []],
      ["7 个截图/导航工具全删回原状、其余保留（对抗 M8 实测过零红的那个形态）",
        "---\nname: x\ntools: Read, Grep, Glob, Bash, Write\n---\n正文", true, []],
      ["只留 playwright 支两个工具，chrome-devtools 支四个全删（F4 返修前的原状）",
        "---\nname: x\ntools: Read, Grep, Glob, Bash, Write, mcp__playwright__browser_navigate, mcp__playwright__browser_take_screenshot\n---\n正文",
        true, ["mcp__playwright__browser_navigate", "mcp__playwright__browser_take_screenshot"]],
    ];
    for (const [tag, sample, wantOk, wantTools] of DOGFOOD_SAMPLES) {
      const g = toolsLineOf(sample);
      check(`dogfood 合成样本「${tag}」：tools: 行认不认得出，判得出 ${wantOk}`,
        g.ok === wantOk, `实得 ok=${g.ok} value=${JSON.stringify(g.value)} why=${g.why}`);
      const gotItems = (g.value || "").split(",").map((s) => s.trim());
      const hasAllWant = wantTools.every((t) => gotItems.includes(t));
      const hasNoExtra = REQUIRED_DOGFOOD_TOOLS.filter((t) => !wantTools.includes(t)).every((t) => !gotItems.includes(t));
      check(`dogfood 合成样本「${tag}」：含且仅含预期的截图/导航工具子集`,
        hasAllWant && hasNoExtra, `实得 items=${JSON.stringify(gotItems)} 预期=${JSON.stringify(wantTools)}`);
    }
  }

  // ── 其余 8 份 profile 的存在性 + tools 行断言（issue #245 N4，PR #234 二核遗留）─────────
  // PR #234 只覆盖了官种型 profile（dao-implementer/adversary/dogfood/scout，4/12=33%）。
  // 「删 tools: 行 = 继承全部工具」是宿主性质，对**任何** profile 都成立，不分官种型/能力型
  // ——本节把剩下 8 份逐一点名补上「行在 + 认得出」这一格（机械活，照上面 OFFICER_STEMS
  // 循环的形态原样套）。三份**结构性只读**（dao-reviewer / dao-reviewer-critical /
  // dao-brainstormer，实测 tools: 均只有 `Read, Grep, Glob`）额外钉「无写入工具」——
  // 与 dao-scout 的只读红线同一判据：这三份若被误删 tools: 行，会从「只读」静默裸奔成
  // 「继承全部工具」，与当年 scout 那个病逐字同型。其余 5 份（debugger/plan-writer/
  // spec-writer/strategist/worker-batch）设计上本就带写入工具，不适用这条负控。
  const REMAINING_PROFILES = [
    ["dao-brainstormer", true],
    ["dao-debugger", false],
    ["dao-plan-writer", false],
    ["dao-reviewer-critical", true],
    ["dao-reviewer", true],
    ["dao-spec-writer", false],
    ["dao-strategist", false],
    ["dao-worker-batch", false],
  ];
  for (const [stem, readOnly] of REMAINING_PROFILES) {
    const p = path.join(AGENTS_DIR, stem + ".md");
    const exists = fs.existsSync(p);
    check(`${stem}.md 在盘上（没有 profile 就没有 agent type 可选）`, exists, p);
    if (!exists) continue;
    const rv = toolsLineOf(fs.readFileSync(p, "utf8"));
    check(`${stem}：tools: 这一行在，且值是一张逐项认得出的工具表（**没有这一行 = 继承全部工具**；认不出的形态一律 fail-closed）`,
      rv.ok, rv.why);
    if (readOnly) {
      check(`${stem}：tools: 的内容里没有 NotebookEdit/MultiEdit/Edit/Write（结构性只读官种，删 tools: 行 = 裸奔继承全部工具，同 dao-scout 的只读红线）`,
        !WRITE_TOOL_RE.test(rv.value || ""), JSON.stringify(rv.value));
    }
  }
}

console.log("\n──── ⑧ --selfcheck：自洽 + 逐面报 + 给得出修法 ────");
{
  // 不断言本机是绿是红（取决于用户注册没注册），断言的是**自检自身自洽**
  const r = spawnSync(process.execPath, [HOOK, "--selfcheck"], {
    encoding: "utf8",
    env: Object.assign({}, process.env, { DAO_CLAUSE_SOURCES: IDX_ROLES }),
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

  // ── M3 · 「语料源读不到 ⇒ 指针且不退官种」那一支的三形态 + 反向 ──────────
  // 三形态照对抗验证条款「改坏要试不止一种形态」：①移除 ②保留字面但不执行
  // ③保留计算与副作用、只让结果不被消费。**三个红集刻意各不相同**。
  // （本段前身是 stale 支 mutation；现算化后 stale 不复存在，等价的失败形态是「源读不到」。）
  const staleMutFiles = [];
  {
    const deadSources = path.join(TMP, "sources-dead-m3.json");
    fs.writeFileSync(deadSources, JSON.stringify([
      { file: path.join(TMP, "no-such-clauses.md"), selector: "all-top-level", role_scheme: "dispatch-sections" },
    ]), "utf8");
    const dead = { index: deadSources };
    const lastBeat = () => {
      const p = path.join(REPO, "_tmp", "subagent-clauses", "fired.log");
      const recs = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
      return JSON.parse(recs[recs.length - 1]);
    };

    const base = fire("mousse-implementer", dead);
    const baseBeat = lastBeat();
    check("M3 基线：源读不到时保住官种 + 记 source-dead-pointer 心跳（变异体的对照面是活的）",
      /官种=implementer/.test(base.ctx) && baseBeat.mode === "source-dead-pointer",
      JSON.stringify(baseBeat));

    // ①移除：判据整段拿掉 ⇒ 退回旧行为（退官种），且心跳形态灭
    const t3a = `  const sourceDead = !r.ok && /读不到/.test(r.why || "");`;
    check("M3a 靶点唯一", src.split(t3a).length === 2, `出现 ${src.split(t3a).length - 1} 次`);
    const m3a = writeMutant("sourcedead-removed", t3a, `  const sourceDead = false;`);
    staleMutFiles.push(m3a);
    const a3 = fire("mousse-implementer", Object.assign({ script: m3a }, dead));
    const beat3a = lastBeat();
    check("M3a（①移除）：官种掉回 general + 心跳形态灭 ⇒ 「不退官种」与「心跳可数」两格都被测着",
      /官种=general/.test(a3.ctx) && beat3a.mode !== "source-dead-pointer" && a3.code === 0,
      `head=${a3.ctx.split("\n")[0]} beat=${JSON.stringify(beat3a)}`);

    // ②保留字面但使其不执行：`sourceDead` 标识符还在，分支却永不进
    //   ⇒ 文本匹配型检查对这一形态天然失明，只有行为断言抓得到。
    const t3b = `\n  if (sourceDead) {\n    degraded.push(`;
    check("M3b 靶点唯一", src.split(t3b).length === 2, `出现 ${src.split(t3b).length - 1} 次`);
    const m3b = writeMutant("sourcedead-dead-branch", t3b, `\n  if (false && sourceDead) {\n    degraded.push(`);
    staleMutFiles.push(m3b);
    const b3 = fire("mousse-implementer", Object.assign({ script: m3b }, dead));
    check("M3b（②保留字面但不执行）：官种照样掉回 general ⇒ 抓得住「分支还在但没人走」",
      /官种=general/.test(b3.ctx) && b3.code === 0, `head=${b3.ctx.split("\n")[0]}`);

    // ③保留计算与副作用、结果不被消费：判据照算、degraded 照写、官种照保，
    //   只是 buildContext 收不到这个答案 ⇒ 指针走普通分支（没有「修法归帅」句），心跳形态灭。
    //   这一形态最像没事：注入还在、长度正常、官种也对，人眼扫一遍看不出异常。
    const t3c = `    sourceDead,\n    regenHint: r.hint,`;
    check("M3c 靶点唯一", src.split(t3c).length === 2, `出现 ${src.split(t3c).length - 1} 次`);
    const m3c = writeMutant("sourcedead-unconsumed", t3c, `    sourceDead: false,\n    regenHint: r.hint,`);
    staleMutFiles.push(m3c);
    const c3 = fire("mousse-implementer", Object.assign({ script: m3c }, dead));
    const beat3c = lastBeat();
    check("M3c（③结果不被消费）：官种仍对、注入仍在，但「修法归帅」句与心跳形态双双消失 ⇒ 红集与 ①② 不同",
      /官种=implementer/.test(c3.ctx) && !/修法归帅/.test(c3.ctx) && beat3c.mode !== "source-dead-pointer",
      `head=${c3.ctx.split("\n")[0]} beat=${JSON.stringify(beat3c)}`);

    check("M3 语料复核：正常语料下官种节渲得出", fire("mousse-implementer").ctx.includes("## implementer 节"));

    // 反向 mutation：**上面三次全在「让 sourceDead 支失灵」这一侧**，那样「非源死的失败仍要退官种」
    //   那条负控一次都不会红 —— 它可能只是因为 sourceDead 支本来就没被触发才通过的。
    //   故把判据改成恒真：成因一（官种 0 条）会被误当成源读不到 ⇒ 那条负控必须当场红。
    const t4 = `  const sourceDead = !r.ok && /读不到/.test(r.why || "");`;
    const r1 = writeMutant("sourcedead-always-true", t4, `  const sourceDead = !r.ok;`);
    staleMutFiles.push(r1);
    const zeroClauses = { index: IDX_GENERAL_ONLY };
    const beforeR = fire("mousse-implementer", zeroClauses);
    const afterR = fire("mousse-implementer", Object.assign({ script: r1 }, zeroClauses));
    check("R1（反向）：sourceDead 恒真后「官种 0 条 → 退通用节」这条负控真的红了 ⇒ 那条负控有判别力",
      /官种=general/.test(beforeR.ctx) && /官种=implementer/.test(afterR.ctx),
      `before=${beforeR.ctx.split("\n")[0]} after=${afterR.ctx.split("\n")[0]}`);
  }

  // ── M4 · 指针档自声明那条判据（issue #174）：把它改成**恒判非指针**，④′ 两条必须当场红 ──
  // 帅裁定要求「先破再验」：**一条断言若在被测物被故意破坏时不变红，它就不是锚**。
  // 破的是判据本身（`isPointerDoc` 的返回值），不是它的调用点 —— 改调用点验不到「标记认得出来」
  // 这件事，只验得到「有没有人调它」。
  const t5 = `  return head !== null && POINTER_MARK_RE.test(head);`;
  check("M4 靶点唯一", src.split(t5).length === 2, `出现 ${src.split(t5).length - 1} 次`);
  const m4 = writeMutant("pointer-never", t5, `  return false;`);
  const before4 = fire("general-purpose", { cwd: REPO });
  const after4 = fire("general-purpose", { cwd: REPO, script: m4 });
  check("M4：真文件认出指针档（退官侧档 + 附指针行）、恒判非指针后两样同时消失 ⇒ ④′ 两条有判别力",
    /dao-officer-clauses\.md/.test(before4.ctx) && /项目侧（指针档）/.test(before4.ctx) &&
      !/项目侧（指针档）/.test(after4.ctx) && /docs\/rules\/dispatch-clauses\.md/.test(after4.ctx.replace(/\\/g, "/")),
    `beforeHasPtr=${/项目侧（指针档）/.test(before4.ctx)} afterHasPtr=${/项目侧（指针档）/.test(after4.ctx)}`);
  // 环境负控（同 M2 那一条的理由）：变异体得是「跑起来了但判据变了」，不是「根本没跑起来」。
  check("M4：改坏后 exit 仍是 0 且注入非空（变异体真的跑起来了，不是崩在别处）",
    after4.code === 0 && after4.ctx.startsWith(SIG), `exit=${after4.code} stderr=${JSON.stringify(after4.err.slice(0, 160))}`);
  // 复原侧：mutation 结束后真文件必须还认得出指针档（两态都要看到，不能只看到红那一态）
  check("M4：复原后真文件仍认得出指针档（两态都看到了，不是只验了「能红」）",
    /项目侧（指针档）/.test(fire("general-purpose", { cwd: REPO }).ctx));

  cleanupMutants();
  check("变异体已清理（ccswitch/hooks/ 下不留残骸，否则死闸检测会把它报成孤儿）",
    !fs.existsSync(m1) && !fs.existsSync(m2) && !fs.existsSync(m4) && staleMutFiles.every((p) => !fs.existsSync(p)));
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
