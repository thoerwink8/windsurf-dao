// 统一命令库 CLI 回归（issue #482）
//
// 验的层：①启动模板从表读、零硬编码、fail-loud
// ②验开工（有输出 / 无待确认）
// ③--help 参数存活（真 --help，禁 mock 内生）
// ④活性：文件 mtime + git 状态
// ⑤逃生口留痕
//
// 原三钉（封装层）：
//   1. 漏 -a never → 审官逐条卡确认
//   2. 用了不存在的 --submit
//   3. pi 界面 Working 一行，活证判据改走 mtime + git
// 规格重定义三钉（约束层，缺参数必须报错）：
//   4. merge-policy 默认 auto（#511：帅只感知不再是关口）；选 manual 必须给 --merge-reason
//   5. 缺 --model/--role（峰时误推 ds-flash：不给则只推荐、禁静默）
//   6. 缺 --reviewer（现建现起造成流转断点）

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'scripts', 'dao.mjs');
const LIB = path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs');
const S_LOAD = import('file://' + LIB.replace(/\\/g, '/'));
const ROUTING_LOAD = S_LOAD.then(m => m.loadRouting());

describe('dao', () => {
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
    await t.test('#602 pi 启动带 provider 前缀，避免裸名歧义', () => {
      assert.ok(flash.command.includes('opencode-go/deepseek-v4-flash'), '#602 pi 启动带 provider 前缀，避免裸名歧义  →  ' + flash.command);
    });
    const kimi = S.resolveLaunch({ model: 'kimi-k3', routing });
    await t.test('#615 kimi 主路走 cursor-agent / kimi-k3-high', () => {
      assert.ok(/cursor-agent/.test(kimi.command) && /--model\s+kimi-k3-high/.test(kimi.command) && /--force/.test(kimi.command), '#615 kimi 主路走 cursor-agent / kimi-k3-high  →  ' + kimi.command);
    });
    const kimiOg = S.resolveLaunch({
      model: 'kimi-k3',
      pipe: { provider: 'opencode-go', cli_model: 'kimi-k3' },
      routing,
    });
    await t.test('#615 kimi 支路走 opencode-go/kimi-k3', () => {
      assert.ok(kimiOg.command.includes('kimi-k3') && /pi\b/.test(kimiOg.command), '#615 kimi 支路走 opencode-go/kimi-k3  →  ' + kimiOg.command);
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
    await t.test('#615 composer 单管 cursor', () => {
      assert.ok(/cursor-agent/.test(composer.command) && /--model\s+composer-2.5/.test(composer.command), '#615 composer 单管 cursor  →  ' + composer.command);
    });
    const devin = S.resolveLaunch({ model: 'devin-deepseek-v4-flash-max', routing });
    await t.test('#688 devin 走 --command，模型是 flash-max，带 dangerous', () => {
      assert.ok(/^devin\b/.test(devin.command) && /--model\s+deepseek-v4-flash-max/.test(devin.command) && /--permission-mode\s+dangerous/.test(devin.command) && !/--print/.test(devin.command) && devin.agentId == null, '#688 devin launch  →  ' + JSON.stringify(devin));
    });
    await t.test('shim 文件在仓里', () => {
      assert.ok(fs.existsSync(path.join(REPO, 'scripts', 'grok-shim.cmd')), 'shim 文件在仓里');
    });
    const shim = fs.readFileSync(path.join(REPO, 'scripts', 'grok-shim.cmd'), 'utf8');
    await t.test('shim 带 HTTPS_PROXY', () => {
      assert.ok(/HTTPS_PROXY=http:\/\/127\.0\.0\.1:7890/.test(shim), 'shim 带 HTTPS_PROXY');
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
  });

  it('② --submit 不存在（真 --help，禁 mock）', async (t) => {
    const S = await S_LOAD;
    const fetched = S.fetchHelpPreferLive('orchestration worker-start');
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
      assert.ok(skipCi.action === 'skip' && /本项需本机 orca/.test(skipCi.reason), 'CI 无 orca → SKIP（不计失败）  →  ' + JSON.stringify(skipCi));
    });
    const failLocal = S.helpCheckPolicy({ ci: false, orca: { ok: false, missing: true, error: 'spawnSync orca ENOENT' } });
    await t.test('本机无 orca → FAIL（不许悄悄跳过）', () => {
      assert.ok(failLocal.action === 'fail', '本机无 orca → FAIL（不许悄悄跳过）  →  ' + JSON.stringify(failLocal));
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
    spawnSync('powershell', [
      '-NoProfile', '-Command',
      `$i=Get-Item -LiteralPath '${state.replace(/'/g, "''")}'; $t=(Get-Date).AddHours(-3.5); $i.CreationTime=$t; $i.LastWriteTime=(Get-Date).AddSeconds(-12)`,
    ], { encoding: 'utf8' });
    const scanned = S.assessWorktreeLiveness(tmp);
    await t.test('真实目录+git：pi 假活 → fake-alive', () => {
      assert.ok(scanned.verdict === 'fake-alive', '真实目录+git：pi 假活 → fake-alive  →  ' + JSON.stringify(scanned));
    });
    await t.test('真实目录+git：processAlive 且无产出', () => {
      assert.ok(scanned.processAlive === true && scanned.hasOutput === false, '真实目录+git：processAlive 且无产出  →  ' + JSON.stringify(scanned));
    });
    await t.test('真实目录+git：git 干净', () => {
      assert.ok(scanned.gitDirty === false, '真实目录+git：git 干净  →  ' + JSON.stringify(scanned));
    });
  });

  it('④⑤⑥ 派工硬闸（merge-policy 默认 auto；manual 必带理由；缺 model/reviewer 报错）', async (t) => {
    const S = await S_LOAD;
    const routing = await ROUTING_LOAD;
    function withSplit(extra) {
      if (extra.includes('--split')) return extra;
      return [...extra, '--split', 'no', '--split-reason', '单测默认：不测拆分'];
    }
    function dispatch(extra, opts = {}) {
      const args = opts.raw ? extra : withSplit(extra);
      return spawnSync(process.execPath, [CLI, 'dispatch', ...args], { encoding: 'utf8', cwd: REPO });
    }
    function payload(r) {
      try { return JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop()); }
      catch { return { raw: r.stdout, err: r.stderr }; }
    }

    const noMerge = dispatch(['--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const p1 = payload(noMerge);
    await t.test('缺 --merge-policy → 默认 auto 通过', () => {
      assert.ok(noMerge.status === 0 && p1.mergePolicy === 'auto', '缺 --merge-policy → 默认 auto 通过  →  ' + JSON.stringify(p1));
    });

    const noReason = dispatch(['--merge-policy', 'manual', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const p1b = payload(noReason);
    await t.test('manual 无 --merge-reason → 非零', () => {
      assert.ok(noReason.status !== 0, 'manual 无 --merge-reason → 非零  →  ' + `status=${noReason.status}`);
    });
    await t.test('manual 无 --merge-reason → 打印缺什么', () => {
      assert.ok(p1b.error && String(p1b.error).includes('--merge-reason'), 'manual 无 --merge-reason → 打印缺什么  →  ' + JSON.stringify(p1b));
    });

    const withReason = dispatch(['--merge-policy', 'manual', '--merge-reason', '改协作约定 CLAUDE.md', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const p1c = payload(withReason);
    await t.test('manual 带理由 → 通过且理由落 comment', () => {
      assert.ok(withReason.status === 0 && p1c.mergePolicy === 'manual' && /manual 理由: 改协作约定/.test(p1c.comment), 'manual 带理由 → 通过且理由落 comment  →  ' + JSON.stringify(p1c));
    });
    await t.test('manual 带理由 → mergeReason 透传', () => {
      assert.ok(p1c.mergeReason === '改协作约定 CLAUDE.md', 'manual 带理由 → mergeReason 透传  →  ' + JSON.stringify(p1c));
    });

    const emptyReason = dispatch(['--merge-policy', 'manual', '--merge-reason', '  ', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const p1d = payload(emptyReason);
    await t.test('manual 理由为空白 → 非零（理由为空即退出）', () => {
      assert.ok(emptyReason.status !== 0 && /--merge-reason/.test(p1d.error || ''), 'manual 理由为空白 → 非零（理由为空即退出）  →  ' + JSON.stringify(p1d));
    });

    const autoExplicit = dispatch(['--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const p1e = payload(autoExplicit);
    await t.test('显式 auto 无需理由 → 通过', () => {
      assert.ok(autoExplicit.status === 0 && p1e.mergePolicy === 'auto', '显式 auto 无需理由 → 通过  →  ' + JSON.stringify(p1e));
    });
    await t.test('#615 dry-run 带 slate 且 grok 在名单里', () => {
      assert.ok(Array.isArray(p1e.slate) && p1e.slate.some(s => s && s.id === 'grok-4.6' && Array.isArray(s.pipes)), '#615 dry-run 带 slate 且 grok 在名单里  →  ' + JSON.stringify(p1e.slate));
    });

    const noModel = dispatch(['--merge-policy', 'auto', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--dry-run']);
    const p2 = payload(noModel);
    await t.test('缺 --model/--role → 非零', () => {
      assert.ok(noModel.status !== 0, '缺 --model/--role → 非零  →  ' + `status=${noModel.status}`);
    });
    await t.test('缺 --model/--role → 打印缺什么', () => {
      assert.ok(p2.error && String(p2.error).includes('--model'), '缺 --model/--role → 打印缺什么  →  ' + JSON.stringify(p2));
    });

    const noRev = dispatch(['--merge-policy', 'auto', '--model', 'grok-4.6', '--name', 'x', '--dry-run']);
    const p3 = payload(noRev);
    await t.test('缺 --reviewer → 非零', () => {
      assert.ok(noRev.status !== 0, '缺 --reviewer → 非零  →  ' + `status=${noRev.status}`);
    });
    await t.test('缺 --reviewer → 打印缺什么', () => {
      assert.ok(p3.error && String(p3.error).includes('--reviewer'), '缺 --reviewer → 打印缺什么  →  ' + JSON.stringify(p3));
    });

    const noSpec = dispatch(['--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--dry-run']);
    const pSpec = payload(noSpec);
    await t.test('R5 缺 --spec → 非零', () => {
      assert.ok(noSpec.status !== 0, 'R5 缺 --spec → 非零  →  ' + `status=${noSpec.status}`);
    });
    await t.test('R5 缺 --spec → 打印缺什么', () => {
      assert.ok(pSpec.error && String(pSpec.error).includes('--spec'), 'R5 缺 --spec → 打印缺什么  →  ' + JSON.stringify(pSpec));
    });

    const ok = dispatch(['--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--spec', '短摘要：修命令库', '--dry-run']);
    const pOk = payload(ok);
    await t.test('三参数齐 + --spec → dry-run 过', () => {
      assert.ok(ok.status === 0 && pOk.ok === true, '三参数齐 + --spec → dry-run 过  →  ' + JSON.stringify(pOk));
    });
    await t.test('dry-run 不再预建审官卡（#586 按需起）', () => {
      assert.ok(pOk.reviewerDeferred === true && pOk.reviewerCard == null, 'dry-run 不再预建审官卡（#586 按需起）  →  ' + JSON.stringify(pOk));
    });
    await t.test('dry-run 仍校验审官 launch（不建卡但选型要合法）', () => {
      assert.ok(/codex/.test(pOk.reviewerLaunchChecked) && String(pOk.reviewerLaunchChecked || '').includes(S.CODEX_CAPABLE_FLAG), 'dry-run 仍校验审官 launch（不建卡但选型要合法）  →  ' + JSON.stringify(pOk));
    });
    await t.test('dry-run 工人走 grok --always-approve', () => {
      assert.ok(/\bgrok\b/.test(pOk.workerLaunch) && /--always-approve/.test(pOk.workerLaunch), 'dry-run 工人走 grok --always-approve  →  ' + JSON.stringify(pOk));
    });

    const okIssue = dispatch(['--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', '修地基', '--issue', '565', '--spec', '短摘要', '--dry-run']);
    const pIssue = payload(okIssue);
    await t.test('#589：dry-run 带 --issue → 工人卡 ISSUE- + 角色·模型（审官卡推迟到 worker-done）', () => {
      assert.ok(okIssue.status === 0 && pIssue.workerCard === 'ISSUE-#565 工人·grok-4.6 修地基' && pIssue.reviewerDeferred === true, '#589：dry-run 带 --issue → 工人卡 ISSUE-# + 角色·模型  →  ' + JSON.stringify(pIssue));
    });
    await t.test('#559 追加：dry-run 带 --issue → issue 字段透出', () => {
      assert.ok(pIssue.issue === '565', '#559 追加：dry-run 带 --issue → issue 字段透出  →  ' + JSON.stringify(pIssue));
    });

    const peak = '2026-08-15T02:00:00.000Z'; // 北京 10:00 峰时
    const roleOnly = dispatch(['--merge-policy', 'auto', '--role', '写码', '--reviewer', 'gpt-5.6-sol', '--now', peak, '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const pRole = payload(roleOnly);
    await t.test('峰时只给 --role 不给 --model → 非零（禁静默默认）', () => {
      assert.ok(roleOnly.status !== 0, '峰时只给 --role 不给 --model → 非零（禁静默默认）  →  ' + JSON.stringify(pRole));
    });
    await t.test('写码推荐 devin 通道条目不是 ds-flash', () => {
      assert.ok(pRole.recommendation && pRole.recommendation.model === 'devin-deepseek-v4-flash-max', '写码推荐 devin 通道条目  →  ' + JSON.stringify(pRole));
    });
    await t.test('写码推荐不是 deepseek-v4-flash（误推钉）', () => {
      assert.ok(!(pRole.recommendation && pRole.recommendation.model === 'deepseek-v4-flash'), '写码推荐不是 deepseek-v4-flash（误推钉）  →  ' + JSON.stringify(pRole));
    });

    const roleConfirm = dispatch(['--merge-policy', 'auto', '--role', '写码', '--reviewer', 'gpt-5.6-sol', '--now', peak, '--confirm', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const pConf = payload(roleConfirm);
    await t.test('--role + --confirm 采用写码推荐 devin', () => {
      assert.ok(roleConfirm.status === 0 && pConf.model === 'devin-deepseek-v4-flash-max', '--role + --confirm 采用写码推荐 devin  →  ' + JSON.stringify(pConf));
    });

    const fnDefault = S.resolveDispatchConstraints({
      model: 'grok-4.6', reviewer: 'gpt-5.6-sol', routing,
    });
    await t.test('函数层不给 mergePolicy → 默认 auto', () => {
      assert.ok(fnDefault.ok === true && fnDefault.mergePolicy === 'auto', '函数层不给 mergePolicy → 默认 auto  →  ' + JSON.stringify(fnDefault));
    });
    const fnManualNoReason = S.resolveDispatchConstraints({
      mergePolicy: 'manual', model: 'grok-4.6', reviewer: 'gpt-5.6-sol', routing,
    });
    await t.test('函数层 manual 无理由 → 失败', () => {
      assert.ok(fnManualNoReason.ok === false && (fnManualNoReason.missing || []).includes('--merge-reason'), '函数层 manual 无理由 → 失败  →  ' + JSON.stringify(fnManualNoReason));
    });

    const fnMiss = S.resolveDispatchConstraints({
      mergePolicy: 'auto', model: 'grok-4.6', routing,
    });
    await t.test('函数层缺 --reviewer 也失败', () => {
      assert.ok(fnMiss.ok === false && (fnMiss.missing || []).includes('--reviewer'), '函数层缺 --reviewer 也失败  →  ' + JSON.stringify(fnMiss));
    });

    const ws = spawnSync(process.execPath, [
      CLI, 'worker-start', '--task', 't', '--worktree', 'w', '--terminal', 'h',
    ], { encoding: 'utf8', cwd: REPO });
    const pWs = payload(ws);
    await t.test('worker-start 缺 model/reviewer → 非零', () => {
      assert.ok(ws.status !== 0 && String(pWs.error || '').includes('--model'), 'worker-start 缺 model/reviewer → 非零  →  ' + JSON.stringify(pWs));
    });

    const wsManual = spawnSync(process.execPath, [
      CLI, 'worker-start', '--task', 't', '--worktree', 'w', '--terminal', 'h',
      '--merge-policy', 'manual', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol',
    ], { encoding: 'utf8', cwd: REPO });
    const pWsManual = payload(wsManual);
    await t.test('worker-start manual 无理由 → 非零', () => {
      assert.ok(wsManual.status !== 0 && /--merge-reason/.test(pWsManual.error || ''), 'worker-start manual 无理由 → 非零  →  ' + JSON.stringify(pWsManual));
    });
  });

  it('#565 消歧门：dispatch/worker-start 带 --issue 时缺「已消歧」label 拒派', async (t) => {
    const S = await S_LOAD;
    // 纯函数三态判别（假 gh，不碰网络）：查成有 label / 查成没 label / 没查成（gh 失败 / 非 JSON）。
    const ghHas = () => ({ ok: true, out: JSON.stringify({ labels: [{ name: '已消歧' }, { name: '任务' }] }) });
    const ghNone = () => ({ ok: true, out: JSON.stringify({ labels: [{ name: '任务' }] }) });
    const ghFail = () => ({ ok: false, error: 'gh exit 1: network down' });
    const ghBroken = () => ({ ok: true, out: 'not json at all' });

    const ok1 = S.checkIssueDisambiguated({ issue: '565', runGh: ghHas });
    await t.test('消歧门：有 已消歧 label → 放行', () => {
      assert.ok(ok1.ok === true && ok1.hasLabel === true && ok1.gated === true, '消歧门：有 已消歧 label → 放行  →  ' + JSON.stringify(ok1));
    });
    const no1 = S.checkIssueDisambiguated({ issue: '559', runGh: ghNone });
    await t.test('消歧门：查成但没 label → 拒派并点名缺什么', () => {
      assert.ok(no1.ok === false && no1.hasLabel === false && /已消歧/.test(no1.error) && /补消歧记录|label/.test(no1.error), '消歧门：查成但没 label → 拒派并点名缺什么  →  ' + JSON.stringify(no1));
    });
    await t.test('消歧门：没 label ≠ 没查成（两态分开）', () => {
      assert.ok(no1.unscanned !== true, '消歧门：没 label ≠ 没查成（两态分开）  →  ' + JSON.stringify(no1));
    });
    const f1 = S.checkIssueDisambiguated({ issue: '559', runGh: ghFail });
    await t.test('消歧门：gh 失败 → 没查成，不许当没 label 放行', () => {
      assert.ok(f1.ok === false && f1.unscanned === true && /没查成/.test(f1.error), '消歧门：gh 失败 → 没查成，不许当没 label 放行  →  ' + JSON.stringify(f1));
    });
    const b1 = S.checkIssueDisambiguated({ issue: '559', runGh: ghBroken });
    await t.test('消歧门：gh 返回非 JSON → 没查成', () => {
      assert.ok(b1.ok === false && b1.unscanned === true, '消歧门：gh 返回非 JSON → 没查成  →  ' + JSON.stringify(b1));
    });
    const noIssue = S.checkIssueDisambiguated({ issue: '', runGh: ghNone });
    await t.test('消歧门：无 --issue → 不受门控', () => {
      assert.ok(noIssue.ok === true && noIssue.gated === false, '消歧门：无 --issue → 不受门控  →  ' + JSON.stringify(noIssue));
    });
    const badIssue = S.checkIssueDisambiguated({ issue: 'abc', runGh: ghNone });
    await t.test('消歧门：--issue 非数字 → 拒派', () => {
      assert.ok(badIssue.ok === false && /issue 号/.test(badIssue.error), '消歧门：--issue 非数字 → 拒派  →  ' + JSON.stringify(badIssue));
    });

    // CLI 级：假 gh（CI 无 GH_TOKEN，dao.mjs 消歧门读 DAO_GH_FAKE 用它替真 gh；
    // 判据固定：565 有「已消歧」、559 无、999 = gh 失败）。真 gh 的端到端验收在合并证据里手跑。
    // #565 返工：--dry-run 不实际派工，门控对预览无意义——disambiguation 只作报告，不影响退出码。
    const FAKE_GH = path.join(REPO, 'tests', 'fixtures', 'fake-gh.mjs');
    const cliEnv = { ...process.env, DAO_GH_FAKE: FAKE_GH };
    const cliHas = spawnSync(process.execPath, [CLI, 'dispatch', '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', '修地基', '--issue', '565', '--spec', '短摘要', '--split', 'no', '--split-reason', '单测默认：不测拆分', '--dry-run'], { encoding: 'utf8', cwd: REPO, env: cliEnv });
    const pHas = (() => { try { return JSON.parse((cliHas.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('消歧门：dispatch --issue 565（有 label）--dry-run 过且报告为绿', () => {
      assert.ok(cliHas.status === 0 && pHas.disambiguation && pHas.disambiguation.ok === true, '消歧门：dispatch --issue 565（有 label）--dry-run 过且报告为绿  →  ' + `status=${cliHas.status} ${String(pHas.error || '')}`);
    });

    const cliNo = spawnSync(process.execPath, [CLI, 'dispatch', '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--issue', '559', '--spec', '短摘要', '--split', 'no', '--split-reason', '单测默认：不测拆分', '--dry-run'], { encoding: 'utf8', cwd: REPO, env: cliEnv });
    const pNo = (() => { try { return JSON.parse((cliNo.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('消歧门：dry-run --issue 559（无 label）→ exit 0，报告 hasLabel:false（门控不影响预览）', () => {
      assert.ok(cliNo.status === 0 && pNo.disambiguation && pNo.disambiguation.ok === false && pNo.disambiguation.hasLabel === false, '消歧门：dry-run --issue 559（无 label）→ exit 0，报告 hasLabel:false（门控不影响预览）  →  ' + `status=${cliNo.status} ${JSON.stringify(pNo)}`);
    });
    await t.test('消歧门：dry-run 报告仍说清去哪补', () => {
      assert.ok(/消歧记录|label/.test(String(pNo.disambiguation && pNo.disambiguation.error || '')), '消歧门：dry-run 报告仍说清去哪补  →  ' + String(pNo.disambiguation && pNo.disambiguation.error || ''));
    });

    // 真派工（非 dry-run）：门在碰 orca / 建卡之前拦——被拦下时什么都不会创建（#565 硬约束）。
    const cliReal = spawnSync(process.execPath, [CLI, 'dispatch', '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--issue', '559', '--spec', '短摘要', '--split', 'no', '--split-reason', '单测默认：不测拆分'], { encoding: 'utf8', cwd: REPO, env: cliEnv });
    const pReal = (() => { try { return JSON.parse((cliReal.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('消歧门：真派工 --issue 559（无 label）→ 非 0 当场拦下', () => {
      assert.ok(cliReal.status !== 0 && /已消歧/.test(String(pReal.error || '')), '消歧门：真派工 --issue 559（无 label）→ 非 0 当场拦下  →  ' + `status=${cliReal.status} ${JSON.stringify(pReal)}`);
    });
    await t.test('消歧门：真派工被拦时错误说清去哪补', () => {
      assert.ok(/消歧记录|label/.test(String(pReal.error || '')), '消歧门：真派工被拦时错误说清去哪补  →  ' + String(pReal.error || ''));
    });
    await t.test('消歧门：真派工被拦发生在建卡前（disambiguation.hasLabel=false，无 workerId）', () => {
      assert.ok((pReal.disambiguation || {}).hasLabel === false && !pReal.workerId, '消歧门：真派工被拦发生在建卡前（disambiguation.hasLabel=false，无 workerId）  →  ' + JSON.stringify(pReal));
    });

    // worker-start 带 --issue 同样受门控：559 无 label → 在碰 orca 之前就被拦（非 0）。
    const wsNo = spawnSync(process.execPath, [CLI, 'worker-start', '--task', 't', '--worktree', 'w', '--terminal', 'h', '--issue', '559', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol'], { encoding: 'utf8', cwd: REPO, env: cliEnv });
    const pWsNo = (() => { try { return JSON.parse((wsNo.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('消歧门：worker-start --issue 559（无 label）→ 非 0 拒派', () => {
      assert.ok(wsNo.status !== 0 && /已消歧/.test(String(pWsNo.error || '')), '消歧门：worker-start --issue 559（无 label）→ 非 0 拒派  →  ' + `status=${wsNo.status} ${JSON.stringify(pWsNo)}`);
    });
    await t.test('worker-start 的 FLAGS_BY_VERB 登记了 --issue', () => {
      assert.ok(S.FLAGS_BY_VERB['worker-start'].has('--issue'), 'worker-start 的 FLAGS_BY_VERB 登记了 --issue');
    });

    // CI 场景（无 GH_TOKEN → gh 失败）：真派工必须报「没查成」拒派，不许放行（#565 硬约束）。
    const cliFail = spawnSync(process.execPath, [CLI, 'dispatch', '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--issue', '999', '--spec', '短摘要', '--split', 'no', '--split-reason', '单测默认：不测拆分'], { encoding: 'utf8', cwd: REPO, env: cliEnv });
    const pFail = (() => { try { return JSON.parse((cliFail.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('消歧门：gh 失败（CI 无 token）真派工 → 非 0 且报「没查成」', () => {
      assert.ok(cliFail.status !== 0 && /没查成/.test(String(pFail.error || '')) && (pFail.disambiguation || {}).unscanned === true, '消歧门：gh 失败（CI 无 token）真派工 → 非 0 且报「没查成」  →  ' + `status=${cliFail.status} ${JSON.stringify(pFail)}`);
    });

    const daoSrc565 = fs.readFileSync(CLI, 'utf8');
    await t.test('dao.mjs dispatch 与 worker-start 都调消歧门', () => {
      assert.ok((daoSrc565.match(/checkIssueDisambiguated/g) || []).length >= 2, 'dao.mjs dispatch 与 worker-start 都调消歧门  →  ' + daoSrc565.slice(0, 60));
    });
  });

  it('#564 label 自动打：dispatch 记 issue + pr-sync-labels 合并侧同步到 PR', async (t) => {
    const S = await S_LOAD;
    // 纯函数：label 名组装（角色缺省写码）。
    const ln1 = S.dispatchLabelNames({ model: 'grok-4.6' });
    await t.test('label 名：model/<id> + type/写码（缺省）', () => {
      assert.ok(ln1.includes('model/grok-4.6') && ln1.includes('type/写码'), 'label 名：model/<id> + type/写码（缺省）  →  ' + JSON.stringify(ln1));
    });
    const ln2 = S.dispatchLabelNames({ model: 'gpt-5.6-sol', role: '审查' });
    await t.test('label 名：给角色 → type/<角色>', () => {
      assert.ok(ln2.includes('model/gpt-5.6-sol') && ln2.includes('type/审查') && !ln2.includes('type/写码'), 'label 名：给角色 → type/<角色>  →  ' + JSON.stringify(ln2));
    });

    // PR 署名单号：只认 Closes/Fixes 关键词，正文随手引用的 #N 不算。
    const refs = S.linkedIssueNumbers('Closes #564\n参考 #498 #480（历史相关）');
    await t.test('署名单号只认 Closes 关键词（#498 #480 不被抄 label）',
      () => {
        assert.ok(refs.length === 1 && refs[0] === 564, '署名单号只认 Closes 关键词（#498 #480 不被抄 label）  →  ' + JSON.stringify(refs));
      });
    const refs2 = S.linkedIssueNumbers('Fixes #12');
    await t.test('Fixes 也算署名单号', () => {
      assert.ok(refs2.length === 1 && refs2[0] === 12, 'Fixes 也算署名单号  →  ' + JSON.stringify(refs2));
    });
    const refs3 = S.linkedIssueNumbers('关联 issue #633。不要 Closes。\n见 #655 现场');
    await t.test('关联 issue #N 也是署名（不触发 GitHub 自动关单）', () => {
      assert.ok(refs3.length === 1 && refs3[0] === 633, '关联 issue #N 也是署名  →  ' + JSON.stringify(refs3));
    });

    // dispatch 侧打标：stub runGh 验证调用面（label list → 缺的建 → issue edit --add-label）。
    const calls = [];
    const recGh = (a) => {
      calls.push(a.slice());
      if (a[0] === 'label' && a[1] === 'list') return { ok: true, out: JSON.stringify([{ name: 'model/grok-4.6' }]) };
      if (a[0] === 'label' && a[1] === 'create') return { ok: true, out: JSON.stringify({ name: a[2] }) };
      if (a[0] === 'issue' && a[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: `未预期 ${a.join(' ')}` };
    };
    const stamped = S.stampIssueLabels({ issue: '123', model: 'grok-4.6', role: '写码', runGh: recGh });
    await t.test('dispatch 打标成功：names 对、缺的 label 先建、issue edit 带 --add-label',
      () => {
        assert.ok(stamped.ok === true && stamped.names.length === 2
        && calls.some(a => a[0] === 'label' && a[1] === 'create' && a[2] === 'type/写码')
        && calls.some(a => a[0] === 'issue' && a[1] === 'edit' && a[2] === '123' && a.includes('--add-label') && a.includes('model/grok-4.6') && a.includes('type/写码')),
        'dispatch 打标成功：names 对、缺的 label 先建、issue edit 带 --add-label  →  ' + JSON.stringify({ stamped, calls }));
      });

    // 没 gh 执行器 / 没合法 issue：不许当「查过没事」。
    const noGh = S.stampIssueLabels({ issue: '123', model: 'grok-4.6', runGh: null });
    await t.test('打标没 gh 执行器 → 报没查成', () => {
      assert.ok(noGh.ok === false && noGh.unscanned === true, '打标没 gh 执行器 → 报没查成  →  ' + JSON.stringify(noGh));
    });
    const skip = S.stampIssueLabels({ issue: '', model: 'grok-4.6', runGh: recGh });
    await t.test('打标没合法 issue 号 → skipped 不瞎打', () => {
      assert.ok(skip.ok === false && skip.skipped === true, '打标没合法 issue 号 → skipped 不瞎打  →  ' + JSON.stringify(skip));
    });

    // 合并侧同步：stub runGh（PR 正文 Closes #7，issue #7 有 model+type）。
    const calls2 = [];
    const syncGh = (a) => {
      calls2.push(a.slice());
      if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: '修 X', body: 'Closes #7\n验收：过' }) };
      if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [{ name: 'model/grok-4.6' }, { name: 'type/写码' }, { name: '已消歧' }] }) };
      if (a[0] === 'label' && a[1] === 'list') return { ok: true, out: JSON.stringify([{ name: 'model/grok-4.6' }, { name: 'type/写码' }]) };
      if (a[0] === 'pr' && a[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: `未预期 ${a.join(' ')}` };
    };
    const synced = S.syncPrLabelsFromIssue({ pr: '7', runGh: syncGh });
    await t.test('pr-sync-labels：从署名 issue 把 model/type 抄到 PR（非 model/type 不抄）',
      () => {
        assert.ok(synced.ok === true && synced.labels.length === 2 && synced.labels.includes('model/grok-4.6') && synced.labels.includes('type/写码')
        && calls2.some(a => a[0] === 'pr' && a[1] === 'edit' && a[2] === '7' && a.includes('--add-label')),
        'pr-sync-labels：从署名 issue 把 model/type 抄到 PR（非 model/type 不抄）  →  ' + JSON.stringify({ synced, calls2 }));
      });

    // PR 没署名单号 → 说清楚，不许静默。
    const noRef = S.syncPrLabelsFromIssue({ pr: '9', runGh: (a) => {
      if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: '无署名', body: '改动：修 bug' }) };
      return { ok: false, error: `未预期 ${a.join(' ')}` };
    } });
    await t.test('pr-sync-labels 无署名单号 → 报错需人工补', () => {
      assert.ok(noRef.ok === false && /Closes|署名/.test(noRef.error), 'pr-sync-labels 无署名单号 → 报错需人工补  →  ' + JSON.stringify(noRef));
    });

    // 署名 issue 没有 model/type label → 说清楚。
    const noLabel = S.syncPrLabelsFromIssue({ pr: '10', runGh: (a) => {
      if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: 'x', body: 'Closes #10' }) };
      if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [{ name: '已消歧' }] }) };
      return { ok: false, error: `未预期 ${a.join(' ')}` };
    } });
    await t.test('署名 issue 无 model/type → 报错需人工补', () => {
      assert.ok(noLabel.ok === false && /model|type/.test(noLabel.error), '署名 issue 无 model/type → 报错需人工补  →  ' + JSON.stringify(noLabel));
    });

    // CLI 级：pr-sync-labels --pr 42（fake-gh 固定：正文 Closes #565，565 带 model/type）→ 退出 0。
    const FAKE_GH2 = path.join(REPO, 'tests', 'fixtures', 'fake-gh.mjs');
    const cliSync = spawnSync(process.execPath, [CLI, 'pr-sync-labels', '--pr', '42'], { encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH2 } });
    const pSync = (() => { try { return JSON.parse((cliSync.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI pr-sync-labels --pr 42（假 gh）→ 退出 0 且 label 抄到',
      () => {
        assert.ok(cliSync.status === 0 && pSync.ok === true && (pSync.labels || []).includes('model/grok-4.6') && (pSync.labels || []).includes('type/写码'),
          'CLI pr-sync-labels --pr 42（假 gh）→ 退出 0 且 label 抄到  →  ' + `status=${cliSync.status} ${JSON.stringify(pSync)}`);
      });
    const cliSyncNoRef = spawnSync(process.execPath, [CLI, 'pr-sync-labels', '--pr', '41'], { encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH2 } });
    const pSyncNoRef = (() => { try { return JSON.parse((cliSyncNoRef.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI pr-sync-labels 无署名单号 → 非 0 且说清',
      () => {
        assert.ok(cliSyncNoRef.status !== 0 && /署名/.test(String(pSyncNoRef.error || '')), 'CLI pr-sync-labels 无署名单号 → 非 0 且说清  →  ' + `status=${cliSyncNoRef.status} ${JSON.stringify(pSyncNoRef)}`);
      });

    const daoSrcLabels = fs.readFileSync(CLI, 'utf8');
    await t.test('dao.mjs dispatch 成功后调 stampIssueLabels', () => {
      assert.ok(/stampIssueLabels\(\{/.test(daoSrcLabels), 'dao.mjs dispatch 成功后调 stampIssueLabels  →  ' + daoSrcLabels.slice(0, 60));
    });
    await t.test('dao.mjs dispatch 打 reviewer/*', () => {
      assert.ok(/reviewer:\s*gate\.reviewer/.test(daoSrcLabels), 'dao.mjs dispatch 打 reviewer/*  →  ' + daoSrcLabels.slice(0, 60));
    });
  });

  it('#586 审官按需起阶段一：pickReviewer + 自读选型 + worker-done 骨架', async (t) => {
    const S = await S_LOAD;
    const one = S.pickReviewer(['model/grok-4.6', 'type/写码', 'reviewer/gpt-5.6-sol', '已消歧']);
    await t.test('pickReviewer 查到一个 → ok + modelId', () => {
      assert.ok(one.ok === true && one.state === 'one' && one.modelId === 'gpt-5.6-sol', 'pickReviewer 查到一个 → ok + modelId  →  ' + JSON.stringify(one));
    });
    const none = S.pickReviewer(['model/grok-4.6', 'type/写码', '已消歧']);
    await t.test('pickReviewer 没有 reviewer/* → none，不许猜', () => {
      assert.ok(none.ok === false && none.state === 'none' && /没有 reviewer/.test(none.error), 'pickReviewer 没有 reviewer/* → none，不许猜  →  ' + JSON.stringify(none));
    });
    const many = S.pickReviewer(['reviewer/gpt-5.6-sol', 'reviewer/claude-opus']);
    await t.test('pickReviewer 有多个 → many，不许猜', () => {
      assert.ok(many.ok === false && many.state === 'many' && /多个 reviewer/.test(many.error), 'pickReviewer 有多个 → many，不许猜  →  ' + JSON.stringify(many));
    });
    const unscanned = S.pickReviewer(null);
    await t.test('pickReviewer 没拿到列表 → unscanned，和「扫完 0 条」不同话',
      () => {
        assert.ok(unscanned.ok === false && unscanned.state === 'unscanned'
        && unscanned.error !== none.error && unscanned.error !== many.error && one.state !== none.state,
        'pickReviewer 没拿到列表 → unscanned，和「扫完 0 条」不同话  →  ' + JSON.stringify({ unscanned, none, many }));
      });
    await t.test('pickReviewer 三态话面互不相同',
      () => {
        assert.ok(one.state !== none.state && none.state !== many.state && many.state !== one.state
        && none.error !== many.error,
        'pickReviewer 三态话面互不相同  →  ' + JSON.stringify({ none: none.error, many: many.error }));
      });

    const lnRev = S.dispatchLabelNames({ model: 'grok-4.6', role: '写码', reviewer: 'gpt-5.6-sol' });
    await t.test('label 名含 reviewer/<id>', () => {
      assert.ok(lnRev.includes('reviewer/gpt-5.6-sol') && lnRev.includes('model/grok-4.6'), 'label 名含 reviewer/<id>  →  ' + JSON.stringify(lnRev));
    });

    const stampCalls = [];
    const stampGh = (a) => {
      stampCalls.push(a.slice());
      if (a[0] === 'label' && a[1] === 'list') return { ok: true, out: JSON.stringify([{ name: 'model/grok-4.6' }, { name: 'type/写码' }]) };
      if (a[0] === 'label' && a[1] === 'create') return { ok: true, out: JSON.stringify({ name: a[2] }) };
      if (a[0] === 'issue' && a[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: `未预期 ${a.join(' ')}` };
    };
    const stampedRev = S.stampIssueLabels({ issue: '123', model: 'grok-4.6', role: '写码', reviewer: 'gpt-5.6-sol', runGh: stampGh });
    await t.test('dispatch 打标含 reviewer/*',
      () => {
        assert.ok(stampedRev.ok === true && stampedRev.names.includes('reviewer/gpt-5.6-sol')
        && stampCalls.some(a => a[0] === 'issue' && a.includes('reviewer/gpt-5.6-sol')),
        'dispatch 打标含 reviewer/*  →  ' + JSON.stringify({ stampedRev, stampCalls }));
      });

    const syncRevCalls = [];
    const syncRev = S.syncPrLabelsFromIssue({
      pr: '8',
      runGh: (a) => {
        syncRevCalls.push(a.slice());
        if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: 'x', body: 'Closes #8' }) };
        if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [{ name: 'model/grok-4.6' }, { name: 'type/写码' }, { name: 'reviewer/gpt-5.6-sol' }, { name: '已消歧' }] }) };
        if (a[0] === 'label' && a[1] === 'list') return { ok: true, out: JSON.stringify([{ name: 'model/grok-4.6' }, { name: 'type/写码' }, { name: 'reviewer/gpt-5.6-sol' }]) };
        if (a[0] === 'pr' && a[1] === 'edit') return { ok: true, out: '{}' };
        return { ok: false, error: `未预期 ${a.join(' ')}` };
      },
    });
    await t.test('pr-sync-labels 抄 reviewer/*（已消歧仍不抄）',
      () => {
        assert.ok(syncRev.ok === true && syncRev.labels.includes('reviewer/gpt-5.6-sol') && syncRev.labels.includes('model/grok-4.6')
        && !syncRev.labels.includes('已消歧'),
        'pr-sync-labels 抄 reviewer/*（已消歧仍不抄）  →  ' + JSON.stringify(syncRev));
      });

    const onlyRevCalls = [];
    const onlyRev = S.syncPrLabelsFromIssue({
      pr: '11',
      runGh: (a) => {
        onlyRevCalls.push(a.slice());
        if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: 'x', body: 'Closes #11' }) };
        if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [{ name: 'reviewer/gpt-5.6-sol' }] }) };
        if (a[0] === 'pr' && a[1] === 'edit') return { ok: true, out: '{}' };
        return { ok: false, error: `未预期 ${a.join(' ')}` };
      },
    });
    await t.test('pr-sync-labels 只有 reviewer/* → 拒且不调 pr edit',
      () => {
        assert.ok(onlyRev.ok === false && /model/.test(onlyRev.error) && /type/.test(onlyRev.error)
        && !onlyRevCalls.some(a => a[0] === 'pr' && a[1] === 'edit'),
        'pr-sync-labels 只有 reviewer/* → 拒且不调 pr edit  →  ' + JSON.stringify({ onlyRev, onlyRevCalls }));
      });

    const modelOnlyCalls = [];
    const modelOnly = S.syncPrLabelsFromIssue({
      pr: '12',
      runGh: (a) => {
        modelOnlyCalls.push(a.slice());
        if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: 'x', body: 'Closes #12' }) };
        if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [{ name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }] }) };
        if (a[0] === 'pr' && a[1] === 'edit') return { ok: true, out: '{}' };
        return { ok: false, error: `未预期 ${a.join(' ')}` };
      },
    });
    await t.test('pr-sync-labels 有 model 无 type → 拒且不调 pr edit',
      () => {
        assert.ok(modelOnly.ok === false && /type/.test(modelOnly.error)
        && !modelOnlyCalls.some(a => a[0] === 'pr' && a[1] === 'edit'),
        'pr-sync-labels 有 model 无 type → 拒且不调 pr edit  →  ' + JSON.stringify({ modelOnly, modelOnlyCalls }));
      });

    const FAKE_GH3 = path.join(REPO, 'tests', 'fixtures', 'fake-gh.mjs');
    const cliPick = spawnSync(process.execPath, [CLI, 'reviewer-create', '--pr', '42', '--dry-run'], {
      encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH3 },
    });
    const pPick = (() => { try { return JSON.parse((cliPick.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI reviewer-create --pr 42 --dry-run 打印出自读选型',
      () => {
        assert.ok(cliPick.status === 0 && pPick.ok === true && pPick.dryRun === true && pPick.reviewer === 'gpt-5.6-sol' && pPick.reviewerSource === 'label',
          'CLI reviewer-create --pr 42 --dry-run 打印出自读选型  →  ' + `status=${cliPick.status} ${JSON.stringify(pPick)} stderr=${cliPick.stderr}`);
      });

    const cliNone = spawnSync(process.execPath, [CLI, 'reviewer-create', '--pr', '43', '--dry-run'], {
      encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH3 },
    });
    const pNone = (() => { try { return JSON.parse((cliNone.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI reviewer-create 没有 reviewer/* → 非 0 且话面是「没有」',
      () => {
        assert.ok(cliNone.status !== 0 && /没有 reviewer/.test(String(pNone.error || '')),
          'CLI reviewer-create 没有 reviewer/* → 非 0 且话面是「没有」  →  ' + `status=${cliNone.status} ${JSON.stringify(pNone)}`);
      });

    const cliMany = spawnSync(process.execPath, [CLI, 'reviewer-create', '--pr', '44', '--dry-run'], {
      encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH3 },
    });
    const pMany = (() => { try { return JSON.parse((cliMany.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI reviewer-create 有多个 reviewer/* → 非 0 且话面是「多个」',
      () => {
        assert.ok(cliMany.status !== 0 && /多个 reviewer/.test(String(pMany.error || '')),
          'CLI reviewer-create 有多个 reviewer/* → 非 0 且话面是「多个」  →  ' + `status=${cliMany.status} ${JSON.stringify(pMany)}`);
      });
    await t.test('CLI 没有 / 多个 话面不同', () => {
      assert.ok(String(pNone.error || '') !== String(pMany.error || ''), 'CLI 没有 / 多个 话面不同');
    });

    await t.test('worker-done 已登记进 VERBS', () => {
      assert.ok(S.VERBS.includes('worker-done'), 'worker-done 已登记进 VERBS  →  ' + S.VERBS.join(','));
    });
    const wdHelp = spawnSync(process.execPath, [CLI, 'worker-done', '--help'], { encoding: 'utf8', cwd: REPO });
    await t.test('worker-done 出现在 help', () => {
      assert.ok(/worker-done/.test(wdHelp.stdout || ''), 'worker-done 出现在 help  →  ' + (wdHelp.stdout || '').slice(0, 200));
    });
    const wdMiss = spawnSync(process.execPath, [CLI, 'worker-done'], { encoding: 'utf8', cwd: REPO });
    const pWdMiss = (() => { try { return JSON.parse(wdMiss.stdout || '{}'); } catch { return {}; } })();
    await t.test('worker-done 缺 --pr → 非零', () => {
      assert.ok(wdMiss.status !== 0 && /--pr/.test(String(pWdMiss.error || wdMiss.stderr || '')), 'worker-done 缺 --pr → 非零  →  ' + JSON.stringify(pWdMiss));
    });

    const cliWd = spawnSync(process.execPath, [CLI, 'worker-done', '--pr', '42', '--dry-run'], {
      encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH3 },
    });
    const pWd = (() => { try { return JSON.parse((cliWd.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI worker-done --dry-run 首审：wired + shouldCreate + 调 reviewer-create --dry-run',
      () => {
        assert.ok(cliWd.status === 0 && pWd.ok === true && pWd.wired === true && pWd.round === 'first' && pWd.shouldCreate === true
        && pWd.reviewer === 'gpt-5.6-sol'
        && pWd.reviewerCreate && pWd.reviewerCreate.invoked === true && pWd.reviewerCreate.dryRun === true
        && pWd.reviewerCreate.reviewer === 'gpt-5.6-sol'
        && pWd.settled === false
        && /^完工/.test(pWd.comment || ''),
        'CLI worker-done --dry-run 首审：wired + shouldCreate + 调 reviewer-create --dry-run  →  ' + `status=${cliWd.status} ${JSON.stringify(pWd)}`);
      });

    const cliWdRework = spawnSync(process.execPath, [CLI, 'worker-done', '--pr', '46', '--dry-run'], {
      encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH3 },
    });
    const pWdRework = (() => { try { return JSON.parse((cliWdRework.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI worker-done --dry-run 返工：shouldCreate=false，不起第二个审官',
      () => {
        assert.ok(cliWdRework.status === 0 && pWdRework.ok === true && pWdRework.wired === true
        && pWdRework.round === 'rework' && pWdRework.shouldCreate === false
        && pWdRework.reviewerCreate && pWdRework.reviewerCreate.skipped === true
        && pWdRework.settled === false
        && /^返工完成/.test(pWdRework.comment || ''),
        'CLI worker-done --dry-run 返工：shouldCreate=false，不起第二个审官  →  ' + `status=${cliWdRework.status} ${JSON.stringify(pWdRework)}`);
      });

    const badBody = S.planWorkerDone({
      pr: '42',
      body: '已完成：漏了首行关键字',
      runGh: (a) => {
        if (a[0] === 'pr' && a[1] === 'view' && String(a).includes('reviews')) {
          return { ok: true, out: JSON.stringify({ reviews: [] }) };
        }
        if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: 'x', body: 'Closes #565' }) };
        if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [{ name: 'reviewer/gpt-5.6-sol' }] }) };
        return { ok: false, error: `未预期 ${a.join(' ')}` };
      },
    });
    await t.test('worker-done --body 不以「完工」开头 → 拒', () => {
      assert.ok(badBody.ok === false && /完工/.test(badBody.error), 'worker-done --body 不以「完工」开头 → 拒  →  ' + JSON.stringify(badBody));
    });

    const daoSrc586 = fs.readFileSync(CLI, 'utf8');
    await t.test('#586 不重写 reviewer-create 既有坑：仍走 assessPrMergeable + trialMergeMaster',
      () => {
        assert.ok(/function cmdReviewerCreate[\s\S]*assessPrMergeable/.test(daoSrc586)
        && /function cmdReviewerCreate[\s\S]*trialMergeMaster/.test(daoSrc586), '#586 不重写 reviewer-create 既有坑：仍走 assessPrMergeable + trialMergeMaster');
      });
    const wdFn = (daoSrc586.match(/function cmdWorkerDone\([\s\S]*?\nfunction /) || [''])[0];
    await t.test('#586 worker-done 首审真调 reviewer-create（不带 --dry-run 才建树）',
      () => {
        assert.ok(/invokeReviewerCreate\(/.test(wdFn) && /dryRun: false/.test(wdFn) && !/argsWorktreeCreate/.test(wdFn),
          '#586 worker-done 首审真调 reviewer-create（不带 --dry-run 才建树）  →  ' + wdFn.slice(0, 240));
      });
    await t.test('#675 完工评论在起审官之前（失败也要留交卷证据）', () => {
      const post = wdFn.indexOf('#675：交卷证据必须先落到 GitHub');
      const spawn = post >= 0 ? wdFn.indexOf('if (shouldCreate)', post) : -1;
      assert.ok(post >= 0 && spawn > post && /postIssueComment/.test(wdFn.slice(post, spawn)),
        '#675 完工评论在起审官之前  →  post=' + post + ' spawn=' + spawn);
    });
    await t.test('#675 起审官失败三态分开', () => {
      const timeout = S.classifyReviewerSpawnError('审官终端创建失败: terminal create 失败: Timed out waiting for terminal handle after creation');
      const paste = S.classifyReviewerSpawnError('审官注入后开工验证失败: 注入未提交（Pasted Content / Pasted text）');
      const miss = S.classifyReviewerSpawnError('worker-list 没查成');
      assert.ok(timeout.kind === 'terminal-timeout' && paste.kind === 'inject-unsubmitted' && miss.kind === 'unscanned',
        '#675 三态  →  ' + JSON.stringify({ timeout, paste, miss }));
      assert.ok(timeout.label !== paste.label && paste.label !== miss.label && timeout.label !== miss.label, '三态标签互不相同');
    });
    await t.test('#675 失败评论写清种类且不以「完工」打头', () => {
      const body = S.reviewerSpawnFailComment({ error: '注入未提交（Pasted Content）', retried: true });
      assert.ok(/^交卷没开成审官下一跳：注入未提交/.test(body) && !/^完工/.test(body) && /已重试一次/.test(body),
        '#675 失败评论  →  ' + body.slice(0, 200));
    });
    await t.test('#586 worker-done 首审/返工都走 completeWorkerDoneNotify（投失败即停）',
      () => {
        assert.ok(/create\.reviewerDispatchId/.test(wdFn) && /completeWorkerDoneNotify/.test(wdFn)
        && !/plan\.round === 'first' && reviewerDispatchId/.test(wdFn),
        '#586 worker-done 首审/返工都走 completeWorkerDoneNotify（投失败即停）  →  ' + wdFn.slice(0, 400));
      });
    await t.test('#677 worker-done 成功路径不结算（无 settleDispatch / 无 type worker_done）', () => {
      assert.ok(/settled: false/.test(wdFn) && !/settleDispatch\(/.test(wdFn)
        && !/--type['"]?\s*,\s*['"]worker_done['"]/.test(wdFn)
        && /#677：本命令只交 GitHub 卷/.test(wdFn),
        '#677 worker-done 不结算  →  ' + wdFn.slice(0, 280));
    });
    const reworkNotifyCalls = [];
    const reworkNotify = S.completeWorkerDoneNotify({
      round: 'rework',
      pr: '46',
      comment: '返工完成：PR #46\n\n已修红项',
      reviewerDispatchId: 'ctx_reviewer_existing',
      deliver: (opts) => {
        reworkNotifyCalls.push(opts);
        return { ok: true, messageId: 'msg_rework1', hop: opts.hop };
      },
    });
    await t.test('#677 completeWorkerDoneNotify 是投递给审官，不是结算士兵', () => {
      assert.ok(reworkNotifyCalls.length === 1 && reworkNotifyCalls[0].type !== 'worker_done'
        && reworkNotifyCalls[0].hop === '士兵→审官'
        && String(reworkNotifyCalls[0].to).startsWith('dispatch:'),
        '#677 投递审官不是结算  →  ' + JSON.stringify(reworkNotifyCalls[0]));
    });
    await t.test('#586 返工路径 notified.ok===true（不只是 commentPosted）',
      () => {
        assert.ok(reworkNotify.ok === true && reworkNotify.notified && reworkNotify.notified.ok === true
        && reworkNotify.notified.dispatchId === 'ctx_reviewer_existing',
        '#586 返工路径 notified.ok===true（不只是 commentPosted）  →  ' + JSON.stringify(reworkNotify));
      });
    const pickedReuseFail = S.pickWorkerDoneDispatchId({
      create: { skipped: true },
      reused: { ok: false, reuseFailed: true, error: 'runtime_unavailable' },
      existingDispatchId: 'ctx_reviewer_existing',
    });
    await t.test('#552 复用 worker-start 失败禁止回退已有 dispatch（可能已结算）',
      () => {
        assert.ok(pickedReuseFail.ok === false && /禁止回退/.test(pickedReuseFail.error || '')
        && !pickedReuseFail.reviewerDispatchId,
        '#552 复用 worker-start 失败禁止回退已有 dispatch（可能已结算）  →  ' + JSON.stringify(pickedReuseFail));
      });
    const pickedExistingBlocked = S.pickWorkerDoneDispatchId({
      create: { skipped: true },
      reused: { skipped: true },
      existingDispatchId: 'ctx_reviewer_existing',
    });
    await t.test('#552 已有审官 dispatch 不得当复审收件人',
      () => {
        assert.ok(pickedExistingBlocked.ok === false && pickedExistingBlocked.source === 'existing-blocked'
        && /#552/.test(pickedExistingBlocked.error || ''),
        '#552 已有审官 dispatch 不得当复审收件人  →  ' + JSON.stringify(pickedExistingBlocked));
      });
    await t.test('#586 返工投递主题是「返工完成：PR #…」且收件人是现有审官 dispatch',
      () => {
        assert.ok(reworkNotifyCalls.length === 1
        && reworkNotifyCalls[0].to === 'dispatch:ctx_reviewer_existing'
        && reworkNotifyCalls[0].subject === '返工完成：PR #46'
        && reworkNotifyCalls[0].hop === '士兵→审官',
        '#586 返工投递主题是「返工完成：PR #…」且收件人是现有审官 dispatch  →  ' + JSON.stringify(reworkNotifyCalls));
      });
    const reworkNoId = S.completeWorkerDoneNotify({
      round: 'rework',
      pr: '46',
      comment: '返工完成：PR #46',
      reviewerDispatchId: null,
    });
    await t.test('#586 返工找不到审官 dispatch → fail-visible',
      () => {
        assert.ok(reworkNoId.ok === false && /审官/.test(reworkNoId.error || ''),
          '#586 返工找不到审官 dispatch → fail-visible  →  ' + JSON.stringify(reworkNoId));
      });
    const reworkFailDeliver = S.completeWorkerDoneNotify({
      round: 'rework',
      pr: '46',
      comment: '返工完成：PR #46',
      reviewerDispatchId: 'ctx_x',
      deliver: () => ({ ok: false, error: '士兵→审官：收件人不存在' }),
    });
    await t.test('#586 返工投递失败 → fail-visible',
      () => {
        assert.ok(reworkFailDeliver.ok === false && /没送到|不存在/.test(reworkFailDeliver.error || ''),
          '#586 返工投递失败 → fail-visible  →  ' + JSON.stringify(reworkFailDeliver));
      });
    const reworkPlan = S.planWorkerDone({
      pr: '46',
      runGh: (a) => {
        if (a[0] === 'pr' && a[1] === 'view' && String(a).includes('reviews')) {
          return { ok: true, out: JSON.stringify({ reviews: [{ id: 1, body: '判定：红 1 项' }] }) };
        }
        if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: 'x', body: 'Closes #565' }) };
        if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [{ name: 'reviewer/gpt-5.6-sol' }] }) };
        return { ok: false, error: `未预期 ${a.join(' ')}` };
      },
    });
    await t.test('planWorkerDone 已有 review → rework，shouldCreate=false',
      () => {
        assert.ok(reworkPlan.ok === true && reworkPlan.round === 'rework' && reworkPlan.shouldCreate === false
        && /^返工完成/.test(reworkPlan.comment),
        'planWorkerDone 已有 review → rework，shouldCreate=false  →  ' + JSON.stringify(reworkPlan));
      });

    const parent = 'wt_worker';
    const parentWt = { id: parent, parentWorktreeId: null };
    const first = S.resolveReviewerReuse({
      parentId: parent, worktrees: [parentWt], workers: [], terminals: [],
    });
    const afterCreate = S.resolveReviewerReuse({
      parentId: parent,
      worktrees: [
        parentWt,
        { id: 'wt_rev', parentWorktreeId: parent, createdAt: 10, displayName: '随便叫啥' },
      ],
      workers: [{
        dispatchId: 'ctx_r1',
        resource: { worktreeId: 'wt_rev', terminalHandle: 'term_r' },
        agentTerminalHandle: 'term_r',
        terminalState: 'retained',
      }],
      terminals: [{ handle: 'term_r', worktreeId: 'wt_rev', status: 'running' }],
    });
    const afterRework = S.resolveReviewerReuse({
      parentId: parent,
      worktrees: [
        parentWt,
        { id: 'wt_rev', parentWorktreeId: parent, createdAt: 10, displayName: '随便叫啥' },
      ],
      workers: [{
        dispatchId: 'ctx_r2',
        resource: { worktreeId: 'wt_rev', terminalHandle: 'term_r' },
        agentTerminalHandle: 'term_r',
      }],
      terminals: [{ handle: 'term_r', worktreeId: 'wt_rev', status: 'running' }],
    });
    await t.test('#586 样本① 首审→返工→复核全程只有一个审官卡',
      () => {
        assert.ok(first.action === 'create' && afterCreate.action === 'reuse' && afterCreate.worktreeId === 'wt_rev'
        && afterRework.action === 'reuse' && afterRework.worktreeId === 'wt_rev'
        && afterRework.handle === 'term_r',
        '#586 样本① 首审→返工→复核全程只有一个审官卡  →  ' + JSON.stringify({ first, afterCreate, afterRework }));
      });

    const closed = S.resolveReviewerReuse({
      parentId: parent,
      worktrees: [
        parentWt,
        { id: 'wt_rev_dead', parentWorktreeId: parent, createdAt: 10 },
      ],
      workers: [{
        dispatchId: 'ctx_dead',
        resource: { worktreeId: 'wt_rev_dead', terminalHandle: 'term_dead' },
        agentTerminalHandle: 'term_dead',
      }],
      terminals: [{ handle: 'term_dead', worktreeId: 'wt_rev_dead', status: 'exited' }],
    });
    await t.test('#586 样本② 老审官终端已关闭才允许新建并写原因',
      () => {
        assert.ok(closed.action === 'create' && /已关闭|不存在/.test(closed.reason || '')
        && Array.isArray(closed.closedWorktrees) && closed.closedWorktrees.includes('wt_rev_dead'),
        '#586 样本② 老审官终端已关闭才允许新建并写原因  →  ' + JSON.stringify(closed));
      });

    const secondPr = S.resolveReviewerReuse({
      parentId: parent,
      worktrees: [
        parentWt,
        { id: 'wt_rev_590', parentWorktreeId: parent, createdAt: 1, displayName: '#590 - 别的号' },
      ],
      workers: [{
        dispatchId: 'ctx_590',
        resource: { worktreeId: 'wt_rev_590', terminalHandle: 'term_590' },
        agentTerminalHandle: 'term_590',
      }],
      terminals: [{ handle: 'term_590', worktreeId: 'wt_rev_590', status: 'running' }],
    });
    await t.test('#586 样本③ 同一工人换 PR 号不新建审官',
      () => {
        assert.ok(secondPr.action === 'reuse' && secondPr.worktreeId === 'wt_rev_590',
          '#586 样本③ 同一工人换 PR 号不新建审官  →  ' + JSON.stringify(secondPr));
      });

    const namedOnly = S.resolveReviewerReuse({
      parentId: parent,
      worktrees: [
        parentWt,
        { id: 'wt_named', parentWorktreeId: parent, createdAt: 1, displayName: '#1 - 审官·gpt' },
      ],
      workers: [],
      terminals: [],
    });
    const bookedAnon = S.resolveReviewerReuse({
      parentId: parent,
      worktrees: [
        parentWt,
        { id: 'wt_aux', parentWorktreeId: parent, createdAt: 1, displayName: '辅助·foo' },
      ],
      workers: [{
        dispatchId: 'ctx_aux',
        resource: { worktreeId: 'wt_aux', terminalHandle: 'term_aux' },
        agentTerminalHandle: 'term_aux',
      }],
      terminals: [{ handle: 'term_aux', status: 'running' }],
    });
    await t.test('#586 找审官不靠卡名：有「审官」二字但无记账 ≠ 审官卡',
      () => {
        assert.ok(namedOnly.action === 'create', '#586 找审官不靠卡名：有「审官」二字但无记账 ≠ 审官卡  →  ' + JSON.stringify(namedOnly));
      });
    await t.test('#586 找审官不靠卡名：有记账的子卡就算（即使卡名没有审官）',
      () => {
        assert.ok(bookedAnon.action === 'reuse' && bookedAnon.worktreeId === 'wt_aux',
          '#586 找审官不靠卡名：有记账的子卡就算（即使卡名没有审官）  →  ' + JSON.stringify(bookedAnon));
      });

    const staleThenLive = S.resolveReviewerReuse({
      parentId: parent,
      worktrees: [
        parentWt,
        { id: 'wt_rev_mix', parentWorktreeId: parent, createdAt: 10 },
      ],
      workers: [
        {
          dispatchId: 'ctx_old_done',
          dispatchStatus: 'completed',
          workerState: 'succeeded',
          resource: { worktreeId: 'wt_rev_mix', terminalHandle: 'term_stale' },
          agentTerminalHandle: 'term_stale',
        },
        {
          dispatchId: 'ctx_new_failed',
          dispatchStatus: 'failed',
          workerState: 'failed',
          resource: { worktreeId: 'wt_rev_mix', terminalHandle: 'term_live' },
          agentTerminalHandle: 'term_live',
        },
      ],
      terminals: [
        { handle: 'term_live', worktreeId: 'wt_rev_mix', connected: true, writable: true },
      ],
    });
    await t.test('#586 同树先结算后失败：复用还活着的 handle，不因旧 handle 误判已关',
      () => {
        assert.ok(staleThenLive.action === 'reuse' && staleThenLive.handle === 'term_live',
          '#586 同树先结算后失败：复用还活着的 handle，不因旧 handle 误判已关  →  ' + JSON.stringify(staleThenLive));
      });

    await t.test('#586 worker-done 源码不再用卡名匹配找审官',
      () => {
        assert.ok(!/\/审官\//.test(wdFn) && /resolveReviewerReuse/.test(wdFn) && /reuseReviewerOnTerminal/.test(wdFn),
          '#586 worker-done 源码不再用卡名匹配找审官  →  ' + wdFn.slice(0, 280));
      });
    await t.test('#586 复用路径 worker-start 必带审官树 --worktree',
      () => {
        assert.ok(/worktree: reviewerWorktreeId/.test(daoSrc586) && /result\.task\.id/.test(daoSrc586),
          '#586 复用路径 worker-start 必带审官树 --worktree  →  复用路径要显式 --worktree，task id 取 result.task.id');
      });
  });

  it('#602：开工验证保留；#619 订正粘贴定性', async (t) => {
    const S = await S_LOAD;
    const MARKER = '› [Pasted Content 7383 chars]\n';
    const CLEAN = '短摘要：修命令库\nThinking...\n';
    const LOADING = 'Starting MCP servers (0/5)\n';
    const unproven = () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'no_hook_report' });
    const noopSleep = () => {};

    const a = S.verifyStartedPolling({
      dispatchId: 'ctx_a',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [LOADING] } } }),
      proofOnce: () => ({ ok: true, proven: true, source: 'transcript' }),
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    await t.test('开工验证：worker-read 证明（transcript）→ started', () => {
      assert.ok(a.ok === true && a.state === 'started', '开工验证：worker-read 证明（transcript）→ started  →  ' + JSON.stringify(a));
    });

    const b = S.verifyStartedPolling({
      dispatchId: 'ctx_b',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [MARKER] } } }),
      proofOnce: () => ({ ok: true, proven: true, source: 'transcript' }),
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('已有开工证明时 Pasted Content 不挡', () => {
      assert.ok(b.ok === true && b.state === 'started', '已有开工证明时 Pasted Content 不挡  →  ' + JSON.stringify(b));
    });

    const d = S.verifyStartedPolling({
      dispatchId: 'ctx_d',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [LOADING] } } }),
      proofOnce: unproven,
      timeoutMs: 60, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    await t.test('TUI 加载期不算开工 → 超时 failed', () => {
      assert.ok(d.ok === false && d.state === 'failed' && /超时/.test(d.reason), 'TUI 加载期不算开工 → 超时 failed  →  ' + JSON.stringify(d));
    });

    const e = S.verifyStartedPolling({
      dispatchId: 'ctx_e',
      readOnce: () => ({ error: 'terminal read timeout' }),
      proofOnce: unproven,
      timeoutMs: 60, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    await t.test('全程没读成 → 超时 failed 且带 unscanned', () => {
      assert.ok(e.ok === false && e.unscanned && e.unscanned.unscanned === true, '全程没读成 → 超时 failed 且带 unscanned  →  ' + JSON.stringify(e));
    });

    const g = S.verifyStartedPolling({
      dispatchId: 'ctx_g',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [CLEAN] } } }),
      proofOnce: () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'provider_unsupported' }),
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    await t.test('pi 正常提交：proof 不可用 + 屏面稳定 → started（proofFallback）',
      () => {
        assert.ok(g.ok === true && g.state === 'started' && g.proofFallback === true && g.stableRounds >= 3, 'pi 正常提交：proof 不可用 + 屏面稳定 → started（proofFallback）  →  ' + JSON.stringify(g));
      });

    let readsH = 0;
    const h = S.verifyStartedPolling({
      dispatchId: 'ctx_h',
      readOnce: () => {
        readsH++;
        return { ok: true, result: { terminal: { tail: [readsH <= 4 ? LOADING : CLEAN] } } };
      },
      proofOnce: () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'session_not_reported' }),
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    await t.test('pi 加载开头：加载期不算绿，结束后连续稳定才判绿',
      () => {
        assert.ok(h.ok === true && h.state === 'started' && h.proofFallback === true && h.stableRounds >= 3 && readsH >= 7, 'pi 加载开头：加载期不算绿，结束后连续稳定才判绿  →  ' + JSON.stringify(h));
      });

    const j = S.verifyStartedPolling({
      dispatchId: 'ctx_j',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [] } } }),
      proofOnce: () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'provider_unsupported' }),
      timeoutMs: 60, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    await t.test('proof 不可用 + 空屏 → 不许判绿，超时 failed',
      () => {
        assert.ok(j.ok === false && j.state === 'failed' && /超时/.test(j.reason), 'proof 不可用 + 空屏 → 不许判绿，超时 failed  →  ' + JSON.stringify(j));
      });

    const daoSrcPoll = fs.readFileSync(CLI, 'utf8');
    await t.test('dao.mjs 不再调用 verifyInjectionPolling', () => {
      assert.ok(!/verifyInjectionPolling\(/.test(daoSrcPoll), 'dao.mjs 不再调用 verifyInjectionPolling');
    });
    await t.test('dao.mjs 工人/审官/attach/续派走 finishWorkerInject', () => {
      assert.ok((daoSrcPoll.match(/finishWorkerInject\(\{/g) || []).length >= 4, 'dao.mjs 工人/审官/attach/续派走 finishWorkerInject  →  ' + (daoSrcPoll.match(/finishWorkerInject\(\{/g) || []).length);
    });

    const okLine = S.assertInjectText('读 host/skills/dispatch/templates/soldier-book.md spec=修 X #602', { label: '士兵注入' });
    await t.test('短指针放行', () => {
      assert.ok(okLine.ok === true, '短指针放行  →  ' + JSON.stringify(okLine));
    });
    const withNl = S.assertInjectText('a\nb', { label: '士兵注入' });
    await t.test('含换行不再拒（按 agent 转码，不禁换行）', () => {
      assert.ok(withNl.ok === true && withNl.newlines === true, '含换行不再拒（按 agent 转码，不禁换行）  →  ' + JSON.stringify(withNl));
    });
    const tooLong = S.assertInjectText('x'.repeat(S.INJECT_MAX_BYTES + 1), { label: '士兵注入' });
    await t.test('次闸：超长单行仍拒', () => {
      assert.ok(tooLong.ok === false && /上限/.test(tooLong.error), '次闸：超长单行仍拒  →  ' + JSON.stringify(tooLong));
    });
    await t.test('#619 闸明说只量我们那一半', () => {
      assert.ok(okLine.scope === 'our-spec-only' && /preamble/.test(okLine.note) && tooLong.scope === 'our-spec-only', '#619 闸明说只量我们那一半  →  ' + JSON.stringify({ ok: okLine, tooLong }));
    });

    await t.test('grok：\n → ESC+CR', () => {
      assert.ok(S.encodeSendText('a\nb\nc', 'grok') === 'a\x1b\rb\x1b\rc', 'grok：\n → ESC+CR');
    });
    await t.test('claude：\n 原样', () => {
      assert.ok(S.encodeSendText('a\nb', 'claude') === 'a\nb', 'claude：\n 原样');
    });
    await t.test('pi / opencode-go：\n 原样', () => {
      assert.ok(S.encodeSendText('a\nb', 'opencode-go') === 'a\nb' && S.newlineCodec('pi') === 'passthrough', 'pi / opencode-go：\n 原样');
    });
    await t.test('codex：不转码（换行留不住）', () => {
      assert.ok(S.encodeSendText('a\nb', 'codex') === 'a\nb' && S.newlineCodec('gpt-5.6-sol') === 'passthrough-lost', 'codex：不转码（换行留不住）');
    });
    const sent = S.argsTerminalSend({ terminal: 't', text: '一\n二', agent: 'grok' });
    await t.test('argsTerminalSend(grok) 载荷已转码且不含裸 LF', () => {
      assert.ok(sent.includes('一\x1b\r二') && !sent.includes('一\n二'), 'argsTerminalSend(grok) 载荷已转码且不含裸 LF');
    });
  });

  it('#661：粘贴不证明开工——未提交一律立刻红，垫片补回车已退役', async (t) => {
    const S = await S_LOAD;
    const MARKER = '› [Pasted Content 4700 chars]\n';
    const CURSOR_ONLY = '[Pasted text #1 +86 lines]\n';
    const CURSOR_STUCK = '[Pasted text #1 +86 lines]\n→ 短摘要：修命令库\n';
    const CLEAN = '短摘要：审 PR #619\nThinking...\n';
    const WORKING = '短摘要：修命令库\nRunning: reading scripts/lib/dao-cmd.mjs\n';
    const noopSleep = () => {};
    const unproven = () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'no_hook_report' });
    const unavailable = () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'provider_unsupported' });

    const fastFail = S.verifyStartedPolling({
      dispatchId: 'ctx_fast',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [MARKER] } } }),
      proofOnce: unproven,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('未提交粘贴立刻报注入未提交，不等 120s 超时，pasteSubmitted:false', () => {
      assert.ok(fastFail.ok === false && fastFail.state === 'unsubmitted-paste' && fastFail.pasteSubmitted === false && /注入未提交/.test(fastFail.reason) && /禁止粘贴当开工/.test(fastFail.reason) && !/超时/.test(fastFail.reason) && typeof fastFail.text === 'string' && /Pasted Content/.test(fastFail.text), '未提交粘贴立刻报注入未提交  →  ' + JSON.stringify(fastFail));
    });

    const cursorOnly = S.verifyStartedPolling({
      dispatchId: 'ctx_cursor_only',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [CURSOR_ONLY] } } }),
      proofOnce: unproven,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('故意只贴不发：屏上只有 [Pasted text] → 红，不许当开工', () => {
      assert.ok(cursorOnly.ok === false && cursorOnly.state === 'unsubmitted-paste' && cursorOnly.pasteSubmitted === false && /禁止粘贴当开工/.test(cursorOnly.reason), '故意只贴不发：屏上只有 [Pasted text] → 红  →  ' + JSON.stringify(cursorOnly));
    });

    const cursorStuck = S.verifyStartedPolling({
      dispatchId: 'ctx_cursor_stuck',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [CURSOR_STUCK] } } }),
      proofOnce: unproven,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('故意违规：粘贴块 + 未发 follow-up → 红，不许假装开工', () => {
      assert.ok(cursorStuck.ok === false && cursorStuck.state === 'unsubmitted-paste' && cursorStuck.pasteSubmitted === false, '故意违规：粘贴块 + 未发 follow-up → 红  →  ' + JSON.stringify(cursorStuck));
    });

    let proofReads = 0;
    let provenReads = 0;
    const provenSession = S.verifyStartedPolling({
      dispatchId: 'ctx_proven',
      readOnce: () => {
        provenReads += 1;
        // 第一拍粘贴块还没画出来（屏面干净），第二拍才出现——和真实时序一致。
        const tail = provenReads === 1 ? [CLEAN] : [MARKER];
        return { ok: true, result: { terminal: { tail } } };
      },
      proofOnce: () => {
        proofReads += 1;
        return proofReads === 1
          ? unproven()
          : { ok: true, proven: true, source: 'transcript' };
      },
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('绿样本：worker-read 真 transcript 证明 session → started（外部证据优先于屏上粘贴行）', () => {
      assert.ok(provenSession.ok === true && provenSession.state === 'started' && proofReads === 2 && provenReads === 1, '绿样本：worker-read 真 transcript → started  →  ' + JSON.stringify({ provenSession, proofReads, provenReads }));
    });

    const stillStuck = S.verifyStartedPolling({
      dispatchId: 'ctx_stuck',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [MARKER] } } }),
      proofOnce: unproven,
      timeoutMs: 60, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('无证明 + 屏上仍是粘贴块 → 立刻红（不再等超时抳环境）', () => {
      assert.ok(stillStuck.ok === false && stillStuck.state === 'unsubmitted-paste' && stillStuck.pasteSubmitted === false && /注入未提交/.test(stillStuck.reason) && stillStuck.text, '无证明 + 屏上仍是粘贴块 → 立刻红  →  ' + JSON.stringify(stillStuck));
    });

    const cleanOk = S.verifyStartedPolling({
      dispatchId: 'ctx_clean',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [CLEAN] } } }),
      proofOnce: unavailable,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('绿样本：屏面干净 + proof 不可用 → 稳定轮判开工（agent 真在干活）', () => {
      assert.ok(cleanOk.ok === true && cleanOk.state === 'started' && cleanOk.proofFallback === true, '屏面干净 + proof 不可用 → 稳定轮判开工  →  ' + JSON.stringify(cleanOk));
    });

    const workOk = S.verifyStartedPolling({
      dispatchId: 'ctx_work',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [WORKING] } } }),
      proofOnce: unavailable,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('绿样本：Cursor 粘贴后状态行 Running → 真在干活，不当未提交 → 稳定轮绿', () => {
      assert.ok(workOk.ok === true && workOk.state === 'started' && workOk.proofFallback === true, 'Cursor 粘贴后在干活 → 稳定轮绿  →  ' + JSON.stringify(workOk));
    });

    const allRed = [];
    for (let i = 0; i < 10; i++) {
      allRed.push(S.verifyStartedPolling({
        dispatchId: `ctx_h${i}`,
        readOnce: () => ({ ok: true, result: { terminal: { tail: [`[Pasted Content ${4000 + i} chars]`] } } }),
        proofOnce: unproven,
        timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
      }));
    }
    await t.test('连续 10 个只贴不发样本：全部红、全部 pasteSubmitted:false、零垫片', () => {
      assert.ok(allRed.length === 10 && allRed.every(r => r.ok === false && r.state === 'unsubmitted-paste' && r.pasteSubmitted === false), '连续 10 个只贴不发样本：全部红  →  ' + JSON.stringify(allRed.map(r => r.state)));
    });

    const libSrc = fs.readFileSync(LIB, 'utf8');
    await t.test('垫片退役：dao-cmd.mjs 不再定义 completePendingPaste、不再有 sendEnter', () => {
      assert.ok(!/export function completePendingPaste\(/.test(libSrc) && !/sendEnter/.test(libSrc), 'dao-cmd.mjs 不再定义 completePendingPaste 垫片、不再有 sendEnter');
    });
    const daoSrc2 = fs.readFileSync(CLI, 'utf8');
    await t.test('dao.mjs 不再有 sendEnter / sendEnterHandle 垫片路径', () => {
      assert.ok(!/sendEnter/.test(daoSrc2), 'dao.mjs 不再有 sendEnter 垫片路径');
    });
    await t.test('回滚前先存屏（failCreated 调 snapshotHandleScreen）', () => {
      assert.ok(/function failCreated[\s\S]*snapshotHandleScreen/.test(daoSrc2) && /function snapshotHandleScreen/.test(daoSrc2), '回滚前先存屏（failCreated 调 snapshotHandleScreen）');
    });
  });

  it('#651：Cursor 认出 [Pasted text #N +M lines] 与未发出 follow-up（含审红 1/2 返工补样）', async (t) => {
    const S = await S_LOAD;
    const CURSOR_STUCK = '[Pasted text #1 +86 lines]\n→ 短摘要：修命令库\n';              // 未提交：粘贴块 + 输入框压着 follow-up
    const CURSOR_STUCK_FOLLOWUPS = '[Pasted text #1 +86 lines]\n2 follow-ups\n';          // 未提交：follow-ups 计数
    const CURSOR_WORKING = '[Pasted text #1 +86 lines]\nRunning: reading scripts/lib/dao-cmd.mjs\n'; // 已提交在干活
    const CURSOR_EMPTY_PROMPT = '[Pasted text #1 +86 lines]\n→\n';                        // 审红1：粘贴块单独 + 空 → 提示
    const CURSOR_ALONE = '[Pasted text #1 +86 lines]\n';                                  // 审红1：#634 原现场，只有粘贴块
    const CURSOR_FOLLOWUP_ALONE = '→ 短摘要：修命令库\n';                                   // 第二条指纹：只有 → 行未发
    const CURSOR_WORK_WORD = '[Pasted text #1 +86 lines]\n→ 短摘要：Reading Cursor 粘贴并提交\n'; // 审红2：follow-up 正文含 Reading
    const noopSleep = () => {};
    const unproven = () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'no_hook_report' });
    const unavailable = () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'provider_unsupported' });

    // 1. 指纹认出：pastedContentMatch / verifyInjection
    const m1 = S.pastedContentMatch(CURSOR_STUCK);
    await t.test('pastedContentMatch 认出 Cursor 粘贴块 + 未发 follow-up', () => {
      assert.ok(m1 === '[Pasted text #1 +86 lines]', 'pastedContentMatch 认出 Cursor 粘贴块  →  ' + m1);
    });
    const m2 = S.pastedContentMatch(CURSOR_STUCK_FOLLOWUPS);
    await t.test('follow-ups 字样也算未提交', () => {
      assert.ok(m2 === '[Pasted text #1 +86 lines]', 'follow-ups 字样也算未提交  →  ' + m2);
    });
    const m3 = S.pastedContentMatch(CURSOR_WORKING);
    await t.test('已提交在干活（Running/读文件）→ 不当未提交', () => {
      assert.ok(m3 === null, '已提交在干活 → 不当未提交  →  ' + m3);
    });
    const m4 = S.pastedContentMatch(CURSOR_EMPTY_PROMPT);
    await t.test('审红1：粘贴块单独出现（空 → 提示）也算未提交', () => {
      assert.ok(m4 === '[Pasted text #1 +86 lines]', '审红1：粘贴块单独出现 → 未提交  →  ' + m4);
    });
    const mAlone = S.pastedContentMatch(CURSOR_ALONE);
    await t.test('审红1：只有 [Pasted text #1 +86 lines] → 未提交', () => {
      assert.ok(mAlone === '[Pasted text #1 +86 lines]', '审红1：只有粘贴块 → 未提交  →  ' + mAlone);
    });
    const mFollowup = S.pastedContentMatch(CURSOR_FOLLOWUP_ALONE);
    await t.test('第二条指纹：只有 → 行未发 follow-up → 未提交', () => {
      assert.ok(mFollowup !== null && /→/.test(mFollowup), '第二条指纹：→ 行未发 follow-up → 未提交  →  ' + mFollowup);
    });
    const mWorkWord = S.pastedContentMatch(CURSOR_WORK_WORD);
    await t.test('审红2：follow-up 正文含 Reading/Working 仍红', () => {
      assert.ok(mWorkWord === '[Pasted text #1 +86 lines]', '审红2：follow-up 正文含 Reading 仍红  →  ' + mWorkWord);
    });

    const vStuck = S.verifyInjection({ text: CURSOR_STUCK });
    await t.test('故意违规：Cursor 未提交 → 注入验证红', () => {
      assert.ok(vStuck.ok === false && /Pasted text/.test(vStuck.reason) && vStuck.evidence === '[Pasted text #1 +86 lines]', '故意违规：Cursor 未提交 → 注入验证红  →  ' + JSON.stringify(vStuck));
    });
    const vAlone = S.verifyInjection({ text: CURSOR_ALONE });
    await t.test('审红1：只有粘贴块 → 注入验证红', () => {
      assert.ok(vAlone.ok === false && vAlone.evidence === '[Pasted text #1 +86 lines]' && /Pasted text/.test(vAlone.reason), '审红1：只有粘贴块 → 注入验证红  →  ' + JSON.stringify(vAlone));
    });
    const vFollowupInj = S.verifyInjection({ text: CURSOR_FOLLOWUP_ALONE });
    await t.test('第二条指纹：只有 → 行未发 follow-up → 注入验证红', () => {
      assert.ok(vFollowupInj.ok === false && /follow-up/.test(vFollowupInj.reason), '第二条指纹：→ 行未发 follow-up → 注入验证红  →  ' + JSON.stringify(vFollowupInj));
    });
    const vWorkWordInj = S.verifyInjection({ text: CURSOR_WORK_WORD });
    await t.test('审红2：follow-up 正文含 Reading → 注入验证红', () => {
      assert.ok(vWorkWordInj.ok === false && /Pasted text/.test(vWorkWordInj.reason), '审红2：follow-up 正文含 Reading → 注入验证红  →  ' + JSON.stringify(vWorkWordInj));
    });
    const vWork = S.verifyInjection({ text: CURSOR_WORKING });
    await t.test('已提交 + 在干活 → 注入验证绿', () => {
      assert.ok(vWork.ok === true, '已提交 + 在干活 → 注入验证绿  →  ' + JSON.stringify(vWork));
    });
    const grokStillRed = S.verifyInjection({ text: '⚠ MCP failed\n[Pasted Content 4686 chars]\n›' });
    await t.test('Grok Pasted Content 折叠仍然红', () => {
      assert.ok(grokStillRed.ok === false && grokStillRed.evidence === '[Pasted Content 4686 chars]', 'Grok Pasted Content 折叠仍然红  →  ' + JSON.stringify(grokStillRed));
    });

    const leftoverRework = S.leftoverDispatchMatch('【返工指令 · 闭环自动流转 · 第 1 轮】\n[Pasted Content 5711 chars]');
    await t.test('#633 leftoverDispatchMatch 认出框里返工指令', () => {
      assert.ok(leftoverRework === '【返工指令', '#633 leftoverDispatchMatch 认出返工  →  ' + leftoverRework);
    });
    const leftoverRecheck = S.leftoverDispatchMatch('【复核指令 · 闭环自动流转】');
    await t.test('#633 leftoverDispatchMatch 认出复核指令', () => {
      assert.ok(leftoverRecheck === '【复核指令', '#633 leftoverDispatchMatch 认出复核  →  ' + leftoverRecheck);
    });
    const leftoverGeneric = S.leftoverDispatchMatch('[Pasted Content 5711 chars]\n›');
    await t.test('#633 无返工/复核字的粘贴块不算残留派活', () => {
      assert.ok(leftoverGeneric === null, '#633 普通粘贴块不是残留派活  →  ' + leftoverGeneric);
    });

    // 2. verifyStartedPolling：只贴不发 → 立刻红；垫片没了，没有「补 enter → 绿」这条路。
    //    绿色唯一来源：真 transcript 证明（见上方 #661 块）或屏面稳定（agent 真在干活）。
    let fastReads = 0;
    const pollFast = S.verifyStartedPolling({
      dispatchId: 'ctx_poll_fast',
      readOnce: () => {
        fastReads += 1;
        return { ok: true, result: { terminal: { tail: ['[Pasted text #1 +86 lines]', '→ 短摘要：修命令库'] } } };
      },
      proofOnce: unproven,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('故意只贴不发：粘贴块 + follow-up → 首拍即红，pasteSubmitted:false', () => {
      assert.ok(pollFast.ok === false && pollFast.state === 'unsubmitted-paste' && fastReads === 1 && pollFast.pasteSubmitted === false, '故意只贴不发：粘贴块 + follow-up → 首拍即红  →  ' + JSON.stringify(pollFast));
    });

    // 绿样本（真在干活）：粘贴块从未出现在屏上，只有状态行。
    let recReads = 0;
    const pollRecover = S.verifyStartedPolling({
      dispatchId: 'ctx_poll_recover',
      readOnce: () => {
        recReads += 1;
        return { ok: true, result: { terminal: { tail: ['Running: reading files'] } } };
      },
      proofOnce: unavailable,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('绿样本：屏上没有未提交粘贴、状态行在干活 → 稳定轮判开工', () => {
      assert.ok(pollRecover.ok === true && pollRecover.state === 'started' && pollRecover.proofFallback === true, '绿样本：屏上没有未提交粘贴、在干活 → 稳定轮绿  →  ' + JSON.stringify(pollRecover));
    });

    const pollStuck = S.verifyStartedPolling({
      dispatchId: 'ctx_poll_stuck',
      readOnce: () => ({ ok: true, result: { terminal: { tail: ['[Pasted text #1 +86 lines]', '→ 短摘要：修命令库'] } } }),
      proofOnce: unproven,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('Cursor 未提交（无 sendEnter）→ 立刻报注入未提交，不等超时', () => {
      assert.ok(pollStuck.ok === false && pollStuck.state === 'unsubmitted-paste' && /注入未提交/.test(pollStuck.reason) && !/超时/.test(pollStuck.reason) && /Pasted text/.test(pollStuck.evidence), 'Cursor 未提交 → 立刻报注入未提交  →  ' + JSON.stringify(pollStuck));
    });

    const pollWork = S.verifyStartedPolling({
      dispatchId: 'ctx_poll_work',
      readOnce: () => ({ ok: true, result: { terminal: { tail: ['[Pasted text #1 +86 lines]', 'Running: reading scripts/lib/dao-cmd.mjs'] } } }),
      proofOnce: unavailable,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('Cursor 已提交 + 在干活 → 不报未提交，屏面稳定判开工', () => {
      assert.ok(pollWork.ok === true && pollWork.state === 'started' && pollWork.proofFallback === true, 'Cursor 已提交 + 在干活 → 屏面稳定判开工  →  ' + JSON.stringify(pollWork));
    });

    // Cursor 只贴不发 / 第二拍恢复的旧样本在上节已按 #661 重写（首拍即红 / 无粘贴才绿），
    // 这里只剩「只有粘贴块 → 红」与「follow-up 未发 → 红」两个补样。
    const pollAlone = S.verifyStartedPolling({
      dispatchId: 'ctx_poll_alone',
      readOnce: () => ({ ok: true, result: { terminal: { tail: ['[Pasted text #1 +86 lines]'] } } }),
      proofOnce: unproven,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('审红1：只有粘贴块 → 立刻红，不等超时', () => {
      assert.ok(pollAlone.ok === false && pollAlone.state === 'unsubmitted-paste' && /注入未提交/.test(pollAlone.reason) && !/超时/.test(pollAlone.reason), '审红1：只有粘贴块 → 立刻红  →  ' + JSON.stringify(pollAlone));
    });

    const pollWorkWord = S.verifyStartedPolling({
      dispatchId: 'ctx_poll_workword',
      readOnce: () => ({ ok: true, result: { terminal: { tail: ['[Pasted text #1 +86 lines]', '→ 短摘要：Reading Cursor 粘贴并提交'] } } }),
      proofOnce: unproven,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('审红2：follow-up 正文含 Reading → 屏轮询立刻红', () => {
      assert.ok(pollWorkWord.ok === false && pollWorkWord.state === 'unsubmitted-paste', '审红2：follow-up 正文含 Reading → 立刻红  →  ' + JSON.stringify(pollWorkWord));
    });
  });

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
    await t.test('#495 dao.mjs 派工成功后写任务卡 comment 定界区', () => {
      assert.ok(/afterDispatchComment/.test(daoSrc), '#495 dao.mjs 派工成功后写任务卡 comment 定界区');
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
      assert.ok(/probeWaitMs\(routing, workerLaunch\.provider\)/.test(daoSrc) && /function cmdReviewerCreate[\s\S]*probeWaitMs\(routing, reviewerLaunch\.provider\)/.test(daoSrc), '#559 waitAndVerify 超时按 provider 的 probe_wait_ms（不再 8s 硬编码）  →  waitAndVerify 要按 provider 覆盖 timeoutMs');
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
    const askZero = spawnSync(process.execPath, [CLI, 'ask', '--question', 'x', '--timeout-ms', '0'], { encoding: 'utf8', cwd: REPO });
    const askZeroJ = (() => { try { return JSON.parse(askZero.stdout || '{}'); } catch { return {}; } })();
    await t.test('#598 红项3：--timeout-ms 0 非零且不空转', () => {
      assert.ok(askZero.status !== 0 && /正整数/.test(String(askZeroJ.error || askZero.stderr || '')), '#598 红项3：--timeout-ms 0 非零且不空转  →  ' + JSON.stringify(askZeroJ));
    });
    const askNan = spawnSync(process.execPath, [CLI, 'ask', '--question', 'x', '--timeout-ms', 'nope'], { encoding: 'utf8', cwd: REPO });
    const askNanJ = (() => { try { return JSON.parse(askNan.stdout || '{}'); } catch { return {}; } })();
    await t.test('#598 红项3：--timeout-ms 非数字 非零', () => {
      assert.ok(askNan.status !== 0 && /正整数/.test(String(askNanJ.error || '')), '#598 红项3：--timeout-ms 非数字 非零  →  ' + JSON.stringify(askNanJ));
    });
    const askFrac = spawnSync(process.execPath, [CLI, 'ask', '--question', 'x', '--timeout-ms', '1.5'], { encoding: 'utf8', cwd: REPO });
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
    const inboxSrc = fs.readFileSync(path.join(REPO, 'scripts', 'inbox-station.mjs'), 'utf8');
    const ensureFn = inboxSrc.slice(inboxSrc.indexOf('async function cmdEnsure'), inboxSrc.indexOf('/// ══════════════════════════════════════════════════════════════════════\n// #637 可归档二次验证闸'));
    await t.test('#638+#601 cmdEnsure 只经 planEnsureLeaseStamp 盖 handle，绝不无条件 stamp coordinator/终端', () => {
      assert.ok(/planEnsureLeaseStamp/.test(ensureFn)
        && /if \(stampPlan\.stamp\)/.test(ensureFn)
        && /stampLeaseHandle\(logPath, stampPlan\.handle, 'rebuild'\)/.test(ensureFn)
        && !/stampLeaseHandle\(logPath, handle\)/.test(ensureFn)
        && !/stampLeaseHandle\(logPath, coordTerm/.test(ensureFn), 'cmdEnsure 仍无条件 stamp coordinator');
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
    const attachHelp = spawnSync(process.execPath, [CLI, 'reviewer-attach', '--help'], { encoding: 'utf8', cwd: REPO });
    await t.test('reviewer-attach 出现在 help', () => {
      assert.ok(/reviewer-attach/.test(attachHelp.stdout || ''), 'reviewer-attach 出现在 help  →  ' + (attachHelp.stdout || '').slice(0, 200));
    });
    const attachMiss = spawnSync(process.execPath, [CLI, 'reviewer-attach'], { encoding: 'utf8', cwd: REPO });
    const pAttach = (() => { try { return JSON.parse(attachMiss.stdout || '{}'); } catch { return {}; } })();
    await t.test('reviewer-attach 缺 --pr → 非零', () => {
      assert.ok(attachMiss.status !== 0 && /--pr/.test(String(pAttach.error || attachMiss.stderr || '')), 'reviewer-attach 缺 --pr → 非零  →  ' + JSON.stringify(pAttach));
    });
    const attachMissWt = spawnSync(process.execPath, [CLI, 'reviewer-attach', '--pr', '1'], { encoding: 'utf8', cwd: REPO });
    const pAttachWt = (() => { try { return JSON.parse(attachMissWt.stdout || '{}'); } catch { return {}; } })();
    await t.test('reviewer-attach 缺 --worktree → 非零', () => {
      assert.ok(attachMissWt.status !== 0 && /--worktree/.test(String(pAttachWt.error || attachMissWt.stderr || '')), 'reviewer-attach 缺 --worktree → 非零  →  ' + JSON.stringify(pAttachWt));
    });
    const attachMissRev = spawnSync(process.execPath, [CLI, 'reviewer-attach', '--pr', '1', '--worktree', 'w'], { encoding: 'utf8', cwd: REPO });
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
    await t.test('dao.mjs 起 agent 只在 launchAgentInWorktree 里 terminal create', () => {
      const createHits = [...src.matchAll(/argsTerminalCreate\(/g)];
      assert.ok(createHits.length === 1, 'dao.mjs 起 agent 只在 launchAgentInWorktree 里 terminal create  →  ' + createHits.length);
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
    const grokLaunch = S.resolveLaunch({ provider: 'grok', routing });
    const flash = S.resolveLaunch({ model: 'deepseek-v4-flash', routing });
    const gpt = S.resolveLaunch({ provider: 'gpt', routing });
    const claude = S.resolveLaunch({ provider: 'claude', routing });
    await t.test('认识的 agent：cursor / grok / pi / codex 有 id', () => {
      assert.ok(kimi.agentId === 'cursor' && grokLaunch.agentId === 'grok' && flash.agentId === 'pi' && gpt.agentId === 'codex',
        '认识的 agent：cursor / grok / pi / codex 有 id  →  ' + JSON.stringify({
          kimi: kimi.agentId, grok: grokLaunch.agentId, flash: flash.agentId, gpt: gpt.agentId,
        }));
    });
    await t.test('reclaude 不能映射成 --agent claude', () => {
      assert.ok(claude.agentId == null && /reclaude/.test(claude.command),
        'reclaude 不能映射成 --agent claude  →  ' + JSON.stringify({ agentId: claude.agentId, command: claude.command }));
    });
    const kimiSpec = S.agentStartSpec(kimi);
    const gptSpec = S.agentStartSpec(gpt);
    const grokSpec = S.agentStartSpec(grokLaunch);
    const claudeSpec = S.agentStartSpec(claude);
    await t.test('cursor / codex 走 worker-start --agent + --model', () => {
      assert.ok(kimiSpec.mode === 'agent' && kimiSpec.agentId === 'cursor' && kimiSpec.model === 'kimi-k3-high'
        && gptSpec.mode === 'agent' && gptSpec.agentId === 'codex',
        'cursor / codex 走 worker-start --agent + --model  →  ' + JSON.stringify({ kimiSpec, gptSpec }));
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
    await t.test('审官起动带 forceCommand（走 --command，不走 worker-start --agent）', () => {
      const launches = [...src.matchAll(/launchAgentInWorktree\(\{[\s\S]*?\}\)/g)].map(m => m[0]);
      const reviewer = launches.filter(s => /reviewerLaunch/.test(s));
      assert.ok(reviewer.length >= 2 && reviewer.every(s => /forceCommand:\s*true/.test(s)),
        '审官起动带 forceCommand  →  ' + reviewer.join('\n---\n'));
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

  it('#546 #541 审官树自证 / 注入后开工 / 环境自检', async (t) => {
    const S = await S_LOAD;
    const folded = S.verifyInjection({ text: '⚠ MCP failed\n[Pasted Content 4686 chars]\n›' });
    await t.test('故意违规：Pasted Content 折叠 → 注入验证红', () => {
      assert.ok(folded.ok === false && /Pasted Content/.test(folded.reason), '故意违规：Pasted Content 折叠 → 注入验证红  →  ' + JSON.stringify(folded));
    });
    await t.test('折叠证据带字符数', () => {
      assert.ok(folded.evidence === '[Pasted Content 4686 chars]', '折叠证据带字符数  →  ' + JSON.stringify(folded));
    });
    const unreadInj = S.verifyInjection({ readError: 'terminal_handle_stale' });
    await t.test('注入后没读成 ≠ 已开工', () => {
      assert.ok(unreadInj.ok === false && unreadInj.unscanned === true, '注入后没读成 ≠ 已开工  →  ' + JSON.stringify(unreadInj));
    });
    const emptyInj = S.verifyInjection({ text: '   ' });
    await t.test('注入后屏面空 → 红', () => {
      assert.ok(emptyInj.ok === false && /空/.test(emptyInj.reason), '注入后屏面空 → 红  →  ' + JSON.stringify(emptyInj));
    });
    const landed = S.verifyInjection({ text: '短摘要：修命令库\nThinking...\n' });
    await t.test('屏上无 Pasted Content → 注入验证绿', () => {
      assert.ok(landed.ok === true, '屏上无 Pasted Content → 注入验证绿  →  ' + JSON.stringify(landed));
    });

    // #559 ⑥：判开工优先 worker-read --source auto（官方可证明 transcript 源）
    const provenAuto = S.verifyWorkerStarted({ ok: true, result: { source: 'auto', transcript: { messages: [] } } });
    await t.test('#559 worker-read source=auto → 开工证明绿（官方 transcript 源）', () => {
      assert.ok(provenAuto.ok === true && provenAuto.proven === true, '#559 worker-read source=auto → 开工证明绿（官方 transcript 源）  →  ' + JSON.stringify(provenAuto));
    });
    const provenTranscript = S.verifyWorkerStarted({ ok: true, result: { source: 'transcript', transcript: { messages: [{ role: 'user', blocks: [] }] } } });
    await t.test('#559 worker-read source=transcript → 同样绿', () => {
      assert.ok(provenTranscript.ok === true && provenTranscript.proven === true, '#559 worker-read source=transcript → 同样绿  →  ' + JSON.stringify(provenTranscript));
    });
    const weakTerminal = S.verifyWorkerStarted({ ok: true, result: { source: 'terminal', fallbackReason: 'no_hook_report', terminal: { tail: [] } } });
    await t.test('#559 worker-read source=terminal → 降级（proven=false，带 fallbackReason）', () => {
      assert.ok(weakTerminal.ok === false && weakTerminal.proven === false && weakTerminal.fallbackReason === 'no_hook_report', '#559 worker-read source=terminal → 降级（proven=false，带 fallbackReason）  →  ' + JSON.stringify(weakTerminal));
    });
    const unreadProof = S.verifyWorkerStarted({ ok: false, error: { code: 'dispatch_not_found', message: 'x' } });
    await t.test('#559 worker-read 没读成 → unscanned（不许当成没开工）', () => {
      assert.ok(unreadProof.ok === false && unreadProof.unscanned === true, '#559 worker-read 没读成 → unscanned（不许当成没开工）  →  ' + JSON.stringify(unreadProof));
    });
    await t.test('#559 worker-read 已登记进 VERBS', () => {
      assert.ok(S.VERBS.includes('worker-read'), '#559 worker-read 已登记进 VERBS  →  ' + S.VERBS.join(','));
    });
    const wrRead = S.argsWorkerRead({ dispatch: 'ctx_x', source: 'auto', limit: 50 });
    await t.test('worker-read 拼 --dispatch/--source/--limit', () => {
      assert.ok(wrRead.includes('--source') && wrRead.includes('--limit'), 'worker-read 拼 --dispatch/--source/--limit  →  ' + wrRead.join(' '));
    });

    const filesUnscanned = S.verifyReviewerFiles({ reviewerPath: REPO });
    await t.test('#541 没给清单 = 没查成', () => {
      assert.ok(filesUnscanned.ok === false && filesUnscanned.unscanned === true, '#541 没给清单 = 没查成  →  ' + JSON.stringify(filesUnscanned));
    });
    const filesEmpty = S.verifyReviewerFiles({ reviewerPath: REPO, files: [] });
    await t.test('#541 空文件清单（PR 尚无改文件）→ 绿', () => {
      assert.ok(filesEmpty.ok === true && filesEmpty.checked === 0, '#541 空文件清单（PR 尚无改文件）→ 绿  →  ' + JSON.stringify(filesEmpty));
    });
    await t.test('#541 parseGhPullFiles 跳过 removed', () => {
      assert.ok(JSON.stringify(S.parseGhPullFiles([
        { filename: 'a.js', status: 'added' },
        { filename: 'gone.js', status: 'removed' },
      ])) === JSON.stringify(['a.js']), '#541 parseGhPullFiles 跳过 removed');
    });
    const filesOk = S.verifyReviewerFiles({ reviewerPath: REPO, files: ['scripts/dao.mjs', 'scripts/lib/dao-cmd.mjs'] });
    await t.test('#541 被审文件在 → 绿', () => {
      assert.ok(filesOk.ok === true && filesOk.checked === 2, '#541 被审文件在 → 绿  →  ' + JSON.stringify(filesOk));
    });
    const filesMiss = S.verifyReviewerFiles({ reviewerPath: REPO, files: ['scripts/dao.mjs', 'this-file-does-not-exist-541.js'] });
    await t.test('#541 缺被审文件 → 红并点名', () => {
      assert.ok(filesMiss.ok === false && (filesMiss.missing || []).includes('this-file-does-not-exist-541.js'), '#541 缺被审文件 → 红并点名  →  ' + JSON.stringify(filesMiss));
    });

    const parsed = S.parseDiffNameStatus('M\tscripts/dao.mjs\nA\thost/skills/dispatch/hooks/hooks.json\nD\told.txt\nR100\ta.txt\tb.txt\n');
    await t.test('name-status 收 A/M/R 新名、跳过 D', () => {
      assert.ok(parsed.includes('scripts/dao.mjs') && parsed.includes('host/skills/dispatch/hooks/hooks.json') && parsed.includes('b.txt') && !parsed.includes('old.txt'), 'name-status 收 A/M/R 新名、跳过 D  →  ' + JSON.stringify(parsed));
    });

    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-rev-a-'));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-rev-b-'));
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const gitIn = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
    gitIn(tmpA, ['init', '-q']);
    gitIn(tmpA, ['config', 'user.email', 't@t']);
    gitIn(tmpA, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(tmpA, 'f.txt'), 'a\n');
    gitIn(tmpA, ['add', 'f.txt']);
    gitIn(tmpA, ['commit', '-q', '-m', 'a']);
    gitIn(tmpB, ['init', '-q']);
    gitIn(tmpB, ['config', 'user.email', 't@t']);
    gitIn(tmpB, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(tmpB, 'f.txt'), 'b\n');
    gitIn(tmpB, ['add', 'f.txt']);
    gitIn(tmpB, ['commit', '-q', '-m', 'b']);
    const mismatch = S.verifyReviewerTree({ workerPath: tmpA, reviewerPath: tmpB });
    await t.test('#541 审官 HEAD ≠ 工人 HEAD → 红', () => {
      assert.ok(mismatch.ok === false && /审空气/.test(mismatch.error), '#541 审官 HEAD ≠ 工人 HEAD → 红  →  ' + JSON.stringify(mismatch));
    });
    const same = S.verifyReviewerTree({ workerPath: tmpA, reviewerPath: tmpA });
    await t.test('#541 两树 HEAD 相同 → 绿', () => {
      assert.ok(same.ok === true && same.reviewerHead === same.expectedOid, '#541 两树 HEAD 相同 → 绿  →  ' + JSON.stringify(same));
    });

    const missingDir = path.join(os.tmpdir(), `dao-env-missing-${Date.now()}`);
    const ro = S.envProbeWorktree(missingDir);
    await t.test('#546 故意让工作区不可写 → 环境自检红（写探针）', () => {
      assert.ok(ro.ok === false && (ro.failed || []).includes('write'), '#546 故意让工作区不可写 → 环境自检红（写探针）  →  ' + JSON.stringify(ro));
    });

    await t.test('#575 ⑦ MERGEABLE → 放行', () => {
      assert.ok(S.assessPrMergeable('MERGEABLE').ok === true, '#575 ⑦ MERGEABLE → 放行');
    });
    await t.test('#575 ⑦ CONFLICTING → 拒建树', () => {
      assert.ok(S.assessPrMergeable('CONFLICTING').ok === false && /rebase master/.test(S.assessPrMergeable('CONFLICTING').error), '#575 ⑦ CONFLICTING → 拒建树');
    });
    await t.test('#575 ⑦ UNKNOWN → 没查成，不是绿', () => {
      assert.ok(S.assessPrMergeable('UNKNOWN').ok === false && S.assessPrMergeable('UNKNOWN').unscanned === true, '#575 ⑦ UNKNOWN → 没查成，不是绿');
    });
    await t.test('#575 ⑦ 空值 → 没查成', () => {
      assert.ok(S.assessPrMergeable('').unscanned === true, '#575 ⑦ 空值 → 没查成');
    });
    await t.test('#575 ⑦ 不认识的值 → 没查成', () => {
      assert.ok(S.assessPrMergeable('DIRTY').unscanned === true, '#575 ⑦ 不认识的值 → 没查成');
    });

    const alignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-align-'));
    const originDir = path.join(alignRoot, 'origin');
    const workDir = path.join(alignRoot, 'work');
    fs.mkdirSync(originDir);
    const envGit = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: envGit });
    g(originDir, ['init', '-q', '-b', 'master']);
    g(originDir, ['config', 'user.email', 't@t']);
    g(originDir, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(originDir, 'a.txt'), 'a0\n');
    g(originDir, ['add', 'a.txt']);
    g(originDir, ['commit', '-q', '-m', 'base']);
    g(originDir, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(originDir, 'b.txt'), 'b\n');
    g(originDir, ['add', 'b.txt']);
    g(originDir, ['commit', '-q', '-m', 'feature']);
    g(originDir, ['checkout', '-q', 'master']);
    fs.writeFileSync(path.join(originDir, 'c.txt'), 'c\n');
    g(originDir, ['add', 'c.txt']);
    g(originDir, ['commit', '-q', '-m', 'master-ahead']);
    spawnSync('git', ['clone', '-q', '-b', 'feature', originDir, workDir], { encoding: 'utf8', env: envGit });
    g(workDir, ['config', 'user.email', 't@t']);
    g(workDir, ['config', 'user.name', 't']);
    const headBefore = String(g(workDir, ['rev-parse', 'HEAD']).stdout).trim();
    const alignOk = S.trialMergeMaster({ cwd: workDir });
    const headAfter = String(g(workDir, ['rev-parse', 'HEAD']).stdout).trim();
    const dirty = String(g(workDir, ['status', '--porcelain']).stdout).trim();
    await t.test('#575 ⑦ 试合无冲突：ok 且落后 ≥1', () => {
      assert.ok(alignOk.ok === true && alignOk.behind >= 1 && alignOk.conflict === false, '#575 ⑦ 试合无冲突：ok 且落后 ≥1  →  ' + JSON.stringify(alignOk));
    });
    const fakeFail = S.trialMergeMaster({
      cwd: workDir,
      runGit: (args) => {
        if (args[0] === 'merge' && args[1] !== '--abort') return { ok: false, error: 'Author identity unknown' };
        const { spawnSync } = require('child_process');
        const r = spawnSync('git', ['-C', workDir, ...args], { encoding: 'utf8' });
        if (r.error || (r.status !== 0 && r.status != null)) {
          return { ok: false, error: String(r.stderr || r.status) };
        }
        return { ok: true, out: String(r.stdout || '').trim() };
      },
    });
    await t.test('#575 ⑦ merge 非零但无 unmerged → 没查成，不是 conflict',
      () => {
        assert.ok(fakeFail.ok === false && fakeFail.unscanned === true && !fakeFail.conflict, '#575 ⑦ merge 非零但无 unmerged → 没查成，不是 conflict  →  ' + JSON.stringify(fakeFail));
      });
    await t.test('#575 ⑦ 试合后 HEAD 仍是 PR head', () => {
      assert.ok(headAfter === headBefore, '#575 ⑦ 试合后 HEAD 仍是 PR head  →  ' + `${headBefore} → ${headAfter}`);
    });
    await t.test('#575 ⑦ 试合后工作区干净', () => {
      assert.ok(dirty === '', '#575 ⑦ 试合后工作区干净  →  ' + dirty);
    });

    const clashDir = path.join(alignRoot, 'clash');
    g(originDir, ['checkout', '-q', 'feature']);
    fs.writeFileSync(path.join(originDir, 'a.txt'), 'feature-change\n');
    g(originDir, ['add', 'a.txt']);
    g(originDir, ['commit', '-q', '-m', 'feature-touch-a']);
    g(originDir, ['checkout', '-q', 'master']);
    fs.writeFileSync(path.join(originDir, 'a.txt'), 'master-change\n');
    g(originDir, ['add', 'a.txt']);
    g(originDir, ['commit', '-q', '-m', 'master-touch-a']);
    spawnSync('git', ['clone', '-q', '-b', 'feature', originDir, clashDir], { encoding: 'utf8', env: envGit });
    g(clashDir, ['config', 'user.email', 't@t']);
    g(clashDir, ['config', 'user.name', 't']);
    const clashHead = String(g(clashDir, ['rev-parse', 'HEAD']).stdout).trim();
    const alignClash = S.trialMergeMaster({ cwd: clashDir });
    const clashHeadAfter = String(g(clashDir, ['rev-parse', 'HEAD']).stdout).trim();
    const clashDirty = String(g(clashDir, ['status', '--porcelain']).stdout).trim();
    await t.test('#575 ⑦ 试合有冲突：conflict=true 且仍 ok（树已还原）', () => {
      assert.ok(alignClash.ok === true && alignClash.conflict === true, '#575 ⑦ 试合有冲突：conflict=true 且仍 ok（树已还原）  →  ' + JSON.stringify(alignClash));
    });
    await t.test('#575 ⑦ 冲突试合后 HEAD 不变', () => {
      assert.ok(clashHeadAfter === clashHead, '#575 ⑦ 冲突试合后 HEAD 不变');
    });
    await t.test('#575 ⑦ 冲突试合后工作区干净', () => {
      assert.ok(clashDirty === '', '#575 ⑦ 冲突试合后工作区干净  →  ' + clashDirty);
    });

    const daoSrcAlign = fs.readFileSync(CLI, 'utf8');
    await t.test('#575 ⑦ reviewer-create 建树前走 assessPrMergeable', () => {
      assert.ok(/function cmdReviewerCreate[\s\S]*assessPrMergeable/.test(daoSrcAlign), '#575 ⑦ reviewer-create 建树前走 assessPrMergeable');
    });
    await t.test('#575 ⑦ reviewer-attach 建树前走 assessPrMergeable', () => {
      assert.ok(/function cmdReviewerAttach[\s\S]*assessPrMergeable/.test(daoSrcAlign), '#575 ⑦ reviewer-attach 建树前走 assessPrMergeable');
    });
    await t.test('#575 ⑦ reviewer-create 建树后试合', () => {
      assert.ok(/function cmdReviewerCreate[\s\S]*trialMergeMaster/.test(daoSrcAlign), '#575 ⑦ reviewer-create 建树后试合');
    });

    const revHelp = spawnSync(process.execPath, [CLI, 'reviewer-create', '--help'], { encoding: 'utf8', cwd: REPO });
    await t.test('reviewer-create 出现在 help', () => {
      assert.ok(/reviewer-create/.test(revHelp.stdout || ''), 'reviewer-create 出现在 help  →  ' + (revHelp.stdout || '').slice(0, 200));
    });
    const revMiss = spawnSync(process.execPath, [CLI, 'reviewer-create', '--name', 'x'], { encoding: 'utf8', cwd: REPO });
    const pRevMiss = (() => { try { return JSON.parse(revMiss.stdout || '{}'); } catch { return {}; } })();
    await t.test('reviewer-create 缺 --pr → 非零', () => {
      assert.ok(revMiss.status !== 0 && /--pr/.test(String(pRevMiss.error || revMiss.stderr || '')), 'reviewer-create 缺 --pr → 非零  →  ' + JSON.stringify(pRevMiss));
    });
  });

  it('#546 追加第五件：士兵—审官闭环任务书模板', async (t) => {
    const S = await S_LOAD;
    const tmplDir = path.join(REPO, 'host', 'skills', 'dispatch', 'templates');
    const files = S.listDispatchTemplates();
    await t.test('模板目录有 soldier-book + reviewer-book + 两份 inject', () => {
      assert.ok(files.includes('soldier-book.md') && files.includes('reviewer-book.md') && files.includes('soldier-inject.md') && files.includes('reviewer-inject.md'), '模板目录有 soldier-book + reviewer-book + 两份 inject  →  ' + files.join(','));
    });

    const soldierBook = fs.readFileSync(path.join(tmplDir, 'soldier-book.md'), 'utf8');
    await t.test('soldier-book 不再内嵌审官 dispatch id（#586 按需起）', () => {
      assert.ok(!/REVIEWER_DISPATCH_ID/.test(soldierBook) && !/dispatch:undefined/.test(soldierBook), 'soldier-book 不再内嵌审官 dispatch id（#586 按需起）  →  ' + soldierBook.slice(-220));
    });
    await t.test('soldier-book 完工走 worker-done', () => {
      assert.ok(/worker-done/.test(soldierBook) && /--pr/.test(soldierBook), 'soldier-book 完工走 worker-done  →  ' + soldierBook.slice(-260));
    });
    await t.test('soldier-book 要求不要自己发 comment / notify', () => {
      assert.ok(/不要自己/.test(soldierBook), 'soldier-book 要求不要自己发 comment / notify');
    });

    const soldier = S.buildSoldierInject({ spec: '短摘要：修 X', issue: 602 });
    await t.test('士兵注入是单行且含 spec', () => {
      assert.ok(!/[\r\n]/.test(soldier) && /短摘要：修 X/.test(soldier), '士兵注入是单行且含 spec  →  ' + soldier);
    });
    await t.test('士兵注入含指针路径', () => {
      assert.ok(/host\/skills\/dispatch\/templates\/soldier-book\.md/.test(soldier), '士兵注入含指针路径  →  ' + soldier);
    });
    await t.test('主约束：士兵注入 ≤100 字节', () => {
      assert.ok(S.injectUtf8Bytes(soldier) <= 100, '主约束：士兵注入 ≤100 字节  →  ' + `bytes=${S.injectUtf8Bytes(soldier)} ${soldier}`);
    });

    const reviewer = S.buildReviewerInject({
      spec: '按审官任务书审 PR #1',
      pr: '1',
      soldierDispatchId: 'ctx_worker-1',
      mergePolicy: 'auto',
    });
    await t.test('审官注入是单行', () => {
      assert.ok(!/[\r\n]/.test(reviewer), '审官注入是单行  →  ' + reviewer);
    });
    await t.test('审官注入低于长度上限', () => {
      assert.ok(S.injectUtf8Bytes(reviewer) <= S.INJECT_MAX_BYTES, '审官注入低于长度上限  →  ' + `bytes=${S.injectUtf8Bytes(reviewer)} ${reviewer}`);
    });
    await t.test('审官注入填进士兵 dispatch id', () => {
      assert.ok(/ctx_worker-1/.test(reviewer), '审官注入填进士兵 dispatch id');
    });
    await t.test('审官注入填进 merge-policy', () => {
      assert.ok(/m=auto/.test(reviewer), '审官注入填进 merge-policy  →  ' + reviewer);
    });
    await t.test('审官注入红项目标是 dispatch:<id> 不是 handle', () => {
      assert.ok(/d=ctx_worker-1/.test(reviewer) && !/term_/.test(reviewer), '审官注入红项目标是 dispatch:<id> 不是 handle  →  ' + reviewer);
    });

    const reviewerBook = fs.readFileSync(path.join(tmplDir, 'reviewer-book.md'), 'utf8');
    await t.test('reviewer-book 要求红项发回士兵、乒乓两轮仍红才上帅', () => {
      assert.ok(/乒乓/.test(reviewerBook), 'reviewer-book 要求红项发回士兵、乒乓两轮仍红才上帅');
    });
    await t.test('reviewer-book 走 gh-as reviewer approve（#573）', () => {
      assert.ok(/gh-as\.mjs reviewer/.test(reviewerBook) && /--approve/.test(reviewerBook) && /真 approve/.test(reviewerBook), 'reviewer-book 走 gh-as reviewer approve（#573）  →  ' + reviewerBook.slice(0, 400));
    });
    await t.test('#625 reviewer-book 合并走 marshal squash，不依赖 GitHub --auto', () => {
      assert.ok(
        /gh-as\.mjs marshal -- pr merge <PR号> --squash --delete-branch/.test(reviewerBook)
          && !/pr merge <PR号> --auto/.test(reviewerBook)
          && !/服务端 auto-merge/.test(reviewerBook),
        '#625 reviewer-book 合并走 marshal squash，不依赖 GitHub --auto  →  ' + reviewerBook.slice(reviewerBook.indexOf('merge-policy: auto'), reviewerBook.indexOf('merge-policy: auto') + 280),
      );
    });
    const reviewerManual = S.buildReviewerInject({
      spec: '按审官任务书审 PR #1',
      pr: '1',
      soldierDispatchId: 'ctx_worker-1',
      mergePolicy: 'manual',
      mergeReason: '改协作约定',
    });
    await t.test('审官注入 manual 带 merge-reason', () => {
      assert.ok(/r=改协作约定/.test(reviewerManual) && !/[\r\n]/.test(reviewerManual), '审官注入 manual 带 merge-reason  →  ' + reviewerManual);
    });
    await t.test('reviewer-book manual 模式含转 draft 机器落点（#498/#559）', () => {
      assert.ok(/--undo/.test(reviewerBook) && /pr ready/.test(reviewerBook) && /gh-as\.mjs reviewer/.test(reviewerBook), 'reviewer-book manual 模式含转 draft 机器落点（#498/#559）  →  ' + reviewerBook.slice(-400));
    });

    let threw = false, threwMsg = '';
    try { S.buildReviewerInject({ spec: 'x', pr: '1', mergePolicy: 'auto' }); }
    catch (e) { threw = true; threwMsg = String(e.message || e); }
    await t.test('缺占位符值 → 抛', () => {
      assert.ok(threw && /SOLDIER_DISPATCH_ID/.test(threwMsg), '缺占位符值 → 抛  →  ' + threwMsg);
    });

    let threwU = false, uMsg = '';
    try { S.buildReviewerInject({ spec: 'x', pr: '1', soldierDispatchId: String(undefined), mergePolicy: 'auto' }); }
    catch (e) { threwU = true; uMsg = String(e.message || e); }
    await t.test('审官红项回归：dispatch id 缺失（"undefined" 字符串）→ 渲染抛错变红', () => {
      assert.ok(threwU && /SOLDIER_DISPATCH_ID/.test(uMsg) && /dispatch:undefined|无效值/.test(uMsg), '审官红项回归：dispatch id 缺失（"undefined" 字符串）→ 渲染抛错变红  →  ' + uMsg);
    });
    let threwN = false;
    try { S.buildReviewerInject({ spec: 'x', pr: '1', soldierDispatchId: 'null', mergePolicy: 'auto' }); }
    catch (e) { threwN = true; }
    await t.test('审官红项回归：占位符填字面量 null 也抛', () => {
      assert.ok(threwN, '审官红项回归：占位符填字面量 null 也抛');
    });

    const multi = S.buildSoldierInject({ spec: '短摘要\n第二行' });
    await t.test('spec 自带换行：注入渲染不炸，grok 发送前才转码', () => {
      assert.ok(/\n/.test(multi) && S.encodeSendText(multi, 'grok').includes('\x1b\r') && !S.encodeSendText(multi, 'grok').includes('\n'), 'spec 自带换行：注入渲染不炸，grok 发送前才转码');
    });

    let notFound = false;
    try { S.renderDispatchTemplate('no-such-template.md', {}); }
    catch (e) { notFound = true; }
    await t.test('模板文件不在 → 抛（不静默空模板）', () => {
      assert.ok(notFound, '模板文件不在 → 抛（不静默空模板）');
    });

    const badName = (() => { try { S.readDispatchTemplate('..\evil.md'); return false; } catch { return true; } })();
    await t.test('模板名不合法 → 拒绝', () => {
      assert.ok(badName, '模板名不合法 → 拒绝');
    });

    const daoSrc = fs.readFileSync(CLI, 'utf8');
    await t.test('dao.mjs 士兵任务书走短注入（buildSoldierInject）', () => {
      assert.ok(/buildSoldierInject/.test(daoSrc), 'dao.mjs 士兵任务书走短注入（buildSoldierInject）');
    });
    await t.test('dao.mjs 士兵 spec 不再是裸 args.spec（闭环包装）', () => {
      assert.ok(/soldierBook/.test(daoSrc) && !/REVIEWER_DISPATCH_ID/.test(daoSrc), 'dao.mjs 士兵 spec 不再是裸 args.spec（闭环包装）  →  REVIEWER_DISPATCH_ID 已从 dao.mjs 移除');
    });
    await t.test('dao.mjs 审官由 reviewer-create 起终端 + worker-start（dispatch 不再起）',
      () => {
        assert.ok(/function cmdReviewerCreate[\s\S]*reviewerTaskId/.test(daoSrc) && /function cmdReviewerCreate[\s\S]*revStarted/.test(daoSrc)
        && /function cmdDispatch[\s\S]*reviewerDeferred: true/.test(daoSrc), 'dao.mjs 审官由 reviewer-create 起终端 + worker-start（dispatch 不再起）');
      });
    await t.test('dao.mjs 审官注入后也验开工（reviewerInject）', () => {
      assert.ok(/reviewerInject/.test(daoSrc), 'dao.mjs 审官注入后也验开工（reviewerInject）');
    });
    await t.test('dao.mjs 从 worker-start 返回取 dispatch id（extractDispatchId）', () => {
      assert.ok(/extractDispatchId/.test(daoSrc), 'dao.mjs 从 worker-start 返回取 dispatch id（extractDispatchId）');
    });
    await t.test('dao.mjs dispatch 完工走 worker-done（不再预填 soldierDoneTo）', () => {
      assert.ok(/soldierDoneVia: 'worker-done'/.test(daoSrc) && /reviewerDeferred: true/.test(daoSrc), 'dao.mjs dispatch 完工走 worker-done（不再预填 soldierDoneTo）');
    });
    await t.test('审官红项修正：审官任务书在 reviewer-create 里用士兵真 id 渲染', () => {
      assert.ok(/function cmdReviewerCreate[\s\S]*soldierDispatchId: String\(soldierDispatchId\)/.test(daoSrc), '审官红项修正：审官任务书在 reviewer-create 里用士兵真 id 渲染  →  渲染落点检查');
    });
    await t.test('审官红项修正：审官身份消息发进士兵收件箱（四关确认）', () => {
      assert.ok(/审官身份/.test(daoSrc) && /identity/.test(daoSrc), '审官红项修正：审官身份消息发进士兵收件箱（四关确认）');
    });
  });
  it('⑨ 闭环三跳：投递失败必须炸，不许静默（#548 红项 1）', async (t) => {
    const S = await S_LOAD;
    // 判别性：同一套判据，活收件人必须放行、死收件人必须拦下。只会拦不会放的守卫等于天天假红。
    const LIVE = 'term_live-0001';
    const DEAD = 'term_00000000-0000-0000-0000-000000000000';
    const LIVE_RUN = 'run_live0001';
    const DEAD_RUN = 'run_00000000';
    const LIVE_DISPATCH = 'ctx_live-0001';
    const DEAD_DISPATCH = 'ctx_00000000-0000-0000-0000-000000000000';
    const DONE_DISPATCH = 'ctx_done-0001';

    // 假 orca：照抄真实返回形状——send 对死 handle 一样 ok:true / delivered_at:null。
    function fakeOrca({ inboxDrops = false, inboxBroken = false, sentMissingId = false, misroute = null } = {}) {
      let seq = 0;
      const sent = [];
      const fn = (a) => {
        const key = `${a[0]} ${a[1]}`;
        if (key === 'terminal read') {
          const h = a[a.indexOf('--terminal') + 1];
          if (h === LIVE) return { ok: true, json: { ok: true, result: { terminal: { handle: h, status: 'running' } } } };
          return { ok: false, error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' } };
        }
        if (key === 'orchestration run-show') {
          const id = a[a.indexOf('--id') + 1];
          if (id === LIVE_RUN) return { ok: true, json: { ok: true, result: { run: { id } } } };
          return { ok: false, error: { code: 'run_not_found', message: `Run ${id} was not found.` } };
        }
        if (key === 'orchestration run-current') {
          return { ok: true, json: { ok: true, result: { run: null } } };
        }
        if (key === 'orchestration worker-show') {
          const d = a[a.indexOf('--dispatch') + 1];
          if (d === LIVE_DISPATCH) {
            return { ok: true, json: { ok: true, result: { dispatch: { id: d, status: 'dispatched', assignee_handle: 'term_live-0001' }, worker: { state: 'ready' } } } };
          }
          if (d === DONE_DISPATCH) {
            return { ok: true, json: { ok: true, result: { dispatch: { id: d, status: 'completed' }, worker: { state: 'succeeded' } } } };
          }
          return { ok: false, error: { code: 'dispatch_not_found', message: `Worker Dispatch ${d} was not found.` } };
        }
        if (key === 'orchestration send') {
          const to = a.includes('--to') ? a[a.indexOf('--to') + 1] : null;
          const id = `msg_fake${++seq}`;
          const m = { id, to_handle: misroute || to, delivered_at: null };
          if (!inboxDrops) sent.push(m);
          if (sentMissingId) return { ok: true, json: { ok: true, result: { mutation: {} } } };
          return { ok: true, json: { ok: true, result: { message: m } } };
        }
        if (key === 'orchestration inbox') {
          if (inboxBroken) return { ok: true, json: { ok: true, result: {} } };
          return { ok: true, json: { ok: true, result: { messages: sent.slice().reverse() } } };
        }
        throw new Error(`假 orca 没登记这条命令: ${a.join(' ')}`);
      };
      return fn;
    }

    const HOPS = [
      { hop: '士兵→审官', live: { to: LIVE }, dead: { to: DEAD } },
      { hop: '审官→士兵', live: { to: LIVE }, dead: { to: DEAD } },
      // 审官→帅 是普通告知，不带 --type worker_done：notify 验投递不验结算（#551）
      { hop: '审官→帅', live: { to: `run:${LIVE_RUN}` }, dead: { to: `run:${DEAD_RUN}` } },
      // #559 ①：士兵↔审官互发走 dispatch:<id>（结构化收件箱）不是 terminal handle
      { hop: '士兵→审官(dispatch)', live: { to: `dispatch:${LIVE_DISPATCH}` }, dead: { to: `dispatch:${DEAD_DISPATCH}` } },
      { hop: '审官→士兵(dispatch)', live: { to: `dispatch:${LIVE_DISPATCH}` }, dead: { to: `dispatch:${DEAD_DISPATCH}` } },
    ];
    for (const h of HOPS) {
      const good = S.deliverMessage({ ...h.live, subject: '完工', hop: h.hop, orca: fakeOrca() });
      await t.test(`${h.hop}：收件人在 → 放行并给消息 id`, () => {
        assert.ok(good.ok === true && /^msg_/.test(good.messageId || ''), `${h.hop}：收件人在 → 放行并给消息 id  →  ` + JSON.stringify(good));
      });
      const bad = S.deliverMessage({ ...h.dead, subject: '完工', hop: h.hop, orca: fakeOrca() });
      await t.test(`${h.hop}：故意错 handle → 拦下`, () => {
        assert.ok(bad.ok === false && bad.stage === '收件人', `${h.hop}：故意错 handle → 拦下  →  ` + JSON.stringify(bad));
      });
      await t.test(`${h.hop}：错 handle 的报错说得出「不存在」`, () => {
        assert.ok(bad.ok === false && /不存在/.test(bad.error), `${h.hop}：错 handle 的报错说得出「不存在」  →  ` + bad.error);
      });
    }

    const dropped = S.deliverMessage({ to: LIVE, subject: 'x', orca: fakeOrca({ inboxDrops: true }) });
    await t.test('回执给了 id 但编排里查不到 → 拦下', () => {
      assert.ok(dropped.ok === false && dropped.stage === '复核', '回执给了 id 但编排里查不到 → 拦下  →  ' + JSON.stringify(dropped));
    });

    const unscanned = S.deliverMessage({ to: LIVE, subject: 'x', orca: fakeOrca({ inboxBroken: true }) });
    await t.test('复核一条样本都没扫到 → 标 unscanned 且非 ok（没查成 ≠ 查过没事）', () => {
      assert.ok(unscanned.ok === false && unscanned.unscanned === true, '复核一条样本都没扫到 → 标 unscanned 且非 ok（没查成 ≠ 查过没事）  →  ' + JSON.stringify(unscanned));
    });

    const noReceipt = S.deliverMessage({ to: LIVE, subject: 'x', orca: fakeOrca({ sentMissingId: true }) });
    await t.test('send 说成功却没回执 → 拦下', () => {
      assert.ok(noReceipt.ok === false && noReceipt.stage === '回执', 'send 说成功却没回执 → 拦下  →  ' + JSON.stringify(noReceipt));
    });

    const wrong = S.deliverMessage({ to: LIVE, subject: 'x', orca: fakeOrca({ misroute: 'term_someone-else' }) });
    await t.test('回执收件人与请求不一致（错投）→ 拦下', () => {
      assert.ok(wrong.ok === false && /错投/.test(wrong.error), '回执收件人与请求不一致（错投）→ 拦下  →  ' + JSON.stringify(wrong));
    });

    const noRun = S.deliverMessage({ subject: 'x', orca: fakeOrca() });
    await t.test('省略收件人但没绑 Run → 拦下（发进真空）', () => {
      assert.ok(noRun.ok === false && /真空/.test(noRun.error), '省略收件人但没绑 Run → 拦下（发进真空）  →  ' + JSON.stringify(noRun));
    });

    const badDispatchForm = S.classifyNotifyTarget('dispatch_ctx-x');
    await t.test('dispatch_xxx 不带冒号 → 不收（只收 dispatch:）', () => {
      assert.ok(badDispatchForm.kind === 'unsupported', 'dispatch_xxx 不带冒号 → 不收（只收 dispatch:）  →  ' + JSON.stringify(badDispatchForm));
    });
    const okDispatchForm = S.classifyNotifyTarget('dispatch:ctx_x');
    await t.test('dispatch:<id> 形态被认', () => {
      assert.ok(okDispatchForm.kind === 'dispatch' && okDispatchForm.id === 'ctx_x', 'dispatch:<id> 形态被认  →  ' + JSON.stringify(okDispatchForm));
    });

    await t.test('ready/working/waiting 算活人', () => {
      assert.ok(S.isLiveDispatchRecipient({ workerState: 'ready' })
        && S.isLiveDispatchRecipient({ workerState: 'working' })
        && S.isLiveDispatchRecipient({ workerState: 'waiting' }),
        'ready/working/waiting 算活人');
    });
    await t.test('completed/succeeded/failed 不算活人', () => {
      assert.ok(!S.isLiveDispatchRecipient({ workerState: 'succeeded', dispatchStatus: 'completed' })
        && !S.isLiveDispatchRecipient({ workerState: 'failed' })
        && !S.isLiveDispatchRecipient({ dispatchStatus: 'completed' }),
        'completed/succeeded/failed 不算活人');
    });
    const doneProbe = S.probeRecipient({ kind: 'dispatch', id: DONE_DISPATCH }, fakeOrca());
    await t.test('probeRecipient 已完工 dispatch → 非零，并写人走了才新开', () => {
      assert.ok(doneProbe.ok === false && /已完工/.test(doneProbe.error)
        && /#677/.test(doneProbe.error) && /新开工人/.test(doneProbe.error)
        && !/新 task/.test(doneProbe.error),
        'probeRecipient 已完工 dispatch → 非零  →  ' + JSON.stringify(doneProbe));
    });
    const doneSendOther = S.deliverMessage({
      to: `dispatch:${DONE_DISPATCH}`,
      subject: '红项',
      hop: '士兵→审官(dispatch)',
      orca: fakeOrca(),
    });
    await t.test('非审官→士兵 hop 已完工 dispatch → 非零，禁止当送达', () => {
      assert.ok(doneSendOther.ok === false && doneSendOther.stage === '收件人' && /已完工/.test(doneSendOther.error),
        '非审官→士兵 hop 已完工 dispatch → 非零  →  ' + JSON.stringify(doneSendOther));
    });
    const doneSendHop = S.deliverMessage({
      to: `dispatch:${DONE_DISPATCH}`,
      subject: '红项',
      hop: '审官→士兵(dispatch)',
      orca: fakeOrca(),
    });
    await t.test('#677 审官→士兵 已完工 → 失败，不开下一跳', () => {
      assert.ok(doneSendHop.ok === false && doneSendHop.stage === '收件人'
        && /士兵已下班/.test(doneSendHop.error) && /#677/.test(doneSendHop.error)
        && /不要开下一跳/.test(doneSendHop.error),
        '#677 审官→士兵 已完工不开下一跳  →  ' + JSON.stringify(doneSendHop));
    });

    const wsFx = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'orca-json', 'worker-show.json'), 'utf8'));
    await t.test('真语料 worker-show → extractDispatchId 取 result.dispatch.id', () => {
      assert.ok(S.extractDispatchId(wsFx) === 'ctx_5a59f2b680ca', '真语料 worker-show → extractDispatchId 取 result.dispatch.id  →  ' + JSON.stringify(S.extractDispatchId(wsFx)));
    });
    await t.test('extractDispatchId 认 worker-start 的 result.dispatchId（CLI 源码形态）', () => {
      assert.ok(S.extractDispatchId({ result: { dispatchId: 'ctx_abc' } }) === 'ctx_abc', 'extractDispatchId 认 worker-start 的 result.dispatchId（CLI 源码形态）');
    });
    await t.test('extractDispatchId 认 worker.dispatch_id', () => {
      assert.ok(S.extractDispatchId({ result: { worker: { dispatch_id: 'ctx_def' } } }) === 'ctx_def', 'extractDispatchId 认 worker.dispatch_id');
    });
    await t.test('extractDispatchId 不认 RPC 顶层 id', () => {
      assert.ok(S.extractDispatchId({ id: 'rpc-123', result: {} }) === null, 'extractDispatchId 不认 RPC 顶层 id');
    });

    const group = S.deliverMessage({ to: '@all', subject: 'x', orca: fakeOrca() });
    await t.test('组播收件人 → 拒发（没人负责签收）', () => {
      assert.ok(group.ok === false && /组播/.test(group.error), '组播收件人 → 拒发（没人负责签收）  →  ' + JSON.stringify(group));
    });

    const noSubject = S.deliverMessage({ to: LIVE, orca: fakeOrca() });
    await t.test('缺 subject → 拦下', () => {
      assert.ok(noSubject.ok === false && noSubject.stage === '参数', '缺 subject → 拦下  →  ' + JSON.stringify(noSubject));
    });

    const reworkFourGate = S.completeWorkerDoneNotify({
      round: 'rework',
      pr: '592',
      comment: '返工完成：PR #592\n\n已修红项',
      reviewerDispatchId: LIVE_DISPATCH,
      deliver: S.deliverMessage,
      orca: fakeOrca(),
    });
    await t.test('#586 返工走四关投递 notified.ok===true',
      () => {
        assert.ok(reworkFourGate.ok === true && reworkFourGate.notified && reworkFourGate.notified.ok === true
        && /^msg_/.test(reworkFourGate.notified.messageId || ''),
        '#586 返工走四关投递 notified.ok===true  →  ' + JSON.stringify(reworkFourGate));
      });

    // delivered_at 不是判据：真语料里活收件人也是 null，当门就是每条都假红。
    const fx = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'orca-json', 'orchestration-send.json'), 'utf8'));
    await t.test('真语料：send 对活收件人 delivered_at 也是 null', () => {
      assert.ok(fx.ok === true && fx.result.message.delivered_at === null, '真语料：send 对活收件人 delivered_at 也是 null  →  ' + JSON.stringify(fx.result?.message?.delivered_at));
    });
    const libSrc = fs.readFileSync(LIB, 'utf8');
    await t.test('deliverMessage 不拿 delivered_at 当门（只报出）', () => {
      assert.ok(!/delivered_at[^\n]*\?\s*[^:]*:\s*\{\s*ok:\s*false/.test(libSrc) && /deliveredAt: found\.message/.test(libSrc), 'deliverMessage 不拿 delivered_at 当门（只报出）');
    });

    // CLI 接线：动词登记 + 失败非零
    await t.test('notify 已登记进 VERBS', () => {
      assert.ok(S.VERBS.includes('notify'), 'notify 已登记进 VERBS  →  ' + S.VERBS.join(','));
    });
    const cliBad = spawnSync(process.execPath, [CLI, 'notify', '--to', DEAD, '--subject', '回归样本'], { encoding: 'utf8', cwd: REPO });
    await t.test('CLI notify 故意错 handle → 非零退出', () => {
      assert.ok(cliBad.status !== 0, 'CLI notify 故意错 handle → 非零退出  →  ' + `status=${cliBad.status} ${cliBad.stdout}`);
    });
    await t.test('CLI notify 失败时 stderr 明说链断', () => {
      assert.ok(/链断/.test(cliBad.stderr || ''), 'CLI notify 失败时 stderr 明说链断  →  ' + cliBad.stderr);
    });

    const tmplSoldier = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'templates', 'soldier-book.md'), 'utf8');
    const tmplReviewer = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'templates', 'reviewer-book.md'), 'utf8');
    await t.test('士兵任务书问帅走 dao.mjs ask，并写 ASK_TIMEOUT', () => {
      assert.ok(/dao\.mjs ask/.test(tmplSoldier) && /ASK_TIMEOUT/.test(tmplSoldier) && /run-current/.test(tmplSoldier), '士兵任务书问帅走 dao.mjs ask，并写 ASK_TIMEOUT');
    });
    await t.test('审官上报不用 run-current 当地址', () => {
      assert.ok(/不要用 `run-current`/.test(tmplReviewer) && /worker-show/.test(tmplReviewer), '审官上报不用 run-current 当地址');
    });
    await t.test('士兵任务书完工走 dao.mjs worker-done（不是裸 orca send）', () => {
      assert.ok(/dao\.mjs worker-done/.test(tmplSoldier) && !/^\s*orca orchestration send/m.test(tmplSoldier), '士兵任务书完工走 dao.mjs worker-done（不是裸 orca send）  →  ' + tmplSoldier.slice(0, 200));
    });
    await t.test('审官任务书发信走 dao.mjs notify（不是裸 orca send）', () => {
      assert.ok(/dao\.mjs notify/.test(tmplReviewer) && !/^\s*orca orchestration send/m.test(tmplReviewer), '审官任务书发信走 dao.mjs notify（不是裸 orca send）  →  ' + tmplReviewer.slice(0, 200));
    });
    await t.test('两份任务书都写明「确认送达才准进下一步」', () => {
      assert.ok(/确认送达/.test(tmplSoldier) && /确认送达/.test(tmplReviewer), '两份任务书都写明「确认送达才准进下一步」');
    });

    // 审官「可归档」仍是普通告知；结算另走 worker_done（#551）
    const archiveBlock = tmplReviewer.slice(tmplReviewer.indexOf('### 3. 收尾'));
    const marshalNotify = archiveBlock.match(/notify --hop "审官→帅"[\s\S]{0,280}?--body[^\n]*/);
    await t.test('审官「可归档」notify 不带 --type worker_done（那是投递给帅）', () => {
      assert.ok(marshalNotify && /--to run:/.test(marshalNotify[0]) && !/--type worker_done/.test(marshalNotify[0]),
        '审官「可归档」notify 不带 --type worker_done（那是投递给帅）  →  ' + (marshalNotify && marshalNotify[0]));
    });
    await t.test('审官结算走 notify --type worker_done 且带 task-id/dispatch-id', () => {
      assert.ok(/--type worker_done/.test(archiveBlock) && /--task-id/.test(archiveBlock) && /--dispatch-id/.test(archiveBlock)
        && /未结算/.test(archiveBlock) && /#551/.test(archiveBlock),
        '审官结算走 notify --type worker_done 且带 task-id/dispatch-id  →  ' + archiveBlock.slice(0, 400));
    });
    await t.test('审官任务书写明红项后也结算，复审靠新 Dispatch（#552）', () => {
      assert.ok(/inspect-only/.test(archiveBlock) && /worker-start --terminal/.test(archiveBlock) && /#552/.test(archiveBlock),
        '审官任务书写明红项后也结算，复审靠新 Dispatch（#552）');
    });
    await t.test('#675 审官任务书红项只跑 notify，不自己拼 task-create', () => {
      assert.ok(/不要自己拼/.test(tmplReviewer) && /task-create/.test(tmplReviewer) && /不要开下一跳/.test(tmplReviewer),
        '#675 审官任务书红项只跑 notify，不自己拼 task-create');
    });
    await t.test('#677 士兵任务书：交卷后身份继续活，判定绿才结算', () => {
      assert.ok(/不要立刻/.test(tmplSoldier) && /判定绿/.test(tmplSoldier)
        && /还活着/.test(tmplSoldier) && /#677/.test(tmplSoldier)
        && !/新 Task 注入本终端/.test(tmplSoldier),
        '#677 士兵任务书交卷不立刻结算  →  ' + tmplSoldier.slice(tmplSoldier.indexOf('不要立刻'), tmplSoldier.indexOf('不要立刻') + 180));
    });
    await t.test('#677 全局约定与派工手册不得再教交卷即下班', () => {
      const global = fs.readFileSync(path.join(REPO, 'docs', 'global-CLAUDE.md'), 'utf8');
      const skill = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'SKILL.md'), 'utf8');
      const banned = /发完完工报告就不再收信箱/;
      assert.ok(!banned.test(global) && !banned.test(skill)
        && /判定绿/.test(global) && /判定绿/.test(skill) && /#677/.test(global) && /#677/.test(skill),
        '#677 常驻约定与 SKILL 同一口径  →  global=' + global.includes('判定绿') + ' skill=' + skill.includes('判定绿'));
    });
    await t.test('notify 文档：普通投递 ≠ 结算；worker_done 才核 completed', () => {
      assert.ok(/投递\*\*不是\*\*结算|普通 notify 验的是\*\*投递\*\*不是\*\*结算/.test(S.USAGE)
        && /未结算/.test(S.USAGE) && /#551/.test(S.USAGE),
        'notify 文档：普通投递 ≠ 结算；worker_done 才核 completed  →  ' + S.USAGE.slice(-500));
    });
    await t.test('deliverMessage 注释点明普通 ok:true ≠ 结算，worker_done 核 completed', () => {
      assert.ok(/不是结算/.test(libSrc) && /未结算/.test(libSrc) && /#551/.test(libSrc) && /completed/.test(libSrc),
        'deliverMessage 注释点明普通 ok:true ≠ 结算，worker_done 核 completed');
    });
  });

  it('#677 红项打进活身份：waiting 能送达；已完工 fail-visible 不开下一跳', async (t) => {
    const S = await S_LOAD;
    const LIVE = 'ctx_live-hop-1';
    const DONE = 'ctx_done-hop-1';
    const LIVE_TERM = 'term_live-0001';
    const RUN = 'run_live0001';

    function hopOrca({ dispatchId = LIVE, workerState = 'waiting', dispatchStatus = 'dispatched', showBroken = false } = {}) {
      const calls = [];
      const sent = [];
      let seq = 0;
      const fn = (a) => {
        calls.push(a.slice());
        const key = `${a[0]} ${a[1]}`;
        if (key === 'orchestration worker-show') {
          if (showBroken) return { ok: false, error: { code: 'timeout', message: 'worker-show timeout' } };
          const d = a[a.indexOf('--dispatch') + 1];
          if (d !== dispatchId) {
            return { ok: false, error: { code: 'dispatch_not_found', message: `Worker Dispatch ${d} was not found.` } };
          }
          return {
            ok: true,
            json: {
              ok: true,
              result: {
                dispatch: { id: d, status: dispatchStatus, assignee_handle: LIVE_TERM, run_id: RUN },
                worker: { state: workerState, agent_terminal_handle: LIVE_TERM },
              },
            },
          };
        }
        if (key === 'orchestration worker-list') {
          return { ok: false, error: { code: 'boom', message: 'worker-list down' } };
        }
        if (key === 'orchestration task-create' || key === 'orchestration worker-start') {
          throw new Error(`#677 不许开下一跳: ${a.join(' ')}`);
        }
        if (key === 'orchestration send') {
          const to = a.includes('--to') ? a[a.indexOf('--to') + 1] : null;
          const id = `msg_hop${++seq}`;
          const m = { id, to_handle: to, to_dispatch: to && String(to).startsWith('dispatch:') ? String(to).slice('dispatch:'.length) : null, delivered_at: null };
          sent.push(m);
          return { ok: true, json: { ok: true, result: { message: m } } };
        }
        if (key === 'orchestration inbox') {
          return { ok: true, json: { ok: true, result: { messages: sent.slice().reverse() } } };
        }
        throw new Error(`假 orca 没登记这条命令: ${a.join(' ')}`);
      };
      fn.calls = calls;
      fn.sent = sent;
      return fn;
    }

    const liveIo = hopOrca({ workerState: 'waiting' });
    const delivered = S.deliverMessage({
      to: `dispatch:${LIVE}`,
      subject: '红项：2 条',
      body: '位置+问题+期望',
      hop: '审官→士兵',
      orca: liveIo,
    });
    await t.test('正样本：waiting Dispatch 收到红项', () => {
      assert.ok(delivered.ok === true && /^msg_/.test(delivered.messageId || ''),
        'waiting 能送达  →  ' + JSON.stringify(delivered));
    });
    await t.test('正样本：红项打进这个活 id，不开 task-create', () => {
      const tos = liveIo.sent.map((m) => m.to_handle || m.to_dispatch);
      assert.ok(tos.some((x) => x === `dispatch:${LIVE}` || x === LIVE), '活 id 有信  →  ' + JSON.stringify(tos));
      assert.ok(!liveIo.calls.some((c) => c[1] === 'task-create' || c[1] === 'worker-start'),
        '不开下一跳  →  ' + JSON.stringify(liveIo.calls.map((c) => c.slice(0, 2))));
    });

    const readyIo = hopOrca({ workerState: 'ready' });
    const ready = S.deliverMessage({
      to: `dispatch:${LIVE}`,
      subject: '红项：1 条',
      hop: '审官→士兵',
      orca: readyIo,
    });
    await t.test('正样本：ready Dispatch 也能收到红项', () => {
      assert.ok(ready.ok === true && /^msg_/.test(ready.messageId || ''),
        'ready 能送达  →  ' + JSON.stringify(ready));
    });

    const deadIo = hopOrca({ dispatchId: DONE, workerState: 'succeeded', dispatchStatus: 'completed' });
    const dead = S.deliverMessage({
      to: `dispatch:${DONE}`,
      subject: '红项：1 条',
      hop: '审官→士兵',
      orca: deadIo,
    });
    await t.test('负样本：已完工 → 非零，报士兵已下班，不开下一跳', () => {
      assert.ok(dead.ok === false && /士兵已下班/.test(dead.error) && /#677/.test(dead.error)
        && !deadIo.calls.some((c) => c[1] === 'task-create'),
        '已完工不开下一跳  →  ' + JSON.stringify({ dead, calls: deadIo.calls.map((c) => c.slice(0, 2)) }));
    });

    const missIo = hopOrca({ showBroken: true });
    const unscanned = S.deliverMessage({
      to: `dispatch:${LIVE}`,
      subject: '红项',
      hop: '审官→士兵',
      orca: missIo,
    });
    await t.test('worker-show 没查成 → unscanned，不开下一跳', () => {
      assert.ok(unscanned.ok === false && unscanned.unscanned === true
        && !missIo.calls.some((c) => c[1] === 'task-create'),
        '没查成 ≠ 已完工  →  ' + JSON.stringify(unscanned));
    });

    await t.test('USAGE：worker-done 不结算；notify 不开下一跳', () => {
      assert.ok(/#677：成功路径不结算/.test(S.USAGE) && /不开下一跳救人/.test(S.USAGE),
        'USAGE #677  →  ' + S.USAGE.slice(S.USAGE.indexOf('worker-done --pr'), S.USAGE.indexOf('worker-done --pr') + 280));
    });

    await t.test('extractSoldierTerminal：terminal 为 null 时退到 handle', () => {
      const fx = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'orca-json', 'worker-show-completed.json'), 'utf8'));
      assert.ok(fx.result.terminal === null && S.extractSoldierTerminal(fx) === 'term_7e9c479f-36af-45eb-a0de-9c3ab0917d80',
        'completed 语料仍能取出终端  →  ' + S.extractSoldierTerminal(fx));
    });
  });

  it('#551 #552 闭环结算：worker_done 真结算、第二轮不往死信箱发', async (t) => {
    const S = await S_LOAD;
    const SETTLE = 'ctx_settle-0001';
    const TASK = 'task_settle-1';
    const FROM = 'term_live-0001';
    const completedFx = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'orca-json', 'worker-show-completed.json'), 'utf8'));

    const liveShow = {
      ok: true, result: {
        dispatch: { id: SETTLE, status: 'dispatched', assignee_handle: FROM, task_id: TASK, completed_at: null },
        worker: { state: 'working' },
      },
    };
    const doneShow = {
      ok: true, result: {
        dispatch: { id: SETTLE, status: 'completed', assignee_handle: FROM, task_id: TASK, completed_at: '2026-08-20 00:00:00' },
        worker: { state: 'succeeded' },
      },
    };

    function fakeSettleOrca({ wrongPane = false, settleNoop = false, showBroken = false, showBrokenAfter = false } = {}) {
      let seq = 0;
      let afterSend = false;
      return (a) => {
        const key = `${a[0]} ${a[1]}`;
        if (key === 'orchestration worker-show') {
          if (showBroken) return { ok: false, error: { code: 'timeout', message: 'worker-show timeout' } };
          if (showBrokenAfter && afterSend) return { ok: false, error: { code: 'timeout', message: 'worker-show timeout' } };
          const d = a[a.indexOf('--dispatch') + 1];
          if (d !== SETTLE) return { ok: false, error: { code: 'dispatch_not_found', message: `Worker Dispatch ${d} was not found.` } };
          if (afterSend && !settleNoop) return { ok: true, json: doneShow };
          return { ok: true, json: liveShow };
        }
        if (key === 'orchestration send') {
          if (wrongPane) {
            return { ok: false, error: { code: 'not_dispatch_pane', message: 'The caller is not the Dispatch pane' } };
          }
          afterSend = true;
          const to = a.includes('--to') ? a[a.indexOf('--to') + 1] : null;
          const id = `msg_settle${++seq}`;
          return { ok: true, json: { ok: true, result: { message: { id, to_handle: to, delivered_at: null } } } };
        }
        throw new Error(`假 orca 没登记这条命令: ${a.join(' ')}`);
      };
    }

    const missing = S.planWorkerDoneSend({ type: 'worker_done', outcome: 'succeeded' });
    await t.test('负样本一：缺 task-id/dispatch-id → 未结算', () => {
      assert.ok(missing.ok === false && /未结算/.test(missing.error) && /task-id/.test(missing.error) && /dispatch-id/.test(missing.error),
        '负样本一：缺 task-id/dispatch-id → 未结算  →  ' + JSON.stringify(missing));
    });
    const withTo = S.planWorkerDoneSend({
      type: 'worker_done', outcome: 'succeeded', taskId: TASK, dispatchId: SETTLE, to: `dispatch:${SETTLE}`,
    });
    await t.test('worker_done 带 --to → 未结算', () => {
      assert.ok(withTo.ok === false && /未结算/.test(withTo.error) && /不能带 --to/.test(withTo.error),
        'worker_done 带 --to → 未结算  →  ' + JSON.stringify(withTo));
    });
    const noOutcome = S.planWorkerDoneSend({ type: 'worker_done', taskId: TASK, dispatchId: SETTLE });
    await t.test('worker_done 缺 outcome → 未结算', () => {
      assert.ok(noOutcome.ok === false && /outcome/.test(noOutcome.error),
        'worker_done 缺 outcome → 未结算  →  ' + JSON.stringify(noOutcome));
    });

    const sendArgs = S.argsOrchestrationSend({
      subject: '本跳结束', type: 'worker_done', outcome: 'succeeded',
      taskId: TASK, dispatchId: SETTLE, from: FROM, dispatchCapability: 'dcap_x',
    });
    await t.test('worker_done 参数省略 --to，带 task-id/dispatch-id/from/capability', () => {
      assert.ok(!sendArgs.includes('--to') && sendArgs.includes('--task-id') && sendArgs.includes('--dispatch-id')
        && sendArgs.includes('--from') && sendArgs.includes('--dispatch-capability')
        && sendArgs.includes('--outcome') && sendArgs.includes('worker_done'),
        'worker_done 参数省略 --to，带 task-id/dispatch-id/from/capability  →  ' + sendArgs.join(' '));
    });

    const fromFx = S.readDispatchSettlement(completedFx);
    await t.test('真语料 worker-show-completed → settled（status=completed）', () => {
      assert.ok(fromFx.ok === true && fromFx.unscanned === false && fromFx.settled === true
        && fromFx.status === 'completed' && fromFx.dispatchId === 'ctx_adfee0055aef',
        '真语料 worker-show-completed → settled  →  ' + JSON.stringify(fromFx));
    });
    const fromLive = S.readDispatchSettlement(liveShow);
    await t.test('worker-show dispatched → 查到了但未结算（不是没查成）', () => {
      assert.ok(fromLive.ok === true && fromLive.unscanned === false && fromLive.settled === false
        && fromLive.status === 'dispatched',
        'worker-show dispatched → 查到了但未结算  →  ' + JSON.stringify(fromLive));
    });
    const fromEmpty = S.readDispatchSettlement({ ok: true, result: {} });
    await t.test('worker-show 缺 dispatch → unscanned，不是未 completed', () => {
      assert.ok(fromEmpty.ok === false && fromEmpty.unscanned === true && fromEmpty.settled === false,
        'worker-show 缺 dispatch → unscanned  →  ' + JSON.stringify(fromEmpty));
    });
    const fromNoStatus = S.readDispatchSettlement({ ok: true, result: { dispatch: { id: SETTLE } } });
    await t.test('worker-show 缺 status → unscanned（没查成 ≠ 0）', () => {
      assert.ok(fromNoStatus.ok === false && fromNoStatus.unscanned === true,
        'worker-show 缺 status → unscanned  →  ' + JSON.stringify(fromNoStatus));
    });

    const good = S.deliverMessage({
      type: 'worker_done', outcome: 'succeeded', subject: '本跳结束',
      taskId: TASK, dispatchId: SETTLE, from: FROM, hop: '审官结算',
      orca: fakeSettleOrca(),
    });
    await t.test('正样本：带完整身份 → Dispatch 变 completed', () => {
      assert.ok(good.ok === true && good.settled === true && good.stage === '已结算'
        && good.status === 'completed' && good.dispatchId === SETTLE,
        '正样本：带完整身份 → Dispatch 变 completed  →  ' + JSON.stringify(good));
    });

    const noop = S.deliverMessage({
      type: 'worker_done', outcome: 'succeeded', subject: '本跳结束',
      taskId: TASK, dispatchId: SETTLE, from: FROM, hop: '审官结算',
      orca: fakeSettleOrca({ settleNoop: true }),
    });
    await t.test('反例：落库但 Dispatch 仍 dispatched → 未结算，不得 ok:true', () => {
      assert.ok(noop.ok === false && noop.settled === false && !noop.unscanned
        && /未结算/.test(noop.error) && /落库无结算效力/.test(noop.error),
        '反例：落库但 Dispatch 仍 dispatched → 未结算  →  ' + JSON.stringify(noop));
    });

    const pane = S.deliverMessage({
      type: 'worker_done', outcome: 'succeeded', subject: '本跳结束',
      taskId: TASK, dispatchId: SETTLE, from: 'term_wrong', hop: '审官结算',
      orca: fakeSettleOrca({ wrongPane: true }),
    });
    await t.test('负样本二：错误 pane 发送 → 未结算', () => {
      assert.ok(pane.ok === false && pane.wrongPane === true && /未结算/.test(pane.error) && /错误 pane/.test(pane.error),
        '负样本二：错误 pane 发送 → 未结算  →  ' + JSON.stringify(pane));
    });

    const unscanned = S.deliverMessage({
      type: 'worker_done', outcome: 'succeeded', subject: '本跳结束',
      taskId: TASK, dispatchId: SETTLE, from: FROM, hop: '审官结算',
      orca: fakeSettleOrca({ showBroken: true }),
    });
    await t.test('结算前 worker-show 失败 → unscanned，不是查过未 completed', () => {
      assert.ok(unscanned.ok === false && unscanned.unscanned === true && /没查成/.test(unscanned.error),
        '结算前 worker-show 失败 → unscanned  →  ' + JSON.stringify(unscanned));
    });
    const unscannedAfter = S.deliverMessage({
      type: 'worker_done', outcome: 'succeeded', subject: '本跳结束',
      taskId: TASK, dispatchId: SETTLE, from: FROM, hop: '审官结算',
      orca: fakeSettleOrca({ showBrokenAfter: true }),
    });
    await t.test('发出后 worker-show 失败 → unscanned（没查成 ≠ 未变 completed）', () => {
      assert.ok(unscannedAfter.ok === false && unscannedAfter.unscanned === true && /没查成/.test(unscannedAfter.error),
        '发出后 worker-show 失败 → unscanned  →  ' + JSON.stringify(unscannedAfter));
    });

    const parsed = S.parseArgs([
      'node', 'dao.mjs', 'notify', '--type', 'worker_done', '--task-id', TASK,
      '--dispatch-id', SETTLE, '--outcome', 'succeeded', '--from', FROM, '--subject', '本跳结束',
    ]);
    await t.test('CLI parseArgs 透传 task-id/dispatch-id/from', () => {
      assert.ok(parsed.taskId === TASK && parsed.dispatchId === SETTLE && parsed.from === FROM
        && parsed.type === 'worker_done' && parsed.outcome === 'succeeded',
        'CLI parseArgs 透传 task-id/dispatch-id/from  →  ' + JSON.stringify(parsed));
    });

    const cliMiss = spawnSync(process.execPath, [
      CLI, 'notify', '--type', 'worker_done', '--outcome', 'succeeded', '--subject', '结算样本',
    ], { encoding: 'utf8', cwd: REPO });
    const pMiss = (() => { try { return JSON.parse((cliMiss.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI 缺身份 → 非零 + 报未结算', () => {
      assert.ok(cliMiss.status !== 0 && /未结算/.test(String(pMiss.error || cliMiss.stderr || ''))
        && /task-id/.test(String(pMiss.error || '')),
        'CLI 缺身份 → 非零 + 报未结算  →  ' + `status=${cliMiss.status} ${cliMiss.stderr} ${JSON.stringify(pMiss)}`);
    });
    const cliTo = spawnSync(process.execPath, [
      CLI, 'notify', '--type', 'worker_done', '--outcome', 'succeeded',
      '--task-id', TASK, '--dispatch-id', SETTLE, '--subject', '结算样本',
      '--to', 'dispatch:ctx_x',
    ], { encoding: 'utf8', cwd: REPO });
    const pTo = (() => { try { return JSON.parse((cliTo.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('CLI worker_done 带 --to → 非零 + 报未结算', () => {
      assert.ok(cliTo.status !== 0 && /未结算/.test(String(pTo.error || cliTo.stderr || '')) && /--to/.test(String(pTo.error || '')),
        'CLI worker_done 带 --to → 非零 + 报未结算  →  ' + `status=${cliTo.status} ${JSON.stringify(pTo)}`);
    });

    const daoSrc = fs.readFileSync(CLI, 'utf8');
    await t.test('#552 worker-done 复用失败当场 fail，不吞掉再投死信箱', () => {
      assert.ok(/禁止回退已结算 dispatch/.test(daoSrc) && !/帅会另开复核 Task/.test(daoSrc),
        '#552 worker-done 复用失败当场 fail，不吞掉再投死信箱');
    });
    await t.test('#677 士兵任务书判定绿才 worker_done，过早结算会打进死人', () => {
      const brief = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'templates', 'soldier-book.md'), 'utf8');
      assert.ok(/判定绿之前不要发 worker_done/.test(brief) && /打进死人/.test(brief) && /#677/.test(brief),
        '#677 士兵任务书下班时机  →  ' + brief.slice(brief.indexOf('判定绿之前'), brief.indexOf('判定绿之前') + 80));
    });
    await t.test('#675 士兵任务书：待终审只在审官起来之后写', () => {
      const brief = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'templates', 'soldier-book.md'), 'utf8');
      assert.ok(/待终审.*worker-done/.test(brief.replace(/\s+/g, ' ')) && /审官没起来不许写/.test(brief),
        '#675 待终审纪律  →  ' + brief.slice(brief.indexOf('卡备注'), brief.indexOf('卡备注') + 200));
    });
  });

  it('#611 dispatch --split 必填（fail-close + 三单回归 + 建卡计划）', async (t) => {
    const S = await S_LOAD;
    function dispatchRaw(extra) {
      return spawnSync(process.execPath, [CLI, 'dispatch', ...extra], { encoding: 'utf8', cwd: REPO });
    }
    function payload(r) {
      try { return JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop()); }
      catch { return { raw: r.stdout, err: r.stderr }; }
    }
    const base = ['--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--spec', '短摘要', '--dry-run'];

    const noSplit = dispatchRaw(base);
    const pNo = payload(noSplit);
    await t.test('② 不给 --split → 非零', () => {
      assert.ok(noSplit.status !== 0, '② 不给 --split → 非零  →  status=' + noSplit.status);
    });
    await t.test('② 不给 --split → 报缺 --split', () => {
      assert.ok(pNo.error && String(pNo.error).includes('--split'), '② 不给 --split → 报缺 --split  →  ' + JSON.stringify(pNo));
    });

    const noReason = dispatchRaw([...base, '--split', 'no']);
    const pReason = payload(noReason);
    await t.test('② --split no 不给 --split-reason → 非零', () => {
      assert.ok(noReason.status !== 0, '② --split no 不给 --split-reason → 非零  →  status=' + noReason.status);
    });
    await t.test('② --split no 不给理由 → 报 --split-reason', () => {
      assert.ok(pReason.error && String(pReason.error).includes('--split-reason'), '② --split no 不给理由 → 报 --split-reason  →  ' + JSON.stringify(pReason));
    });

    const emptyReason = dispatchRaw([...base, '--split', 'no', '--split-reason', '  ']);
    await t.test('② --split no 理由空白 → 非零', () => {
      assert.ok(emptyReason.status !== 0 && /--split-reason/.test(payload(emptyReason).error || ''), '② --split no 理由空白 → 非零  →  ' + JSON.stringify(payload(emptyReason)));
    });

    const one = dispatchRaw([...base, '--split', '1']);
    await t.test('--split 1 → 非零（N≥2）', () => {
      assert.ok(one.status !== 0 && /≥2/.test(payload(one).error || ''), '--split 1 → 非零（N≥2）  →  ' + JSON.stringify(payload(one)));
    });

    const fnMiss = S.resolveSplitConstraint({});
    await t.test('函数层缺 --split → 失败', () => {
      assert.ok(fnMiss.ok === false && (fnMiss.missing || []).includes('--split'), '函数层缺 --split → 失败  →  ' + JSON.stringify(fnMiss));
    });
    const fnNoReason = S.resolveSplitConstraint({ split: 'no' });
    await t.test('函数层 --split no 无理由 → 失败', () => {
      assert.ok(fnNoReason.ok === false && (fnNoReason.missing || []).includes('--split-reason'), '函数层 --split no 无理由 → 失败  →  ' + JSON.stringify(fnNoReason));
    });
    const fnOk = S.resolveSplitConstraint({ split: 'no', splitReason: '同几个文件反复改' });
    await t.test('函数层 --split no + 理由 → 过', () => {
      assert.ok(fnOk.ok === true && fnOk.split === 'no' && fnOk.childCount === 0, '函数层 --split no + 理由 → 过  →  ' + JSON.stringify(fnOk));
    });
    const fnN = S.resolveSplitConstraint({ split: '2' });
    await t.test('函数层 --split 2 → childCount=2', () => {
      assert.ok(fnN.ok === true && fnN.split === 2 && fnN.childCount === 2, '函数层 --split 2 → childCount=2  →  ' + JSON.stringify(fnN));
    });

    const cases = [
      { issue: 608, title: '迁24套测试', filesSeparable: true, chunkCount: 24, eachChunkEnoughWork: true, n: 4, expect: 4, reason: null },
      { issue: 604, title: '拆提示词整层', filesSeparable: false, chunkCount: 3, eachChunkEnoughWork: true, expect: 'no', reason: '同几个文件反复改' },
      { issue: 603, title: '归档收口', filesSeparable: false, chunkCount: 3, eachChunkEnoughWork: true, expect: 'no', reason: '三个红项互相关联' },
    ];
    for (const c of cases) {
      const decided = S.decideSplit(c);
      await t.test(`① #${c.issue} 判据 → ${c.expect}`, () => {
        assert.ok(decided.split === c.expect, `① #${c.issue} 判据 → ${c.expect}  →  ` + JSON.stringify(decided));
      });
      const flags = decided.split === 'no'
        ? ['--split', 'no', '--split-reason', c.reason]
        : ['--split', String(decided.split),
          '--slice', 'tests/a.test.js', '--slice', 'tests/b.test.js',
          '--slice', 'tests/c.test.js', '--slice', 'tests/d.test.js'];
      const r = dispatchRaw([
        '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol',
        '--name', c.title, '--issue', String(c.issue), '--spec', `短摘要：#${c.issue}`,
        ...flags, '--dry-run',
      ]);
      const p = payload(r);
      await t.test(`① #${c.issue} dry-run 结论 ${c.expect}`, () => {
        assert.ok(r.status === 0 && p.split === c.expect, `① #${c.issue} dry-run 结论 ${c.expect}  →  ` + JSON.stringify(p));
      });
    }
    await t.test('① 判据挑出 #608、不误伤另两单', () => {
      assert.ok(
        S.decideSplit(cases[0]).split === 4
        && S.decideSplit(cases[1]).split === 'no'
        && S.decideSplit(cases[2]).split === 'no',
        '① 判据挑出 #608、不误伤另两单',
      );
    });

    const noSlice = dispatchRaw([
      '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol',
      '--name', '并行两块', '--spec', '改 a.js 和 b.js', '--split', '2', '--dry-run',
    ]);
    await t.test('--split 2 不给 --slice → 非零', () => {
      assert.ok(noSlice.status !== 0 && /--slice/.test(payload(noSlice).error || ''), '--split 2 不给 --slice → 非零  →  ' + JSON.stringify(payload(noSlice)));
    });
    const overlap = dispatchRaw([
      '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol',
      '--name', '并行两块', '--spec', '改 a.js 和 b.js', '--split', '2',
      '--slice', '改 a.js', '--slice', '也改 a.js', '--dry-run',
    ]);
    await t.test('a.js 跨两块 → 非零（边界重叠）', () => {
      assert.ok(overlap.status !== 0 && /重叠/.test(payload(overlap).error || '') && /a\.js/.test(payload(overlap).error || ''), 'a.js 跨两块 → 非零  →  ' + JSON.stringify(payload(overlap)));
    });

    const split2 = dispatchRaw([
      '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol',
      '--name', '并行两块', '--spec', '改 a.js 和 b.js', '--split', '2',
      '--slice', '改 a.js', '--slice', '改 b.js', '--dry-run',
    ]);
    const p2 = payload(split2);
    const kids = Array.isArray(p2.childCards) ? p2.childCards : [];
    const kidsText = JSON.stringify(p2);
    await t.test('④ --split 2 dry-run 过', () => {
      assert.ok(split2.status === 0 && p2.split === 2, '④ --split 2 dry-run 过  →  ' + JSON.stringify(p2));
    });
    await t.test('④ 输出有父卡', () => {
      assert.ok(p2.parentCard && p2.parentCard.noParent === true && p2.workerCard, '④ 输出有父卡  →  ' + JSON.stringify(p2.parentCard));
    });
    await t.test('④ 输出有 2 张子卡', () => {
      assert.ok(kids.length === 2, '④ 输出有 2 张子卡  →  ' + kidsText);
    });
    await t.test('④ 子卡带 --parent-worktree', () => {
      assert.ok(kids.every(c => (c.flags || []).includes('--parent-worktree')) && /--parent-worktree/.test(kidsText), '④ 子卡带 --parent-worktree  →  ' + kidsText);
    });
    await t.test('④ 子卡带 --base-branch', () => {
      assert.ok(kids.every(c => (c.flags || []).includes('--base-branch')) && /--base-branch/.test(kidsText), '④ 子卡带 --base-branch  →  ' + kidsText);
    });
    await t.test('④ dry-run 子卡标明 willStart 且带分块职责', () => {
      assert.ok(kids.every(c => c.willStart === true && /块\d+\/2/.test(c.spec || '')), '④ dry-run 子卡标明 willStart 且带分块职责  →  ' + kidsText);
    });
    await t.test('a.js/b.js 反例：两个子工人拿到不同可执行职责', () => {
      assert.ok(
        /a\.js/.test(kids[0].spec) && !/b\.js/.test(kids[0].spec)
        && /b\.js/.test(kids[1].spec) && !/a\.js/.test(kids[1].spec),
        'a.js/b.js 反例  →  ' + kidsText,
      );
    });
    await t.test('④ dry-run 父卡是头工人', () => {
      assert.ok(p2.parentCard && p2.parentCard.role === '头工人' && /头工人/.test(p2.parentCard.spec || ''), '④ dry-run 父卡是头工人  →  ' + JSON.stringify(p2.parentCard));
    });

    const headSpec = S.buildSplitRoleSpec({ spec: '短摘要', role: 'head', total: 2 });
    const child1 = S.buildSplitRoleSpec({ spec: '改 a.js 和 b.js', role: 'child', index: 1, total: 2, slice: '改 a.js' });
    await t.test('分块职责：头工人不独占文件块', () => {
      assert.ok(/头工人/.test(headSpec) && /不独占/.test(headSpec), '分块职责：头工人不独占文件块  →  ' + headSpec);
    });
    await t.test('分块职责：子工人写明第几块', () => {
      assert.ok(/块1\/2/.test(child1) && /改 a\.js/.test(child1), '分块职责：子工人写明第几块  →  ' + child1);
    });

    const missSlice = S.resolveSliceAssignments({ childCount: 2, slices: ['改 a.js'] });
    await t.test('函数层 --split 2 只给 1 个 --slice → 失败', () => {
      assert.ok(missSlice.ok === false && (missSlice.missing || []).includes('--slice'), JSON.stringify(missSlice));
    });
    const fileOverlap = S.resolveSliceAssignments({ childCount: 2, slices: ['改 a.js', '也改 a.js'] });
    await t.test('函数层 a.js 跨块 → 失败', () => {
      assert.ok(fileOverlap.ok === false && /a\.js/.test(fileOverlap.error || ''), JSON.stringify(fileOverlap));
    });
    const okSlices = S.resolveSliceAssignments({ childCount: 2, slices: ['改 a.js', '改 b.js'] });
    await t.test('函数层 a.js / b.js 各一块 → 过', () => {
      assert.ok(okSlices.ok && okSlices.slices[0] === '改 a.js' && okSlices.slices[1] === '改 b.js', JSON.stringify(okSlices));
    });

    const calls = [];
    const okStart = S.startSplitChildren({
      children: [{ id: 'c1', name: 'a · 1' }, { id: 'c2', name: 'a · 2' }],
      spec: '改 a.js 和 b.js',
      slices: ['改 a.js', '改 b.js'],
      startOne: (req) => {
        calls.push(req);
        return { ok: true, handle: `h-${req.index}`, dispatchId: `d-${req.index}`, taskId: `t-${req.index}` };
      },
    });
    await t.test('真路径：--split 2 起父卡之外的 2 个独立子工人', () => {
      assert.ok(okStart.ok && okStart.started.length === 2 && okStart.started.every(s => s.handle && s.dispatchId), '真路径：--split 2 起 2 个子工人  →  ' + JSON.stringify(okStart));
    });
    await t.test('真路径：两个子工人职责不同', () => {
      assert.ok(
        calls.length === 2
        && /a\.js/.test(calls[0].spec) && !/b\.js/.test(calls[0].spec)
        && /b\.js/.test(calls[1].spec) && !/a\.js/.test(calls[1].spec)
        && calls[0].worktreeId === 'c1' && calls[1].worktreeId === 'c2',
        '真路径：两个子工人职责不同  →  ' + JSON.stringify(calls),
      );
    });

    const failCalls = [];
    const failStart = S.startSplitChildren({
      children: [{ id: 'c1', name: 'a · 1' }, { id: 'c2', name: 'a · 2' }],
      spec: '改 a.js 和 b.js',
      slices: ['改 a.js', '改 b.js'],
      startOne: (req) => {
        failCalls.push(req);
        if (req.index === 2) return { ok: false, error: 'boom', handle: 'h-fail' };
        return { ok: true, handle: 'h-1', dispatchId: 'd-1', taskId: 't-1' };
      },
    });
    await t.test('真路径：第二子工人失败时保留已起的人供回滚', () => {
      assert.ok(
        failStart.ok === false
        && failStart.started.some(s => s.handle === 'h-1' && s.dispatchId === 'd-1')
        && failStart.started.some(s => s.handle === 'h-fail'),
        '真路径：第二子工人失败时保留已起的人供回滚  →  ' + JSON.stringify(failStart),
      );
    });
    const rbFail = S.planDispatchRollback({
      workerId: 'w1',
      workerHandle: 'th1',
      childIds: failStart.started.map(s => s.id).filter(Boolean).concat(['c2']),
      childHandles: failStart.started.map(s => s.handle).filter(Boolean),
      dispatchIds: ['d-parent', 'd-1'],
      taskIds: ['t-parent', 't-1'],
    });
    await t.test('真路径：子工人失败回滚含关终端+删子卡+删父卡', () => {
      const text = JSON.stringify(rbFail);
      assert.ok(/h-1/.test(text) && /h-fail/.test(text) && /c2/.test(text) && /w1/.test(text), '真路径：子工人失败回滚完整  →  ' + text);
    });
    await t.test('真路径：回滚先 worker-stop / task-update failed 再删树', () => {
      const text = rbFail.map(s => s.join(' ')).join(' | ');
      const stopAt = text.indexOf('worker-stop');
      const taskAt = text.indexOf('task-update');
      const rmAt = text.indexOf('worktree rm');
      assert.ok(
        stopAt >= 0 && taskAt >= 0 && /--dispatch d-parent/.test(text) && /--dispatch d-1/.test(text)
        && /--status failed/.test(text) && /--id t-parent/.test(text)
        && stopAt < rmAt && taskAt < rmAt,
        '回滚先停 Dispatch/Task  →  ' + text,
      );
    });

    await t.test('FLAGS 登记 --split / --split-reason', () => {
      assert.ok(S.FLAGS_BY_VERB.dispatch.has('--split') && S.FLAGS_BY_VERB.dispatch.has('--split-reason') && S.FLAGS_BY_VERB.dispatch.has('--slice'), 'FLAGS 登记 --split / --split-reason');
    });
    await t.test('USAGE 有 --split <no|N>', () => {
      assert.ok(/--split <no\|N>/.test(S.USAGE), 'USAGE 有 --split <no|N>');
    });
    await t.test('USAGE 写了判据真相源', () => {
      assert.ok(/能不能按文件切开/.test(S.USAGE) && /块数/.test(S.USAGE), 'USAGE 写了判据真相源');
    });
    await t.test('skill 只留指针不复制判据全文', () => {
      const skill = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'SKILL.md'), 'utf8');
      assert.ok(/#611/.test(skill) && /dispatch --help/.test(skill) && !/能切 \+ 块数/.test(skill), 'skill 只留指针不复制判据全文');
    });
  });
});