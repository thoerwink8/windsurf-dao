// #588 worktree-rm 整树后序删：先计划、再执行。占用必须在开删前拦住。
// #595：orca 错误对象不得变成 [object Object]；未进主树的账本事件拦住。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'dao-cmd.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function wt(partial) {
  return {
    worktreeId: partial.id,
    displayName: partial.name,
    path: partial.path || `/tmp/${partial.id}`,
    parentWorktreeId: partial.parent || null,
    childWorktreeIds: partial.children || [],
    agents: partial.agents || [],
    isMainWorktree: !!partial.main,
    isActive: !!partial.active,
    isArchived: !!partial.archived,
    workspaceStatus: partial.status || 'in-progress',
    linkedIssue: partial.issue || null,
    branch: partial.branch || `refs/heads/${partial.id}`,
  };
}

describe('worktree-rm', () => {
  const parent = wt({
    id: 'p1', name: '#588 - 工人', children: ['c1', 'c2'], issue: 588,
  });
  const c1 = wt({ id: 'c1', name: '#588 - 审官甲', parent: 'p1' });
  const c2 = wt({ id: 'c2', name: '#588 - 审官乙', parent: 'p1' });
  const forest = [
    wt({ id: 'master', name: 'master', main: true, active: true }),
    parent, c1, c2,
  ];

  it('带 2 个子卡：后序，子先父后', async (t) => {
    const S = await LIB_LOAD;
    const plan = S.planWorktreeRm(forest, 'p1');
    await t.test('计划成功', () => {
      assert.ok(plan.ok === true, '计划成功  →  ' + JSON.stringify(plan));
    });
    await t.test('三棵都在顺序里', () => {
      assert.ok(plan.order.map(n => n.id).sort().join(',') === 'c1,c2,p1', '三棵都在顺序里  →  ' + JSON.stringify(plan.order));
    });
    await t.test('父卡在最后', () => {
      assert.ok(plan.order[plan.order.length - 1].id === 'p1', '父卡在最后  →  ' + JSON.stringify(plan.order));
    });
    const idx = Object.fromEntries(plan.order.map((n, i) => [n.id, i]));
    await t.test('两个子卡都在父卡前面', () => {
      assert.ok(idx.c1 < idx.p1 && idx.c2 < idx.p1, '两个子卡都在父卡前面  →  ' + JSON.stringify(idx));
    });
  });

  it('子卡占用：整树不删', async (t) => {
    const S = await LIB_LOAD;
    const busy = [
      wt({ id: 'master', name: 'master', main: true }),
      wt({ id: 'p2', name: '#1 - 工人', children: ['c3', 'c4'] }),
      wt({ id: 'c3', name: '#1 - 审官', parent: 'p2', agents: [{ state: 'working' }] }),
      wt({ id: 'c4', name: '#1 - 闲', parent: 'p2' }),
    ];
    const plan = S.planWorktreeRm(busy, 'p2');
    await t.test('占用 → 计划失败', () => {
      assert.ok(plan.ok === false, '占用 → 计划失败  →  ' + JSON.stringify(plan));
    });
    await t.test('报出错的是哪棵', () => {
      assert.ok(/#1 - 审官/.test(plan.error) && /working/.test(plan.error), '报出错的是哪棵  →  ' + plan.error);
    });
    await t.test('order 空（调用方不得开删）', () => {
      assert.ok(Array.isArray(plan.order) && plan.order.length === 0, 'order 空（调用方不得开删）  →  ' + JSON.stringify(plan.order));
    });
    const applied = S.applyWorktreeRmPlan(plan, { rm: () => ({ ok: true }) });
    await t.test('失败计划不会去删', () => {
      assert.ok(applied.ok === false && (applied.removed || []).length === 0, '失败计划不会去删  →  ' + JSON.stringify(applied));
    });
  });

  it('执行：2 子卡一条命令删干净', async (t) => {
    const S = await LIB_LOAD;
    const plan = S.planWorktreeRm(forest, 'name:#588 - 工人');
    const seen = [];
    const applied = S.applyWorktreeRmPlan(plan, {
      rm: (node) => { seen.push(node.id); return { ok: true }; },
    });
    await t.test('执行成功', () => {
      assert.ok(applied.ok === true && applied.removed.length === 3, '执行成功  →  ' + JSON.stringify(applied));
    });
    await t.test('实际删除顺序与计划一致', () => {
      assert.ok(seen.join(',') === plan.order.map(n => n.id).join(','), '实际删除顺序与计划一致  →  ' + seen.join(','));
    });
    await t.test('父卡最后删', () => {
      assert.ok(seen[seen.length - 1] === 'p1', '父卡最后删  →  ' + seen.join(','));
    });
  });

  it('中途失败：报已删，不装成没动过', async (t) => {
    const S = await LIB_LOAD;
    const plan = S.planWorktreeRm(forest, 'p1');
    let n = 0;
    const applied = S.applyWorktreeRmPlan(plan, {
      rm: (node) => {
        n += 1;
        if (n === 2) return { ok: false, error: 'orca boom' };
        return { ok: true };
      },
    });
    await t.test('中途失败非零', () => {
      assert.ok(applied.ok === false, '中途失败非零  →  ' + JSON.stringify(applied));
    });
    await t.test('点得出已删和失败点', () => {
      assert.ok(applied.removed.length === 1 && applied.failed && /半删/.test(applied.error), '点得出已删和失败点  →  ' + applied.error);
    });
  });

  it('主树 / 找不到 / 子卡失踪', async (t) => {
    const S = await LIB_LOAD;
    await t.test('拒绝删主树', () => {
      assert.ok(S.planWorktreeRm(forest, 'master').ok === false
        && /主树/.test(S.planWorktreeRm(forest, 'master').error), '拒绝删主树  →  ' + S.planWorktreeRm(forest, 'master').error);
    });
    await t.test('找不到就报', () => {
      assert.ok(/找不到/.test(S.planWorktreeRm(forest, 'no-such').error), '找不到就报');
    });
    const ghost = [
      wt({ id: 'p3', name: '#2', children: ['ghost-1'] }),
    ];
    const g = S.planWorktreeRm(ghost, 'p3');
    await t.test('子卡失踪 → 不删', () => {
      assert.ok(g.ok === false && /找不到/.test(g.error), '子卡失踪 → 不删  →  ' + g.error);
    });
  });

  it('选择器：active / issue / 显示名', async (t) => {
    const S = await LIB_LOAD;
    await t.test('issue:588 命中工人卡', () => {
      assert.ok(S.planWorktreeRm(forest, 'issue:588').ok
        && S.planWorktreeRm(forest, 'issue:588').root.id === 'p1', 'issue:588 命中工人卡');
    });
    await t.test('active 命中主树后被拒绝（不是静默删错）', () => {
      assert.ok(/主树/.test(S.planWorktreeRm(forest, 'active').error), 'active 命中主树后被拒绝（不是静默删错）');
    });
    const waiting = [
      wt({ id: 'p4', name: '#3', children: ['c5'] }),
      wt({ id: 'c5', name: '审', parent: 'p4', agents: [{ state: 'waiting' }] }),
    ];
    await t.test('waiting 也算占用', () => {
      assert.ok(/占用/.test(S.planWorktreeRm(waiting, 'p4').error), 'waiting 也算占用  →  ' + S.planWorktreeRm(waiting, 'p4').error);
    });
    const doneOnly = [
      wt({ id: 'p5', name: '#4', children: ['c6'] }),
      wt({ id: 'p5-no', name: 'x' }),
      wt({ id: 'c6', name: '审', parent: 'p5', agents: [{ state: 'done' }] }),
    ];
    await t.test('done 不算占用，可以删', () => {
      assert.ok(S.planWorktreeRm(doneOnly, 'p5').ok === true, 'done 不算占用，可以删  →  ' + JSON.stringify(S.planWorktreeRm(doneOnly, 'p5')));
    });
    const idleOnly = [
      wt({ id: 'p6', name: '#5', children: ['c7'] }),
      wt({ id: 'c7', name: '审', parent: 'p6', agents: [{ state: 'idle' }, { state: 'done' }] }),
    ];
    await t.test('#665 idle 不算占用，可以删', () => {
      assert.ok(S.planWorktreeRm(idleOnly, 'p6').ok === true, 'idle 不算占用  →  ' + JSON.stringify(S.planWorktreeRm(idleOnly, 'p6')));
    });
  });

  it('三层：孙卡先于子卡先于父卡', async (t) => {
    const S = await LIB_LOAD;
    const deep = [
      wt({ id: 'a', name: '项', children: ['b'] }),
      wt({ id: 'b', name: '工人', parent: 'a', children: ['c'] }),
      wt({ id: 'c', name: '审官', parent: 'b' }),
    ];
    const plan = S.planWorktreeRm(deep, 'a');
    const ids = plan.order.map(n => n.id);
    await t.test('三层都在', () => {
      assert.ok([...ids].sort().join(',') === 'a,b,c', '三层都在  →  ' + ids.join(','));
    });
    await t.test('孙 → 子 → 父', () => {
      assert.ok(ids.indexOf('c') < ids.indexOf('b') && ids.indexOf('b') < ids.indexOf('a'), '孙 → 子 → 父  →  ' + ids.join(','));
    });
  });

  it('#595 ③ 错误对象不得变成 [object Object]', async (t) => {
    const S = await LIB_LOAD;
    const plan = S.planWorktreeRm(forest, 'p1');
    const applied = S.applyWorktreeRmPlan(plan, {
      rm: () => ({
        ok: false,
        error: { code: 'dirty_worktree', files: ['review-592.txt', 'ledger/events/x.json'] },
      }),
    });
    await t.test('失败非零', () => {
      assert.ok(applied.ok === false, '失败非零  →  ' + JSON.stringify(applied));
    });
    await t.test('输出不含 [object Object]', () => {
      assert.ok(!String(applied.error).includes('[object Object]'), '输出不含 [object Object]  →  ' + applied.error);
    });
    await t.test('输出含真因', () => {
      assert.ok(/dirty_worktree|review-592|ledger\/events/.test(applied.error), '输出含真因  →  ' + applied.error);
    });
  });

  it('#595 ② 未进主树的账本事件拦住', async (t) => {
    const S = await LIB_LOAD;
    const workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-595-w-'));
    const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-595-m-'));
    fs.mkdirSync(path.join(workerDir, 'ledger', 'events'), { recursive: true });
    fs.mkdirSync(path.join(mainDir, 'ledger', 'events'), { recursive: true });
    fs.writeFileSync(path.join(workerDir, 'ledger', 'events', 'orphan-595.json'), '{"type":"job.dispatch"}');
    const sample = [
      wt({ id: 'master', name: 'master', main: true, path: mainDir }),
      wt({ id: 'w1', name: '#595 - 工人', path: workerDir }),
    ];
    const blocked = S.prepareWorktreeRm(sample, 'w1', {
      mainEventsDir: path.join(mainDir, 'ledger', 'events'),
    });
    await t.test('有孤本拒删', () => {
      assert.ok(blocked.ok === false, '有孤本拒删  →  ' + JSON.stringify(blocked));
    });
    await t.test('报出文件名', () => {
      assert.ok(/orphan-595\.json/.test(blocked.error), '报出文件名  →  ' + blocked.error);
    });

    fs.writeFileSync(path.join(mainDir, 'ledger', 'events', 'orphan-595.json'), '{"type":"job.dispatch"}');
    const synced = S.prepareWorktreeRm(sample, 'w1', {
      mainEventsDir: path.join(mainDir, 'ledger', 'events'),
    });
    await t.test('主树已有同名则放行', () => {
      assert.ok(synced.ok === true, '主树已有同名则放行  →  ' + JSON.stringify(synced));
    });

    fs.unlinkSync(path.join(workerDir, 'ledger', 'events', 'orphan-595.json'));
    const clean = S.prepareWorktreeRm(sample, 'w1', {
      mainEventsDir: path.join(mainDir, 'ledger', 'events'),
    });
    await t.test('工人树干净放行', () => {
      assert.ok(clean.ok === true, '工人树干净放行  →  ' + JSON.stringify(clean));
    });

    fs.rmSync(workerDir, { recursive: true, force: true });
    fs.rmSync(mainDir, { recursive: true, force: true });
  });

  it('#601 审官草稿被 gitignore，账本事件仍可见', async (t) => {
    const S = await LIB_LOAD;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-601-gi-'));
    const repoIgnore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
    const init = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
    await t.test('沙箱 git init', () => {
      assert.equal(init.status, 0, init.stderr);
    });
    fs.writeFileSync(path.join(dir, '.gitignore'), repoIgnore);
    fs.writeFileSync(path.join(dir, 'review-601.txt'), 'draft');
    fs.mkdirSync(path.join(dir, '.tmp-review-601'));
    fs.writeFileSync(path.join(dir, '.tmp-review-601', 'x'), 'x');
    fs.mkdirSync(path.join(dir, 'ledger', 'events'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ledger', 'events', 'orphan-601.json'), '{}');
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: dir, encoding: 'utf8',
    });
    const lines = (status.stdout || '').split(/\r?\n/).filter(Boolean);
    await t.test('git status 不列 review-601.txt', () => {
      assert.ok(!lines.some(l => /review-601\.txt/.test(l)), status.stdout);
    });
    await t.test('git status 不列 .tmp-review-601', () => {
      assert.ok(!lines.some(l => /\.tmp-review-601/.test(l)), status.stdout);
    });
    await t.test('git status 仍列账本事件', () => {
      assert.ok(lines.some(l => /orphan-601\.json/.test(l)), status.stdout);
    });

    const workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-601-w-'));
    const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-601-m-'));
    fs.mkdirSync(path.join(workerDir, 'ledger', 'events'), { recursive: true });
    fs.mkdirSync(path.join(mainDir, 'ledger', 'events'), { recursive: true });
    fs.writeFileSync(path.join(workerDir, 'review-601.txt'), 'draft');
    fs.writeFileSync(path.join(workerDir, 'ledger', 'events', 'orphan-601.json'), '{}');
    const sample = [
      wt({ id: 'master', name: 'master', main: true, path: mainDir }),
      wt({ id: 'w601', name: '#601 - 工人', path: workerDir }),
    ];
    const blocked = S.prepareWorktreeRm(sample, 'w601', {
      mainEventsDir: path.join(mainDir, 'ledger', 'events'),
    });
    await t.test('未跟踪账本事件仍拦住', () => {
      assert.ok(blocked.ok === false && /orphan-601\.json/.test(blocked.error), blocked.error);
    });
    fs.unlinkSync(path.join(workerDir, 'ledger', 'events', 'orphan-601.json'));
    const draftOnly = S.prepareWorktreeRm(sample, 'w601', {
      mainEventsDir: path.join(mainDir, 'ledger', 'events'),
    });
    await t.test('只剩审官草稿时计划放行', () => {
      assert.ok(draftOnly.ok === true, JSON.stringify(draftOnly));
    });
    fs.rmSync(workerDir, { recursive: true, force: true });
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('#835 cwd 归属：只认本树，含 (deleted) 后缀',
    async (t) => {
      const S = await LIB_LOAD;
      await t.test('本树 cwd 命中',
        () => {
          assert.ok(S.cwdBelongsToTree('/tmp/ISSUE-835', '/tmp/ISSUE-835') === true, '本树 cwd 命中');
        });
      await t.test('(deleted) 也算本树',
        () => {
          assert.ok(S.cwdBelongsToTree('/tmp/ISSUE-835 (deleted)', '/tmp/ISSUE-835') === true, '(deleted) 也算本树');
        });
      await t.test('子目录不算本树（不许扫到父路径）',
        () => {
          assert.ok(S.cwdBelongsToTree('/tmp/ISSUE-835/src', '/tmp/ISSUE-835') === false, '子目录不算');
        });
      await t.test('别的树不算',
        () => {
          assert.ok(S.cwdBelongsToTree('/tmp/ISSUE-831', '/tmp/ISSUE-835') === false, '别的树不算');
        });
    });

  it('#835 假 /proc：只收本树 pid',
    async (t) => {
      const S = await LIB_LOAD;
      const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-835-proc-'));
      const tree = '/tmp/ISSUE-835-tree';
      const other = '/tmp/other-tree';
      for (const [pid, target] of [['111', tree], ['222', `${tree} (deleted)`], ['333', other]]) {
        const dir = path.join(proc, pid);
        fs.mkdirSync(dir);
        fs.symlinkSync(target, path.join(dir, 'cwd'));
      }
      fs.mkdirSync(path.join(proc, 'self'));
      const found = S.pidsOnTreePath(tree, { procDir: proc, selfPid: -1 });
      await t.test('扫成',
        () => {
          assert.ok(found.ok === true && found.available === true, JSON.stringify(found));
        });
      await t.test('本树两个 pid（含 deleted）',
        () => {
          assert.deepEqual([...found.pids].sort(), [111, 222], JSON.stringify(found));
        });
      await t.test('别的树的 pid 不收',
        () => {
          assert.ok(!found.pids.includes(333), JSON.stringify(found));
        });
      fs.rmSync(proc, { recursive: true, force: true });
    });

  it('#835 占用闸一条都不放宽',
    async (t) => {
      const S = await LIB_LOAD;
      const busy = [
        wt({ id: 'p835', name: '#835 - 工人', agents: [{ state: 'working' }] }),
      ];
      const plan = S.planWorktreeRm(busy, 'p835');
      await t.test('working 仍整树不删',
        () => {
          assert.ok(plan.ok === false && /占用/.test(plan.error), plan.error);
        });
    });

  it('#835 terminal stop 后进程没了 → 放行',
    async (t) => {
      const S = await LIB_LOAD;
      const node = { id: 'w835', name: '#835', path: '/tmp/w835' };
      const calls = [];
      let live = [{ handle: 'term_a', agentIdentity: 'pi' }];
      let pids = [4242];
      const reaped = S.reapWorktreeAgents({
        node,
        stop: (id) => { calls.push(`stop:${id}`); live = []; pids = []; return { ok: true }; },
        listTerminals: () => ({ ok: true, terminals: live }),
        listPids: () => ({ ok: true, available: true, pids }),
        killPid: (pid) => { calls.push(`kill:${pid}`); return { ok: true, pid }; },
        sleep: () => {},
        now: (() => { let n = 0; return () => (n += 1000); })(),
        stopWaitMs: 10,
        termWaitMs: 10,
        pollMs: 1,
      });
      await t.test('收进程成功',
        () => {
          assert.ok(reaped.ok === true, JSON.stringify(reaped));
        });
      await t.test('先 stop 没升 SIGTERM',
        () => {
          assert.ok(calls.join(',') === 'stop:w835', calls.join(','));
        });
    });

  it('#835 stop 不退则 SIGTERM，再退 → 放行',
    async (t) => {
      const S = await LIB_LOAD;
      const node = { id: 'w835b', name: '#835b', path: '/tmp/w835b' };
      const calls = [];
      let pids = [77];
      const reaped = S.reapWorktreeAgents({
        node,
        stop: (id) => { calls.push(`stop:${id}`); return { ok: true }; },
        listTerminals: () => ({ ok: true, terminals: [] }),
        listPids: () => ({ ok: true, available: true, pids: [...pids] }),
        killPid: (pid) => { calls.push(`kill:${pid}`); pids = []; return { ok: true, pid }; },
        sleep: () => {},
        now: (() => { let n = 0; return () => (n += 1000); })(),
        stopWaitMs: 10,
        termWaitMs: 10,
        pollMs: 1,
      });
      await t.test('升级后成功',
        () => {
          assert.ok(reaped.ok === true, JSON.stringify(reaped));
        });
      await t.test('stop 之后才 SIGTERM 77',
        () => {
          assert.ok(calls.join(',') === 'stop:w835b,kill:77', calls.join(','));
        });
    });

  it('#835 收不掉报 pid 非零',
    async (t) => {
      const S = await LIB_LOAD;
      const node = { id: 'w835c', name: '#835c', path: '/tmp/w835c' };
      const reaped = S.reapWorktreeAgents({
        node,
        stop: () => ({ ok: true }),
        listTerminals: () => ({ ok: true, terminals: [] }),
        listPids: () => ({ ok: true, available: true, pids: [1511975] }),
        killPid: (pid) => ({ ok: true, pid }),
        sleep: () => {},
        now: (() => { let n = 0; return () => (n += 1000); })(),
        stopWaitMs: 10,
        termWaitMs: 10,
        pollMs: 1,
      });
      await t.test('失败非零',
        () => {
          assert.ok(reaped.ok === false, JSON.stringify(reaped));
        });
      await t.test('报出 pid',
        () => {
          assert.ok(/1511975/.test(reaped.error) && /未删树/.test(reaped.error), reaped.error);
        });
    });

  it('#835 删树后本树终端登记还在 → 非零',
    async (t) => {
      const S = await LIB_LOAD;
      const stuck = S.verifyWorktreeTerminalsGone({
        node: { id: 'w835d', name: '#835d' },
        listTerminals: () => ({ ok: true, terminals: [{ handle: 'term_left' }] }),
      });
      await t.test('登记还在失败',
        () => {
          assert.ok(stuck.ok === false && /term_left/.test(stuck.error), JSON.stringify(stuck));
        });
      const gone = S.verifyWorktreeTerminalsGone({
        node: { id: 'w835d' },
        listTerminals: () => ({ ok: true, terminals: [] }),
      });
      await t.test('空名单算跟着掉',
        () => {
          assert.ok(gone.ok === true, JSON.stringify(gone));
        });
      const missing = S.verifyWorktreeTerminalsGone({
        node: { id: 'w835d' },
        listTerminals: () => ({ ok: false, error: 'orca 报错 selector_not_found: selector_not_found' }),
      });
      await t.test('selector_not_found 算树已没、登记跟着掉',
        () => {
          assert.ok(missing.ok === true && missing.missingWorktree === true, JSON.stringify(missing));
        });
    });

  it('#835 argsTerminalStop 带 --worktree --json',
    async (t) => {
      const S = await LIB_LOAD;
      const a = S.argsTerminalStop({ worktree: 'w' });
      await t.test('命令是 terminal stop',
        () => {
          assert.ok(a[0] === 'terminal' && a[1] === 'stop', a.join(' '));
        });
      await t.test('带选择器和 json',
        () => {
          assert.ok(a.includes('--worktree') && a[a.indexOf('--worktree') + 1] === 'w' && a.includes('--json'), a.join(' '));
        });
    });

  it('#835 cmdWorktreeRm 闸过后再 reapThenRm',
    async (t) => {
      const daoSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'dao.mjs'), 'utf8');
      const rmFn = daoSrc.slice(daoSrc.indexOf('function cmdWorktreeRm'), daoSrc.indexOf('function cmdTaskCreate'));
      await t.test('热路走 reapThenRmWorktree',
        () => {
          assert.ok(/reapThenRmWorktree/.test(rmFn), rmFn.slice(0, 400));
        });
      await t.test('先退役再 reap/删树',
        () => {
          assert.ok(rmFn.indexOf('finalizeWorktreeRmLifecycle') < rmFn.indexOf('reapThenRmWorktree'), '顺序反了');
        });
      await t.test('占用闸文案仍在',
        () => {
          assert.ok(/占用中，未删任何树/.test(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'worktree.mjs'), 'utf8')), '占用闸文案丢了');
        });
    });
});