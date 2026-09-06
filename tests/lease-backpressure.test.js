// tests/lease-backpressure.test.js —— 租约拦下的派工是「背压」，不是「失败」
//
// 起因：租约闸（#1085）上线后，被拦下的派工在指挥官眼里 ok:false，会走
// dispatch-failed 分支开一张待拍板单。而「这棵树有人在干活，下轮再来」
// 根本不需要人拍板——那正是 2026-09-06 花一整晚清掉的那类噪音单（#1063）。
//
// 判据：busy 与 failed 必须在出口上分得开。分不开就等于闸每拦一次就造一张单。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CMD = import('file://' + path.join(__dirname, '..', 'scripts', 'commander.mjs').replace(/\\/g, '/'));

describe('派工结果四态：成 / 背压 / 失败 / 没查成', () => {
  it('busy 的结果判成背压，不判成失败', async () => {
    const { classifyDispatchResult } = await CMD;
    const got = classifyDispatchResult({
      present: true,
      doc: { ok: false, busy: true, reason: 'lease-held', error: '租约被占，拒起会话：… pi pid 2977217' },
      waitedMs: 100,
    });
    assert.equal(got.ok, false);
    assert.equal(got.busy, true);
    assert.equal(got.unscanned, false);
  });

  it('普通失败仍是失败（busy 不许把真失败也吞掉）', async () => {
    const { classifyDispatchResult } = await CMD;
    const got = classifyDispatchResult({ present: true, doc: { ok: false, error: '模型不在选型' }, waitedMs: 100 });
    assert.equal(got.busy, undefined);
    assert.equal(got.unscanned, false);
  });

  it('没落盘仍是没查成（三者互不串味）', async () => {
    const { classifyDispatchResult } = await CMD;
    const got = classifyDispatchResult({ present: false, doc: null, waitedMs: 1000 });
    assert.equal(got.unscanned, true);
    assert.equal(got.busy, undefined);
  });
});

describe('背压不报帅、不开单，但也不发喜报', () => {
  const 派工 = { kind: 'dispatch', issue: 1055, why: '测试' };
  const 喜报 = { kind: 'notify-hub', issue: 1055, moment: 'dispatched' };

  it('被租约拦下 → 一条 escalate 都不发', async () => {
    const { runActions } = await CMD;
    const 干过的 = [];
    runActions([派工, 喜报], {
      exec: (a) => {
        干过的.push(a.kind);
        return a.kind === 'dispatch' ? { ok: false, busy: true, error: '租约被占' } : { ok: true };
      },
    });
    assert.equal(干过的.includes('escalate'), false, '背压不许开待拍板单');
  });

  it('被租约拦下 → 也不发「已自动派单」喜报（毕竟没派出去）', async () => {
    const { runActions } = await CMD;
    const 干过的 = [];
    runActions([派工, 喜报], {
      exec: (a) => {
        干过的.push(a.kind);
        return a.kind === 'dispatch' ? { ok: false, busy: true, error: '租约被占' } : { ok: true };
      },
    });
    assert.equal(干过的.includes('notify-hub'), false, '没派出去就不许报喜');
  });

  it('日志里说得出「排队下一轮」，人看得懂它不是坏事', async () => {
    const { runActions } = await CMD;
    const { log } = runActions([派工], {
      exec: () => ({ ok: false, busy: true, error: '租约被占：dao-1055 已经有 1 个会话进程在干活' }),
    });
    assert.match(log.join('\n'), /排队下一轮/);
  });

  // 反向钉死：真失败必须照旧报帅，别让背压这条路把真问题也吞了。
  it('真失败照旧 escalate dispatch-failed', async () => {
    const { runActions } = await CMD;
    const 发出的 = [];
    runActions([派工], {
      exec: (a) => { 发出的.push(a); return a.kind === 'dispatch' ? { ok: false, error: '模型不在选型' } : { ok: true }; },
    });
    const esc = 发出的.find((a) => a.kind === 'escalate');
    assert.equal(esc?.reason, 'dispatch-failed');
  });

  it('没查成照旧 escalate dispatch-unscanned', async () => {
    const { runActions } = await CMD;
    const 发出的 = [];
    runActions([派工], {
      exec: (a) => { 发出的.push(a); return a.kind === 'dispatch' ? { ok: false, unscanned: true, error: '没落盘' } : { ok: true }; },
    });
    assert.equal(发出的.find((a) => a.kind === 'escalate')?.reason, 'dispatch-unscanned');
  });
});

describe('busy 标记从起会话那头一路透得出来', () => {
  const RT = path.join(__dirname, '..', 'scripts', 'lib', 'mirasim-runtime.mjs');
  const DAO = path.join(__dirname, '..', 'scripts', 'dao.mjs');
  const fs = require('node:fs');

  it('runtime 拒起时带上 busy 与 reason', () => {
    const src = fs.readFileSync(RT, 'utf8');
    assert.match(src, /busy: true, reason: LEASE_BUSY_REASON/, 'runtime 不标 busy，下游就分不出背压和失败');
  });

  it('dao.mjs 把 busy 原样透进结果文件', () => {
    const src = fs.readFileSync(DAO, 'utf8');
    const 处数 = (src.match(/e\?\.detail\?\.busy === true \? \{ busy: true/g) || []).length;
    assert.equal(处数, 2, `两个 mirasim 起会话入口都要透 busy，现在 ${处数} 处`);
  });

  it('holders 字段名对得上 —— 单数 holder 是改名前的旧名，不许残留', () => {
    const src = fs.readFileSync(RT, 'utf8');
    assert.equal(/holder:/.test(src), false, 'lease 返回的是 holders（复数），写成 holder 会永远拿到 undefined');
  });
});
