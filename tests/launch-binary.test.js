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
import { classifyLaunchBinaries, commandWord, resolvesOnPath, OFF_PATH_BIN } from '../scripts/lib/launch-binary.mjs';

/** 假文件系统：only 集合里的路径算「存在且可执行」，其余一律不可解析。
 *  与真实 fs 同形（exists/access/stat），但不碰磁盘——本套不许依赖跑测试的机器上装了什么。 */
function fakeFs(only) {
  const has = (p) => only.includes(p);
  return {
    exists: has,
    access: (p) => { if (!has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } },
    stat: (p) => { if (!has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return { isFile: () => true }; },
  };
}

const PATH_ = '/usr/bin:/bin';
const HOME = '/home/u';

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
