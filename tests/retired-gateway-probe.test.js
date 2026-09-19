const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LIB = 'file://' + path.join(ROOT, 'scripts/lib/retired-gateway-probe.mjs').split(path.sep).join('/');
const SCRIPT = path.join(ROOT, 'scripts', 'gw-remote-probe.mjs');

describe('isRetiredNewApiUrl', () => {
  it('认退役主机和本机 4317 桥，不误伤 pqapi / 假网关', async () => {
    const { isRetiredNewApiUrl } = await import(LIB);
    assert.equal(isRetiredNewApiUrl('https://156.224.28.95.sslip.io/v1/chat/completions'), true);
    assert.equal(isRetiredNewApiUrl('https://156.224.28.95/v1'), true);
    assert.equal(isRetiredNewApiUrl('http://127.0.0.1:4317/v1'), true);
    assert.equal(isRetiredNewApiUrl('http://localhost:4317/responses'), true);
    assert.equal(isRetiredNewApiUrl('https://api.pqapi.shop/v1'), false);
    assert.equal(isRetiredNewApiUrl('http://127.0.0.1:4315/v1'), false);
    assert.equal(isRetiredNewApiUrl('http://127.0.0.1:9'), false);
    assert.equal(isRetiredNewApiUrl(''), false);
    assert.equal(isRetiredNewApiUrl(null), false);
  });
});

describe('selectPoolProbes / pruneHealthKeys', () => {
  const pools = [
    { key: 'gw:grokpool/grok-4.6', group: 'grokpool', model: 'grok-4.6' },
    { key: 'gw:gptpool/gpt-5.6', group: 'gptpool', model: 'gpt-5.6' },
  ];

  it('默认跳过全部 gw 池；--include-retired-gw 才留下', async () => {
    const { selectPoolProbes, includeRetiredGateway } = await import(LIB);
    const skip = selectPoolProbes(pools, { includeRetired: includeRetiredGateway([]) });
    assert.deepEqual(skip.jobs, []);
    assert.equal(skip.skipped.length, 2);
    assert.match(skip.skipped[0].why, /#1174 T7/);
    const keep = selectPoolProbes(pools, { includeRetired: includeRetiredGateway(['--include-retired-gw']) });
    assert.equal(keep.jobs.length, 2);
    assert.equal(keep.skipped.length, 0);
  });

  it('拿掉没探的 gw: key，native 留下——updatedAt 新了也不能把旧绿装成刚探过', async () => {
    const { pruneHealthKeys } = await import(LIB);
    const next = pruneHealthKeys({
      'gw:grokpool/grok-4.6': { kind: 'pool', state: 'green', why: 'old' },
      'native:xai-native': { kind: 'native-login', state: 'unscanned', why: 'file' },
    }, ['gw:grokpool/grok-4.6']);
    assert.equal(next['gw:grokpool/grok-4.6'], undefined);
    assert.equal(next['native:xai-native'].kind, 'native-login');
  });

  it('--only 命中默认跳过的池：该 key 进 skipped，其它池不进 jobs/skipped', async () => {
    const { selectPoolProbes } = await import(LIB);
    const r = selectPoolProbes(pools, { includeRetired: false, only: 'gw:gptpool/gpt-5.6' });
    assert.deepEqual(r.jobs, []);
    assert.deepEqual(r.skipped.map((s) => s.key), ['gw:gptpool/gpt-5.6']);
  });
});

describe('周期探针源码闸', () => {
  it('默认路径走 selectPoolProbes，旗标 --include-retired-gw 写在用法里', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.match(src, /selectPoolProbes/);
    assert.match(src, /isRetiredNewApiUrl/);
    assert.match(src, /--include-retired-gw/);
    assert.match(src, /pruneHealthKeys/);
    assert.doesNotMatch(
      src,
      /const wantPool = PLAN\.pools\.filter/,
      '不许再无条件 for PLAN.pools 发请求',
    );
    assert.doesNotMatch(
      src,
      /only\s*\?\s*folded/,
      '--only 命中但仍 skip 的 gw: 池也必须 prune，不能 folded 原样留旧绿',
    );
  });
});
