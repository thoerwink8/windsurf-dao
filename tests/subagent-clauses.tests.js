// dao-subagent-clauses hook 回归网 — 每个行为分支留正控 + 负控 + mutation 判别力
//
// 跑法：node tests/subagent-clauses.tests.js   （全绿 exit 0，任一红 exit 1）
//
// 夹具语料是**合成**的（形态照 dao-officer-clauses.md），真仓条数随条款库增删而变，不拿来当正控。
// 重设计后渲染端现算、无索引派生物：夹具只需一份 sources-json 指向夹具 md。
// ⚠ 本文件里的「密钥/变异体」都是合成的；变异体必须落在 ccswitch/hooks/ 自己那一层
// （hook 用 __dirname 定位仓根 + require("../lib/…")，写进 _tmp/ 会 MODULE_NOT_FOUND，
// 而「输出为空」恰好是某些断言想看到的现象——环境错误差点被读成 mutation 成功）。

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
  "# 夹具条款库（测试用，非真语料）", "",
  "## 通用节（任意官种派单都应带）", "",
  "- 夹具通用一：随便写一句判据。 [n=1 @07-24 触发:模板首行]",
  "- 夹具通用二：另一句判据。 [n=? @07-24 触发:无] [仅判据·无触发]", "",
  "## 复审官节", "", "- 夹具复审：range 要实算。 [n=2 @07-25 触发:模板首行]", "",
  "## 实现官节", "", "- 夹具实现：进 worktree 先核基点。 [n=2 @07-24 触发:模板首行]", "",
  "## 对抗验证官节", "", "- 夹具对抗：mutation 两态都要看到。 [n=1 @07-24 触发:模板首行]", "",
  "## 侦察官节", "", "- 夹具侦察：论断带出处。 [n=1 @07-25 触发:模板首行]", "",
  "## dogfood 官节", "", "- 夹具 dogfood：起隔离实例走脚本。 [n=1 @07-25 触发:start-isolated-dev]", "",
].join("\n"), "utf8");

function buildSources(outName, roleScheme) {
  const srcJson = path.join(TMP, `sources-${outName}.json`);
  fs.writeFileSync(srcJson, JSON.stringify([
    { file: FIXTURE_MD, selector: "all-top-level", role_scheme: roleScheme },
  ], null, 2), "utf8");
  return srcJson;
}
const IDX_ROLES = buildSources("roles", "dispatch-sections");
const IDX_GENERAL_ONLY = buildSources("general", "general");

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
  // cwd 必须显式给，不许继承调用者的：stdin 解析不出来时 hook 拿不到输入里的 cwd，
  // 退到 process.cwd() 探项目侧条款库——「在哪个目录敲命令」不该改变断言结果。
  const r = spawnSync(process.execPath, [opts.script || HOOK], {
    input: stdin, encoding: "utf8", env, cwd: opts.spawnCwd || REPO,
  });
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch (_) {}
  const hs = out.hookSpecificOutput || {};
  return {
    code: r.status,
    ctx: String(hs.additionalContext || ""),
    sys: String(out.systemMessage || ""),
    raw: String(r.stdout || ""),
  };
}
const SIG = "[dao-subagent-clauses v1]";

console.log("\n──── ① 官种映射正控 ────");
{
  for (const [agentType, role] of [["Explore", "scout"], ["mousse-implementer", "implementer"], ["对抗验证官", "adversary"]]) {
    const r = fire(agentType);
    check(`正控：${agentType} → 官种=${role}，注入含通用节 + ${role} 节`,
      r.code === 0 && new RegExp(`官种=${role}`).test(r.ctx) && /## 通用节/.test(r.ctx) && new RegExp(`## ${role} 节`).test(r.ctx),
      `head=${JSON.stringify(r.ctx.split("\n")[0])}`);
  }
  const one = fire("mousse-implementer");
  check("正控：首行带签名 + 官种是推断的写在注入里（误判时当场可纠）",
    one.ctx.startsWith(SIG) && /按你所属官种那一节读/.test(one.ctx));
}

console.log("\n──── ② 映射不出（主路径）────");
{
  const g = fire("general-purpose");
  check("泛型：agent_type 不含官种 → 通用节 + 官侧档指针 + 写明「映射不出」，不静默空过",
    g.code === 0 && /官种=general/.test(g.ctx) && /## 通用节/.test(g.ctx) &&
    /dao-officer-clauses\.md/.test(g.ctx) && /映射不出/.test(g.ctx) && !/D:\/frank\/mousse-cli/.test(g.ctx),
    JSON.stringify(g.ctx.slice(-300)));
}

console.log("\n──── ③ 渲染端 fail-closed 的降级（三种成因）────");
{
  const a = fire("mousse-implementer", { index: IDX_GENERAL_ONLY });
  check("官种节 0 条 → 退到通用节并写明渲染不出，不给一份看起来正常的空节",
    a.code === 0 && /官种=general/.test(a.ctx) && /渲染不出/.test(a.ctx) && /## 通用节/.test(a.ctx));

  const b = fire("mousse-implementer", { index: path.join(TMP, "no-such-sources.json") });
  check("语料清单读不到 → 仍注入签名 + 指针（永不静默空过）",
    b.code === 0 && b.ctx.startsWith(SIG) && /dao-officer-clauses\.md/.test(b.ctx));

  const deadSources = path.join(TMP, "sources-dead.json");
  fs.writeFileSync(deadSources, JSON.stringify([
    { file: path.join(TMP, "no-such-clauses.md"), selector: "all-top-level", role_scheme: "dispatch-sections" },
  ]), "utf8");
  const c = fire("mousse-implementer", { index: deadSources });
  check("语料源读不到 → 指针 + 点名「读不到」成因 + 渲染端末行原样带进注入",
    c.code === 0 && c.ctx.startsWith(SIG) && /dao-officer-clauses\.md/.test(c.ctx) &&
    /读不到/.test(c.ctx) && /CLAUSE_RENDER_SUMMARY/.test(c.ctx));
  check("语料源读不到 → **不退官种**（对每个官种都一样，退了就再也说不出「你那一节」）",
    /官种=implementer/.test(c.ctx) && !/官种=general/.test(c.ctx));
}

console.log("\n──── ④ fail-open：喂什么都不砖会话 ────");
{
  const bad = fireRaw("这不是 JSON");
  check("stdin 不是 JSON → exit 0 + 签名 + 指针 + systemMessage 留痕",
    bad.code === 0 && bad.ctx.startsWith(SIG) && /dao-officer-clauses\.md/.test(bad.ctx) && /解析 stdin 失败/.test(bad.sys));
  const stray = fireRaw(JSON.stringify({ agent_type: "mousse-implementer" })); // 缺 cwd/agent_id/transcript_path
  check("输入缺字段 → 照常渲染不崩", stray.code === 0 && /官种=implementer/.test(stray.ctx));
  const forced = fire("mousse-implementer", { forceError: "1" });
  check("故障注入 → exit 0 + 指针 + 留痕（绝不砖掉 subagent）",
    forced.code === 0 && forced.ctx.startsWith(SIG) && forced.sys.length > 0);
}

console.log("\n──── ④′ 指针档自声明（两态 + env 逃生口）────");
{
  // 态一：真档带标记 ⇒ 正文源退官侧档 + 末尾附「项目侧（指针档）」行
  const real = fire("general-purpose", { cwd: REPO });
  check("态一：标记在 ⇒ 正文源退官侧档 + 附指针行（协议是两份都读）",
    /dao-officer-clauses\.md/.test(real.ctx) && /指针档/.test(real.ctx) &&
    /项目侧（指针档）：[^\n]*docs\/rules\/dispatch-clauses\.md/.test(real.ctx.replace(/\\/g, "/")));

  // 态二：合成样本无标记 ⇒ 指针仍指项目侧那份，不附指针行（别的项目零影响）
  const plainProj = path.join(TMP, "plain-project", "docs", "rules");
  fs.mkdirSync(plainProj, { recursive: true });
  fs.writeFileSync(path.join(plainProj, "dispatch-clauses.md"),
    "# 合成·真·项目侧条款库（无标记）\n\n## 通用节\n\n- 合成判据一句。 [n=1 @08-07 触发:无]\n", "utf8");
  const plain = fire("general-purpose", { cwd: path.join(TMP, "plain-project") });
  check("态二：没标记 ⇒ 指项目侧那份、不附指针行、不指官侧档",
    /plain-project\/docs\/rules\/dispatch-clauses\.md/.test(plain.ctx.replace(/\\/g, "/")) &&
    !/项目侧（指针档）/.test(plain.ctx) && !/dao-officer-clauses\.md/.test(plain.ctx));

  // 边界二：正文里提到这个词但不在行首 ⇒ 不算声明（判据是结构不是「出现过这个词」）
  const proseProj = path.join(TMP, "prose-project", "docs", "rules");
  fs.mkdirSync(proseProj, { recursive: true });
  fs.writeFileSync(path.join(proseProj, "dispatch-clauses.md"),
    "# 只是提到这个约定，不是声明\n\n## 通用节\n\n- 本仓约定：指针档要在头部写 `<!-- dao-clause-pointer` 标记。 [n=1 @08-07 触发:无]\n", "utf8");
  const prose = fire("general-purpose", { cwd: path.join(TMP, "prose-project") });
  check("边界：正文提到这个词不在行首 ⇒ 不算声明",
    !/项目侧（指针档）/.test(prose.ctx) && /prose-project\/docs\/rules\/dispatch-clauses\.md/.test(prose.ctx.replace(/\\/g, "/")));

  // 边界三：env 逃生口不走指针推断（指了什么就是什么）；样本必须真实存在（不存在=零样本恒绿）
  const envMarked = path.join(TMP, "env-escape-hatch-marked.md");
  fs.writeFileSync(envMarked, "<!-- dao-clause-pointer: 合成样本，非真档 -->\n\n# 带标记但由 env 显式指定\n", "utf8");
  const envHit = fire("claude", { clauseFile: envMarked });
  check("边界：DAO_CLAUSE_FILE 显式指定时不做指针推断（逃生口就指什么是什么）",
    envHit.ctx.replace(/\\/g, "/").includes(envMarked.replace(/\\/g, "/")) && !/项目侧（指针档）/.test(envHit.ctx));
}

console.log("\n──── ⑤ 注入上限 ────");
{
  const r = fire("mousse-implementer", { max: 600 });
  check("超限时硬截断在上限以内 + 签名仍在首行 + 明说被截断（静默截断＝无从核验型误裁）",
    r.ctx.length <= 600 && r.ctx.startsWith(SIG) && /截断|未列进本次注入/.test(r.ctx));
}

console.log("\n──── ⑥ 心跳 ────");
{
  const fired = path.join(REPO, "_tmp", "subagent-clauses", "fired.log");
  check("心跳文件写出 + 带官种/形态/字符数 + 本测试跑出的全部标 synthetic（不许把接线染绿）",
    (() => {
      if (!fs.existsSync(fired)) return false;
      const recs = fs.readFileSync(fired, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      const last = recs[recs.length - 1];
      return last && last.role && last.mode && typeof last.chars === "number" &&
        recs.slice(-20).every((r) => r.synthetic === true);
    })());
}

console.log("\n──── ⑦ 契约 + ⑦′ 接线 ────");
{
  const probe = spawnSync(process.execPath, [RENDERER, "--list-roles", "--sources-json", IDX_ROLES], { encoding: "utf8" });
  const m = String(probe.stdout || "").match(/合法官种：(.+)/);
  const legal = m ? m[1].split("/").map((s) => s.trim()) : [];
  const src = fs.readFileSync(HOOK, "utf8");
  const seg = src.slice(src.indexOf("const AGENT_ROLE_EXACT"), src.indexOf("const S = createHookScaffold"));
  const roles = [...new Set([...seg.matchAll(/"([a-z][a-z-]*)"\]/g)].map((x) => x[1]))];
  check("契约：映射表用到的官种全部在渲染端词表内（写错一个字就是每次静默降级）",
    legal.length >= 5 && roles.length >= 5 && roles.every((r) => legal.includes(r)),
    `映射表=${roles.join(",")} 词表=${legal.join(",")}`);
  const AGENTS_DIR = path.join(REPO, "ccswitch", "agents");
  const wiringOk = ["dao-implementer", "dao-adversary", "dao-scout", "dao-dogfood", "dao-reviewer"].every((stem) => {
    const p = path.join(AGENTS_DIR, stem + ".md");
    if (!fs.existsSync(p)) return false;
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(p, "utf8"));
    const nameLine = fm ? /^name:\s*(\S+)\s*$/m.exec(fm[1]) : null;
    return !!nameLine && nameLine[1] === stem;
  });
  check("⑦′ 接线：五个官种型 profile 的 frontmatter name 与文件名一致（宿主下发的是 name）", wiringOk);
}

console.log("\n──── ⑧ --selfcheck 自洽 ────");
{
  const r = spawnSync(process.execPath, [HOOK, "--selfcheck"], {
    encoding: "utf8",
    env: Object.assign({}, process.env, { DAO_CLAUSE_SOURCES: IDX_ROLES }),
  });
  const out = String(r.stdout || "");
  check("自检：逐面报 + 各官种条数 + 结论与退出码一致（不断言本机绿红，那取决于用户注册）",
    /注册/.test(out) && /各官种条数/.test(out) && (/✗/.test(out) ? r.status === 1 : r.status === 0),
    `exit=${r.status}`);
}

console.log("\n──── ⑨ mutation 双向（判据真在测这两处吗）────");
{
  // 行尾必须归一化：本仓 core.autocrlf=true，工作树里是 CRLF，跨行锚点用 \n 找不到，
  // 而失败的样子是「靶点出现 0 次」——看起来像结构变了，实际只是行尾。
  const src = fs.readFileSync(HOOK, "utf8").replace(/\r\n/g, "\n");
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

  // M1 · 关键词映射永不命中 ⇒ implementer 正控必须掉成 general，泛型路径不受影响
  const t1 = `[/实现官|implement/i, "implementer"],`;
  check("M1 靶点唯一存在", src.split(t1).length === 2);
  const m1 = writeMutant("keyword", t1, `[/__NEVER_MATCHES__/i, "implementer"],`);
  const before1 = fire("mousse-implementer");
  const after1 = fire("mousse-implementer", { script: m1 });
  check("M1：真文件映射 implementer、改坏后掉成 general ⇒ ① 那批断言有判别力",
    /官种=implementer/.test(before1.ctx) && /官种=general/.test(after1.ctx) && after1.code === 0);

  // M2 · 「渲染不出也要给指针」：改成返回空文 ⇒ ③ 的降级断言必须红
  const t2 = `      text: clamp(head.concat(tail, ptr).join("\\n")),`;
  check("M2 靶点唯一存在", src.split(t2).length === 2);
  const m2 = writeMutant("empty-degrade", t2, `      text: clamp(head.concat(tail, ptr).join("\\n")).slice(0, 0),`);
  const dead = { index: path.join(TMP, "no-such-sources.json") };
  const before2 = fire("mousse-implementer", dead);
  const after2 = fire("mousse-implementer", Object.assign({ script: m2 }, dead));
  check("M2：真文件在渲染全失败时仍给指针、改坏后注入变空（且 exit 仍 0——是判据被改坏非崩溃）",
    /dao-officer-clauses\.md/.test(before2.ctx) && after2.ctx === "" && after2.code === 0);

  // M3a · 「语料源读不到 ⇒ 不退官种」：判据整段移除 ⇒ 官种掉回 general + 心跳形态灭
  const t3a = `  const sourceDead = !r.ok && /读不到/.test(r.why || "");`;
  check("M3a 靶点唯一存在", src.split(t3a).length === 2);
  const m3a = writeMutant("sourcedead-removed", t3a, `  const sourceDead = false;`);
  const deadSources = path.join(TMP, "sources-dead-m3.json");
  fs.writeFileSync(deadSources, JSON.stringify([
    { file: path.join(TMP, "no-such-clauses.md"), selector: "all-top-level", role_scheme: "dispatch-sections" },
  ]), "utf8");
  const lastBeat = () => {
    const p = path.join(REPO, "_tmp", "subagent-clauses", "fired.log");
    const recs = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
    return JSON.parse(recs[recs.length - 1]);
  };
  const base3 = fire("mousse-implementer", { index: deadSources });
  const baseBeat = lastBeat();
  const a3 = fire("mousse-implementer", Object.assign({ script: m3a }, { index: deadSources }));
  const beat3a = lastBeat();
  check("M3a：基线保官种+记 source-dead-pointer 心跳；改坏后官种掉回 general + 心跳形态灭",
    /官种=implementer/.test(base3.ctx) && baseBeat.mode === "source-dead-pointer" &&
    /官种=general/.test(a3.ctx) && beat3a.mode !== "source-dead-pointer" && a3.code === 0);
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
