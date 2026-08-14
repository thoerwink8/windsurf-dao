// 正式看门狗回归网（issue #442）——每个检测项留正控 + 负控 + 判别力
//
// 验的层：①真实语料（live/ 2026-08-14 实录）扫完 0 异常 ②exited 违规样本被拦 ③错误指纹样本被拦
// ④waiting 官方信号样本被拦 ⑤整屏哈希三轮不变样本在第 3 轮被拦（前两轮不报）⑥NO_TARGETS 与
// OK 区分（退出码 2 vs 0，且输出可辨）⑦--once 只跑单轮 ⑧检测不依赖工人自报（删掉 ps 里的
// lastAssistantMessage 依旧报警）。
//
// 判别力自检问句：任何把检测放宽或收紧的改动，是否都至少有一条断言会变红？
// 每个违规样本都是「故意构造的违规」，被拦下就是生效证据——v0.4 上线首报即翻车正是
// 因为抢时间跳过了这一步（#442 评论区最后一条）。
//
// ⚠ 快照是录制/手工改出的语料，不是 mock：ps/read 均来自 orca 真实输出结构，
//   违规样本是在真实录制基础上改字段改出来的。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const WATCHDOG = path.join(REPO, "scripts", "watchdog.mjs");
const FIXTURES = path.join(REPO, "tests", "watchdog-fixtures");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

function runWatchdog(dir, extraArgs = []) {
  const r = spawnSync(process.execPath, [WATCHDOG, "--snapshot-dir", dir, ...extraArgs], {
    encoding: "utf8",
    cwd: REPO,
  });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

const EVENT_RE = /^\[.+\] (exited|waiting|fingerprint|hash-stable|read-failed):/m;

console.log("\n=== ① 真实语料（2026-08-14 实录）——负向对照：健康工位不误报 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "live"));
  check("退出码 0（扫完 0 异常）", r.status === 0, `status=${r.status}`);
  check("OK 汇总含工位数 2", /OK 扫完 2 个工位/.test(r.out), r.out.split("\n").slice(0, 3).join(" | "));
  check("工位名自动枚举：master 在列", r.out.includes("master"), "无 master");
  check("工位名自动枚举：看门狗正式版在列", r.out.includes("看门狗正式版"), "无 看门狗正式版");
  // 负控：master 屏面上部叙述里有指纹字样（任务书原文），但底部状态窗口没有——不得误报
  check("屏面上部叙述里的指纹字样不误报（v0 教训）", !EVENT_RE.test(r.out), r.out.split("\n").filter(l => EVENT_RE.test(l)).join(" | "));
}

console.log("\n=== ② exited 违规样本被拦 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "exited"));
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("输出 [master] exited: 事件", /\[master\] exited:/.test(r.out), r.out.trim());
}

console.log("\n=== ③ 错误指纹违规样本被拦（盲考·Grok 真实报错原文）===");
{
  const r = runWatchdog(path.join(FIXTURES, "fingerprint"));
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("输出 [master] fingerprint: 事件", /\[master\] fingerprint:/.test(r.out), r.out.trim());
  check("详情含命中指纹 terminated", /terminated/.test(r.out), "指纹名没进详情");
}

console.log("\n=== ④ waiting 官方信号样本被拦 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "waiting"));
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("输出 [master] waiting: 事件", /\[master\] waiting:/.test(r.out), r.out.trim());
}

console.log("\n=== ⑤ 整屏哈希三轮不变——第 3 轮才报警 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "hash-stable"));
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("三轮都扫了（round 1/3 2/3 3/3 标记）",
    r.out.includes("round 1/3") && r.out.includes("round 2/3") && r.out.includes("round 3/3"),
    r.out.split("\n").slice(0, 6).join(" | "));
  check("第 3 轮输出 [看门狗正式版] hash-stable: 事件", /\[看门狗正式版\] hash-stable:/.test(r.out), r.out.trim());
  check("前两轮是 OK 汇总不是报警", (r.out.match(/OK 扫完 1 个工位/g) || []).length === 2, "OK 行数不对");
}

console.log("\n=== ⑥ NO_TARGETS 与 OK 的区分（数到 0 ≠ 没看到样本）===");
{
  const r = runWatchdog(path.join(FIXTURES, "no-targets"));
  check("退出码 2（NO_TARGETS）", r.status === 2, `status=${r.status}`);
  check("明确打印 NO_TARGETS 警告", /NO_TARGETS/.test(r.out), r.out.trim());
  check("不打出 OK 汇总（不能把没查成说成查过没事）", !/OK 扫完/.test(r.out), r.out.trim());
}

console.log("\n=== ⑦ --once 只跑单轮 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "hash-stable"), ["--once"]);
  check("单轮退出码 0（第 1 轮无违规）", r.status === 0, `status=${r.status}`);
  check("没有 round 2/3 标记（没跑后面的轮）", !r.out.includes("round 2/3"), r.out.trim());
}

console.log("\n=== ⑧ 检测不依赖工人自报（删掉 lastAssistantMessage 依旧报警）===");
{
  // 在临时目录复制 exited 样本，把 ps.json 里全部 lastAssistantMessage 清掉再跑
  // （不用 fs.cpSync：本机 Node 24 在 Windows 上 cpSync 会静默崩进程，手动递归拷贝）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-noself-"));
  (function copyDir(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      const s = path.join(src, f);
      if (fs.statSync(s).isDirectory()) copyDir(s, path.join(dst, f));
      else fs.copyFileSync(s, path.join(dst, f));
    }
  })(path.join(FIXTURES, "exited"), tmp);
  const psPath = path.join(tmp, "ps.json");
  const ps = JSON.parse(fs.readFileSync(psPath, "utf8"));
  for (const w of ps.result.worktrees) for (const a of w.agents) delete a.lastAssistantMessage;
  fs.writeFileSync(psPath, JSON.stringify(ps, null, 2), "utf8");
  const r = runWatchdog(tmp);
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("exited 报警照常触发", /\[master\] exited:/.test(r.out), r.out.trim());
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nwatchdog 回归网：${pass} 过 / ${fail} 红`);
process.exit(fail > 0 ? 1 : 0);
