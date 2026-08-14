// 正式看门狗回归网（issue #442）——每个检测项留正控 + 负控 + 判别力
//
// 验的层：①真实语料（live/ 2026-08-14 实录）扫完 0 异常 ②真实事故语料被拦（at-capacity 两起
// 实录 + terminal_handle_stale 读失败实录，字段未改写）③exited / 错误指纹 / waiting / 哈希三轮 /
// NO_TARGETS 违规样本被拦 ④epoch 状态机三类边界（活动推进 / 同 pane 重启 / 屏面变化）⑤结构性
// 排除（主工作区 / 自身 / 稳定 pane ID）⑥--once 只跑单轮 ⑦检测不依赖工人自报。
//
// 判别力自检问句：任何把检测放宽或收紧的改动，是否都至少有一条断言会变红？
// 每个违规样本都是「故意构造的违规，被当场拦下」——上线生效证据，v0.4 跳过这步首报即翻车。
//
// 语料分类（tests/watchdog-fixtures/README.md 有逐目录说明）：
//   real-incidents/  = 现场实录（2026-08-15），ps/read 字段未改写
//   其余目录         = 在真实录制基础上手工变异的单元样本，只作补充单元测试，不当现场实录

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
const SELF_WT = "1770a430-983a-4e86-9277-9f1e5c376b83::C:/Users/Administrator/orca/workspaces/windsurf-dao/看门狗正式版";

console.log("\n=== ① 真实语料（2026-08-14 实录）——负向对照：健康工位不误报 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "live"));
  check("退出码 0（扫完 0 异常）", r.status === 0, `status=${r.status}`);
  check("OK 汇总含工位数（主工作区被结构性排除，剩 1 个）", /OK 扫完 1 个工位/.test(r.out), r.out.trim());
  check("被监视工位：看门狗正式版在列", r.out.includes("看门狗正式版"), "无 看门狗正式版");
  check("主工作区 master 不在监视集合（结构性排除）", !r.out.includes("master"), r.out.trim());
  check("屏面上部叙述里的指纹字样不误报（v0 教训）", !EVENT_RE.test(r.out), r.out.split("\n").filter(l => EVENT_RE.test(l)).join(" | "));
}

console.log("\n=== ② 真实语料 + 自身排除：全被排除 → NO_TARGETS ===");
{
  const r = runWatchdog(path.join(FIXTURES, "live"), ["--self-worktree", SELF_WT]);
  check("退出码 2（NO_TARGETS）", r.status === 2, `status=${r.status}`);
  check("明确打印 NO_TARGETS", /NO_TARGETS/.test(r.out), r.out.trim());
}

console.log("\n=== ③ 真实事故语料被拦（2026-08-15 现场实录，字段未改写）===");
{
  const r1 = runWatchdog(path.join(FIXTURES, "real-incidents", "at-capacity-450"),
    ["--self-worktree", SELF_WT]);
  check("at-capacity-450：退出码 1", r1.status === 1, `status=${r1.status}`);
  check("at-capacity-450：真实工位 #450 报 fingerprint", /\[#450 - 点将台综合稿\] fingerprint:/.test(r1.out), r1.out.trim());
  check("at-capacity-450：命中新指纹 at capacity", /at capacity/.test(r1.out), "at capacity 没进详情");
  check("at-capacity-450：命中新指纹 try a different model", /try a different model/.test(r1.out), "try a different model 没进详情");

  const r2 = runWatchdog(path.join(FIXTURES, "real-incidents", "at-capacity"));
  check("at-capacity（审官实录）：退出码 1", r2.status === 1, `status=${r2.status}`);
  check("at-capacity（审官实录）：报 fingerprint 且命中 at capacity", /fingerprint:.*at capacity/.test(r2.out), r2.out.trim());

  const r3 = runWatchdog(path.join(FIXTURES, "real-incidents", "read-error"));
  check("read-error 实录（terminal_handle_stale）：退出码 1", r3.status === 1, `status=${r3.status}`);
  check("read-error 实录：首轮 read-failed 且错误码透传（快照样本验规整逻辑；live 侧错误码由 runOrca 解析 stdout 保证同形态）", /read-failed:.*terminal_handle_stale/.test(r3.out), r3.out.trim());
}

console.log("\n=== ④ exited 违规样本被拦 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "exited"));
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("输出 [#452 - 看门狗正式版] exited: 事件", /\[#452 - 看门狗正式版\] exited:/.test(r.out), r.out.trim());
}

console.log("\n=== ⑤ 错误指纹违规样本被拦（盲考·Grok 真实报错原文）===");
{
  const r = runWatchdog(path.join(FIXTURES, "fingerprint"));
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("输出 fingerprint: 事件", /\[#452 - 看门狗正式版\] fingerprint:/.test(r.out), r.out.trim());
  check("详情含命中指纹 terminated", /terminated/.test(r.out), "指纹名没进详情");
}

console.log("\n=== ⑥ waiting 官方信号样本被拦 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "waiting"));
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("输出 waiting: 事件", /\[#452 - 看门狗正式版\] waiting:/.test(r.out), r.out.trim());
}

console.log("\n=== ⑦ 整屏哈希三轮不变——第 3 轮才报警 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "hash-stable"));
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("第 3 轮输出 hash-stable 事件", /\[#452 - 看门狗正式版\] hash-stable:/.test(r.out), r.out.trim());
  check("前两轮是 OK 汇总不是报警", (r.out.match(/OK 扫完 1 个工位/g) || []).length === 2, "OK 行数不对");
}

console.log("\n=== ⑧ epoch 状态机：updatedAt 刚推进后同屏三轮 → 第 4 轮才报（红 4 修法判别）===");
{
  const r = runWatchdog(path.join(FIXTURES, "hash-stable-activity"));
  // 轮段提取：断言只针对第 n 轮自身的输出块（懒匹配 + 后续轮 OK 会跨轮误命中，不能直接全文正则）
  const seg = (n) => (r.out.match(new RegExp(`round ${n}\\/4([\\s\\S]*?)(?:round \\d\\/4|$)`)) || [])[1] || "";
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("第 4 轮输出 hash-stable（3 个同屏轮）", /\[#452 - 看门狗正式版\] hash-stable:/.test(seg(4)), r.out.trim());
  check("第 3 轮还是 OK（没提前报）", /OK 扫完 1 个工位/.test(seg(3)) && !/hash-stable:/.test(seg(3)), "第 3 轮不该报警");
}

console.log("\n=== ⑨ epoch 状态机：同 pane 重启（incarnation 变、屏面不变）→ 重启轮重新起算，第 5 轮才报 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "hash-stable-restart"));
  const seg = (n) => (r.out.match(new RegExp(`round ${n}\\/5([\\s\\S]*?)(?:round \\d\\/5|$)`)) || [])[1] || "";
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("第 5 轮输出 hash-stable（重启后 3 个同屏轮）", /\[#452 - 看门狗正式版\] hash-stable:/.test(seg(5)), r.out.trim());
  check("第 3 轮还是 OK（重启轮重新起算——判别力：把 epoch 去掉 incarnation 会在第 3 轮就报）", /OK 扫完 1 个工位/.test(seg(3)) && !/hash-stable:/.test(seg(3)), "第 3 轮不该报警");
  check("第 4 轮还是 OK（没串用旧计数）", /OK 扫完 1 个工位/.test(seg(4)) && !/hash-stable:/.test(seg(4)), "第 4 轮不该报警");
}

console.log("\n=== ⑩ epoch 状态机：屏面变了又变回 → 连击清零，永不报 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "hash-stable-screenchange"));
  check("退出码 0（无报警）", r.status === 0, `status=${r.status}`);
  check("没有 hash-stable 事件", !/hash-stable:/.test(r.out), r.out.trim());
}

console.log("\n=== ⑪ NO_TARGETS 与 OK 的区分（数到 0 ≠ 没看到样本）===");
{
  const r = runWatchdog(path.join(FIXTURES, "no-targets"));
  check("退出码 2（NO_TARGETS）", r.status === 2, `status=${r.status}`);
  check("明确打印 NO_TARGETS 警告", /NO_TARGETS/.test(r.out), r.out.trim());
  check("不打出 OK 汇总（不能把没查成说成查过没事）", !/OK 扫完/.test(r.out), r.out.trim());
}

console.log("\n=== ⑫ --once 只跑单轮 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "hash-stable"), ["--once"]);
  check("单轮退出码 0（第 1 轮无违规）", r.status === 0, `status=${r.status}`);
  check("没有 round 2/3 标记（没跑后面的轮）", !r.out.includes("round 2/3"), r.out.trim());
}

console.log("\n=== ⑬ read-failed fail-closed：成功响应缺 result.terminal → 首轮即报（红 3 修法）===");
{
  const r = runWatchdog(path.join(FIXTURES, "read-malformed"));
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("首轮输出 read-failed", /\[#452 - 看门狗正式版\] read-failed:/.test(r.out), r.out.trim());
}

console.log("\n=== ⑬b read-failed fail-closed：runOrca 回落形态（stdout 非 JSON 的字符串错误）也透传 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "read-error-livefallback"));
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("首轮 read-failed 且回落字符串进详情（live 字符串分支有断言看着，审读红 ② 返工）", /\[#452 - 看门狗正式版\] read-failed:.*exit 1/.test(r.out), r.out.trim());
}

console.log("\n=== ⑭ 结构性排除（红 2 修法）：主工作区 / 自身 / 稳定 pane ID ===");
{
  const ex = path.join(FIXTURES, "exclusion");
  const r1 = runWatchdog(ex);
  check("不传排除：主工作区被排除，自身卡（指纹屏面）被监视 → 退出码 1", r1.status === 1, `status=${r1.status}`);
  check("不传排除：master 不在监视集合", !r1.out.includes("master"), r1.out.trim());
  check("不传排除：#452 指纹屏面报警（自身未排除时会报）", /\[#452 - 看门狗正式版\] fingerprint:/.test(r1.out), r1.out.trim());

  const r2 = runWatchdog(ex, ["--self-worktree", "wt::self-card-452"]);
  check("--self-worktree：自身卡被排除 → 只扫工人卡，退出码 0", r2.status === 0, `status=${r2.status}`);
  check("--self-worktree：OK 只含工人卡 #999", /OK 扫完 1 个工位（#999 - 排除测试工人）/.test(r2.out), r2.out.trim());
  check("--self-worktree：不再报自身指纹（审官复现场景被结构性拦住）", !/\[#452 - 看门狗正式版\] fingerprint:/.test(r2.out), r2.out.trim());

  const r3 = runWatchdog(ex, ["--self-worktree", "wt::self-card-452", "--exclude-pane", "worker-pane-999:leaf"]);
  check("--exclude-pane：稳定 pane ID 排除后全部排除 → NO_TARGETS", r3.status === 2 && /NO_TARGETS/.test(r3.out), `status=${r3.status} ${r3.out.trim()}`);
}

console.log("\n=== ⑮ 检测不依赖工人自报（删掉 lastAssistantMessage 依旧报警）===");
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
  check("exited 报警照常触发", /\[#452 - 看门狗正式版\] exited:/.test(r.out), r.out.trim());
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nwatchdog 回归网：${pass} 过 / ${fail} 红`);
process.exit(fail > 0 ? 1 : 0);
