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
// issue #232：镜像留痕域的期望落点。`envFor(tag)` 只传 `DAO_RATE_LIMIT_MARKER` /
// `DAO_PROBE_GATE_STATE_SUBDIR`、不传 `DAO_PROBE_GATE_MIRROR` —— 命中的是
// `deriveMirrorFallback()` 的第一分支（`DAO_RATE_LIMIT_MARKER` 优先），算法与 hook 源码
// 逐字同一套：`path.join(path.dirname(<marker>), "probe-gate-mirror-fallback", "errors.log")`。
function mirrorErrorsPath(tag) { return path.join(path.dirname(markerPath(tag)), "probe-gate-mirror-fallback", "errors.log"); }

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
    // 🔴 哨兵自 2026-08-08（#190 第 2 条）起还有一条**出 `_tmp` 域**的镜像通道，生产落点在
    // `~/.claude/dao-state/…`。这里必须一起指进沙箱 —— 那份是「真实限流实战样本」的耐久数据，
    // 掺进合成记录就污染了将来那次复盘（与上面两个覆写口同一个理由，别只指两个）。
    DAO_RATE_LIMIT_MIRROR: path.join(BASE, tag, "sentinel-mirror", "fired.log"),
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

// ── mutation 沙箱（**提到模块级**，issue #190）────────────────────────────────
// 原先它住在文件末尾那个 mutation 块里，于是新增的几节各自要么再抄一份、要么就没有
// 先破再验那一半。**同型的东西只留一个出口**（同 hard-gates.tests.js 收口喂 nudge 的教训）。
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
    // issue #247 H3：零磁盘的扫描面此前只查主域（`errorsPath`），镜像域
    // （`mirrorErrorsPath`，issue #232 新增的第二条留痕通道）零覆盖——非探针路径
    // 若偷写镜像域，这 13 条负控里没有一条会红。这里把扫描面扩到镜像域。
    check("负控：" + name + " → 零磁盘（不给每条用户消息记账，含镜像域，issue #247 H3）",
      firedLines(tag).length === 0 && !fs.existsSync(errorsPath(tag)) && !fs.existsSync(mirrorErrorsPath(tag)));
  }

  // ── 先破再验：非探针路径偷写镜像域 ⇒ 上面新增的镜像域负控必须翻面 ──────────────
  // 归因对照（issue #247 H3 原始实测）：非探针路径偷写**主域** → 13 条旧负控全红；
  // 偷写**镜像域** → 0 红（因为旧负控只查 `errorsPath`）。这里补一个精确打在
  // 「只写镜像、不碰主域」这个此前真空缺上的 mutation，证明新加的那半镜像域检查
  // 真的在盯着它，而不是碰巧跟着主域检查一起绿。
  {
    const ANCHOR = "    // 这条路径覆盖**每一条用户消息**，所以它必须什么都不做。往这里加任何一次写盘，";
    const h = mutantHook("h3-nonprobe-mirror-leak", ANCHOR,
      ANCHOR + '\n    mirrorErrorLog("issue #247 H3 mutation：非探针路径偷写镜像域");');
    const tag = "h3-neg-mut";
    const r = run(h, "帮我看看这个函数的实现", tag);
    check("canary：变异体还活着（非探针仍 exit 0、stdout 仍零字节 —— 偷写的只是磁盘这一半，不是整条判定）",
      r.code === 0 && r.out === "", "code=" + r.code + " out=" + JSON.stringify(r.out.slice(0, 80)));
    check("🔴 先破再验：非探针路径偷写镜像域 ⇒ 新加的「零磁盘（含镜像域）」这一格翻面（此前 0 红）",
      fs.existsSync(mirrorErrorsPath(tag)), "expect written=" + mirrorErrorsPath(tag));
    check("对照：主域（旧检查早就覆盖的那一半）仍是零 —— 证明这次 mutation 精准打在「只偷写镜像」这个真空缺上，" +
      "不是靠误伤主域才被抓住",
      !fs.existsSync(errorsPath(tag)), "不该存在=" + errorsPath(tag));
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
  // issue #232：主域 errors.log 之外，同一条留痕现在还有出 `_tmp` 域的镜像（call site #2）。
  check("issue #232：坏标记 → 镜像域也写了一份 errors.log（call site #2 走了 logError）",
    fs.existsSync(mirrorErrorsPath(tag)), "expect=" + mirrorErrorsPath(tag));
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
  // ── #201-③（用户 2026-08-09 拍板：放行并报异常）─────────────────────────────
  // 标记的**父路径**被占成普通文件（正是对抗官弄坏仓根 `_tmp` 的那个形态）时：
  //   本机实测（win32 / node v24.13.1）`readFileSync("<普通文件>/child")` 抛的是 **ENOENT**
  //   —— 不是 ENOTDIR。此前 `readMarker()` 直接走 `"none"` 那一支 ⇒ **闸门照常 block**——
  //   这就是对抗官那句「四条通道全哑、闸门照常拦探针」里**后半句**的机制来源：
  //   不是判据写错，是「父目录坏了」在 errno 上与「标记还没写过」不可区分。
  // 用户拍板后的处置：ENOENT/ENOTDIR 命中时额外探一次父目录本身（`isHealthyDir`）——
  // 父目录不健康 ⇒ 判 `"infra-broken"`，**放行**并在 `additionalContext` 里注入一行
  // 异常说明、指明修法，不许把用户拦在一个坏掉的基础设施前。
  const tag = "marker-parent-is-file";
  const blocker = path.join(BASE, tag, "occupied");
  fs.mkdirSync(path.dirname(blocker), { recursive: true });
  fs.writeFileSync(blocker, "我是普通文件，不是目录", "utf8");
  const env = Object.assign({}, envFor(tag), {
    DAO_RATE_LIMIT_MARKER: path.join(blocker, "rate-limit-interrupt.json"),
  });
  const rp = spawnSync(process.execPath, [REAL_HOOK], {
    input: JSON.stringify({ prompt: "[dao-probe] 查中断", session_id: "sid-" + TAG, transcript_path: "C:/fake/t.jsonl", cwd: REPO }),
    encoding: "utf8", env,
  });
  let j = null; try { j = JSON.parse(rp.stdout || "{}"); } catch (_) {}
  check("现状·#201-③：标记父路径被占成普通文件 ⇒ **不 block**（基础设施坏了，不是没有中断）",
    rp.status === 0 && !(j && j.decision === "block"),
    "code=" + rp.status + " out=" + String(rp.stdout || "").slice(0, 200));
  const ctxBroken = (j && j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) || "";
  check("现状·#201-③：additionalContext 说明「不是没有中断，是基础设施坏了」并指明修法",
    /基础设施坏了/.test(ctxBroken) && /修法/.test(ctxBroken), "ctx=" + ctxBroken.slice(0, 300));
  check("现状·#201-③：fired.log 记 marker_state=infra-broken（与 none/ok/bad 三态分得开）",
    firedLines(tag)[0] && firedLines(tag)[0].marker_state === "infra-broken",
    "fired=" + JSON.stringify(firedLines(tag)));
  check("现状·#201-③：写 errors.log 留痕（基础设施坏这种事不许静默）", fs.existsSync(errorsPath(tag)));
  // ⚠ issue #232 的镜像通道**不**在本节额外断言：这里 `DAO_RATE_LIMIT_MARKER` 被指向
  // `blocker`（一个文件）下的一个子路径，而 `deriveMirrorFallback()` 分支①把镜像也放在
  // `path.dirname(<marker>)` 也就是 `blocker` 底下——两者共享同一个被弄坏的祖先，镜像在
  // *这个具体合成场景*里同样写不进去，这不代表镜像修复无效，只说明分支①（本来就只是
  // 测试期的沙箱路由，不是生产会走的分支）在「marker 目录自己就是那个坏节点」这种双重嵌套下
  // 没有意义。call site #2（infra-broken 分支）真正有代表性的镜像覆盖见下面新增的
  // 「issue #232 · 沙箱仓根 _tmp 整体换成文件」一节（零 env 覆写，真正的生产形态）。
  check("已知前提：这条路径的 errno 是 ENOENT/ENOTDIR 之一（换平台/换 node 版本这一格可能翻面，" +
    "判据靠父目录探测兜底、不靠 errno 本身分流，故翻面不影响上面几条断言）",
    (() => { try { fs.readFileSync(path.join(blocker, "x"), "utf8"); return false; }
      catch (e) { return e.code === "ENOENT" || e.code === "ENOTDIR"; } })(),
    "实测 errno 与本节前提不符 ⇒ 上面那条断言的解释已过期，重读它");

  // ── 先破再验：父目录健康探测被架空 ⇒ 上面那条「不 block」必须翻面（health 探测摘掉能红）──
  // 形态是「保留字面但使其不执行」：让 `isHealthyDir` 那道判断恒不成立，父目录再坏也
  // 判不出来 ⇒ ENOENT/ENOTDIR 又退回旧行为——判 "none" ⇒ block。这就是「加固前会怎样」
  // 的对照组，也正是本节要证明的：这次修法真的改了行为，不是加了一句没人读的注释。
  const ANCHOR = "      if (!isHealthyDir(dir)) {";
  const h = mutantHook("infra-check-disabled", ANCHOR, "      if (false) {");
  const tagM = "marker-parent-is-file-mut";
  const blockerM = path.join(BASE, tagM, "occupied");
  fs.mkdirSync(path.dirname(blockerM), { recursive: true });
  fs.writeFileSync(blockerM, "我是普通文件，不是目录", "utf8");
  const envM = Object.assign({}, envFor(tagM), {
    DAO_RATE_LIMIT_MARKER: path.join(blockerM, "rate-limit-interrupt.json"),
  });
  const rm = spawnSync(process.execPath, [h], {
    input: JSON.stringify({ prompt: "[dao-probe] 查中断", session_id: "sid-" + TAG, transcript_path: "C:/fake/t.jsonl", cwd: REPO }),
    encoding: "utf8", env: envM,
  });
  let jm = null; try { jm = JSON.parse(rm.stdout || "{}"); } catch (_) {}
  check("🔴 先破再验：父目录健康探测被架空 ⇒ 同一场景退回旧行为、仍然 block（上面「不 block」断言不是摆设）",
    rm.status === 0 && jm && jm.decision === "block",
    "code=" + rm.status + " out=" + String(rm.stdout || "").slice(0, 200));
  check("canary：变异体还活着（正常场景——无标记且父目录健康——仍照常 block，不是整个 hook 崩了）",
    blocked(run(h, "[dao-probe] 查中断", "infra-mut-canary")));
}

console.log("\n=== issue #232 · 沙箱仓根 _tmp 整体换成文件（零 env 覆写 = 生产形态，PR #227 B5 场景）===");
{
  // 与上面「marker-parent-is-file」不同：那一节只坏了**标记的父目录**（一个受 env 覆写口指向
  // 的子路径），本节要坏的是**仓根 `_tmp` 本身**——这样 `MARKER_PATH` 与 `S.stateDir` 的默认值
  // （都挂在 `<ROOT>/_tmp` 下）同时遭殃，且**不**靠 `DAO_RATE_LIMIT_MARKER` /
  // `DAO_PROBE_GATE_STATE_SUBDIR` 这两个 env 覆写口去指哪里——这才是 PR #227 对抗验证 B5
  // 原话「零 env 覆写 = 生产形态」的忠实模拟。借 `mutantHook()`（锚点与替换给同一段文本 = 只
  // 借它「拷贝相对依赖到一棵独立 ROOT」那半，不做真变异）拿一棵独立仓根，把它的 `_tmp` 换成
  // 普通文件，复现的就是 issue #232 的根因现场。
  const NOOP = 'const SIGNATURE = "[dao-probe-gate v1]";';
  const h = mutantHook("b5-repro", NOOP, NOOP);
  const sandboxRoot = path.resolve(path.dirname(h), "..", "..");
  fs.writeFileSync(path.join(sandboxRoot, "_tmp"), "我是文件不是目录", "utf8");

  // 沙箱 HOME：**不**覆写 DAO_RATE_LIMIT_MARKER / DAO_PROBE_GATE_STATE_SUBDIR /
  // DAO_PROBE_GATE_MIRROR 中任何一个——这才是「零 env 覆写」；镜像域改落进沙箱而不是真机
  // HOME，靠的是覆写 USERPROFILE/HOME（与本文件「--selfcheck covers」那节的 scWith() 同一技法）。
  const sandboxHome = path.join(BASE, "b5-home");
  fs.mkdirSync(sandboxHome, { recursive: true });
  const env = Object.assign({}, process.env, { USERPROFILE: sandboxHome, HOME: sandboxHome });
  delete env.DAO_RATE_LIMIT_MARKER;
  delete env.DAO_PROBE_GATE_STATE_SUBDIR;
  delete env.DAO_PROBE_GATE_MIRROR;

  const r = spawnSync(process.execPath, [h], {
    input: JSON.stringify({ prompt: "[dao-probe] 查中断", session_id: "sid-b5", transcript_path: "C:/fake/t.jsonl", cwd: sandboxRoot }),
    encoding: "utf8", env,
  });
  let j = null; try { j = JSON.parse(r.stdout || "{}"); } catch (_) {}

  check("B5：不 block（基础设施坏了，不是没有中断——与 #201-③ 同一判定）",
    r.status === 0 && !(j && j.decision === "block"),
    "code=" + r.status + " out=" + String(r.stdout || "").slice(0, 200));
  const c = (j && j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) || "";
  check("B5：additionalContext 异常注入照常发生（这一半此前就是好的，本次没有改它）",
    /基础设施坏了/.test(c), "ctx=" + c.slice(0, 200));

  const primaryErrLog = path.join(sandboxRoot, "_tmp", "probe-gate", "errors.log");
  check("B5：主域 errors.log 确实写不出来（复现 issue #232 的根因——留痕域与坏掉的 _tmp 同一棵树）",
    !fs.existsSync(primaryErrLog), "primary=" + primaryErrLog);

  const mirrorErrLog = path.join(sandboxHome, ".claude", "dao-state", "probe-gate", "errors.log");
  check("🔴 B5：镜像域（出 _tmp）写得出 errors.log —— 这是本次修的那一格（issue #232 解冻条件）",
    fs.existsSync(mirrorErrLog), "expect=" + mirrorErrLog);
  const mirrorText = fs.existsSync(mirrorErrLog) ? fs.readFileSync(mirrorErrLog, "utf8") : "";
  check("B5：镜像内容带得上下文（标记父目录不可用），不是空文件",
    /标记父目录不可用/.test(mirrorText), "text=" + mirrorText.slice(0, 200));

  // ── 先破再验：把 logError 里镜像那一半架空 ⇒ 上面「镜像域写得出」翻面 ──────────────
  // 三处调用点共用同一个 logError()，故只需变异这一处就同时钉住全部三个 call site
  // 是不是都真的走了它（不是各自另开了一条没接线的路）。
  const h2 = mutantHook("b5-mirror-disabled", "  mirrorErrorLog(msg);", "  /* mirrorErrorLog(msg); */");
  const sandboxRootMut = path.resolve(path.dirname(h2), "..", "..");
  fs.writeFileSync(path.join(sandboxRootMut, "_tmp"), "我是文件不是目录", "utf8");
  const sandboxHomeMut = path.join(BASE, "b5-home-mut");
  fs.mkdirSync(sandboxHomeMut, { recursive: true });
  const envMut = Object.assign({}, process.env, { USERPROFILE: sandboxHomeMut, HOME: sandboxHomeMut });
  delete envMut.DAO_RATE_LIMIT_MARKER; delete envMut.DAO_PROBE_GATE_STATE_SUBDIR; delete envMut.DAO_PROBE_GATE_MIRROR;
  const rMut = spawnSync(process.execPath, [h2], {
    input: JSON.stringify({ prompt: "[dao-probe] 查中断", session_id: "sid-b5m", transcript_path: "C:/fake/t.jsonl", cwd: sandboxRootMut }),
    encoding: "utf8", env: envMut,
  });
  const mirrorErrLogMut = path.join(sandboxHomeMut, ".claude", "dao-state", "probe-gate", "errors.log");
  check("🔴 先破再验：镜像调用被架空 ⇒ 「镜像域写得出」翻面（B5 场景重新回到修前「两条通道都哑」的旧行为）",
    !fs.existsSync(mirrorErrLogMut), "mut=" + mirrorErrLogMut);
  check("canary：变异体还活着（放行判定不受影响，只是镜像调用那一行被摘）",
    rMut.status === 0, "code=" + rMut.status);
}

console.log("\n=== issue #232 · 镜像域结构性沙箱兜底（只指 DAO_PROBE_GATE_STATE_SUBDIR，不指 MARKER/MIRROR）===");
{
  // 同 dao-rate-limit-sentinel.js #201 笔2 的判据：只要**任一个**落盘覆写口被显式指了，
  // 调用方就已经在把落盘面往沙箱里赶，镜像即便漏传覆写口也该跟着落沙箱，不滑回真机 HOME。
  // 本仓其余全部测试走的都是 `envFor()`（两个覆写口都传 ⇒ deriveMirrorFallback 分支①）——
  // 分支②（只指 STATE_SUBDIR）此前零覆盖，这里补上。
  // ⚠ **两次子进程都额外沙箱 USERPROFILE/HOME**（哪怕正态那次预期走分支②不会碰到分支③）：
  // 下面「先破再验」把分支②架空后会真的落到分支③（真机 HOME 判据），不沙箱 HOME 的话那次
  // mutation 调用会实打实往真机 `~/.claude/dao-state/…` 写一行——用假 HOME 而不是断言
  // 「真机文件不存在」，是因为后者对「本来就有」与「这次写的」分不开，前者才是干净的隔离。
  const tag = "structural-subdir-only";
  const stateSubdir = path.posix.join(TAG, tag, "state");
  const sandboxHomeS = path.join(BASE, "structural-home");
  fs.mkdirSync(sandboxHomeS, { recursive: true });
  const env = Object.assign({}, process.env, {
    DAO_PROBE_GATE_STATE_SUBDIR: stateSubdir, USERPROFILE: sandboxHomeS, HOME: sandboxHomeS,
  });
  delete env.DAO_RATE_LIMIT_MARKER;
  delete env.DAO_PROBE_GATE_MIRROR;
  const r = spawnSync(process.execPath, [REAL_HOOK], { input: "这不是 JSON{{{", encoding: "utf8", env });
  check("前提：坏 stdin → exit 0（走的是 call site #1，触发 logError）", r.status === 0, "code=" + r.status);
  const expectMirror = path.join(REPO, "_tmp", stateSubdir, "mirror-fallback", "errors.log");
  check("结构性兜底·分支②：只指 STATE_SUBDIR ⇒ 镜像落在 <ROOT>/_tmp/<STATE_SUBDIR>/mirror-fallback/errors.log（不是真机/沙箱 HOME）",
    fs.existsSync(expectMirror), "expect=" + expectMirror);
  const sandboxHomeMirrorS = path.join(sandboxHomeS, ".claude", "dao-state", "probe-gate", "errors.log");
  check("结构性兜底·分支②：沙箱 HOME 那份（分支③的落点）没有被写——分支②真的截住了，没有两边都写",
    !fs.existsSync(sandboxHomeMirrorS), "不该存在=" + sandboxHomeMirrorS);

  // 先破再验：架空分支②，退回分支③（这里退到的是**沙箱** HOME，不是真机 HOME）。
  const ANCHOR = "  if (process.env.DAO_PROBE_GATE_STATE_SUBDIR) {";
  const h = mutantHook("structural-subdir-disabled", ANCHOR, "  if (false) {");
  const tagM = "structural-subdir-only-mut";
  const stateSubdirM = path.posix.join(TAG, tagM, "state");
  const sandboxHomeM = path.join(BASE, "structural-home-mut");
  fs.mkdirSync(sandboxHomeM, { recursive: true });
  const envM = Object.assign({}, process.env, {
    DAO_PROBE_GATE_STATE_SUBDIR: stateSubdirM, USERPROFILE: sandboxHomeM, HOME: sandboxHomeM,
  });
  delete envM.DAO_RATE_LIMIT_MARKER; delete envM.DAO_PROBE_GATE_MIRROR;
  const rm = spawnSync(process.execPath, [h], { input: "这不是 JSON{{{", encoding: "utf8", env: envM });
  const expectMirrorM = path.join(rootOf(h), "_tmp", stateSubdirM, "mirror-fallback", "errors.log");
  const fellBackToHomeM = path.join(sandboxHomeM, ".claude", "dao-state", "probe-gate", "errors.log");
  check("canary：变异体还活着（坏 stdin 仍 exit 0，只是分支②被摘）", rm.status === 0, "code=" + rm.status);
  check("🔴 先破再验：分支②被架空 ⇒ 镜像不再落沙箱子目录（本组断言不是摆设）",
    !fs.existsSync(expectMirrorM), "mut=" + expectMirrorM);
  check("🔴 先破再验的副产物：确实退回了分支③（沙箱 HOME 那份镜像反而出现了）——证明「架空」" +
    "改的是判据走向，不是让镜像整体消失",
    fs.existsSync(fellBackToHomeM), "expect=" + fellBackToHomeM);
}

console.log("\n=== issue #247 H1 · DAO_PROBE_GATE_MIRROR 显式覆写口 —— 真传覆写口的正控（PR #241 对抗遗留）===");
{
  // 对照哨兵 tests/rate-limit-sentinel.tests.js:52（envFor() 真传 DAO_RATE_LIMIT_MIRROR，
  // 随后 mirrorLines(tag) 断言内容真的落在那个覆写路径）——本文件此前所有场景都只测过
  // deriveMirrorFallback() 的分支②③（结构性沙箱兜底），`process.env.DAO_PROBE_GATE_MIRROR ||`
  // 这半的**左手边**（显式覆写口本身）零覆盖：mutation 实测摘掉它，189/189 全绿。
  const tag = "h1-explicit-mirror";
  const explicitMirror = path.join(BASE, tag, "explicit-mirror-dir", "errors.log");
  // 分支①（只指 MARKER、不指 MIRROR 时）会落到的路径——用来证明「没有落到这里」，
  // 即覆写口真的赢过了兜底算法，不是巧合重合。
  const derivedFallback = mirrorErrorsPath(tag);
  const env = Object.assign({}, envFor(tag), { DAO_PROBE_GATE_MIRROR: explicitMirror });
  const r = spawnSync(process.execPath, [REAL_HOOK], {
    input: "这不是 JSON{{{", // 走 call site #1（stdin 解析失败），最短路径触发 logError
    encoding: "utf8", env,
  });
  check("H1 前提：坏 stdin → exit 0（走的是会调用 logError 的那条路）", r.status === 0, "code=" + r.status);
  check("H1 正控：真传 DAO_PROBE_GATE_MIRROR ⇒ 镜像 errors.log 落在覆写指定的那个路径",
    fs.existsSync(explicitMirror), "expect=" + explicitMirror);
  check("H1 正控：没有落到 deriveMirrorFallback() 算出的分支①路径（覆写口真的赢过了兜底算法）",
    !fs.existsSync(derivedFallback), "不该存在=" + derivedFallback);
  const content = fs.existsSync(explicitMirror) ? fs.readFileSync(explicitMirror, "utf8") : "";
  check("H1 正控：覆写路径里的内容确实是这次的错误留痕，不是空文件",
    /dao-probe-gate/.test(content) && content.trim().length > 0, "text=" + content.slice(0, 200));

  // ── 先破再验：摘掉 `||` 左手边（显式覆写口）⇒ 上面「落在覆写路径」必须翻面 ─────────
  const ANCHOR = "const MIRROR_LOG = process.env.DAO_PROBE_GATE_MIRROR || deriveMirrorFallback();";
  const h = mutantHook("h1-mirror-override-disabled", ANCHOR, "const MIRROR_LOG = deriveMirrorFallback();");
  const tagM = "h1-explicit-mirror-mut";
  const explicitMirrorM = path.join(BASE, tagM, "explicit-mirror-dir", "errors.log");
  const derivedFallbackM = mirrorErrorsPath(tagM);
  const envM = Object.assign({}, envFor(tagM), { DAO_PROBE_GATE_MIRROR: explicitMirrorM });
  const rm = spawnSync(process.execPath, [h], { input: "这不是 JSON{{{", encoding: "utf8", env: envM });
  check("canary：变异体还活着（坏 stdin 仍 exit 0，只是覆写口被摘）", rm.status === 0, "code=" + rm.status);
  check("🔴 先破再验：`||` 左手边被摘掉 ⇒ 覆写路径落空，写去的是兜底算法算出的那个路径（本组正控不是摆设）",
    !fs.existsSync(explicitMirrorM) && fs.existsSync(derivedFallbackM),
    "覆写路径存在=" + fs.existsSync(explicitMirrorM) + "（" + explicitMirrorM + "）" +
    " 兜底路径存在=" + fs.existsSync(derivedFallbackM) + "（" + derivedFallbackM + "）");
}

console.log("\n=== 具名负控 · 父目录不存在/是空目录 ⇒ 仍判 none ⇒ block（PR #227 对抗官挂账）===");
{
  // PR #227 对抗验证官 mutation P4（catch{return true} → return false）打出 16 条隐式红，
  // 但**全套里没有任何一条具名断言**写着「父目录不存在 ⇒ 仍判 none ⇒ block」——16 条红全靠
  // 各 tag 的父目录在 readMarker() 跑的那一刻恰好还没被建出来这个巧合撑住（脚手架建 state
  // 目录在 heartbeat()，晚于 readMarker）。哪天有人预建了每个 tag 的目录，这层保护会静默
  // 消失，而没有任何东西会红。这里补两条具名断言，对应对抗官边界直测 B1/B3 的形状。
  const tag = "negctrl-parent-absent";
  // 刻意不 mkdir 任何一层：BASE/<tag>/ 本身都不存在（对应 B1：从未限流过的正常态）。
  const r = run(REAL_HOOK, "[dao-probe] 查中断", tag);
  check("具名负控 B1：父目录压根不存在 ⇒ state=none ⇒ block（不是 infra-broken）",
    blocked(r) && firedLines(tag)[0] && firedLines(tag)[0].marker_state === "none",
    "out=" + r.out.slice(0, 160) + " fired=" + JSON.stringify(firedLines(tag)));
}
{
  const tag = "negctrl-parent-empty-dir";
  // 只建父目录本身、不写标记文件（对应 B3：父目录是真目录、无标记的正常态）。
  fs.mkdirSync(path.dirname(markerPath(tag)), { recursive: true });
  const r = run(REAL_HOOK, "[dao-probe] 查中断", tag);
  check("具名负控 B3：父目录存在但没有标记文件 ⇒ state=none ⇒ block",
    blocked(r) && firedLines(tag)[0] && firedLines(tag)[0].marker_state === "none",
    "out=" + r.out.slice(0, 160) + " fired=" + JSON.stringify(firedLines(tag)));
}

console.log("\n=== 单元层 · readMarker 的 ENOTDIR 半边（F4，PR #227 对抗官挂账）===");
{
  // win32 端到端造不出 ENOTDIR（上面 #201-③ 那节的前提断言已实测坐实：本机这条路径的
  // errno 恒为 ENOENT）。`|| e.code === "ENOTDIR"` 这半支因此是**真空锚**：对抗官 mutation P7
  // 把它摘掉 ⇒ 160/0 全绿、零检出，POSIX 那半没有任何东西在守。readMarker 是导出的（见文件
  // 末尾 module.exports），单元层直接 require 它、假造一个 `{code:"ENOTDIR"}` 的 error 就能
  // 覆盖——不需要真的在 win32 上造出这个 errno。
  const hookModule = require(REAL_HOOK);
  const realReadFileSync = fs.readFileSync;
  const realStatSync = fs.statSync;
  const fakeErr = (code) => { const e = new Error("fake " + code); e.code = code; return e; };
  try {
    fs.readFileSync = function (p, enc) {
      if (p === hookModule.MARKER_PATH) throw fakeErr("ENOTDIR");
      return realReadFileSync.apply(fs, arguments);
    };

    fs.statSync = () => ({ isDirectory: () => true }); // 父目录健康
    const r1 = hookModule.readMarker();
    check("单元·ENOTDIR + 父目录健康 ⇒ state=none（与 ENOENT 分支同一处置，只换了 errno）",
      r1.state === "none", "got=" + JSON.stringify(r1));

    fs.statSync = () => ({ isDirectory: () => false }); // 父目录不健康（存在但不是目录）
    const r2 = hookModule.readMarker();
    check("单元·ENOTDIR + 父目录不健康 ⇒ state=infra-broken（P7 把这半摘掉后会退化成 none）",
      r2.state === "infra-broken", "got=" + JSON.stringify(r2));
  } finally {
    fs.readFileSync = realReadFileSync;
    fs.statSync = realStatSync;
  }
  check("桩已复原：readFileSync/statSync 回到真实实现（不许把测试专用的缝留在共享的 fs 模块上）",
    fs.readFileSync === realReadFileSync && fs.statSync === realStatSync);
}
{
  const tag = "badstdin";
  const r = run(REAL_HOOK, null, tag, "这不是 JSON{{{");
  check("坏 stdin → exit 0 且零输出（读不出 prompt 就判不了，放行）",
    r.code === 0 && r.out === "", "code=" + r.code + " out=" + JSON.stringify(r.out.slice(0, 120)));
  check("坏 stdin → 写 errors.log（协议变了这种事不许静默）", fs.existsSync(errorsPath(tag)));
  check("issue #232：坏 stdin → 镜像域也写了一份 errors.log（call site #1，stdin 解析失败路径）",
    fs.existsSync(mirrorErrorsPath(tag)), "expect=" + mirrorErrorsPath(tag));
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

console.log("\n=== 🔴 最外层 catch 不再是真空锚（#190 第 3 条，双官独立证实）===");
{
  // 头注自称「本 hook 最要紧的一行」：它保证「闸门崩了」永不变成「用户消息被吞」。
  // 而 #190 第 3 条实测：把它改成 fail-closed 后**全套测试零红** —— 因为注入点全在
  // `main()` 内层 try 里，异常压根走不到外层。现在有了 `outer` 相位，这条路第一次被跑到。
  //
  // 两条路各验一次，**非探针那一条才是真正承重的**：它覆盖每一条用户消息。
  const CASES = [
    ["非探针（每条用户消息都走这条路）", "帮我看看这个函数的实现", "outer-user"],
    ["探针 prompt", "[dao-probe] 查中断", "outer-probe"],
  ];
  function outerRun(prompt, tag, script, phase) {
    const env = envFor(tag); env.DAO_PROBE_GATE_FORCE_ERROR = phase || "outer";
    return spawnSync(process.execPath, [script || REAL_HOOK], {
      input: JSON.stringify({ prompt, session_id: "sid-" + TAG, transcript_path: "C:/fake/transcript.jsonl", cwd: REPO }),
      encoding: "utf8", env,
    });
  }
  for (const [label, prompt, tag] of CASES) {
    const r = outerRun(prompt, tag);
    check(`外层注入（${label}）→ exit 0（宿主按「hook 没意见」放行）`, r.status === 0, "code=" + r.status);
    check(`外层注入（${label}）→ stdout 不含 block（这一条就是「不许吞用户消息」）`,
      !/"decision"\s*:\s*"block"/.test(r.stdout || ""), "out=" + String(r.stdout || "").slice(0, 160));
    check(`外层注入（${label}）→ stdout 一个字节都没有（连半帧 JSON 都不许留下）`,
      (r.stdout || "") === "", "out=" + JSON.stringify(String(r.stdout || "").slice(0, 160)));
    check(`外层注入（${label}）→ 走的确实是最外层那条路（stderr 说未捕获异常）`,
      /未捕获异常/.test(r.stderr || ""), "err=" + String(r.stderr || "").slice(0, 160));
    check(`外层注入（${label}）→ 写 errors.log 留痕（协议变了这种事不许静默）`,
      fs.existsSync(errorsPath(tag)));
    check(`issue #232：外层注入（${label}）→ 镜像域也写了一份 errors.log（call site #3，最外层 catch）`,
      fs.existsSync(mirrorErrorsPath(tag)), "expect=" + mirrorErrorsPath(tag));
  }

  // 误伤反例：相位名对不上就不该注入（否则「相位」这机制等于「设了就抛」）
  const rMis = outerRun("[dao-probe] 查中断", "outer-mismatch", null, "no-such-phase");
  check("误伤反例：相位名不匹配 → 一切照常（无标记 ⇒ 照常 block）",
    rMis.status === 0 && /"decision"\s*:\s*"block"/.test(rMis.stdout || ""),
    "code=" + rMis.status + " out=" + String(rMis.stdout || "").slice(0, 160));
  // 历史路径：`=1` 仍撞在 parse 相位（上面「故障注入」那一节验的就是它，这里只钉「两者分得开」）
  const rOne = outerRun("[dao-probe] 查中断", "outer-one", null, "1");
  check("历史路径不变：`=1` 撞 parse 相位 ⇒ stderr 不是「未捕获异常」（两个相位分得开）",
    rOne.status === 0 && !/未捕获异常/.test(rOne.stderr || ""),
    "err=" + String(rOne.stderr || "").slice(0, 160));

  // ── 先破再验 ×2（两条断言各打一次，证明它们覆盖面不同）────────────────────────
  const ANCHOR = '      const msg = `[dao-probe-gate] 未捕获异常：${e && e.message}`;';
  {
    const h = mutantHook("outer-exit2", ANCHOR, ANCHOR + " process.exit(2);");
    const r = outerRun("帮我看看这个函数的实现", "outer-mut-exit2", h);
    check("🔴 先破再验①：外层 catch 改成 exit 2 ⇒ 「exit 0」那条断言翻面（宿主会当场吞掉这条用户消息）",
      r.status === 2, "code=" + r.status);
  }
  {
    const h = mutantHook("outer-emitblock", ANCHOR,
      ANCHOR + ' try { process.stdout.write(JSON.stringify({ decision: "block", reason: msg })); } catch (_) {}');
    const r = outerRun("帮我看看这个函数的实现", "outer-mut-block", h);
    check("🔴 先破再验②：外层 catch 改成 emit block ⇒ 「stdout 不含 block」那条断言翻面",
      /"decision"\s*:\s*"block"/.test(r.stdout || ""), "out=" + String(r.stdout || "").slice(0, 200));
    check("先破再验②的副产物：退出码仍是 0 ⇒ **只靠退出码断言逮不住这一形态**（两条断言各管一半）",
      r.status === 0, "code=" + r.status);
  }
}

console.log("\n=== 标记陈旧判据（#190 第 4 条最后一格）：单元 + 端到端 + 两向 mutation ===");
{
  // 加固前标记文件**没有任何时效概念**：三个月前的中断标记与三分钟前的完全等价，
  // 探针轮会被放行去「接手」一件早就自己好了的事，而它看不出区别。
  const { markerStaleness, STALE_GRACE_S } = require(REAL_HOOK);
  const NOW = Date.UTC(2026, 7, 8, 6, 0, 0);   // 固定基准，免得随时钟漂
  const at = (offsetS) => new Date(NOW + offsetS * 1000).toISOString();

  check("余量是个正数（0 或负数会让每一份标记都被判陈旧 —— 那比没有这个判据更糟）",
    Number.isFinite(STALE_GRACE_S) && STALE_GRACE_S > 0, "STALE_GRACE_S=" + STALE_GRACE_S);
  // ⚠ **刻意不钉具体数字**：当前 24 小时原为 AI 自定初值，用户 2026-08-09 issue #70 已追认为基线
  //   （追认的是数值本身，不是「该不该钉断言」——是否就此补一条钉死具体值的断言仍是判断档，
  //   本次未随追认一并改动，见交付未尽处）。钉死这个数会让用户重新调参那一刻变成假红，
  //   而那次调参恰恰是我们希望发生的事。

  const U = [
    ["刚写下的标记（reset 1h）→ 不陈旧", { at: at(0), reset_estimate_s: 3600 }, false],
    ["超界 60 秒 → 陈旧", { at: at(-(3600 + STALE_GRACE_S + 60)), reset_estimate_s: 3600 }, true],
    ["恰在界上（overdue = 0）→ 不陈旧（判据是 > 0，不是 >= 0）",
      { at: at(-(3600 + STALE_GRACE_S)), reset_estimate_s: 3600 }, false],
    ["界外 1 秒 → 陈旧（上下界都夹住，不只验一侧）",
      { at: at(-(3600 + STALE_GRACE_S + 1)), reset_estimate_s: 3600 }, true],
    ["reset 为 null → 按 0 计，距 at 超过余量即陈旧", { at: at(-(STALE_GRACE_S + 10)), reset_estimate_s: null }, true],
    ["reset 为 null 且未超余量 → 不陈旧", { at: at(-(STALE_GRACE_S - 10)), reset_estimate_s: null }, false],
    ["reset 是个非数字（脏数据）→ 按 0 计，不炸", { at: at(-(STALE_GRACE_S + 10)), reset_estimate_s: "三小时" }, true],
    ["at 在未来（时钟偏移）→ 不陈旧", { at: at(86400), reset_estimate_s: null }, false],
  ];
  for (const [name, doc, want] of U) {
    const r = markerStaleness(doc, NOW);
    check("单元：" + name, r.stale === want, "得 " + JSON.stringify(r));
  }
  // `at` 读不出来 ⇒ **不判陈旧**，而不是判成陈旧：「读不出时间」与「时间已经过去」是两件事，
  // 把前者归进后者就是替未知下结论（同 `[#守-退役触发]` 的「计数未知不等于已复发」）。
  for (const bad of [{}, { at: "不是时间" }, { at: null }, null]) {
    const r = markerStaleness(bad, NOW);
    check("单元·负控：at 读不出来（" + JSON.stringify(bad) + "）→ 不判陈旧且给出理由",
      r.stale === false && typeof r.why === "string", "得 " + JSON.stringify(r));
  }

  // ── 端到端：陈旧的标记仍然**放行**（这一条是本格最要紧的） ────────────────────
  const tag = "stale";
  armMarker(tag);
  const fresh = run(REAL_HOOK, "[dao-probe] 查中断", tag);
  check("端到端·负控：刚写下的标记 → 放行且**不**提陈旧", !blocked(fresh) && !/已经陈旧/.test(ctx(fresh)),
    "ctx=" + ctx(fresh).slice(0, 200));
  check("端到端·负控：fired.log 记 marker_stale=false（查过了、不陈旧）",
    firedLines(tag)[0] && firedLines(tag)[0].marker_stale === false,
    "fired=" + JSON.stringify(firedLines(tag)));

  const tag2 = "stale-old";
  armMarker(tag2);
  {
    // 把标记的 at 挪到很久以前（改盘上那份，模拟「一个月前限流过、没人接手」）
    const doc = JSON.parse(fs.readFileSync(markerPath(tag2), "utf8"));
    doc.at = new Date(Date.now() - (30 * 86400 * 1000)).toISOString();
    fs.writeFileSync(markerPath(tag2), JSON.stringify(doc, null, 2), "utf8");
  }
  const old = run(REAL_HOOK, "[dao-probe] 查中断", tag2);
  check("🔴 端到端：陈旧标记**仍然放行**（陈旧只改分类不改判定 —— 往 fail-closed 挪就是 #190 整张单在警告的方向）",
    !blocked(old), "out=" + old.out.slice(0, 200));
  check("端到端：注入里明说它陈旧了、并说清「仍然放行」", /已经陈旧/.test(ctx(old)) && /仍然放行/.test(ctx(old)),
    "ctx=" + ctx(old).slice(-400));
  check("端到端：fired.log 记 marker_stale=true 且带 overdue 秒数（观测数据要能事后算账）",
    firedLines(tag2)[0] && firedLines(tag2)[0].marker_stale === true &&
    firedLines(tag2)[0].marker_overdue_s > 0, "fired=" + JSON.stringify(firedLines(tag2)));

  // 三态分得开：none / bad 一律记 null 而**不是 false** —— false 会被读成「查过了、不陈旧」
  const tagNone = "stale-none";
  run(REAL_HOOK, "[dao-probe] 查中断", tagNone);
  check("三态：无标记 → marker_stale=null（不是 false；「没得查」与「查过了不陈旧」分得开）",
    firedLines(tagNone)[0] && firedLines(tagNone)[0].marker_stale === null,
    "fired=" + JSON.stringify(firedLines(tagNone)));
  const tagBad = "stale-bad";
  fs.mkdirSync(path.dirname(markerPath(tagBad)), { recursive: true });
  fs.writeFileSync(markerPath(tagBad), "{坏 JSON", "utf8");
  run(REAL_HOOK, "[dao-probe] 查中断", tagBad);
  check("三态：坏标记 → marker_stale=null（读不出内容就没得判）",
    firedLines(tagBad)[0] && firedLines(tagBad)[0].marker_stale === null,
    "fired=" + JSON.stringify(firedLines(tagBad)));

  // ── 先破再验 ×2，**两个相反方向**（单向 mutation 验不到负控组）──────────────────
  {
    const ANCHOR = '  const stale = marker.state === "ok" ? markerStaleness(marker.doc, nowMs) : null;';
    const h = mutantHook("stale-always-null", ANCHOR, "  const stale = null;");
    const t = "stale-mut-null";
    armMarker(t);
    { const doc = JSON.parse(fs.readFileSync(markerPath(t), "utf8"));
      doc.at = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
      fs.writeFileSync(markerPath(t), JSON.stringify(doc, null, 2), "utf8"); }
    const r = run(h, "[dao-probe] 查中断", t);
    check("🔴 先破再验①（放宽向）：陈旧判定恒 null ⇒ 陈旧那两条断言翻面",
      !/已经陈旧/.test(ctx(r)) && firedLines(t, h)[0] && firedLines(t, h)[0].marker_stale === null,
      "ctx=" + ctx(r).slice(0, 200) + " fired=" + JSON.stringify(firedLines(t, h)));
    check("canary：变异体还活着（照常放行、照常注入标记全文）",
      !blocked(r) && /"error": "rate_limit"/.test(ctx(r)), "ctx=" + ctx(r).slice(0, 200));
  }
  {
    const ANCHOR = "  return { stale: overdue > 0, overdue_s: overdue, why: null };";
    const h = mutantHook("stale-always-true", ANCHOR, "  return { stale: true, overdue_s: overdue, why: null };");
    const t = "stale-mut-true";
    armMarker(t);
    const r = run(h, "[dao-probe] 查中断", t);
    check("🔴 先破再验②（收紧向）：陈旧判定恒真 ⇒ 刚写下的标记也被标陈旧 ⇒ 负控组翻面",
      /已经陈旧/.test(ctx(r)) && firedLines(t, h)[0] && firedLines(t, h)[0].marker_stale === true,
      "ctx=" + ctx(r).slice(-300) + " fired=" + JSON.stringify(firedLines(t, h)));
    check("canary：变异体还活着**且仍然放行**（证明「陈旧」这一路从头到尾都不影响判定）",
      !blocked(r), "out=" + r.out.slice(0, 200));
  }
}

console.log("\n=== 负控 · 宿主失效态两格（#190 第 4 条：模块加载期崩 / stdout 写不动）===");
{
  // ㈠ **模块加载期崩**：`require` 就失败 ⇒ 连 `main()` 都没进，最外层 catch 也兜不到
  //    （它住在 `require.main === module` 那个块里，而那个块根本没执行到）。
  //    这一格问的是**宿主怎么处置**：非 0 非 2 = non-blocking error ⇒ 动作照常放行
  //    （`[#守-宿主失效态]` ㈠㈡）。判据因此是「**不是 2**」而不是「是 1」——
  //    押死具体数字会在 node 改退出码那天误红，而承重的不变量只有「别伪装成 block」。
  const crashDir = path.join(BASE, "loadcrash", "ccswitch", "hooks");
  fs.mkdirSync(crashDir, { recursive: true });
  const crashHook = path.join(crashDir, "dao-probe-gate.js");
  fs.copyFileSync(REAL_HOOK, crashHook);      // 刻意**不**拷 ../lib/hook-selfcheck.js
  const rc = spawnSync(process.execPath, [crashHook], {
    input: JSON.stringify({ prompt: "帮我看看这个函数的实现", session_id: "s", transcript_path: "C:/f/t.jsonl", cwd: REPO }),
    encoding: "utf8", env: envFor("loadcrash"),
  });
  check("模块加载期崩 → 退出码非 0（宿主 transcript 会打一行 non-blocking error，不静默）",
    rc.status !== 0, "code=" + rc.status);
  check("🔴 模块加载期崩 → 退出码**不是 2**（2 才 block；那才是「用户消息被吞」）",
    rc.status !== 2, "code=" + rc.status);
  check("模块加载期崩 → stdout 零输出（没有半帧 JSON 去毒害宿主解析）",
    (rc.stdout || "") === "", "out=" + JSON.stringify(String(rc.stdout || "").slice(0, 120)));
  check("前提：它崩的原因确实是加载期（stderr 里是 MODULE_NOT_FOUND，不是别的）",
    /Cannot find module|MODULE_NOT_FOUND/.test(rc.stderr || ""), "err=" + String(rc.stderr || "").slice(0, 200));

  // ㈡ **stdout 写不动（EPIPE 形态）**：用 `node -r <桩>` 在真 hook 之前把 `process.stdout.write`
  //    换成必抛 EPIPE 的实现 —— **被测文件一个字节没改**，只是它的 stdout 成了敌对环境。
  //    ⚠ 照直写这是**替身不是真 EPIPE**：真 EPIPE 要读端提前关闭的管道，Windows 上不可靠复现。
  //    它验的是「写 stdout 抛异常时本 hook 仍 exit 0」这条不变量 —— 而对这个 hook，
  //    **写不出去的后果恰好是放行**，也就是倒向安全的那一侧。
  const stub = path.join(BASE, "epipe-stub.js");
  fs.writeFileSync(stub,
    'process.stdout.write = function () { const e = new Error("write EPIPE"); e.code = "EPIPE"; throw e; };\n',
    "utf8");
  const tag = "epipe";
  const re = spawnSync(process.execPath, ["-r", stub, REAL_HOOK], {
    input: JSON.stringify({ prompt: "[dao-probe] 查中断", session_id: "sid-" + TAG, transcript_path: "C:/fake/t.jsonl", cwd: REPO }),
    encoding: "utf8", env: envFor(tag),
  });
  check("stdout 写不动 → 仍 exit 0（emit 的 write 被 try 包着，不许把它变成崩溃）",
    re.status === 0, "code=" + re.status + " err=" + String(re.stderr || "").slice(0, 200));
  check("stdout 写不动 → 宿主收不到 block ⇒ 那一轮照跑（fail-open 方向正确）",
    !/"decision"\s*:\s*"block"/.test(re.stdout || ""), "out=" + String(re.stdout || "").slice(0, 160));
  check("stdout 写不动 → fired.log 仍记 decision=block（**它判了 block 但没送出去**，账要留下）",
    firedLines(tag)[0] && firedLines(tag)[0].decision === "block",
    "fired=" + JSON.stringify(firedLines(tag)));
}

console.log("\n=== --selfcheck 第③段（留痕域可写性）+ covers 判定（喂合成 settings）===");
{
  // 两格加固前都是零守护：③ 压根不存在；covers 写成恒真也没有一条断言会红，
  // 而它答的是「探针轮到底走不走得到本 hook」—— 判错就是整个机制静默失效。
  const okR = spawnSync(process.execPath, [REAL_HOOK, "--selfcheck"],
    { input: "", encoding: "utf8", env: envFor("sc-writable") });
  const okOut = String(okR.stdout || "");
  check("③ 正态：主域可写 ⇒ 打一条 ✓", /✓ 留痕域可写：主域/.test(okOut), okOut.slice(-400));
  check("issue #232：③ 正态：镜像域也各自分开报一条 ✓（两个域各查一次，不是共享一条结论）",
    /✓ 留痕域可写：镜像域/.test(okOut), okOut.slice(-400));

  // ── issue #247 H2：上面两条只匹配标签串，谓词改核真实路径两域各异 ─────────────
  // 此前的谓词只查「✓ 留痕域可写：镜像域」这串标签文字出没出现——`dao-probe-gate.js:372`
  // 若把镜像域探测目标改指主域（`dir: path.dirname(MIRROR_LOG)` → `dir: S.stateDir`），
  // 标签串一字不变、仍会打出两条 ✓，旧谓词照样绿、0 红。这里改成核对 `--selfcheck`
  // 报出的**真实目录路径**：两个域必须指向不同的目录，且各自等于按同一套算法独立算出的期望值。
  const mainDirLine = okOut.match(/✓ 留痕域可写：主域[^\n]*→ ([^\n]+)/);
  const mirrorDirLine = okOut.match(/✓ 留痕域可写：镜像域[^\n]*→ ([^\n]+)/);
  const wantMainDir = path.dirname(firedPath("sc-writable"));
  const wantMirrorDir = path.dirname(mirrorErrorsPath("sc-writable"));
  check("H2：主域探测报出的真实路径 = 按同一套算法独立算出的 stateDir",
    mainDirLine && path.resolve(mainDirLine[1].trim()) === path.resolve(wantMainDir),
    "got=" + (mainDirLine && mainDirLine[1]) + " want=" + wantMainDir);
  check("H2：镜像域探测报出的真实路径 = 按同一套算法独立算出的镜像目录，且与主域不同" +
    "（不是同一个目录被查两次、只是标签文本不同）",
    mirrorDirLine && path.resolve(mirrorDirLine[1].trim()) === path.resolve(wantMirrorDir) &&
    mainDirLine && mainDirLine[1].trim() !== mirrorDirLine[1].trim(),
    "got=" + (mirrorDirLine && mirrorDirLine[1]) + " want=" + wantMirrorDir);

  // ── 先破再验：dao-probe-gate.js:372 把镜像域探测目标改指主域 ──────────────────
  {
    const ANCHOR = '      { label: "镜像域（出 _tmp，本机 dao 状态）", dir: path.dirname(MIRROR_LOG),';
    const h = mutantHook("h2-mirror-probe-points-primary", ANCHOR,
      '      { label: "镜像域（出 _tmp，本机 dao 状态）", dir: S.stateDir,');
    const tagM = "sc-h2-mut";
    const rM = spawnSync(process.execPath, [h, "--selfcheck"], { input: "", encoding: "utf8", env: envFor(tagM) });
    const outM = String(rM.stdout || "");
    check("canary：变异体还活着（自检照跑、报头照打、两条 ✓ 都还在——旧谓词只认标签文字，在这个变异体上仍会全绿）",
      /dao-probe-gate --selfcheck/.test(outM) && /✓ 留痕域可写：主域/.test(outM) &&
      /✓ 留痕域可写：镜像域/.test(outM), outM.slice(0, 400));
    const mainDirLineM = outM.match(/✓ 留痕域可写：主域[^\n]*→ ([^\n]+)/);
    const mirrorDirLineM = outM.match(/✓ 留痕域可写：镜像域[^\n]*→ ([^\n]+)/);
    check("🔴 先破再验：镜像域探测目标被改指主域 ⇒ 两条路径变成同一个——新谓词（核真实路径两域各异）" +
      "在这里翻面，证明它真的在核路径，不是只核标签文字",
      mainDirLineM && mirrorDirLineM && mainDirLineM[1].trim() === mirrorDirLineM[1].trim(),
      "主域=" + (mainDirLineM && mainDirLineM[1]) + " 镜像域=" + (mirrorDirLineM && mirrorDirLineM[1]));
  }

  const blocker = path.join(BASE, "sc-broken");
  fs.writeFileSync(blocker, "普通文件", "utf8");
  const badEnv = Object.assign({}, envFor("sc-broken-tag"), {
    DAO_PROBE_GATE_STATE_SUBDIR: path.posix.join(TAG, "sc-broken", "state"),
  });
  const badR = spawnSync(process.execPath, [REAL_HOOK, "--selfcheck"], { input: "", encoding: "utf8", env: badEnv });
  const badOut = String(badR.stdout || "");
  check("③ 负态：写不进去 ⇒ 打 ✗", /✗ 留痕域写不进去/.test(badOut), badOut.slice(-400));
  check("🔴 ③ 负态：✗ 那行必须明说它会污染第②段（否则「无记录」会被读成「没触发过」）",
    /可能只是写不进去，不是没触发过/.test(badOut), badOut.slice(-400));
  check("③ 负态：selfcheck 退出码 1（有 bad 就不许当过）", badR.status === 1, "code=" + badR.status);

  // covers：给子进程一个沙箱 HOME，于是库里的 LIVE_SETTINGS 指向我们现造的那份
  // —— **不给被测文件加任何测试专用的缝**。
  function scWith(tag, settingsObj, script) {
    const home = path.join(BASE, "home-" + tag);
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    if (settingsObj !== null) {
      fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(settingsObj, null, 2), "utf8");
    }
    const env = Object.assign({}, envFor("sc-" + tag), { USERPROFILE: home, HOME: home });
    const r = spawnSync(process.execPath, [script || REAL_HOOK, "--selfcheck"], { input: "", encoding: "utf8", env });
    return String(r.stdout || "");
  }
  const reg = (matcher, name) => ({
    hooks: {
      UserPromptSubmit: [{
        matcher,
        hooks: [{ type: "command", command: 'node "D:/x/ccswitch/hooks/' + (name || "dao-probe-gate.js") + '"' }],
      }],
    },
  });
  check("covers 正控：matcher 为空 ⇒ ✓ 已注册（空 = 全部 prompt，本事件本仓既有注册都这样）",
    /✓ 已注册于 UserPromptSubmit/.test(scWith("covered", reg(""))));
  const un = scWith("uncovered", reg("Bash"));
  check("🔴 covers 负控：写了 matcher ⇒ ✗ 已注册（有 prompt 走不到本 hook，探针轮可能正在那一批里）",
    /✗ 已注册于 UserPromptSubmit/.test(un), un.slice(0, 400));
  check("covers 负控：✗ 那行说得出后果", /探针轮可能正在那一批里/.test(un), un.slice(0, 400));
  check("covers 负控：settings 里只有别的 hook ⇒ ✗ 未注册",
    /✗ 未注册/.test(scWith("otherhook", reg("", "dao-cn-title.js"))));
  {
    const ANCHOR = '    covers: (m) => m === "" || m === "*",';
    const h = mutantHook("covers-always-true", ANCHOR, "    covers: () => true,");
    const out = scWith("covers-mut", reg("Bash"), h);
    check("🔴 先破再验：covers 恒真 ⇒ 覆盖不到的 matcher 也报 ✓（负控组真的在测这条判据）",
      /✓ 已注册于 UserPromptSubmit/.test(out) && !/✗ 已注册于 UserPromptSubmit/.test(out), out.slice(0, 400));
    check("canary：变异体还活着（自检照跑、报头照打）",
      /dao-probe-gate --selfcheck/.test(out), out.slice(0, 200));
  }
}

// ⚠ 本节只放**判据类**那四向；#190 新增的几向（外层 catch / 陈旧判据 / covers 判定）
//   **就近放在它们各自那一节里** —— mutation 与它该打红的那条断言隔上几百行，
//   下一次有人改那条断言时不会想起还有个 mutation 在守它。
console.log("\n=== mutation · 判据四向（锚点单行、断言与 replace 同一个字符串）===");
{
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
