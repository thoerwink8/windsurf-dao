// dao-check 第 ⑭ 项判别力（#556 / #966）
//
// 快档 live 不出网，所以这里用隔离夹具证明：
//   超阈的非「将来某版」开放单会被当场拦下
//   再加入「将来某版」开放单，它们不进入积压分母
// 不 import dao-check.mjs（会递归跑 tests/）。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'open-issue-count-check.mjs');
const FIX = path.join(__dirname, 'fixtures', 'open-issue-count');
const LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function board(doc) {
  return {
    issues: { array: doc.issues },
    prs: { array: doc.prs },
    worktrees: { worktrees: doc.worktrees },
    max: doc.max,
  };
}

function loadFix(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

describe('open-issue-count ⑭', () => {
  it('隔离夹具：超阈非推迟单当场红；加入将来某版不进分母', async () => {
    const Q = await LOAD;
    const over = loadFix('over-red.json');
    const plus = loadFix('over-red-plus-deferred.json');
    const ok = loadFix('deferred-ok.json');

    const rOver = Q.inspectOpenIssueCount(board(over));
    assert.equal(rOver.kind, 'red', rOver.line);
    assert.equal(rOver.n, 2);
    assert.deepStrictEqual(rOver.backlog, [101, 102]);
    assert.match(rOver.line, /open 未在做单 2 张，超阈值 1/);
    assert.match(rOver.line, /共 2 张 open/);

    const rPlus = Q.inspectOpenIssueCount(board(plus));
    assert.equal(rPlus.kind, 'red', rPlus.line);
    assert.equal(rPlus.n, 2, '加入将来某版后分母仍是 2，不是 4');
    assert.equal(rPlus.open, 4);
    assert.deepStrictEqual(rPlus.backlog, [101, 102]);
    assert.match(rPlus.line, /open 未在做单 2 张，超阈值 1（共 4 张 open/);

    const rOk = Q.inspectOpenIssueCount(board(ok));
    assert.equal(rOk.kind, 'ok', rOk.line);
    assert.equal(rOk.n, 1, '若推迟进分母会是 3>1 红');
    assert.equal(rOk.open, 3);
    assert.match(rOk.line, /open 未在做单 1\/1（共 3 张 open/);
  });

  it('夹具目录红/绿都有判别力，expectN 钉死推迟不进分母', async () => {
    const Q = await LOAD;
    const r = Q.inspectOpenIssueCountFixtures(FIX);
    assert.equal(r.ok, true, r.error || JSON.stringify(r.problems));
    assert.ok(r.kinds.red >= 1 && r.kinds.ok >= 1, JSON.stringify(r.kinds));
  });
});
