// Orca Desktop 启动命令：夹具 json，不拿本机真文件当唯一路径。
// 没查成（无文件 / 坏 JSON / 没扫到 settings）≠ 读到 0 条覆盖。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'orca-agent-cmds');
const LIB = path.join(REPO, 'scripts', 'lib', 'orca-agent-cmds.mjs');
const DAO = path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));
const DAO_LOAD = import('file://' + DAO.replace(/\\/g, '/'));

describe('orca-agent-cmds', () => {
  it('夹具：有覆盖 / 0 条 / 无文件 / 坏 JSON / 空 args / 没扫到 settings', async (t) => {
    const S = await LIB_LOAD;

    const hit = S.loadOrcaAgentCmds({ file: path.join(FIX, 'with-overrides.json') });
    await t.test('有 overrides：扫成了，不是 unscanned', () => {
      assert.ok(hit.ok === true && hit.unscanned === false && hit.overrideCount === 1,
        '有 overrides  →  ' + JSON.stringify({ ok: hit.ok, unscanned: hit.unscanned, overrideCount: hit.overrideCount }));
    });
    await t.test('Claude 读出 reclaude（覆盖）', () => {
      assert.ok(hit.agents.claude.command === 'reclaude' && hit.agents.claude.launch === 'reclaude',
        'Claude  →  ' + JSON.stringify(hit.agents.claude));
    });
    await t.test('Codex 手试成功那条能被读出来', () => {
      const c = hit.agents.codex;
      assert.ok(c && c.command === 'codex' && c.launch === 'codex --dangerously-bypass-approvals-and-sandbox',
        'Codex  →  ' + JSON.stringify(c));
    });

    const zero = S.loadOrcaAgentCmds({ file: path.join(FIX, 'empty-overrides.json') });
    await t.test('读到 0 条覆盖：ok、overrideCount=0，不是没查成', () => {
      assert.ok(zero.ok === true && zero.unscanned === false && zero.overrideCount === 0 && zero.agentCount === 0,
        '0 条覆盖  →  ' + JSON.stringify({ ok: zero.ok, unscanned: zero.unscanned, overrideCount: zero.overrideCount, agentCount: zero.agentCount }));
    });

    const missing = S.loadOrcaAgentCmds({ file: path.join(FIX, 'no-such-orca-data.json') });
    await t.test('无文件：unscanned，overrideCount 是 null 不是 0', () => {
      assert.ok(missing.ok === false && missing.unscanned === true && missing.reason === 'missing-file'
        && missing.overrideCount === null && /没查成/.test(missing.error),
        '无文件  →  ' + JSON.stringify(missing));
    });

    const bad = S.loadOrcaAgentCmds({ file: path.join(FIX, 'bad.json') });
    await t.test('坏 JSON：unscanned，不是 0 条覆盖', () => {
      assert.ok(bad.ok === false && bad.unscanned === true && bad.reason === 'bad-json'
        && bad.overrideCount === null && /没查成/.test(bad.error),
        '坏 JSON  →  ' + JSON.stringify(bad));
    });

    const emptyArgs = S.loadOrcaAgentCmds({ file: path.join(FIX, 'empty-args.json') });
    await t.test('空 args：覆盖还在，launch 不加尾巴', () => {
      assert.ok(emptyArgs.ok && emptyArgs.unscanned === false
        && emptyArgs.agents.claude.command === 'reclaude'
        && emptyArgs.agents.claude.args === ''
        && emptyArgs.agents.claude.launch === 'reclaude',
        '空 args  →  ' + JSON.stringify(emptyArgs.agents.claude));
    });

    const noSettings = S.loadOrcaAgentCmds({ file: path.join(FIX, 'no-settings.json') });
    await t.test('没扫到 settings：unscanned，不是 0 条覆盖', () => {
      assert.ok(noSettings.ok === false && noSettings.unscanned === true && noSettings.reason === 'no-settings'
        && noSettings.overrideCount === null,
        '没扫到 settings  →  ' + JSON.stringify(noSettings));
    });
  });

  it('路径：ORCA_HOME / ORCA_DATA_JSON，不读本机真文件', async (t) => {
    const S = await LIB_LOAD;
    const viaHome = S.resolveOrcaDataPath({ env: { ORCA_HOME: 'D:\\tmp\\orca-home' } });
    await t.test('ORCA_HOME 拼到 profiles/local-default/orca-data.json', () => {
      assert.ok(/orca-home[\\/]profiles[\\/]local-default[\\/]orca-data\.json$/i.test(viaHome),
        'ORCA_HOME  →  ' + viaHome);
    });
    const viaFile = S.resolveOrcaDataPath({ env: { ORCA_DATA_JSON: 'Z:\\fixture.json' } });
    await t.test('ORCA_DATA_JSON 优先于默认 Roaming', () => {
      assert.ok(viaFile === 'Z:\\fixture.json', 'ORCA_DATA_JSON  →  ' + viaFile);
    });
    const viaApp = S.resolveOrcaDataPath({ env: { APPDATA: 'D:\\Roaming' } });
    await t.test('Roaming 默认落 %APPDATA%/orca/...', () => {
      assert.ok(/Roaming[\\/]orca[\\/]profiles[\\/]local-default[\\/]orca-data\.json$/i.test(viaApp),
        'APPDATA  →  ' + viaApp);
    });
  });

  it('resolveLaunch：先问 Orca，再回落 routing', async (t) => {
    const S = await LIB_LOAD;
    const D = await DAO_LOAD;
    const routing = D.loadRouting();
    const orca = S.loadOrcaAgentCmds({ file: path.join(FIX, 'with-overrides.json') });

    const gpt = D.resolveLaunch({ provider: 'gpt', routing, orca });
    await t.test('gpt 用 Orca 的 Codex 手试串，并带上模型', () => {
      assert.ok(gpt.launchSource === 'orca' && gpt.orcaLaunch === 'codex --dangerously-bypass-approvals-and-sandbox'
        && gpt.command.includes('--dangerously-bypass-approvals-and-sandbox')
        && /\bcodex\b/.test(gpt.command) && /(?:^|\s)-m\s+\S+/.test(gpt.command),
        'gpt Orca  →  ' + JSON.stringify({ command: gpt.command, source: gpt.launchSource, orca: gpt.orcaLaunch }));
    });

    const claude = D.resolveLaunch({ provider: 'claude', routing, orca });
    await t.test('claude 用 Orca 的 reclaude，并带上 --model', () => {
      assert.ok(claude.launchSource === 'orca' && claude.orcaLaunch === 'reclaude'
        && /^reclaude\b/.test(claude.command) && /--model\s+\S+/.test(claude.command),
        'claude Orca  →  ' + JSON.stringify({ command: claude.command, source: claude.launchSource }));
    });

    const missing = S.loadOrcaAgentCmds({ file: path.join(FIX, 'no-such-orca-data.json') });
    const gptFallback = D.resolveLaunch({ provider: 'gpt', routing, orca: missing });
    await t.test('文件不在：回落 routing，不把没查成当成 0 条覆盖', () => {
      assert.ok(gptFallback.launchSource === 'routing' && gptFallback.orcaReason === 'missing-file'
        && gptFallback.command.includes('codex'),
        '缺文件回落  →  ' + JSON.stringify({ command: gptFallback.command, source: gptFallback.launchSource, reason: gptFallback.orcaReason }));
    });

    const zero = S.loadOrcaAgentCmds({ file: path.join(FIX, 'empty-overrides.json') });
    const gptZero = D.resolveLaunch({ provider: 'gpt', routing, orca: zero });
    await t.test('读到 0 条覆盖：这智能体不在表里，回落 routing', () => {
      assert.ok(zero.unscanned === false && gptZero.launchSource === 'routing',
        '0 条回落  →  ' + JSON.stringify({ overrideCount: zero.overrideCount, source: gptZero.launchSource }));
    });

    const bad = S.loadOrcaAgentCmds({ file: path.join(FIX, 'bad.json') });
    let threw = false;
    let err = '';
    try { D.resolveLaunch({ provider: 'gpt', routing, orca: bad }); }
    catch (e) { threw = true; err = String(e.message || e); }
    await t.test('坏 JSON：resolveLaunch 抛，不许当没有覆盖', () => {
      assert.ok(threw && /没查成/.test(err), '坏 JSON 抛  →  ' + err);
    });

    const skip = D.resolveLaunch({ provider: 'gpt', routing, skipOrca: true });
    await t.test('skipOrca 仍走 routing（给只验 toml 的测试）', () => {
      assert.ok(skip.launchSource === 'routing' && skip.command.includes('codex'),
        'skipOrca  →  ' + skip.command);
    });
  });

  it('droppedRoutingFlags：routing 保命旗标被 Orca 覆盖丢掉时显形', async (t) => {
    const S = await LIB_LOAD;

    const grok = S.droppedRoutingFlags({
      template: 'grok -m {model} --effort xhigh --always-approve',
      launch: 'grok',
    });
    await t.test('裸命令丢两个旗标', () => {
      assert.ok(grok.join(',') === '--effort,--always-approve', '裸命令  →  ' + grok.join(','));
    });

    const full = S.droppedRoutingFlags({
      template: 'grok -m {model} --effort xhigh --always-approve',
      launch: 'grok --effort xhigh --always-approve',
    });
    await t.test('带齐旗标就不报', () => {
      assert.ok(full.length === 0, '带齐  →  ' + JSON.stringify(full));
    });

    const modelOnly = S.droppedRoutingFlags({
      template: 'codex --model {model}',
      launch: 'codex',
    });
    await t.test('模型旗标不算丢（mergeOrcaLaunch 会接）', () => {
      assert.ok(modelOnly.length === 0, '模型旗标  →  ' + JSON.stringify(modelOnly));
    });

    const dup = S.droppedRoutingFlags({
      template: 'x --force --trust --force',
      launch: 'x',
    });
    await t.test('重复旗标只报一次', () => {
      assert.ok(dup.join(',') === '--force,--trust', '去重  →  ' + dup.join(','));
    });
  });

  it('applyOrcaAgentCmds：Orca 覆盖丢旗标时结果带 droppedFlags', async (t) => {
    const S = await LIB_LOAD;
    const orcaCmds = {
      ok: true, unscanned: false, reason: 'ok', error: null, file: null,
      overrides: { grok: 'grok' }, defaultArgs: {},
      agents: { grok: { command: 'grok', args: '', launch: 'grok', overridden: true } },
      overrideCount: 1, agentCount: 1,
    };
    const hit = S.applyOrcaAgentCmds(
      { provider: 'grok', command: 'grok -m grok-4.6 --effort xhigh --always-approve', template: 'grok -m {model} --effort xhigh --always-approve', start: 'command' },
      orcaCmds,
      { cliModel: 'grok-4.6' },
    );
    await t.test('launchSource=orca 且 droppedFlags 显形', () => {
      assert.ok(hit.launchSource === 'orca' && Array.isArray(hit.droppedFlags)
        && hit.droppedFlags.join(',') === '--effort,--always-approve',
        'droppedFlags  →  ' + JSON.stringify({ source: hit.launchSource, dropped: hit.droppedFlags }));
    });

    const clean = S.applyOrcaAgentCmds(
      { provider: 'gpt', command: 'codex --dangerously-bypass-approvals-and-sandbox', template: 'codex --dangerously-bypass-approvals-and-sandbox', start: 'command' },
      orcaCmds,
      {},
    );
    await t.test('routing 回落不带 droppedFlags 字段', () => {
      assert.ok(clean.launchSource === 'routing' && !('droppedFlags' in clean),
        'routing 回落  →  ' + JSON.stringify(clean));
    });
  });
});
