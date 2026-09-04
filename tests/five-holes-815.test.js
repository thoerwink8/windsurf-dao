// #815 五洞判别测试：今晚人工 reviewer-attach 的场景必须由机制接住。
// ① 复审待办队列 + drain ② 派工单记真终端 + send --dispatch
// ③ 复用审官前 worker-read 核活性 ④ 建审官树按 origin 检出
// ⑤ 接手派单不重挂 model/* + attach --model
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs');
const CLI = path.join(REPO, 'scripts', 'dao.mjs');
const REVIEWER_BOOK = path.join(REPO, 'host', 'skills', 'dispatch', 'templates', 'reviewer-book.md');
const S_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
}

function gitIn(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() });
}

function initRepo(dir, message) {
  gitIn(dir, ['init', '-q']);
  gitIn(dir, ['config', 'user.email', 't@t']);
  gitIn(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'f.txt'), `${message}\n`);
  gitIn(dir, ['add', 'f.txt']);
  gitIn(dir, ['commit', '-q', '-m', message]);
  return {
    oid: gitIn(dir, ['rev-parse', 'HEAD']).stdout.trim(),
    branch: gitIn(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(),
  };
}

describe('#815 ① 复审待办队列 + drain', () => {
  it('worker-done 起败写队列；drain 调 reviewer-attach --skip-wait；空目录是扫完 0 不是没查成', async () => {
    const S = await S_LOAD;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-rp-'));
    const empty = S.listReviewPending(dir);
    assert.ok(empty.ok === true && empty.unscanned === false && empty.scanned === 0,
      '空目录必须是扫完 0 条 → ' + JSON.stringify(empty));

    const missing = S.listReviewPending(path.join(dir, 'no-such'));
    assert.ok(missing.ok === true && missing.scanned === 0 && missing.unscanned === false,
      '目录不在 = 扫完 0，不是没查成 → ' + JSON.stringify(missing));

    const built = S.buildReviewPendingTicket({
      pr: '810',
      head: { name: 'ISSUE-810', oid: 'abc1234def' },
      workerWorktree: 'wt_worker',
      reviewer: 'gpt-5.6-sol',
      issue: '810',
      round: 'rework',
      error: 'Sub-worker dispatch is not permitted at depth 2',
      workerModel: 'grok-4.6',
    });
    assert.ok(built.ok, JSON.stringify(built));
    const wrote = S.writeReviewPending({ dir, ticket: built.ticket });
    assert.ok(wrote.ok && fs.existsSync(path.join(dir, '810.json')), JSON.stringify(wrote));

    const listed = S.listReviewPending(dir);
    assert.ok(listed.ok && listed.scanned === 1 && listed.tickets[0].pr === '810', JSON.stringify(listed));
    assert.ok(listed.tickets[0].head.oid === 'abc1234def' && listed.tickets[0].workerWorktree === 'wt_worker',
      '待办必须含 head + 工人树 + reviewer → ' + JSON.stringify(listed.tickets[0]));

    const plan = S.planReviewPendingDrain(listed.tickets[0]);
    assert.ok(plan.ok && plan.skipWait === true, JSON.stringify(plan));
    assert.ok(plan.argv.includes('reviewer-attach') && plan.argv.includes('--skip-wait'),
      'drain 必须走 attach --skip-wait → ' + plan.argv.join(' '));
    assert.ok(plan.argv.includes('--model') && plan.argv.includes('grok-4.6'),
      '待办带工人模型时 drain 传 --model → ' + plan.argv.join(' '));

    const calls = [];
    const drained = S.drainReviewPending({
      dir,
      attach: (p) => { calls.push(p.argv.slice()); return { ok: true, pr: p.pr }; },
    });
    assert.ok(drained.ok && drained.scanned === 1 && drained.drained === 1, JSON.stringify(drained));
    assert.ok(calls.length === 1 && calls[0].includes('--skip-wait'), JSON.stringify(calls));
    assert.ok(!fs.existsSync(path.join(dir, '810.json')), '成功后应删待办');

    const noAttach = S.drainReviewPending({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dao-rp-u-')) });
    assert.ok(noAttach.ok === false && noAttach.unscanned === true && /没查成/.test(noAttach.error),
      '没 attach 执行器 = 没查成，不许当扫完 0 → ' + JSON.stringify(noAttach));

    const daoSrc = fs.readFileSync(CLI, 'utf8');
    assert.ok(/writeReviewPendingOnFail/.test(daoSrc) && /reviewPending/.test(daoSrc),
      'worker-done 起败必须写队列');
    const book = fs.readFileSync(REVIEWER_BOOK, 'utf8');
    assert.ok(/复审轮走队列/.test(book) && /review-pending-drain/.test(book),
      'reviewer-book 必须写复审轮走队列');
  });

  it('不可删除路径：attach 成功但待办删不掉 → consume/drain 必须 ok:false，文件仍在', async () => {
    const S = await S_LOAD;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-rp-sticky-'));
    const built = S.buildReviewPendingTicket({
      pr: '820',
      head: { name: 'ISSUE-815', oid: 'abc1234def' },
      workerWorktree: 'wt_worker',
      reviewer: 'gpt-5.6-sol',
    });
    assert.ok(built.ok, JSON.stringify(built));
    const wrote = S.writeReviewPending({ dir, ticket: built.ticket });
    assert.ok(wrote.ok, JSON.stringify(wrote));
    const pendingPath = path.join(dir, '820.json');
    const bak = `${pendingPath}.bak`;
    fs.renameSync(pendingPath, bak);
    fs.mkdirSync(pendingPath);
    fs.writeFileSync(path.join(pendingPath, 'keep'), 'x');
    fs.unlinkSync(bak);

    const consumed = S.consumeReviewPending({
      dir,
      ticket: built.ticket,
      attach: () => ({ ok: true, pr: '820' }),
    });
    assert.ok(consumed.ok === false && consumed.cleanupFailed === true,
      '删不掉必须 ok:false，不许当已消费 → ' + JSON.stringify(consumed));
    assert.ok(/删不掉|清理失败/.test(consumed.error || ''), '报错要点名清理失败 → ' + consumed.error);
    assert.ok(fs.existsSync(pendingPath), '待办路径必须还在，下轮才能重试');

    const drained = S.drainReviewPending({
      dir,
      tickets: [built.ticket],
      attach: () => ({ ok: true, pr: '820' }),
    });
    assert.ok(drained.ok === false && drained.failed === 1 && drained.drained === 0,
      'drain 必须非零且不计入 drained → ' + JSON.stringify(drained));
    assert.ok(fs.existsSync(pendingPath), 'drain 失败后待办仍在');
  });
});

describe('#815 ② 派工单记真终端 + send --dispatch', () => {
  it('#802 实咬：workerHandle 是空壳，worker-read 的 terminal.handle 才是活人', async () => {
    const S = await S_LOAD;
    const shell = 'term_19076863-shell';
    const agent = 'term_3fd5952a-grok';
    const read = {
      result: {
        terminal: { handle: agent, connected: true, writable: true, orphaned: false },
        worker: { agent_terminal_handle: agent, state: 'ready' },
        dispatch: { id: 'ctx_802', status: 'dispatched', assignee_handle: agent },
      },
    };
    const picked = S.pickDispatchAgentTerminal({ workerHandle: shell, workerReadJson: read });
    assert.ok(picked.ok && picked.mismatch === true && picked.agentTerminalHandle === agent,
      '必须记下 agent 终端，不能信空壳 → ' + JSON.stringify(picked));

    const miss = S.pickDispatchAgentTerminal({ workerHandle: shell, workerReadJson: null });
    assert.ok(miss.ok === false && miss.unscanned === true && /没查成/.test(miss.error),
      '没读成不许把空壳当活人 → ' + JSON.stringify(miss));

    const empty = S.pickDispatchAgentTerminal({ workerHandle: shell, workerReadJson: { result: {} } });
    assert.ok(empty.ok === false && /terminal\.handle/.test(empty.error),
      '读到了但没有 handle → ' + JSON.stringify(empty));

    const viaDispatch = S.resolveSendTarget({ dispatch: 'ctx_802', workerReadJson: read });
    assert.ok(viaDispatch.ok && viaDispatch.terminal === agent && viaDispatch.source === 'dispatch',
      'send --dispatch 必须解析到真终端 → ' + JSON.stringify(viaDispatch));

    const viaTerm = S.resolveSendTarget({ terminal: shell });
    assert.ok(viaTerm.ok && viaTerm.terminal === shell && viaTerm.source === 'flag', JSON.stringify(viaTerm));

    const neither = S.resolveSendTarget({});
    assert.ok(neither.ok === false && /--terminal 或 --dispatch/.test(neither.error), JSON.stringify(neither));

    const parsed = S.parseArgs(['node', 'dao.mjs', 'send', '--dispatch', 'ctx_802', '--text', '红项']);
    assert.ok(parsed.dispatch === 'ctx_802' && parsed.text === '红项', JSON.stringify(parsed));

    const daoSrc = fs.readFileSync(CLI, 'utf8');
    assert.ok(/pickDispatchAgentTerminal/.test(daoSrc) && /created\.agentTerminalHandle/.test(daoSrc),
      '派工单落盘必须补 agentTerminalHandle');
    assert.ok(/function cmdSend[\s\S]*resolveSendTarget/.test(daoSrc),
      'cmdSend 必须走 --dispatch 解析');
  });
});

describe('#815 ③ 复用审官前 worker-read 核活性', () => {
  it('活 → 复用；已结算/不活 → 新建树；没查成不许猜', async () => {
    const S = await S_LOAD;
    const cards = {
      ok: true,
      count: 1,
      cards: [{ worktreeId: 'wt_rev', createdAt: 10 }],
    };
    const workers = [{ dispatchId: 'ctx_rev', resource: { worktreeId: 'wt_rev' } }];

    const probe = S.planReviewerAttachReuse({ cards, workers, workerRead: null });
    assert.ok(probe.ok && probe.action === 'probe' && probe.dispatchId === 'ctx_rev', JSON.stringify(probe));

    const liveRead = {
      ok: true,
      json: {
        result: {
          dispatch: { id: 'ctx_rev', status: 'dispatched' },
          worker: { state: 'ready', agent_terminal_handle: 'term_rev' },
          terminal: { handle: 'term_rev', connected: true, writable: true, orphaned: false },
        },
      },
    };
    const live = S.planReviewerAttachReuse({ cards, workers, workerRead: liveRead });
    assert.ok(live.ok && live.action === 'reuse' && live.handle === 'term_rev',
      'worker-read 活必须复用 → ' + JSON.stringify(live));

    const settledRead = {
      ok: true,
      json: {
        result: {
          dispatch: { id: 'ctx_rev', status: 'completed' },
          worker: { state: 'succeeded', agent_terminal_handle: 'term_rev' },
          terminal: null,
        },
      },
    };
    const settled = S.planReviewerAttachReuse({ cards, workers, workerRead: settledRead });
    assert.ok(settled.ok && settled.action === 'create' && /已结算/.test(settled.reason),
      '已结算必须新建，不许复用死人 → ' + JSON.stringify(settled));

    // 2026-09-05 实咬（#866/#868 复审 drain 全灭）：probe 回读若接的是 worker-read
    // 的真实返回（result.dispatchId+terminal，没有 dispatch 块），结算判读必须报「没查成」
    // 而不是误判——这条钉死数据契约：喂 worker-read 形状进来只能得 unscanned，
    // 所以调用点（cmdReviewerAttach 的 probe 分支）必须用 worker-show。
    const workerReadShape = {
      ok: true,
      json: {
        result: {
          dispatchId: 'ctx_rev',
          source: 'terminal',
          terminal: { handle: 'term_rev', status: 'running', tail: ['…'] },
        },
      },
    };
    const misfed = S.planReviewerAttachReuse({ cards, workers, workerRead: workerReadShape });
    assert.ok(misfed.ok === false && misfed.unscanned === true && /result\.dispatch/.test(misfed.error),
      'worker-read 形状（无 dispatch 块）必须判没查成，不许当已结算/未结算 → ' + JSON.stringify(misfed));

    const deadRead = {
      ok: true,
      json: {
        result: {
          dispatch: { id: 'ctx_rev', status: 'dispatched' },
          worker: { state: 'ready', agent_terminal_handle: 'term_dead' },
          terminal: { handle: 'term_dead', connected: false, writable: false, orphaned: true },
        },
      },
    };
    const dead = S.planReviewerAttachReuse({ cards, workers, workerRead: deadRead });
    assert.ok(dead.ok && dead.action === 'create' && /不活/.test(dead.reason),
      '终端不活必须新建 → ' + JSON.stringify(dead));

    const unread = S.planReviewerAttachReuse({
      cards, workers,
      workerRead: { ok: false, unscanned: true, error: 'worker-read 失败' },
    });
    assert.ok(unread.ok === false && unread.unscanned === true && unread.action !== 'reuse',
      '没查成不许复用也不许当没有审官 → ' + JSON.stringify(unread));

    const none = S.planReviewerAttachReuse({
      cards: { ok: true, count: 0, cards: [] },
      workers: [],
    });
    assert.ok(none.ok && none.action === 'create' && /扫完没有/.test(none.reason), JSON.stringify(none));

    const daoSrc = fs.readFileSync(CLI, 'utf8');
    assert.ok(/function cmdReviewerAttach[\s\S]*planReviewerAttachReuse[\s\S]*argsWorkerRead/.test(daoSrc),
      'attach 复用前必须 worker-read');
  });
});

describe('#815 ④ 建审官树按 origin 检出', () => {
  it('#810 实咬：本地落后时报「本地分支落后」，不是「在审空气」', async () => {
    const S = await S_LOAD;
    const originDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-or-'));
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-loc-'));
    const first = initRepo(originDir, 'old');
    fs.writeFileSync(path.join(originDir, 'f.txt'), 'new\n');
    gitIn(originDir, ['add', 'f.txt']);
    gitIn(originDir, ['commit', '-q', '-m', 'new']);
    const originOid = gitIn(originDir, ['rev-parse', 'HEAD']).stdout.trim();
    const branch = first.branch;
    gitIn(localDir, ['clone', '-q', originDir, '.']);
    gitIn(localDir, ['reset', '--hard', '-q', first.oid]);
    const localOid = gitIn(localDir, ['rev-parse', 'HEAD']).stdout.trim();
    assert.ok(localOid === first.oid && localOid !== originOid, `local=${localOid} origin=${originOid}`);

    const air = S.verifyReviewerTree({ reviewerPath: localDir, expectedOid: originOid });
    assert.ok(air.ok === false && /在审空气/.test(air.error) && !air.localBehind,
      '不传 originOid 仍报在审空气（旧口径） → ' + JSON.stringify(air));

    const behind = S.verifyReviewerTree({
      reviewerPath: localDir, expectedOid: originOid, originOid,
    });
    assert.ok(behind.ok === false && /本地分支落后/.test(behind.error) && behind.localBehind === true,
      'HEAD≠PR head 且 origin 对得上 → 本地分支落后，不是在审空气 → ' + JSON.stringify(behind));
    assert.ok(!/在审空气/.test(behind.error), '两种报错必须分开 → ' + behind.error);

    const prep = S.prepareReviewerOriginRef({
      cwd: localDir, branch, expectedOid: originOid,
    });
    assert.ok(prep.ok && prep.baseBranch === `origin/${branch}` && prep.originOid,
      'fetch 后应按 origin/<分支> 检出 → ' + JSON.stringify(prep));

    const stale = S.prepareReviewerOriginRef({
      cwd: localDir, branch, expectedOid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    assert.ok(stale.ok === false && /本地分支落后/.test(stale.error),
      'origin 仍落后 PR head → 建树前就报落后 → ' + JSON.stringify(stale));

    const co = S.checkoutOriginRef({ cwd: localDir, branch, expectedOid: originOid });
    assert.ok(co.ok, JSON.stringify(co));
    const aligned = S.verifyReviewerTree({
      reviewerPath: localDir, expectedOid: originOid, originOid: co.originOid,
    });
    assert.ok(aligned.ok === true, '按 origin 检出后应对上 PR head → ' + JSON.stringify(aligned));

    const daoSrc = fs.readFileSync(CLI, 'utf8');
    assert.ok(/function cmdReviewerCreate[\s\S]*prepareReviewerOriginRef/.test(daoSrc),
      'reviewer-create 建树前必须 fetch origin');
    assert.ok(/function cmdReviewerAttach[\s\S]*prepareReviewerOriginRef/.test(daoSrc),
      'reviewer-attach 建树前必须 fetch origin');
  });
});

describe('#815 ⑤ 接手派单不重挂 model/*；attach --model', () => {
  it('#810 实咬：issue 已有 model/pi，再派 grok 不得挂第二条', async () => {
    const S = await S_LOAD;
    const keep = S.planStampIssueLabels({
      existingNames: ['已消歧', 'model/pi-v2', 'type/写码', 'reviewer/gpt-5.6-sol'],
      model: 'grok-4.6',
      role: '写码',
      reviewer: 'gpt-5.6-sol',
    });
    assert.ok(keep.ok, JSON.stringify(keep));
    assert.ok(!keep.add.includes('model/grok-4.6'),
      '接手不得再挂 model/grok → ' + JSON.stringify(keep));
    assert.ok(keep.skipped.some(s => s.reason === 'handoff-keep-existing-model'),
      JSON.stringify(keep.skipped));

    const first = S.planStampIssueLabels({
      existingNames: ['已消歧'],
      model: 'grok-4.6',
      role: '写码',
      reviewer: 'gpt-5.6-sol',
    });
    assert.ok(first.add.includes('model/grok-4.6') && first.add.includes('type/写码'),
      '首次派工仍打 model/* → ' + JSON.stringify(first));

    const unscanned = S.planStampIssueLabels({ existingNames: null, model: 'grok-4.6' });
    assert.ok(unscanned.ok === false && unscanned.unscanned === true,
      '现有 label 没查成不许再挂 → ' + JSON.stringify(unscanned));

    const calls = [];
    const gh = (a) => {
      calls.push(a.slice());
      if (a[0] === 'issue' && a[1] === 'view') {
        return { ok: true, out: JSON.stringify({ labels: [{ name: 'model/pi-v2' }, { name: 'type/写码' }] }) };
      }
      if (a[0] === 'label' && a[1] === 'list') {
        return { ok: true, out: JSON.stringify([{ name: 'model/pi-v2' }, { name: 'type/写码' }, { name: 'reviewer/gpt-5.6-sol' }]) };
      }
      if (a[0] === 'issue' && a[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: `未预期 ${a.join(' ')}` };
    };
    const stamped = S.stampIssueLabels({
      issue: '810', model: 'grok-4.6', role: '写码', reviewer: 'gpt-5.6-sol', runGh: gh,
    });
    assert.ok(stamped.ok, JSON.stringify(stamped));
    const edit = calls.find(a => a[0] === 'issue' && a[1] === 'edit');
    assert.ok(!edit || !edit.includes('model/grok-4.6'),
      'issue edit 不得带第二条 model/* → ' + JSON.stringify({ stamped, calls }));

    const many = S.requireWorkerModel(['model/pi-v2', 'model/grok-4.6', 'type/写码']);
    assert.ok(many.ok === false && many.state === 'many', JSON.stringify(many));
    const flagged = S.resolveWorkerFromPr({
      pr: '42',
      model: 'grok-4.6',
      runGh: () => ({ ok: true, out: JSON.stringify({ title: 'x', body: '署名 issue #565', labels: [] }) }),
    });
    // collectIssueLabelsFromPr 会先 pr view 再 issue view；上面的 runGh 对两种都返回同一 JSON。
    // --model 显式指定时即使 label 读不全也用旗标。
    assert.ok(flagged.ok === true && flagged.source === 'flag' && flagged.modelId === 'grok-4.6',
      'attach --model 显式指定，不许猜 → ' + JSON.stringify(flagged));

    const flags = S.FLAGS_BY_VERB['reviewer-attach'];
    assert.ok(flags.has('--model'), 'reviewer-attach 必须允许 --model');
  });
});

describe('#815 ⑥ 审官注入失败不回滚树', () => {
  it('#820/#821 实咬：pi 审官 120s 等不到开工证明后不得整树回滚', async () => {
    const S = await S_LOAD;
    const keep = S.planReviewerKeepOnFail({
      reviewerId: 'wt_rev_815',
      reviewerPath: '/tmp/PR-820-审官',
      reason: '审官注入后开工验证失败: 120s 未见开工证明',
    });
    assert.ok(keep.ok && keep.keepTree === true && keep.rollback === false && keep.keep === true,
      '树已建成必须 keepTree → ' + JSON.stringify(keep));
    assert.ok(/不回滚/.test(keep.warning) && /start --model/.test(keep.warning),
      '红项要提示接手命令 → ' + keep.warning);

    const noTree = S.planReviewerKeepOnFail({
      reason: '审官卡创建失败',
    });
    assert.ok(noTree.ok && noTree.keepTree === false && noTree.rollback === true,
      '还没有树才允许回滚 → ' + JSON.stringify(noTree));

    const daoSrc = fs.readFileSync(CLI, 'utf8');
    assert.ok(/function keepCreated/.test(daoSrc), '注入失败走 keepCreated 不是 failCreated');
    assert.ok(!/failCreated\([^)]*审官注入后开工验证失败/.test(daoSrc),
      'create/attach 不得因开工验证失败 failCreated');
    assert.ok(/keepCreated\([^)]*审官注入后开工验证失败/.test(daoSrc),
      '开工验证失败必须 keepCreated');
    assert.ok(/keepCreated\([^)]*审官 worker-start 失败/.test(daoSrc),
      'worker-start 失败也不得整树回滚');

    const createSeg = daoSrc.slice(daoSrc.indexOf('function cmdReviewerCreate'), daoSrc.indexOf('function cmdReviewerAttach'));
    const attachSeg = daoSrc.slice(daoSrc.indexOf('function cmdReviewerAttach'), daoSrc.indexOf('function cmdReviewerDone'));
    assert.ok(/preferAgent:\s*true/.test(createSeg) && /preferAgent:\s*true/.test(attachSeg),
      '审官 create/attach 必须 preferAgent，注入走 #805 --agent 探就绪');
    const launchFn = daoSrc.match(/function launchAgentInWorktree[\s\S]*?\nfunction /)?.[0] || '';
    assert.ok(/!preferAgent && !!\(launch && launch\.daoTrace\)/.test(launchFn),
      'daoTrace 不得再把审官逼成 --command → ' + launchFn.slice(0, 240));

    const book = fs.readFileSync(REVIEWER_BOOK, 'utf8');
    assert.ok(/失败不回滚树/.test(book) && /start --model/.test(book),
      'reviewer-book 必须写失败不回滚 + 接手命令');
  });
});
