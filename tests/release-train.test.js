// 发布列车（issue #800）：档位汇总 / 版本号复用 bump / 触发（阈值 5 + 周日） / CHANGELOG / 真 git e2e。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CORE = 'file://' + path.join(REPO, 'scripts', 'lib', 'release-train-core.mjs').replace(/\\/g, '/');
const CLI = path.join(REPO, 'scripts', 'release-train.mjs');
const LOAD = import(CORE);

function git(cwd, args, env) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
}

// 造一个真 git 临时仓：v0.1.0 tag + 若干 squash-merge 风格提交。
function makeRepo(commitSubjects) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-train-'));
  const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  git(dir, ['init', '-q', '-b', 'master']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'release-policy.json'), JSON.stringify({
    version: {
      bump_by_commit_type: { fix: 'patch', docs: 'patch', chore: 'patch', refactor: 'patch', perf: 'patch', feat: 'minor', 'feat!': 'major', 'BREAKING CHANGE': 'major' },
      train: { min_merged: 5, cadence: 'weekly', weekday: 'sunday' },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'seed.txt'), '0');
  git(dir, ['add', '.'], ID);
  git(dir, ['commit', '-q', '-m', 'chore: seed'], ID);
  git(dir, ['tag', '-a', 'v0.1.0', '-m', 'release v0.1.0'], ID);
  let n = 1;
  for (const s of commitSubjects) {
    fs.writeFileSync(path.join(dir, `f${n}.txt`), String(n));
    git(dir, ['add', '.'], ID);
    git(dir, ['commit', '-q', '-m', s], ID);
    n += 1;
  }
  return dir;
}

describe('release-train-core', () => {
  it('classifyTitles：feat→minor / fix→patch / breaking→major / 一个都没有→null', async (t) => {
    const { classifyTitles } = await LOAD;
    await t.test('含 feat → minor', () => {
      const r = classifyTitles(['[grok] feat: 加东西 (#1)', '[cc] fix: 修 (#2)']);
      assert.equal(r.level, 'minor');
      assert.equal(r.feats.length, 1);
      assert.equal(r.fixes.length, 1);
    });
    await t.test('只有 fix/docs/chore → patch', () => {
      const r = classifyTitles(['[cc] fix(policy): a', 'docs: b', 'chore: c']);
      assert.equal(r.level, 'patch');
      assert.equal(r.breaking.length, 0);
    });
    await t.test('feat! → major', () => {
      const r = classifyTitles(['[grok] feat!: 破坏 (#3)', 'fix: x']);
      assert.equal(r.level, 'major');
      assert.equal(r.breaking.length, 1);
    });
    await t.test('BREAKING CHANGE 文案 → major', () => {
      const r = classifyTitles(['chore: 重构 BREAKING CHANGE 删了老接口']);
      assert.equal(r.level, 'major');
    });
    await t.test('一个 conventional 类型都认不出 → null（不发）', () => {
      const r = classifyTitles(['[grok] 堵复审轮与终端错位五洞 (#815)', 'Merge pull request #1 from x/y']);
      assert.equal(r.level, null);
      assert.equal(r.others.length, 2);
    });
    await t.test('空列表 → null', () => {
      assert.equal(classifyTitles([]).level, null);
    });
  });

  it('nextVersion：复用 bump.mjs 语义，不抄第二份', async (t) => {
    const { nextVersion } = await LOAD;
    assert.equal(nextVersion('0.1.0', 'minor'), '0.2.0');
    assert.equal(nextVersion('0.1.0', 'patch'), '0.1.1');
    assert.equal(nextVersion('0.1.0', 'major'), '1.0.0');
    assert.equal(nextVersion('1.2.3', null), null);
    await t.test('current 非法 → error', () => {
      const r = nextVersion('nope', 'minor');
      assert.ok(r && r.error, JSON.stringify(r));
    });
  });

  it('shouldRelease：阈值 5 与周日两种触发；一个都没有不发；≥3 不到阈值不发', async (t) => {
    const { shouldRelease } = await LOAD;
    const sunday = new Date('2026-09-06T12:00:00Z');   // 周日
    const wed = new Date('2026-09-09T12:00:00Z');      // 周三
    const prevTue = new Date('2026-09-01T00:00:00Z');  // 上个周日之前
    const thisMon = new Date('2026-09-07T00:00:00Z');  // 本周日之后

    await t.test('攒够 5 个 → 发（周中、刚发过版也发）', () => {
      const r = shouldRelease({ now: wed, mergedSinceTag: 5, lastReleaseAt: thisMon, minMerged: 5, weekday: 0 });
      assert.ok(r.release, JSON.stringify(r));
      assert.ok(r.reasons.some((x) => /攒够/.test(x)), JSON.stringify(r));
    });
    await t.test('到周日、本周期没发过 → 发（哪怕只有 2 个）', () => {
      const r = shouldRelease({ now: sunday, mergedSinceTag: 2, lastReleaseAt: prevTue, minMerged: 5, weekday: 0 });
      assert.ok(r.release, JSON.stringify(r));
      assert.ok(r.reasons.some((x) => /发布日/.test(x)), JSON.stringify(r));
    });
    await t.test('合并 3 个、周中、本周期已发过 → 不发', () => {
      const r = shouldRelease({ now: wed, mergedSinceTag: 3, lastReleaseAt: thisMon, minMerged: 5, weekday: 0 });
      assert.equal(r.release, false, JSON.stringify(r));
    });
    await t.test('列车为空（0 个合并）→ 不发，哪怕是周日', () => {
      const r = shouldRelease({ now: sunday, mergedSinceTag: 0, lastReleaseAt: prevTue, minMerged: 5, weekday: 0 });
      assert.equal(r.release, false, JSON.stringify(r));
      assert.ok(/一个都没有/.test(r.reasons.join('')), JSON.stringify(r));
    });
    await t.test('周日但本周期已发过版 → 周日触发不重复', () => {
      const r = shouldRelease({ now: sunday, mergedSinceTag: 2, lastReleaseAt: sunday, minMerged: 5, weekday: 0 });
      assert.equal(r.release, false, JSON.stringify(r));
    });
    await t.test('maxWaitH 兜底（旧口径若配了仍认）', () => {
      const r = shouldRelease({ now: wed, mergedSinceTag: 1, lastReleaseAt: new Date('2026-09-07T00:00:00Z'), minMerged: 99, weekday: 3, maxWaitH: 24 });
      assert.ok(r.release, JSON.stringify(r));
    });
  });

  it('renderChangelog：分节、空节不渲染', async () => {
    const { renderChangelog } = await LOAD;
    const md = renderChangelog({
      version: '0.2.0', date: '2026-09-03',
      classification: { breaking: [], feats: ['feat: A (#1)'], fixes: ['fix: B (#2)'], others: [] },
    });
    assert.ok(md.includes('## v0.2.0 — 2026-09-03'), md);
    assert.ok(md.includes('### 新功能'), md);
    assert.ok(md.includes('- feat: A (#1)'), md);
    assert.ok(md.includes('### 修复与维护'), md);
    assert.ok(!md.includes('### 破坏性变更'), md);
  });
});

describe('release-train CLI（真 git 临时仓 e2e）', () => {
  it('造 3 个 feat 合并（低于阈值 5）：plan 不发版，release 拒发、不写盘', () => {
    const dir = makeRepo([
      '[grok] feat: 加卡片来源 (#901)',
      '[cc] feat(policy): 读真相源 (#902)',
      '[grok] fix: 修边界 (#903)',
    ]);
    try {
      const plan = spawnSync(process.execPath, [CLI, 'plan', '--repo', dir], { encoding: 'utf8', windowsHide: true });
      assert.equal(plan.status, 0, plan.stderr);
      const j = JSON.parse(plan.stdout);
      assert.equal(j.lastTag, 'v0.1.0', JSON.stringify(j));
      assert.equal(j.current, '0.1.0');
      assert.equal(j.mergedCount, 3);
      assert.equal(j.level, 'minor', JSON.stringify(j.classification));
      assert.equal(j.next, '0.2.0');
      assert.equal(j.nextTag, 'v0.2.0');
      assert.equal(j.shouldRelease.release, false, '3 个合并没到阈值 5，不该发：' + JSON.stringify(j.shouldRelease));

      // plan 不写任何东西：没有新 tag、没有 CHANGELOG
      const tagsAfterPlan = git(dir, ['tag', '--list']).stdout.trim().split(/\s+/);
      assert.deepEqual(tagsAfterPlan, ['v0.1.0']);
      assert.ok(!fs.existsSync(path.join(dir, 'CHANGELOG.md')));

      // fail-closed：未到发布点，release（非 dry-run）拒发、退非零、不打 tag、不写 CHANGELOG
      // ——这就是审官在 956f8a2 上做的判别性实验的自动化版本。
      const rel = spawnSync(process.execPath, [CLI, 'release', '--repo', dir], { encoding: 'utf8', windowsHide: true });
      assert.notEqual(rel.status, 0, '未到发布点 release 必须非零退出，实际 status=' + rel.status + ' out=' + rel.stdout);
      assert.ok(/未到发布点/.test(rel.stdout), rel.stdout);
      assert.deepEqual(git(dir, ['tag', '--list']).stdout.trim().split(/\s+/), ['v0.1.0'], '未到发布点不该打 tag');
      assert.ok(!fs.existsSync(path.join(dir, 'CHANGELOG.md')), '未到发布点不该写 CHANGELOG');

      // dry-run 也一样如实报「未到发布点，不发」、非零、不写盘
      const dry = spawnSync(process.execPath, [CLI, 'release', '--dry-run', '--repo', dir], { encoding: 'utf8', windowsHide: true });
      assert.notEqual(dry.status, 0, dry.stdout);
      assert.ok(/未到发布点/.test(dry.stdout), dry.stdout);
      assert.deepEqual(git(dir, ['tag', '--list']).stdout.trim().split(/\s+/), ['v0.1.0']);
      assert.ok(!fs.existsSync(path.join(dir, 'CHANGELOG.md')));

      // --force 才强发；--dry-run --force 预演出正确 tag，仍不写盘
      const forced = spawnSync(process.execPath, [CLI, 'release', '--dry-run', '--force', '--repo', dir], { encoding: 'utf8', windowsHide: true });
      assert.equal(forced.status, 0, forced.stderr);
      assert.ok(/v0\.2\.0/.test(forced.stdout), forced.stdout);
      assert.ok(/--force/.test(forced.stdout), forced.stdout);
      assert.deepEqual(git(dir, ['tag', '--list']).stdout.trim().split(/\s+/), ['v0.1.0'], '--dry-run --force 不该打 tag');
      assert.ok(!fs.existsSync(path.join(dir, 'CHANGELOG.md')), '--dry-run --force 不该写 CHANGELOG');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('到发布点（攒够 6 个合并）：release --dry-run 预演出正确 tag，非零仅在拒发时', () => {
    // 6 个合并（含 feat）≥ 阈值 5 → shouldRelease.release=true，dry-run 预演 v0.2.0
    const dir = makeRepo([
      '[grok] feat: a (#1)', '[cc] fix: b (#2)', '[grok] feat: c (#3)',
      '[cc] fix: d (#4)', '[grok] chore: e', '[cc] fix: f (#7)',
    ]);
    try {
      const plan = JSON.parse(spawnSync(process.execPath, [CLI, 'plan', '--repo', dir], { encoding: 'utf8', windowsHide: true }).stdout);
      assert.equal(plan.mergedCount, 6);
      assert.equal(plan.shouldRelease.release, true, JSON.stringify(plan.shouldRelease));
      const rel = spawnSync(process.execPath, [CLI, 'release', '--dry-run', '--repo', dir], { encoding: 'utf8', windowsHide: true });
      assert.equal(rel.status, 0, rel.stderr);
      assert.ok(/v0\.2\.0/.test(rel.stdout), rel.stdout);
      assert.ok(/拟/.test(rel.stdout), rel.stdout);
      assert.deepEqual(git(dir, ['tag', '--list']).stdout.trim().split(/\s+/), ['v0.1.0'], 'dry-run 不该打 tag');
      assert.ok(!fs.existsSync(path.join(dir, 'CHANGELOG.md')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should-run：3 个合并未到阈值 → 退非 0', () => {
    const dir = makeRepo(['[grok] feat: a (#1)', '[cc] fix: b (#2)', 'chore: c']);
    try {
      const r = spawnSync(process.execPath, [CLI, 'should-run', '--repo', dir], { encoding: 'utf8', windowsHide: true });
      // 周中运行时应非 0；若恰逢本周期未发过版的周日则为 0——两种都是合法态，断言退出码与话面一致
      const releasedByOutput = /^到发布点/.test(r.stdout.trim());
      assert.equal(r.status === 0, releasedByOutput, `退出码与话面不一致：status=${r.status} out=${r.stdout}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('install：幂等——连跑两遍单元文件不变、不重复', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-units-'));
    try {
      const run = () => spawnSync(process.execPath, [CLI, 'install', '--unit-dir', dir, '--user', 'orca', '--at', '04:00'], { encoding: 'utf8', windowsHide: true });
      const a = run();
      assert.equal(a.status, 0, a.stderr);
      const svc1 = fs.readFileSync(path.join(dir, 'release-train.service'), 'utf8');
      const tmr1 = fs.readFileSync(path.join(dir, 'release-train.timer'), 'utf8');
      const b = run();
      assert.equal(b.status, 0, b.stderr);
      const svc2 = fs.readFileSync(path.join(dir, 'release-train.service'), 'utf8');
      const tmr2 = fs.readFileSync(path.join(dir, 'release-train.timer'), 'utf8');
      assert.equal(svc1, svc2, 'service 第二遍应一字不差');
      assert.equal(tmr1, tmr2, 'timer 第二遍应一字不差');
      assert.ok(/已是最新/.test(b.stdout), '第二遍应报「已是最新」：' + b.stdout);
      assert.ok(/should-run && /.test(svc1) && /release/.test(svc1), svc1);
      assert.ok(/OnCalendar=\*-\*-\* 04:00:00/.test(tmr1), tmr1);
      assert.ok(/Persistent=true/.test(tmr1), tmr1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
