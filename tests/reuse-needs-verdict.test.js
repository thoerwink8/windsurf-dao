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
import { judgeReviewerSessionReuse, decideReviewerCreateStart } from '../scripts/lib/dispatch/reviewer-mirasim.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const record = { sessionKey: 'codex:02923a47-bc9b-492f-a537-20b23b8691ba', expectedOid: HEAD };
const rv = (state, oid) => ({ state, commit: { oid } });

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
});

describe('生产接线（正控：漏一处就等于没修）', () => {
  const DAO = readFileSync(join(REPO, 'scripts', 'dao.mjs'), 'utf8');

  it('reviewer-create 真的算了这个判据并传进去', () => {
    assert.match(DAO, /const verdict = judgeVerdictOnHead\(args\.pr, existingRecord, targetRepo\)/);
    assert.match(DAO, /verdictOnHead: verdict/);
  });

  it('读不到判定时给 null，不给 false——否则每轮都重复起会话', () => {
    assert.match(DAO, /if \(!listed\.ok\) return null;/);
  });
});
