// tests/dao-launch.test.js —— dao 启动与活性
//
// 2026-09-06 从 dao.test.js 拆出（原 4220 行 / 1058 用例一个文件）。
// 本套管：启动模板从表读 / --help 参数存活 / pi 假活判据
// 共享前置在 tests/helpers/dao-harness.js，各套逐字复用，行为与拆分前一致。

const { describe, it } = require('node:test');
const { assert, fs, os, path, spawnSync, REPO, CLI, LIB, S_LOAD, DAO_LOAD, cliInProc, ROUTING_LOAD, waitForOutJson } = require('./helpers/dao-harness');

describe('dao 启动与活性', () => {
  it('① R2 起 codex 必须带 danger 旗标（#468 实测换路）', async (t) => {
    const S = await S_LOAD;
    const routing = await ROUTING_LOAD;
    const gpt = S.resolveLaunch({ provider: 'gpt', routing });
    await t.test('gpt launch 含 --dangerously-bypass-approvals-and-sandbox', () => {
      assert.ok(gpt.command.includes(S.CODEX_CAPABLE_FLAG), 'gpt launch 含 --dangerously-bypass-approvals-and-sandbox  →  ' + gpt.command);
    });
    await t.test('gpt launch 含 codex', () => {
      assert.ok(/\bcodex\b/.test(gpt.command), 'gpt launch 含 codex  →  ' + gpt.command);
    });
    await t.test('gpt 不用单挂 -a never（会拦 gh/node）', () => {
      assert.ok(!/(^|\s)-a\s+never\b/.test(gpt.command), 'gpt 不用单挂 -a never（会拦 gh/node）  →  ' + gpt.command);
    });

    const dry = spawnSync(process.execPath, [CLI, 'start', '--provider', 'gpt', '--worktree', 'active', '--dry-run'], {
      encoding: 'utf8', cwd: REPO,
    });
    await t.test('dao start --dry-run 退出 0', () => {
      assert.ok(dry.status === 0, 'dao start --dry-run 退出 0  →  ' + (dry.stderr || dry.stdout));
    });
    await t.test('CLI 起 gpt 自动带 danger 旗标', () => {
      assert.ok((dry.stdout || '').includes(S.CODEX_CAPABLE_FLAG), 'CLI 起 gpt 自动带 danger 旗标  →  ' + dry.stdout);
    });

    const mute = { ...routing, providers: { ...routing.providers, gpt: { ...routing.providers.gpt, launch: 'codex -a never -m {model}' } } };
    const muteLaunch = S.resolveLaunch({ provider: 'gpt', routing: mute });
    const muteRev = S.assertCodexLaunch({ command: muteLaunch.command });
    await t.test('判别力：-a never 单用当审官 → 拦', () => {
      assert.ok(muteRev.ok === false && /哑终端/.test(muteRev.error), '判别力：-a never 单用当审官 → 拦  →  ' + JSON.stringify(muteRev));
    });
    const muteWorker = S.assertCodexLaunch({ command: 'codex -a never -m gpt-5.6-sol' });
    await t.test('R2 工人位 -a never 同样拦', () => {
      assert.ok(muteWorker.ok === false, 'R2 工人位 -a never 同样拦  →  ' + JSON.stringify(muteWorker));
    });
    const okWorker = S.assertCodexLaunch({ command: `codex ${S.CODEX_CAPABLE_FLAG} -m gpt-5.6-sol` });
    await t.test('R2 工人位带 danger 旗标放行', () => {
      assert.ok(okWorker.ok === true, 'R2 工人位带 danger 旗标放行  →  ' + JSON.stringify(okWorker));
    });

    const confirm = S.verifyStarted({ text: 'Allow command?\n[Yes] [No] [Always allow]' });
    await t.test('确认屏被验开工拦住', () => {
      assert.ok(confirm.ok === false && confirm.reason === '有待确认提示', '确认屏被验开工拦住  →  ' + JSON.stringify(confirm));
    });
    await t.test('正常有输出无确认 → 过', () => {
      assert.ok(S.verifyStarted({ text: 'codex ready\nmodel gpt-5.6-sol' }).ok === true, '正常有输出无确认 → 过');
    });
    const reject = S.verifyStarted({ result: { text: 'Cannot use this model' } });
    await t.test('#618 返工：拒模文本不能当 TUI 就绪', () => {
      assert.ok(reject.ok === false && reject.reason === '拒模', '#618 返工：拒模文本不能当 TUI 就绪  →  ' + JSON.stringify(reject));
    });
    const rejectWait = S.waitAndVerify({
      readOnce: () => ({ result: { text: 'Cannot use this model' } }),
      timeoutMs: 10,
      intervalMs: 1,
      sleep: () => {},
    });
    await t.test('#618 返工：waitAndVerify 拒模立刻失败（审官复现）', () => {
      assert.ok(rejectWait.ok === false && rejectWait.reason === '拒模', '#618 返工：waitAndVerify 拒模立刻失败  →  ' + JSON.stringify(rejectWait));
    });
    const region = S.verifyStarted({ text: 'This model is not available in your region.' });
    await t.test('#618 返工：区域不可用也是拒模', () => {
      assert.ok(region.ok === false && region.reason === '拒模', '#618 返工：区域不可用也是拒模  →  ' + JSON.stringify(region));
    });
  });

  it('启动模板：reclaude / shim / fail-loud', async (t) => {
    const S = await S_LOAD;
    const routing = await ROUTING_LOAD;
    const claude = S.resolveLaunch({ provider: 'claude', routing });
    await t.test('claude 走 reclaude', () => {
      assert.ok(claude.command.includes('reclaude'), 'claude 走 reclaude  →  ' + claude.command);
    });
    await t.test('claude 带 --model opus', () => {
      assert.ok(/--model\s+opus/.test(claude.command), 'claude 带 --model opus  →  ' + claude.command);
    });
    await t.test('claude 不走裸 claude', () => {
      assert.ok(!/\bclaude\b/.test(claude.command.replace(/reclaude/g, '')), 'claude 不走裸 claude  →  ' + claude.command);
    });

    const grok = S.resolveLaunch({ provider: 'grok', routing });
    await t.test('grok launch 走 grok', () => {
      assert.ok(/\bgrok\b/.test(grok.command) && !/grok-shim\.cmd/.test(grok.command), 'grok launch 走 grok  →  ' + grok.command);
    });
    await t.test('grok launch 带 --effort xhigh', () => {
      assert.ok(/--effort\s+xhigh/.test(grok.command), 'grok launch 带 --effort xhigh  →  ' + grok.command);
    });
    await t.test('grok launch 带 --always-approve', () => {
      assert.ok(/--always-approve/.test(grok.command), 'grok launch 带 --always-approve  →  ' + grok.command);
    });
    await t.test('grok launch 不再用 --permission-mode auto 冒充免确认', () => {
      assert.ok(!/--permission-mode\s+auto/.test(grok.command), 'grok launch 不再用 --permission-mode auto 冒充免确认  →  ' + grok.command);
    });
    const flash = S.resolveLaunch({ model: 'deepseek-v4-flash', routing });
    await t.test('#602 / #797 pi 启动走 gw-dspool 前缀，避免裸名歧义', () => {
      assert.ok(flash.provider === 'gw' && flash.command.includes('gw-dspool/deepseek-v4-flash'), '#602 / #797 pi 启动走 gw-dspool  →  ' + flash.command);
    });
    const kimi = S.resolveLaunch({ model: 'kimi-k3', routing });
    await t.test('#822 kimi 主路走 pi gw-sub/kimi-k3-high', () => {
      assert.ok(kimi.provider === 'gw' && /pi --model/.test(kimi.command) && /gw-sub\/kimi-k3-high/.test(kimi.command), '#822 kimi 主路走 pi gw-sub  →  ' + kimi.command);
    });
    await t.test('kimi 不再挂 cursor-agent / opencode-go', () => {
      assert.ok(!/cursor-agent/.test(kimi.command) && !/opencode-go\/kimi-k3/.test(kimi.command), 'kimi 默认启动不走 cursor/og  →  ' + kimi.command);
    });
    const gptMain = S.resolveLaunch({ model: 'gpt-5.6-sol', routing });
    await t.test('#615 gpt 主路仍 Codex', () => {
      assert.ok(/\bcodex\b/.test(gptMain.command) && gptMain.command.includes(S.CODEX_CAPABLE_FLAG), '#615 gpt 主路仍 Codex  →  ' + gptMain.command);
    });
    const gptPipe = S.resolveLaunch({
      model: 'gpt-5.6-sol',
      pipe: { provider: 'cursor', cli_model: 'gpt-5.6-sol-high' },
      routing,
    });
    await t.test('#615 gpt 支路走 cursor / gpt-5.6-sol-high', () => {
      assert.ok(/cursor-agent/.test(gptPipe.command) && /gpt-5\.6-sol-high/.test(gptPipe.command), '#615 gpt 支路走 cursor / gpt-5.6-sol-high  →  ' + gptPipe.command);
    });
    const composer = S.resolveLaunch({ model: 'composer-2.5', routing });
    await t.test('#822 composer 走 pi gw-sub', () => {
      assert.ok(composer.provider === 'gw' && /pi --model/.test(composer.command) && /gw-sub\/composer-2.5/.test(composer.command), '#822 composer 走 pi gw-sub  →  ' + composer.command);
    });
    const grokModel = S.resolveLaunch({ model: 'grok-4.6', routing });
    await t.test('#822 写码 grok-4.6 走 pi gw/grok-4.6（不再是 Grok Build CLI）', () => {
      assert.ok(grokModel.provider === 'gw' && /pi --model/.test(grokModel.command) && /gw\/grok-4\.6/.test(grokModel.command) && !/\bgrok -m\b/.test(grokModel.command), '#822 grok 工人走 pi  →  ' + grokModel.command);
    });
    const devin = S.resolveLaunch({ model: 'devin-deepseek-v4-flash-max', routing });
    await t.test('#782 devin 走交互 TUI 形态（start=agent，launch 带 dangerous+trust 旗标，不带 --model）', () => {
      assert.ok(/^devin\b/.test(devin.command) && devin.command === 'devin --permission-mode dangerous --respect-workspace-trust false' && devin.start === 'agent' && devin.agentId === 'devin', '#782 devin launch  →  ' + JSON.stringify(devin));
    });
    await t.test('POSIX grok shim 在仓里', () => {
      assert.ok(fs.existsSync(path.join(REPO, 'host', 'machine', 'shims', 'grok')), 'POSIX grok shim 在仓里');
    });
    const shim = fs.readFileSync(path.join(REPO, 'host', 'machine', 'shims', 'grok'), 'utf8');
    await t.test('shim 带 HTTPS_PROXY（DAO_PROXY 未设时回退 7890）', () => {
      assert.ok(/DAO_PROXY:=http:\/\/127\.0\.0\.1:7890/.test(shim) && /HTTPS_PROXY/.test(shim), 'shim 带 HTTPS_PROXY（DAO_PROXY 未设时回退 7890）  →  ' + shim.replace(/\r?\n/g, ' | '));
    });

    let threw = false;
    try { S.loadRouting(path.join(REPO, 'docs', 'no-such-routing.toml')); } catch { threw = true; }
    await t.test('读表失败 fail-loud（文件不在）', () => {
      assert.ok(threw, '读表失败 fail-loud（文件不在）');
    });

    const noLaunch = { providers: { gpt: { cli: 'codex' } }, models: [] };
    let threw2 = false;
    try { S.resolveLaunch({ provider: 'gpt', routing: noLaunch }); } catch { threw2 = true; }
    await t.test('缺 launch fail-loud', () => {
      assert.ok(threw2, '缺 launch fail-loud');
    });

    let threw3 = false;
    try { S.resolveLaunch({ provider: 'ghost', routing }); } catch { threw3 = true; }
    await t.test('未知 provider fail-loud', () => {
      assert.ok(threw3, '未知 provider fail-loud');
    });

    const gptLaunch = S.resolveLaunch({ provider: 'gpt', routing });
    await t.test('gpt start=agent（读 toml）', () => {
      assert.ok(gptLaunch.start === 'agent', 'gpt start=agent  →  ' + JSON.stringify(gptLaunch.start));
    });
    const noStart = {
      providers: { gpt: { ...routing.providers.gpt, start: undefined } },
      models: routing.models,
    };
    let threwStart = false;
    try { S.resolveLaunch({ provider: 'gpt', routing: noStart }); } catch { threwStart = true; }
    await t.test('缺 start fail-loud', () => {
      assert.ok(threwStart, '缺 start fail-loud');
    });
    const asCmd = S.agentStartSpec({ ...gptLaunch, start: 'command' });
    await t.test('起法读 start 字段，不按二进制名硬编码', () => {
      assert.ok(asCmd.mode === 'command' && gptLaunch.agentId === 'codex',
        'start=command 压过 codex 二进制  →  ' + JSON.stringify(asCmd));
    });
  });

  it('② --submit 不存在（真 --help，禁 mock）', async (t) => {
    const S = await S_LOAD;
    // 有 orca 走 live --help；无 orca / ETIMEDOUT 才夹具。不许永远塞 ENOENT（#984 返工红 3）。
    const availNow = S.orcaHelpAvailable();
    if (availNow.ok) await S.prefetchLiveHelp([...new Set(S.catalogUsedFlags().map((x) => x.cmd))]);
    const fetched = S.fetchHelpPreferLive('orchestration worker-start');
    await t.test('有 orca 时走 live，无 orca 才夹具（禁永 ENOENT）', () => {
      if (!availNow.ok) {
        assert.equal(fetched.source, 'fixture', '无 orca 才夹具  →  ' + JSON.stringify(availNow));
        return;
      }
      assert.equal(fetched.source, 'live', '有 orca 必须 live  →  ' + JSON.stringify({ availNow, source: fetched.source }));
    });
    await t.test(`worker-start --help 有文本（源=${fetched.source}）`, () => {
      assert.ok(String(fetched.text).trim().length > 0, `worker-start --help 有文本（源=${fetched.source}）`);
    });
    const available = S.parseHelpFlags(fetched.text);
    await t.test('真 help 解析出参数', () => {
      assert.ok(available.size > 0, '真 help 解析出参数  →  ' + `size=${available.size}`);
    });
    await t.test('真 help 没有 --submit', () => {
      assert.ok(!available.has('--submit'), '真 help 没有 --submit  →  ' + [...available].join(' '));
    });
    await t.test('真 help 有 --task', () => {
      assert.ok(available.has('--task'), '真 help 有 --task');
    });
    await t.test('真 help 有 --terminal', () => {
      assert.ok(available.has('--terminal'), '真 help 有 --terminal');
    });

    const poisoned = S.checkHelpLiveness({
      catalog: [{ cmd: 'orchestration worker-start', flags: ['--task', '--submit'] }],
      fetchHelp: () => fetched.text,
    });
    await t.test('故意用 --submit 被自检拦下', () => {
      assert.ok(poisoned.ok === false && poisoned.missing.some(m => m.includes('--submit')), '故意用 --submit 被自检拦下  →  ' + JSON.stringify(poisoned));
    });
    await t.test('判别力：--submit 在 missing 里', () => {
      assert.ok(poisoned.missing.includes('orchestration worker-start --submit'), '判别力：--submit 在 missing 里  →  ' + poisoned.missing.join(','));
    });

    const clean = S.checkHelpLiveness({
      catalog: S.catalogUsedFlags(),
      fetchHelp: (cmd) => S.fetchHelpPreferLive(cmd).text,
    });
    await t.test('库里用到的参数都还在 help 里', () => {
      assert.ok(clean.ok === true && clean.unscanned === false, '库里用到的参数都还在 help 里  →  ' + JSON.stringify(clean));
    });
    await t.test('自检扫到了命令（不是 0 样本）', () => {
      assert.ok(clean.scanned.length > 0, '自检扫到了命令（不是 0 样本）  →  ' + String(clean.scanned.length));
    });

    // 上一条在本机永远走 live，加了 builder 忘补夹具本机照样绿、到 CI（无 orca）才炸成「没查成」。
    // 这条把「夹具齐不齐」在本机就问出来——判据是文件在不在，不看 orca 在不在。
    const noFixture = S.catalogUsedFlags()
      .map(item => item.cmd)
      .filter(cmd => !fs.existsSync(S.helpFixturePath(cmd)));
    await t.test('catalogUsedFlags 每条命令都有 --help 夹具（CI 无 orca 时靠它）', () => {
      assert.ok(noFixture.length === 0, 'catalogUsedFlags 每条命令都有 --help 夹具（CI 无 orca 时靠它）  →  ' + noFixture.join(' '));
    });

    const empty = S.checkHelpLiveness({ catalog: [], fetchHelp: () => fetched.text });
    await t.test('catalog 空 → 没查成', () => {
      assert.ok(empty.unscanned === true && empty.ok === false, 'catalog 空 → 没查成');
    });

    const blank = S.checkHelpLiveness({
      catalog: [{ cmd: 'orchestration worker-start', flags: ['--task'] }],
      fetchHelp: () => '   ',
    });
    await t.test('help 无输出 → 没查成', () => {
      assert.ok(blank.unscanned === true && blank.ok === false, 'help 无输出 → 没查成');
    });

    const skipCi = S.helpCheckPolicy({ ci: true, orca: { ok: false, missing: true, error: 'spawnSync orca ENOENT' } });
    await t.test('CI 无 orca → SKIP（不计失败）', () => {
      assert.ok(skipCi.action === 'skip' && /不在 PATH/.test(skipCi.reason), 'CI 无 orca → SKIP（不计失败）  →  ' + JSON.stringify(skipCi));
    });
    const skipLocal = S.helpCheckPolicy({ ci: false, orca: { ok: false, missing: true, error: 'spawnSync orca ENOENT' } });
    await t.test('本机无 orca → SKIP（#807 不再当红）', () => {
      assert.ok(skipLocal.action === 'skip', '本机无 orca → SKIP（#807 不再当红）  →  ' + JSON.stringify(skipLocal));
    });
    const failBroken = S.helpCheckPolicy({ ci: false, orca: { ok: false, missing: false, error: 'orca --help 无输出' } });
    await t.test('orca 在但 --help 空 → FAIL', () => {
      assert.ok(failBroken.action === 'fail', 'orca 在但 --help 空 → FAIL  →  ' + JSON.stringify(failBroken));
    });
    const runLive = S.helpCheckPolicy({ ci: true, orca: { ok: true, missing: false } });
    await t.test('有 orca 时 CI 也必须真跑', () => {
      assert.ok(runLive.action === 'run', '有 orca 时 CI 也必须真跑  →  ' + JSON.stringify(runLive));
    });

    const avail = S.orcaHelpAvailable();
    const policy = S.helpCheckPolicy({ ci: S.isCiEnv(), orca: avail });
    if (policy.action === 'skip') {
      await t.test('live orca --help（本机不可用，跳过）', { skip: `live orca --help（${policy.reason}）` }, () => {});
    } else if (policy.action === 'fail') {
      await t.test('live orca --help 可跑', () => {
        assert.ok(false, 'live orca --help 可跑  →  ' + policy.reason);
      });
    } else {
      const liveText = S.fetchOrcaHelp('orchestration worker-start');
      await t.test('live --help 也不含 --submit', () => {
        assert.ok(!S.parseHelpFlags(liveText).has('--submit'), 'live --help 也不含 --submit');
      });
    }
  });

  it('③ pi 假活：mtime + git（#463）', async (t) => {
    const S = await S_LOAD;
    const now = 1_700_000_000_000;
    const hours = 3.5 * 3600 * 1000;
    const fake = S.assessLiveness({
      now,
      processNewestMtime: now - 12_000,
      processStartedMs: now - hours,
      workNewestMtime: now - hours,
      gitHeadMs: now - hours,
      gitDirty: false,
    });
    await t.test('state.json 12 秒前在动 + 代码停在 3.5h 前的 commit → fake-alive', () => {
      assert.ok(fake.verdict === 'fake-alive', 'state.json 12 秒前在动 + 代码停在 3.5h 前的 commit → fake-alive  →  ' + JSON.stringify(fake));
    });
    await t.test('假活 processAlive=true hasOutput=false', () => {
      assert.ok(fake.processAlive === true && fake.hasOutput === false, '假活 processAlive=true hasOutput=false  →  ' + JSON.stringify(fake));
    });

    const working = S.assessLiveness({
      now,
      processNewestMtime: now - 12_000,
      processStartedMs: now - hours,
      workNewestMtime: now - 30_000,
      gitHeadMs: now - hours,
      gitDirty: true,
    });
    await t.test('判别力：代码刚改过 → working（不会误报假活）', () => {
      assert.ok(working.verdict === 'working', '判别力：代码刚改过 → working（不会误报假活）  →  ' + JSON.stringify(working));
    });

    const thinking = S.assessLiveness({
      now,
      processNewestMtime: now - 12_000,
      processStartedMs: now - 60_000,
      workNewestMtime: now - hours,
      gitHeadMs: now - hours,
      gitDirty: false,
    });
    await t.test('刚开工不到宽限期 → thinking', () => {
      assert.ok(thinking.verdict === 'thinking', '刚开工不到宽限期 → thinking  →  ' + JSON.stringify(thinking));
    });

    const dead = S.assessLiveness({
      now,
      processNewestMtime: now - 30 * 60 * 1000,
      processStartedMs: now - hours,
      workNewestMtime: now - hours,
      gitHeadMs: now - hours,
      gitDirty: false,
    });
    await t.test('进程文件也不动 → dead', () => {
      assert.ok(dead.verdict === 'dead', '进程文件也不动 → dead  →  ' + JSON.stringify(dead));
    });

    await t.test('state.json 算进程文件', () => {
      assert.ok(S.isProcessFile('state.json') === true, 'state.json 算进程文件');
    });
    await t.test('.pi/session 算进程文件', () => {
      assert.ok(S.isProcessFile('.pi/session.json') === true, '.pi/session 算进程文件');
    });
    await t.test('src/app.js 算产出文件', () => {
      assert.ok(S.isWorkFile('src/app.js') === true && S.isProcessFile('src/app.js') === false, 'src/app.js 算产出文件');
    });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-live-'));
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const git = (args) => spawnSync('git', args, { cwd: tmp, encoding: 'utf8', env: gitEnv });
    git(['init', '-q']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    const app = path.join(tmp, 'app.js');
    fs.writeFileSync(app, 'console.log(1)\n');
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'state.json\n');
    git(['add', 'app.js', '.gitignore']);
    git(['commit', '-q', '-m', 'init']);
    const state = path.join(tmp, 'state.json');
    fs.writeFileSync(state, '{}\n');
    const oldSec = (Date.now() - 3.5 * 3600 * 1000) / 1000;
    fs.utimesSync(app, oldSec, oldSec);
    fs.utimesSync(path.join(tmp, '.gitignore'), oldSec, oldSec);
    if (process.platform === 'win32') {
      spawnSync('powershell', [
        '-NoProfile', '-Command',
        `$i=Get-Item -LiteralPath '${state.replace(/'/g, "''")}'; $t=(Get-Date).AddHours(-3.5); $i.CreationTime=$t; $i.LastWriteTime=(Get-Date).AddSeconds(-12)`,
      ], { encoding: 'utf8' });
    } else {
      // 非 Windows 没有可写的 CreationTime，活性判定只读 mtime；utimes 等价模拟「进程文件 12 秒前动过」
      const recentSec = (Date.now() - 12_000) / 1000;
      fs.utimesSync(state, recentSec, recentSec);
    }
    const scanned = S.assessWorktreeLiveness(tmp);
    // fake-alive 判定靠 processStartedMs=文件 birthtime；birthtime 在非 Windows 不可写，
    // 集成形态只能在 Windows 验（verdict 判定逻辑本身由本套件纯函数用例覆盖，Linux 上不失网）
    await t.test('真实目录+git：pi 假活 → fake-alive', {
      skip: process.platform !== 'win32' ? 'birthtime 非 Windows 不可写，集成形态只在 Windows 验' : false,
    }, () => {
      assert.ok(scanned.verdict === 'fake-alive', '真实目录+git：pi 假活 → fake-alive  →  ' + JSON.stringify(scanned));
    });
    await t.test('真实目录+git：processAlive 且无产出', () => {
      assert.ok(scanned.processAlive === true && scanned.hasOutput === false, '真实目录+git：processAlive 且无产出  →  ' + JSON.stringify(scanned));
    });
    await t.test('真实目录+git：git 干净', () => {
      assert.ok(scanned.gitDirty === false, '真实目录+git：git 干净  →  ' + JSON.stringify(scanned));
    });
  });

});
