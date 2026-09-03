// 说人话闸（用户 2026-09-04 拍板，落地清单第 9 步）：机器人发到群里的每种文案都要过 plainViolations 为空。
// 判别力：故意黑话样本必须被抓；真文案生成器（盘点/限流探测）喂红态样本后必须干净。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const url = (p) => 'file://' + path.join(REPO, p).replace(/\\/g, '/');

describe('说人话闸', () => {
  it('黑话样本一条条被抓（截图里的原话）', async () => {
    const { plainViolations } = await import(url('scripts/lib/plain-words.mjs'));
    const bad = [
      '孤儿进程 cwd 已删 1 个：pid=1850627 comm=pi cwd=/home/orca/orca/workspaces/x (deleted)',
      '指挥官 timer 未 enabled：commander-act.timer=disabled——node scripts/commander.mjs install',
      '影响：pool 红 = 整条降级链不通；leg 红 = 那条腿死',
      'HTTP 503 连红',
      '已换人 term_9d5d7780 --reviewer luna',
    ];
    for (const s of bad) assert.ok(plainViolations(s).length > 0, `该抓没抓：${s}`);
  });

  it('每条规则一个独占样本（审官红1：注掉任一条规则这里必红，不许互相顶班）', async () => {
    const { plainViolations } = await import(url('scripts/lib/plain-words.mjs'));
    // 样本设计成只命中一条规则：断言 violations 恰好 1 条且 why 对得上。
    const oneEach = [
      ['pid=123', '进程号'],
      ['cwd=/somewhere', '工作目录字段'],
      ['comm=pi', '进程名字段'],
      ['句柄 term_9d5d7780abcd', '终端句柄'],
      ['commander-act.timer 停了', 'systemd 单元名'],
      ['去 journalctl 看', 'systemd 命令/日志'],
      ['它是 disabled 状态', '英文状态词'],
      ['文件在 /home/orca/x 里', '文件路径'],
      ['跑 node scripts/commander.mjs', '命令行'],
      ['加 --force 参数', '命令行参数'],
      ['HTTP 503 错误', 'HTTP 状态码'],
      ['这是 worktree 的问题', '内部英文代号'],
      ['pool 红了', '探针内部分类词'],
      ['有 3 个 live agent', 'live agent'],
    ];
    for (const [sample, whyPart] of oneEach) {
      const v = plainViolations(sample);
      assert.ok(v.length >= 1, `该抓没抓：${sample}`);
      assert.ok(v.some((x) => x.why.includes(whyPart)), `${sample} 抓到的是 ${JSON.stringify(v)}，缺「${whyPart}」`);
      assert.equal(v.filter((x) => !x.why.includes(whyPart)).length, 0, `${sample} 不该命中别的规则：${JSON.stringify(v)}`);
    }
  });

  it('人话样本放行', async () => {
    const { plainViolations } = await import(url('scripts/lib/plain-words.mjs'));
    const good = [
      '有 1 个干活的程序还在跑，但它的工位已经拆了（#833 的旧工位）\n影响：白占服务器资源\n我打算：开单，你放行后我关掉',
      '已经为你记录了这项需求，单号为 #3031。',
      'PR #850 已合并，指挥官自动派单已重开。',
      '网关有 2 条线路连续 3 次没回真内容（grok 池、deepseek 池）',
    ];
    for (const s of good) assert.deepEqual(plainViolations(s), [], `误抓：${s}`);
  });

  it('盘点合并文案：六种红态喂进去，一条消息、零黑话', async () => {
    const { buildInventoryHubText } = await import(url('scripts/lib/commander-inventory.mjs'));
    const { plainViolations } = await import(url('scripts/lib/plain-words.mjs'));
    const reds = [
      { key: 'orphan-cwd', detail: 'pid=1 comm=pi cwd=/x (deleted)', plain: { what: '有 1 个干活的程序还在跑，但它的工位已经拆了（#833 的旧工位）', impact: '白占资源', plan: '开单待你放行' } },
      { key: 'timers', detail: 'commander-act.timer=disabled', plain: { what: '指挥官的定时任务有 1 个是关着的（含自动派单）', impact: '新单不会自动派', plan: '故意关的不用管' } },
    ];
    const text = buildInventoryHubText(reds);
    assert.match(text, /发现 2 处不对/);
    assert.match(text, /1）/);
    assert.match(text, /2）/);
    assert.deepEqual(plainViolations(text), [], text);
    assert.doesNotMatch(text, /pid=|\.timer/, 'detail 里的技术细节不许漏进群');
    const one = buildInventoryHubText([reds[0]]);
    assert.match(one, /发现 1 处不对/);
    assert.doesNotMatch(one, /1）/, '只有一处不编号');
  });

  it('盘点没给 plain 的红项也能说（退化到 detail），不炸', async () => {
    const { buildInventoryHubText } = await import(url('scripts/lib/commander-inventory.mjs'));
    const text = buildInventoryHubText([{ key: 'x', detail: '某某异常' }]);
    assert.match(text, /某某异常/);
  });

  it('限流探测报告：换人成功/失败/停手/只提醒四态，零黑话、无句柄', async () => {
    const { buildStallReport } = await import(url('scripts/agent-stall-watch.mjs'));
    const { plainViolations } = await import(url('scripts/lib/plain-words.mjs'));
    const text = buildStallReport({
      failed: 1, need: 2,
      items: [
        { name: 'PR-851-审官【luna】term_9d5d7780-c28a', action: 'switch', ok: true, from: 'gpt-5.6-luna', to: 'gpt-5.6-sol' },
        { name: 'PR-850-审官', action: 'switch', ok: false, from: 'a', to: 'b', detail: '换人失败：上游没响应' },
        { name: 'ISSUE-807-工人', action: 'escalate', reason: '选型序走完' },
        { name: 'ISSUE-843-工人', action: 'alert', reason: '不是审官，不自动换' },
      ],
    });
    assert.match(text, /^有 1 个卡住的工人换人没成功/);
    assert.match(text, /已换成 gpt-5.6-sol/);
    assert.match(text, /没换成——上游没响应/);
    assert.match(text, /先停手等你拍/);
    assert.match(text, /先只提醒不换人/);
    assert.doesNotMatch(text, /term_|【/);
    assert.deepEqual(plainViolations(text), [], text);
    assert.match(buildStallReport({ failed: 0, need: 2, items: [{ name: 'a', action: 'switch', ok: true, from: 'x', to: 'y' }] }), /已按备选顺序换人/);
    assert.match(buildStallReport({ failed: 0, need: 2, items: [{ name: 'a', action: 'alert', reason: 'r' }] }), /这次没换人/); // 审官疑问4：没换成事实别说换了
  });

  it('机器人人格文件带说人话规则与口吻参照', () => {
    const fs = require('fs');
    const md = fs.readFileSync(path.join(REPO, 'host/skills/feishu-triage/persona.md'), 'utf8');
    assert.match(md, /说人话/);
    assert.match(md, /已经为你记录了这项需求/);
    assert.match(md, /直接告诉我编号即可/);
  });
});

describe('收工：僵尸终端', () => {
  it('只关「目录确实不存在」的；没挂工位/目录在/没查成一律不动', async () => {
    const { decideTerminalClose, hasLandWork } = await import(url('scripts/lib/land-core.mjs'));
    assert.equal(decideTerminalClose({ path: '/x/gone', exists: false }).close, true);
    assert.equal(decideTerminalClose({ path: '/x/here', exists: true }).close, false);
    assert.equal(decideTerminalClose({ path: '/x/unk', exists: null }).close, false, '没查成不是没事');
    assert.equal(decideTerminalClose({ path: '', exists: false }).close, false, '裸终端不动');
    assert.equal(hasLandWork({ shipAction: 'clean', removeCount: 0, deleteCount: 0, zombieCount: 3 }), true);
    assert.equal(hasLandWork({ shipAction: 'clean', removeCount: 0, deleteCount: 0 }), false);
  });
});
