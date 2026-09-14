import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/no-network.mjs';

// ── 帅位自开 PR 挑哪条工人腿（2026-09-14 用户拍板：grok-4.6）──
//
// 挑错的代价不是报个错，是开出一张**任何合法审官都派不上去**的 PR：
// 审官位闸只认当前座位或其同厂备选，同厂闸又禁止工人与审官同厂
// ⇒ 工人一旦与座位同厂，这张 PR 就没有合法审官。
// 2026-09-14 实咬：帅位手打 codex-relay-gpt-5.6-luna（GPT，与座位同厂），
// #1265/#1266/#1270/#1271/#1272 五张全部零判定，三轮后打「卡死/自动化认输」。
describe('帅位自开 PR 的工人腿', () => {
  const DAO = import('../scripts/dao.mjs');
  const ROUTING = import('../scripts/lib/model-routing-json.mjs');
  const LAUNCH = import('../scripts/lib/dispatch/launch.mjs');
  const loadRouting = async () => (await LAUNCH).loadRouting();

  it('①默认腿就是拍板那条 grok-4.6', async () => {
    const { defaultMarshalWorker } = await DAO;
    const routing = await loadRouting();
    assert.equal(defaultMarshalWorker(routing), 'grok-4.6');
  });

  it('②默认腿必须与**当前审官座位**跨厂——这是它存在的全部理由', async () => {
    const { defaultMarshalWorker, crossVendorWorkersFor } = await DAO;
    const routing = await loadRouting();
    const { currentReviewerSeat } = await import('../scripts/lib/dispatch/reviewer.mjs');
    const seat = currentReviewerSeat(routing);
    assert.equal(seat.ok, true, '座位读不出来就谈不上跨厂');
    const ok = crossVendorWorkersFor(seat.modelId, routing);
    assert.equal(ok.includes(defaultMarshalWorker(routing)), true, '默认腿必须在「与座位跨厂」的名单里');
    assert.equal(ok.includes('codex-relay-gpt-5.6-luna'), false,
      '与座位同厂的腿一条都不许进——那正是 2026-09-14 五张 PR 卡死的那一条');
  });

  it('③可选集只收在役腿：退役的 windsurf/pqapi/opencode 一条都不许进', async () => {
    const { crossVendorWorkersFor } = await DAO;
    const routing = await loadRouting();
    const ids = crossVendorWorkersFor('gpt-5.6-luna', routing);
    for (const dead of ['windsurf-deepseek', 'codex-pqapi-luna', 'opencode-zen-deepseek', 'kimi-k3']) {
      assert.equal(ids.includes(dead), false, `${dead} 已退役（执行目录里没有 enabled 条目），不许当默认腿`);
    }
    assert.equal(ids.length > 0 && ids.length < 10, true, `在役跨厂腿应是个位数，实得 ${ids.length}：${ids.join('、')}`);
  });

  it('④偏好只排序、不放行：JSON 里写一条与座位同厂的，也不许被选中', async () => {
    const { crossVendorWorkersFor } = await DAO;
    const routing = await loadRouting();
    const ids = crossVendorWorkersFor('gpt-5.6-luna', routing);
    // defaultMarshalWorker 的实现是「偏好 ∩ 可选集」，可选集里没有就跳过 —— 这里直接钉可选集
    assert.equal(ids.includes('gpt-5.6-sol'), false, '同厂的 sol 不在可选集里，偏好写了它也选不中');
  });

  it('⑤拍板落在 JSON 里，不在代码里（选型只认 JSON，2026-08-22）', async () => {
    const { loadRoutingJsonRaw } = await ROUTING;
    const raw = loadRoutingJsonRaw();
    const node = raw['帅'] && raw['帅']['自开PR工人'];
    assert.equal(!!node, true, '帅.自开PR工人 节必须在，否则这条拍板没有落点');
    const ids = (node['模型'] || []).filter((m) => m && m['禁用'] !== true).map((m) => m.id);
    assert.deepEqual(ids, ['grok-4.6']);
    const one = node['模型'][0];
    assert.equal(one['拍板'], '2026-09-14');
    assert.equal(typeof one['理由'] === 'string' && one['理由'].length > 40, true, '理由要说清为什么是这条腿');
  });
});
