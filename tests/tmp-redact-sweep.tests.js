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
//   ⑥ **预算用尽要说出口**，且**水位线要按 keyset 游标单调推进**（2026-08-04 改，见组内注释）
//   ⑦ **不扫自己的输出**（状态文件与台账都住在 `_tmp/` 里）
//   ⑧ **报告绝不回显凭据值**
//   ⑨ **hook 端到端**：一条不触发任何提醒的命令，也要能让 ⑥ 类跑起来
//   ⑪ **扫描面白名单**（2026-08-04 新增）：名单内才读，名单外连读都不读；剪枝真的在剪；
//      声明文件没被 git 跟踪就不生效、且必须出声
//
// ⚠ 本文件里所有「凭据」都是**合成串**（`FAKE-FOR-TEST` / `CANARY` 命名），不是任何真实凭据。
//
// 🔴 **一个必须写下来的构造判据**：合成串**刻意在运行时拼出来**，不以完整字面量出现在本文件里。
//    **它挡的是两件事，不是一件**：
//    ㈠ 夹具豁免的判据正是「这个值是否逐字出现在 git 跟踪的源文件里」，而**本文件自己就是
//       git 跟踪的源文件** ⇒ 写死在这里会被当夹具跳过，于是**正控恒绿而什么都没验到**；
//    ㈡ **sweep 会改坏本文件自己** —— 对抗验证官照 ㈠ 的理由照做时漏了 ㈡，当场中招：
//       他的验收文件被自己要验的东西就地改写，其中一处被改成语法错误。
//    （③ 的两侧刻意用 `corpus` 注入而不依赖真 git，才能把两个方向都摆出来。）
//
// 🔴 **2026-08-04：本文件的夹具路径整体搬进扫描面内**。加了白名单之后，`_tmp/` 顶层的
//    `d.json` / `leak.json` 之类**不在默认扫描面里** ⇒ 断言会**恒绿而什么都没验到**
//    （「没被改」既可能因为逻辑对，也可能因为它压根没被看）。故夹具一律落
//    `_tmp/dump/`（约定落点，默认扫描面内）或 `_tmp/<x>/00-current.*`（文件名形态），
//    并由 ⓪ 组把「夹具真的在面内」本身钉成断言。
//    **这与上面那条构造判据是同一个病的两个实例：断言看起来在跑，实际被自己引入的机制豁免了。**

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const LIB = path.join(REPO, "ccswitch", "lib", "tmp-redact-sweep.js");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-tool-nudge.js");
const SANDBOX_ROOT = path.join(REPO, "_tmp", "tmp-redact-sweep-sandbox");

const S = require(LIB);
const SC = require(path.join(REPO, "ccswitch", "lib", "tmp-sweep-scope.js"));

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

console.log("── ⓪ 前置：夹具路径确实在默认扫描面内（否则下面全是空转）──");
{
  // 少了这一条，「恒绿而什么都没验到」的病会在下次有人改默认值时静默复发。
  const m = SC.compile(SC.DEFAULT_SCOPE);
  const used = [
    "ops/00-current.provider.json", "dump/d.json", "dump/fixture-out.json", "dump/real-out.json",
    "dump/opaque.json", "dump/clean-a.txt", "dump/clean-b.json", "dump/many-0.json",
    "dump/x.json", "dump/leak.json", "dump/shot.png", "dump/old.txt", "dump/ops.json",
    "dump/d2.json", "dump/a.json",
  ];
  const outside = used.filter((r) => !m.matchFile(r));
  check("本文件全部夹具路径都在默认扫描面内", outside.length === 0, "不在面内：" + outside.join(", "));
}

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
  const dump = w(root, "dump/d.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK } }));
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
  const f = w(root, "dump/fixture-out.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK } }));
  const before = read(f);
  // 正侧：值逐字出现在「git 跟踪的源码」里 ⇒ 它不是秘密 ⇒ 跳过
  const hit = S.sweep({ root, corpus: ['const CANARY = "' + SK + '";'] });
  check("值在跟踪源码里 ⇒ 记为 fixtureSkipped", hit.fixtureSkipped.length === 1);
  check("值在跟踪源码里 ⇒ 盘上不动", read(f) === before);

  const root2 = newRoot();
  const g = w(root2, "dump/real-out.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK } }));
  // 负侧：语料里没有它 ⇒ 照脱。**这一侧是负控**：证明挡住上一条的是「值在源码里」
  // 这个判据本身，而不是别的什么东西碰巧让它没被脱。
  const miss = S.sweep({ root: root2, corpus: ['const UNRELATED = "hello world";'] });
  check("值不在跟踪源码里 ⇒ 照脱", miss.redacted.length === 1 && miss.fixtureSkipped.length === 0);
  check("值不在跟踪源码里 ⇒ 盘上真的变了", !read(g).includes(SK));
}

console.log("── ④ 豁免的 fail-closed 边：只有键名级命中 ⇒ 不豁免 ──");
{
  const root = newRoot();
  const f = w(root, "dump/opaque.json", JSON.stringify({ auth: { refresh_token: OPAQUE } }));
  // 值是不透明串（不是 sk-/JWT/vendor 前缀）⇒ 抽不出值级样本 ⇒ **即便语料里有它也不许豁免**
  check("前置：该值确实抽不出值级样本", S.valueLevelMatches(read(f)).length === 0);
  const res = S.sweep({ root, corpus: ['const X = "' + OPAQUE + '";'] });
  check("取不到值级样本时不豁免，照脱", res.redacted.length === 1 && res.fixtureSkipped.length === 0,
    JSON.stringify({ redacted: res.redacted.length, fixture: res.fixtureSkipped.length }));
  check("不透明 token 已从盘上消失", !read(f).includes(OPAQUE));
}

console.log("── ⑤ 自检那一半：零处置 ≠ 零样本 ≠ 零扫描面 ──");
{
  const root = newRoot();
  w(root, "dump/clean-a.txt", "这里什么凭据都没有\nmodel=claude-opus-5\n");
  w(root, "dump/clean-b.json", JSON.stringify({ model: "claude-opus-5", max_retries: 3 }));
  const res = S.sweep({ root });
  check("零处置", res.redacted.length === 0 && res.fixtureSkipped.length === 0);
  check("但分母不是 0（walker 独立产出，证明它没瞎）", res.walked >= 2,
    JSON.stringify({ walked: res.walked }));
  check("而且它们真的进了扫描面（不是「看见了但跳过了」）", res.candidates >= 2,
    JSON.stringify({ candidates: res.candidates, scopeSkipped: res.scopeSkipped }));

  const empty = newRoot();
  const res2 = S.sweep({ root: empty });
  check("空 _tmp/ ⇒ walked=0，与上面那种「看了但没事」分得开", res2.ran === true && res2.walked === 0,
    JSON.stringify({ ran: res2.ran, walked: res2.walked }));

  // 白名单引入的**第三种 0**：看到了文件，但一个都不在扫描面里。
  // 它与前两种在旧返回值里长得一模一样，而它恰恰是白名单配错时的表现。
  const root3 = newRoot();
  w(root3, "not-in-scope/whatever.txt", "含不含凭据都无所谓，它不该被读");
  const res3 = S.sweep({ root: root3 });
  check("「看到了但都不在扫描面里」与前两种 0 分得开（scopeSkipped/scopePruned 有数）",
    res3.ran === true && res3.candidates === 0 && (res3.scopeSkipped + res3.scopePruned) >= 1,
    JSON.stringify({ walked: res3.walked, scopeSkipped: res3.scopeSkipped, scopePruned: res3.scopePruned }));

  const noRepo = S.sweep({ root: path.join(SANDBOX_ROOT, "does-not-exist") });
  check("没有 _tmp/ ⇒ ran=false 且给出 reason", noRepo.ran === false && noRepo.reason === "no-tmp");
}

console.log("── ⑥ 预算用尽：要说出口，且水位线按 keyset 游标单调推进 ──");
{
  // 🔴 2026-08-04 改写：本组原先断言 `st.lastSweepMs === 0`（「没看完就别推进」）——
  //    **那条断言把 B2 那个 bug 本身钉住了**：候选数长期超预算时 truncated 恒真 ⇒ 水位线
  //    永停 0 ⇒ 目录遍历顺序确定 ⇒ 每次读同一批，一部分文件结构性永远扫不到（实测
  //    30 文件 / 预算 5 连跑 10 次，候选恒 [5,5,…]，25/30 从未被处理）。
  //    现在的判据是「游标必须推进到本次处理完的位置」，端到端收敛性由 acceptance 的 A3 盯。
  const root = newRoot();
  for (let i = 0; i < 4; i++) w(root, `dump/many-${i}.json`, JSON.stringify({ i, env: { ANTHROPIC_AUTH_TOKEN: SK } }));
  const res = S.sweep({ root, budget: 2 });
  check("truncated=true（没看完必须说出来）", res.truncated === true);
  check("只处理了预算内的那些", res.candidates === 2, JSON.stringify({ candidates: res.candidates }));
  check("还剩几个在排队要报出来（pending）", res.pending === 2, JSON.stringify({ pending: res.pending }));
  check("renderNotice 里明说没扫完", /没看完|预算用尽/.test(S.renderNotice(res, root) || ""));

  const stateFile = path.join(root, "_tmp", S.STATE_REL);
  const st = JSON.parse(read(stateFile));
  check("水位线**推进了**（keyset 游标：mtime 与相对路径两维都记下来）",
    st.lastSweepMs > 0 && typeof st.lastPath === "string" && st.lastPath.length > 0,
    JSON.stringify(st));

  // 补跑：游标之后的那两个才是候选，且不重读已处理的那两个
  const res2 = S.sweep({ root, budget: 10 });
  check("补跑只处理剩下的两个（不重读已处理过的）", res2.candidates === 2 && res2.redacted.length === 2,
    JSON.stringify({ candidates: res2.candidates, redacted: res2.redacted.length }));
  const leftovers = fs.readdirSync(path.join(root, "_tmp", "dump")).filter((f) => f.startsWith("many-"));
  check("四个文件最终都不含凭据", leftovers.length === 4 &&
    leftovers.every((f) => !read(path.join(root, "_tmp", "dump", f)).includes(SK)));

  const res3 = S.sweep({ root, budget: 10 });
  check("再跑一次：零候选、零处置、不再报「没看完」（游标真的越过去了）",
    res3.candidates === 0 && res3.redacted.length === 0 && res3.truncated === false,
    JSON.stringify({ candidates: res3.candidates, truncated: res3.truncated }));

  // 🔴 **同一毫秒落盘、且多于预算** —— 游标第二维（相对路径）就是为这一格存在的。
  // 这条断言是 2026-08-04 由 mutation 补出来的：把 `mtimeMs === sinceMs && rel <= sincePath`
  // 那一维删掉，上面全部断言**一条都不红** —— 因为它们的夹具 mtime 各不相同，`===` 那一支
  // 从来没被走到过。只按 mtime 排的话，同 mtime 的一批会永远卡在同一个位置：**B2 换个地方复发**。
  const rootT = newRoot();
  const N = 12, STAMP = Math.floor(Date.now() / 1000) - 3600;   // 秒级时间戳，确保逐字相同
  for (let i = 0; i < N; i++) {
    const p = w(rootT, `dump/tie-${String(i).padStart(2, "0")}.json`,
      JSON.stringify({ i, env: { ANTHROPIC_AUTH_TOKEN: SK } }));
    fs.utimesSync(p, STAMP, STAMP);
  }
  const tieDir = path.join(rootT, "_tmp", "dump");
  const distinct = new Set(fs.readdirSync(tieDir).map((f) => fs.statSync(path.join(tieDir, f)).mtimeMs));
  check("前置：这批文件的 mtime 逐字相同（否则本组测不到第二维，会恒绿）", distinct.size === 1,
    JSON.stringify({ distinctMtimes: distinct.size }));

  const tieCands = [];
  for (let k = 0; k < 6; k++) tieCands.push(S.sweep({ root: rootT, budget: 3 }).candidates);
  check("同 mtime 的一批多于预算时仍然收敛（游标第二维在起作用）",
    tieCands[tieCands.length - 1] === 0, "candidates 序列=" + JSON.stringify(tieCands));
  const tieDirty = fs.readdirSync(tieDir).filter((f) => read(path.join(tieDir, f)).includes(SK));
  check("同 mtime 的这批最终全部被处理过（一个都不许结构性漏掉）", tieDirty.length === 0,
    "仍含凭据=" + tieDirty.length + " / " + N);
}

console.log("── ⑦ 不扫自己的输出（状态文件 + 台账）──");
{
  const root = newRoot();
  w(root, "dump/x.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK } }));
  const res = S.sweep({ root });
  const stateFile = path.resolve(path.join(root, "_tmp", S.STATE_REL));
  const auditFile = path.resolve(path.join(root, "_tmp", S.AUDIT_REL));
  check("状态文件没被当成处置对象", !res.redacted.some((r) => path.resolve(r.file) === stateFile));
  check("台账没被当成处置对象", !res.redacted.some((r) => path.resolve(r.file) === auditFile));
  // 先断言存在再读：**文件不在时要红着说出来，不是抛异常**。抛出去的话本套没有汇总行，
  // 而「没有汇总行」与「跑挂了」在计分器眼里一样 —— mutation 计分会把它读成「变异体已死」。
  check("状态文件已落盘", fs.existsSync(stateFile));
  check("台账已落盘", fs.existsSync(auditFile));
  check("状态文件里不含任何凭据值", fs.existsSync(stateFile) && !read(stateFile).includes(SK));
  check("台账里不含任何凭据值", fs.existsSync(auditFile) && !read(auditFile).includes(SK));
  // 第二次跑时状态文件已存在于 _tmp/ 内，确认它不会把自己卷进去
  const res2 = S.sweep({ root, now: Date.now() + 1000 });
  check("第二次跑仍然不处置状态文件", !res2.redacted.some((r) => path.resolve(r.file) === stateFile));

  // 🔴 **两次都真改了盘**时台账才验得到「追加 vs 覆写」。这条是 2026-08-04 由 mutation 补的：
  // 把 appendFileSync 换成 writeFileSync（＝旧实现那个「下次覆写」的病），原有断言**一条都不红**
  // —— 因为第二次 sweep 没有产生任何记录（`appendAudit` 在 records 为空时直接早退），
  // 于是「覆写」这个动作根本没被执行过。**没被执行的代码路径，断言再多也验不到它。**
  const rootA = newRoot();
  w(rootA, "dump/first.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK } }));
  S.sweep({ root: rootA });
  w(rootA, "dump/second.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK } }));
  S.sweep({ root: rootA, now: Date.now() + 1000 });
  const auditA = path.join(rootA, "_tmp", S.AUDIT_REL);
  const logA = fs.existsSync(auditA) ? read(auditA) : "";
  check("两次改盘之后，第一次的记录仍在（真·追加，不是覆写）",
    logA.includes("first.json") && logA.includes("second.json"),
    JSON.stringify({ hasFirst: logA.includes("first.json"), hasSecond: logA.includes("second.json") }));
  check("台账是逐行 JSONL，两次各占一行", logA.trim().split(/\r?\n/).filter(Boolean).length === 2,
    JSON.stringify({ lines: logA.trim().split(/\r?\n/).filter(Boolean).length }));
}

console.log("── ⑧ 报告绝不回显凭据值 ──");
{
  const root = newRoot();
  w(root, "dump/leak.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK }, t: JWT }));
  const res = S.sweep({ root });
  const notice = S.renderNotice(res, root) || "";
  check("notice 非空（确实报了）", notice.length > 0);
  check("notice 不含 sk 串", !notice.includes(SK));
  check("notice 不含 JWT 串", !notice.includes(JWT));
  check("notice 里有模式名（报的是类别不是值）", /sk-key|json-kv|jwt/.test(notice));
  check("返回结构里也不含凭据值", !JSON.stringify(res).includes(SK));
  const um = S.renderUserMessage(res, root) || "";
  check("给用户那条也非空（改盘必须走用户可见通道）", um.length > 0);
  check("给用户那条不含凭据值", !um.includes(SK) && !um.includes(JWT));
}

console.log("── ⑨ 二进制 / 越界 / 增量 ──");
{
  const root = newRoot();
  const bin = path.join(root, "_tmp", "dump", "shot.png");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
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
  const old = w(root2, "dump/old.txt", "nothing here");
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
  const dump = w(root, "dump/ops.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK } }));
  const payload = JSON.stringify({
    tool_name: "Bash",
    cwd: root,
    tool_input: { command: "node _tmp/dump/make-dump.mjs" },  // 不含 grep/cat/gh/git push/dev
  });
  const r = spawnSync(process.execPath, [HOOK], { input: payload, encoding: "utf8" });
  check("hook exit 0（永不阻断）", r.status === 0, `status=${r.status} stderr=${String(r.stderr).slice(0, 200)}`);
  check("盘上凭据已被 hook 擦掉", !read(dump).includes(SK));

  let parsed = {};
  try { parsed = JSON.parse(String(r.stdout)); } catch (_) { parsed = {}; }
  const ctx = String((parsed.hookSpecificOutput || {}).additionalContext || "");
  check("hook 输出里报告了这次脱敏", /凭据脱敏/.test(ctx), String(r.stdout).slice(0, 300));
  check("hook 输出里不含凭据值", !String(r.stdout).includes(SK));
  check("改盘走了 systemMessage（用户可见通道）",
    typeof parsed.systemMessage === "string" && parsed.systemMessage.length > 0,
    JSON.stringify(parsed.systemMessage));

  // 逃生阀：只有用户设得了（子进程环境里模拟）
  const root2 = newRoot();
  const dump2 = w(root2, "dump/d2.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK } }));
  const r2 = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", cwd: root2, tool_input: { command: "echo hi" } }),
    encoding: "utf8",
    env: Object.assign({}, process.env, { DAO_TMP_SWEEP_OFF: "1" }),
  });
  check("逃生阀开启时 hook 仍 exit 0", r2.status === 0);
  check("逃生阀开启时不改盘", read(dump2).includes(SK));
}

console.log("── ⑪ 扫描面白名单（2026-08-04 · B4 的正解）──");
{
  // ㈠ 名单外的文件：连读都不读。**用「盘上没变」当判据是不够的** —— 干净的文件本来就不变。
  //    故两侧靶子都**含凭据**：名单内被脱、名单外原封不动，摆在一起才有判别力。
  const root = newRoot();
  const inScope = w(root, "dump/a.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SK } }));
  const outScope = w(root, "third-party/docs/howto.md", "教你怎么填：ANTHROPIC_AUTH_TOKEN: " + SK + "\n");
  const res = S.sweep({ root });
  check("名单内的被脱敏", !read(inScope).includes(SK));
  check("名单外的原封不动（这才是那 379 个误伤的正解）", read(outScope).includes(SK));
  check("名单外的进了 scopeSkipped 或被剪枝，不是静默消失",
    (res.scopeSkipped + res.scopePruned) >= 1,
    JSON.stringify({ scopeSkipped: res.scopeSkipped, scopePruned: res.scopePruned }));

  // ㈡ 剪枝真的在剪：深层第三方树（mousse-cli 那 370 个误伤的形状）不该被 readdir 进去。
  const root2 = newRoot();
  w(root2, "gate0/synth/plugins/x/skills/y/refs/oauth.md", "api_key: " + SK + "\n");
  const res2 = S.sweep({ root: root2 });
  check("深层第三方树被剪枝（那个文件根本没被 walk 到）", res2.walked === 0 && res2.scopePruned >= 1,
    JSON.stringify({ walked: res2.walked, scopePruned: res2.scopePruned }));

  // ㈢ 声明文件：**没被 git 跟踪就不生效**，且必须出声（静默忽略是本体系明令要防的形态）。
  const root3 = newRoot();
  const target3 = w(root3, "myops/keydump.txt", "api_key: " + SK + "\n");
  fs.writeFileSync(path.join(root3, SC.DECL_FILE), JSON.stringify({ scope: ["myops/**"] }), "utf8");
  const res3 = S.sweep({ root: root3, declaredTracked: false });
  check("声明文件未被 git 跟踪 ⇒ 不生效（放宽改盘面必须留下可审查的提交）",
    read(target3).includes(SK), "文件被改了 ⇒ 未跟踪的声明竟然生效了");
  check("而且要出声，不能静默忽略", res3.scopeWarnings.length >= 1 &&
    /没有被 git 跟踪/.test(res3.scopeWarnings.join(" ")), JSON.stringify(res3.scopeWarnings));
  check("这条警告到得了读者眼前（进 renderNotice）",
    /扫描面声明/.test(S.renderNotice(res3, root3) || ""), JSON.stringify(S.renderNotice(res3, root3)));

  // ㈣ 对照组：被跟踪时**真的生效** —— 证明挡住 ㈢ 的是「没跟踪」，不是别的什么东西
  const root4 = newRoot();
  const target4 = w(root4, "myops/keydump.txt", "api_key: " + SK + "\n");
  fs.writeFileSync(path.join(root4, SC.DECL_FILE), JSON.stringify({ scope: ["myops/**"] }), "utf8");
  const res4 = S.sweep({ root: root4, declaredTracked: true });
  check("声明被 git 跟踪 ⇒ 扩出来的面真的生效（对照组）", !read(target4).includes(SK),
    JSON.stringify({ source: res4.scopeSource, warnings: res4.scopeWarnings }));
  check("声明是 extend 不是 replace（内置那几条还在）",
    res4.scopePatterns === SC.DEFAULT_SCOPE.length + 1 && res4.scopeSource === "builtin+declared",
    JSON.stringify({ n: res4.scopePatterns, builtin: SC.DEFAULT_SCOPE.length, src: res4.scopeSource }));

  // ㈤ 上溯段/绝对路径一律拒绝：扫描面永远只表达 `_tmp/` 内部的相对位置
  const root5 = newRoot();
  fs.writeFileSync(path.join(root5, SC.DECL_FILE), JSON.stringify({ scope: ["../../etc/**", "ok/**"] }), "utf8");
  const res5 = S.sweep({ root: root5, declaredTracked: true });
  check("含上溯段的模式被拒绝且出声", /被拒绝/.test(res5.scopeWarnings.join(" ")), JSON.stringify(res5.scopeWarnings));
  check("同批里合法的那条仍然生效（拒绝是逐条的，不是整份丢弃）",
    res5.scopePatterns === SC.DEFAULT_SCOPE.length + 1, JSON.stringify({ n: res5.scopePatterns }));
}

fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true });

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
