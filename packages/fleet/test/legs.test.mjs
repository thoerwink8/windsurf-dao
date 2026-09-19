// T39 阶梯③：换腿候选。纯函数喂样本。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { alternateProfiles } from '../src/legs.mjs';

const cand = (id, family, rank, over = {}) => ({ id, family, rank, eliminated: rank === null, ...over });

describe('T39：换腿候选（同 family 优先）', () => {
  it('同 family 的可用腿排在前面；主腿自己排除', () => {
    const out = alternateProfiles({
      primary: 'a',
      candidates: [cand('a', 'openai', 1), cand('b', 'openai', 2), cand('c', 'xai', 3)],
    });
    assert.deepEqual(out, ['b', 'c']);
  });

  it('淘汰的（rank=null）不进候选', () => {
    const out = alternateProfiles({
      primary: 'a',
      candidates: [cand('a', 'openai', 1), cand('dead', 'openai', null), cand('c', 'openai', 2)],
    });
    assert.deepEqual(out, ['c']);
  });

  it('没有同 family 的 → 退而用其余可用腿（不空手）', () => {
    const out = alternateProfiles({
      primary: 'a',
      candidates: [cand('a', 'openai', 1), cand('c', 'xai', 2)],
    });
    assert.deepEqual(out, ['c']);
  });

  it('主腿 family 未知 → 全部可用腿按 rank 排', () => {
    const out = alternateProfiles({ primary: 'zzz', candidates: [cand('a', 'openai', 2), cand('b', 'xai', 1)] });
    assert.deepEqual(out, ['b', 'a']);
  });

  it('limit 截断；空/脏输入不抛', () => {
    const out = alternateProfiles({ primary: 'a', candidates: [cand('b', 'f', 1), cand('c', 'f', 2)], limit: 1 });
    assert.deepEqual(out, ['b']);
    assert.deepEqual(alternateProfiles({}), []);
    assert.deepEqual(alternateProfiles({ primary: 'a', candidates: null }), []);
    assert.deepEqual(alternateProfiles({ primary: 'a', candidates: [null, {}] }), []);
  });
});
