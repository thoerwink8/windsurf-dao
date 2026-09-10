// 执行租约回收的判据（#1175 实咬：审官被上游断流打死，留下 running 租约永久占树）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeLease, planLeaseGc, judgeRegistryStuck, DEFAULT_LEASE_GRACE_MIN } from '../scripts/lib/lease-gc.mjs';

const lease = (over = {}) => ({ state: 'running', sessionKey: 'codex:11111111-2222-3333-4444-555555555555', workdir: '/x/dao-review-pr-1', ageMin: 120, ...over });
const S = { sessionsScanned: true };

test('活进程 → 永远保留（哪怕记录过期）', () => {
  const j = judgeLease(lease({ hasLiveProcess: true }), { ...S, sessionState: null });
  assert.equal(j.verdict, 'keep');
  assert.match(j.why, /活进程/);
});

test('会话名单里查不到 → 回收（台账有、盘上没了）', () => {
  const j = judgeLease(lease(), { ...S, sessionState: null });
  assert.equal(j.verdict, 'reap');
  assert.match(j.why, /查不到/);
});

test('会话已是终态 → 回收（incomplete 也算终态，那是本次那批死会话的形态）', () => {
  for (const st of ['incomplete', 'failed', 'done', 'gone', 'aborted']) {
    assert.equal(judgeLease(lease(), { ...S, sessionState: st }).verdict, 'reap', `${st} 应当回收`);
  }
});

test('会话还在跑 → 保留（不赌）', () => {
  assert.equal(judgeLease(lease(), { ...S, sessionState: 'running' }).verdict, 'keep');
  assert.equal(judgeLease(lease(), { ...S, sessionState: 'starting' }).verdict, 'keep');
});

test('宽限期内一律不动——刚起的会话有权存在', () => {
  const j = judgeLease(lease({ ageMin: 5 }), { ...S, sessionState: 'incomplete' });
  assert.equal(j.verdict, 'keep');
  assert.match(j.why, /宽限/);
});

test('会话名单没查成 → 保留并标 unknown（fail-closed）', () => {
  const j = judgeLease(lease(), { sessionsScanned: false, sessionState: null });
  assert.equal(j.verdict, 'keep');
  assert.equal(j.unknown, true);
});

test('租约年龄没查成 → 保留并标 unknown，绝不猜', () => {
  const j = judgeLease(lease({ ageMin: NaN }), { ...S, sessionState: 'incomplete' });
  assert.equal(j.verdict, 'keep');
  assert.equal(j.unknown, true);
});

test('planLeaseGc：三类分开计数，可回收与没查成不许混', () => {
  const leases = [
    lease({ sessionKey: 'a', ageMin: 100 }),
    lease({ sessionKey: 'b', ageMin: 100 }),
    lease({ sessionKey: 'c', ageMin: 2 }),
    lease({ sessionKey: 'd', ageMin: 100, hasLiveProcess: true }),
  ];
  const sessions = new Map([['a', 'incomplete'], ['b', 'running'], ['d', 'incomplete']]);
  const p = planLeaseGc({ leases, sessions, sessionsScanned: true });
  assert.deepEqual(p.reap.map((x) => x.sessionKey), ['a']);
  assert.deepEqual(p.keep.map((x) => x.sessionKey).sort(), ['b', 'c', 'd']);
  assert.equal(p.state, 'ok');
});

test('planLeaseGc：清单不是数组 → unknown，不是「一条都不用收」', () => {
  assert.equal(planLeaseGc({ leases: null }).state, 'unknown');
});

test('宽限期是常量不是魔法数字', () => {
  assert.ok(DEFAULT_LEASE_GRACE_MIN >= 10 && DEFAULT_LEASE_GRACE_MIN <= 120);
});

// 登记层（同一案子里的第二层残留：租约清了，登记表还停在 stopping，照样起不了新会话）。
const rec = (over = {}) => ({ state: 'stopping', sessionKey: 'codex:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', workdir: '/x/dao-review-pr-1', updatedAt: Date.now() - 120 * 60000, ...over });

test('登记表停在 stopping 且会话已终态 → 回收', () => {
  const j = judgeRegistryStuck(rec(), { sessionsScanned: true, sessionState: 'incomplete' });
  assert.equal(j.verdict, 'reap');
  assert.match(j.why, /stopping/);
});

test('登记表停在 stopping 且名单里没这条会话 → 回收', () => {
  assert.equal(judgeRegistryStuck(rec(), { sessionsScanned: true, sessionState: null }).verdict, 'reap');
});

test('登记表停在中间态但会话还在跑 → 保留（那是真在跑的一次启动）', () => {
  assert.equal(judgeRegistryStuck(rec(), { sessionsScanned: true, sessionState: 'running' }).verdict, 'keep');
});

test('非中间态一律不碰（正常记录轮不到这一层管）', () => {
  for (const st of ['running', 'done', 'stopped']) {
    assert.equal(judgeRegistryStuck(rec({ state: st }), { sessionsScanned: true, sessionState: 'incomplete' }).verdict, 'keep');
  }
});

test('中间态 + 名单没查成 → 保留并标 unknown（fail-closed）', () => {
  const j = judgeRegistryStuck(rec(), { sessionsScanned: false });
  assert.equal(j.verdict, 'keep');
  assert.equal(j.unknown, true);
});

test('中间态 + 宽限期内 → 保留', () => {
  assert.equal(judgeRegistryStuck(rec({ updatedAt: Date.now() }), { sessionsScanned: true, sessionState: 'incomplete' }).verdict, 'keep');
});
