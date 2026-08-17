// 正式看门狗回归网（issue #442 + #500/#492/#471/#476 换代 + #569 降噪/换 provider/权限框）——每个检测项留正控 + 负控 + 判别力
//
// 验的层：①真实语料（live/ 2026-08-14 实录）扫完 0 异常 ②真实事故语料被拦（at-capacity 两起
// 实录 + terminal_handle_stale 读失败实录，字段未改写）③exited / 错误指纹 / waiting / 停摆 /
// NO_TARGETS 违规样本被拦 ④epoch 状态机边界（同 pane 重启 / 内容变化）⑤结构性排除（主工作区 /
// 自身 / 稳定 pane ID）⑥--once 只跑单轮 ⑦检测不依赖工人自报。
// #500 换代：⑧停摆判据 = 非 spinner 真实内容连续三轮不变（spinner 重绘/cursor 前进/ps updatedAt
// 前进都不算活性——转圈假工人 spinner-hang 样本：旧判据全放行、新判据第 3 轮报）⑨空转（git 证据）
// ⑩孤儿树（活跃执行者判据，跨主帅不误伤）⑪命名校验 ⑫flow 心跳/停滞态 ⑬处置矩阵动作行与连败报帅。
// #569：⑭空转降噪三类豁免（角色·在途PR·活性否决，各留正控 negative + 真阳对照）⑮权限确认框
// selector 指纹（1/3:select 两连同，不自动替它选）⑯BLIND 隐形工人（垫片 watch-board 并进，
// 2026-08-17 判据订正：有活终端且查不到 dispatch 记账才报，agents=0 不算数）⑰model-change
// （pi 静默换 provider：诱因 errorMessage、初始选型不报）。
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

// 把单轮快照目录复制成 n 轮同屏（两连同/停摆判据是跨轮状态机，单轮快照不够）
function multiRound(dir, n) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-mr-"));
  for (let i = 1; i <= n; i++) {
    const dst = path.join(tmp, `round-${i}`);
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      const s = path.join(dir, f);
      if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(dst, f));
    }
  }
  return tmp;
}

function runMultiRounds(dir, n, extraArgs = []) {
  const tmp = multiRound(dir, n);
  const r = runWatchdog(tmp, extraArgs);
  fs.rmSync(tmp, { recursive: true, force: true });
  return r;
}

const EVENT_RE = /^\[.+\] (exited|waiting|fingerprint|stall|read-failed|idle|orphan|naming|flow-stalled|flow-absent|stagnation|selector|blind|model-change|retry-loop|stale-completion|stale-code|报帅|动作):/m;
const SELF_WT = "1770a430-983a-4e86-9277-9f1e5c376b83::C:/Users/Administrator/orca/workspaces/windsurf-dao/看门狗正式版";
const NOW = 1786800000000;

console.log("\n=== ① 真实语料（2026-08-14 实录）——负向对照：健康工位不误报 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "live"));
  check("退出码 0（扫完 0 异常）", r.status === 0, `status=${r.status}`);
  check("OK 汇总含工位数（主工作区被结构性排除，剩 1 个）", /OK 扫完 1 个工位/.test(r.out), r.out.trim());
  check("被监视工位：#452 - 看门狗正式版在列", r.out.includes("#452 - 看门狗正式版"), "无 #452 - 看门狗正式版");
  check("主工作区 master 不在监视集合（结构性排除）", !r.out.includes("master"), r.out.trim());
  check("屏面上部叙述里的指纹字样不误报（v0 教训）", !EVENT_RE.test(r.out), r.out.split("\n").filter(l => EVENT_RE.test(l)).join(" | "));
  check("命名合规树不报 naming（#476）", !/naming:/.test(r.out), r.out.trim());
}

console.log("\n=== ② 真实语料 + 自身排除：全被排除 → NO_TARGETS ===");
{
  const r = runWatchdog(path.join(FIXTURES, "live"), ["--self-worktree", SELF_WT]);
  check("退出码 2（NO_TARGETS）", r.status === 2, `status=${r.status}`);
  check("明确打印 NO_TARGETS", /NO_TARGETS/.test(r.out), r.out.trim());
}

console.log("\n=== ③ 真实事故语料被拦（2026-08-15 现场实录，字段未改写）——指纹两连同才报警（2026-08-15 裁定书）===");
{
  const r1 = runWatchdog(path.join(FIXTURES, "real-incidents", "at-capacity-450"),
    ["--self-worktree", SELF_WT]);
  check("at-capacity-450：单轮 → 退出码 0（两连同未达成，不唤醒）", r1.status === 0, `status=${r1.status}`);
  check("at-capacity-450：单轮不报 fingerprint", !/fingerprint:/.test(r1.out), r1.out.trim());

  const r2 = runMultiRounds(path.join(FIXTURES, "real-incidents", "at-capacity-450"), 2, ["--self-worktree", SELF_WT]);
  check("at-capacity-450：两轮同屏 → 退出码 1（两连同报警）", r2.status === 1, `status=${r2.status}`);
  check("at-capacity-450：第二轮报 fingerprint 命中 at capacity（现场实录第二轮到）", /round 2\/2[\s\S]*\[#450 - 点将台综合稿\] fingerprint:.*at capacity/.test(r2.out), r2.out.trim());
  const seg1 = (r2.out.match(/round 1\/2([\s\S]*?)(?:round 2\/2|$)/) || [])[1] || "";
  check("at-capacity-450：第一轮不报（streak 1）", !/fingerprint:/.test(seg1), r2.out.trim());
  check("at-capacity-450：处置矩阵动作行出现（#471：at capacity → 注入续命 keepalive）", /动作: 注入续命，错峰退避 120s→300s：将发送「看门狗续命/.test(r2.out), r2.out.trim());

  const r3 = runMultiRounds(path.join(FIXTURES, "real-incidents", "at-capacity"), 2);
  check("at-capacity（审官实录）：两轮同屏 → 退出码 1", r3.status === 1, `status=${r3.status}`);
  check("at-capacity（审官实录）：报 fingerprint 且命中 at capacity", /\[#452 - 看门狗正式版\] fingerprint:.*at capacity/.test(r3.out), r3.out.trim());

  const r4 = runWatchdog(path.join(FIXTURES, "real-incidents", "read-error"));
  check("read-error 实录（terminal_handle_stale）：退出码 1", r4.status === 1, `status=${r4.status}`);
  check("read-error 实录：首轮 read-failed 且错误码透传（快照样本验规整逻辑；live 侧错误码由 runOrca 解析 stdout 保证同形态）", /read-failed:.*terminal_handle_stale/.test(r4.out), r4.out.trim());
}

console.log("\n=== ④ exited 违规样本被拦 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "exited"));
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("输出 [#452 - 看门狗正式版] exited: 事件", /\[#452 - 看门狗正式版\] exited:/.test(r.out), r.out.trim());
}

console.log("\n=== ⑤ 宽指纹退役（2026-08-15 裁定书：删单发即唤醒的 'Error:'/'terminated'/'Connection error' 类）===");
{
  // 判别力：指纹一律两连同才报警，单轮本来就不响——退役断言必须用两轮同屏证明
  const r = runMultiRounds(path.join(FIXTURES, "fingerprint"), 2);
  check("fingerprint 样本两轮同屏：退出码 0（'terminated' 已退役，两连同也不报）", r.status === 0, `status=${r.status}`);
  check("fingerprint 样本两轮同屏：无 fingerprint 事件", !/fingerprint:/.test(r.out), r.out.trim());
  check("fingerprint 样本两轮同屏：OK 扫完（不是没查成）", /OK 扫完 1 个工位/.test(r.out), r.out.trim());

  const r2 = runMultiRounds(path.join(FIXTURES, "wide-fp-deleted"), 2);
  check("wide-fp-deleted 两轮同屏：'Error:'/'Connection error' 不再报警 → 退出码 0", r2.status === 0, `status=${r2.status}`);
  check("wide-fp-deleted 两轮同屏：宽指纹字样在屏面但不报", !/fingerprint:/.test(r2.out), r2.out.trim());
}

console.log("\n=== ⑥ waiting 官方信号样本被拦 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "waiting"));
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("输出 waiting: 事件", /\[#452 - 看门狗正式版\] waiting:/.test(r.out), r.out.trim());
}

console.log("\n=== ⑦ 停摆判据（#500 换代）：非 spinner 真实内容三轮不变——第 3 轮才报警 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "hash-stable"));
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("第 3 轮输出 stall 事件", /\[#452 - 看门狗正式版\] stall:/.test(r.out), r.out.trim());
  check("前两轮是 OK 汇总不是报警", (r.out.match(/OK 扫完 1 个工位/g) || []).length === 2, "OK 行数不对");
}

console.log("\n=== ⑧ 判别力：ps updatedAt 前进不算活性（#500：转圈挂死时 ps 也可能在动）——第 3 轮即报 ===");
{
  // hash-stable-activity 原样本：ps updatedAt 第 2 轮推进一次、真实内容不动。
  // 旧判据以 updatedAt 重启计数 → 第 4 轮才报；新判据只认非 spinner 真实内容 → 第 3 轮报。
  // 判别力：把 updatedAt 重新接回 epoch 会让断言变红（改坏自检）。
  const r = runWatchdog(path.join(FIXTURES, "hash-stable-activity"));
  const seg = (n) => (r.out.match(new RegExp(`round ${n}\\/4([\\s\\S]*?)(?:round \\d\\/4|$)`)) || [])[1] || "";
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("第 3 轮输出 stall（updatedAt 前进不重启计数）", /\[#452 - 看门狗正式版\] stall:/.test(seg(3)), r.out.trim());
  check("第 2 轮还是 OK（streak 2 未达阈值）", /OK 扫完 1 个工位/.test(seg(2)) && !/stall:/.test(seg(2)), "第 2 轮不该报警");
}

console.log("\n=== ⑨ epoch 状态机：同 pane 重启（incarnation 变、内容不变）→ 重启轮重新起算，第 5 轮才报 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "hash-stable-restart"));
  const seg = (n) => (r.out.match(new RegExp(`round ${n}\\/5([\\s\\S]*?)(?:round \\d\\/5|$)`)) || [])[1] || "";
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("第 5 轮输出 stall（重启后 3 个同屏轮）", /\[#452 - 看门狗正式版\] stall:/.test(seg(5)), r.out.trim());
  check("第 3 轮还是 OK（重启轮重新起算——判别力：把 epoch 去掉 incarnation 会在第 3 轮就报）", /OK 扫完 1 个工位/.test(seg(3)) && !/stall:/.test(seg(3)), "第 3 轮不该报警");
  check("第 4 轮还是 OK（没串用旧计数）", /OK 扫完 1 个工位/.test(seg(4)) && !/stall:/.test(seg(4)), "第 4 轮不该报警");
}

console.log("\n=== ⑩ epoch 状态机：内容变了又变回 → 连击清零，永不报 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "hash-stable-screenchange"));
  check("退出码 0（无报警）", r.status === 0, `status=${r.status}`);
  check("没有 stall 事件", !/stall:/.test(r.out), r.out.trim());
}

console.log("\n=== ⑪ NO_TARGETS 与 OK 的区分（数到 0 ≠ 没看到样本）===");
{
  const r = runWatchdog(path.join(FIXTURES, "no-targets"));
  check("退出码 2（NO_TARGETS）", r.status === 2, `status=${r.status}`);
  check("明确打印 NO_TARGETS 警告", /NO_TARGETS/.test(r.out), r.out.trim());
  check("不打出 OK 汇总（不能把没查成说成查过没事）", !/OK 扫完/.test(r.out), r.out.trim());
  check("无关联单证据的树不误报孤儿（查不到≠孤儿，#492）", !/orphan:/.test(r.out), r.out.trim());
  check("#602：in-review 待合并盘面不报 all-idle（该扩判已退役）", !/all-idle:/.test(r.out), r.out.trim());
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

console.log("\n=== ⑭ 结构性排除（红 2 修法）：主工作区 / 自身 / 稳定 pane ID（2026-08-15 起 --exclude-pane 分级排除）===");
{
  const ex = path.join(FIXTURES, "exclusion");
  const r1 = runMultiRounds(ex, 2);
  check("不传排除：主工作区被排除，自身卡（指纹屏面）被监视，两轮同屏 → 退出码 1", r1.status === 1, `status=${r1.status}`);
  check("不传排除：master 不在监视集合", !r1.out.includes("master"), r1.out.trim());
  check("不传排除：#452 指纹屏面两连同报警（自身未排除时会报）", /round 2\/2[\s\S]*\[#452 - 看门狗正式版\] fingerprint:/.test(r1.out), r1.out.trim());

  const r2 = runWatchdog(ex, ["--self-worktree", "wt::self-card-452"]);
  check("--self-worktree：自身卡被排除 → 只扫工人卡，退出码 0", r2.status === 0, `status=${r2.status}`);
  check("--self-worktree：OK 只含工人卡 #999", /OK 扫完 1 个工位（#999 - 排除测试工人）/.test(r2.out), r2.out.trim());
  check("--self-worktree：不再报自身指纹（审官复现场景被结构性拦住）", !/\[#452 - 看门狗正式版\] fingerprint:/.test(r2.out), r2.out.trim());

  const r3 = runWatchdog(ex, ["--self-worktree", "wt::self-card-452", "--exclude-pane", "worker-pane-999:leaf"]);
  check("--exclude-pane：分级排除——工位仍被监视（保留死活判据）→ OK 扫完 1 个工位", r3.status === 0 && /OK 扫完 1 个工位（#999 - 排除测试工人）/.test(r3.out), `status=${r3.status} ${r3.out.trim()}`);
  check("--exclude-pane：不再 NO_TARGETS（旧版整体排除把工位整个摘掉=死活也没人盯）", !/NO_TARGETS/.test(r3.out), r3.out.trim());
}

console.log("\n=== ⑮ 检测不依赖工人自报（删掉 lastAssistantMessage 依旧报警）===");
{
  // 在临时目录复制 exited 样本，把 ps.json 里全部 lastAssistantMessage 清掉再跑
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

console.log("\n=== ⑯ 判别性实验（#500）：转圈假工人——spinner 重绘 + cursor 前进 + ps updatedAt 前进 ===");
{
  // spinner-hang/：三轮真实内容完全不动，spinner 帧轮换、nextCursor 前进、ps updatedAt 前进。
  // 旧判据（cursor 增量/整屏哈希/ps updatedAt）：全放行 → 瞎（这就是 #500 当天三种探头全瞎的复现）。
  // 新判据（非 spinner 内容哈希）：第 3 轮 stall。
  const r = runWatchdog(path.join(FIXTURES, "spinner-hang"));
  check("退出码 1（新判据当场抓住）", r.status === 1, `status=${r.status}`);
  check("第 3 轮输出 stall 事件", /round 3\/3[\s\S]*\[#452 - 看门狗正式版\] stall:/.test(r.out), r.out.trim());
  check("前两轮是 OK（streak 1/2 未达阈值）", (r.out.match(/OK 扫完 1 个工位/g) || []).length === 2, "OK 行数不对");
  // 判别力自检：把 spinner 剔除逻辑改坏（比如直接用整屏哈希）→ spinner 帧轮换让哈希每轮都变 → 永不报 → 本条断言变红。
  // 原始输出（判别性实验 2）已贴 PR #505 正文。

  // 负对照：真实内容逐轮变化 + spinner 也在转 → 健康工人不误报
  const ra = runWatchdog(path.join(FIXTURES, "real-advance"));
  check("real-advance：退出码 0（真实内容在动 = 活着）", ra.status === 0, `status=${ra.status}`);
  check("real-advance：不报 stall", !/stall:/.test(ra.out), ra.out.trim());
}

console.log("\n=== ⑰ 空转强判据（#471 第四类事故）：进程在动但工作树 N 分钟无 git 活动 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "idle"), ["--once", "--now", String(NOW)]);
  check("idle：退出码 1（空转报警）", r.status === 1, `status=${r.status}`);
  check("idle：输出 idle 事件且带 git 证据分钟数", /\[#452 - 看门狗正式版\] idle:.*30 分钟无 git 活动/.test(r.out), r.out.trim());

  const rf = runWatchdog(path.join(FIXTURES, "idle-fresh"), ["--once", "--now", String(NOW)]);
  check("idle-fresh：5 分钟内有活动 → 退出码 0", rf.status === 0, `status=${rf.status}`);
  check("idle-fresh：不报 idle", !/idle:/.test(rf.out), rf.out.trim());
}

console.log("\n=== ⑰a #569 降噪①（角色判据）：审官/辅助子卡不判 git 空转（#568 审官案例同类） ===");
{
  const r = runWatchdog(path.join(FIXTURES, "idle-reviewer"), ["--once", "--now", String(NOW)]);
  check("idle-reviewer：退出码 0（子卡豁免，不再是假阳）", r.status === 0, `status=${r.status}`);
  check("idle-reviewer：不报 idle（审官产出是 review comment 与 notify 不是 commit）", !/idle:/.test(r.out), r.out.trim());
  check("idle-reviewer：打角色豁免观察行（判据可见）", /\[#455 - 审官·grok-4.6\] 观察: 子卡（审官\/辅助，卡名带 ·）不判 git 空转/.test(r.out), r.out.trim());
}

console.log("\n=== ⑰b #569 降噪②（在途 PR 豁免）：已交付等下一环的工位不算空转 ===");
{
  const re = runWatchdog(path.join(FIXTURES, "idle-pr-exempt"), ["--once", "--now", String(NOW)]);
  check("idle-pr-exempt（OPEN 非 draft APPROVED）：退出码 0（在途 PR 等着别人 = 不算空转）", re.status === 0, `status=${re.status}`);
  check("idle-pr-exempt：不报 idle", !/idle:/.test(re.out), re.out.trim());
  check("idle-pr-exempt：打在途 PR 观察行（判据可见）", /观察: 在途 PR #999（OPEN 非 draft，APPROVED）等着别人/.test(re.out), re.out.trim());

  const rr = runWatchdog(path.join(FIXTURES, "idle-pr-rework"), ["--once", "--now", String(NOW)]);
  check("idle-pr-rework（CHANGES_REQUESTED 要返工）：退出码 1（责任仍在本工位，真阳不减）", rr.status === 1, `status=${rr.status}`);
  check("idle-pr-rework：idle 照报", /\[#999 - 返工PR测试\] idle:/.test(rr.out), rr.out.trim());
}

console.log("\n=== ⑰c #569 降噪③（活性否决）：非 spinner 真实内容在动 = 不算空转（#500 一致性） ===");
{
  // 三轮：第 1 轮冻结（git 空置）→ idle 报；第 2 轮真实内容在动 → 豁免（刚重启正在开 PR 的形态）；
  // 第 3 轮内容又冻结 → idle 再报。判别力：把否决删掉 → 第 2 轮把 idle 再报一遍 → 断言变红。
  const r = runWatchdog(path.join(FIXTURES, "idle-veto"), ["--now", String(NOW)]);
  const seg = (n) => (r.out.match(new RegExp(`round ${n}\\/3([\\s\\S]*?)(?:round \\d\\/3|$)`)) || [])[1] || "";
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("第 1 轮：idle 报（屏面冻结 + git 空置）", /idle:/.test(seg(1)), seg(1).trim());
  check("第 2 轮：不报 idle，打活性否决观察行", !/idle:/.test(seg(2)) && /观察: 空转豁免：非 spinner 真实内容在动——活性否决/.test(seg(2)), seg(2).trim());
  check("第 3 轮：内容冻结回来 → idle 再报（豁免不是永久放行）", /idle:/.test(seg(3)), seg(3).trim());
}


console.log("\n=== ⑱ 孤儿树判据（#492/#476）：还有没有活跃执行者，跨主帅不误伤 ===");
{
  const rc = runWatchdog(path.join(FIXTURES, "orphan-closed"), ["--once"]);
  check("真孤儿（无活跃执行者 + 关联 issue 已关 + 终端已关）：退出码 1", rc.status === 1, `status=${rc.status}`);
  check("真孤儿：输出 orphan 事件且带判断依据", /\[#483 - 调研单\] orphan:.*关联 issue 483/.test(rc.out), rc.out.trim());

  const ro = runWatchdog(path.join(FIXTURES, "orphan-open"), ["--once"]);
  check("关联单还开着：不报 orphan（#492 v3：任一开着就不算孤儿）", !/orphan:/.test(ro.out), ro.out.trim());

  const ra = runWatchdog(path.join(FIXTURES, "orphan-active"), ["--once"]);
  check("另一位主帅的活跃工位（working agent）：退出码 0 且不报 orphan（#492 关条件 3）", ra.status === 0 && !/orphan:/.test(ra.out), `status=${ra.status} ${ra.out.trim()}`);

  const rs = runWatchdog(path.join(FIXTURES, "orphan-noassoc-stale"), ["--once"]);
  check("无关联 + 静置超 60 分钟：退出码 1（孤儿候选）", rs.status === 1, `status=${rs.status}`);
  check("无关联 + 静置超阈值：输出 orphan 且带静置分钟数", /orphan:.*无关联.*静置 \d+ 分钟/.test(rs.out), rs.out.trim());

  const rf = runWatchdog(path.join(FIXTURES, "orphan-noassoc-fresh"), ["--once"]);
  check("无关联 + 静置 5 分钟：不报 orphan（未超阈值）", !/orphan:/.test(rf.out), rf.out.trim());
}

console.log("\n=== ⑲ 命名校验（#476）：任务卡显示名格式 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "naming-bad"), ["--once"]);
  check("不合规卡名：退出码 1（naming 报警）", r.status === 1, `status=${r.status}`);
  check("输出 naming 事件且带卡名", /\[审官·GPT\] naming:.*审官·GPT/.test(r.out), r.out.trim());
  check("命名违规但终端在跑的树不报 orphan（活跃执行者判据优先）", !/orphan:/.test(r.out), r.out.trim());
}

console.log("\n=== ⑳ flow 心跳消费端（#471 停滞态/flow 停摆；契约 #497 立约；#580 从未存在）===");
{
  const rs = runWatchdog(path.join(FIXTURES, "heartbeat-stale"), ["--once", "--now", String(NOW)]);
  check("心跳 10 分钟未更新：退出码 1（flow 停摆候选）", rs.status === 1, `status=${rs.status}`);
  check("心跳过期三态话：flow-stalled 含「心跳过期」", /\[flow\] flow-stalled:.*心跳过期.*10 分钟未更新/.test(rs.out), rs.out.trim());

  const rp = runWatchdog(path.join(FIXTURES, "heartbeat-pending"), ["--once", "--now", String(NOW)]);
  check("在途 PR 停留 40 分钟：退出码 1（停滞态：该发生而没发生）", rp.status === 1, `status=${rp.status}`);
  check("在途 PR 停留超阈值：输出 stagnation 且带 state", /\[PR#456\] stagnation:.*state=approved.*40 分钟/.test(rp.out), rp.out.trim());

  const rf = runWatchdog(path.join(FIXTURES, "heartbeat-fresh"), ["--once", "--now", String(NOW)]);
  check("心跳新鲜 + 无停滞 PR：不报 flow-stalled/stagnation", !/flow-stalled:/.test(rf.out) && !/stagnation:/.test(rf.out), rf.out.trim());
  check("心跳新鲜三态话", /心跳新鲜/.test(rf.out), rf.out.trim());
  check("心跳缺失且待流转没查成：HEARTBEAT_MISSING（不是查过没事）", /HEARTBEAT_MISSING/.test(runWatchdog(path.join(FIXTURES, "live"), ["--once"]).out), "live/ 快照无 heartbeat.json 应显形");

  const ap = runWatchdog(path.join(FIXTURES, "heartbeat-absent-pending"), ["--once"]);
  check("无心跳 + 有待流转（红判定待返工注入）：退出码 1", ap.status === 1, `status=${ap.status}`);
  check("无心跳 + 有待流转：报 flow-absent 心跳从未存在", /\[flow\] flow-absent:.*心跳从未存在.*待流转/.test(ap.out), ap.out.trim());
  check("无心跳 + 有待流转：不报 flow-stalled（过期和从未存在分得开）", !/flow-stalled:/.test(ap.out), ap.out.trim());

  const ai = runWatchdog(path.join(FIXTURES, "heartbeat-absent-idle"), ["--once"]);
  check("无心跳 + 无待流转（已绿待帅）：不报 flow-absent/flow-stalled", !/flow-absent:/.test(ai.out) && !/flow-stalled:/.test(ai.out), ai.out.trim());
  check("无心跳 + 无待流转：心跳从未存在但不报", /心跳从未存在.*无待流转对象，不报/.test(ai.out), ai.out.trim());

  const tp = runWatchdog(path.join(FIXTURES, "heartbeat-absent-ticket-pending"), ["--once"]);
  check("PR#582≠issue#580：署名 issue 完工 + 红判定 → 报 flow-absent", /\[flow\] flow-absent:.*心跳从未存在/.test(tp.out), tp.out.trim());
  const ti = runWatchdog(path.join(FIXTURES, "heartbeat-absent-ticket-idle"), ["--once"]);
  check("PR#582≠issue#580：完工只在 PR 会话 → 不报", !/flow-absent:/.test(ti.out) && /心跳从未存在.*无待流转对象/.test(ti.out), ti.out.trim());
}

console.log("\n=== ⑳r #595 守卫版本闸（heartbeat.revision 三态）===");
{
  const behind = runWatchdog(path.join(FIXTURES, "heartbeat-revision-behind"), ["--once", "--now", String(NOW)]);
  check("落后 1 个 commit：报 stale-code", /\[flow\] stale-code:.*落后 origin\/master 1 个 commit/.test(behind.out), behind.out.trim());
  check("落后样本不含「已是最新」", !/已是最新/.test(behind.out), behind.out.trim());

  const current = runWatchdog(path.join(FIXTURES, "heartbeat-revision-current"), ["--once", "--now", String(NOW)]);
  check("已是最新：不报 stale-code", !/stale-code:/.test(current.out), current.out.trim());

  const unknown = runWatchdog(path.join(FIXTURES, "heartbeat-revision-unknown"), ["--once", "--now", String(NOW)]);
  check("fetch 失败：报查不成", /\[flow\] stale-code:.*查不成/.test(unknown.out), unknown.out.trim());
  check("查不成不含「已是最新」", !/已是最新/.test(unknown.out), unknown.out.trim());
}

console.log("\n=== ⑳k #575 ① 真实故障注入：跑 flow 写心跳 → 停写（kill）→ 5 分钟报 flow-stalled ===");
{
  // 硬证据：心跳必须是 flow.mjs 自己写的，不是测试手搓 JSON。
  // kill = 只跑一轮然后不再跑（停写）。阈值 = heartbeatStaleMs = 5 分钟。
  // 不真睡 5 分钟：用 --now 把「现在」拨过阈值。报警必须是 [flow] flow-stalled / 5 分钟未更新。
  const FLOW = path.join(REPO, "scripts", "flow.mjs");
  const FLOW_FIXTURE = path.join(REPO, "tests", "flow-fixtures", "no-open");
  const STALE_MS = 5 * 60 * 1000;
  const tmpFlow = fs.mkdtempSync(path.join(os.tmpdir(), "wd-kill-flow-src-"));
  const stateFile = path.join(tmpFlow, "state.json");
  const flowRun = spawnSync(process.execPath, [
    FLOW, "--snapshot-dir", FLOW_FIXTURE, "--state-file", stateFile, "--dry-run",
  ], { encoding: "utf8", cwd: REPO });
  const hbFile = path.join(tmpFlow, "heartbeat.json");
  let hb = null;
  try { hb = JSON.parse(fs.readFileSync(hbFile, "utf8")); } catch { hb = null; }
  const tWrite = hb && Date.parse(hb.ts);
  check("kill 前：flow.mjs 真写下 heartbeat.json（含可解析 ts）",
    fs.existsSync(hbFile) && Number.isFinite(tWrite),
    `status=${flowRun.status} hb=${JSON.stringify(hb)}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wd-kill-flow-"));
  const src = path.join(FIXTURES, "heartbeat-fresh", "round-1");
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f);
    if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(tmp, f));
  }
  if (fs.existsSync(hbFile)) fs.copyFileSync(hbFile, path.join(tmp, "heartbeat.json"));

  if (!Number.isFinite(tWrite)) {
    check("kill 后 1s：不报 flow-stalled", false, "flow 没写下可解析心跳，后续注入无法跑");
    check("刚好 5 分钟还不报", false, "跳过");
    check("kill 后超过 5 分钟：退出码 1", false, "跳过");
    check("kill 后超过 5 分钟：输出 [flow] flow-stalled", false, "跳过");
    check("报警写得出停了几分钟（5 分钟）", false, "跳过");
  } else {
    const alive = runWatchdog(tmp, ["--once", "--now", String(tWrite + 1000)]);
    check("kill 后 1s（心跳仍新鲜）：不报 flow-stalled", !/flow-stalled:/.test(alive.out), alive.out.trim());

    const atThreshold = runWatchdog(tmp, ["--once", "--now", String(tWrite + STALE_MS)]);
    check("刚好 5 分钟（now-ts == 阈值）：还不报（判据是 > 不是 >=）", !/flow-stalled:/.test(atThreshold.out), atThreshold.out.trim());

    const killed = runWatchdog(tmp, ["--once", "--now", String(tWrite + STALE_MS + 1)]);
    check("kill 后超过 5 分钟：退出码 1", killed.status === 1, `status=${killed.status}`);
    check("kill 后超过 5 分钟：输出 [flow] flow-stalled", /\[flow\] flow-stalled:/.test(killed.out), killed.out.trim());
    check("报警写得出停了几分钟（5 分钟）", /flow-stalled:.*5 分钟未更新/.test(killed.out), killed.out.trim());
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmpFlow, { recursive: true, force: true });
}

console.log("\n=== ⑳b 处置矩阵连败：同指纹连续命中超阈值 → 报帅（#471）===");
{
  const r = runWatchdog(path.join(FIXTURES, "fp-loss"));
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("第 2 轮 fingerprint + 动作行", /round 2\/5[\s\S]*fingerprint:.*at capacity/.test(r.out) && /动作: 注入续命/.test(r.out), r.out.trim());
  check("第 5 轮报帅（连败阈值）", /round 5\/5[\s\S]*报帅:.*连败/.test(r.out), r.out.trim());
}

console.log("\n=== ⑳c 活证否决（#500 换代）：否决只看非 spinner 真实内容在动 ===");
{
  const r = runWatchdog(path.join(FIXTURES, "veto"));
  check("退出码 0（否决 = 不唤醒）", r.status === 0, `status=${r.status}`);
  check("打印观察行（活证否决，真实内容在动）", /\[#452 - 看门狗正式版\] 观察: 指纹两连同「at capacity、try a different model」但非 spinner 真实内容在动——活证否决/.test(r.out), r.out.trim());
  check("不报 fingerprint（被否决）", !/fingerprint:/.test(r.out), r.out.trim());

  const rs = runWatchdog(path.join(FIXTURES, "veto-stall"));
  check("真实内容静止 → 指纹两连同照常报警（退出码 1）", rs.status === 1, `status=${rs.status}`);
  check("真实内容静止 → fingerprint 事件命中 at capacity", /round 2\/2[\s\S]*\[#452 - 看门狗正式版\] fingerprint:.*at capacity/.test(rs.out), rs.out.trim());
}

console.log("\n=== ⑳d 分级排除：--exclude-pane 豁免指纹/停摆判据但保留死活判据（2026-08-15 裁定书）===");
{
  // veto-stall 的工位屏面有 at capacity 指纹 + 真实内容静止：不排除会报警；排除后指纹豁免 → 不报但仍在监视
  const paneKey = "e9f1fff3-f73d-4624-a619-99c0cb257267:60cb698e-d683-446b-aaab-6e475a3b0c56";
  const r = runWatchdog(path.join(FIXTURES, "veto-stall"), ["--exclude-pane", paneKey]);
  check("退出码 0（指纹判据被豁免）", r.status === 0, `status=${r.status}`);
  check("不报 fingerprint", !/fingerprint:/.test(r.out), r.out.trim());
  check("工位仍被监视（保留死活判据）→ OK 扫完 1 个工位", /OK 扫完 1 个工位（#452 - 看门狗正式版）/.test(r.out), r.out.trim());
  check("不是 NO_TARGETS（旧版整体排除的盲区没了）", !/NO_TARGETS/.test(r.out), r.out.trim());
}

console.log("\n=== ⑳e 分级排除保留死活判据：--exclude-pane 下 exited/waiting 仍会响（2026-08-15 裁定书）===");
{
  // 豁免的是指纹/停摆判据，不是死活判据——exited/waiting 在分级排除下必须照常报警
  const paneKey = "a04a1b0a-c845-4ec2-842b-41816b364e87:d539fff1-47d1-4a97-b479-69523fc1778f";
  const re = runWatchdog(path.join(FIXTURES, "exited"), ["--exclude-pane", paneKey]);
  check("exited 工位被 --exclude-pane 后仍报 exited（保留死活判据）", re.status === 1 && /\[#452 - 看门狗正式版\] exited:/.test(re.out), `status=${re.status} ${re.out.trim()}`);
  const rw = runWatchdog(path.join(FIXTURES, "waiting"), ["--exclude-pane", paneKey]);
  check("waiting 工位被 --exclude-pane 后仍报 waiting（保留死活判据）", rw.status === 1 && /\[#452 - 看门狗正式版\] waiting:/.test(rw.out), `status=${rw.status} ${rw.out.trim()}`);
}

console.log("\n=== ㉑ #569 ④ 权限确认框停摆指纹：N/M:select 持续超阈轮才报，不自动替它选 ===");
{
  // 真阳样本形态直接抄 #568 现场（grok 审官卡在权限确认框 7 分钟）：屏面底部 1/3:select、进程活着、屏面冻结。
  const r1 = runWatchdog(path.join(FIXTURES, "selector-freeze"), ["--once"]);
  check("单轮：退出码 0（持续未达阈轮，不唤醒）", r1.status === 0, `status=${r1.status}`);
  check("单轮：不报 selector", !/selector:/.test(r1.out), r1.out.trim());

  const r2 = runMultiRounds(path.join(FIXTURES, "selector-freeze", "round-1"), 2);
  check("两轮同屏：退出码 1（选择器持续超阈轮）", r2.status === 1, `status=${r2.status}`);
  check("两轮同屏：第 2 轮报 selector 且带选择器原文", /round 2\/2[\s\S]*\[#452 - 看门狗正式版\] selector:.*「1\/3:select」/.test(r2.out), r2.out.trim());
  check("selector 事件不带处置动作（不自动替它选——选哪个有后果）", !/动作:/.test(r2.out), r2.out.trim());

  const rn = runWatchdog(path.join(FIXTURES, "live"), ["--once"]);
  check("健康语料（无选择器提示）：不报 selector", !/selector:/.test(rn.out), rn.out.trim());
}

console.log("\n=== ㉒ #569 垫片并进：编排层隐形工人 BLIND（2026-08-17 判据订正：有活终端 + 查不到 dispatch 记账才算真隐形） ===");
{
  // 真判据 = 有活终端（>1）+ orca orchestration worker-list 的 resource.worktreeId 里没有它
  // （从没走 worker-start/dispatch = 编排层不知道有工人在跑）。worker-list-evidence.json 里
  // 列了现存非主树（#450/#452/#449）但没列 #555 → #555 无记账 → 报。
  const r = runWatchdog(path.join(FIXTURES, "blind"), ["--once"]);
  check("退出码 1（隐形工人必须显形）", r.status === 1, `status=${r.status}`);
  check("输出 blind 事件且带判据（有活终端、无 dispatch 记账）", /\[#555 - 隐形工人测试\] blind: 编排层隐形工人：有 2 个活终端且查不到 dispatch 记账/.test(r.out), r.out.trim());
  check("有记账的非主树（#452 等）不报 blind", !/\[#452 - 看门狗正式版\] blind:/.test(r.out), r.out.trim());
  check("隐形工人树不误报 orphan（有活终端 = 有活跃执行者）", !/\[#555 - 隐形工人测试\] orphan:/.test(r.out), r.out.trim());

  // 负控（2026-08-17 帅实证形态）：同一棵树出现在记账里（agents=0 的审官 worker-read 读得到、
  // token 在涨）→ 编排层看得见 → 不报。判别力：把判据改回垫片的 agents=0 → 本条断言变红。
  const rt = runWatchdog(path.join(FIXTURES, "blind-tracked"), ["--once"]);
  check("blind-tracked（#555 有 dispatch 记账）：退出码 0，不报 blind（有记账的 agents=0 不算隐形）", rt.status === 0 && !/blind:/.test(rt.out), `${rt.status} ${rt.out.trim()}`);

  // 没查成 ≠ 查过没事：无 worker-list-evidence.json 的快照显式 DISPATCH_BOOKKEEPING_MISSING
  const rm = runWatchdog(path.join(FIXTURES, "live"), ["--once"]);
  check("缺记账证据：显式 DISPATCH_BOOKKEEPING_MISSING（不是静默放过）", /DISPATCH_BOOKKEEPING_MISSING/.test(rm.out), rm.out.trim());
}

console.log("\n=== ㉓ #569 降噪命名：无 agent 且无 #N 前缀的树不参与命名校验（windsurf-dao 假阳修复） ===");
{
  const r = runWatchdog(path.join(FIXTURES, "naming-skip"), ["--once"]);
  check("退出码 0（无报警）", r.status === 0, `status=${r.status}`);
  check("windsurf-dao（0 agent、无 #N）不再报 naming（#569：它不是任务卡）", !/naming:.*windsurf-dao/.test(r.out), r.out.trim());
  check("有 agent 的误命名卡仍报（naming-bad 就是正控）", /\[审官·GPT\] naming:/.test(runWatchdog(path.join(FIXTURES, "naming-bad"), ["--once"]).out), "naming-bad 应照常报警");
}

console.log("\n=== ㉔ #569 ② pi 静默换 provider：model_change 事件 + 诱因（errorMessage） ===");
{
  const r = runWatchdog(path.join(FIXTURES, "model-change"), ["--once"]);
  check("退出码 1（静默换 provider 报警）", r.status === 1, `status=${r.status}`);
  check("输出 model-change 事件且带诱因（前一条 message 的 errorMessage）", /\[pi\] model-change:.*诱因：503 status code \(no body\)/.test(r.out), r.out.trim());
  check("切换到 deepseek 直连被点出（止血验证手段）", /model_change → provider=deepseek/.test(r.out), r.out.trim());
  check("会话开头的初始选型（前无 message）不报——只报中途切换", (r.out.match(/\[pi\] model-change:/g) || []).length === 1, r.out.trim());

  const rm = runWatchdog(path.join(FIXTURES, "live"), ["--once", "--sessions-dir", path.join(FIXTURES, "live", "no-sessions")]);
  check("sessions 目录不存在：显式 PI_SESSIONS_MISSING（没查成≠查过没事），不误报", rm.status === 0 && /PI_SESSIONS_MISSING/.test(rm.out), `${rm.status} ${rm.out.trim()}`);
}

console.log("\n=== ㉕ #602：Pasted/ALL_IDLE 扩判退役（治错了病） ===");
{
  const r1 = runWatchdog(path.join(FIXTURES, "pasted-content"), ["--once"]);
  check("Pasted Content 单轮：不再报 pasted-content", !/pasted-content:/.test(r1.out), r1.out.trim());

  const r2 = runMultiRounds(path.join(FIXTURES, "pasted-content", "round-1"), 2);
  check("Pasted Content 两轮：仍不报 pasted-content，不补回车", !/pasted-content:/.test(r2.out) && !/补一记回车/.test(r2.out), r2.out.trim());

  const ra = runWatchdog(path.join(FIXTURES, "all-idle"), ["--once"]);
  check("原 ALL_IDLE 盘面：回到 NO_TARGETS（exit 2），不打 all-idle", ra.status === 2 && /NO_TARGETS/.test(ra.out) && !/all-idle:/.test(ra.out), ra.out.trim());

  const ri1 = runWatchdog(path.join(FIXTURES, "pasted-idle"), ["--once"]);
  check("idle+Pasted：不报 all-idle / pasted-content", !/all-idle:/.test(ri1.out) && !/pasted-content:/.test(ri1.out), ri1.out.trim());
}

console.log("\n=== ㉖ #580 追加：503/5xx 指纹 + 重试循环（内容在变也报；有产出不报；stall 不弱） ===");
{
  const r = runWatchdog(path.join(FIXTURES, "retry-503"), ["--now", String(NOW)]);
  check("503 重试三轮（内容在变、无产出）：退出码 1", r.status === 1, `status=${r.status} ${r.out.trim()}`);
  check("503 重试三轮：报 retry-loop", /retry-loop:.*同一错误行连续 3 轮/.test(r.out), r.out.trim());
  check("503 重试三轮：不报 stall（真实内容在变，停摆判据没被放宽也没被误伤）", !/stall:/.test(r.out), r.out.trim());

  const p = runWatchdog(path.join(FIXTURES, "retry-503-progress"), ["--now", String(NOW)]);
  check("503 重试但 git 产出新鲜：不报 retry-loop", !/retry-loop:/.test(p.out), p.out.trim());

  const s = runWatchdog(path.join(FIXTURES, "hash-stable"));
  check("屏面全冻三轮：stall 照旧报（不许为修重试循环把停摆判弱）", s.status === 1 && /stall:/.test(s.out), s.out.trim());

  const h = runWatchdog(path.join(FIXTURES, "real-advance"));
  check("正常输出且内容在动：不报 retry-loop / stall", h.status === 0 && !/retry-loop:/.test(h.out) && !/stall:/.test(h.out), h.out.trim());
}

console.log("\n=== ㉗ #586 工人 done 但 head 比完工信号新 ===");
{
  const stale = runWatchdog(path.join(FIXTURES, "stale-completion"), ["--once"]);
  check("正样本：head 比完工 comment 新 → 退出码 1", stale.status === 1, `status=${stale.status}`);
  check("正样本：报 stale-completion", /stale-completion:/.test(stale.out) && /#453 - dispatch 顺车修订/.test(stale.out), stale.out.trim());

  const fresh = runWatchdog(path.join(FIXTURES, "stale-completion-fresh"), ["--once"]);
  check("负样本：完工 comment 不早于 head → 不报 stale-completion", !/stale-completion:/.test(fresh.out), fresh.out.trim());

  const none = runWatchdog(path.join(FIXTURES, "no-targets"), ["--once"]);
  check("缺 completion-evidence：不猜、不报 stale-completion（没查成 ≠ 查过有事）", !/stale-completion:/.test(none.out), none.out.trim());
}

console.log(`\nwatchdog 回归网：${pass} 过 / ${fail} 红`);
process.exit(fail > 0 ? 1 : 0);
