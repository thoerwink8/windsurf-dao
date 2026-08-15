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
    check('grok 走 shim', /grok-shim\.cmd/.test(grok.command), grok.command);
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
    check('dry-run 工人走 grok shim', /grok-shim/.test(pOk.workerLaunch), JSON.stringify(pOk));

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
    check('R1 dao.mjs 走 terminalProbeExec 不走 hostProbeExec', /terminalProbeExec/.test(daoSrc) && !/hostProbeExec/.test(daoSrc));
    check('R1 dao.mjs 不再裸调 worktree show', !/orca\(\['worktree', 'show'/.test(daoSrc));
    check('#495 dao.mjs 派工成功后写任务卡 comment 定界区', /afterDispatchComment/.test(daoSrc));
    check('#502 取 taskId 走 extractTaskId 不猜 result.id', /extractTaskId/.test(daoSrc) && !/result\?\.id/.test(daoSrc));
    check('#502 未绑 Run 报 run-create/run-use', /RUN_REQUIRED_HINT/.test(daoSrc) && /run-create/.test(S.RUN_REQUIRED_HINT));
    check('#495 dao.mjs 不走终端 rename', !/afterDispatchSuccess/.test(daoSrc) && !/terminal', 'rename'/.test(daoSrc));
    check('探针等待从表读，不写死毫秒数', /probeWaitMs/.test(daoSrc) && !/45000/.test(daoSrc) && !/120000/.test(daoSrc));
    check('grok 表上 probe_wait_ms=45000', S.probeWaitMs(routing, 'grok') === 45000, String(S.probeWaitMs(routing, 'grok')));
    check('gpt 表上 probe_wait_ms=120000', S.probeWaitMs(routing, 'gpt') === 120000, String(S.probeWaitMs(routing, 'gpt')));
    check('没配的 provider 回落默认', S.probeWaitMs(routing, 'claude') === S.DEFAULT_PROBE_WAIT_MS);
    check('缺字段 / 非法值回落默认', S.probeWaitMs({ providers: { x: {} } }, 'x') === 120000 && S.probeWaitMs({ providers: { x: { probe_wait_ms: -1 } } }, 'x') === 120000);
    check('R1 真机等待认 probeMarkFound 不认 DAO_PROBE_ 字面量', /probeMarkFound/.test(daoSrc) && !/DAO_PROBE_/.test(daoSrc));

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
    const ws = S.argsWorkerStart({ task: 't', worktree: 'w', terminal: 'h' });
    check('worker-start 用 --terminal 不用 --agent', ws.includes('--terminal') && !ws.includes('--agent'));

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

    const taskLive = fx('task-create.json');
    check('真 task-create → extractTaskId 走 result.task.id',
      S.extractTaskId(taskLive) === 'task_72992e47f0f4');
    check('真 task-create 顶层 id 不是 taskId',
      taskLive.id !== S.extractTaskId(taskLive) && taskLive.result.id === undefined);
    check('旧路径 result.id / 顶层 id 都取不到',
      S.extractTaskId({ id: 'rpc', result: { id: 'rpc2' } }) === null);
  }

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
