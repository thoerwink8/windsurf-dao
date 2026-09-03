// #823：派工层 DAO_TASK / DAO_ACTOR / DAO_RUN 拼装。
// 判别三条：launch 命令带三变量；缺 issue 落 #pr<N> 而非空；非 pi 不拼。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'dispatch', 'launch.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

describe('dao-trace（#823）', () => {
  it('launch 命令拼装断言带三变量', async () => {
    const S = await LIB_LOAD;
    const env = S.buildDaoTraceEnv({
      repo: 'thoerwink8/windsurf-dao',
      issue: 823,
      role: 'worker',
      model: 'deepseek-v4-flash',
      run: 'ctx_abc',
    });
    assert.equal(env.DAO_TASK, 'thoerwink8/windsurf-dao#823');
    assert.equal(env.DAO_ACTOR, 'worker-deepseek-v4-flash');
    assert.equal(env.DAO_RUN, 'ctx_abc');
    const cmd = S.prefixLaunchWithDaoTrace('pi --model gw-dspool/deepseek-v4-flash', env);
    assert.match(cmd, /^DAO_TASK=thoerwink8\/windsurf-dao#823 /);
    assert.match(cmd, /DAO_ACTOR=worker-deepseek-v4-flash /);
    assert.match(cmd, /DAO_RUN=ctx_abc /);
    assert.ok(cmd.endsWith('pi --model gw-dspool/deepseek-v4-flash'), cmd);
    const again = S.prefixLaunchWithDaoTrace(cmd, env);
    assert.equal(again, cmd, '已带前缀的命令不重复拼');
  });

  it('缺 issue 号时 DAO_TASK 落 #pr<N> 而非空', async () => {
    const S = await LIB_LOAD;
    const task = S.daoTaskId({ repo: 'thoerwink8/windsurf-dao', pr: 824 });
    assert.equal(task, 'thoerwink8/windsurf-dao#pr824');
    assert.ok(!/#$/.test(task), '不是空号');
    const env = S.buildDaoTraceEnv({
      repo: 'thoerwink8/windsurf-dao',
      pr: 824,
      role: 'reviewer',
      model: 'gpt-5.6-sol',
      run: 'pr824',
    });
    assert.equal(env.DAO_TASK, 'thoerwink8/windsurf-dao#pr824');
    assert.equal(env.DAO_ACTOR, 'reviewer-gpt-5.6-sol');
    const cmd = S.prefixLaunchWithDaoTrace('pi --model x', env);
    assert.match(cmd, /DAO_TASK=thoerwink8\/windsurf-dao#pr824/);
    assert.doesNotThrow(() => S.daoTaskId({ issue: 1 }));
    assert.throws(() => S.daoTaskId({}), /缺 issue 也缺 pr/);
  });

  it('只给 pi 拼前缀；grok 原样', async () => {
    const S = await LIB_LOAD;
    const routing = S.loadRouting();
    const pi = S.resolveLaunch({ model: 'deepseek-v4-flash', routing, skipOrca: true });
    const grok = S.resolveLaunch({ provider: 'grok', routing, skipOrca: true });
    assert.equal(S.shouldPrefixDaoTrace(pi), true);
    assert.equal(S.shouldPrefixDaoTrace(grok), false);
    const trace = { issue: 823, role: 'worker', model: 'deepseek-v4-flash', run: 'ctx_1' };
    const piTraced = S.applyDaoTraceToLaunch(pi, trace);
    const grokTraced = S.applyDaoTraceToLaunch(grok, trace);
    assert.match(piTraced.command, /^DAO_TASK=/);
    assert.equal(S.orcaKnownAgentId(piTraced), 'pi', '拼了 DAO_* 仍认 pi');
    assert.equal(grokTraced.command, grok.command, 'grok 不拼 DAO_*');
    assert.equal(S.daoActorId({ role: 'shuai', model: 'grok-4.6' }), 'shuai');
  });

  it('dispatch / start / reviewer-create / reviewer-attach 起 pi 传 daoTrace', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'dao.mjs'), 'utf8');
    assert.match(src, /function launchAgentInWorktree\(\{[^}]*daoTrace/);
    const n = (src.match(/daoTraceFor\(/g) || []).length;
    assert.ok(n >= 5, `daoTraceFor 调用应覆盖 start/dispatch/batch/create/attach，实际 ${n}`);
    const create = src.match(/function cmdReviewerCreate\b[\s\S]*?\nfunction cmdReviewerAttach\b/)?.[0] || '';
    const attach = src.match(/function cmdReviewerAttach\b[\s\S]*?\nfunction cmd/)?.[0] || '';
    assert.match(create, /daoTraceFor\(/);
    assert.match(attach, /daoTraceFor\(/);
    assert.doesNotMatch(create, /forceCommand/);
    assert.doesNotMatch(attach, /forceCommand/);
  });
});
