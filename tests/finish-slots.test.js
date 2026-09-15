// tests/finish-slots.test.js —— 一轮能同时起几个收尾动作
//
// 起因（2026-09-15 实测）：盘面 21 张 PR 等复审，审官在役 0 / 上限 8，
// 而指挥官一轮只派 3 张——扫一遍 7 轮 × 20 分钟 ≈ 2.3 小时，队列一直排着。
// 那个 3 是手打的，理由是「一轮开太多不好定位」，不是资源理由。
// 实测 5 个审官并发（6 核机）：每个 ≈ 3.7% CPU / 174M RSS，按上限 8 满跑 ~30% CPU / 1.4G。
// 判据改成「已有的两个数取较小值」，不新造数字。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { finishSlotsMax, FINISH_SLOTS_FLOOR, FINISH_SLOTS_MAX } from '../scripts/lib/commander-core.mjs';
import { DEFAULT_REVIEWER_CAP } from '../scripts/lib/dispatch/review-pending.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('收尾名额上限', () => {
  it('核数少于审官上限 ⇒ 取核数（本机 6 核 / 上限 8 ⇒ 6）', () => {
    assert.equal(finishSlotsMax({ reviewerCap: 8, cores: 6 }), 6);
  });

  it('审官上限低于核数 ⇒ 取审官上限——不许比上游真限额还宽', () => {
    assert.equal(finishSlotsMax({ reviewerCap: 4, cores: 16 }), 4);
  });

  it('小机器也留得下下界 3：这笔名额存在的理由就是「把手上的活推过终点线」', () => {
    assert.equal(finishSlotsMax({ reviewerCap: 8, cores: 1 }), FINISH_SLOTS_FLOOR);
    assert.equal(finishSlotsMax({ reviewerCap: 1, cores: 1 }), FINISH_SLOTS_FLOOR);
  });

  it('核数读不出来 ⇒ 退回审官上限，不退回 0（读不到不该把收尾闸死）', () => {
    assert.equal(finishSlotsMax({ reviewerCap: 8 }), 8);
    assert.equal(finishSlotsMax({ reviewerCap: 8, cores: null }), 8);
    assert.equal(finishSlotsMax({ reviewerCap: 8, cores: 0 }), 8);
  });

  it('审官上限读不出来 ⇒ 退回它自己的默认值', () => {
    assert.equal(finishSlotsMax({ cores: 64 }), DEFAULT_REVIEWER_CAP);
    assert.equal(finishSlotsMax({ reviewerCap: null, cores: 64 }), DEFAULT_REVIEWER_CAP);
  });

  it('不带参数也算得出来（别让默认路径炸）', () => {
    assert.ok(finishSlotsMax() >= FINISH_SLOTS_FLOOR);
  });

  it('永远不超过审官上限——两笔账不许互相打架', () => {
    for (const cores of [1, 2, 4, 6, 8, 16, 64]) {
      const got = finishSlotsMax({ reviewerCap: DEFAULT_REVIEWER_CAP, cores });
      assert.ok(got <= Math.max(DEFAULT_REVIEWER_CAP, FINISH_SLOTS_FLOOR),
        `cores=${cores} 算出 ${got}，超过了审官上限 ${DEFAULT_REVIEWER_CAP}`);
    }
  });

  it('本机算出来的值不低于旧的手打值 3——这次是放开，不是收紧', () => {
    assert.ok(FINISH_SLOTS_MAX >= 3, `本机算出 ${FINISH_SLOTS_MAX}`);
  });

  it('不再是写死的 3：源码里不许再出现 `FINISH_SLOTS_MAX = 3`', () => {
    const src = readFileSync(join(REPO, 'scripts', 'lib', 'commander-core.mjs'), 'utf8');
    assert.doesNotMatch(src, /FINISH_SLOTS_MAX\s*=\s*3\b/);
    assert.match(src, /FINISH_SLOTS_MAX = finishSlotsMax\(/);
  });
});
