// #1150：orca 批派工已退役。本套只钉「调用即拒」，不测已删的 orca 批派脊。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'scripts', 'dao.mjs');
const LIB = path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs');
const S_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

describe('#1150 dispatch --batch 已退役', () => {
  it('buildBatchInject 当场拒', async () => {
    const S = await S_LOAD;
    assert.throws(() => S.buildBatchInject({ spec: 'x', issue: '1' }), /orca 已退役/);
  });

  it('dao.mjs dispatch --batch 当场拒', () => {
    const r = spawnSync(process.execPath, [
      CLI, 'dispatch', '--batch', '/tmp/no.json', '--name', 'x', '--issue', '1', '--model', 'grok-4.6',
      '--dry-run',
    ], { encoding: 'utf8', cwd: REPO });
    let payload = {};
    try { payload = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); } catch { /* 非 JSON */ }
    assert.notEqual(r.status, 0);
    assert.match(String(payload.error || r.stderr || ''), /orca 已退役/);
  });

  it('cmdDispatchBatch 是退役 stub', () => {
    const src = require('fs').readFileSync(CLI, 'utf8');
    const fn = src.match(/function cmdDispatchBatch[\s\S]*?\nfunction /);
    assert.ok(fn, 'cmdDispatchBatch 找不到');
    assert.match(fn[0], /orca 已退役/);
    assert.doesNotMatch(fn[0], /bindStation/);
  });
});
