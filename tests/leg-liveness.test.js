// tests/leg-liveness.test.js —— 「这条腿跑不动了」的判据，以及它能不能撬开换厂闸
//
// 起因（2026-09-15 实咬）：整条 gpt 腿断流，18/23 次审官会话 incomplete，
// 34 张开放 PR 零判定，合并吞吐 10/天 → 2/天。想换到活着的 grok 腿被闸拦住，
// 理由是死因原文不在 `CAPACITY_DEATH_RE` 那张 2026-09-07 抄下来的词表里。
// 详见 scripts/lib/leg-liveness.mjs 头部。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  judgeLegDown, MIN_SAMPLES, DEAD_RATIO, SAMPLE_WINDOW_MS,
} from '../scripts/lib/leg-liveness.mjs';
import { recordIsLeg, splitSessionKey } from '../scripts/lib/leg-liveness-io.mjs';
import {
  isCapacityDeath, isLegDownEvidence, judgeCapacityFailover, planReviewerOnCapacityDeath,
} from '../scripts/lib/dianjiangtai-reviewer-slot.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAO_MJS = readFileSync(join(REPO, 'scripts', 'dao.mjs'), 'utf8');

const NOW = Date.parse('2026-09-15T10:00:00Z');
const ago = (min) => NOW - min * 60 * 1000;
/** 造一批样本：dead 个没跑完 + ok 个跑完，都落在窗口内。 */
function samples({ dead = 0, ok = 0, minsAgo = 10 } = {}) {
  const out = [];
  for (let i = 0; i < dead; i++) out.push({ state: 'incomplete', at: ago(minsAgo + i) });
  for (let i = 0; i < ok; i++) out.push({ state: 'completed', at: ago(minsAgo + dead + i) });
  return out;
}

describe('腿况判据', () => {
  it('四次里坏三次就算跑不动', () => {
    const got = judgeLegDown(samples({ dead: 6, ok: 2 }), { now: NOW });
    assert.equal(got.down, true);
    assert.equal(got.samples, 8);
    assert.equal(got.dead, 6);
  });

  it('坏一半不算——换厂治的是「这一厂跑不动」，不是「这个模型审得不好」', () => {
    const got = judgeLegDown(samples({ dead: 4, ok: 4 }), { now: NOW });
    assert.equal(got.down, false);
  });

  it('样本不够一律不判腿断：一次网络抖动不许把整条腿判死', () => {
    const got = judgeLegDown(samples({ dead: MIN_SAMPLES - 1 }), { now: NOW });
    assert.equal(got.down, false);
    assert.match(got.why, /样本不够/);
  });

  it('最后一次侥幸跑完，也不能掩盖一条 82% 跑不完的腿（第一版就栽在这）', () => {
    const recs = samples({ dead: 18 });
    recs.unshift({ state: 'completed', at: ago(1) });   // 最近的一次是成功
    const got = judgeLegDown(recs, { now: NOW });
    assert.equal(got.down, true);
  });

  it('新的成功进了窗口，比率掉下阈值 ⇒ 闸自己合上（恢复不靠人手清状态）', () => {
    const got = judgeLegDown(samples({ dead: 6, ok: 6 }), { now: NOW });
    assert.equal(got.down, false);
    assert.equal(got.ratio, 0.5);
  });

  it('窗口外的死不算数——「三天前坏过」跟「现在跑不跑得动」无关', () => {
    const old = samples({ dead: 10 }).map((r) => ({ ...r, at: NOW - SAMPLE_WINDOW_MS - 1000 }));
    const got = judgeLegDown(old, { now: NOW });
    assert.equal(got.down, false);
    assert.equal(got.samples, 0);
  });

  it('还在跑的不当样本：它既没成功也没失败', () => {
    const got = judgeLegDown([
      { state: 'running', at: ago(1) }, { state: 'streaming', at: ago(2) },
      { state: 'accepted', at: ago(3) }, { state: 'queued', at: ago(4) },
    ], { now: NOW });
    assert.equal(got.samples, 0);
  });

  it('结局读不出来的不当样本，也不当死', () => {
    const got = judgeLegDown([{ state: null, at: ago(1) }, { at: ago(2) }], { now: NOW });
    assert.equal(got.samples, 0);
  });

  it('时间读不出来的不当样本——判不了新旧', () => {
    const got = judgeLegDown(samples({ dead: 9 }).map((r) => ({ state: r.state })), { now: NOW });
    assert.equal(got.samples, 0);
  });

  it('done 和 completed 都算跑完了', () => {
    const got = judgeLegDown([
      { state: 'done', at: ago(1) }, { state: 'completed', at: ago(2) },
      { state: 'done', at: ago(3) }, { state: 'done', at: ago(4) },
      { state: 'done', at: ago(5) }, { state: 'incomplete', at: ago(6) },
    ], { now: NOW });
    assert.equal(got.dead, 1);
    assert.equal(got.down, false);
  });

  it('failed / gone / unknown 都算没跑完', () => {
    const got = judgeLegDown([
      { state: 'failed', at: ago(1) }, { state: 'gone', at: ago(2) },
      { state: 'unknown', at: ago(3) }, { state: 'incomplete', at: ago(4) },
      { state: 'failed', at: ago(5) }, { state: 'completed', at: ago(6) },
    ], { now: NOW });
    assert.equal(got.dead, 5);
    assert.equal(got.down, true);
  });

  it('不是数组 ⇒ 没查成，且 down 恒为 false', () => {
    const got = judgeLegDown(null);
    assert.equal(got.scanned, false);
    assert.equal(got.down, false);
  });

  it('阈值是一句人能判对错的话（四次里坏三次），不是照着今天的数字刻的线', () => {
    assert.equal(DEAD_RATIO, 0.75);
  });
});

describe('样本取自哪里', () => {
  it('按模型 id 认领会话', () => {
    assert.equal(recordIsLeg({ model: 'gpt-5.6-luna' }, 'gpt-5.6-luna'), true);
    assert.equal(recordIsLeg({ requestedModel: 'gpt-5.6-luna' }, 'gpt-5.6-luna'), true);
    assert.equal(recordIsLeg({ model: 'grok-4.6' }, 'gpt-5.6-luna'), false);
  });

  it('退回 profileId 的 codex-relay-<模型> 形态', () => {
    assert.equal(recordIsLeg({ profileId: 'codex-relay-gpt-5.6-luna' }, 'gpt-5.6-luna'), true);
    assert.equal(recordIsLeg({ profileId: 'codex-relay-gpt-5.6-sol' }, 'gpt-5.6-luna'), false);
  });

  it('空模型不认领任何东西——否则第一条记录就会被当成样本', () => {
    assert.equal(recordIsLeg({ model: 'x' }, ''), false);
    assert.equal(recordIsLeg({ model: 'x' }, null), false);
  });

  it('会话键拆成 agent + id', () => {
    assert.deepEqual(splitSessionKey('codex:02923a47-bc9b'), { agent: 'codex', id: '02923a47-bc9b' });
  });

  it('形态不对的键回 null——不许把它拼进路径', () => {
    for (const bad of ['', 'codex', ':abc', 'codex:', 'codex:../../etc', 'a/b:c']) {
      assert.equal(splitSessionKey(bad), null, `${bad} 应该判不出来`);
    }
  });
});

describe('换厂闸认不认这条新凭证', () => {
  const base = {
    deadModelId: 'gpt-5.6-luna',
    workerId: 'claude-opus-5',
    models: [
      { id: 'gpt-5.6-luna', vendor: 'gpt' },
      { id: 'grok-4.6', vendor: 'grok' },
    ],
    passerIds: ['gpt-5.6-luna', 'grok-4.6'],
    order: ['gpt-5.6-luna', 'grok-4.6'],
  };
  const legDown = { down: true, scanned: true, why: '最近 22 次会话死了 18 次（82%）' };

  it('词表认得出的死因照旧成立（老路一个字没动）', () => {
    assert.equal(isCapacityDeath('Selected model is at capacity. Please try a different model.'), true);
    assert.equal(isCapacityDeath('pi turn stalled past 30 minutes'), true);
  });

  it('今天这种死法词表认不出——这就是盘面卡住的那一刻', () => {
    assert.equal(isCapacityDeath('stream disconnected before completion: stream closed before response.completed'), false);
  });

  it('词表认不出，但腿况证据成立 ⇒ 放行换厂', () => {
    const got = judgeCapacityFailover({
      requested: 'grok-4.6',
      capacityFailover: { ...base, deadError: 'stream disconnected before completion', legEvidence: legDown },
    });
    assert.equal(got.ok, true);
    assert.match(got.why, /跑不完/);
  });

  it('没腿况证据、死因也认不出 ⇒ 照旧拒，而且说得出是缺了哪一半', () => {
    const got = judgeCapacityFailover({
      requested: 'grok-4.6',
      capacityFailover: { ...base, deadError: 'stream disconnected before completion' },
    });
    assert.equal(got.ok, false);
    assert.match(got.error, /没给这条腿的近况证据/);
  });

  it('腿况没查成 ⇒ 不许当腿断。把日志弄坏不能变成换厂后门', () => {
    assert.equal(isLegDownEvidence({ down: true, scanned: false }), false);
    const got = judgeCapacityFailover({
      requested: 'grok-4.6',
      capacityFailover: { ...base, deadError: 'stream disconnected', legEvidence: { down: true, scanned: false, why: '读不到' } },
    });
    assert.equal(got.ok, false);
  });

  it('腿况说没断 ⇒ 不许换厂', () => {
    assert.equal(isLegDownEvidence({ down: false, scanned: true }), false);
  });

  it('凭证成立也不许跳级点名——顺位约束一点没松', () => {
    const got = judgeCapacityFailover({
      requested: 'gpt-5.6-luna',
      capacityFailover: { ...base, deadError: 'stream disconnected', legEvidence: legDown },
    });
    assert.equal(got.ok, false);
    assert.match(got.error, /不许跳级点名|按顺位该换/);
  });

  it('选人这条腿跟闸口同一把尺：腿况成立时真的会换人', () => {
    const got = planReviewerOnCapacityDeath({
      requested: 'gpt-5.6-luna',
      capacityFailover: { ...base, deadError: 'stream disconnected', legEvidence: legDown },
    });
    assert.equal(got.ok, true);
    assert.equal(got.reviewerId, 'grok-4.6');
  });

  it('两处判据不许只改一处——只放行不换人会卡成半通不通', () => {
    const ctx = { ...base, deadError: 'stream disconnected', legEvidence: legDown };
    assert.equal(judgeCapacityFailover({ requested: 'grok-4.6', capacityFailover: ctx }).ok, true);
    assert.equal(planReviewerOnCapacityDeath({ requested: 'grok-4.6', capacityFailover: ctx }).reviewerId, 'grok-4.6');
  });
});

describe('dao.mjs 里的接线（正控：没接上这几条要红）', () => {
  it('两处换厂凭证都带上了腿况', () => {
    const hits = DAO_MJS.match(/legEvidence: legEvidenceFor\(failover\.deadModelId\)/g) || [];
    assert.equal(hits.length, 2);
  });

  it('腿况取不到时如实报没查成，不是当成「腿没断」也不是当成「腿断了」', () => {
    assert.match(DAO_MJS, /if \(!got\.scanned\) return \{ down: false, scanned: false, why: got\.error \}/);
  });
});
