// #1150 审官红 2：现役帮助不许再宣传已退役 dao 入口。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'retired-verb-advert-check.mjs');
const FIX = path.join(REPO, 'tests', 'fixtures', 'retired-verb-advert');
const LOAD = import('file://' + LIB.split(path.sep).join('/'));

describe('retired-verb-advert', () => {
  it('扫描器：照抄入口红，同一行交代退役绿', async () => {
    const { scanRetiredAdverts } = await LOAD;
    const red = scanRetiredAdverts('node scripts/dao.mjs reviewer-attach --pr 1');
    assert.equal(red.length, 1);
    assert.equal(red[0].id, 'reviewer-attach');

    const send = scanRetiredAdverts('必须用 dao.mjs send/notify 送达');
    assert.equal(send.length, 1);
    assert.equal(send[0].id, 'send');

    const usage = scanRetiredAdverts('  notify --subject <文>\n  dispatch --batch <file.json>');
    assert.equal(usage.map((h) => h.id).sort().join(','), 'dispatch-batch,notify');

    const ok = scanRetiredAdverts('不要调 dao.mjs send / notify——已随 orca 编排退役，调用即拒。');
    assert.equal(ok.length, 0);

    const batchRetired = scanRetiredAdverts('`dispatch --batch` 已随执行体退役。调用当场拒。');
    assert.equal(batchRetired.length, 0);

    const ts = scanRetiredAdverts('吞注入才走 terminal send 补救');
    assert.equal(ts.length, 1);
    assert.equal(ts[0].id, 'terminal-send');

    const orcaTs = scanRetiredAdverts('orca terminal send --text hi --enter');
    assert.equal(orcaTs.length, 1);
    assert.equal(orcaTs[0].id, 'terminal-send');

    const okTs = scanRetiredAdverts('没有 terminal send 可补（orca 已退役，调用即拒）。');
    assert.equal(okTs.length, 0);
  });

  it('夹具红/绿/空有判别力', async () => {
    const { inspectRetiredVerbAdvertFixtures } = await LOAD;
    const r = inspectRetiredVerbAdvertFixtures(FIX);
    assert.equal(r.ok, true, r.error || '');
    assert.equal(r.kinds.red, 1);
    assert.equal(r.kinds.ok, 1);
    assert.equal(r.kinds.empty, 1);

    const missing = inspectRetiredVerbAdvertFixtures(path.join(FIX, 'no-such'));
    assert.equal(missing.ok, false);
    assert.equal(missing.unscanned, true);
  });

  it('live 本仓必须绿；故意塞一条照抄必须红；0 文件没查成', async () => {
    const { checkRetiredVerbAdvert } = await LOAD;
    const live = checkRetiredVerbAdvert({ root: REPO });
    assert.equal(live.fail, undefined, live.fail && live.fail.join('；'));
    assert.match(live.green, /未宣传退役入口/);

    const empty = checkRetiredVerbAdvert({ root: REPO, manuals: [] });
    assert.ok(empty.fail);
    assert.match(empty.fail[0], /一个文件都没扫到/);

    const mutated = checkRetiredVerbAdvert({
      root: REPO,
      files: {
        'host/skills/dispatch/SKILL.md': '走 node scripts/dao.mjs notify --subject x\n',
      },
    });
    assert.ok(mutated.fail);
    assert.match(mutated.fail[0], /宣传已退役入口/);

    const mutatedSend = checkRetiredVerbAdvert({
      root: REPO,
      files: {
        'host/skills/dispatch/SKILL.md': '吞注入才走 terminal send 补救\n',
      },
    });
    assert.ok(mutatedSend.fail);
    assert.match(mutatedSend.fail[0], /宣传已退役入口/);
    assert.match(mutatedSend.fail[2], /terminal-send/);
  });

  it('wakeBrain 生成的任务书不再要求 send/notify', async () => {
    const CMD = path.join(REPO, 'scripts', 'commander.mjs');
    const { buildBrainPointer } = await import('file://' + CMD.split(path.sep).join('/'));
    const pointer = buildBrainPointer({
      situFile: '/tmp/situation.json',
      target: 'stall:term',
      why: '撞死',
    });
    assert.match(pointer, /GitHub 评论/);
    assert.match(pointer, /飞书 hub/);
    assert.match(pointer, /不要调 dao\.mjs send/);
    assert.match(pointer, /已退役/);
    assert.doesNotMatch(pointer, /必须用 dao\.mjs send\/notify/);
    assert.doesNotMatch(pointer, /只留评论不算送达/);

    const { scanRetiredAdverts } = await LOAD;
    assert.equal(scanRetiredAdverts(pointer).length, 0);

    const skill = fs.readFileSync(path.join(REPO, 'host', 'skills', 'commander', 'SKILL.md'), 'utf8');
    assert.match(skill, /GitHub 评论/);
    assert.match(skill, /不要调 `dao\.mjs send`/);
    assert.equal(scanRetiredAdverts(skill).length, 0);
  });
});
