// calibrate.mjs 红项口径回归网（issue #444）
//
// 背景：#444 当时 GitHub 不许同账号对自己 PR 打 request-changes，审官以 COMMENT
// 提交 review、判定写在正文首行（格式如「判定：红 N 项」「**判定：红 N 项**」
// 「复核结论：绿，可合并」）。v1 只数结构化 review 线程，这类评审线程数为 0，
// 红项被永远计成 0。#573 已废同账号限制（审官改走 approve），但判定行口径不变，
// 本回归仍用当时 COMMENT 语料——解析认正文，不认 event 类型。
//
// 语料来源（禁止 mock 内生）：tests/fixtures/reviews-446.json 与 reviews-440.json
// 是 gh api 拉取的真实 review 原文，生成命令：
//   gh api 'repos/thoerwink8/windsurf-dao/pulls/446/reviews' --paginate > tests/fixtures/reviews-446.json
//   gh api 'repos/thoerwink8/windsurf-dao/pulls/440/reviews' --paginate > tests/fixtures/reviews-440.json
// 两个 PR 的真实战况：#446 首审红 3、复核绿；#440 首审红 4+推测 1、二轮残留轻红 1。
// 判定格式约定（与 CLAUDE.md / issue #444 一致）：红项数 = 各 review body 中
// 「红 N 项」的最大 N；跨 review 取最大值 ⇒ 复核绿不清零首审红项。
//
// 返工轮数口径 v3（issue #501 缺陷二）语料：tests/fixtures/reviews-496.json、
// reviews-505.json、reviews-439.json 是 gh pr view --json reviews 的真实返回，生成命令：
//   gh pr view 496 --json reviews > tests/fixtures/reviews-496.json
//   gh pr view 505 --json reviews > tests/fixtures/reviews-505.json
//   gh pr view 439 --json reviews > tests/fixtures/reviews-439.json
// 真实战况：#496 首审红 1 + 复核绿（补录，2 条判定行 ⇒ 返工 1 轮）；#505 判定绿 0 项
// （1 条判定行 ⇒ 返工 0 轮）；#439 零 review（0 条判定行 ⇒ 没测成，不是 0 轮）。
// 旧口径（首次 ready 之后新增 commit 数）下 #496 这种 draft 到底的合规工人返工记 0，
// 新口径必须报 1。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require("fs");
const path = require("path");
const { redFlagsFromReviewBodies, buildRows, renderRow, renderFullReport, countVerdictLines, reworkFromVerdictLines, describeRework, samplesFromEvents, describeNoEvents } = require("../scripts/calibrate.mjs");

const REPO = path.resolve(__dirname, "..");
const fixture = name => JSON.parse(fs.readFileSync(path.join(REPO, "tests", "fixtures", name), "utf8"));

const r446 = fixture("reviews-446.json");
const r440 = fixture("reviews-440.json");
const bodies446 = r446.map(r => r.body);
const bodies440 = r440.map(r => r.body);

describe('calibrate', () => {
  it('单个 review body 的判定行识别（真实语料 #446 / #440）', async (t) => {
    // 真实语料：#446 首审判定行「**判定：红 3 项**」；复核行「复核结论：绿，可合并」。
    // 注意：真实复核 body 正文里有「红 3 项逐条验证」字样（复核时复述红项清单），
    // 单条解析会读到 3——「复核绿不清零首审红项」由跨 review 取最大 N 保证，
    // 而不是靠绿 body 解析为 0。
    await t.test('446 首审 body 判出 红 3 项', () => {
      assert.ok(redFlagsFromReviewBodies([bodies446[0]]) === 3, '446 首审 body 判出 红 3 项  →  ' + String(redFlagsFromReviewBodies([bodies446[0]])));
    });
    await t.test('446 两条合判仍为 3（复核绿不清零）', () => {
      assert.ok(redFlagsFromReviewBodies(bodies446) === 3, '446 两条合判仍为 3（复核绿不清零）  →  ' + String(redFlagsFromReviewBodies(bodies446)));
    });

    // 真实语料：#440 首审「红 4 项 + 推测 1 项」——推测不计入红项；二轮「残留轻红 1 项」。
    await t.test('440 首审 body 判出 红 4 项（推测 1 项不计）', () => {
      assert.ok(redFlagsFromReviewBodies([bodies440[0]]) === 4, '440 首审 body 判出 红 4 项（推测 1 项不计）  →  ' + String(redFlagsFromReviewBodies([bodies440[0]])));
    });
    await t.test('440 二轮 body 判出 红 1 项（残留）', () => {
      assert.ok(redFlagsFromReviewBodies([bodies440[1]]) === 1, '440 二轮 body 判出 红 1 项（残留）  →  ' + String(redFlagsFromReviewBodies([bodies440[1]])));
    });
    await t.test('440 两条合判取最大为 4', () => {
      assert.ok(redFlagsFromReviewBodies(bodies440) === 4, '440 两条合判取最大为 4  →  ' + String(redFlagsFromReviewBodies(bodies440)));
    });
  });

  it('边界与判别力', async (t) => {
    await t.test('空数组判 0', () => {
      assert.ok(redFlagsFromReviewBodies([]) === 0, '空数组判 0');
    });
    await t.test('无正文判 0', () => {
      assert.ok(redFlagsFromReviewBodies([null, undefined, ""]) === 0, '无正文判 0');
    });
    await t.test('无「红 N 项」字样判 0', () => {
      assert.ok(redFlagsFromReviewBodies(["普通评论，没有判定行"]) === 0, '无「红 N 项」字样判 0');
    });
    await t.test('格式变体「判定：红 2 项」可识别', () => {
      assert.ok(redFlagsFromReviewBodies(["判定：红 2 项（带冒号前缀）"]) === 2, '格式变体「判定：红 2 项」可识别');
    });
    await t.test('格式变体「**判定：红 5 项**」可识别', () => {
      assert.ok(redFlagsFromReviewBodies(["**判定：红 5 项**（加粗）"]) === 5, '格式变体「**判定：红 5 项**」可识别');
    });
    await t.test('一条内取最大 N（红 1 项与红 3 项并存取 3）', () => {
      assert.ok(redFlagsFromReviewBodies(["**判定：红 1 项**…红 3 项"]) === 3, '一条内取最大 N（红 1 项与红 3 项并存取 3）');
    });
    await t.test('跨条取最大 N（2 与 5 并存取 5）', () => {
      assert.ok(redFlagsFromReviewBodies(["**判定：红 2 项**", "判定：红 5 项"]) === 5, '跨条取最大 N（2 与 5 并存取 5）');
    });

    // 结构性线程数仍兼容（取两者最大值）——由 calibrate.mjs 的 measurePr 组合，
    // 这里直接验证纯函数与线程数取最大的语义由调用方 Math.max 承担，单测覆盖纯函数。
    await t.test('真实语料 446 战况 = 红 3 项', () => {
      assert.ok(redFlagsFromReviewBodies(bodies446) === 3, '真实语料 446 战况 = 红 3 项');
    });
    await t.test('真实语料 440 战况 = 红 4 项', () => {
      assert.ok(redFlagsFromReviewBodies(bodies440) === 4, '真实语料 440 战况 = 红 4 项');
    });
  });

  it('红 1 收窄到判定行（对抗审 #449）：正文叙述里引用他单红数不计入', async (t) => {
    // 审语讨论口径时天然含「红 N 项」字样（本例审官通篇避免写 N≥3 裸串即是活证据）；
    // 只认行首为「判定」「复核结论」（允许 >、** 前缀）的行，其余行一律不算。
    await t.test('正文叙述引用他单「红 4 项」不计入', () => {
      assert.ok(redFlagsFromReviewBodies(["比 #440 的红 4 项（N=4）干净多了"]) === 0, '正文叙述引用他单「红 4 项」不计入');
    });
    await t.test('正文讨论语料「红 5 项」不计入', () => {
      assert.ok(redFlagsFromReviewBodies(["语料样本判定：红 5 项——这条是讨论不是判定"]) === 0, '正文讨论语料「红 5 项」不计入');
    });
    await t.test('判定行在首行可识别', () => {
      assert.ok(redFlagsFromReviewBodies(["**判定：红 3 项**（对抗审）\n比 #440 的红 4 项干净多了"]) === 3, '判定行在首行可识别');
    });
    await t.test('判定行在次行（> 前缀）可识别', () => {
      assert.ok(redFlagsFromReviewBodies(["# 对抗审 PR #1\n> **判定：request-changes（红 4 项 + 推测 1 项）**。\n正文里红 6 项不计数"]) === 4, '判定行在次行（> 前缀）可识别');
    });
    await t.test('复核结论行（绿）判 0', () => {
      assert.ok(redFlagsFromReviewBodies(["**复核结论：绿，可合并**（复核）\n红 3 项逐条验证（叙述不计）"]) === 0, '复核结论行（绿）判 0');
    });
  });

  it('红 2 无审读与 0 红可区分（对抗审 #449，仓规硬条款）', async (t) => {
    // 没人审过（0 条 review）记 redFlags=null，报告呈现「无审读」；审过但 0 红记 0。
    const unreviewed = buildRows([{ model: "m", taskType: "写码", rework: 1, redFlags: null, number: 1, mergedAt: "2026-01-01T00:00:00Z" }], [], ["写码"]);
    await t.test('全组无审读 ⇒ 平均红项=null', () => {
      assert.ok(unreviewed[0].averageRedFlags === null, '全组无审读 ⇒ 平均红项=null');
    });
    await t.test('无审读渲染为「无审读」非 0.0', () => {
      assert.ok(renderRow(unreviewed[0]).includes("无审读"), '无审读渲染为「无审读」非 0.0');
    });
    await t.test('无审读趋势记「无审」非 0', () => {
      assert.ok(renderRow(unreviewed[0]).includes("1/无审"), '无审读趋势记「无审」非 0');
    });
    const reviewedZero = buildRows([{ model: "m", taskType: "写码", rework: 0, redFlags: 0, number: 2, mergedAt: "2026-01-02T00:00:00Z" }], [], ["写码"]);
    await t.test('审过 0 红 ⇒ 平均红项=0.0（与无审读区分）', () => {
      assert.ok(reviewedZero[0].averageRedFlags === 0 && renderRow(reviewedZero[0]).includes("0.0"), '审过 0 红 ⇒ 平均红项=0.0（与无审读区分）');
    });
    const mixed = buildRows([
      { model: "m", taskType: "写码", rework: 1, redFlags: null, number: 1, mergedAt: "2026-01-01T00:00:00Z" },
      { model: "m", taskType: "写码", rework: 2, redFlags: 4, number: 2, mergedAt: "2026-01-02T00:00:00Z" },
    ], [], ["写码"]);
    await t.test('混审：无审读不进平均，平均=4.0', () => {
      assert.ok(mixed[0].averageRedFlags === 4, '混审：无审读不进平均，平均=4.0');
    });
  });

  it('返工轮数口径 v3（issue #501 缺陷二）：判定行条数 - 1', async (t) => {
    // 旧口径「首次 ready 之后新增 commit 数」惩罚「draft 到底、完工才 ready」的合规工人：
    // #496 全程 draft、实返工 1 轮，旧口径测出 0。新口径数审官判定行的条数 - 1，
    // 与 ready/commit 节奏无关，数据源与红项数同一处（review 正文判定行）。
    const r496 = fixture("reviews-496.json").reviews;
    const r505 = fixture("reviews-505.json").reviews;
    const r439 = fixture("reviews-439.json").reviews;
    const bodies496 = r496.map(r => r.body);
    const bodies505 = r505.map(r => r.body);
    const bodies439 = r439.map(r => r.body);

    // 真语料（gh 拉取，禁止手写 mock）：#496 两条补录判定行、#505 一条、#439 零 review。
    await t.test('真语料 496：2 条判定行 ⇒ 返工 1 轮', () => {
      assert.ok(reworkFromVerdictLines(bodies496) === 1, '真语料 496：2 条判定行 ⇒ 返工 1 轮  →  ' + `得 ${reworkFromVerdictLines(bodies496)}`);
    });
    await t.test('真语料 505：1 条判定行 ⇒ 返工 0 轮', () => {
      assert.ok(reworkFromVerdictLines(bodies505) === 0, '真语料 505：1 条判定行 ⇒ 返工 0 轮  →  ' + `得 ${reworkFromVerdictLines(bodies505)}`);
    });
    await t.test('真反例 439：0 条判定行 ⇒ null（不是 0 轮）', () => {
      assert.ok(reworkFromVerdictLines(bodies439) === null, '真反例 439：0 条判定行 ⇒ null（不是 0 轮）  →  ' + `得 ${reworkFromVerdictLines(bodies439)}`);
    });
    await t.test('countVerdictLines 496 = 2', () => {
      assert.ok(countVerdictLines(bodies496) === 2, 'countVerdictLines 496 = 2  →  ' + String(countVerdictLines(bodies496)));
    });
    await t.test('countVerdictLines 505 = 1', () => {
      assert.ok(countVerdictLines(bodies505) === 1, 'countVerdictLines 505 = 1  →  ' + String(countVerdictLines(bodies505)));
    });
    await t.test('countVerdictLines 439 = 0', () => {
      assert.ok(countVerdictLines(bodies439) === 0, 'countVerdictLines 439 = 0  →  ' + String(countVerdictLines(bodies439)));
    });
  });

  it('边界：什么算一条判定行（与红项解析共用 judgment.mjs 的判定行定义）', async (t) => {
    await t.test('空数组 0 条判定行', () => {
      assert.ok(countVerdictLines([]) === 0, '空数组 0 条判定行');
    });
    await t.test('无正文不数', () => {
      assert.ok(countVerdictLines([null, undefined, ""]) === 0, '无正文不数');
    });
    await t.test('普通评论不算判定行', () => {
      assert.ok(countVerdictLines(["普通评论，没有判定行"]) === 0, '普通评论不算判定行');
    });
    await t.test('正文叙述引用他单「红 4 项」不算（非行首）', () => {
      assert.ok(countVerdictLines(["比 #440 的红 4 项干净多了"]) === 0, '正文叙述引用他单「红 4 项」不算（非行首）');
    });
    await t.test('首行判定算 1 条', () => {
      assert.ok(countVerdictLines(["**判定：红 3 项**\n叙述"]) === 1, '首行判定算 1 条');
    });
    await t.test('复核结论算 1 条', () => {
      assert.ok(countVerdictLines(["**复核结论：绿，可合并**"]) === 1, '复核结论算 1 条');
    });
    await t.test('多条 body 逐条数', () => {
      assert.ok(countVerdictLines(["判定：红 1 项", "复核结论：绿", "普通评论"]) === 2, '多条 body 逐条数');
    });
    await t.test('rework：1 条→0 轮', () => {
      assert.ok(reworkFromVerdictLines(["判定：红 1 项"]) === 0, 'rework：1 条→0 轮');
    });
    await t.test('rework：2 条→1 轮', () => {
      assert.ok(reworkFromVerdictLines(["判定：红 1 项", "复核结论：绿"]) === 1, 'rework：2 条→1 轮');
    });
    await t.test('rework：3 条→2 轮', () => {
      assert.ok(reworkFromVerdictLines(["判定：红 1 项", "判定：红 1 项", "复核结论：绿"]) === 2, 'rework：3 条→2 轮');
    });
  });

  it('三态输出可分辨（仓规硬条款：没查成 ≠ 查过没事）：0 轮 / N-1 轮 / 无判定行', async (t) => {
    await t.test('三态①：1 条判定行 → 「0 轮（审过一次，零返工）」', () => {
      assert.ok(describeRework(0).startsWith("0 轮") && describeRework(0).includes("零返工"), '三态①：1 条判定行 → 「0 轮（审过一次，零返工）」');
    });
    await t.test('三态②：2 条判别态 → 「1 轮」', () => {
      assert.ok(describeRework(1).startsWith("1 轮") && describeRework(1).includes("判别态 2 条"), '三态②：2 条判别态 → 「1 轮」');
    });
    await t.test('三态③：0 条判别态 → 「无审读（本项没测成）」，不是 0 轮', () => {
      assert.ok(describeRework(null).includes("无审读") && describeRework(null).includes("没测成") && !describeRework(null).startsWith("0 轮"), '三态③：0 条判别态 → 「无审读」，不是 0 轮');
    });
  });

  it('#807：判定行协议退役，近义变体不再当 malformed 闸', async (t) => {
    await t.test('无审读 describeRework 说没测成', () => {
      assert.ok(describeRework(null).includes('无审读') && describeRework(null).includes('没测成'));
    });
  });

  it('累计表镜像：无判定行不混进返工平均，也不当作 0 轮', async (t) => {
    const noVerdict = buildRows([{ model: "m", taskType: "写码", rework: null, redFlags: null, number: 1, mergedAt: "2026-01-01T00:00:00Z" }], [], ["写码"]);
    await t.test('全组无判定行 ⇒ 平均返工=null', () => {
      assert.ok(noVerdict[0].averageRework === null, '全组无判定行 ⇒ 平均返工=null');
    });
    await t.test('无审读渲染为「无审读」非 0.0', () => {
      assert.ok(renderRow(noVerdict[0]).includes("无审读"), '无审读渲染为「无审读」非 0.0');
    });
    await t.test('无判定行趋势记「无判定」非 0', () => {
      assert.ok(renderRow(noVerdict[0]).includes("无判定/无审"), '无判定行趋势记「无判定」非 0');
    });
    const zeroRework = buildRows([{ model: "m", taskType: "写码", rework: 0, redFlags: 0, number: 2, mergedAt: "2026-01-02T00:00:00Z" }], [], ["写码"]);
    await t.test('审过零返工 ⇒ 平均返工=0.0（与无判定行区分）', () => {
      assert.ok(zeroRework[0].averageRework === 0 && renderRow(zeroRework[0]).includes("0.0"), '审过零返工 ⇒ 平均返工=0.0（与无判定行区分）');
    });
    const mixedRework = buildRows([
      { model: "m", taskType: "写码", rework: null, redFlags: null, number: 1, mergedAt: "2026-01-01T00:00:00Z" },
      { model: "m", taskType: "写码", rework: 1, redFlags: 4, number: 2, mergedAt: "2026-01-02T00:00:00Z" },
    ], [], ["写码"]);
    await t.test('混判：无判定行样本不进平均，平均=1.0', () => {
      assert.ok(mixedRework[0].averageRework === 1, '混判：无判定行样本不进平均，平均=1.0');
    });
  });

  it('#588：整表不打无样本行，末尾汇总；单行 renderRow 仍保留三态', async (t) => {
    {
      const mixedRows = [
        { model: "a", taskType: "写码", sampleCount: 2, averageRework: 0, averageRedFlags: 0, trend: [{ number: 1, rework: 0, redFlags: 0 }] },
        { model: "b", taskType: "判断", sampleCount: 0, averageRework: null, averageRedFlags: null, trend: [] },
        { model: "c", taskType: "查证", sampleCount: 0, averageRework: null, averageRedFlags: null, trend: [] },
      ];
      const report = renderFullReport(mixedRows, 0);
      await t.test('整表不出现无样本废行', () => {
        assert.ok(!/\| b \| 判断 \| 无样本 \|/.test(report) && !/\| c \| 查证 \| 无样本 \|/.test(report), '整表不出现无样本废行  →  ' + report);
      });
      await t.test('整表仍有有样本行', () => {
        assert.ok(/\| a \| 写码 \| 2 \|/.test(report), '整表仍有有样本行  →  ' + report);
      });
      await t.test('末尾汇总无样本组合数', () => {
        assert.ok(/另有 2 个模型×任务类组合无样本/.test(report), '末尾汇总无样本组合数  →  ' + report);
      });
      await t.test('单行「无样本」三态还在（不铺开）', () => {
        assert.ok(renderRow(mixedRows[1]).includes("无样本"), '单行「无样本」三态还在（不铺开）');
      });
      await t.test('有样本的 0 轮仍是 0.0 不是无样本', () => {
        assert.ok(renderRow(mixedRows[0]).includes("0.0") && !renderRow(mixedRows[0]).includes("无样本"), '有样本的 0 轮仍是 0.0 不是无样本');
      });
    }

    {
      const allEmpty = [{ model: "a", taskType: "写码", sampleCount: 0, averageRework: null, averageRedFlags: null, trend: [] }];
      const report = renderFullReport(allEmpty, 0);
      await t.test('全量无样本不打废表行', () => {
        assert.ok(!report.includes("| 无样本 | 无样本 | 无样本 | 无样本 | 无样本 | 无样本 |"), '全量无样本不打废表行  →  ' + report);
      });
      await t.test('全量无样本只留汇总句', () => {
        assert.ok(/另有 1 个模型×任务类组合无样本/.test(report), '全量无样本只留汇总句  →  ' + report);
      });
      await t.test('全量无样本不残留表头', () => {
        assert.ok(!/\| 模型 \| 任务类 \|/.test(report), '全量无样本不残留表头  →  ' + report);
      });
    }
  });

  it('#581：校准改读账本后，判定行函数仍导出（flow / 回归网用），样本识别走事件', async (t) => {
    await t.test('没有事件的话术 ≠ 0 红', () => {
      assert.ok(describeNoEvents(12).includes("没有事件") && !describeNoEvents(12).startsWith("0"), '没有事件的话术 ≠ 0 红');
    });
    const fromLedger = samplesFromEvents([
      { type: "job.dispatch", job_id: "gh-pr-12-review", model: "gpt-5.6-sol", identity: "审官", work_type: "审查" },
      { type: "job.closed", job_id: "gh-pr-12-review", pr_number: 12, red_flags: 0, worker_rework: 0, ts: "2026-08-17T12:00:00+08:00" },
    ]);
    await t.test('账本 0 红样本 redFlags=0 且任务类=审查', () => {
      assert.ok(fromLedger[0].redFlags === 0 && fromLedger[0].taskType === "审查", '账本 0 红样本 redFlags=0 且任务类=审查');
    });
  });

  it('#591 读取侧三态：未记录 / 0 / 无审，表上不许长得一样；未记录不进均值', async (t) => {
    const { formatRedCell, renderRow, buildRows, samplesFromEvents } = require("../scripts/calibrate.mjs");
    const unrecorded = samplesFromEvents([
      { type: "job.dispatch", job_id: "gh-pr-582", model: "grok-4.6", identity: "工人", work_type: "写码" },
      { type: "job.dispatch", job_id: "gh-pr-582-review", model: "gpt-5.6-sol", identity: "审官", work_type: "审查" },
      { type: "job.closed", job_id: "gh-pr-582", pr_number: 582, success: true, ts: "2026-08-17T12:00:00+08:00" },
    ]);
    await t.test('#582 残缺 closed → redKind=unrecorded', () => {
      assert.ok(unrecorded[0].redKind === "unrecorded" && unrecorded[0].redFlags === null, '#582 残缺 closed → redKind=unrecorded  →  ' + JSON.stringify(unrecorded[0]));
    });
    const zero = samplesFromEvents([
      { type: "job.dispatch", job_id: "gh-pr-592", model: "grok-4.6", identity: "工人", work_type: "写码" },
      { type: "job.closed", job_id: "gh-pr-592", pr_number: 592, red_flags: 0, worker_rework: 0, ts: "2026-08-17T12:00:00+08:00" },
    ]);
    await t.test('#592 完整 0 红 → redKind=zero', () => {
      assert.ok(zero[0].redKind === "zero" && zero[0].redFlags === 0, '#592 完整 0 红 → redKind=zero');
    });
    const none = samplesFromEvents([
      { type: "job.dispatch", job_id: "gh-pr-10", model: "grok-4.6", identity: "工人", work_type: "写码" },
      { type: "job.closed", job_id: "gh-pr-10", pr_number: 10, success: true, ts: "2026-08-17T12:00:00+08:00" },
    ]);
    await t.test('无审官 job → redKind=none', () => {
      assert.ok(none[0].redKind === "none", '无审官 job → redKind=none');
    });
    const rowU = buildRows([{ model: "m", taskType: "写码", rework: 1, redFlags: null, redKind: "unrecorded", number: 582, mergedAt: "2026-08-17T00:00:00Z" }], [], ["写码"]);
    const row0 = buildRows([{ model: "m", taskType: "写码", rework: 0, redFlags: 0, redKind: "zero", number: 592, mergedAt: "2026-08-17T00:00:00Z" }], [], ["写码"]);
    const rowN = buildRows([{ model: "m", taskType: "写码", rework: 1, redFlags: null, redKind: "none", number: 10, mergedAt: "2026-08-17T00:00:00Z" }], [], ["写码"]);
    await t.test('趋势 未记录 ≠ 0 ≠ 无审', () => {
      assert.ok(renderRow(rowU[0]).includes("未记录") && renderRow(row0[0]).includes("/0") && renderRow(rowN[0]).includes("无审"), '趋势 未记录 ≠ 0 ≠ 无审');
    });
    await t.test('未记录不进红项均值（平均栏写未记录）', () => {
      assert.ok(rowU[0].averageRedFlags === null && renderRow(rowU[0]).includes("未记录"), '未记录不进红项均值（平均栏写未记录）');
    });
    await t.test('0 红进均值', () => {
      assert.ok(row0[0].averageRedFlags === 0, '0 红进均值');
    });
    const mixed = buildRows([
      { model: "m", taskType: "写码", rework: 1, redFlags: null, redKind: "unrecorded", number: 582, mergedAt: "2026-08-16T00:00:00Z" },
      { model: "m", taskType: "写码", rework: 0, redFlags: 2, redKind: "counted", number: 594, mergedAt: "2026-08-17T00:00:00Z" },
    ], [], ["写码"]);
    await t.test('未记录不拉低均值，平均=2.0', () => {
      assert.ok(mixed[0].averageRedFlags === 2, '未记录不拉低均值，平均=2.0');
    });
    await t.test('formatRedCell 三态互异', () => {
      assert.ok(formatRedCell({ redKind: "unrecorded" }) === "未记录" && formatRedCell({ redKind: "zero", redFlags: 0 }) === "0" && formatRedCell({ redKind: "none" }) === "无审", 'formatRedCell 三态互异');
    });

    const withOv = samplesFromEvents([
      { type: "job.dispatch", job_id: "gh-pr-585", model: "grok-4.6", identity: "工人", work_type: "写码" },
      { type: "job.override", override_kind: "scope", job_id: "gh-pr-585", pr_number: 585, why: "拆掉平行账本" },
      { type: "job.closed", job_id: "gh-pr-585", pr_number: 585, red_flags: 1, worker_rework: 1, verdict_rounds: 2, ts: "2026-08-17T12:00:00+08:00" },
    ]);
    await t.test('#585 读侧按 override 把那一轮归帅', () => {
      assert.ok(withOv[0].attributionSource === "event" && withOv[0].marshalRounds === 1 && withOv[0].rework === 0, '#585 读侧按 override 把那一轮归帅  →  ' + JSON.stringify(withOv[0]));
    });
    const inferred = samplesFromEvents([
      { type: "job.dispatch", job_id: "gh-pr-11", model: "grok-4.6", identity: "工人", work_type: "写码" },
      { type: "job.closed", job_id: "gh-pr-11", pr_number: 11, red_flags: 1, worker_rework: 1, ts: "2026-08-17T12:00:00+08:00" },
    ]);
    await t.test('无 override 历史单标反推', () => {
      assert.ok(inferred[0].attributionSource === "inferred" && /反推/.test(inferred[0].attributionNote), '无 override 历史单标反推');
    });
  });
});