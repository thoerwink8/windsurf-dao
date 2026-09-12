// tests/pr-label-truth.test.js —— #1116：真相源 = PR 自己的 label
//
// 用户 2026-09-07 拍板删掉「从 issue 标签反推派工决定」这一层。
// 决定在 dispatch 写一次（model + reviewer + branch）；消费方按 PR head 分支打标，
// 之后只读 PR label。读不到就拒，不回退去读 issue、不猜家族。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WD = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'worker-done.mjs').replace(/\\/g, '/'));
const CARD = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'card.mjs').replace(/\\/g, '/'));
const ROOT = path.join(__dirname, '..');
const REPO = 'thoerwink8/windsurf-dao';
const OTHER = 'acme/other-dao';

function ghLog() {
  const calls = [];
  const runGh = (args) => {
    calls.push(args.slice());
    return { ok: true, out: '{}' };
  };
  return { calls, runGh };
}

describe('pickWorkerDispatchByBranch', () => {
  it('按仓+分支精确命中工人 dispatch，带 reviewer', async () => {
    const { pickWorkerDispatchByBranch } = await WD;
    const events = [
      { type: 'job.dispatch', identity: '审官', branch: 'dao-1116', repo: REPO, model: 'gpt-5.6-luna', reviewer: 'x' },
      { type: 'job.dispatch', identity: '工人', branch: 'dao-other', repo: REPO, model: 'kimi-k3', reviewer: 'x' },
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1116', repo: REPO, model: 'grok-4.6', reviewer: 'gpt-5.6-luna', work_type: '写码' },
    ];
    const got = pickWorkerDispatchByBranch(events, 'dao-1116', REPO);
    assert.equal(got.ok, true);
    assert.equal(got.model, 'grok-4.6');
    assert.equal(got.reviewer, 'gpt-5.6-luna');
  });

  it('查不到 → 需人工打标，不猜', async () => {
    const { pickWorkerDispatchByBranch } = await WD;
    const none = pickWorkerDispatchByBranch([], 'hand-opened', REPO);
    assert.equal(none.ok, false);
    assert.equal(none.state, 'none');
    assert.match(none.error, /需人工打标/);
    const unscanned = pickWorkerDispatchByBranch(null, 'dao-1', REPO);
    assert.equal(unscanned.state, 'unscanned');
    const noRepo = pickWorkerDispatchByBranch([], 'dao-1');
    assert.equal(noRepo.ok, false);
    assert.equal(noRepo.state, 'unscanned');
    assert.match(noRepo.error, /没给仓/);
  });

  it('缺 reviewer 的工人 dispatch 不当成功', async () => {
    const { pickWorkerDispatchByBranch } = await WD;
    const got = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1116', repo: REPO, model: 'grok-4.6', work_type: '写码' },
    ], 'dao-1116', REPO);
    assert.equal(got.ok, false);
    assert.equal(got.state, 'none');
    assert.match(got.error, /缺 model 或 reviewer/);
    assert.match(got.error, /需人工打标/);
  });

  it('缺 identity 或非法身份不当成工人事件', async () => {
    const { pickWorkerDispatchByBranch } = await WD;
    const missing = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', branch: 'dao-1116', repo: REPO, model: 'grok-4.6', reviewer: 'gpt-5.6-luna' },
    ], 'dao-1116', REPO);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /缺 identity 或不是工人/);
    assert.match(missing.error, /需人工打标/);
    const broken = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', identity: '审官', branch: 'dao-1116', repo: REPO, model: 'wrong', reviewer: 'wrong' },
      { type: 'job.dispatch', identity: '协调者', branch: 'dao-1116', repo: REPO, model: 'also-wrong', reviewer: 'also-wrong' },
    ], 'dao-1116', REPO);
    assert.equal(broken.ok, false);
    const mixed = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', branch: 'dao-1116', repo: REPO, model: 'wrong', reviewer: 'wrong' },
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1116', repo: REPO, model: 'grok-4.6', reviewer: 'gpt-5.6-luna' },
    ], 'dao-1116', REPO);
    assert.equal(mixed.ok, true);
    assert.equal(mixed.model, 'grok-4.6');
    const laterBroken = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1116', repo: REPO, model: 'grok-4.6', reviewer: 'gpt-5.6-luna' },
      { type: 'job.dispatch', branch: 'dao-1116', repo: REPO, model: 'wrong', reviewer: 'wrong' },
    ], 'dao-1116', REPO);
    assert.equal(laterBroken.ok, false);
    assert.match(laterBroken.error, /缺 identity 或不是工人/);
    assert.match(laterBroken.error, /需人工打标/);
  });

  it('后写残缺工人记录不得回退旧的完整记录', async () => {
    const { pickWorkerDispatchByBranch } = await WD;
    const got = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: 'acme/repo', model: 'old-complete', reviewer: 'old-reviewer' },
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: 'acme/repo', model: 'new-incomplete' },
    ], 'dao-1', 'acme/repo');
    assert.equal(got.ok, false);
    assert.match(got.error, /缺 model 或 reviewer/);
    assert.match(got.error, /需人工打标/);
  });

  it('后写缺 repo 不得回退旧的完整记录', async () => {
    const { pickWorkerDispatchByBranch } = await WD;
    const got = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', identity: '工人', branch: 'b', repo: 'acme/repo', model: 'old', reviewer: 'old-r' },
      { type: 'job.dispatch', identity: '工人', branch: 'b', model: 'new', reviewer: 'new-r' },
    ], 'b', 'acme/repo');
    assert.equal(got.ok, false);
    assert.equal(got.model, undefined);
    assert.match(got.error, /缺 repo/);
    assert.match(got.error, /需人工打标/);
  });

  it('跨仓同名分支不套另一仓的 dispatch', async () => {
    const { pickWorkerDispatchByBranch } = await WD;
    const events = [
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1116', repo: REPO, model: 'grok-4.6', reviewer: 'gpt-5.6-luna' },
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1116', repo: OTHER, model: 'kimi-k3', reviewer: 'gpt-5.6-sol' },
    ];
    const here = pickWorkerDispatchByBranch(events, 'dao-1116', REPO);
    assert.equal(here.ok, true);
    assert.equal(here.model, 'grok-4.6');
    assert.equal(here.reviewer, 'gpt-5.6-luna');
    const there = pickWorkerDispatchByBranch(events, 'dao-1116', OTHER);
    assert.equal(there.ok, true);
    assert.equal(there.model, 'kimi-k3');
    const laterOther = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: REPO, model: 'a', reviewer: 'r1' },
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: OTHER, model: 'b', reviewer: 'r2' },
    ], 'dao-1', REPO);
    assert.equal(laterOther.ok, true);
    assert.equal(laterOther.model, 'a');
    const noRepoOnEvent = pickWorkerDispatchByBranch([
      { type: 'job.dispatch', identity: '工人', branch: 'dao-1', model: 'a', reviewer: 'r1' },
    ], 'dao-1', REPO);
    assert.equal(noRepoOnEvent.ok, false);
    assert.match(noRepoOnEvent.error, /需人工打标/);
  });
});

describe('stampPrLabelsFromDispatch', () => {
  it('按 head 分支打 model/* reviewer/*，gh 序列没有 issue view', async () => {
    const { stampPrLabelsFromDispatch } = await WD;
    const { ensureRepoLabels } = await CARD;
    const calls = [];
    const runGh = (args) => {
      calls.push(args.slice());
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          ok: true,
          out: JSON.stringify({
            title: 'x', body: '署名 issue #1116', labels: [], headRefName: 'dao-1116',
          }),
        };
      }
      if (args[0] === 'label' && args[1] === 'list') {
        return { ok: true, out: JSON.stringify([{ name: 'model/grok-4.6' }, { name: 'type/写码' }, { name: 'reviewer/gpt-5.6-luna' }]) };
      }
      if (args[0] === 'pr' && args[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: '未预期 ' + args.join(' ') };
    };
    const r = stampPrLabelsFromDispatch({
      pr: '1118',
      runGh,
      repo: REPO,
      events: [{
        type: 'job.dispatch', identity: '工人', branch: 'dao-1116', repo: REPO,
        model: 'grok-4.6', reviewer: 'gpt-5.6-luna', work_type: '写码',
      }],
      ensureLabels: ensureRepoLabels,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.labels.includes('model/grok-4.6'));
    assert.ok(r.labels.includes('reviewer/gpt-5.6-luna'));
    assert.equal(calls.some((a) => a[0] === 'pr' && a[1] === 'edit'), true);
    assert.equal(calls.some((a) => a.includes('model/grok-4.6')), true);
    assert.ok(!calls.some((a) => a[0] === 'issue'), JSON.stringify(calls));
  });

  it('已有同名 label 幂等，不再 edit', async () => {
    const { stampPrLabelsFromDispatch } = await WD;
    const calls = [];
    const runGh = (args) => {
      calls.push(args.slice());
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          ok: true,
          out: JSON.stringify({
            title: 'x', body: '署名 issue #1',
            labels: [{ name: 'model/grok-4.6' }, { name: 'type/写码' }, { name: 'reviewer/gpt-5.6-luna' }],
            headRefName: 'dao-1',
          }),
        };
      }
      return { ok: false, error: '未预期 ' + args.join(' ') };
    };
    const r = stampPrLabelsFromDispatch({
      pr: '1',
      runGh,
      repo: REPO,
      events: [{ type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: REPO, model: 'grok-4.6', reviewer: 'gpt-5.6-luna' }],
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.add, []);
    assert.ok(!calls.some((a) => a[1] === 'edit'));
  });

  it('判别力：把打标事件拿掉，起审官当场红', async () => {
    const { stampPrLabelsFromDispatch, resolveReviewerFromPr, resolveWorkerFromPr } = await WD;
    const runGh = (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          ok: true,
          out: JSON.stringify({
            title: '[cc] 手开', body: '署名 issue #1070', labels: [], headRefName: 'hand-1070',
          }),
        };
      }
      throw new Error('未预期 ' + args.join(' '));
    };
    const stamped = stampPrLabelsFromDispatch({ pr: '1070', runGh, events: [], repo: REPO });
    assert.equal(stamped.ok, false);
    assert.match(stamped.error, /需人工打标/);
    const rev = resolveReviewerFromPr({ pr: '1070', runGh });
    assert.equal(rev.ok, false);
    assert.match(rev.error, /需人工打标/);
    const worker = resolveWorkerFromPr({ pr: '1070', runGh });
    assert.equal(worker.ok, false);
    assert.match(worker.error, /需人工打标/);
  });

  it('缺 reviewer 打标 fail-visible，不许 ok:true 只留下 model/type', async () => {
    const { stampPrLabelsFromDispatch } = await WD;
    const calls = [];
    const runGh = (args) => {
      calls.push(args.slice());
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          ok: true,
          out: JSON.stringify({ title: 'x', body: '署名 issue #1', labels: [], headRefName: 'dao-1' }),
        };
      }
      if (args[0] === 'pr' && args[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: '未预期 ' + args.join(' ') };
    };
    const r = stampPrLabelsFromDispatch({
      pr: '1',
      runGh,
      repo: REPO,
      events: [{ type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: REPO, model: 'grok-4.6', work_type: '写码' }],
    });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /需人工打标/);
    assert.ok(!calls.some((a) => a[1] === 'edit'), JSON.stringify(calls));
  });

  it('跨仓同名分支：后写的另一仓 dispatch 不给本仓 PR 打标', async () => {
    const { stampPrLabelsFromDispatch } = await WD;
    const { ensureRepoLabels } = await CARD;
    const calls = [];
    const runGh = (args) => {
      calls.push(args.slice());
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          ok: true,
          out: JSON.stringify({ title: 'x', body: '署名 issue #2', labels: [], headRefName: 'dao-1' }),
        };
      }
      if (args[0] === 'label' && args[1] === 'list') {
        return { ok: true, out: JSON.stringify([{ name: 'model/grok-4.6' }, { name: 'type/写码' }, { name: 'reviewer/gpt-5.6-luna' }]) };
      }
      if (args[0] === 'pr' && args[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: '未预期 ' + args.join(' ') };
    };
    const r = stampPrLabelsFromDispatch({
      pr: '2',
      runGh,
      repo: REPO,
      ensureLabels: ensureRepoLabels,
      events: [
        { type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: REPO, model: 'grok-4.6', reviewer: 'gpt-5.6-luna' },
        { type: 'job.dispatch', identity: '工人', branch: 'dao-1', repo: OTHER, model: 'kimi-k3', reviewer: 'gpt-5.6-sol' },
      ],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.model, 'grok-4.6');
    assert.equal(r.reviewer, 'gpt-5.6-luna');
    assert.ok(r.labels.includes('model/grok-4.6'));
    assert.ok(r.labels.includes('reviewer/gpt-5.6-luna'));
    assert.ok(!r.labels.includes('model/kimi-k3'));
  });
});

describe('选型路径零残留', () => {
  it('四处删除在仓内 grep 零命中（生产代码）', () => {
    const banned = [
      'collectIssueLabelsFromPr',
      'vendorFamilyFromHostPrefix',
      'HOST_PREFIX_VENDOR_FAMILY',
      'function uniqueNames',
    ];
    const hits = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git') continue;
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.(mjs|js|md)$/.test(name) && !name.includes('CHANGELOG')) {
          const text = fs.readFileSync(p, 'utf8');
          for (const needle of banned) {
            if (text.includes(needle) && !p.includes(`${path.sep}tests${path.sep}`)) {
              hits.push(`${p}: ${needle}`);
            }
          }
        }
      }
    };
    walk(path.join(ROOT, 'scripts'));
    walk(path.join(ROOT, 'host'));
    assert.deepEqual(hits, [], hits.join('\n'));
  });

  it('ready-queue-check 的 linkedIssueNumbers 是 re-export，不是第二份正则', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'ready-queue-check.mjs'), 'utf8');
    assert.match(src, /import \{ linkedIssueNumbers \} from '\.\/dispatch\/worker-done\.mjs'/);
    assert.doesNotMatch(src, /const CLOSES_RE/);
    assert.doesNotMatch(src, /export function linkedIssueNumbers/);
  });

  it('job.dispatch schema 有 reviewer 与 branch 与 repo', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'events.schema.json'), 'utf8'));
    const variants = schema.oneOf || schema.anyOf || [];
    const job = variants.find((x) => x.title === 'job.dispatch');
    assert.ok(job, 'schema 缺 job.dispatch');
    const props = job.allOf[1].properties;
    assert.ok(props.reviewer, 'schema 缺 reviewer');
    assert.ok(props.branch, 'schema 缺 branch');
    assert.ok(props.repo, 'schema 缺 repo');
  });

  it('mirasim 派工写口带 reviewer + branch + repo', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'dao.mjs'), 'utf8');
    const fn = src.slice(src.indexOf('async function cmdDispatchMirasim'), src.indexOf('async function cmdDispatch(args)'));
    assert.match(fn, /reviewer: args\.reviewer/);
    assert.match(fn, /branch,/);
    assert.match(fn, /repo: resolveDispatchRepo\(ghRepo\)/);
  });
});

function lastJson(r) {
  try { return JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); }
  catch { return { raw: r.stdout, err: r.stderr }; }
}

function cliWithGhLog(verb, pr) {
  const log = path.join(os.tmpdir(), `dao-1116-gh-${verb}-${pr}-${process.pid}-${Date.now()}.log`);
  try { fs.unlinkSync(log); } catch { /* 没有就没有 */ }
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'dao.mjs'),
    verb, '--pr', String(pr), '--executor', 'mirasim', '--dry-run',
  ], {
    encoding: 'utf8',
    cwd: ROOT,
    env: {
      ...process.env,
      DAO_GH_FAKE: path.join(ROOT, 'tests', 'fixtures', 'fake-gh.mjs'),
      DAO_GH_FAKE_LOG: log,
      DAO_GH_FAKE_REFUSE_ISSUE_VIEW: '1',
    },
  });
  const logText = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  try { fs.unlinkSync(log); } catch { /* 测完收 */ }
  return { r, logText, payload: lastJson(r) };
}

describe('CLI 选型入口一次 issue label 都不读', () => {
  it('reviewer-create --pr 42：成功且 gh 序列没有 issue view', () => {
    const { r, logText, payload } = cliWithGhLog('reviewer-create', 42);
    assert.equal(r.status, 0, JSON.stringify({ payload, stderr: r.stderr, logText }));
    assert.equal(payload.ok, true);
    assert.equal(payload.reviewer, 'gpt-5.6-luna');
    assert.match(logText, /pr view/);
    assert.doesNotMatch(logText, /issue view/);
  });

  it('worker-done --pr 42：成功且 gh 序列没有 issue view', () => {
    const { r, logText, payload } = cliWithGhLog('worker-done', 42);
    assert.equal(r.status, 0, JSON.stringify({ payload, stderr: r.stderr, logText }));
    assert.equal(payload.ok, true);
    assert.equal(payload.reviewer, 'gpt-5.6-luna');
    assert.match(logText, /pr view/);
    assert.doesNotMatch(logText, /issue view/);
  });

  it('reviewer-create 手开无标 PR → 拒，话面需人工打标', () => {
    const { r, logText, payload } = cliWithGhLog('reviewer-create', 41);
    assert.notEqual(r.status, 0, JSON.stringify({ payload, stderr: r.stderr }));
    assert.match(String(payload.error || r.stderr || ''), /需人工打标/);
    assert.doesNotMatch(logText, /issue view/);
  });
});
