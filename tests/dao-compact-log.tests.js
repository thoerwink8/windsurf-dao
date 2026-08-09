// dao-compact-log 两态自证 · 单元级（喂 PostCompact 形态 JSON → 断言 stdout/日志）
//
// 跑法：node tests/dao-compact-log.tests.js   （全绿 exit 0，任一红 exit 1）
//
// 验的是哪一层：**hook 脚本自身的输入→输出契约**。它证明「命中即产出结构正确的
// systemMessage / 落盘一行日志 / 出错不静默」，**不证明** systemMessage 真的被
// 模型下一轮读到——那是 PostCompact 文档未逐字担保的能力，需真实 compaction 后
// 人工核对（见 dao-compact-log.js 头注③，本测试不为此打包票）。
//
// 用 spawnSync 直接喂 stdin，绕开 PowerShell 引号/编码坑。
// 全部用例带 DAO_COMPACT_LOG_SELFTEST=1，心跳标 synthetic，不污染 --selfcheck 的接线判定。
//
// ── 🔴 家目录隔离（issue #82 同族，普查时由复现脚本量出来的）───────────────────
// 本测试有一条承重断言是**增量**判据：「跑一次 hook ⇒ 日志正好多一行」。日志原先落在
// **真实的** `~/.claude/compaction-log.jsonl` —— 一个机器级共享文件 ⇒ 盘上任何另一个进程
// （另一棵 worktree 的同一个测试，或一次真实 compaction）同时追加一行，这条断言就红，
// 而红的是**无辜的那一方**。实测（`node scripts/repro-fixture-isolation.mjs
// -t tests/dao-compact-log.tests.js -c 6 -r 3`）：隔离前 18/18 = 100% 被染红，隔离后 0%。
// 它比 rule-echo 那两个夹具更狠：夹具互删要抢时序窗口，追加式增量断言**只要撞上就必红**。
//
// 修法是给每个进程一个自己的假家目录（hook 与本测试都用
// `USERPROFILE || HOME || os.homedir()` 定位，改 env 即可整条改道）。
// ⚠ **两半的分工照直写**：跨 worktree 那一半是 `REPO`（= `<本目录>/..`）给的 —— 每棵树各有
// 自己的 `_tmp/`；`UNIQ` 只多管**同一棵树里并行**那一半。实测坐实（mutation M5b：去掉 UNIQ
// 但保留假家目录 ⇒ 复现网 18/18 全绿，因为它给每个子进程的沙箱本来就各有各的 REPO）。
// 真正承重的是「有没有假家目录」这件事：mutation M5a 把它摘掉、落回真实家目录 ⇒ **串行就红**
// （被下面的隔离自证当场抓住，都不用等并行）。别把 M5b 的绿读成「UNIQ 没用」。
// **被验的契约一个字没变**：仍是「hook 往 <家目录>/.claude/compaction-log.jsonl 追加一行」。
// 顺带还掉一笔一直在付的账：此前每跑一次测试，就往用户真实的 compaction 日志里塞 5 行
// 合成记录（虽标了 `synthetic:true` 且 --selfcheck 会跳过，但那是「读的人记得过滤」，
// 不是「压根没写进去」）。
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const HOOK = path.resolve(__dirname, "..", "ccswitch", "hooks", "dao-compact-log.js");
const REPO = path.resolve(__dirname, "..");
// PID 防跨进程撞名，随机段防 PID 复用 —— 与 dao-rule-echo.tests.js 的 UNIQ 同一路数。
const UNIQ = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const FAKE_HOME = path.join(REPO, "_tmp", "compact-log-tests", UNIQ);
const LOG_PATH = path.join(FAKE_HOME, ".claude", "compaction-log.jsonl");
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
// 隔离自证要用的时间基点：只有「本次开跑之后」写的行才算泄漏（见文件末尾那一段）
const STARTED_AT = Date.now();

function run(payload, env) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const r = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    // USERPROFILE 与 HOME 两个都要改：hook 侧读的是 `USERPROFILE || HOME || homedir()`，
    // 只改一个会在另一个平台/另一种取值优先级下**静默落回真实家目录**（本仓已有先例：
    // dao-scaffold-check.tests.js 头注记着 settings-drift 的优先级正好相反）。
    env: Object.assign({}, process.env, {
      DAO_COMPACT_LOG_SELFTEST: "1",
      USERPROFILE: FAKE_HOME,
      HOME: FAKE_HOME,
    }, env || {}),
  });
  let json = null;
  if (r.stdout && r.stdout.trim()) { try { json = JSON.parse(r.stdout); } catch (_) {} }
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", json };
}

// 真实宿主 PostCompact 输入形态（字段沿用 PreCompact 已确认的通用字段 + trigger）
function pc(trigger, extra) {
  return Object.assign({
    session_id: "test-session-compact",
    transcript_path: "C:/fake/transcript.jsonl",
    cwd: "D:/frank/windsurf-dao",
    hook_event_name: "PostCompact",
    trigger,
  }, extra || {});
}

function lastLogLine() {
  if (!fs.existsSync(LOG_PATH)) return null;
  const lines = fs.readFileSync(LOG_PATH, "utf8").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1]); } catch (_) { return null; }
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}
function sysMsg(r) {
  return (r.json && r.json.systemMessage) || "";
}

console.log("\n=== 正态：manual/auto 两种 trigger 都要产出 systemMessage + 落盘一行 ===");
{
  const before = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, "utf8").split(/\r?\n/).filter(Boolean).length : 0;
  const r = run(pc("manual"));
  check("trigger=manual → 有 systemMessage", sysMsg(r).length > 0);
  check("trigger=manual → systemMessage 含 trigger 值", /trigger=manual/.test(sysMsg(r)), sysMsg(r));
  check("trigger=manual → exit 0", r.code === 0, "code=" + r.code);
  const after = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, "utf8").split(/\r?\n/).filter(Boolean).length : 0;
  check("trigger=manual → 落盘增加一行", after === before + 1, `before=${before} after=${after}`);
  const last = lastLogLine();
  check("trigger=manual → 日志行 trigger 字段正确", !!last && last.trigger === "manual");
  check("trigger=manual → 日志行标 synthetic=true（自测不冒充真实触发）", !!last && last.synthetic === true);
  check("trigger=manual → 日志行含 session_id", !!last && last.session_id === "test-session-compact");
}
{
  const r = run(pc("auto"));
  check("trigger=auto → 有 systemMessage", sysMsg(r).length > 0);
  check("trigger=auto → systemMessage 含 trigger 值", /trigger=auto/.test(sysMsg(r)), sysMsg(r));
  const last = lastLogLine();
  check("trigger=auto → 日志行 trigger 字段正确", !!last && last.trigger === "auto");
}
{
  // PostCompact 文档未逐字给出 trigger 字段名——source 兜底，防字段名猜错致数据丢失
  const r = run({ session_id: "s2", transcript_path: "x", cwd: "y", hook_event_name: "PostCompact", source: "auto" });
  check("兜底字段 source（无 trigger）→ 仍捕获 trigger=auto", /trigger=auto/.test(sysMsg(r)), sysMsg(r));
}
{
  // 缺 trigger 与 source → unknown，不报错、不吞
  const r = run({ session_id: "s3", transcript_path: "x", cwd: "y", hook_event_name: "PostCompact" });
  check("缺 trigger/source → 降级为 unknown 而非崩溃", /trigger=unknown/.test(sysMsg(r)), sysMsg(r));
  check("缺 trigger/source → 仍 exit 0", r.code === 0, "code=" + r.code);
}
{
  // hookSpecificOutput.additionalContext 未被文档证实对 PostCompact 生效——本 hook
  // 不应产出该字段，避免打一个未验证的包票。
  const r = run(pc("manual"));
  check("不产出 hookSpecificOutput（未验证能力不硬编）", !(r.json && r.json.hookSpecificOutput));
}

console.log("\n=== 错误可见性：出错必须留痕，且不取阻断语义 ===");
{
  const r = run("这不是 JSON{{{");
  check("坏 stdin → stderr 有痕", /\[dao-compact-log\].*失败/.test(r.err), "err=" + JSON.stringify(r.err));
  check("坏 stdin → systemMessage 用户可见", !!(r.json && r.json.systemMessage), "out=" + r.out.slice(0, 200));
  check("坏 stdin → 不阻断（exit 0）", r.code === 0, "code=" + r.code);
}
{
  const r = run(pc("manual"), { DAO_COMPACT_LOG_FORCE_ERROR: "1" });
  check("内部故障闸 → stderr 有痕", /\[dao-compact-log\].*失败/.test(r.err), "err=" + JSON.stringify(r.err));
  check("内部故障闸 → systemMessage 用户可见", !!(r.json && r.json.systemMessage));
  check("内部故障闸 → exit 0 不阻断", r.code === 0, "code=" + r.code);
  check("内部故障闸 → 未静默（stdout+stderr 至少一处有内容）", r.out !== "" || r.err !== "");
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== scaffold-check 死闸检测挂载点：陈旧判据四态 + 一个负态（机制体检②）===");
// 治的是什么病：dao-scaffold-check.js 的心跳落在 `_tmp/scaffold-check/fired.log`，
// 本 hook 每次 PostCompact 顺带查一眼它有没有停摆——读心跳判陈旧的人必须在**另一个事件**
// 上，否则循环依赖原样保留、只是换了个身位。本节验四个读态 + 一个「摘掉调用」的负态。
// 用 `DAO_SCAFFOLD_CHECK_STATE_SUBDIR` 把被读的 fired.log 改道到本测试自己的 UNIQ
// 子目录（与 FAKE_HOME 同一个隔离理由：不想读到/写到真实 `_tmp/scaffold-check/`）。
function writeScaffoldFired(subdir, records) {
  const dir = path.join(REPO, "_tmp", subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "fired.log"),
    records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""), "utf8");
}
{
  const subdir = path.posix.join("compact-log-tests", UNIQ, "sc-fresh");
  writeScaffoldFired(subdir, [{ at: new Date().toISOString(), synthetic: false, session_id: "real-fresh", mode: "A", result: "clean" }]);
  const r = run(pc("manual"), { DAO_SCAFFOLD_CHECK_STATE_SUBDIR: subdir });
  check("① 新鲜的真实心跳 → 不报陈旧（常路零噪音）", !/scaffold-check/.test(sysMsg(r)), "msg=" + sysMsg(r));
}
{
  const subdir = path.posix.join("compact-log-tests", UNIQ, "sc-stale");
  const old = new Date(Date.now() - 10 * 86400000).toISOString();
  writeScaffoldFired(subdir, [{ at: old, synthetic: false, session_id: "real-stale", mode: "A", result: "clean" }]);
  const r = run(pc("manual"), { DAO_SCAFFOLD_CHECK_STATE_SUBDIR: subdir });
  check("② 10 天前的真实心跳 → 报陈旧且带天数与阈值", /scaffold-check 已 10\.0 天没有真实触发（阈值 5 天）/.test(sysMsg(r)), "msg=" + sysMsg(r));
}
{
  const subdir = path.posix.join("compact-log-tests", UNIQ, "sc-onlysynthetic");
  writeScaffoldFired(subdir, [{ at: new Date().toISOString(), synthetic: true, session_id: "self-test", mode: "A", result: "clean" }]);
  const r = run(pc("manual"), { DAO_SCAFFOLD_CHECK_STATE_SUBDIR: subdir });
  check("③ 只有 synthetic 记录（无真实心跳）→ 报「从未留下真实心跳记录」", /从未留下真实心跳记录/.test(sysMsg(r)), "msg=" + sysMsg(r));
}
{
  const subdir = path.posix.join("compact-log-tests", UNIQ, "sc-missing");
  // 连目录都不建：fired.log 压根不存在，readJsonlRecords 对不存在的文件返回 []，
  // 与「过滤掉全部 synthetic 后为空」在这里得到同一处置——两者对消费方而言是同一句话。
  const r = run(pc("manual"), { DAO_SCAFFOLD_CHECK_STATE_SUBDIR: subdir });
  check("④ fired.log 压根不存在 → 同样报「从未留下真实心跳记录」（不是「读取失败」）",
    /从未留下真实心跳记录/.test(sysMsg(r)), "msg=" + sysMsg(r));
}
{
  const subdir = path.posix.join("compact-log-tests", UNIQ, "sc-dirblocked");
  const dir = path.join(REPO, "_tmp", subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "fired.log"), { recursive: true }); // 占成目录 → readFileSync 抛 EISDIR
  const r = run(pc("manual"), { DAO_SCAFFOLD_CHECK_STATE_SUBDIR: subdir });
  check("⑤ fired.log 读不动（被占成目录）→ 报读取失败，不误判成「没事」也不误判成「陈旧」",
    /心跳日志读取失败/.test(sysMsg(r)) && !/从未留下真实心跳记录/.test(sysMsg(r)) && !/已 .+ 天没有真实触发/.test(sysMsg(r)),
    "msg=" + sysMsg(r));
}
{
  const subdir = path.posix.join("compact-log-tests", UNIQ, "sc-badat");
  writeScaffoldFired(subdir, [{ at: "不是时间", synthetic: false, session_id: "real-badat", mode: "A", result: "clean" }]);
  const r = run(pc("manual"), { DAO_SCAFFOLD_CHECK_STATE_SUBDIR: subdir });
  check("⑥ 末次心跳的 at 解析不出来 → 只报异常，不替未知下陈旧结论",
    /at 解析不出来/.test(sysMsg(r)) && !/已 .+ 天没有真实触发/.test(sysMsg(r)), "msg=" + sysMsg(r));
}
{
  // 负控：末尾是新的 synthetic 记录时，判据仍要取「最后一条真实记录」，不能被新的合成
  // 记录掩盖成「有新鲜心跳」（那会让一个真的停摆的 scaffold-check 被自测流量假装还活着）。
  const subdir = path.posix.join("compact-log-tests", UNIQ, "sc-mixed");
  writeScaffoldFired(subdir, [
    { at: new Date(Date.now() - 10 * 86400000).toISOString(), synthetic: false, session_id: "old-real", mode: "A", result: "clean" },
    { at: new Date().toISOString(), synthetic: true, session_id: "fresh-synthetic", mode: "A", result: "clean" },
  ]);
  const r = run(pc("manual"), { DAO_SCAFFOLD_CHECK_STATE_SUBDIR: subdir });
  check("负控：末尾新鲜的 synthetic 记录不掩盖旧的真实记录 → 仍报陈旧",
    /scaffold-check 已 10\.0 天没有真实触发/.test(sysMsg(r)), "msg=" + sysMsg(r));
}

// ── 先破再验：scaffoldCheckStalenessNote() 的调用点被摘掉 ⇒ 陈旧永远不出声 ──────
// 单行锚点（行尾差异咬不到它），只摘掉「读取结果」这一步、保留 try/catch 结构本身——
// 同 dao-guard-writing.md「改坏多形态」②（保留字面但使其不执行）那一向。
console.log("\n=== 先破再验：scaffoldCheckStalenessNote() 调用被摘掉 ⇒ 陈旧数据摆在那也不会被报出 ===");
{
  const SRC = fs.readFileSync(HOOK, "utf8");
  const ANCHOR = "    staleNote = scaffoldCheckStalenessNote();";
  check("mutation 靶点在源码里唯一存在（scaffoldCheckStalenessNote 调用点）",
    SRC.split(ANCHOR).length === 2, "出现 " + (SRC.split(ANCHOR).length - 1) + " 次");

  const mutRoot = path.join(FAKE_HOME, "mut-tree");
  const hooksDir = path.join(mutRoot, "ccswitch", "hooks");
  const libDir = path.join(mutRoot, "ccswitch", "lib");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  // 本 hook 唯一的本地依赖是 hook-selfcheck.js（copy 过去即可独立跑，
  // 与 probe-gate.tests.js 的 mutantHook 同一手法）。
  fs.copyFileSync(path.join(REPO, "ccswitch", "lib", "hook-selfcheck.js"), path.join(libDir, "hook-selfcheck.js"));
  const hookCopy = path.join(hooksDir, "dao-compact-log.js");
  fs.writeFileSync(hookCopy, SRC.replace(ANCHOR, "    staleNote = null;"), "utf8");

  const subdir = path.posix.join("compact-log-tests", UNIQ, "sc-mut-stale");
  const old = new Date(Date.now() - 10 * 86400000).toISOString();
  writeScaffoldFired(subdir, [{ at: old, synthetic: false, session_id: "real-stale-mut", mode: "A", result: "clean" }]);

  const rMut = spawnSync(process.execPath, [hookCopy], {
    input: JSON.stringify(pc("manual")),
    encoding: "utf8",
    env: Object.assign({}, process.env, {
      DAO_COMPACT_LOG_SELFTEST: "1", USERPROFILE: FAKE_HOME, HOME: FAKE_HOME,
      DAO_SCAFFOLD_CHECK_STATE_SUBDIR: subdir,
    }),
  });
  let mutJson = null;
  if (rMut.stdout && rMut.stdout.trim()) { try { mutJson = JSON.parse(rMut.stdout); } catch (_) {} }
  const mutMsg = (mutJson && mutJson.systemMessage) || "";
  check("🔴 先破再验：调用被摘掉 ⇒ 陈旧记录（数据摆在那）再也不会被报出",
    !/scaffold-check 已/.test(mutMsg), "msg=" + mutMsg);
  check("canary：变异体还活着（主产物不受影响——落盘日志/systemMessage 依旧正常产出，只是少了这一句）",
    !!mutJson && /快照已刷新/.test(mutMsg), "msg=" + mutMsg.slice(0, 200));
}

// ── 隔离自证：改道真的生效了，且用户真实日志一行都没多 ────────────────────────
// 「对照组必须验证它自己真的被关掉了」——env 改道一旦失效（换平台、hook 改了取值优先级、
// 某次 spawn 漏传 env），症状是**测试照常全绿**、只是又开始写用户的真日志。
// 那种失效必须当场变红，否则它会一直静默地跑下去。
console.log("\n=== 隔离自证：日志落在假家目录，真实日志零新增 ===");
{
  check("日志确实落在沙箱家目录内", fs.existsSync(LOG_PATH), LOG_PATH);
  const realHome = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const realLog = path.join(realHome, ".claude", "compaction-log.jsonl");
  check("沙箱日志路径 ≠ 用户真实日志路径", path.resolve(LOG_PATH) !== path.resolve(realLog));
  // 判据挑得很窄，刻意不用「总行数没变」：真实 compaction 可能在测试期间发生，那是无关的
  // 合法新增，用总行数会造出假红。只数「本测试的签名 + 本次开跑之后」这两条同时成立的行。
  let leaked = 0;
  try {
    for (const line of fs.readFileSync(realLog, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.session_id === "test-session-compact" && Date.parse(rec.at) >= STARTED_AT) leaked++;
      } catch (_) { /* 真实日志里的坏行不归本测试管 */ }
    }
  } catch (_) { /* 真实日志不存在 ⇒ 天然零泄漏 */ }
  check("用户真实 compaction 日志零新增（本测试签名的行）", leaked === 0, `leaked=${leaked} → ${realLog}`);
}

try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (_) {}
// 空父目录一并收走；别人还在跑时目录非空，rmdir 失败正是想要的
try { fs.rmdirSync(path.dirname(FAKE_HOME)); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
