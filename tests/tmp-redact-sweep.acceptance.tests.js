// PR #108 对抗验证 · 四个阻断项的验收判据（B1 台账 / B2 收敛 / B3 越界 / B4 自噬）
//
// 跑法：node tests/tmp-redact-sweep.acceptance.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 这个文件从哪来 ──────────────────────────────────────────────────────────
// 它**不是修复方写的**。2026-08-03 的对抗验证官在判 PR #108「不可合」时，把四个阻断项
// 写成了 13 条可执行断言放在 `_tmp/adv108/acceptance.tests.js`，当时 **4 过 9 红**，
// 并明说「修完原样落 `tests/`」。红断言跟着修复那一版一起进，是为了**锚先破再验**。
// 本文件即那一份，逐条保留原判据与原措辞。
//
// ── 相对原件的改动，逐条照直写（别让「原样落」变成一句空话）────────────────
//   ㈠ `REPO` 由 `../..` 改成 `..`（原件自己的注释就写了「落 tests/ 后改这里」）。
//   ㈡ **夹具路径搬进扫描面内**。修复引入了白名单（`ccswitch/lib/tmp-sweep-scope.js`），
//      而原件的夹具（`_tmp/big.json`、`_tmp/a.json`、`link/config.json`…）落在名单外
//      ⇒ 那些断言会**恒绿而什么都没验到**：「没被改」既可能因为修好了，也可能因为它
//      压根没被看。故夹具一律改到默认名单内的位置（`_tmp/dump/**` 或 `*/​*settings*.json`），
//      **并给每组补一条「非空转前置」**：断言这个夹具确实同时满足「在扫描面内」+
//      「redactText 真的会动它」。少了这条前置，下一个改默认值的人会静默把整份验收变成空转。
//   ㈢ A6 的 canary 同理搬进 `_tmp/dump/`。**这一格最要紧**：原件的 canary 在
//      `_tmp/acceptance-canary/` —— 白名单生效后它天然不在面内 ⇒ A6 会变成**假阴性**
//      （即便 cwd 那个 bug 原封不动，canary 也活得好好的）。它验的是 cwd，不是 scope，
//      所以必须让它落在「若 cwd 错了就一定会被吃掉」的位置。
//   ㈣ A1 的越界靶子改名 `config.json` → `settings.json`（同 ㈡ 的理由：要在名单内，
//      这条断言才是在验「圈定」而不是在验「碰巧没扫」）。
// 除此之外判据一字未改；A1-A6 的分组、断言文案与判定逻辑均为原件。
//
// ⚠ 全部为合成假串，运行时拼装（见回归网头注的构造判据：写死字面量会被夹具豁免染绿，
//   而且 sweep 会改坏本文件自己 —— 原件就是这么中招的）。

const fs = require("fs"), path = require("path"), cp = require("child_process");
const REPO = path.resolve(__dirname, "..");
const LIB = path.join(REPO, "ccswitch", "lib", "tmp-redact-sweep.js");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-tool-nudge.js");
const S = require(LIB);
const SC = require(path.join(REPO, "ccswitch", "lib", "tmp-sweep-scope.js"));
const R = require(path.join(REPO, "ccswitch", "lib", "redact.js"));
const SB = path.join(REPO, "_tmp", "sweep-acceptance-sandbox");

const SK = ["sk", "FAKE", "FOR", "TEST", "000111222333"].join("-");
const PATTERN_NAMES = new RegExp(["json-kv", "yaml-kv", "sk" + "-key"].join("|"));
const SCOPE = SC.compile(SC.DEFAULT_SCOPE);
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n + (d ? "  →  " + d : ""))); };

// 非空转前置：这个夹具**同时**满足「在默认扫描面内」与「redactText 真的会改它」。
// 两个条件缺任何一个，本组的断言就只是在观察一个不会发生的事。
function assertLive(label, relInTmp, content) {
  const inScope = SCOPE.matchFile(relInTmp);
  const wouldChange = R.redactText(content) !== content;
  check(label + "：夹具非空转（在扫描面内 + redactText 真的会动它）", inScope && wouldChange,
    JSON.stringify({ rel: relInTmp, inScope, wouldChange }));
}

fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
let seq = 0;
function newRoot() {
  const r = path.join(SB, "r" + ++seq);
  fs.mkdirSync(path.join(r, "_tmp"), { recursive: true });
  fs.mkdirSync(path.join(r, ".git"), { recursive: true });
  return r;
}
const w = (p, c) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, c, "utf8"), p);
const rd = (p) => fs.readFileSync(p, "utf8");
const bare = (extra) => JSON.stringify(Object.assign({ api_key: SK }, extra || {}));

console.log("── A1 越界：目录联接(junction)不得让 sweep 改写 `_tmp/` 之外的文件 ──");
{
  const root = newRoot();
  const outside = path.join(root, "not-tmp");
  const victim = w(path.join(outside, "settings.json"), bare());
  assertLive("A1", "link/settings.json", bare());
  const r = cp.spawnSync("cmd", ["/c", "mklink", "/J", path.join(root, "_tmp", "link"), outside],
    { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) console.log("  SKIP  本机建不了 junction（非 Windows 或权限不足）");
  else {
    const res = S.sweep({ root });
    check("junction 目标（在 _tmp/ 之外）未被改写", rd(victim).includes(SK),
      "redacted=" + JSON.stringify(res.redacted.map((x) => path.relative(root, x.file))));
    check("越界候选被明确计数/报告，而不是静默处理掉",
      typeof res.outOfScope === "number" || Array.isArray(res.outOfScope),
      "res 里没有任何表示「我拒绝了越界目标」的字段");
    // B3 的后半：原缺陷里 `redacted` 报的是 `_tmp\link\config.json` —— 一个 `_tmp/` 里面
    // 的路径，而文件被改在外面。**唯一那点痕还是错的**，故这里连报的路径一起钉住。
    check("报出来的越界项指得回真实位置（原缺陷报的是 `_tmp/` 里的假路径）",
      res.outOfScope.length >= 1 && res.outOfScope.every((x) => x.real === null || path.resolve(x.real) === path.resolve(outside)),
      JSON.stringify(res.outOfScope));
  }
}

console.log("── A2 静默跳过：tooLarge 必须说出口（否则与「干净」不可区分）──");
{
  const root = newRoot();
  assertLive("A2", "dump/big.json", bare());
  w(path.join(root, "_tmp", "dump", "big.json"), bare() + " ".repeat(64));
  const res = S.sweep({ root, maxBytes: 8 });
  check("前置：确实制造出了 tooLarge", res.tooLarge === 1, JSON.stringify({ tooLarge: res.tooLarge }));
  const notice = S.renderNotice(res, root);
  check("renderNotice 必须提到「有文件没读」", notice !== null && /过大|超过|没读|未读|tooLarge/.test(notice),
    "notice=" + JSON.stringify(notice));
  // unreadable 判据同上，但本机造不稳（Windows 上「stat 得到而 read 不到」不易复现）⇒
  // 刻意不写一条造不出来的断言，改为在 PR 评论里标为「读码得出、未实测」。
}

console.log("── A3 收敛：预算用尽不得让水位线永久冻结（否则每次 Bash 调用都重读同一批）──");
{
  const root = newRoot();
  assertLive("A3", "dump/f0.json", bare({ i: 0 }));
  // 30 个文件**每个都含凭据** ⇒ 「谁被真正处理过」由盘上内容直接判，不靠计数自证
  for (let i = 0; i < 30; i++) w(path.join(root, "_tmp", "dump", "f" + i + ".json"), bare({ i }));
  const cands = [];
  for (let k = 0; k < 10; k++) cands.push(S.sweep({ root, budget: 5 }).candidates);
  check("连跑 10 次、期间无新文件 ⇒ 候选数必须收敛到 0（原实现恒为 5）",
    cands[cands.length - 1] === 0, "candidates 序列=" + JSON.stringify(cands));
  const dir = path.join(root, "_tmp", "dump");
  const dirty = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && rd(path.join(dir, f)).includes(SK));
  check("30 个文件在 10 次扫描后全部被处理过（不许某些文件结构性永远轮不到）",
    dirty.length === 0, "至今仍含凭据的文件数=" + dirty.length + " / 30");
}

console.log("── A4 留痕（用户 2026-08-03 拍板「接受误伤」的附带义务）──");
{
  const root = newRoot();
  assertLive("A4", "dump/a.json", bare());
  const f = w(path.join(root, "_tmp", "dump", "a.json"), bare());
  S.sweep({ root });
  check("前置：确实改了盘", !rd(f).includes(SK));

  // ①盘上要有一份可事后查询的记录，写明改了哪个文件 + 命中哪条模式
  const cands = [
    path.join(root, "_tmp", "tool-nudge", "tmp-redact-sweep.log"),
    path.join(root, "_tmp", "tool-nudge", "tmp-redact-sweep-audit.jsonl"),
  ];
  const logFile = cands.find((p) => fs.existsSync(p));
  check("存在一份独立的改盘台账文件", !!logFile, "找过：" + cands.map((p) => path.relative(root, p)).join(" / "));
  if (logFile) {
    const log = rd(logFile);
    check("台账里有被改文件的路径", log.includes("a.json"));
    check("台账里有命中的模式名", PATTERN_NAMES.test(log));
    check("台账里没有凭据值", !log.includes(SK));
  }

  // ②台账必须是追加的：下一次 sweep 不许把上一次的记录抹掉
  w(path.join(root, "_tmp", "dump", "b.json"), "clean");
  S.sweep({ root, now: Date.now() + 5000 });
  check("下一次 sweep 之后，上一次的改盘记录仍在（追加而非覆写）",
    !!logFile && fs.existsSync(logFile) && rd(logFile).includes("a.json"),
    "原实现只有 state 文件，且 redacted 计数被下一次覆写成 0");
}

console.log("── A5 留痕（用户侧通道）：改了盘必须走 systemMessage，不能只进 additionalContext ──");
{
  const root = newRoot();
  assertLive("A5", "dump/c.json", bare());
  const f = w(path.join(root, "_tmp", "dump", "c.json"), bare());
  const r = cp.spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", cwd: root, tool_input: { command: "node _tmp/x.mjs" } }),
    encoding: "utf8",
  });
  let out = {}; try { out = JSON.parse(r.stdout || "{}"); } catch (_) { }
  check("前置：hook 确实改了盘", !rd(f).includes(SK));
  check("改盘时 systemMessage 非空（本仓既有约定：systemMessage=用户可见，见 dao-rule-echo.js:29）",
    typeof out.systemMessage === "string" && out.systemMessage.length > 0,
    "原实现只有 additionalContext（模型侧），systemMessage=" + JSON.stringify(out.systemMessage));
  check("systemMessage 里不含凭据值", !String(out.systemMessage || "").includes(SK));
}

console.log("── A6 自噬：跑回归网不得改动沙箱之外的任何文件 ──");
{
  // tests/dao-tool-nudge.tests.js 的 nudge() 原先不传 cwd ⇒ hook 落到 process.cwd() ⇒ 真仓。
  // 🔴 canary 必须落在**默认扫描面内**：放在面外的话，即便那个 bug 原封不动它也活得好好的
  //    ⇒ 本组会变成假阴性。下面 assertLive 就是钉这一格的。
  const canary = path.join(REPO, "_tmp", "dump", "acceptance-canary.json");
  assertLive("A6", "dump/acceptance-canary.json", bare());
  w(canary, bare());
  fs.rmSync(path.join(REPO, "_tmp", "tool-nudge", "tmp-redact-sweep.json"), { force: true });
  const r = cp.spawnSync(process.execPath, [path.join(REPO, "tests", "dao-tool-nudge.tests.js")],
    { cwd: REPO, encoding: "utf8" });
  check("跑 tests/dao-tool-nudge.tests.js 不得改动真 `_tmp/` 里的文件",
    rd(canary).includes(SK), "该套 exit=" + r.status + "（它自己是绿的，而盘被改了）");
  fs.rmSync(canary, { force: true });
}

console.log("── A7 自噬的**根**：payload 没有 cwd 时一律不改盘（2026-08-04 新增）──");
{
  // A6 盯的是「本仓那一套测试有没有带 cwd」，**它盯不住别的文件**。
  // 本批实测第三次复发就在 A6 射程之外：`tests/hard-gates.tests.js:64` 的 nudge() 同样不带 cwd，
  // 它在本 worktree 里真的吃掉了 `_tmp/dump/` 的一个 canary（台账留了痕，那是 B1 第一次实战）。
  // 那个文件归另一路官的在途 PR 管、本批碰不得 ⇒ 判据必须收口在 hook 自己身上：
  // **拿不到显式 cwd 就不扫**。这一条盯的就是那个收口点，与调用方是谁无关。
  const root = newRoot();
  assertLive("A7", "dump/nocwd.json", bare());
  const f = w(path.join(root, "_tmp", "dump", "nocwd.json"), bare());
  const r = cp.spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "node _tmp/x.mjs" } }), // 刻意不给 cwd
    cwd: root,                                                                                // 进程 cwd 指着靶子
    encoding: "utf8",
  });
  check("payload 无 cwd ⇒ 盘上原封不动（不拿 process.cwd() 兜底）", rd(f).includes(SK),
    "文件被改了 ⇒ 又退回 process.cwd() 了；exit=" + r.status);
  check("跳过这件事不是静默的（stderr 说得出为什么）",
    /没有 cwd|跳过/.test(String(r.stderr || "")), JSON.stringify(String(r.stderr || "").slice(0, 200)));
  check("hook 仍然 exit 0（永不阻断）", r.status === 0, "exit=" + r.status);

  // 对照组：**同一条命令、同一个靶子**，只多给一个 cwd ⇒ 必须改盘。
  // 少了这一条，上面那三条也可能只是因为「这个靶子本来就不会被改」而绿。
  const f2 = w(path.join(root, "_tmp", "dump", "withcwd.json"), bare());
  const r2 = cp.spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", cwd: root, tool_input: { command: "node _tmp/x.mjs" } }),
    encoding: "utf8",
  });
  check("对照组：只多给一个 cwd，同一靶子就被脱敏了（证明上面挡住它的确实是「没有 cwd」）",
    !rd(f2).includes(SK), "exit=" + r2.status + " stdout=" + String(r2.stdout || "").slice(0, 120));
}

fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " ===");
process.exit(fail ? 1 : 0);
