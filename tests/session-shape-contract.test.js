// tests/session-shape-contract.test.js —— 外部会话形状的字段契约
//
// 起因（2026-09-11，一晚九处同形状的错）：同一件事在两个地方各写一份，然后漂移。
// 其中三处是**字段名**：代码读了一个真实数据里不存在的字段名，于是判据恒假、静默失效。
// 最贵的两次：#1150 卡 5 小时、审官池被焊死 7 张 PR 零判定。
//
// 这道闸钉的是**类**，不是那几个具体字段名：
//   1. 外部形状（会话名单/登记记录）的键集，必须与代码声称要读的键集对得上；
//   2. 状态词表只有一份正典，别的模块不许再手打；
//   3. 每个消费者读状态时必须走正典函数（用真形状喂，不许喂 runState 幻觉）。
//
// **判据不复用被检查对象自己的解析逻辑**（仓规）：期望键集是本文件里独立写死的，
// 不从 mirasim-runtime 导。这样 runtime 改了形状而没改契约，这里才会红。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.resolve(__dirname, '..');
const toUrl = (p) => 'file://' + p.replace(/\\/g, '/');
const STATES = import(toUrl(path.join(REPO, 'scripts', 'lib', 'execution-states.mjs')));
const CORE = import(toUrl(path.join(REPO, 'scripts', 'lib', 'commander-core.mjs')));
const REVIEW_PENDING = import(toUrl(path.join(REPO, 'scripts', 'lib', 'dispatch', 'review-pending.mjs')));
const RUNTIME = import(toUrl(path.join(REPO, 'scripts', 'lib', 'mirasim-runtime.mjs')));

// ── 外部形状的键集（**独立写死**，不从被测模块导）─────────────────────
// 取自 2026-09-11 实测：runuser -u orca -- node -e '<listSessions 并打印 Object.keys>'
// 真实会话名单（服务端 listSessions 帧里的一条）：
const REAL_SESSION_LIST_KEYS = [
  'sessionKey', 'backend', 'agent', 'model', 'profileId', 'provider', 'accountPoolId',
  'route', 'taskId', 'issue', 'pr', 'workdir', 'startedAt', 'state', 'updatedAt',
  'cleanupVerified', 'observedState', 'observedAt', 'taskCompleted', 'key', 'phase',
  'cwd', 'title', 'scope',
];
// 真实登记记录（~/.dao/execution/sessions/<key>.json）：
const REAL_REGISTRY_KEYS = [
  'sessionKey', 'backend', 'agent', 'model', 'profileId', 'provider', 'accountPoolId',
  'route', 'taskId', 'issue', 'pr', 'workdir', 'startedAt', 'state', 'updatedAt',
  'cleanupVerified', 'observedState', 'observedAt', 'taskCompleted', 'recordKey',
  'launchId', 'attemptId', 'launchState', 'createdAt', 'owner', 'acceptedAt',
  'cleanupToken', 'cleanupOwner', 'recovered', 'schemaVersion', 'clientRef',
  'completionScope', 'actualModel', 'requestedModel', 'actualVendor', 'vendorTaskId',
];

describe('外部会话形状的字段契约（防「读一个不存在的字段名」）', () => {
  it('真实名单里有 state/phase/observedState，**没有 runState**（本晚两处 bug 的根）', async () => {
    assert.ok(REAL_SESSION_LIST_KEYS.includes('state'), 'state 是权威定性');
    assert.ok(REAL_SESSION_LIST_KEYS.includes('phase'), 'phase 是快照侧的说法');
    assert.ok(REAL_SESSION_LIST_KEYS.includes('observedState'), 'observedState 是上次观测值');
    assert.equal(REAL_SESSION_LIST_KEYS.includes('runState'), false,
      'runState 在真实名单里不存在——谁读它谁恒假（countLiveReviewers / metaView 都栽在这）');
    assert.equal(REAL_REGISTRY_KEYS.includes('runState'), false, '登记记录里也没有 runState');
  });

  it('sessionStateOf 认得真实的三套词，且不认幻觉', async () => {
    const { sessionStateOf } = await STATES;
    for (const k of ['state', 'phase', 'observedState']) {
      assert.equal(sessionStateOf({ [k]: 'stopped' }), 'stopped', `${k} 必须认得`);
    }
    assert.equal(sessionStateOf({ runState: 'stopped' }), 'stopped', '历史遗留的 runState 仍兜底（不砸旧数据）');
    assert.equal(sessionStateOf({}), null, '读不到就是 null，不许编默认值');
    assert.equal(sessionStateOf({ state: '' }), null, '空串不算状态');
  });

  it('state 优先于 phase/observedState（?? 不是 ||：空串也要让位）', async () => {
    const { sessionStateOf } = await STATES;
    assert.equal(sessionStateOf({ state: 'running', phase: 'stopped' }), 'running');
    assert.equal(sessionStateOf({ state: '', phase: 'stopped' }), 'stopped', 'state 是空串 → 回落');
    assert.equal(sessionStateOf({ observedState: 'done', phase: 'running' }), 'running', 'phase 在 observedState 之前');
  });

  it('classifySessionState 三分类，且「没查成」与「在跑」分得开', async () => {
    const { classifySessionState } = await STATES;
    assert.equal(classifySessionState({ state: 'stopped' }), 'finished');
    assert.equal(classifySessionState({ state: 'incomplete' }), 'finished');
    assert.equal(classifySessionState({ state: 'rejected' }), 'finished');
    assert.equal(classifySessionState({ state: 'stopping' }), 'reserved');
    assert.equal(classifySessionState({ state: 'running' }), 'live');
    assert.equal(classifySessionState({ state: 'streaming' }), 'live');
    assert.equal(classifySessionState({}), null, '读不出来必须与 live 分开——不许当成在跑');
  });

  it('每个真实状态都能被归类（正典不得有洞）', async () => {
    const { classifySessionState, EXECUTION_FINISHED, EXECUTION_RESERVED } = await STATES;
    // 2026-09-11 实测出现过的全部状态值
    const SEEN = ['stopped', 'failed', 'incomplete', 'completed', 'gone', 'done', 'rejected',
      'running', 'streaming', 'pending', 'stopping', 'uncertain'];
    for (const st of SEEN) {
      const c = classifySessionState({ state: st });
      assert.ok(['finished', 'reserved', 'live'].includes(c), `${st} 归不了类`);
    }
    // 三分类必须覆盖（互斥且穷尽）：终态 ∪ 预留 = 非 live
    const F = [...EXECUTION_FINISHED];
    const R = [...EXECUTION_RESERVED];
    for (const st of F) assert.equal(classifySessionState({ state: st }), 'finished', `${st} 该判 finished`);
    for (const st of R) assert.equal(classifySessionState({ state: st }), 'reserved', `${st} 该判 reserved`);
  });
});

describe('状态词表只有一份正典（防手打副本漂移）', () => {
  // 本晚的病根：同一张状态表在仓里手打了 11 份，互相不一致。
  // 这条闸扫源码找「看起来像状态表的手打 Set」，要求它们要么是正典，要么显式登记豁免。
  const LIB = path.join(REPO, 'scripts', 'lib');
  const SCAN = [
    path.join(LIB, 'execution-runtime.mjs'),
    path.join(LIB, 'dispatch', 'review-pending.mjs'),
    path.join(LIB, 'dispatch', 'reviewer-mirasim.mjs'),
    path.join(LIB, 'acp-runtime.mjs'),
    path.join(LIB, 'lease-gc.mjs'),
    path.join(LIB, 'board-gc.mjs'),
  ];

  // 允许存在的独立词表：它们判的不是「执行会话终态」，是别的域（写清楚理由才许留）。
  const ALLOWED = [
    { file: 'acp-runtime.mjs', why: 'ACP 自己的协议终态，与执行会话状态是两个域（含 auth_required/unsupported_interaction）' },
    { file: 'close-issue.mjs', why: 'CI check 的 conclusion，不是会话状态' },
    { file: 'deliver.mjs', why: '交付单状态，不是执行会话状态' },
  ];

  it('execution-runtime 的 TERMINAL 已并入正典（rejected/gone/incomplete 不许漏）', async () => {
    const src = fs.readFileSync(path.join(LIB, 'execution-runtime.mjs'), 'utf8');
    // 修前那行：const TERMINAL = new Set([...]) —— 漏了 rejected/incomplete/gone，
    // 于是 judgeExecutionCompletion 把已死的会话判成 running。
    assert.equal(/const TERMINAL\s*=\s*new Set\(/.test(src), false,
      'TERMINAL 不许再手打——读 EXECUTION_FINISHED（正典）');
    assert.match(src, /EXECUTION_FINISHED/, 'execution-runtime 必须从正典读终态');
  });

  it('review-pending 的终态读正典，不手打', async () => {
    const src = fs.readFileSync(path.join(LIB, 'dispatch', 'review-pending.mjs'), 'utf8');
    assert.match(src, /EXECUTION_FINISHED/, '必须从正典读');
    assert.equal(/REVIEWER_DONE_PHASES\s*=\s*new Set\(\[/.test(src), false,
      'REVIEWER_DONE_PHASES 曾手打 8 个词、漏了 stopped/incomplete，不许回退');
  });

  it('每个模块要么读正典，要么在豁免名单里写明理由', async () => {
    for (const f of SCAN) {
      if (!fs.existsSync(f)) continue;
      const base = path.basename(f);
      const src = fs.readFileSync(f, 'utf8');
      const handTyped = /new Set\(\[\s*'(?:done|completed|failed|error|cancel|stopped|aborted)/.test(src);
      if (!handTyped) continue;
      const exempt = ALLOWED.some((a) => a.file === base);
      assert.ok(exempt, `${base} 手打了状态表，且不在豁免名单里——要么读正典 execution-states.mjs，要么登记理由`);
    }
  });

  it('消费者读状态走正典函数，不自己点字段名', async () => {
    const RP = fs.readFileSync(path.join(LIB, 'dispatch', 'review-pending.mjs'), 'utf8');
    assert.equal(/s\.runState\s*\?\?|s\.runState\s*\|\|/.test(RP), false,
      'review-pending 不许再自己点 runState——走 sessionStateOf/classifySessionState');
    const CORE_SRC = fs.readFileSync(path.join(LIB, 'commander-core.mjs'), 'utf8');
    assert.equal(/s\.runState\s*\?\?|s\.runState\s*\|\|/.test(CORE_SRC), false,
      'commander-core 同样走正典');
  });
});
