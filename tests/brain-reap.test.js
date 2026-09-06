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

describe('#1055 返工：session-read 坏帧不许当可读（没查成要留着）', () => {
  it('故意坏帧：31 分钟龄、phase:null、无正文 → readable 不给，超龄也不关', async () => {
    const { interpretBrainSessionView, classifyBrainReap } = await LOAD;
    const rd = interpretBrainSessionView({
      ok: true, executor: 'mirasim', sessionKey: 'pi:deadbeef',
      phase: null, text: '', toolCalls: [], error: null,
      missing: false, partial: false, via: 'snapshot',
      why: '快照体形状不符：要对象，实际 undefined',
      readable: true, // dao.mjs 在 missing!==true 时会标这个，适配器不许信
    });
    assert.equal(rd.readable, undefined, '形状错误帧不许 readable:true');
    assert.match(String(rd.error), /形状不符/);
    const v = classifyBrainReap({
      readable: rd.readable, age: 31 * MIN, maxAgeMs: CAP, hardCapMs: 90 * MIN,
      signature: null, prev: null,
    });
    assert.equal(v.verdict, 'unknown', '超龄坏帧必须 unknown，不能 close');
    assert.notEqual(v.verdict, 'close');
  });

  it('phase 缺失 / 未知 / 契约 why / 无法确认的 partial → readable 不给', async () => {
    const { interpretBrainSessionView } = await LOAD;
    const missPhase = interpretBrainSessionView({ missing: false, phase: null, text: '', why: null });
    assert.equal(missPhase.readable, undefined);
    const unknownPhase = interpretBrainSessionView({ missing: false, phase: 'incomplete', text: 'x' });
    assert.equal(unknownPhase.readable, undefined);
    const contract = interpretBrainSessionView({
      missing: false, phase: 'running', why: '快照体形状不符：要对象，实际 null',
    });
    assert.equal(contract.readable, undefined, 'why 标明契约错误时即使有 phase 也不信');
    const partialDone = interpretBrainSessionView({
      missing: false, phase: 'done', partial: true, text: '只是预览',
    });
    assert.equal(partialDone.readable, undefined, 'partial 终态无法确认');
    const partialNull = interpretBrainSessionView({ missing: false, phase: null, partial: true });
    assert.equal(partialNull.readable, undefined);
  });

  it('有效运行态 / 终态 / 明确 missing 才给 true/false', async () => {
    const { interpretBrainSessionView } = await LOAD;
    assert.equal(interpretBrainSessionView({ missing: false, phase: 'running' }).readable, true);
    assert.equal(interpretBrainSessionView({ missing: false, phase: 'streaming' }).readable, true);
    assert.equal(interpretBrainSessionView({ missing: false, phase: 'waiting' }).readable, true);
    assert.equal(interpretBrainSessionView({ missing: false, phase: 'queued' }).readable, true);
    assert.equal(interpretBrainSessionView({ missing: false, phase: 'running', partial: true }).readable, true,
      'partial 但 phase=running 是确认过的运行态');
    assert.equal(interpretBrainSessionView({ missing: false, phase: 'done' }).readable, false);
    assert.equal(interpretBrainSessionView({ missing: false, phase: 'error' }).readable, false);
    assert.equal(interpretBrainSessionView({ missing: true, phase: null, why: '会话清单里没有' }).readable, false);
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

  it('#1055：mirasim session-read 的 text 也取得出', async () => {
    const { brainScreenText } = await LOAD;
    assert.equal(brainScreenText({ text: 'hello from mirasim', phase: 'running' }), 'hello from mirasim');
    assert.equal(brainScreenText({ json: { text: 'via json', phase: 'running' } }), 'via json');
  });
});

describe('#1055 取数切 mirasim，判据一个字不动', () => {
  const fs = require('node:fs');
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'commander.mjs'), 'utf8');

  it('reapBrains 走 session-read / session-stop，不再调 orca terminal', () => {
    const i = SRC.indexOf('function readBrainSession');
    assert.ok(i > -1, '找不到 readBrainSession');
    const body = SRC.slice(i, SRC.indexOf('export function brainScreenText', i));
    assert.match(body, /session-read/);
    assert.match(body, /session-stop/);
    assert.match(body, /function reapBrains/);
    assert.match(body, /function stopBrainSession/);
    assert.ok(!body.includes('runOrca('), '回收路上还在调 orca');
    assert.ok(!/orca terminal/.test(body), '回收路上还在碰 orca terminal');
  });

  it('wakeBrain 一步到位：start --executor mirasim --prompt，没有 send 第二步', () => {
    const i = SRC.indexOf('function brainStartCmd');
    assert.ok(i > -1, '找不到 brainStartCmd');
    const body = SRC.slice(i, SRC.indexOf('export function classifyBrainReap', i));
    assert.match(body, /--executor['"]?,\s*['"]mirasim['"]/);
    assert.match(body, /--prompt/);
    assert.ok(!/dao\.mjs', 'send'/.test(body), 'mirasim 路径不许再 send --terminal');
    assert.ok(!body.includes('--provider'), '不许再走 orca 的 --provider 起 TUI');
  });

  it('cmdAct / cmdPatrol 仍是同步函数——改成 async 会牵动退出码三态', () => {
    assert.match(SRC, /^function cmdAct\(/m);
    assert.match(SRC, /^function cmdPatrol\(/m);
    assert.ok(!/^async function cmdAct\(/m.test(SRC), 'cmdAct 被改成 async 了');
    assert.ok(!/^async function cmdPatrol\(/m.test(SRC), 'cmdPatrol 被改成 async 了');
  });

  it('#1055：SITUATION_SECTIONS 不再钉 orca（fail-closed 总闸不许常开）', async () => {
    const CORE = await import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'commander-core.mjs').split(path.sep).join('/'));
    assert.ok(!CORE.SITUATION_SECTIONS.includes('orca'));
    assert.deepEqual(CORE.SITUATION_SECTIONS, ['github', 'reviewPending', 'prReviews', 'stall']);
  });

  it('classifyBrainReap 的判据签名与分支没被动过', () => {
    const i = SRC.indexOf('export function classifyBrainReap');
    const start = SRC.indexOf('{', i);
    const end = SRC.indexOf('\n}\n', start);
    const body = SRC.slice(i, end + 2);
    assert.match(body, /readable === false/);
    assert.match(body, /readable !== true/);
    assert.match(body, /verdict: 'keep'/);
    assert.match(body, /verdict: 'close'/);
    assert.match(body, /verdict: 'gone'/);
    assert.match(body, /verdict: 'unknown'/);
    assert.match(body, /到硬顶/);
    assert.match(body, /超龄但屏面还在变/);
    assert.match(body, /超龄且屏面一轮没动/);
    assert.ok(!body.includes('session-read'), '判据函数里不许出现取数实现');
    assert.ok(!body.includes('mirasim'), '判据函数与执行体无关');
    assert.ok(!body.includes('runCmd'), '判据函数不许自己取数');
  });
});
