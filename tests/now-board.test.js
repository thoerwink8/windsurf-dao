// `dao now` 的判官测试。头等大事是**「没查成」与「没有」分得开**，而且没查成
// 绝不许被显示成一切正常——这条是本仓反复实咬的那条（2026-09-04 又栽一次：
// 审官零审查被当成「审官坏了」，实际是从没起过）。
//
// 正反样本覆盖：过期票（红/绿/oid 缺失三态）、审官树 head 不一致、审官登记缺失、
// 会话在/不在/没查成、issue 缺「已消歧」、每一路源没查成、空盘面（真没有）、
// 冲突、分支发散、整屏行数上限、以及取数层三个解析纯函数。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const BOARD = path.join(REPO, 'scripts', 'lib', 'now-board.mjs');
const COLLECT = path.join(REPO, 'scripts', 'lib', 'now-collect.mjs');
const load = p => import('file://' + p.replace(/\\/g, '/'));

const NOW = new Date('2026-09-04T16:00:00Z');
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const okEnv = items => ({ scanned: true, items });
const deadEnv = why => ({ scanned: false, error: why });

function prFixture(over = {}) {
  return {
    number: 900, title: '一张在途 PR', isDraft: false, reviewDecision: '',
    headRefOid: HEAD, headRefName: 'feat/x', mergeable: 'MERGEABLE',
    updatedAt: '2026-09-04T15:00:00Z', ...over,
  };
}
function review(state, commitOid, at = '2026-09-04T14:00:00Z') {
  return { author: 'dao-reviewer[bot]', state, submittedAt: at, commitOid };
}
function registry(over = {}) {
  return {
    pr: '900', sessionKey: 'codex:11111111-2222-3333-4444-555555555555', agent: 'codex',
    treePath: '/home/orca/mirasim-worktrees/windsurf-dao/dao-review-pr-900',
    round: 'first', headRefName: 'feat/x', expectedOid: HEAD, ts: 1788536760108,
    treeHead: { scanned: true, oid: HEAD }, ...over,
  };
}
/** 一盘全绿好数据，各例只改自己关心的那一格。 */
function board(S, over = {}) {
  return S.renderNow({
    now: NOW,
    prs: okEnv([prFixture()]),
    reviews: { byPr: { 900: okEnv([review('APPROVED', HEAD)]) } },
    merged: { prs: okEnv([]), commits: okEnv([]) },
    issues: okEnv([]),
    registries: okEnv([registry()]),
    worktrees: okEnv([]),
    sessions: okEnv([{ pid: '1', cwd: '/home/orca/mirasim-worktrees/windsurf-dao/dao-review-pr-900' }]),
    ...over,
  });
}

describe('dao now：三态判官', () => {
  it('tri 三态分得开：没查成 / 真没有 / 有货（合并这三态是本仓头号实咬）', async () => {
    const S = await load(BOARD);
    assert.equal(S.tri({ scanned: false, error: 'ssh 连不上' }).state, 'unscanned');
    assert.equal(S.tri(undefined).state, 'unscanned', '源根本没给 = 没查成');
    assert.equal(S.tri({ scanned: true }).state, 'unscanned', '说查成了却没给数组 = 契约不符，按没查成算');
    assert.equal(S.tri({ scanned: true, items: [] }).state, 'empty', '查过了确实没有 = empty');
    assert.equal(S.tri({ scanned: true, items: [1] }).state, 'ok');
  });

  it('sectionState：主源没查成→unscanned；有缺源但没条目→partial（不是 empty）', async () => {
    const S = await load(BOARD);
    assert.equal(S.sectionState({ primaryUnscanned: true, itemCount: 0, gapCount: 1 }), 'unscanned');
    assert.equal(S.sectionState({ primaryUnscanned: false, itemCount: 0, gapCount: 1 }), 'partial');
    assert.equal(S.sectionState({ primaryUnscanned: false, itemCount: 0, gapCount: 0 }), 'empty');
    assert.equal(S.sectionState({ primaryUnscanned: false, itemCount: 2, gapCount: 0 }), 'ok');
  });
});

describe('dao now：判定票与过期票', () => {
  it('review 没查成 ≠ 无审查（两种处置相反：一个要查、一个要催审）', async () => {
    const S = await load(BOARD);
    const un = S.judgeBallots({ reviews: deadEnv('gh api 超时'), headRefOid: HEAD });
    assert.equal(un.state, 'unscanned');
    assert.match(un.why, /超时/);
    const none = S.judgeBallots({ reviews: okEnv([]), headRefOid: HEAD });
    assert.equal(none.state, 'none', '查成了一张判别票都没有 = 从没审过');
    assert.equal(none.why, null);
  });

  it('只有 COMMENTED 也算「无审查」（评论不是判定）', async () => {
    const S = await load(BOARD);
    const r = S.judgeBallots({ reviews: okEnv([review('COMMENTED', HEAD)]), headRefOid: HEAD });
    assert.equal(r.state, 'none');
  });

  it('过期票：红票投在旧 commit 上 → stale（返工已推、没人复审）', async () => {
    const S = await load(BOARD);
    const r = S.judgeBallots({ reviews: okEnv([review('CHANGES_REQUESTED', OLD)]), headRefOid: HEAD });
    assert.equal(r.state, 'CHANGES_REQUESTED');
    assert.equal(r.stale, true);
    assert.equal(r.staleUnknown, false);
  });

  it('绿票投在旧 commit 上 → stale（这张绿不作数）', async () => {
    const S = await load(BOARD);
    const r = S.judgeBallots({ reviews: okEnv([review('APPROVED', OLD)]), headRefOid: HEAD });
    assert.equal(r.stale, true);
  });

  it('票投在当前 head 上 → 不过期；commit oid 缺失 → staleUnknown（不许当没过期）', async () => {
    const S = await load(BOARD);
    const fresh = S.judgeBallots({ reviews: okEnv([review('APPROVED', HEAD)]), headRefOid: HEAD });
    assert.equal(fresh.stale, false);
    assert.equal(fresh.staleUnknown, false);
    const blind = S.judgeBallots({ reviews: okEnv([review('APPROVED', null)]), headRefOid: HEAD });
    assert.equal(blind.stale, false);
    assert.equal(blind.staleUnknown, true, 'oid 读不到 = 判不出过期与否');
  });

  it('多轮票取最后一张判别票（红后再绿 = 绿）', async () => {
    const S = await load(BOARD);
    const r = S.judgeBallots({
      reviews: okEnv([
        review('CHANGES_REQUESTED', OLD, '2026-09-04T10:00:00Z'),
        review('APPROVED', HEAD, '2026-09-04T15:00:00Z'),
      ]),
      headRefOid: HEAD,
    });
    assert.equal(r.state, 'APPROVED');
    assert.equal(r.stale, false);
    assert.equal(r.staleCount, 1, '早先那张红票是过期票，计数里要看得见');
  });
});

describe('dao now：审官登记 / 会话 / 树', () => {
  it('审官登记扫不到 = 没查成（落点跟着执行树跑，找不到不构成「没有审官」）', async () => {
    const S = await load(BOARD);
    const miss = S.pickRegistry({ registries: okEnv([]), pr: '900' });
    assert.equal(miss.found, false);
    assert.equal(miss.unscanned, true, '扫完没有也只能算没查成');
    assert.match(miss.why, /没查成/);
    const dead = S.pickRegistry({ registries: deadEnv('ssh 连不上'), pr: '900' });
    assert.equal(dead.unscanned, true);
    assert.match(dead.why, /ssh 连不上/);
    const hit = S.pickRegistry({ registries: okEnv([registry()]), pr: '900' });
    assert.equal(hit.found, true);
    assert.equal(hit.unscanned, false);
  });

  it('同一 PR 多份登记取 ts 最大的那份（换轮重起会各写一份）', async () => {
    const S = await load(BOARD);
    const hit = S.pickRegistry({
      registries: okEnv([registry({ round: 'first', ts: 1 }), registry({ round: 'rework', ts: 9 })]),
      pr: '900',
    });
    assert.equal(hit.item.round, 'rework');
  });

  it('会话在/不在/没查成三分（判据是进程 cwd == 登记 treePath）', async () => {
    const S = await load(BOARD);
    const tree = '/home/orca/mirasim-worktrees/windsurf-dao/dao-review-pr-900';
    assert.equal(S.judgeSession({ sessions: okEnv([{ pid: '1', cwd: tree }]), treePath: tree }).state, 'live');
    assert.equal(S.judgeSession({ sessions: okEnv([]), treePath: tree }).state, 'gone');
    assert.equal(S.judgeSession({ sessions: deadEnv('连不上'), treePath: tree }).state, 'unscanned');
    assert.equal(S.judgeSession({ sessions: okEnv([]), treePath: null }).state, 'unscanned',
      '没有树路径就对不上号，只能算没查成');
  });

  it('审官树 head：一致 / 落后 / 读不到（读不到不许当一致）', async () => {
    const S = await load(BOARD);
    assert.equal(S.judgeTreeHead({ treeHead: { scanned: true, oid: HEAD }, headRefOid: HEAD }).state, 'same');
    const behind = S.judgeTreeHead({ treeHead: { scanned: true, oid: OLD }, headRefOid: HEAD });
    assert.equal(behind.state, 'behind');
    assert.match(behind.why, /审官树停在/);
    assert.equal(S.judgeTreeHead({ treeHead: { scanned: false, error: 'dubious ownership' }, headRefOid: HEAD }).state, 'unscanned');
    assert.equal(S.judgeTreeHead({ treeHead: { scanned: true, oid: HEAD }, headRefOid: null }).state, 'unscanned');
  });

  it('本机工人：按分支对树；工人树没查成不许当「没有工人」', async () => {
    const S = await load(BOARD);
    const wts = okEnv([{ path: 'D:/frank/wd-x', branch: 'feat/x' }, { path: 'D:/frank/wd-y', branch: 'feat/y' }]);
    assert.deepEqual(S.judgeWorker({ worktrees: wts, headRefName: 'feat/x' }).paths, ['D:/frank/wd-x']);
    assert.equal(S.judgeWorker({ worktrees: wts, headRefName: 'feat/z' }).state, 'none');
    assert.equal(S.judgeWorker({ worktrees: deadEnv('git 跑不了'), headRefName: 'feat/x' }).state, 'unscanned');
  });
});

describe('dao now：一张 PR 要不要你拍', () => {
  it('红票已过期 → 返工待复审进「待你拍」', async () => {
    const S = await load(BOARD);
    const row = S.assessPr({
      pr: prFixture(), reviews: okEnv([review('CHANGES_REQUESTED', OLD)]),
      registries: okEnv([registry()]), sessions: okEnv([]), worktrees: okEnv([]),
    });
    assert.ok(row.needs.some(n => n.kind === 'rework-awaiting-recheck'), JSON.stringify(row.needs));
  });

  it('零审查 + 审官登记找不到 → reviewer-unknown（用户这次撞到的那一格）', async () => {
    const S = await load(BOARD);
    const row = S.assessPr({
      pr: prFixture(), reviews: okEnv([]),
      registries: okEnv([]), sessions: okEnv([]), worktrees: okEnv([]),
    });
    const need = row.needs.find(n => n.kind === 'reviewer-unknown');
    assert.ok(need, JSON.stringify(row.needs));
    assert.match(need.why, /起没起都没查成/, '不许把「查不到」说成「审官坏了」');
  });

  it('零审查 + 登记在但树上没进程 → reviewer-down（起过又没了，处置不同）', async () => {
    const S = await load(BOARD);
    const row = S.assessPr({
      pr: prFixture(), reviews: okEnv([]),
      registries: okEnv([registry()]), sessions: okEnv([]), worktrees: okEnv([]),
    });
    assert.ok(row.needs.some(n => n.kind === 'reviewer-down'), JSON.stringify(row.needs));
  });

  it('零审查 + 会话源没查成 → reviewer-session-unknown（与上一条分开形）', async () => {
    const S = await load(BOARD);
    const row = S.assessPr({
      pr: prFixture(), reviews: okEnv([]),
      registries: okEnv([registry()]), sessions: deadEnv('连不上服务器'), worktrees: okEnv([]),
    });
    assert.ok(row.needs.some(n => n.kind === 'reviewer-session-unknown'), JSON.stringify(row.needs));
  });

  it('审官树落后 + 冲突 各自进「待你拍」；全绿当前代码 → 只剩「要不要合」', async () => {
    const S = await load(BOARD);
    const behind = S.assessPr({
      pr: prFixture({ mergeable: 'CONFLICTING' }), reviews: okEnv([review('CHANGES_REQUESTED', HEAD)]),
      registries: okEnv([registry({ treeHead: { scanned: true, oid: OLD } })]),
      sessions: okEnv([]), worktrees: okEnv([]),
    });
    const kinds = behind.needs.map(n => n.kind);
    assert.ok(kinds.includes('reviewer-tree-behind'), JSON.stringify(kinds));
    assert.ok(kinds.includes('conflicting'), JSON.stringify(kinds));
    const green = S.assessPr({
      pr: prFixture(), reviews: okEnv([review('APPROVED', HEAD)]),
      registries: okEnv([registry()]), sessions: okEnv([]), worktrees: okEnv([]),
    });
    assert.deepEqual(green.needs.map(n => n.kind), ['green-awaiting-land']);
  });
});

describe('dao now：issue 与分支', () => {
  it('issue 四分：待拍板 / 待消歧 / 缺「已消歧」派不出去 / 已消歧不用你拍', async () => {
    const S = await load(BOARD);
    assert.equal(S.assessIssue({ number: 1, labels: ['待拍板'] }).kind, 'issue-awaiting-call');
    assert.equal(S.assessIssue({ number: 2, labels: [{ name: '待消歧' }] }).kind, 'issue-pending-disambiguation');
    assert.equal(S.assessIssue({ number: 3, labels: ['任务'] }).kind, 'issue-not-disambiguated');
    assert.equal(S.assessIssue({ number: 4, labels: ['已消歧'] }).kind, 'issue-ready');
  });

  it('labels 不是数组 = 没查成，绝不当「没有标签」（否则会错判成缺已消歧）', async () => {
    const S = await load(BOARD);
    const v = S.assessIssue({ number: 5, labels: null });
    assert.equal(v.kind, 'issue-labels-unscanned');
    assert.equal(v.unscanned, true);
  });

  it('分支：两头都有独占提交才算发散；track 没查成单列', async () => {
    const S = await load(BOARD);
    assert.equal(S.assessWorktree({ path: '/a', branch: 'b', ahead: 1, behind: 2, trackScanned: true }).kind, 'branch-diverged');
    assert.equal(S.assessWorktree({ path: '/a', branch: 'b', ahead: 3, behind: 0, trackScanned: true }), null);
    assert.equal(S.assessWorktree({ path: '/a', branch: 'b', trackScanned: false }).unscanned, true);
  });
});

describe('dao now：整盘与排版', () => {
  it('空盘面 = 真的没有（empty），排版说「没有」而不是「没查成」', async () => {
    const S = await load(BOARD);
    const b = S.renderNow({
      now: NOW,
      prs: okEnv([]), reviews: { byPr: {} }, merged: { prs: okEnv([]), commits: okEnv([]) },
      issues: okEnv([]), registries: okEnv([]), worktrees: okEnv([]), sessions: okEnv([]),
    });
    assert.equal(b.landed.state, 'empty');
    assert.equal(b.inflight.state, 'empty');
    assert.equal(b.decide.state, 'empty');
    assert.deepEqual(b.unscanned, [], '真空盘面不该有任何「没查成」');
    const text = S.formatNow(b);
    assert.match(text, /一张 open PR 都没有/);
    assert.match(text, /没有等你拍的事/);
    assert.doesNotMatch(text, /没查成/, '空盘面不许出现「没查成」字样');
  });

  it('源全挂 = 没查成：每段都说「等于没查」，一个字的「没有」都不许出现', async () => {
    const S = await load(BOARD);
    const b = S.renderNow({
      now: NOW,
      prs: deadEnv('gh 超时'), reviews: { byPr: null, error: 'PR 名单没查成' },
      merged: { prs: deadEnv('gh 超时'), commits: deadEnv('git 跑不了') },
      issues: deadEnv('gh 超时'), registries: deadEnv('ssh 连不上'),
      worktrees: deadEnv('git 跑不了'), sessions: deadEnv('ssh 连不上'),
    });
    assert.equal(b.landed.state, 'unscanned');
    assert.equal(b.inflight.state, 'unscanned');
    assert.equal(b.decide.state, 'unscanned');
    assert.ok(b.unscanned.length >= 5, JSON.stringify(b.unscanned));
    const text = S.formatNow(b);
    assert.doesNotMatch(text, /都没有|没有等你拍的事|一切正常/, '没查成绝不许显示成一切正常');
    assert.equal((text.match(/等于没查/g) || []).length, 3, '三段各说一次「等于没查」');
  });

  it('半挂：查成的部分没有 + 有源没查成 → partial，既不说「没有」也不吞掉缺源', async () => {
    const S = await load(BOARD);
    const b = S.renderNow({
      now: NOW,
      prs: okEnv([]), reviews: { byPr: {} },
      merged: { prs: okEnv([]), commits: deadEnv('git 跑不了') },
      issues: okEnv([]), registries: okEnv([]), worktrees: okEnv([]), sessions: deadEnv('ssh 连不上'),
    });
    assert.equal(b.landed.state, 'partial');
    const text = S.formatNow(b);
    assert.match(text, /查成的部分里没有/);
    assert.match(text, /没查成/);
  });

  it('一行里每格都分得开：判定/审官/会话/树/工人 各自的没查成不互相冒充', async () => {
    const S = await load(BOARD);
    const row = S.assessPr({
      pr: prFixture(), reviews: deadEnv('gh 超时'),
      registries: deadEnv('ssh 连不上'), sessions: deadEnv('ssh 连不上'), worktrees: deadEnv('git 跑不了'),
    });
    const line = S.formatPrRow(row);
    assert.match(line, /判定没查成/);
    assert.match(line, /审官没查成/);
    assert.match(line, /会话没查成/);
    assert.match(line, /树没查成/);
    assert.match(line, /工人没查成/);
  });

  it('默认不超过一屏：40 张 PR + 40 张 issue 也要折叠成计数 + 用 --json 看全部', async () => {
    const S = await load(BOARD);
    const prs = [];
    const byPr = {};
    for (let i = 0; i < 40; i++) {
      const n = 800 + i;
      prs.push(prFixture({ number: n, headRefName: `feat/${n}` }));
      byPr[n] = okEnv([review('CHANGES_REQUESTED', OLD)]);
    }
    const issues = [];
    for (let i = 0; i < 40; i++) issues.push({ number: 700 + i, title: 't', labels: ['任务'] });
    const b = S.renderNow({
      now: NOW, prs: okEnv(prs), reviews: { byPr },
      merged: { prs: okEnv([]), commits: okEnv([]) },
      issues: okEnv(issues), registries: okEnv([]), worktrees: okEnv([]), sessions: okEnv([]),
    });
    const lines = S.formatNow(b).split('\n');
    assert.ok(lines.length <= S.DEFAULT_MAX_LINES, `一屏 = ${S.DEFAULT_MAX_LINES} 行，实际 ${lines.length}`);
    assert.ok(lines.some(l => /--json 看全部/.test(l)), '折叠必须留出口');
    assert.ok(lines.some(l => /没查成/.test(l)), '折叠不许把「没查成」挤掉');
  });

  it('已落地：窗口外的不算；squash 提交与它那张 PR 不重复报', async () => {
    const S = await load(BOARD);
    const b = board(await load(BOARD), {
      merged: {
        prs: okEnv([
          { number: 901, title: '刚合的', mergedAt: '2026-09-04T15:30:00Z', mergeCommitOid: HEAD },
          { number: 700, title: '昨天合的', mergedAt: '2026-09-03T01:00:00Z', mergeCommitOid: OLD },
        ]),
        commits: okEnv([
          { sha: HEAD, at: '2026-09-04T15:30:00Z', subject: '刚合的 (#901)' },
          { sha: 'cccccccccccccccccccccccccccccccccccccccc', at: '2026-09-04T15:40:00Z', subject: '直推 master 的一条' },
        ]),
      },
    });
    const kinds = b.landed.items.map(i => `${i.kind}:${i.pr || i.sha}`);
    assert.deepEqual(kinds, ['commit:ccccccc', 'merged-pr:901'], JSON.stringify(b.landed.items));
    void S;
  });
});

describe('dao now：取数层的解析纯函数', () => {
  it('git worktree list --porcelain 解析出 path/branch/head', async () => {
    const C = await load(COLLECT);
    const items = C.parseWorktreePorcelain([
      'worktree D:/frank/windsurf-dao', 'HEAD abc123', 'branch refs/heads/master', '',
      'worktree D:/frank/wd-now', 'HEAD def456', 'branch refs/heads/feat/dao-now', '',
      'worktree D:/frank/wt-861', 'HEAD 999', 'detached', '',
    ].join('\n'));
    assert.equal(items.length, 3);
    assert.equal(items[1].branch, 'feat/dao-now');
    assert.equal(items[2].branch, null, 'detached 没有分支');
  });

  it('upstream track 解析：ahead/behind/gone/空', async () => {
    const C = await load(COLLECT);
    assert.deepEqual(C.parseTrack('[ahead 2, behind 1]'), { ahead: 2, behind: 1 });
    assert.deepEqual(C.parseTrack('[ahead 3]'), { ahead: 3, behind: 0 });
    assert.deepEqual(C.parseTrack('[gone]'), { ahead: 0, behind: 0 });
    assert.deepEqual(C.parseTrack(''), { ahead: 0, behind: 0 });
  });

  it('远端 TSV 解析：登记按 base64 还原、坏行单列、缺 END = 没跑完', async () => {
    const C = await load(COLLECT);
    const reg = { pr: '890', sessionKey: 'codex:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', treePath: '/t/890' };
    const b64 = Buffer.from(JSON.stringify(reg), 'utf8').toString('base64');
    const good = C.parseRemoteScan([
      'DIROK\t/home/orca/wt-unblock/_flow/mirasim',
      'DIRMISS\t/root/windsurf-dao/_flow/mirasim',
      `REG\t/home/orca/wt-unblock/_flow/mirasim/reviewer-890.json\t${b64}`,
      'REG\t/broken.json\tbm90LWpzb24=',
      'TREE\t/t/890\tabc',
      'PROC\t123\t/home/orca/mirasim-worktrees/windsurf-dao/dao-review-pr-890',
      'END',
    ].join('\n'));
    assert.equal(good.ended, true);
    assert.equal(good.regs.length, 1);
    assert.equal(good.regs[0].pr, '890');
    assert.equal(good.bad.length, 1, '坏文件单列，不当「没有」');
    assert.equal(good.trees.get('/t/890'), 'abc');
    assert.equal(good.procs.length, 1);
    assert.equal(good.dirsMissing.length, 1);
    const cut = C.parseRemoteScan('DIROK\t/x');
    assert.equal(cut.ended, false, '没收到 END = 扫描没跑完，调用方要按没查成算');
  });

  it('本机登记目录：不存在的目录记 missing，坏 JSON 记 bad，都不当「没有」', async () => {
    const C = await load(COLLECT);
    const r = C.readRegistryDirs(['/nope', '/ok'], {
      exists: p => p === '/ok',
      readdir: () => ['reviewer-1.json', 'reviewer-2.json', 'noise.txt'],
      readFile: p => (/reviewer-1/.test(p) ? '{"pr":"1","treePath":"/t/1"}' : '{坏'),
    });
    assert.equal(r.scanned, true);
    assert.deepEqual(r.dirsMissing, ['/nope']);
    assert.equal(r.items.length, 1);
    assert.equal(r.bad.length, 1);
  });
});
