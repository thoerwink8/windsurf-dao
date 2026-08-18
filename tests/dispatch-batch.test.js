// #620 dispatch --batch：N 个只读工人共享 1 张卡
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'scripts', 'dao.mjs');
const LIB = path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs');
const S_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function payload(r) {
  try { return JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); }
  catch { return { raw: r.stdout, err: r.stderr }; }
}

function items(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `判定工${i + 1}`,
    spec: `只读判定第 ${i + 1} 单，不产 PR`,
  }));
}

function makeEffects({ failAt } = {}) {
  const log = [];
  let termSeq = 0;
  let taskSeq = 0;
  return {
    log,
    createWorktree(p) {
      log.push(['createWorktree', p]);
      if (failAt === 'createWorktree') return { ok: false, error: 'boom-wt' };
      return { ok: true, id: 'wt_batch', path: `/tmp/${p.name}` };
    },
    startTerminal(p) {
      log.push(['startTerminal', p]);
      const n = ++termSeq;
      if (failAt === `startTerminal:${n}`) return { ok: false, error: `term fail ${n}` };
      return { ok: true, handle: `term_${n}` };
    },
    createTask(p) {
      log.push(['createTask', p]);
      const n = ++taskSeq;
      if (failAt === `createTask:${n}`) return { ok: false, error: `task fail ${n}` };
      return { ok: true, taskId: `task_${n}` };
    },
    startWorker(p) {
      log.push(['startWorker', p]);
      if (failAt === `startWorker:${p.task}`) return { ok: false, error: `ws fail ${p.task}` };
      if (failAt === `inject:${p.task}`) {
        return { ok: false, dispatchId: `ctx_${p.task}`, error: `inject fail ${p.task}` };
      }
      return { ok: true, dispatchId: `ctx_${p.task}` };
    },
    closeTerminal(h) {
      log.push(['closeTerminal', h]);
      return { ok: true };
    },
    rmWorktree(id) {
      log.push(['rmWorktree', id]);
      return { ok: true };
    },
  };
}

function ops(log) {
  return log.map(row => row[0]);
}

describe('dispatch --batch', () => {
  it('解析 [{name, spec}] 与 {workers: [...]} 等价', async () => {
    const S = await S_LOAD;
    const a = S.parseDispatchBatchItems(items(2));
    const b = S.parseDispatchBatchItems({ workers: items(2) });
    assert.ok(a.ok && b.ok && a.items.length === 2 && b.items.length === 2);
    assert.deepStrictEqual(a.items, b.items);
  });

  it('空数组 / 缺字段 fail-loud', async () => {
    const S = await S_LOAD;
    const empty = S.parseDispatchBatchItems([]);
    assert.ok(!empty.ok && /至少要 1/.test(empty.error), JSON.stringify(empty));
    const noName = S.parseDispatchBatchItems([{ spec: 'x' }]);
    assert.ok(!noName.ok && /缺 name/.test(noName.error), JSON.stringify(noName));
    const noSpec = S.parseDispatchBatchItems([{ name: 'x' }]);
    assert.ok(!noSpec.ok && /缺 spec/.test(noSpec.error), JSON.stringify(noSpec));
    const unread = S.loadDispatchBatchFile('no-such-batch-620.json', {
      readFile: () => { throw new Error('ENOENT'); },
    });
    assert.ok(!unread.ok && /读不到/.test(unread.error), JSON.stringify(unread));
  });

  it('计划：1 棵树、N 条 name/spec/handle 占位、硬编码跳过审官、不带 no-parent', async () => {
    const S = await S_LOAD;
    const plan = S.planDispatchBatch({
      name: '存量27单分流总卡',
      issue: '600',
      model: 'grok-4.6',
      items: items(4),
    });
    assert.ok(plan.ok, JSON.stringify(plan));
    assert.strictEqual(plan.cardName, '#600 - 存量27单分流总卡');
    assert.strictEqual(plan.noParent, false);
    assert.strictEqual(plan.reviewerCreate, false);
    assert.strictEqual(plan.workers.length, 4);
    assert.ok(plan.workers.every((w, i) => (
      w.name === `判定工${i + 1}`
      && w.spec.includes(`第 ${i + 1} 单`)
      && w.handle === `<handle:${i}>`
      && w.worktree === plan.cardName
      && /batch-book\.md/.test(w.inject)
      && /#600/.test(w.inject)
    )), JSON.stringify(plan.workers));
  });

  it('batch 任务书：注入含共享 issue，正文禁止 worker-done / 要求判定 comment', async () => {
    const S = await S_LOAD;
    const inject = S.buildBatchInject({ spec: '判第 1 单', issue: '600' });
    assert.ok(!/[\r\n]/.test(inject), inject);
    assert.match(inject, /host\/skills\/dispatch\/templates\/batch-book\.md/);
    assert.match(inject, /判第 1 单/);
    assert.match(inject, /#600/);
    const book = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'templates', 'batch-book.md'), 'utf8');
    assert.match(book, /不产 PR/);
    assert.match(book, /worker-done/);
    assert.match(book, /reviewer-create/);
    assert.match(book, /判定：/);
    const plan = S.planDispatchBatch({
      name: '总卡', issue: '600', model: 'grok-4.6', items: items(1),
    });
    const fx = makeEffects();
    const r = S.runDispatchBatch({ plan, effects: fx });
    assert.ok(r.ok, JSON.stringify(r));
    const taskCall = fx.log.find(row => row[0] === 'createTask');
    assert.strictEqual(taskCall[1].spec, plan.workers[0].inject);
    assert.strictEqual(taskCall[1].issue, '600');
    assert.ok(fx.log.some(row => row[0] === 'startWorker' && row[1].issue === '600'));
  });

  it('N=1 正常路径：1 棵树 + 1 次 start/task/worker-start，不回滚', async () => {
    const S = await S_LOAD;
    const plan = S.planDispatchBatch({
      name: '总卡', issue: '600', model: 'grok-4.6', items: items(1),
    });
    const fx = makeEffects();
    const r = S.runDispatchBatch({ plan, effects: fx });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepStrictEqual(ops(fx.log), [
      'createWorktree', 'startTerminal', 'createTask', 'startWorker',
    ]);
    assert.strictEqual(fx.log[0][1].noParent, false);
    assert.ok(fx.log.every(row => row[0] !== 'rmWorktree' && row[0] !== 'closeTerminal'));
    assert.strictEqual(r.workers[0].handle, 'term_1');
    assert.strictEqual(r.created.workerId, 'wt_batch');
    assert.strictEqual(r.created.handles.length, 1);
  });

  it('N=4 正常路径：1 棵树 + 4 次循环绑同一张卡，不回滚', async () => {
    const S = await S_LOAD;
    const plan = S.planDispatchBatch({
      name: '总卡', issue: '600', model: 'grok-4.6', items: items(4),
    });
    const fx = makeEffects();
    const r = S.runDispatchBatch({ plan, effects: fx });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(ops(fx.log).filter(x => x === 'createWorktree').length, 1);
    assert.strictEqual(ops(fx.log).filter(x => x === 'startTerminal').length, 4);
    assert.strictEqual(ops(fx.log).filter(x => x === 'createTask').length, 4);
    assert.strictEqual(ops(fx.log).filter(x => x === 'startWorker').length, 4);
    const trees = fx.log.filter(row => row[0] === 'startWorker').map(row => row[1].worktree);
    assert.ok(trees.every(id => id === 'wt_batch'), JSON.stringify(trees));
    assert.strictEqual(r.workers.length, 4);
    assert.ok(!ops(fx.log).includes('rmWorktree'));
    assert.ok(!ops(fx.log).includes('closeTerminal'));
  });

  it('中途第 3 个失败：先 worker-stop 已建 Dispatch，再关终端、删树', async () => {
    const S = await S_LOAD;
    const plan = S.planDispatchBatch({
      name: '总卡', issue: '600', model: 'grok-4.6', items: items(4),
    });
    const fx = makeEffects({ failAt: 'startWorker:task_3' });
    const r = S.runDispatchBatch({ plan, effects: fx });
    assert.ok(!r.ok, JSON.stringify(r));
    assert.match(String(r.error), /worker-start 失败（判定工3）/);
    assert.deepStrictEqual(r.created.handles, ['term_1', 'term_2', 'term_3']);
    assert.deepStrictEqual(r.created.dispatchIds, ['ctx_task_1', 'ctx_task_2']);
    assert.strictEqual(r.created.workerId, 'wt_batch');
    assert.strictEqual(r.workers.length, 2);

    const steps = S.planDispatchRollback(r.created);
    const joined = steps.map(s => s.join(' '));
    assert.ok(joined[0].includes('worker-stop') && joined[0].includes('ctx_task_2'), JSON.stringify(joined));
    assert.ok(joined[1].includes('worker-stop') && joined[1].includes('ctx_task_1'), JSON.stringify(joined));
    assert.ok(joined.some(s => s.includes('terminal close') && s.includes('term_3')), JSON.stringify(joined));
    assert.ok(joined.some(s => s.includes('terminal close') && s.includes('term_2')), JSON.stringify(joined));
    assert.ok(joined.some(s => s.includes('terminal close') && s.includes('term_1')), JSON.stringify(joined));
    assert.ok(joined[joined.length - 1].includes('worktree rm') && joined[joined.length - 1].includes('wt_batch'), JSON.stringify(joined));
    assert.ok(joined.every(s => !/reviewer-create/.test(s)));

    const live = r.created.dispatchIds.map(id => ({
      dispatchId: id, dispatchStatus: 'dispatched', workerState: 'ready',
    }));
    const dirty = S.classifyDispatchResidue({ dispatchIds: r.created.dispatchIds, workers: live });
    assert.ok(!dirty.ok && dirty.leftover.length === 2, JSON.stringify(dirty));
    const fenced = r.created.dispatchIds.map(id => ({
      dispatchId: id, dispatchStatus: 'failed', workerState: 'failed',
    }));
    const clean = S.classifyDispatchResidue({ dispatchIds: r.created.dispatchIds, workers: fenced });
    assert.ok(clean.ok && clean.leftover.length === 0, JSON.stringify(clean));
    const gone = S.classifyDispatchResidue({ dispatchIds: r.created.dispatchIds, workers: [] });
    assert.ok(gone.ok && gone.leftover.length === 0, JSON.stringify(gone));
    const miss = S.classifyDispatchResidue({ dispatchIds: r.created.dispatchIds, workers: null });
    assert.ok(!miss.ok && miss.unscanned === true, JSON.stringify(miss));
  });

  it('启动成功但验注入失败：仍记下 Dispatch ID，回滚先 worker-stop', async () => {
    const S = await S_LOAD;
    const plan = S.planDispatchBatch({
      name: '总卡', issue: '600', model: 'grok-4.6', items: items(3),
    });
    const fx = makeEffects({ failAt: 'inject:task_3' });
    const r = S.runDispatchBatch({ plan, effects: fx });
    assert.ok(!r.ok, JSON.stringify(r));
    assert.match(String(r.error), /inject fail task_3/);
    assert.deepStrictEqual(r.created.dispatchIds, ['ctx_task_1', 'ctx_task_2', 'ctx_task_3']);
    const steps = S.planDispatchRollback(r.created);
    const joined = steps.map(s => s.join(' '));
    assert.ok(joined.some(s => s.includes('worker-stop') && s.includes('ctx_task_3')), JSON.stringify(joined));
    assert.ok(joined.some(s => s.includes('worker-stop') && s.includes('ctx_task_2')), JSON.stringify(joined));
    assert.ok(joined.some(s => s.includes('worker-stop') && s.includes('ctx_task_1')), JSON.stringify(joined));
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'dao.mjs'), 'utf8');
    assert.match(src, /if \(!inject\.ok\) return \{ ok: false, dispatchId/);
  });

  it('CLI --batch --dry-run：N 条计划、跳过审官、不要求 --spec/--reviewer', async () => {
    const S = await S_LOAD;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-batch-'));
    const file = path.join(dir, 'workers.json');
    fs.writeFileSync(file, JSON.stringify(items(4)), 'utf8');
    const r = spawnSync(process.execPath, [
      CLI, 'dispatch', '--batch', file,
      '--name', '存量27单分流总卡', '--issue', '600', '--model', 'grok-4.6', '--dry-run',
    ], { encoding: 'utf8', cwd: REPO });
    const p = payload(r);
    assert.strictEqual(r.status, 0, JSON.stringify(p));
    assert.ok(p.ok && p.dryRun === true && p.batch === true, JSON.stringify(p));
    assert.strictEqual(p.reviewerCreate, false);
    assert.strictEqual(p.noParent, false);
    assert.strictEqual(p.cardName, '#600 - 存量27单分流总卡');
    assert.strictEqual(p.workers.length, 4);
    assert.ok(p.workers[0].handle === '<handle:0>' && p.workers[3].handle === '<handle:3>', JSON.stringify(p.workers));
    assert.ok(/batch-book\.md/.test(p.workers[0].inject) && /#600/.test(p.workers[0].inject), JSON.stringify(p.workers[0]));
    assert.ok(S.FLAGS_BY_VERB.dispatch.has('--batch'));
    const parsed = S.parseArgs([
      'node', 'dao.mjs', 'dispatch', '--batch', file, '--name', 'x', '--issue', '1', '--model', 'grok-4.6',
    ]);
    assert.strictEqual(parsed.batch, file);
  });

  it('CLI --batch --dry-run 不建真实资源（runDispatchBatch 不会被副作用路径碰到）', async () => {
    const S = await S_LOAD;
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'dao.mjs'), 'utf8');
    const fn = src.match(/function cmdDispatchBatch[\s\S]*?\nfunction /);
    assert.ok(fn, 'cmdDispatchBatch 找不到');
    const body = fn[0];
    assert.ok(/if \(args\.dryRun\)/.test(body), 'dry-run 分支缺失');
    assert.ok(/emit\(\{ ok: true, dryRun: true/.test(body), 'dry-run 必须先 emit 退出');
    const dryIdx = body.indexOf('if (args.dryRun)');
    const runIdx = body.indexOf('runDispatchBatch');
    assert.ok(dryIdx >= 0 && runIdx > dryIdx, 'dry-run 必须在 runDispatchBatch 之前退出');
    assert.ok(!/reviewer-create/.test(body), 'batch 路径不得调 reviewer-create');
  });

  it('CLI --batch 缺 --issue / 带 --spec 非零', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-batch-'));
    const file = path.join(dir, 'workers.json');
    fs.writeFileSync(file, JSON.stringify(items(1)), 'utf8');
    const noIssue = spawnSync(process.execPath, [
      CLI, 'dispatch', '--batch', file, '--name', '总卡', '--model', 'grok-4.6', '--dry-run',
    ], { encoding: 'utf8', cwd: REPO });
    const p1 = payload(noIssue);
    assert.ok(noIssue.status !== 0 && /--issue/.test(p1.error || ''), JSON.stringify(p1));
    const withSpec = spawnSync(process.execPath, [
      CLI, 'dispatch', '--batch', file, '--name', '总卡', '--issue', '600',
      '--model', 'grok-4.6', '--spec', '不该出现', '--dry-run',
    ], { encoding: 'utf8', cwd: REPO });
    const p2 = payload(withSpec);
    assert.ok(withSpec.status !== 0 && /不要再给 --spec/.test(p2.error || ''), JSON.stringify(p2));
  });

  it('host/skills/dispatch/SKILL.md 有「批量派只读工人」', () => {
    const txt = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'SKILL.md'), 'utf8');
    assert.ok(/## 批量派只读工人/.test(txt));
    assert.ok(/dispatch --batch/.test(txt));
    assert.ok(/不调 `reviewer-create`/.test(txt));
  });
});
