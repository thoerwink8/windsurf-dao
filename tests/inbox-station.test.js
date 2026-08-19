// 信箱台幂等脚本 · 纯函数回归（不碰 live orca）
//
// 验的层：①参数/选型 ②租约/活性判据（新鲜+PID+handle 在盘面，不是历史屏面）
// ③#638 单台决策（全局台优先/关多余台/旧台全关重建/无台重建/证不出不动）
// ④收信分流（heartbeat 不落盘、业务信落盘）⑤活跃 Run 集与相关消息过滤
// ⑥重建命令串（#638：不再 run-use，纯 inbox 轮询）⑦故障注入
// ⑧#614 只读 gc 阈值行
// 判别力：READY 历史行当活、或多台并存没被收敛、或只读 gc 超阈值没打行，必有一条变红。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'inbox-station.mjs');
const SCRIPT_LOAD = import('file://' + SCRIPT.replace(/\\/g, '/'));

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-test-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  return dir;
}

function writeLease(dir, name, { pid, runId, ts, ttlMs, handle }) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ pid, runId, ts, ttlMs, handle: handle ?? null }) + '\n', 'utf8');
  return file;
}

describe('inbox-station', () => {
  it('① 参数 / 选型', async (t) => {
    const S = await SCRIPT_LOAD;
    const a = S.parseArgs(['node', 'inbox-station.mjs']);
    await t.test('默认命令 ensure', () => {
      assert.ok(a.cmd === 'ensure', '默认命令 ensure');
    });
    await t.test('默认 gc 阈值', () => {
      assert.ok(a.gcThreshold === S.GC_THRESHOLD, '默认 gc 阈值');
    });
    const b = S.parseArgs(['node', 'x', 'relay', '--log', 'x.log', '--timeout-ms', '5000', '--gc-threshold', '9']);
    await t.test('relay + log + 自定义阈值', () => {
      assert.ok(b.cmd === 'relay' && b.log === 'x.log' && b.timeoutMs === 5000 && b.gcThreshold === 9, 'relay + log + 自定义阈值');
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
    let bad = false;
    try { S.parseArgs(['node', 'x', 'ensure', '--gc-threshold', '-1']); } catch { bad = true; }
    await t.test('gc 阈值负数抛错', () => {
      assert.ok(bad, 'gc 阈值负数抛错');
    });
  });

  it('② 租约 / 活性（#493 返工：身份从租约取，标题只出不进）', async (t) => {
    const S = await SCRIPT_LOAD;
    await t.test('runShort 去掉 run_ 前缀', () => {
      assert.ok(S.runShort('run_bfd7e4e193ce') === 'bfd7e4e193ce', 'runShort 去掉 run_ 前缀');
    });
    await t.test('stationTitle 带 run 后缀（历史格式保留）', () => {
      assert.ok(S.stationTitle('run_bfd7e4e193ce') === '信箱台·bfd7e4e193ce（勿关）', 'stationTitle 带 run 后缀');
    });
    await t.test('stationTitle 无 run = 裸标题', () => {
      assert.ok(S.stationTitle(null) === '信箱台（勿关）', 'stationTitle 无 run = 裸标题');
    });
    await t.test('defaultLogRel 按 run 隔离（历史格式）', () => {
      assert.ok(S.defaultLogRel('run_bfd7e4e193ce').replace(/\\/g, '/') === '_flow/inbox-bfd7e4e193ce.log', 'defaultLogRel 按 run 隔离');
    });
    await t.test('defaultLogRel 无 run = 全局 inbox.log', () => {
      assert.ok(S.defaultLogRel(null) === S.DEFAULT_LOG_REL, 'defaultLogRel 无 run = 全局 inbox.log');
    });

    const now = 1_000_000;
    const liveLease = { pid: process.pid, runId: null, ts: now, ttlMs: S.LEASE_TTL_MS };
    const deadPidLease = { pid: 2147483647, runId: null, ts: now, ttlMs: S.LEASE_TTL_MS };
    const staleLease = { pid: process.pid, runId: null, ts: now - S.LEASE_TTL_MS - 1, ttlMs: S.LEASE_TTL_MS };
    await t.test('isStationAlive 新鲜+PID在 = 活', () => {
      assert.ok(S.isStationAlive(liveLease, { now }) === true, 'isStationAlive 新鲜+PID在 = 活');
    });
    await t.test('isStationAlive 死 PID = 死', () => {
      assert.ok(S.isStationAlive(deadPidLease, { now }) === false, 'isStationAlive 死 PID = 死');
    });
    await t.test('isStationAlive 过期租约 = 死', () => {
      assert.ok(S.isStationAlive(staleLease, { now }) === false, 'isStationAlive 过期租约 = 死');
    });
    await t.test('isStationAlive 无租约 = 死', () => {
      assert.ok(S.isStationAlive(null) === false, 'isStationAlive 无租约 = 死');
    });

    await t.test('isRelayAlive 未连 = 死', () => {
      assert.ok(S.isRelayAlive({ handle: 'term_a', connected: false }, { lease: liveLease, now }) === false, '未连 = 死');
    });
    await t.test('isRelayAlive 孤儿 = 死', () => {
      assert.ok(S.isRelayAlive({ handle: 'term_a', connected: true, orphaned: true }, { lease: liveLease, now }) === false, '孤儿 = 死');
    });
    await t.test('isRelayAlive 只有标题没有租约 = 死', () => {
      assert.ok(S.isRelayAlive({ handle: 'term_a', connected: true, preview: S.READY_MARK }) === false, '只有标题没有租约 = 死');
    });
    await t.test('isRelayAlive 租约新鲜+PID活+已连 = 活', () => {
      assert.ok(S.isRelayAlive({ handle: 'term_a', connected: true, preview: S.READY_MARK }, { lease: liveLease, now }) === true, '租约新鲜+PID活+已连 = 活');
    });
    await t.test('isRelayAlive 过期租约 = 死', () => {
      assert.ok(S.isRelayAlive({ handle: 'term_a', connected: true }, { lease: staleLease, now }) === false, '过期租约 = 死');
    });

    await t.test('isHandleOnBoard 在盘面 = 真', () => {
      assert.ok(S.isHandleOnBoard('term_a', [{ handle: 'term_a' }, { handle: 'term_b' }]) === true, 'isHandleOnBoard 在盘面 = 真');
    });
    await t.test('isHandleOnBoard 不在 = 假', () => {
      assert.ok(S.isHandleOnBoard('term_c', [{ handle: 'term_a' }]) === false, '不在 = 假');
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
    const withHandle = S.parseLease(S.formatLease({ pid: 12, runId: null, ts: now, ttlMs: 9000, handle: 'term_s' }));
    await t.test('租约可带 handle', () => {
      assert.ok(withHandle && withHandle.handle === 'term_s', '租约可带 handle');
    });
    await t.test('mergeLeaseHandle 保留旧 handle', () => {
      assert.ok(S.mergeLeaseHandle({ handle: 'term_old' }, null) === 'term_old', 'mergeLeaseHandle 保留旧 handle');
    });
    await t.test('acceptLeaseHandleStamp rebuild 可盖新台 handle', () => {
      assert.ok(S.acceptLeaseHandleStamp({ prevHandle: 'term_old', nextHandle: 'term_new', source: 'rebuild' }) === true, 'rebuild 可盖新台 handle');
    });
    await t.test('acceptLeaseHandleStamp ensure 不得覆写', () => {
      assert.ok(S.acceptLeaseHandleStamp({ prevHandle: 'term_station', nextHandle: 'term_shuai', source: 'ensure' }) === false, 'ensure 不得覆写');
    });
    const rebuildWrite = S.planEnsureLeaseStamp({ action: 'rebuild', leaseHandle: 'term_old', rebuiltHandle: 'term_new' });
    await t.test('rebuild 才 stamp', () => {
      assert.ok(rebuildWrite.stamp === true && rebuildWrite.handle === 'term_new', 'rebuild 才 stamp');
    });
    const okWrite = S.planEnsureLeaseStamp({ action: 'ok', leaseHandle: 'term_station', rebuiltHandle: null });
    await t.test('all-alive 不 stamp', () => {
      assert.ok(okWrite.stamp === false && okWrite.handle === 'term_station', 'all-alive 不 stamp');
    });
    await t.test('leasePath 落在日志同目录', () => {
      assert.ok(S.leasePath('D:/repo/_flow/inbox.log').replace(/\\/g, '/').endsWith('/_flow/inbox.lease'), 'leasePath 落在日志同目录');
    });
    await t.test('launchFilePath 按日志名区分', () => {
      assert.ok(S.launchFilePath('D:/repo/_flow/inbox-A.log').replace(/\\/g, '/').endsWith('/_flow/inbox-A.cmd'), 'launchFilePath 按日志名区分');
    });
  });

  it('③ #638 单台决策（幂等关多余台 / 无台重建 / 旧台全关重建 / 证不出不动）', async (t) => {
    const S = await SCRIPT_LOAD;
    const now = 2_000_000;

    // 全局台 + 旧 per-run 台并存：留全局，关旧台
    const globalLease = { pid: process.pid, runId: null, ts: now, ttlMs: S.LEASE_TTL_MS, handle: 'term_global' };
    const oldLease = { pid: process.pid, runId: 'run_old', ts: now, ttlMs: S.LEASE_TTL_MS, handle: 'term_old' };
    const oldLease2 = { pid: process.pid, runId: 'run_old2', ts: now, ttlMs: S.LEASE_TTL_MS, handle: 'term_old2' };
    const globalStation = { stem: 'inbox', runId: null, lease: globalLease, files: ['a.lease', 'a.cmd', 'a.log'] };
    const oldStation = { stem: 'inbox-old', runId: 'run_old', lease: oldLease, files: ['b.lease', 'b.cmd', 'b.log'] };
    const oldStation2 = { stem: 'inbox-old2', runId: 'run_old2', lease: oldLease2, files: ['c.lease', 'c.cmd', 'c.log'] };

    const trim = S.planSingleStation({
      stations: [globalStation, oldStation, oldStation2],
      terminals: [{ handle: 'term_global' }, { handle: 'term_old' }, { handle: 'term_old2' }],
      now,
    });
    await t.test('全局台 + 旧台 → ok/closed-extra', () => {
      assert.ok(trim.action === 'ok' && trim.reason === 'closed-extra', '全局台 + 旧台 → ok/closed-extra  →  ' + JSON.stringify(trim));
    });
    await t.test('留全局台', () => {
      assert.ok(trim.keep && trim.keep.stem === 'inbox', '留全局台');
    });
    await t.test('关掉全部旧台', () => {
      assert.ok(trim.close.length === 2
        && trim.close.every((s) => s.stem !== 'inbox')
        && trim.close.map((s) => s.stem).sort().join(',') === 'inbox-old,inbox-old2', '关掉全部旧台');
    });
    await t.test('closed-extra 不再触发 rebuild', () => {
      assert.ok(trim.rebuild === false, 'closed-extra 不再触发 rebuild');
    });

    // 只有全局台活着 → all-alive 秒退
    const only = S.planSingleStation({
      stations: [globalStation],
      terminals: [{ handle: 'term_global' }],
      now,
    });
    await t.test('只有全局台 → ok/all-alive', () => {
      assert.ok(only.action === 'ok' && only.reason === 'all-alive' && only.keep.stem === 'inbox' && only.close.length === 0, '只有全局台 → ok/all-alive');
    });

    // 全局台死了（过期），旧台活着 → 全关 + 重建全局台
    const staleGlobal = S.planSingleStation({
      stations: [{ ...globalStation, lease: { pid: process.pid, runId: null, ts: now - S.LEASE_TTL_MS - 1, ttlMs: S.LEASE_TTL_MS, handle: 'term_global' } }, oldStation],
      terminals: [{ handle: 'term_old' }],
      now,
    });
    await t.test('全局死 + 旧台活 → rebuild/no-global-station + 关旧台', () => {
      assert.ok(staleGlobal.action === 'rebuild' && staleGlobal.reason === 'no-global-station'
        && staleGlobal.rebuild === true && staleGlobal.close.length === 1, '全局死 + 旧台活 → rebuild + 关旧台  →  ' + JSON.stringify(staleGlobal));
    });

    // 一个活台都没有 → rebuild/no-station，不关任何台
    const none = S.planSingleStation({
      stations: [globalStation, oldStation],
      terminals: [],
      now: now + S.LEASE_TTL_MS + 1000,
    });
    await t.test('无活台 → rebuild/no-station', () => {
      assert.ok(none.action === 'rebuild' && none.reason === 'no-station' && none.close.length === 0, '无活台 → rebuild/no-station');
    });

    // 证不出身份（租约无 handle / handle 不在盘面 / 坏租约）→ 不动
    const noHandle = { stem: 'inbox-x', runId: 'run_x', lease: { pid: process.pid, runId: 'run_x', ts: now, ttlMs: S.LEASE_TTL_MS, handle: null }, files: [] };
    const offBoard = { stem: 'inbox-y', runId: 'run_y', lease: { pid: process.pid, runId: 'run_y', ts: now, ttlMs: S.LEASE_TTL_MS, handle: 'term_gone' }, files: [] };
    const badLease = { stem: 'inbox-z', runId: null, lease: null, parseError: true, files: [] };
    const unproven = S.planSingleStation({
      stations: [noHandle, offBoard, badLease],
      terminals: [],
      now,
    });
    await t.test('证不出的租约进 unproven，不关不保', () => {
      assert.ok(unproven.close.length === 0 && unproven.unproven.length === 3, '证不出的租约进 unproven，不关不保  →  ' + JSON.stringify(unproven));
    });
    await t.test('全是证不出 → rebuild（不误关）', () => {
      assert.ok(unproven.action === 'rebuild' && unproven.reason === 'no-station', '全是证不出 → rebuild');
    });

    // scanLeaseStations：从目录扫全局 + 旧模型租约
    const dir = tmpDir(t);
    writeLease(dir, 'inbox.lease', { pid: process.pid, runId: null, ts: now, ttlMs: S.LEASE_TTL_MS, handle: 'term_global' });
    writeLease(dir, 'inbox-abcdef123456.lease', { pid: 999999, runId: 'run_abcdef123456', ts: now, ttlMs: S.LEASE_TTL_MS, handle: 'term_x' });
    fs.writeFileSync(path.join(dir, 'inbox.cmd'), '@echo off\n');
    fs.writeFileSync(path.join(dir, 'inbox-abcdef123456.cmd'), '@echo off\n');
    const scanned = S.scanLeaseStations(dir);
    await t.test('scanLeaseStations 扫到全局 + 旧台', () => {
      assert.ok(scanned.length === 2, 'scanLeaseStations 扫到全局 + 旧台  →  ' + JSON.stringify(scanned.map((s) => s.stem)));
    });
    await t.test('全局台 stem=inbox 且 runId=null', () => {
      const g = scanned.find((s) => s.stem === 'inbox');
      assert.ok(g && g.runId === null && g.lease.handle === 'term_global', '全局台 stem=inbox 且 runId=null');
    });
    await t.test('旧台 runId 从租约取', () => {
      const o = scanned.find((s) => s.stem !== 'inbox');
      assert.ok(o && o.runId === 'run_abcdef123456', '旧台 runId 从租约取');
    });
    await t.test('不扫描非租约文件', () => {
      assert.ok(scanned.every((s) => s.stem.endsWith('.lease') === false), '不扫描非租约文件');
    });
    const badDir = S.scanLeaseStations(path.join(dir, 'nope'));
    await t.test('目录不存在 → 空数组', () => {
      assert.ok(badDir.length === 0, '目录不存在 → 空数组');
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
    const line = S.formatLogLine({
      id: 'm2', type: 'worker_done', from_handle: 'term_w', subject: '完工', body: 'PR #466', run_id: 'run_x',
    }, new Date('2026-08-15T07:00:00.000Z'));
    const obj = JSON.parse(line);
    await t.test('日志是一行 JSON 且带 run_id', () => {
      assert.ok(obj.id === 'm2' && obj.type === 'worker_done' && obj.run_id === 'run_x', '日志是一行 JSON 且带 run_id');
    });
    await t.test('日志带 ts', () => {
      assert.ok(obj.ts === '2026-08-15T07:00:00.000Z', '日志带 ts');
    });
  });

  it('⑤ #638 活跃 Run 集与相关消息过滤', async (t) => {
    const S = await SCRIPT_LOAD;
    const runs = [
      { id: 'run_keep', coordinator_handle: null, legacy: 0 },
      { id: 'run_coord', coordinator_handle: 'term_alive', legacy: 0 },
      { id: 'run_dead', coordinator_handle: 'term_dead', legacy: 0 },
      { id: 'run_legacy', legacy: 1 },
    ];
    const workers = [
      { dispatchId: 'ctx_a', runId: 'run_keep', workerState: 'ready', dispatchStatus: 'dispatched', resource: { worktreeId: 'repo::/wt/a' } },
    ];
    const worktrees = [{ worktreeId: 'repo::/wt/a', isMainWorktree: false, isArchived: false }];
    const terminals = [{ handle: 'term_alive' }];
    const active = S.activeRunIds({ runs, workers, worktrees, terminals });
    await t.test('keep 集 + 活 coordinator 的 Run 进活跃集', () => {
      assert.ok(active.has('run_keep') && active.has('run_coord'), 'keep 集 + 活 coordinator 的 Run 进活跃集  →  ' + JSON.stringify([...active]));
    });
    await t.test('死 coordinator / legacy 不进集', () => {
      assert.ok(!active.has('run_dead') && !active.has('run_legacy'), '死 coordinator / legacy 不进集');
    });

    const msgs = [
      { id: 'm1', run_id: 'run_keep', type: 'worker_done' },
      { id: 'm2', run_id: 'run_coord', type: 'status' },
      { id: 'm3', run_id: 'run_dead', type: 'worker_done' },
      { id: 'm4', run_id: null, type: 'heartbeat' },
      { id: 'm5', run_id: 'run_keep', type: 'worker_done' },
    ];
    const rel = S.relevantMessages(msgs, active);
    await t.test('只收活跃 Run 的信', () => {
      assert.ok(rel.map((m) => m.id).sort().join(',') === 'm1,m2,m5', '只收活跃 Run 的信  →  ' + JSON.stringify(rel.map((m) => m.id)));
    });
    await t.test('同 id 去重（m1/m5 同 id 只留一条）', () => {
      assert.ok(rel.filter((m) => m.id === 'm1').length === 1, '同 id 去重');
    });
    const relSeen = S.relevantMessages(msgs, active, new Set(['m1']));
    await t.test('seen 集里的不再收', () => {
      assert.ok(!relSeen.some((m) => m.id === 'm1'), 'seen 集里的不再收');
    });

    // readLoggedIds：从日志回读已写 id
    const dir = tmpDir(t);
    const logPath = path.join(dir, 'inbox.log');
    fs.writeFileSync(logPath, JSON.stringify({ id: 'msg_a', type: 'x' }) + '\n' + JSON.stringify({ id: 'msg_b', type: 'y' }) + '\n', 'utf8');
    const ids = S.readLoggedIds(logPath);
    await t.test('日志回读已写 id', () => {
      assert.ok(ids.has('msg_a') && ids.has('msg_b'), '日志回读已写 id  →  ' + JSON.stringify([...ids]));
    });
    await t.test('日志不存在 = 空集不失败', () => {
      assert.ok(S.readLoggedIds(path.join(dir, 'none.log')).size === 0, '日志不存在 = 空集不失败');
    });
  });

  it('⑥ 重建命令串（#638 不再 run-use）', async (t) => {
    const S = await SCRIPT_LOAD;
    const script = S.buildLaunchScript({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      scriptPath: 'C:\\repo\\scripts\\inbox-station.mjs',
      logPath: 'D:\\frank\\windsurf-dao\\_flow\\inbox.log',
    });
    await t.test('启动串不再 run-use（根治 consumer_fenced）', () => {
      assert.ok(!/run-use/.test(script), '启动串不再 run-use  →  ' + script);
    });
    await t.test('启动串不再带 --run（单台轮询全部）', () => {
      assert.ok(!/--run/.test(script), '启动串不再带 --run');
    });
    await t.test('启动串进 relay 且带全局 --log', () => {
      assert.ok(/inbox-station\.mjs" relay --log/.test(script) && script.includes('inbox.log'), '启动串进 relay 且带全局 --log');
    });
    const cmd = S.buildRelayCommand({ launchPath: 'D:\\frank\\windsurf-dao\\_flow\\inbox-station.cmd' });
    await t.test('create --command 走 cmd 文件', () => {
      assert.ok(cmd.includes('cmd.exe /c') && cmd.includes('inbox-station.cmd'), 'create --command 走 cmd 文件');
    });

    const st = S.statusPayload({ handle: 'term_y', logPath: 'p', action: 'ok', reason: 'all-alive' });
    await t.test('现状 JSON ok', () => {
      assert.ok(st.ok === true && st.action === 'ok' && st.reason === 'all-alive', '现状 JSON ok');
    });
    const stExtra = S.statusPayload({
      handle: 'term_y', logPath: 'p', action: 'ok', reason: 'closed-extra',
      closedExtra: [{ runId: 'run_x' }], gc: { zombieCount: 3 },
    });
    await t.test('现状 JSON 带 closedExtra 与 gc', () => {
      assert.ok(stExtra.closedExtra.length === 1 && stExtra.gc.zombieCount === 3, '现状 JSON 带 closedExtra 与 gc');
    });
    const stFail = S.statusPayload({ ok: false, handle: 'term_y', logPath: 'p', action: 'rebuild', reason: 'relay-not-alive', error: '中继未存活' });
    await t.test('现状 JSON 失败带 ok:false', () => {
      assert.ok(stFail.ok === false && stFail.error === '中继未存活', '现状 JSON 失败带 ok:false');
    });
    await t.test('findMainWorktree', () => {
      assert.ok(S.findMainWorktree([
        { id: 'a', isMainWorktree: false },
        { id: 'b', isMainWorktree: true },
      ]).id === 'b', 'findMainWorktree');
    });
    await t.test('extractHandle 几种形状', () => {
      assert.ok(S.extractHandle({ result: { handle: 'term_z' } }) === 'term_z', 'extractHandle 几种形状');
    });
  });

  it('⑦ waitReady / decideReady / finalizeEnsure 故障注入', async (t) => {
    const S = await SCRIPT_LOAD;
    const now = 2_000_000;
    const term = { handle: 'term_box', connected: true, preview: S.READY_MARK };
    const liveLease = { pid: process.pid, ts: now, ttlMs: S.LEASE_TTL_MS, handle: 'term_box' };
    const staleLease = { pid: process.pid, ts: now - S.LEASE_TTL_MS - 1, ttlMs: S.LEASE_TTL_MS, handle: 'term_box' };

    await t.test('decideReady 全好 → ok', () => {
      assert.ok(S.decideReady({ terminal: term, lease: liveLease, now }).ok === true, 'decideReady 全好 → ok');
    });
    await t.test('decideReady 无终端 → 失败', () => {
      assert.ok(S.decideReady({ terminal: null, lease: liveLease, now }).ok === false, 'decideReady 无终端 → 失败');
    });
    await t.test('decideReady 历史 READY 无租约 → relay-not-alive', () => {
      assert.ok(S.decideReady({ terminal: term, lease: null, now }).error === 'relay-not-alive', 'decideReady 历史 READY 无租约 → relay-not-alive');
    });
    await t.test('decideReady 过期租约 → relay-not-alive', () => {
      assert.ok(S.decideReady({ terminal: term, lease: staleLease, now }).error === 'relay-not-alive', 'decideReady 过期租约 → relay-not-alive');
    });
    await t.test('acceptRebuildReady 超时不得降级成功', () => {
      assert.ok(S.acceptRebuildReady({ ok: false, error: 'timeout' }).ok === false, 'acceptRebuildReady 超时不得降级成功');
    });

    const base = { handle: 'term_box', logPath: 'p', action: 'rebuild', reason: 'no-terminal' };
    const deadRelay = S.finalizeEnsure({ ...base, relayAlive: false });
    await t.test('finalize 中继死 → ok:false 非零', () => {
      assert.ok(deadRelay.exitCode === 1 && deadRelay.payload.ok === false, 'finalize 中继死 → ok:false 非零');
    });
    await t.test('finalize 中继死 reason', () => {
      assert.ok(deadRelay.payload.reason === 'relay-not-alive', 'finalize 中继死 reason');
    });
    const okFinal = S.finalizeEnsure({ ...base, action: 'ok', reason: 'all-alive', relayAlive: true });
    await t.test('finalize 全好 → ok:true 零退出', () => {
      assert.ok(okFinal.exitCode === 0 && okFinal.payload.ok === true && okFinal.payload.handle === 'term_box', 'finalize 全好 → ok:true 零退出');
    });
  });

  it('⑧ #614 只读 gc 阈值行', async (t) => {
    const S = await SCRIPT_LOAD;
    await t.test('超阈值打一行', () => {
      const line = S.gcThresholdLine({ zombieCount: 10, threshold: 5, scanned: true });
      assert.ok(line && /10/.test(line) && /run-gc --apply/.test(line), '超阈值打一行  →  ' + line);
    });
    await t.test('等于阈值不打', () => {
      assert.ok(S.gcThresholdLine({ zombieCount: 5, threshold: 5, scanned: true }) === null, '等于阈值不打');
    });
    await t.test('低于阈值不打', () => {
      assert.ok(S.gcThresholdLine({ zombieCount: 0, threshold: 5, scanned: true }) === null, '低于阈值不打');
    });
    await t.test('没扫成（unscanned）不打', () => {
      assert.ok(S.gcThresholdLine({ zombieCount: 99, threshold: 5, scanned: false }) === null, '没扫成不打');
    });
    await t.test('gcSummaryFromPlan 统计', () => {
      const plan = { ok: true, retire: [{ id: 'a' }, { id: 'b' }], keep: [{ id: 'k' }] };
      const g = S.gcSummaryFromPlan(plan, 5);
      assert.ok(g.ok && g.zombieCount === 2 && g.keepCount === 1 && g.threshold === 5, 'gcSummaryFromPlan 统计');
    });
    await t.test('gcSummaryFromPlan 没查成 → unscanned', () => {
      const g = S.gcSummaryFromPlan({ ok: false, error: 'x' }, 5);
      assert.ok(g.ok === false && g.unscanned === true, 'gcSummaryFromPlan 没查成 → unscanned');
    });
  });
});