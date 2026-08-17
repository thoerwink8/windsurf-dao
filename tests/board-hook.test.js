// 盘面摘要 hook 纯函数回归（issue #564 第 1 条 + comment 追加的信箱台自愈）。
//
// 验的层：① summarizeBoard 从 orca worktree ps 快照算三数（master/archived 不计）
// ② boardLine 两形分得开——扫完是空的（全 0）≠ 这次没扫到（没查成）
// ③ inboxInjection 三态：健康静音 / 自愈留痕 / 失败可辨认（只报不拦）
// ④ 真实 hook 端到端留到手工验收（本套不碰 orca）

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const HOOK = path.join(REPO, 'scripts', 'lib', 'board-hook.mjs');
const H_LOAD = import('file://' + HOOK.replace(/\\/g, '/'));

describe('board-hook', () => {
  it('#564 盘面摘要：summarizeBoard 三数口径', async (t) => {
    const H = await H_LOAD;
    const fixture = {
      result: {
        worktrees: [
          { isMainWorktree: true, displayName: 'master', agents: [] },                       // 主树：不算
          { isMainWorktree: false, displayName: '#1', agents: [{ state: 'working' }] },       // 在途
          { isMainWorktree: false, displayName: '#2', agents: [{ state: 'working' }] },       // 在途
          { isMainWorktree: false, displayName: '#3', agents: [{ state: 'done' }] },          // 待收口
          { isMainWorktree: false, displayName: '#4', agents: [], workspaceStatus: 'todo' },  // 待消歧（todo 卡）
          { isMainWorktree: false, displayName: '#5', agents: [], workspaceStatus: 'in-progress' }, // 无 agent 的壳卡：不算
          { isMainWorktree: false, isArchived: true, displayName: '#6', agents: [{ state: 'done' }] }, // archived：不算
        ],
      },
    };
    const s = H.summarizeBoard(fixture);
    await t.test('口径：master/archived/壳卡不计，在途/待收口/待消歧各归各',
      () => {
        assert.ok(s.scanned === 5 && s.inFlight.length === 2 && s.closing.length === 1 && s.todo.length === 1, '口径：master/archived/壳卡不计，在途/待收口/待消歧各归各  →  ' + JSON.stringify(s));
      });
    await t.test('在途带单号和做中',
      () => {
        assert.ok(s.inFlight[0].number === 1 && s.inFlight[0].status === '做中'
          && s.inFlight[1].number === 2 && s.inFlight[1].status === '做中', '在途带单号和做中  →  ' + JSON.stringify(s.inFlight));
      });
    await t.test('待收口是 #3',
      () => {
        assert.ok(s.closing[0].number === 3, '待收口是 #3  →  ' + JSON.stringify(s.closing));
      });
    await t.test('待消歧是 #4',
      () => {
        assert.ok(s.todo[0].number === 4, '待消歧是 #4  →  ' + JSON.stringify(s.todo));
      });
    await t.test('扫完是真扫了（scanned>0 且 unscanned=false）',
      () => {
        assert.ok(s.unscanned === false && s.scanned > 0, '扫完是真扫了（scanned>0 且 unscanned=false）  →  ' + JSON.stringify(s));
      });

    const bad = H.summarizeBoard({ result: {} });
    await t.test('没拿到 worktrees 数组 → unscanned，不许当扫完是空的',
      () => {
        assert.ok(bad.unscanned === true, '没拿到 worktrees 数组 → unscanned，不许当扫完是空的  →  ' + JSON.stringify(bad));
      });
  });

  it('#564 盘面摘要：两形分得开（扫完真空 ≠ 没扫到）', async (t) => {
    const H = await H_LOAD;
    const emptyLine = H.boardLine({ inFlight: [], closing: [], todo: [], scanned: 3, unscanned: false });
    const unscanLine = H.boardLine({ unscanned: true, error: 'orca worktree ps 失败（exit 1）' });
    await t.test('扫完全空 → 「在途 无 · 待收口 无」',
      () => {
        assert.ok(/在途 无 · 待收口 无/.test(emptyLine) && !/待消歧/.test(emptyLine), '扫完全空 → 「在途 无 · 待收口 无」  →  ' + emptyLine);
      });
    await t.test('没扫到 → 「[盘] 没查成：…」不是全空形',
      () => {
        assert.ok(/没查成/.test(unscanLine) && unscanLine !== emptyLine, '没扫到 → 「[盘] 没查成：…」不是全空形  →  ' + unscanLine);
      });
    const stale = H.boardLine({ inFlight: 4, closing: 4, todo: 0, unscanned: false });
    await t.test('旧计数缓存 → 没查成（不作全空）',
      () => {
        assert.ok(/没查成/.test(stale), '旧计数缓存 → 没查成（不作全空）  →  ' + stale);
      });
  });

  it('#588 盘面摘要：单号+状态，子卡不单独占行', async (t) => {
    const H = await H_LOAD;
    const fixture = {
      result: {
        worktrees: [
          { isMainWorktree: true, displayName: 'master', agents: [] },
          {
            displayName: '#588 - strikes', workspaceStatus: 'in-progress',
            parentWorktreeId: null,
            worktreeId: 'parent-588',
            agents: [{ state: 'working' }],
          },
          {
            displayName: '#588 - 审官', workspaceStatus: 'in-progress',
            parentWorktreeId: 'parent-588',
            worktreeId: 'child-588',
            agents: [{ state: 'working' }],
          },
          {
            displayName: '#582 - flow', workspaceStatus: 'in-review',
            parentWorktreeId: null,
            worktreeId: 'parent-582',
            agents: [{ state: 'working' }],
          },
        ],
      },
    };
    const s = H.summarizeBoard(fixture);
    await t.test('子卡不进在途名单',
      () => {
        assert.ok(s.inFlight.length === 2 && s.inFlight.every(c => c.number !== null), '子卡不进在途名单  →  ' + JSON.stringify(s.inFlight));
      });
    await t.test('in-review 标审中，即使 agent 还在 working',
      () => {
        assert.ok(s.inFlight.some(c => c.number === 582 && c.status === '审中'), 'in-review 标审中，即使 agent 还在 working  →  ' + JSON.stringify(s.inFlight));
      });
    await t.test('in-progress 标做中',
      () => {
        assert.ok(s.inFlight.some(c => c.number === 588 && c.status === '做中'), 'in-progress 标做中  →  ' + JSON.stringify(s.inFlight));
      });
    const line = H.boardLine(s);
    await t.test('一行能读出单号和状态',
      () => {
        assert.ok(/在途 #588\(做中\) #582\(审中\)/.test(line) && /待收口 无/.test(line), '一行能读出单号和状态  →  ' + line);
      });
    await t.test('待消歧为空时不占位',
      () => {
        assert.ok(!/待消歧/.test(line), '待消歧为空时不占位  →  ' + line);
      });
  });

  it('#564 信箱台自愈：健康静音 / 自愈留痕 / 失败可辨认', async (t) => {
    const H = await H_LOAD;
    const healthy = H.inboxInjection({ script: 'x', exec: () => ({ status: 0, stdout: '{"ok":true,"action":"noop"}\n' }) });
    await t.test('台全活着 → 静音（不刷屏；[盘] 行的存在就是活证）',
      () => {
        assert.ok(healthy === null, '台全活着 → 静音（不刷屏；[盘] 行的存在就是活证）  →  ' + String(healthy));
      });

    const healed = H.inboxInjection({ script: 'x', exec: () => ({ status: 0, stdout: '{"ok":true,"action":"restart","reason":"relay-dead"}\n' }) });
    await t.test('台死了被 ensure 自愈 → 留痕「已自愈」',
      () => {
        assert.ok(healed !== null && /已自愈/.test(healed), '台死了被 ensure 自愈 → 留痕「已自愈」  →  ' + String(healed));
      });

    const failed = H.inboxInjection({ script: 'x', exec: () => ({ status: 1, stdout: '{"ok":false,"error":"terminal list 失败"}\n' }) });
    await t.test('自愈失败 → 可辨认错误串，不是空',
      () => {
        assert.ok(failed !== null && /自愈失败/.test(failed) && /terminal list 失败/.test(failed), '自愈失败 → 可辨认错误串，不是空  →  ' + String(failed));
      });

    const crashed = H.inboxInjection({ script: 'x', exec: () => ({ error: { message: 'ENOENT' }, status: null }) });
    await t.test('ensure 直接崩 → 报「自愈失败」(无输出也不许吞)',
      () => {
        assert.ok(crashed !== null && /自愈失败/.test(crashed), 'ensure 直接崩 → 报「自愈失败」(无输出也不许吞)  →  ' + String(crashed));
      });
  });

  it('#564 接线：settings.json UserPromptSubmit 只挂一条命令（盘面+自愈合一）', async (t) => {
    const H = await H_LOAD;
    const settings = JSON.parse(require('fs').readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8'));
    const ups = settings.hooks?.UserPromptSubmit || [];
    const commands = ups.flatMap(g => (g.hooks || []).map(h => h.command));
    await t.test('UserPromptSubmit 是数组且挂了 board-hook',
      () => {
        assert.ok(commands.length >= 1 && commands.some(c => c.includes('board-hook.mjs')), 'UserPromptSubmit 是数组且挂了 board-hook  →  ' + JSON.stringify(commands));
      });
    await t.test('盘面与自愈合成一条命令（不挂两条互相拖超时）',
      () => {
        assert.ok(commands.length === 1, '盘面与自愈合成一条命令（不挂两条互相拖超时）  →  ' + JSON.stringify(commands));
      });
  });
});