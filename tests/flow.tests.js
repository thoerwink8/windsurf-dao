// 闭环自动流转器回归网（issue #455/#480/#478）——正控 + 负控 + 判别力
//
// 验的层：①真实语料（#453/#456 实录）推导当前态并给出正确动作/报帅 ②假闭环验收
// （draft PR + 假判定行 review → 自动注入下一环且帅零介入）③prime 吞存量负控
// （存量已有完工+红判定的 PR 启动即识别并注入返工，不被吞）④重启不重复动作负控
// （同状态文件重跑零动作）⑤判定行缺失负控（报帅、不猜红绿、区分没查成与无需流转）
// ⑥乒乓标注驱动换人（同一处未修好 → 报帅换人，不自动换）⑦复核绿 → 合并门（三条件）
// ⑧审官选型序 ⑨MERGED 退役 ⑩完工 comment 识别变体 ⑪judgment 解析与 calibrate 同源
// ⑫上帅（review 行 / 原生 escalation / 六轮兜底）⑬合并打回人工（冲突/失败）
// ⑭反例回归样本（正文引用代码块含「判定：绿」不得算数）⑮双通道等价（原生消息 vs
// GitHub 兜底，动作一致且只动作一次）⑯heartbeat 落盘 ⑰--explain。
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
const { deriveState, pendingAction, pickReviewer, orderedSignals, isInstitutional, awaitingShuaiReason, mergeGate, ciState, mergeableVerdict, greenCommitVerdict, extractPrsFromSpec, runCmd, taskIdFromTaskCreate, handleFromWorkerShow, worktreeIdFromWorktreeCreate, terminalHandleFromTerminalCreate, dispatchIdFromDispatchShow } = require("../scripts/flow.mjs");
const { judgmentFromReview, isCompletionComment, redFlagsFromReviewBodies, reviewAnnotations, mergePolicyFromComment, SHANG_SHUAI_LINE_RE, SAME_SPOT_LINE_RE, NEW_INTRODUCED_LINE_RE } = require("../scripts/lib/judgment.mjs");

let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + String(detail).trim().slice(0, 400) : ""}`); }
}
// 显形跳过（#497 第五轮帅补正）：依赖本机 orca 的行为断言在 CI/无 orca 机器上必须 SKIP——
// 不算过也不算红，计入跳过数。分不清「查过没事」和「没查成」正是仓规禁的形态。
function skipCheck(name, detail) {
  skip++;
  console.log(`  SKIP  ${name}${detail ? "  →  " + String(detail).trim().slice(0, 200) : ""}`);
}

function runFlow(dir, extraArgs = []) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-test-"));
  const stateFile = path.join(tmp, "state.json");
  const hbFile = path.join(tmp, "heartbeat.json");
  const r = spawnSync(process.execPath, [FLOW, "--snapshot-dir", dir, "--state-file", stateFile, "--heartbeat-file", hbFile, "--dry-run", ...extraArgs], {
    encoding: "utf8", cwd: REPO,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const heartbeat = fs.existsSync(hbFile) ? JSON.parse(fs.readFileSync(hbFile, "utf8")) : null;
  fs.rmSync(tmp, { recursive: true, force: true });
  return { status: r.status, out, heartbeat };
}

function runFlowShared(dir, stateFile, hbFile, extraArgs = []) {
  return spawnSync(process.execPath, [FLOW, "--snapshot-dir", dir, "--state-file", stateFile, "--heartbeat-file", hbFile, "--dry-run", ...extraArgs], {
    encoding: "utf8", cwd: REPO,
  });
}

console.log("\n=== ① 假闭环验收（#455 验收：draft PR + 完工 + 假判定行 review → 自动注入下一环且帅零介入）===");
{
  const r = runFlow(path.join(FIXTURES, "fake-loop"));
  check("退出码 1（有动作）", r.status === 1, `status=${r.status}`);
  check("自动注入发生：返工走 task-create + worker-start --terminal（非预览-阻塞）", /动作：返工注入 #999（第 1 轮，红 3 项）：task-create \+ worker-start --task <新> --terminal term_worker_999/.test(r.out), r.out.trim());
  check("返工注入不再用 send --to dispatch（收件箱不是推送，#480 实测纠正）", !/send --to dispatch/.test(r.out), r.out.trim());
  check("返工指令文本含 review 链接", /pull\/999#pullrequestreview-910001/.test(r.out), "review 链接没进指令");
  check("帅零介入：无任何 报帅 行（真注入路径下成立，名副其实）", !/报帅/.test(r.out), r.out.split("\n").filter(l => /报帅/.test(l)).join(" | "));
  check("不重复起审官（红判定已存在 → 不新建审官）", !/起审官/.test(r.out), r.out.trim());
}

console.log("\n=== ② prime 吞存量负控：存量已有完工+红判定，启动即动作（不吞存量）===");
{
  const r = runFlow(path.join(FIXTURES, "fake-loop"));
  check("存量信号被识别并自动注入返工（吞存量 = 本轮无动作）", /动作：返工注入 #999（第 1 轮，红 3 项）：task-create \+ worker-start --task <新> --terminal term_worker_999/.test(r.out), r.out.trim());
  check("打出存量清点标记（先清点再增量）", /存量清点/.test(r.out), "存量清点标记缺失");
}

console.log("\n=== ③ 重启不重复动作负控：同状态文件重跑 → 零动作 ===");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-restart-"));
  const stateFile = path.join(tmp, "state.json");
  const hbFile = path.join(tmp, "heartbeat.json");
  const r1 = runFlowShared(path.join(FIXTURES, "fake-loop"), stateFile, hbFile);
  const r2 = runFlowShared(path.join(FIXTURES, "fake-loop"), stateFile, hbFile);
  const out2 = (r2.stdout || "") + (r2.stderr || "");
  check("首跑退出码 1（有动作）", r1.status === 1, `status=${r1.status}`);
  check("重跑退出码 0（无动作）", r2.status === 0, `status=${r2.status}`);
  check("重跑打出 OK 扫完（同指纹不重复动作）", /OK 扫完 1 个 PR，0 需流转/.test(out2), out2.trim());
  check("重跑无任何 动作/报帅 行", !/动作：|报帅：/.test(out2), out2.trim());
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n=== ④ 真实语料 #453（实录：判定红5→复核红2→复核绿 → 报帅终审，不自动合）===");
{
  const r = runFlow(path.join(FIXTURES, "real-453"));
  check("退出码 1（有报帅）", r.status === 1, `status=${r.status}`);
  check("复核绿无 merge/auto 标签 → 报帅终审（缺一不合）", /报帅：终审 #453（复核结论：绿，无 merge\/auto 标签——等用户终审(；mergeable 还在算，下轮重查)?）/.test(r.out), r.out.trim());
  check("终审不自动合并（无 动作： 行）", !/动作：/.test(r.out), r.out.trim());
  check("同时打出待帅处置（等用户终审）", /待帅处置：#453（复核绿待帅终审（无 merge\/auto 标签——等用户终审(；mergeable 还在算)?））/.test(r.out), r.out.trim());
  check("真实语料判定行解析：#453 首审红 5 项", redFlagsFromReviewBodies([JSON.parse(fs.readFileSync(path.join(FIXTURES, "real-453", "pr-453-reviews.json"), "utf8"))[0].body]) === 5, "红项数应为 5");
}

console.log("\n=== ⑤ 真实语料 #456（实录：完工自报×2 重复 → 起审官一次，选型序 deepseek→gpt）===");
{
  const r = runFlow(path.join(FIXTURES, "real-456"));
  check("退出码 1（有动作）", r.status === 1, `status=${r.status}`);
  check("完工自报 → 起审官", /动作：起审官 #456/.test(r.out), r.out.trim());
  check("审官选型序：deepseek 工人 → gpt-5.6-sol（异厂商 GPT 优先）", /审官·gpt-5.6-sol/.test(r.out), r.out.trim());
  check("起审官走 task-create + worker-start（--agent codex --model gpt-5.6-sol）", /orca orchestration worker-start --task <task_id> --worktree current --agent codex --model gpt-5.6-sol --json/.test(r.out), r.out.trim());
  check("不再走 worktree create --agent --prompt（#480 受控例外退役）", !/worktree create.*--agent codex --prompt/.test(r.out), r.out.trim());
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
  const hbFile = path.join(tmp, "heartbeat.json");
  const r1 = runFlowShared(path.join(FIXTURES, "malformed"), stateFile, hbFile);
  const r2 = runFlowShared(path.join(FIXTURES, "malformed"), stateFile, hbFile);
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

console.log("\n=== ⑧ 完整闭环四轮：完工→起审官 / 红→返工 / 返工完成→复核 / 复核绿→终审（全部真通）===");
{
  const r = runFlow(path.join(FIXTURES, "recheck-green"));
  check("退出码 1（有动作/报帅）", r.status === 1, `status=${r.status}`);
  check("round-1 起审官（task-create + worker-start）", /round-1[\s\S]*动作：起审官 #1005/.test(r.out), r.out.trim());
  check("round-2 返工注入真通（worker-start --terminal 推闲置工人）", /round-2[\s\S]*动作：返工注入 #1005（第 1 轮，红 2 项）：task-create \+ worker-start --task <新> --terminal term_worker_1005/.test(r.out), r.out.trim());
  check("round-3 复核注入真通（审官 handle）", /round-3[\s\S]*动作：复核注入 #1005（第 1 轮返工后）：task-create \+ worker-start --task <新> --terminal term_reviewer_1005/.test(r.out), r.out.trim());
  check("round-4 报帅终审（无 merge/auto → 等用户终审）", /round-4[\s\S]*报帅：终审 #1005（复核结论：绿，无 merge\/auto 标签——等用户终审(；mergeable 还在算，下轮重查)?）/.test(r.out), r.out.trim());
  check("复核绿后不再注入任何动作", !/round-4[\s\S]*动作：/.test(r.out), r.out.trim());
}

console.log("\n=== ⑨ 审官标注驱动换人：round-2/4 红自动返工；round-6 标「同一处未修好」→ 报帅换人（不自动换）===");
{
  const r = runFlow(path.join(FIXTURES, "pingpong"));
  check("退出码 1（有动作/报帅）", r.status === 1, `status=${r.status}`);
  check("round-2 返工注入（第 1 轮，红 3 项）", /round-2[\s\S]*返工注入 #1006（第 1 轮，红 3 项）/.test(r.out), r.out.trim());
  check("round-4 返工注入（第 2 轮，红 2 项，无标注不换人）", /round-4[\s\S]*返工注入 #1006（第 2 轮，红 2 项）/.test(r.out), r.out.trim());
  check("round-6 报帅换人（审官标「同一处未修好」）", /round-6[\s\S]*报帅：换人 #1006（审官标注「同一处未修好」，第 3 次红判定）/.test(r.out), r.out.trim());
  check("round-6 不再注入返工（换人信号停手）", !/round-6[\s\S]*返工注入/.test(r.out), r.out.trim());
}

console.log("\n=== ⑨b 六轮红判定硬兜底：第 6 次红 → 上帅（不自动换人）===");
{
  const r = runFlow(path.join(FIXTURES, "six-rounds"));
  check("退出码 1（有报帅）", r.status === 1, `status=${r.status}`);
  check("六轮兜底 → 报帅上帅", /报帅：上帅 #3304（六轮红判定兜底上帅（第 6 次红判定，不自动换人））/.test(r.out), r.out.trim());
  check("不再注入返工（上帅停手）", !/动作：/.test(r.out), r.out.trim());
  check("待帅处置常驻", /待帅处置：#3304（六轮红判定兜底上帅/.test(r.out), r.out.trim());
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
  check("round-2 退役（MERGED 收口）", /round-2[\s\S]*退役：PR #1004 MERGED/.test(r.out), r.out.trim());
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

console.log("\n=== ⑬b 审官标注行解析（#480：上帅：/同一处未修好/新引入，行首锚定不搜全文）===");
{
  const a1 = reviewAnnotations("判定：红 2 项\n上帅：规格本身有疑问");
  check("上帅：行 → shangShuai=原因", a1.shangShuai === "规格本身有疑问", JSON.stringify(a1));
  check("上帅：无原因 → 占位", reviewAnnotations("上帅：").shangShuai === "（未写原因）");
  check("** 前缀也可（同判定行口径）", reviewAnnotations("**上帅：** 需求不成立").shangShuai === "** 需求不成立" || reviewAnnotations("**上帅：** 需求不成立").shangShuai === "需求不成立", JSON.stringify(reviewAnnotations("**上帅：** 需求不成立")));
  check("同一处未修好 → sameSpot", reviewAnnotations("复核结论：红 1 项\n同一处未修好").sameSpot === true);
  check("新引入 → newIntroduced", reviewAnnotations("复核结论：红 2 项\n新引入").newIntroduced === true);
  check("正文引用「上帅：」不算（行首锚定）", reviewAnnotations("他单上帅：xxx 的 review 里……").shangShuai === null, JSON.stringify(reviewAnnotations("他单上帅：xxx 的 review 里……")));
  check("代码块引用「同一处未修好」不算（行首锚定）", reviewAnnotations('```\nif (x === "同一处未修好") {}\n```').sameSpot === false);
  check("正则导出可用（测试与 calibrate 引用）", SHANG_SHUAI_LINE_RE.test("上帅：x") && SAME_SPOT_LINE_RE.test("同一处未修好") && NEW_INTRODUCED_LINE_RE.test("新引入"));
  check("merge-policy:auto 行首 → auto", mergePolicyFromComment("merge-policy:auto · model:gpt-5.6-sol · reviewer:gpt-5.6-sol") === "auto");
  check("merge-policy:manual → manual", mergePolicyFromComment("merge-policy:manual · model:X") === "manual");
  check("备注被覆写成人话（master 真备注语料）→ null", mergePolicyFromComment("主会话：对话/派单/终审。在途：#439 #440 待复审、#441 在审+补丁") === null);
  check("空备注 → null（安全默认）", mergePolicyFromComment("") === null);
  check("值不在词表（auto|manual）→ null", mergePolicyFromComment("merge-policy:maybe · model:X") === null);
  check("正文叙述引用不算（字段锚定，非搜全文）", mergePolicyFromComment("之前的 merge-policy:auto 作废了") === null);
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

console.log("\n=== ⑮ 状态机纯函数（含 #480 新态：switch / shang-shuai / 六轮兜底）===");
{
  const done = [{ id: 1, body: "## 完工报告", createdAt: "t0" }];
  const red = [{ id: 2, body: "判定：红 3 项", submittedAt: "t1" }];
  const rework = [{ id: 3, body: "## 对抗审返工处置（全修）", createdAt: "t2" }];
  const green = [{ id: 4, body: "复核结论：绿，可合并", submittedAt: "t3" }];
  const d1 = deriveState(orderedSignals(done, red));
  check("完工+红判定 → rework-needed，红 1 轮", d1.state === "rework-needed" && d1.redReviews === 1 && d1.lastRed === 3);
  check("pendingAction → inject-rework", pendingAction(d1)?.kind === "inject-rework");
  check("复核绿 → approved → merge-gate", deriveState(orderedSignals([...done, ...rework], [...red, ...green])).state === "approved" && pendingAction(deriveState(orderedSignals([...done, ...rework], [...red, ...green])))?.kind === "merge-gate");
  // 标注驱动
  const sameSpot = [{ id: 5, body: "复核结论：红 1 项\n同一处未修好", submittedAt: "t4" }];
  const dSwitch = deriveState(orderedSignals([...done, ...rework], [...red, ...sameSpot]));
  check("同一处未修好 → switch → report-switch", dSwitch.state === "switch" && pendingAction(dSwitch)?.kind === "report-switch");
  const shang = [{ id: 6, body: "上帅：规格有疑问", submittedAt: "t5" }];
  const dShang = deriveState(orderedSignals([...done, ...rework], [...red, ...sameSpot, ...shang]));
  check("上帅：行 → shang-shuai（不再自动流转，pendingAction=null）", dShang.state === "shang-shuai" && pendingAction(dShang) === null);
  const dAfterResolve = deriveState(orderedSignals([...done, ...rework], [...red, ...sameSpot, { id: 9, body: "复核结论：绿，可合并", submittedAt: "t9" }]));
  check("旧标注不粘：同一处未修好之后审官再判绿 → 恢复 approved", dAfterResolve.state === "approved", JSON.stringify(dAfterResolve));
  const dNoAnn = deriveState(orderedSignals([...done], [{ id: 7, body: "上帅：规格有疑问", submittedAt: "t6" }, { id: 8, body: "复核结论：绿，可合并", submittedAt: "t7" }]));
  check("旧上帅不粘：上帅后审官判绿 → 恢复 approved", dNoAnn.state === "approved", JSON.stringify(dNoAnn));
  // 六轮兜底
  const sixReds = [];
  for (let i = 0; i < 6; i++) sixReds.push({ id: 100 + i, body: i === 0 ? "判定：红 1 项" : `复核结论：红 ${i + 1} 项`, submittedAt: `t${i}` });
  const d6 = deriveState(orderedSignals(done, sixReds));
  check("6 次红判定 → shang-shuai（六轮硬兜底，不自动换人）", d6.state === "shang-shuai" && d6.redReviews === 6, JSON.stringify(d6));
  const d5 = deriveState(orderedSignals(done, sixReds.slice(0, 5)));
  check("5 次红判定还不到兜底 → rework-needed", d5.state === "rework-needed" && d5.redReviews === 5);
  check("pendingShuai 不 gate 注入（待帅记账只管显示，闸已由 fp 去重承担）", pendingAction(d1)?.kind === "inject-rework");
  check("awaitingShuaiReason 读 pendingShuai（reviewer-unfound 常驻）", awaitingShuaiReason({ state: "rework-needed", redReviews: 1 }, { pendingShuai: { kind: "inject-recheck", reason: "找不到投递目标 dispatch——待帅转交" } }, false) === "找不到投递目标 dispatch——待帅转交");
  check("awaitingShuaiReason state 兜底：error 态常驻", awaitingShuaiReason({ state: "error", redReviews: 0 }, {}, false) === "判定行缺失/格式不符待帅分诊");
  check("awaitingShuaiReason shang-shuai 带原因（上帅：行）", awaitingShuaiReason({ state: "shang-shuai", redReviews: 2, latestAnnotation: { shangShuai: "规格有疑问" } }, {}, false) === "上帅：规格有疑问——停手叫人，不再自动流转");
  check("awaitingShuaiReason 六轮带轮次", awaitingShuaiReason({ state: "shang-shuai", redReviews: 6, latestAnnotation: null }, {}, false) === "六轮红判定兜底上帅（第 6 次红判定）——停手叫人，不自动换人");
  check("awaitingShuaiReason approved 已发起合并 → 不欠待帅", awaitingShuaiReason({ state: "approved", redReviews: 1 }, { mergeAttempted: true, mergeBlocked: false, pendingShuai: null }, false) === null);
  check("制度类识别：正文含「体系类改动」", isInstitutional({ body: "## 体系类改动（必答）", title: "x" }) === true);
  check("制度类识别：标题含「制度/体系」", isInstitutional({ body: "## 目标", title: "[pi] 制度修订" }) === true);
  check("标题仅含「拍板」不再误判制度类（对抗审观察 7）", isInstitutional({ body: "## 目标", title: "[pi] 修复 xx 拍板口径" }) === false);
  check("非制度类不识别", isInstitutional({ body: "## 目标", title: "写码 PR" }) === false);
}

console.log("\n=== ⑮b 合并门纯函数（三条件硬查 + 等你撤回 + CI 0 条 ≠ 全绿）===");
{
  const mk = (labels, rollup, extra = {}) => ({ labels: labels.map(n => ({ name: n })), isDraft: false, statusCheckRollup: rollup, ...extra });
  const okCi = { count: 1, allGreen: true, redNames: "" };
  const zeroCi = { count: 0, allGreen: false, redNames: "" };
  const redCi = { count: 2, allGreen: false, redNames: "check" };
  check("三条件齐 → ok", mergeGate(mk(["merge/auto"], [{ conclusion: "SUCCESS" }]), okCi).ok === true);
  check("无 merge/auto → 缺一不合（等用户终审）", mergeGate(mk([], [{ conclusion: "SUCCESS" }]), okCi).ok === false && /merge\/auto/.test(mergeGate(mk([], [{ conclusion: "SUCCESS" }]), okCi).reason));
  check("带等你 → 撤回不合（最高优先）", mergeGate(mk(["merge/auto", "等你"], [{ conclusion: "SUCCESS" }]), okCi).reason.includes("等你"));
  check("CI 0 条 check → 没查成≠全绿", mergeGate(mk(["merge/auto"], []), zeroCi).reason.includes("0 条 check"));
  check("CI 有红 → 不合", mergeGate(mk(["merge/auto"], [{ conclusion: "FAILURE" }]), redCi).reason.includes("CI 未全绿"));
  check("ciState：全 SUCCESS 且 ≥1 → 绿", ciState([{ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }]).allGreen === true);
  check("ciState：0 条 → 不绿（数到 0 ≠ 没扫到）", ciState([]).allGreen === false && ciState([]).count === 0);
  check("ciState：PENDING → 不绿", ciState([{ status: "PENDING" }]).allGreen === false);
  check("ciState：StatusContext 形态（state 字段）", ciState([{ state: "SUCCESS" }]).allGreen === true);
  check("mergeable MERGEABLE → 可合", mergeableVerdict("MERGEABLE", "CLEAN").ok === true);
  check("mergeable CONFLICTING → 打回", mergeableVerdict("CONFLICTING", "DIRTY").ok === false && !mergeableVerdict("CONFLICTING", "DIRTY").wait);
  check("mergeable UNKNOWN → 下轮重查（不打回误伤瞬态）", mergeableVerdict("UNKNOWN", "UNKNOWN").wait === true);
  check("spec 提取 PR 号", JSON.stringify(extractPrsFromSpec("审官任务：#456 - 审官·gpt。任务 PR：#456")) === "[456]");
  check("spec 多号去重", JSON.stringify(extractPrsFromSpec("Closes #480 #478")) === "[480,478]");
}

console.log("\n=== ⑯ dispatch 寻址：存量审官任务卡反查（task-list spec 含审官任务标记）===");
{
  const r = runFlow(path.join(FIXTURES, "recheck-reviewer"));
  check("退出码 1（有动作）", r.status === 1, `status=${r.status}`);
  check("复核注入动作（存量场景不退化报帅）", /动作：复核注入 #2001（第 1 轮返工后）：task-create \+ worker-start --task <新> --terminal term_reviewer_2001/.test(r.out), r.out.trim());
  check("没有报帅（不是当注入失败）", !/报帅：/.test(r.out), r.out.trim());
}

console.log("\n=== ⑰ dispatch 映射不出 → 退回 GitHub 通道：返工投递缺工人 dispatch → 预览-阻塞，不报错停手 ===");
{
  const r = runFlow(path.join(FIXTURES, "blocked-recover"));
  check("退出码 1（有输出）", r.status === 1, `status=${r.status}`);
  check("round-1 预览-阻塞（找不到工人 dispatch）", /round-1[\s\S]*预览-阻塞：#2005（返工注入——投递目标解析失败：找不到工人 dispatch）/.test(r.out), r.out.trim());
  check("round-1 本轮待帅确认（可见但不落闸）", /round-1[\s\S]*待帅处置：#2005（投递\/目标解析失败待帅确认（本轮，未落闸））/.test(r.out), r.out.trim());
  check("round-2 dispatch 就位 + 新红判定 → 恢复注入（第 2 轮）", /round-2[\s\S]*动作：返工注入 #2005（第 2 轮，红 2 项）：task-create \+ worker-start --task <新> --terminal term_worker_2005/.test(r.out), r.out.trim());
  check("round-2 不再有预览-阻塞", !/round-2[\s\S]*预览-阻塞/.test(r.out), r.out.trim());
}

console.log("\n=== ⑰b 自愈：预置 pendingShuai，新红判定到达即清除重试一次 ===");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-selfheal-"));
  const stateFile = path.join(tmp, "state.json");
  const hbFile = path.join(tmp, "heartbeat.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1, inventoried: true, round: 0, dispatchCache: {},
    records: {
      "2006": { pr: 2006, seenComments: { 240001: true }, seenReviews: { 340001: true }, pendingShuai: { kind: "inject-rework", reason: "投递失败待帅接手（新信号到来自动重试一次）" }, reportedMalformed: {}, reportedStale: false, actedOn: "rework-needed|1|r:340001", reviewer: null, escalated: null, mergeAttempted: false, mergeBlocked: false, stateSince: Date.now() },
    },
  }), "utf8");
  const r = runFlowShared(path.join(FIXTURES, "blocked-selfheal"), stateFile, hbFile);
  const out = (r.stdout || "") + (r.stderr || "");
  check("新红判定到达 → pendingShuai 清除并恢复注入（第 2 轮，红 2 项）", /动作：返工注入 #2006（第 2 轮，红 2 项）：task-create \+ worker-start --task <新> --terminal term_worker_2006/.test(out), out.trim());
  check("不再挂投递失败待帅处置", !/待帅处置：#2006（投递失败/.test(out), out.trim());
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n=== ⑰c reviewer-unfound 常驻：审官 dispatch 找不到，连跑三轮每轮都有待帅处置 ===");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-unfound-"));
  const stateFile = path.join(tmp, "state.json");
  const hbFile = path.join(tmp, "heartbeat.json");
  const r1 = runFlowShared(path.join(FIXTURES, "reviewer-unfound"), stateFile, hbFile);
  const r2 = runFlowShared(path.join(FIXTURES, "reviewer-unfound"), stateFile, hbFile);
  const r3 = runFlowShared(path.join(FIXTURES, "reviewer-unfound"), stateFile, hbFile);
  const out1 = (r1.stdout || "") + (r1.stderr || "");
  const out2 = (r2.stdout || "") + (r2.stderr || "");
  const out3 = (r3.stdout || "") + (r3.stderr || "");
  check("首跑 exit 1（报帅 + 待帅处置）", r1.status === 1, `status=${r1.status}`);
  check("首跑报帅找不到审官 dispatch（待帅接手复核）", /报帅：找不到审官 dispatch.*待帅接手复核/.test(out1), out1.trim());
  check("二跑仍 exit 1（常驻不转绿）", r2.status === 1, `status=${r2.status}`);
  check("二跑仍有待帅处置（找不到投递目标 dispatch）", /待帅处置：#2007（找不到投递目标 dispatch——待帅转交）/.test(out2), out2.trim());
  check("三跑仍常驻", /待帅处置：#2007（找不到投递目标 dispatch——待帅转交）/.test(out3), out3.trim());
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n=== ⑱ 启动序：#480 受控例外退役——起审官一律 worker-start（dispatch 身份硬要求）===");
{
  const r = runFlow(path.join(FIXTURES, "real-456"));
  check("起审官 dry-run 标明 task-create + worker-start", /task-create \+ worker-start/.test(r.out), r.out.trim());
  check("起审官命令含 worker-start --worktree current --agent codex", /orca orchestration worker-start --task <task_id> --worktree current --agent codex --model gpt-5.6-sol --json/.test(r.out), r.out.trim());
  check("不再用 worktree create --agent --prompt（例外已退役）", !/worktree create.*--prompt/.test(r.out), r.out.trim());
  check("不再标受控例外（随 #480 退役即现在）", !/受控例外/.test(r.out), r.out.trim());

  const flowSrc = fs.readFileSync(FLOW, "utf8");
  const liveStart = flowSrc.split("if (action.kind === 'start-reviewer')")[1]?.split("if (action.kind === 'inject-rework')")[0] || "";
  check("live 起审官 argv 含 orchestration worker-start", /\['orchestration', 'worker-start'/.test(liveStart), liveStart.slice(0, 200));
  check("live 起审官不再有 worktree create --agent --prompt", !/\['worktree', 'create', '--parent-worktree', `branch:\${\${pr.headRefName}}`, '--name', cardName, '--agent'/.test(liveStart) && !/--prompt'\]/.test(liveStart), liveStart.slice(0, 200));
  check("flow 头注写明受控例外退役（#480 换原生）", /起审官走 worktree create --agent --prompt（自称「受控例外，随 #480 退役」——就是现在）/.test(flowSrc) || /task-create \+ worker-start --task <id> --worktree current --agent <cli> --model <id>/.test(flowSrc));
  check("flow 头注写明删除 pickUniqueTerminal / findReviewerTerminal", /pickUniqueTerminal \/ findReviewerTerminal/.test(flowSrc));
  check("flow 头注写明 heartbeat 契约", /heartbeat\.json/.test(flowSrc));

  const skill = fs.readFileSync(path.join(REPO, "host", "skills", "dispatch", "SKILL.md"), "utf8");
  check("SKILL 启动序写明 flow 起审官走 worker-start（受控例外已退役）", /flow\.mjs 闭环内起审官仍走/.test(skill) === false && /起审官/.test(skill) && /worker-start/.test(skill));
  const liveFn = fs.readFileSync(FLOW, "utf8").split("function makeLiveSource")[1]?.split("function readJson")[0] || "";
  check("live getComments 走 issues/.../comments --paginate", /issues\/\$\{number\}\/comments/.test(liveFn) && /--paginate/.test(liveFn));
  check("live getPrGate 拉 statusCheckRollup + mergeable（合并前重查）", /statusCheckRollup/.test(liveFn) && /mergeable/.test(liveFn));
}

console.log("\n=== ⑲ review 链接必须可用（数字锚点 id，不是 GraphQL node id）===");
{
  const r = runFlow(path.join(FIXTURES, "fake-loop"));
  check("返工指令链接是数字锚点形态（无 PRR_ node-id）", /pull\/999#pullrequestreview-910001/.test(r.out) && !/pull\/999#pullrequestreview-PRR_/.test(r.out), r.out.trim());
  const real453 = JSON.parse(fs.readFileSync(path.join(FIXTURES, "real-453", "pr-453-reviews.json"), "utf8"));
  check("real-453 语料 id 全是数字锚点（无 PRR_ node-id）", real453.every(x => /^\d+$/.test(String(x.id))), real453.map(x => x.id).join(","));
  check("real-453 语料 html_url 现成（live 口径镜像）", real453.every(x => /^https:\/\/github\.com\/.+pullrequestreview-\d+$/.test(x.html_url || "")), real453.map(x => x.html_url).join(","));
  check("real-453 语料 3 条 review body 未改写（判定行口径仍成立）", redFlagsFromReviewBodies(real453.map(x => x.body)) === 5, "应为 5");
}

console.log("\n=== ㉒ 合并三条件硬查：绿→合 / 缺一不合各一条 ===");
{
  const green = runFlow(path.join(FIXTURES, "merge-green"));
  check("绿→合：退出码 1（有合并动作）", green.status === 1, `status=${green.status}`);
  check("绿→合：输出合并动作（三条件 + MERGEABLE）", /动作：合并 #3201（复核绿 \+ CI 全绿 \+ merge\/auto \+ MERGEABLE）：gh pr merge 3201 --squash/.test(green.out), green.out.trim());
  check("绿→合：不再挂待帅处置", !/待帅处置：#3201/.test(green.out), green.out.trim());

  const noAuto = runFlow(path.join(FIXTURES, "merge-no-auto"));
  check("无 merge/auto 标签 → 只通知不合（等用户终审），不合并", /报帅：终审 #3202（复核结论：绿，无 merge\/auto 标签——等用户终审）/.test(noAuto.out) && !/动作：合并/.test(noAuto.out), noAuto.out.trim());

  const ciRed = runFlow(path.join(FIXTURES, "merge-ci-red"));
  check("CI 有红 → 不合（报红项名）", /报帅：终审 #3203（复核结论：绿，CI 未全绿（check）——不合）/.test(ciRed.out) && !/动作：合并/.test(ciRed.out), ciRed.out.trim());

  const ciZero = runFlow(path.join(FIXTURES, "merge-ci-zero"));
  check("CI 0 条 check → 没查成≠全绿，不合", /CI 0 条 check——没查成≠全绿，不合/.test(ciZero.out) && !/动作：合并/.test(ciZero.out), ciZero.out.trim());

  const waitingYou = runFlow(path.join(FIXTURES, "merge-waiting-you"));
  check("带等你标签 → 撤回不合", /带「等你」标签——撤回，不合/.test(waitingYou.out) && !/动作：合并/.test(waitingYou.out), waitingYou.out.trim());
}

console.log("\n=== ㉒b 合并前重查 mergeable：判绿后被撞 CONFLICTING → comment + 等你 + 停手不重试 ===");
{
  const r = runFlow(path.join(FIXTURES, "merge-conflict"));
  check("退出码 1（有打回）", r.status === 1, `status=${r.status}`);
  check("打回人工：写明冲突原因", /打回人工：#3206（mergeable=CONFLICTING，mergeStateStatus=DIRTY——打回人工）/.test(r.out), r.out.trim());
  check("打回动作：comment + 等你 标签 + 停手不重试", /comment \+ 「等你」标签 \+ 停手不重试/.test(r.out), r.out.trim());
  check("不执行合并", !/gh pr merge 3206/.test(r.out) || /gh pr merge 3206 --squash 成功/.test(r.out) === false, r.out.trim());
  check("待帅处置常驻（打回人工）", /待帅处置：#3206（合并前重查 mergeable 失败——打回人工/.test(r.out), r.out.trim());
}

console.log("\n=== ㉓ 上帅→停手叫人：review 首行「上帅：」/ 原生 escalation / 六轮兜底 ===");
{
  const rev = runFlow(path.join(FIXTURES, "shang-shuai-review"));
  check("review 上帅：行 → 报帅上帅（停手）", /报帅：上帅 #3301（审官上帅：规格本身有疑问，需帅仲裁）——停止自动流转，不再自动流转该 PR/.test(rev.out), rev.out.trim());
  check("不再自动流转（无任何动作）", !/动作：/.test(rev.out), rev.out.trim());
  check("待帅处置常驻（带原因）", /待帅处置：#3301（上帅：规格本身有疑问，需帅仲裁——停手叫人，不再自动流转）/.test(rev.out), rev.out.trim());
  check("上帅 review 不误报判定行缺失（标注行不算缺判定）", !/判定行缺失/.test(rev.out), rev.out.trim());

  const esc = runFlow(path.join(FIXTURES, "shang-shuai-escalation"));
  check("原生 escalation → 报帅上帅（停手）", /报帅：上帅 #3302（worker 上帅：规格有疑问/.test(esc.out), esc.out.trim());
  check("escalation 后不再自动流转（红判定不触发返工注入）", !/动作：/.test(esc.out), esc.out.trim());
  check("escalation 待帅处置常驻", /待帅处置：#3302（worker 上帅：规格有疑问/.test(esc.out), esc.out.trim());

  const escResolve = runFlow(path.join(FIXTURES, "escalation-resolve"));
  check("round-1 escalation → 上帅停手", /round-1[\s\S]*报帅：上帅 #3309/.test(escResolve.out), escResolve.out.trim());
  check("round-2 新 review（帅已处置）→ 上帅解除，恢复自动流转", /round-2[\s\S]*上帅解除 #3309/.test(escResolve.out), escResolve.out.trim());
  check("round-2 恢复后正常终审（等用户终审）", /round-2[\s\S]*报帅：终审 #3309/.test(escResolve.out), escResolve.out.trim());
}

console.log("\n=== ㉔ 反例回归样本：review 判定行「判定：红 2 项」，正文引用代码块含「判定：绿」→ 必须判红 ===");
{
  const r = runFlow(path.join(FIXTURES, "anti-sample"));
  check("退出码 1（有动作）", r.status === 1, `status=${r.status}`);
  check("判红（引用代码块的 判定：绿 不得算数——搜全文会被骗，本防线在）", /动作：返工注入 #3305（第 1 轮，红 2 项）：task-create \+ worker-start --task <新> --terminal term_worker_3305/.test(r.out), r.out.trim());
  check("不判绿不合并", !/动作：合并|复核结论：绿/.test(r.out), r.out.trim());
  check("红 2 与判定行一致（redFlagsFromReviewBodies 口径）", redFlagsFromReviewBodies(["判定：红 2 项\n\n```js\nif (verdict.line === \"判定：绿\") { return approve(); }\n```"]) === 2, "应为 2");
}

console.log("\n=== ㉕ 双通道等价：原生消息通道 vs GitHub 兜底通道，动作结果一致且只动作一次 ===");
{
  const native = runFlow(path.join(FIXTURES, "dual-native"));
  const github = runFlow(path.join(FIXTURES, "dual-github"));
  const actionLine = /动作：返工注入 #3306（第 1 轮，红 2 项）：task-create \+ worker-start --task <新> --terminal term_worker_3306/;
  check("原生通道：worker_done 门铃 → 同一动作", actionLine.test(native.out), native.out.trim());
  check("闲置工人（已 worker_done）收返工走 worker-start 路径，绝无 send --to dispatch（#480 实测回归）", !/send --to dispatch/.test(native.out) && !/send --to dispatch/.test(github.out), native.out.trim());
  check("GitHub 通道：完工 comment 兜底 → 同一动作", actionLine.test(github.out), github.out.trim());
  check("两通道动作结果一致（同一行）", (native.out.match(actionLine) || []).length === 1 && (github.out.match(actionLine) || []).length === 1);
  check("原生通道打出门铃记账（dispatchCache）", /门铃：worker_done（task=task_3306w，dispatch=ctx_worker_3306）/.test(native.out), native.out.trim());

  // 幂等：同状态文件重跑不重复动作
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-dual-"));
  const stateFile = path.join(tmp, "state.json");
  const hbFile = path.join(tmp, "heartbeat.json");
  const r1 = runFlowShared(path.join(FIXTURES, "dual-native"), stateFile, hbFile);
  const r2 = runFlowShared(path.join(FIXTURES, "dual-native"), stateFile, hbFile);
  const out2 = (r2.stdout || "") + (r2.stderr || "");
  check("原生通道重跑零动作（幂等，只动作一次）", r1.status === 1 && r2.status === 0 && !/动作：/.test(out2), out2.trim());
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n=== ㉕b handle 缺失：dispatch 有但 worker-show 取不到 handle → 预览-阻塞（不猜终端）===");
{
  const r = runFlow(path.join(FIXTURES, "handle-missing"));
  check("退出码 1（有输出）", r.status === 1, `status=${r.status}`);
  check("预览-阻塞：取不到 agentTerminalHandle——待帅转交", /预览-阻塞：#3310（返工注入——投递目标解析失败：worker-show --dispatch ctx_worker_3310 取不到 agentTerminalHandle——待帅转交）/.test(r.out), r.out.trim());
  check("不猜终端、不注入（没有 worker-start 动作）", !/动作：返工注入 #3310/.test(r.out), r.out.trim());
}

console.log("\n=== ㉘ merge-policy 回填（#498 过渡垫片：worktree 卡备注 → GitHub 标签，只做一次不覆盖）===");
{
  const auto = runFlow(path.join(FIXTURES, "policy-auto"));
  check("comment 有 merge-policy:auto → 回填动作", /动作：回填 merge\/auto 标签 #3401（worktree comment 读 merge-policy:auto）→ gh pr edit 3401 --add-label merge\/auto/.test(auto.out), auto.out.trim());

  const manual = runFlow(path.join(FIXTURES, "policy-manual"));
  check("merge-policy:manual → 不回填，落安全默认", !/回填|动作：/.test(manual.out) && /OK 扫完 1 个 PR，0 需流转/.test(manual.out), manual.out.trim());

  const prose = runFlow(path.join(FIXTURES, "policy-prose"));
  check("备注被覆写成人话（master 真备注语料）→ 不回填不报错", !/回填|报帅/.test(prose.out), prose.out.trim());
  check("链观察：无 merge-policy 树 → 没扫到样本显形（非「全部正常」）", /提醒：合并权链没扫到样本/.test(prose.out), prose.out.trim());

  const exists = runFlow(path.join(FIXTURES, "policy-label-exists"));
  check("标签已存在（帅手工优先）→ 不重复打", !/回填/.test(exists.out) && /OK 扫完 1 个 PR，0 需流转/.test(exists.out), exists.out.trim());

  // 幂等：同状态文件重跑不再回填
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-policy-"));
  const stateFile = path.join(tmp, "state.json");
  const hbFile = path.join(tmp, "heartbeat.json");
  const r1 = runFlowShared(path.join(FIXTURES, "policy-auto"), stateFile, hbFile);
  const r2 = runFlowShared(path.join(FIXTURES, "policy-auto"), stateFile, hbFile);
  const out2 = (r2.stdout || "") + (r2.stderr || "");
  check("回填只做一次：重跑零动作", r1.status === 1 && r2.status === 0 && !/回填/.test(out2), out2.trim());
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n=== ㉖ heartbeat：每轮结束原子写，字段契约（看门狗 #471 读它）===");
{
  const r = runFlow(path.join(FIXTURES, "fake-loop"));
  check("heartbeat.json 写出", r.heartbeat !== null, "heartbeat 未写");
  check("字段齐：ts/round/lastWakeSource/pendingCount/prs", r.heartbeat && typeof r.heartbeat.ts === "string" && typeof r.heartbeat.round === "number" && typeof r.heartbeat.lastWakeSource === "string" && typeof r.heartbeat.pendingCount === "number" && Array.isArray(r.heartbeat.prs), JSON.stringify(r.heartbeat));
  check("prs 含在途 PR 的 state 与 sinceMs", r.heartbeat && r.heartbeat.prs.some(p => p.number === 999 && typeof p.state === "string" && typeof p.sinceMs === "number"), JSON.stringify(r.heartbeat?.prs));
  check("lastWakeSource 为快照通道", r.heartbeat && (r.heartbeat.lastWakeSource === "native" || r.heartbeat.lastWakeSource === "github-poll"), r.heartbeat?.lastWakeSource);

  // 快照多轮 round 递增 + 有待帅处置时 pendingCount 计数
  const r2 = runFlow(path.join(FIXTURES, "real-453"));
  check("待帅处置 PR 计入 pendingCount", r2.heartbeat && r2.heartbeat.pendingCount >= 1 && r2.heartbeat.prs.some(p => p.number === 453 && p.state === "approved"), JSON.stringify(r2.heartbeat));
}

console.log("\n=== ㉗ --explain：对每个在途 PR 输出「当前态 + 下一步 + 卡在哪」，帅照着人肉执行 ===");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-explain-"));
  const stateFile = path.join(tmp, "state.json");
  const hbFile = path.join(tmp, "heartbeat.json");
  const r = runFlowShared(path.join(FIXTURES, "explain"), stateFile, hbFile, ["--explain"]);
  const out = (r.stdout || "") + (r.stderr || "");
  check("explain 对每个在途 PR 输出 explain 行", (out.match(/\[explain\] PR #3307/g) || []).length === 1 && /\[explain\] PR #3308/.test(out), out.trim());
  check("approved PR：当前态 + 卡在哪（无 merge/auto → 等用户终审）", /\[explain\] PR #3307[\s\S]*当前态：复核绿[\s\S]*卡在哪：无 merge\/auto 标签——等用户终审/.test(out), out.trim());
  check("working PR：当前态 + 下一步", /\[explain\] PR #3308[\s\S]*当前态：工人开工中/.test(out), out.trim());
  check("explain 只读：不产生动作/报帅行，不写状态文件", !/动作：|报帅：/.test(out) && !fs.existsSync(stateFile), out.trim());
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n=== ㉙ orca 真实返回契约（#497 第四轮：taskId 恒 null bug 防线，夹具 = orca 原样输出）===");
{
  const load = f => JSON.parse(fs.readFileSync(path.join(REPO, "tests", "fixtures", "orca-returns", f), "utf8"));
  const tc = load("task-create.json");
  check("task-create 真实返回：result.task.id 可取（旧代码 result.id / json.task.id 两路全错）", String(taskIdFromTaskCreate(tc)).startsWith("task_"), JSON.stringify(tc).slice(0, 160));
  check("task-create 真实返回：顶层 id 是 RPC id 不是 task id", tc.result.task.id !== tc.id, JSON.stringify(tc).slice(0, 160));
  check("task-create 真实返回：result.id 不存在（旧代码第一路永远 null）", tc.result.id === undefined, JSON.stringify(tc).slice(0, 160));
  const ts = load("task-list.json");
  check("task-list 真实返回：result.tasks 是数组", Array.isArray(ts.result.tasks) && ts.result.tasks.length > 0);
  const ws = load("worker-show.json");
  check("worker-show 真实返回：result.worker.agent_terminal_handle 可取", typeof handleFromWorkerShow(ws) === "string" && handleFromWorkerShow(ws).length > 0);
  check("worker-show 真实返回里的 result.dispatch.id 可被 dispatchIdFromDispatchShow 取到（已派工形态）", dispatchIdFromDispatchShow(ws) === (ws.result.dispatch || {}).id, JSON.stringify(ws.result.dispatch || {}).slice(0, 120));
  const ds = load("dispatch-show.json");
  check("dispatch-show 真实返回：result.dispatch 字段存在（未派工为 null）", "dispatch" in (ds.result || {}));
  const wc = load("worktree-create.json");
  check("worktree create 真实返回：result.worktree.id 可取", typeof worktreeIdFromWorktreeCreate(wc) === "string" && worktreeIdFromWorktreeCreate(wc).length > 0);
  const term = load("terminal-create.json");
  check("terminal create 真实返回：result.terminal.handle 可取", typeof terminalHandleFromTerminalCreate(term) === "string" && terminalHandleFromTerminalCreate(term).length > 0);
}

console.log("\n=== ㉚ merge-policy 契约（dispatch 真实产出 → flow 解析器；禁手写字面量 = 禁 mock 内生）===");
{
  const { dispatchComment } = require("../scripts/lib/dao-cmd.mjs");
  const c1 = dispatchComment({ mergePolicy: "auto", model: "gpt-5.6-sol", reviewer: "gpt-5.6-sol" });
  check("dispatchComment(auto) 真实产出 → 解出 auto", mergePolicyFromComment(c1) === "auto", c1);
  const c2 = dispatchComment({ mergePolicy: "manual", model: "gpt-5.6-sol", reviewer: "gpt-5.6-sol" });
  check("dispatchComment(manual) 真实产出 → 解出 manual", mergePolicyFromComment(c2) === "manual", c2);
  // 端到端：dao dispatch --dry-run 的 JSON 输出里 comment 字段（dao.mjs:196 emit）
  for (const policy of ["auto", "manual"]) {
    const r = spawnSync(process.execPath, [path.join(REPO, "scripts", "dao.mjs"), "dispatch", "--dry-run", "--name", "契约语料", "--merge-policy", policy, "--model", "gpt-5.6-sol", "--reviewer", "gpt-5.6-sol", "--spec", "契约语料：不做实际派工", "--json"], { encoding: "utf8", cwd: REPO });
    const out = (r.stdout || "") + (r.stderr || "");
    let parsed = null;
    try { parsed = JSON.parse(out); } catch { /* 非 JSON */ }
    check(`dao dispatch --dry-run(${policy}) 真实 comment → 解出 ${policy}`, parsed && mergePolicyFromComment(parsed.comment) === policy, out.slice(0, 200));
  }
}

console.log("\n=== ㉛ 合并权链断报警（comment auto 但 PR 无标签超 15 分钟 → 待帅处置常驻）===");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-chain-"));
  const stateFile = path.join(tmp, "state.json");
  const hbFile = path.join(tmp, "heartbeat.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1, inventoried: true, round: 0, dispatchCache: {}, chainWatchNoSampleReported: false,
    records: {
      "3405": { pr: 3405, seenComments: {}, seenReviews: {}, pendingShuai: null, reportedMalformed: {}, reportedStale: false, actedOn: null, reviewer: null, escalated: null, workerDispatch: null, policyBackfilled: true, chainBrokenSince: Date.now() - 20 * 60 * 1000, mergeAttempted: false, mergeBlocked: false, stateSince: Date.now() },
    },
  }), "utf8");
  const r = runFlowShared(path.join(FIXTURES, "chain-broken"), stateFile, hbFile);
  const out = (r.stdout || "") + (r.stderr || "");
  check("退出码 1（待帅处置）", r.status === 1, `status=${r.status}`);
  check("链断 → 待帅处置：合并权链断（#3405 回填失败）", /待帅处置：#3405（合并权链断：回填失败）/.test(out), out.trim());
  check("不误报 0 需流转", !/OK 扫完 1 个 PR，0 需流转/.test(out), out.trim());
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n=== ㉛b 链观察三态（扫过有样本 / 没扫到样本 / 没查成）===");
{
  const healthy = runFlow(path.join(FIXTURES, "policy-label-exists"));
  check("态1：auto 树 + 标签齐 → OK 合并权链（非报帅非 NO_TARGETS）", /OK 合并权链：1 棵 auto 树标签齐/.test(healthy.out), healthy.out.trim());
  const nt = runFlow(path.join(FIXTURES, "chain-notargets"));
  check("态3：读不到 worktree 列表 → NO_TARGETS（没查成，非查过没事）", /NO_TARGETS：读 worktree 列表失败/.test(nt.out), nt.out.trim());
  check("态3 退出码 2（没查成）", nt.status === 2, `status=${nt.status}`);
  // 态2 once-only：policy-prose（无 merge-policy 树）提醒一次，重跑不重复
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-chain2-"));
  const stateFile = path.join(tmp, "state.json");
  const hbFile = path.join(tmp, "heartbeat.json");
  const r1 = runFlowShared(path.join(FIXTURES, "policy-prose"), stateFile, hbFile);
  const r2 = runFlowShared(path.join(FIXTURES, "policy-prose"), stateFile, hbFile);
  const out1 = (r1.stdout || "") + (r1.stderr || "");
  const out2 = (r2.stdout || "") + (r2.stderr || "");
  check("态2：首跑提醒没扫到样本（显形，非全部正常）", /提醒：合并权链没扫到样本/.test(out1), out1.trim());
  check("态2：提醒只一次（重跑不刷屏）", !/提醒：合并权链没扫到样本/.test(out2), out2.trim());
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n=== ㉜ 引号坑锁（#499/#497 第六轮：runCmd 数组传参 + 无 shell，带空格参数不被拆）===");
{
  const flowSrc = fs.readFileSync(FLOW, "utf8");
  const runCmdSrc = flowSrc.split("function runCmd(")[1]?.split(/\nfunction /)[0] || "";
  check("runCmd 用 spawnSync(cmd, args, {...})（第二个参数是数组）", /spawnSync\(\s*cmd\s*,\s*args\s*,/.test(runCmdSrc), runCmdSrc.slice(0, 160));
  check("runCmd 选项不含 shell（shell:true 会经 cmd 二次解析丢引号）", !/shell\s*:/.test(runCmdSrc), runCmdSrc.slice(0, 160));
  // 行为断言：带空格参数走完整调用不被拆（实测证据：dispatch_not_found = 参数完整到达 RPC 解析）
  // 行为断言：带空格参数走完整调用不被拆（实测证据：dispatch_not_found = 参数完整到达 RPC 解析）。
  // 依赖本机 orca：无 orca（CI）时显形 SKIP——不算过不算红（帅补正：#475 同类问题，分不清
  // 「orca 说引号没问题」和「orca 没装」就把后者当成了前者的反面）。
  const sp = spawnSync("orca", ["orchestration", "send", "--to", "dispatch:__nonexistent__", "--subject", "A B C", "--body", "d e f", "--json"], { encoding: "utf8", timeout: 30000, windowsHide: true });
  const rawOut = ((sp.stdout || "") + (sp.stderr || "")).trim();
  // 无 orca 的机器（CI）：错误落在 sp.error（stdout/stderr 为空），要并进来才能显形
  const rawErr = (((sp.error && sp.error.message) || "") + " " + rawOut).trim();
  if (/dispatch_not_found/.test(rawErr)) {
    check("带空格参数完整到达（返回 dispatch_not_found，不是参数解析就炸）", true, rawErr.slice(0, 120));
  } else if (sp.error || /(not recognized|ENOENT|不是内部|外部命令|Cannot find)/i.test(rawErr)) {
    skipCheck("带空格参数完整到达（本机无 orca，CI 无法验证，源码断言已锁传参形态）", "SKIP: " + rawErr.slice(0, 120));
  } else {
    check("带空格参数完整到达（返回 dispatch_not_found，不是参数解析就炸）", false, rawErr.slice(0, 200));
  }
}

console.log("\n=== ㉝ 活性判据禁令（#500 实证：禁止屏面形态当活性证据）===");
{
  const flowSrc = fs.readFileSync(FLOW, "utf8");
  check("flow 头注写死活性判据禁令（屏面指纹/cursor 增量/tui-idle 禁用）", /禁止使用任何屏面形态/.test(flowSrc) && /tui-idle/.test(flowSrc), "禁令缺失");
  check("flow 无运行时 cursor 增量判活代码（无 terminal read 调用）", !/\['terminal', 'read'/.test(flowSrc) && !/nextCursor/.test(flowSrc), "屏面形态判活代码残留");
  const skill = fs.readFileSync(path.join(REPO, "host", "skills", "dispatch", "SKILL.md"), "utf8");
  check("dispatch SKILL 开工判据不再用 token/cursor 增量当活性证据", !/token\/cursor 在涨才算开工/.test(skill), "残留旧判据");
  check("dispatch SKILL 写明 #500 实证", /#500/.test(skill));
}

console.log("\n=== ㉞ 判绿 + 冲突漏报修正（#497 第五轮：无论走不走自动合都查 mergeable 说清）===");
{
  // 三态：MERGEABLE→待终审（merge-no-auto 已有断言）；CONFLICTING→冲突提示压过温和文案；UNKNOWN→还在算不打回（real-453 已断言）
  const conflict = runFlow(path.join(FIXTURES, "merge-no-auto-conflict"));
  check("判绿+无标签+CONFLICTING → 冲突提示（不再只说待终审）", /报帅：终审 #3207（复核结论：绿，无 merge\/auto 标签——等用户终审；且 mergeable=CONFLICTING（DIRTY）——有冲突，需 rebase 后才能合）/.test(conflict.out), conflict.out.trim());
  check("判绿+冲突 → 待帅处置常驻行写明冲突（压过「待终审」）", /待帅处置：#3207（复核绿但有冲突，需 rebase 后才能合（无 merge\/auto 标签——等用户终审））/.test(conflict.out), conflict.out.trim());
  check("判绿+冲突 → 不再说「复核绿待帅终审」", !/待帅处置：#3207（复核绿待帅终审/.test(conflict.out), conflict.out.trim());
  check("判绿+冲突 → 不合并", !/动作：合并/.test(conflict.out), conflict.out.trim());
  // UNKNOWN（无 gate 数据 → mergeable 缺省）：还在算，不打回（real-453 断言过文案，这里再验退出码路径不变）
  const unknown = runFlow(path.join(FIXTURES, "real-453"));
  check("UNKNOWN → 仍在算下轮重查，不报冲突不打回", /mergeable 还在算，下轮重查/.test(unknown.out) && !/有冲突/.test(unknown.out), unknown.out.trim());
}

console.log("\n=== ㉟ 未归类状态报警（#497 第五轮：显式白名单 + 未知状态必须叫，不能静默消失）===");
{
  check("pendingAction 白名单：working → null（合法无待办）", pendingAction({ state: "working" }) === null);
  check("pendingAction 白名单：shang-shuai → null（报帅覆盖）", pendingAction({ state: "shang-shuai" }) === null);
  check("pendingAction 白名单：error → null（报帅覆盖）", pendingAction({ state: "error" }) === null);
  const u = pendingAction({ state: "test-only-future-state" });
  check("pendingAction 未知状态 → unclassified 动作（不静默 null）", u && u.kind === "unclassified" && u.state === "test-only-future-state", JSON.stringify(u));
  check("awaitingShuaiReason 未知状态 → 给原因（不 null 消失）", awaitingShuaiReason({ state: "test-only-future-state" }, {}, false) === "落入未归类状态 test-only-future-state——设计时没想到的状态组合，请帅分诊");
  check("awaitingShuaiReason 白名单 working → null", awaitingShuaiReason({ state: "working" }, {}, false) === null);
  // 端到端：预置 unclassified 待帅账 → 常驻行每轮显形（未归类 PR 不静默）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-unclass-"));
  const stateFile = path.join(tmp, "state.json");
  const hbFile = path.join(tmp, "heartbeat.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1, inventoried: true, round: 0, dispatchCache: {}, chainWatchNoSampleReported: false,
    records: {
      "3407": { pr: 3407, seenComments: {}, seenReviews: {}, pendingShuai: { kind: "unclassified", reason: "落入未归类状态 test-only——设计时没想到的状态组合，请帅分诊" }, reportedMalformed: {}, reportedStale: false, actedOn: "working|0|", reviewer: null, escalated: null, workerDispatch: null, policyBackfilled: false, chainBrokenSince: null, mergeAttempted: false, mergeBlocked: false, stateSince: Date.now() },
    },
  }), "utf8");
  const r = runFlowShared(path.join(FIXTURES, "unclassified-hold"), stateFile, hbFile);
  const out = (r.stdout || "") + (r.stderr || "");
  check("端到端：未归类待帅账 → 待帅处置常驻行显形（不静默）", /待帅处置：#3407（落入未归类状态 test-only——设计时没想到的状态组合，请帅分诊）/.test(out), out.trim());
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n=== ㊱ 合并门第四条（#497 第八轮：判绿的 commit 必须等于当前 HEAD）===");
{
  const mkRev = (id, body, commitId) => ({ id, body, commitId });
  // 纯函数四情形 + 边界
  check("相等 → 放行", greenCommitVerdict([mkRev(1, "复核结论：绿", "abc123")], "abc123", () => { throw new Error("相等不该调 probe"); }).ok === true);
  const ahead = greenCommitVerdict([mkRev(1, "复核结论：绿", "old")], "new", () => ({ ancestor: true, count: 3 }));
  check("祖先 → 不合：判绿后又推 N 个 commit（N=3）", ahead.ok === false && ahead.kind === "ahead" && ahead.n === 3 && /判绿后又推了 3 个 commit，需重新复核/.test(ahead.reason), JSON.stringify(ahead));
  const rew = greenCommitVerdict([mkRev(1, "复核结论：绿", "old")], "new", () => ({ ancestor: false, count: null }));
  check("rebase 重写 → 不合：无共同历史，不给 N", rew.ok === false && rew.kind === "rewritten" && !/\d 个 commit/.test(rew.reason) && /无共同历史/.test(rew.reason), JSON.stringify(rew));
  const unread = greenCommitVerdict([mkRev(1, "复核结论：绿", "old")], "new", () => ({ ancestor: null, count: null }));
  check("关系判不出 → 不合：没查成", unread.ok === false && unread.kind === "unreadable" && /没查成/.test(unread.reason), JSON.stringify(unread));
  const noCid = greenCommitVerdict([mkRev(1, "复核结论：绿", null)], "new", () => { throw new Error("不该调 probe"); });
  check("commit_id 缺失 → 不合：没查成（禁止查不到就当通过）", noCid.ok === false && /commit_id 缺失——没查成/.test(noCid.reason), JSON.stringify(noCid));
  const noJudge = greenCommitVerdict([mkRev(1, "普通评论", "abc")], "new", () => { throw new Error("不该调 probe"); });
  check("无带判定行 review → 不合：没查成", noJudge.ok === false && /没查到带判定行的 review/.test(noJudge.reason), JSON.stringify(noJudge));
  // 取最新一条带判定行的 review（中间有不带判定行的普通评论也算）
  const latest = greenCommitVerdict([mkRev(1, "普通评论", "x"), mkRev(2, "复核结论：绿", "first"), mkRev(3, "普通评论", "y"), mkRev(4, "复核结论：绿，可合并", "second")], "head", () => ({ ancestor: true, count: 5 }));
  check("取最新带判定行的 review（跳过中间普通评论）", latest.ok === false && latest.kind === "ahead" && latest.n === 5, JSON.stringify(latest));
  // 端到端（快照 + 真实 git probe）
  const rebased = runFlow(path.join(FIXTURES, "merge-rebased"));
  check("负样本1（本单真实数据：cc53837 判绿 vs c73b0e4 HEAD）：rebase 重写不合，不给 N", /报帅：终审 #3208（复核结论：绿，判绿的 commit 已被 rebase 重写，与当前 HEAD 无共同历史，需重新复核）/.test(rebased.out) && !/\d 个 commit/.test(rebased.out), rebased.out.trim());
  const aheadFlow = runFlow(path.join(FIXTURES, "merge-ahead"));
  check("负样本2（review commit 是 HEAD 祖先）：判绿后又推 5 个 commit，不合", /报帅：终审 #3209（复核结论：绿，判绿后又推了 5 个 commit，需重新复核）/.test(aheadFlow.out), aheadFlow.out.trim());
  const noCommit = runFlow(path.join(FIXTURES, "merge-no-commit"));
  check("负样本3（commit_id 缺失）：没查成，不合，不放行", /报帅：终审 #3210（复核结论：绿，判绿 review 的 commit_id 缺失——没查成）/.test(noCommit.out) && !/动作：合并/.test(noCommit.out), noCommit.out.trim());
  const fresh = runFlow(path.join(FIXTURES, "merge-green"));
  check("正样本（判绿 commit == HEAD + CI 绿 + merge/auto）：放行合并", /动作：合并 #3201（复核绿 \+ CI 全绿 \+ merge\/auto \+ MERGEABLE）：gh pr merge 3201 --squash/.test(fresh.out), fresh.out.trim());
}

console.log(`\n流转器回归网：${pass} 过 / ${fail} 红 / ${skip} 跳过`);
process.exit(fail > 0 ? 1 : 0);
