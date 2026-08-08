// dao-probe-gate 两态自证 · 端到端（喂 UserPromptSubmit 形态 JSON → 断言 stdout 与落盘）
//
// 跑法：node tests/probe-gate.tests.js   （全绿 exit 0，任一红 exit 1）
//
// 验的是哪一层：**探针签名判据的两侧 + 标记三态（无/好/坏）对应的三种处置 + 零干预面**。
// 它证明「探针×无标记 ⇒ block / 探针×有标记 ⇒ 放行且注入 / 非探针 ⇒ 一个字节都不输出 /
// 坏标记 ⇒ fail-open 放行」，**不证明**宿主真的会因为这份 JSON 而拦下那一轮 ——
// 那一格由 2026-08-08 前提批的真链路实测承担（证据 `_tmp/premise-184/upsubmit.log`），
// 不在单元测试射程内。
//
// ── 这个 hook 的特殊之处：它是本仓唯一会拦下用户消息的 hook ──────────────────
// 所以下面**负控组比正控组重**：正控错了只是多跑一轮探针（几句话额度），
// 负控错了是用户的消息被吞。两侧代价不对称 ⇒ 负控要密。
//
// ── 为什么不需要沙箱副本（mutation 那半除外）──────────────────────────────────
// 两处落盘面都有 env 覆写口（`DAO_RATE_LIMIT_MARKER` / `DAO_PROBE_GATE_STATE_SUBDIR`），
// 故端到端那半直接跑**真文件**。生产那份 fired.log 是验收判据③「从 hook 日志确认 block
// 发生过」的取证面，掺进合成样本会让那次取证失真。

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const REAL_HOOK = path.join(REPO, "ccswitch", "hooks", "dao-probe-gate.js");
const REAL_SENTINEL = path.join(REPO, "ccswitch", "hooks", "dao-rate-limit-sentinel.js");
const TAG = "probegate-" + process.pid + "-" + Math.random().toString(36).slice(2, 8);
const BASE = path.join(REPO, "_tmp", TAG);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  ->  " + detail : ""}`); }
}

fs.mkdirSync(BASE, { recursive: true });

function rootOf(hookPath) { return path.resolve(path.dirname(hookPath), "..", ".."); }
function markerPath(tag) { return path.join(BASE, tag, "rate-limit-interrupt.json"); }
function firedPath(tag, hookPath) { return path.join(rootOf(hookPath || REAL_HOOK), "_tmp", TAG, tag, "state", "fired.log"); }
function errorsPath(tag, hookPath) { return path.join(rootOf(hookPath || REAL_HOOK), "_tmp", TAG, tag, "state", "errors.log"); }

function envFor(tag) {
  return Object.assign({}, process.env, {
    DAO_RATE_LIMIT_MARKER: markerPath(tag),
    DAO_PROBE_GATE_STATE_SUBDIR: path.posix.join(TAG, tag, "state"),
  });
}
// 标记文件由**哨兵真的写一次**产生，而不是测试手捏一份 JSON ——
// 手捏的那份只证明「我编的形状我认得出」；让上游真跑一次，两个 hook 的字段契约才真的被夹住。
function armMarker(tag, over) {
  fs.mkdirSync(path.dirname(markerPath(tag)), { recursive: true });
  const payload = JSON.stringify(Object.assign({
    session_id: "sid-" + TAG,
    transcript_path: "C:/fake/transcript.jsonl",
    cwd: REPO,
    hook_event_name: "StopFailure",
    error: "rate_limit",
    error_details: "429 Too Many Requests",
    last_assistant_message: "API Error: Rate limit reached · 约 2 小时 30 分钟后重置",
  }, over || {}));
  const env = Object.assign({}, process.env, {
    DAO_RATE_LIMIT_MARKER: markerPath(tag),
    DAO_RATE_LIMIT_STATE_SUBDIR: path.posix.join(TAG, tag, "sentinel-state"),
  });
  spawnSync(process.execPath, [REAL_SENTINEL], { input: payload, encoding: "utf8", env });
  return markerPath(tag);
}

function run(hookPath, prompt, tag, rawInput) {
  const input = rawInput != null ? rawInput : JSON.stringify({
    session_id: "sid-" + TAG,
    transcript_path: "C:/fake/transcript.jsonl",
    cwd: REPO,
    hook_event_name: "UserPromptSubmit",
    prompt,
  });
  const r = spawnSync(process.execPath, [hookPath], { input, encoding: "utf8", env: envFor(tag) });
  let json = null;
  if (r.stdout && r.stdout.trim()) { try { json = JSON.parse(r.stdout); } catch (_) {} }
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", json };
}
function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || "";
}
function blocked(r) { return !!(r.json && r.json.decision === "block"); }
function firedLines(tag, hookPath) {
  try {
    return fs.readFileSync(firedPath(tag, hookPath), "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

console.log("\n=== 正态 · 探针 × 无标记 → block（无事时探针 0 轮，本机制的全部意义）===");
{
  const tag = "block";
  const r = run(REAL_HOOK, "[dao-probe] 查中断：有没有被限流打断的活？", tag);
  check("exit 0（block 走 JSON 通道，不走 exit 2 —— 后者会把 stdout 连同 JSON 一起丢掉）",
    r.code === 0, "code=" + r.code);
  check("decision=block", blocked(r), "out=" + r.out.slice(0, 200));
  check("reason 在场且带签名（block 消息是用户唯一看得见的东西，误伤时要认得出是谁干的）",
    r.json && typeof r.json.reason === "string" && /\[dao-probe-gate v1\]/.test(r.json.reason),
    "reason=" + (r.json && r.json.reason));
  // 🔴 这一条钉的是本批最值钱的一格实测结论：官方文档把 suppressOriginalPrompt 与
  //    decision/reason 列在同一张表里，照着写会放到顶层而**静默失效**（zod strip 不报错）。
  //    本机 claude.exe 取证：它住在 hookSpecificOutput 里。断言两层各在其位。
  check("suppressOriginalPrompt 在 hookSpecificOutput 里（不是顶层 —— 文档那张表会把人带偏）",
    r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.suppressOriginalPrompt === true &&
    r.json.suppressOriginalPrompt === undefined,
    "out=" + r.out.slice(0, 250));
  check("hookEventName = UserPromptSubmit",
    r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.hookEventName === "UserPromptSubmit");
  const f = firedLines(tag);
  check("fired.log 记一行 decision=block（验收判据③要从这份日志确认 block 真发生过）",
    f.length === 1 && f[0].decision === "block" && f[0].marker_state === "none", "fired=" + JSON.stringify(f));
}

console.log("\n=== 正态 · 探针 × 有标记 → 放行 + additionalContext 带标记全文 ===");
{
  const tag = "allow";
  armMarker(tag);
  const r = run(REAL_HOOK, "[dao-probe] 查中断", tag);
  check("不 block（有活要接，这一轮必须发生）", !blocked(r), "out=" + r.out.slice(0, 200));
  const c = ctx(r);
  check("additionalContext 在场且带签名", /\[dao-probe-gate v1\]/.test(c), "ctx=" + c.slice(0, 160));
  check("注入含标记全文的承重字段（at / error / reset_estimate_s）",
    /"at":/.test(c) && /"error": "rate_limit"/.test(c) && /"reset_estimate_s": 9000/.test(c),
    "ctx=" + c.slice(0, 400));
  check("注入含标记文件路径（探针轮要按它去删）", c.includes(markerPath(tag)), "ctx=" + c.slice(0, 300));
  check("注入提醒「接手前先删标记」（不删 ⇒ 下一轮重复接手同一件事）", /接手前先删/.test(c));
  check("hook 自己不删标记（删归探针轮，理由见 hook 头注的分工段）", fs.existsSync(markerPath(tag)));
  const f = firedLines(tag);
  check("fired.log 记 decision=allow / marker_state=ok",
    f.length === 1 && f[0].decision === "allow" && f[0].marker_state === "ok", "fired=" + JSON.stringify(f));
}

console.log("\n=== 负态 · 非探针 prompt：零输出、零磁盘、零留痕（这一条错了就是吞用户消息）===");
{
  const NEG = [
    ["普通中文消息", "帮我看看这个函数的实现"],
    ["普通英文消息", "please review this diff"],
    ["心跳签名（同仓另一个签名，绝不能串味）", "[dao-heartbeat] 高性能目标窗心跳。对账：① 三路在途"],
    ["大小写不符", "[DAO-PROBE] 查中断"],
    ["下划线/空格变体", "[dao probe] 查中断"],
    ["连字符变体", "[dao_probe] 查中断"],
    ["方括号不闭合", "[dao-probe 查中断"],
    ["签名不在开头", "顺带说一句 [dao-probe] 查中断"],
    ["散文里引用这个签名（讲机制的那种消息）", "闸门只认以 [dao-probe] 开头的 prompt，你记住"],
    ["前缀更长的相似签名", "[dao-probe-gate] 查中断"],
    ["空 prompt", ""],
    ["纯 slash 命令", "/dao-resume"],
    ["只有方括号", "[]"],
  ];
  for (const [name, prompt] of NEG) {
    const tag = "neg-" + Buffer.from(name).toString("hex").slice(0, 12);
    const r = run(REAL_HOOK, prompt, tag);
    check("负控：" + name + " → stdout 一个字节都没有", r.out === "", "out=" + JSON.stringify(r.out.slice(0, 160)));
    check("负控：" + name + " → exit 0", r.code === 0, "code=" + r.code);
    check("负控：" + name + " → 零磁盘（不给每条用户消息记账）",
      firedLines(tag).length === 0 && !fs.existsSync(errorsPath(tag)));
  }
}
{
  // 正控配对项：免得上面那批被读成「凡不完全一致都不认」——前导空白**要**认，
  // 与同仓 [dao-heartbeat] 的判据（trim 之后取前缀）逐字同一套写法。
  const tag = "leadws";
  const r = run(REAL_HOOK, "  \n[dao-probe] 查中断", tag);
  check("正控（配对项）：签名前有空白仍认（判据是 trim 之后的前缀）", blocked(r), "out=" + r.out.slice(0, 160));
}
{
  // 签名后紧跟内容 / 签名独占一行，两种真实形态都要认
  const tag = "tight";
  check("正控：签名后无空格紧跟内容 → 仍认", blocked(run(REAL_HOOK, "[dao-probe]查中断", tag)));
  check("正控：只有签名本身 → 仍认", blocked(run(REAL_HOOK, "[dao-probe]", tag + "2")));
}

console.log("\n=== fail-open · 三条失败路径全部倒向「放行」===");
{
  const tag = "badmarker";
  fs.mkdirSync(path.dirname(markerPath(tag)), { recursive: true });
  fs.writeFileSync(markerPath(tag), "{这不是合法 JSON", "utf8");
  const r = run(REAL_HOOK, "[dao-probe] 查中断", tag);
  check("坏标记 JSON → **不 block**（宁可多跑一轮，不可能因一个坏文件把探针链永久拦死）",
    !blocked(r), "out=" + r.out.slice(0, 200));
  check("坏标记 → 注入里说明白「这不构成刚被限流的证据」（否则探针轮会以为真有活要接）",
    /不构成/.test(ctx(r)), "ctx=" + ctx(r).slice(0, 240));
  check("坏标记 → 写 errors.log 留痕", fs.existsSync(errorsPath(tag)));
  const f = firedLines(tag);
  check("坏标记 → fired.log 记 marker_state=bad（与 none/ok 三态分得开）",
    f.length === 1 && f[0].marker_state === "bad", "fired=" + JSON.stringify(f));
}
{
  const tag = "marker-is-dir";
  // 标记路径被占成目录：readFileSync 抛的不是 ENOENT ⇒ 走 "bad" 那一支而不是 "none"
  fs.mkdirSync(markerPath(tag), { recursive: true });
  const r = run(REAL_HOOK, "[dao-probe] 查中断", tag);
  check("标记路径是目录（读不动而非不存在）→ 放行，不误判成「没标记」而 block",
    !blocked(r) && firedLines(tag)[0] && firedLines(tag)[0].marker_state === "bad",
    "out=" + r.out.slice(0, 160) + " fired=" + JSON.stringify(firedLines(tag)));
}
{
  const tag = "badstdin";
  const r = run(REAL_HOOK, null, tag, "这不是 JSON{{{");
  check("坏 stdin → exit 0 且零输出（读不出 prompt 就判不了，放行）",
    r.code === 0 && r.out === "", "code=" + r.code + " out=" + JSON.stringify(r.out.slice(0, 120)));
  check("坏 stdin → 写 errors.log（协议变了这种事不许静默）", fs.existsSync(errorsPath(tag)));
}
{
  const tag = "forceerr";
  const env = envFor(tag); env.DAO_PROBE_GATE_FORCE_ERROR = "1";
  const r = spawnSync(process.execPath, [REAL_HOOK], {
    input: JSON.stringify({ prompt: "[dao-probe] 查中断", session_id: "s", transcript_path: "C:/f/t.jsonl", cwd: REPO }),
    encoding: "utf8", env,
  });
  check("故障注入 → exit 0 且不 block（闸门坏了绝不能变成用户消息被吞）",
    r.status === 0 && !/\"decision\"\s*:\s*\"block\"/.test(r.stdout || ""),
    "code=" + r.status + " out=" + (r.stdout || "").slice(0, 160));
}

console.log("\n=== --selfcheck 不许崩（读真实 settings.json，故只断言形态不断言结论）===");
{
  const r = spawnSync(process.execPath, [REAL_HOOK, "--selfcheck"], { input: "", encoding: "utf8", env: envFor("selfcheck") });
  check("--selfcheck 退出码 ∈ {0,1}（不是崩溃码）", r.status === 0 || r.status === 1, "code=" + r.status);
  check("--selfcheck 打印带 hook 名的报头", /dao-probe-gate --selfcheck/.test(r.stdout || ""), "out=" + (r.stdout || "").slice(0, 160));
}

console.log("\n=== mutation · 四个方向（锚点单行、断言与 replace 同一个字符串）===");
{
  const SRC = fs.readFileSync(REAL_HOOK, "utf8");
  const SHA_BEFORE = crypto.createHash("sha256").update(SRC).digest("hex");

  function relRequiresOf(src) {
    return [...src.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)].map((m) => m[1]);
  }
  function mutantHook(tag, anchor, replacement) {
    check(`mutation 靶点在源码里唯一存在（${tag}）`, SRC.split(anchor).length === 2,
      `出现 ${SRC.split(anchor).length - 1} 次`);
    const root = path.join(BASE, "mut-" + tag);
    const hooksDir = path.join(root, "ccswitch", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const deps = relRequiresOf(SRC);
    check(`沙箱前提：${tag} 的相对依赖能逐个定位（加了新依赖会在这里当场变红）`,
      deps.length > 0 && deps.every((d) => fs.existsSync(path.resolve(path.dirname(REAL_HOOK), d))),
      "deps=" + JSON.stringify(deps));
    for (const d of deps) {
      const from = path.resolve(path.dirname(REAL_HOOK), d);
      const to = path.resolve(hooksDir, d);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    fs.writeFileSync(path.join(hooksDir, "dao-probe-gate.js"), SRC.replace(anchor, replacement), "utf8");
    return path.join(hooksDir, "dao-probe-gate.js");
  }

  // 方向①「放松」：前缀判据改恒真 ⇒ 普通用户消息开始被 block
  //   ⇒ 证明上面那一大组负控**真的在测判据**，不是永真。这是 spec e 段点名要的那一格。
  {
    const ANCHOR = "const PROBE_SIG = /^\\[dao-probe\\]/;";
    const h = mutantHook("loosen", ANCHOR, "const PROBE_SIG = /^/;");
    const before = run(REAL_HOOK, "帮我看看这个函数的实现", "mutL-a");
    const after = run(h, "帮我看看这个函数的实现", "mutL-b");
    check("放松方向：真文件对普通消息零输出，判据改恒真后 block ⇒ 负控组有判别力",
      before.out === "" && blocked(after),
      "before=" + JSON.stringify(before.out.slice(0, 60)) + " after=" + after.out.slice(0, 120));
    check("canary：变异体还活着（对真探针 prompt 仍照常 block，不是整个 hook 崩了）",
      blocked(run(h, "[dao-probe] 查中断", "mutL-canary")));
  }

  // 方向②「保留字面但使其不执行」：让早退恒成立 ⇒ 探针轮再也不会被 block
  //   刻意不用整段删除：删掉 code review 一眼看得见，「留着但永远早退」才骗得过人眼。
  {
    const ANCHOR = "  if (!PROBE_SIG.test(prompt.trim())) {";
    const h = mutantHook("disable", ANCHOR, "  if (true || !PROBE_SIG.test(prompt.trim())) {");
    const before = run(REAL_HOOK, "[dao-probe] 查中断", "mutD-a");
    const after = run(h, "[dao-probe] 查中断", "mutD-b");
    check("关掉方向：真文件 block，判据被架空后零输出 ⇒ 正控组有判别力",
      blocked(before) && after.out === "", "after=" + JSON.stringify(after.out.slice(0, 120)));
    check("canary：变异体还活着（进程照常 exit 0，不是崩了才没输出）", after.code === 0, "code=" + after.code);
  }

  // 方向③「保留调用与副作用，但结果不被消费」：标记照读（fired.log 照记 marker_state），
  //   只是判定恒为 allow ⇒ block 永远不发生。这一向骗得过「hook 跑了吗 / 日志有吗」这类断言。
  {
    const ANCHOR = 'const decision = marker.state === "none" ? "block" : "allow";';
    const h = mutantHook("unconsumed", ANCHOR, 'readMarker; const decision = "allow";');
    const after = run(h, "[dao-probe] 查中断", "mutU-a");
    check("结果不被消费方向：判定恒 allow ⇒ 不再 block ⇒ 正控组逮得住",
      !blocked(after), "after=" + after.out.slice(0, 160));
    check("canary：变异体还活着**且副作用仍在**（fired.log 照样记了一行、标记仍被读过）—— " +
      "正是这一向骗得过「跑没跑」类断言的证明",
      firedLines("mutU-a", h).length === 1 && firedLines("mutU-a", h)[0].marker_state === "none",
      "fired=" + JSON.stringify(firedLines("mutU-a", h)));
  }

  // 方向④「按官方文档那张表写」：把 suppressOriginalPrompt 挪到顶层 ⇒ 位置断言必须红。
  //   这一向守的是本批唯一一条**实测推翻文档**的结论；没有它，哪天有人「照文档修正一下」，
  //   宿主会静默 strip 掉那个键，而所有行为断言（block 仍然发生）照常全绿。
  {
    const ANCHOR = "    hookSpecificOutput: { hookEventName: EVENT, suppressOriginalPrompt: true },";
    const h = mutantHook("suppress-toplevel", ANCHOR,
      "    suppressOriginalPrompt: true,\n    hookSpecificOutput: { hookEventName: EVENT },");
    const after = run(h, "[dao-probe] 查中断", "mutS-a");
    check("文档形态方向：挪到顶层后位置断言翻面 ⇒ 那条断言不是摆设",
      blocked(after) &&
      after.json.suppressOriginalPrompt === true &&
      after.json.hookSpecificOutput.suppressOriginalPrompt === undefined,
      "after=" + after.out.slice(0, 220));
    check("canary：变异体还活着（block 本身照常发生 —— 说明这个错法只坏在「原文还会显示给用户」这一格，" +
      "行为断言全绿，只有位置断言逮得住）", blocked(after));
  }

  check("canary 恒等：真 hook 文件全程未被改动",
    crypto.createHash("sha256").update(fs.readFileSync(REAL_HOOK)).digest("hex") === SHA_BEFORE);
}

console.log("\n=== 跨文件一致性：闸门读的路径 = 哨兵写的路径 ===");
{
  // 端到端而不是只比源码文本：让哨兵真写一次、闸门真读一次，中间不经过任何测试手捏的 JSON。
  const tag = "e2e";
  const before = run(REAL_HOOK, "[dao-probe] 查中断", tag);
  check("哨兵没跑过 ⇒ 闸门 block", blocked(before));
  armMarker(tag);
  const after = run(REAL_HOOK, "[dao-probe] 查中断", tag);
  check("哨兵真跑一次写下标记 ⇒ 同一个闸门当场改判放行（两个 hook 认同一个路径与同一套字段）",
    !blocked(after) && /"error": "rate_limit"/.test(ctx(after)), "ctx=" + ctx(after).slice(0, 200));
  fs.rmSync(markerPath(tag), { force: true });
  const gone = run(REAL_HOOK, "[dao-probe] 查中断", tag);
  check("标记被删掉（模拟探针轮接手后的清理）⇒ 下一轮又回到 block",
    blocked(gone), "out=" + gone.out.slice(0, 160));
}

try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
