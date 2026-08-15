// 闭环自动流转器回归网（issue #455）——正控 + 负控 + 判别力
//
// 验的层：①真实语料（#453/#456 实录）推导当前态并给出正确动作/报帅 ②假闭环验收
// （draft PR + 假判定行 review → 自动注入下一环且帅零介入）③prime 吞存量负控
// （存量已有完工+红判定的 PR 启动即识别并注入返工，不被吞）④重启不重复动作负控
// （同状态文件重跑零动作）⑤判定行缺失负控（报帅、不猜红绿、区分没查成与无需流转）
// ⑥乒乓两轮仍红→报帅换人 ⑦复核绿→报帅终审 ⑧审官选型序（deepseek→gpt/gpt→claude/
// UI→claude）⑨制度类 24h 提醒只提醒一次 ⑩MERGED 退役 ⑪完工 comment 识别变体
// ⑫judgment 解析与 calibrate 同源（共享模块单一真相源）。
//
// 语料分类：real-453/real-456 为现场实录（gh 拉取未改写）；其余目录为构造样本。
// 每个负控样本都是「故意构造的违规，被当场拦下」——上线生效证据（仓规：上线前先
// 故意构造一次违规样本）。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const FLOW = path.join(REPO, "scripts", "flow.mjs");
const FIXTURES = path.join(REPO, "tests", "flow-fixtures");
const { deriveState, pendingAction, pickReviewer, orderedSignals, isInstitutional, awaitingShuaiReason } = require("../scripts/flow.mjs");
const { judgmentFromReview, isCompletionComment, redFlagsFromReviewBodies } = require("../scripts/lib/judgment.mjs");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

function runFlow(dir, extraArgs = []) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-test-"));
  const stateFile = path.join(tmp, "state.json");
  const r = spawnSync(process.execPath, [FLOW, "--snapshot-dir", dir, "--state-file", stateFile, "--dry-run", ...extraArgs], {
    encoding: "utf8", cwd: REPO,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  fs.rmSync(tmp, { recursive: true, force: true });
  return { status: r.status, out };
}

console.log("\n=== ① 假闭环验收（#455 验收：draft PR + 假判定行 review → 自动注入下一环且帅零介入）===");
{
  const r = runFlow(path.join(FIXTURES, "fake-loop"));
  check("退出码 1（有动作）", r.status === 1, `status=${r.status}`);
  check("自动注入发生：返工注入 + 注入目标已解析（真通，非预览-阻塞）", /动作：返工注入 #999（第 1 轮，红 3 项）（注入目标：工人终端 term_worker_999）/.test(r.out), r.out.trim());
  check("返工指令文本含 review 链接", /pull\/999#pullrequestreview-910001/.test(r.out), "review 链接没进指令");
  check("帅零介入：无任何 报帅 行（真注入路径下成立，名副其实）", !/报帅/.test(r.out), r.out.split("\n").filter(l => /报帅/.test(l)).join(" | "));
  check("不重复起审官（红判定已存在 → 不新建审官）", !/起审官/.test(r.out), r.out.trim());
}

console.log("\n=== ② prime 吞存量负控：存量已有完工+红判定，启动即动作（不吞存量）===");
{
  const r = runFlow(path.join(FIXTURES, "fake-loop"));
  check("存量信号被识别并自动注入返工（吞存量 = 本轮无动作）", /动作：返工注入 #999（第 1 轮，红 3 项）（注入目标：工人终端 term_worker_999）/.test(r.out), r.out.trim());
  check("打出存量清点标记（先清点再增量）", /存量清点/.test(r.out), "存量清点标记缺失");
}

console.log("\n=== ③ 重启不重复动作负控：同状态文件重跑 → 零动作 ===");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-restart-"));
  const stateFile = path.join(tmp, "state.json");
  const args = [FLOW, "--snapshot-dir", path.join(FIXTURES, "fake-loop"), "--state-file", stateFile, "--dry-run"];
  const r1 = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
  const r2 = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
  const out2 = (r2.stdout || "") + (r2.stderr || "");
  check("首跑退出码 1（有动作）", r1.status === 1, `status=${r1.status}`);
  check("重跑退出码 0（无动作）", r2.status === 0, `status=${r2.status}`);
  check("重跑打出 OK 扫完（同指纹不重复动作）", /OK 扫完 1 个 PR，0 需流转/.test(out2), out2.trim());
  check("重跑无任何 动作/报帅 行", !/动作：|报帅：/.test(out2), out2.trim());
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n=== ④ 真实语料 #453（实录：判定红5→复核红2→复核绿 → 报帅终审）===");
{
  const r = runFlow(path.join(FIXTURES, "real-453"));
  check("退出码 1（有报帅）", r.status === 1, `status=${r.status}`);
  check("复核绿 → 报帅终审", /报帅：终审 #453（复核结论：绿）/.test(r.out), r.out.trim());
  check("终审不自动合并（无 动作： 行）", !/动作：/.test(r.out), r.out.trim());
  check("真实语料判定行解析：#453 首审红 5 项", redFlagsFromReviewBodies([JSON.parse(fs.readFileSync(path.join(FIXTURES, "real-453", "pr-453-reviews.json"), "utf8"))[0].body]) === 5, "红项数应为 5");
}

console.log("\n=== ⑤ 真实语料 #456（实录：完工自报×2 重复 → 起审官一次，选型序 deepseek→gpt）===");
{
  const r = runFlow(path.join(FIXTURES, "real-456"));
  check("退出码 1（有动作）", r.status === 1, `status=${r.status}`);
  check("完工自报 → 起审官", /动作：起审官 #456/.test(r.out), r.out.trim());
  check("审官选型序：deepseek 工人 → gpt-5.6-sol（异厂商 GPT 优先）", /审官·gpt-5.6-sol/.test(r.out), r.out.trim());
  check("起审官命令走 codex 一步到位", /--agent codex/.test(r.out), r.out.trim());
  check("重复完工自报不重复起审官（只一次）", (r.out.match(/起审官 #456/g) || []).length === 1, r.out.trim());
}

console.log("\n=== ⑥ 判定行缺失负控：review 无判定行 → 报帅分诊，不动作 ===");
{
  const r = runFlow(path.join(FIXTURES, "malformed"));
  check("退出码 1（有报帅）", r.status === 1, `status=${r.status}`);
  check("报帅判定行缺失/格式不符", /报帅：判定行缺失\/格式不符 #1001/.test(r.out), r.out.trim());
  check("明确区分没查成（不猜红绿）", /没查成，请帅分诊/.test(r.out), r.out.trim());
  check("不产生任何自动动作", !/动作：/.test(r.out), r.out.trim());
  check("同时打出待帅处置常驻行", /待帅处置：#1001（判定行缺失\/格式不符待帅分诊）/.test(r.out), r.out.trim());
}

console.log("\n=== ⑥b 红 3：待帅事项必须每轮常驻显形——连跑两轮不能转绿 ===");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-shuai-"));
  const stateFile = path.join(tmp, "state.json");
  const args = [FLOW, "--snapshot-dir", path.join(FIXTURES, "malformed"), "--state-file", stateFile, "--dry-run"];
  const r1 = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
  const r2 = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
  const out2 = (r2.stdout || "") + (r2.stderr || "");
  check("首跑 exit 1", r1.status === 1, `status=${r1.status}`);
  check("重跑仍 exit 1（待办不能报一次就转绿）", r2.status === 1, `status=${r2.status}`);
  check("重跑仍打待帅处置常驻行", /待帅处置：#1001/.test(out2), out2.trim());
  check("重跑不打「0 需流转」（有待办就不是无事）", !/OK 扫完 1 个 PR，0 需流转/.test(out2), out2.trim());
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n=== ⑦ 无需流转 vs 没查成：0 个 open PR → OK 扫完 0（数到 0 ≠ 没扫到）===");
{
  const r = runFlow(path.join(FIXTURES, "no-open"));
  check("退出码 0（扫完 0 需流转）", r.status === 0, `status=${r.status}`);
  check("OK 扫完 0 个 PR，0 需流转", /OK 扫完 0 个 PR，0 需流转/.test(r.out), r.out.trim());
  check("不打出 NO_TARGETS（不是没查成）", !/NO_TARGETS/.test(r.out), r.out.trim());
}

console.log("\n=== ⑦b 没查成负控：数据源不可用（缺 prs.json）→ NO_TARGETS，与「扫完 0 条」区分 ===");
{
  const r = runFlow(path.join(FIXTURES, "broken-source"));
  check("退出码 3（基础设施失败/没查成）", r.status === 3, `status=${r.status}`);
  check("明确打印 NO_TARGETS", /NO_TARGETS/.test(r.out), r.out.trim());
  check("不打出 OK 扫完（不能把没查成说成查过没事）", !/OK 扫完/.test(r.out), r.out.trim());
}

console.log("\n=== ⑧ 完整闭环四轮：完工→起审官 / 红→返工注入 / 返工完成→复核注入 / 复核绿→报帅终审（全部真通）===");
{
  const r = runFlow(path.join(FIXTURES, "recheck-green"));
  check("退出码 1（有动作/报帅）", r.status === 1, `status=${r.status}`);
  check("round-1 起审官", /round-1[\s\S]*动作：起审官 #1005/.test(r.out), r.out.trim());
  check("round-2 返工注入真通（注入目标已解析）", /round-2[\s\S]*动作：返工注入 #1005（第 1 轮，红 2 项）（注入目标：工人终端 term_worker_1005）/.test(r.out), r.out.trim());
  check("round-3 复核注入真通（存量反查找到审官终端）", /round-3[\s\S]*动作：复核注入 #1005（第 1 轮返工后）（复核目标：审官终端 term_reviewer_1005，存量反查（审官· 子卡））/.test(r.out), r.out.trim());
  check("round-4 报帅终审", /round-4[\s\S]*报帅：终审 #1005/.test(r.out), r.out.trim());
  check("复核绿后不再注入任何动作", !/round-4[\s\S]*动作：/.test(r.out), r.out.trim());
}

console.log("\n=== ⑨ 乒乓两轮仍红：第 1/2 轮红自动返工，第 3 轮红报帅换人（不再注入）===");
{
  const r = runFlow(path.join(FIXTURES, "pingpong"));
  check("退出码 1（有动作/报帅）", r.status === 1, `status=${r.status}`);
  check("round-2 返工注入（第 1 轮，红 3 项）", /round-2[\s\S]*返工注入 #1006（第 1 轮，红 3 项）/.test(r.out), r.out.trim());
  check("round-4 返工注入（第 2 轮，红 2 项）", /round-4[\s\S]*返工注入 #1006（第 2 轮，红 2 项）/.test(r.out), r.out.trim());
  check("round-6 报帅换人（乒乓两轮仍红，第 3 次红判定）", /round-6[\s\S]*报帅：换人 #1006（乒乓两轮仍红——两轮返工后第 3 次红判定）/.test(r.out), r.out.trim());
  check("第 3 次红不再注入返工", !/round-6[\s\S]*返工注入/.test(r.out), r.out.trim());
}

console.log("\n=== ⑩ 制度类 PR 停留超 24h 提醒一声（round-2 不重复提醒）===");
{
  const r = runFlow(path.join(FIXTURES, "stale-24h"));
  check("退出码 1（有提醒）", r.status === 1, `status=${r.status}`);
  check("round-1 提醒制度类超 24h", /round-1[\s\S]*提醒：制度类 PR #1003/.test(r.out), r.out.trim());
  check("round-2 不重复提醒（只提醒一声）", !/round-2[\s\S]*提醒：/.test(r.out), r.out.trim());
  check("round-2 正常 OK 扫完", /round-2[\s\S]*OK 扫完 1 个 PR，0 需流转/.test(r.out), r.out.trim());
}

console.log("\n=== ⑪ MERGED 退役：round-1 在途起审官，round-2 合并 → 退役收口 ===");
{
  const r = runFlow(path.join(FIXTURES, "merged"));
  check("退出码 1（有动作/退役）", r.status === 1, `status=${r.status}`);
  check("round-1 起审官（在途）", /round-1[\s\S]*起审官 #1004/.test(r.out), r.out.trim());
  check("round-2 退役（MERGED 收口，终审+归档归帅）", /round-2[\s\S]*退役：PR #1004 MERGED/.test(r.out), r.out.trim());
}

console.log("\n=== ⑫ 完工 comment 识别变体（真实语料）===");
{
  const positives = [
    "## 完工报告",
    "## 完工自报（pi 工人，model/deepseek-v4-flash，type/写码）",
    "完工，转 ready。",
    "## 完工自报。",
    "## 对抗审返工处置（红 5 项全修，push 9e03606）",
    "## 二轮返工完成，红 4 项逐条处置（补丁 3e49a34 已 push）：",
    "## 三轮返工完成，红 2 项逐条处置（补丁 8e3d6b9 已 push）：",
  ];
  const negatives = [
    "开工。这张 PR 把 2026-08-14 攒在 #443 里的拍板全部落地到三个 skill",
    "## 追加说明（返工后 #452 已 merged 的跟进）",
    "普通评论，没有任何完工标记",
  ];
  for (const p of positives) check(`完工识别 ✓「${p.slice(0, 24)}」`, isCompletionComment(p) === true);
  for (const n of negatives) check(`非完工不识别 ✓「${n.slice(0, 24)}」`, isCompletionComment(n) === false);
}

console.log("\n=== ⑬ 判定行解析与 calibrate 同源（共享模块单一真相源，不复制两份）===");
{
  check("判定：红 5 项 → kind=判定 red=5", JSON.stringify(judgmentFromReview("判定：红 5 项\n正文")) === '{"kind":"判定","red":5,"green":false,"malformed":false}');
  check("复核结论：红 2 项 → kind=复核结论 red=2", JSON.stringify(judgmentFromReview("复核结论：红 2 项")) === '{"kind":"复核结论","red":2,"green":false,"malformed":false}');
  check("复核结论：绿，可合并 → green", JSON.stringify(judgmentFromReview("复核结论：绿，可合并")) === '{"kind":"复核结论","red":null,"green":true,"malformed":false}');
  check("无判定行 → kind=null（报帅不猜）", JSON.stringify(judgmentFromReview("普通 review 正文")) === '{"kind":null,"red":null,"green":false,"malformed":false}');
  check("格式不符「判定：红 项」缺数字 → malformed（报帅不猜红）", judgmentFromReview("判定：红 项\n缺数字").malformed === true);
  check("格式不符「判定：红」无 N 项 → malformed", judgmentFromReview("判定：红").malformed === true);
  check("判定行含绿且无红数 → green（确定性规则：绿优先）", judgmentFromReview("复核结论：绿/红，可合并").green === true);
  check("正文叙述引用他单红数不计（#449 红 1 口径）", judgmentFromReview("比 #440 的红 4 项干净多了\n复核结论：绿").green === true, "叙述里红数不应影响判定");
  const real453 = JSON.parse(fs.readFileSync(path.join(FIXTURES, "real-453", "pr-453-reviews.json"), "utf8"));
  check("真实语料 #453 跨 review 最大红 = 5（复核绿不清零）", redFlagsFromReviewBodies(real453.map(r => r.body)) === 5, "应为 5");
}

console.log("\n=== ⑭ 审官选型序纯函数（docs/model-routing.toml 真相源）===");
{
  const { loadRouting } = require("../scripts/flow.mjs");
  const toml = loadRouting().toml;
  check("deepseek 工人 → gpt-5.6-sol（异厂商 GPT 优先）", pickReviewer(toml, "deepseek-v4-flash", "写码")?.id === "gpt-5.6-sol");
  check("grok 工人 → gpt-5.6-sol（异厂商 GPT 优先）", pickReviewer(toml, "grok-4.6", "写码")?.id === "gpt-5.6-sol");
  check("claude 工人 → gpt-5.6-sol（异厂商）", pickReviewer(toml, "claude-opus", "写码")?.id === "gpt-5.6-sol");
  check("gpt 工人 → claude-opus（审查必换厂商）", pickReviewer(toml, "gpt-5.6-sol", "写码")?.id === "claude-opus");
  check("UI 类 → claude-opus（gpt UI ban 顶位）", pickReviewer(toml, "deepseek-v4-flash", "UI")?.id === "claude-opus");
  check("复审 → claude-opus（gpt UI 类含复审禁入）", pickReviewer(toml, "deepseek-v4-flash", "复审")?.id === "claude-opus");
  check("未知模型 → 不炸，回退 gpt", pickReviewer(toml, "model/不存在", "写码")?.id === "gpt-5.6-sol");
}

console.log("\n=== ⑮ 状态机纯函数 ===");
{
  const done = [{ id: 1, body: "## 完工报告", createdAt: "t0" }];
  const red = [{ id: 2, body: "判定：红 3 项", submittedAt: "t1" }];
  const rework = [{ id: 3, body: "## 对抗审返工处置（全修）", createdAt: "t2" }];
  const green = [{ id: 4, body: "复核结论：绿，可合并", submittedAt: "t3" }];
  const d1 = deriveState(orderedSignals(done, red));
  check("完工+红判定 → rework-needed，红 1 轮", d1.state === "rework-needed" && d1.redReviews === 1 && d1.lastRed === 3);
  check("pendingAction → inject-rework", pendingAction(d1)?.kind === "inject-rework");
  check("pendingShuai 不 gate 注入（待帅记账只管显示，闸已由 fp 去重承担，四轮复核红 1）", pendingAction(d1)?.kind === "inject-rework");
  check("awaitingShuaiReason 读 pendingShuai（reviewer-unfound 常驻）", awaitingShuaiReason({ state: "rework-needed", redReviews: 1 }, { pendingShuai: { kind: "inject-recheck", reason: "找不到审官终端——待帅接手复核" } }, false) === "找不到审官终端——待帅接手复核");
  check("awaitingShuaiReason state 兜底：error 态常驻（四轮复核红 1）", awaitingShuaiReason({ state: "error", redReviews: 0 }, {}, false) === "判定行缺失/格式不符待帅分诊");
  const d4 = deriveState(orderedSignals([...done, ...rework], [...red, ...green]));
  check("复核绿 → approved → report-final", d4.state === "approved" && pendingAction(d4)?.kind === "report-final");
  check("制度类识别：正文含「体系类改动」", isInstitutional({ body: "## 体系类改动（必答）", title: "x" }) === true);
  check("制度类识别：标题含「制度/体系」", isInstitutional({ body: "## 目标", title: "[pi] 制度修订" }) === true);
  check("标题仅含「拍板」不再误判制度类（对抗审观察 7）", isInstitutional({ body: "## 目标", title: "[pi] 修复 xx 拍板口径" }) === false);
  check("非制度类不识别", isInstitutional({ body: "## 目标", title: "写码 PR" }) === false);
}

console.log("\n=== ⑯ 红 2：存量审官反查——帅手起审官、流转器后启动，复核注入仍能找到审官终端 ===");
{
  const r = runFlow(path.join(FIXTURES, "recheck-reviewer"));
  check("退出码 1（有动作）", r.status === 1, `status=${r.status}`);
  check("复核注入动作（存量场景不退化报帅）", /动作：复核注入 #2001（第 1 轮返工后）/ .test(r.out), r.out.trim());
  check("通过「审官· 子卡」反查找到审官终端", /复核目标：审官终端 term_reviewer_2001，存量反查（审官· 子卡）/.test(r.out), r.out.trim());
  check("没有报帅（不是当注入失败）", !/报帅：/.test(r.out), r.out.trim());
}

console.log("\n=== ⑰ 红 4：同一 worktree 多终端选不出唯一 → 报帅不挑第一个 ===");
{
  const r = runFlow(path.join(FIXTURES, "multi-terminal"));
  check("退出码 1（有输出）", r.status === 1, `status=${r.status}`);
  check("明确「选不出唯一注入目标——请帅指定，不挑第一个」", /选不出唯一注入目标——请帅指定，不挑第一个/.test(r.out), r.out.trim());
  check("没有注入到任一终端（不挑第一个）", !/注入目标：工人终端 term_a_2002/.test(r.out) && !/注入目标：工人终端 term_b_2002/.test(r.out), r.out.trim());
  check("解析失败用「预览-阻塞：」前缀而非「动作：」（观察 1）", !/动作：/.test(r.out), r.out.trim());
}

console.log("\n=== ⑰b 三轮复核红 1：dry-run 不落 blocked 闸（预览不污染值守状态）——A 实验组 round-2 恢复注入 ===");
{
  const r = runFlow(path.join(FIXTURES, "blocked-recover"));
  check("退出码 1（有动作/阻塞）", r.status === 1, `status=${r.status}`);
  check("round-1 预览-阻塞（选不出唯一）", /round-1[\s\S]*预览-阻塞：#2005（返工注入/.test(r.out), r.out.trim());
  check("round-1 本轮待帅确认（可见但不落闸）", /round-1[\s\S]*待帅处置：#2005（注入\/目标解析失败待帅确认（本轮，未落闸））/.test(r.out), r.out.trim());
  check("round-2 终端修好 + 新红判定 → 恢复注入（第 2 轮，不再被旧阻塞吞掉）", /round-2[\s\S]*动作：返工注入 #2005（第 2 轮，红 2 项）（注入目标：工人终端 term_x_2005）/.test(r.out), r.out.trim());
  check("round-2 不再有预览-阻塞", !/round-2[\s\S]*预览-阻塞/.test(r.out), r.out.trim());
}

console.log("\n=== ⑰c 四轮复核红 1：live 落闸自愈——预置 pendingShuai，新红判定到达即清除重试一次 ===");
{
  // 预置状态模拟 live 注入失败落记账（pendingShuai + 旧指纹）；夹具里有更新的红判定
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-selfheal-"));
  const stateFile = path.join(tmp, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1, inventoried: true,
    records: {
      "2006": { pr: 2006, seenComments: { 240001: true }, seenReviews: { 340001: true }, pendingShuai: { kind: "inject-rework", reason: "注入失败待帅接手（新信号到来自动重试一次）" }, reportedMalformed: {}, reportedStale: false, actedOn: "rework-needed|1|r:340001", reviewer: null, workerWorktree: null },
    },
  }), "utf8");
  const r = spawnSync(process.execPath, [FLOW, "--snapshot-dir", path.join(FIXTURES, "blocked-selfheal"), "--state-file", stateFile, "--dry-run"], { encoding: "utf8", cwd: REPO });
  const out = (r.stdout || "") + (r.stderr || "");
  check("新红判定到达 → pendingShuai 清除并恢复注入（第 2 轮，红 2 项）", /动作：返工注入 #2006（第 2 轮，红 2 项）（注入目标：工人终端 term_worker_2006）/.test(out), out.trim());
  check("不再挂注入失败待帅处置", !/待帅处置：#2006（注入失败/.test(out), out.trim());
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n=== ⑰d 四轮复核红 1：reviewer-unfound 常驻——审官找不到，连跑三轮每轮都有待帅处置 ===");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-unfound-"));
  const stateFile = path.join(tmp, "state.json");
  const args = [FLOW, "--snapshot-dir", path.join(FIXTURES, "reviewer-unfound"), "--state-file", stateFile, "--dry-run"];
  const r1 = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
  const r2 = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
  const r3 = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
  const out1 = (r1.stdout || "") + (r1.stderr || "");
  const out2 = (r2.stdout || "") + (r2.stderr || "");
  const out3 = (r3.stdout || "") + (r3.stderr || "");
  check("首跑 exit 1（报帅 + 待帅处置）", r1.status === 1, `status=${r1.status}`);
  check("首跑报帅找不到审官终端（待帅接手复核）", /报帅：找不到审官终端.*待帅接手复核/.test(out1), out1.trim());
  check("二跑仍 exit 1（常驻不转绿）", r2.status === 1, `status=${r2.status}`);
  check("二跑仍有待帅处置（找不到审官终端）", /待帅处置：#2007（找不到审官终端——待帅接手复核）/.test(out2), out2.trim());
  check("三跑仍常驻", /待帅处置：#2007（找不到审官终端——待帅接手复核）/.test(out3), out3.trim());
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n=== ⑱ 红 5：--parent-worktree 用合法 selector（branch:，不是 name:）===");
{
  const r = runFlow(path.join(FIXTURES, "real-456"));
  check("起审官命令用 branch:<headRefName> selector", /--parent-worktree branch:thoerwink8\/点将台实现/.test(r.out), r.out.trim());
  check("不再用 name: selector（不是 orca 认识的 worktree selector）", !/--parent-worktree name:/.test(r.out), r.out.trim());
  check("oneShot 走官方首注入通道 --prompt（免就绪竞态）", /--agent codex --prompt <复核任务书> --json/.test(r.out), r.out.trim());
  check("审官卡名按全局约定 #PR号 - 角色·模型（观察 3）", /--name "#456 - 审官·gpt-5.6-sol"/.test(r.out), r.out.trim());
}

console.log("\n=== ⑲ 复核红 1：review 链接必须可用（数字锚点 id，不是 GraphQL node id）===");
{
  const r = runFlow(path.join(FIXTURES, "fake-loop"));
  check("返工指令链接是数字锚点形态（无 PRR_ node-id）", /pull\/999#pullrequestreview-910001/.test(r.out) && !/pull\/999#pullrequestreview-PRR_/.test(r.out), r.out.trim());
  // 真实语料夹具改走 gh api 口径（数字 id + html_url），镜像 live 数据形态
  const real453 = JSON.parse(fs.readFileSync(path.join(FIXTURES, "real-453", "pr-453-reviews.json"), "utf8"));
  check("real-453 语料 id 全是数字锚点（无 PRR_ node-id）", real453.every(x => /^\d+$/.test(String(x.id))), real453.map(x => x.id).join(","));
  check("real-453 语料 html_url 现成（live 口径镜像）", real453.every(x => /^https:\/\/github\.com\/.+pullrequestreview-\d+$/.test(x.html_url || "")), real453.map(x => x.html_url).join(","));
  check("real-453 语料 3 条 review body 未改写（判定行口径仍成立）", redFlagsFromReviewBodies(real453.map(x => x.body)) === 5, "应为 5");
}

console.log("\n=== ⑳ 敏感路径越权报警（fusion-verdict 2026-08-15：diff 触碰敏感路径且正文未声明 → 报警行）===");
{
  const { sensitiveEscalations } = require("../scripts/flow.mjs");
  check("纯函数：host/skills + dao-check 未声明 → 2 条", sensitiveEscalations({ body: "## 目标" }, ["host/skills/dispatch/SKILL.md", "scripts/dao-check.mjs"]).length === 2);
  check("纯函数：正文声明过 → 0 条", sensitiveEscalations({ body: "改动 host/skills/dispatch/SKILL.md 与 scripts/dao-check.mjs" }, ["host/skills/dispatch/SKILL.md", "scripts/dao-check.mjs"]).length === 0);
  check("纯函数：CLAUDE.md 与 docs/global-CLAUDE.md 分开算（声明 CLAUDE.md 不覆盖 global）", JSON.stringify(sensitiveEscalations({ body: "只声明 CLAUDE.md" }, ["CLAUDE.md", "docs/global-CLAUDE.md"]).map(v => v.rule)) === '["docs/global-CLAUDE.md"]');
  check("纯函数：正文只提 docs/global-CLAUDE.md 不覆盖根 CLAUDE.md（审读红 2 负控：仍须报根）", JSON.stringify(sensitiveEscalations({ body: "改了 docs/global-CLAUDE.md" }, ["CLAUDE.md"]).map(v => v.rule)) === '["CLAUDE.md"]');
  check("纯函数：正文提根 CLAUDE.md 且只动根 → 不报", sensitiveEscalations({ body: "改了根 CLAUDE.md" }, ["CLAUDE.md"]).length === 0);
  check("纯函数：未触碰敏感路径 → 0 条", sensitiveEscalations({ body: "## 目标" }, ["scripts/flow.mjs", "docs/model-routing.toml"]).length === 0);

  const r = runFlow(path.join(FIXTURES, "sensitive-undeclared"));
  check("退出码 1（有报警）", r.status === 1, `status=${r.status}`);
  check("报警 host/skills/ 越权（含命中文件）", /报警：敏感路径越权 #3002（diff 触碰 host\/skills\/——host\/skills\/dispatch\/SKILL\.md，正文未声明）/.test(r.out), r.out.trim());
  check("报警 dao-check 越权", /报警：敏感路径越权 #3002（diff 触碰 scripts\/dao-check\.mjs——scripts\/dao-check\.mjs，正文未声明）/.test(r.out), r.out.trim());
  check("不打出 OK 扫完（有报警不是无事）", !/OK 扫完/.test(r.out), r.out.trim());

  const rd = runFlow(path.join(FIXTURES, "sensitive-declared"));
  check("声明过 → 退出码 0（无报警）", rd.status === 0, `status=${rd.status}`);
  check("声明过 → OK 扫完", /OK 扫完 1 个 PR，0 需流转/.test(rd.out), rd.out.trim());
  check("声明过 → 无报警行", !/报警：/.test(rd.out), rd.out.trim());
}

console.log("\n=== ⑳b 敏感路径越权报警持续显形：同状态重跑仍报警（待办不因报过一次就转绿）===");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-sensitive-"));
  const stateFile = path.join(tmp, "state.json");
  const args = [FLOW, "--snapshot-dir", path.join(FIXTURES, "sensitive-undeclared"), "--state-file", stateFile, "--dry-run"];
  const r1 = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
  const r2 = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
  const out1 = (r1.stdout || "") + (r1.stderr || "");
  const out2 = (r2.stdout || "") + (r2.stderr || "");
  check("首跑 exit 1（报警）", r1.status === 1, `status=${r1.status}`);
  check("重跑仍 exit 1（每轮重算，违规持续则持续报警）", r2.status === 1, `status=${r2.status}`);
  check("重跑仍有报警行", /报警：敏感路径越权 #3002/.test(out2), out2.trim());
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n流转器回归网：${pass} 过 / ${fail} 红`);
process.exit(fail > 0 ? 1 : 0);
