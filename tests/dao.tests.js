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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'scripts', 'dao.mjs');
const LIB = path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  →  ' + detail : ''}`); }
}

async function main() {
  const S = await import('file://' + LIB.replace(/\\/g, '/'));
  const routing = S.loadRouting();

  console.log('\n=== ① R2 起 codex 必须带 danger 旗标（#468 实测换路）===');
  {
    const gpt = S.resolveLaunch({ provider: 'gpt', routing });
    check('gpt launch 含 --dangerously-bypass-approvals-and-sandbox', gpt.command.includes(S.CODEX_CAPABLE_FLAG), gpt.command);
    check('gpt launch 含 codex', /\bcodex\b/.test(gpt.command), gpt.command);
    check('gpt 不用单挂 -a never（会拦 gh/node）', !/(^|\s)-a\s+never\b/.test(gpt.command), gpt.command);

    const dry = spawnSync(process.execPath, [CLI, 'start', '--provider', 'gpt', '--worktree', 'active', '--dry-run'], {
      encoding: 'utf8', cwd: REPO,
    });
    check('dao start --dry-run 退出 0', dry.status === 0, dry.stderr || dry.stdout);
    check('CLI 起 gpt 自动带 danger 旗标', (dry.stdout || '').includes(S.CODEX_CAPABLE_FLAG), dry.stdout);

    const mute = { ...routing, providers: { ...routing.providers, gpt: { ...routing.providers.gpt, launch: 'codex -a never -m {model}' } } };
    const muteLaunch = S.resolveLaunch({ provider: 'gpt', routing: mute });
    const muteRev = S.assertCodexLaunch({ command: muteLaunch.command });
    check('判别力：-a never 单用当审官 → 拦', muteRev.ok === false && /哑终端/.test(muteRev.error), JSON.stringify(muteRev));
    const muteWorker = S.assertCodexLaunch({ command: 'codex -a never -m gpt-5.6-sol' });
    check('R2 工人位 -a never 同样拦', muteWorker.ok === false, JSON.stringify(muteWorker));
    const okWorker = S.assertCodexLaunch({ command: `codex ${S.CODEX_CAPABLE_FLAG} -m gpt-5.6-sol` });
    check('R2 工人位带 danger 旗标放行', okWorker.ok === true, JSON.stringify(okWorker));

    const confirm = S.verifyStarted({ text: 'Allow command?\n[Yes] [No] [Always allow]' });
    check('确认屏被验开工拦住', confirm.ok === false && confirm.reason === '有待确认提示', JSON.stringify(confirm));
    check('正常有输出无确认 → 过', S.verifyStarted({ text: 'codex ready\nmodel gpt-5.6-sol' }).ok === true);
  }

  console.log('\n=== 启动模板：reclaude / shim / fail-loud ===');
  {
    const claude = S.resolveLaunch({ provider: 'claude', routing });
    check('claude 走 reclaude', claude.command.includes('reclaude'), claude.command);
    check('claude 带 --model opus', /--model\s+opus/.test(claude.command), claude.command);
    check('claude 不走裸 claude', !/\bclaude\b/.test(claude.command.replace(/reclaude/g, '')), claude.command);

    const grok = S.resolveLaunch({ provider: 'grok', routing });
    check('grok launch 走 grok', /\bgrok\b/.test(grok.command) && !/grok-shim\.cmd/.test(grok.command), grok.command);
    check('grok launch 带 --effort xhigh', /--effort\s+xhigh/.test(grok.command), grok.command);
    check('grok launch 带 --always-approve', /--always-approve/.test(grok.command), grok.command);
    check('grok launch 不再用 --permission-mode auto 冒充免确认', !/--permission-mode\s+auto/.test(grok.command), grok.command);
    check('shim 文件在仓里', fs.existsSync(path.join(REPO, 'scripts', 'grok-shim.cmd')));
    const shim = fs.readFileSync(path.join(REPO, 'scripts', 'grok-shim.cmd'), 'utf8');
    check('shim 带 HTTPS_PROXY', /HTTPS_PROXY=http:\/\/127\.0\.0\.1:7890/.test(shim));

    let threw = false;
    try { S.loadRouting(path.join(REPO, 'docs', 'no-such-routing.toml')); } catch { threw = true; }
    check('读表失败 fail-loud（文件不在）', threw);

    const noLaunch = { providers: { gpt: { cli: 'codex' } }, models: [] };
    let threw2 = false;
    try { S.resolveLaunch({ provider: 'gpt', routing: noLaunch }); } catch { threw2 = true; }
    check('缺 launch fail-loud', threw2);

    let threw3 = false;
    try { S.resolveLaunch({ provider: 'ghost', routing }); } catch { threw3 = true; }
    check('未知 provider fail-loud', threw3);
  }

  console.log('\n=== ② --submit 不存在（真 --help，禁 mock）===');
  {
    const fetched = S.fetchHelpPreferLive('orchestration worker-start');
    check(`worker-start --help 有文本（源=${fetched.source}）`, String(fetched.text).trim().length > 0);
    const available = S.parseHelpFlags(fetched.text);
    check('真 help 解析出参数', available.size > 0, `size=${available.size}`);
    check('真 help 没有 --submit', !available.has('--submit'), [...available].join(' '));
    check('真 help 有 --task', available.has('--task'));
    check('真 help 有 --terminal', available.has('--terminal'));

    const poisoned = S.checkHelpLiveness({
      catalog: [{ cmd: 'orchestration worker-start', flags: ['--task', '--submit'] }],
      fetchHelp: () => fetched.text,
    });
    check('故意用 --submit 被自检拦下', poisoned.ok === false && poisoned.missing.some(m => m.includes('--submit')), JSON.stringify(poisoned));
    check('判别力：--submit 在 missing 里', poisoned.missing.includes('orchestration worker-start --submit'), poisoned.missing.join(','));

    const clean = S.checkHelpLiveness({
      catalog: S.catalogUsedFlags(),
      fetchHelp: (cmd) => S.fetchHelpPreferLive(cmd).text,
    });
    check('库里用到的参数都还在 help 里', clean.ok === true && clean.unscanned === false, JSON.stringify(clean));
    check('自检扫到了命令（不是 0 样本）', clean.scanned.length > 0, String(clean.scanned.length));

    // 上一条在本机永远走 live，加了 builder 忘补夹具本机照样绿、到 CI（无 orca）才炸成「没查成」。
    // 这条把「夹具齐不齐」在本机就问出来——判据是文件在不在，不看 orca 在不在。
    const noFixture = S.catalogUsedFlags()
      .map(item => item.cmd)
      .filter(cmd => !fs.existsSync(S.helpFixturePath(cmd)));
    check('catalogUsedFlags 每条命令都有 --help 夹具（CI 无 orca 时靠它）', noFixture.length === 0, noFixture.join(' '));

    const empty = S.checkHelpLiveness({ catalog: [], fetchHelp: () => fetched.text });
    check('catalog 空 → 没查成', empty.unscanned === true && empty.ok === false);

    const blank = S.checkHelpLiveness({
      catalog: [{ cmd: 'orchestration worker-start', flags: ['--task'] }],
      fetchHelp: () => '   ',
    });
    check('help 无输出 → 没查成', blank.unscanned === true && blank.ok === false);

    const skipCi = S.helpCheckPolicy({ ci: true, orca: { ok: false, missing: true, error: 'spawnSync orca ENOENT' } });
    check('CI 无 orca → SKIP（不计失败）', skipCi.action === 'skip' && /本项需本机 orca/.test(skipCi.reason), JSON.stringify(skipCi));
    const failLocal = S.helpCheckPolicy({ ci: false, orca: { ok: false, missing: true, error: 'spawnSync orca ENOENT' } });
    check('本机无 orca → FAIL（不许悄悄跳过）', failLocal.action === 'fail', JSON.stringify(failLocal));
    const runLive = S.helpCheckPolicy({ ci: true, orca: { ok: true, missing: false } });
    check('有 orca 时 CI 也必须真跑', runLive.action === 'run', JSON.stringify(runLive));

    const avail = S.orcaHelpAvailable();
    const policy = S.helpCheckPolicy({ ci: S.isCiEnv(), orca: avail });
    if (policy.action === 'skip') {
      console.log(`  SKIP  live orca --help（${policy.reason}）`);
    } else if (policy.action === 'fail') {
      check('live orca --help 可跑', false, policy.reason);
    } else {
      const liveText = S.fetchOrcaHelp('orchestration worker-start');
      check('live --help 也不含 --submit', !S.parseHelpFlags(liveText).has('--submit'));
    }
  }

  console.log('\n=== ③ pi 假活：mtime + git（#463）===');
  {
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
    check('state.json 12 秒前在动 + 代码停在 3.5h 前的 commit → fake-alive', fake.verdict === 'fake-alive', JSON.stringify(fake));
    check('假活 processAlive=true hasOutput=false', fake.processAlive === true && fake.hasOutput === false, JSON.stringify(fake));

    const working = S.assessLiveness({
      now,
      processNewestMtime: now - 12_000,
      processStartedMs: now - hours,
      workNewestMtime: now - 30_000,
      gitHeadMs: now - hours,
      gitDirty: true,
    });
    check('判别力：代码刚改过 → working（不会误报假活）', working.verdict === 'working', JSON.stringify(working));

    const thinking = S.assessLiveness({
      now,
      processNewestMtime: now - 12_000,
      processStartedMs: now - 60_000,
      workNewestMtime: now - hours,
      gitHeadMs: now - hours,
      gitDirty: false,
    });
    check('刚开工不到宽限期 → thinking', thinking.verdict === 'thinking', JSON.stringify(thinking));

    const dead = S.assessLiveness({
      now,
      processNewestMtime: now - 30 * 60 * 1000,
      processStartedMs: now - hours,
      workNewestMtime: now - hours,
      gitHeadMs: now - hours,
      gitDirty: false,
    });
    check('进程文件也不动 → dead', dead.verdict === 'dead', JSON.stringify(dead));

    check('state.json 算进程文件', S.isProcessFile('state.json') === true);
    check('.pi/session 算进程文件', S.isProcessFile('.pi/session.json') === true);
    check('src/app.js 算产出文件', S.isWorkFile('src/app.js') === true && S.isProcessFile('src/app.js') === false);

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
    check('真实目录+git：pi 假活 → fake-alive', scanned.verdict === 'fake-alive', JSON.stringify(scanned));
    check('真实目录+git：processAlive 且无产出', scanned.processAlive === true && scanned.hasOutput === false, JSON.stringify(scanned));
    check('真实目录+git：git 干净', scanned.gitDirty === false, JSON.stringify(scanned));
  }

  console.log('\n=== ④⑤⑥ 派工硬闸（merge-policy 默认 auto；manual 必带理由；缺 model/reviewer 报错）===');
  {
    function dispatch(extra) {
      return spawnSync(process.execPath, [CLI, 'dispatch', ...extra], { encoding: 'utf8', cwd: REPO });
    }
    function payload(r) {
      try { return JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop()); }
      catch { return { raw: r.stdout, err: r.stderr }; }
    }

    const noMerge = dispatch(['--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const p1 = payload(noMerge);
    check('缺 --merge-policy → 默认 auto 通过', noMerge.status === 0 && p1.mergePolicy === 'auto', JSON.stringify(p1));

    const noReason = dispatch(['--merge-policy', 'manual', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const p1b = payload(noReason);
    check('manual 无 --merge-reason → 非零', noReason.status !== 0, `status=${noReason.status}`);
    check('manual 无 --merge-reason → 打印缺什么', p1b.error && String(p1b.error).includes('--merge-reason'), JSON.stringify(p1b));

    const withReason = dispatch(['--merge-policy', 'manual', '--merge-reason', '改协作约定 CLAUDE.md', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const p1c = payload(withReason);
    check('manual 带理由 → 通过且理由落 comment', withReason.status === 0 && p1c.mergePolicy === 'manual' && /manual 理由: 改协作约定/.test(p1c.comment), JSON.stringify(p1c));
    check('manual 带理由 → mergeReason 透传', p1c.mergeReason === '改协作约定 CLAUDE.md', JSON.stringify(p1c));

    const emptyReason = dispatch(['--merge-policy', 'manual', '--merge-reason', '  ', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const p1d = payload(emptyReason);
    check('manual 理由为空白 → 非零（理由为空即退出）', emptyReason.status !== 0 && /--merge-reason/.test(p1d.error || ''), JSON.stringify(p1d));

    const autoExplicit = dispatch(['--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const p1e = payload(autoExplicit);
    check('显式 auto 无需理由 → 通过', autoExplicit.status === 0 && p1e.mergePolicy === 'auto', JSON.stringify(p1e));

    const noModel = dispatch(['--merge-policy', 'auto', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--dry-run']);
    const p2 = payload(noModel);
    check('缺 --model/--role → 非零', noModel.status !== 0, `status=${noModel.status}`);
    check('缺 --model/--role → 打印缺什么', p2.error && String(p2.error).includes('--model'), JSON.stringify(p2));

    const noRev = dispatch(['--merge-policy', 'auto', '--model', 'grok-4.6', '--name', 'x', '--dry-run']);
    const p3 = payload(noRev);
    check('缺 --reviewer → 非零', noRev.status !== 0, `status=${noRev.status}`);
    check('缺 --reviewer → 打印缺什么', p3.error && String(p3.error).includes('--reviewer'), JSON.stringify(p3));

    const noSpec = dispatch(['--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--dry-run']);
    const pSpec = payload(noSpec);
    check('R5 缺 --spec → 非零', noSpec.status !== 0, `status=${noSpec.status}`);
    check('R5 缺 --spec → 打印缺什么', pSpec.error && String(pSpec.error).includes('--spec'), JSON.stringify(pSpec));

    const ok = dispatch(['--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--spec', '短摘要：修命令库', '--dry-run']);
    const pOk = payload(ok);
    check('三参数齐 + --spec → dry-run 过', ok.status === 0 && pOk.ok === true, JSON.stringify(pOk));
    check('dry-run 写出审官预建计划', pOk.reviewerCard === '审官·gpt-5.6-sol' && /codex/.test(pOk.reviewerLaunch), JSON.stringify(pOk));
    check('审官 launch 带 danger 旗标', String(pOk.reviewerLaunch || '').includes(S.CODEX_CAPABLE_FLAG), JSON.stringify(pOk));
    check('#546 dry-run 写出审官 base（工人树当前分支）', typeof pOk.reviewerBase === 'string' && pOk.reviewerBase.length > 0, JSON.stringify(pOk));
    check('dry-run 工人走 grok --always-approve', /\bgrok\b/.test(pOk.workerLaunch) && /--always-approve/.test(pOk.workerLaunch), JSON.stringify(pOk));

    const okIssue = dispatch(['--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', '修地基', '--issue', '565', '--spec', '短摘要', '--dry-run']);
    const pIssue = payload(okIssue);
    check('#559 追加：dry-run 带 --issue → 卡名带号', okIssue.status === 0 && pIssue.workerCard === '#565 - 修地基' && pIssue.reviewerCard === '#565 - 审官·gpt-5.6-sol', JSON.stringify(pIssue));
    check('#559 追加：dry-run 带 --issue → issue 字段透出', pIssue.issue === '565', JSON.stringify(pIssue));

    const peak = '2026-08-15T02:00:00.000Z'; // 北京 10:00 峰时
    const roleOnly = dispatch(['--merge-policy', 'auto', '--role', '写码', '--reviewer', 'gpt-5.6-sol', '--now', peak, '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const pRole = payload(roleOnly);
    check('峰时只给 --role 不给 --model → 非零（禁静默默认）', roleOnly.status !== 0, JSON.stringify(pRole));
    check('峰时推荐 grok-4.6 不是 ds-flash', pRole.recommendation && pRole.recommendation.model === 'grok-4.6', JSON.stringify(pRole));
    check('峰时推荐不是 deepseek-v4-flash（误推钉）', !(pRole.recommendation && pRole.recommendation.model === 'deepseek-v4-flash'), JSON.stringify(pRole));

    const roleConfirm = dispatch(['--merge-policy', 'auto', '--role', '写码', '--reviewer', 'gpt-5.6-sol', '--now', peak, '--confirm', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const pConf = payload(roleConfirm);
    check('--role + --confirm 采用峰时推荐 grok-4.6', roleConfirm.status === 0 && pConf.model === 'grok-4.6', JSON.stringify(pConf));

    const fnDefault = S.resolveDispatchConstraints({
      model: 'grok-4.6', reviewer: 'gpt-5.6-sol', routing,
    });
    check('函数层不给 mergePolicy → 默认 auto', fnDefault.ok === true && fnDefault.mergePolicy === 'auto', JSON.stringify(fnDefault));
    const fnManualNoReason = S.resolveDispatchConstraints({
      mergePolicy: 'manual', model: 'grok-4.6', reviewer: 'gpt-5.6-sol', routing,
    });
    check('函数层 manual 无理由 → 失败', fnManualNoReason.ok === false && (fnManualNoReason.missing || []).includes('--merge-reason'), JSON.stringify(fnManualNoReason));

    const fnMiss = S.resolveDispatchConstraints({
      mergePolicy: 'auto', model: 'grok-4.6', routing,
    });
    check('函数层缺 --reviewer 也失败', fnMiss.ok === false && (fnMiss.missing || []).includes('--reviewer'), JSON.stringify(fnMiss));

    const ws = spawnSync(process.execPath, [
      CLI, 'worker-start', '--task', 't', '--worktree', 'w', '--terminal', 'h',
    ], { encoding: 'utf8', cwd: REPO });
    const pWs = payload(ws);
    check('worker-start 缺 model/reviewer → 非零', ws.status !== 0 && String(pWs.error || '').includes('--model'), JSON.stringify(pWs));

    const wsManual = spawnSync(process.execPath, [
      CLI, 'worker-start', '--task', 't', '--worktree', 'w', '--terminal', 'h',
      '--merge-policy', 'manual', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol',
    ], { encoding: 'utf8', cwd: REPO });
    const pWsManual = payload(wsManual);
    check('worker-start manual 无理由 → 非零', wsManual.status !== 0 && /--merge-reason/.test(pWsManual.error || ''), JSON.stringify(pWsManual));
  }

  console.log('\n=== #565 消歧门：dispatch/worker-start 带 --issue 时缺「已消歧」label 拒派 ===');
  {
    // 纯函数三态判别（假 gh，不碰网络）：查成有 label / 查成没 label / 没查成（gh 失败 / 非 JSON）。
    const ghHas = () => ({ ok: true, out: JSON.stringify({ labels: [{ name: '已消歧' }, { name: '任务' }] }) });
    const ghNone = () => ({ ok: true, out: JSON.stringify({ labels: [{ name: '任务' }] }) });
    const ghFail = () => ({ ok: false, error: 'gh exit 1: network down' });
    const ghBroken = () => ({ ok: true, out: 'not json at all' });

    const ok1 = S.checkIssueDisambiguated({ issue: '565', runGh: ghHas });
    check('消歧门：有 已消歧 label → 放行', ok1.ok === true && ok1.hasLabel === true && ok1.gated === true, JSON.stringify(ok1));
    const no1 = S.checkIssueDisambiguated({ issue: '559', runGh: ghNone });
    check('消歧门：查成但没 label → 拒派并点名缺什么', no1.ok === false && no1.hasLabel === false && /已消歧/.test(no1.error) && /补消歧记录|label/.test(no1.error), JSON.stringify(no1));
    check('消歧门：没 label ≠ 没查成（两态分开）', no1.unscanned !== true, JSON.stringify(no1));
    const f1 = S.checkIssueDisambiguated({ issue: '559', runGh: ghFail });
    check('消歧门：gh 失败 → 没查成，不许当没 label 放行', f1.ok === false && f1.unscanned === true && /没查成/.test(f1.error), JSON.stringify(f1));
    const b1 = S.checkIssueDisambiguated({ issue: '559', runGh: ghBroken });
    check('消歧门：gh 返回非 JSON → 没查成', b1.ok === false && b1.unscanned === true, JSON.stringify(b1));
    const noIssue = S.checkIssueDisambiguated({ issue: '', runGh: ghNone });
    check('消歧门：无 --issue → 不受门控', noIssue.ok === true && noIssue.gated === false, JSON.stringify(noIssue));
    const badIssue = S.checkIssueDisambiguated({ issue: 'abc', runGh: ghNone });
    check('消歧门：--issue 非数字 → 拒派', badIssue.ok === false && /issue 号/.test(badIssue.error), JSON.stringify(badIssue));

    // CLI 级：假 gh（CI 无 GH_TOKEN，dao.mjs 消歧门读 DAO_GH_FAKE 用它替真 gh；
    // 判据固定：565 有「已消歧」、559 无、999 = gh 失败）。真 gh 的端到端验收在合并证据里手跑。
    // #565 返工：--dry-run 不实际派工，门控对预览无意义——disambiguation 只作报告，不影响退出码。
    const FAKE_GH = path.join(REPO, 'tests', 'fixtures', 'fake-gh.mjs');
    const cliEnv = { ...process.env, DAO_GH_FAKE: FAKE_GH };
    const cliHas = spawnSync(process.execPath, [CLI, 'dispatch', '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', '修地基', '--issue', '565', '--spec', '短摘要', '--dry-run'], { encoding: 'utf8', cwd: REPO, env: cliEnv });
    const pHas = (() => { try { return JSON.parse((cliHas.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    check('消歧门：dispatch --issue 565（有 label）--dry-run 过且报告为绿', cliHas.status === 0 && pHas.disambiguation && pHas.disambiguation.ok === true, `status=${cliHas.status} ${String(pHas.error || '')}`);

    const cliNo = spawnSync(process.execPath, [CLI, 'dispatch', '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--issue', '559', '--spec', '短摘要', '--dry-run'], { encoding: 'utf8', cwd: REPO, env: cliEnv });
    const pNo = (() => { try { return JSON.parse((cliNo.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    check('消歧门：dry-run --issue 559（无 label）→ exit 0，报告 hasLabel:false（门控不影响预览）', cliNo.status === 0 && pNo.disambiguation && pNo.disambiguation.ok === false && pNo.disambiguation.hasLabel === false, `status=${cliNo.status} ${JSON.stringify(pNo)}`);
    check('消歧门：dry-run 报告仍说清去哪补', /消歧记录|label/.test(String(pNo.disambiguation && pNo.disambiguation.error || '')), String(pNo.disambiguation && pNo.disambiguation.error || ''));

    // 真派工（非 dry-run）：门在碰 orca / 建卡之前拦——被拦下时什么都不会创建（#565 硬约束）。
    const cliReal = spawnSync(process.execPath, [CLI, 'dispatch', '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--issue', '559', '--spec', '短摘要'], { encoding: 'utf8', cwd: REPO, env: cliEnv });
    const pReal = (() => { try { return JSON.parse((cliReal.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    check('消歧门：真派工 --issue 559（无 label）→ 非 0 当场拦下', cliReal.status !== 0 && /已消歧/.test(String(pReal.error || '')), `status=${cliReal.status} ${JSON.stringify(pReal)}`);
    check('消歧门：真派工被拦时错误说清去哪补', /消歧记录|label/.test(String(pReal.error || '')), String(pReal.error || ''));
    check('消歧门：真派工被拦发生在建卡前（disambiguation.hasLabel=false，无 workerId）', (pReal.disambiguation || {}).hasLabel === false && !pReal.workerId, JSON.stringify(pReal));

    // worker-start 带 --issue 同样受门控：559 无 label → 在碰 orca 之前就被拦（非 0）。
    const wsNo = spawnSync(process.execPath, [CLI, 'worker-start', '--task', 't', '--worktree', 'w', '--terminal', 'h', '--issue', '559', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol'], { encoding: 'utf8', cwd: REPO, env: cliEnv });
    const pWsNo = (() => { try { return JSON.parse((wsNo.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    check('消歧门：worker-start --issue 559（无 label）→ 非 0 拒派', wsNo.status !== 0 && /已消歧/.test(String(pWsNo.error || '')), `status=${wsNo.status} ${JSON.stringify(pWsNo)}`);
    check('worker-start 的 FLAGS_BY_VERB 登记了 --issue', S.FLAGS_BY_VERB['worker-start'].has('--issue'));

    // CI 场景（无 GH_TOKEN → gh 失败）：真派工必须报「没查成」拒派，不许放行（#565 硬约束）。
    const cliFail = spawnSync(process.execPath, [CLI, 'dispatch', '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--issue', '999', '--spec', '短摘要'], { encoding: 'utf8', cwd: REPO, env: cliEnv });
    const pFail = (() => { try { return JSON.parse((cliFail.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    check('消歧门：gh 失败（CI 无 token）真派工 → 非 0 且报「没查成」', cliFail.status !== 0 && /没查成/.test(String(pFail.error || '')) && (pFail.disambiguation || {}).unscanned === true, `status=${cliFail.status} ${JSON.stringify(pFail)}`);

    const daoSrc565 = fs.readFileSync(CLI, 'utf8');
    check('dao.mjs dispatch 与 worker-start 都调消歧门', (daoSrc565.match(/checkIssueDisambiguated/g) || []).length >= 2, daoSrc565.slice(0, 60));
  }

  console.log('\n=== #564 label 自动打：dispatch 记 issue + pr-sync-labels 合并侧同步到 PR ===');
  {
    // 纯函数：label 名组装（角色缺省写码）。
    const ln1 = S.dispatchLabelNames({ model: 'grok-4.6' });
    check('label 名：model/<id> + type/写码（缺省）', ln1.includes('model/grok-4.6') && ln1.includes('type/写码'), JSON.stringify(ln1));
    const ln2 = S.dispatchLabelNames({ model: 'gpt-5.6-sol', role: '审查' });
    check('label 名：给角色 → type/<角色>', ln2.includes('model/gpt-5.6-sol') && ln2.includes('type/审查') && !ln2.includes('type/写码'), JSON.stringify(ln2));

    // PR 署名单号：只认 Closes/Fixes 关键词，正文随手引用的 #N 不算。
    const refs = S.linkedIssueNumbers('Closes #564\n参考 #498 #480（历史相关）');
    check('署名单号只认 Closes 关键词（#498 #480 不被抄 label）',
      refs.length === 1 && refs[0] === 564, JSON.stringify(refs));
    const refs2 = S.linkedIssueNumbers('Fixes #12');
    check('Fixes 也算署名单号', refs2.length === 1 && refs2[0] === 12, JSON.stringify(refs2));

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
    check('dispatch 打标成功：names 对、缺的 label 先建、issue edit 带 --add-label',
      stamped.ok === true && stamped.names.length === 2
      && calls.some(a => a[0] === 'label' && a[1] === 'create' && a[2] === 'type/写码')
      && calls.some(a => a[0] === 'issue' && a[1] === 'edit' && a[2] === '123' && a.includes('--add-label') && a.includes('model/grok-4.6') && a.includes('type/写码')),
      JSON.stringify({ stamped, calls }));

    // 没 gh 执行器 / 没合法 issue：不许当「查过没事」。
    const noGh = S.stampIssueLabels({ issue: '123', model: 'grok-4.6', runGh: null });
    check('打标没 gh 执行器 → 报没查成', noGh.ok === false && noGh.unscanned === true, JSON.stringify(noGh));
    const skip = S.stampIssueLabels({ issue: '', model: 'grok-4.6', runGh: recGh });
    check('打标没合法 issue 号 → skipped 不瞎打', skip.ok === false && skip.skipped === true, JSON.stringify(skip));

    // 合并侧同步：stub runGh（PR 正文 Closes #7，issue #7 有 model+type）。
    const syncGh = (a) => {
      calls2.push(a.slice());
      if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: '修 X', body: 'Closes #7\n验收：过' }) };
      if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [{ name: 'model/grok-4.6' }, { name: 'type/写码' }, { name: '已消歧' }] }) };
      if (a[0] === 'label' && a[1] === 'list') return { ok: true, out: JSON.stringify([{ name: 'model/grok-4.6' }, { name: 'type/写码' }]) };
      if (a[0] === 'pr' && a[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: `未预期 ${a.join(' ')}` };
    };
    const calls2 = [];
    const synced = S.syncPrLabelsFromIssue({ pr: '7', runGh: syncGh });
    check('pr-sync-labels：从署名 issue 把 model/type 抄到 PR（非 model/type 不抄）',
      synced.ok === true && synced.labels.length === 2 && synced.labels.includes('model/grok-4.6') && synced.labels.includes('type/写码')
      && calls2.some(a => a[0] === 'pr' && a[1] === 'edit' && a[2] === '7' && a.includes('--add-label')),
      JSON.stringify({ synced, calls2 }));

    // PR 没署名单号 → 说清楚，不许静默。
    const noRef = S.syncPrLabelsFromIssue({ pr: '9', runGh: (a) => {
      if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: '无署名', body: '改动：修 bug' }) };
      return { ok: false, error: `未预期 ${a.join(' ')}` };
    } });
    check('pr-sync-labels 无署名单号 → 报错需人工补', noRef.ok === false && /Closes|署名/.test(noRef.error), JSON.stringify(noRef));

    // 署名 issue 没有 model/type label → 说清楚。
    const noLabel = S.syncPrLabelsFromIssue({ pr: '10', runGh: (a) => {
      if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: 'x', body: 'Closes #10' }) };
      if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [{ name: '已消歧' }] }) };
      return { ok: false, error: `未预期 ${a.join(' ')}` };
    } });
    check('署名 issue 无 model/type → 报错需人工补', noLabel.ok === false && /model|type/.test(noLabel.error), JSON.stringify(noLabel));

    // CLI 级：pr-sync-labels --pr 42（fake-gh 固定：正文 Closes #565，565 带 model/type）→ 退出 0。
    const FAKE_GH2 = path.join(REPO, 'tests', 'fixtures', 'fake-gh.mjs');
    const cliSync = spawnSync(process.execPath, [CLI, 'pr-sync-labels', '--pr', '42'], { encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH2 } });
    const pSync = (() => { try { return JSON.parse((cliSync.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    check('CLI pr-sync-labels --pr 42（假 gh）→ 退出 0 且 label 抄到',
      cliSync.status === 0 && pSync.ok === true && (pSync.labels || []).includes('model/grok-4.6') && (pSync.labels || []).includes('type/写码'),
      `status=${cliSync.status} ${JSON.stringify(pSync)}`);
    const cliSyncNoRef = spawnSync(process.execPath, [CLI, 'pr-sync-labels', '--pr', '41'], { encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH2 } });
    const pSyncNoRef = (() => { try { return JSON.parse((cliSyncNoRef.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    check('CLI pr-sync-labels 无署名单号 → 非 0 且说清',
      cliSyncNoRef.status !== 0 && /署名/.test(String(pSyncNoRef.error || '')), `status=${cliSyncNoRef.status} ${JSON.stringify(pSyncNoRef)}`);

    const daoSrcLabels = fs.readFileSync(CLI, 'utf8');
    check('dao.mjs dispatch 成功后调 stampIssueLabels', /stampIssueLabels\(\{/.test(daoSrcLabels), daoSrcLabels.slice(0, 60));
    check('dao.mjs dispatch 打 reviewer/*', /reviewer:\s*gate\.reviewer/.test(daoSrcLabels), daoSrcLabels.slice(0, 60));
  }

  console.log('\n=== #586 审官按需起阶段一：pickReviewer + 自读选型 + worker-done 骨架 ===');
  {
    const one = S.pickReviewer(['model/grok-4.6', 'type/写码', 'reviewer/gpt-5.6-sol', '已消歧']);
    check('pickReviewer 查到一个 → ok + modelId', one.ok === true && one.state === 'one' && one.modelId === 'gpt-5.6-sol', JSON.stringify(one));
    const none = S.pickReviewer(['model/grok-4.6', 'type/写码', '已消歧']);
    check('pickReviewer 没有 reviewer/* → none，不许猜', none.ok === false && none.state === 'none' && /没有 reviewer/.test(none.error), JSON.stringify(none));
    const many = S.pickReviewer(['reviewer/gpt-5.6-sol', 'reviewer/claude-opus']);
    check('pickReviewer 有多个 → many，不许猜', many.ok === false && many.state === 'many' && /多个 reviewer/.test(many.error), JSON.stringify(many));
    const unscanned = S.pickReviewer(null);
    check('pickReviewer 没拿到列表 → unscanned，和「扫完 0 条」不同话',
      unscanned.ok === false && unscanned.state === 'unscanned'
      && unscanned.error !== none.error && unscanned.error !== many.error && one.state !== none.state,
      JSON.stringify({ unscanned, none, many }));
    check('pickReviewer 三态话面互不相同',
      one.state !== none.state && none.state !== many.state && many.state !== one.state
      && none.error !== many.error,
      JSON.stringify({ none: none.error, many: many.error }));

    const lnRev = S.dispatchLabelNames({ model: 'grok-4.6', role: '写码', reviewer: 'gpt-5.6-sol' });
    check('label 名含 reviewer/<id>', lnRev.includes('reviewer/gpt-5.6-sol') && lnRev.includes('model/grok-4.6'), JSON.stringify(lnRev));

    const stampCalls = [];
    const stampGh = (a) => {
      stampCalls.push(a.slice());
      if (a[0] === 'label' && a[1] === 'list') return { ok: true, out: JSON.stringify([{ name: 'model/grok-4.6' }, { name: 'type/写码' }]) };
      if (a[0] === 'label' && a[1] === 'create') return { ok: true, out: JSON.stringify({ name: a[2] }) };
      if (a[0] === 'issue' && a[1] === 'edit') return { ok: true, out: '{}' };
      return { ok: false, error: `未预期 ${a.join(' ')}` };
    };
    const stampedRev = S.stampIssueLabels({ issue: '123', model: 'grok-4.6', role: '写码', reviewer: 'gpt-5.6-sol', runGh: stampGh });
    check('dispatch 打标含 reviewer/*',
      stampedRev.ok === true && stampedRev.names.includes('reviewer/gpt-5.6-sol')
      && stampCalls.some(a => a[0] === 'issue' && a.includes('reviewer/gpt-5.6-sol')),
      JSON.stringify({ stampedRev, stampCalls }));

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
    check('pr-sync-labels 抄 reviewer/*（已消歧仍不抄）',
      syncRev.ok === true && syncRev.labels.includes('reviewer/gpt-5.6-sol') && syncRev.labels.includes('model/grok-4.6')
      && !syncRev.labels.includes('已消歧'),
      JSON.stringify(syncRev));

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
    check('pr-sync-labels 只有 reviewer/* → 拒且不调 pr edit',
      onlyRev.ok === false && /model/.test(onlyRev.error) && /type/.test(onlyRev.error)
      && !onlyRevCalls.some(a => a[0] === 'pr' && a[1] === 'edit'),
      JSON.stringify({ onlyRev, onlyRevCalls }));

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
    check('pr-sync-labels 有 model 无 type → 拒且不调 pr edit',
      modelOnly.ok === false && /type/.test(modelOnly.error)
      && !modelOnlyCalls.some(a => a[0] === 'pr' && a[1] === 'edit'),
      JSON.stringify({ modelOnly, modelOnlyCalls }));

    const FAKE_GH3 = path.join(REPO, 'tests', 'fixtures', 'fake-gh.mjs');
    const cliPick = spawnSync(process.execPath, [CLI, 'reviewer-create', '--pr', '42', '--dry-run'], {
      encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH3 },
    });
    const pPick = (() => { try { return JSON.parse((cliPick.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    check('CLI reviewer-create --pr 42 --dry-run 打印出自读选型',
      cliPick.status === 0 && pPick.ok === true && pPick.dryRun === true && pPick.reviewer === 'gpt-5.6-sol' && pPick.reviewerSource === 'label',
      `status=${cliPick.status} ${JSON.stringify(pPick)} stderr=${cliPick.stderr}`);

    const cliNone = spawnSync(process.execPath, [CLI, 'reviewer-create', '--pr', '43', '--dry-run'], {
      encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH3 },
    });
    const pNone = (() => { try { return JSON.parse((cliNone.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    check('CLI reviewer-create 没有 reviewer/* → 非 0 且话面是「没有」',
      cliNone.status !== 0 && /没有 reviewer/.test(String(pNone.error || '')),
      `status=${cliNone.status} ${JSON.stringify(pNone)}`);

    const cliMany = spawnSync(process.execPath, [CLI, 'reviewer-create', '--pr', '44', '--dry-run'], {
      encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH3 },
    });
    const pMany = (() => { try { return JSON.parse((cliMany.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    check('CLI reviewer-create 有多个 reviewer/* → 非 0 且话面是「多个」',
      cliMany.status !== 0 && /多个 reviewer/.test(String(pMany.error || '')),
      `status=${cliMany.status} ${JSON.stringify(pMany)}`);
    check('CLI 没有 / 多个 话面不同', String(pNone.error || '') !== String(pMany.error || ''));

    check('worker-done 已登记进 VERBS', S.VERBS.includes('worker-done'), S.VERBS.join(','));
    const wdHelp = spawnSync(process.execPath, [CLI, 'worker-done', '--help'], { encoding: 'utf8', cwd: REPO });
    check('worker-done 出现在 help', /worker-done/.test(wdHelp.stdout || ''), (wdHelp.stdout || '').slice(0, 200));
    const wdMiss = spawnSync(process.execPath, [CLI, 'worker-done'], { encoding: 'utf8', cwd: REPO });
    const pWdMiss = (() => { try { return JSON.parse(wdMiss.stdout || '{}'); } catch { return {}; } })();
    check('worker-done 缺 --pr → 非零', wdMiss.status !== 0 && /--pr/.test(String(pWdMiss.error || wdMiss.stderr || '')), JSON.stringify(pWdMiss));

    const cliWd = spawnSync(process.execPath, [CLI, 'worker-done', '--pr', '42', '--dry-run'], {
      encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH3 },
    });
    const pWd = (() => { try { return JSON.parse((cliWd.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    check('CLI worker-done --dry-run 自读选型且调 reviewer-create --dry-run',
      cliWd.status === 0 && pWd.ok === true && pWd.wired === false && pWd.reviewer === 'gpt-5.6-sol'
      && pWd.reviewerCreate && pWd.reviewerCreate.invoked === true && pWd.reviewerCreate.dryRun === true
      && pWd.reviewerCreate.reviewer === 'gpt-5.6-sol'
      && /^完工/.test(pWd.comment || ''),
      `status=${cliWd.status} ${JSON.stringify(pWd)}`);

    const cliWdLive = spawnSync(process.execPath, [CLI, 'worker-done', '--pr', '42'], {
      encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH3 },
    });
    const pWdLive = (() => { try { return JSON.parse((cliWdLive.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    check('CLI worker-done 发 issue+PR 完工 comment，调 reviewer-create 但不建树',
      cliWdLive.status === 0 && pWdLive.commentPosted === true && pWdLive.wired === false
      && pWdLive.postedIssue && pWdLive.postedPr
      && pWdLive.reviewerCreate && pWdLive.reviewerCreate.invoked === true && pWdLive.reviewerCreate.dryRun === true,
      `status=${cliWdLive.status} ${JSON.stringify(pWdLive)}`);

    const badBody = S.planWorkerDone({
      pr: '42',
      body: '已完成：漏了首行关键字',
      runGh: (a) => {
        if (a[0] === 'pr' && a[1] === 'view') return { ok: true, out: JSON.stringify({ title: 'x', body: 'Closes #565' }) };
        if (a[0] === 'issue' && a[1] === 'view') return { ok: true, out: JSON.stringify({ labels: [{ name: 'reviewer/gpt-5.6-sol' }] }) };
        return { ok: false, error: `未预期 ${a.join(' ')}` };
      },
    });
    check('worker-done --body 不以「完工」开头 → 拒', badBody.ok === false && /完工/.test(badBody.error), JSON.stringify(badBody));

    const daoSrc586 = fs.readFileSync(CLI, 'utf8');
    check('#586 不重写 reviewer-create 既有坑：仍走 assessPrMergeable + trialMergeMaster',
      /function cmdReviewerCreate[\s\S]*assessPrMergeable/.test(daoSrc586)
      && /function cmdReviewerCreate[\s\S]*trialMergeMaster/.test(daoSrc586));
    const wdFn = (daoSrc586.match(/function cmdWorkerDone\([\s\S]*?\n\}/) || [''])[0];
    check('#586 worker-done 不调用 orca 建树',
      /function cmdWorkerDone/.test(wdFn) && !/argsWorktreeCreate|worktree create/.test(wdFn),
      wdFn.slice(0, 200));
  }


  console.log('\n=== #565 追加：注入后开工验证 = 轮询 + 命中 Pasted Content 自动补回车救活 ===');
  {
    const MARKER = '› [Pasted Content 7383 chars]\n';
    const CLEAN = '短摘要：修命令库\nThinking...\n';
    const LOADING = 'Starting MCP servers (0/5)\n';
    const unproven = () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'no_hook_report' });
    const noopSleep = () => {};

    // A. 快路径：worker-read 官方开工证明（paste 自动提交，没看见 marker）→ started，不带 enter。
    const a = S.verifyInjectionPolling({
      dispatchId: 'ctx_a',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [LOADING] } } }),
      sendEnter: () => { throw new Error('不该发回车'); },
      proofOnce: () => ({ ok: true, proven: true, source: 'transcript' }),
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    check('轮询：worker-read 证明（transcript）→ started（不带 enter）', a.ok === true && a.state === 'started' && a.enter === null, JSON.stringify(a));

    // B. 故意造 Pasted Content 残留 → 自动补回车 → 重读消失 = startedAfterEnter（救活留痕）。
    let enterCalls = 0;
    let readsB = 0;
    const b = S.verifyInjectionPolling({
      dispatchId: 'ctx_b',
      readOnce: () => {
        readsB++;
        return readsB === 1
          ? { ok: true, result: { terminal: { tail: [MARKER] } } }
          : { ok: true, result: { terminal: { tail: [CLEAN] } } };
      },
      sendEnter: () => { enterCalls++; return { ok: true }; },
      proofOnce: unproven,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    check('故意残留：命中 Pasted Content 自动补回车救活 → startedAfterEnter', b.ok === true && b.state === 'startedAfterEnter' && b.enter && b.enter.ok === true, JSON.stringify(b));
    check('故意残留：补回车只发一次（enter 留痕）', enterCalls === 1, `enterCalls=${enterCalls}`);

    // C. 真失败：补回车后 marker 仍在 = 回滚信号（仍在才回滚，处置代价与判据对称）。
    const c = S.verifyInjectionPolling({
      dispatchId: 'ctx_c',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [MARKER] } } }),
      sendEnter: () => ({ ok: true }),
      proofOnce: unproven,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    check('补回车后 marker 仍在 → failed，reason 点名「仍停在输入框」', c.ok === false && c.state === 'failed' && /仍停在输入框/.test(c.reason), JSON.stringify(c));

    // D. TUI 加载期（非空无 marker）不得判绿——时序 bug 回归钉（#565 实测现场：MCP servers 0/5）。
    const d = S.verifyInjectionPolling({
      dispatchId: 'ctx_d',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [LOADING] } } }),
      sendEnter: () => ({ ok: true }),
      proofOnce: unproven,
      timeoutMs: 60, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    check('TUI 加载期（非空无 marker）不算开工 → 超时 failed（时序 bug 回归钉）', d.ok === false && d.state === 'failed' && /超时/.test(d.reason), JSON.stringify(d));

    // E. 全程没读成：不许当「没查成=没开工」以外的东西（scanned 与 unscanned 分开）。
    const e = S.verifyInjectionPolling({
      dispatchId: 'ctx_e',
      readOnce: () => ({ error: 'terminal read timeout' }),
      sendEnter: () => ({ ok: true }),
      proofOnce: unproven,
      timeoutMs: 60, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    check('全程没读成 → 超时 failed 且带 unscanned（没查成 ≠ 查过没事）', e.ok === false && e.unscanned && e.unscanned.unscanned === true, JSON.stringify(e));

    // F. 回车没送出去且 marker 仍在：reason 说得出「没送出去」，不许伪装成「补了没救活」。
    const f = S.verifyInjectionPolling({
      dispatchId: 'ctx_f',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [MARKER] } } }),
      sendEnter: () => ({ ok: false, error: 'orca terminal send 失败' }),
      proofOnce: unproven,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    check('回车没送出去且 marker 仍在 → failed，reason 说得出「没送出去」', f.ok === false && /没送出去/.test(f.reason), JSON.stringify(f));

    // G. #568 回归钉：pi 工人正常提交 = proof 恒 false（provider_unsupported）+ 全程无 marker + 屏面稳定 → 判绿。
    // 这是最常见的成功路径（#568 之前唯一没被测的）；修法 = proof 不可用时降级到屏面连续稳定轮。
    const g = S.verifyInjectionPolling({
      dispatchId: 'ctx_g',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [CLEAN] } } }),
      sendEnter: () => { throw new Error('不该发回车'); },
      proofOnce: () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'provider_unsupported' }),
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    check('pi 正常提交：proof 恒 false + 全程无 marker → 连续稳定轮判绿 started（proofFallback 留痕）',
      g.ok === true && g.state === 'started' && g.enter === null && g.proofFallback === true && g.stableRounds >= 3, JSON.stringify(g));
    check('pi 正常提交：不该发回车', true, '（sendEnter 抛错但没被调 = 该路径不发回车）');

    // H. pi 正常提交但开头有加载期：加载指纹轮不计稳定、清零，加载结束后连续稳定才判绿。
    let readsH = 0;
    const h = S.verifyInjectionPolling({
      dispatchId: 'ctx_h',
      readOnce: () => {
        readsH++;
        return { ok: true, result: { terminal: { tail: [readsH <= 4 ? LOADING : CLEAN] } } };
      },
      sendEnter: () => { throw new Error('不该发回车'); },
      proofOnce: () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'session_not_reported' }),
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    check('pi 正常提交带加载开头：加载期不算绿，加载结束后连续稳定才判绿',
      h.ok === true && h.state === 'started' && h.proofFallback === true && h.stableRounds >= 3 && readsH >= 7, JSON.stringify(h));

    // I. 加载指纹凑不满稳定轮但没到稳定阈值就超时：仍 failed（防误判意图保留，不许因为加了降级路就把加载期判绿）。
    let readsI = 0;
    const i = S.verifyInjectionPolling({
      dispatchId: 'ctx_i',
      readOnce: () => {
        readsI++;
        // 加载态后只稳定 1 轮就回到加载态：稳定轮永远攒不满。
        return { ok: true, result: { terminal: { tail: [readsI % 2 === 1 ? LOADING : CLEAN] } } };
      },
      sendEnter: () => ({ ok: true }),
      proofOnce: () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'provider_unsupported' }),
      timeoutMs: 60, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    check('加载指纹被清零：稳定 1 轮又回加载态 → 攒不满降级条件 → 超时 failed',
      i.ok === false && i.state === 'failed' && i.stableRounds < 3 && /超时/.test(i.reason), JSON.stringify(i));

    // J. proof 不可用但全程空屏：不许按屏面判绿（空屏 ≠ 已提交）。
    const j = S.verifyInjectionPolling({
      dispatchId: 'ctx_j',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [] } } }),
      sendEnter: () => ({ ok: true }),
      proofOnce: () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'provider_unsupported' }),
      timeoutMs: 60, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    check('proof 不可用 + 空屏 → 不许判绿（空屏 ≠ 已提交），超时 failed',
      j.ok === false && j.state === 'failed' && /超时/.test(j.reason), JSON.stringify(j));

    // wiring：dao.mjs 工人与审官两处注入验证都走轮询（#565 追加第 5 条）。
    const daoSrcPoll = fs.readFileSync(CLI, 'utf8');
    check('dao.mjs 工人/审官注入验证两处都走 verifyInjectionPolling', (daoSrcPoll.match(/verifyInjectionPolling\(\{/g) || []).length >= 2, daoSrcPoll.slice(0, 80));
    check('#575 ④ reviewer-attach 也走 verifyInjectionPolling（不另写一份）',
      (daoSrcPoll.match(/verifyInjectionPolling\(\{/g) || []).length >= 3
      && /function cmdReviewerAttach/.test(daoSrcPoll));

    // 连带验收：6000+ 字符任务书折在输入框 → 自动补回车留痕；仍在 → fail-visible。
    const LONG = `› [Pasted Content ${'x'.repeat(6000).length} chars]\n`;
    let enterLong = 0;
    let readsLong = 0;
    const longOk = S.verifyInjectionPolling({
      dispatchId: 'ctx_long',
      readOnce: () => {
        readsLong++;
        return readsLong === 1
          ? { ok: true, result: { terminal: { tail: [LONG] } } }
          : { ok: true, result: { terminal: { tail: ['审官已开工\n'] } } };
      },
      sendEnter: () => { enterLong++; return { ok: true }; },
      proofOnce: unproven,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    check('#575 ④ 6000+ 字符 Pasted Content → 自动补回车 startedAfterEnter',
      longOk.ok === true && longOk.state === 'startedAfterEnter' && enterLong === 1, JSON.stringify(longOk));
    const longFail = S.verifyInjectionPolling({
      dispatchId: 'ctx_long_fail',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [LONG] } } }),
      sendEnter: () => ({ ok: true }),
      proofOnce: unproven,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    check('#575 ④ 6000+ 字符补回车后仍在 → failed 不许静默成功',
      longFail.ok === false && longFail.state === 'failed' && /仍停在输入框/.test(longFail.reason), JSON.stringify(longFail));
  }

  console.log('\n=== R1 R3 R4 R6 探针 / 未知参数 / 读失败分态 / 回滚 ===');
  {
    const allOk = S.runCapabilityProbes({ exec: (n) => ({ ok: true, name: n }) });
    check('R1 三项探针都过', allOk.ok === true && allOk.failed.length === 0, JSON.stringify(allOk));
    const noWrite = S.runCapabilityProbes({ exec: (n) => ({ ok: n !== 'write' }) });
    check('R1 不能写文件 → 点名缺能写文件', noWrite.ok === false && noWrite.failed.includes('write') && /能写文件/.test(noWrite.error), JSON.stringify(noWrite));
    const noNode = S.runCapabilityProbes({ exec: (n) => ({ ok: n !== 'node' }) });
    check('R1 不能跑 node → 点名缺能跑 node', noNode.ok === false && /能跑 node/.test(noNode.error), JSON.stringify(noNode));
    const noGh = S.runCapabilityProbes({ exec: (n) => ({ ok: n !== 'gh' }) });
    check('R1 不能调 gh → 点名缺能调 gh', noGh.ok === false && /能调 gh/.test(noGh.error), JSON.stringify(noGh));

    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-empty-'));
    const hostOnEmpty = S.runCapabilityProbes({ exec: S.hostProbeExec(emptyDir) });
    check('判别力：空目录上 hostProbe 仍绿（验错主体）', hostOnEmpty.ok === true, JSON.stringify(hostOnEmpty));
    const termEmpty = S.runCapabilityProbes({
      exec: S.terminalProbeExec({ sendAndRead: () => ({ text: 'Working...' }) }),
    });
    check('R1 终端无真执行标记 → 探针红', termEmpty.ok === false && termEmpty.failed.length === 3, JSON.stringify(termEmpty));

    const echoOnly = S.runCapabilityProbes({
      exec: S.terminalProbeExec({
        sendAndRead: (cmd) => ({ text: `• Ran ${cmd}\nrejected: blocked by policy` }),
      }),
    });
    check('R1 命令回显+policy 拦 → 三项都红（自证不绿）', echoOnly.ok === false && echoOnly.failed.length === 3, JSON.stringify(echoOnly));

    const corpus = '• Ran gh --version\nrejected: blocked by policy';
    check('R1 帅语料：Ran gh --version + blocked by policy ≠ 能调 gh', S.probeMarkFound('gh', corpus) === false);

    for (const name of ['write', 'node', 'gh']) {
      check(`R1 命令原文不含 ${name} 真执行标记`, S.probeMarkFound(name, S.probeCommand(name)) === false, S.probeCommand(name));
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
    check('R1 真执行标记出现 → 三项过', termOk.ok === true, JSON.stringify(termOk));
    check('R1 写/node/gh 标记互相独立', S.probeMarkFound('write', 'N1734123456789') === false && S.probeMarkFound('gh', 'W1734123456789') === false);

    check('R1 写探针命令含 finally+unlink', /finally/.test(S.probeCommand('write')) && /unlinkSync/.test(S.probeCommand('write')), S.probeCommand('write'));
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
    check('R1 写探针真跑出发标记', ran.status === 0 && S.probeMarkFound('write', ran.stdout || ''), ran.stdout);
    check('R1 写探针跑完探测文件不在', fs.existsSync(path.join(probeRepo, S.WRITE_PROBE_FILE)) === false);
    const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: probeRepo, encoding: 'utf8' });
    check('R1 写探针跑完 git status 无新增', String(dirty.stdout || '').trim() === '', dirty.stdout);
    check('R1 残留探测文件会被当成产出（所以必须清）', S.isWorkFile(S.WRITE_PROBE_FILE) === true);

    const unreadProbe = S.terminalProbeExec({ sendAndRead: () => ({ error: 'terminal_handle_stale' }) })('write');
    check('R1 终端没读成 ≠ 探针绿', unreadProbe.ok === false && unreadProbe.unread === true, JSON.stringify(unreadProbe));
    const daoSrc = fs.readFileSync(CLI, 'utf8');
    check('#546 dao.mjs 环境自检走 envProbeWorktree，不经 agent 探针', /envProbeWorktree/.test(daoSrc) && !/terminalProbeExec/.test(daoSrc) && !/runTerminalProbes/.test(daoSrc));
    check('#546 审官卡带 baseBranch 且建完自证', /baseBranch: workerBranch\.branch/.test(daoSrc) && /verifyReviewerTree/.test(daoSrc));
    check('#546 注入后验开工走 verifyInjection', /verifyInjection/.test(daoSrc) && !/DAO_PROBE_/.test(daoSrc));
    check('R1 dao.mjs 不再裸调 worktree show', !/orca\(\['worktree', 'show'/.test(daoSrc));
    check('#495 dao.mjs 派工成功后写任务卡 comment 定界区', /afterDispatchComment/.test(daoSrc));
    check('#502 取 taskId 走 extractTaskId 不猜 result.id', /extractTaskId/.test(daoSrc) && !/result\?\.id/.test(daoSrc));
    check('#502 未绑 Run 报 run-create/run-use', /RUN_REQUIRED_HINT/.test(daoSrc) && /run-create/.test(S.RUN_REQUIRED_HINT));
    check('#495 dao.mjs 不走终端 rename', !/afterDispatchSuccess/.test(daoSrc) && !/terminal', 'rename'/.test(daoSrc));
    check('#559 waitAndVerify 超时按 provider 的 probe_wait_ms（不再 8s 硬编码）', /probeWaitMs\(routing, workerLaunch\.provider\)/.test(daoSrc) && /probeWaitMs\(routing, reviewerLaunch\.provider\)/.test(daoSrc), 'waitAndVerify 要按 provider 覆盖 timeoutMs');
    check('#559 waitAndVerify 默认超时不再是 8000ms', !/timeoutMs = 8000/.test(fs.readFileSync(LIB, 'utf8')));
    check('grok 表上 probe_wait_ms=45000', S.probeWaitMs(routing, 'grok') === 45000, String(S.probeWaitMs(routing, 'grok')));
    check('gpt 表上 probe_wait_ms=120000', S.probeWaitMs(routing, 'gpt') === 120000, String(S.probeWaitMs(routing, 'gpt')));
    check('没配的 provider 回落默认', S.probeWaitMs(routing, 'claude') === S.DEFAULT_PROBE_WAIT_MS);
    check('缺字段 / 非法值回落默认', S.probeWaitMs({ providers: { x: {} } }, 'x') === 120000 && S.probeWaitMs({ providers: { x: { probe_wait_ms: -1 } } }, 'x') === 120000);
    const unread = S.verifyStarted({ error: 'terminal_handle_stale' });
    check('R4 没读成 ≠ 读了是空的', unread.reason === '没读成' && unread.unscanned === true, JSON.stringify(unread));
    const empty = S.verifyStarted({ text: '' });
    check('R4 读了是空的', empty.reason === '读了是空的' && empty.unscanned === false, JSON.stringify(empty));
    const unreadWait = S.waitAndVerify({
      readOnce: () => ({ error: 'boom' }),
      timeoutMs: 5000,
      intervalMs: 10,
      sleep: () => { throw new Error('unread 不该再睡'); },
    });
    check('R4 没读成立即返回（不等满超时）', unreadWait.reason === '没读成', JSON.stringify(unreadWait));

    const badStart = spawnSync(process.execPath, [
      CLI, 'start', '--provider', 'gpt', '--worktree', 'active', '--dry-run', '--submit', 'yes',
    ], { encoding: 'utf8', cwd: REPO });
    const badText = `${badStart.stdout || ''}${badStart.stderr || ''}`;
    check('R3 --submit 被 CLI 拦住非零', badStart.status !== 0, `status=${badStart.status} ${badText}`);
    check('R3 打印未知参数 --submit', /未知参数: --submit/.test(badText), badText);

    const badSandbox = spawnSync(process.execPath, [
      CLI, 'dispatch', '--name', 'x', '--merge-policy', 'auto', '--model', 'grok-4.6',
      '--reviewer', 'gpt-5.6-sol', '--spec', '短摘要', '--dry-run', '--sandbox', 'danger-full-access',
    ], { encoding: 'utf8', cwd: REPO });
    const sandText = `${badSandbox.stdout || ''}${badSandbox.stderr || ''}`;
    check('R3 --sandbox 不再被静默吞掉', badSandbox.status !== 0 && /未知参数: --sandbox/.test(sandText), sandText);

    check('R3 VERBS 与 FLAGS_BY_VERB 齐（除 raw）', S.verbFlagGaps().length === 0, S.verbFlagGaps().join(','));
    check('R3 缺 FLAGS 条目能被发现', S.verbFlagGaps(['start', 'newverb']).includes('newverb'));
    const saved = S.FLAGS_BY_VERB.start;
    delete S.FLAGS_BY_VERB.start;
    let gapThrew = false;
    try { S.parseArgs(['node', 'dao.mjs', 'start', '--submit', 'yes']); }
    catch (e) { gapThrew = /没登记参数表/.test(String(e.message || e)); }
    S.FLAGS_BY_VERB.start = saved;
    check('R3 动词没登记参数表 → 抛（不许静默回落）', gapThrew);

    const steps = S.planDispatchRollback({
      workerId: 'w1', workerHandle: 'th1', reviewerId: 'r1', reviewerHandle: 'rh1',
    });
    check('R6 回滚先关审官终端', steps[0] && steps[0].includes('--terminal') && steps[0].includes('rh1'), JSON.stringify(steps));
    check('R6 回滚最后删工人卡', steps[steps.length - 1] && steps[steps.length - 1].includes('worktree') && steps[steps.length - 1].includes('w1'), JSON.stringify(steps));
    check('R6 什么都没建 → 回滚空', S.planDispatchRollback({}).length === 0);
    const rbOk = S.rollbackReport([{ cmd: 'terminal close x --tab', ok: true }]);
    check('R6 回滚全成功 → 不叫', rbOk.rollbackFailed === false && rbOk.alarm == null, JSON.stringify(rbOk));
    const rbGone = S.rollbackReport([
      { cmd: 'terminal close th1 --tab', ok: false, error: 'tab_not_found' },
      { cmd: 'worktree rm w1 --force', ok: true },
    ]);
    check('R6 tab_not_found = 目标已不在，不算回滚失败', rbGone.rollbackFailed === false, JSON.stringify(rbGone));
    const closeFx = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'orca-json', 'close-tab-not-found.json'), 'utf8'));
    check('R6 真 tab_not_found 夹具判已不在', S.rollbackErrorAlreadyGone(closeFx.error) === true, JSON.stringify(closeFx.error));
    const rbFail = S.rollbackReport([
      { cmd: 'terminal close th1 --tab', ok: false, error: 'permission denied' },
    ]);
    check('R6 真正清理失败单独可见', rbFail.rollbackFailed === true && /孤儿/.test(rbFail.alarm) && /permission denied/.test(rbFail.alarm), JSON.stringify(rbFail));
    check('R6 run_required 能认出', S.isRunRequired({ code: 'run_required', message: 'No Run is bound' }) === true);
    check('R6 普通错误不是 run_required', S.isRunRequired('tab_not_found') === false);
  }

  console.log('\n=== 编排 builder / 逃生口 ===');
  {
    const wt = S.argsWorktreeCreate({ name: 'x', noParent: true, setup: 'skip' });
    check('worktree create 带 --no-parent --setup --json', wt.includes('--no-parent') && wt.includes('--setup') && wt.includes('--json'));
    const wtIssue = S.argsWorktreeCreate({ name: '修地基', issue: 559 });
    check('#559 追加：worktree create 带 --issue 透传', wtIssue.includes('--issue') && wtIssue[wtIssue.indexOf('--issue') + 1] === '559', wtIssue.join(' '));
    check('#559 追加：assembleCardName 拼 #<issue> - <动宾短语>', S.assembleCardName({ name: '修地基', issue: 559 }) === '#559 - 修地基', S.assembleCardName({ name: '修地基', issue: 559 }));
    check('#559 追加：assembleCardName 幂等（name 已带 #N 前缀）', S.assembleCardName({ name: '#559 - 修地基', issue: 559 }) === '#559 - 修地基', S.assembleCardName({ name: '#559 - 修地基', issue: 559 }));
    check('#559 追加：assembleCardName 子卡 = #N - 审官·模型', S.assembleCardName({ name: S.reviewerCardName('gpt-5.6-sol'), issue: 559 }) === '#559 - 审官·gpt-5.6-sol');
    check('#559 追加：没给 issue 原样返回', S.assembleCardName({ name: '审读 #505' }) === '审读 #505' && S.assembleCardName({ name: 'x' }) === 'x');
    const ws = S.argsWorkerStart({ task: 't', worktree: 'w', terminal: 'h' });
    check('worker-start 用 --terminal 不用 --agent', ws.includes('--terminal') && !ws.includes('--agent'));
    const wsContinue = S.argsWorkerStart({ task: 't', terminal: 'h' });
    check('#559 续 Dispatch：worker-start 可只给 --task + --terminal（不带 --worktree）', wsContinue.includes('--task') && wsContinue.includes('--terminal') && !wsContinue.includes('--worktree'), wsContinue.join(' '));
    const wsRetry = S.argsWorkerStart({ task: 't', terminal: 'h', retryOf: 'ctx_old' });
    check('#559 换人：worker-start --retry-of 透传旧 dispatch id', wsRetry.includes('--retry-of') && wsRetry[wsRetry.indexOf('--retry-of') + 1] === 'ctx_old', wsRetry.join(' '));
    const parsedContinue = S.parseArgs(['node', 'dao.mjs', 'worker-start', '--task', 't', '--terminal', 'h', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol']);
    check('#559 续 Dispatch：CLI 收 --task+--terminal 不带 --worktree', parsedContinue.task === 't' && parsedContinue.terminal === 'h' && parsedContinue.worktree === undefined, JSON.stringify(parsedContinue));

    check('#559 ③ reply 已登记进 VERBS', S.VERBS.includes('reply'), S.VERBS.join(','));
    const replyArgs = S.argsOrchestrationReply({ id: 'msg_q1', body: '可以' });
    check('reply 拼 --id + --body', replyArgs.includes('--id') && replyArgs[replyArgs.indexOf('--id') + 1] === 'msg_q1' && replyArgs[replyArgs.indexOf('--body') + 1] === '可以', replyArgs.join(' '));
    const replyParsed = S.parseArgs(['node', 'dao.mjs', 'reply', '--id', 'msg_q1', '--body', '可以']);
    check('CLI 收 reply --id/--body', replyParsed.id === 'msg_q1' && replyParsed.body === '可以', JSON.stringify(replyParsed));

    check('#559 ④ gate-create/gate-resolve/gate-list 已登记进 VERBS', S.VERBS.includes('gate-create') && S.VERBS.includes('gate-resolve') && S.VERBS.includes('gate-list'), S.VERBS.join(','));
    const gc = S.argsGateCreate({ task: 'task_x', question: '乒乓两轮仍红，换人？', options: '["换","不换"]' });
    check('gate-create 拼 --task/--question/--options', gc.includes('--task') && gc.includes('--question') && gc.includes('--options'), gc.join(' '));
    const gr = S.argsGateResolve({ id: 'gate_x', resolution: '换' });
    check('gate-resolve 拼 --id/--resolution', gr.includes('--id') && gr[gr.indexOf('--resolution') + 1] === '换', gr.join(' '));
    const gl = S.argsGateList({ task: 'task_x', status: 'pending' });
    check('gate-list 拼 --task/--status', gl.includes('--task') && gl.includes('--status'), gl.join(' '));
    const gateParsed = S.parseArgs(['node', 'dao.mjs', 'gate-resolve', '--id', 'gate_x', '--resolution', '换']);
    check('CLI 收 gate-resolve --id/--resolution', gateParsed.id === 'gate_x' && gateParsed.resolution === '换', JSON.stringify(gateParsed));

    check('#559 ⑤ worker-release 已登记进 VERBS', S.VERBS.includes('worker-release'), S.VERBS.join(','));
    const wr = S.argsWorkerRelease({ dispatch: 'ctx_x' });
    check('worker-release 拼 --dispatch', wr.includes('--dispatch') && wr[wr.indexOf('--dispatch') + 1] === 'ctx_x', wr.join(' '));
    const wrParsed = S.parseArgs(['node', 'dao.mjs', 'worker-release', '--dispatch', 'ctx_x']);
    check('CLI 收 worker-release --dispatch', wrParsed.dispatch === 'ctx_x', JSON.stringify(wrParsed));

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-escape-'));
    const log = path.join(tmp, 'cmd-escape.jsonl');
    S.recordEscape({ argv: ['orca', 'foo', '--submit'], ts: '2026-08-15T00:00:00.000Z', cwd: tmp }, log);
    const line = fs.readFileSync(log, 'utf8').trim();
    const rec = JSON.parse(line);
    check('逃生口写下命令', rec.argv[2] === '--submit' && rec.argv[0] === 'orca', line);
    check('逃生口有时间戳', rec.ts === '2026-08-15T00:00:00.000Z');

    const raw = spawnSync(process.execPath, [CLI, 'raw', '--', process.execPath, '-e', 'process.exit(0)'], {
      encoding: 'utf8', cwd: REPO,
    });
    check('dao raw 退出跟随子进程', raw.status === 0, raw.stderr || raw.stdout);
    check('dao raw 在 stderr 留痕', /已记账/.test(raw.stderr || ''), raw.stderr);

    const rawJson = spawnSync(process.execPath, [CLI, 'raw', '--', process.execPath, '-e', 'console.log(JSON.stringify({ok:true,id:"t575"}))'], {
      encoding: 'utf8', cwd: REPO,
    });
    let parsedRaw = null;
    try { parsedRaw = JSON.parse(rawJson.stdout); } catch { parsedRaw = null; }
    check('#575 ② dao raw stdout 可直接 JSON.parse（记账不污染 stdout）',
      parsedRaw && parsedRaw.ok === true && parsedRaw.id === 't575', rawJson.stdout);
    check('#575 ② 记账行在 stderr 不在 stdout',
      /已记账/.test(rawJson.stderr || '') && !/已记账/.test(rawJson.stdout || ''),
      `stdout=${rawJson.stdout} stderr=${rawJson.stderr}`);

    const rawSpec = spawnSync(process.execPath, [
      CLI, 'raw', '--', process.execPath, '-e', 'console.log(JSON.stringify({ok:true}))',
    ], { encoding: 'utf8', cwd: REPO });
    let parsedSpec = null;
    try { parsedSpec = JSON.parse(rawSpec.stdout); } catch { parsedSpec = null; }
    check('#575 ② 子进程 JSON 不被多行记账拆碎', parsedSpec && parsedSpec.ok === true, rawSpec.stdout);

    check('#575 ④ reviewer-attach 已登记进 VERBS', S.VERBS.includes('reviewer-attach'), S.VERBS.join(','));
    const attachHelp = spawnSync(process.execPath, [CLI, 'reviewer-attach', '--help'], { encoding: 'utf8', cwd: REPO });
    check('reviewer-attach 出现在 help', /reviewer-attach/.test(attachHelp.stdout || ''), (attachHelp.stdout || '').slice(0, 200));
    const attachMiss = spawnSync(process.execPath, [CLI, 'reviewer-attach'], { encoding: 'utf8', cwd: REPO });
    const pAttach = (() => { try { return JSON.parse(attachMiss.stdout || '{}'); } catch { return {}; } })();
    check('reviewer-attach 缺 --pr → 非零', attachMiss.status !== 0 && /--pr/.test(String(pAttach.error || attachMiss.stderr || '')), JSON.stringify(pAttach));
    const attachMissWt = spawnSync(process.execPath, [CLI, 'reviewer-attach', '--pr', '1'], { encoding: 'utf8', cwd: REPO });
    const pAttachWt = (() => { try { return JSON.parse(attachMissWt.stdout || '{}'); } catch { return {}; } })();
    check('reviewer-attach 缺 --worktree → 非零', attachMissWt.status !== 0 && /--worktree/.test(String(pAttachWt.error || attachMissWt.stderr || '')), JSON.stringify(pAttachWt));
    const attachMissRev = spawnSync(process.execPath, [CLI, 'reviewer-attach', '--pr', '1', '--worktree', 'w'], { encoding: 'utf8', cwd: REPO });
    const pAttachRev = (() => { try { return JSON.parse(attachMissRev.stdout || '{}'); } catch { return {}; } })();
    check('reviewer-attach 缺 --reviewer → 非零', attachMissRev.status !== 0 && /--reviewer/.test(String(pAttachRev.error || attachMissRev.stderr || '')), JSON.stringify(pAttachRev));

    const wlFx = { result: { workers: [
      { dispatchId: 'ctx_live', workerState: 'working', dispatchStatus: 'running', resource: { worktreeId: 'repo::C:/wt/worker' } },
      { dispatchId: 'ctx_old', workerState: 'succeeded', dispatchStatus: 'completed', resource: { worktreeId: 'repo::C:/wt/worker' } },
    ] } };
    const foundLive = S.findDispatchForWorktree(wlFx, 'repo::C:/wt/worker');
    check('findDispatchForWorktree 优先活着的 dispatch', foundLive.ok && foundLive.dispatchId === 'ctx_live', JSON.stringify(foundLive));
    const foundMiss = S.findDispatchForWorktree(wlFx, 'no-such-tree');
    check('findDispatchForWorktree 查到 0 条不是没查成', foundMiss.ok === false && !foundMiss.unscanned && foundMiss.scanned === 2, JSON.stringify(foundMiss));
    const foundBad = S.findDispatchForWorktree({ result: {} }, 'x');
    check('findDispatchForWorktree 结构不认识 → unscanned', foundBad.ok === false && foundBad.unscanned === true, JSON.stringify(foundBad));
  }

  console.log('\n=== 真语料：orca --json 存档必须能被解析函数吃下（#499）===');
  {
    const fx = (name) => JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'orca-json', name), 'utf8'));
    const readLive = fx('terminal-read.json');
    const createLive = fx('terminal-create.json');
    const wtLive = fx('worktree-create.json');

    check('terminal-read 信封是真 orca 形（ok + result.terminal.tail）',
      readLive.ok === true && Array.isArray(readLive.result?.terminal?.tail) && readLive.result.terminal.tail.length > 0,
      JSON.stringify(Object.keys(readLive.result || {})));

    const extracted = S.extractTerminalText(readLive);
    check('真 terminal read → extractTerminalText 非空', String(extracted).trim().length > 0, `len=${String(extracted).length}`);
    check('真 terminal read 含屏面原文', /Grok 4\.6/.test(extracted), extracted.slice(0, 160));
    const started = S.verifyStarted(readLive);
    check('真 terminal read → verifyStarted 过', started.ok === true, JSON.stringify({ ok: started.ok, reason: started.reason, len: String(started.text || '').length }));

    check('真 terminal create → extractHandleFromCreate',
      S.extractHandleFromCreate(createLive) === 'term_a106c2c9-62cc-440b-afde-0b9416ffb630');
    check('真 worktree create → extractWorktreeId',
      S.extractWorktreeId(wtLive) === '1770a430-983a-4e86-9277-9f1e5c376b83::C:/Users/Administrator/orca/workspaces/windsurf-dao/_fixture-499-delete-me');
    check('真 worktree create → extractWorktreePath',
      S.extractWorktreePath(wtLive) === 'C:/Users/Administrator/orca/workspaces/windsurf-dao/_fixture-499-delete-me');

    const sendLive = fx('terminal-send.json');
    const sent = S.extractTerminalSend(sendLive);
    check('真 terminal send --json → extractTerminalSend accepted', sent && sent.accepted === true && sent.bytesWritten === 9, JSON.stringify(sent));

    const taskLive = fx('task-create.json');
    check('真 task-create → extractTaskId 走 result.task.id',
      S.extractTaskId(taskLive) === 'task_72992e47f0f4');
    check('真 task-create 顶层 id 不是 taskId',
      taskLive.id !== S.extractTaskId(taskLive) && taskLive.result.id === undefined);
    check('旧路径 result.id / 顶层 id 都取不到',
      S.extractTaskId({ id: 'rpc', result: { id: 'rpc2' } }) === null);
  }

  console.log('\n=== #546 #541 审官树自证 / 注入后开工 / 环境自检 ===');
  {
    const folded = S.verifyInjection({ text: '⚠ MCP failed\n[Pasted Content 4686 chars]\n›' });
    check('故意违规：Pasted Content 折叠 → 注入验证红', folded.ok === false && /Pasted Content/.test(folded.reason), JSON.stringify(folded));
    check('折叠证据带字符数', folded.evidence === '[Pasted Content 4686 chars]', JSON.stringify(folded));
    const unreadInj = S.verifyInjection({ readError: 'terminal_handle_stale' });
    check('注入后没读成 ≠ 已开工', unreadInj.ok === false && unreadInj.unscanned === true, JSON.stringify(unreadInj));
    const emptyInj = S.verifyInjection({ text: '   ' });
    check('注入后屏面空 → 红', emptyInj.ok === false && /空/.test(emptyInj.reason), JSON.stringify(emptyInj));
    const landed = S.verifyInjection({ text: '短摘要：修命令库\nThinking...\n' });
    check('屏上无 Pasted Content → 注入验证绿', landed.ok === true, JSON.stringify(landed));

    // #559 ⑥：判开工优先 worker-read --source auto（官方可证明 transcript 源）
    const provenAuto = S.verifyWorkerStarted({ ok: true, result: { source: 'auto', transcript: { messages: [] } } });
    check('#559 worker-read source=auto → 开工证明绿（官方 transcript 源）', provenAuto.ok === true && provenAuto.proven === true, JSON.stringify(provenAuto));
    const provenTranscript = S.verifyWorkerStarted({ ok: true, result: { source: 'transcript', transcript: { messages: [{ role: 'user', blocks: [] }] } } });
    check('#559 worker-read source=transcript → 同样绿', provenTranscript.ok === true && provenTranscript.proven === true, JSON.stringify(provenTranscript));
    const weakTerminal = S.verifyWorkerStarted({ ok: true, result: { source: 'terminal', fallbackReason: 'no_hook_report', terminal: { tail: [] } } });
    check('#559 worker-read source=terminal → 降级（proven=false，带 fallbackReason）', weakTerminal.ok === false && weakTerminal.proven === false && weakTerminal.fallbackReason === 'no_hook_report', JSON.stringify(weakTerminal));
    const unreadProof = S.verifyWorkerStarted({ ok: false, error: { code: 'dispatch_not_found', message: 'x' } });
    check('#559 worker-read 没读成 → unscanned（不许当成没开工）', unreadProof.ok === false && unreadProof.unscanned === true, JSON.stringify(unreadProof));
    check('#559 worker-read 已登记进 VERBS', S.VERBS.includes('worker-read'), S.VERBS.join(','));
    const wrRead = S.argsWorkerRead({ dispatch: 'ctx_x', source: 'auto', limit: 50 });
    check('worker-read 拼 --dispatch/--source/--limit', wrRead.includes('--source') && wrRead.includes('--limit'), wrRead.join(' '));

    const filesUnscanned = S.verifyReviewerFiles({ reviewerPath: REPO });
    check('#541 没给清单 = 没查成', filesUnscanned.ok === false && filesUnscanned.unscanned === true, JSON.stringify(filesUnscanned));
    const filesEmpty = S.verifyReviewerFiles({ reviewerPath: REPO, files: [] });
    check('#541 空文件清单（PR 尚无改文件）→ 绿', filesEmpty.ok === true && filesEmpty.checked === 0, JSON.stringify(filesEmpty));
    check('#541 parseGhPullFiles 跳过 removed', JSON.stringify(S.parseGhPullFiles([
      { filename: 'a.js', status: 'added' },
      { filename: 'gone.js', status: 'removed' },
    ])) === JSON.stringify(['a.js']));
    const filesOk = S.verifyReviewerFiles({ reviewerPath: REPO, files: ['scripts/dao.mjs', 'scripts/lib/dao-cmd.mjs'] });
    check('#541 被审文件在 → 绿', filesOk.ok === true && filesOk.checked === 2, JSON.stringify(filesOk));
    const filesMiss = S.verifyReviewerFiles({ reviewerPath: REPO, files: ['scripts/dao.mjs', 'this-file-does-not-exist-541.js'] });
    check('#541 缺被审文件 → 红并点名', filesMiss.ok === false && (filesMiss.missing || []).includes('this-file-does-not-exist-541.js'), JSON.stringify(filesMiss));

    const parsed = S.parseDiffNameStatus('M\tscripts/dao.mjs\nA\thost/skills/dispatch/hooks/hooks.json\nD\told.txt\nR100\ta.txt\tb.txt\n');
    check('name-status 收 A/M/R 新名、跳过 D', parsed.includes('scripts/dao.mjs') && parsed.includes('host/skills/dispatch/hooks/hooks.json') && parsed.includes('b.txt') && !parsed.includes('old.txt'), JSON.stringify(parsed));

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
    check('#541 审官 HEAD ≠ 工人 HEAD → 红', mismatch.ok === false && /审空气/.test(mismatch.error), JSON.stringify(mismatch));
    const same = S.verifyReviewerTree({ workerPath: tmpA, reviewerPath: tmpA });
    check('#541 两树 HEAD 相同 → 绿', same.ok === true && same.reviewerHead === same.expectedOid, JSON.stringify(same));

    const missingDir = path.join(os.tmpdir(), `dao-env-missing-${Date.now()}`);
    const ro = S.envProbeWorktree(missingDir);
    check('#546 故意让工作区不可写 → 环境自检红（写探针）', ro.ok === false && (ro.failed || []).includes('write'), JSON.stringify(ro));

    check('#575 ⑦ MERGEABLE → 放行', S.assessPrMergeable('MERGEABLE').ok === true);
    check('#575 ⑦ CONFLICTING → 拒建树', S.assessPrMergeable('CONFLICTING').ok === false && /rebase master/.test(S.assessPrMergeable('CONFLICTING').error));
    check('#575 ⑦ UNKNOWN → 没查成，不是绿', S.assessPrMergeable('UNKNOWN').ok === false && S.assessPrMergeable('UNKNOWN').unscanned === true);
    check('#575 ⑦ 空值 → 没查成', S.assessPrMergeable('').unscanned === true);
    check('#575 ⑦ 不认识的值 → 没查成', S.assessPrMergeable('DIRTY').unscanned === true);

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
    check('#575 ⑦ 试合无冲突：ok 且落后 ≥1', alignOk.ok === true && alignOk.behind >= 1 && alignOk.conflict === false, JSON.stringify(alignOk));
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
    check('#575 ⑦ merge 非零但无 unmerged → 没查成，不是 conflict',
      fakeFail.ok === false && fakeFail.unscanned === true && !fakeFail.conflict, JSON.stringify(fakeFail));
    check('#575 ⑦ 试合后 HEAD 仍是 PR head', headAfter === headBefore, `${headBefore} → ${headAfter}`);
    check('#575 ⑦ 试合后工作区干净', dirty === '', dirty);

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
    check('#575 ⑦ 试合有冲突：conflict=true 且仍 ok（树已还原）', alignClash.ok === true && alignClash.conflict === true, JSON.stringify(alignClash));
    check('#575 ⑦ 冲突试合后 HEAD 不变', clashHeadAfter === clashHead);
    check('#575 ⑦ 冲突试合后工作区干净', clashDirty === '', clashDirty);

    const daoSrcAlign = fs.readFileSync(CLI, 'utf8');
    check('#575 ⑦ reviewer-create 建树前走 assessPrMergeable', /function cmdReviewerCreate[\s\S]*assessPrMergeable/.test(daoSrcAlign));
    check('#575 ⑦ reviewer-attach 建树前走 assessPrMergeable', /function cmdReviewerAttach[\s\S]*assessPrMergeable/.test(daoSrcAlign));
    check('#575 ⑦ reviewer-create 建树后试合', /function cmdReviewerCreate[\s\S]*trialMergeMaster/.test(daoSrcAlign));

    const revHelp = spawnSync(process.execPath, [CLI, 'reviewer-create', '--help'], { encoding: 'utf8', cwd: REPO });
    check('reviewer-create 出现在 help', /reviewer-create/.test(revHelp.stdout || ''), (revHelp.stdout || '').slice(0, 200));
    const revMiss = spawnSync(process.execPath, [CLI, 'reviewer-create', '--name', 'x'], { encoding: 'utf8', cwd: REPO });
    const pRevMiss = (() => { try { return JSON.parse(revMiss.stdout || '{}'); } catch { return {}; } })();
    check('reviewer-create 缺 --pr → 非零', revMiss.status !== 0 && /--pr/.test(String(pRevMiss.error || revMiss.stderr || '')), JSON.stringify(pRevMiss));
  }

  console.log('\n=== #546 追加第五件：士兵—审官闭环任务书模板 ===');
  {
    const tmplDir = path.join(REPO, 'host', 'skills', 'dispatch', 'templates');
    const files = S.listDispatchTemplates();
    check('模板目录有 soldier-book.md + reviewer-book.md', files.includes('soldier-book.md') && files.includes('reviewer-book.md'), files.join(','));

    const soldier = S.renderDispatchTemplate('soldier-book.md', {
      SPEC: '短摘要：修 X',
    });
    check('soldier-book 填进 spec', /短摘要：修 X/.test(soldier), soldier.slice(0, 120));
    check('soldier-book 不再内嵌审官 dispatch id（身份消息另行送达，审官红项修正）', !/REVIEWER_DISPATCH_ID/.test(soldier) && !/dispatch:undefined/.test(soldier), soldier.slice(-220));
    check('soldier-book 完工通知写 dispatch:<id> 且指明先收信取 id', /--to dispatch:/.test(soldier) && /审官身份/.test(soldier) && !/term_/.test(soldier), soldier.slice(-260));
    check('soldier-book 要求完工后告知审官不告帅', /审官/.test(soldier));
    check('soldier-book 渲染后无任何 dispatch:undefined', /dispatch:undefined/.test(soldier) === false);

    const reviewer = S.renderDispatchTemplate('reviewer-book.md', {
      SOLDIER_DISPATCH_ID: 'ctx_worker-1',
      MERGE_POLICY: 'auto',
      MERGE_REASON: '',
    });
    check('reviewer-book 填进士兵 dispatch id', /ctx_worker-1/.test(reviewer));
    check('reviewer-book 填进 merge-policy', /merge-policy.*auto|auto/.test(reviewer));
    check('reviewer-book 红项发回 dispatch:<id> 不是 handle', /dispatch:ctx_worker-1/.test(reviewer) && !/term_/.test(reviewer), reviewer.slice(-300));
    check('reviewer-book 要求红项发回士兵、乒乓两轮仍红才上帅', /SOLDIER_DISPATCH_ID/.test(reviewer) === false && /乒乓/.test(reviewer), '占位符应已被替换');
    check('reviewer-book 走 gh-as reviewer approve（#573）', /gh-as\.mjs reviewer/.test(reviewer) && /--approve/.test(reviewer) && /真 approve/.test(reviewer), reviewer.slice(0, 400));
    const reviewerManual = S.renderDispatchTemplate('reviewer-book.md', {
      SOLDIER_DISPATCH_ID: 'ctx_worker-1',
      MERGE_POLICY: 'manual',
      MERGE_REASON: '改协作约定',
    });
    check('reviewer-book manual 模式含转 draft 机器落点（#498/#559）', /--undo/.test(reviewerManual) && /pr ready/.test(reviewerManual) && /gh-as\.mjs reviewer/.test(reviewerManual) && /MERGE_REASON/.test(reviewerManual) === false && /改协作约定/.test(reviewerManual), reviewerManual.slice(-400));

    let threw = false, threwMsg = '';
    try { S.renderDispatchTemplate('reviewer-book.md', { MERGE_POLICY: 'auto', MERGE_REASON: '' }); } // 缺 SOLDIER_DISPATCH_ID
    catch (e) { threw = true; threwMsg = String(e.message || e); }
    check('缺占位符值 → 抛', threw && /SOLDIER_DISPATCH_ID/.test(threwMsg), threwMsg);

    // 审官红项回归：dispatch id 缺失时渲染必须变红（不许出现 dispatch:undefined）
    let threwU = false, uMsg = '';
    try { S.renderDispatchTemplate('reviewer-book.md', { SOLDIER_DISPATCH_ID: String(undefined), MERGE_POLICY: 'auto', MERGE_REASON: '' }); }
    catch (e) { threwU = true; uMsg = String(e.message || e); }
    check('审官红项回归：dispatch id 缺失（"undefined" 字符串）→ 渲染抛错变红', threwU && /SOLDIER_DISPATCH_ID/.test(uMsg) && /dispatch:undefined|无效值/.test(uMsg), uMsg);
    let threwN = false;
    try { S.renderDispatchTemplate('reviewer-book.md', { SOLDIER_DISPATCH_ID: 'null', MERGE_POLICY: 'auto', MERGE_REASON: '' }); }
    catch (e) { threwN = true; }
    check('审官红项回归：占位符填字面量 null 也抛', threwN);

    let notFound = false;
    try { S.renderDispatchTemplate('no-such-template.md', {}); }
    catch (e) { notFound = true; }
    check('模板文件不在 → 抛（不静默空模板）', notFound);

    const badName = (() => { try { S.readDispatchTemplate('..\evil.md'); return false; } catch { return true; } })();
    check('模板名不合法 → 拒绝', badName);

    const daoSrc = fs.readFileSync(CLI, 'utf8');
    check('dao.mjs 士兵任务书走模板渲染（renderDispatchTemplate）', /renderDispatchTemplate/.test(daoSrc));
    check('dao.mjs 士兵 spec 不再是裸 args.spec（闭环包装）', /soldierBook/.test(daoSrc) && !/REVIEWER_DISPATCH_ID/.test(daoSrc), 'REVIEWER_DISPATCH_ID 已从 dao.mjs 移除');
    check('dao.mjs 审官也 task-create + worker-start（拿到编排身份）', /reviewerTaskId/.test(daoSrc) && /revStarted/.test(daoSrc));
    check('dao.mjs 审官注入后也验开工（reviewerInject）', /reviewerInject/.test(daoSrc));
    check('dao.mjs 从 worker-start 返回取 dispatch id（extractDispatchId）', /extractDispatchId/.test(daoSrc));
    check('dao.mjs 输出双方收件 dispatch（loop 段，soldierDoneTo=dispatch:…）', /soldierDoneTo/.test(daoSrc) && /reviewerRedTo/.test(daoSrc) && /dispatch:\$\{created\.reviewerDispatchId\}/.test(daoSrc));
    check('审官红项修正：审官任务书在士兵 worker-start 之后才渲染', /SOLDIER_DISPATCH_ID: String\(created\.workerDispatchId\)/.test(daoSrc), '渲染顺序检查');
    check('审官红项修正：审官身份消息发进士兵收件箱（四关确认）', /审官身份/.test(daoSrc) && /identity/.test(daoSrc));
  }

  console.log('\n=== ⑨ 闭环三跳：投递失败必须炸，不许静默（#548 红项 1）===');
  {
    // 判别性：同一套判据，活收件人必须放行、死收件人必须拦下。只会拦不会放的守卫等于天天假红。
    const LIVE = 'term_live-0001';
    const DEAD = 'term_00000000-0000-0000-0000-000000000000';
    const LIVE_RUN = 'run_live0001';
    const DEAD_RUN = 'run_00000000';
    const LIVE_DISPATCH = 'ctx_live-0001';
    const DEAD_DISPATCH = 'ctx_00000000-0000-0000-0000-000000000000';

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
            return { ok: true, json: { ok: true, result: { dispatch: { id: d, assignee_handle: 'term_live-0001' }, worker: { state: 'ready' } } } };
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
      check(`${h.hop}：收件人在 → 放行并给消息 id`, good.ok === true && /^msg_/.test(good.messageId || ''), JSON.stringify(good));
      const bad = S.deliverMessage({ ...h.dead, subject: '完工', hop: h.hop, orca: fakeOrca() });
      check(`${h.hop}：故意错 handle → 拦下`, bad.ok === false && bad.stage === '收件人', JSON.stringify(bad));
      check(`${h.hop}：错 handle 的报错说得出「不存在」`, bad.ok === false && /不存在/.test(bad.error), bad.error);
    }

    const dropped = S.deliverMessage({ to: LIVE, subject: 'x', orca: fakeOrca({ inboxDrops: true }) });
    check('回执给了 id 但编排里查不到 → 拦下', dropped.ok === false && dropped.stage === '复核', JSON.stringify(dropped));

    const unscanned = S.deliverMessage({ to: LIVE, subject: 'x', orca: fakeOrca({ inboxBroken: true }) });
    check('复核一条样本都没扫到 → 标 unscanned 且非 ok（没查成 ≠ 查过没事）', unscanned.ok === false && unscanned.unscanned === true, JSON.stringify(unscanned));

    const noReceipt = S.deliverMessage({ to: LIVE, subject: 'x', orca: fakeOrca({ sentMissingId: true }) });
    check('send 说成功却没回执 → 拦下', noReceipt.ok === false && noReceipt.stage === '回执', JSON.stringify(noReceipt));

    const wrong = S.deliverMessage({ to: LIVE, subject: 'x', orca: fakeOrca({ misroute: 'term_someone-else' }) });
    check('回执收件人与请求不一致（错投）→ 拦下', wrong.ok === false && /错投/.test(wrong.error), JSON.stringify(wrong));

    const noRun = S.deliverMessage({ subject: 'x', orca: fakeOrca() });
    check('省略收件人但没绑 Run → 拦下（发进真空）', noRun.ok === false && /真空/.test(noRun.error), JSON.stringify(noRun));

    const badDispatchForm = S.classifyNotifyTarget('dispatch_ctx-x');
    check('dispatch_xxx 不带冒号 → 不收（只收 dispatch:）', badDispatchForm.kind === 'unsupported', JSON.stringify(badDispatchForm));
    const okDispatchForm = S.classifyNotifyTarget('dispatch:ctx_x');
    check('dispatch:<id> 形态被认', okDispatchForm.kind === 'dispatch' && okDispatchForm.id === 'ctx_x', JSON.stringify(okDispatchForm));

    const wsFx = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'orca-json', 'worker-show.json'), 'utf8'));
    check('真语料 worker-show → extractDispatchId 取 result.dispatch.id', S.extractDispatchId(wsFx) === 'ctx_5a59f2b680ca', JSON.stringify(S.extractDispatchId(wsFx)));
    check('extractDispatchId 认 worker-start 的 result.dispatchId（CLI 源码形态）', S.extractDispatchId({ result: { dispatchId: 'ctx_abc' } }) === 'ctx_abc');
    check('extractDispatchId 认 worker.dispatch_id', S.extractDispatchId({ result: { worker: { dispatch_id: 'ctx_def' } } }) === 'ctx_def');
    check('extractDispatchId 不认 RPC 顶层 id', S.extractDispatchId({ id: 'rpc-123', result: {} }) === null);

    const group = S.deliverMessage({ to: '@all', subject: 'x', orca: fakeOrca() });
    check('组播收件人 → 拒发（没人负责签收）', group.ok === false && /组播/.test(group.error), JSON.stringify(group));

    const noSubject = S.deliverMessage({ to: LIVE, orca: fakeOrca() });
    check('缺 subject → 拦下', noSubject.ok === false && noSubject.stage === '参数', JSON.stringify(noSubject));

    // delivered_at 不是判据：真语料里活收件人也是 null，当门就是每条都假红。
    const fx = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'orca-json', 'orchestration-send.json'), 'utf8'));
    check('真语料：send 对活收件人 delivered_at 也是 null', fx.ok === true && fx.result.message.delivered_at === null, JSON.stringify(fx.result?.message?.delivered_at));
    const libSrc = fs.readFileSync(LIB, 'utf8');
    check('deliverMessage 不拿 delivered_at 当门（只报出）', !/delivered_at[^\n]*\?\s*[^:]*:\s*\{\s*ok:\s*false/.test(libSrc) && /deliveredAt: found\.message/.test(libSrc));

    // CLI 接线：动词登记 + 失败非零
    check('notify 已登记进 VERBS', S.VERBS.includes('notify'), S.VERBS.join(','));
    const cliBad = spawnSync(process.execPath, [CLI, 'notify', '--to', DEAD, '--subject', '回归样本'], { encoding: 'utf8', cwd: REPO });
    check('CLI notify 故意错 handle → 非零退出', cliBad.status !== 0, `status=${cliBad.status} ${cliBad.stdout}`);
    check('CLI notify 失败时 stderr 明说链断', /链断/.test(cliBad.stderr || ''), cliBad.stderr);

    const tmplSoldier = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'templates', 'soldier-book.md'), 'utf8');
    const tmplReviewer = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'templates', 'reviewer-book.md'), 'utf8');
    check('士兵任务书发信走 dao.mjs notify（不是裸 orca send）', /dao\.mjs notify/.test(tmplSoldier) && !/^\s*orca orchestration send/m.test(tmplSoldier), tmplSoldier.slice(0, 200));
    check('审官任务书发信走 dao.mjs notify（不是裸 orca send）', /dao\.mjs notify/.test(tmplReviewer) && !/^\s*orca orchestration send/m.test(tmplReviewer), tmplReviewer.slice(0, 200));
    check('两份任务书都写明「确认送达才准进下一步」', /确认送达/.test(tmplSoldier) && /确认送达/.test(tmplReviewer));

    // 审官那条「可归档」是普通告知，不许伪装成结算信号（#548 第二轮红项 → 轻量修正，完整修法 #551）
    const archiveBlock = tmplReviewer.slice(tmplReviewer.indexOf('### 3. 收尾'));
    check('审官「可归档」命令行不带 --type worker_done', !/```bash[\s\S]*?--type worker_done[\s\S]*?```/.test(archiveBlock), archiveBlock.slice(0, 300));
    check('审官任务书明写「不结算自己的 Dispatch」并指向 #551', /不是结算信号/.test(archiveBlock) && /#551/.test(archiveBlock));
    check('notify 文档点明验的是投递不是结算', /投递\*\*不是\*\*结算|投递.*不.*结算/.test(S.USAGE) && /#551/.test(S.USAGE), S.USAGE.slice(-400));
    check('deliverMessage 注释点明 ok:true ≠ 事情办完', /不是结算/.test(libSrc) && /#551/.test(libSrc));
  }

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
