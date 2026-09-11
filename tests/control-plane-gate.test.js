// 控制面闸（#948）：会话在跑 ≠ 帅位能接管。
//
// 每条对着 2026-09-07 拍板 5A：
//   控制面明确不可达 → 拦 git push / 部署；
//   探测没查成 → 不拦（没查成 ≠ 断了）；
//   本地提交 / 只读 → 无论控制面状态都不拦。
// 断言拆到 equal / match，不写复合 assert.ok。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const LIB = 'file://' + path.join(REPO, 'scripts', 'lib', 'control-plane-gate.mjs').replace(/\\/g, '/');
const GATE = path.join(REPO, 'scripts', 'lib', 'dispatch-gate.mjs');
const HOOK = path.join(REPO, 'scripts', 'lib', 'dispatch-gate-hook.mjs');
const CURSOR_HOOK = path.join(REPO, 'scripts', 'lib', 'cursor-dispatch-gate-hook.mjs');
const LOAD = import(LIB);
const GATE_LOAD = import('file://' + GATE.replace(/\\/g, '/'));

function payload(command, extra = {}) {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    session_id: extra.session_id || 'sess-cc',
    tool_input: { command },
  });
}

function cursorPayload(command) {
  return JSON.stringify({
    conversation_id: 'c-sess',
    generation_id: 'g1',
    command,
    cwd: '',
    hook_event_name: 'beforeShellExecution',
    workspace_roots: ['C:/repo'],
  });
}

function runHook(script, command, envExtra = {}, { cursor = false } = {}) {
  return spawnSync(process.execPath, [script], {
    windowsHide: true,
    encoding: 'utf8',
    input: cursor ? cursorPayload(command) : payload(command, envExtra),
    timeout: 15000,
    env: { ...process.env, ...envExtra },
  });
}

function cursorResponse(r) {
  try { return JSON.parse(String(r.stdout || '').trim()); } catch { return null; }
}

describe('控制面闸：命令分类', () => {
  it('git push 是对外写', async () => {
    const S = await LOAD;
    assert.equal(S.classifyCommand('git push origin HEAD').kind, 'outbound');
    assert.equal(S.isOutboundWrite('git push -u origin dao-948'), true);
  });

  it('git -C 仓库 push 也是对外写', async () => {
    const S = await LOAD;
    assert.equal(S.classifyStatement('git -C /tmp/repo push origin master'), 'outbound');
  });

  it('echo && git push 整条按对外写', async () => {
    const S = await LOAD;
    assert.equal(S.classifyCommand('echo ok && git push origin HEAD').kind, 'outbound');
  });

  it('套在 dao.mjs raw 后面的 git push 仍是对外写', async () => {
    const S = await LOAD;
    assert.equal(
      S.classifyCommand('node scripts/dao.mjs raw -- git push origin HEAD').kind,
      'outbound',
    );
  });

  it('land.mjs 默认是对外写（会真 push）', async () => {
    const S = await LOAD;
    assert.equal(S.classifyCommand('node scripts/land.mjs').kind, 'outbound');
    assert.equal(S.classifyCommand('node scripts/land.mjs --dry-run').kind, 'local');
    assert.equal(S.classifyCommand('node scripts/land.mjs --has-work').kind, 'local');
  });

  it('常见部署命令是对外写', async () => {
    const S = await LOAD;
    assert.equal(S.classifyStatement('docker push registry/app:tag'), 'outbound');
    assert.equal(S.classifyStatement('npm publish'), 'outbound');
    assert.equal(S.classifyStatement('npx wrangler deploy'), 'outbound');
    assert.equal(S.classifyStatement('vercel --prod'), 'outbound');
    assert.equal(S.classifyStatement('kubectl apply -f k8s.yaml'), 'outbound');
    assert.equal(S.classifyStatement('helm upgrade app chart'), 'outbound');
    assert.equal(S.classifyStatement('terraform apply'), 'outbound');
    assert.equal(S.classifyStatement('make deploy'), 'outbound');
  });

  it('带值全局参数后面的真实子命令仍是对外写', async () => {
    const S = await LOAD;
    assert.equal(S.classifyStatement('docker --context prod push registry/app:tag'), 'outbound');
    assert.equal(S.classifyStatement('kubectl --context prod apply -f k8s.yaml'), 'outbound');
    assert.equal(S.classifyStatement('helm --kube-context prod upgrade app chart'), 'outbound');
    assert.equal(S.classifyStatement('docker -H tcp://1.2.3.4:2375 push registry/app:tag'), 'outbound');
    assert.equal(S.classifyStatement('kubectl -n prod apply -f k8s.yaml'), 'outbound');
    assert.equal(S.classifyStatement('helm -n prod upgrade app chart'), 'outbound');
    assert.equal(S.classifyStatement('docker --host=tcp://1.2.3.4:2375 push registry/app:tag'), 'outbound');
    assert.equal(S.classifyStatement('kubectl --namespace=prod apply -f k8s.yaml'), 'outbound');
  });

  it('本地提交和只读不是对外写', async () => {
    const S = await LOAD;
    assert.equal(S.classifyCommand('git commit -m "x"').kind, 'local');
    assert.equal(S.classifyCommand('git status').kind, 'local');
    assert.equal(S.classifyCommand('git log -1').kind, 'local');
    assert.equal(S.classifyCommand('git add scripts/lib/control-plane-gate.mjs').kind, 'local');
    assert.equal(S.classifyCommand('git diff --stat').kind, 'local');
    assert.equal(S.isLocalOrReadOnly('git commit --allow-empty -m x'), true);
  });

  it('注释里写 git push 不算对外写', async () => {
    const S = await LOAD;
    assert.equal(S.classifyCommand('git status # git push origin HEAD').kind, 'local');
  });

  it('引号里的 git push 不算对外写', async () => {
    const S = await LOAD;
    assert.equal(S.classifyCommand('echo "git push origin HEAD"').kind, 'other');
  });
});

describe('控制面闸：三态探测', () => {
  it('reachable=false → unreachable', async () => {
    const S = await LOAD;
    const p = S.parseProbeJson(JSON.stringify({ reachable: false, error: 'Remote Control 400' }));
    assert.equal(p.state, 'unreachable');
    assert.match(p.why, /400/);
  });

  it('reachable=true → reachable', async () => {
    const S = await LOAD;
    const p = S.parseProbeJson(JSON.stringify({ reachable: true }));
    assert.equal(p.state, 'reachable');
  });

  it('JSON 坏了 → unscanned，不是 unreachable', async () => {
    const S = await LOAD;
    const p = S.parseProbeJson('{这不是 JSON');
    assert.equal(p.state, 'unscanned');
    assert.match(p.why, /不是 JSON|解析/);
  });

  it('缺 reachable 字段 → unscanned', async () => {
    const S = await LOAD;
    const p = S.parseProbeJson(JSON.stringify({ ok: true }));
    assert.equal(p.state, 'unscanned');
    assert.match(p.why, /缺 reachable/);
  });

  it('reachable 不是布尔 → unscanned', async () => {
    const S = await LOAD;
    const p = S.parseProbeJson(JSON.stringify({ reachable: 'maybe' }));
    assert.equal(p.state, 'unscanned');
  });

  it('环境变量 false → unreachable；空 → 走文件；垃圾字 → unscanned', async () => {
    const S = await LOAD;
    assert.equal(S.parseProbeText('false').state, 'unreachable');
    assert.equal(S.parseProbeText('true').state, 'reachable');
    assert.equal(S.parseProbeText('unscanned').state, 'unscanned');
    assert.equal(S.parseProbeText('garbage-xyz').state, 'unscanned');
    assert.equal(S.parseProbeText('').state, 'unscanned');
  });

  it('文件不在 → unscanned，不是断了', async () => {
    const S = await LOAD;
    const p = S.probeControlPlane({
      env: { DAO_CONTROL_PLANE_FILE: path.join(os.tmpdir(), 'dao-cp-missing.json') },
      exists: () => false,
      readFile: () => { throw new Error('不该读'); },
    });
    assert.equal(p.state, 'unscanned');
    assert.match(p.why, /不在|没查成/);
  });

  it('DAO_CONTROL_PLANE 优先于文件', async () => {
    const S = await LOAD;
    const p = S.probeControlPlane({
      env: { DAO_CONTROL_PLANE: 'false', DAO_CONTROL_PLANE_FILE: '/nope' },
      exists: () => { throw new Error('不该看文件'); },
    });
    assert.equal(p.state, 'unreachable');
    assert.equal(p.via, 'env');
  });
});

describe('控制面闸：判定', () => {
  const evidence = {
    session_id: 'sess-1',
    task_id: 'task-9',
    dispatch_id: 'disp-4',
    commit: 'abc1234',
  };

  it('unreachable + git push → 拦，证据字段进消息', async () => {
    const S = await LOAD;
    const d = S.decideControlPlane({
      cmd: 'git push origin HEAD',
      probe: { state: 'unreachable' },
      evidence,
    });
    assert.equal(d.block, true);
    assert.equal(d.kind, 'outbound');
    assert.match(d.message, /失控会话的对外写/);
    assert.match(d.message, /session_id=sess-1/);
    assert.match(d.message, /task_id=task-9/);
    assert.match(d.message, /dispatch_id=disp-4/);
    assert.match(d.message, /commit=abc1234/);
  });

  it('unscanned + git push → 不拦，note 写清没查成 ≠ 断了', async () => {
    const S = await LOAD;
    const d = S.decideControlPlane({
      cmd: 'git push origin HEAD',
      probe: { state: 'unscanned', why: '文件不在' },
      evidence,
    });
    assert.equal(d.block, false);
    assert.equal(d.state, 'unscanned');
    assert.match(d.note, /没查成 ≠ 断了/);
    assert.match(d.note, /session_id=sess-1/);
  });

  it('reachable + git push → 放行', async () => {
    const S = await LOAD;
    const d = S.decideControlPlane({
      cmd: 'git push origin HEAD',
      probe: { state: 'reachable' },
      evidence,
    });
    assert.equal(d.block, false);
    assert.equal(d.state, 'reachable');
    assert.equal(d.note, undefined);
  });

  it('unreachable + git commit → 不拦', async () => {
    const S = await LOAD;
    const d = S.decideControlPlane({
      cmd: 'git commit -m x',
      probe: { state: 'unreachable' },
      evidence,
    });
    assert.equal(d.block, false);
    assert.equal(d.kind, 'local');
  });

  it('unreachable + git status → 不拦', async () => {
    const S = await LOAD;
    const d = S.decideControlPlane({
      cmd: 'git status',
      probe: { state: 'unreachable' },
    });
    assert.equal(d.block, false);
    assert.equal(d.kind, 'local');
  });

  it('unreachable + land.mjs → 拦；--dry-run 不拦', async () => {
    const S = await LOAD;
    const blocked = S.decideControlPlane({
      cmd: 'node scripts/land.mjs',
      probe: { state: 'unreachable' },
      evidence,
    });
    assert.equal(blocked.block, true);
    const dry = S.decideControlPlane({
      cmd: 'node scripts/land.mjs --dry-run',
      probe: { state: 'unreachable' },
    });
    assert.equal(dry.block, false);
  });

  it('证据缺字段时写成 —，不许把空当没有键', async () => {
    const S = await LOAD;
    const line = S.formatEvidence({ session_id: '', task_id: 't', dispatch_id: '', commit: '' });
    assert.match(line, /session_id=—/);
    assert.match(line, /task_id=t/);
    assert.match(line, /dispatch_id=—/);
    assert.match(line, /commit=—/);
  });
});

describe('控制面闸：接到派工闸入口', () => {
  it('decideGate：unreachable + git push → block，证据进 message', async () => {
    const G = await GATE_LOAD;
    const d = G.decideGate('git push origin HEAD', {
      probe: { state: 'unreachable' },
      evidence: { session_id: 's', task_id: 't', dispatch_id: 'd', commit: 'c1' },
    });
    assert.equal(d.block, true);
    assert.match(d.message, /session_id=s/);
    assert.match(d.message, /task_id=t/);
  });

  it('decideGate：unscanned + git push → 不拦，note 写没查成 ≠ 断了', async () => {
    const G = await GATE_LOAD;
    const d = G.decideGate('git push origin HEAD', {
      probe: { state: 'unscanned', why: '抖动' },
      evidence: { session_id: 's', task_id: '', dispatch_id: '', commit: '' },
    });
    assert.equal(d.block, false);
    assert.match(d.note, /没查成 ≠ 断了/);
  });

  it('decideGate：unreachable + git commit 不拦', async () => {
    const G = await GATE_LOAD;
    const d = G.decideGate('git commit -m x', { probe: { state: 'unreachable' } });
    assert.equal(d.block, false);
  });

  it('Claude 面：DAO_CONTROL_PLANE=false + git push → exit 2', () => {
    const r = runHook(HOOK, 'git push origin HEAD', { DAO_CONTROL_PLANE: 'false' });
    assert.equal(r.status, 2);
    assert.match(r.stderr || '', /失控会话的对外写/);
    assert.match(r.stderr || '', /session_id=/);
  });

  it('Claude 面：探测没查成 + git push → 放行，stderr 写没查成 ≠ 断了', () => {
    const r = runHook(HOOK, 'git push origin HEAD', {
      DAO_CONTROL_PLANE: 'garbage',
    });
    assert.equal(r.status, 0);
    assert.match(r.stderr || '', /没查成 ≠ 断了/);
  });

  it('Claude 面：控制面可达 + git push → 放行且 stderr 空', () => {
    const r = runHook(HOOK, 'git push origin HEAD', { DAO_CONTROL_PLANE: 'true' });
    assert.equal(r.status, 0);
    assert.equal(String(r.stderr || '').trim(), '');
  });

  it('Claude 面：unreachable + git commit → 放行', () => {
    const r = runHook(HOOK, 'git commit -m x', { DAO_CONTROL_PLANE: 'false' });
    assert.equal(r.status, 0);
  });

  it('Claude 面：闸崩了 → exit 2（fail-closed）', () => {
    const r = runHook(HOOK, 'git push origin HEAD', {
      DAO_CONTROL_PLANE: 'false',
      CONTROL_PLANE_GATE_CRASH: '1',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr || '', /fail-closed|崩/);
  });

  it('Cursor 面：unreachable + git push → deny JSON，证据进消息', () => {
    const r = runHook(CURSOR_HOOK, 'git push origin HEAD', { DAO_CONTROL_PLANE: 'false' }, { cursor: true });
    assert.equal(r.status, 0);
    const doc = cursorResponse(r);
    assert.equal(doc && doc.permission, 'deny');
    assert.match(JSON.stringify(doc), /失控会话的对外写/);
    assert.match(JSON.stringify(doc), /session_id=/);
  });

  it('Cursor 面：unscanned + git push → allow，消息写没查成 ≠ 断了', () => {
    const r = runHook(CURSOR_HOOK, 'git push origin HEAD', { DAO_CONTROL_PLANE: 'unscanned' }, { cursor: true });
    assert.equal(r.status, 0);
    const doc = cursorResponse(r);
    assert.equal(doc && doc.permission, 'allow');
    assert.match(JSON.stringify(doc), /没查成 ≠ 断了/);
  });

  it('Cursor 面：闸崩了 → deny JSON', () => {
    const r = runHook(CURSOR_HOOK, 'git push origin HEAD', {
      DAO_CONTROL_PLANE: 'true',
      CONTROL_PLANE_GATE_CRASH: '1',
    }, { cursor: true });
    assert.equal(r.status, 0);
    const doc = cursorResponse(r);
    assert.equal(doc && doc.permission, 'deny');
    assert.match(JSON.stringify(doc), /fail-closed|崩/);
  });

  it('Cursor 面：unreachable + git status → allow', () => {
    const r = runHook(CURSOR_HOOK, 'git status', { DAO_CONTROL_PLANE: 'false' }, { cursor: true });
    assert.equal(r.status, 0);
    const doc = cursorResponse(r);
    assert.equal(doc && doc.permission, 'allow');
  });

  it('Claude 面：unreachable + 带值全局参数的部署命令 → exit 2', () => {
    const cmds = [
      'docker --context prod push registry/app:tag',
      'kubectl --context prod apply -f k8s.yaml',
      'helm --kube-context prod upgrade app chart',
    ];
    for (const cmd of cmds) {
      const r = runHook(HOOK, cmd, { DAO_CONTROL_PLANE: 'false' });
      assert.equal(r.status, 2, cmd);
      assert.match(r.stderr || '', /失控会话的对外写/);
    }
  });

  it('Cursor 面：unreachable + 带值全局参数的部署命令 → deny JSON', () => {
    const cmds = [
      'docker --context prod push registry/app:tag',
      'kubectl --context prod apply -f k8s.yaml',
      'helm --kube-context prod upgrade app chart',
    ];
    for (const cmd of cmds) {
      const r = runHook(CURSOR_HOOK, cmd, { DAO_CONTROL_PLANE: 'false' }, { cursor: true });
      assert.equal(r.status, 0, cmd);
      const doc = cursorResponse(r);
      assert.equal(doc && doc.permission, 'deny', cmd);
      assert.match(JSON.stringify(doc), /失控会话的对外写/);
    }
  });
});

describe('控制面闸：随仓挂载面仍是派工闸入口', () => {
  it('.claude/settings.json PreToolUse 仍指向 dispatch-gate-hook', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8'));
    const cmds = [];
    for (const g of settings.hooks.PreToolUse || []) {
      for (const h of g.hooks || []) {
        if (h.type === 'command') cmds.push(h.command);
      }
    }
    assert.equal(cmds.some((c) => /dispatch-gate-hook\.mjs/.test(c)), true);
  });

  it('.cursor/hooks.json beforeShellExecution 仍指向 cursor-dispatch-gate-hook', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(REPO, '.cursor', 'hooks.json'), 'utf8'));
    const entries = hooks.hooks.beforeShellExecution || [];
    assert.equal(entries.some((h) => /cursor-dispatch-gate-hook\.mjs/.test(h.command)), true);
  });
});

const WRITE_LIB = 'file://' + path.join(REPO, 'scripts', 'lib', 'control-plane-write.mjs').replace(/\\/g, '/');
const PRE_PUSH = path.join(REPO, 'scripts', 'lib', 'control-plane-pre-push.mjs');
const LAND = path.join(REPO, 'scripts', 'land.mjs');

function git(dir, args, env) {
  return spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function runNode(script, extra = {}) {
  return spawnSync(process.execPath, [script].concat(extra.args || []), {
    encoding: 'utf8',
    windowsHide: true,
    input: extra.input || '',
    env: extra.env ? { ...process.env, ...extra.env } : process.env,
  });
}

function setupPushRepo(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const work = path.join(tmp, 'work');
  assert.equal(git(tmp, ['init', '--bare', '-b', 'master', 'origin.git']).status, 0);
  assert.equal(git(tmp, ['clone', 'origin.git', 'work']).status, 0);
  const ident = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
  assert.equal(git(work, [...ident, 'commit', '--allow-empty', '-m', 'c1']).status, 0);
  return { tmp, work, ident, bare: path.join(tmp, 'origin.git') };
}

describe('控制面闸：写腿文档', () => {
  it('green→reachable true；red→false；unscanned 不写 reachable', async () => {
    const W = await import(WRITE_LIB);
    const g = W.controlPlaneDocFromProbe({ state: 'green', at: 't0' });
    assert.equal(g.reachable, true);
    assert.equal(g.probe, 'green');
    const r = W.controlPlaneDocFromProbe({ state: 'red', why: 'Remote Control 400', at: 't1' });
    assert.equal(r.reachable, false);
    assert.match(r.error, /400/);
    const u = W.controlPlaneDocFromProbe({ state: 'unscanned', why: '令牌不在', at: 't2' });
    assert.equal(Object.prototype.hasOwnProperty.call(u, 'reachable'), false);
    assert.equal(u.probe, 'unscanned');
  });

  it('ensureControlPlaneHooksPath：没有 .git 不抛', async () => {
    const W = await import(WRITE_LIB);
    const r = W.ensureControlPlaneHooksPath({ cwd: path.join(os.tmpdir(), 'dao-cp-no-git') });
    assert.equal(r.ok, false);
    assert.match(r.why, /不是 git/);
  });

  it('稳定来源：工作树没有 githooks 也能挂上，读回对得上', async () => {
    const W = await import(WRITE_LIB);
    const { work } = setupPushRepo('dao-cp-stable-hooks-');
    assert.equal(fs.existsSync(path.join(work, 'scripts', 'githooks', 'pre-push')), false);
    const r = W.ensureControlPlaneHooksPath({ cwd: work });
    assert.equal(r.ok, true, r.why);
    assert.equal(r.hooksPath, W.stableHooksDir());
    const got = git(work, ['config', '--worktree', '--get', 'core.hooksPath']);
    assert.equal(got.stdout.trim(), W.stableHooksDir());
  });

  it('稳定来源没有 pre-push → ok:false', async () => {
    const W = await import(WRITE_LIB);
    const { work } = setupPushRepo('dao-cp-no-src-hook-');
    const r = W.ensureControlPlaneHooksPath({
      cwd: work,
      hooksDir: path.join(os.tmpdir(), 'dao-no-hooks-src'),
    });
    assert.equal(r.ok, false);
    assert.match(r.why, /稳定来源钩子不在/);
  });

  it('hooksPath 写了但读回对不上 → ok:false', async () => {
    const W = await import(WRITE_LIB);
    const hooksDir = W.stableHooksDir();
    let gets = 0;
    const spawnGit = (_cmd, args) => {
      if (args.includes('rev-parse')) return { status: 0, stdout: '/tmp/x\n', stderr: '' };
      if (args.includes('--get') && args.includes('core.hooksPath')) {
        gets += 1;
        if (gets === 1) return { status: 1, stdout: '', stderr: '' };
        return { status: 0, stdout: '/wrong\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = W.ensureControlPlaneHooksPath({
      cwd: '/tmp/x',
      spawnGit,
      exists: (p) => /\.git$/.test(p) || /pre-push$/.test(p),
      hooksDir,
    });
    assert.equal(r.ok, false);
    assert.match(r.why, /读回/);
  });

  it('attachControlPlaneHooksOrThrow：失败就抛', async () => {
    const W = await import(WRITE_LIB);
    assert.throws(
      () => W.attachControlPlaneHooksOrThrow(path.join(os.tmpdir(), 'dao-cp-no-git')),
      /控制面闸没挂上/,
    );
  });
});

describe('控制面闸：现役 git push 路径', () => {
  it('pre-push 脚本：false 拦、true 放、落点不在放行并写没查成', () => {
    const blocked = runNode(PRE_PUSH, { env: { DAO_CONTROL_PLANE: 'false' } });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr || '', /失控会话的对外写/);

    const allowed = runNode(PRE_PUSH, { env: { DAO_CONTROL_PLANE: 'true' } });
    assert.equal(allowed.status, 0);

    const missing = runNode(PRE_PUSH, {
      env: {
        DAO_CONTROL_PLANE: '',
        DAO_CONTROL_PLANE_FILE: path.join(os.tmpdir(), 'dao-cp-absent.json'),
      },
    });
    assert.equal(missing.status, 0);
    assert.match(missing.stderr || '', /没查成/);
  });

  it('真 git push：reachable=false 拦；恢复 true 后能推', () => {
    const { work } = setupPushRepo('dao-cp-git-');
    assert.equal(git(work, ['config', 'core.hooksPath', path.join(REPO, 'scripts', 'githooks')]).status, 0);

    const blocked = git(work, ['push', 'origin', 'HEAD'], { DAO_CONTROL_PLANE: 'false' });
    assert.notEqual(blocked.status, 0);
    assert.match(`${blocked.stderr || ''}${blocked.stdout || ''}`, /失控会话的对外写|控制面/);

    const allowed = git(work, ['push', '-u', 'origin', 'HEAD'], { DAO_CONTROL_PLANE: 'true' });
    assert.equal(allowed.status, 0, allowed.stderr);
  });

  it('land.mjs：unreachable 不推；恢复后能推', () => {
    const { work, ident, bare } = setupPushRepo('dao-cp-land-');
    assert.equal(git(work, ['push', '-u', 'origin', 'master'], { DAO_CONTROL_PLANE: 'true' }).status, 0);
    assert.equal(git(work, [...ident, 'commit', '--allow-empty', '-m', 'c2']).status, 0);

    const blocked = runNode(LAND, { args: [work], env: { DAO_CONTROL_PLANE: 'false' } });
    assert.notEqual(blocked.status, 0);
    assert.match(`${blocked.stdout || ''}${blocked.stderr || ''}`, /失控会话的对外写|控制面/);

    const allowed = runNode(LAND, { args: [work], env: { DAO_CONTROL_PLANE: 'true' } });
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
    assert.equal(git(bare, ['rev-parse', 'master']).stdout.trim(), git(work, ['rev-parse', 'master']).stdout.trim());
  });
});
