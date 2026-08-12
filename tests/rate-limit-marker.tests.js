// 限流哨兵：限流真的发生时，标记文件真的写下来了。
//
// 守的对象：ccswitch/hooks/dao-rate-limit-sentinel.js（StopFailure 事件）。
// 它失效的样子是**静默的**——hook 挂在 StopFailure 上，它不写标记与它根本没被调用，
// 在屏幕上、退出码上、日志上长得一模一样。而标记是「这一轮死于限流」这件事的唯一物证：
// 没有它，接手的人只看到会话停了，不知道停在哪、也不知道什么时候能续。
//
// 四条断言，缺哪一条都证明不了什么：
//   ① 正控 rate_limit  ⇒ 写标记，且 error 字段对得上
//   ② 正控 overloaded  ⇒ 也写（判据是 MARKED_ERRORS 这个集合，不是单个字面量）
//   ③ 判别力负控 其他错误 ⇒ **不**写。没有它，「恒写标记」也能让 ①② 变绿
//   ④ mutation：把那个集合改空 ⇒ 正控从「写」掉到「不写」。
//      没有 mutation 的正控只证明今天是绿的，证明不了它明天变坏时会红。
//
// 全程沙盒化（hook 自带 DAO_RATE_LIMIT_* 三个环境变量出口），不碰真 _tmp 也不碰 ~/.claude。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-rate-limit-sentinel.js");
const SANDBOX = path.join(os.tmpdir(), `dao-rate-limit-${process.pid}-${Math.random().toString(36).slice(2)}`);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

function payload(error) {
  return {
    session_id: "dao-test-session",
    hook_event_name: "StopFailure",
    error,
    error_details: "429 Too Many Requests",
    last_assistant_message: "API Error: Rate limit reached",
  };
}

/** 跑一次 hook，返回 {code, marker}；marker 为 null 表示这一次没写。 */
function fire(error, tag, hookPath) {
  const dir = path.join(SANDBOX, tag);
  const marker = path.join(dir, "rate-limit-interrupt.json");
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(process.execPath, [hookPath || HOOK], {
    input: JSON.stringify(payload(error)),
    encoding: "utf8",
    env: {
      ...process.env,
      DAO_RATE_LIMIT_MARKER: marker,
      DAO_RATE_LIMIT_STATE_SUBDIR: `rate-limit-test-${tag}`,
      DAO_RATE_LIMIT_MIRROR: path.join(dir, "mirror.log"),
    },
  });
  let parsed = null;
  if (fs.existsSync(marker)) {
    try { parsed = JSON.parse(fs.readFileSync(marker, "utf8")); } catch (e) { parsed = { __unparsable: String(e.message) }; }
  }
  return { code: r.status, marker: parsed };
}

try {
  console.log("\n=== 正控：被判为限流的错误必须留下物证 ===");
  const a = fire("rate_limit", "positive-rate-limit");
  check("rate_limit ⇒ 标记文件写下了", a.marker !== null);
  check("rate_limit ⇒ 标记内容认得出是限流", a.marker !== null && a.marker.error === "rate_limit",
    a.marker ? JSON.stringify(a.marker).slice(0, 120) : "(无标记)");
  check("rate_limit ⇒ hook 自己 exit 0（它是留痕不是拦截）", a.code === 0, `实际 ${a.code}`);

  const b = fire("overloaded", "positive-overloaded");
  check("overloaded ⇒ 也写标记（判据是集合不是单个字面量）", b.marker !== null);

  console.log("\n=== 判别力负控：不是限流的错误不许写 ===");
  // 没有这一条，「恒写标记」也能让上面全绿——那时标记就不再是限流的物证了。
  const c = fire("server_error", "negative-other");
  check("server_error ⇒ 不写标记", c.marker === null,
    c.marker ? JSON.stringify(c.marker).slice(0, 120) : "");

  console.log("\n=== 判别力 · mutation（把判据集合改空，正控必须跟着掉下来）===");
  const SRC = fs.readFileSync(HOOK, "utf8");
  const ANCHOR = 'const MARKED_ERRORS = new Set(["rate_limit", "overloaded"]);';
  if (!SRC.includes(ANCHOR)) {
    // 判据搬了家而 mutation 静默变成空操作 ⇒ 这一条会「通过」而什么都没验。必须红。
    check("mutation 锚点还在", false, "MARKED_ERRORS 的定义变了，这条 mutation 已经什么都没验");
  } else {
    fs.mkdirSync(SANDBOX, { recursive: true });

    // 对照组：**未变异**的副本，跑在与变异体同一个位置上。
    // 没有它，「判据真的被改坏了」与「副本换了个目录就跑不起来了」在结果上完全一样
    // （两边都是「没写标记」）——那时下面那条 mutation 证明的是路径，不是判据。
    const twin = path.join(SANDBOX, "sentinel-twin.js");
    fs.writeFileSync(twin, SRC, "utf8");
    const t = fire("rate_limit", "twin", twin);
    check("未变异副本在同一位置照样写标记（证明变异体不是死于换了个目录）", t.marker !== null,
      t.marker ? "" : "副本在沙盒里跑不起来 ⇒ 下面那条 mutation 什么都没证明");

    const mutant = path.join(SANDBOX, "sentinel-mutant.js");
    fs.writeFileSync(mutant, SRC.replace(ANCHOR, "const MARKED_ERRORS = new Set([]);"), "utf8");
    const m = fire("rate_limit", "mutant", mutant);
    check("判据集合被改空 ⇒ 正控从「写标记」掉到「不写」", m.marker === null,
      m.marker ? JSON.stringify(m.marker).slice(0, 120) : "");
  }
} finally {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail > 0 ? 1 : 0);
