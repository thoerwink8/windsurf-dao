// 信箱台幂等脚本 · 纯函数回归（不碰 live orca）
//
// 验的层：①参数/选型 ②终端+中继活着判据（租约+PID，不是历史屏面）
// ③ensure 三岔（秒退/夺回/重建）
// ④收信分流（heartbeat 不落盘、业务信落盘）⑤check JSON 多形态解析
// ⑥重建命令串（run-use 由 relay 进程自己做，--command 不走 stdin）
// ⑦waitReady / finalizeEnsure 故障注入（超时与夺回失败必须 ok:false 非零）
// 判别力：READY 历史行当活、或超时仍 ok:true，必有一条变红。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'inbox-station.mjs');
const SCRIPT_LOAD = import('file://' + SCRIPT.replace(/\\/g, '/'));

describe('inbox-station', () => {
  it('① 参数 / 选型', async (t) => {
    const S = await SCRIPT_LOAD;
    const a = S.parseArgs(['node', 'inbox-station.mjs']);
    await t.test('默认命令 ensure', () => {
      assert.ok(a.cmd === 'ensure', '默认命令 ensure');
    });
    await t.test('默认 timeout 15s', () => {
      assert.ok(a.timeoutMs === 15000, '默认 timeout 15s');
    });
    const b = S.parseArgs(['node', 'x', 'relay', '--run', 'run_abc', '--log', 'x.log', '--timeout-ms', '5000']);
    await t.test('relay + run/log', () => {
      assert.ok(b.cmd === 'relay' && b.run === 'run_abc' && b.log === 'x.log' && b.timeoutMs === 5000, 'relay + run/log');
    });
    let threw = false;
    try { S.parseArgs(['node', 'x', 'explode']); } catch { threw = true; }
    await t.test('未知命令抛错', () => {
      assert.ok(threw, '未知命令抛错');
    });
    let threw2 = false;
    try { S.parseArgs(['node', 'x', 'ensure', '--nope']); } catch { threw2 = true; }
    await t.test('未知参数抛错', () => {
      assert.ok(threw2, '未知参数抛错');
    });
  });

  it('pickRun 选 run', async (t) => {
    const S = await SCRIPT_LOAD;
    const runs = [
      { id: 'run_legacy_local', legacy: 1, updated_at: '2026-08-20T00:00:00Z' },
      { id: 'run_old', legacy: 0, updated_at: '2026-08-14T00:00:00Z' },
      { id: 'run_new', legacy: 0, updated_at: '2026-08-15T06:00:00Z' },
    ];
    await t.test('pickRun 跳过 legacy 取最新', () => {
      assert.ok(S.pickRun(runs).id === 'run_new', 'pickRun 跳过 legacy 取最新');
    });
    await t.test('pickRun --run 优先', () => {
      assert.ok(S.pickRun(runs, { preferredId: 'run_old' }).id === 'run_old', 'pickRun --run 优先');
    });
    await t.test('pickRun current 次之', () => {
      assert.ok(S.pickRun(runs, { currentId: 'run_old' }).id === 'run_old', 'pickRun current 次之');
    });
    await t.test('pickRun 空列表空', () => {
      assert.ok(S.pickRun([]) === null, 'pickRun 空列表空');
    });
    await t.test('pickRun 只认在途 allowedIds', () => {
      assert.ok(S.pickRun(runs, { allowedIds: ['run_old'] }).id === 'run_old', 'pickRun 只认在途 allowedIds');
    });
    await t.test('pickRun 无在途 → 空（不认最新墓碑）', () => {
      assert.ok(S.pickRun(runs, { allowedIds: [] }) === null, 'pickRun 无在途 → 空（不认最新墓碑）');
    });
  });

  it('② 终端 + 中继活着（#493 返工：身份从 coordinator_handle 取，标题只出不进）', async (t) => {
    const S = await SCRIPT_LOAD;
    const titled = { handle: 'term_a', title: '◑ 信箱台（勿关）', connected: true, preview: 'PS>' };
    await t.test('runShort 去掉 run_ 前缀', () => {
      assert.ok(S.runShort('run_bfd7e4e193ce') === 'bfd7e4e193ce', 'runShort 去掉 run_ 前缀');
    });
    await t.test('stationTitle 带 run 后缀（输出给人看）', () => {
      assert.ok(S.stationTitle('run_bfd7e4e193ce') === '信箱台·bfd7e4e193ce（勿关）', 'stationTitle 带 run 后缀（输出给人看）');
    });
    await t.test('defaultLogRel 按 run 隔离', () => {
      assert.ok(S.defaultLogRel('run_bfd7e4e193ce').replace(/\\/g, '/') === '_flow/inbox-bfd7e4e193ce.log', 'defaultLogRel 按 run 隔离');
    });
    await t.test('defaultLogRel 无 run 兑底 inbox.log', () => {
      assert.ok(S.defaultLogRel(null) === S.DEFAULT_LOG_REL, 'defaultLogRel 无 run 兑底 inbox.log');
    });

    // 身份 = run-show 的 coordinator_handle：标题是 pwsh.exe 也认得；标题是信箱台也认得
    const reset = { handle: 'term_station', title: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', connected: true };
    const fancy = { handle: 'term_fancy', title: S.stationTitle('run_ev'), connected: true };
    await t.test('按 handle 认出被重置标题的台', () => {
      assert.ok(S.findCoordinatorTerminal([reset, fancy], 'term_station')?.handle === 'term_station', '按 handle 认出被重置标题的台');
    });
    await t.test('按 handle 认出正常标题的台', () => {
      assert.ok(S.findCoordinatorTerminal([reset, fancy], 'term_fancy')?.handle === 'term_fancy', '按 handle 认出正常标题的台');
    });
    await t.test('coordinator 空 → null', () => {
      assert.ok(S.findCoordinatorTerminal([reset], null) === null, 'coordinator 空 → null');
    });
    await t.test('handle 不在列表 → null', () => {
      assert.ok(S.findCoordinatorTerminal([reset], 'term_nope') === null, 'handle 不在列表 → null');
    });
    await t.test('非数组 → null', () => {
      assert.ok(S.findCoordinatorTerminal(null, 'term_a') === null, '非数组 → null');
    });

    const now = 1_000_000;
    const liveLease = { pid: process.pid, runId: 'run_ev', ts: now, ttlMs: S.LEASE_TTL_MS };
    const deadPidLease = { pid: 2147483647, runId: 'run_ev', ts: now, ttlMs: S.LEASE_TTL_MS };
    const staleLease = { pid: process.pid, runId: 'run_ev', ts: now - S.LEASE_TTL_MS - 1, ttlMs: S.LEASE_TTL_MS };
    const wrongRunLease = { pid: process.pid, runId: 'run_other', ts: now, ttlMs: S.LEASE_TTL_MS };
    await t.test('isStationAlive 新鲜+PID在+runId对 = 活', () => {
      assert.ok(S.isStationAlive(liveLease, 'run_ev', { now }) === true, 'isStationAlive 新鲜+PID在+runId对 = 活');
    });
    await t.test('isStationAlive 死 PID = 死', () => {
      assert.ok(S.isStationAlive(deadPidLease, 'run_ev', { now }) === false, 'isStationAlive 死 PID = 死');
    });
    await t.test('isStationAlive 过期租约 = 死', () => {
      assert.ok(S.isStationAlive(staleLease, 'run_ev', { now }) === false, 'isStationAlive 过期租约 = 死');
    });
    await t.test('isStationAlive runId 不对 = 死', () => {
      assert.ok(S.isStationAlive(wrongRunLease, 'run_ev', { now }) === false, 'isStationAlive runId 不对 = 死');
    });
    await t.test('isStationAlive 无租约 = 死', () => {
      assert.ok(S.isStationAlive(null, 'run_ev') === false, 'isStationAlive 无租约 = 死');
    });

    await t.test('未连 = 死', () => {
      assert.ok(S.isRelayAlive({ ...titled, connected: false }) === false, '未连 = 死');
    });
    await t.test('孤儿 = 死', () => {
      assert.ok(S.isRelayAlive({ ...titled, connected: true, orphaned: true }) === false, '孤儿 = 死');
    });
    await t.test('只有标题没有中继痕迹 = 死', () => {
      assert.ok(S.isRelayAlive(titled) === false, '只有标题没有中继痕迹 = 死');
    });
    await t.test('isRelayAlive 租约 runId 不对 = 死', () => {
      assert.ok(S.isRelayAlive(reset, { lease: wrongRunLease, runId: 'run_ev', now }) === false, 'isRelayAlive 租约 runId 不对 = 死');
    });

    // 审官红1 原样：connected + lastOutputAt:0 + 仅历史 READY preview
    const residue = {
      handle: 'term_a',
      title: S.TITLE,
      connected: true,
      lastOutputAt: 0,
      preview: `${S.READY_MARK} run=x\nnode scripts/inbox-station.mjs relay\norchestration check --wait`,
    };
    await t.test('READY 历史行在但 relay 已退出 = 死', () => {
      assert.ok(S.isRelayAlive(residue) === false, 'READY 历史行在但 relay 已退出 = 死');
    });
    await t.test('脚本名/check 历史残留不能当活', () => {
      assert.ok(S.isRelayAlive({
        handle: 'term_a', title: S.TITLE, connected: true,
        preview: 'node scripts/inbox-station.mjs relay',
      }) === false, '脚本名/check 历史残留不能当活');
    });

    await t.test('新鲜租约 + 本进程 PID = 活', () => {
      assert.ok(S.isRelayAlive(residue, { lease: liveLease, now }) === true, '新鲜租约 + 本进程 PID = 活');
    });
    await t.test('新鲜租约但 PID 已死 = 死', () => {
      assert.ok(S.isRelayAlive(residue, { lease: deadPidLease, now }) === false, '新鲜租约但 PID 已死 = 死');
    });
    await t.test('过期租约 + 活 PID = 死', () => {
      assert.ok(S.isRelayAlive(residue, { lease: staleLease, now }) === false, '过期租约 + 活 PID = 死');
    });
    await t.test('preview 已滚没但租约新鲜+PID 活 = 活', () => {
      assert.ok(S.isRelayAlive({
        handle: 'term_a', title: S.TITLE, connected: true, preview: 'PS>',
      }, { lease: liveLease, now }) === true, 'preview 已滚没但租约新鲜+PID 活 = 活');
    });

    await t.test('parseLease 坏 JSON → null', () => {
      assert.ok(S.parseLease('not-json') === null, 'parseLease 坏 JSON → null');
    });
    await t.test('parseLease 缺 pid → null', () => {
      assert.ok(S.parseLease(JSON.stringify({ ts: now })) === null, 'parseLease 缺 pid → null');
    });
    const parsed = S.parseLease(S.formatLease({ pid: 12, runId: 'run_x', ts: now, ttlMs: 9000 }));
    await t.test('format/parse 租约往返', () => {
      assert.ok(parsed && parsed.pid === 12 && parsed.runId === 'run_x' && parsed.ttlMs === 9000, 'format/parse 租约往返');
    });
    const withHandle = S.parseLease(S.formatLease({ pid: 12, runId: 'run_x', ts: now, ttlMs: 9000, handle: 'term_s' }));
    await t.test('租约可带 handle', () => {
      assert.ok(withHandle && withHandle.handle === 'term_s', '租约可带 handle');
    });
    await t.test('旧租约无 handle 仍可读', () => {
      assert.ok(parsed.handle == null, '旧租约无 handle 仍可读');
    });
    await t.test('mergeLeaseHandle 保留旧 handle', () => {
      assert.ok(S.mergeLeaseHandle({ handle: 'term_old' }, null) === 'term_old', 'mergeLeaseHandle 保留旧 handle');
    });
    await t.test('#601 mergeLeaseHandle 拒用帅 handle 顶掉台', () => {
      assert.ok(S.mergeLeaseHandle({ handle: 'term_station' }, 'term_shuai') === 'term_station', 'mergeLeaseHandle 拒用帅 handle 顶掉台');
    });
    await t.test('#601 rebuild 可盖新台 handle', () => {
      assert.ok(S.acceptLeaseHandleStamp({ prevHandle: 'term_old', nextHandle: 'term_new', source: 'rebuild' }) === true, 'rebuild 可盖新台 handle');
    });
    await t.test('#601 ensure 不得用帅 handle 覆写', () => {
      assert.ok(S.acceptLeaseHandleStamp({ prevHandle: 'term_station', nextHandle: 'term_shuai', source: 'ensure' }) === false, 'ensure 不得用帅 handle 覆写');
    });
    await t.test('#601 ensure 没有旧 handle 也不收 coordinator', () => {
      assert.ok(S.acceptLeaseHandleStamp({ prevHandle: null, nextHandle: 'term_shuai', source: 'ensure' }) === false, 'ensure 没有旧 handle 也不收 coordinator');
    });
    const stolenWrite = S.planEnsureLeaseStamp({
      action: 'ok', leaseHandle: 'term_station', rebuiltHandle: null,
    });
    await t.test('#601 生产写入：借走 coordinator 不 stamp', () => {
      assert.ok(stolenWrite.stamp === false && stolenWrite.handle === 'term_station', '借走 coordinator 不 stamp');
    });
    const noLeaseWrite = S.planEnsureLeaseStamp({
      action: 'ok', leaseHandle: null, rebuiltHandle: null,
    });
    await t.test('#601 生产写入：无租约 handle 也不收 coordinator', () => {
      assert.ok(noLeaseWrite.stamp === false && noLeaseWrite.handle == null, '无租约 handle 也不收 coordinator');
    });
    const rebuildWrite = S.planEnsureLeaseStamp({
      action: 'rebuild', leaseHandle: 'term_old', rebuiltHandle: 'term_new',
    });
    await t.test('#601 生产写入：rebuild 才盖新台', () => {
      assert.ok(rebuildWrite.stamp === true && rebuildWrite.handle === 'term_new', 'rebuild 才盖新台');
    });
    await t.test('本进程 PID 活', () => {
      assert.ok(S.isProcessAlive(process.pid) === true, '本进程 PID 活');
    });
    await t.test('非法 PID 死', () => {
      assert.ok(S.isProcessAlive(0) === false && S.isProcessAlive(-1) === false, '非法 PID 死');
    });
    await t.test('leasePath 落在日志同目录且按日志名区分', () => {
      assert.ok(S.leasePath('D:/repo/_flow/inbox.log').replace(/\\/g, '/').endsWith('/_flow/inbox.lease'), 'leasePath 落在日志同目录且按日志名区分');
    });
    await t.test('默认日志的租约按 run 隔离', () => {
      assert.ok(S.leasePath('D:/repo/_flow/inbox-72d9e54bbf7f.log').replace(/\\/g, '/').endsWith('/_flow/inbox-72d9e54bbf7f.lease'), '默认日志的租约按 run 隔离');
    });
    await t.test('显式日志的租约跟随日志名', () => {
      assert.ok(S.leasePath('D:/repo/_flow/inbox-A.log').replace(/\\/g, '/').endsWith('/_flow/inbox-A.lease'), '显式日志的租约跟随日志名');
    });
    await t.test('启动脚本也按日志名区分', () => {
      assert.ok(S.launchFilePath('D:/repo/_flow/inbox-72d9e54bbf7f.log').replace(/\\/g, '/').endsWith('/_flow/inbox-72d9e54bbf7f.cmd'), '启动脚本也按日志名区分');
    });
    await t.test('两条 run 的租约不共用', () => {
      assert.ok(S.leasePath('D:/repo/_flow/inbox-72d9e54bbf7f.log') !== S.leasePath('D:/repo/_flow/inbox-883935d71262.log'), '两条 run 的租约不共用');
    });
  });

  it('③ ensure 判定（#493 返工：coordinator_handle 是身份，标题只出不进）', async (t) => {
    const S = await SCRIPT_LOAD;
    const now = 2_000_000;
    const RUN = 'run_ev';
    const freshLease = { pid: process.pid, runId: RUN, ts: now, ttlMs: S.LEASE_TTL_MS, handle: 'term_station' };
    const freshLease2 = { pid: process.pid, runId: RUN, ts: now, ttlMs: S.LEASE_TTL_MS, handle: 'term_station2' };
    const staleLease = { pid: process.pid, runId: RUN, ts: now - S.LEASE_TTL_MS - 1, ttlMs: S.LEASE_TTL_MS };
    const wrongRunLease = { pid: process.pid, runId: 'run_other', ts: now, ttlMs: S.LEASE_TTL_MS };
    // 审官红1 的现场：台的标题被重置成 pwsh.exe，但 run-show 的 coordinator_handle 仍是它
    const resetStation = { handle: 'term_station', title: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', connected: true };
    const station = { handle: 'term_station2', title: S.stationTitle(RUN), connected: true };
    const shuaiTerm = { handle: 'term_shuai', title: 'A 主帅（Branch）', connected: true };

    // ★ 判别测试：标题被重置成 pwsh.exe 仍按 coordinator_handle 认出自己的台 → ok / all-alive / handle 不变
    const resetDec = S.decideEnsureAction({
      runId: RUN, coordinatorHandle: 'term_station', terminals: [resetStation, shuaiTerm], lease: freshLease, now,
    });
    await t.test('★ 标题被重置仍认出台 → ok', () => {
      assert.ok(resetDec.action === 'ok' && resetDec.reason === 'all-alive', '★ 标题被重置仍认出台 → ok');
    });
    await t.test('★ 标题被重置 handle 不变', () => {
      assert.ok(resetDec.handle === 'term_station', '★ 标题被重置 handle 不变');
    });
    await t.test('★ 标题被重置不新建不顶替（无 rebuild/restart/reject）',
      () => {
        assert.ok(!['rebuild', 'restart', 'reject'].includes(resetDec.action), '★ 标题被重置不新建不顶替（无 rebuild/restart/reject）');
      });

    // 正常标题的台同样 ok
    const okDec = S.decideEnsureAction({
      runId: RUN, coordinatorHandle: 'term_station2', terminals: [station], lease: freshLease2, now,
    });
    await t.test('正常标题 → ok', () => {
      assert.ok(okDec.action === 'ok' && okDec.reason === 'all-alive' && okDec.handle === 'term_station2', '正常标题 → ok');
    });
    const stolenDec = S.decideEnsureAction({
      runId: RUN, coordinatorHandle: 'term_shuai', terminals: [resetStation, shuaiTerm], lease: freshLease, now,
    });
    await t.test('coordinator 在帅的终端但中继活 → ok', () => {
      assert.ok(stolenDec.action === 'ok', 'coordinator 在帅的终端但中继活 → ok');
    });
    await t.test('#601 借走时返回租约 handle 不是帅', () => {
      assert.ok(stolenDec.handle === 'term_station', '借走时返回租约 handle 不是帅');
    });
    // coordinator 还没回来（null）但中继活 → ok
    await t.test('coordinator 暂空但中继活 → ok', () => {
      assert.ok(S.decideEnsureAction({
        runId: RUN, coordinatorHandle: null, terminals: [resetStation], lease: freshLease, now,
      }).action === 'ok', 'coordinator 暂空但中继活 → ok');
    });

    // 台死了：租约过期 + coordinator 挂在死壳/帅的终端上 → restart（本 run 台死重启，不碰别人）
    const restartDec = S.decideEnsureAction({
      runId: RUN, coordinatorHandle: 'term_station', terminals: [resetStation], lease: staleLease, now,
    });
    await t.test('台死 + coordinator 在死壳 → restart', () => {
      assert.ok(restartDec.action === 'restart' && restartDec.reason === 'relay-dead', '台死 + coordinator 在死壳 → restart');
    });
    await t.test('台死 + coordinator 空 → restart', () => {
      assert.ok(S.decideEnsureAction({
        runId: RUN, coordinatorHandle: null, terminals: [], lease: staleLease, now,
      }).action === 'restart', '台死 + coordinator 空 → restart');
    });

    // 从没有台：无租约 + 无 coordinator → rebuild（本 run 无台新建）
    const rebuildDec = S.decideEnsureAction({
      runId: RUN, coordinatorHandle: null, terminals: [], lease: null, now,
    });
    await t.test('无台无租约 → rebuild', () => {
      assert.ok(rebuildDec.action === 'rebuild' && rebuildDec.reason === 'no-terminal', '无台无租约 → rebuild');
    });
    // coordinator 在帅的终端但无本 run 租约 → rebuild（帅的终端不是台，绝不复用/顶替）
    await t.test('coordinator 在帅的终端且无租约 → rebuild 不动它', () => {
      assert.ok(S.decideEnsureAction({
        runId: RUN, coordinatorHandle: 'term_shuai', terminals: [shuaiTerm], lease: null, now,
      }).action === 'rebuild', 'coordinator 在帅的终端且无租约 → rebuild 不动它');
    });
    // 租约 runId 不对（别人的）→ 当没有
    await t.test('租约 runId 不对 → 当无台 rebuild', () => {
      assert.ok(S.decideEnsureAction({
        runId: RUN, coordinatorHandle: null, terminals: [], lease: wrongRunLease, now,
      }).action === 'rebuild', '租约 runId 不对 → 当无台 rebuild');
    });

    // 撞上别的 run 的台：本 run 台死，coordinator 被别的 run 的活台占着 → reject + 报对方 run id
    const rejectDec = S.decideEnsureAction({
      runId: RUN, coordinatorHandle: 'term_foreign',
      terminals: [{ handle: 'term_foreign', title: S.stationTitle('run_other'), connected: true }],
      lease: staleLease, now,
      foreignStation: { runId: 'run_other', handle: 'term_foreign' },
    });
    await t.test('撞上别的 run 的台 → reject', () => {
      assert.ok(rejectDec.action === 'reject' && rejectDec.reason === 'foreign-station', '撞上别的 run 的台 → reject');
    });
    await t.test('拒绝时报出对方 run id', () => {
      assert.ok(rejectDec.foreignRunId === 'run_other' && rejectDec.foreignHandle === 'term_foreign', '拒绝时报出对方 run id');
    });
    // 回归反例：任何场景不得再返回 ok:true/rebuild/coordinator-stolen
    await t.test('回归反例：不再出现 ok:true+rebuild+coordinator-stolen',
      () => {
        assert.ok(![resetDec, okDec, restartDec, rebuildDec, rejectDec].some(
          (d) => d.ok === true && d.action === 'rebuild' && d.reason === 'coordinator-stolen'), '回归反例：不再出现 ok:true+rebuild+coordinator-stolen');
      });
    await t.test('回归反例：reject 不带 ok:true', () => {
      assert.ok(rejectDec.ok !== true, '回归反例：reject 不带 ok:true');
    });
  });

  it('④ 收信分流（heartbeat 不落盘）', async (t) => {
    const S = await SCRIPT_LOAD;
    const batch = [
      { id: 'm1', type: 'heartbeat', subject: 'alive', body: '' },
      { id: 'm2', type: 'worker_done', subject: '完工', body: 'PR #466' },
      { id: 'm3', type: 'HEARTBEAT', subject: 'alive', body: '' },
      { id: 'm4', type: 'question', subject: '问', body: 'x' },
    ];
    const { loggable, heartbeats } = S.splitMessages(batch);
    await t.test('两条业务信落盘', () => {
      assert.ok(loggable.map((m) => m.id).join(',') === 'm2,m4', '两条业务信落盘');
    });
    await t.test('两条心跳不落盘', () => {
      assert.ok(heartbeats.length === 2, '两条心跳不落盘');
    });
    await t.test('heartbeat 判定大小写不敏感', () => {
      assert.ok(S.shouldLogMessage({ type: 'HeartBeat' }) === false, 'heartbeat 判定大小写不敏感');
    });
    await t.test('worker_done 要落盘', () => {
      assert.ok(S.shouldLogMessage({ type: 'worker_done' }) === true, 'worker_done 要落盘');
    });
    await t.test('空 type 当业务信', () => {
      assert.ok(S.shouldLogMessage({ subject: 'x' }) === true, '空 type 当业务信');
    });

    const line = S.formatLogLine({
      id: 'm2', type: 'worker_done', from_handle: 'term_w', subject: '完工', body: 'PR #466',
    }, new Date('2026-08-15T07:00:00.000Z'));
    const obj = JSON.parse(line);
    await t.test('日志是一行 JSON', () => {
      assert.ok(obj.id === 'm2' && obj.type === 'worker_done' && obj.body === 'PR #466', '日志是一行 JSON');
    });
    await t.test('日志带 ts', () => {
      assert.ok(obj.ts === '2026-08-15T07:00:00.000Z', '日志带 ts');
    });
    await t.test('心跳若被 format 也不会当业务（分流在前）', () => {
      assert.ok(!loggable.some((m) => m.type && m.type.toLowerCase() === 'heartbeat'), '心跳若被 format 也不会当业务（分流在前）');
    });
  });

  it('⑤ check JSON 多形态', async (t) => {
    const S = await SCRIPT_LOAD;
    const a = S.parseCheckResult({
      ok: true,
      result: { delivery_id: 'del_1', messages: [{ id: 'm1', type: 'question' }] },
    });
    await t.test('result.delivery_id + messages', () => {
      assert.ok(a.deliveryId === 'del_1' && a.messages[0].id === 'm1', 'result.delivery_id + messages');
    });

    const b = S.parseCheckResult({
      result: { delivery: { id: 'del_2', messages: [{ id: 'm2' }] } },
    });
    await t.test('result.delivery.id 嵌套', () => {
      assert.ok(b.deliveryId === 'del_2' && b.messages[0].id === 'm2', 'result.delivery.id 嵌套');
    });

    const c = S.parseCheckResult({ messages: [], deliveryId: 'del_3' });
    await t.test('顶层 deliveryId 空消息', () => {
      assert.ok(c.deliveryId === 'del_3' && c.messages.length === 0, '顶层 deliveryId 空消息');
    });

    const d = S.parseCheckResult({ ok: true, result: {} });
    await t.test('空 result 不炸', () => {
      assert.ok(d.messages.length === 0 && d.deliveryId === null, '空 result 不炸');
    });

    const e = S.parseOrcaStdout('noise\n{"ok":true,"result":{"x":1}}\n');
    await t.test('stdout 夹杂时取 JSON', () => {
      assert.ok(e.ok === true && e.json.result.x === 1, 'stdout 夹杂时取 JSON');
    });
    await t.test('空 stdout 失败', () => {
      assert.ok(S.parseOrcaStdout('').ok === false, '空 stdout 失败');
    });
    const plain = fs.readFileSync(path.join(__dirname, 'fixtures', 'orca-json', 'terminal-send-plaintext.txt'), 'utf8');
    const sent = S.parseOrcaStdout(plain);
    await t.test('Sent N bytes to term_ 判成功（#580 真语料）', () => {
      assert.ok(sent.ok === true && sent.sentPlaintext === true && sent.bytes === 11, 'Sent N bytes to term_ 判成功（#580 真语料）  →  ' + JSON.stringify(sent));
    });
    await t.test('Sent N bytes 归一成 result.send.accepted', () => {
      assert.ok(sent.json?.result?.send?.accepted === true, 'Sent N bytes 归一成 result.send.accepted');
    });
    const jsonSend = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'orca-json', 'terminal-send.json'), 'utf8'));
    const parsedJson = S.parseOrcaStdout(JSON.stringify(jsonSend));
    await t.test('send --json 信封过解析', () => {
      assert.ok(parsedJson.ok === true && parsedJson.json.result.send.accepted === true, 'send --json 信封过解析');
    });
  });

  it('⑥ 重建命令串 / 现状 JSON', async (t) => {
    const S = await SCRIPT_LOAD;
    const script = S.buildLaunchScript({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      scriptPath: 'C:\\repo\\scripts\\inbox-station.mjs',
      runId: 'run_af8',
      logPath: 'D:\\frank\\windsurf-dao\\_flow\\inbox.log',
    });
    await t.test('启动串先 run-use', () => {
      assert.ok(/^\s*orca orchestration run-use --id run_af8/m.test(script), '启动串先 run-use');
    });
    await t.test('启动串再进 relay', () => {
      assert.ok(/inbox-station\.mjs" relay --run run_af8/.test(script), '启动串再进 relay');
    });
    await t.test('启动串含 --log', () => {
      assert.ok(script.includes('--log') && script.includes('inbox.log'), '启动串含 --log');
    });
    const cmd = S.buildRelayCommand({ launchPath: 'D:\\frank\\windsurf-dao\\_flow\\inbox-station.cmd' });
    await t.test('create --command 走 cmd 文件', () => {
      assert.ok(cmd.includes('cmd.exe /c') && cmd.includes('inbox-station.cmd'), 'create --command 走 cmd 文件');
    });
    await t.test('命令不走 stdin/send', () => {
      assert.ok(!/terminal send/.test(cmd) && !cmd.includes('--enter'), '命令不走 stdin/send');
    });

    const st = S.statusPayload({
      runId: 'run_x', handle: 'term_y', logPath: 'p', action: 'ok', reason: 'all-alive',
    });
    await t.test('现状 JSON 三件套', () => {
      assert.ok(st.runId === 'run_x' && st.handle === 'term_y' && st.logPath === 'p', '现状 JSON 三件套');
    });
    await t.test('现状 JSON ok', () => {
      assert.ok(st.ok === true && st.action === 'ok', '现状 JSON ok');
    });
    const stFail = S.statusPayload({
      ok: false, runId: 'run_x', handle: 'term_y', logPath: 'p',
      action: 'rebuild', reason: 'relay-not-alive', error: '中继未存活',
    });
    await t.test('现状 JSON 失败带 ok:false', () => {
      assert.ok(stFail.ok === false && stFail.error === '中继未存活', '现状 JSON 失败带 ok:false');
    });

    await t.test('标题常量（旧格式裸标题保留作识别用）', () => {
      assert.ok(S.TITLE === '信箱台（勿关）', '标题常量（旧格式裸标题保留作识别用）');
    });
    await t.test('新标题带 run 后缀', () => {
      assert.ok(S.stationTitle('run_af8fc3144eb7') === '信箱台·af8fc3144eb7（勿关）', '新标题带 run 后缀');
    });
    await t.test('unwrap result.key', () => {
      assert.ok(S.unwrapOrca({ result: { terminals: [1] } }, 'terminals')[0] === 1, 'unwrap result.key');
    });
    await t.test('extractHandle 几种形状', () => {
      assert.ok(S.extractHandle({ result: { handle: 'term_z' } }) === 'term_z', 'extractHandle 几种形状');
    });
    await t.test('findMainWorktree', () => {
      assert.ok(S.findMainWorktree([
        { id: 'a', isMainWorktree: false },
        { id: 'b', isMainWorktree: true },
      ]).id === 'b', 'findMainWorktree');
    });
  });

  it('⑦ waitReady / finalizeEnsure 故障注入', async (t) => {
    const S = await SCRIPT_LOAD;
    const now = 2_000_000;
    const term = { handle: 'term_box', title: S.TITLE, connected: true, preview: S.READY_MARK };
    const liveLease = { pid: process.pid, ts: now, ttlMs: S.LEASE_TTL_MS };

    await t.test('decideReady 全好 → ok', () => {
      assert.ok(S.decideReady({
        terminal: term, lease: liveLease, coordinatorHandle: 'term_box', now,
      }).ok === true, 'decideReady 全好 → ok');
    });
    await t.test('decideReady 无终端 → 失败', () => {
      assert.ok(S.decideReady({
        terminal: null, lease: liveLease, coordinatorHandle: 'term_box', now,
      }).ok === false, 'decideReady 无终端 → 失败');
    });
    await t.test('decideReady 历史 READY 无租约 → relay-not-alive', () => {
      assert.ok(S.decideReady({
        terminal: term, lease: null, coordinatorHandle: 'term_box', now,
      }).error === 'relay-not-alive', 'decideReady 历史 READY 无租约 → relay-not-alive');
    });
    await t.test('decideReady coordinator 空 → coordinator-not-held', () => {
      assert.ok(S.decideReady({
        terminal: term, lease: liveLease, coordinatorHandle: null, now,
      }).error === 'coordinator-not-held', 'decideReady coordinator 空 → coordinator-not-held');
    });
    await t.test('decideReady coordinator 是别人 → coordinator-not-held', () => {
      assert.ok(S.decideReady({
        terminal: term, lease: liveLease, coordinatorHandle: 'term_thief', now,
      }).error === 'coordinator-not-held', 'decideReady coordinator 是别人 → coordinator-not-held');
    });

    await t.test('超时不得降级成功', () => {
      assert.ok(S.acceptRebuildReady({ ok: false, error: 'timeout' }).ok === false, '超时不得降级成功');
    });
    await t.test('超时不得带 warning 当成功', () => {
      assert.ok(!('warning' in S.acceptRebuildReady({ ok: false, error: 'timeout' })), '超时不得带 warning 当成功');
    });
    await t.test('acceptRebuildReady 成功带 handle', () => {
      assert.ok(S.acceptRebuildReady({
        ok: true, terminal: term,
      }).handle === 'term_box', 'acceptRebuildReady 成功带 handle');
    });

    const base = {
      handle: 'term_box', runId: 'run_x', logPath: 'p', action: 'rebuild', reason: 'no-terminal',
    };
    const deadRelay = S.finalizeEnsure({ ...base, relayAlive: false, runShowOk: true, coordinatorHandle: 'term_box' });
    await t.test('finalize 中继死 → ok:false 非零', () => {
      assert.ok(deadRelay.exitCode === 1 && deadRelay.payload.ok === false, 'finalize 中继死 → ok:false 非零');
    });
    await t.test('finalize 中继死 reason', () => {
      assert.ok(deadRelay.payload.reason === 'relay-not-alive', 'finalize 中继死 reason');
    });

    const showFail = S.finalizeEnsure({ ...base, relayAlive: true, runShowOk: false, coordinatorHandle: null });
    await t.test('finalize run-show 失败 → ok:false 非零', () => {
      assert.ok(showFail.exitCode === 1 && showFail.payload.ok === false, 'finalize run-show 失败 → ok:false 非零');
    });
    await t.test('finalize run-show 失败 reason', () => {
      assert.ok(showFail.payload.reason === 'coordinator-unknown', 'finalize run-show 失败 reason');
    });

    const emptyCoord = S.finalizeEnsure({ ...base, relayAlive: true, runShowOk: true, coordinatorHandle: null });
    await t.test('finalize coordinator 空 → ok:false 非零', () => {
      assert.ok(emptyCoord.exitCode === 1 && emptyCoord.payload.ok === false, 'finalize coordinator 空 → ok:false 非零');
    });
    await t.test('finalize coordinator 空 reason', () => {
      assert.ok(emptyCoord.payload.reason === 'coordinator-not-held', 'finalize coordinator 空 reason');
    });

    const stolen = S.finalizeEnsure({ ...base, relayAlive: true, runShowOk: true, coordinatorHandle: 'term_thief' });
    await t.test('finalize 未夺回 → ok:false 非零', () => {
      assert.ok(stolen.exitCode === 1 && stolen.payload.ok === false, 'finalize 未夺回 → ok:false 非零');
    });
    await t.test('finalize 未夺回写出对方 handle', () => {
      assert.ok(stolen.payload.coordinatorHandle === 'term_thief', 'finalize 未夺回写出对方 handle');
    });
    const aliveStolen = S.finalizeEnsure({
      handle: 'term_station', runId: 'run_x', logPath: 'p', action: 'ok', reason: 'all-alive',
      relayAlive: true, runShowOk: true, coordinatorHandle: 'term_thief',
    });
    await t.test('#601 all-alive 时 coordinator 被借走仍秒退', () => {
      assert.ok(aliveStolen.exitCode === 0 && aliveStolen.payload.ok === true, 'all-alive 时 coordinator 被借走仍秒退');
    });

    const okFinal = S.finalizeEnsure({
      ...base, action: 'ok', reason: 'all-alive',
      relayAlive: true, runShowOk: true, coordinatorHandle: 'term_box',
    });
    await t.test('finalize 全好 → ok:true 零退出', () => {
      assert.ok(okFinal.exitCode === 0 && okFinal.payload.ok === true, 'finalize 全好 → ok:true 零退出');
    });
    await t.test('finalize 成功不带 error', () => {
      assert.ok(okFinal.payload.error === undefined, 'finalize 成功不带 error');
    });
  });
});