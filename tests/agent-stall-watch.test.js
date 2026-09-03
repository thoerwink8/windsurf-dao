// tests/agent-stall-watch.test.js —— #833 撞限流探测判别力
//
// ① 今天这段 429 真屏面：改之前（旧指纹表）不报、改之后报；正常工作屏面不报。
// ② 连红 2 轮才报（一轮可能正在自己重连）。
// ③ 探到审官撞限流 → 调 planCapacitySwitch 换人（假钩子证据）；选型序走完 → 报帅停手，不降级同厂。
// ④ 判别力：拿掉 429 指纹，① 必须变不报。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  STALL_FINGERPRINTS,
  matchFingerprints,
  nextStrike,
  scanRound,
  decideHitAction,
  stateWindow,
} from '../scripts/lib/agent-stall-detect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const CLI = join(REPO, 'scripts', 'agent-stall-watch.mjs');

// issue #833 正文夹具：2026-09-03 PR-827 审官真屏面
const SCREEN_429 = [
  '  === TASK ===',
  '  读 host/skills/dispatch/templates/reviewer-book.md 按审官任务书审 PR #827 p=827 d=ctx_f81eeebd9230 m=auto',
  '■ exceeded retry limit, last status: 429 Too Many Requests, request id: a353010e3ff21b48-FRA',
  '› Ask Codex to do anything',
  '  gpt-5.6-sol high · PR-827-审官-gpt-5.6-sol',
].join('\n');

const SCREEN_OK = [
  '  === TASK ===',
  '  读 host/skills/dispatch/templates/reviewer-book.md 按审官任务书审 PR #827',
  '正在读 diff…',
  '› Ask Codex to do anything',
].join('\n');

const OLD_FINGERPRINTS = [
  'Retry failed',
  'no serving account',
  'stream disconnected',
  'login rejected',
  'timed out connecting',
  /Reconnecting.*5\/5/i,
  'at capacity',
  'try a different model',
  'temporarily limiting requests',
  '503 Service Unavailable',
];

const MODELS = [
  { id: 'grok-4.6', provider: 'gw', roles: ['写码'] },
  { id: 'gpt-5.6-sol', provider: 'gpt', roles: ['审查'] },
  { id: 'gpt-5.6-luna', provider: 'gw', roles: ['审查'] },
  { id: 'kimi-k3', provider: 'gw', roles: ['审查'] },
];

test('#833 撞限流判据', async (t) => {
  await t.test('判别性实验①：今天这段 429 文本', async (t) => {
    await t.test('旧指纹表（改之前）不报', () => {
      assert.deepEqual(matchFingerprints(SCREEN_429, OLD_FINGERPRINTS), []);
    });
    await t.test('新表报 exceeded retry limit / 429', () => {
      const hits = matchFingerprints(SCREEN_429);
      assert.ok(hits.includes('exceeded retry limit'), hits.join(','));
      assert.ok(hits.includes('last status: 429') || hits.includes('429 Too Many Requests'), hits.join(','));
    });
    await t.test('正常工作屏面不报', () => {
      assert.deepEqual(matchFingerprints(SCREEN_OK), []);
    });
    await t.test('429 只在上部任务书、底部正常 → 整轮不报（状态窗，v0 假阳同款）', () => {
      const history = [
        ...Array.from({ length: 40 }, () => '正在读 diff…'),
        '夹具原文 exceeded retry limit, last status: 429 Too Many Requests',
        ...Array.from({ length: 20 }, () => '正在写审查意见…'),
      ].join('\n');
      assert.equal(matchFingerprints(stateWindow(history)).length, 0);
      const r = scanRound({
        agents: [{ handle: 'term_hist', screen: history, displayName: 'PR-#834 审官·gpt-5.6-sol' }],
        prevState: {},
        strikesNeeded: 1,
      });
      assert.equal(r.reports.length, 0);
    });
    await t.test('判别力：拿掉 429 三条，今天这段必须变不报', () => {
      const stripped = STALL_FINGERPRINTS.filter((fp) => {
        const s = fp instanceof RegExp ? fp.source : String(fp);
        return !/429|exceeded retry limit/i.test(s);
      });
      assert.deepEqual(matchFingerprints(SCREEN_429, stripped), []);
    });
  });

  await t.test('连红 2 轮才报；恢复即清零', () => {
    const a1 = nextStrike({ prev: {}, hitSig: 'exceeded retry limit', need: 2 });
    assert.equal(a1.fresh, false);
    assert.equal(a1.strikes, 1);
    const a2 = nextStrike({ prev: a1, hitSig: 'exceeded retry limit', need: 2 });
    assert.equal(a2.fresh, true);
    assert.equal(a2.reported, 'exceeded retry limit');
    const again = nextStrike({ prev: a2, hitSig: 'exceeded retry limit', need: 2 });
    assert.equal(again.fresh, false);
    const recovered = nextStrike({ prev: a2, hitSig: null, need: 2 });
    assert.equal(recovered.keep, false);
  });

  await t.test('scanRound：一轮不报、两轮报；屏面 null 算没查成', () => {
    const agents = [{
      handle: 'term_x',
      displayName: 'PR-#827 审官·gpt-5.6-sol',
      agentIdentity: 'codex',
      screen: SCREEN_429,
    }];
    const r1 = scanRound({ agents, prevState: {}, strikesNeeded: 2 });
    assert.equal(r1.reports.length, 0);
    assert.equal(r1.scanned, 1);
    const r2 = scanRound({ agents, prevState: r1.nextState, strikesNeeded: 2 });
    assert.equal(r2.reports.length, 1);
    assert.equal(r2.reports[0].sig, 'exceeded retry limit');
    const miss = scanRound({
      agents: [{ handle: 'term_y', screen: null }],
      prevState: {},
    });
    assert.equal(miss.unscanned, 1);
    assert.equal(miss.scanned, 0);
  });

  await t.test('判别性实验② / 选型序走完', async (t) => {
    await t.test('#843 后 grok 工人 + GPT 审官 → 下一位 luna 是 OpenAI 家族，跨厂可换', () => {
      const d = decideHitAction({
        displayName: 'PR-#827 审官·gpt-5.6-sol',
        workerId: 'grok-4.6',
        models: MODELS,
        passerIds: ['gpt-5.6-sol', 'gpt-5.6-luna', 'kimi-k3'],
        order: ['gpt-5.6-sol', 'gpt-5.6-luna', 'kimi-k3'],
      });
      assert.equal(d.action, 'switch');
      assert.equal(d.to, 'gpt-5.6-luna');
    });
    await t.test('选型序剩余全是 grok 家族 → 报帅停手，不降级同厂', () => {
      const d = decideHitAction({
        displayName: 'PR-#827 审官·gpt-5.6-sol',
        workerId: 'grok-4.6',
        models: MODELS,
        passerIds: ['gpt-5.6-sol', 'grok-4.6'],
        order: ['gpt-5.6-sol', 'grok-4.6'],
      });
      assert.equal(d.action, 'escalate');
      assert.equal(d.exhausted, true);
      assert.match(d.reason, /同厂/);
    });
    await t.test('工人是别厂、序里有跨厂候选 → switch', () => {
      const models = [
        { id: 'claude-opus', provider: 'claude', roles: ['写码'] },
        { id: 'gpt-5.6-sol', provider: 'gpt', roles: ['审查'] },
        { id: 'kimi-k3', provider: 'gw', roles: ['审查'] },
      ];
      const d = decideHitAction({
        displayName: 'PR-#827 审官·gpt-5.6-sol',
        workerId: 'claude-opus',
        models,
        passerIds: ['gpt-5.6-sol', 'kimi-k3'],
        order: ['gpt-5.6-sol', 'kimi-k3'],
      });
      assert.equal(d.action, 'switch');
      assert.equal(d.to, 'kimi-k3');
      assert.equal(d.pr, 827);
    });
    await t.test('工人卡不是审官 → 只报警不换人', () => {
      const d = decideHitAction({
        displayName: 'ISSUE-#833 工人·grok-4.6 把撞限流探测搬上服务器',
        workerId: 'grok-4.6',
        models: MODELS,
        passerIds: ['gpt-5.6-sol'],
        order: ['gpt-5.6-sol'],
      });
      assert.equal(d.action, 'alert');
    });
    await t.test('没查成工人 → 报帅不许换人', () => {
      const d = decideHitAction({
        displayName: 'PR-#827 审官·gpt-5.6-sol',
        models: MODELS,
        passerIds: ['gpt-5.6-sol', 'kimi-k3'],
        order: ['gpt-5.6-sol', 'kimi-k3'],
      });
      assert.equal(d.action, 'escalate');
      assert.equal(d.unscanned, true);
    });
  });
});

function writeFake(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, body, 'utf8');
  return p;
}

test('#833 CLI 夹具：假 orca 两轮 429 → 换人钩子被调', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stall-833-'));
  const state = join(dir, 'state.json');
  const log = join(dir, 'switch.log');
  const sayLog = join(dir, 'say.log');
  const screens = join(dir, 'screens');
  mkdirSync(screens);

  const orca = writeFake(dir, 'fake-orca.mjs', `#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
const screens = process.env.FAKE_SCREENS;
function emit(obj) { process.stdout.write(JSON.stringify({ ok: true, result: obj })); }
if (args[0] === 'terminal' && args[1] === 'list') {
  emit({ terminals: [{
    handle: 'term_429',
    agentIdentity: 'codex',
    title: 'PR-#664 审官·gpt-5.6-sol',
    worktreeId: 'wt-reviewer',
  }] });
  process.exit(0);
}
if (args[0] === 'terminal' && args[1] === 'read') {
  const i = args.indexOf('--terminal');
  const h = i >= 0 ? args[i + 1] : '';
  const f = screens + '/' + h + '.txt';
  const screen = existsSync(f) ? readFileSync(f, 'utf8') : '';
  emit({ terminal: { handle: h, screen } });
  process.exit(0);
}
if (args[0] === 'worktree' && args[1] === 'ps') {
  // live orca worktree ps 的主键是 worktreeId，没有 id（#833 实咬）
  emit({ worktrees: [
    { worktreeId: 'wt-worker', displayName: 'PR-#664 工人·claude-opus', parentWorktreeId: null },
    { worktreeId: 'wt-reviewer', displayName: 'PR-#664 审官·gpt-5.6-sol', parentWorktreeId: 'wt-worker' },
  ] });
  process.exit(0);
}
if (args[0] === 'orchestration' && args[1] === 'worker-list') {
  emit({ workers: [{ resource: { worktreeId: 'wt-worker' }, model: 'claude-opus' }] });
  process.exit(0);
}
process.stderr.write('fake-orca unexpected ' + args.join(' '));
process.exit(1);
`);

  const sw = writeFake(dir, 'fake-switch.mjs', `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.SWITCH_LOG, process.argv.slice(2).join(' ') + '\\n');
process.stdout.write(JSON.stringify({ ok: true }));
`);
  const say = writeFake(dir, 'fake-say.mjs', `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.SAY_LOG, process.argv.slice(2).join('\\n') + '\\n');
`);

  writeFileSync(join(screens, 'term_429.txt'), SCREEN_429, 'utf8');

  const env = {
    ...process.env,
    AGENT_STALL_ORCA: orca,
    AGENT_STALL_SWITCH: sw,
    AGENT_STALL_SAY: say,
    AGENT_STALL_STATE: state,
    AGENT_STALL_STRIKES: '2',
    FAKE_SCREENS: screens,
    SWITCH_LOG: log,
    SAY_LOG: sayLog,
  };

  const run = () => spawnSync(process.execPath, [CLI], { encoding: 'utf8', cwd: REPO, env, timeout: 15000 });
  const r1 = run();
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  assert.equal(readFileSync(state, 'utf8').includes('exceeded retry limit'), true);
  let switched = '';
  try { switched = readFileSync(log, 'utf8'); } catch { switched = ''; }
  assert.equal(switched, '');

  const r2 = run();
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  switched = readFileSync(log, 'utf8');
  assert.match(switched, /--pr 664/);
  assert.match(switched, /--reviewer kimi-k3/);
  const said = readFileSync(sayLog, 'utf8');
  assert.match(said, /已换成|想换成|卡在上游限流/); // 群里说人话（2026-09-04），技术行在 stdout

  rmSync(dir, { recursive: true, force: true });
});

test('#833 CLI 夹具：选型序走完 → 报帅，不调换人钩子', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stall-833e-'));
  const state = join(dir, 'state.json');
  const log = join(dir, 'switch.log');
  const sayLog = join(dir, 'say.log');
  const screens = join(dir, 'screens');
  mkdirSync(screens);

  const orca = writeFake(dir, 'fake-orca.mjs', `#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
const screens = process.env.FAKE_SCREENS;
function emit(obj) { process.stdout.write(JSON.stringify({ ok: true, result: obj })); }
if (args[0] === 'terminal' && args[1] === 'list') {
  emit({ terminals: [{ handle: 'term_429', agentIdentity: 'codex', title: 'x', worktreeId: 'wt-reviewer' }] });
  process.exit(0);
}
if (args[0] === 'terminal' && args[1] === 'read') {
  const screen = existsSync(screens + '/term_429.txt') ? readFileSync(screens + '/term_429.txt', 'utf8') : '';
  emit({ terminal: { handle: 'term_429', screen } });
  process.exit(0);
}
if (args[0] === 'worktree' && args[1] === 'ps') {
  emit({ worktrees: [
    { worktreeId: 'wt-worker', displayName: 'PR-#664 工人·grok-4.6', parentWorktreeId: null, linkedIssue: 664 },
    { worktreeId: 'wt-reviewer', displayName: 'PR-#664 审官·glm-5.2', parentWorktreeId: 'wt-worker' },
  ] });
  process.exit(0);
}
if (args[0] === 'orchestration' && args[1] === 'worker-list') {
  emit({ workers: [{ resource: { worktreeId: 'wt-worker' }, model: 'grok-4.6' }] });
  process.exit(0);
}
process.exit(1);
`);
  const sw = writeFake(dir, 'fake-switch.mjs', `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.SWITCH_LOG, 'CALLED\\n');
process.exit(0);
`);
  const say = writeFake(dir, 'fake-say.mjs', `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.SAY_LOG, process.argv.slice(2).join('\\n') + '\\n');
`);
  writeFileSync(join(screens, 'term_429.txt'), SCREEN_429, 'utf8');
  writeFileSync(state, JSON.stringify({
    term_429: { strikes: 1, reported: null, sig: 'exceeded retry limit' },
  }), 'utf8');

  const env = {
    ...process.env,
    AGENT_STALL_ORCA: orca,
    AGENT_STALL_SWITCH: sw,
    AGENT_STALL_SAY: say,
    AGENT_STALL_STATE: state,
    AGENT_STALL_STRIKES: '2',
    FAKE_SCREENS: screens,
    SWITCH_LOG: log,
    SAY_LOG: sayLog,
  };
  const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8', cwd: REPO, env, timeout: 15000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  let switched = '';
  try { switched = readFileSync(log, 'utf8'); } catch { switched = ''; }
  assert.equal(switched, '');
  const said = readFileSync(sayLog, 'utf8');
  assert.match(said, /先停手等你拍/); // 「报帅停手」是内部说法，群里改人话（2026-09-04）
  rmSync(dir, { recursive: true, force: true });
});
