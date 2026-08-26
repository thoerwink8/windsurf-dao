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

  it('resolveLaunch：派工只听仓内，Orca 桌面只比较不盖 argv', async (t) => {
    const S = await LIB_LOAD;
    const D = await DAO_LOAD;
    const routing = D.loadRouting();
    const orca = S.loadOrcaAgentCmds({ file: path.join(FIX, 'with-overrides.json') });
    const routingGpt = D.resolveLaunch({ provider: 'gpt', routing, skipOrca: true });

    const gpt = D.resolveLaunch({ provider: 'gpt', routing, orca });
    await t.test('gpt 启动 argv 仍是仓内 launch，不换成 Orca 串', () => {
      assert.ok(gpt.launchSource === 'routing' && gpt.command === routingGpt.command
        && gpt.orcaLaunch === 'codex --dangerously-bypass-approvals-and-sandbox'
        && gpt.command.includes('--dangerously-bypass-approvals-and-sandbox')
        && /\bcodex\b/.test(gpt.command) && /(?:^|\s)-m\s+\S+/.test(gpt.command),
        'gpt 仓内  →  ' + JSON.stringify({ command: gpt.command, source: gpt.launchSource, orca: gpt.orcaLaunch }));
    });

    const claude = D.resolveLaunch({ provider: 'claude', routing, orca });
    const routingClaude = D.resolveLaunch({ provider: 'claude', routing, skipOrca: true });
    await t.test('claude 启动 argv 仍是仓内 reclaude --model，Orca 覆盖不当命令', () => {
      assert.ok(claude.launchSource === 'routing' && claude.command === routingClaude.command
        && claude.orcaLaunch === 'reclaude'
        && /^reclaude\b/.test(claude.command) && /--model\s+\S+/.test(claude.command),
        'claude 仓内  →  ' + JSON.stringify({ command: claude.command, source: claude.launchSource }));
    });

    const missing = S.loadOrcaAgentCmds({ file: path.join(FIX, 'no-such-orca-data.json') });
    const gptFallback = D.resolveLaunch({ provider: 'gpt', routing, orca: missing });
    await t.test('文件不在：走仓内，不把没查成当成 0 条覆盖', () => {
      assert.ok(gptFallback.launchSource === 'routing' && gptFallback.orcaReason === 'missing-file'
        && gptFallback.command.includes('codex'),
        '缺文件  →  ' + JSON.stringify({ command: gptFallback.command, source: gptFallback.launchSource, reason: gptFallback.orcaReason }));
    });

    const zero = S.loadOrcaAgentCmds({ file: path.join(FIX, 'empty-overrides.json') });
    const gptZero = D.resolveLaunch({ provider: 'gpt', routing, orca: zero });
    await t.test('读到 0 条覆盖：走仓内', () => {
      assert.ok(zero.unscanned === false && gptZero.launchSource === 'routing',
        '0 条  →  ' + JSON.stringify({ overrideCount: zero.overrideCount, source: gptZero.launchSource }));
    });

    const bad = S.loadOrcaAgentCmds({ file: path.join(FIX, 'bad.json') });
    let threw = false;
    let badLaunch = null;
    try { badLaunch = D.resolveLaunch({ provider: 'gpt', routing, orca: bad }); }
    catch (e) { threw = true; }
    await t.test('坏 JSON：仍按仓内起，只记没查成，不许挡派工', () => {
      assert.ok(!threw && badLaunch && badLaunch.launchSource === 'routing'
        && badLaunch.command === routingGpt.command && /没查成|bad-json/.test(String(badLaunch.orcaReason || '')),
        '坏 JSON 不挡  →  ' + JSON.stringify({ threw, launch: badLaunch }));
    });

    const skip = D.resolveLaunch({ provider: 'gpt', routing, skipOrca: true });
    await t.test('skipOrca 仍走 routing（给只验 toml 的测试）', () => {
      assert.ok(skip.launchSource === 'routing' && skip.command.includes('codex'),
        'skipOrca  →  ' + skip.command);
    });

    const desktop = S.loadOrcaAgentCmds({ file: path.join(FIX, 'devin-desktop.json') });
    const routingDevin = D.resolveLaunch({ model: 'devin-deepseek-v4-flash-max', routing, skipOrca: true });
    const devin = D.resolveLaunch({ model: 'devin-deepseek-v4-flash-max', routing, orca: desktop });
    await t.test('#771 Devin：仓内 launch 裸 devin（交互 TUI 形态），桌面覆盖不当命令', () => {
      assert.ok(devin.launchSource === 'routing' && devin.command === routingDevin.command
        && devin.command === 'devin'
        && !/--permission-mode\s+bypass/.test(devin.command),
        'Devin 仓内  →  ' + JSON.stringify({ command: devin.command, source: devin.launchSource, orca: devin.orcaLaunch }));
    });
    await t.test('Devin：桌面多的旗标只提示，不写进本次 argv', () => {
      assert.ok(Array.isArray(devin.extraDesktopFlags) && devin.extraDesktopFlags.includes('--experimental')
        && !/--experimental/.test(devin.command),
        '桌面多旗标  →  ' + JSON.stringify({ extra: devin.extraDesktopFlags, command: devin.command }));
    });
    await t.test('#771 Devin：仓内无旗标，桌面少旗标不报（dropped 空）', () => {
      assert.ok(Array.isArray(devin.droppedFlags) && devin.droppedFlags.length === 0,
        '桌面少旗标  →  ' + JSON.stringify(devin.droppedFlags));
    });
    await t.test('#771 Devin：仓内无同旗标，无差异可报（diffs 空）', () => {
      assert.ok(Array.isArray(devin.desktopFlagDiffs) && devin.desktopFlagDiffs.length === 0,
        '同旗标不同值  →  ' + JSON.stringify(devin.desktopFlagDiffs));
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

  it('applyOrcaAgentCmds：比较桌面，不改仓内 argv', async (t) => {
    const S = await LIB_LOAD;
    const routingCmd = 'grok -m grok-4.6 --effort xhigh --always-approve';
    const orcaCmds = {
      ok: true, unscanned: false, reason: 'ok', error: null, file: null,
      overrides: { grok: 'grok' }, defaultArgs: {},
      agents: { grok: { command: 'grok', args: '', launch: 'grok', overridden: true } },
      overrideCount: 1, agentCount: 1,
    };
    const hit = S.applyOrcaAgentCmds(
      { provider: 'grok', command: routingCmd, template: 'grok -m {model} --effort xhigh --always-approve', start: 'command' },
      orcaCmds,
      { cliModel: 'grok-4.6' },
    );
    await t.test('launchSource=routing，command 仍是仓内，droppedFlags 显形', () => {
      assert.ok(hit.launchSource === 'routing' && hit.command === routingCmd
        && Array.isArray(hit.droppedFlags)
        && hit.droppedFlags.join(',') === '--effort,--always-approve',
        'droppedFlags  →  ' + JSON.stringify({ source: hit.launchSource, command: hit.command, dropped: hit.droppedFlags }));
    });

    const clean = S.applyOrcaAgentCmds(
      { provider: 'gpt', command: 'codex --dangerously-bypass-approvals-and-sandbox', template: 'codex --dangerously-bypass-approvals-and-sandbox', start: 'command' },
      orcaCmds,
      {},
    );
    await t.test('桌面没这个智能体：走仓内，不带比较字段', () => {
      assert.ok(clean.launchSource === 'routing' && clean.command === 'codex --dangerously-bypass-approvals-and-sandbox'
        && !clean.droppedFlags?.length && !clean.extraDesktopFlags?.length,
        '无智能体  →  ' + JSON.stringify(clean));
    });

    const notes = S.formatDesktopLaunchNotes({
      droppedFlags: ['--respect-workspace-trust'],
      extraDesktopFlags: ['--experimental'],
      desktopFlagDiffs: [{ flag: '--permission-mode', routing: 'dangerous', desktop: 'bypass' }],
    });
    await t.test('桌面差异话面：少的只报、多的建议补仓内、不同值不覆盖', () => {
      const blob = notes.join('\n');
      assert.ok(/少这些旗标/.test(blob) && /不删桌面/.test(blob)
        && /多这些旗标/.test(blob) && /补进仓内/.test(blob)
        && /没改桌面/.test(blob) && /dangerous/.test(blob) && /bypass/.test(blob),
        '话面  →  ' + blob);
    });
  });
});
