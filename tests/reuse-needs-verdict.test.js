// tests/reuse-needs-verdict.test.js —— 复用审官会话要先问「它真的交了判定吗」
//
// 起因（2026-09-15 实咬，#1289）：19 张 PR 冻了一整天。
// 审官会话跑完、分析做完、结论写在会话文本里（实测读到「核心检查结果已齐…
// 还确认了一个实质逻辑洞…」），但**从没调 gh pr review 把判定落到 GitHub**，
// 然后以 phase=done 收尾。下一轮 reviewer-create 看到 done + 无 error，
// 判「正常完工」→ 复用 → 一个字都不发生。实测 6 张连派 6 次，outcome 全是 reused。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verdictOnHead } from '../scripts/lib/review-state.mjs';
import { judgeReviewerSessionReuse, decideReviewerCreateStart, runLockedReviewerCreate, mustRecheckVerdictUnderLock } from '../scripts/lib/dispatch/reviewer-mirasim.mjs';
import { judgeVerdictOnHead } from '../scripts/dao.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const record = { sessionKey: 'codex:02923a47-bc9b-492f-a537-20b23b8691ba', expectedOid: HEAD };
const rv = (state, oid) => ({ state, commit: { oid } });

/** 注入 gh：认一次快照 `headRefOid,reviews`，也认拆开的字段（用来钉死分读竞态）。 */
const fakeGh = ({ headOid, reviews, headOk = true }) => (argv) => {
  const json = String(argv[argv.length - 1] || '');
  const fields = json.split(',');
  if (fields.includes('headRefOid') && !headOk) {
    return { ok: false, error: 'simulated gh failure' };
  }
  const out = {};
  if (fields.includes('headRefOid')) out.headRefOid = headOid;
  if (fields.includes('reviews')) out.reviews = reviews;
  if (Object.keys(out).length === 0) return { ok: false, error: `unexpected argv: ${argv.join(' ')}` };
  return { ok: true, out: JSON.stringify(out) };
};

describe('当前 head 上有没有判定（三态）', () => {
  it('判定打在当前 head ⇒ true', () => {
    assert.equal(verdictOnHead([rv('CHANGES_REQUESTED', HEAD)], HEAD), true);
    assert.equal(verdictOnHead([rv('APPROVED', HEAD)], HEAD), true);
  });

  it('判定只打在旧码上 ⇒ false（确认没有）', () => {
    assert.equal(verdictOnHead([rv('CHANGES_REQUESTED', OLD)], HEAD), false);
  });

  it('一条判定都没有 ⇒ false', () => {
    assert.equal(verdictOnHead([], HEAD), false);
  });

  it('COMMENTED 不算判定——它不表态', () => {
    assert.equal(verdictOnHead([rv('COMMENTED', HEAD)], HEAD), false);
  });

  it('读不到 reviews 数组 ⇒ null（没查成）', () => {
    assert.equal(verdictOnHead(null, HEAD), null);
    assert.equal(verdictOnHead(undefined, HEAD), null);
  });

  it('不知道 head ⇒ null——判不了「打在 head 上」', () => {
    assert.equal(verdictOnHead([rv('APPROVED', HEAD)], ''), null);
    assert.equal(verdictOnHead([rv('APPROVED', HEAD)], null), null);
  });

  it('有判定但读不到它打在哪个 commit ⇒ null，不许当成「没有」', () => {
    assert.equal(verdictOnHead([{ state: 'CHANGES_REQUESTED' }], HEAD), null);
    assert.equal(verdictOnHead([rv('APPROVED', '')], HEAD), null);
  });

  it('多条里只要有一条打在 head 上就算有', () => {
    assert.equal(verdictOnHead([rv('CHANGES_REQUESTED', OLD), rv('APPROVED', HEAD)], HEAD), true);
  });
});

describe('复用判据', () => {
  const done = { phase: 'done' };

  it('会话收尾了但当前 head 没判定 ⇒ 不复用（本单要治的那一格）', () => {
    const got = judgeReviewerSessionReuse({ record, view: done, verdictOnHead: false });
    assert.equal(got.reuse, false);
    assert.match(got.why, /会话结束 ≠ 活干完了/);
  });

  it('会话收尾了且判定在当前 head ⇒ 复用（一 PR 一审官的本意）', () => {
    const got = judgeReviewerSessionReuse({ record, view: done, verdictOnHead: true });
    assert.equal(got.reuse, true);
  });

  it('判定没查成 ⇒ 维持原样复用，不许拿「读不到」去重复烧额度', () => {
    assert.equal(judgeReviewerSessionReuse({ record, view: done, verdictOnHead: null }).reuse, true);
    assert.equal(judgeReviewerSessionReuse({ record, view: done }).reuse, true);
  });

  it('会话还在跑、没判定 ⇒ 照旧复用（它可能马上就交）', () => {
    for (const phase of ['running', 'streaming']) {
      const got = judgeReviewerSessionReuse({ record, view: { phase }, verdictOnHead: false });
      assert.equal(got.reuse, true, `${phase} 不该另起`);
    }
  });

  it('incomplete 照旧不复用（老判据一个字没动）', () => {
    assert.equal(judgeReviewerSessionReuse({ record, view: { phase: 'incomplete' }, verdictOnHead: true }).reuse, false);
  });

  it('view 没查成 ⇒ 照旧复用，新判据不许把这条放松', () => {
    assert.equal(judgeReviewerSessionReuse({ record, view: null, verdictOnHead: false }).reuse, true);
  });

  it('--force 照旧一律另起', () => {
    assert.equal(judgeReviewerSessionReuse({ record, view: done, force: true, verdictOnHead: true }).reuse, false);
  });

  it('其它终态（failed/gone/stopped）没判定时也另起', () => {
    for (const phase of ['failed', 'gone', 'stopped', 'aborted']) {
      const got = judgeReviewerSessionReuse({ record, view: { phase }, verdictOnHead: false });
      assert.equal(got.reuse, false, `${phase} 该另起`);
    }
  });
});

describe('透传：包装函数不许把 verdictOnHead 吃掉', () => {
  it('decideReviewerCreateStart 一路传下去', () => {
    const got = decideReviewerCreateStart({
      force: false, switched: false, deadError: null,
      record, view: { phase: 'done' }, verdictOnHead: false,
    });
    assert.equal(got.reuse.reuse, false);
    assert.equal(got.race.raced, false);
    assert.equal(got.start, true, '要真的去起一个新会话');
  });

  it('有判定时仍然复用、不重复起', () => {
    const got = decideReviewerCreateStart({
      force: false, switched: false, deadError: null,
      record, view: { phase: 'done' }, verdictOnHead: true,
    });
    assert.equal(got.start, false);
  });

  it('runLockedReviewerCreate 也要传（#1293 审官 P1：锁内漏传 = 锁外白判）', async () => {
    let created = 0;
    const locked = await runLockedReviewerCreate({
      forceNew: false, record, view: { phase: 'done' }, verdictOnHead: false,
      create: () => { created += 1; return { ok: true }; },
    });
    assert.equal(locked.raced, false, JSON.stringify(locked));
    assert.equal(created, 1, '终态且当前 head 无判定：锁内必须走到 create，不许落回复用');

    const reused = await runLockedReviewerCreate({
      forceNew: false, record, view: { phase: 'done' }, verdictOnHead: true,
      create: () => { throw new Error('当前 head 已有判定，不许再起'); },
    });
    assert.equal(reused.raced, true, JSON.stringify(reused));
  });
});

describe('锁外 true、锁内新 HEAD 无判定 ⇒ 必须 create（#1293 二审 P1）', () => {
  // 审官判别性实证：旧 HEAD 有判定、当前 HEAD 已变化且没有判定。
  // 只透传锁外 verdict → outsideReuse:true, lockedRaced:true, createCalls:0（新提交没审官）。
  // 持锁后重读并把这份快照交给 runLockedReviewerCreate → createCalls:1。

  it('终态 reuse 必须持锁重读，在役/没查成才许锁外退出', () => {
    assert.equal(mustRecheckVerdictUnderLock({ reuse: true, view: { phase: 'done' } }), true);
    assert.equal(mustRecheckVerdictUnderLock({ reuse: true, view: { phase: 'failed' } }), true);
    assert.equal(mustRecheckVerdictUnderLock({ reuse: true, view: { phase: 'running' } }), false);
    assert.equal(mustRecheckVerdictUnderLock({ reuse: true, view: null }), false);
    assert.equal(mustRecheckVerdictUnderLock({ reuse: false, view: { phase: 'done' } }), false);
  });

  it('锁外旧 HEAD 有判定、锁内新 HEAD 无判定 ⇒ create()，不许 reused', async () => {
    const outside = decideReviewerCreateStart({
      force: false, switched: false, deadError: null,
      record, view: { phase: 'done' }, verdictOnHead: true,
    });
    assert.equal(outside.reuse.reuse, true, '锁外快照会判 reuse');
    assert.equal(
      mustRecheckVerdictUnderLock({ reuse: outside.reuse.reuse, view: { phase: 'done' } }),
      true,
      '终态 reuse 不许在锁外 emit 退出，否则锁内重读跑不到',
    );

    const lockedVerdict = judgeVerdictOnHead('1293', record, null, {
      runGh: fakeGh({ headOid: HEAD, reviews: [] }),
    });
    assert.equal(lockedVerdict, false, '新 HEAD 确认没有判定');

    let createCalls = 0;
    const locked = await runLockedReviewerCreate({
      forceNew: false, record, view: { phase: 'done' }, verdictOnHead: lockedVerdict,
      create: () => { createCalls += 1; return { ok: true }; },
    });
    assert.equal(locked.raced, false, JSON.stringify(locked));
    assert.equal(locked.outcome, undefined);
    assert.equal(createCalls, 1, '锁内新 HEAD 无判定必须调用 create()');

    // 对照：把锁外旧值透传进去会跳过 create——这就是本 P1 要钉死的病。
    const stale = await runLockedReviewerCreate({
      forceNew: false, record, view: { phase: 'done' }, verdictOnHead: true,
      create: () => { throw new Error('透传锁外 true 不该走到 create'); },
    });
    assert.equal(stale.raced, true);
    assert.equal(stale.outcome, 'reused');
  });
});

describe('对账目标是 PR 当前 head，不是登记里的 expectedOid（#1293 审官 P1）', () => {
  // record.expectedOid 钉着旧提交；GitHub 上 PR 已推到 HEAD。
  const staleRecord = { sessionKey: 'codex:02923a47-bc9b-492f-a537-20b23b8691ba', expectedOid: OLD };

  it('判定只打在登记钉的旧提交上 ⇒ false（确认当前 head 没有）', () => {
    const got = judgeVerdictOnHead('1293', staleRecord, null, {
      runGh: fakeGh({ headOid: HEAD, reviews: [rv('APPROVED', OLD)] }),
    });
    assert.equal(got, false, '旧提交上的判定不许误认作当前 head 已判定');
  });

  it('判定打在 GitHub 读到的当前 head 上 ⇒ true', () => {
    const got = judgeVerdictOnHead('1293', staleRecord, null, {
      runGh: fakeGh({ headOid: HEAD, reviews: [rv('CHANGES_REQUESTED', HEAD)] }),
    });
    assert.equal(got, true);
  });

  it('当前 head 读不到 ⇒ null（没查成），不许拿登记里的 oid 顶上', () => {
    const got = judgeVerdictOnHead('1293', staleRecord, null, {
      runGh: fakeGh({ headOid: HEAD, reviews: [rv('APPROVED', HEAD)], headOk: false }),
    });
    assert.equal(got, null);
  });
});

describe('生产接线（正控：漏一处就等于没修）', () => {
  const DAO = readFileSync(join(REPO, 'scripts', 'dao.mjs'), 'utf8');

  it('reviewer-create 真的算了这个判据并传进去', () => {
    assert.match(DAO, /const verdict = judgeVerdictOnHead\(args\.pr, existingRecord, targetRepo\)/);
    assert.match(DAO, /verdictOnHead: verdict/);
  });

  it('锁内复查用持锁后重读的 lockedVerdict，不是锁外那份（#1293 二审 P1：等锁期间 head 变了会误判 reused）', () => {
    // 锁内必须重新算：judgeVerdictOnHead 的第二次调用出现在 withWorktreeLock 之后，
    // 且 runLockedReviewerCreate 拿的是 lockedVerdict 而不是锁外的 verdict。
    const lockAt = DAO.indexOf('withWorktreeLock(async () => {');
    const recomputeAt = DAO.indexOf('const lockedVerdict = ');
    const callAt = DAO.indexOf('runLockedReviewerCreate({');
    assert.ok(lockAt > -1, 'withWorktreeLock 还在');
    assert.ok(recomputeAt > -1, 'lockedVerdict 还在');
    assert.ok(callAt > -1, 'runLockedReviewerCreate 还在');
    assert.ok(recomputeAt > lockAt, 'lockedVerdict 必须在锁内算（等锁期间 head 可能变了）');
    assert.ok(recomputeAt < callAt, '先重读再判 race');
    assert.match(DAO, /runLockedReviewerCreate\(\{\s*forceNew, record: againRecord, view: racePeek\.view, verdictOnHead: lockedVerdict,/);
    // forceNew 短路时不许白打两次 gh（judgeReviewerCreateRace 根本不看 verdictOnHead）
    assert.match(DAO, /const lockedVerdict = \(!forceNew && againRecord && againRecord\.sessionKey\)/);
  });

  it('终态 reuse 不许在锁外 emit 退出（否则 lockedVerdict 重读跑不到）', () => {
    const reuseAt = DAO.indexOf('if (decided.reuse.reuse');
    const lockAt = DAO.indexOf('withWorktreeLock(async () => {');
    assert.ok(reuseAt > -1, 'reuse 出口还在');
    assert.ok(lockAt > reuseAt, 'reuse 出口必须在进锁之前');
    const seg = DAO.slice(reuseAt, lockAt);
    assert.match(seg, /mustRecheckVerdictUnderLock/);
    const gateAt = seg.indexOf('mustRecheckVerdictUnderLock');
    const emitAt = seg.indexOf("outcome: 'reused'");
    assert.ok(gateAt > -1, 'mustRecheck 闸要写在 reuse 出口里');
    assert.ok(emitAt > gateAt, '锁外 reused 出口必须先过 mustRecheck 闸，不能无条件 process.exit');
  });

  it('对账目标从 GitHub 读当前 headRefOid，不读登记里的 expectedOid（#1293 审官 P1）', () => {
    const fn = DAO.match(/export function judgeVerdictOnHead[\s\S]*?\n\}/);
    assert.ok(fn, 'judgeVerdictOnHead 要能从 dao.mjs 里截出来');
    assert.match(fn[0], /'headRefOid,reviews'/);
    assert.doesNotMatch(fn[0], /record\.expectedOid/);
    assert.doesNotMatch(fn[0], /listPrReviews/);
  });

  it('读不到判定时给 null，不给 false——否则每轮都重复起会话', () => {
    const fn = DAO.match(/export function judgeVerdictOnHead[\s\S]*?\n\}/);
    assert.ok(fn, 'judgeVerdictOnHead 要能从 dao.mjs 里截出来');
    assert.match(fn[0], /if \(!snap \|\| !snap\.ok\) return null;/);
    assert.match(fn[0], /if \(!Array\.isArray\(reviews\)\) return null;/);
  });
});

describe('headRefOid 与 reviews 必须同一快照（#1293 三审 P1）', () => {
  // 审官判别性复现：注入的 runGh 在第一次 headRefOid 读取后把实际 HEAD 从 OLD 推到 HEAD，
  // 第二次 reviews 仍返回旧提交票。分两次读会得出 true（旧 OID 对上旧票），
  // 而 actualHead 已是 HEAD、HEAD 上没有审官。
  it('两次独立读取之间 HEAD 被推走 ⇒ 不许得出 true', () => {
    let liveHead = OLD;
    const calls = [];
    const runGh = (argv) => {
      const json = String(argv[argv.length - 1] || '');
      calls.push(json);
      const fields = json.split(',');
      const out = {};
      if (fields.includes('headRefOid')) out.headRefOid = liveHead;
      if (fields.includes('reviews')) out.reviews = [rv('APPROVED', OLD)];
      if (fields.includes('headRefOid') && !fields.includes('reviews')) liveHead = HEAD;
      if (Object.keys(out).length === 0) {
        return { ok: false, error: `unexpected argv: ${argv.join(' ')}` };
      }
      return { ok: true, out: JSON.stringify(out) };
    };

    const got = judgeVerdictOnHead('1293', record, null, { runGh });
    const raced = {
      verdict: got, calls, actualHead: liveHead, oldReviewOid: OLD,
    };
    if (liveHead === HEAD) {
      // 读完再核对 OID：竞态窗口已打开，旧票对不上新 HEAD，不许 true。
      assert.notEqual(got, true, JSON.stringify(raced));
    } else {
      // 一次快照：push 发生在函数返回之后，head 与 reviews 仍一致。
      assert.ok(
        calls.some((c) => c.includes('headRefOid') && c.includes('reviews')),
        `head 与 reviews 必须同一次读取：${JSON.stringify(calls)}`,
      );
      assert.equal(got, true, JSON.stringify(raced));
    }
  });

  it('一次快照里 head=新、reviews 仍是旧票 ⇒ false（确认当前 head 没有）', () => {
    const got = judgeVerdictOnHead('1293', record, null, {
      runGh: fakeGh({ headOid: HEAD, reviews: [rv('APPROVED', OLD)] }),
    });
    assert.equal(got, false);
  });
});
