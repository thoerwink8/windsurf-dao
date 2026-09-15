const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = import('../scripts/lib/branch-protection-io.mjs');

test('read adapter rejects writes before selecting credentials', async () => {
  const { readBranchProtection } = await load;
  const r = readBranchProtection(['api', 'repos/o/r/branches/master', '-X', 'DELETE'], {
    appCredentials: () => { throw Error('must not request credentials'); },
  });
  assert.equal(r.status, 1);
});

test('branch read uses application identity when personal GitHub login is disabled', async () => {
  const { readBranchProtection } = await load;
  let role;
  const r = readBranchProtection(['api', 'repos/o/r/branches/master'], {
    appCredentials: () => ({ ok: true }),
    readAsApp: (r, args) => { role = r; assert.equal(args[0], 'api'); return { ok: true, out: '{"protected":true}' }; },
    readAsCli: () => { throw Error('personal login is unavailable'); },
  });
  assert.equal(role, 'marshal');
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).protected, true);
});

test('application failure remains failure rather than silently falling back to personal auth', async () => {
  const { readBranchProtection } = await load;
  const r = readBranchProtection(['api', 'repos/o/r/branches/master'], {
    appCredentials: () => ({ ok: true }), readAsApp: () => ({ ok: false, status: 1, error: 'denied' }),
    readAsCli: () => { throw Error('must not change identities after rejection'); },
  });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'denied');
});

test('a CI checkout without App credentials can use its existing scoped CLI token', async () => {
  const { readBranchProtection } = await load;
  const r = readBranchProtection(['api', 'repos/o/r/branches/master'], {
    appCredentials: () => ({ ok: false }), readAsApp: () => { throw Error('no app'); },
    readAsCli: () => ({ status: 0, stdout: '{}', stderr: '' }),
  });
  assert.equal(r.status, 0);
});
