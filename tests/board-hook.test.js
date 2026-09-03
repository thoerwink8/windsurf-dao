// 盘面摘要 hook 纯函数回归（issue #564 第 1 条 + comment 追加的信箱台自愈）。
//
// 验的层：① summarizeBoard 从 orca worktree ps 快照算在途/待收口/待消歧 + 盘面真实卡
// ② boardLine 两形分得开——扫完是空的（盘面 无）≠ 这次没扫到（没查成）
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
          { isMainWorktree: false, displayName: '#5', agents: [], workspaceStatus: 'in-progress' }, // 无 agent 的壳卡：不进在途，进盘面
          { isMainWorktree: false, isArchived: true, displayName: '#6', agents: [{ state: 'done' }] }, // archived：不算
        ],
      },
    };
    const s = H.summarizeBoard(fixture);
    await t.test('口径：master/archived 不计在途；壳卡不进在途但进盘面',
      () => {
        assert.ok(s.scanned === 5 && s.inFlight.length === 2 && s.closing.length === 1 && s.todo.length === 1
          && s.onBoard.length === 5 && s.onBoard.some(c => c.number === 5 && !c.status),
          '口径：master/archived 不计在途；壳卡不进在途但进盘面  →  ' + JSON.stringify(s));
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
    const emptyLine = H.boardLine({ inFlight: [], closing: [], todo: [], onBoard: [], scanned: 3, unscanned: false });
    const unscanLine = H.boardLine({ unscanned: true, error: 'orca worktree ps 失败（exit 1）' });
    await t.test('扫完全空 → 「在途 无 · 待收口 无 · 盘面 无」',
      () => {
        assert.ok(/在途 无 · 待收口 无 · 盘面 无/.test(emptyLine) && !/待消歧/.test(emptyLine) && !/没查成/.test(emptyLine),
          '扫完全空 → 「在途 无 · 待收口 无 · 盘面 无」  →  ' + emptyLine);
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
    const staleNoBoard = H.boardLine({ inFlight: [], closing: [], todo: [], scanned: 3, unscanned: false });
    await t.test('旧摘要缺 onBoard → 没查成（不作盘面 无）',
      () => {
        assert.ok(/没查成/.test(staleNoBoard) && staleNoBoard !== emptyLine, '旧摘要缺 onBoard → 没查成  →  ' + staleNoBoard);
      });
  });

  it('[盘] 列出盘上真实卡名：无状态非正式卡也要出现', async (t) => {
    const H = await H_LOAD;
    const fixture = {
      result: {
        worktrees: [
          { isMainWorktree: true, displayName: 'master', agents: [] },
          {
            displayName: 'PR-#729 工人·cursor-grok-4.6-xhigh-fast 扩盘面',
            workspaceStatus: 'in-review',
            parentWorktreeId: null,
            worktreeId: 'parent-729',
            linkedPR: { number: 729 },
            agents: [{ state: 'working' }],
          },
          {
            displayName: 'PR-#729 审官·gpt-5.6-sol',
            parentWorktreeId: 'parent-729',
            worktreeId: 'child-729',
            agents: [{ state: 'working' }],
          },
          { isMainWorktree: false, displayName: 'debug-fresh-ws', agents: [] },
          { isMainWorktree: false, displayName: '微修样本-空卡', agents: [] },
          { isMainWorktree: false, displayName: 'exam-arena', agents: [] },
        ],
      },
    };
    const s = H.summarizeBoard(fixture);
    await t.test('无状态非正式卡进 onBoard，不进在途',
      () => {
        assert.ok(s.unscanned === false && s.inFlight.length === 1 && s.inFlight[0].number === 729
          && s.onBoard.length === 4
          && s.onBoard.some(c => c.name === 'debug-fresh-ws' && !c.status)
          && s.onBoard.some(c => c.name === '微修样本-空卡' && !c.status)
          && s.onBoard.some(c => c.name === 'exam-arena' && !c.status),
          '无状态非正式卡进 onBoard  →  ' + JSON.stringify(s.onBoard));
      });
    await t.test('审官子卡不进盘面清单',
      () => {
        assert.ok(!s.onBoard.some(c => /审官/.test(c.name)), '审官子卡不进盘面清单  →  ' + JSON.stringify(s.onBoard));
      });
    await t.test('主树不进盘面清单',
      () => {
        assert.ok(!s.onBoard.some(c => c.name === 'master'), '主树不进盘面清单  →  ' + JSON.stringify(s.onBoard));
      });
    const line = H.boardLine(s);
    await t.test('盘面短名：#729审中 + 非正式名；不塞整段模型名',
      () => {
        assert.ok(/盘面 #729审中 debug-fresh-ws 微修样本-空卡 exam-arena/.test(line)
          && !/cursor-grok-4\.6-xhigh-fast/.test(line)
          && /在途 #729\(审中\)/.test(line),
          '盘面短名  →  ' + line);
      });
    await t.test('shortCardLabel 喂返回值：有号拼状态，无号取首段',
      () => {
        assert.ok(H.shortCardLabel({ number: 729, status: '审中' }) === '#729审中'
          && H.shortCardLabel({ name: 'debug-fresh-ws' }) === 'debug-fresh-ws'
          && H.shortCardLabel({ name: 'PR-#729 工人·cursor-grok-4.6-xhigh-fast 扩盘面' }) === 'PR-#729',
          'shortCardLabel  →  ' + [
            H.shortCardLabel({ number: 729, status: '审中' }),
            H.shortCardLabel({ name: 'debug-fresh-ws' }),
            H.shortCardLabel({ name: 'PR-#729 工人·cursor-grok-4.6-xhigh-fast 扩盘面' }),
          ].join(' | '));
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
        assert.ok(/在途 #588\(做中\) #582\(审中\)/.test(line) && /待收口 无/.test(line) && /盘面 #588做中 #582审中/.test(line),
          '一行能读出单号和状态  →  ' + line);
      });
    await t.test('待消歧为空时不占位',
      () => {
        assert.ok(!/待消歧/.test(line), '待消歧为空时不占位  →  ' + line);
      });
  });

  it('#807：本机守卫保活已删（inboxInjection / guardInjection / haltInjection 都不在）', async (t) => {
    const H = await H_LOAD;
    await t.test('inboxInjection / guardInjection / haltInjection 已删除',
      () => {
        assert.ok(typeof H.inboxInjection === 'undefined'
          && typeof H.guardInjection === 'undefined'
          && typeof H.haltInjection === 'undefined',
          '守卫注入不该再存在');
      });
  });

  // 2026-08-31 停派工归零（docs/decisions/2026-08-31-local-guards-retire-with-server.md）：
  // 盘面注入随本机编排一起停，挂点摘除；恢复 = revert 那个 commit。
  // 上面的纯函数测试全部保留——代码死缓不删，逻辑仍要能测。
  it('停派工态：settings.json 不挂 UserPromptSubmit（盘面注入已摘除）', () => {
    const settings = JSON.parse(require('fs').readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8'));
    assert.ok(!settings.hooks?.UserPromptSubmit,
      'UserPromptSubmit 应已摘除  →  ' + JSON.stringify(settings.hooks));
  });

  it('#684 board-hook 不每轮 sync 帅位定界区（拍板取舍）', () => {
    const src = require('fs').readFileSync(HOOK, 'utf8');
    assert.ok(!/syncMasterTicketZone/.test(src) && !/mutateWorktreeComment/.test(src),
      '#684 board-hook 不写定界区');
  });
});