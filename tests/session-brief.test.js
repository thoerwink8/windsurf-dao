// 会话开场简报 + 清单退场闸（联动退出）判官（2026-09-08 拍板，见 docs/README.md）。
// 判别力铁律：故意违规样本必须被咬住；「没查成」与「查过没事」必须分得开。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('path');

const LIB = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'session-brief.mjs').replace(/\\/g, '/'));

describe('parseFrontmatter：计划文档头', () => {
  it('status + issues 都解出来', async () => {
    const { parseFrontmatter } = await LIB;
    const fm = parseFrontmatter('---\nstatus: in-progress\nissues: [1133, 1145]\n---\n正文');
    assert.equal(fm.status, 'in-progress');
    assert.deepEqual(fm.issues, [1133, 1145]);
  });
  it('没 frontmatter / 没这两个键 → null，不抛', async () => {
    const { parseFrontmatter } = await LIB;
    assert.equal(parseFrontmatter('# 普通判例文档\n正文'), null);
    assert.equal(parseFrontmatter('---\ntitle: x\n---\n正文'), null);
    assert.equal(parseFrontmatter(''), null);
    assert.equal(parseFrontmatter(null), null);
  });
  it('issues 里的脏值原样保留（滤掉会让退场闸当零目标绿）', async () => {
    const { parseFrontmatter } = await LIB;
    const fm = parseFrontmatter('---\nissues: [12, abc, -3, 0]\n---\n');
    assert.deepEqual(fm.issues, [12, 'abc', -3, 0]);
  });
});

describe('开场简报行', () => {
  it('active 西瓜一条一行，done/queued 不念', async () => {
    const { initiativeLines } = await LIB;
    const lines = initiativeLines({ initiatives: [
      { name: 'A', status: 'active', next_action: '干 X', next_action_as_of: '2026-09-08' },
      { name: 'B', status: 'done', next_action: 'x' },
      { name: 'C', status: 'queued', next_action: 'x' },
    ] });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[清单\] A：干 X（2026-09-08 写）/);
  });
  it('active 但没写 next_action → 念出来的是「答不出」，不是静默', async () => {
    const { initiativeLines } = await LIB;
    const lines = initiativeLines({ initiatives: [{ name: 'A', status: 'active' }] });
    assert.match(lines[0], /没写下一步/);
  });
  it('计划文档只念 in-progress，带挂钩单号', async () => {
    const { planDocLines } = await LIB;
    const lines = planDocLines([
      { file: 'docs/decisions/a.md', fm: { status: 'in-progress', issues: [7, 8] } },
      { file: 'docs/decisions/b.md', fm: { status: 'done' } },
      { file: 'docs/decisions/c.md', fm: null },
    ]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[计划\] docs\/decisions\/a\.md 未收口（挂 #7 #8）/);
  });
  it('单文件读失败 → 开场打没查成，不是静默', async () => {
    const { ingestPlanDocs, planDocLines, unreadPlanLines } = await LIB;
    const ingested = ingestPlanDocs([
      { file: 'docs/decisions/a.md', ok: true, text: '---\nstatus: in-progress\nissues: [7]\n---\n' },
      { file: 'docs/decisions/locked.md', ok: false, error: 'EACCES' },
    ]);
    const lines = [...planDocLines(ingested.entries), ...unreadPlanLines(ingested)];
    assert.equal(ingested.unscanned, true);
    assert.match(lines.find((l) => l.startsWith('[计划]')), /a\.md 未收口（挂 #7）/);
    assert.match(lines.find((l) => /没查成/.test(l)), /locked\.md/);
  });
});

describe('清单退场闸（联动退出）判官', () => {
  const targets = [
    { kind: 'initiative', name: 'x', issues: [11, 12] },
    { kind: 'plan', name: 'p.md', issues: [13] },
  ];
  it('collectExitTargets：只收 active/in-progress 且挂了 issues 的', async () => {
    const { collectExitTargets } = await LIB;
    const t = collectExitTargets({
      initiativesDoc: { initiatives: [
        { id: 'x', status: 'active', issues: [11] },
        { id: 'y', status: 'active' },
        { id: 'z', status: 'done', issues: [9] },
      ] },
      planDocs: [
        { file: 'a.md', fm: { status: 'in-progress', issues: [13] } },
        { file: 'b.md', fm: { status: 'in-progress' } },
        { file: 'c.md', fm: { status: 'done', issues: [14] } },
      ],
    });
    assert.deepEqual(t.map((e) => e.name), ['x', 'a.md']);
  });
  it('done_when 指向的 OPEN 统领单漏挂 issues 不得误报 stale', async () => {
    const { collectExitTargets, judgeListExit } = await LIB;
    // 复现 2026-09-16 实咬：scale-dozens 的 issues 只有已关前置单，统领 #1174 写在 done_when。
    const targets = collectExitTargets({
      initiativesDoc: { initiatives: [{
        id: 'scale-dozens',
        status: 'active',
        done_when: '统领 #1174 的 T1–T11 均有测试/部署/真实任务证据且已收口',
        issues: [1145, 1146, 1147, 1151, 1152],
      }] },
      planDocs: [],
    });
    assert.deepEqual(targets[0].issues, [1145, 1146, 1147, 1151, 1152, 1174]);
    const openUmbrella = judgeListExit({
      targets,
      states: {
        1145: 'CLOSED', 1146: 'CLOSED', 1147: 'CLOSED',
        1151: 'CLOSED', 1152: 'CLOSED', 1174: 'OPEN',
      },
    });
    assert.equal(openUmbrella.ok, true);
    assert.deepEqual(openUmbrella.stale, []);
    const allClosed = judgeListExit({
      targets,
      states: {
        1145: 'CLOSED', 1146: 'CLOSED', 1147: 'CLOSED',
        1151: 'CLOSED', 1152: 'CLOSED', 1174: 'CLOSED',
      },
    });
    assert.equal(allClosed.ok, false);
    assert.deepEqual(allClosed.stale.map((t) => t.name), ['scale-dozens']);
  });
  it('真实西瓜清单：active 条目 done_when 里的单号都在挂钩里', async () => {
    const { hookedIssues, issueRefsInText, collectExitTargets, judgeListExit } = await LIB;
    const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'initiatives.json'), 'utf8'));
    for (const i of doc.initiatives.filter((x) => x && x.status === 'active')) {
      const hooked = hookedIssues(i);
      for (const n of issueRefsInText(i.done_when)) {
        assert.ok(hooked.includes(n), `${i.id} 的 done_when #${n} 必须在挂钩里，否则会误报 stale`);
      }
    }
    const scale = doc.initiatives.find((x) => x.id === 'scale-dozens');
    assert.ok(scale, 'scale-dozens 还在清单里');
    const targets = collectExitTargets({ initiativesDoc: { initiatives: [scale] }, planDocs: [] });
    assert.ok(targets[0].issues.includes(1174), 'scale-dozens 挂钩必须含统领 #1174');
    const r = judgeListExit({
      targets,
      states: Object.fromEntries(targets[0].issues.map((n) => [n, n === 1174 ? 'OPEN' : 'CLOSED'])),
    });
    assert.equal(r.ok, true, '统领 OPEN 时不得把 scale-dozens 判 stale：' + JSON.stringify(r));
    assert.deepEqual(r.stale, []);
  });
  it('故意违规样本：挂的单全 CLOSED 还在推 → 咬住（这条红不了闸就没生效）', async () => {
    const { judgeListExit } = await LIB;
    const r = judgeListExit({ targets, states: { 11: 'CLOSED', 12: 'CLOSED', 13: 'CLOSED' } });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, false);
    assert.deepEqual(r.stale.map((t) => t.name), ['x', 'p.md']);
  });
  it('还有单开着 → 放行', async () => {
    const { judgeListExit } = await LIB;
    const r = judgeListExit({ targets, states: { 11: 'OPEN', 12: 'CLOSED', 13: 'OPEN' } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.stale, []);
  });
  it('单状态查不全 → unscanned（fail-close），不许当「查过没事」', async () => {
    const { judgeListExit } = await LIB;
    const r = judgeListExit({ targets, states: { 11: 'CLOSED' } });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
    assert.match(r.error, /没查成/);
  });
  it('零挂钩对象 → ok（「没东西可查」由调用方说清，不在判官里折成红）', async () => {
    const { judgeListExit } = await LIB;
    const r = judgeListExit({ targets: [], states: {} });
    assert.equal(r.ok, true);
  });
  it('坏的 issues 配置不得当零目标绿', async () => {
    const { collectExitTargets, judgeListExit, parseFrontmatter } = await LIB;
    const targets = collectExitTargets({
      initiativesDoc: { initiatives: [
        { id: 'bad', status: 'active', issues: ['not-an-issue'] },
      ] },
      planDocs: [
        { file: 'p.md', fm: parseFrontmatter('---\nstatus: in-progress\nissues: [abc]\n---\n') },
      ],
    });
    assert.deepEqual(targets.map((t) => t.name), ['bad', 'p.md']);
    const r = judgeListExit({ targets, states: {} });
    assert.equal(r.ok, false, '非法挂钩不得走 0 个对象绿：' + JSON.stringify(r));
    assert.equal(r.unscanned, true);
    assert.match(r.error, /没查成/);
  });
  it('坏挂钩夹在合法单号里也不得滤掉后放行或误报 stale', async () => {
    const { collectExitTargets, judgeListExit } = await LIB;
    const targets = collectExitTargets({
      initiativesDoc: { initiatives: [
        { id: 'mixed', status: 'active', issues: [1145, 'not-an-issue'] },
      ] },
    });
    assert.deepEqual(targets[0].issues, [1145, 'not-an-issue']);
    const r = judgeListExit({ targets, states: { 1145: 'CLOSED' } });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
    assert.deepEqual(r.stale, []);
  });
  it('单文件读失败不得当零目标绿', async () => {
    const { ingestPlanDocs, collectExitTargets } = await LIB;
    const plans = ingestPlanDocs([
      { file: 'docs/decisions/plain.md', ok: true, text: '# 无 frontmatter\n' },
      { file: 'docs/decisions/locked.md', ok: false, error: 'EACCES' },
    ]);
    assert.equal(plans.unscanned, true, '读失败必须 unscanned  →  ' + JSON.stringify(plans));
    assert.match(plans.error, /locked\.md/);
    const targets = collectExitTargets({ initiativesDoc: { initiatives: [] }, planDocs: plans.entries });
    assert.equal(targets.length, 0, '可读文件没有挂钩对象——这就是静默绿陷阱：只看 targets.length 会绿');
    assert.equal(plans.unscanned, true, '调用方必须先看 unscanned，不得把零目标当查过没事');
  });
});
