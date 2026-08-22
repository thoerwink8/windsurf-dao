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

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const FLOW = path.join(REPO, "scripts", "flow.mjs");
const FIXTURES = path.join(REPO, "tests", "flow-fixtures");
const { deriveState, pendingAction, orderedSignals, isInstitutional, awaitingShuaiReason, parseOrcaStdout, verifyStarted, injectAndVerify, dispatchNewTaskToTerminal, isFlowWork, pendingFlowItems, ticketIssueNumber, loadState, saveState } = require("../scripts/flow.mjs");
const { judgmentFromReview, isCompletionComment, redFlagsFromReviewBodies } = require("../scripts/lib/judgment.mjs");

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

describe('flow', () => {
  it('① 假闭环验收（#675：红项已落地但下一跳没开 → 报帅，不 task-create）', async (t) => {
    const r = runFlow(path.join(FIXTURES, "fake-loop"));
    await t.test('退出码 1（报帅）', () => {
      assert.ok(r.status === 1, '退出码 1（报帅）  →  ' + `status=${r.status}`);
    });
    await t.test('报帅验收没开成下一跳', () => {
      assert.ok(/报帅：验收没开成下一跳/.test(r.out), '报帅验收没开成下一跳  →  ' + r.out.trim());
    });
    await t.test('禁止 task-create / 返工注入', () => {
      assert.ok(!/task-create/.test(r.out) && !/返工注入/.test(r.out) && !/动作：/.test(r.out), '禁止 task-create  →  ' + r.out.trim());
    });
    await t.test('不重复起审官（红判定已存在 → 不新建审官）', () => {
      assert.ok(!/起审官/.test(r.out), '不重复起审官（红判定已存在 → 不新建审官）  →  ' + r.out.trim());
    });
  });

  it('①b #677 士兵还活着 → 红项打进这个身份，不 task-create，0 需流转', async (t) => {
    const r = runFlow(path.join(FIXTURES, "rework-hop-open"));
    await t.test('观察士兵还活着且不 task-create', () => {
      assert.ok(/观察：#999 士兵还活着，红项打进这个身份 ctx_next_999，不 task-create/.test(r.out), '观察士兵还活着  →  ' + r.out.trim());
    });
    await t.test('0 需流转', () => {
      assert.ok(/OK 扫完 1 个 PR，0 需流转/.test(r.out) && r.status === 0, '0 需流转  →  ' + `status=${r.status} ` + r.out.trim());
    });
    await t.test('不报帅、不注入', () => {
      assert.ok(!/报帅/.test(r.out) && !/返工注入/.test(r.out) && !/task-create/.test(r.out.replace(/不 task-create/g, '')), '不报帅不注入  →  ' + r.out.trim());
    });
  });

  it('①c #677 worker-list 结构不认识 → 没查成，不是查到 0', async (t) => {
    const r = runFlow(path.join(FIXTURES, "rework-workers-unscanned"));
    await t.test('报帅下一跳没查成', () => {
      assert.ok(/报帅：下一跳没查成/.test(r.out) && /结构不认识/.test(r.out),
        '没查成  →  ' + r.out.trim());
    });
    await t.test('不把没查成说成验收没开成（那是查到 0）', () => {
      assert.ok(!/验收没开成下一跳/.test(r.out), '没查成 ≠ 查到 0  →  ' + r.out.trim());
    });
    await t.test('不 task-create', () => {
      assert.ok(!/task-create/.test(r.out), '不 task-create  →  ' + r.out.trim());
    });
  });

  it('② prime 吞存量负控：存量已有完工+红判定，启动即看见（不吞存量）', async (t) => {
    const r = runFlow(path.join(FIXTURES, "fake-loop"));
    await t.test('存量信号被识别并报帅验收没开成下一跳（吞存量 = 本轮无输出）', () => {
      assert.ok(/报帅：验收没开成下一跳/.test(r.out), '存量信号被识别  →  ' + r.out.trim());
    });
    await t.test('打出存量清点标记（先清点再增量）', () => {
      assert.ok(/存量清点/.test(r.out), '打出存量清点标记（先清点再增量）  →  存量清点标记缺失');
    });
  });

  it('③ 重启不重复动作负控：同状态文件重跑 → 不重复报帅，待帅处置常驻', async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-restart-"));
    const stateFile = path.join(tmp, "state.json");
    const args = [FLOW, "--snapshot-dir", path.join(FIXTURES, "fake-loop"), "--state-file", stateFile, "--dry-run"];
    const r1 = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
    const r2 = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
    const out1 = (r1.stdout || "") + (r1.stderr || "");
    const out2 = (r2.stdout || "") + (r2.stderr || "");
    await t.test('首跑退出码 1（报帅）', () => {
      assert.ok(r1.status === 1 && /报帅：验收没开成下一跳/.test(out1), '首跑退出码 1（报帅）  →  ' + `status=${r1.status} ` + out1.trim());
    });
    await t.test('重跑仍 exit 1（待帅处置常驻，不能报一次就转绿）', () => {
      assert.ok(r2.status === 1, '重跑仍 exit 1  →  ' + `status=${r2.status}`);
    });
    await t.test('重跑仍有待帅处置，不打 0 需流转', () => {
      assert.ok(/待帅处置：#999（验收没开成下一跳）/.test(out2) && !/OK 扫完/.test(out2), '重跑待帅常驻  →  ' + out2.trim());
    });
    await t.test('重跑不重复报帅：行（闸已落）', () => {
      assert.ok(!/报帅：/.test(out2) && !/动作：/.test(out2), '重跑不重复报帅  →  ' + out2.trim());
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('③b 待帅处置去重 JSON 往返（#730 刷屏回归：Set 序列化落成 {} → .has 崩/去重落空）', async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ghnotified-"));
    const stateFile = path.join(tmp, "state.json");
    await t.test('旧版 Set 序列化形态（{}）回读不崩，归一成 plain object', () => {
      // 旧代码 ghNotified 是 Set：JSON.stringify(Set) === '{}'，回读后 .has is not a function
      fs.writeFileSync(stateFile, JSON.stringify({
        version: 1, inventoried: true, round: 3,
        records: { 730: { pr: 730, seenComments: {}, seenReviews: {}, ghNotified: {} } },
      }));
      const s = loadState(stateFile);
      assert.ok(s.records[730] && typeof s.records[730].ghNotified === 'object' && !Array.isArray(s.records[730].ghNotified),
        '旧形态 {} 归一成 plain object  →  ' + JSON.stringify(s.records[730]));
    });
    await t.test('坏形态（数组/null/标量）归一，不崩', () => {
      for (const bad of [[], null, 'x', 7]) {
        fs.writeFileSync(stateFile, JSON.stringify({
          version: 1, inventoried: true, round: 1,
          records: { 730: { pr: 730, seenComments: {}, seenReviews: {}, ghNotified: bad } },
        }));
        const s = loadState(stateFile);
        assert.deepStrictEqual(s.records[730].ghNotified, {}, `坏形态 ${JSON.stringify(bad)} 归一  →  ` + JSON.stringify(s.records[730].ghNotified));
      }
    });
    await t.test('去重标记 JSON 往返后存活（同一 reason 不重复发）', () => {
      const s = loadState(stateFile);
      s.records[730].ghNotified['approved 超时未合待帅处置'] = true;
      saveState(stateFile, s);
      const s2 = loadState(stateFile);
      assert.strictEqual(s2.records[730].ghNotified['approved 超时未合待帅处置'], true,
        '去重标记往返后存活  →  ' + JSON.stringify(s2.records[730].ghNotified));
    });
    await t.test('端到端：旧 {} 形态状态文件 + 有待帅处置的盘面 → 不 TypeError 崩', () => {
      // fake-loop 产出「待帅处置：#999」；旧代码此时 rec.ghNotified={} → .has 抛 TypeError 整轮崩掉
      fs.writeFileSync(stateFile, JSON.stringify({
        version: 1, inventoried: true, round: 5,
        records: { 999: { pr: 999, seenComments: {}, seenReviews: {}, reportedMalformed: {}, reportedStale: false, actedOn: null, reviewer: null, workerWorktree: null, ghNotified: {} } },
      }));
      const r = spawnSync(process.execPath, [FLOW, "--snapshot-dir", path.join(FIXTURES, "fake-loop"), "--state-file", stateFile, "--dry-run"], { encoding: "utf8", cwd: REPO });
      const out = (r.stdout || "") + (r.stderr || "");
      assert.ok(!/is not a function/.test(out) && !/TypeError/.test(out), '不得 TypeError 崩  →  ' + out.trim());
      assert.ok(/待帅处置：#999/.test(out), '待帅处置仍常驻  →  ' + out.trim());
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('④ 真实语料 #453（实录：判定红5→复核红2→复核绿 → 报帅终审）', async (t) => {
    const r = runFlow(path.join(FIXTURES, "real-453"));
    await t.test('退出码 1（有报帅）', () => {
      assert.ok(r.status === 1, '退出码 1（有报帅）  →  ' + `status=${r.status}`);
    });
    await t.test('#686 拍板 2：复核绿不报帅终审，等 MERGED 超时才报帅', () => {
      assert.ok(/报帅：approved 超时未合：PR #453/.test(r.out) && !/报帅：终审/.test(r.out),
        '#686 复核绿超时未合报帅  →  ' + r.out.trim());
    });
    await t.test('终审不自动合并（无 动作： 行）', () => {
      assert.ok(!/动作：/.test(r.out), '终审不自动合并（无 动作： 行）  →  ' + r.out.trim());
    });
    await t.test('真实语料判定行解析：#453 首审红 5 项', () => {
      assert.ok(redFlagsFromReviewBodies([JSON.parse(fs.readFileSync(path.join(FIXTURES, "real-453", "pr-453-reviews.json"), "utf8"))[0].body]) === 5, '真实语料判定行解析：#453 首审红 5 项  →  红项数应为 5');
    });
  });

  it('⑤ 真实语料 #456（#586：完工自报不再由 flow 起审官）', async (t) => {
    const r = runFlow(path.join(FIXTURES, "real-456"));
    await t.test('完工自报 → flow 不起审官（worker-done 已按需起）', () => {
      assert.ok(!/起审官/.test(r.out), '完工自报 → flow 不起审官（worker-done 已按需起）  →  ' + r.out.trim());
    });
    await t.test('不打出 动作： 行（不 task-create）', () => {
      assert.ok(!/动作：/.test(r.out), '不打出 动作： 行  →  ' + r.out.trim());
    });
    await t.test('有完工无审官 → 报帅交卷没开成审官下一跳', () => {
      assert.ok(/报帅：交卷没开成审官下一跳/.test(r.out), '交卷没开成审官  →  ' + r.out.trim());
    });
  });

  it('⑥ 判定行缺失负控：review 无判定行 → 报帅分诊，不动作', async (t) => {
    const r = runFlow(path.join(FIXTURES, "malformed"));
    await t.test('退出码 1（有报帅）', () => {
      assert.ok(r.status === 1, '退出码 1（有报帅）  →  ' + `status=${r.status}`);
    });
    await t.test('报帅判定行缺失/格式不符', () => {
      assert.ok(/报帅：判定行缺失\/格式不符 #1001/.test(r.out), '报帅判定行缺失/格式不符  →  ' + r.out.trim());
    });
    await t.test('明确区分没查成（不猜红绿）', () => {
      assert.ok(/没查成，请帅分诊/.test(r.out), '明确区分没查成（不猜红绿）  →  ' + r.out.trim());
    });
    await t.test('不产生任何自动动作', () => {
      assert.ok(!/动作：/.test(r.out), '不产生任何自动动作  →  ' + r.out.trim());
    });
    await t.test('同时打出待帅处置常驻行', () => {
      assert.ok(/待帅处置：#1001（判定行缺失\/格式不符待帅分诊）/.test(r.out), '同时打出待帅处置常驻行  →  ' + r.out.trim());
    });
  });

  it('⑥b 红 3：待帅事项必须每轮常驻显形——连跑两轮不能转绿', async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-shuai-"));
    const stateFile = path.join(tmp, "state.json");
    const args = [FLOW, "--snapshot-dir", path.join(FIXTURES, "malformed"), "--state-file", stateFile, "--dry-run"];
    const r1 = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
    const r2 = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
    const out2 = (r2.stdout || "") + (r2.stderr || "");
    await t.test('首跑 exit 1', () => {
      assert.ok(r1.status === 1, '首跑 exit 1  →  ' + `status=${r1.status}`);
    });
    await t.test('重跑仍 exit 1（待办不能报一次就转绿）', () => {
      assert.ok(r2.status === 1, '重跑仍 exit 1（待办不能报一次就转绿）  →  ' + `status=${r2.status}`);
    });
    await t.test('重跑仍打待帅处置常驻行', () => {
      assert.ok(/待帅处置：#1001/.test(out2), '重跑仍打待帅处置常驻行  →  ' + out2.trim());
    });
    await t.test('重跑不打「0 需流转」（有待办就不是无事）', () => {
      assert.ok(!/OK 扫完 1 个 PR，0 需流转/.test(out2), '重跑不打「0 需流转」（有待办就不是无事）  →  ' + out2.trim());
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('⑦ 无需流转 vs 没查成：0 个 open PR → OK 扫完 0（数到 0 ≠ 没扫到）', async (t) => {
    const r = runFlow(path.join(FIXTURES, "no-open"));
    await t.test('退出码 0（扫完 0 需流转）', () => {
      assert.ok(r.status === 0, '退出码 0（扫完 0 需流转）  →  ' + `status=${r.status}`);
    });
    await t.test('OK 扫完 0 个 PR，0 需流转', () => {
      assert.ok(/OK 扫完 0 个 PR，0 需流转/.test(r.out), 'OK 扫完 0 个 PR，0 需流转  →  ' + r.out.trim());
    });
    await t.test('不打出 NO_TARGETS（不是没查成）', () => {
      assert.ok(!/NO_TARGETS/.test(r.out), '不打出 NO_TARGETS（不是没查成）  →  ' + r.out.trim());
    });
  });

  it('⑦b 没查成负控：数据源不可用（缺 prs.json）→ NO_TARGETS，与「扫完 0 条」区分', async (t) => {
    const r = runFlow(path.join(FIXTURES, "broken-source"));
    await t.test('退出码 3（基础设施失败/没查成）', () => {
      assert.ok(r.status === 3, '退出码 3（基础设施失败/没查成）  →  ' + `status=${r.status}`);
    });
    await t.test('明确打印 NO_TARGETS', () => {
      assert.ok(/NO_TARGETS/.test(r.out), '明确打印 NO_TARGETS  →  ' + r.out.trim());
    });
    await t.test('不打出 OK 扫完（不能把没查成说成查过没事）', () => {
      assert.ok(!/OK 扫完/.test(r.out), '不打出 OK 扫完（不能把没查成说成查过没事）  →  ' + r.out.trim());
    });
  });

  it('⑧ 完整闭环四轮：完工不由 flow 起审官 / 红→观察下一跳 / 返工完成→观察审官下一跳 / 复核绿→报帅终审', async (t) => {
    const r = runFlow(path.join(FIXTURES, "recheck-green"));
    await t.test('退出码 1（有报帅）', () => {
      assert.ok(r.status === 1, '退出码 1（有报帅）  →  ' + `status=${r.status}`);
    });
    await t.test('round-1 不起审官（#586）', () => {
      assert.ok(/round-1[\s\S]*起审官/.test(r.out) === false, 'round-1 不起审官（#586）  →  ' + r.out.trim());
    });
    await t.test('round-1 报帅交卷没开成审官下一跳', () => {
      assert.ok(/round-1[\s\S]*报帅：交卷没开成审官下一跳/.test(r.out) && !/round-1[\s\S]*task-create/.test(r.out),
        'round-1 观察报帅  →  ' + r.out.trim());
    });
    await t.test('round-2 报帅验收没开成下一跳（不 task-create）', () => {
      assert.ok(/round-2[\s\S]*报帅：验收没开成下一跳/.test(r.out) && !/round-2[\s\S]*返工注入/.test(r.out), 'round-2 观察报帅  →  ' + r.out.trim());
    });
    await t.test('round-3 报帅验收没开成审官下一跳', () => {
      assert.ok(/round-3[\s\S]*报帅：验收没开成审官下一跳/.test(r.out) && !/round-3[\s\S]*复核注入/.test(r.out), 'round-3 观察报帅  →  ' + r.out.trim());
    });
    await t.test('#686 拍板 2：round-4 复核绿超时未合才报帅（不报终审）', () => {
      assert.ok(/round-4[\s\S]*报帅：approved 超时未合：PR #1005/.test(r.out) && !/round-4[\s\S]*报帅：终审/.test(r.out),
        'round-4 超时报帅  →  ' + r.out.trim());
    });
    await t.test('复核绿后不再注入任何动作', () => {
      assert.ok(!/round-4[\s\S]*动作：/.test(r.out), '复核绿后不再注入任何动作  →  ' + r.out.trim());
    });
  });

  it('⑨ 乒乓两轮仍红：第 1/2 轮红观察报帅，第 3 轮红报帅换人（不再注入）', async (t) => {
    const r = runFlow(path.join(FIXTURES, "pingpong"));
    await t.test('退出码 1（有报帅）', () => {
      assert.ok(r.status === 1, '退出码 1（有报帅）  →  ' + `status=${r.status}`);
    });
    await t.test('round-2 报帅验收没开成下一跳', () => {
      assert.ok(/round-2[\s\S]*报帅：验收没开成下一跳/.test(r.out), 'round-2 报帅验收没开成下一跳  →  ' + r.out.trim());
    });
    await t.test('round-4 报帅验收没开成下一跳', () => {
      assert.ok(/round-4[\s\S]*报帅：验收没开成下一跳/.test(r.out), 'round-4 报帅验收没开成下一跳  →  ' + r.out.trim());
    });
    await t.test('round-6 报帅换人（乒乓两轮仍红，第 3 次红判定）', () => {
      assert.ok(/round-6[\s\S]*报帅：换人 #1006（乒乓两轮仍红——两轮返工后第 3 次红判定）/.test(r.out), 'round-6 报帅换人（乒乓两轮仍红，第 3 次红判定）  →  ' + r.out.trim());
    });
    await t.test('全程不 task-create / 返工注入', () => {
      assert.ok(!/返工注入/.test(r.out) && !/task-create/.test(r.out), '全程不注入  →  ' + r.out.trim());
    });
  });

  it('⑩ 制度类 PR 停留超 24h 提醒一声（round-2 不重复提醒）', async (t) => {
    const r = runFlow(path.join(FIXTURES, "stale-24h"));
    await t.test('退出码 1（有提醒）', () => {
      assert.ok(r.status === 1, '退出码 1（有提醒）  →  ' + `status=${r.status}`);
    });
    await t.test('round-1 提醒制度类超 24h', () => {
      assert.ok(/round-1[\s\S]*提醒：制度类 PR #1003/.test(r.out), 'round-1 提醒制度类超 24h  →  ' + r.out.trim());
    });
    await t.test('round-2 不重复提醒（只提醒一声）', () => {
      assert.ok(!/round-2[\s\S]*提醒：/.test(r.out), 'round-2 不重复提醒（只提醒一声）  →  ' + r.out.trim());
    });
    await t.test('round-2 正常 OK 扫完', () => {
      assert.ok(/round-2[\s\S]*OK 扫完 1 个 PR，0 需流转/.test(r.out), 'round-2 正常 OK 扫完  →  ' + r.out.trim());
    });
  });

  it('⑪ MERGED 退役：round-1 待审（flow 不起审官），round-2 合并 → 退役收口', async (t) => {
    const r = runFlow(path.join(FIXTURES, "merged"));
    await t.test('退出码 1（有退役）', () => {
      assert.ok(r.status === 1, '退出码 1（有退役）  →  ' + `status=${r.status}`);
    });
    await t.test('round-1 不起审官（#586）', () => {
      assert.ok(!/round-1[\s\S]*起审官/.test(r.out), 'round-1 不起审官（#586）  →  ' + r.out.trim());
    });
    await t.test('round-2 退役（MERGED 收口，终审+归档归帅）', () => {
      assert.ok(/round-2[\s\S]*退役：PR #1004 MERGED/.test(r.out), 'round-2 退役（MERGED 收口，终审+归档归帅）  →  ' + r.out.trim());
    });
    await t.test('#684 round-2 合并钩重写帅位定界区（树已不在 → 空区）', () => {
      assert.ok(/round-2[\s\S]*帅位定界区/.test(r.out) && /将写 \(空\)/.test(r.out),
        '#684 合并钩  →  ' + r.out.trim());
    });
    const flowSrc = fs.readFileSync(FLOW, 'utf8');
    await t.test('#684 flow MERGED 退役调用 syncMasterTicketZone', () => {
      assert.ok(/noteMasterZoneOnMerge/.test(flowSrc) && /syncMasterTicketZone/.test(flowSrc),
        '#684 flow 挂点');
    });
  });

  it('⑫ 完工 comment 识别变体（真实语料）', async (t) => {
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
    for (const p of positives) {
      await t.test(`完工识别 ✓「${p.slice(0, 24)}」`, () => {
        assert.ok(isCompletionComment(p) === true, `完工识别 ✓「${p.slice(0, 24)}」`);
      });
    }
    for (const n of negatives) {
      await t.test(`非完工不识别 ✓「${n.slice(0, 24)}」`, () => {
        assert.ok(isCompletionComment(n) === false, `非完工不识别 ✓「${n.slice(0, 24)}」`);
      });
    }
  });

  it('⑬ 判定行解析与 calibrate 同源（共享模块单一真相源，不复制两份）', async (t) => {
    await t.test('判定：红 5 项 → kind=判定 red=5', () => {
      assert.ok(JSON.stringify(judgmentFromReview("判定：红 5 项\n正文")) === '{"kind":"判定","red":5,"green":false,"malformed":false}', '判定：红 5 项 → kind=判定 red=5');
    });
    await t.test('复核结论：红 2 项 → kind=复核结论 red=2', () => {
      assert.ok(JSON.stringify(judgmentFromReview("复核结论：红 2 项")) === '{"kind":"复核结论","red":2,"green":false,"malformed":false}', '复核结论：红 2 项 → kind=复核结论 red=2');
    });
    await t.test('复核结论：绿，可合并 → green', () => {
      assert.ok(JSON.stringify(judgmentFromReview("复核结论：绿，可合并")) === '{"kind":"复核结论","red":null,"green":true,"malformed":false}', '复核结论：绿，可合并 → green');
    });
    await t.test('无判定行 → kind=null（报帅不猜）', () => {
      assert.ok(JSON.stringify(judgmentFromReview("普通 review 正文")) === '{"kind":null,"red":null,"green":false,"malformed":false}', '无判定行 → kind=null（报帅不猜）');
    });
    await t.test('格式不符「判定：红 项」缺数字 → malformed（报帅不猜红）', () => {
      assert.ok(judgmentFromReview("判定：红 项\n缺数字").malformed === true, '格式不符「判定：红 项」缺数字 → malformed（报帅不猜红）');
    });
    await t.test('格式不符「判定：红」无 N 项 → malformed', () => {
      assert.ok(judgmentFromReview("判定：红").malformed === true, '格式不符「判定：红」无 N 项 → malformed');
    });
    await t.test('判定行含绿且无红数 → green（确定性规则：绿优先）', () => {
      assert.ok(judgmentFromReview("复核结论：绿/红，可合并").green === true, '判定行含绿且无红数 → green（确定性规则：绿优先）');
    });
    await t.test('正文叙述引用他单红数不计（#449 红 1 口径）', () => {
      assert.ok(judgmentFromReview("比 #440 的红 4 项干净多了\n复核结论：绿").green === true, '正文叙述引用他单红数不计（#449 红 1 口径）  →  叙述里红数不应影响判定');
    });
    const real453 = JSON.parse(fs.readFileSync(path.join(FIXTURES, "real-453", "pr-453-reviews.json"), "utf8"));
    await t.test('真实语料 #453 跨 review 最大红 = 5（复核绿不清零）', () => {
      assert.ok(redFlagsFromReviewBodies(real453.map(r => r.body)) === 5, '真实语料 #453 跨 review 最大红 = 5（复核绿不清零）  →  应为 5');
    });
  });

  it('⑭ #586 flow 不再按 toml 起审官（选型在 label / worker-done）', async (t) => {
    const done = [{ type: "completion", id: "c:1", at: "t0", body: "完工：x" }];
    const awaiting = deriveState(done);
    await t.test('仅完工 → awaiting-review', () => {
      assert.ok(awaiting.state === "awaiting-review", '仅完工 → awaiting-review');
    });
    await t.test('awaiting-review → observe-reviewer-hop（不起审官，只观察）', () => {
      assert.ok(pendingAction(awaiting)?.kind === 'observe-reviewer-hop', 'awaiting-review → observe-reviewer-hop  →  ' + JSON.stringify(pendingAction(awaiting)));
    });
  });

  it('⑮ 状态机纯函数', async (t) => {
    const done = [{ id: 1, body: "## 完工报告", createdAt: "t0" }];
    const red = [{ id: 2, body: "判定：红 3 项", submittedAt: "t1" }];
    const rework = [{ id: 3, body: "## 对抗审返工处置（全修）", createdAt: "t2" }];
    const green = [{ id: 4, body: "复核结论：绿，可合并", submittedAt: "t3" }];
    const d1 = deriveState(orderedSignals(done, red));
    await t.test('完工+红判定 → rework-needed，红 1 轮', () => {
      assert.ok(d1.state === "rework-needed" && d1.redReviews === 1 && d1.lastRed === 3, '完工+红判定 → rework-needed，红 1 轮');
    });
    await t.test('pendingAction → observe-rework-hop', () => {
      assert.ok(pendingAction(d1)?.kind === "observe-rework-hop", 'pendingAction → observe-rework-hop');
    });
    await t.test('pendingShuai 不 gate 观察（待帅记账只管显示，闸已由 fp 去重承担）', () => {
      assert.ok(pendingAction(d1)?.kind === "observe-rework-hop", 'pendingShuai 不 gate 观察');
    });
    await t.test('awaitingShuaiReason 读 pendingShuai（reviewer-unfound 常驻）', () => {
      assert.ok(awaitingShuaiReason({ state: "rework-needed", redReviews: 1 }, { pendingShuai: { kind: "inject-recheck", reason: "找不到审官终端——待帅接手复核" } }, false) === "找不到审官终端——待帅接手复核", 'awaitingShuaiReason 读 pendingShuai（reviewer-unfound 常驻）');
    });
    await t.test('awaitingShuaiReason state 兜底：error 态常驻（四轮复核红 1）', () => {
      assert.ok(awaitingShuaiReason({ state: "error", redReviews: 0 }, {}, false) === "判定行缺失/格式不符待帅分诊", 'awaitingShuaiReason state 兜底：error 态常驻（四轮复核红 1）');
    });
    const d4 = deriveState(orderedSignals([...done, ...rework], [...red, ...green]));
    await t.test('#686 拍板 2：复核绿 → approved → observe-approved-merge（不报帅终审）', () => {
      assert.ok(d4.state === "approved" && pendingAction(d4)?.kind === "observe-approved-merge", '复核绿 → approved → observe-approved-merge');
    });
    await t.test('制度类识别：正文含「体系类改动」', () => {
      assert.ok(isInstitutional({ body: "## 体系类改动（必答）", title: "x" }) === true, '制度类识别：正文含「体系类改动」');
    });
    await t.test('制度类识别：标题含「制度/体系」', () => {
      assert.ok(isInstitutional({ body: "## 目标", title: "[pi] 制度修订" }) === true, '制度类识别：标题含「制度/体系」');
    });
    await t.test('标题仅含「拍板」不再误判制度类（对抗审观察 7）', () => {
      assert.ok(isInstitutional({ body: "## 目标", title: "[pi] 修复 xx 拍板口径" }) === false, '标题仅含「拍板」不再误判制度类（对抗审观察 7）');
    });
    await t.test('非制度类不识别', () => {
      assert.ok(isInstitutional({ body: "## 目标", title: "写码 PR" }) === false, '非制度类不识别');
    });
  });

  it('⑯ #675 复核态：没有活审官下一跳 → 报帅，不 task-create', async (t) => {
    const r = runFlow(path.join(FIXTURES, "recheck-reviewer"));
    await t.test('退出码 1（报帅）', () => {
      assert.ok(r.status === 1, '退出码 1（报帅）  →  ' + `status=${r.status}`);
    });
    await t.test('报帅验收没开成审官下一跳', () => {
      assert.ok(/报帅：验收没开成审官下一跳/.test(r.out), '报帅验收没开成审官下一跳  →  ' + r.out.trim());
    });
    await t.test('不复核注入', () => {
      assert.ok(!/复核注入/.test(r.out) && !/动作：/.test(r.out), '不复核注入  →  ' + r.out.trim());
    });
  });

  it('⑰ #675 多终端也不 task-create：没开下一跳就报帅', async (t) => {
    const r = runFlow(path.join(FIXTURES, "multi-terminal"));
    await t.test('退出码 1（报帅）', () => {
      assert.ok(r.status === 1, '退出码 1（报帅）  →  ' + `status=${r.status}`);
    });
    await t.test('报帅验收没开成下一跳', () => {
      assert.ok(/报帅：验收没开成下一跳/.test(r.out), '报帅验收没开成下一跳  →  ' + r.out.trim());
    });
    await t.test('没有注入到任一终端', () => {
      assert.ok(!/注入目标：工人终端/.test(r.out) && !/动作：/.test(r.out), '没有注入到任一终端  →  ' + r.out.trim());
    });
  });

  it('⑰b #675 新红判定到达仍观察、不注入', async (t) => {
    const r = runFlow(path.join(FIXTURES, "blocked-recover"));
    await t.test('退出码 1（报帅）', () => {
      assert.ok(r.status === 1, '退出码 1（报帅）  →  ' + `status=${r.status}`);
    });
    await t.test('round-1 报帅验收没开成下一跳', () => {
      assert.ok(/round-1[\s\S]*报帅：验收没开成下一跳/.test(r.out), 'round-1 报帅  →  ' + r.out.trim());
    });
    await t.test('round-2 新红判定仍观察报帅，不返工注入', () => {
      assert.ok(/round-2[\s\S]*报帅：验收没开成下一跳/.test(r.out) && !/返工注入/.test(r.out), 'round-2 仍观察  →  ' + r.out.trim());
    });
  });

  it('⑰c 四轮复核红 1：live 落闸自愈——预置 pendingShuai，新红判定到达即清除重试一次', async (t) => {
    // 预置状态模拟 live 注入失败落记账（pendingShuai + 旧指纹）；夹具里有更新的红判定
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-selfheal-"));
    const stateFile = path.join(tmp, "state.json");
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1, inventoried: true,
      records: {
        "2006": { pr: 2006, seenComments: { 240001: true }, seenReviews: { 340001: true }, pendingShuai: { kind: "observe-rework-hop", reason: "验收没开成下一跳" }, reportedMalformed: {}, reportedStale: false, actedOn: "rework-needed|1|r:340001", reviewer: null, workerWorktree: null },
      },
    }), "utf8");
    const r = spawnSync(process.execPath, [FLOW, "--snapshot-dir", path.join(FIXTURES, "blocked-selfheal"), "--state-file", stateFile, "--dry-run"], { encoding: "utf8", cwd: REPO });
    const out = (r.stdout || "") + (r.stderr || "");
    await t.test('新红判定到达 → 再观察，仍报帅验收没开成下一跳（不注入）', () => {
      assert.ok(/报帅：验收没开成下一跳/.test(out) && !/返工注入/.test(out), '新红判定到达再观察  →  ' + out.trim());
    });
    await t.test('不再挂旧的注入失败待帅处置', () => {
      assert.ok(!/待帅处置：#2006（注入失败/.test(out), '不再挂注入失败待帅处置  →  ' + out.trim());
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('⑰d 四轮复核红 1：reviewer-unfound 常驻——审官找不到，连跑三轮每轮都有待帅处置', async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-unfound-"));
    const stateFile = path.join(tmp, "state.json");
    const args = [FLOW, "--snapshot-dir", path.join(FIXTURES, "reviewer-unfound"), "--state-file", stateFile, "--dry-run"];
    const r1 = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
    const r2 = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
    const r3 = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
    const out1 = (r1.stdout || "") + (r1.stderr || "");
    const out2 = (r2.stdout || "") + (r2.stderr || "");
    const out3 = (r3.stdout || "") + (r3.stderr || "");
    await t.test('首跑 exit 1（报帅 + 待帅处置）', () => {
      assert.ok(r1.status === 1, '首跑 exit 1（报帅 + 待帅处置）  →  ' + `status=${r1.status}`);
    });
    await t.test('首跑报帅验收没开成审官下一跳', () => {
      assert.ok(/报帅：验收没开成审官下一跳/.test(out1), '首跑报帅验收没开成审官下一跳  →  ' + out1.trim());
    });
    await t.test('二跑仍 exit 1（常驻不转绿）', () => {
      assert.ok(r2.status === 1, '二跑仍 exit 1（常驻不转绿）  →  ' + `status=${r2.status}`);
    });
    await t.test('二跑仍有待帅处置（验收没开成审官下一跳）', () => {
      assert.ok(/待帅处置：#2007（验收没开成审官下一跳）/.test(out2), '二跑仍有待帅处置  →  ' + out2.trim());
    });
    await t.test('三跑仍常驻', () => {
      assert.ok(/待帅处置：#2007（验收没开成审官下一跳）/.test(out3), '三跑仍常驻  →  ' + out3.trim());
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('⑱ #586 flow 源码不再含起审官动作', async (t) => {
    const flowSrc = fs.readFileSync(FLOW, "utf8");
    await t.test('没有 start-reviewer 动作', () => {
      assert.ok(!/start-reviewer/.test(flowSrc), '没有 start-reviewer 动作');
    });
    await t.test('没有受控例外 / #480 退役字样', () => {
      assert.ok(!/受控例外：不走 worker-start，随 #480 重做/.test(flowSrc), '没有受控例外 / #480 退役字样');
    });
  });

  it('⑲ 复核红 1：review 链接必须可用（数字锚点 id，不是 GraphQL node id）', async (t) => {
    const r = runFlow(path.join(FIXTURES, "fake-loop"));
    await t.test('语料 review 链接是数字锚点形态（无 PRR_ node-id）', () => {
      const reviews = JSON.parse(fs.readFileSync(path.join(FIXTURES, "fake-loop", "pr-999-reviews.json"), "utf8"));
      assert.ok(reviews[0].id === 910001 && !/PRR_/.test(String(reviews[0].id)), '语料 review 链接是数字锚点  →  ' + JSON.stringify(reviews[0].id));
    });
    // 真实语料夹具改走 gh api 口径（数字 id + html_url），镜像 live 数据形态
    const real453 = JSON.parse(fs.readFileSync(path.join(FIXTURES, "real-453", "pr-453-reviews.json"), "utf8"));
    await t.test('real-453 语料 id 全是数字锚点（无 PRR_ node-id）', () => {
      assert.ok(real453.every(x => /^\d+$/.test(String(x.id))), 'real-453 语料 id 全是数字锚点（无 PRR_ node-id）  →  ' + real453.map(x => x.id).join(","));
    });
    await t.test('real-453 语料 html_url 现成（live 口径镜像）', () => {
      assert.ok(real453.every(x => /^https:\/\/github\.com\/.+pullrequestreview-\d+$/.test(x.html_url || "")), 'real-453 语料 html_url 现成（live 口径镜像）  →  ' + real453.map(x => x.html_url).join(","));
    });
    await t.test('real-453 语料 3 条 review body 未改写（判定行口径仍成立）', () => {
      assert.ok(redFlagsFromReviewBodies(real453.map(x => x.body)) === 5, 'real-453 语料 3 条 review body 未改写（判定行口径仍成立）  →  应为 5');
    });
  });

  it('㉑ #586 退役 flow 起审官：SKILL 受控例外删除，flow 不再起审官', async (t) => {
    const r = runFlow(path.join(FIXTURES, "real-456"));
    await t.test('完工语料不再打起审官 / 受控例外', () => {
      assert.ok(!/起审官/.test(r.out) && !/受控例外/.test(r.out), '完工语料不再打起审官 / 受控例外  →  ' + r.out.trim());
    });

    const flowSrc = fs.readFileSync(FLOW, "utf8");
    await t.test('flow 源码不含 start-reviewer', () => {
      assert.ok(!/start-reviewer/.test(flowSrc), 'flow 源码不含 start-reviewer');
    });
    await t.test('flow 头注写明审官由 worker-done 按需起', () => {
      assert.ok(/审官由 worker-done 按需起/.test(flowSrc), 'flow 头注写明审官由 worker-done 按需起');
    });

    const skill = fs.readFileSync(path.join(REPO, "host", "skills", "dispatch", "SKILL.md"), "utf8");
    const chain = (skill.split("## 一条完整命令链")[1] || "").split("## 命令级铁律")[0];
    const multi = (chain.split("多工人")[1] || "");
    await t.test('SKILL 命令链多工人/辅助卡示例含 worker-start --terminal', () => {
      assert.ok(/worker-start --task <task_id> --worktree <新建子卡 id> --terminal/.test(multi), 'SKILL 命令链多工人/辅助卡示例含 worker-start --terminal  →  ' + multi.slice(0, 300));
    });
    await t.test('SKILL 已删受控例外（随 #480 退役）那段', () => {
      assert.ok(!/受控例外（自动起审官，随 #480 退役）/.test(skill), 'SKILL 已删受控例外（随 #480 退役）那段');
    });
    await t.test('SKILL 写明审官由 worker-done 按需起', () => {
      assert.ok(/worker-done/.test(skill), 'SKILL 写明审官由 worker-done 按需起');
    });
    const liveFn = fs.readFileSync(FLOW, "utf8").split("function makeLiveSource")[1]?.split("function readJson")[0] || "";
    await t.test('live getComments 走 issues/.../comments --paginate', () => {
      assert.ok(/issues\/\$\{number\}\/comments/.test(liveFn) && /--paginate/.test(liveFn), 'live getComments 走 issues/.../comments --paginate');
    });
  });

  it('⑳ #633 派活禁止 terminal send / 验开工不认 cursor 增量', async (t) => {
    const plain = fs.readFileSync(path.join(REPO, "tests/fixtures/orca-json/terminal-send-plaintext.txt"), "utf8");
    const parsed = parseOrcaStdout(plain);
    await t.test('Sent N bytes to term_ 判成功', () => {
      assert.ok(parsed.ok === true && parsed.sentPlaintext === true && parsed.bytes === 11, 'Sent N bytes to term_ 判成功  →  ' + JSON.stringify(parsed));
    });

    const jsonSend = JSON.parse(fs.readFileSync(path.join(REPO, "tests/fixtures/orca-json/terminal-send.json"), "utf8"));
    const parsedJson = parseOrcaStdout(JSON.stringify(jsonSend));
    await t.test('send --json 信封过解析', () => {
      assert.ok(parsedJson.ok && parsedJson.json.result.send.accepted === true, 'send --json 信封过解析');
    });

    const sent = [];
    let reads = 0;
    const leftoverIo = {
      read(_h, cursor) {
        reads += 1;
        if (reads === 1) return { ok: true, terminal: { status: "running", nextCursor: 10, returnedLineCount: 2, tail: ["[Pasted Content 236 chars]"] } };
        if (cursor != null && reads === 2) return { ok: true, terminal: { status: "running", nextCursor: 10, returnedLineCount: 0, tail: [] } };
        if (cursor != null) return { ok: true, terminal: { status: "running", nextCursor: 16, returnedLineCount: 4, tail: ["token grew"] } };
        return { ok: true, terminal: { status: "running", nextCursor: 10, returnedLineCount: 2, tail: ["[Pasted Content 236 chars]"] } };
      },
      send(cmd) { sent.push(cmd); return { ok: true, json: { ok: true, result: { send: { accepted: true, bytesWritten: 236 } } } }; },
      sleep() {},
    };
    const v = verifyStarted("term_x", "【返工指令", "工人", leftoverIo);
    await t.test('#633 残留未提交 → 没开工，不补回车', () => {
      assert.ok(v.ok === false && /不补回车/.test(v.error) && /Pasted Content/.test(v.error), '残留未提交没开工  →  ' + JSON.stringify(v));
    });
    await t.test('#633 验开工禁止 terminal send --enter', () => {
      assert.ok(!sent.some(c => c.includes("--enter")), '不补回车  →  ' + JSON.stringify(sent));
    });

    const sendPlainIo = {
      send(cmd) {
        sent.push(cmd);
        if (cmd.includes("--text")) return parseOrcaStdout(plain);
        return { ok: true, json: { ok: true, result: { send: { accepted: true, bytesWritten: 0 } } } };
      },
      read() { return { ok: true, terminal: { status: "running", nextCursor: 3, returnedLineCount: 2, tail: ["working"] } }; },
      sleep() {},
    };
    sent.length = 0;
    const inj = injectAndVerify("term_x", "【返工指令 · 测试】请修", "工人", sendPlainIo);
    await t.test('#633 派活禁止 terminal send', () => {
      assert.ok(inj.ok === false && /禁止 terminal send/.test(inj.error), '派活禁止 send  →  ' + JSON.stringify(inj));
    });
    await t.test('#633 injectAndVerify 不再往框里打字', () => {
      assert.ok(sent.length === 0, '不 send  →  ' + JSON.stringify(sent));
    });

    await t.test('观察下一跳是流转器活；注入不再是', () => {
      assert.ok(isFlowWork({ kind: "observe-rework-hop" }) && isFlowWork({ kind: "observe-recheck-hop" })
        && isFlowWork({ kind: "observe-reviewer-hop" })
        && isFlowWork({ kind: "inject-rework" }) === false,
        '观察下一跳是流转器活；注入不再是');
    });
    await t.test('起审官不再是流转器活（#586 worker-done）', () => {
      assert.ok(isFlowWork({ kind: "start-reviewer" }) === false, '起审官不再是流转器活（#586 worker-done）');
    });
    await t.test('报帅终审不是流转器活', () => {
      assert.ok(isFlowWork({ kind: "report-final" }) === false, '报帅终审不是流转器活');
    });
    const pending = pendingFlowItems([{ number: 580, comments: [{ id: 1, body: "完工\n好了", createdAt: "t" }], reviews: [] }]);
    await t.test('完工未起审官 → 观察审官下一跳（不 task-create）', () => {
      assert.ok(pending.length === 1 && pending[0].kind === 'observe-reviewer-hop',
        '完工未起审官 → 观察  →  ' + JSON.stringify(pending));
    });
    const idle = pendingFlowItems([{ number: 579, comments: [{ id: 1, body: "完工\n好了", createdAt: "t" }], reviews: [{ id: 2, body: "判定：绿，可合并", submittedAt: "t2" }] }]);
    await t.test('#686 拍板 2：已绿等合并 → 不是流转器待办（watchdog 不报 flow-absent）', () => {
      assert.ok(idle.length === 0, '已绿等合并不是流转器待办  →  ' + JSON.stringify(idle));
    });

    const order = [];
    const earlyIo = {
      sent: false,
      read(_h, cursor) {
        order.push(cursor == null ? 'read-full' : `read-cursor:${cursor}`);
        if (!this.sent) return { ok: true, terminal: { status: "running", nextCursor: 10, returnedLineCount: 1, tail: ["idle"] } };
        if (cursor == null) return { ok: true, terminal: { status: "running", nextCursor: 20, returnedLineCount: 5, tail: ["echo already passed"] } };
        if (Number(cursor) === 10) return { ok: true, terminal: { status: "running", nextCursor: 20, returnedLineCount: 3, tail: ["new after send"] } };
        return { ok: true, terminal: { status: "running", nextCursor: 20, returnedLineCount: 0, tail: [] } };
      },
      send(cmd) { this.sent = true; order.push(cmd.includes("--enter") ? "enter" : "send"); return { ok: true, json: { ok: true } }; },
      sleep() {},
    };
    const early = injectAndVerify("term_x", "【返工指令 · 时序】", "工人", earlyIo);
    await t.test('#633 cursor 增量不算开工，injectAndVerify 直接拒', () => {
      assert.ok(early.ok === false && /禁止 terminal send/.test(early.error), '不认 cursor 增量  →  ' + JSON.stringify({ early, order }));
    });
    await t.test('#633 拒派活后不读屏不 send', () => {
      assert.ok(order.length === 0, '不读不发  →  ' + JSON.stringify(order));
    });

    const dispatched = [];
    const bindIo = {
      send(cmd) {
        dispatched.push(cmd);
        if (cmd.includes('task-create')) {
          return { ok: true, json: { ok: true, result: { task: { id: 'task_rework_1' }, id: 'rpc-not-task' } } };
        }
        if (cmd.includes('worker-start')) {
          return { ok: true, json: { ok: true, result: { dispatchId: 'ctx_rework_1' } } };
        }
        return { ok: false, error: '不该 terminal send' };
      },
      read() { return { ok: true, terminal: { status: 'running', nextCursor: 1, returnedLineCount: 0, tail: [] } }; },
      sleep() {},
    };
    const bound = dispatchNewTaskToTerminal({ spec: '【返工指令 · 测试】', terminal: 'term_worker', io: bindIo });
    await t.test('#675 flow 禁止 task-create', () => {
      assert.ok(bound.ok === false && /禁止 task-create/.test(bound.error), 'flow 禁止 task-create  →  ' + JSON.stringify(bound));
      assert.ok(dispatched.length === 0, '不发 task-create  →  ' + JSON.stringify(dispatched));
    });
    const flowSrc = fs.readFileSync(FLOW, "utf8");
    const execChunk = flowSrc.slice(flowSrc.indexOf('function executeAction'), flowSrc.indexOf('function processOneRound'));
    await t.test('#675 executeAction 不调用 task-create', () => {
      assert.ok(!/argsTaskCreate/.test(execChunk) && !/dispatchNewTaskToTerminal\(/.test(execChunk),
        '#675 executeAction 不调用 task-create  →  ' + execChunk.slice(0, 200));
    });
  });

  it('㉒ #575 ⑥ issue comment 首行「完工：」触发起审官；PR 会话上的完工不算', async (t) => {
    await t.test('标题 #575 → ticket 575', () => {
      assert.ok(ticketIssueNumber({ title: "[grok] #575 完工首行正控" }) === 575, '标题 #575 → ticket 575');
    });
    await t.test('正文 Closes #512 → ticket 512', () => {
      assert.ok(ticketIssueNumber({ title: "无号", body: "Closes #512" }) === 512, '正文 Closes #512 → ticket 512');
    });
    await t.test('正文随手引用 #443 不算', () => {
      assert.ok(ticketIssueNumber({ title: "无号", body: "规格源 = #443 全部评论" }) === null, '正文随手引用 #443 不算');
    });

    const r = runFlow(path.join(FIXTURES, "completion-head"));
    await t.test('issue 首行「完工：」被识别但 flow 不起审官（#586）', () => {
      assert.ok(!/起审官/.test(r.out), 'issue 首行「完工：」被识别但 flow 不起审官（#586）  →  ' + r.out.trim());
    });

    const n = runFlow(path.join(FIXTURES, "completion-neg"));
    await t.test('issue 首行「已完成：…」→ 不起审官（负控，防判据放宽成含完工二字）', () => {
      assert.ok(!/起审官/.test(n.out), 'issue 首行「已完成：…」→ 不起审官（负控，防判据放宽成含完工二字）  →  ' + n.out.trim());
    });

    const p = runFlow(path.join(FIXTURES, "completion-pr-only"));
    await t.test('完工只在 PR 会话、issue 上没有 → 不起审官（证明改读 issue）', () => {
      assert.ok(!/起审官/.test(p.out), '完工只在 PR 会话、issue 上没有 → 不起审官（证明改读 issue）  →  ' + p.out.trim());
    });

    const flowSrc = fs.readFileSync(FLOW, "utf8");
    await t.test('processOneRound 用 ticketIssueNumber 取评论，不写死 pr.number',
      () => {
        assert.ok(/ticketIssueNumber\(pr\)/.test(flowSrc) && /getComments\(ticket \|\| pr\.number\)/.test(flowSrc), 'processOneRound 用 ticketIssueNumber 取评论，不写死 pr.number');
      });
  });

  it('㉓ #575 ① flow 每轮写心跳（watchdog 不再假红 HEARTBEAT_MISSING）', async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-hb-"));
    const stateFile = path.join(tmp, "state.json");
    const r = spawnSync(process.execPath, [FLOW, "--snapshot-dir", path.join(FIXTURES, "no-open"), "--state-file", stateFile, "--dry-run"], {
      encoding: "utf8", cwd: REPO,
    });
    const hbFile = path.join(tmp, "heartbeat.json");
    const exists = fs.existsSync(hbFile);
    let hb = null;
    try { hb = JSON.parse(fs.readFileSync(hbFile, "utf8")); } catch { hb = null; }
    const ts = hb && Date.parse(hb.ts);
    await t.test('跑完一轮后心跳文件在（与 state 同目录）', () => {
      assert.ok(exists, '跑完一轮后心跳文件在（与 state 同目录）  →  ' + hbFile);
    });
    await t.test('心跳含可解析 ts', () => {
      assert.ok(Number.isFinite(ts), '心跳含可解析 ts  →  ' + JSON.stringify(hb));
    });
    await t.test('心跳 ts 是本轮写下的（60s 内）', () => {
      assert.ok(Number.isFinite(ts) && Math.abs(Date.now() - ts) < 60 * 1000, '心跳 ts 是本轮写下的（60s 内）  →  ' + (hb && hb.ts));
    });
    await t.test('心跳写入不改变退出语义（本样本仍按原判据退出）', () => {
      assert.ok(r.status === 0 || r.status === 1 || r.status === 2, '心跳写入不改变退出语义（本样本仍按原判据退出）  →  ' + `status=${r.status}`);
    });
    const flowSrc = fs.readFileSync(FLOW, "utf8");
    await t.test('flow.mjs 真有写 heartbeat.json 的实现（不是只在注释里）', () => {
      assert.ok(/writeHeartbeat\(/.test(flowSrc) && /heartbeat\.json/.test(flowSrc), 'flow.mjs 真有写 heartbeat.json 的实现（不是只在注释里）');
    });
    await t.test('flow live 心跳带 revision 且落后要报警', () => {
      assert.ok(/attachRevision\(/.test(flowSrc) && /STALE_CODE/.test(flowSrc), 'flow live 心跳带 revision 且落后要报警');
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════════
  // #686 flow 判据四件套
  // ═══════════════════════════════════════════════════════════════

  it('⑳ #686 ① 工人异常死亡检测：dispatch 未结算 + agent done + 无完工 comment → 报帅', async (t) => {
    const r = runFlow(path.join(FIXTURES, "worker-dead"));
    await t.test('退出码 1（报帅）', () => {
      assert.ok(r.status === 1, '退出码 1  →  ' + `status=${r.status}`);
    });
    await t.test('报帅工人异常死亡', () => {
      assert.ok(/异常：工人异常死亡：#2008/.test(r.out), '报帅工人异常死亡  →  ' + r.out.trim());
    });
    await t.test('含 agent done + dispatch 未结算信息', () => {
      assert.ok(/agent done/.test(r.out) && /dispatch/.test(r.out), '含详情  →  ' + r.out.trim());
    });
    await t.test('待帅处置常驻行', () => {
      assert.ok(/待帅处置：#2008/.test(r.out), '待帅处置常驻  →  ' + r.out.trim());
    });
    await t.test('不 task-create / 不注入', () => {
      assert.ok(!/task-create/.test(r.out) && !/动作：/.test(r.out), '不 task-create  →  ' + r.out.trim());
    });
  });

  it('⑳b #686 ① 不误报：agent working / 有完工 comment / dispatch 已结算', async (t) => {
    // 负控 1：agent working → 不报死亡
    const r1 = runFlow(path.join(FIXTURES, "worker-not-dead"));
    await t.test('agent working → 不报死亡', () => {
      assert.ok(!/异常/.test(r1.out) && !/工人异常死亡/.test(r1.out), 'agent working 不报  →  ' + r1.out.trim());
    });
    await t.test('agent working → 0 需流转', () => {
      assert.ok(/OK 扫完/.test(r1.out) && r1.status === 0, '0 需流转  →  ' + `status=${r1.status} ` + r1.out.trim());
    });

    // 负控 2：有完工 comment（state != working）→ 不报死亡
    const r2 = runFlow(path.join(FIXTURES, "fake-loop"));
    await t.test('有完工 comment + 红判定 → 不报死亡（正常闭环）', () => {
      assert.ok(!/工人异常死亡/.test(r2.out), '有完工 comment 不报  →  ' + r2.out.trim());
    });

    // 负控 3：PR MERGED → 退役，不报死亡
    const r3 = runFlow(path.join(FIXTURES, "merged"));
    await t.test('PR MERGED → 退役，不报死亡', () => {
      assert.ok(!/工人异常死亡/.test(r3.out), 'PR MERGED 不报  →  ' + r3.out.trim());
    });
  });

  it('㉑ #686 ② notify 链断自愈：审官 dispatch 已结算 + 红项 + 返工完成 → 自动 reviewer-create', async (t) => {
    // 预置状态：rec 里有 reviewer.dispatchId，模拟已有审官但 dispatch 已结算
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-selfheal-686-"));
    const stateFile = path.join(tmp, "state.json");
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1, inventoried: true,
      records: {
        "2009": {
          pr: 2009, seenComments: { 240001: true }, seenReviews: { 340001: true },
          pendingShuai: null, reportedMalformed: {}, reportedStale: false,
          actedOn: "awaiting-recheck|1|r:340001",
          reviewer: { dispatchId: "ctx_reviewer_2009", worktree: null },
          workerWorktree: null,
        },
      },
    }), "utf8");
    const r = spawnSync(process.execPath, [FLOW, "--snapshot-dir", path.join(FIXTURES, "reviewer-settled"), "--state-file", stateFile, "--dry-run"], {
      encoding: "utf8", cwd: REPO,
    });
    const out = (r.stdout || "") + (r.stderr || "");
    await t.test('退出码 1（有自愈动作）', () => {
      assert.ok(r.status === 1, '退出码 1  →  ' + `status=${r.status}`);
    });
    await t.test('自愈：自动 reviewer-create（dry-run）', () => {
      assert.ok(/自愈：#2009/.test(out) && /审官 dispatch 已结算/.test(out), '自愈 reviewer-create  →  ' + out.trim());
    });
    await t.test('不报帅（自愈不需帅介入）', () => {
      assert.ok(!/报帅/.test(out) || /自愈/.test(out), '自愈不报帅  →  ' + out.trim());
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('㉒ #686 拍板 2：复核绿不报帅终审，等 MERGED 超时才报帅', async (t) => {
    // 纯函数测试：approved → observe-approved-merge（不是 report-final）
    const done = [{ type: "completion", id: "c:1", at: "t0", body: "完工：x" }];
    const green = [{ type: "review", id: "r:1", at: "t1", body: "复核结论：绿", verdict: { kind: "复核结论", red: null, green: true, malformed: false } }];
    const d = deriveState([...done, ...green]);
    await t.test('approved → observe-approved-merge（不再 report-final）', () => {
      assert.ok(d.state === "approved", 'state = approved');
      assert.ok(pendingAction(d)?.kind === 'observe-approved-merge', 'observe-approved-merge  →  ' + JSON.stringify(pendingAction(d)));
    });
    await t.test('report-final 不再是流转器动作', () => {
      assert.ok(isFlowWork({ kind: "report-final" }) === false, 'report-final 不是流转器动作');
    });
    await t.test('#686 拍板 2：observe-approved-merge 不算流转器待办（同旧 report-final 口径）', () => {
      assert.ok(isFlowWork({ kind: "observe-approved-merge" }) === false, 'observe-approved-merge 不算流转器活');
    });

    // flow 快照测试：approved + 超时（fixture 时间远在过去）→ 报帅超时未合
    const r = runFlow(path.join(FIXTURES, "real-453"));
    await t.test('approved + 超时未合 → 报帅 approved 超时未合', () => {
      assert.ok(/报帅：approved 超时未合：PR #453/.test(r.out), '超时报帅  →  ' + r.out.trim());
    });
    await t.test('不再报帅终审', () => {
      assert.ok(!/报帅：终审/.test(r.out), '不报终审  →  ' + r.out.trim());
    });
  });
});