// tests/launch-binary.test.js —— 启动模板闸的判别力
//
// 2026-09-13 实咬：`docs/model-routing.toml` 的 commandcode 段写 `command-code`，
// 而本机只有 `cmdc`/`commandcode`/`cmd` 三个符号链接（npm 的 bin 声明了四个，
// 只建出三个）。这条腿一个月里一跑就 command not found，没有任何检查会红。
//
// 本套钉两头：写错的命令词必须抓到（正控）；正常命令词与显式落点不许误伤（反证）。
// PATH 全部显式注入——判据跟着跑测试那台机器的 PATH 漂，就是这一闸最该避免的坏法。

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLaunchBinaries, commandWord, resolvesOnPath, OFF_PATH_BIN, resolveProbePath, pathFromUnitText, deployPathFromUnits, countExistingDirs, DEPLOY_PATH_ENV } from '../scripts/lib/launch-binary.mjs';

const PATH_ = '/usr/bin:/bin';
const HOME = '/home/u';

/** 假文件系统：only 集合里的路径算「存在且可执行」，其余一律不可解析。
 *  与真实 fs 同形（exists/access/stat），但不碰磁盘——本套不许依赖跑测试的机器上装了什么。
 *
 *  PATH_ 里的目录默认算「存在」：真实机器上 `/usr/bin` / `/bin` 就是在的，
 *  把它们也排除掉会触发「这条 PATH 不属于本机」那条判据（⑫），
 *  于是每条用例都变 unknown——那是夹具不真，不是判据错了。
 *  `dirsPresent: false` 显式要那个场景时用。 */
function fakeFs(only, { dirsPresent = true } = {}) {
  const pathDirs = PATH_.split(':').filter(Boolean);
  const has = (p) => only.includes(p) || (dirsPresent && pathDirs.includes(p));
  return {
    exists: has,
    access: (p) => { if (!has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } },
    stat: (p) => { if (!has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return { isFile: () => true }; },
  };
}


test('① 正控：launch 里的命令词本机没有 → 红并点名字段', () => {
  const v = classifyLaunchBinaries({
    providers: [{ name: 'commandcode', cli: 'cmdc', launch: 'command-code -m {model} --yolo' }],
    pathValue: PATH_, homeDir: HOME, fs: fakeFs(['/usr/bin/cmdc']),
  });
  assert.equal(v.state, 'red');
  assert.deepEqual(v.broken.map(b => [b.provider, b.field, b.word]), [['commandcode', 'launch', 'command-code']]);
});

test('② 正控：cli 与 launch 都要看——launch 全对但 cli 写错也要红', () => {
  const v = classifyLaunchBinaries({
    providers: [{ name: 'x', cli: 'nope-cli', launch: 'cmdc -m {model}' }],
    pathValue: PATH_, homeDir: HOME, fs: fakeFs(['/usr/bin/cmdc']),
  });
  assert.equal(v.state, 'red');
  assert.deepEqual(v.broken.map(b => b.field), ['cli']);
});

test('③ 反证：命令词解析得出 → 绿', () => {
  const v = classifyLaunchBinaries({
    providers: [
      { name: 'commandcode', cli: 'cmdc', launch: 'cmdc -m {model} --skip-onboarding --yolo' },
      { name: 'grok', cli: 'grok', launch: 'grok -m {model} --effort xhigh --always-approve' },
    ],
    pathValue: PATH_, homeDir: HOME, fs: fakeFs(['/usr/bin/cmdc', '/usr/bin/grok']),
  });
  assert.equal(v.state, 'ok');
  assert.equal(v.checked, 2);
});

test('④ 环境变量赋值前缀不误判（launch 前会拼 DAO_TASK=… DAO_ACTOR=…）', () => {
  const v = classifyLaunchBinaries({
    providers: [{ name: 'pi', cli: 'pi', launch: 'DAO_TASK=1 DAO_RUN=2 pi --model {model}' }],
    pathValue: PATH_, homeDir: HOME, fs: fakeFs(['/usr/bin/pi']),
  });
  assert.equal(v.state, 'ok');
  assert.deepEqual(commandWord('DAO_TASK=1 DAO_RUN=2 pi --model x'), 'pi');
});

test('⑤ 显式落点允许表：落点真在 → 记 excused 不红；落点不在 → 照样红', () => {
  const abs = '/home/u/.local/share/cursor-agent/versions/2026.08.31-4057e58/cursor-agent';
  const ok = classifyLaunchBinaries({
    providers: [{ name: 'cursor-native', cli: 'cursor-agent', launch: 'cursor-agent --model {model} --force --trust' }],
    pathValue: PATH_, homeDir: HOME, fs: fakeFs([abs]),
  });
  assert.equal(ok.state, 'ok');
  // cli 与 launch 两处各记一条——判据覆盖两个字段，不是重复。
  assert.deepEqual(ok.excused.map(e => [e.field, e.word]), [['launch', 'cursor-agent'], ['cli', 'cursor-agent']]);
  // 落点不存在 = 允许表不是免死金牌
  const gone = classifyLaunchBinaries({
    providers: [{ name: 'cursor-native', cli: 'cursor-agent', launch: 'cursor-agent --model {model}' }],
    pathValue: PATH_, homeDir: HOME, fs: fakeFs([]),
  });
  assert.equal(gone.state, 'red');
  assert.match(gone.broken[0].why, /落点不存在/);
});

test('⑥ 允许表里的路径必须是真路径，不许拿名字顶替', () => {
  const v = classifyLaunchBinaries({
    providers: [{ name: 'cursor-native', cli: 'cursor-agent', launch: 'cursor-agent -m {model}' }],
    pathValue: PATH_, homeDir: HOME, fs: fakeFs(['/usr/bin/cursor-agent']),
  });
  // 装了真在 PATH 上也不必进允许表；这条断言的是允许表本身的值形态。
  assert.ok(OFF_PATH_BIN['cursor-agent'].includes('/'), '允许表要写真实落点，不是命令名');
  assert.equal(v.state, 'ok');
});

test('⑦ 带路径的命令词按原样判，不走 PATH', () => {
  const v = classifyLaunchBinaries({
    providers: [{ name: 'x', launch: '/opt/bin/agent --go' }],
    pathValue: PATH_, homeDir: HOME, fs: fakeFs(['/opt/bin/agent']),
  });
  assert.equal(v.state, 'ok');
  const missing = classifyLaunchBinaries({
    providers: [{ name: 'x', launch: '/opt/bin/agent --go' }],
    pathValue: PATH_, homeDir: HOME, fs: fakeFs(['/usr/bin/agent']),
  });
  assert.equal(missing.state, 'red');
});

test('⑧ 「没扫到样本」与「扫完 0 条违规」必须分得开', () => {
  const none = classifyLaunchBinaries({ providers: [], pathValue: PATH_, homeDir: HOME, fs: fakeFs([]) });
  assert.equal(none.state, 'unknown');
  assert.match(none.detail, /没查成/);
  const noPath = classifyLaunchBinaries({ providers: [{ name: 'x', launch: 'pi -m {model}' }], pathValue: '', homeDir: HOME, fs: fakeFs(['/usr/bin/pi']) });
  assert.equal(noPath.state, 'unknown');
  const notArray = classifyLaunchBinaries({ providers: null, pathValue: PATH_, homeDir: HOME, fs: fakeFs([]) });
  assert.equal(notArray.state, 'unknown');
  // 全绿的那种不是 unknown
  const clean = classifyLaunchBinaries({ providers: [{ name: 'x', launch: 'pi -m {model}' }], pathValue: PATH_, homeDir: HOME, fs: fakeFs(['/usr/bin/pi']) });
  assert.equal(clean.state, 'ok');
});

test('⑨ 真机自持解析：不 import dispatch/launch 的任何东西', async () => {
  const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../scripts/lib/launch-binary.mjs', import.meta.url), 'utf8'));
  // 只认 import/require 行与真实调用——注释里提到名字不算（写这条时被自己的注释绊了一次）。
  const importLines = src.split('\n').filter(l => /^\s*(import|const .*require\()/.test(l));
  assert.deepEqual(importLines.filter(l => /dispatch|next-launch|orca-agent-cmds/.test(l)), []);
  assert.equal(/child_process/.test(importLines.join('\n')), false, '本模块是纯函数，不 spawn');
});

test('⑩ resolvesOnPath 只看可执行位，不看存在与否', () => {
  const fsNoExec = {
    access: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; },
    stat: () => ({ isFile: () => true }),
  };
  assert.equal(resolvesOnPath('foo', { pathValue: '/usr/bin', ...fsNoExec }).ok, false);
  assert.equal(resolvesOnPath('foo', { pathValue: '/usr/bin', ...fakeFs(['/usr/bin/foo']) }).ok, true);
});

// ⑪ PATH 该按哪条判（2026-09-13 实咬）
//
// 第一版吃 `process.env.PATH`，于是同一个仓两处相反结论：手动跑 dao-check 时 PATH 不含
// `~/.local/bin` → reclaude/devin 判「解析不到」→ 红；真实服务 commander-act.service 的
// PATH 显式带着它 → 解析得到。**那条红是探针自己的 PATH 造成的假失败**，与模板对不对无关。
// 判据的锚点是部署环境，不是跑检查那个 shell。这一套钉住三条来源的优先级。
test('⑪ 探针 PATH 优先取部署单元，读不到才退回本进程', () => {
  const unitDir = '/repo/host/machine/systemd';
  const units = {
    'a.service': '[Service]\nEnvironment=PATH=/deploy/bin:/usr/bin\n',
    'b.service': '[Service]\nEnvironment=PATH=/deploy/bin:/usr/bin\n',
    'c.service': '[Service]\nEnvironment=PATH=/other/bin\n',   // 少数派：不该被选中
  };
  const io = {
    readdir: () => Object.keys(units),
    readFile: (p) => { const n = p.split('/').pop(); if (!units[n]) { const e = new Error('ENOENT'); throw e; } return units[n]; },
  };
  // ① 显式给的最优先
  assert.equal(resolveProbePath({ [DEPLOY_PATH_ENV]: '/explicit/bin', PATH: '/shell/bin' }).pathValue, '/explicit/bin');
  // ② 没有显式就给单元众数（两份 /deploy/bin:/usr/bin 胜过一份 /other/bin）
  const fromUnits = resolveProbePath({ PATH: '/shell/bin' }, { unitDir, io });
  assert.equal(fromUnits.pathValue, '/deploy/bin:/usr/bin');
  assert.match(fromUnits.source, /部署单元/);
  // ③ 单元读不到才退回本进程 PATH，且**标明来源**——红项要能一眼看出「是模板错还是我这条 PATH 不对」
  const fallback = resolveProbePath({ PATH: '/shell/bin' }, { unitDir, io: { readdir: () => { throw new Error('ENOENT'); }, readFile: () => '' } });
  assert.equal(fallback.pathValue, '/shell/bin');
  assert.match(fallback.source, /本进程 PATH/);
});

test('⑪b 单元里没写 PATH 的文件不参与取值（不拿空串当一条 PATH）', () => {
  assert.equal(pathFromUnitText('[Service]\nExecStart=/usr/bin/node x\n'), null);
  assert.equal(pathFromUnitText('Environment=PATH=/a:/b\n'), '/a:/b');
  assert.equal(pathFromUnitText('Environment="PATH=/a:/b"\n'), '/a:/b');
  // 全仓都没有 PATH → 返回 null（调用方退回本进程），不许编一条出来
  assert.equal(deployPathFromUnits('/x', { readdir: () => ['z.service'], readFile: () => '[Service]\n' }), null);
});

// ⑫ 异机（CI runner）不许假红（2026-09-13 审官在 PR #1213 上抓的红 1）
//
// `resolveProbePath()` 取仓内 systemd 单元写的 `/home/orca/.local/bin:…`——那是**生产**的 PATH。
// 在 GitHub runner 上那个目录根本不存在，于是 24 处命令词齐刷刷判「解析不到」、
// `dao-check --all-tests` 稳定退出 1。那不是模板的 24 个错，是**检查环境被混用了**。
// 判据：这条 PATH 里的目录在本机一个都不存在 ⇒ unknown（没查成），不许判红也不许判绿。
test('⑫ PATH 目录本机一个都不存在 → unknown（异机不假红）', () => {
  const prodPath = '/home/orca/.local/bin:/home/orca/bin:/usr/local/bin:/usr/bin:/bin';
  const v = classifyLaunchBinaries({
    providers: [{ name: 'claude', cli: 'reclaude', launch: 'reclaude --model {model}' }],
    pathValue: prodPath, homeDir: '/home/runner', pathSource: '仓内部署单元',
    fs: fakeFs([], { dirsPresent: false }),   // 一个目录都不存在 = 这不是那台机器
  });
  assert.equal(v.state, 'unknown', '异机上判红是把「检查环境不对」说成「模板错了」');
  assert.match(v.detail, /别的机器/);
  assert.equal(v.broken.length, 0);
});

test('⑫b 正控：目录在、命令词不在 → 仍然红（别拿异机判据把真错也挡住）', () => {
  const v = classifyLaunchBinaries({
    providers: [{ name: 'commandcode', cli: 'cmdc', launch: 'command-code -m {model}' }],
    pathValue: PATH_, homeDir: HOME, fs: fakeFs(['/usr/bin/cmdc']),   // /usr/bin 在，command-code 不在
  });
  assert.equal(v.state, 'red');
  assert.deepEqual(v.broken.map(b => b.word), ['command-code']);
  // countExistingDirs 是这条判据的输入，单独钉一下
  assert.deepEqual(countExistingDirs(PATH_, { exists: (p) => p === '/usr/bin' }), { total: 2, existing: 1 });
  assert.deepEqual(countExistingDirs('', { exists: () => true }), { total: 0, existing: 0 });
});
