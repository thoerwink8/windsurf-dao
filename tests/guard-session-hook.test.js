// #693 帥位触发：judgeSeat 机械判定 + SessionStart hook 行为 + settings.json 接线。
// 2026-08-22 追加：guardLaunchGate 保活闸（主树即拉，不认 master；判不出/非主树不拉）。
//
// 验的层：① judgeSeat 七态（主树 master / 非主树 / 非 master / detached / git 失败 ×2 / 主树路径解析失败）
// ② sessionHookLines 五态（非主树静默 / 判不出注入问用户 / 在位 / 已拉起 / 没查成两形分得开）
//        + 主树非 master 仍拉起且显形分支
// ③ hook 直跑永远 exit 0（不弄坏会话启动）——含非 git 目录的判不出路径
// ④ settings.json SessionStart 只挂一条命令且脚本真存在

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SEAT = path.join(REPO, 'scripts', 'lib', 'guard-seat.mjs');
const SEAT_LOAD = import('file://' + SEAT.replace(/\\/g, '/'));
const HOOK = path.join(REPO, 'scripts', 'lib', 'guard-session-hook.mjs');
const HOOK_LOAD = import('file://' + HOOK.replace(/\\/g, '/'));

const PORCELAIN = 'worktree D:/frank/windsurf-dao\nHEAD abc\nbranch refs/heads/master\n\nworktree C:/wt/x\nHEAD def\nbranch refs/heads/x\n';

function fakeGit({ worktreeOut = PORCELAIN, worktreeErr = null, branch = 'master', branchErr = null } = {}) {
  return (args) => {
    if (args[0] === 'worktree') {
      return worktreeErr ? { ok: false, error: worktreeErr } : { ok: true, out: worktreeOut };
    }
    if (args[0] === 'rev-parse') {
      return branchErr ? { ok: false, error: branchErr } : { ok: true, out: branch };
    }
    return { ok: false, error: 'unexpected git args: ' + args.join(' ') };
  };
}

describe('guard-seat（帥位判定）', () => {
  it('主树 + master → shuai', async (t) => {
    const S = await SEAT_LOAD;
    const s = S.judgeSeat({ projectDir: 'D:\\frank\\windsurf-dao', git: fakeGit() });
    await t.test('seat=shuai 且带回 mainPath/branch', () => {
      assert.ok(s.ok && s.seat === 'shuai' && s.branch === 'master' && /windsurf-dao/.test(s.mainPath), 'shuai  →  ' + JSON.stringify(s));
    });
  });

  it('路径归一化：反斜杠/尾斜杠/大小写不影响主树认定', async (t) => {
    const S = await SEAT_LOAD;
    const s = S.judgeSeat({ projectDir: 'd:/frank/windsurf-dao/', git: fakeGit() });
    await t.test('仍是 shuai', () => {
      assert.ok(s.ok && s.seat === 'shuai', '归一化  →  ' + JSON.stringify(s));
    });
  });

  it('非主树（工人 worktree）→ other，不猜', async (t) => {
    const S = await SEAT_LOAD;
    const s = S.judgeSeat({ projectDir: 'C:\\wt\\x', git: fakeGit() });
    await t.test('seat=other reason=not-main-worktree', () => {
      assert.ok(s.ok && s.seat === 'other' && s.reason === 'not-main-worktree', 'other  →  ' + JSON.stringify(s));
    });
  });

  it('主树但分支不是 master → other', async (t) => {
    const S = await SEAT_LOAD;
    const s = S.judgeSeat({ projectDir: 'D:\\frank\\windsurf-dao', git: fakeGit({ branch: 'thoerwink8/cursor/issue-693' }) });
    await t.test('seat=other reason=not-master', () => {
      assert.ok(s.ok && s.seat === 'other' && s.reason === 'not-master', 'other  →  ' + JSON.stringify(s));
    });
  });

  it('判不出来三态全是 ok:false，不许当确定态', async (t) => {
    const S = await SEAT_LOAD;
    const detached = S.judgeSeat({ projectDir: 'D:\\frank\\windsurf-dao', git: fakeGit({ branch: 'HEAD' }) });
    await t.test('detached HEAD → 没查成', () => {
      assert.ok(detached.ok === false && /detached/.test(detached.error), 'detached  →  ' + JSON.stringify(detached));
    });
    const noGit = S.judgeSeat({ projectDir: 'D:\\frank\\windsurf-dao', git: fakeGit({ worktreeErr: 'git exit 128' }) });
    await t.test('worktree list 失败 → 没查成', () => {
      assert.ok(noGit.ok === false && /worktree list 失败/.test(noGit.error), 'git 失败  →  ' + JSON.stringify(noGit));
    });
    const noBranch = S.judgeSeat({ projectDir: 'D:\\frank\\windsurf-dao', git: fakeGit({ branchErr: 'git exit 129' }) });
    await t.test('分支读不出 → 没查成', () => {
      assert.ok(noBranch.ok === false && /分支读不出/.test(noBranch.error), '分支失败  →  ' + JSON.stringify(noBranch));
    });
    const noMain = S.judgeSeat({ projectDir: 'D:\\frank\\windsurf-dao', git: fakeGit({ worktreeOut: 'HEAD abc\n' }) });
    await t.test('主树路径解析失败 → 没查成', () => {
      assert.ok(noMain.ok === false && /主树路径/.test(noMain.error), '无主树  →  ' + JSON.stringify(noMain));
    });
  });

  it('guardLaunchGate：主树即拉（不认 master），判不出/非主树不拉', async (t) => {
    const S = await SEAT_LOAD;
    const shuai = S.guardLaunchGate({ ok: true, seat: 'shuai', branch: 'master' });
    await t.test('帅位 → 拉', () => {
      assert.ok(shuai.launch === true && shuai.shuai === true, '帅位  →  ' + JSON.stringify(shuai));
    });
    const notMaster = S.guardLaunchGate({ ok: true, seat: 'other', reason: 'not-master', branch: 'thoerwink8/x' });
    await t.test('主树非 master → 拉（2026-08-22 拍板），shuai=false', () => {
      assert.ok(notMaster.launch === true && notMaster.shuai === false && notMaster.branch === 'thoerwink8/x', '主树非 master  →  ' + JSON.stringify(notMaster));
    });
    const notMain = S.guardLaunchGate({ ok: true, seat: 'other', reason: 'not-main-worktree' });
    await t.test('工人树 → 不拉（防多树双拉）', () => {
      assert.ok(notMain.launch === false && notMain.unknown === false, '工人树  →  ' + JSON.stringify(notMain));
    });
    const unknown = S.guardLaunchGate({ ok: false, error: 'detached HEAD，判不出当前分支名' });
    await t.test('判不出 → 不拉且 unknown（fail-close）', () => {
      assert.ok(unknown.launch === false && unknown.unknown === true && /detached/.test(unknown.error), '判不出  →  ' + JSON.stringify(unknown));
    });
  });
});

describe('guard-session-hook（SessionStart 面）', () => {
  const okOnce = (doc) => () => ({ status: 0, stdout: JSON.stringify(doc) + '\n', stderr: '' });

  it('非主树（工人树）→ 静默（空行组）', async (t) => {
    const H = await HOOK_LOAD;
    const lines = H.sessionHookLines({
      projectDir: 'C:\\wt\\x',
      judge: () => ({ ok: true, seat: 'other', reason: 'not-main-worktree' }),
      runOnce: () => { throw new Error('非主树不许跑 --once'); },
    });
    await t.test('空行组且没碰 --once', () => {
      assert.ok(Array.isArray(lines) && lines.length === 0, '静默  →  ' + JSON.stringify(lines));
    });
  });

  it('主树非 master → 仍跑 --once 拉起，行尾显形分支（2026-08-22 拍板）', async (t) => {
    const H = await HOOK_LOAD;
    const lines = H.sessionHookLines({
      projectDir: 'D:\\frank\\windsurf-dao',
      judge: () => ({ ok: true, seat: 'other', reason: 'not-master', branch: 'thoerwink8/og-keep-ds-ox-alpha' }),
      runOnce: okOnce({ ok: true, results: [{ name: 'watchdog', action: 'started', pid: 42 }, { name: 'flow', action: 'already', pid: 2 }] }),
    });
    await t.test('一行「已拉起」且带「非 master」与分支名', () => {
      assert.ok(lines.length === 1 && /已拉起/.test(lines[0]) && /watchdog=started\(42\)/.test(lines[0])
        && /非 master/.test(lines[0]) && /og-keep-ds-ox-alpha/.test(lines[0]), '主树非 master 照拉  →  ' + lines[0]);
    });
  });

  it('帥位判定没查成 → 注入醒目行请帅问用户（不猜、不静默）', async (t) => {
    const H = await HOOK_LOAD;
    const lines = H.sessionHookLines({
      projectDir: 'X',
      judge: () => ({ ok: false, error: 'detached HEAD，判不出当前分支名' }),
      runOnce: () => { throw new Error('判不出不许跑 --once'); },
    });
    await t.test('一行，带「没查成」与 AskUserQuestion', () => {
      assert.ok(lines.length === 1 && /帥位判定没查成/.test(lines[0]) && /detached/.test(lines[0])
        && /AskUserQuestion/.test(lines[0]), '问用户  →  ' + lines[0]);
    });
  });

  it('帥位 + 全在位 → 一行「在位」（查过的活证）', async (t) => {
    const H = await HOOK_LOAD;
    const lines = H.sessionHookLines({
      projectDir: 'D:\\frank\\windsurf-dao',
      judge: () => ({ ok: true, seat: 'shuai' }),
      runOnce: okOnce({ ok: true, results: [{ name: 'watchdog', action: 'already', pid: 1 }, { name: 'flow', action: 'already', pid: 2 }] }),
    });
    await t.test('[卫] 守卫在位', () => {
      assert.ok(lines.length === 1 && /守卫在位/.test(lines[0]) && /watchdog=already\(1\)/.test(lines[0]), '在位  →  ' + lines[0]);
    });
  });

  it('帥位 + 缺了被拉起 → 一行「已拉起」', async (t) => {
    const H = await HOOK_LOAD;
    const lines = H.sessionHookLines({
      projectDir: 'D:\\frank\\windsurf-dao',
      judge: () => ({ ok: true, seat: 'shuai' }),
      runOnce: okOnce({ ok: true, results: [{ name: 'watchdog', action: 'started', pid: 42 }, { name: 'flow', action: 'already', pid: 2 }] }),
    });
    await t.test('[卫] 守卫已拉起', () => {
      assert.ok(lines.length === 1 && /已拉起/.test(lines[0]) && /watchdog=started\(42\)/.test(lines[0]), '拉起  →  ' + lines[0]);
    });
  });

  it('「查过」和「没查成」两形分得开', async (t) => {
    const H = await HOOK_LOAD;
    const shuai = () => ({ ok: true, seat: 'shuai' });
    const exit2 = H.sessionHookLines({
      projectDir: 'X', judge: shuai,
      runOnce: () => ({ status: 2, stdout: '', stderr: '进程列表没查成：timeout' }),
    });
    await t.test('--once exit 2 → 没查成行', () => {
      assert.ok(exit2.length === 1 && /没查成/.test(exit2[0]) && !/在位|已拉起/.test(exit2[0]), 'exit2  →  ' + exit2[0]);
    });
    const crashed = H.sessionHookLines({
      projectDir: 'X', judge: shuai,
      runOnce: () => ({ error: { message: 'spawn ENOENT' }, status: null, stdout: '' }),
    });
    await t.test('--once 直接崩 → 没查成行（不吞）', () => {
      assert.ok(crashed.length === 1 && /没查成/.test(crashed[0]) && /ENOENT/.test(crashed[0]), '崩  →  ' + crashed[0]);
    });
    const garbage = H.sessionHookLines({
      projectDir: 'X', judge: shuai,
      runOnce: () => ({ status: 0, stdout: 'not json\n', stderr: '' }),
    });
    await t.test('exit 0 但输出不是结果 JSON → 没查成行（不许当查过）', () => {
      assert.ok(garbage.length === 1 && /没查成/.test(garbage[0]), '垃圾输出  →  ' + garbage[0]);
    });
    const failed = H.sessionHookLines({
      projectDir: 'X', judge: shuai,
      runOnce: okOnce({ ok: false, results: [{ name: 'flow', action: 'start-failed', error: 'spawn 没给出 pid' }] }),
    });
    await t.test('结果里有 start-failed → 「拉起没成」不是「在位」', () => {
      assert.ok(failed.length === 1 && /拉起没成/.test(failed[0]) && !/在位/.test(failed[0]), '失败  →  ' + failed[0]);
    });
  });

  it('hook 直跑永远 exit 0：非 git 目录判不出也只注入不拦', async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-seat-'));
    const r = spawnSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
      windowsHide: true,
      timeout: 30000,
    });
    await t.test('exit 0', () => {
      assert.ok(r.status === 0, 'exit  →  ' + `status=${r.status} err=${(r.stderr || '').slice(0, 200)}`);
    });
    await t.test('非 git 目录 → 帥位判定没查成行（不是静默、不是崩溃）', () => {
      assert.ok(/帥位判定没查成/.test(r.stdout || ''), 'stdout  →  ' + (r.stdout || '').slice(0, 300));
    });
  });

  it('settings.json SessionStart 只挂一条命令且脚本真存在', async (t) => {
    const settings = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8'));
    const ss = settings.hooks?.SessionStart || [];
    const commands = ss.flatMap(g => (g.hooks || []).map(h => h.command));
    await t.test('SessionStart 挂了 guard-session-hook', () => {
      assert.ok(commands.length === 1 && commands[0].includes('guard-session-hook.mjs'), 'SessionStart  →  ' + JSON.stringify(commands));
    });
    await t.test('指向的脚本真存在', () => {
      assert.ok(fs.existsSync(HOOK), '脚本在  →  ' + HOOK);
    });
    await t.test('timeout 大于 --once 内部预算（50s）', () => {
      const timeout = ss.flatMap(g => (g.hooks || []))[0].timeout;
      assert.ok(typeof timeout === 'number' && timeout > 50, 'timeout  →  ' + timeout);
    });
  });
});
