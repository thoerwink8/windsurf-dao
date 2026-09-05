// 派前探超时不算红（#853）
//
// 2026-09-03 实咬：reviewer-create --pr 796 的派前探把 gpt-5.6-luna / kimi-k3 / gpt-5.6-sol
// 全判红（>5000ms），换位到 glm-5.2——而 luna 当时正在审 PR #850/#851，通道好好的，
// 只是排队下 5s 内没吐首 token。判红的代价不是慢一点，是**当场换人**。
//
// 本文件钉三件事：
//  ① 判据：怎么区分「上游说不行」和「我们自己等不及了」——只吃结构化字段，不解析 why 里的中文。
//  ② 接线：超时是软态——不换人、不停手、不记熔断失败；而真错误码照旧红、照旧换人、照旧记熔断。
//  ③ 阈值：30000ms 是量出来的，不是拍出来的。数字被人随手改回 5000 时这里要红。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const url = (rel) => 'file://' + resolve(REPO, rel).replace(/\\/g, '/');
const PREFLIGHT = url('scripts/lib/preflight.mjs');
const PROBE = url('scripts/lib/provider-probe.mjs');

const POLICY = { enabled: true, timeoutMs: 5000, maxCandidates: 4, useHealthTable: false };
const SLATE = [
  { id: 'gpt-5.6-luna', pipes: [{ provider: 'gw', cli_model: 'gw-windsurf/gpt-5.6-luna' }] },
  { id: 'kimi-k3', pipes: [{ provider: 'gw', cli_model: 'gw-sub/kimi-k3-high' }] },
  { id: 'glm-5.2', pipes: [{ provider: 'gw', cli_model: 'gw-windsurf/glm-5-2' }] },
];

/** 按 id 给态的假探针。ms 默认踩满预算（模拟「被我们自己的秒表掐掉」）。 */
function fakeProbe(byId, { timeoutMs = POLICY.timeoutMs } = {}) {
  return async (landing) => {
    const model = String(landing.cli_model || '').split('/').pop();
    const id = { 'gpt-5.6-luna': 'gpt-5.6-luna', 'kimi-k3-high': 'kimi-k3', 'glm-5-2': 'glm-5.2' }[model] || model;
    const want = byId[id] || 'green';
    if (want === 'green') return { state: 'green', code: 200, ms: 1200, why: '收到真内容且收尾', target: `t:${id}` };
    if (want === 'slow') return { state: 'red', code: null, ms: timeoutMs + 14, why: `超时（>${timeoutMs}ms）`, target: `t:${id}` };
    if (want === 'red') return { state: 'red', code: 403, ms: 90, why: 'HTTP 403 假 token', target: `t:${id}` };
    return { state: want, code: 200, ms: 300, why: want, target: `t:${id}` };
  };
}

test('① 判据：上游说不行 vs 我们等不及了（只看结构化字段）', async (t) => {
  const { isProbeTimeout, PROBE_TIMEOUT_TOLERANCE_MS } = await import(PREFLIGHT);

  await t.test('预算用满 + 上游一个码都没给 → 超时', () => {
    assert.equal(isProbeTimeout({ state: 'red', code: null, ms: 5014 }, 5000), true);
  });

  await t.test('2xx 起了流但没吐内容就被掐 → 也是超时（上游没说过「不行」）', () => {
    assert.equal(isProbeTimeout({ state: 'red', code: 200, ms: 5003 }, 5000), true);
  });

  await t.test('真错误码照旧红，跑多久都一样', () => {
    for (const code of [401, 403, 429, 500, 502, 503]) {
      assert.equal(isProbeTimeout({ state: 'red', code, ms: 60000 }, 5000), false, `HTTP ${code} 是上游明说不行，不许洗成超时`);
    }
  });

  await t.test('没到预算就红的（2xx 空流 / 连接被拒）→ 红，不是超时', () => {
    assert.equal(isProbeTimeout({ state: 'red', code: 200, ms: 120 }, 5000), false);
    assert.equal(isProbeTimeout({ state: 'red', code: null, ms: 35 }, 5000), false);
  });

  await t.test('容差只吃几十毫秒，不许把「早退两秒」也算成超时', () => {
    assert.ok(PROBE_TIMEOUT_TOLERANCE_MS > 0 && PROBE_TIMEOUT_TOLERANCE_MS <= 200, `容差 ${PROBE_TIMEOUT_TOLERANCE_MS}ms 不合理`);
    assert.equal(isProbeTimeout({ state: 'red', code: null, ms: 5000 - PROBE_TIMEOUT_TOLERANCE_MS }, 5000), true);
    assert.equal(isProbeTimeout({ state: 'red', code: null, ms: 5000 - PROBE_TIMEOUT_TOLERANCE_MS - 1 }, 5000), false);
    assert.equal(isProbeTimeout({ state: 'red', code: null, ms: 3000 }, 5000), false);
  });

  await t.test('非 red 的态原样放过（green / no_finish / unscanned 不归本判据管）', () => {
    for (const state of ['green', 'no_finish', 'unscanned', 'timeout']) {
      assert.equal(isProbeTimeout({ state, code: null, ms: 9999 }, 5000), false);
    }
  });

  await t.test('缺 ms / 预算不合法 → 不敢判超时（宁可照旧红，不许猜）', () => {
    assert.equal(isProbeTimeout({ state: 'red', code: null, ms: null }, 5000), false);
    assert.equal(isProbeTimeout({ state: 'red', code: null, ms: 5014 }, 0), false);
    assert.equal(isProbeTimeout({ state: 'red', code: null, ms: 5014 }, NaN), false);
    assert.equal(isProbeTimeout(null, 5000), false);
  });
});

test('② 接线：超时不换人、不停手、不记熔断；红照旧', async (t) => {
  const { runPreflight } = await import(PREFLIGHT);
  const run = (over = {}) => runPreflight({
    candidates: SLATE, policy: POLICY, role: '审官', dispatchId: 'd853',
    breakerDoc: { targets: {} }, audit: () => {}, recordBreaker: () => ({ ok: true }),
    ...over,
  });

  await t.test('#853 复现：首选超时、后面有真绿 → 仍不该把超时那位记成 red', async () => {
    const audits = [];
    const r = await run({ probe: fakeProbe({ 'gpt-5.6-luna': 'slow' }), audit: (a) => audits.push(a) });
    const luna = audits.find((a) => a.model === 'gpt-5.6-luna');
    assert.equal(luna.state, 'timeout', 'ndjson 里写 red 就等于把误判固化进历史，事后没法复盘');
    assert.match(String(luna.why), /不判红/);
  });

  await t.test('全都超时 → 不停手，回退第一位（换位的动作根本不该发生）', async () => {
    const r = await run({ probe: fakeProbe({ 'gpt-5.6-luna': 'slow', 'kimi-k3': 'slow', 'glm-5.2': 'slow' }) });
    assert.equal(r.stop, false, '排队慢不是故障，不该报帅停手');
    assert.equal(r.chosen, 'gpt-5.6-luna', '#853 的病灶就是这里换成了 glm——顺位第一的通道没被证伪就不许换');
    assert.equal(r.allRed, false);
    assert.equal(r.fallbackState, 'timeout', '回退原因要说清是超时，不许糊成一句「不可用」');
    assert.ok(r.notes.some((n) => /超时/.test(n)), `回退要留痕，实际 notes=${JSON.stringify(r.notes)}`);
  });

  await t.test('有真绿时仍选真绿（超时不许顶替 green）', async () => {
    const r = await run({ probe: fakeProbe({ 'gpt-5.6-luna': 'slow', 'kimi-k3': 'green' }) });
    assert.equal(r.chosen, 'kimi-k3');
  });

  await t.test('故意违规样本：全红（403）必须照旧停手——反证这条放行没把 red 一起放掉', async () => {
    const r = await run({ probe: fakeProbe({ 'gpt-5.6-luna': 'red', 'kimi-k3': 'red', 'glm-5.2': 'red' }) });
    assert.equal(r.stop, true);
    assert.equal(r.allRed, true);
    assert.equal(r.chosen, null);
  });

  await t.test('超时不记熔断失败——三次超时就 cooldown 24h，正是误换位的放大器', async () => {
    const events = [];
    await run({
      probe: fakeProbe({ 'gpt-5.6-luna': 'slow', 'kimi-k3': 'slow', 'glm-5.2': 'slow' }),
      recordBreaker: (ev) => { events.push(ev); return { ok: true }; },
    });
    assert.deepEqual(events.filter((e) => e.type === 'failure'), [], '超时是「没结论」，没有证据可记');
  });

  await t.test('反证：真红照旧记熔断失败（判据不是「什么都不记」）', async () => {
    const events = [];
    await run({
      probe: fakeProbe({ 'gpt-5.6-luna': 'red', 'kimi-k3': 'red', 'glm-5.2': 'red' }),
      recordBreaker: (ev) => { events.push(ev); return { ok: true }; },
    });
    assert.equal(events.filter((e) => e.type === 'failure').length, 3);
  });

  await t.test('reasons 里超时和红分得开', async () => {
    const r = await run({ probe: fakeProbe({ 'gpt-5.6-luna': 'slow', 'kimi-k3': 'red', 'glm-5.2': 'green' }) });
    assert.ok((r.reasons['gpt-5.6-luna'] || []).some((x) => x.startsWith('timeout:')));
    assert.ok((r.reasons['kimi-k3'] || []).some((x) => x.startsWith('probe:red')));
  });
});

test('③ 判别性实验：真探针 + 真慢上游，只差一个 timeoutMs', async (t) => {
  // 不用假探针——用 provider-probe 的真实请求路径打一个「憋住 N 毫秒才吐首字节」的本地网关。
  // 这是 #853 的机制原样复刻：排队型网关首字节慢，通道本身完全正常。
  const { planProbe, runProbe } = await import(PROBE);
  const DELAY_MS = 1200;
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('data: {"choices":[{"delta":{"content":"pong"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }, DELAY_MS);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const gatewayConfig = { ok: true, gateway: `http://127.0.0.1:${port}`, providers: [{ id: 'gw', token: 'probe-fake-token' }] };
  const plan = planProbe({ provider: 'gw', cli_model: 'gw/slow-model' }, { gatewayConfig });

  try {
    await t.test('预算比首字节短 → 探针回 red（这就是 5000ms 之下 gw-sub 组的处境）', async () => {
      const r = await runProbe(plan, { timeoutMs: DELAY_MS - 700, gatewayConfig });
      assert.equal(r.state, 'red', JSON.stringify(r));
      assert.equal(r.code, null, '连响应头都没等到——上游一句话都没说过');
    });

    await t.test('同一个通道、同一针，预算给够就是绿的', async () => {
      const r = await runProbe(plan, { timeoutMs: DELAY_MS + 8000, gatewayConfig });
      assert.equal(r.state, 'green', JSON.stringify(r));
    });

    await t.test('接进 runPreflight：预算不够时判成 timeout 而不是 red，因此不换人', async () => {
      const { runPreflight, isProbeTimeout } = await import(PREFLIGHT);
      const tight = { ...POLICY, timeoutMs: DELAY_MS - 700 };
      const probe = () => runProbe(plan, { timeoutMs: tight.timeoutMs, gatewayConfig });
      const raw = await probe();
      assert.equal(isProbeTimeout(raw, tight.timeoutMs), true, `真探针的返回要认得出是超时：${JSON.stringify(raw)}`);
      const r = await runPreflight({
        candidates: SLATE.slice(0, 1), policy: tight, role: '审官',
        breakerDoc: { targets: {} }, audit: () => {}, recordBreaker: () => ({ ok: true }), probe,
      });
      assert.equal(r.stop, false);
      assert.equal(r.chosen, 'gpt-5.6-luna');
      assert.equal(r.probed[0].state, 'timeout');
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('④ 阈值是量出来的：数字被改回去就红', async (t) => {
  const { DISPATCH_POLICY_DEFAULTS, validateDispatchPolicy } = await import(PREFLIGHT);
  const policyDoc = JSON.parse(readFileSync(resolve(REPO, 'docs/dispatch-policy.json'), 'utf8'));

  // 2026-09-05 实测（scripts/lib/provider-probe.mjs 的真实请求路径，在役腿各 8 针）：
  // 整针收口最慢 16.66s（composer-2.5@gw-sub），次慢 15.20s（kimi-k3@gw-sub）。
  // 预算必须盖住实测最坏值并留余量；20000 是「盖不住实测就红」的下界，不是目标值。
  const MEASURED_WORST_SETTLE_MS = 16662;
  const FLOOR_MS = 20000;
  const enough = (ms) => Number.isFinite(ms) && ms >= FLOOR_MS && ms > MEASURED_WORST_SETTLE_MS;

  await t.test('判据本身不是恒真：5000 要被判不够', () => {
    assert.equal(enough(5000), false, '#853 之前的值必须过不了这道闸，否则这条测试是摆设');
    assert.equal(enough(16000), false, '刚好盖不住实测最坏值也不行');
    assert.equal(enough(30000), true);
  });

  await t.test('docs/dispatch-policy.json 的 preflight.timeoutMs 盖得住实测', () => {
    const ms = Number(policyDoc.preflight.timeoutMs);
    assert.ok(enough(ms),
      `timeoutMs=${ms} 盖不住实测最坏 ${MEASURED_WORST_SETTLE_MS}ms（gw-sub 组 kimi-k3/composer-2.5 首字节 10~16.5s）。`
      + '要改这个数先重新量一遍，实测表在 scripts/lib/preflight.mjs 的 DISPATCH_POLICY_DEFAULTS 上方');
  });

  await t.test('代码缺省值与策略文件同值（文件没了也不许悄悄退回旧值）', () => {
    assert.equal(DISPATCH_POLICY_DEFAULTS.timeoutMs, Number(policyDoc.preflight.timeoutMs));
  });

  await t.test('改完仍在 validateDispatchPolicy 的取值范围内（dao-check 不会红）', () => {
    const v = validateDispatchPolicy(policyDoc);
    assert.equal(v.ok, true, JSON.stringify(v.problems));
    assert.equal(v.unscanned, false);
  });

  await t.test('实测依据必须留在代码里：只写数字不写依据，下一个人照样会改回去', () => {
    const src = readFileSync(resolve(REPO, 'scripts/lib/preflight.mjs'), 'utf8');
    const head = src.slice(0, src.indexOf('export const DISPATCH_POLICY_DEFAULTS'));
    assert.match(head, /实测/, '阈值上方要有实测表');
    assert.match(head, /gw-sub/, '要点名是哪一组慢——不然读的人不知道去量谁');
    assert.match(head, /16\.\d+s|16\.5|16662/, '要写清实测最坏值，数字才有出处');
  });
});
