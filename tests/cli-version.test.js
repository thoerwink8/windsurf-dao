// tests/cli-version.test.js —— 载体版本漂移的判别力
//
// 用户 2026-09-13 拍板：「只做版本变了要说，不钉死」。
// 本套钉三头：变了必须报；没变必须闭嘴；**读不到必须跟「没变」分开**——
// 最后这条是这类检查最容易犯的错（把「没查成」当「查过没事」），
// 也正是这套系统里 GPU 那几个失败模式的老根。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersionLine, classifyVersionDrift, mergeVersionState, renderDrift,
  VERSION_PROBES, resolveProbeBinary, effectivePath } from '../scripts/lib/cli-version.mjs';

test('① 各家用各自的读法，不是每个都认 --version', () => {
  // devin 是子命令形态。写死 --version 会在它身上读空，而空会被当成「没读成」——
  // 判据看着还在跑，实际永远读不到 devin 的版本。
  assert.deepEqual(VERSION_PROBES.devin.args, ['version']);
  assert.deepEqual(VERSION_PROBES.pi.args, ['--version']);
});

test('② 版本串从各家输出里抠得出来', () => {
  assert.equal(parseVersionLine('0.85.1'), '0.85.1');
  assert.equal(parseVersionLine('grok 1.0.30 (04b7ffed98c6)'), '1.0.30');
  assert.equal(parseVersionLine('codex-cli 0.154.0'), '0.154.0');
  assert.equal(parseVersionLine('devin 3000.6.14 (18033302)'), '3000.6.14');
  assert.equal(parseVersionLine('2026.08.31-4057e58'), '2026.08.31-4057e58', '构建标识要一起收：只比日期会把换构建当成没变');
  assert.equal(parseVersionLine(''), null);
  // 认不出就报毛坯，不许静默丢——「读不出」和「没变」是两回事
  assert.equal(parseVersionLine('no digits here'), 'no digits here');
});

test('③ 变了要报，且带上从什么变成什么', () => {
  const d = classifyVersionDrift({
    current: { pi: { version: '0.85.1' } },
    previous: { pi: { version: '0.80.0' } },
  });
  assert.deepEqual(d.changed, [{ bin: 'pi', was: '0.80.0', now: '0.85.1' }]);
  assert.match(renderDrift(d), /pi 0\.80\.0 → 0\.85\.1/);
});

test('④ 没变不报，且不许把没变算进任何一类', () => {
  const d = classifyVersionDrift({
    current: { pi: { version: '0.85.1' }, grok: { version: '1.0.30' } },
    previous: { pi: { version: '0.85.1' }, grok: { version: '1.0.30' } },
  });
  assert.deepEqual([d.changed, d.appeared, d.gone, d.unreadable], [[], [], [], []]);
  assert.equal(d.unchanged, 2);
  assert.equal(renderDrift(d), '', '什么都没变时必须吐空串，调用方据此闭嘴');
});

test('⑤ 降级同样要报——不判「升还是降」，只判「变没变」', () => {
  // AI CLI 的 minor 升级能改输出行为，行业口径是当 major 对待；
  // 而回滚/装坏也会让版本变小，两种都该被看见。
  const d = classifyVersionDrift({
    current: { pi: { version: '0.80.0' } },
    previous: { pi: { version: '0.85.1' } },
  });
  assert.deepEqual(d.changed, [{ bin: 'pi', was: '0.85.1', now: '0.80.0' }]);
});

test('⑥ 读不到 ≠ 没变：必须进 unreadable，不许静默当「没变化」', () => {
  const d = classifyVersionDrift({
    current: { pi: { version: null, error: '超时' } },
    previous: { pi: { version: '0.85.1' } },
  });
  assert.deepEqual(d.unreadable, [{ bin: 'pi', error: '超时' }]);
  assert.deepEqual(d.changed, []);
  assert.match(renderDrift(d), /没读成/);
});

test('⑦ 新出现与不见了分得开（装上新载体 / 卸载或探测失败）', () => {
  const d = classifyVersionDrift({
    current: { newbin: { version: '1.0.0' }, pi: { version: '0.85.1' } },
    previous: { pi: { version: '0.85.1' }, gonebin: { version: '2.0.0' } },
  });
  assert.deepEqual(d.appeared, [{ bin: 'newbin', version: '1.0.0' }]);
  assert.deepEqual(d.gone, [{ bin: 'gonebin', was: '2.0.0' }]);
  assert.match(renderDrift(d), /新出现：newbin/);
  assert.match(renderDrift(d), /不见了：gonebin/);
});

test('⑧ 变了才翻 lastChangedAt，没变保留原值', () => {
  const prev = { pi: { version: '0.80.0', firstSeenAt: '2026-09-01T00:00:00Z', lastChangedAt: '2026-09-01T00:00:00Z' } };
  const changed = mergeVersionState({ current: { pi: { version: '0.85.1' } }, previous: prev, now: '2026-09-13T00:00:00Z' });
  assert.equal(changed.pi.lastChangedAt, '2026-09-13T00:00:00Z');
  assert.equal(changed.pi.firstSeenAt, '2026-09-01T00:00:00Z', '首次见到的时间不该被覆盖');
  const same = mergeVersionState({ current: { pi: { version: '0.80.0' } }, previous: prev, now: '2026-09-13T00:00:00Z' });
  assert.equal(same.pi.lastChangedAt, '2026-09-01T00:00:00Z', '没变就不许动它——这决定「这个版本什么时候上的」答不答得出来');
});

test('⑨ cursor-agent 不在 PATH，读版本时必须走显式落点（不许拿裸名 spawn）', () => {
  // 第一次写就栽在这：六个载体里 cursor-agent 是唯一读成 ENOENT 的。
  // fs 注入：本套不许依赖跑测试那台机器上装了什么（判据跟着机器漂是最该避免的坏法）。
  const abs = '/home/u/.local/share/cursor-agent/versions/2026.08.31-4057e58/cursor-agent';
  const fs = {
    exists: (p) => p === abs,
    access: (p) => { if (p !== abs) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } },
    stat: (p) => { if (p !== abs) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return { isFile: () => true }; },
  };
  const resolved = resolveProbeBinary('cursor-agent', { pathValue: '/usr/bin:/bin', homeDir: '/home/u', fs });
  assert.equal(resolved.via, 'off-path');
  assert.equal(resolved.command, abs);
  // PATH 上没有、又没有显式落点的，老老实实说解析不到
  assert.equal(resolveProbeBinary('definitely-not-installed', { pathValue: '/usr/bin:/bin', homeDir: '/home/u', fs }).via, 'unresolved');
});

test('⑩ 解析不到的可执行文件不许静默当「版本没变」', () => {
  const d = classifyVersionDrift({
    current: { mystery: { version: null, error: '本机解析不到这个可执行文件' } },
    previous: {},
  });
  assert.equal(d.unreadable.length, 1);
  assert.equal(d.appeared.length, 0, '读不到 ≠ 新出现');
});

// 红 2（审官在 PR #1213 上抓）：探测失败不许抹掉 last-known
//
// 原实现 `if (!rec.version) continue` 会把那条记录整个删掉，一次临时超时就让下一轮
// 只能报 appeared、永远报不出 changed: 0.85.1 → 0.86.0——正好毁掉本模块存在的理由。
test('mergeVersionState：本轮读不到 → 保留旧值；恢复后仍按旧值判 changed', () => {
  const previous = { pi: { version: '0.85.1', firstSeenAt: 'A', lastChangedAt: 'A', lastCheckedAt: 'A' } };
  // ① 超时那一轮：旧值必须还在
  const during = mergeVersionState({ current: { pi: { version: null, error: '超时' } }, previous, now: 'B' });
  assert.equal(during.pi.version, '0.85.1', '一次超时不许把基线抹掉');
  assert.equal(during.pi.lastChangedAt, 'A', '读不到不是「变了」，不许动 lastChangedAt');
  assert.equal(during.pi.lastCheckedAt, 'B');
  assert.equal(during.pi.error, '超时');
  // ② 恢复后读到新版本：跟**旧值**比，报得出 changed
  const after = mergeVersionState({ current: { pi: { version: '0.86.0' } }, previous: during, now: 'C' });
  assert.equal(after.pi.version, '0.86.0');
  assert.equal(after.pi.lastChangedAt, 'C');
  assert.equal(after.pi.firstSeenAt, 'A', 'firstSeenAt 要跟着旧值走，不许被重置');
  const drift = classifyVersionDrift({ current: { pi: { version: '0.86.0' } }, previous: during });
  assert.deepEqual(drift.changed.map(c => [c.bin, c.was, c.now]), [['pi', '0.85.1', '0.86.0']]);
  // ③ 从来没有旧值又读不到：留一条「一直是读不到」的账，不是静默消失
  const never = mergeVersionState({ current: { devin: { version: null, error: '起不来' } }, previous: {}, now: 'D' });
  assert.equal(never.devin.version, null);
  assert.equal(never.devin.error, '起不来');
});

// 红 3（审官在 PR #1213 上抓）：解析用的 PATH 必须与子进程实际拿到的是同一条
//
// 原实现先按 `process.env.PATH` 判一次死活、**之后**才往子进程 env 里补 `~/.local/bin`。
// 于是 `PATH=/usr/bin:/bin` 时 devin 判「本机解析不到」，而它就在随后那条有效 PATH 里——
// 正是本模块自己要修的那类「shell PATH 与部署 PATH 不一致」。
test('effectivePath：把 ~/.local/bin 并进来，且不重复', () => {
  const home = '/home/u';
  assert.equal(effectivePath({ home, env: { PATH: '/usr/bin:/bin' } }), '/home/u/.local/bin:/usr/bin:/bin');
  // 已经在里面就不再加一次（重复项会让「按 PATH 判死活」多走一圈，也让人读串）
  assert.equal(effectivePath({ home, env: { PATH: '/home/u/.local/bin:/usr/bin' } }), '/home/u/.local/bin:/usr/bin');
  assert.equal(effectivePath({ home, env: {} }), '/home/u/.local/bin:');
});

test('resolveProbeBinary 按传入的 pathValue 判，不偷偷退回 process.env.PATH', async () => {
  const { resolveProbeBinary } = await import('../scripts/lib/cli-version.mjs');
  // 装出来的假 fs：只有那条有效 PATH 的目录里有 devin（fs 按 {exists,access,stat} 包成对象传）
  const fs = {
    exists: () => true,
    access: (p) => { if (p !== '/home/u/.local/bin/devin') { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } },
    stat: () => ({ isFile: () => true }),
  };
  const hit = resolveProbeBinary('devin', { homeDir: '/home/u', pathValue: '/home/u/.local/bin:/usr/bin:/bin', fs });
  assert.equal(hit.via, 'path');
  assert.equal(hit.command, '/home/u/.local/bin/devin');
  // 同一条 fs、换一条不含它的 PATH → 判不出来（证明判据确实吃入参，不是吃环境）
  const miss = resolveProbeBinary('devin', { homeDir: '/home/u', pathValue: '/usr/bin:/bin', fs });
  assert.equal(miss.command, null);
});
