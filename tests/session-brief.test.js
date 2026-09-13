// 会话开场简报 + 清单退场闸（联动退出）判官（2026-09-08 拍板，见 docs/README.md）。
// 判别力铁律：故意违规样本必须被咬住；「没查成」与「查过没事」必须分得开。
const { describe, it } = require('node:test');
const assert = require('node:assert');
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
  it('issues 里的脏值被滤掉', async () => {
    const { parseFrontmatter } = await LIB;
    const fm = parseFrontmatter('---\nissues: [12, abc, -3, 0]\n---\n');
    assert.deepEqual(fm.issues, [12]);
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
});
