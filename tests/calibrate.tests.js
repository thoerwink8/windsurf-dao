// calibrate.mjs 红项口径回归网（issue #444）
//
// 背景：GitHub 不许同账号对自己 PR 打 request-changes，审官以 COMMENT 提交 review、
// 判定写在正文首行（格式如「判定：红 N 项」「**判定：红 N 项**」「复核结论：绿，可合并」）。
// v1 只数结构化 review 线程，这类评审线程数为 0，红项被永远计成 0。
//
// 语料来源（禁止 mock 内生）：tests/fixtures/reviews-446.json 与 reviews-440.json
// 是 gh api 拉取的真实 review 原文，生成命令：
//   gh api 'repos/thoerwink8/windsurf-dao/pulls/446/reviews' --paginate > tests/fixtures/reviews-446.json
//   gh api 'repos/thoerwink8/windsurf-dao/pulls/440/reviews' --paginate > tests/fixtures/reviews-440.json
// 两个 PR 的真实战况：#446 首审红 3、复核绿；#440 首审红 4+推测 1、二轮残留轻红 1。
// 判定格式约定（与 CLAUDE.md / issue #444 一致）：红项数 = 各 review body 中
// 「红 N 项」的最大 N；跨 review 取最大值 ⇒ 复核绿不清零首审红项。

const fs = require("fs");
const path = require("path");
const { redFlagsFromReviewBodies } = require("../scripts/calibrate.mjs");

const REPO = path.resolve(__dirname, "..");
const fixture = name => JSON.parse(fs.readFileSync(path.join(REPO, "tests", "fixtures", name), "utf8"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

const r446 = fixture("reviews-446.json");
const r440 = fixture("reviews-440.json");
const bodies446 = r446.map(r => r.body);
const bodies440 = r440.map(r => r.body);

// ── 单个 review body 的判定行识别 ────────────────────────────────────
// 真实语料：#446 首审判定行「**判定：红 3 项**」；复核行「复核结论：绿，可合并」。
// 注意：真实复核 body 正文里有「红 3 项逐条验证」字样（复核时复述红项清单），
// 单条解析会读到 3——「复核绿不清零首审红项」由跨 review 取最大 N 保证，
// 而不是靠绿 body 解析为 0。
check("446 首审 body 判出 红 3 项", redFlagsFromReviewBodies([bodies446[0]]) === 3, String(redFlagsFromReviewBodies([bodies446[0]])));
check("446 两条合判仍为 3（复核绿不清零）", redFlagsFromReviewBodies(bodies446) === 3, String(redFlagsFromReviewBodies(bodies446)));

// 真实语料：#440 首审「红 4 项 + 推测 1 项」——推测不计入红项；二轮「残留轻红 1 项」。
check("440 首审 body 判出 红 4 项（推测 1 项不计）", redFlagsFromReviewBodies([bodies440[0]]) === 4, String(redFlagsFromReviewBodies([bodies440[0]])));
check("440 二轮 body 判出 红 1 项（残留）", redFlagsFromReviewBodies([bodies440[1]]) === 1, String(redFlagsFromReviewBodies([bodies440[1]])));
check("440 两条合判取最大为 4", redFlagsFromReviewBodies(bodies440) === 4, String(redFlagsFromReviewBodies(bodies440)));

// ── 边界与判别力 ─────────────────────────────────────────────────────
check("空数组判 0", redFlagsFromReviewBodies([]) === 0);
check("无正文判 0", redFlagsFromReviewBodies([null, undefined, ""]) === 0);
check("无「红 N 项」字样判 0", redFlagsFromReviewBodies(["普通评论，没有判定行"]) === 0);
check("格式变体「判定：红 2 项」可识别", redFlagsFromReviewBodies(["判定：红 2 项（带冒号前缀）"]) === 2);
check("格式变体「**判定：红 5 项**」可识别", redFlagsFromReviewBodies(["**判定：红 5 项**（加粗）"]) === 5);
check("一条内取最大 N（红 1 项与红 3 项并存取 3）", redFlagsFromReviewBodies(["**判定：红 1 项**…红 3 项"]) === 3);
check("跨条取最大 N（2 与 5 并存取 5）", redFlagsFromReviewBodies(["**判定：红 2 项**", "判定：红 5 项"]) === 5);

// 结构性线程数仍兼容（取两者最大值）——由 calibrate.mjs 的 measurePr 组合，
// 这里直接验证纯函数与线程数取最大的语义由调用方 Math.max 承担，单测覆盖纯函数。
check("真实语料 446 战况 = 红 3 项", redFlagsFromReviewBodies(bodies446) === 3);
check("真实语料 440 战况 = 红 4 项", redFlagsFromReviewBodies(bodies440) === 4);

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
