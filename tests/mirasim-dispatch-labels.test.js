const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = import('../scripts/lib/dispatch/card.mjs');

test('type-only backfill uses the gateway and an ASCII-safe key', async () => {
  const { stampIssueLabels } = await load;
  const { isGatewayKeySafe } = await import('../scripts/lib/escalation-key.mjs');
  const writes = [];
  const r = stampIssueLabels({ issue: 1182, role: '写码', preserveType: true,
    runGh: args => ({ ok: true, out: JSON.stringify(args[0] === 'issue' ? { labels: ['已拍板', '已消歧', 'model/grok-4.6'] } : [{ name: 'type/写码' }]) }),
    writeIssue: req => { writes.push(req); return { ok: true }; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(writes[0].add, ['type/写码']);
  assert.equal(isGatewayKeySafe(writes[0].idempotency_key), true);
});

test('freshly declared type wins over a default backfill and a failed write remains failure', async () => {
  const { stampIssueLabels } = await load;
  const kept = stampIssueLabels({ issue: 1182, role: '写码', preserveType: true,
    runGh: () => ({ ok: true, out: JSON.stringify({ labels: ['type/体系'] }) }),
    writeIssue: () => { throw Error('must preserve declared type'); },
  });
  assert.equal(kept.ok, true);
  assert.deepEqual(kept.add, []);
  const failed = stampIssueLabels({ issue: 1182, role: '写码', preserveType: true,
    runGh: args => ({ ok: true, out: JSON.stringify(args[0] === 'issue' ? { labels: [] } : [{ name: 'type/写码' }]) }),
    writeIssue: () => ({ ok: false, error: 'denied' }),
  });
  assert.equal(failed.ok, false);
});
