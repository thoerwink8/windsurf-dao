// #576 next 动作候选行回归（issue #576 项一余量）。
//
// 验的层：① nextLine 纯函数从本地文件产物（盘面摘要 / flow、watchdog 心跳 / dao-mode 态）
//         算出「现在该干什么」一行，按谁在等谁排
//         ② 「扫完是空的」与「这次没扫到」不同形：心跳损坏 ≠ 未在跑；盘面没扫到 ≠ 全空
//         ③ standby 态（复用 dao-mode 的 state.json）不输出「待消歧」（⑤）
//         ④ nextInjection 读侧喂 fixture（假 git/read/exists/orca/cache），不碰 orca / GitHub / 真文件

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const HOOK = path.join(REPO, 'scripts', 'lib', 'board-hook.mjs');
const H_LOAD = import('file://' + HOOK.replace(/\\/g, '/'));

const MIN = 60 * 1000;
const NOW = Date.parse('2026-08-22T00:00:00.000Z');
const FLOW_STALE = 10 * MIN;   // 与 guard-keepalive FLOW_HEARTBEAT_STALE_MS 同口径
const WD_STALE = 5 * MIN;      // 与 guard-keepalive WATCHDOG_HEARTBEAT_STALE_MS 同口径

const boardFixture = {
  inFlight: [{ number: 588, status: '做中' }],
  closing: [{ number: 575, status: '待收口' }],
  todo: [{ number: 4, status: '待消歧' }],
  scanned: 3,
  unscanned: false,
};

const psJson = {
  result: {
    worktrees: [
      { isMainWorktree: true, displayName: 'master', agents: [] },
      { displayName: '#575', agents: [{ state: 'done' }] },                   // 待收口
      { displayName: '#4', agents: [], workspaceStatus: 'todo' },             // 待消歧
      { displayName: '#588', workspaceStatus: 'in-progress', agents: [{ state: 'working' }] }, // 在途
    ],
  },
};

/** 环境变量临时覆写（读侧路径走 process.env，测试不碰真文件）。 */
function withEnv(name, value, fn) {
  const prev = process.env[name];
  process.env[name] = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

function freshHb(msAgo = 60 * 1000) {
  return { ts: new Date(NOW - msAgo).toISOString() };
}

describe('next', () => {
  it('#576 nextLine：全部新鲜且无候选 → 无事可动形（≠ 没查成）', async (t) => {
    const H = await H_LOAD;
    const line = H.nextLine({
      board: { inFlight: [], closing: [], todo: [], scanned: 3, unscanned: false },
      flowHb: freshHb(),
      wdHb: freshHb(30 * 1000),
      mode: { mode: 'normal' },
      now: NOW,
    });
    await t.test('有 [盘] 行且明说是扫完',
      () => {
        assert.ok(/^\[盘\] 无事可动/.test(line) && /扫完是空的/.test(line), '有 [盘] 行且明说是扫完  →  ' + line);
      });
    await t.test('心跳新鲜不占位（无「未在跑」，也不是没查成形）',
      () => {
        assert.ok(!/未在跑/.test(line) && !/^\[盘\] 没查成/.test(line), '心跳新鲜不占位  →  ' + line);
      });
  });

  it('#576 nextLine：动作候选按「谁在等谁」排（待帅处置→待收口→监控→待消歧→在途）', async (t) => {
    const H = await H_LOAD;
    const line = H.nextLine({
      board: boardFixture,
      flowHb: { ...freshHb(), prs: [{ number: 571, state: '判定行缺失/格式不符待帅分诊' }] },
      wdHb: freshHb(30 * 1000),
      mode: { mode: 'normal' },
      now: NOW,
    });
    await t.test('一行能读出全部候选与顺序',
      () => {
        const want = '待帅处置 #571（判定行缺失/格式不符待帅分诊） · 待收口 #575 · 待消歧 #4 · 在途 #588(做中)';
        assert.ok(line === `[盘] ${want}`, '顺序：待帅处置→待收口→待消歧→在途  →  ' + line);
      });
  });

  it('#576 nextLine：监控自己没跑三态分得开（缺失/过期 = 未在跑；损坏 = 没查成）', async (t) => {
    const H = await H_LOAD;
    const base = { board: boardFixture, wdHb: freshHb(30 * 1000), mode: { mode: 'normal' }, now: NOW };

    await t.test('flow 心跳缺失 → flow 未在跑',
      () => {
        const line = H.nextLine({ ...base, flowHb: { missing: true } });
        assert.ok(/flow 未在跑/.test(line) && !/watchdog/.test(line), 'flow 未在跑  →  ' + line);
      });
    await t.test('watchdog 心跳缺失 → watchdog 未在跑',
      () => {
        const line = H.nextLine({ ...base, flowHb: freshHb(), wdHb: { missing: true } });
        assert.ok(/watchdog 未在跑/.test(line), 'watchdog 未在跑  →  ' + line);
      });
    await t.test('flow 心跳过期超阈值 → flow 未在跑（带分钟数）',
      () => {
        const line = H.nextLine({ ...base, flowHb: { ts: new Date(NOW - FLOW_STALE - 60 * 1000).toISOString() } });
        assert.ok(/flow 未在跑（心跳过期 11 分钟）/.test(line), '过期带分钟数  →  ' + line);
      });
    await t.test('watchdog 心跳过期超阈值 → watchdog 未在跑（带分钟数）',
      () => {
        const line = H.nextLine({ ...base, flowHb: freshHb(), wdHb: { ts: new Date(NOW - WD_STALE - 60 * 1000).toISOString() } });
        assert.ok(/watchdog 未在跑（心跳过期 6 分钟）/.test(line), '过期带分钟数  →  ' + line);
      });
    await t.test('心跳损坏 → 没查成形，不是未在跑',
      () => {
        const line = H.nextLine({ ...base, flowHb: { unscanned: true, error: 'flow 心跳损坏' } });
        assert.ok(/flow 没查成（flow 心跳损坏，≠ 未在跑）/.test(line), '损坏 ≠ 未在跑  →  ' + line);
      });
    await t.test('心跳 ts 不可解析 → 没查成形',
      () => {
        const line = H.nextLine({ ...base, flowHb: { ts: '不是时间' } });
        assert.ok(/flow 没查成（心跳 ts 不可解析，≠ 未在跑）/.test(line), 'ts 不可解析  →  ' + line);
      });
    await t.test('心跳在阈值内 → 不占位',
      () => {
        const line = H.nextLine({ ...base, flowHb: { ts: new Date(NOW - FLOW_STALE + 60 * 1000).toISOString() } });
        assert.ok(!/flow/.test(line), '新鲜不占位  →  ' + line);
      });
  });

  it('#576 nextLine：standby 态不输出「待消歧」（⑤），其余候选照常', async (t) => {
    const H = await H_LOAD;
    const input = {
      board: boardFixture,
      flowHb: freshHb(),
      wdHb: freshHb(30 * 1000),
      mode: { mode: 'standby' },
      now: NOW,
    };
    await t.test('standby → 无待消歧',
      () => {
        const line = H.nextLine(input);
        assert.ok(!/待消歧/.test(line), 'standby 无待消歧  →  ' + line);
      });
    await t.test('standby → 待收口与在途照常',
      () => {
        const line = H.nextLine(input);
        assert.ok(/待收口 #575/.test(line) && /在途 #588\(做中\)/.test(line), '待收口/在途照常  →  ' + line);
      });
    await t.test('normal → 有待消歧',
      () => {
        const line = H.nextLine({ ...input, mode: { mode: 'normal' } });
        assert.ok(/待消歧 #4/.test(line), 'normal 有待消歧  →  ' + line);
      });
    await t.test('mode 读不到（null）→ 按常态不隐藏（dao-mode 自报态，next 不猜）',
      () => {
        const line = H.nextLine({ ...input, mode: null });
        assert.ok(/待消歧 #4/.test(line), 'mode 读不到按常态  →  ' + line);
      });
  });

  it('#576 nextLine：盘面没扫到 → 整行没查成（≠ 扫完是空的）', async (t) => {
    const H = await H_LOAD;
    const line = H.nextLine({
      board: { unscanned: true, error: 'orca worktree ps 失败（exit 1）' },
      flowHb: freshHb(),
      wdHb: freshHb(30 * 1000),
      mode: { mode: 'normal' },
      now: NOW,
    });
    await t.test('没查成形且不带任何候选',
      () => {
        assert.ok(/^\[盘\] 没查成：orca worktree ps 失败（exit 1）（≠ 扫完是空的）$/.test(line), '没查成形  →  ' + line);
      });
  });

  it('#576 nextLine：待帅处置 reason 超长截断，不给上下文灌长行', async (t) => {
    const H = await H_LOAD;
    const line = H.nextLine({
      board: { inFlight: [], closing: [], todo: [], scanned: 1, unscanned: false },
      flowHb: { ...freshHb(), prs: [{ number: 571, state: '这是一条特别长的待帅处置原因，应该被截断到二十四字以内' }] },
      wdHb: freshHb(30 * 1000),
      mode: { mode: 'normal' },
      now: NOW,
    });
    await t.test('reason 截到 24 字',
      () => {
        assert.ok(line.length < 120, '行不膨胀  →  ' + line);
      });
  });

  it('#576 nextInjection：读侧喂 fixture（假 git/read/exists/orca/cache），不碰真机', async (t) => {
    const H = await H_LOAD;
    const stateFile = 'C:/fake/dao/state.json';
    const guardDir = 'C:/fake/dao/guard';
    const mainPath = 'C:/fake/main';
    const flowPath = path.join(mainPath, '_flow', 'heartbeat.json');
    const wdPath = path.join(guardDir, 'watchdog-heartbeat.json');

    const files = {
      [flowPath]: JSON.stringify({
        ts: new Date(NOW - 60 * 1000).toISOString(),
        prs: [{ number: 571, state: '判定行缺失' }],
      }),
      [wdPath]: JSON.stringify({ ts: new Date(NOW - 30 * 1000).toISOString() }),
      [stateFile]: JSON.stringify({ mode: 'normal' }),
    };
    const git = () => ({ ok: true, out: `worktree ${mainPath}\nworktree ${path.join('C:/fake/worker')} ${''}` });
    const read = (p) => {
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
      throw new Error(`没喂这个文件的 fixture：${p}`);
    };
    const exists = (p) => Object.prototype.hasOwnProperty.call(files, p);
    const orca = () => ({ status: 0, stdout: JSON.stringify(psJson) });
    const cache = { load: () => null, save: () => {} };

    await withEnv('DAO_STATE_FILE', stateFile, () => withEnv('DAO_GUARD_HALT_DIR', guardDir, () => {
      const line = H.nextInjection({ root: 'C:/fake/root', git, read, exists, orca, cache, now: NOW });
      t.test('全 fixture → 动作候选齐全', () => {
        const want = '[盘] 待帅处置 #571（判定行缺失） · 待收口 #575 · 待消歧 #4 · 在途 #588(做中)';
        assert.ok(line === want, '全 fixture 一行  →  ' + line);
      });
    }));
  });

  it('#576 nextInjection：主树路径没解出来 / 心跳损坏 / standby，各成其形', async (t) => {
    const H = await H_LOAD;
    const stateFile = 'C:/fake/dao/state.json';
    const guardDir = 'C:/fake/dao/guard';
    const mainPath = 'C:/fake/main';
    const flowPath = path.join(mainPath, '_flow', 'heartbeat.json');
    const wdPath = path.join(guardDir, 'watchdog-heartbeat.json');
    const orca = () => ({ status: 0, stdout: JSON.stringify(psJson) });
    const cache = { load: () => null, save: () => {} };

    await t.test('git 失败 → flow 没查成（不是未在跑），盘面照常',
      () => withEnv('DAO_STATE_FILE', stateFile, () => withEnv('DAO_GUARD_HALT_DIR', guardDir, () => {
        const git = () => ({ ok: false, error: 'git 不在' });
        const read = () => { throw new Error('不应读文件'); };
        const exists = () => false;
        const line = H.nextInjection({ root: 'C:/fake/root', git, read, exists, orca, cache, now: NOW });
        assert.ok(/flow 没查成（主树路径没解出来，flow 心跳没查成，≠ 未在跑）/.test(line)
          && /待收口 #575/.test(line) && /watchdog 未在跑/.test(line), 'flow 没查成 + 盘面照常  →  ' + line);
      })));

    await t.test('flow 心跳文件坏了 → flow 没查成（≠ 未在跑）',
      () => withEnv('DAO_STATE_FILE', stateFile, () => withEnv('DAO_GUARD_HALT_DIR', guardDir, () => {
        const git = () => ({ ok: true, out: `worktree ${mainPath}` });
        const files = { [flowPath]: '不是 JSON', [stateFile]: JSON.stringify({ mode: 'normal' }) };
        const read = (p) => {
          if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
          throw new Error(`没喂这个文件的 fixture：${p}`);
        };
        const exists = (p) => Object.prototype.hasOwnProperty.call(files, p);
        const line = H.nextInjection({ root: 'C:/fake/root', git, read, exists, orca, cache, now: NOW });
        assert.ok(/flow 没查成（flow 心跳损坏，≠ 未在跑）/.test(line), 'flow 心跳损坏  →  ' + line);
      })));

    await t.test('standby 态 fixture → 行里无待消歧',
      () => withEnv('DAO_STATE_FILE', stateFile, () => withEnv('DAO_GUARD_HALT_DIR', guardDir, () => {
        const git = () => ({ ok: true, out: `worktree ${mainPath}` });
        const files = {
          [flowPath]: JSON.stringify({ ts: new Date(NOW - 60 * 1000).toISOString() }),
          [wdPath]: JSON.stringify({ ts: new Date(NOW - 30 * 1000).toISOString() }),
          [stateFile]: JSON.stringify({ mode: 'standby' }),
        };
        const read = (p) => {
          if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
          throw new Error(`没喂这个文件的 fixture：${p}`);
        };
        const exists = (p) => Object.prototype.hasOwnProperty.call(files, p);
        const line = H.nextInjection({ root: 'C:/fake/root', git, read, exists, orca, cache, now: NOW });
        assert.ok(!/待消歧/.test(line) && /待收口 #575/.test(line), 'standby 无待消歧  →  ' + line);
      })));
  });
});
