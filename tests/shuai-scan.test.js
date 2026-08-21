// tests/shuai-scan.test.js —— 帅位看门狗判别力回归网（chain:shuai-watchdog#1）

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'shuai-scan.mjs');
const CLI = path.join(REPO, 'scripts', 'shuai-scan.mjs');
const RULES = path.join(REPO, 'docs', 'shuai-scan-rules.json');
const LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function rollup(...conclusions) {
  return conclusions.map((c) => ({ status: 'COMPLETED', conclusion: c }));
}

describe('shuai-scan 规则文件', () => {
  it('默认 rules JSON 能解析', async () => {
    const S = await LOAD;
    const loaded = S.loadRulesFile(RULES);
    assert.ok(loaded.ok, loaded.error);
    assert.ok(loaded.rules['异常判据']['僵尸Run阈值']['值'] === 5);
  });

  it('JSON 语法错 → 非 ok', async () => {
    const S = await LOAD;
    const bad = S.loadRules('{ broken');
    assert.ok(!bad.ok && /JSON/.test(bad.error));
  });
});

describe('shuai-scan 判定层', () => {
  it('僵尸 Run 超阈值报异常', async () => {
    const S = await LOAD;
    const rules = { 异常判据: { 僵尸Run阈值: { 值: 0 } }, 推荐排序: {} };
    const orca = {
      ok: true,
      plan: { retire: [{ id: 'run_a' }] },
      workers: [],
      worktrees: [],
      pendingInboxCount: 0,
    };
    const github = { ok: true, issues: [], prs: [] };
    const an = S.detectAnomalies({ rules, orca, github });
    assert.ok(an.ok && an.anomalies.some((l) => /僵尸 Run 1/.test(l)));
  });

  it('僵尸阈值极高 → 零异常', async () => {
    const S = await LOAD;
    const rules = { 异常判据: { 僵尸Run阈值: { 值: 9999 }, 未读消息条数阈值: { 值: 9999 } }, 推荐排序: {} };
    const orca = {
      ok: true,
      plan: { retire: [{ id: 'run_a' }] },
      workers: [],
      worktrees: [],
      pendingInboxCount: 1,
    };
    const github = { ok: true, issues: [], prs: [] };
    const an = S.detectAnomalies({ rules, orca, github });
    assert.ok(an.ok && an.anomalies.length === 0);
  });

  it('P0 PR CI 红进入推荐且触发 wake', async () => {
    const S = await LOAD;
    const rules = { 异常判据: {}, 推荐排序: {} };
    const github = {
      ok: true,
      issues: [],
      prs: [{ number: 9, title: '红 PR', isDraft: false, statusCheckRollup: rollup('FAILURE') }],
    };
    const rec = S.buildRecommendations({ rules, github, orca: { ok: true, worktrees: [] } });
    assert.ok(rec.items.some((i) => i.priority === 'P0' && i.number === 9));
    const ev = S.evaluateScan({
      rules,
      orca: { ok: true, plan: { retire: [] }, workers: [], worktrees: [], pendingInboxCount: 0 },
      github,
    });
    assert.ok(ev.ok && ev.wake);
  });

  it('P2 已消歧未派工', async () => {
    const S = await LOAD;
    const github = {
      ok: true,
      issues: [{ number: 42, title: '可起', labels: [{ name: '已消歧' }], updatedAt: '2026-08-21T00:00:00Z' }],
      prs: [],
    };
    const rec = S.buildRecommendations({ rules: {}, github, orca: { ok: true, worktrees: [] } });
    assert.ok(rec.items.some((i) => i.priority === 'P2' && i.number === 42));
  });

  it('仅 P3 不 wake', async () => {
    const S = await LOAD;
    const rules = { 异常判据: { 僵尸Run阈值: { 值: 9999 }, 未读消息条数阈值: { 值: 9999 } }, 推荐排序: {} };
    const github = {
      ok: true,
      issues: [{ number: 1, title: 'backlog', labels: [], updatedAt: '2026-08-21T00:00:00Z' }],
      prs: [],
    };
    const orca = { ok: true, plan: { retire: [] }, workers: [], worktrees: [], pendingInboxCount: 0 };
    const ev = S.evaluateScan({ rules, orca, github });
    assert.ok(ev.ok && !ev.wake);
  });

  it('Orca 没扫成 ≠ 零异常', async () => {
    const S = await LOAD;
    const an = S.detectAnomalies({
      rules: { 异常判据: {}, 推荐排序: {} },
      orca: { ok: false, error: 'run-list 挂了' },
      github: { ok: true, issues: [], prs: [] },
    });
    assert.ok(!an.ok && /没扫成|查成/.test(an.error));
  });
});

describe('shuai-scan CLI 契约', () => {
  it('规则坏 JSON → 非零 + stderr，无 sentinel', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shuai-scan-bad-'));
    const badRules = path.join(tmp, 'bad.json');
    fs.writeFileSync(badRules, '{ nope', 'utf8');
    const r = spawnSync(process.execPath, [CLI, '--rules', badRules], { encoding: 'utf8', cwd: REPO });
    assert.notStrictEqual(r.status, 0);
    assert.ok((r.stderr || '').trim().length > 0);
    assert.ok(!(r.stdout || '').includes('AGENT_LOOP_TICK_PANMIAN'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('gh 鉴权失败 → 非零 + stderr，无 sentinel', () => {
    const r = spawnSync(process.execPath, [CLI], {
      encoding: 'utf8',
      cwd: REPO,
      env: { ...process.env, GH_TOKEN: 'invalid-token-on-purpose', GITHUB_TOKEN: 'invalid-token-on-purpose' },
    });
    assert.notStrictEqual(r.status, 0);
    assert.ok((r.stderr || '').trim().length > 0);
    assert.ok(/GitHub 没扫成|gh /.test(r.stderr || ''));
    assert.ok(!(r.stdout || '').includes('AGENT_LOOP_TICK_PANMIAN'));
  });
});
