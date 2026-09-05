// 大脑回收判据（2026-09-05 实咬）。
// 巡检 17:03 唤起大脑，17:51 被「超龄回收」关掉——全程零记录。它是干完了活还是从头坐到尾，
// 事后谁也说不出来：close --tab 之后 scrollback 就没了，而 reapBrains 本来就在读屏面，
// 只是把内容扔了、只留下一个 rd.ok。于是「杀掉一个正在干活的大脑」和「清掉一个卡死的」
// 在日志里长得一模一样，两条链都天天绿。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LIB = 'file://' + path.join(__dirname, '..', 'scripts', 'commander.mjs').split(path.sep).join('/');
const LOAD = import(LIB);

const MIN = 60 * 1000;
const CAP = 30 * MIN;

describe('大脑该留该关', () => {
  it('故意违规样本：超龄但屏面还在变——不许关，那是正在干活的', async () => {
    const { classifyBrainReap } = await LOAD;
    const v = classifyBrainReap({
      readable: true, age: 35 * MIN, maxAgeMs: CAP, hardCapMs: 90 * MIN,
      signature: '120:abc', prev: '80:xyz',
    });
    assert.equal(v.verdict, 'keep', '屏面变了说明它在推进，超龄不是杀它的理由');
    assert.equal(v.moved, true);
  });

  it('超龄且一轮没动 → 关', async () => {
    const { classifyBrainReap } = await LOAD;
    const v = classifyBrainReap({
      readable: true, age: 35 * MIN, maxAgeMs: CAP, hardCapMs: 90 * MIN,
      signature: '80:xyz', prev: '80:xyz',
    });
    assert.equal(v.verdict, 'close');
    assert.equal(v.moved, false);
  });

  it('硬顶到了照关——「一直在动」不能变成永不回收', async () => {
    const { classifyBrainReap } = await LOAD;
    const v = classifyBrainReap({
      readable: true, age: 100 * MIN, maxAgeMs: CAP, hardCapMs: 90 * MIN,
      signature: '999:zzz', prev: '80:xyz',
    });
    assert.equal(v.verdict, 'close');
    assert.match(v.reason, /硬顶/);
  });

  it('反证：没到上限一律留着——判据不是恒关', async () => {
    const { classifyBrainReap } = await LOAD;
    const v = classifyBrainReap({ readable: true, age: 5 * MIN, maxAgeMs: CAP, signature: 's', prev: 's' });
    assert.equal(v.verdict, 'keep');
  });

  it('读不到终端 = 已退，不是「该关」', async () => {
    const { classifyBrainReap } = await LOAD;
    assert.equal(classifyBrainReap({ readable: false, age: 1, maxAgeMs: CAP }).verdict, 'gone');
  });

  it('「没查成」不许压成 gone 或 close', async () => {
    const { classifyBrainReap } = await LOAD;
    assert.equal(classifyBrainReap({ age: 1, maxAgeMs: CAP }).verdict, 'unknown', 'readable 没给 = 没查成');
    assert.equal(classifyBrainReap({ readable: true, age: 'x', maxAgeMs: CAP }).verdict, 'unknown');
    assert.equal(classifyBrainReap({ readable: true, age: 1, maxAgeMs: null }).verdict, 'unknown');
  });
});

describe('屏面取数：字段路径别猜，取不到要回 null', () => {
  it('三种真实形状都取得出', async () => {
    const { brainScreenText } = await LOAD;
    assert.equal(brainScreenText({ json: { result: { terminal: { tail: ['a', 'b'] } } } }), 'a\nb');
    assert.equal(brainScreenText({ json: { terminal: { screen: 'hello' } } }), 'hello');
    assert.equal(brainScreenText(JSON.stringify({ result: { terminal: { content: 'c' } } })), 'c');
  });

  it('取不到回 null——绝不回空串，空串会被当成「屏面是空的」', async () => {
    const { brainScreenText } = await LOAD;
    assert.equal(brainScreenText(null), null);
    assert.equal(brainScreenText('not json'), null);
    assert.equal(brainScreenText({ json: { result: { terminal: {} } } }), null, '有 terminal 但没有任何屏面字段 = 没查成');
  });
});
