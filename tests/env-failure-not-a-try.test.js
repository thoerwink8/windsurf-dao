// #1331 控制面抖一下不该烧光这张 PR 的重审预算。
//
// 病（2026-09-17 实咬，一天三次现场）：回环 ws 断连让「起审官会话」当场失败。按老账，
// 这算**这个 PR 试过了一次**——3 次断连（每次不到 1 秒、彼此隔几分钟）就把它判
// 「卡死/自动化认输」，判词写成「叫了 3 次审官，判定仍是 0」。可那三次里**一个审官都没起过**：
// 记的是环境抖动，说的是这张 PR 叫不动人。环境恢复后没有解冻口，PR 永久停在盘面上。
//
// 判据必须是**结构化字段**（MirasimUnavailableError 的 code='unavailable'），不是错误文本词表：
// 词表只找得到见过的失败（memory `whitelist-fingerprints-cannot-find-unseen-failures`），
// 而这里要分的两类恰好**错误文本很像、后果完全相反**：
//   · 执行体自己够不着（ws 断、令牌读不到、租约没查成）→ 不是这个 PR 的事，不记 tries
//   · 服务端明确拒了 / 顺位表里没有这个模型 → 就是这个 PR 的事，必须记，否则永远不交人
//
// 纯函数夹具：不碰 mirasim、不碰 GitHub、不碰文件系统、不出网。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const RP = import('file://' + path.join(REPO, 'scripts', 'lib', 'dispatch', 'review-pending.mjs').replace(/\\/g, '/'));

/** drain 整队回执的形状（dao.mjs 的 fail(drained.error, drained) 摊出来的那份）。 */
const drainFailure = (attached) => ({
  ok: false,
  scanned: 1,
  drained: 0,
  failed: 1,
  held: 0,
  error: `reviewer-attach 失败：${attached.error}`,
  results: [{ ok: false, pr: '1273', error: `reviewer-attach 失败：${attached.error}`, attached }],
});

/** 只摘本单这一条闸，另两条照旧开着——判别力要指向 env-not-try，不是整片闸。 */
const GATE_OFF = { 'held-not-try': true, 'unscanned-not-try': true, 'env-not-try': false };

const WS_DOWN = { ok: false, error: '起审官会话没查成：连不上回环 ws', code: 'unavailable', stage: 'start' };
const REFUSED = { ok: false, error: '审官位只许同厂换顺位（当前 gpt-5.6-luna／gpt），不许换厂到 grok-4.6／grok', code: 'rejected', stage: 'start' };

describe('#1331 judgeEnvFailure：执行体够不着 ≠ 这张 PR 叫不动审官', () => {
  it('code=unavailable → 判环境，带上阶段', async () => {
    const { judgeEnvFailure } = await RP;
    const r = judgeEnvFailure(drainFailure(WS_DOWN));
    assert.equal(r.env, true);
    assert.equal(r.code, 'unavailable');
    assert.equal(r.stage, 'start');
  });

  it('code=rejected（服务端明确拒）→ 不是环境，照旧记账', async () => {
    const { judgeEnvFailure } = await RP;
    const r = judgeEnvFailure(drainFailure(REFUSED));
    assert.equal(r.env, false, '确定性拒绝必须记 tries，否则每 20 分钟白试一次、永远不交人（#1237）');
    assert.equal(r.code, 'rejected');
  });

  it('单票回执与整队回执都收', async () => {
    const { judgeEnvFailure } = await RP;
    assert.equal(judgeEnvFailure({ attached: WS_DOWN }).env, true, '单票（consumeReviewPending 的返回）');
    assert.equal(judgeEnvFailure(drainFailure(WS_DOWN)).env, true, '整队（drainReviewPending 的返回）');
  });

  it('没有证据一律判「不是环境」——宁可多烧一次，也不把真失败变成无限重试', async () => {
    const { judgeEnvFailure } = await RP;
    for (const sample of [null, undefined, 'a string', 42, {}, { results: [] }, { attached: null },
      { attached: { ok: false, error: '没带 code 的老回执' } }]) {
      assert.equal(judgeEnvFailure(sample).env, false, `样本 ${JSON.stringify(sample)} 不该判成环境`);
    }
  });
});

describe('#1331 classifyDrainAttempt：环境类失败不算这张 PR 试过', () => {
  it('ws 断连 → 不记 tries', async () => {
    const { classifyDrainAttempt } = await RP;
    const r = classifyDrainAttempt(drainFailure(WS_DOWN));
    assert.equal(r.countTry, false);
    assert.equal(r.reason, 'env-unreachable');
  });

  it('服务端明确拒 → 照旧记 tries', async () => {
    const { classifyDrainAttempt } = await RP;
    const r = classifyDrainAttempt(drainFailure(REFUSED));
    assert.equal(r.countTry, true);
    assert.equal(r.reason, 'failed');
  });

  it('摘掉 env-not-try → ws 断连又被记成试过（证明「不记」是这条闸撑着的）', async () => {
    const { classifyDrainAttempt, DRAIN_ATTEMPT_CHECKS } = await RP;
    const payload = drainFailure(WS_DOWN);
    assert.equal(DRAIN_ATTEMPT_CHECKS['env-not-try'], true, '生产路径上必须开着');
    assert.equal(classifyDrainAttempt(payload).countTry, false, '闸开着必须不记');
    const off = classifyDrainAttempt(payload, { _checks: GATE_OFF });
    assert.equal(off.countTry, true, '闸摘掉必须回到老行为——否则这条闸没有判别力');
    assert.equal(off.reason, 'env-but-gate-off');
  });

  it('原有三态不受影响：背压 / 没查成 / 空转 / 真拉走', async () => {
    const { classifyDrainAttempt } = await RP;
    assert.equal(classifyDrainAttempt({ ok: true, drained: 0, failed: 0, held: 2 }).reason, 'held');
    assert.equal(classifyDrainAttempt({ ok: true, drained: 0, held: 2, unscanned: true }).reason, 'unscanned');
    assert.equal(classifyDrainAttempt({ ok: true, drained: 0, failed: 0, held: 0 }).reason, 'empty');
    assert.equal(classifyDrainAttempt({ ok: true, drained: 1, failed: 0, held: 0 }).reason, 'pulled');
  });
});

describe('#1331 attachReceiptFromSpawn：结构化字段要提到顶层', () => {
  const spawned = (json, extra = {}) => ({
    status: 1, stdout: JSON.stringify(json), stderr: '', ...extra,
  });

  it('code / stage 与 error 同层，判据不必下钻 json', async () => {
    const { attachReceiptFromSpawn } = await RP;
    const r = attachReceiptFromSpawn(spawned({
      ok: false, error: '起审官会话没查成：连不上回环 ws', code: 'unavailable', stage: 'start',
    }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unavailable');
    assert.equal(r.stage, 'start');
    assert.equal(r.error, '起审官会话没查成：连不上回环 ws');
  });

  it('非 JSON / 超时 / 被信号杀：没有 code，判据落回「不是环境」', async () => {
    const { attachReceiptFromSpawn, judgeEnvFailure } = await RP;
    const noJson = attachReceiptFromSpawn({ status: 1, stdout: 'not-json', stderr: 'boom' });
    assert.equal(noJson.code, undefined, 'json 是 null 时不许编一个 code 出来');
    assert.equal(judgeEnvFailure({ attached: noJson }).env, false);

    const killed = attachReceiptFromSpawn({ status: null, signal: 'SIGTERM', stdout: '', stderr: 'timeout' });
    assert.equal(killed.ok, false);
    assert.equal(killed.code, undefined);
  });

  it('成功回执不带这两个字段（只在失败支提）', async () => {
    const { attachReceiptFromSpawn } = await RP;
    const r = attachReceiptFromSpawn({ status: 0, stdout: JSON.stringify({ ok: true, sessionKey: 'codex:abc' }) });
    assert.equal(r.ok, true);
    assert.equal(r.code, undefined);
  });
});

describe('#1331 返工 / 收口泵那条路：同一个判据，回执形状不同', () => {
  // 返工派的是 `dao.mjs start`，回执是 runCmd 的形状（out 里一行 JSON），
  // 与复审那条路（reviewer-attach 的结构化回执）不是同一个形状，但判据必须是同一个。
  const startFailure = (json) => ({
    ok: false, status: 1, out: JSON.stringify(json), stderr: '',
    error: String(json.error || '').slice(0, 300),
  });

  it('start 的 ws 断连回执 → 判环境（这就是 #885 / #1284 被烧掉预算的那一条）', async () => {
    const { judgeEnvFailure } = await RP;
    const { drainPayloadOf } = await import(
      'file://' + path.join(REPO, 'scripts', 'commander.mjs').replace(/\\/g, '/'));
    const receipt = startFailure({
      ok: false, error: 'mirasim 起会话失败: 连不上回环 ws',
      executor: 'mirasim', code: 'unavailable', agent: 'grok',
    });
    assert.equal(judgeEnvFailure({ attached: drainPayloadOf(receipt) }).env, true);
  });

  it('start 的确定性失败（无 code）→ 不是环境，照旧记账', async () => {
    const { judgeEnvFailure } = await RP;
    const { drainPayloadOf } = await import(
      'file://' + path.join(REPO, 'scripts', 'commander.mjs').replace(/\\/g, '/'));
    const receipt = startFailure({ ok: false, error: 'mirasim 建树失败: 分支不存在', executor: 'mirasim' });
    assert.equal(judgeEnvFailure({ attached: drainPayloadOf(receipt) }).env, false);
  });

  it('非 dao 回执（自动合并成功 / 找不到树）→ 不是环境', async () => {
    const { judgeEnvFailure } = await RP;
    const { drainPayloadOf } = await import(
      'file://' + path.join(REPO, 'scripts', 'commander.mjs').replace(/\\/g, '/'));
    for (const v of [{ ok: true, integrated: true },
      { ok: false, unscanned: true, error: '找不到工人树 dao-1284，不新派工' }]) {
      assert.equal(judgeEnvFailure({ attached: drainPayloadOf(v) }).env, false,
        `${JSON.stringify(v)} 不该判成环境`);
    }
  });
});

describe('#1331 判别性实验：三次 ws 断连，老判据认输、新判据一次没烧', () => {
  it('同一张 PR 连撞三次断连后仍有满额重试预算', async () => {
    const { classifyDrainAttempt } = await RP;
    const MAX = 3;                       // MAX_REREVIEW_TRIES / MAX_DRAIN_TRIES 都是 3
    const rounds = [WS_DOWN, WS_DOWN, WS_DOWN].map(drainFailure);

    const before = rounds.filter((p) => classifyDrainAttempt(p, { _checks: GATE_OFF }).countTry).length;
    const after = rounds.filter((p) => classifyDrainAttempt(p).countTry).length;

    assert.equal(before, MAX, '老判据：三次断连烧满预算 → 打「卡死/自动化认输」，这就是 2026-09-17 现场');
    assert.equal(after, 0, '新判据：一次都不烧——那三次里一个审官都没起过');
  });

  it('断连之后来一次真拒绝，预算照样开始走——不是把闸焊死', async () => {
    const { classifyDrainAttempt } = await RP;
    const seq = [WS_DOWN, WS_DOWN, REFUSED, REFUSED, REFUSED].map(drainFailure);
    const counted = seq.filter((p) => classifyDrainAttempt(p).countTry).length;
    assert.equal(counted, 3, '两次环境不计、三次真拒绝全计——试满仍会交人');
  });
});
