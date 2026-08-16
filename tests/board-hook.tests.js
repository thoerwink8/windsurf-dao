// 盘面摘要 hook 纯函数回归（issue #564 第 1 条 + comment 追加的信箱台自愈）。
//
// 验的层：① summarizeBoard 从 orca worktree ps 快照算三数（master/archived 不计）
// ② boardLine 两形分得开——扫完是空的（全 0）≠ 这次没扫到（没查成）
// ③ inboxInjection 三态：健康静音 / 自愈留痕 / 失败可辨认（只报不拦）
// ④ 真实 hook 端到端留到手工验收（本套不碰 orca）

const { spawnSync } = require('child_process');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const HOOK = path.join(REPO, 'scripts', 'lib', 'board-hook.mjs');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  →  ' + detail : ''}`); }
}

async function main() {
  const H = await import('file://' + HOOK.replace(/\\/g, '/'));

  console.log('\n=== #564 盘面摘要：summarizeBoard 三数口径 ===');
  {
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
    check('三数口径：master/archived/无 agent 壳卡不计，在途/待收口/待消歧各归各',
      s.scanned === 5 && s.inFlight === 2 && s.closing === 1 && s.todo === 1, JSON.stringify(s));
    check('扫完是真扫了（scanned>0 且 unscanned=false）', s.unscanned === false && s.scanned > 0, JSON.stringify(s));

    const bad = H.summarizeBoard({ result: {} });
    check('没拿到 worktrees 数组 → unscanned，不许当扫完是空的', bad.unscanned === true, JSON.stringify(bad));
  }

  console.log('\n=== #564 盘面摘要：两形分得开（扫完真空 ≠ 没扫到）===');
  {
    const emptyLine = H.boardLine({ inFlight: 0, closing: 0, todo: 0, scanned: 3, unscanned: false });
    const unscanLine = H.boardLine({ unscanned: true, error: 'orca worktree ps 失败（exit 1）' });
    check('扫完全 0 → 「在途 0 · 待消歧 0 · 待收口 0」', /在途 0 · 待消歧 0 · 待收口 0/.test(emptyLine), emptyLine);
    check('没扫到 → 「[盘] 没查成：…」不是全 0 形', /没查成/.test(unscanLine) && unscanLine !== emptyLine, unscanLine);
  }

  console.log('\n=== #564 信箱台自愈：健康静音 / 自愈留痕 / 失败可辨认 ===');
  {
    const healthy = H.inboxInjection({ script: 'x', exec: () => ({ status: 0, stdout: '{"ok":true,"action":"noop"}\n' }) });
    check('台全活着 → 静音（不刷屏；[盘] 行的存在就是活证）', healthy === null, String(healthy));

    const healed = H.inboxInjection({ script: 'x', exec: () => ({ status: 0, stdout: '{"ok":true,"action":"restart","reason":"relay-dead"}\n' }) });
    check('台死了被 ensure 自愈 → 留痕「已自愈」', healed !== null && /已自愈/.test(healed), String(healed));

    const failed = H.inboxInjection({ script: 'x', exec: () => ({ status: 1, stdout: '{"ok":false,"error":"terminal list 失败"}\n' }) });
    check('自愈失败 → 可辨认错误串，不是空', failed !== null && /自愈失败/.test(failed) && /terminal list 失败/.test(failed), String(failed));

    const crashed = H.inboxInjection({ script: 'x', exec: () => ({ error: { message: 'ENOENT' }, status: null }) });
    check('ensure 直接崩 → 报「自愈失败」(无输出也不许吞)', crashed !== null && /自愈失败/.test(crashed), String(crashed));
  }

  console.log('\n=== #564 接线：settings.json UserPromptSubmit 只挂一条命令（盘面+自愈合一）===');
  {
    const settings = JSON.parse(require('fs').readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8'));
    const ups = settings.hooks?.UserPromptSubmit || [];
    const commands = ups.flatMap(g => (g.hooks || []).map(h => h.command));
    check('UserPromptSubmit 是数组且挂了 board-hook', commands.length >= 1 && commands.some(c => c.includes('board-hook.mjs')), JSON.stringify(commands));
    check('盘面与自愈合成一条命令（不挂两条互相拖超时）', commands.length === 1, JSON.stringify(commands));
  }

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();