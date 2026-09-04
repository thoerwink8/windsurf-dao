// 双门制+超时代拍（2026-09-04 拍板）判别性用例
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { doorOf, classifyDaipai, TWO_WAY_DEADLINE_MS } from '../scripts/lib/daipai.mjs';

const H = 3600 * 1000;

describe('双门制+超时代拍', () => {
  it('门类表：登记过的算双向门；没登记的一律单向门（fail-closed，宁可等人）', () => {
    assert.equal(doorOf('missing-labels'), 'two-way');
    assert.equal(doorOf('malformed-judgment'), 'two-way');
    assert.equal(doorOf('approved-but-ci-red'), 'two-way');
    assert.equal(doorOf('two-red'), 'one-way');
    assert.equal(doorOf('wake-exhausted'), 'one-way');
    assert.equal(doorOf('没见过的新reason'), 'one-way');
    assert.equal(doorOf(undefined), 'one-way');
  });

  const base = {
    body: '……\n- 门类：双向门（可翻案）——4 小时无人回复按推荐项代拍\n- 推荐项：补 label',
    createdAt: new Date(Date.now() - 5 * H).toISOString(),
    comments: [],
  };

  it('双向门 + 到期 + 零回复 → 代拍', () => {
    assert.equal(classifyDaipai(base).daipai, true);
  });
  it('未到期 → 不代拍', () => {
    assert.equal(classifyDaipai({ ...base, createdAt: new Date(Date.now() - 1 * H).toISOString() }).daipai, false);
  });
  it('单向门正文 → 不代拍', () => {
    assert.equal(classifyDaipai({ ...base, body: '- 门类：单向门（花钱/换人/不可逆）' }).daipai, false);
  });
  it('有任何回复 → 不代拍（人或大脑已介入）', () => {
    assert.equal(classifyDaipai({ ...base, comments: [{ author: { login: 'x' } }] }).daipai, false);
  });
  it('createdAt / comments 没查成 → 不代拍且标 unscanned（没查成不是过期，也不是零回复）', () => {
    const a = classifyDaipai({ ...base, createdAt: 'garbage' });
    assert.equal(a.daipai, false); assert.equal(a.unscanned, true);
    const b = classifyDaipai({ ...base, comments: null });
    assert.equal(b.daipai, false); assert.equal(b.unscanned, true);
  });
  it('期限是 4 小时（拍板值，防手滑）', () => {
    assert.equal(TWO_WAY_DEADLINE_MS, 4 * H);
  });
});
