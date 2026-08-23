// 信箱台幂等脚本 · 纯函数回归（不碰 live orca）
//
// 验的层：①参数/选型 ②租约/活性判据（新鲜+PID 在；detached 台加命令行核对防 PID 复用）
// ③#638+2026-08-23 单台决策（detached 全局台优先/关多余台/旧式终端台迁移重建/无台重建/证不出不动）
// ④收信分流（heartbeat 不落盘、业务信落盘）⑤活跃 Run 集与相关消息过滤
// ⑥detached 拉起形态（无终端、无启动文件；stale-guard 比进程命令行）⑦故障注入
// ⑧#614 只读 gc 阈值行
// 判别力：租约过期当活、多台并存没收敛、PID 复用没核对、或只读 gc 超阈值没打行，必有一条变红。

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

    await t.test('pidIsRelay 命令行核对：在进程列表 = 真', () => {
      assert.ok(S.pidIsRelay(123, [{ pid: 123 }, { pid: 456 }]) === true, 'pidIsRelay 在列表 = 真');
    });
    await t.test('pidIsRelay 不在 = 假（防 PID 复用误认/误杀）', () => {
      assert.ok(S.pidIsRelay(999, [{ pid: 123 }]) === false && S.pidIsRelay(NaN, [{ pid: 123 }]) === false, 'pidIsRelay 不在 = 假');
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
    await t.test('租约可带 handle（旧式终端台迁移判据靠它）', () => {
      assert.ok(withHandle && withHandle.handle === 'term_s', '租约可带 handle');
    });
    await t.test('detached 租约不带 handle', () => {
      const noHandle = S.parseLease(S.formatLease({ pid: 12, runId: null, ts: now, ttlMs: 9000 }));
      assert.ok(noHandle && noHandle.handle === null, 'detached 租约不带 handle');
    });
    await t.test('leasePath 落在日志同目录', () => {
      assert.ok(S.leasePath('D:/repo/_flow/inbox.log').replace(/\\/g, '/').endsWith('/_flow/inbox.lease'), 'leasePath 落在日志同目录');
    });
    await t.test('launchFilePath 按日志名区分', () => {
      assert.ok(S.launchFilePath('D:/repo/_flow/inbox-A.log').replace(/\\/g, '/').endsWith('/_flow/inbox-A.cmd'), 'launchFilePath 按日志名区分');
    });
  });

  it('③ #638+2026-08-23 单台决策（detached 判活 / 旧式台迁移 / 关多余台 / 证不出不动）', async (t) => {
    const S = await SCRIPT_LOAD;
    const now = 2_000_000;

    // detached 全局台（无 handle，PID 核对过）+ 旧 per-run 终端台并存：留全局，关旧台
    const globalLease = { pid: process.pid, runId: null, ts: now, ttlMs: S.LEASE_TTL_MS };
    const oldLease = { pid: process.pid, runId: 'run_old', ts: now, ttlMs: S.LEASE_TTL_MS, handle: 'term_old' };
    const oldLease2 = { pid: process.pid, runId: 'run_old2', ts: now, ttlMs: S.LEASE_TTL_MS, handle: 'term_old2' };
    const globalStation = { stem: 'inbox', runId: null, lease: globalLease, files: ['a.lease', 'a.cmd', 'a.log'] };
    const oldStation = { stem: 'inbox-old', runId: 'run_old', lease: oldLease, files: ['b.lease', 'b.cmd', 'b.log'] };
    const oldStation2 = { stem: 'inbox-old2', runId: 'run_old2', lease: oldLease2, files: ['c.lease', 'c.cmd', 'c.log'] };
    const pidAlive = (pid) => pid === process.pid;

    const trim = S.planSingleStation({
      stations: [globalStation, oldStation, oldStation2],
      terminals: [{ handle: 'term_old' }, { handle: 'term_old2' }],
      now,
      pidAlive,
    });
    await t.test('detached 全局台 + 旧台 → ok/closed-extra', () => {
      assert.ok(trim.action === 'ok' && trim.reason === 'closed-extra', 'detached 全局台 + 旧台 → ok/closed-extra  →  ' + JSON.stringify(trim));
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

    // 只有 detached 全局台活着 → all-alive 秒退
    const only = S.planSingleStation({
      stations: [globalStation],
      terminals: [],
      now,
      pidAlive,
    });
    await t.test('只有 detached 全局台 → ok/all-alive（不需要任何终端）', () => {
      assert.ok(only.action === 'ok' && only.reason === 'all-alive' && only.keep.stem === 'inbox' && only.close.length === 0, '只有 detached 全局台 → ok/all-alive');
    });

    // 旧式终端台当全局台（租约带 handle 且在盘面）→ detached-migration 迁移重建
    const legacyGlobal = { stem: 'inbox', runId: null, lease: { ...globalLease, handle: 'term_global' }, files: ['a.lease', 'a.cmd', 'a.log'] };
    const migration = S.planSingleStation({
      stations: [legacyGlobal],
      terminals: [{ handle: 'term_global' }],
      now,
      pidAlive,
    });
    await t.test('旧式终端台当全局台 → rebuild/detached-migration', () => {
      assert.ok(migration.action === 'rebuild' && migration.reason === 'detached-migration'
        && migration.rebuild === true && migration.close.length === 1
        && migration.close[0].stem === 'inbox', '旧式全局台 → 迁移重建  →  ' + JSON.stringify(migration));
    });

    // detached 全局台死了（PID 核对不过），旧台活着 → 全关 + 重建全局台
    const staleGlobal = S.planSingleStation({
      stations: [globalStation, oldStation],
      terminals: [{ handle: 'term_old' }],
      now,
      pidAlive: () => false,
    });
    await t.test('全局死（PID 核对不过）+ 旧台活 → rebuild/no-global-station + 关旧台', () => {
      assert.ok(staleGlobal.action === 'rebuild' && staleGlobal.reason === 'no-global-station'
        && staleGlobal.rebuild === true && staleGlobal.close.length === 1, '全局死 + 旧台活 → rebuild + 关旧台  →  ' + JSON.stringify(staleGlobal));
    });

    // 租约过期 = 死（TTL 兜底，PID 核对不到过期租约头上）
    const expired = S.planSingleStation({
      stations: [globalStation],
      terminals: [],
      now: now + S.LEASE_TTL_MS + 1000,
      pidAlive,
    });
    await t.test('租约过期 → rebuild/no-station', () => {
      assert.ok(expired.action === 'rebuild' && expired.reason === 'no-station' && expired.close.length === 0, '租约过期 → rebuild/no-station');
    });

    // 证不出身份（PID 核对没查成 / 坏租约）→ 不动：没查成的台不当死（不多开），坏租约不关
    const badLease = { stem: 'inbox-z', runId: null, lease: null, parseError: true, files: [] };
    const unscannedPid = S.planSingleStation({
      stations: [globalStation, badLease],
      terminals: [],
      now,
      pidAlive: () => null, // 进程列表没查成 = 证不出 = 当活不动
    });
    await t.test('PID 核对没查成 → 证不出就不动（当活，不多开）', () => {
      assert.ok(unscannedPid.action === 'ok' && unscannedPid.reason === 'all-alive'
        && unscannedPid.unproven.length === 1 && unscannedPid.unproven[0].stem === 'inbox-z',
        'PID 没查成 → 不动  →  ' + JSON.stringify(unscannedPid));
    });

    // 旧式台 handle 不在盘面 = 死（#635 旧判据保留给迁移期）
    const offBoard = { stem: 'inbox-y', runId: 'run_y', lease: { pid: process.pid, runId: 'run_y', ts: now, ttlMs: S.LEASE_TTL_MS, handle: 'term_gone' }, files: [] };
    const offBoardPlan = S.planSingleStation({
      stations: [globalStation, offBoard],
      terminals: [],
      now,
      pidAlive,
    });
    await t.test('旧式台 handle 不在盘面 = 死，进不了 live（全局 detached 台在 → closed-extra 名单不含它）', () => {
      assert.ok(offBoardPlan.action === 'ok' && offBoardPlan.close.length === 0
        && offBoardPlan.unproven.some((s) => s.stem === 'inbox-y'),
        '旧式台 handle 不在盘面  →  ' + JSON.stringify(offBoardPlan));
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

  it('⑥ detached 拉起形态（2026-08-23：无终端、无启动文件；stale-guard 比进程命令行）', async (t) => {
    const S = await SCRIPT_LOAD;

    await t.test('不再有终端台启动件（buildLaunchScript/buildRelayCommand/extractHandle 已删）', () => {
      assert.ok(typeof S.buildLaunchScript === 'undefined'
        && typeof S.buildRelayCommand === 'undefined'
        && typeof S.extractHandle === 'undefined',
        'detached 化后不该再有终端台启动件');
    });
    await t.test('relayOutPath 落在日志同目录（inbox.out.log）', () => {
      assert.ok(S.relayOutPath('D:/repo/_flow/inbox.log').replace(/\\/g, '/').endsWith('/_flow/inbox.out.log'),
        'relayOutPath  →  ' + S.relayOutPath('D:/repo/_flow/inbox.log'));
    });
    await t.test('#665 stale-guard：relay 进程命令行不是镜像脚本 → 要刷新', () => {
      const oldCmd = '"C:\\nvm4w\\nodejs\\node.exe" "C:\\repo\\scripts\\inbox-station.mjs" relay --log "D:\\x\\inbox.log"';
      assert.ok(S.launchNeedsRefresh(oldCmd, 'C:\\Users\\Administrator\\.dao\\guard-mirror\\scripts\\inbox-station.mjs') === true,
        '旧进程命令行要刷新');
    });
    await t.test('#665 stale-guard：命令行已是镜像脚本 → 不刷新', () => {
      const freshCmd = '"C:\\nvm4w\\nodejs\\node.exe" "C:\\Users\\Administrator\\.dao\\guard-mirror\\scripts\\inbox-station.mjs" relay --log "D:\\x\\inbox.log"';
      assert.ok(S.launchNeedsRefresh(freshCmd, 'C:\\Users\\Administrator\\.dao\\guard-mirror\\scripts\\inbox-station.mjs') === false,
        '镜像进程命令行不刷新');
    });
    await t.test('stale-guard：空命令行/空期望 → 刷新（证不出就重建）', () => {
      assert.ok(S.launchNeedsRefresh('', 'C:\\x\\inbox-station.mjs') === true
        && S.launchNeedsRefresh('node x', '') === true, '空输入 → 刷新');
    });

    const st = S.statusPayload({ handle: null, logPath: 'p', action: 'ok', reason: 'all-alive' });
    await t.test('现状 JSON ok（detached：handle 为 null）', () => {
      assert.ok(st.ok === true && st.action === 'ok' && st.reason === 'all-alive' && st.handle === null, '现状 JSON ok');
    });
    const stExtra = S.statusPayload({
      handle: null, logPath: 'p', action: 'ok', reason: 'closed-extra',
      closedExtra: [{ runId: 'run_x' }], gc: { zombieCount: 3 },
    });
    await t.test('现状 JSON 带 closedExtra 与 gc', () => {
      assert.ok(stExtra.closedExtra.length === 1 && stExtra.gc.zombieCount === 3, '现状 JSON 带 closedExtra 与 gc');
    });
    const stFail = S.statusPayload({ ok: false, handle: null, logPath: 'p', action: 'rebuild', reason: 'relay-not-alive', error: '中继未存活' });
    await t.test('现状 JSON 失败带 ok:false', () => {
      assert.ok(stFail.ok === false && stFail.error === '中继未存活', '现状 JSON 失败带 ok:false');
    });
    await t.test('findMainWorktree', () => {
      assert.ok(S.findMainWorktree([
        { id: 'a', isMainWorktree: false },
        { id: 'b', isMainWorktree: true },
      ]).id === 'b', 'findMainWorktree');
    });
  });

  it('⑦ decideReady / finalizeEnsure 故障注入（detached：就绪 = 租约新鲜 + pid 对得上）', async (t) => {
    const S = await SCRIPT_LOAD;
    const now = 2_000_000;
    const liveLease = { pid: process.pid, ts: now, ttlMs: S.LEASE_TTL_MS };
    const staleLease = { pid: process.pid, ts: now - S.LEASE_TTL_MS - 1, ttlMs: S.LEASE_TTL_MS };

    await t.test('decideReady 租约新鲜 → ok', () => {
      assert.ok(S.decideReady({ lease: liveLease, now }).ok === true, 'decideReady 租约新鲜 → ok');
    });
    await t.test('decideReady 无租约 → relay-not-alive', () => {
      assert.ok(S.decideReady({ lease: null, now }).error === 'relay-not-alive', 'decideReady 无租约 → relay-not-alive');
    });
    await t.test('decideReady 过期租约 → relay-not-alive', () => {
      assert.ok(S.decideReady({ lease: staleLease, now }).error === 'relay-not-alive', 'decideReady 过期租约 → relay-not-alive');
    });
    await t.test('decideReady 租约 pid 不是刚拉起的 → 失败', () => {
      assert.ok(S.decideReady({ lease: liveLease, now, pid: 999999 }).ok === false,
        'decideReady pid 不符 → 失败');
    });
    await t.test('decideReady 租约 pid 对得上 → ok', () => {
      assert.ok(S.decideReady({ lease: liveLease, now, pid: process.pid }).ok === true,
        'decideReady pid 对得上 → ok');
    });

    const base = { handle: null, logPath: 'p', action: 'rebuild', reason: 'no-station' };
    const deadRelay = S.finalizeEnsure({ ...base, relayAlive: false });
    await t.test('finalize 中继死 → ok:false 非零', () => {
      assert.ok(deadRelay.exitCode === 1 && deadRelay.payload.ok === false, 'finalize 中继死 → ok:false 非零');
    });
    await t.test('finalize 中继死 reason', () => {
      assert.ok(deadRelay.payload.reason === 'relay-not-alive', 'finalize 中继死 reason');
    });
    const okFinal = S.finalizeEnsure({ ...base, action: 'ok', reason: 'all-alive', relayAlive: true });
    await t.test('finalize 全好 → ok:true 零退出（handle:null）', () => {
      assert.ok(okFinal.exitCode === 0 && okFinal.payload.ok === true && okFinal.payload.handle === null, 'finalize 全好 → ok:true 零退出');
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