// 派工 async-launch（2026-08-23 拍板，叠在 fire-and-forget + delete-all-ceremony 之上）：
// dispatch 热路只做四步——参数校验 → 写派工单到 _flow/queue/ → spawn detached 执行体
// （dao.mjs dispatch-exec，信箱台同款 detached）→ <1s 返回「已受理」。
// 消歧门 / 账本索引查重 / 队列在途查重 / 建卡 / 起终端 / 送字 / 打 label / 记账全在执行体，
// 结果落 _flow/queue/<id>.out.json（ok:false=拒派或已回滚）；开工/死亡确认交 watchdog 与 inbox.log。
// 删掉的旧层：就绪探针（waitForDevinInputBox/classifyDevinScreen/allowDevinWorkerStart/
// interpretTuiIdleWait/tui-idle 等待）、Devin 拆步（planWorkerStart/usesSplitStart）、
// 认账钟（DEVIN_WORKER_START_TIMEOUT_MS）、注入后开工验证（派工路的 finishWorkerInject）、
// 同厂闸（审官不存在时查空气；真闸在 reviewer-create/attach/worker-done）、每单环境自检、
// 同步看板（卡 comment 定界区 + master 全量重写）、gc 顺车（已删）、
// 热路全量 slate 打分（挪执行体，仅 --role 选型打；显式 --model 路由表序 + bans 门闩）、
// 热路全量账本查重（换 .dispatch-index 增量读，也在执行体）。
// 纯函数层：送字分类、dispatchId 找回、账本去重判定、派工单队列。不真起工人。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const DAO = path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs');
const CLI = path.join(REPO, 'scripts', 'dao.mjs');
const GATE = path.join(REPO, 'scripts', 'lib', 'dispatch-gate.mjs');
const LEDGER_QUERY = path.join(REPO, 'scripts', 'lib', 'ledger-query.mjs');
const DISPATCH_QUEUE = path.join(REPO, 'scripts', 'lib', 'dispatch-queue.mjs');
const FAKE_GH = path.join(REPO, 'tests', 'fixtures', 'fake-gh.mjs');
const S_LOAD = import('file://' + DAO.replace(/\\/g, '/'));
const GATE_LOAD = import('file://' + GATE.replace(/\\/g, '/'));
const LQ_LOAD = import('file://' + LEDGER_QUERY.replace(/\\/g, '/'));
const DQ_LOAD = import('file://' + DISPATCH_QUEUE.replace(/\\/g, '/'));

function payload(r) {
  try { return JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); }
  catch { return { raw: r.stdout, err: r.stderr }; }
}

// 等执行体结果文件落盘（detached 后台进程，冷启动 + 门控通常几秒）。
function waitForResult(resultPath, { timeoutMs = 60000, stepMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(resultPath)) return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    } catch { /* 写一半的瞬态，下一轮再读 */ }
    const wait = Math.min(stepMs, Math.max(0, deadline - Date.now()));
    if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  }
  return null;
}

describe('dispatch-launch（async-launch）', () => {
  it('worker-start 送字结果三分类', async (t) => {
    const S = await S_LOAD;

    await t.test('orca 报 ready（exit 0）= confirmed', () => {
      const r = S.classifyWorkerStartSend({ ok: true, json: { result: { dispatchId: 'ctx_1' } } });
      assert.ok(r.kind === 'confirmed', 'confirmed  →  ' + JSON.stringify(r));
    });

    const stallCases = [
      ['exit 1（dispatch_input / agent_prompt_stalled）', null],
      ['exit 1', { result: { lastError: 'agent_prompt_stalled', failedStage: 'dispatch_input' } }],
      ['outcome_unknown', null],
      ['timeout waiting for ready: agent_prompt_stalled', null],
    ];
    for (const [error, json] of stallCases) {
      await t.test(`认账假阴性 = sent-unconfirmed（${String(error).slice(0, 30)}）`, () => {
        const r = S.classifyWorkerStartSend({ ok: false, error, json });
        assert.ok(r.kind === 'sent-unconfirmed',
          'sent-unconfirmed  →  ' + JSON.stringify(r));
      });
    }

    const failCases = [
      'terminal_handle_stale',
      'tab_not_found',
      'agent_unconfigured: devin',
      'task_not_found',
      'run_required',
      'consumer_fenced',
      'exit 1（从没见过的新错误码）',
    ];
    for (const error of failCases) {
      await t.test(`传输/未知错误 = transport-failed（${error.slice(0, 24)}）`, () => {
        const r = S.classifyWorkerStartSend({ ok: false, error, json: null });
        assert.ok(r.kind === 'transport-failed',
          '不认识的错误不许静默吞进「已派未确认」  →  ' + JSON.stringify(r));
      });
    }
  });

  it('stalled 响应没带 dispatchId 时按 taskId 从 worker-list 找回（763 实证记账已落）', async (t) => {
    const S = await S_LOAD;
    const wl = { result: { workers: [
      { taskId: 'task_a', dispatchId: 'ctx_old' },
      { taskId: 'task_b', dispatchId: 'ctx_b' },
      { taskId: 'task_a', dispatchId: 'ctx_new' },
    ] } };

    await t.test('正常找回', () => {
      const r = S.findDispatchForTask(wl, 'task_b');
      assert.ok(r.ok === true && r.dispatchId === 'ctx_b', '找回  →  ' + JSON.stringify(r));
    });
    await t.test('同 taskId 多条取最新（数组尾）', () => {
      const r = S.findDispatchForTask(wl, 'task_a');
      assert.ok(r.ok === true && r.dispatchId === 'ctx_new', '取尾  →  ' + JSON.stringify(r));
    });
    await t.test('找不到 = ok:false（不是没查成）', () => {
      const r = S.findDispatchForTask(wl, 'task_none');
      assert.ok(r.ok === false && r.unscanned !== true && r.scanned === 3, '找不到  →  ' + JSON.stringify(r));
    });
    await t.test('结构不认识 = unscanned', () => {
      const r = S.findDispatchForTask({ ok: true }, 'task_a');
      assert.ok(r.ok === false && r.unscanned === true, 'unscanned  →  ' + JSON.stringify(r));
    });
    await t.test('没给 taskId = ok:false', () => {
      const r = S.findDispatchForTask(wl, '');
      assert.ok(r.ok === false, '空 taskId  →  ' + JSON.stringify(r));
    });
  });

  it('送字物理上限常量：15s，不是认账钟', async () => {
    const S = await S_LOAD;
    assert.ok(S.WORKER_START_SEND_TIMEOUT_MS === 15000,
      'WORKER_START_SEND_TIMEOUT_MS  →  ' + S.WORKER_START_SEND_TIMEOUT_MS);
  });

  it('probeWaitMs 不再有 devin 特判（就绪探针层已删）', async () => {
    const S = await S_LOAD;
    assert.ok(S.probeWaitMs({}, 'devin') === S.DEFAULT_PROBE_WAIT_MS
      && S.probeWaitMs({ providers: { devin: { probe_wait_ms: 42000 } } }, 'devin') === 42000,
      'probeWaitMs devin  →  ' + JSON.stringify({
        empty: S.probeWaitMs({}, 'devin'),
        override: S.probeWaitMs({ providers: { devin: { probe_wait_ms: 42000 } } }, 'devin'),
      }));
  });

  it('探针/认账层已从 dao-cmd.mjs 删净', async () => {
    const libSrc = fs.readFileSync(DAO, 'utf8');
    const gone = [
      'waitForDevinInputBox', 'classifyDevinScreen', 'allowDevinWorkerStart',
      'interpretTuiIdleWait', 'planWorkerStart', 'usesSplitStart', 'hasDevinReadyPrompt',
      'classifyInjectFailure',
      'DEVIN_WORKER_START_TIMEOUT_MS', 'DEVIN_PROBE_WAIT_MS', 'DEVIN_FIRST_READ_MS',
    ];
    for (const sym of gone) {
      assert.ok(!new RegExp(`\\b${sym}\\b`).test(libSrc), `dao-cmd.mjs 不该再有 ${sym}`);
    }
    // #762：argsTerminalWait 保留——command 型 TUI（devin/claude）起法 = wait tui-idle 就绪即送，
    // 是一次性等就绪（不是轮询探针）。见 docs/cli-notes/devin.md。
    assert.ok(new RegExp('\\bargsTerminalWait\\b').test(libSrc), 'dao-cmd.mjs 缺 argsTerminalWait（#762 command 型 TUI 就绪）');
    const kept = ['classifyWorkerStartSend', 'findDispatchForTask', 'WORKER_START_SEND_TIMEOUT_MS'];
    for (const sym of kept) {
      assert.ok(new RegExp(`\\b${sym}\\b`).test(libSrc), `dao-cmd.mjs 缺 ${sym}`);
    }
  });

  it('dao.mjs 派工主路：async-launch 热路/执行体分层，无就绪探针无认账轮询', async (t) => {
    const daoSrc = fs.readFileSync(CLI, 'utf8');
    const gone = [
      'waitForDevinInputBox', 'classifyDevinScreen', 'allowDevinWorkerStart',
      'interpretTuiIdleWait', 'planWorkerStart', 'usesSplitStart',
      'DEVIN_WORKER_START_TIMEOUT_MS', 'DEVIN_PROBE_WAIT_MS', 'DEVIN_FIRST_READ_MS',
      'ensureInboxStation',
    ];
    for (const sym of gone) {
      assert.ok(!new RegExp(`\\b${sym}\\b`).test(daoSrc), `dao.mjs 不该再有 ${sym}`);
    }
    // #762：argsTerminalWait 保留（command 型 TUI 一次性等就绪，非轮询探针）。

    // 热路段 = cmdDispatch 本体（到 cmdDispatchExec 为止）。
    const hi = daoSrc.indexOf('function cmdDispatch(');
    const he = daoSrc.indexOf('function cmdDispatchExec(');
    assert.ok(hi > 0 && he > hi, '热路段定位');
    const hot = daoSrc.slice(hi, he);
    await t.test('热路只做四步：写派工单 + spawn detached 执行体', () => {
      for (const sym of ['writeDispatchOrder(', 'spawnDispatchExecutor(', 'newDispatchOrderId(', 'dispatchQueueDir(']) {
        assert.ok(hot.includes(sym), `热路缺 ${sym}`);
      }
      assert.ok(/queued:\s*true/.test(hot) && /async:\s*true/.test(hot), '热路返回要带 queued/async 标记');
    });
    await t.test('热路不碰 orca / 不建卡 / 不送字 / 不记账 / 不同步打 label（全在执行体）', () => {
      for (const sym of ['argsWorktreeCreate(', 'startOrcaWorker(', 'startWorkerBySlate(',
        'applyGitIdentity(', 'failCreated(', 'bindStation(', 'taskCreateOnRun(',
        'stampIssueLabels(', 'writeJobDispatch(']) {
        assert.ok(!hot.includes(sym), `热路不该再有 ${sym}（同步脊残留）`);
      }
    });
    await t.test('热路不读全量账本打分：loadDispatchSlate 一律 live:false', () => {
      const m = hot.match(/loadDispatchSlate\(\{[\s\S]*?\}\)/);
      assert.ok(m && /live:\s*false/.test(m[0]), '热路 slate 加载必须 live:false（不读 441+ 账本文件）');
    });
    await t.test('#831 热路在写派工单之前走 assertDispatchInjectPlan（dry-run 也拦）', () => {
      const gateAt = hot.indexOf('assertDispatchInjectPlan(');
      const writeAt = hot.indexOf('writeDispatchOrder(');
      const dryAt = hot.indexOf('if (args.dryRun)');
      assert.ok(gateAt > 0, '热路缺 assertDispatchInjectPlan');
      assert.ok(writeAt > gateAt, '注入闸必须在写派工单之前');
      assert.ok(dryAt > gateAt, '注入闸必须在 dry-run 分支之前（dry-run 也要拦）');
    });

    // 执行体段 = runDispatchExecution 本体（到 cmdDispatchBatch 为止）。
    const xi = daoSrc.indexOf('function runDispatchExecution(');
    const xj = daoSrc.indexOf('function cmdDispatchBatch(');
    assert.ok(xi > 0 && xj > xi, '执行体段定位');
    const seg = daoSrc.slice(xi, xj);
    await t.test('执行体段保留：消歧门 / 账本查重 / 队列查重 / git 身份 / 送字 / 失败回滚 / 事后 label / 记账', () => {
      for (const sym of ['checkIssueDisambiguated', 'precheckDispatchDup', 'precheckQueueDup',
        'applyGitIdentity', 'startOrcaWorker', 'failCreated', 'stampIssueLabels', 'writeJobDispatch']) {
        assert.ok(new RegExp(`\\b${sym}\\b`).test(seg), `执行体段缺 ${sym}`);
      }
    });
    await t.test('执行体段删净：同厂闸 / 环境自检 / 同步看板 / gc 顺车', () => {
      for (const sym of ['filterSlateSameVendor', 'assertCrossVendor', 'envProbeWorktree',
        'rewriteMasterZone', 'afterDispatchComment', 'runGcReadonlyScan', 'gcThresholdLine', 'launchedGate']) {
        assert.ok(!new RegExp(`\\b${sym}\\b`).test(seg), `执行体段不该再有 ${sym}`);
      }
    });
    await t.test('#831 执行体段：同一道注入闸在建卡之前（防绕过热路直接 dispatch-exec）', () => {
      const gateAt = seg.indexOf('assertDispatchInjectPlan(');
      const createAt = seg.indexOf('argsWorktreeCreate(');
      assert.ok(gateAt > 0, '执行体缺 assertDispatchInjectPlan');
      assert.ok(createAt > gateAt, '执行体注入闸必须在 argsWorktreeCreate 之前');
      assert.ok(/buildSoldierInject\(/.test(seg), '执行体仍走 buildSoldierInject（闸在模板纯函数里，不是抄第二份）');
    });
    await t.test('执行体段：两道查重与消歧门都在建卡之前（拦截不碰 orca）', () => {
      assert.ok(seg.indexOf('precheckDispatchDup(') > 0
        && seg.indexOf('precheckDispatchDup(') < seg.indexOf('argsWorktreeCreate('),
        'precheckDispatchDup 必须在 argsWorktreeCreate 之前');
      assert.ok(seg.indexOf('precheckQueueDup(') > 0
        && seg.indexOf('precheckQueueDup(') < seg.indexOf('argsWorktreeCreate('),
        'precheckQueueDup 必须在 argsWorktreeCreate 之前');
      assert.ok(seg.indexOf('checkIssueDisambiguated(') > 0
        && seg.indexOf('checkIssueDisambiguated(') < seg.indexOf('argsWorktreeCreate('),
        '消歧门必须在建卡之前');
      assert.ok(/dup\.blocked/.test(seg) && /queueDup\.blocked/.test(seg) && /args\.allowDup/.test(seg),
        '两道命中都要有 blocked 拦截与 allowDup 入参');
      assert.ok(/--allow-dup/.test(daoSrc), '拦截话面要指 --allow-dup 逃生口');
    });
    await t.test('执行体段：startOrcaWorker 后无开工验证，带「已派未确认」话面', () => {
      assert.ok(!/finishWorkerInject|verifyStartedPolling|workerStartProof/.test(seg),
        '执行体段不该再有开工验证轮询');
      assert.ok(/已派，未确认/.test(seg) && /startOrcaWorker\(/.test(seg),
        '执行体要有 fire-and-forget 话面');
    });
    await t.test('执行体段：显式 --model 不打分（live:false），bans 门闩仍过滤回退链', () => {
      assert.ok(/live:\s*!gate\.model/.test(seg), '执行体选型打分只在 --role 路（live:!gate.model）');
      assert.ok(/bans\.yml/.test(seg) && /checkGates\(/.test(seg), '显式 --model 的 bans 过滤要在执行体');
    });
    await t.test('dispatch-exec 入口：读派工单 + 结果槽 + running 标记 + 崩溃补结果', () => {
      const ei = daoSrc.indexOf('function cmdDispatchExec(');
      const ej = daoSrc.indexOf('function precheckQueueDup(');
      assert.ok(ei > 0 && ej > ei, 'cmdDispatchExec 段定位');
      const eseg = daoSrc.slice(ei, ej);
      assert.ok(/readDispatchOrder\(/.test(eseg) && /setDispatchResultSink\(/.test(eseg)
        && /runDispatchExecution\(/.test(eseg) && /crashed:\s*true/.test(eseg),
        'cmdDispatchExec 要读单、设结果槽、跑执行体、崩了补 crashed 结果');
    });
    await t.test('dispatch-exec 动词注册进路由与参数表', () => {
      assert.ok(/case 'dispatch-exec': return cmdDispatchExec\(args\)/.test(daoSrc),
        'dao.mjs 路由缺 dispatch-exec');
      const libSrc = fs.readFileSync(DAO, 'utf8');
      assert.ok(/'dispatch-exec'/.test(libSrc) && libSrc.includes("'--order'"),
        'dao-cmd.mjs 的 VERBS/FLAGS_BY_VERB 缺 dispatch-exec --order');
    });
    await t.test('cmdDispatchBatch 段：startWorker 无注入后验证，同样删净四层', () => {
      const bi = daoSrc.indexOf('function cmdDispatchBatch(');
      const bj = daoSrc.indexOf('function cmdPrSyncLabels(');
      assert.ok(bi > 0 && bj > bi, 'cmdDispatchBatch 段定位');
      const bseg = daoSrc.slice(bi, bj);
      assert.ok(!/verifyStartedPolling|waitAndVerify/.test(bseg),
        'cmdDispatchBatch 段不该再有就绪探针/开工验证');
      for (const sym of ['envProbeWorktree', 'runGcReadonlyScan', 'afterDispatchComment', 'rewriteMasterZone']) {
        assert.ok(!new RegExp(`\\b${sym}\\b`).test(bseg), `cmdDispatchBatch 段不该再有 ${sym}`);
      }
    });
    await t.test('startWorkerBySlate 段：terminal create 成功即收，不就绪探针', () => {
      const si = daoSrc.indexOf('function startWorkerBySlate(');
      const sj = daoSrc.indexOf('function readOnceHandle(');
      assert.ok(si > 0 && sj > si, 'startWorkerBySlate 段定位');
      const sseg = daoSrc.slice(si, sj);
      assert.ok(!/waitAndVerify/.test(sseg), 'startWorkerBySlate 不该再有 waitAndVerify');
      assert.ok(/kind: 'deferred'/.test(sseg), '#802 成功 agent 路也要记 launchAttempt');
    });
    await t.test('#802 startOrcaWorker 按 agentIdentity 校准 handle，不是旧开工验证', () => {
      const si = daoSrc.indexOf('function startOrcaWorker(');
      const sj = daoSrc.indexOf('function startWorkerBySlate(');
      assert.ok(si > 0 && sj > si, 'startOrcaWorker 段定位');
      const sseg = daoSrc.slice(si, sj);
      assert.ok(/planDeferredRepair\(/.test(sseg), 'startOrcaWorker 要校准注入目标且缺 book fail-loud');
      assert.ok(!/finishWorkerInject|verifyStartedPolling/.test(sseg),
        '校准不是把开工验证轮询请回来');
    });
    await t.test('runGcReadonlyScan 函数本体已删（gc 顺车整层删，手动走 run-gc）', () => {
      assert.ok(!/function runGcReadonlyScan/.test(daoSrc), 'dao.mjs 不该再有 runGcReadonlyScan');
    });
  });

  it('派工去重：recentDispatchDup 纯函数三态与窗口', async (t) => {
    const LQ = await LQ_LOAD;
    const NOW = new Date('2026-08-23T12:10:00+08:00');
    let seq = 0;
    const ev = (over = {}) => ({
      type: 'job.dispatch',
      ts: '2026-08-23T12:05:00+08:00',
      machine: 'm1',
      seq: ++seq,
      event_id: `e${seq}`,
      job_id: `dispatch-ctx_${seq}`,
      model: 'grok-4.6',
      terminal: 'grok',
      source: 'dao-dispatch',
      issue_number: 759,
      card_name: 'ISSUE-#759 工人·grok-4.6 补 README',
      ...over,
    });

    await t.test('同 issue 窗口内未结 → 命中', () => {
      const r = LQ.recentDispatchDup([ev()], { issue: '759', terminal: 'grok', name: '别的卡名', now: NOW });
      assert.ok(r.ok === true && r.clear === false && r.hit && r.hit.issue_number === 759,
        '命中  →  ' + JSON.stringify(r));
    });
    await t.test('同 issue 超过 10 分钟窗口 → 放行', () => {
      const old = ev({ ts: '2026-08-23T11:50:00+08:00' });
      const r = LQ.recentDispatchDup([old], { issue: '759', now: NOW });
      assert.ok(r.ok === true && r.clear === true && r.hit === null, '放行  →  ' + JSON.stringify(r));
    });
    await t.test('窗口边界正好 10 分钟 → 仍算命中', () => {
      const edge = ev({ ts: '2026-08-23T12:00:00+08:00' });
      const r = LQ.recentDispatchDup([edge], { issue: '759', now: NOW });
      assert.ok(r.clear === false, '边界  →  ' + JSON.stringify(r));
    });
    await t.test('已 closed 的旧派工 → 放行（返工合法）', () => {
      const d = ev({ job_id: 'dispatch-ctx_done' });
      const c = { type: 'job.closed', ts: '2026-08-23T12:06:00+08:00', machine: 'm1', seq: 99, event_id: 'e99', job_id: 'dispatch-ctx_done' };
      const r = LQ.recentDispatchDup([d, c], { issue: '759', now: NOW });
      assert.ok(r.clear === true, '已结放行  →  ' + JSON.stringify(r));
    });
    await t.test('已 handoff 接续到 gh-pr-N 的旧派工 → 放行', () => {
      const d = ev({ job_id: 'dispatch-ctx_old' });
      const h = { type: 'job.handoff', kind: 'job_id_rename', ts: '2026-08-23T12:06:00+08:00', machine: 'm1', seq: 98, event_id: 'e98', from_job_id: 'dispatch-ctx_old', to_job_id: 'gh-pr-800' };
      const d2 = ev({ job_id: 'gh-pr-800', issue_number: null, pr_number: 800 });
      const r = LQ.recentDispatchDup([d, h, d2], { issue: '759', now: NOW });
      assert.ok(r.clear === true, '接续放行  →  ' + JSON.stringify(r));
    });
    await t.test('无 issue 时同终端+同卡名 → 命中；不同卡名 → 放行', () => {
      const noIssue = ev({ issue_number: null, job_id: 'dispatch-ctx_ni' });
      const hit = LQ.recentDispatchDup([noIssue], { terminal: 'grok', name: 'ISSUE-#759 工人·grok-4.6 补 README', now: NOW });
      assert.ok(hit.clear === false, '同终端同名命中  →  ' + JSON.stringify(hit));
      const miss = LQ.recentDispatchDup([noIssue], { terminal: 'grok', name: '另一张卡', now: NOW });
      assert.ok(miss.clear === true, '不同名放行  →  ' + JSON.stringify(miss));
      const otherTerm = LQ.recentDispatchDup([noIssue], { terminal: 'cursor', name: 'ISSUE-#759 工人·grok-4.6 补 README', now: NOW });
      assert.ok(otherTerm.clear === true, '不同终端放行  →  ' + JSON.stringify(otherTerm));
    });
    await t.test('给了 issue 就只按 issue 查（卡名不补刀）', () => {
      const other = ev({ issue_number: 760 });
      const r = LQ.recentDispatchDup([other], { issue: '759', terminal: 'grok', name: other.card_name, now: NOW });
      assert.ok(r.clear === true, '不同 issue 放行  →  ' + JSON.stringify(r));
    });
    await t.test('ts 解析不了的 dispatch 跳过并计数显形', () => {
      const bad = ev({ ts: 'not-a-date' });
      const r = LQ.recentDispatchDup([bad], { issue: '759', now: NOW });
      assert.ok(r.clear === true && r.skippedBadTs === 1, '坏 ts 显形  →  ' + JSON.stringify(r));
    });
    await t.test('events 不是数组 → 没查成（第三态）', () => {
      const r = LQ.recentDispatchDup(null, { issue: '759', now: NOW });
      assert.ok(r.ok === false && r.unscanned === true, '没查成  →  ' + JSON.stringify(r));
    });
    await t.test('窗口常量 = 10 分钟', () => {
      assert.ok(LQ.DISPATCH_DEDUP_WINDOW_MS === 10 * 60 * 1000,
        'DISPATCH_DEDUP_WINDOW_MS  →  ' + LQ.DISPATCH_DEDUP_WINDOW_MS);
    });
  });

  it('派工单队列（dispatch-queue.mjs）：写读回环 / 状态派生 / 队列查重三态', async (t) => {
    const DQ = await DQ_LOAD;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-dq-'));
    const NOW = new Date('2026-08-23T12:10:00+08:00');

    await t.test('写派工单 → 读回（kind 校验），同 id 一组文件路径齐', () => {
      const w = DQ.writeDispatchOrder({
        dir, id: 'dq-test-0001', now: NOW,
        args: { name: 'x', issue: '565' }, plan: { workerCard: '卡A' },
        dedup: { issue: '565', terminal: 'grok', name: '卡A' },
      });
      assert.ok(w.ok === true && fs.existsSync(w.paths.order), '写单  →  ' + JSON.stringify(w));
      const r = DQ.readDispatchOrder(w.paths.order);
      assert.ok(r.ok === true && r.order.id === 'dq-test-0001' && r.order.kind === DQ.DISPATCH_ORDER_KIND
        && r.order.dedup.issue === '565', '读回  →  ' + JSON.stringify(r.ok && r.order.dedup));
      assert.ok(/dq-test-0001\.running$/.test(w.paths.running)
        && /dq-test-0001\.out\.json$/.test(w.paths.result)
        && /dq-test-0001\.out\.log$/.test(w.paths.log), '随单文件路径  →  ' + JSON.stringify(w.paths));
    });

    await t.test('kind 对不上 / 坏 JSON = 不是派工单', () => {
      const bad = path.join(dir, 'bad.json');
      fs.writeFileSync(bad, JSON.stringify({ kind: '别的', id: 'x' }));
      assert.ok(DQ.readDispatchOrder(bad).ok === false, 'kind 对不上要拒');
      fs.writeFileSync(bad, 'not json');
      assert.ok(DQ.readDispatchOrder(bad).ok === false, '坏 JSON 要拒');
    });

    await t.test('单状态派生：pending → running → done/failed', () => {
      const id = 'dq-test-st';
      DQ.writeDispatchOrder({ dir, id, now: NOW, args: {}, plan: {}, dedup: {} });
      const readR = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
      assert.ok(DQ.dispatchOrderStatus(dir, id, { readResult: readR }) === 'pending', '初始 pending');
      fs.writeFileSync(DQ.dispatchOrderPaths(dir, id).running, '{}');
      assert.ok(DQ.dispatchOrderStatus(dir, id, { readResult: readR }) === 'running', '有标记 running');
      fs.writeFileSync(DQ.dispatchOrderPaths(dir, id).result, JSON.stringify({ ok: true }));
      assert.ok(DQ.dispatchOrderStatus(dir, id, { readResult: readR }) === 'done', 'ok:true → done');
      fs.writeFileSync(DQ.dispatchOrderPaths(dir, id).result, JSON.stringify({ ok: false }));
      assert.ok(DQ.dispatchOrderStatus(dir, id, { readResult: readR }) === 'failed', 'ok:false → failed');
    });

    await t.test('listDispatchOrders 只认 <id>.json 本体，随单文件不混入', () => {
      const listed = DQ.listDispatchOrders(dir, { readResult: (p) => JSON.parse(fs.readFileSync(p, 'utf8')) });
      assert.ok(listed.ok === true && listed.unscanned === false, '列队  →  ' + JSON.stringify(listed));
      const ids = listed.orders.map(o => o.id);
      assert.ok(ids.includes('dq-test-0001') && ids.includes('dq-test-st') && ids.length === 2,
        '只列本体  →  ' + ids.join(','));
      const st = listed.orders.find(o => o.id === 'dq-test-st');
      assert.ok(st.status === 'failed' && st.issue === null, '状态与 dedup 透出  →  ' + JSON.stringify(st));
    });

    await t.test('队列查重：在窗同 issue 的 pending/running/done 单命中，failed 不拦', () => {
      const mk = (id, ts, over = {}) => ({ id, ts, issue: '565', terminal: 'grok', name: '卡A', status: 'pending', ...over });
      const inWin = mk('dq-a', '2026-08-23T12:05:00+08:00');
      const hit = DQ.recentQueueDup([inWin], { issue: '565', now: NOW });
      assert.ok(hit.ok === true && hit.clear === false && hit.hit.order_id === 'dq-a', '同 issue 命中  →  ' + JSON.stringify(hit));
      const doneHit = DQ.recentQueueDup([mk('dq-b', '2026-08-23T12:05:00+08:00', { status: 'done' })], { issue: '565', now: NOW });
      assert.ok(doneHit.clear === false, 'done 单仍拦（已派成，账本马上会有）');
      const failedPass = DQ.recentQueueDup([mk('dq-c', '2026-08-23T12:05:00+08:00', { status: 'failed' })], { issue: '565', now: NOW });
      assert.ok(failedPass.clear === true, 'failed 不拦（没派成，重派合法）');
      const stale = DQ.recentQueueDup([mk('dq-d', '2026-08-23T11:50:00+08:00')], { issue: '565', now: NOW });
      assert.ok(stale.clear === true, '窗口外放行');
      const other = DQ.recentQueueDup([mk('dq-e', '2026-08-23T12:05:00+08:00', { issue: '560' })], { issue: '565', now: NOW });
      assert.ok(other.clear === true, '不同 issue 放行');
      const self = DQ.recentQueueDup([inWin], { issue: '565', now: NOW, selfId: 'dq-a' });
      assert.ok(self.clear === true, 'selfId 排除自己');
    });

    await t.test('队列查重：无 issue 时同终端+同卡名才命中；入参非法 = 没查成', () => {
      const o = { id: 'dq-f', ts: '2026-08-23T12:05:00+08:00', issue: null, terminal: 'grok', name: '卡A', status: 'running' };
      const hit = DQ.recentQueueDup([o], { terminal: 'grok', name: '卡A', now: NOW });
      assert.ok(hit.clear === false, '同终端同名命中');
      const miss = DQ.recentQueueDup([o], { terminal: 'grok', name: '卡B', now: NOW });
      assert.ok(miss.clear === true, '不同名放行');
      const bad = DQ.recentQueueDup(null, { issue: '565', now: NOW });
      assert.ok(bad.ok === false && bad.unscanned === true, '没给数组 = 没查成');
    });

    await t.test('spawnDispatchExecutor：detached + stdio 进日志 + unref', () => {
      const calls = [];
      const fakeSpawn = (exe, argv, opts) => {
        calls.push({ exe, argv, opts });
        return { pid: 43210, unref() { this.unrefCalled = true; } };
      };
      const logPath = path.join(dir, 'spawn-test.out.log');
      const r = DQ.spawnDispatchExecutor({
        scriptPath: path.join(REPO, 'scripts', 'dao.mjs'),
        orderPath: path.join(dir, 'dq-x.json'),
        logPath, cwd: REPO, spawnFn: fakeSpawn,
      });
      assert.ok(r.ok === true && r.pid === 43210, 'spawn 返回 pid  →  ' + JSON.stringify(r));
      assert.ok(calls.length === 1, 'spawnFn 调一次');
      const c = calls[0];
      assert.ok(c.argv.includes('dispatch-exec') && c.argv.includes('--order'), 'argv 带 dispatch-exec --order  →  ' + c.argv.join(' '));
      assert.ok(c.opts.detached === true && c.opts.windowsHide !== true, 'detached，不再传 windowsHide');
      assert.ok(Array.isArray(c.opts.stdio) && c.opts.stdio[1] !== 'ignore' && c.opts.stdio[2] !== 'ignore',
        'stdout/stderr 进日志 fd');
      assert.ok(fs.existsSync(logPath), '日志文件已开');
    });

    await t.test('spawnDispatchExecutor：spawn 抛错 = ok:false（不抛穿热路）', () => {
      const r = DQ.spawnDispatchExecutor({
        scriptPath: 'x', orderPath: 'y', logPath: null,
        spawnFn: () => { throw new Error('ENOENT 演示'); },
      });
      assert.ok(r.ok === false && /ENOENT/.test(r.error), 'spawn 失败三态  →  ' + JSON.stringify(r));
    });
  });

  it('派工去重 CLI（async-launch）：热路秒级受理；命中由执行体拒派落结果文件', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-dedup-'));
    const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-dq-cli-'));
    const seed = {
      type: 'job.dispatch', ts: '2026-08-23T12:05:00+08:00', machine: 'm1', seq: 1,
      event_id: 'e1', job_id: 'dispatch-ctx_seed', model: 'grok-4.6', terminal: 'grok',
      source: 'dao-dispatch', issue_number: 565, card_name: 'ISSUE-#565 工人·grok-4.6 x',
    };
    fs.writeFileSync(path.join(dir, '2026-08-23T12-05-00_m1_1.json'), JSON.stringify(seed));
    const env = {
      ...process.env, DAO_GH_FAKE: FAKE_GH,
      LEDGER_EVENTS_DIR: dir, DAO_DISPATCH_QUEUE_DIR: queueDir,
    };
    const base = [
      CLI, 'dispatch', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm',
      '--name', 'x', '--spec', '短摘要', '--split', 'no', '--split-reason', '单测', '--issue', '565',
    ];

    const t0 = Date.now();
    const dry = spawnSync(process.execPath, [...base, '--dry-run', '--now', '2026-08-23T12:06:00+08:00'], { encoding: 'utf8', cwd: REPO, env });
    const dryMs = Date.now() - t0;
    const pDry = payload(dry);
    await t.test('dry-run 透出 dup 命中但不拦预览', () => {
      assert.ok(dry.status === 0 && pDry.ok === true && pDry.dup && pDry.dup.clear === false && pDry.dup.hit,
        'dry-run dup  →  ' + JSON.stringify(pDry.dup || pDry));
    });
    await t.test(`预检路径几秒钟出结果（dry-run 全程 ${dryMs}ms < 15s）`, () => {
      assert.ok(dryMs < 15000, `dry-run 耗时 ${dryMs}ms，超过 15s——事前层又厚了`);
    });

    // async-launch 核心断言一：热路秒级返回「已受理」（NO_SPAWN 隔掉 spawn，纯热路计时）。
    // 阈值 3s 不是 1s：计时含 node 冷启动，dao-check 的 6 宽测试池挤压下实测到过 1027ms
    //（单跑 ~600ms）；要防的「同步脊长回来」是数秒到数十秒级（orca 往返/读全量账本），
    // 3s 对它照样红，对池挤压不再误伤——墙钟断言的余量要按最吵的运行环境给。
    const t1 = Date.now();
    const noSpawn = spawnSync(process.execPath, [...base, '--now', '2026-08-23T12:06:00+08:00'], {
      encoding: 'utf8', cwd: REPO, env: { ...env, DAO_DISPATCH_NO_SPAWN: '1' },
    });
    const hotMs = Date.now() - t1;
    const pNoSpawn = payload(noSpawn);
    await t.test(`热路 <3s 返回（实测 ${hotMs}ms）：queued/async/orderId 齐，派工单落队列目录`, () => {
      assert.ok(noSpawn.status === 0 && pNoSpawn.ok === true && pNoSpawn.queued === true && pNoSpawn.async === true,
        '受理回执  →  ' + JSON.stringify(pNoSpawn).slice(0, 300));
      assert.ok(typeof pNoSpawn.orderId === 'string' && /^dq-/.test(pNoSpawn.orderId), 'orderId  →  ' + pNoSpawn.orderId);
      assert.ok(pNoSpawn.spawnSkipped === true, 'NO_SPAWN 测试口要透出 spawnSkipped');
      assert.ok(String(pNoSpawn.orderPath).startsWith(queueDir), '派工单必须落 DAO_DISPATCH_QUEUE_DIR（隔真仓）  →  ' + pNoSpawn.orderPath);
      assert.ok(fs.existsSync(pNoSpawn.orderPath), '派工单文件在');
      assert.ok(hotMs < 3000, `热路耗时 ${hotMs}ms，超过 3s——同步脊又长回来了`);
    });

    // async-launch 核心断言二：执行体后台跑，查重命中 → 结果文件落 ok:false（拦在 orca 之前）。
    const accepted = spawnSync(process.execPath, [...base, '--now', '2026-08-23T12:06:00+08:00'], { encoding: 'utf8', cwd: REPO, env });
    const pAcc = payload(accepted);
    await t.test('真派工不再当场拒：exit 0 受理，返回 resultPath', () => {
      assert.ok(accepted.status === 0 && pAcc.ok === true && pAcc.queued === true
        && typeof pAcc.resultPath === 'string' && pAcc.resultPath.startsWith(queueDir),
        '受理  →  ' + JSON.stringify(pAcc).slice(0, 300));
    });
    const result = pAcc.resultPath ? waitForResult(pAcc.resultPath) : null;
    await t.test('执行体后台拒派：结果 ok:false，dup.blocked，话面点名 #759 与 --allow-dup', () => {
      assert.ok(result, `执行体结果 60s 没落盘（${pAcc.resultPath}）——执行体没跑或崩了`);
      assert.ok(result.ok === false && result.dup && result.dup.blocked === true
        && /重复派工|重复建卡|#759/.test(String(result.error || ''))
        && /--allow-dup/.test(String(result.error || '')),
        '执行体拦截  →  ' + JSON.stringify(result).slice(0, 400));
      assert.ok(!result.workerId && !result.workerPath, '被拦时什么都不会创建');
    });
    await t.test('结果落盘后 running 标记已删（单状态能派生 done/failed）', () => {
      const runningPath = String(pAcc.resultPath).replace(/\.out\.json$/, '.running');
      assert.ok(!fs.existsSync(runningPath), 'running 标记还在 = 执行体收尾没跑  →  ' + runningPath);
    });

    const stale = spawnSync(process.execPath, [...base, '--dry-run', '--now', '2026-08-23T13:00:00+08:00'], { encoding: 'utf8', cwd: REPO, env });
    const pStale = payload(stale);
    await t.test('窗口外 → dup.clear 放行', () => {
      assert.ok(stale.status === 0 && pStale.dup && pStale.dup.clear === true,
        '窗口外  →  ' + JSON.stringify(pStale.dup || pStale));
    });

    const allowed = spawnSync(process.execPath, [...base, '--dry-run', '--now', '2026-08-23T12:06:00+08:00', '--allow-dup'], { encoding: 'utf8', cwd: REPO, env });
    const pAllowed = payload(allowed);
    await t.test('--allow-dup 显式跳过：命中仍透出但不 blocked', () => {
      assert.ok(allowed.status === 0 && pAllowed.dup && pAllowed.dup.clear === false && pAllowed.dup.blocked !== true,
        '--allow-dup  →  ' + JSON.stringify(pAllowed.dup || pAllowed));
    });
  });

  it('队列在途查重 CLI：账本还看不见第一单时，第二单的执行体被派工单拦住', async (t) => {
    // 空账本（账本查重必 clear）+ 消歧过（565 有 label）→ 唯一拦路的是队列里的 pending 单。
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-dedup-empty-'));
    const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-dq-inflight-'));
    const env = {
      ...process.env, DAO_GH_FAKE: FAKE_GH,
      LEDGER_EVENTS_DIR: ledgerDir, DAO_DISPATCH_QUEUE_DIR: queueDir,
    };
    const base = [
      CLI, 'dispatch', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm',
      '--name', 'x', '--spec', '短摘要', '--split', 'no', '--split-reason', '单测', '--issue', '565',
    ];

    const first = spawnSync(process.execPath, [...base], {
      encoding: 'utf8', cwd: REPO, env: { ...env, DAO_DISPATCH_NO_SPAWN: '1' },
    });
    const pFirst = payload(first);
    await t.test('第一单 NO_SPAWN 留下 pending 派工单（模拟在途）', () => {
      assert.ok(first.status === 0 && pFirst.queued === true && fs.existsSync(pFirst.orderPath),
        '第一单  →  ' + JSON.stringify(pFirst).slice(0, 240));
    });

    const second = spawnSync(process.execPath, [...base], { encoding: 'utf8', cwd: REPO, env });
    const pSecond = payload(second);
    const result = pSecond.resultPath ? waitForResult(pSecond.resultPath) : null;
    await t.test('第二单执行体：账本 clear 但 queueDup.blocked（#759 第二道闸）', () => {
      assert.ok(second.status === 0 && pSecond.queued === true, '第二单受理  →  ' + JSON.stringify(pSecond).slice(0, 240));
      assert.ok(result, `执行体结果 60s 没落盘（${pSecond.resultPath}）`);
      assert.ok(result.ok === false && result.queueDup && result.queueDup.blocked === true
        && result.dup && result.dup.clear === true
        && /派工单 dq-/.test(String(result.error || '')) && /--allow-dup/.test(String(result.error || '')),
        '队列拦截  →  ' + JSON.stringify(result).slice(0, 400));
      assert.ok(!result.workerId, '被拦时什么都没创建');
    });
  });

  it('#831 注入闸前移到热路：超长 --spec 当场非零，一棵树都不建', async (t) => {
    const S = await S_LOAD;
    const prefix = '读 host/skills/dispatch/templates/soldier-book.md spec=';
    const prefixBytes = S.injectUtf8Bytes(prefix);
    const over = 'x'.repeat(S.INJECT_MAX_BYTES - prefixBytes + 1);

    await t.test('纯函数：短 spec 放行，超长说清超了多少字节', () => {
      const ok = S.assertDispatchInjectPlan({ spec: '短摘要' });
      assert.ok(ok.ok === true, '短 spec  →  ' + JSON.stringify(ok));
      const noSpec = S.assertDispatchInjectPlan({ spec: '' });
      assert.ok(noSpec.ok === true && noSpec.skipped === true, '无 spec 跳过  →  ' + JSON.stringify(noSpec));
      const bad = S.assertDispatchInjectPlan({ spec: over });
      assert.ok(bad.ok === false && /上限/.test(bad.error) && /士兵注入/.test(bad.error),
        '超长  →  ' + JSON.stringify(bad));
      const m = String(bad.error).match(/注入 (\d+) 字节超过上限 (\d+)/);
      assert.ok(m && Number(m[1]) > Number(m[2]), '话面要带实际字节与上限  →  ' + bad.error);
    });

    await t.test('纯函数：热路与执行体调的是同一导出，不是抄两份', () => {
      const daoSrc = fs.readFileSync(CLI, 'utf8');
      const hits = daoSrc.match(/assertDispatchInjectPlan\(/g) || [];
      assert.ok(hits.length >= 2, `dao.mjs 热路+执行体都应调用，实际 ${hits.length}`);
      const tmpl = fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'dispatch', 'template.mjs'), 'utf8');
      assert.ok(/export function assertDispatchInjectPlan/.test(tmpl),
        '闸本体只在 template.mjs');
      assert.ok(!/function assertDispatchInjectPlan/.test(daoSrc),
        'dao.mjs 不许再定义一份');
    });

    const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-831-q-'));
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-831-l-'));
    const env = {
      ...process.env, DAO_GH_FAKE: FAKE_GH,
      LEDGER_EVENTS_DIR: ledgerDir, DAO_DISPATCH_QUEUE_DIR: queueDir,
    };
    const base = [
      CLI, 'dispatch', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm',
      '--name', 'x', '--split', 'no', '--split-reason', '单测', '--issue', '565',
    ];

    const dry = spawnSync(process.execPath, [...base, '--spec', over, '--dry-run'], {
      encoding: 'utf8', cwd: REPO, env,
    });
    const pDry = payload(dry);
    await t.test('--dry-run 超长 --spec 当场非零，话面带字节数', () => {
      assert.ok(dry.status !== 0 && pDry.ok === false && /上限/.test(String(pDry.error || '')),
        'dry-run  →  ' + JSON.stringify(pDry).slice(0, 400));
      assert.ok(/注入 \d+ 字节超过上限 500/.test(String(pDry.error || '')),
        '要说清超了多少  →  ' + pDry.error);
      assert.ok(!pDry.queued && !pDry.dryRun, '不合格不许冒充已受理/预览过');
    });

    const before = fs.readdirSync(queueDir);
    const hot = spawnSync(process.execPath, [...base, '--spec', over], {
      encoding: 'utf8', cwd: REPO, env: { ...env, DAO_DISPATCH_NO_SPAWN: '1' },
    });
    const pHot = payload(hot);
    const after = fs.readdirSync(queueDir);
    await t.test('真 dispatch 超长 --spec 热路非零，不写派工单（执行体起不来，一棵树都不建）', () => {
      assert.ok(hot.status !== 0 && pHot.ok === false && /上限/.test(String(pHot.error || '')),
        '热路  →  ' + JSON.stringify(pHot).slice(0, 400));
      assert.ok(!pHot.queued, '不合格不许 queued:true');
      assert.ok(after.length === before.length,
        `不该写下派工单  before=${before.join(',')} after=${after.join(',')}`);
    });

    // 绕过热路：手工写派工单再跑 dispatch-exec，执行体同一道闸仍拦在建卡前。
    const DQ = await DQ_LOAD;
    const id = 'dq-831-bypass';
    const written = DQ.writeDispatchOrder({
      dir: queueDir, id, now: new Date('2026-09-03T12:00:00+08:00'),
      args: {
        name: 'x', issue: '565', spec: over, model: 'grok-4.6', reviewer: 'gpt-5.6-sol',
        confirm: true, split: 'no', splitReason: '单测',
      },
      plan: { workerCard: '卡A' },
      dedup: { issue: '565', terminal: 'pi', name: '卡A' },
    });
    assert.ok(written.ok, '写绕过单  →  ' + JSON.stringify(written));
    const exec = spawnSync(process.execPath, [CLI, 'dispatch-exec', '--order', written.paths.order], {
      encoding: 'utf8', cwd: REPO, env,
    });
    const pExec = payload(exec);
    await t.test('dispatch-exec 绕过热路：同一道闸仍非零，不建卡', () => {
      assert.ok(exec.status !== 0 && pExec.ok === false && /上限/.test(String(pExec.error || '')),
        'exec  →  ' + JSON.stringify(pExec).slice(0, 400));
      assert.ok(!pExec.workerId && !pExec.workerPath, '被拦时什么都不会创建');
    });
  });

  it('闸口：裸 worker-start 仍拦，dao 入口不拦', async (t) => {
    const { isDispatchBypass } = await GATE_LOAD;
    await t.test('裸 worker-start 仍是旁路', () => {
      assert.ok(isDispatchBypass('orca orchestration worker-start --task t --terminal term_d') === true);
    });
    await t.test('dao.mjs dispatch 不是旁路', () => {
      assert.ok(isDispatchBypass('node scripts/dao.mjs dispatch --name x') === false);
    });
    await t.test('terminal create/send 单独跑不算派工旁路（必须走 dao 入口才有 Dispatch）', () => {
      assert.ok(isDispatchBypass('orca terminal create --command "devin --model x"') === false
        && isDispatchBypass('orca terminal send --text hi --enter') === false);
    });
  });

  it('catalog 不再有 terminal wait（探针命令已退役），仍有 terminal send', async (t) => {
    const S = await S_LOAD;
    const catalog = S.catalogUsedFlags();
    const wait = catalog.find(c => c.cmd === 'terminal wait');
    await t.test('catalogUsedFlags 扫不到 terminal wait', () => {
      assert.ok(!wait, 'catalog 不该再有 terminal wait  →  ' + JSON.stringify(wait));
    });
    const send = catalog.find(c => c.cmd === 'terminal send');
    await t.test('terminal send 仍在（送字传输命令）', () => {
      assert.ok(send && send.flags.includes('--text') && send.flags.includes('--enter'),
        'catalog send  →  ' + JSON.stringify(send));
    });
  });
});
