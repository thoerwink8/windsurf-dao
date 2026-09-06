// tests/dao-orca-surface.test.js —— dao 对 orca 的面
//
// 2026-09-06 从 dao.test.js 拆出（原 4220 行 / 1058 用例一个文件）。
// 本套管：探针分态 / builder 逃生口 / 真语料解析 / 空壳与 consumer_fenced
// 共享前置在 tests/helpers/dao-harness.js，各套逐字复用，行为与拆分前一致。

const { describe, it } = require('node:test');
const { assert, fs, os, path, spawnSync, REPO, CLI, LIB, S_LOAD, DAO_LOAD, cliInProc, ROUTING_LOAD, waitForOutJson } = require('./helpers/dao-harness');

describe('dao 对 orca 的面', () => {
  it('R1 R3 R4 R6 探针 / 未知参数 / 读失败分态 / 回滚', async (t) => {
    const S = await S_LOAD;
    const routing = await ROUTING_LOAD;
    const allOk = S.runCapabilityProbes({ exec: (n) => ({ ok: true, name: n }) });
    await t.test('R1 三项探针都过', () => {
      assert.ok(allOk.ok === true && allOk.failed.length === 0, 'R1 三项探针都过  →  ' + JSON.stringify(allOk));
    });
    const noWrite = S.runCapabilityProbes({ exec: (n) => ({ ok: n !== 'write' }) });
    await t.test('R1 不能写文件 → 点名缺能写文件', () => {
      assert.ok(noWrite.ok === false && noWrite.failed.includes('write') && /能写文件/.test(noWrite.error), 'R1 不能写文件 → 点名缺能写文件  →  ' + JSON.stringify(noWrite));
    });
    const noNode = S.runCapabilityProbes({ exec: (n) => ({ ok: n !== 'node' }) });
    await t.test('R1 不能跑 node → 点名缺能跑 node', () => {
      assert.ok(noNode.ok === false && /能跑 node/.test(noNode.error), 'R1 不能跑 node → 点名缺能跑 node  →  ' + JSON.stringify(noNode));
    });
    const noGh = S.runCapabilityProbes({ exec: (n) => ({ ok: n !== 'gh' }) });
    await t.test('R1 不能调 gh → 点名缺能调 gh', () => {
      assert.ok(noGh.ok === false && /能调 gh/.test(noGh.error), 'R1 不能调 gh → 点名缺能调 gh  →  ' + JSON.stringify(noGh));
    });

    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-empty-'));
    const hostOnEmpty = S.runCapabilityProbes({ exec: S.hostProbeExec(emptyDir) });
    await t.test('判别力：空目录上 hostProbe 仍绿（验错主体）', () => {
      assert.ok(hostOnEmpty.ok === true, '判别力：空目录上 hostProbe 仍绿（验错主体）  →  ' + JSON.stringify(hostOnEmpty));
    });
    const termEmpty = S.runCapabilityProbes({
      exec: S.terminalProbeExec({ sendAndRead: () => ({ text: 'Working...' }) }),
    });
    await t.test('R1 终端无真执行标记 → 探针红', () => {
      assert.ok(termEmpty.ok === false && termEmpty.failed.length === 3, 'R1 终端无真执行标记 → 探针红  →  ' + JSON.stringify(termEmpty));
    });

    const echoOnly = S.runCapabilityProbes({
      exec: S.terminalProbeExec({
        sendAndRead: (cmd) => ({ text: `• Ran ${cmd}\nrejected: blocked by policy` }),
      }),
    });
    await t.test('R1 命令回显+policy 拦 → 三项都红（自证不绿）', () => {
      assert.ok(echoOnly.ok === false && echoOnly.failed.length === 3, 'R1 命令回显+policy 拦 → 三项都红（自证不绿）  →  ' + JSON.stringify(echoOnly));
    });

    const corpus = '• Ran gh --version\nrejected: blocked by policy';
    await t.test('R1 帅语料：Ran gh --version + blocked by policy ≠ 能调 gh', () => {
      assert.ok(S.probeMarkFound('gh', corpus) === false, 'R1 帅语料：Ran gh --version + blocked by policy ≠ 能调 gh');
    });

    for (const name of ['write', 'node', 'gh']) {
      await t.test(`R1 命令原文不含 ${name} 真执行标记`, () => {
        assert.ok(S.probeMarkFound(name, S.probeCommand(name)) === false, `R1 命令原文不含 ${name} 真执行标记  →  ` + S.probeCommand(name));
      });
    }

    const termOk = S.runCapabilityProbes({
      exec: S.terminalProbeExec({
        sendAndRead: (cmd) => {
          if (/gh --version/.test(cmd)) return { text: 'gh version 2.82.1 (2026-01-15)' };
          if (/writeFileSync/.test(cmd)) return { text: 'W1734123456789' };
          return { text: 'N1734123456789' };
        },
      }),
    });
    await t.test('R1 真执行标记出现 → 三项过', () => {
      assert.ok(termOk.ok === true, 'R1 真执行标记出现 → 三项过  →  ' + JSON.stringify(termOk));
    });
    await t.test('R1 写/node/gh 标记互相独立', () => {
      assert.ok(S.probeMarkFound('write', 'N1734123456789') === false && S.probeMarkFound('gh', 'W1734123456789') === false, 'R1 写/node/gh 标记互相独立');
    });

    await t.test('R1 写探针命令含 finally+unlink', () => {
      assert.ok(/finally/.test(S.probeCommand('write')) && /unlinkSync/.test(S.probeCommand('write')), 'R1 写探针命令含 finally+unlink  →  ' + S.probeCommand('write'));
    });
    const probeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-probe-git-'));
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const gitIn = (args) => spawnSync('git', args, { cwd: probeRepo, encoding: 'utf8', env: gitEnv });
    gitIn(['init', '-q']);
    gitIn(['config', 'user.email', 't@t']);
    gitIn(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(probeRepo, 'app.js'), '1\n');
    gitIn(['add', 'app.js']);
    gitIn(['commit', '-q', '-m', 'init']);
    const ran = spawnSync(process.execPath, ['-e', S.writeProbeScript()], { cwd: probeRepo, encoding: 'utf8' });
    await t.test('R1 写探针真跑出发标记', () => {
      assert.ok(ran.status === 0 && S.probeMarkFound('write', ran.stdout || ''), 'R1 写探针真跑出发标记  →  ' + ran.stdout);
    });
    await t.test('R1 写探针跑完探测文件不在', () => {
      assert.ok(fs.existsSync(path.join(probeRepo, S.WRITE_PROBE_FILE)) === false, 'R1 写探针跑完探测文件不在');
    });
    const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: probeRepo, encoding: 'utf8' });
    await t.test('R1 写探针跑完 git status 无新增', () => {
      assert.ok(String(dirty.stdout || '').trim() === '', 'R1 写探针跑完 git status 无新增  →  ' + dirty.stdout);
    });
    await t.test('R1 残留探测文件会被当成产出（所以必须清）', () => {
      assert.ok(S.isWorkFile(S.WRITE_PROBE_FILE) === true, 'R1 残留探测文件会被当成产出（所以必须清）');
    });

    const unreadProbe = S.terminalProbeExec({ sendAndRead: () => ({ error: 'terminal_handle_stale' }) })('write');
    await t.test('R1 终端没读成 ≠ 探针绿', () => {
      assert.ok(unreadProbe.ok === false && unreadProbe.unread === true, 'R1 终端没读成 ≠ 探针绿  →  ' + JSON.stringify(unreadProbe));
    });
    const daoSrc = fs.readFileSync(CLI, 'utf8');
    await t.test('#546 dao.mjs 环境自检走 envProbeWorktree，不经 agent 探针', () => {
      assert.ok(/envProbeWorktree/.test(daoSrc) && !/terminalProbeExec/.test(daoSrc) && !/runTerminalProbes/.test(daoSrc), '#546 dao.mjs 环境自检走 envProbeWorktree，不经 agent 探针');
    });
    await t.test('#546 审官卡由 reviewer-create 建完自证（dispatch 不再建）', () => {
      assert.ok(/function cmdReviewerCreate[\s\S]*verifyReviewerTree/.test(daoSrc) && /function cmdDispatch[\s\S]*reviewerDeferred: true/.test(daoSrc), '#546 审官卡由 reviewer-create 建完自证（dispatch 不再建）');
    });
    await t.test('#546/#661 注入后验开工走 finishWorkerInject，垫片不再传 sendEnter', () => {
      assert.ok(/finishWorkerInject/.test(daoSrc) && !/sendEnter/.test(daoSrc) && !/DAO_PROBE_/.test(daoSrc), '#546/#661 注入后验开工走 finishWorkerInject（无 sendEnter 垫片）');
    });
    await t.test('R1 dao.mjs 不再裸调 worktree show', () => {
      assert.ok(!/orca\(\['worktree', 'show'/.test(daoSrc), 'R1 dao.mjs 不再裸调 worktree show');
    });
    await t.test('#684 master 定界区重写只剩清卡/合并钩（dispatch 同步看板 2026-08-23 已删）', () => {
      const dispatchFn = daoSrc.slice(daoSrc.indexOf('function cmdDispatch'), daoSrc.indexOf('function cmdPrSyncLabels'));
      const rmFn = daoSrc.slice(daoSrc.indexOf('function cmdWorktreeRm'), daoSrc.indexOf('function cmdTaskCreate'));
      assert.ok(!/rewriteMasterZone\(/.test(dispatchFn) && !/afterDispatchComment/.test(dispatchFn),
        'dispatch 热路不再同步看板（delete-all-ceremony）');
      assert.ok(/rewriteMasterZone\(remaining\)/.test(rmFn),
        '#684 worktree-rm 挂点保留  →  ' + rmFn.slice(rmFn.indexOf('applyWorktreeRmPlan'), rmFn.indexOf('applyWorktreeRmPlan') + 280));
    });
    await t.test('#502 取 taskId 走 extractTaskId 不猜 result.id', () => {
      assert.ok(/extractTaskId/.test(daoSrc) && !/result\?\.id/.test(daoSrc), '#502 取 taskId 走 extractTaskId 不猜 result.id');
    });
    await t.test('#502 未绑 Run 先指 run-create，不并列 run-use', () => {
      assert.ok(/RUN_REQUIRED_HINT/.test(daoSrc)
      && /run-create/.test(S.RUN_REQUIRED_HINT)
      && /不要先试 run-use/.test(S.RUN_REQUIRED_HINT)
      && !/或 run-use/.test(S.RUN_REQUIRED_HINT), '#502 未绑 Run 先指 run-create，不并列 run-use  →  ' + S.RUN_REQUIRED_HINT);
    });
    await t.test('#667 帅窗 dispatch 不 run-use', () => {
      const chunk = daoSrc.match(/function cmdDispatch\b[\s\S]*?\nfunction /);
      assert.ok(chunk && !/argsRunUse\(/.test(chunk[0]) && !/\['orchestration',\s*'run-use'/.test(daoSrc),
        '#667 帅窗 dispatch 不 run-use');
    });
    await t.test('#667 argsRunUse 无 from/self 抛错；self 不带 --from', () => {
      let threw = false;
      try { S.argsRunUse({ id: 'run_x' }); } catch { threw = true; }
      const selfBind = S.argsRunUse({ id: 'run_x', self: true });
      assert.ok(threw && selfBind.includes('--id') && !selfBind.includes('--from'),
        '#667 argsRunUse self 绑自己  →  ' + selfBind.join(' '));
    });
    await t.test('#667 argsRunCreate 必须 --from', () => {
      let threw = false;
      try { S.argsRunCreate({ objective: 'x' }); } catch { threw = true; }
      const withFrom = S.argsRunCreate({ objective: 'x', from: 'term_station' });
      assert.ok(threw && withFrom.includes('--from'), '#667 argsRunCreate 必须 --from  →  ' + withFrom.join(' '));
    });
    await t.test('#675 本窗自开 Run 不带 --from', () => {
      const self = S.argsRunCreateSelf({ objective: 'dao dispatch' });
      assert.ok(self.includes('run-create') && !self.includes('--from'), '#675 本窗自开 Run 不带 --from  →  ' + self.join(' '));
    });
    await t.test('#675 planCallerRun：已有 Run / 要自开 / 没查成 三态', () => {
      const have = S.planCallerRun({ currentOk: true, currentJson: { result: { run: { id: 'run_x' } } } });
      const need = S.planCallerRun({ currentOk: true, currentJson: { result: { run: null } } });
      const miss = S.planCallerRun({ currentOk: false, currentError: 'boom' });
      assert.ok(have.ok && have.runId === 'run_x' && have.needCreate === false, '已有 Run  →  ' + JSON.stringify(have));
      assert.ok(need.ok && need.needCreate === true && !need.runId, '要自开  →  ' + JSON.stringify(need));
      assert.ok(!miss.ok && miss.unscanned === true, '没查成  →  ' + JSON.stringify(miss));
    });
    await t.test('#614 bindStation 自开 Run 打身份标记（coordinator/dispatch）', () => {
      const stationFn = daoSrc.slice(daoSrc.indexOf('function bindStation'), daoSrc.indexOf('function sleepMs'));
      assert.ok(/objective: `\$\{runRole\}: dao dispatch`/.test(stationFn), 'run-create 带身份前缀  →  ' + stationFn.slice(stationFn.indexOf('argsRunCreateSelf'), stationFn.indexOf('argsRunCreateSelf') + 120));
      const batchFn = daoSrc.slice(daoSrc.indexOf('function cmdDispatchBatch'), daoSrc.indexOf('function cmdPrSyncLabels'));
      assert.ok(/bindStation\(\{ runRole: 'coordinator' \}\)/.test(batchFn),
        '#614 批派工的协调 Run 标 coordinator');
    });
    await t.test('#762 派工执行体改哑终端 coordinator（不再 bindStation 自开 Run）', () => {
      const execFn = daoSrc.slice(daoSrc.indexOf('function runDispatchExecution'), daoSrc.indexOf('function cmdDispatchBatch'));
      assert.ok(/派工协调（勿关）/.test(execFn) && /argsRunCreate\(\{/.test(execFn) && /from: coordHandle/.test(execFn),
        '#762 起哑终端 + run-create --from  →  ' + execFn.slice(0, 400));
      assert.ok(!/bindStation\(\{ runRole: 'coordinator' \}\)/.test(execFn),
        '#762 执行体不再 bindStation 自开 Run（detached 无 coordinator 必 fenced）');
      assert.ok(/created\.runId = runId/.test(execFn) && /created\.runCreated = true/.test(execFn),
        '#762 记录新建 Run 供回滚  →  ' + execFn.slice(0, 400));
      assert.ok(/created\.handles = \[\.\.\.\(Array\.isArray\(created\.handles\)/.test(execFn),
        '#762 协调哑终端登记进 handles 随回滚关');
      assert.ok(/taskCreateOnRun\(soldierBook, runId, \{ from: coordHandle \}\)/.test(execFn)
        && /startOrcaWorker\(\{[\s\S]*?from: coordHandle/.test(execFn),
        '#762 task-create / worker-start 都带 --from 协调哑终端（detached 无发送者终端）  →  ' + execFn.slice(0, 900));
    });
    await t.test('#762 worktree create 带 --repo 选择符（外部主树不再 Missing repo selector）', () => {
      const execFn = daoSrc.slice(daoSrc.indexOf('function runDispatchExecution'), daoSrc.indexOf('function cmdDispatchBatch'));
      assert.match(execFn, /resolveTargetRepoSelector\(/);
      assert.match(execFn, /repo: repoResolved\.selector/);
      assert.match(execFn, /repo: created\.repoSelector/);
    });
    await t.test('#762 resolveRepoSelector：remote 命中 / 路径兜底 / 冲突 / 0 条 / 多条 / 没查成 分开报', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-repo-sel-'));
      const ident = (url) => ({ gitRemoteIdentity: { remoteUrl: url } });
      const one = S.resolveRepoSelector({ repos: [{ id: 'r1', ...ident('https://github.com/thoerwink8/windsurf-dao.git') }], remoteUrl: 'https://github.com/thoerwink8/windsurf-dao.git' });
      assert.ok(one.ok && one.selector === 'id:r1' && one.matchedBy === 'remote', 'remote 命中  →  ' + JSON.stringify(one));
      const pathOnly = S.resolveRepoSelector({ repos: [{ id: 'r2', path: root }], root });
      assert.ok(pathOnly.ok && pathOnly.selector === 'id:r2' && pathOnly.matchedBy === 'path', '路径兜底  →  ' + JSON.stringify(pathOnly));
      const conflict = S.resolveRepoSelector({ repos: [{ id: 'r1', ...ident('https://github.com/thoerwink8/windsurf-dao.git') }, { id: 'r2', path: root }], root, remoteUrl: 'https://github.com/thoerwink8/windsurf-dao.git' });
      assert.ok(!conflict.ok && /冲突/.test(conflict.error), '不同 repo 各命中 remote/路径 → 冲突  →  ' + JSON.stringify(conflict));
      const none = S.resolveRepoSelector({ repos: [], remoteUrl: 'x' });
      assert.ok(!none.ok && !none.unscanned && /没注册/.test(none.error), '0 条 → 没注册  →  ' + JSON.stringify(none));
      const many = S.resolveRepoSelector({ repos: [{ id: 'r1', ...ident('https://github.com/thoerwink8/windsurf-dao.git') }, { id: 'r2', ...ident('https://github.com/thoerwink8/windsurf-dao.git') }], remoteUrl: 'https://github.com/thoerwink8/windsurf-dao.git' });
      assert.ok(!many.ok && /2 条 repo/.test(many.error), '多条 → 不许猜  →  ' + JSON.stringify(many));
      const miss = S.resolveRepoSelector({ remoteUrl: 'x' });
      assert.ok(!miss.ok && miss.unscanned === true && /结构不认识/.test(miss.error), '没查成（无 repos）→ unscanned  →  ' + JSON.stringify(miss));
    });
    await t.test('#762 argsWorktreeCreate 带 repo 时透传 --repo', () => {
      const withRepo = S.argsWorktreeCreate({ name: 'n', repo: 'id:r1' });
      assert.ok(withRepo.includes('--repo') && withRepo.includes('id:r1'), '#762 透传 --repo  →  ' + withRepo.join(' '));
      const without = S.argsWorktreeCreate({ name: 'n' });
      assert.ok(!without.includes('--repo'), '无 repo 不带 --repo');
    });
    await t.test('#614 dispatch 回滚退役本次新建的 Run（只退 runCreated 的）', () => {
      const rollbackFn = daoSrc.slice(daoSrc.indexOf('function rollbackCreated'), daoSrc.indexOf('function snapshotHandleScreen'));
      assert.ok(/created\.runCreated === true && created\.runId/.test(rollbackFn), '只退本次新建的  →  ' + rollbackFn.slice(0, 200));
      assert.ok(/retireOneRun\(created\.runId\)/.test(rollbackFn), '回滚路径退役 Run  →  ' + rollbackFn.slice(0, 200));
      const dispatchFn = daoSrc.slice(daoSrc.indexOf('function runDispatchExecution'), daoSrc.indexOf('function cmdDispatchBatch'));
      assert.ok(/created\.runId = runId/.test(dispatchFn) && /created\.runCreated = true/.test(dispatchFn),
        '派工记录新建 Run 供回滚  →  ' + dispatchFn.slice(dispatchFn.indexOf('const runId'), dispatchFn.indexOf('const runId') + 200));
      const batchFn = daoSrc.slice(daoSrc.indexOf('function cmdDispatchBatch'), daoSrc.indexOf('function cmdPrSyncLabels'));
      assert.ok(/result\.created\.runId = batchRun\.runId/.test(batchFn) && /result\.created\.runCreated = batchRun\.runCreated/.test(batchFn),
        '批派工失败同样回收 Run');
    });
    await t.test('#614 dispatch 不再顺带只读 gc（2026-08-23 删顺车；自动扫描已删）', () => {
      const dispatchFn = daoSrc.slice(daoSrc.indexOf('function cmdDispatch'), daoSrc.indexOf('function cmdPrSyncLabels'));
      assert.ok(!/runGcReadonlyScan/.test(dispatchFn) && !/gcThresholdLine/.test(dispatchFn),
        'dispatch 热路不该再有 gc 顺车');
      assert.ok(!/function runGcReadonlyScan/.test(daoSrc), 'runGcReadonlyScan 函数本体已删');
    });
    await t.test('#614 coordinator 豁免分桶（在途单/协调终端在盘面 keep，查不成 fail-close）', () => {
      const gcFn = daoSrc.slice(daoSrc.indexOf('function cmdRunGc'), daoSrc.indexOf('function cmdAsk'));
      assert.ok(/partitionCoordinatorRuns\(plan\.coordinator/.test(gcFn), 'coordinator 走 handle 分桶  →  ' + gcFn.slice(0, 200));
      assert.ok(/argsTerminalList\(\)/.test(gcFn) && /onBoard = new Set/.test(gcFn), '活性判据 = terminal list 盘面  →  ' + gcFn.slice(0, 200));
      assert.ok(/coordinatorKeep/.test(gcFn) && /coordinatorTombstones/.test(gcFn), '输出活豁免/墓碑两桶');
    });
    await t.test('#614 run-list 分页扫全（nextCursor 循环，页失败 → unscanned 不许当全量）', () => {
      const listFn = daoSrc.slice(daoSrc.indexOf('function listAllRuns'), daoSrc.indexOf('function precheckDispatchDup'));
      assert.ok(/nextCursor/.test(listFn) && /游标不前进/.test(listFn), '分页扫全 + 游标不前进保护  →  ' + listFn.slice(0, 200));
      assert.ok(/分页超过 20 页，放弃（没扫成）/.test(listFn), '超页数放弃 → 没扫成');
      const loadFn = daoSrc.slice(daoSrc.indexOf('function loadLifecycleInputs'), daoSrc.indexOf('function listAllRuns'));
      assert.ok(/const rl = listAllRuns\(\)/.test(loadFn), 'loadLifecycleInputs 走分页扫全  →  ' + loadFn.slice(0, 200));
    });
    await t.test('#667 task-create / worker-start 能带 --from', () => {
      const t = S.argsTaskCreate({ spec: 's', run: 'r', from: 'h' });
      const w = S.argsWorkerStart({ task: 't', worktree: 'w', terminal: 'x', from: 'h', run: 'r' });
      assert.ok(t.includes('--from') && w.includes('--from') && w.includes('--run'),
        '#667 task-create / worker-start 能带 --from  →  ' + t.join(' ') + ' | ' + w.join(' '));
    });
    await t.test('#495 dao.mjs 不走终端 rename', () => {
      assert.ok(!/afterDispatchSuccess/.test(daoSrc) && !/terminal', 'rename'/.test(daoSrc), '#495 dao.mjs 不走终端 rename');
    });
    await t.test('#559 waitAndVerify 超时按 provider 的 probe_wait_ms（不再 8s 硬编码）', () => {
      // 2026-08-23：派工主路已 fire-and-forget（不就绪轮询探针），waitAndVerify 只剩审官/调试路。
      // #762/#753：command 型 TUI（devin）起法 = create → wait tui-idle（就绪即返回）→ worker-start；
      // 不等就绪就送字会 agent_prompt_stalled。agent 型由 orca 管就绪。
      const startWorkerFn = daoSrc.slice(daoSrc.indexOf('function startOrcaWorker'), daoSrc.indexOf('function startWorkerBySlate'));
      assert.ok(/function cmdReviewerCreate[\s\S]*probeWaitMs\(routing, reviewerLaunch\.provider\)/.test(daoSrc)
        && !/probeWaitMs/.test(startWorkerFn),
        '#559 waitAndVerify 超时按 provider 的 probe_wait_ms（审官路保留；派工路已删轮询探针）');
      assert.ok(/argsTerminalWait\(\{ terminal: handle, for: 'tui-idle'/.test(daoSrc),
        '#762/#753 派工路 command 型 TUI 等 tui-idle（就绪即返回，防 stalled）');
    });
    await t.test('#559 waitAndVerify 默认超时不再是 8000ms', () => {
      assert.ok(!/timeoutMs = 8000/.test(fs.readFileSync(LIB, 'utf8')), '#559 waitAndVerify 默认超时不再是 8000ms');
    });
    await t.test('grok 表上 probe_wait_ms=45000', () => {
      assert.ok(S.probeWaitMs(routing, 'grok') === 45000, 'grok 表上 probe_wait_ms=45000  →  ' + String(S.probeWaitMs(routing, 'grok')));
    });
    await t.test('gpt 表上 probe_wait_ms=120000', () => {
      assert.ok(S.probeWaitMs(routing, 'gpt') === 120000, 'gpt 表上 probe_wait_ms=120000  →  ' + String(S.probeWaitMs(routing, 'gpt')));
    });
    await t.test('没配的 provider 回落默认', () => {
      assert.ok(S.probeWaitMs(routing, 'claude') === S.DEFAULT_PROBE_WAIT_MS, '没配的 provider 回落默认');
    });
    await t.test('缺字段 / 非法值回落默认', () => {
      assert.ok(S.probeWaitMs({ providers: { x: {} } }, 'x') === 120000 && S.probeWaitMs({ providers: { x: { probe_wait_ms: -1 } } }, 'x') === 120000, '缺字段 / 非法值回落默认');
    });
    const unread = S.verifyStarted({ error: 'terminal_handle_stale' });
    await t.test('R4 没读成 ≠ 读了是空的', () => {
      assert.ok(unread.reason === '没读成' && unread.unscanned === true, 'R4 没读成 ≠ 读了是空的  →  ' + JSON.stringify(unread));
    });
    const empty = S.verifyStarted({ text: '' });
    await t.test('R4 读了是空的', () => {
      assert.ok(empty.reason === '读了是空的' && empty.unscanned === false, 'R4 读了是空的  →  ' + JSON.stringify(empty));
    });
    const unreadWait = S.waitAndVerify({
      readOnce: () => ({ error: 'boom' }),
      timeoutMs: 5000,
      intervalMs: 10,
      sleep: () => { throw new Error('unread 不该再睡'); },
    });
    await t.test('R4 没读成立即返回（不等满超时）', () => {
      assert.ok(unreadWait.reason === '没读成', 'R4 没读成立即返回（不等满超时）  →  ' + JSON.stringify(unreadWait));
    });

    const badStart = spawnSync(process.execPath, [
      CLI, 'start', '--provider', 'gpt', '--worktree', 'active', '--dry-run', '--submit', 'yes',
    ], { encoding: 'utf8', cwd: REPO });
    const badText = `${badStart.stdout || ''}${badStart.stderr || ''}`;
    await t.test('R3 --submit 被 CLI 拦住非零', () => {
      assert.ok(badStart.status !== 0, 'R3 --submit 被 CLI 拦住非零  →  ' + `status=${badStart.status} ${badText}`);
    });
    await t.test('R3 打印未知参数 --submit', () => {
      assert.ok(/未知参数: --submit/.test(badText), 'R3 打印未知参数 --submit  →  ' + badText);
    });

    const badSandbox = spawnSync(process.execPath, [
      CLI, 'dispatch', '--name', 'x', '--merge-policy', 'auto', '--model', 'grok-4.6',
      '--reviewer', 'gpt-5.6-sol', '--spec', '短摘要', '--dry-run', '--sandbox', 'danger-full-access',
    ], { encoding: 'utf8', cwd: REPO });
    const sandText = `${badSandbox.stdout || ''}${badSandbox.stderr || ''}`;
    await t.test('R3 --sandbox 不再被静默吞掉', () => {
      assert.ok(badSandbox.status !== 0 && /未知参数: --sandbox/.test(sandText), 'R3 --sandbox 不再被静默吞掉  →  ' + sandText);
    });

    await t.test('R3 VERBS 与 FLAGS_BY_VERB 齐（除 raw）', () => {
      assert.ok(S.verbFlagGaps().length === 0, 'R3 VERBS 与 FLAGS_BY_VERB 齐（除 raw）  →  ' + S.verbFlagGaps().join(','));
    });
    await t.test('#591 amend 已登记进 VERBS', () => {
      assert.ok(S.VERBS.includes('amend'), '#591 amend 已登记进 VERBS  →  ' + S.VERBS.join(','));
    });
    await t.test('#591 USAGE 有 amend', () => {
      assert.ok(/amend --issue/.test(S.USAGE), '#591 USAGE 有 amend');
    });
    await t.test('R3 缺 FLAGS 条目能被发现', () => {
      assert.ok(S.verbFlagGaps(['start', 'newverb']).includes('newverb'), 'R3 缺 FLAGS 条目能被发现');
    });
    const saved = S.FLAGS_BY_VERB.start;
    delete S.FLAGS_BY_VERB.start;
    let gapThrew = false;
    try { S.parseArgs(['node', 'dao.mjs', 'start', '--submit', 'yes']); }
    catch (e) { gapThrew = /没登记参数表/.test(String(e.message || e)); }
    S.FLAGS_BY_VERB.start = saved;
    await t.test('R3 动词没登记参数表 → 抛（不许静默回落）', () => {
      assert.ok(gapThrew, 'R3 动词没登记参数表 → 抛（不许静默回落）');
    });

    const steps = S.planDispatchRollback({
      workerId: 'w1', workerHandle: 'th1', reviewerId: 'r1', reviewerHandle: 'rh1',
    });
    await t.test('R6 回滚先关审官终端', () => {
      assert.ok(steps[0] && steps[0].includes('--terminal') && steps[0].includes('rh1'), 'R6 回滚先关审官终端  →  ' + JSON.stringify(steps));
    });
    await t.test('R6 回滚最后删工人卡', () => {
      assert.ok(steps[steps.length - 1] && steps[steps.length - 1].includes('worktree') && steps[steps.length - 1].includes('w1'), 'R6 回滚最后删工人卡  →  ' + JSON.stringify(steps));
    });
    await t.test('R6 什么都没建 → 回滚空', () => {
      assert.ok(S.planDispatchRollback({}).length === 0, 'R6 什么都没建 → 回滚空');
    });
    const stepsKids = S.planDispatchRollback({ workerId: 'w1', childIds: ['c1', 'c2'] });
    const kidIdx = stepsKids.findIndex(s => s.includes('c1'));
    const parentIdx = stepsKids.findIndex(s => s.includes('w1'));
    await t.test('#611 回滚先删子卡再删父卡', () => {
      assert.ok(kidIdx >= 0 && parentIdx > kidIdx, '#611 回滚先删子卡再删父卡  →  ' + JSON.stringify(stepsKids));
    });
    const stepsHandles = S.planDispatchRollback({
      workerId: 'w1', workerHandle: 'th1', childIds: ['c1', 'c2'], childHandles: ['ch1', 'ch2'],
    });
    const chIdx = stepsHandles.findIndex(s => s.includes('ch1'));
    const rmKidIdx = stepsHandles.findIndex(s => s.includes('c1'));
    await t.test('#611 回滚先关子工人终端再删子卡', () => {
      assert.ok(chIdx >= 0 && rmKidIdx > chIdx, '#611 回滚先关子工人终端再删子卡  →  ' + JSON.stringify(stepsHandles));
    });
    const rbOk = S.rollbackReport([{ cmd: 'terminal close x --tab', ok: true }]);
    await t.test('R6 回滚全成功 → 不叫', () => {
      assert.ok(rbOk.rollbackFailed === false && rbOk.alarm == null, 'R6 回滚全成功 → 不叫  →  ' + JSON.stringify(rbOk));
    });
    const rbGone = S.rollbackReport([
      { cmd: 'terminal close th1 --tab', ok: false, error: 'tab_not_found' },
      { cmd: 'worktree rm w1 --force', ok: true },
    ]);
    await t.test('R6 tab_not_found = 目标已不在，不算回滚失败', () => {
      assert.ok(rbGone.rollbackFailed === false, 'R6 tab_not_found = 目标已不在，不算回滚失败  →  ' + JSON.stringify(rbGone));
    });
    const closeFx = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'orca-json', 'close-tab-not-found.json'), 'utf8'));
    await t.test('R6 真 tab_not_found 夹具判已不在', () => {
      assert.ok(S.rollbackErrorAlreadyGone(closeFx.error) === true, 'R6 真 tab_not_found 夹具判已不在  →  ' + JSON.stringify(closeFx.error));
    });
    const rbFail = S.rollbackReport([
      { cmd: 'terminal close th1 --tab', ok: false, error: 'permission denied' },
    ]);
    await t.test('R6 真正清理失败单独可见', () => {
      assert.ok(rbFail.rollbackFailed === true && /孤儿/.test(rbFail.alarm) && /permission denied/.test(rbFail.alarm), 'R6 真正清理失败单独可见  →  ' + JSON.stringify(rbFail));
    });
    await t.test('R6 run_required 能认出', () => {
      assert.ok(S.isRunRequired({ code: 'run_required', message: 'No Run is bound' }) === true, 'R6 run_required 能认出');
    });
    await t.test('R6 普通错误不是 run_required', () => {
      assert.ok(S.isRunRequired('tab_not_found') === false, 'R6 普通错误不是 run_required');
    });
  });

  it('编排 builder / 逃生口', async (t) => {
    const S = await S_LOAD;
    const wt = S.argsWorktreeCreate({ name: 'x', noParent: true, setup: 'skip' });
    await t.test('worktree create 带 --no-parent --setup --json', () => {
      assert.ok(wt.includes('--no-parent') && wt.includes('--setup') && wt.includes('--json'), 'worktree create 带 --no-parent --setup --json');
    });
    const wtIssue = S.argsWorktreeCreate({ name: '修地基', issue: 559 });
    await t.test('#559 追加：worktree create 带 --issue 透传', () => {
      assert.ok(wtIssue.includes('--issue') && wtIssue[wtIssue.indexOf('--issue') + 1] === '559', '#559 追加：worktree create 带 --issue 透传  →  ' + wtIssue.join(' '));
    });
    await t.test('#589：assembleCardName 拼 ISSUE-# + 工人·模型', () => {
      assert.strictEqual(S.assembleCardName({ name: '修地基', issue: 559, role: '工人', model: 'grok-4.6' }), 'ISSUE-#559 工人·grok-4.6 修地基');
    });
    await t.test('#589：assembleCardName 见到 PR 号升级成 PR-#', () => {
      assert.strictEqual(S.assembleCardName({ name: 'ISSUE-#559 工人·grok-4.6 修地基', pr: 616 }), 'PR-#616 工人·grok-4.6 修地基');
    });
    await t.test('#589：assembleCardName 审官卡用 PR-#', () => {
      assert.strictEqual(S.assembleCardName({ name: S.reviewerCardName('gpt-5.6-sol'), pr: 616, role: '审官', model: 'gpt-5.6-sol' }), 'PR-#616 审官·gpt-5.6-sol');
    });
    await t.test('#589：assembleCardName 旧 #N 前缀升级成 PR-#', () => {
      assert.strictEqual(S.assembleCardName({ name: '#559 - 修地基', pr: 616, role: '工人', model: 'grok-4.6' }), 'PR-#616 工人·grok-4.6 修地基');
    });
    await t.test('#589 返工：组装必须带 #（删掉这条里的 # 必须变红）', () => {
      assert.strictEqual(
        S.assembleCardName({ name: '卡名归人眼判据归字段', pr: 616, role: '工人', model: 'grok-4.6' }),
        'PR-#616 工人·grok-4.6 卡名归人眼判据归字段',
      );
    });
    await t.test('#559 追加：没给号原样返回', () => {
      assert.ok(S.assembleCardName({ name: '审读 #505' }) === '审读 #505' && S.assembleCardName({ name: 'x' }) === 'x', '#559 追加：没给号原样返回');
    });
    const wdSrc = fs.readFileSync(CLI, 'utf8');
    await t.test('#589 worker-done 建审官卡名用 PR 不用 issue', () => {
      assert.ok(/assembleCardName\(\{[\s\S]*pr: plan\.pr/.test(wdSrc)
        && !/reviewerCardName\(plan\.reviewer\), issue: plan\.issue/.test(wdSrc),
        'createName 必须传 pr: plan.pr');
    });
    const ws = S.argsWorkerStart({ task: 't', worktree: 'w', terminal: 'h' });
    await t.test('续 Dispatch 的 worker-start 用 --terminal', () => {
      assert.ok(ws.includes('--terminal') && !ws.includes('--agent'), '续 Dispatch 的 worker-start 用 --terminal');
    });
    const wsContinue = S.argsWorkerStart({ task: 't', terminal: 'h' });
    await t.test('#559 续 Dispatch：worker-start 可只给 --task + --terminal（不带 --worktree）', () => {
      assert.ok(wsContinue.includes('--task') && wsContinue.includes('--terminal') && !wsContinue.includes('--worktree'), '#559 续 Dispatch：worker-start 可只给 --task + --terminal（不带 --worktree）  →  ' + wsContinue.join(' '));
    });
    const wsRetry = S.argsWorkerStart({ task: 't', terminal: 'h', retryOf: 'ctx_old' });
    await t.test('#559 换人：worker-start --retry-of 透传旧 dispatch id', () => {
      assert.ok(wsRetry.includes('--retry-of') && wsRetry[wsRetry.indexOf('--retry-of') + 1] === 'ctx_old', '#559 换人：worker-start --retry-of 透传旧 dispatch id  →  ' + wsRetry.join(' '));
    });
    const parsedContinue = S.parseArgs(['node', 'dao.mjs', 'worker-start', '--task', 't', '--terminal', 'h', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol']);
    await t.test('#559 续 Dispatch：CLI 收 --task+--terminal 不带 --worktree', () => {
      assert.ok(parsedContinue.task === 't' && parsedContinue.terminal === 'h' && parsedContinue.worktree === undefined, '#559 续 Dispatch：CLI 收 --task+--terminal 不带 --worktree  →  ' + JSON.stringify(parsedContinue));
    });

    await t.test('#593 inbox-collect / run-gc / ask 已登记进 VERBS', () => {
      assert.ok(S.VERBS.includes('inbox-collect') && S.VERBS.includes('run-gc') && S.VERBS.includes('ask'), '#593 inbox-collect / run-gc / ask 已登记进 VERBS  →  ' + S.VERBS.join(','));
    });
    const askZero = await cliInProc(['ask', '--question', 'x', '--timeout-ms', '0']);
    const askZeroJ = (() => { try { return JSON.parse(askZero.stdout || '{}'); } catch { return {}; } })();
    await t.test('#598 红项3：--timeout-ms 0 非零且不空转', () => {
      assert.ok(askZero.status !== 0 && /正整数/.test(String(askZeroJ.error || askZero.stderr || '')), '#598 红项3：--timeout-ms 0 非零且不空转  →  ' + JSON.stringify(askZeroJ));
    });
    const askNan = await cliInProc(['ask', '--question', 'x', '--timeout-ms', 'nope']);
    const askNanJ = (() => { try { return JSON.parse(askNan.stdout || '{}'); } catch { return {}; } })();
    await t.test('#598 红项3：--timeout-ms 非数字 非零', () => {
      assert.ok(askNan.status !== 0 && /正整数/.test(String(askNanJ.error || '')), '#598 红项3：--timeout-ms 非数字 非零  →  ' + JSON.stringify(askNanJ));
    });
    const askFrac = await cliInProc(['ask', '--question', 'x', '--timeout-ms', '1.5']);
    const askFracJ = (() => { try { return JSON.parse(askFrac.stdout || '{}'); } catch { return {}; } })();
    await t.test('#598 红项3：--timeout-ms 小数 非零', () => {
      assert.ok(askFrac.status !== 0 && /正整数/.test(String(askFracJ.error || '')), '#598 红项3：--timeout-ms 小数 非零  →  ' + JSON.stringify(askFracJ));
    });
    const daoCliSrc = fs.readFileSync(CLI, 'utf8');
    await t.test('#598 红项1：worktree-rm 删树前要先查 worker-list/run-list', () => {
      assert.ok(/worker-list 没查成，未删任何树/.test(daoCliSrc) && /run-list 没查成，未删任何树/.test(daoCliSrc), '#598 红项1：worktree-rm 删树前要先查 worker-list/run-list');
    });
    await t.test('#598 红项1：退役失败走 fail 不是 ok:true', () => {
      assert.ok(/finalizeWorktreeRmLifecycle/.test(daoCliSrc) && /if \(!life\.ok\)/.test(daoCliSrc), '#598 红项1：退役失败走 fail 不是 ok:true');
    });
    const rmFn = daoCliSrc.slice(daoCliSrc.indexOf('function cmdWorktreeRm'), daoCliSrc.indexOf('function cmdTaskCreate'));
    await t.test('#601 先退役再删树', () => {
      assert.ok(rmFn.indexOf('finalizeWorktreeRmLifecycle') !== -1
        && rmFn.indexOf('applyWorktreeRmPlan') !== -1
        && rmFn.indexOf('finalizeWorktreeRmLifecycle') < rmFn.indexOf('applyWorktreeRmPlan')
        && /退役名单没查成，未删任何树/.test(rmFn), 'retire/delete 顺序或失败文案不对');
    });
    await t.test('#601 run-gc 输出三态', () => {
      assert.ok(/closedCount/.test(daoCliSrc) && /alreadyGoneCount/.test(daoCliSrc) && /tombstones/.test(daoCliSrc), '#601 run-gc 输出三态');
    });
    const retireFn = daoCliSrc.slice(daoCliSrc.indexOf('function retireOneRun'), daoCliSrc.indexOf('function loadLifecycleInputs'));
    await t.test('#601 退役走租约身份不是 coordinator', () => {
      assert.ok(/resolveStationCloseTarget/.test(retireFn)
        && /previewHandlesForRun/.test(retireFn)
        && !/isProcessAlive/.test(retireFn)
        && !/pidAlive/.test(retireFn)
        && !/coordinatorHandle: handle/.test(retireFn), 'retireOneRun 仍把 coordinator 当关台目标');
    });
    await t.test('#598 红项2：reply 无 --from 不许裸发', () => {
      assert.ok(/reply 没有信箱台 --from/.test(daoCliSrc) && /resolveReplySender/.test(daoCliSrc), '#598 红项2：reply 无 --from 不许裸发');
    });
    await t.test('#559 ③ reply 已登记进 VERBS', () => {
      assert.ok(S.VERBS.includes('reply'), '#559 ③ reply 已登记进 VERBS  →  ' + S.VERBS.join(','));
    });
    const replyArgs = S.argsOrchestrationReply({ id: 'msg_q1', body: '可以' });
    await t.test('reply 拼 --id + --body', () => {
      assert.ok(replyArgs.includes('--id') && replyArgs[replyArgs.indexOf('--id') + 1] === 'msg_q1' && replyArgs[replyArgs.indexOf('--body') + 1] === '可以', 'reply 拼 --id + --body  →  ' + replyArgs.join(' '));
    });
    const replyParsed = S.parseArgs(['node', 'dao.mjs', 'reply', '--id', 'msg_q1', '--body', '可以']);
    await t.test('CLI 收 reply --id/--body', () => {
      assert.ok(replyParsed.id === 'msg_q1' && replyParsed.body === '可以', 'CLI 收 reply --id/--body  →  ' + JSON.stringify(replyParsed));
    });

    await t.test('#559 ④ gate-create/gate-resolve/gate-list 已登记进 VERBS', () => {
      assert.ok(S.VERBS.includes('gate-create') && S.VERBS.includes('gate-resolve') && S.VERBS.includes('gate-list'), '#559 ④ gate-create/gate-resolve/gate-list 已登记进 VERBS  →  ' + S.VERBS.join(','));
    });
    const gc = S.argsGateCreate({ task: 'task_x', question: '乒乓两轮仍红，换人？', options: '["换","不换"]' });
    await t.test('gate-create 拼 --task/--question/--options', () => {
      assert.ok(gc.includes('--task') && gc.includes('--question') && gc.includes('--options'), 'gate-create 拼 --task/--question/--options  →  ' + gc.join(' '));
    });
    const gr = S.argsGateResolve({ id: 'gate_x', resolution: '换' });
    await t.test('gate-resolve 拼 --id/--resolution', () => {
      assert.ok(gr.includes('--id') && gr[gr.indexOf('--resolution') + 1] === '换', 'gate-resolve 拼 --id/--resolution  →  ' + gr.join(' '));
    });
    const gl = S.argsGateList({ task: 'task_x', status: 'pending' });
    await t.test('gate-list 拼 --task/--status', () => {
      assert.ok(gl.includes('--task') && gl.includes('--status'), 'gate-list 拼 --task/--status  →  ' + gl.join(' '));
    });
    const gateParsed = S.parseArgs(['node', 'dao.mjs', 'gate-resolve', '--id', 'gate_x', '--resolution', '换']);
    await t.test('CLI 收 gate-resolve --id/--resolution', () => {
      assert.ok(gateParsed.id === 'gate_x' && gateParsed.resolution === '换', 'CLI 收 gate-resolve --id/--resolution  →  ' + JSON.stringify(gateParsed));
    });

    await t.test('#559 ⑤ worker-release 已登记进 VERBS', () => {
      assert.ok(S.VERBS.includes('worker-release'), '#559 ⑤ worker-release 已登记进 VERBS  →  ' + S.VERBS.join(','));
    });
    const wr = S.argsWorkerRelease({ dispatch: 'ctx_x' });
    await t.test('worker-release 拼 --dispatch', () => {
      assert.ok(wr.includes('--dispatch') && wr[wr.indexOf('--dispatch') + 1] === 'ctx_x', 'worker-release 拼 --dispatch  →  ' + wr.join(' '));
    });
    const wrParsed = S.parseArgs(['node', 'dao.mjs', 'worker-release', '--dispatch', 'ctx_x']);
    await t.test('CLI 收 worker-release --dispatch', () => {
      assert.ok(wrParsed.dispatch === 'ctx_x', 'CLI 收 worker-release --dispatch  →  ' + JSON.stringify(wrParsed));
    });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-escape-'));
    const log = path.join(tmp, 'cmd-escape.jsonl');
    S.recordEscape({ argv: ['orca', 'foo', '--submit'], ts: '2026-08-15T00:00:00.000Z', cwd: tmp }, log);
    const line = fs.readFileSync(log, 'utf8').trim();
    const rec = JSON.parse(line);
    await t.test('逃生口写下命令', () => {
      assert.ok(rec.argv[2] === '--submit' && rec.argv[0] === 'orca', '逃生口写下命令  →  ' + line);
    });
    await t.test('逃生口有时间戳', () => {
      assert.ok(rec.ts === '2026-08-15T00:00:00.000Z', '逃生口有时间戳');
    });

    const raw = spawnSync(process.execPath, [CLI, 'raw', '--', process.execPath, '-e', 'process.exit(0)'], {
      encoding: 'utf8', cwd: REPO,
    });
    await t.test('dao raw 退出跟随子进程', () => {
      assert.ok(raw.status === 0, 'dao raw 退出跟随子进程  →  ' + (raw.stderr || raw.stdout));
    });
    await t.test('dao raw 在 stderr 留痕', () => {
      assert.ok(/已记账/.test(raw.stderr || ''), 'dao raw 在 stderr 留痕  →  ' + raw.stderr);
    });

    const rawJson = spawnSync(process.execPath, [CLI, 'raw', '--', process.execPath, '-e', 'console.log(JSON.stringify({ok:true,id:"t575"}))'], {
      encoding: 'utf8', cwd: REPO,
    });
    let parsedRaw = null;
    try { parsedRaw = JSON.parse(rawJson.stdout); } catch { parsedRaw = null; }
    await t.test('#575 ② dao raw stdout 可直接 JSON.parse（记账不污染 stdout）',
      () => {
        assert.ok(parsedRaw && parsedRaw.ok === true && parsedRaw.id === 't575', '#575 ② dao raw stdout 可直接 JSON.parse（记账不污染 stdout）  →  ' + rawJson.stdout);
      });
    await t.test('#575 ② 记账行在 stderr 不在 stdout',
      () => {
        assert.ok(/已记账/.test(rawJson.stderr || '') && !/已记账/.test(rawJson.stdout || ''),
          '#575 ② 记账行在 stderr 不在 stdout  →  ' + `stdout=${rawJson.stdout} stderr=${rawJson.stderr}`);
      });

    const rawSpec = spawnSync(process.execPath, [
      CLI, 'raw', '--', process.execPath, '-e', 'console.log(JSON.stringify({ok:true}))',
    ], { encoding: 'utf8', cwd: REPO });
    let parsedSpec = null;
    try { parsedSpec = JSON.parse(rawSpec.stdout); } catch { parsedSpec = null; }
    await t.test('#575 ② 子进程 JSON 不被多行记账拆碎', () => {
      assert.ok(parsedSpec && parsedSpec.ok === true, '#575 ② 子进程 JSON 不被多行记账拆碎  →  ' + rawSpec.stdout);
    });

    await t.test('#575 ④ reviewer-attach 已登记进 VERBS', () => {
      assert.ok(S.VERBS.includes('reviewer-attach'), '#575 ④ reviewer-attach 已登记进 VERBS  →  ' + S.VERBS.join(','));
    });
    const attachHelp = await cliInProc(['reviewer-attach', '--help']);
    await t.test('reviewer-attach 出现在 help', () => {
      assert.ok(/reviewer-attach/.test(attachHelp.stdout || ''), 'reviewer-attach 出现在 help  →  ' + (attachHelp.stdout || '').slice(0, 200));
    });
    const attachMiss = await cliInProc(['reviewer-attach']);
    const pAttach = (() => { try { return JSON.parse(attachMiss.stdout || '{}'); } catch { return {}; } })();
    await t.test('reviewer-attach 缺 --pr → 非零', () => {
      assert.ok(attachMiss.status !== 0 && /--pr/.test(String(pAttach.error || attachMiss.stderr || '')), 'reviewer-attach 缺 --pr → 非零  →  ' + JSON.stringify(pAttach));
    });
    const attachMissWt = await cliInProc(['reviewer-attach', '--pr', '1']);
    const pAttachWt = (() => { try { return JSON.parse(attachMissWt.stdout || '{}'); } catch { return {}; } })();
    await t.test('reviewer-attach 缺 --worktree → 非零', () => {
      assert.ok(attachMissWt.status !== 0 && /--worktree/.test(String(pAttachWt.error || attachMissWt.stderr || '')), 'reviewer-attach 缺 --worktree → 非零  →  ' + JSON.stringify(pAttachWt));
    });
    const attachMissRev = await cliInProc(['reviewer-attach', '--pr', '1', '--worktree', 'w']);
    const pAttachRev = (() => { try { return JSON.parse(attachMissRev.stdout || '{}'); } catch { return {}; } })();
    await t.test('reviewer-attach 缺 --reviewer → 非零', () => {
      assert.ok(attachMissRev.status !== 0 && /--reviewer/.test(String(pAttachRev.error || attachMissRev.stderr || '')), 'reviewer-attach 缺 --reviewer → 非零  →  ' + JSON.stringify(pAttachRev));
    });

    const wlFx = { result: { workers: [
      { dispatchId: 'ctx_live', workerState: 'working', dispatchStatus: 'running', resource: { worktreeId: 'repo::C:/wt/worker' } },
      { dispatchId: 'ctx_old', workerState: 'succeeded', dispatchStatus: 'completed', resource: { worktreeId: 'repo::C:/wt/worker' } },
    ] } };
    const foundLive = S.findDispatchForWorktree(wlFx, 'repo::C:/wt/worker');
    await t.test('findDispatchForWorktree 优先活着的 dispatch', () => {
      assert.ok(foundLive.ok && foundLive.dispatchId === 'ctx_live', 'findDispatchForWorktree 优先活着的 dispatch  →  ' + JSON.stringify(foundLive));
    });
    const wlFailedFirst = { result: { workers: [
      { dispatchId: 'ctx_failed', workerState: 'failed', dispatchStatus: 'failed', resource: { worktreeId: 'repo::C:/wt/rev' } },
      { dispatchId: 'ctx_ready', workerState: 'ready', dispatchStatus: 'dispatched', resource: { worktreeId: 'repo::C:/wt/rev' } },
    ] } };
    const foundReady = S.findDispatchForWorktree(wlFailedFirst, 'repo::C:/wt/rev');
    await t.test('findDispatchForWorktree 同树优先 ready，不拿已结算 failed',
      () => {
        assert.ok(foundReady.ok && foundReady.dispatchId === 'ctx_ready', 'findDispatchForWorktree 同树优先 ready，不拿已结算 failed  →  ' + JSON.stringify(foundReady));
      });
    const foundMiss = S.findDispatchForWorktree(wlFx, 'no-such-tree');
    await t.test('findDispatchForWorktree 查到 0 条不是没查成', () => {
      assert.ok(foundMiss.ok === false && !foundMiss.unscanned && foundMiss.scanned === 2, 'findDispatchForWorktree 查到 0 条不是没查成  →  ' + JSON.stringify(foundMiss));
    });
    const foundBad = S.findDispatchForWorktree({ result: {} }, 'x');
    await t.test('findDispatchForWorktree 结构不认识 → unscanned', () => {
      assert.ok(foundBad.ok === false && foundBad.unscanned === true, 'findDispatchForWorktree 结构不认识 → unscanned  →  ' + JSON.stringify(foundBad));
    });
    const foundDeadOnly = S.findDispatchForWorktree({ result: { workers: [
      { dispatchId: 'ctx_done', workerState: 'succeeded', dispatchStatus: 'completed', resource: { worktreeId: 'repo::C:/wt/dead' } },
    ] } }, 'repo::C:/wt/dead');
    await t.test('#552 同树只剩已结算 dispatch → 非 ok，不是没查成', () => {
      assert.ok(foundDeadOnly.ok === false && !foundDeadOnly.unscanned && foundDeadOnly.deadCount === 1
        && /已结算/.test(foundDeadOnly.error || ''),
        '#552 同树只剩已结算 dispatch → 非 ok，不是没查成  →  ' + JSON.stringify(foundDeadOnly));
    });
  });

  it('真语料：orca --json 存档必须能被解析函数吃下（#499）', async (t) => {
    const S = await S_LOAD;
    const fx = (name) => JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'orca-json', name), 'utf8'));
    const readLive = fx('terminal-read.json');
    const createLive = fx('terminal-create.json');
    const wtLive = fx('worktree-create.json');

    await t.test('terminal-read 信封是真 orca 形（ok + result.terminal.tail）',
      () => {
        assert.ok(readLive.ok === true && Array.isArray(readLive.result?.terminal?.tail) && readLive.result.terminal.tail.length > 0,
          'terminal-read 信封是真 orca 形（ok + result.terminal.tail）  →  ' + JSON.stringify(Object.keys(readLive.result || {})));
      });

    const extracted = S.extractTerminalText(readLive);
    await t.test('真 terminal read → extractTerminalText 非空', () => {
      assert.ok(String(extracted).trim().length > 0, '真 terminal read → extractTerminalText 非空  →  ' + `len=${String(extracted).length}`);
    });
    await t.test('真 terminal read 含屏面原文', () => {
      assert.ok(/Grok 4\.6/.test(extracted), '真 terminal read 含屏面原文  →  ' + extracted.slice(0, 160));
    });
    const started = S.verifyStarted(readLive);
    await t.test('真 terminal read → verifyStarted 过', () => {
      assert.ok(started.ok === true, '真 terminal read → verifyStarted 过  →  ' + JSON.stringify({ ok: started.ok, reason: started.reason, len: String(started.text || '').length }));
    });

    await t.test('真 terminal create → extractHandleFromCreate',
      () => {
        assert.ok(S.extractHandleFromCreate(createLive) === 'term_a106c2c9-62cc-440b-afde-0b9416ffb630', '真 terminal create → extractHandleFromCreate');
      });
    await t.test('真 worktree create → extractWorktreeId',
      () => {
        assert.ok(S.extractWorktreeId(wtLive) === '1770a430-983a-4e86-9277-9f1e5c376b83::C:/Users/Administrator/orca/workspaces/windsurf-dao/_fixture-499-delete-me', '真 worktree create → extractWorktreeId');
      });
    await t.test('真 worktree create → extractWorktreePath',
      () => {
        assert.ok(S.extractWorktreePath(wtLive) === 'C:/Users/Administrator/orca/workspaces/windsurf-dao/_fixture-499-delete-me', '真 worktree create → extractWorktreePath');
      });

    const sendLive = fx('terminal-send.json');
    const sent = S.extractTerminalSend(sendLive);
    await t.test('真 terminal send --json → extractTerminalSend accepted', () => {
      assert.ok(sent && sent.accepted === true && sent.bytesWritten === 9, '真 terminal send --json → extractTerminalSend accepted  →  ' + JSON.stringify(sent));
    });

    const taskLive = fx('task-create.json');
    await t.test('真 task-create → extractTaskId 走 result.task.id',
      () => {
        assert.ok(S.extractTaskId(taskLive) === 'task_72992e47f0f4', '真 task-create → extractTaskId 走 result.task.id');
      });
    await t.test('真 task-create 顶层 id 不是 taskId',
      () => {
        assert.ok(taskLive.id !== S.extractTaskId(taskLive) && taskLive.result.id === undefined, '真 task-create 顶层 id 不是 taskId');
      });
    await t.test('旧路径 result.id / 顶层 id 都取不到',
      () => {
        assert.ok(S.extractTaskId({ id: 'rpc', result: { id: 'rpc2' } }) === null, '旧路径 result.id / 顶层 id 都取不到');
      });
    const runShow = fx('run-show.json');
    await t.test('#667 真 run-show → extractRunId 走 result.run.id',
      () => {
        assert.ok(S.extractRunId(runShow) === 'run_1f15bcf004cb', '#667 真 run-show → extractRunId 走 result.run.id');
      });
    await t.test('#667 顶层 id 不是 runId',
      () => {
        assert.ok(runShow.id !== S.extractRunId(runShow), '#667 顶层 id 不是 runId');
      });
  });

  it('#633 空壳先关再 create --command，禁止 send 进 pwsh', async (t) => {
    const S = await S_LOAD;
    const routing = await ROUTING_LOAD;
    const live = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'orca-json', 'terminal-list-default.json'), 'utf8'));
    const listArgs = S.argsTerminalList({ worktree: 'w' });
    await t.test('terminal list builder 带 --worktree --json', () => {
      assert.ok(listArgs.includes('--worktree') && listArgs[listArgs.indexOf('--worktree') + 1] === 'w' && listArgs.includes('--json'),
        'terminal list builder 带 --worktree --json  →  ' + listArgs.join(' '));
    });
    const found = S.findReusableDefaultTerminal(live);
    await t.test('真 terminal list 默认空壳能拿到 handle', () => {
      assert.ok(found.ok && found.handle === 'term_21834764-0aab-4188-bacf-651b4f6ae6c6' && found.unscanned === false,
        '真 terminal list 默认空壳能拿到 handle  →  ' + JSON.stringify(found));
    });
    await t.test('title null + PS 提示符算空壳', () => {
      assert.ok(S.isReusableDefaultTerminal(live.result.terminals[0]) === true, 'title null + PS 提示符算空壳');
    });
    await t.test('title Terminal 1 也算空壳', () => {
      assert.ok(S.isReusableDefaultTerminal({ ...live.result.terminals[0], title: 'Terminal 1' }) === true, 'title Terminal 1 也算空壳');
    });
    const grok = {
      ...live.result.terminals[0],
      title: '⠋ Grok',
      preview: 'Grok Build  1.0.1  always-approve',
    };
    await t.test('已是 agent 的终端不当空壳', () => {
      assert.ok(S.isReusableDefaultTerminal(grok) === false, '已是 agent 的终端不当空壳');
    });
    const mixed = {
      ok: true,
      result: {
        terminals: [
          grok,
          live.result.terminals[0],
        ],
      },
    };
    const picked = S.findReusableDefaultTerminal(mixed);
    await t.test('一棵树 agent+空壳 只拿空壳来关', () => {
      assert.ok(picked.ok && picked.handle === live.result.terminals[0].handle, '一棵树 agent+空壳 只拿空壳来关  →  ' + JSON.stringify(picked));
    });
    const none = S.findReusableDefaultTerminal({ ok: true, result: { terminals: [grok] } });
    await t.test('查到 0 个空壳不是没查成', () => {
      assert.ok(none.ok === true && none.unscanned === false && none.handle === null, '查到 0 个空壳不是没查成  →  ' + JSON.stringify(none));
    });
    const bad = S.findReusableDefaultTerminal({ result: {} });
    await t.test('terminal list 结构不认识 → unscanned', () => {
      assert.ok(bad.ok === false && bad.unscanned === true, 'terminal list 结构不认识 → unscanned  →  ' + JSON.stringify(bad));
    });
    await t.test('PS 提示符认得出来', () => {
      assert.ok(S.looksLikeShellPrompt(live.result.terminals[0].preview) === true, 'PS 提示符认得出来');
    });
    await t.test('TUI 预览不是 shell', () => {
      assert.ok(S.looksLikeShellPrompt(grok.preview) === false && S.looksLikeAgentPreview(grok.preview) === true, 'TUI 预览不是 shell');
    });
    const src = fs.readFileSync(CLI, 'utf8');
    const calls = src.match(/launchAgentInWorktree\(/g) || [];
    await t.test('start / dispatch / batch / 审官起动都走 launchAgentInWorktree', () => {
      assert.ok(calls.length >= 6, 'start / dispatch / batch / 审官起动都走 launchAgentInWorktree  →  ' + calls.length);
    });
    await t.test('dao.mjs 起 agent 只在 launchAgentInWorktree 里 terminal create；#762 派工协调哑终端是例外', () => {
      const createHits = [...src.matchAll(/argsTerminalCreate\(/g)];
      assert.ok(createHits.length >= 4, 'agent 在 launchAgentInWorktree + #762 工人/审官协调哑终端  →  ' + createHits.length);
      const coordHits = createHits.filter(h => /派工协调（勿关）/.test(src.slice(h.index, h.index + 200)));
      assert.ok(coordHits.length >= 3, '#762 工人 + 审官 create/attach 的协调哑终端（不起 agent）  →  ' + coordHits.length);
    });

    const fn = src.match(/function launchAgentInWorktree[\s\S]*?\nfunction /);
    await t.test('launchAgentInWorktree 禁止 terminal send 启动命令', () => {
      assert.ok(fn && !/argsTerminalSend\(/.test(fn[0]) && !/waitForShellPrompt/.test(fn[0]),
        'launchAgentInWorktree 禁止 terminal send 启动命令  →  ' + (fn ? fn[0].slice(0, 240) : 'no fn'));
    });
    await t.test('launchAgentInWorktree 按计划关空壳再 create', () => {
      assert.ok(fn && /planLaunchFallback\(/.test(fn[0]) && /closeWorkerHandle\(plan\.closeHandle\)/.test(fn[0]),
        'launchAgentInWorktree 按计划关空壳再 create');
    });

    const withShell = S.planLaunchFallback({ foundHandle: 'term_shell' });
    await t.test('有空壳 → 先关再 create，不复用', () => {
      assert.ok(withShell.action === 'close-then-create' && withShell.closeHandle === 'term_shell' && withShell.leftoverIfCreateNow === true,
        '有空壳 → 先关再 create，不复用  →  ' + JSON.stringify(withShell));
    });
    const ignoredSend = S.planLaunchFallback({ foundHandle: 'term_shell', promptReady: true, sendAccepted: true });
    await t.test('故意违规：send 成功也不再复用空壳', () => {
      assert.ok(ignoredSend.action === 'close-then-create' && ignoredSend.closeHandle === 'term_shell',
        '故意违规：send 成功也不再复用空壳  →  ' + JSON.stringify(ignoredSend));
    });
    const noShell = S.planLaunchFallback({ foundHandle: null });
    await t.test('没有空壳 → 直接 create', () => {
      assert.ok(noShell.action === 'create' && noShell.closeHandle == null,
        '没有空壳 → 直接 create  →  ' + JSON.stringify(noShell));
    });
    const leaked = S.terminalsAfterLaunchPlan({
      existingHandles: ['term_shell'],
      plan: { action: 'create', closeHandle: null },
      createdHandle: 'term_agent',
    });
    await t.test('故意违规：不关空壳就 create 会留 2 个终端', () => {
      assert.ok(leaked.length === 2 && leaked.includes('term_shell') && leaked.includes('term_agent'),
        '故意违规：不关空壳就 create 会留 2 个终端  →  ' + JSON.stringify(leaked));
    });
    const afterClose = S.terminalsAfterLaunchPlan({
      existingHandles: ['term_shell'],
      plan: withShell,
      createdHandle: 'term_agent',
    });
    await t.test('关空壳再 create 后只剩 1 个 agent 终端', () => {
      assert.ok(afterClose.length === 1 && afterClose[0] === 'term_agent',
        '关空壳再 create 后只剩 1 个 agent 终端  →  ' + JSON.stringify(afterClose));
    });

    const kimi = S.resolveLaunch({ model: 'kimi-k3', routing });
    const cursorLaunch = S.resolveLaunch({ provider: 'cursor', routing });
    const grokLaunch = S.resolveLaunch({ provider: 'grok', routing });
    const flash = S.resolveLaunch({ model: 'deepseek-v4-flash', routing });
    const gpt = S.resolveLaunch({ provider: 'gpt', routing });
    const claude = S.resolveLaunch({ provider: 'claude', routing });
    await t.test('认识的 agent：cursor / grok / pi / codex 有 id', () => {
      assert.ok(cursorLaunch.agentId === 'cursor' && grokLaunch.agentId === 'grok' && flash.agentId === 'pi' && gpt.agentId === 'codex' && kimi.agentId === 'pi',
        '认识的 agent：cursor / grok / pi / codex 有 id  →  ' + JSON.stringify({
          cursor: cursorLaunch.agentId, grok: grokLaunch.agentId, flash: flash.agentId, gpt: gpt.agentId, kimi: kimi.agentId,
        }));
    });
    await t.test('#797 gw provider 映射到 --agent pi（不靠 launch 二进制名）', () => {
      assert.ok(S.orcaKnownAgentId({ provider: 'gw' }) === 'pi',
        '#797 gw → pi  →  ' + S.orcaKnownAgentId({ provider: 'gw' }));
    });
    await t.test('reclaude 不能映射成 --agent claude', () => {
      assert.ok(claude.agentId == null && /reclaude/.test(claude.command),
        'reclaude 不能映射成 --agent claude  →  ' + JSON.stringify({ agentId: claude.agentId, command: claude.command }));
    });
    const cursorSpec = S.agentStartSpec(cursorLaunch);
    const gptSpec = S.agentStartSpec(gpt);
    const grokSpec = S.agentStartSpec(grokLaunch);
    const claudeSpec = S.agentStartSpec(claude);
    const kimiSpec = S.agentStartSpec(kimi);
    await t.test('cursor / codex 走 worker-start --agent + --model', () => {
      assert.ok(cursorSpec.mode === 'agent' && cursorSpec.agentId === 'cursor' && cursorSpec.model === 'composer-2.5'
        && gptSpec.mode === 'agent' && gptSpec.agentId === 'codex',
        'cursor / codex 走 worker-start --agent + --model  →  ' + JSON.stringify({ cursorSpec, gptSpec }));
    });
    await t.test('#822 kimi 走 --agent pi（模型在 launch，orca --model 不认 pi）', () => {
      assert.ok(kimiSpec.mode === 'agent' && kimiSpec.agentId === 'pi' && kimiSpec.model == null,
        'kimi → pi  →  ' + JSON.stringify(kimiSpec));
    });
    await t.test('grok / pi 走 --agent（模型在 shim；orca --model 不认这两家）', () => {
      assert.ok(grokSpec.mode === 'agent' && grokSpec.agentId === 'grok' && grokSpec.model == null,
        'grok / pi 走 --agent  →  ' + JSON.stringify(grokSpec));
    });
    await t.test('reclaude 仍走 terminal create --command', () => {
      assert.ok(claudeSpec.mode === 'command' && /reclaude/.test(claude.command),
        'reclaude 仍走 terminal create --command  →  ' + JSON.stringify(claudeSpec));
    });
    const agentStart = S.argsWorkerStart({ task: 't', worktree: 'w', agent: 'cursor', model: 'kimi-k3-high' });
    await t.test('认识的 agent 的 worker-start 拼 --agent --model，不带 --terminal', () => {
      assert.ok(agentStart.includes('--agent') && agentStart[agentStart.indexOf('--agent') + 1] === 'cursor'
        && agentStart.includes('--model') && !agentStart.includes('--terminal'),
        '认识的 agent 的 worker-start 拼 --agent --model  →  ' + agentStart.join(' '));
    });
    const fx = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'orca-json', 'worker-show.json'), 'utf8'));
    await t.test('worker-start/show 回包能抽出 agent 终端 handle', () => {
      assert.ok(S.extractHandleFromWorkerStart(fx) === 'term_e525f71f-29a9-419c-9469-b8ef2a277239',
        'worker-start/show 回包能抽出 agent 终端 handle  →  ' + S.extractHandleFromWorkerStart(fx));
    });
    const createChunk = (src.match(/function cmdReviewerCreate\b[\s\S]*?\nfunction /) || [''])[0];
    const attachChunk = (src.match(/function cmdReviewerAttach\b[\s\S]*?\nfunction /) || [''])[0];
    await t.test('审官路径不写 forceCommand（起法读 toml start）', () => {
      assert.ok(!/forceCommand/.test(createChunk) && !/forceCommand/.test(attachChunk),
        '审官路径不写 forceCommand  →  create=' + createChunk.slice(0, 80));
    });
    await t.test('故意 command+paste 路径不再当 GPT 审官起法', () => {
      const gptLaunch = S.resolveLaunch({ provider: 'gpt', routing });
      const gptSpec = S.agentStartSpec(gptLaunch);
      assert.ok(gptSpec.mode === 'agent' && gptSpec.agentId === 'codex' && gptLaunch.start === 'agent'
        && !/forceCommand/.test(createChunk + attachChunk),
        'command+paste 不再是 GPT 审官起法  →  ' + JSON.stringify(gptSpec));
    });
    await t.test('reclaude start=command（不能 --agent）', () => {
      const claudeLaunch = S.resolveLaunch({ provider: 'claude', routing });
      assert.ok(claudeLaunch.start === 'command' && S.agentStartSpec(claudeLaunch).mode === 'command',
        'reclaude 仍 command  →  ' + JSON.stringify(S.agentStartSpec(claudeLaunch)));
    });
  });

  it('#633 consumer_fenced：扫到 0 次和没扫到样本必须分开', async (t) => {
    const S = await S_LOAD;
    const missing = S.inspectConsumerFence(undefined);
    await t.test('没给错误文本 → unscanned（没扫到样本）', () => {
      assert.ok(missing.unscanned === true && missing.scanned === false && /没扫到样本/.test(missing.error),
        '没给错误文本 → unscanned  →  ' + JSON.stringify(missing));
    });
    const zero = S.inspectConsumerFence('审官 worker-start 失败: spawnSync orca ETIMEDOUT');
    await t.test('扫到错误但不是 fence → 0 次', () => {
      assert.ok(zero.unscanned === false && zero.scanned === true && zero.fenced === false && zero.count === 0,
        '扫到错误但不是 fence → 0 次  →  ' + JSON.stringify(zero));
    });
    const hit = S.inspectConsumerFence('orca 报错 consumer_fenced: worker-start requires the coordinator terminal');
    await t.test('扫到 consumer_fenced → 1 次', () => {
      assert.ok(hit.unscanned === false && hit.fenced === true && hit.count === 1,
        '扫到 consumer_fenced → 1 次  →  ' + JSON.stringify(hit));
    });
    const none = S.planFenceHeal({ error: '别的错' });
    await t.test('不是 fence → action none', () => {
      assert.ok(none.ok === true && none.action === 'none' && none.fences === 0,
        '不是 fence → action none  →  ' + JSON.stringify(none));
    });
    const noRun = S.planFenceHeal({ error: 'consumer_fenced: x' });
    await t.test('fence 但没 Run id → 不许当成功', () => {
      assert.ok(noRun.ok === false && noRun.action === 'retire' && /Run id/.test(noRun.error),
        'fence 但没 Run id → 不许当成功  →  ' + JSON.stringify(noRun));
    });
    const healed = S.planFenceHeal({
      error: 'consumer_fenced: x',
      runId: 'run_x',
      retired: { ok: true },
      retried: { ok: true },
      ensured: { ok: true },
    });
    await t.test('retire+再起+ensure 齐 → healed', () => {
      assert.ok(healed.ok === true && healed.action === 'healed' && healed.fences === 1,
        'retire+再起+ensure 齐 → healed  →  ' + JSON.stringify(healed));
    });
    const retryFail = S.planFenceHeal({
      error: 'consumer_fenced: x',
      runId: 'run_x',
      retired: { ok: true },
      retried: { ok: false, error: '还是 fence' },
      ensured: { ok: true },
    });
    await t.test('再起失败 → 不许 ok:true', () => {
      assert.ok(retryFail.ok === false && retryFail.action === 'retry',
        '再起失败 → 不许 ok:true  →  ' + JSON.stringify(retryFail));
    });
  });

});
