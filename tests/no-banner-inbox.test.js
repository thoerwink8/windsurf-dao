// #667 横幅收信整层：检查器判别力 + live 扫描
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'no-banner-inbox-check.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

describe('no-banner-inbox-check', () => {
  it('样本红绿有判别力', async (t) => {
    const S = await LIB_LOAD;
    const fx = S.inspectNoBannerInboxFixtures(path.join(REPO, 'tests', 'fixtures', 'no-banner-inbox'));
    await t.test('夹具齐且绿', () => {
      assert.ok(fx.ok === true && fx.kinds.red >= 1 && fx.kinds.ok >= 1, '夹具齐且绿  →  ' + JSON.stringify(fx));
    });
    const missing = S.inspectNoBannerInboxFixtures(path.join(REPO, 'tests', 'fixtures', 'no-such-dir'));
    await t.test('目录不在 → unscanned', () => {
      assert.ok(missing.ok === false && missing.unscanned === true, '目录不在 → unscanned');
    });
  });

  it('扫描器：裸 run-use / 横幅教法 / 心跳禁令', async (t) => {
    const S = await LIB_LOAD;
    await t.test('故意违规裸 run-use', () => {
      const hits = S.scanRawRunUseWithoutFrom("orca(['orchestration', 'run-use', '--id', runId, '--json']);");
      assert.ok(hits.length === 1, '故意违规裸 run-use  →  ' + JSON.stringify(hits));
    });
    await t.test('带 --from 不算违规', () => {
      const hits = S.scanRawRunUseWithoutFrom("runOrca(['orchestration', 'run-use', '--id', id, '--from', h, '--json']);");
      assert.ok(hits.length === 0, '带 --from 不算违规  →  ' + JSON.stringify(hits));
    });
    await t.test('故意教横幅收信', () => {
      const hits = S.scanBannerDeliveryTeach('完工信号经 帅对话横幅（You have N orchestration messages）');
      assert.ok(hits.length >= 2, '故意教横幅收信  →  ' + JSON.stringify(hits));
    });
    await t.test('心跳不准发 命中禁令', () => {
      assert.ok(S.hasHeartbeatBan('心跳不准发到 Run') === true && S.hasHeartbeatBan('每 5 分钟 heartbeat') === false);
    });
  });

  it('live 仓内文件应绿', async (t) => {
    const S = await LIB_LOAD;
    const r = S.inspectNoBannerInboxLive({
      daoSrc: fs.readFileSync(path.join(REPO, 'scripts', 'dao.mjs'), 'utf8'),
      skillSrc: fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'SKILL.md'), 'utf8'),
      soldierSrc: fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'templates', 'soldier-book.md'), 'utf8'),
    });
    await t.test('live 绿', () => {
      assert.ok(r.ok === true && r.unscanned === false, 'live 绿  →  ' + JSON.stringify(r));
    });
    const empty = S.inspectNoBannerInboxLive({});
    await t.test('没给正文 → unscanned', () => {
      assert.ok(empty.ok === false && empty.unscanned === true, '没给正文 → unscanned');
    });
  });
});
