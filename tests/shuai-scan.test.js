// tests/shuai-scan.test.js —— 帅位看门狗判别力回归网（chain:shuai-watchdog#1）

const { describe, it } = require('node:test');
const assert = require('node:assert');
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

describe('#966 GraphQL 带 milestone，推迟档不进推荐', () => {
  it('查询字符串问了 milestone.title', async () => {
    const S = await LOAD;
    assert.match(S.GITHUB_GRAPHQL, /milestone \{ title \}/);
  });

  it('normalize：有 title 就带上，缺字段当没挂档', async () => {
    const S = await LOAD;
    const deferred = S.normalizeGithubGraphql({
      repository: {
        issues: { nodes: [{
          number: 819, title: '先过渡', updatedAt: '2026-09-07T00:00:00Z',
          labels: { nodes: [{ name: '已消歧' }] },
          milestone: { title: '将来某版' },
        }] },
        pullRequests: { nodes: [] },
      },
    });
    assert.equal(deferred.ok, true);
    assert.equal(deferred.issues[0].milestone.title, '将来某版');
    const missing = S.normalizeGithubGraphql({
      repository: {
        issues: { nodes: [{
          number: 10, title: '现在做', updatedAt: '2026-09-07T00:00:00Z',
          labels: { nodes: [{ name: '已消歧' }] },
        }] },
        pullRequests: { nodes: [] },
      },
    });
    assert.equal(missing.ok, true);
    assert.equal(missing.issues[0].milestone, null);
  });
});

describe('#1147 GraphQL 带 committedDate，normalize 落到 lastCommittedAt', () => {
  it('查询字符串问了 committedDate', async () => {
    const S = await LOAD;
    assert.match(S.GITHUB_GRAPHQL, /committedDate/);
  });

  it('有 committedDate 就带上，缺字段是 null 不当超龄', async () => {
    const S = await LOAD;
    const withDate = S.normalizeGithubGraphql({
      repository: {
        issues: { nodes: [] },
        pullRequests: { nodes: [{
          number: 885, title: 'draft', updatedAt: '2026-09-08T00:00:00Z', isDraft: true,
          commits: { nodes: [{ commit: { committedDate: '2026-09-07T18:00:00Z' } }] },
        }] },
      },
    });
    assert.equal(withDate.ok, true);
    assert.equal(withDate.prs[0].lastCommittedAt, '2026-09-07T18:00:00Z');
    const missing = S.normalizeGithubGraphql({
      repository: {
        issues: { nodes: [] },
        pullRequests: { nodes: [{ number: 1, title: 'x', updatedAt: '2026-09-08T00:00:00Z', isDraft: true }] },
      },
    });
    assert.equal(missing.ok, true);
    assert.equal(missing.prs[0].lastCommittedAt, null);
  });
});

describe('#966 推迟档不进推荐（接 GraphQL 归一化）', () => {
  it('挂将来某版的已消歧单不进 P2，也不进 P3', async () => {
    const S = await LOAD;
    const rec = S.buildRecommendations({
      rules: { 异常判据: {}, 推荐排序: {} },
      github: {
        ok: true,
        issues: [
          { number: 819, title: '先过渡', labels: [{ name: '已消歧' }], milestone: { title: '将来某版' }, updatedAt: '2026-09-07T00:00:00Z' },
          { number: 42, title: '可起', labels: [{ name: '已消歧' }], updatedAt: '2026-08-21T00:00:00Z' },
        ],
        prs: [],
      },
      orca: { ok: true, worktrees: [] },
    });
    assert.equal(rec.ok, true);
    const p2 = rec.items.filter((i) => i.priority === 'P2').map((i) => i.number);
    const p3 = rec.items.filter((i) => i.priority === 'P3').map((i) => i.number);
    assert.deepStrictEqual(p2, [42]);
    assert.deepStrictEqual(p3, []);
  });
});

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

  it('draft + APPROVED 判绿待拍板不隐形（#730 实证：manual 合门制度类 PR 按制度就是 draft）', async () => {
    const S = await LOAD;
    const rules = { 异常判据: {}, 推荐排序: {}, 帅位标题建议: { 模板: {} } };
    const github = {
      ok: true,
      issues: [],
      prs: [
        { number: 730, title: '制度类 PR', isDraft: true, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', statusCheckRollup: rollup('SUCCESS') },
        { number: 740, title: '普通判绿 PR', isDraft: false, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', statusCheckRollup: rollup('SUCCESS') },
        { number: 729, title: '红项 PR', isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', statusCheckRollup: rollup('SUCCESS') },
      ],
    };
    const orca = { ok: true, plan: { retire: [] }, workers: [], worktrees: [], pendingInboxCount: 0 };
    const an = S.detectAnomalies({ rules, orca, github });
    assert.ok(an.ok && an.anomalies.some((l) => /PR #730 判绿待拍板（draft，manual 合门）/.test(l)),
      'draft 判绿进异常面  →  ' + JSON.stringify(an.anomalies));
    assert.ok(an.anomalies.some((l) => /PR #740 审官已绿待合并/.test(l)), '非 draft 判绿仍报待合并');
    assert.ok(!an.anomalies.some((l) => /#729/.test(l)), '红项 PR 不报判绿');
    const rec = S.buildRecommendations({ rules, github, orca });
    assert.ok(rec.ok && rec.items.some((i) => i.priority === 'P1' && /PR #730 判绿待拍板/.test(i.line)),
      'draft 判绿进推荐序 P1  →  ' + JSON.stringify(rec.items));
    const ev = S.evaluateScan({ rules, orca, github });
    assert.ok(ev.ok && ev.hasContent, 'draft 判绿算有内容可报（不被去重吞掉）');
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
  it('快照目录空 → 非零 + stderr，无 sentinel（主路已换推进量，不再读 rules/gh）', async () => {
    const C = await import('file://' + CLI.replace(/\\/g, '/'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shuai-scan-empty-'));
    const r = C.runShuaiScan(['node', CLI, '--dir', tmp, '--state', path.join(tmp, 'state.json')]);
    assert.notStrictEqual(r.exit, 0);
    assert.ok((r.stderr || '').trim().length > 0);
    assert.ok(!(r.stdout || '').includes('AGENT_LOOP_TICK_PANMIAN'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('快照文件损坏 → 非零 + stderr，无 sentinel', async () => {
    const C = await import('file://' + CLI.replace(/\\/g, '/'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shuai-scan-bad-'));
    fs.writeFileSync(path.join(tmp, 'situation-2026-09-06T00-00-00-000Z.json'), '{', 'utf8');
    const r = C.runShuaiScan(['node', CLI, '--dir', tmp, '--state', path.join(tmp, 'state.json')]);
    assert.notStrictEqual(r.exit, 0);
    assert.ok((r.stderr || '').trim().length > 0);
    assert.ok(!(r.stdout || '').includes('AGENT_LOOP_TICK_PANMIAN'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// #1094：指挥官 human_holds 闸要读 issue 正文。查询必须要 body 字段；
// 节点没给 body 键 ≠ 正文是空串——缺键是没查成。
describe('GitHub 快照带 issue body（#1094）', () => {
  it('GraphQL 查询要 issue body 字段', async () => {
    const S = await LOAD;
    assert.match(S.GITHUB_GRAPHQL, /issues\([\s\S]*?\bbody\b/);
  });

  it('节点有 body → 原样留下；没这个键 → 结果上也没有（缺键不是空串）', async () => {
    const S = await LOAD;
    const withBody = S.normalizeGithubGraphql({
      repository: {
        issues: { nodes: [{ number: 1, title: '有正文', body: '改协作约定', labels: { nodes: [] } }] },
        pullRequests: { nodes: [] },
      },
    });
    assert.equal(withBody.ok, true);
    assert.equal(withBody.issues[0].body, '改协作约定');
    const missing = S.normalizeGithubGraphql({
      repository: {
        issues: { nodes: [{ number: 2, title: '没正文键', labels: { nodes: [] } }] },
        pullRequests: { nodes: [] },
      },
    });
    assert.equal(missing.ok, true);
    assert.equal(Object.prototype.hasOwnProperty.call(missing.issues[0], 'body'), false);
    const empty = S.normalizeGithubGraphql({
      repository: {
        issues: { nodes: [{ number: 3, title: '空正文', body: null, labels: { nodes: [] } }] },
        pullRequests: { nodes: [] },
      },
    });
    assert.equal(empty.issues[0].body, '');
  });
});
