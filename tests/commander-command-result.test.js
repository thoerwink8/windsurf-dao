// Exercise the subprocess -> dao receipt -> retry/escalation boundary without
// starting agents, calling GitHub, or writing production ledgers.
const { it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-result-'));
process.env.COMMANDER_STATE_DIR = path.join(scratch, 'state');
process.env.MIRASIM_WORKTREES = path.join(scratch, 'trees');
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const CMD = import('../scripts/commander.mjs');
const VERBS = import('../scripts/lib/commander-verbs.mjs');
const longError = '起会话被拒：' + 'x'.repeat(700);
const busy = { ok: false, error: longError, busy: true, reason: 'lease-held',
  holders: [{ session: 'test-only', details: { note: 'braces { } and "quotes" \\ inside JSON' } }] };
const start = ['node', 'scripts/dao.mjs', 'start'];

it('nonzero subprocess keeps full stdout/stderr while human error stays bounded', async () => {
  const { runCmd } = await CMD;
  const stdout = JSON.stringify(busy);
  const stderr = 'diagnostic '.repeat(80);
  // A real harmless child proves the exit-code boundary, not just the parser.
  const r = runCmd([process.execPath, '-e',
    'process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2]); process.exitCode=1;', stdout, stderr]);
  assert.equal(r.ok, false);
  assert.equal(r.status, 1);
  assert.equal(r.out, stdout);
  assert.equal(r.stderr, stderr);
  assert.equal(r.error.length, 300);
  assert.equal(JSON.parse(r.out).busy, true);
});

it('known dao busy receipt survives the subprocess boundary and runOrShow', async () => {
  const { runCmd, runOrShow } = await CMD;
  const stdout = '[dao] diagnostic\n' + JSON.stringify(busy, null, 2) + '\n';
  const r = runOrShow(start, { say: () => {}, run: argv => runCmd(argv, 1000, {
    spawn: () => ({ status: 1, stdout, stderr: 'e'.repeat(800) }),
  }) });
  assert.equal(r.ok, false);
  assert.equal(r.busy, true);
  assert.equal(r.reason, 'lease-held');
  assert.equal(r.out, stdout);
  assert.equal(r.stderr.length, 800);
  assert.equal(r.error.length, 300);
});

it('only a known dao receipt can classify busy; failures cannot become success', async () => {
  const { runCmd, runOrShow } = await CMD;
  const cases = [
    { argv: ['git', 'status'], doc: busy, status: 1 },
    { argv: ['node', 'scripts/other.mjs', 'start'], doc: busy, status: 1 },
    { argv: ['node', 'scripts/dao.mjs', 'raw'], doc: busy, status: 1 },
    { argv: start, doc: { ok: false, error: 'busy:true lease-held is just prose' }, status: 1 },
    { argv: start, doc: { ok: false, busy: 'true', error: 'failed' }, status: 1 },
    { argv: start, doc: { ok: true, busy: true }, status: 1 },
    { argv: start, doc: { ok: false, error: 'real failure' }, status: 0 },
    { argv: start, doc: busy, status: null, signal: 'SIGTERM' },
    { argv: start, doc: busy, status: null, error: { code: 'ETIMEDOUT', message: 'timed out' } },
  ];
  for (const c of cases) {
    const r = runOrShow(c.argv, { say: () => {}, run: argv => runCmd(argv, 1000, {
      spawn: () => ({ status: c.status, signal: c.signal, error: c.error,
        stdout: JSON.stringify(c.doc), stderr: '' }),
    }) });
    assert.equal(r.ok, false, JSON.stringify(c));
    assert.notEqual(r.busy, true, JSON.stringify(c));
  }
});

it('parser keeps final nested document, rejects truncated receipts and trailing prose', async () => {
  const { parseDaoResult } = await CMD;
  const pretty = JSON.stringify(busy, null, 2);
  assert.deepEqual(parseDaoResult(pretty), busy);
  assert.deepEqual(parseDaoResult('[log] {not JSON}\n{"phase":"starting"}\n' + pretty), busy);
  for (const text of [pretty.slice(0, -1), pretty + '\nnot a receipt', '[{"ok":false,"busy":true}]',
    '{"outer":\n' + pretty, 'busy:true lease-held']) {
    assert.equal(parseDaoResult(text), null, text);
  }
});

it('nested held drain reaches the shared ledger classifier without consuming a try', async () => {
  const { drainPayloadOf, runOrShow } = await CMD;
  const { applyDrainLedger } = await VERBS;
  const payload = { ok: true, drained: 0, failed: 0, held: 1,
    results: [{ pr: 987321, detail: { reason: 'capacity', holders: ['test-only'] } }] };
  const result = runOrShow(['node', 'scripts/dao.mjs', 'review-pending-drain'], {
    say: () => {}, run: () => ({ ok: true, out: '[drain] scan\n' + JSON.stringify(payload, null, 2) }),
  });
  assert.deepEqual(drainPayloadOf(result), payload);
  const ledger = { '987321': { tries: 1 } };
  const held = applyDrainLedger({ ledger, pr: 987321, head: 'abc', payload: drainPayloadOf(result), nowIso: '2026-09-12T00:00:00Z' });
  assert.equal(held.wrote, false);
  assert.deepEqual(held.ledger, ledger);
  const failed = drainPayloadOf({ ok: false, out: JSON.stringify({ ok: false, error: { detail: 'failure' } }) });
  assert.equal(applyDrainLedger({ ledger: {}, pr: 987321, head: 'abc', payload: failed }).wrote, true);
  assert.equal(drainPayloadOf({ ok: false, out: JSON.stringify(payload) }).ok, false);
});

for (const kind of ['rework', 'pump-draft']) {
  for (const isBusy of [true, false]) {
    it(`${kind}: ${isBusy ? 'busy preserves tries and emits no escalation' : 'genuine failure consumes a try and escalates'}`, async () => {
      const { dispatchRework, dispatchPumpDraft, runActions, runCmd } = await CMD;
      const dispatch = kind === 'rework' ? dispatchRework : dispatchPumpDraft;
      const action = { kind, pr: 987321, issue: 987654, head: 'abcdef1234567890',
        reworkKey: 'test-rework', pumpKey: 'test-pump', model: 'grok-4.6', brief: 'test-only', redRounds: 1 };
      const key = kind === 'rework' ? action.reworkKey : action.pumpKey;
      // Check both an untouched retry ledger and one with a prior attempt.
      for (const initial of [{}, { reworkDispatched: { [key]: { tries: 1, at: 'prior', ok: false } } }]) {
        const state = structuredClone(initial);
        const receipt = isBusy ? busy : { ok: false, error: longError, reason: 'start-failed' };
        let starts = 0;
        const run = argv => {
          if (argv.includes('view')) return { ok: true, out: 'test-branch' };
          if (argv.includes('worktree-create')) return { ok: true, out: JSON.stringify({ ok: true, path: path.join(scratch, 'fake-tree') }) };
          assert.equal(argv[2], 'start');
          starts++;
          return runCmd(argv, 1000, { spawn: () => ({ status: 1, stdout: JSON.stringify(receipt), stderr: '' }) });
        };
        const executed = [];
        const result = runActions([action, { kind: 'notify-hub', issue: action.issue, pr: action.pr }], {
          exec: a => {
            executed.push(a.kind);
            return a.kind === kind ? dispatch(a, { state, dryRun: false, say: () => {}, run,
              briefDir: path.join(scratch, kind) }) : { ok: true };
          },
        });
        assert.equal(starts, 1);
        assert.equal(executed.includes('notify-hub'), false);
        if (isBusy) {
          assert.deepEqual(state, initial);
          assert.deepEqual(result.generated, []);
          assert.equal(executed.includes('escalate'), false);
        } else {
          assert.equal(state.reworkDispatched[key].tries, (initial.reworkDispatched?.[key]?.tries || 0) + 1);
          assert.equal(state.reworkDispatched[key].ok, false);
          assert.equal(result.generated[0].reason, `${kind}-failed`);
          assert.equal(executed.includes('escalate'), true);
        }
      }
    });
  }
}
