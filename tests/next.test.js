// #576 next 动作候选行回归（issue #576 项一余量；#807 删本机 flow/watchdog 后瘦身）。
//
// 验的层：① nextLine 纯函数从本地文件产物（盘面摘要 / dao-mode 态）
//         算出「现在该干什么」一行，按谁在等谁排
//         ② 「扫完是空的」与「这次没扫到」不同形：盘面没扫到 ≠ 全空
//         ③ standby 态（复用 dao-mode 的 state.json）不输出「待消歧」（⑤）
//         ④ nextInjection 读侧喂 fixture（假 read/exists/orca/cache），不碰 orca / GitHub / 真文件
// #807 起 flow/watchdog 心跳不再进这一行（本机守卫栈整层删，派工节奏归服务器指挥官）。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const HOOK = path.join(REPO, 'scripts', 'lib', 'board-hook.mjs');
const H_LOAD = import('file://' + HOOK.replace(/\\/g, '/'));

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

describe('next', () => {
  it('#576 nextLine：无候选 → 无事可动形（≠ 没查成）', async (t) => {
    const H = await H_LOAD;
    const line = H.nextLine({
      board: { inFlight: [], closing: [], todo: [], scanned: 3, unscanned: false },
      mode: { mode: 'normal' },
    });
    await t.test('有 [盘] 行且明说是扫完',
      () => {
        assert.ok(/^\[盘\] 无事可动/.test(line) && /扫完是空的/.test(line), '有 [盘] 行且明说是扫完  →  ' + line);
      });
    await t.test('无候选时不是没查成形，也无 #807 已删的心跳位',
      () => {
        assert.ok(!/未在跑/.test(line) && !/^\[盘\] 没查成/.test(line), '无心跳位、非没查成形  →  ' + line);
      });
  });

  it('#576 nextLine：动作候选按「谁在等谁」排（待收口→待消歧→在途），无 flow/watchdog 位', async (t) => {
    const H = await H_LOAD;
    const line = H.nextLine({
      board: boardFixture,
      mode: { mode: 'normal' },
    });
    await t.test('一行能读出全部候选与顺序',
      () => {
        const want = '待收口 #575 · 待消歧 #4 · 在途 #588(做中)';
        assert.ok(line === `[盘] ${want}`, '顺序：待收口→待消歧→在途  →  ' + line);
      });
    await t.test('#807 起不再有 flow/watchdog「未在跑」占位',
      () => {
        assert.ok(!/flow/.test(line) && !/watchdog/.test(line) && !/未在跑/.test(line), '无心跳位  →  ' + line);
      });
  });

  it('#576 nextLine：standby 态不输出「待消歧」（⑤），其余候选照常', async (t) => {
    const H = await H_LOAD;
    const input = {
      board: boardFixture,
      mode: { mode: 'standby' },
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
      mode: { mode: 'normal' },
    });
    await t.test('没查成形且不带任何候选',
      () => {
        assert.ok(/^\[盘\] 没查成：orca worktree ps 失败（exit 1）（≠ 扫完是空的）$/.test(line), '没查成形  →  ' + line);
      });
  });

  it('#576 nextInjection：读侧喂 fixture（假 read/exists/orca/cache），不碰真机', async (t) => {
    const H = await H_LOAD;
    const stateFile = 'C:/fake/dao/state.json';

    const files = {
      [stateFile]: JSON.stringify({ mode: 'normal' }),
    };
    const read = (p) => {
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
      throw new Error(`没喂这个文件的 fixture：${p}`);
    };
    const exists = (p) => Object.prototype.hasOwnProperty.call(files, p);
    const orca = () => ({ status: 0, stdout: JSON.stringify(psJson) });
    const cache = { load: () => null, save: () => {} };

    await withEnv('DAO_STATE_FILE', stateFile, () => {
      const line = H.nextInjection({ read, exists, orca, cache });
      t.test('全 fixture → 动作候选齐全（无 flow/watchdog 位）', () => {
        const want = '[盘] 待收口 #575 · 待消歧 #4 · 在途 #588(做中)';
        assert.ok(line === want, '全 fixture 一行  →  ' + line);
      });
    });
  });

  it('#576 nextInjection：standby 态 fixture → 行里无待消歧', async (t) => {
    const H = await H_LOAD;
    const stateFile = 'C:/fake/dao/state.json';
    const orca = () => ({ status: 0, stdout: JSON.stringify(psJson) });
    const cache = { load: () => null, save: () => {} };

    await t.test('standby → 无待消歧、待收口照常',
      () => withEnv('DAO_STATE_FILE', stateFile, () => {
        const files = { [stateFile]: JSON.stringify({ mode: 'standby' }) };
        const read = (p) => {
          if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
          throw new Error(`没喂这个文件的 fixture：${p}`);
        };
        const exists = (p) => Object.prototype.hasOwnProperty.call(files, p);
        const line = H.nextInjection({ read, exists, orca, cache });
        assert.ok(!/待消歧/.test(line) && /待收口 #575/.test(line), 'standby 无待消歧  →  ' + line);
      }));

    await t.test('mode 文件不在 → 按常态（有待消歧）',
      () => withEnv('DAO_STATE_FILE', stateFile, () => {
        const read = () => { throw new Error('不应读文件'); };
        const exists = () => false;
        const line = H.nextInjection({ read, exists, orca, cache });
        assert.ok(/待消歧 #4/.test(line), 'mode 缺按常态  →  ' + line);
      }));
  });
});
