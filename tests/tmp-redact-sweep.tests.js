// `_tmp/` 落盘即脱敏 · 回归网（issue #101 第 2 条方向「产出侧接线」）
//
// 跑法：node tests/tmp-redact-sweep.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 验的是哪几层 ────────────────────────────────────────────────────────────
//   ① **正控**：新落盘的裸凭据被就地脱敏，值真的从盘上消失（这是本批的验收判据本身）
//   ② **幂等/防 churn**：第二次跑既不改盘也不报 —— 这是本设计最容易写错的一格，
//      因为脱敏标记 `[REDACTED:json-kv]` **会被 json-kv 那条正则再次命中**
//   ③ **夹具豁免的正负两侧**：值在 git 跟踪源码里 ⇒ 跳过；不在 ⇒ 照脱
//   ④ **豁免的 fail-closed 边**：只有键名级命中、取不到值级样本 ⇒ **不豁免**
//   ⑤ **自检那一半**：分母由目录遍历产出 ⇒「零处置」与「一个样本都没看到」分得开
//   ⑥ **预算用尽要说出口**，且**不推进水位线**（否则没看完的文件永远不再被看）
//   ⑦ **不扫自己的输出**（状态文件就住在 `_tmp/` 里）
//   ⑧ **报告绝不回显凭据值**
//   ⑨ **hook 端到端**：一条不触发任何提醒的命令，也要能让 ⑥ 类跑起来
//
// ⚠ 本文件里所有「凭据」都是**合成串**（`FAKE-FOR-TEST` / `CANARY` 命名），不是任何真实凭据。
//
// 🔴 **一个必须写下来的构造判据**：①②④⑨ 这几条用的合成串**刻意在运行时拼出来**，
//    不以完整字面量出现在本文件里。理由：夹具豁免的判据正是「这个值是否逐字出现在 git 跟踪
//    的源文件里」，而**本文件自己就是 git 跟踪的源文件** ⇒ 若把完整串写死在这里，豁免逻辑会
//    把它当夹具跳过，于是**正控恒绿而什么都没验到**。这与「对照组必须验证它自己真的被关掉了」
//    是同一个病：断言看起来在跑，实际被自己引入的机制静默豁免了。
//    （③ 的两侧刻意用 `corpus` 注入而不依赖真 git，才能把两个方向都摆出来。）

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const LIB = path.join(REPO, "ccswitch", "lib", "tmp-redact-sweep.js");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-tool-nudge.js");
const SANDBOX_ROOT = path.join(REPO, "_tmp", "tmp-redact-sweep-sandbox");

const S = require(LIB);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

// 运行时拼装，避免完整串以字面量形式进入 git 跟踪源码（见头注的构造判据）
const SK = ["sk", "FAKE", "FOR", "TEST", "000111222333"].join("-");
const JWT = "ey" + "J" + "hbGciOiJIUzI1NiJ9." + "ey" + "JzdWIiOiJDQU5BUlkifQ." + "FAKEsig000111";
const OPAQUE = "rt" + "_" + "CANARYopaque" + "000111222333444";

let seq = 0;
function newRoot() {
  const root = path.join(SANDBOX_ROOT, "r" + ++seq);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "_tmp"), { recursive: true });
  // 让 findRepoRoot 认得出它是仓根。**空 .git 目录** ⇒ 真 `git ls-files` 必失败 ⇒ 语料为空
  // ⇒ 什么都不豁免（失败方向朝多脱），正是我们要在 ①②④ 里依赖的那个方向。
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return root;
}
function w(root, rel, content) {
  const p = path.join(root, "_tmp", rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}
function read(p) { return fs.readFileSync(p, "utf8"); }

fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true });

console.log("── ① 正控：新落盘的裸 dump 被就地脱敏 ──");
{
  const root = newRoot();
  const dump = w(root, "ops/00-current.provider.json",
    JSON.stringify({ name: "p1", env: { ANTHROPIC_AUTH_TOKEN: SK }, note: "keep me" }, null, 2));
  const before = read(dump);
  check("前置：夹具本身确实含凭据形状（否则后面全是空转）", before.includes(SK));

  const res = S.sweep({ root });
  const after = read(dump);

  check("sweep 真的跑了（ran）", res.ran === true, JSON.stringify({ ran: res.ran, reason: res.reason }));
  check("该文件被记为已脱敏", res.redacted.length === 1 && res.redacted[0].file === dump,
    JSON.stringify(res.redacted.map((r) => r.file)));
  check("凭据值已从盘上消失", !after.includes(SK));
  check("留下了可见的脱敏标记", /\[REDACTED:/.test(after));
  check("文件其余内容原样保留（不是删文件、也不是清空）", after.includes("keep me") && after.includes("p1"));
  check("失败列表为空", res.failed.length === 0, JSON.stringify(res.failed));
}

console.log("── ② 幂等 / 防 churn：第二次跑既不改盘也不报 ──");
{
  const root = newRoot();
  const dump = w(root, "d.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK } }));
  const r1 = S.sweep({ root });
  const afterFirst = read(dump);
  check("第一次：脱了 1 个", r1.redacted.length === 1);

  // 关键：把 mtime 推到未来，强制它在第二次仍然是**候选**（否则这一条会被增量判据
  // 顺手放过，测不到我们真正要测的那个东西 —— 幂等判据本身）
  const future = Date.now() + 60_000;
  fs.utimesSync(dump, future / 1000, future / 1000);

  const r2 = S.sweep({ root });
  check("第二次：它确实又被当成候选读了一遍（否则本条测不到东西）", r2.candidates >= 1,
    JSON.stringify({ candidates: r2.candidates }));
  check("第二次：零处置（脱敏标记没有触发再次改写）", r2.redacted.length === 0,
    JSON.stringify(r2.redacted.map((x) => x.file)));
  check("第二次：文件逐字节未变", read(dump) === afterFirst);
  check("第二次：renderNotice 返回 null（不刷噪音）", S.renderNotice(r2, root) === null);
}

console.log("── ③ 夹具豁免：正负两侧 ──");
{
  const root = newRoot();
  const f = w(root, "fixture-out.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK } }));
  const before = read(f);
  // 正侧：值逐字出现在「git 跟踪的源码」里 ⇒ 它不是秘密 ⇒ 跳过
  const hit = S.sweep({ root, corpus: ['const CANARY = "' + SK + '";'] });
  check("值在跟踪源码里 ⇒ 记为 fixtureSkipped", hit.fixtureSkipped.length === 1);
  check("值在跟踪源码里 ⇒ 盘上不动", read(f) === before);

  const root2 = newRoot();
  const g = w(root2, "real-out.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK } }));
  // 负侧：语料里没有它 ⇒ 照脱。**这一侧是负控**：证明挡住上一条的是「值在源码里」
  // 这个判据本身，而不是别的什么东西碰巧让它没被脱。
  const miss = S.sweep({ root: root2, corpus: ['const UNRELATED = "hello world";'] });
  check("值不在跟踪源码里 ⇒ 照脱", miss.redacted.length === 1 && miss.fixtureSkipped.length === 0);
  check("值不在跟踪源码里 ⇒ 盘上真的变了", !read(g).includes(SK));
}

console.log("── ④ 豁免的 fail-closed 边：只有键名级命中 ⇒ 不豁免 ──");
{
  const root = newRoot();
  const f = w(root, "opaque.json", JSON.stringify({ auth: { refresh_token: OPAQUE } }));
  // 值是不透明串（不是 sk-/JWT/vendor 前缀）⇒ 抽不出值级样本 ⇒ **即便语料里有它也不许豁免**
  check("前置：该值确实抽不出值级样本", S.valueLevelMatches(read(f)).length === 0);
  const res = S.sweep({ root, corpus: ['const X = "' + OPAQUE + '";'] });
  check("取不到值级样本时不豁免，照脱", res.redacted.length === 1 && res.fixtureSkipped.length === 0,
    JSON.stringify({ redacted: res.redacted.length, fixture: res.fixtureSkipped.length }));
  check("不透明 token 已从盘上消失", !read(f).includes(OPAQUE));
}

console.log("── ⑤ 自检那一半：零处置 ≠ 零样本 ──");
{
  const root = newRoot();
  w(root, "clean-a.txt", "这里什么凭据都没有\nmodel=claude-opus-5\n");
  w(root, "clean-b.json", JSON.stringify({ model: "claude-opus-5", max_retries: 3 }));
  const res = S.sweep({ root });
  check("零处置", res.redacted.length === 0 && res.fixtureSkipped.length === 0);
  check("但分母不是 0（walker 独立产出，证明它没瞎）", res.walked >= 2,
    JSON.stringify({ walked: res.walked }));

  const empty = newRoot();
  const res2 = S.sweep({ root: empty });
  check("空 _tmp/ ⇒ walked=0，与上面那种「看了但没事」分得开", res2.ran === true && res2.walked === 0,
    JSON.stringify({ ran: res2.ran, walked: res2.walked }));

  const noRepo = S.sweep({ root: path.join(SANDBOX_ROOT, "does-not-exist") });
  check("没有 _tmp/ ⇒ ran=false 且给出 reason", noRepo.ran === false && noRepo.reason === "no-tmp");
}

console.log("── ⑥ 预算用尽：要说出口，且不推进水位线 ──");
{
  const root = newRoot();
  for (let i = 0; i < 4; i++) w(root, `many-${i}.json`, JSON.stringify({ i, env: { ANTHROPIC_AUTH_TOKEN: SK } }));
  const res = S.sweep({ root, budget: 2 });
  check("truncated=true（没看完必须说出来）", res.truncated === true);
  check("只处理了预算内的那些", res.candidates === 2, JSON.stringify({ candidates: res.candidates }));
  check("renderNotice 里明说没扫完", /没看完|预算用尽/.test(S.renderNotice(res, root) || ""));

  const stateFile = path.join(root, "_tmp", S.STATE_REL);
  const st = JSON.parse(read(stateFile));
  check("水位线未推进（否则剩下的文件会永远不再被看）", st.lastSweepMs === 0 && st.truncated === true,
    JSON.stringify(st));

  // 补跑：水位线没动过 ⇒ 剩下的两个仍然是候选，最终能被清完
  const res2 = S.sweep({ root, budget: 10 });
  check("补跑能把剩下的清完", res2.redacted.length === 2, JSON.stringify({ n: res2.redacted.length }));
  const leftovers = fs.readdirSync(path.join(root, "_tmp")).filter((f) => f.startsWith("many-"));
  check("四个文件最终都不含凭据", leftovers.length === 4 &&
    leftovers.every((f) => !read(path.join(root, "_tmp", f)).includes(SK)));
}

console.log("── ⑦ 不扫自己的输出 ──");
{
  const root = newRoot();
  w(root, "x.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK } }));
  const res = S.sweep({ root });
  const stateFile = path.resolve(path.join(root, "_tmp", S.STATE_REL));
  check("状态文件没被当成处置对象", !res.redacted.some((r) => path.resolve(r.file) === stateFile));
  check("状态文件里不含任何凭据值", !read(stateFile).includes(SK));
  // 第二次跑时状态文件已存在于 _tmp/ 内，确认它不会把自己卷进去
  const res2 = S.sweep({ root, now: Date.now() + 1000 });
  check("第二次跑仍然不处置状态文件", !res2.redacted.some((r) => path.resolve(r.file) === stateFile));
}

console.log("── ⑧ 报告绝不回显凭据值 ──");
{
  const root = newRoot();
  w(root, "leak.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK }, t: JWT }));
  const res = S.sweep({ root });
  const notice = S.renderNotice(res, root) || "";
  check("notice 非空（确实报了）", notice.length > 0);
  check("notice 不含 sk 串", !notice.includes(SK));
  check("notice 不含 JWT 串", !notice.includes(JWT));
  check("notice 里有模式名（报的是类别不是值）", /sk-key|json-kv|jwt/.test(notice));
  check("返回结构里也不含凭据值", !JSON.stringify(res).includes(SK));
}

console.log("── ⑨ 二进制 / 越界 / 增量 ──");
{
  const root = newRoot();
  const bin = path.join(root, "_tmp", "shot.png");
  fs.writeFileSync(bin, Buffer.concat([Buffer.from("PNG"), Buffer.from([0, 0, 0]), Buffer.from(SK)]));
  const res = S.sweep({ root });
  check("二进制被跳过并单独计数", res.binarySkipped === 1, JSON.stringify({ b: res.binarySkipped }));
  check("二进制内容未被改动", fs.readFileSync(bin).includes(SK));

  // 越界：_tmp/ 之外的同名文件不许碰
  const outside = path.join(root, "outside.json");
  fs.writeFileSync(outside, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK } }), "utf8");
  S.sweep({ root, now: Date.now() + 1000 });
  check("`_tmp/` 之外的文件不被触碰", read(outside).includes(SK));

  // 增量：老文件（mtime 早于水位线）不再是候选
  const root2 = newRoot();
  const old = w(root2, "old.txt", "nothing here");
  S.sweep({ root: root2 });
  const past = (Date.now() - 600_000) / 1000;
  fs.utimesSync(old, past, past);
  const res2 = S.sweep({ root: root2 });
  check("mtime 早于水位线的文件不再进候选", res2.candidates === 0, JSON.stringify({ c: res2.candidates }));
  check("但它仍然被 walk 数到（分母不因增量而塌）", res2.walked >= 1, JSON.stringify({ w: res2.walked }));
}

console.log("── ⑩ hook 端到端：不触发任何提醒的命令也要让 ⑥ 跑起来 ──");
{
  const root = newRoot();
  const dump = w(root, "ops/dump.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK } }));
  const payload = JSON.stringify({
    tool_name: "Bash",
    cwd: root,
    tool_input: { command: "node _tmp/ops/make-dump.mjs" },  // 不含 grep/cat/gh/git push/dev
  });
  const r = spawnSync(process.execPath, [HOOK], { input: payload, encoding: "utf8" });
  check("hook exit 0（永不阻断）", r.status === 0, `status=${r.status} stderr=${String(r.stderr).slice(0, 200)}`);
  check("盘上凭据已被 hook 擦掉", !read(dump).includes(SK));

  let ctx = "";
  try { ctx = JSON.parse(String(r.stdout)).hookSpecificOutput.additionalContext || ""; }
  catch (_) { ctx = ""; }
  check("hook 输出里报告了这次脱敏", /凭据脱敏/.test(ctx), String(r.stdout).slice(0, 300));
  check("hook 输出里不含凭据值", !String(r.stdout).includes(SK));

  // 逃生阀：只有用户设得了（子进程环境里模拟）
  const root2 = newRoot();
  const dump2 = w(root2, "d2.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK } }));
  const r2 = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", cwd: root2, tool_input: { command: "echo hi" } }),
    encoding: "utf8",
    env: Object.assign({}, process.env, { DAO_TMP_SWEEP_OFF: "1" }),
  });
  check("逃生阀开启时 hook 仍 exit 0", r2.status === 0);
  check("逃生阀开启时不改盘", read(dump2).includes(SK));
}

fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true });

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
