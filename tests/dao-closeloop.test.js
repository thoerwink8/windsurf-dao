// tests/dao-closeloop.test.js —— dao 闭环投递与结算
//
// 2026-09-06 从 dao.test.js 拆出（原 4220 行 / 1058 用例一个文件）。
// 本套管：三跳投递失败必须炸 / 红项打进活身份 / worker_done 真结算
// 共享前置在 tests/helpers/dao-harness.js，各套逐字复用，行为与拆分前一致。

const { describe, it } = require('node:test');
const { assert, fs, os, path, spawnSync, REPO, CLI, LIB, S_LOAD, DAO_LOAD, cliInProc, ROUTING_LOAD, waitForOutJson } = require('./helpers/dao-harness');

describe('dao 闭环投递与结算', () => {
  it('⑨ 闭环三跳：投递失败必须炸，不许静默（#548 红项 1）', async (t) => {
    const S = await S_LOAD;
    // 判别性：同一套判据，活收件人必须放行、死收件人必须拦下。只会拦不会放的守卫等于天天假红。
    const LIVE = 'term_live-0001';
    const DEAD = 'term_00000000-0000-0000-0000-000000000000';
    const LIVE_RUN = 'run_live0001';
    const DEAD_RUN = 'run_00000000';
    const LIVE_DISPATCH = 'ctx_live-0001';
    const DEAD_DISPATCH = 'ctx_00000000-0000-0000-0000-000000000000';
    const DONE_DISPATCH = 'ctx_done-0001';

    // 假 orca：照抄真实返回形状——send 对死 handle 一样 ok:true / delivered_at:null。
    function fakeOrca({ inboxDrops = false, inboxBroken = false, sentMissingId = false, misroute = null } = {}) {
      let seq = 0;
      const sent = [];
      const fn = (a) => {
        const key = `${a[0]} ${a[1]}`;
        if (key === 'terminal read') {
          const h = a[a.indexOf('--terminal') + 1];
          if (h === LIVE) return { ok: true, json: { ok: true, result: { terminal: { handle: h, status: 'running' } } } };
          return { ok: false, error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' } };
        }
        if (key === 'orchestration run-show') {
          const id = a[a.indexOf('--id') + 1];
          if (id === LIVE_RUN) return { ok: true, json: { ok: true, result: { run: { id } } } };
          return { ok: false, error: { code: 'run_not_found', message: `Run ${id} was not found.` } };
        }
        if (key === 'orchestration run-current') {
          return { ok: true, json: { ok: true, result: { run: null } } };
        }
        if (key === 'orchestration worker-show') {
          const d = a[a.indexOf('--dispatch') + 1];
          if (d === LIVE_DISPATCH) {
            return { ok: true, json: { ok: true, result: { dispatch: { id: d, status: 'dispatched', assignee_handle: 'term_live-0001' }, worker: { state: 'ready' } } } };
          }
          if (d === DONE_DISPATCH) {
            return { ok: true, json: { ok: true, result: { dispatch: { id: d, status: 'completed' }, worker: { state: 'succeeded' } } } };
          }
          return { ok: false, error: { code: 'dispatch_not_found', message: `Worker Dispatch ${d} was not found.` } };
        }
        if (key === 'orchestration send') {
          const to = a.includes('--to') ? a[a.indexOf('--to') + 1] : null;
          const id = `msg_fake${++seq}`;
          const m = { id, to_handle: misroute || to, delivered_at: null };
          if (!inboxDrops) sent.push(m);
          if (sentMissingId) return { ok: true, json: { ok: true, result: { mutation: {} } } };
          return { ok: true, json: { ok: true, result: { message: m } } };
        }
        if (key === 'orchestration inbox') {
          if (inboxBroken) return { ok: true, json: { ok: true, result: {} } };
          return { ok: true, json: { ok: true, result: { messages: sent.slice().reverse() } } };
        }
        throw new Error(`假 orca 没登记这条命令: ${a.join(' ')}`);
      };
      return fn;
    }

    const HOPS = [
      { hop: '士兵→审官', live: { to: LIVE }, dead: { to: DEAD } },
      { hop: '审官→士兵', live: { to: LIVE }, dead: { to: DEAD } },
      // 审官→帅 是普通告知，不带 --type worker_done：notify 验投递不验结算（#551）
      { hop: '审官→帅', live: { to: `run:${LIVE_RUN}` }, dead: { to: `run:${DEAD_RUN}` } },
      // #559 ①：士兵↔审官互发走 dispatch:<id>（结构化收件箱）不是 terminal handle
      { hop: '士兵→审官(dispatch)', live: { to: `dispatch:${LIVE_DISPATCH}` }, dead: { to: `dispatch:${DEAD_DISPATCH}` } },
      { hop: '审官→士兵(dispatch)', live: { to: `dispatch:${LIVE_DISPATCH}` }, dead: { to: `dispatch:${DEAD_DISPATCH}` } },
    ];
    for (const h of HOPS) {
      const good = S.deliverMessage({ ...h.live, subject: '完工', hop: h.hop, orca: fakeOrca() });
      await t.test(`${h.hop}：收件人在 → 放行并给消息 id`, () => {
        assert.ok(good.ok === true && /^msg_/.test(good.messageId || ''), `${h.hop}：收件人在 → 放行并给消息 id  →  ` + JSON.stringify(good));
      });
      const bad = S.deliverMessage({ ...h.dead, subject: '完工', hop: h.hop, orca: fakeOrca() });
      await t.test(`${h.hop}：故意错 handle → 拦下`, () => {
        assert.ok(bad.ok === false && bad.stage === '收件人', `${h.hop}：故意错 handle → 拦下  →  ` + JSON.stringify(bad));
      });
      await t.test(`${h.hop}：错 handle 的报错说得出「不存在」`, () => {
        assert.ok(bad.ok === false && /不存在/.test(bad.error), `${h.hop}：错 handle 的报错说得出「不存在」  →  ` + bad.error);
      });
    }

    const dropped = S.deliverMessage({ to: LIVE, subject: 'x', orca: fakeOrca({ inboxDrops: true }) });
    await t.test('回执给了 id 但编排里查不到 → 拦下', () => {
      assert.ok(dropped.ok === false && dropped.stage === '复核', '回执给了 id 但编排里查不到 → 拦下  →  ' + JSON.stringify(dropped));
    });

    const unscanned = S.deliverMessage({ to: LIVE, subject: 'x', orca: fakeOrca({ inboxBroken: true }) });
    await t.test('复核一条样本都没扫到 → 标 unscanned 且非 ok（没查成 ≠ 查过没事）', () => {
      assert.ok(unscanned.ok === false && unscanned.unscanned === true, '复核一条样本都没扫到 → 标 unscanned 且非 ok（没查成 ≠ 查过没事）  →  ' + JSON.stringify(unscanned));
    });

    const noReceipt = S.deliverMessage({ to: LIVE, subject: 'x', orca: fakeOrca({ sentMissingId: true }) });
    await t.test('send 说成功却没回执 → 拦下', () => {
      assert.ok(noReceipt.ok === false && noReceipt.stage === '回执', 'send 说成功却没回执 → 拦下  →  ' + JSON.stringify(noReceipt));
    });

    const wrong = S.deliverMessage({ to: LIVE, subject: 'x', orca: fakeOrca({ misroute: 'term_someone-else' }) });
    await t.test('回执收件人与请求不一致（错投）→ 拦下', () => {
      assert.ok(wrong.ok === false && /错投/.test(wrong.error), '回执收件人与请求不一致（错投）→ 拦下  →  ' + JSON.stringify(wrong));
    });

    const noRun = S.deliverMessage({ subject: 'x', orca: fakeOrca() });
    await t.test('省略收件人但没绑 Run → 拦下（发进真空）', () => {
      assert.ok(noRun.ok === false && /真空/.test(noRun.error), '省略收件人但没绑 Run → 拦下（发进真空）  →  ' + JSON.stringify(noRun));
    });

    const badDispatchForm = S.classifyNotifyTarget('dispatch_ctx-x');
    await t.test('dispatch_xxx 不带冒号 → 不收（只收 dispatch:）', () => {
      assert.ok(badDispatchForm.kind === 'unsupported', 'dispatch_xxx 不带冒号 → 不收（只收 dispatch:）  →  ' + JSON.stringify(badDispatchForm));
    });
    const okDispatchForm = S.classifyNotifyTarget('dispatch:ctx_x');
    await t.test('dispatch:<id> 形态被认', () => {
      assert.ok(okDispatchForm.kind === 'dispatch' && okDispatchForm.id === 'ctx_x', 'dispatch:<id> 形态被认  →  ' + JSON.stringify(okDispatchForm));
    });

    await t.test('ready/working/waiting 算活人', () => {
      assert.ok(S.isLiveDispatchRecipient({ workerState: 'ready' })
        && S.isLiveDispatchRecipient({ workerState: 'working' })
        && S.isLiveDispatchRecipient({ workerState: 'waiting' }),
        'ready/working/waiting 算活人');
    });
    await t.test('completed/succeeded/failed 不算活人', () => {
      assert.ok(!S.isLiveDispatchRecipient({ workerState: 'succeeded', dispatchStatus: 'completed' })
        && !S.isLiveDispatchRecipient({ workerState: 'failed' })
        && !S.isLiveDispatchRecipient({ dispatchStatus: 'completed' }),
        'completed/succeeded/failed 不算活人');
    });
    const doneProbe = S.probeRecipient({ kind: 'dispatch', id: DONE_DISPATCH }, fakeOrca());
    await t.test('probeRecipient 已完工 dispatch → 非零，并写人走了才新开', () => {
      assert.ok(doneProbe.ok === false && /已完工/.test(doneProbe.error)
        && /#677/.test(doneProbe.error) && /新开工人/.test(doneProbe.error)
        && !/新 task/.test(doneProbe.error),
        'probeRecipient 已完工 dispatch → 非零  →  ' + JSON.stringify(doneProbe));
    });
    const doneSendOther = S.deliverMessage({
      to: `dispatch:${DONE_DISPATCH}`,
      subject: '红项',
      hop: '士兵→审官(dispatch)',
      orca: fakeOrca(),
    });
    await t.test('非审官→士兵 hop 已完工 dispatch → 非零，禁止当送达', () => {
      assert.ok(doneSendOther.ok === false && doneSendOther.stage === '收件人' && /已完工/.test(doneSendOther.error),
        '非审官→士兵 hop 已完工 dispatch → 非零  →  ' + JSON.stringify(doneSendOther));
    });
    const doneSendHop = S.deliverMessage({
      to: `dispatch:${DONE_DISPATCH}`,
      subject: '红项',
      hop: '审官→士兵(dispatch)',
      orca: fakeOrca(),
    });
    await t.test('#677 审官→士兵 已完工 → 失败，不开下一跳', () => {
      assert.ok(doneSendHop.ok === false && doneSendHop.stage === '收件人'
        && /士兵已下班/.test(doneSendHop.error) && /#677/.test(doneSendHop.error)
        && /不要开下一跳/.test(doneSendHop.error),
        '#677 审官→士兵 已完工不开下一跳  →  ' + JSON.stringify(doneSendHop));
    });

    const wsFx = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'orca-json', 'worker-show.json'), 'utf8'));
    await t.test('真语料 worker-show → extractDispatchId 取 result.dispatch.id', () => {
      assert.ok(S.extractDispatchId(wsFx) === 'ctx_5a59f2b680ca', '真语料 worker-show → extractDispatchId 取 result.dispatch.id  →  ' + JSON.stringify(S.extractDispatchId(wsFx)));
    });
    await t.test('extractDispatchId 认 worker-start 的 result.dispatchId（CLI 源码形态）', () => {
      assert.ok(S.extractDispatchId({ result: { dispatchId: 'ctx_abc' } }) === 'ctx_abc', 'extractDispatchId 认 worker-start 的 result.dispatchId（CLI 源码形态）');
    });
    await t.test('extractDispatchId 认 worker.dispatch_id', () => {
      assert.ok(S.extractDispatchId({ result: { worker: { dispatch_id: 'ctx_def' } } }) === 'ctx_def', 'extractDispatchId 认 worker.dispatch_id');
    });
    await t.test('extractDispatchId 不认 RPC 顶层 id', () => {
      assert.ok(S.extractDispatchId({ id: 'rpc-123', result: {} }) === null, 'extractDispatchId 不认 RPC 顶层 id');
    });

    const group = S.deliverMessage({ to: '@all', subject: 'x', orca: fakeOrca() });
    await t.test('组播收件人 → 拒发（没人负责签收）', () => {
      assert.ok(group.ok === false && /组播/.test(group.error), '组播收件人 → 拒发（没人负责签收）  →  ' + JSON.stringify(group));
    });

    const noSubject = S.deliverMessage({ to: LIVE, orca: fakeOrca() });
    await t.test('缺 subject → 拦下', () => {
      assert.ok(noSubject.ok === false && noSubject.stage === '参数', '缺 subject → 拦下  →  ' + JSON.stringify(noSubject));
    });

    const reworkFourGate = S.completeWorkerDoneNotify({
      round: 'rework',
      pr: '592',
      comment: '返工完成：PR #592\n\n已修红项',
      reviewerDispatchId: LIVE_DISPATCH,
      deliver: S.deliverMessage,
      orca: fakeOrca(),
    });
    await t.test('#586 返工走四关投递 notified.ok===true',
      () => {
        assert.ok(reworkFourGate.ok === true && reworkFourGate.notified && reworkFourGate.notified.ok === true
        && /^msg_/.test(reworkFourGate.notified.messageId || ''),
        '#586 返工走四关投递 notified.ok===true  →  ' + JSON.stringify(reworkFourGate));
      });

    // delivered_at 不是判据：真语料里活收件人也是 null，当门就是每条都假红。
    const fx = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'orca-json', 'orchestration-send.json'), 'utf8'));
    await t.test('真语料：send 对活收件人 delivered_at 也是 null', () => {
      assert.ok(fx.ok === true && fx.result.message.delivered_at === null, '真语料：send 对活收件人 delivered_at 也是 null  →  ' + JSON.stringify(fx.result?.message?.delivered_at));
    });
    const deliverSrc = fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'dispatch', 'deliver.mjs'), 'utf8');
    await t.test('deliverMessage 不拿 delivered_at 当门（只报出）', () => {
      assert.ok(!/delivered_at[^\n]*\?\s*[^:]*:\s*\{\s*ok:\s*false/.test(deliverSrc) && /deliveredAt: found\.message/.test(deliverSrc), 'deliverMessage 不拿 delivered_at 当门（只报出）');
    });

    // CLI 接线：动词登记 + 失败非零
    await t.test('notify 已登记进 VERBS', () => {
      assert.ok(S.VERBS.includes('notify'), 'notify 已登记进 VERBS  →  ' + S.VERBS.join(','));
    });
    const cliBad = spawnSync(process.execPath, [CLI, 'notify', '--to', DEAD, '--subject', '回归样本'], { encoding: 'utf8', cwd: REPO });
    await t.test('CLI notify 故意错 handle → 非零退出', () => {
      assert.ok(cliBad.status !== 0, 'CLI notify 故意错 handle → 非零退出  →  ' + `status=${cliBad.status} ${cliBad.stdout}`);
    });
    await t.test('CLI notify 失败时 stderr 明说链断', () => {
      assert.ok(/链断/.test(cliBad.stderr || ''), 'CLI notify 失败时 stderr 明说链断  →  ' + cliBad.stderr);
    });

    const tmplSoldier = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'templates', 'soldier-book.md'), 'utf8');
    const tmplReviewer = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'templates', 'reviewer-book.md'), 'utf8');
    await t.test('士兵任务书问帅走 dao.mjs ask，并写 ASK_TIMEOUT', () => {
      assert.ok(/dao\.mjs ask/.test(tmplSoldier) && /ASK_TIMEOUT/.test(tmplSoldier) && /run-current/.test(tmplSoldier), '士兵任务书问帅走 dao.mjs ask，并写 ASK_TIMEOUT');
    });
    await t.test('审官上报不用 run-current 当地址', () => {
      assert.ok(/不要用 `run-current`/.test(tmplReviewer) && /worker-show/.test(tmplReviewer), '审官上报不用 run-current 当地址');
    });
    await t.test('士兵任务书完工走 dao.mjs worker-done（不是裸 orca send）', () => {
      assert.ok(/dao\.mjs worker-done/.test(tmplSoldier) && !/^\s*orca orchestration send/m.test(tmplSoldier), '士兵任务书完工走 dao.mjs worker-done（不是裸 orca send）  →  ' + tmplSoldier.slice(0, 200));
    });
    await t.test('审官任务书发信走 dao.mjs notify（不是裸 orca send）', () => {
      assert.ok(/dao\.mjs notify/.test(tmplReviewer) && !/^\s*orca orchestration send/m.test(tmplReviewer), '审官任务书发信走 dao.mjs notify（不是裸 orca send）  →  ' + tmplReviewer.slice(0, 200));
    });
    await t.test('两份任务书都写明「确认送达才准进下一步」', () => {
      assert.ok(/确认送达/.test(tmplSoldier) && /确认送达/.test(tmplReviewer), '两份任务书都写明「确认送达才准进下一步」');
    });

    // 审官「可归档」仍是普通告知；结算另走 worker_done（#551）
    const archiveBlock = tmplReviewer.slice(tmplReviewer.indexOf('### 3. 收尾'));
    const marshalNotify = archiveBlock.match(/notify --hop "审官→帅"[\s\S]{0,280}?--body[^\n]*/);
    await t.test('审官「可归档」notify 不带 --type worker_done（那是投递给帅）', () => {
      assert.ok(marshalNotify && /--to run:/.test(marshalNotify[0]) && !/--type worker_done/.test(marshalNotify[0]),
        '审官「可归档」notify 不带 --type worker_done（那是投递给帅）  →  ' + (marshalNotify && marshalNotify[0]));
    });
    await t.test('审官结算走 notify --type worker_done 且带 task-id/dispatch-id', () => {
      assert.ok(/--type worker_done/.test(archiveBlock) && /--task-id/.test(archiveBlock) && /--dispatch-id/.test(archiveBlock)
        && /未结算/.test(archiveBlock) && /#551/.test(archiveBlock),
        '审官结算走 notify --type worker_done 且带 task-id/dispatch-id  →  ' + archiveBlock.slice(0, 400));
    });
    await t.test('审官任务书写明红项后也结算，复审轮走队列（#552/#815）', () => {
      assert.ok(/inspect-only/.test(archiveBlock) && /复审轮走队列/.test(archiveBlock) && /#552/.test(archiveBlock),
        '审官任务书写明红项后也结算，复审轮走队列（#552/#815）');
    });
    await t.test('#675 审官任务书红项只跑 notify，不自己拼 task-create', () => {
      assert.ok(/不要自己拼/.test(tmplReviewer) && /task-create/.test(tmplReviewer) && /不要开下一跳/.test(tmplReviewer),
        '#675 审官任务书红项只跑 notify，不自己拼 task-create');
    });
    await t.test('#677 士兵任务书：交卷后身份继续活，判定绿才结算', () => {
      assert.ok(/不要立刻/.test(tmplSoldier) && /判定绿/.test(tmplSoldier)
        && /还活着/.test(tmplSoldier) && /#677/.test(tmplSoldier)
        && !/新 Task 注入本终端/.test(tmplSoldier),
        '#677 士兵任务书交卷不立刻结算  →  ' + tmplSoldier.slice(tmplSoldier.indexOf('不要立刻'), tmplSoldier.indexOf('不要立刻') + 180));
    });
    await t.test('#677 口径唯一落点在 SKILL；global 已不承载派工约定（2026-08-31 停派工归零）', () => {
      const global = fs.readFileSync(path.join(REPO, 'docs', 'global-CLAUDE.md'), 'utf8');
      const skill = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'SKILL.md'), 'utf8');
      const banned = /发完完工报告就不再收信箱/;
      assert.ok(!banned.test(global) && !banned.test(skill)
        && !/## 派工时\r?\n/.test(global)
        && /判定绿/.test(skill) && /#677/.test(skill) && /派工时的常驻约定/.test(skill),
        '#677 口径唯一落点在 SKILL  →  global派工段=' + /## 派工时/.test(global) + ' skill判定绿=' + skill.includes('判定绿'));
    });
    await t.test('notify 文档：普通投递 ≠ 结算；worker_done 才核 completed', () => {
      assert.ok(/投递\*\*不是\*\*结算|普通 notify 验的是\*\*投递\*\*不是\*\*结算/.test(S.USAGE)
        && /未结算/.test(S.USAGE) && /#551/.test(S.USAGE),
        'notify 文档：普通投递 ≠ 结算；worker_done 才核 completed  →  ' + S.USAGE.slice(-500));
    });
    await t.test('deliverMessage 注释点明普通 ok:true ≠ 结算，worker_done 核 completed', () => {
      assert.ok(/不是结算/.test(deliverSrc) && /未结算/.test(deliverSrc) && /#551/.test(deliverSrc) && /completed/.test(deliverSrc),
        'deliverMessage 注释点明普通 ok:true ≠ 结算，worker_done 核 completed');
    });
  });

  it('#677 红项打进活身份：waiting 能送达；已完工 fail-visible 不开下一跳', async (t) => {
    const S = await S_LOAD;
    const LIVE = 'ctx_live-hop-1';
    const DONE = 'ctx_done-hop-1';
    const LIVE_TERM = 'term_live-0001';
    const RUN = 'run_live0001';

    function hopOrca({ dispatchId = LIVE, workerState = 'waiting', dispatchStatus = 'dispatched', showBroken = false } = {}) {
      const calls = [];
      const sent = [];
      let seq = 0;
      const fn = (a) => {
        calls.push(a.slice());
        const key = `${a[0]} ${a[1]}`;
        if (key === 'orchestration worker-show') {
          if (showBroken) return { ok: false, error: { code: 'timeout', message: 'worker-show timeout' } };
          const d = a[a.indexOf('--dispatch') + 1];
          if (d !== dispatchId) {
            return { ok: false, error: { code: 'dispatch_not_found', message: `Worker Dispatch ${d} was not found.` } };
          }
          return {
            ok: true,
            json: {
              ok: true,
              result: {
                dispatch: { id: d, status: dispatchStatus, assignee_handle: LIVE_TERM, run_id: RUN },
                worker: { state: workerState, agent_terminal_handle: LIVE_TERM },
              },
            },
          };
        }
        if (key === 'orchestration worker-list') {
          return { ok: false, error: { code: 'boom', message: 'worker-list down' } };
        }
        if (key === 'orchestration task-create' || key === 'orchestration worker-start') {
          throw new Error(`#677 不许开下一跳: ${a.join(' ')}`);
        }
        if (key === 'orchestration send') {
          const to = a.includes('--to') ? a[a.indexOf('--to') + 1] : null;
          const id = `msg_hop${++seq}`;
          const m = { id, to_handle: to, to_dispatch: to && String(to).startsWith('dispatch:') ? String(to).slice('dispatch:'.length) : null, delivered_at: null };
          sent.push(m);
          return { ok: true, json: { ok: true, result: { message: m } } };
        }
        if (key === 'orchestration inbox') {
          return { ok: true, json: { ok: true, result: { messages: sent.slice().reverse() } } };
        }
        throw new Error(`假 orca 没登记这条命令: ${a.join(' ')}`);
      };
      fn.calls = calls;
      fn.sent = sent;
      return fn;
    }

    const liveIo = hopOrca({ workerState: 'waiting' });
    const delivered = S.deliverMessage({
      to: `dispatch:${LIVE}`,
      subject: '红项：2 条',
      body: '位置+问题+期望',
      hop: '审官→士兵',
      orca: liveIo,
    });
    await t.test('正样本：waiting Dispatch 收到红项', () => {
      assert.ok(delivered.ok === true && /^msg_/.test(delivered.messageId || ''),
        'waiting 能送达  →  ' + JSON.stringify(delivered));
    });
    await t.test('正样本：红项打进这个活 id，不开 task-create', () => {
      const tos = liveIo.sent.map((m) => m.to_handle || m.to_dispatch);
      assert.ok(tos.some((x) => x === `dispatch:${LIVE}` || x === LIVE), '活 id 有信  →  ' + JSON.stringify(tos));
      assert.ok(!liveIo.calls.some((c) => c[1] === 'task-create' || c[1] === 'worker-start'),
        '不开下一跳  →  ' + JSON.stringify(liveIo.calls.map((c) => c.slice(0, 2))));
    });

    const readyIo = hopOrca({ workerState: 'ready' });
    const ready = S.deliverMessage({
      to: `dispatch:${LIVE}`,
      subject: '红项：1 条',
      hop: '审官→士兵',
      orca: readyIo,
    });
    await t.test('正样本：ready Dispatch 也能收到红项', () => {
      assert.ok(ready.ok === true && /^msg_/.test(ready.messageId || ''),
        'ready 能送达  →  ' + JSON.stringify(ready));
    });

    const deadIo = hopOrca({ dispatchId: DONE, workerState: 'succeeded', dispatchStatus: 'completed' });
    const dead = S.deliverMessage({
      to: `dispatch:${DONE}`,
      subject: '红项：1 条',
      hop: '审官→士兵',
      orca: deadIo,
    });
    await t.test('负样本：已完工 → 非零，报士兵已下班，不开下一跳', () => {
      assert.ok(dead.ok === false && /士兵已下班/.test(dead.error) && /#677/.test(dead.error)
        && !deadIo.calls.some((c) => c[1] === 'task-create'),
        '已完工不开下一跳  →  ' + JSON.stringify({ dead, calls: deadIo.calls.map((c) => c.slice(0, 2)) }));
    });

    const missIo = hopOrca({ showBroken: true });
    const unscanned = S.deliverMessage({
      to: `dispatch:${LIVE}`,
      subject: '红项',
      hop: '审官→士兵',
      orca: missIo,
    });
    await t.test('worker-show 没查成 → unscanned，不开下一跳', () => {
      assert.ok(unscanned.ok === false && unscanned.unscanned === true
        && !missIo.calls.some((c) => c[1] === 'task-create'),
        '没查成 ≠ 已完工  →  ' + JSON.stringify(unscanned));
    });

    await t.test('USAGE：worker-done 不结算；notify 不开下一跳', () => {
      assert.ok(/#677：成功路径不结算/.test(S.USAGE) && /不开下一跳救人/.test(S.USAGE),
        'USAGE #677  →  ' + S.USAGE.slice(S.USAGE.indexOf('worker-done --pr'), S.USAGE.indexOf('worker-done --pr') + 280));
    });

    await t.test('extractSoldierTerminal：terminal 为 null 时退到 handle', () => {
      const fx = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'orca-json', 'worker-show-completed.json'), 'utf8'));
      assert.ok(fx.result.terminal === null && S.extractSoldierTerminal(fx) === 'term_7e9c479f-36af-45eb-a0de-9c3ab0917d80',
        'completed 语料仍能取出终端  →  ' + S.extractSoldierTerminal(fx));
    });
  });

  it('#551 #552 闭环结算：worker_done 真结算、第二轮不往死信箱发', async (t) => {
    const S = await S_LOAD;
    const SETTLE = 'ctx_settle-0001';
    const TASK = 'task_settle-1';
    const FROM = 'term_live-0001';
    const completedFx = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'orca-json', 'worker-show-completed.json'), 'utf8'));

    const liveShow = {
      ok: true, result: {
        dispatch: { id: SETTLE, status: 'dispatched', assignee_handle: FROM, task_id: TASK, completed_at: null },
        worker: { state: 'working' },
      },
    };
    const doneShow = {
      ok: true, result: {
        dispatch: { id: SETTLE, status: 'completed', assignee_handle: FROM, task_id: TASK, completed_at: '2026-08-20 00:00:00' },
        worker: { state: 'succeeded' },
      },
    };

    function fakeSettleOrca({ wrongPane = false, settleNoop = false, showBroken = false, showBrokenAfter = false } = {}) {
      let seq = 0;
      let afterSend = false;
      return (a) => {
        const key = `${a[0]} ${a[1]}`;
        if (key === 'orchestration worker-show') {
          if (showBroken) return { ok: false, error: { code: 'timeout', message: 'worker-show timeout' } };
          if (showBrokenAfter && afterSend) return { ok: false, error: { code: 'timeout', message: 'worker-show timeout' } };
          const d = a[a.indexOf('--dispatch') + 1];
          if (d !== SETTLE) return { ok: false, error: { code: 'dispatch_not_found', message: `Worker Dispatch ${d} was not found.` } };
          if (afterSend && !settleNoop) return { ok: true, json: doneShow };
          return { ok: true, json: liveShow };
        }
        if (key === 'orchestration send') {
          if (wrongPane) {
            return { ok: false, error: { code: 'not_dispatch_pane', message: 'The caller is not the Dispatch pane' } };
          }
          afterSend = true;
          const to = a.includes('--to') ? a[a.indexOf('--to') + 1] : null;
          const id = `msg_settle${++seq}`;
          return { ok: true, json: { ok: true, result: { message: { id, to_handle: to, delivered_at: null } } } };
        }
        throw new Error(`假 orca 没登记这条命令: ${a.join(' ')}`);
      };
    }

    const missing = S.planWorkerDoneSend({ type: 'worker_done', outcome: 'succeeded' });
    await t.test('负样本一：缺 task-id/dispatch-id → 未结算', () => {
      assert.ok(missing.ok === false && /未结算/.test(missing.error) && /task-id/.test(missing.error) && /dispatch-id/.test(missing.error),
        '负样本一：缺 task-id/dispatch-id → 未结算  →  ' + JSON.stringify(missing));
    });
    const withTo = S.planWorkerDoneSend({
      type: 'worker_done', outcome: 'succeeded', taskId: TASK, dispatchId: SETTLE, to: `dispatch:${SETTLE}`,
    });
    await t.test('worker_done 带 --to → 未结算', () => {
      assert.ok(withTo.ok === false && /未结算/.test(withTo.error) && /不能带 --to/.test(withTo.error),
        'worker_done 带 --to → 未结算  →  ' + JSON.stringify(withTo));
    });
    const noOutcome = S.planWorkerDoneSend({ type: 'worker_done', taskId: TASK, dispatchId: SETTLE });
    await t.test('worker_done 缺 outcome → 未结算', () => {
      assert.ok(noOutcome.ok === false && /outcome/.test(noOutcome.error),
        'worker_done 缺 outcome → 未结算  →  ' + JSON.stringify(noOutcome));
    });

    const sendArgs = S.argsOrchestrationSend({
      subject: '本跳结束', type: 'worker_done', outcome: 'succeeded',
      taskId: TASK, dispatchId: SETTLE, from: FROM, dispatchCapability: 'dcap_x',
    });
    await t.test('worker_done 参数省略 --to，带 task-id/dispatch-id/from/capability', () => {
      assert.ok(!sendArgs.includes('--to') && sendArgs.includes('--task-id') && sendArgs.includes('--dispatch-id')
        && sendArgs.includes('--from') && sendArgs.includes('--dispatch-capability')
        && sendArgs.includes('--outcome') && sendArgs.includes('worker_done'),
        'worker_done 参数省略 --to，带 task-id/dispatch-id/from/capability  →  ' + sendArgs.join(' '));
    });

    const fromFx = S.readDispatchSettlement(completedFx);
    await t.test('真语料 worker-show-completed → settled（status=completed）', () => {
      assert.ok(fromFx.ok === true && fromFx.unscanned === false && fromFx.settled === true
        && fromFx.status === 'completed' && fromFx.dispatchId === 'ctx_adfee0055aef',
        '真语料 worker-show-completed → settled  →  ' + JSON.stringify(fromFx));
    });
    const fromLive = S.readDispatchSettlement(liveShow);
    await t.test('worker-show dispatched → 查到了但未结算（不是没查成）', () => {
      assert.ok(fromLive.ok === true && fromLive.unscanned === false && fromLive.settled === false
        && fromLive.status === 'dispatched',
        'worker-show dispatched → 查到了但未结算  →  ' + JSON.stringify(fromLive));
    });
    const fromEmpty = S.readDispatchSettlement({ ok: true, result: {} });
    await t.test('worker-show 缺 dispatch → unscanned，不是未 completed', () => {
      assert.ok(fromEmpty.ok === false && fromEmpty.unscanned === true && fromEmpty.settled === false,
        'worker-show 缺 dispatch → unscanned  →  ' + JSON.stringify(fromEmpty));
    });
    const fromNoStatus = S.readDispatchSettlement({ ok: true, result: { dispatch: { id: SETTLE } } });
    await t.test('worker-show 缺 status → unscanned（没查成 ≠ 0）', () => {
      assert.ok(fromNoStatus.ok === false && fromNoStatus.unscanned === true,
        'worker-show 缺 status → unscanned  →  ' + JSON.stringify(fromNoStatus));
    });

    const good = S.deliverMessage({
      type: 'worker_done', outcome: 'succeeded', subject: '本跳结束',
      taskId: TASK, dispatchId: SETTLE, from: FROM, hop: '审官结算',
      orca: fakeSettleOrca(),
    });
    await t.test('正样本：带完整身份 → Dispatch 变 completed', () => {
      assert.ok(good.ok === true && good.settled === true && good.stage === '已结算'
        && good.status === 'completed' && good.dispatchId === SETTLE,
        '正样本：带完整身份 → Dispatch 变 completed  →  ' + JSON.stringify(good));
    });

    const noop = S.deliverMessage({
      type: 'worker_done', outcome: 'succeeded', subject: '本跳结束',
      taskId: TASK, dispatchId: SETTLE, from: FROM, hop: '审官结算',
      orca: fakeSettleOrca({ settleNoop: true }),
    });
    await t.test('反例：落库但 Dispatch 仍 dispatched → 未结算，不得 ok:true', () => {
      assert.ok(noop.ok === false && noop.settled === false && !noop.unscanned
        && /未结算/.test(noop.error) && /落库无结算效力/.test(noop.error),
        '反例：落库但 Dispatch 仍 dispatched → 未结算  →  ' + JSON.stringify(noop));
    });

    const pane = S.deliverMessage({
      type: 'worker_done', outcome: 'succeeded', subject: '本跳结束',
      taskId: TASK, dispatchId: SETTLE, from: 'term_wrong', hop: '审官结算',
      orca: fakeSettleOrca({ wrongPane: true }),
    });
    await t.test('负样本二：错误 pane 发送 → 未结算', () => {
      assert.ok(pane.ok === false && pane.wrongPane === true && /未结算/.test(pane.error) && /错误 pane/.test(pane.error),
        '负样本二：错误 pane 发送 → 未结算  →  ' + JSON.stringify(pane));
    });

    const unscanned = S.deliverMessage({
      type: 'worker_done', outcome: 'succeeded', subject: '本跳结束',
      taskId: TASK, dispatchId: SETTLE, from: FROM, hop: '审官结算',
      orca: fakeSettleOrca({ showBroken: true }),
    });
    await t.test('结算前 worker-show 失败 → unscanned，不是查过未 completed', () => {
      assert.ok(unscanned.ok === false && unscanned.unscanned === true && /没查成/.test(unscanned.error),
        '结算前 worker-show 失败 → unscanned  →  ' + JSON.stringify(unscanned));
    });
    const unscannedAfter = S.deliverMessage({
      type: 'worker_done', outcome: 'succeeded', subject: '本跳结束',
      taskId: TASK, dispatchId: SETTLE, from: FROM, hop: '审官结算',
      orca: fakeSettleOrca({ showBrokenAfter: true }),
    });
    await t.test('发出后 worker-show 失败 → unscanned（没查成 ≠ 未变 completed）', () => {
      assert.ok(unscannedAfter.ok === false && unscannedAfter.unscanned === true && /没查成/.test(unscannedAfter.error),
        '发出后 worker-show 失败 → unscanned  →  ' + JSON.stringify(unscannedAfter));
    });

    const parsed = S.parseArgs([
      'node', 'dao.mjs', 'notify', '--type', 'worker_done', '--task-id', TASK,
      '--dispatch-id', SETTLE, '--outcome', 'succeeded', '--from', FROM, '--subject', '本跳结束',
    ]);
    await t.test('CLI parseArgs 透传 task-id/dispatch-id/from', () => {
      assert.ok(parsed.taskId === TASK && parsed.dispatchId === SETTLE && parsed.from === FROM
        && parsed.type === 'worker_done' && parsed.outcome === 'succeeded',
        'CLI parseArgs 透传 task-id/dispatch-id/from  →  ' + JSON.stringify(parsed));
    });

    const cliMiss = spawnSync(process.execPath, [
      CLI, 'notify', '--type', 'worker_done', '--outcome', 'succeeded', '--subject', '结算样本',
    ], { encoding: 'utf8', cwd: REPO });
    const pMiss = (() => { try { return JSON.parse((cliMiss.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI 缺身份 → 非零 + 报未结算', () => {
      assert.ok(cliMiss.status !== 0 && /未结算/.test(String(pMiss.error || cliMiss.stderr || ''))
        && /task-id/.test(String(pMiss.error || '')),
        'CLI 缺身份 → 非零 + 报未结算  →  ' + `status=${cliMiss.status} ${cliMiss.stderr} ${JSON.stringify(pMiss)}`);
    });
    const cliTo = spawnSync(process.execPath, [
      CLI, 'notify', '--type', 'worker_done', '--outcome', 'succeeded',
      '--task-id', TASK, '--dispatch-id', SETTLE, '--subject', '结算样本',
      '--to', 'dispatch:ctx_x',
    ], { encoding: 'utf8', cwd: REPO });
    const pTo = (() => { try { return JSON.parse((cliTo.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI worker_done 带 --to → 非零 + 报未结算', () => {
      assert.ok(cliTo.status !== 0 && /未结算/.test(String(pTo.error || cliTo.stderr || '')) && /--to/.test(String(pTo.error || '')),
        'CLI worker_done 带 --to → 非零 + 报未结算  →  ' + `status=${cliTo.status} ${JSON.stringify(pTo)}`);
    });

    const daoSrc = fs.readFileSync(CLI, 'utf8');
    await t.test('#552 worker-done 复用失败当场 fail，不吞掉再投死信箱', () => {
      assert.ok(/禁止回退已结算 dispatch/.test(daoSrc) && !/帅会另开复核 Task/.test(daoSrc),
        '#552 worker-done 复用失败当场 fail，不吞掉再投死信箱');
    });
    await t.test('#677 士兵任务书判定绿才 worker_done，过早结算会打进死人', () => {
      const brief = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'templates', 'soldier-book.md'), 'utf8');
      assert.ok(/判定绿之前不要发 worker_done/.test(brief) && /打进死人/.test(brief) && /#677/.test(brief),
        '#677 士兵任务书下班时机  →  ' + brief.slice(brief.indexOf('判定绿之前'), brief.indexOf('判定绿之前') + 80));
    });
    await t.test('#675 士兵任务书：待终审只在审官起来之后写', () => {
      const brief = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'templates', 'soldier-book.md'), 'utf8');
      assert.ok(/待终审.*worker-done/.test(brief.replace(/\s+/g, ' ')) && /审官没起来不许写/.test(brief),
        '#675 待终审纪律  →  ' + brief.slice(brief.indexOf('卡备注'), brief.indexOf('卡备注') + 200));
    });
  });

});
