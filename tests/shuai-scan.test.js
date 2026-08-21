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

function sampleScanResult(S, overrides = {}) {
  const rules = overrides.rules || { 帅位标题建议: { 模板: {} }, 异常判据: {}, 推荐排序: {} };
  const github = overrides.github || {
    ok: true,
    issues: [{ number: 42, title: '可起', labels: [{ name: '已消歧' }], updatedAt: '2026-08-21T00:00:00Z' }],
    prs: [],
  };
  const orca = overrides.orca || {
    ok: true,
    plan: { retire: [] },
    workers: [],
    worktrees: [],
    pendingInboxCount: 0,
  };
  return S.evaluateScan({ rules, orca, github });
}

describe('shuai-scan 规则文件', () => {
  it('默认 rules JSON 能解析', async () => {
    const S = await LOAD;
    const loaded = S.loadRulesFile(RULES);
    assert.ok(loaded.ok, loaded.error);
    assert.ok(loaded.rules['异常判据']['僵尸Run阈值']['值'] === 5);
    assert.ok(typeof loaded.rules['状态去重']?.['说明'] === 'string');
    assert.ok(typeof loaded.rules['帅位标题建议']?.['模板']?.P1 === 'string');
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

  it('P0 PR CI 红进入推荐且有内容', async () => {
    const S = await LOAD;
    const rules = { 异常判据: {}, 推荐排序: {}, 帅位标题建议: { 模板: {} } };
    const github = {
      ok: true,
      issues: [],
      prs: [{ number: 9, title: '红 PR', isDraft: false, statusCheckRollup: rollup('FAILURE') }],
    };
    const ev = S.evaluateScan({
      rules,
      orca: { ok: true, plan: { retire: [] }, workers: [], worktrees: [], pendingInboxCount: 0 },
      github,
    });
    assert.ok(ev.ok && ev.hasContent);
    assert.ok(ev.titleSuggestion.includes('#9'));
  });

  it('仅 P3 无内容可报', async () => {
    const S = await LOAD;
    const rules = { 异常判据: { 僵尸Run阈值: { 值: 9999 }, 未读消息条数阈值: { 值: 9999 } }, 推荐排序: {} };
    const github = {
      ok: true,
      issues: [{ number: 1, title: 'backlog', labels: [], updatedAt: '2026-08-21T00:00:00Z' }],
      prs: [],
    };
    const orca = { ok: true, plan: { retire: [] }, workers: [], worktrees: [], pendingInboxCount: 0 };
    const ev = S.evaluateScan({ rules, orca, github });
    assert.ok(ev.ok && !ev.hasContent);
  });
});

describe('shuai-scan 状态去重', () => {
  it('同一盘面哈希稳定', async () => {
    const S = await LOAD;
    const a = sampleScanResult(S);
    const b = sampleScanResult(S);
    assert.strictEqual(a.stateHash, b.stateHash);
  });

  it('P3 变化不改变去重键', async () => {
    const S = await LOAD;
    const base = {
      ok: true,
      issues: [
        { number: 42, title: '可起', labels: [{ name: '已消歧' }], updatedAt: '2026-08-21T00:00:00Z' },
        { number: 99, title: 'backlog', labels: [], updatedAt: '2026-08-20T00:00:00Z' },
      ],
      prs: [],
    };
    const h1 = sampleScanResult(S, { github: base }).stateHash;
    const h2 = sampleScanResult(S, {
      github: {
        ...base,
        issues: [
          base.issues[0],
          { number: 99, title: 'backlog', labels: [], updatedAt: '2026-08-22T12:00:00Z' },
        ],
      },
    }).stateHash;
    assert.strictEqual(h1, h2);
  });

  it('哈希一致 → decideOutput 不 emit', async () => {
    const S = await LOAD;
    const result = sampleScanResult(S);
    const d = S.decideOutput({ result, lastState: { ok: true, hash: result.stateHash } });
    assert.ok(d.ok && !d.emit && d.reason === 'unchanged');
  });

  it('落盘读不到 → 视为首轮 emit', async () => {
    const S = await LOAD;
    const result = sampleScanResult(S);
    const d = S.decideOutput({ result, lastState: { ok: false, firstRun: true } });
    assert.ok(d.ok && d.emit && d.reason === 'first-run');
  });
});

describe('shuai-scan 标题建议', () => {
  it('P1 模板生成待合并标题', async () => {
    const S = await LOAD;
    const title = S.suggestChatTitle({
      rules: { 帅位标题建议: { 模板: { P1: '帅·#{number} 待合并' } } },
      anomalies: { ok: true, anomalies: [] },
      recommendations: {
        ok: true,
        items: [{ priority: 'P1', kind: 'pr', number: 710, title: '某 PR' }],
      },
    });
    assert.strictEqual(title, '帅·#710 待合并');
  });

  it('摘要含标题建议行', async () => {
    const S = await LOAD;
    const ev = sampleScanResult(S);
    assert.ok(/帅位标题建议：帅·#42/.test(ev.summary));
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
    assert.ok(!(r.stdout || '').includes('AGENT_LOOP_TICK_PANMIAN'));
  });
});
