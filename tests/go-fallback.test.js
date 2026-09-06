// go-fallback restoreDefaults 恢复决策回归（审查修复：恢复逻辑写错）
//
// 验的层：planRestore 纯决策（host/pi-extensions/go-fallback-core.mjs，node 22 只
// import .mjs，不 import .ts——CI 是 node 22，见 .github/workflows/check.yml）。
//
// 旧逻辑两处错，各有一条判别性断言盯着：
//   1. 「当前值 == 原值」被当成「已恢复过」清掉 pending——但 setModel 的 settings 写队列
//      是异步落盘，恢复刀跑在落盘前读到的就是原值；pending 误清后降级值落盘，
//      补刀变 no-op，settings.json 永远停在降级通道。修复后此情形必须 wait（留 pending）。
//   2. 「当前值既非原值也非降级值」（用户降级后手动改了默认）旧逻辑无条件写回原值，
//      覆盖用户修改。修复后必须 respect-user（尊重用户、不再补刀）。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.resolve(__dirname, '..', 'host', 'pi-extensions', 'go-fallback-core.mjs');
const TS = path.resolve(__dirname, '..', 'host', 'pi-extensions', 'go-fallback.ts');
const CORE_LOAD = import('file://' + CORE.replace(/\\/g, '/'));

// 降级现场：原默认 opencode-go/deepseek-v4-flash，setModel 试图写 deepseek/deepseek-v4-flash
const PENDING = {
  path: 'settings.json',
  provider: 'opencode-go',
  model: 'deepseek-v4-flash',
  fallbackProvider: 'deepseek',
  fallbackModel: 'deepseek-v4-flash',
};

describe('go-fallback-core planRestore', () => {
  it('① 无 pending → noop（没降级过不动作）', async () => {
    const C = await CORE_LOAD;
    assert.strictEqual(C.planRestore({ pending: null, current: { provider: 'x', model: 'y' } }).action, 'noop');
  });

  it('② 当前值 == 降级值 → restore（降级写已落盘，必须写回原值）', async () => {
    const C = await CORE_LOAD;
    const r = C.planRestore({ pending: PENDING, current: { provider: 'deepseek', model: 'deepseek-v4-flash' } });
    assert.strictEqual(r.action, 'restore', '看到降级值必须恢复——否则后续按默认启动的 worker 静默变直连');
    assert.deepStrictEqual(r.from, { provider: 'deepseek', model: 'deepseek-v4-flash' }, '日志要带上被还原的降级值');
  });

  it('③ 当前值 == 原值 → wait（核心修复：不许清 pending 放弃补刀）', async () => {
    const C = await CORE_LOAD;
    const r = C.planRestore({ pending: PENDING, current: { provider: 'opencode-go', model: 'deepseek-v4-flash' } });
    assert.strictEqual(r.action, 'wait',
      '当前是原值时分不清「已恢复」与「降级写还没落盘」——必须留 pending 等补刀；' +
      '旧逻辑在此清 pending，降级值落盘后补刀变 no-op，settings.json 永远停在降级通道');
  });

  it('④ 当前值是用户手动改的其它值 → respect-user（不覆盖用户修改）', async () => {
    const C = await CORE_LOAD;
    const r = C.planRestore({ pending: PENDING, current: { provider: 'anthropic', model: 'claude-x' } });
    assert.strictEqual(r.action, 'respect-user', '用户降级后手动改了默认，必须尊重、不再补刀');
    assert.deepStrictEqual(r.from, { provider: 'anthropic', model: 'claude-x' }, '日志要带上用户值');
  });

  it('⑤ 边界：原值本来就是直连（original == fallback）→ restore 幂等无害', async () => {
    const C = await CORE_LOAD;
    const pending = { ...PENDING, provider: 'deepseek' }; // 原默认就是 deepseek 直连
    const r = C.planRestore({ pending, current: { provider: 'deepseek', model: 'deepseek-v4-flash' } });
    assert.strictEqual(r.action, 'restore', '写回原值==写入现值，幂等');
  });

  it('⑥ 判别力：wait 分支放宽成 restore 会误写（原值场景多写一次文件），' +
     'respect-user 放宽成 restore 会覆盖用户修改——两条分支必须分得开', async () => {
    const C = await CORE_LOAD;
    const cases = [
      [{ provider: 'opencode-go', model: 'deepseek-v4-flash' }, 'wait'],
      [{ provider: 'deepseek', model: 'deepseek-v4-flash' }, 'restore'],
      [{ provider: 'opencode-go', model: 'other-model' }, 'respect-user'], // provider 同、model 不同也是用户改
      [{ provider: 'other', model: 'deepseek-v4-flash' }, 'respect-user'],
    ];
    for (const [current, want] of cases) {
      assert.strictEqual(C.planRestore({ pending: PENDING, current }).action, want,
        `current=${JSON.stringify(current)} 应为 ${want}`);
    }
  });
});

describe('go-fallback-core classifyFallbackError', () => {
  it('识别 GLM 网关过载、Grok 超时/连接中断为 transient', async () => {
    const C = await CORE_LOAD;
    for (const text of [
      '503 new_api_error: system cpu overloaded',
      'Request timed out.',
      'Connection error.',
      'This operation was aborted',
      'fetch failed: ECONNRESET',
    ]) assert.strictEqual(C.classifyFallbackError(text), 'transient', text);
  });

  it('识别余额/5 小时额度耗尽为 hard', async () => {
    const C = await CORE_LOAD;
    assert.strictEqual(C.classifyFallbackError('402: Insufficient Balance'), 'hard');
    assert.strictEqual(C.classifyFallbackError("You've reached your 5-hour usage limit"), 'hard');
  });

  it('未知错误不触发回退', async () => {
    const C = await CORE_LOAD;
    assert.strictEqual(C.classifyFallbackError('Invalid message role'), null);
  });
});

describe('go-fallback-core #841 网关不归扩展管', () => {
  it('默认 PRIMARIES 不含 gw/grok/xai，只留 opencode-go 与 mirasim', async () => {
    const C = await CORE_LOAD;
    const lists = C.resolveProviderLists({});
    assert.deepStrictEqual(lists.primaries, ['opencode-go', 'mirasim']);
    assert.equal(lists.primaries.includes('gw'), false);
    assert.equal(lists.primaries.includes('grok'), false);
    assert.equal(lists.primaries.includes('xai'), false);
    assert.deepStrictEqual(lists.fallbacks, ['deepseek']);
    // 接线层不许再写回旧默认——#794 就是这么把 gw 塞进 PRIMARIES 的。
    const ts = fs.readFileSync(TS, 'utf8');
    assert.equal(/opencode-go,mirasim,gw,grok,xai/.test(ts), false);
    assert.match(ts, /resolveProviderLists\(process\.env\)/);
  });

  it('测试覆盖仍认 PI_GO_FALLBACK_PRIMARY（e2e 的 fake-go 靠这条）', async () => {
    const C = await CORE_LOAD;
    const lists = C.resolveProviderLists({
      PI_GO_FALLBACK_PRIMARY: 'fake-go',
      PI_GO_FALLBACK_PROVIDER: 'fake-ds',
    });
    assert.deepStrictEqual(lists.primaries, ['fake-go']);
    assert.deepStrictEqual(lists.fallbacks, ['fake-ds']);
  });

  it('空环境变量不算覆盖，仍走默认（垫片删掉后不能 silently 变回含 gw）', async () => {
    const C = await CORE_LOAD;
    const lists = C.resolveProviderLists({
      PI_GO_FALLBACK_PRIMARIES: '',
      PI_GO_FALLBACK_PRIMARY: '   ',
    });
    assert.deepStrictEqual(lists.primaries, ['opencode-go', 'mirasim']);
  });

  it('判别性：gw 主通道连续 403×3 → ignore（改前 PRIMARIES 含 gw 会 switch）', async () => {
    const C = await CORE_LOAD;
    const kind = C.classifyFallbackError('403: Internal error during token generation');
    assert.equal(kind, 'transient');
    const old = C.planSwitch({
      provider: 'gw',
      primaries: ['opencode-go', 'mirasim', 'gw', 'grok', 'xai'],
      kind,
      consecutive: 3,
      transientAfter: 2,
    });
    assert.equal(old.action, 'switch', '改前：gw 在 PRIMARIES 里，连撞会切直连——2026-09-03 实咬');
    const now = C.planSwitch({
      provider: 'gw',
      primaries: C.resolveProviderLists({}).primaries,
      kind,
      consecutive: 3,
      transientAfter: 2,
    });
    assert.equal(now.action, 'ignore');
    assert.equal(now.reason, 'not-primary');
  });

  it('opencode-go 返回 GoUsageLimitError → 仍切（不许把原功能弄坏）', async () => {
    const C = await CORE_LOAD;
    const kind = C.classifyFallbackError('GoUsageLimitError: Monthly usage limit reached');
    assert.equal(kind, 'hard');
    const r = C.planSwitch({
      provider: 'opencode-go',
      primaries: C.resolveProviderLists({}).primaries,
      kind,
      consecutive: 1,
      transientAfter: 2,
    });
    assert.equal(r.action, 'switch');
  });

  it('opencode-go 瞬时错误第 1 次 wait、第 2 次才 switch', async () => {
    const C = await CORE_LOAD;
    const kind = C.classifyFallbackError('429 rate_limit_error');
    assert.equal(kind, 'transient');
    const first = C.planSwitch({
      provider: 'opencode-go',
      primaries: C.resolveProviderLists({}).primaries,
      kind,
      consecutive: 1,
      transientAfter: 2,
    });
    assert.equal(first.action, 'wait');
    const second = C.planSwitch({
      provider: 'opencode-go',
      primaries: C.resolveProviderLists({}).primaries,
      kind,
      consecutive: 2,
      transientAfter: 2,
    });
    assert.equal(second.action, 'switch');
  });
});

describe('go-fallback-core 直连余额探针', () => {
  it('只有 deepseek 要探；测试用 fake-ds 不探', async () => {
    const C = await CORE_LOAD;
    assert.equal(C.needsBalanceProbe('deepseek'), true);
    assert.equal(C.needsBalanceProbe('fake-ds'), false);
    assert.equal(C.needsBalanceProbe('opencode-go'), false);
  });

  it('没探过的 deepseek → skip（切到 402 账号不算降级）', async () => {
    const C = await CORE_LOAD;
    const r = C.planFallbackTarget({ provider: 'deepseek', currentProvider: 'opencode-go' });
    assert.equal(r.action, 'skip');
    assert.equal(r.reason, 'unprobed');
  });

  it('HTTP 402 / Insufficient Balance / 余额 0 → 都 skip', async () => {
    const C = await CORE_LOAD;
    assert.equal(C.interpretBalanceProbe({ status: 402, body: '{}' }).ok, false);
    assert.equal(C.interpretBalanceProbe({ status: 402, body: '{}' }).reason, 'insufficient-balance');
    assert.equal(C.interpretBalanceProbe({
      status: 200,
      body: { message: 'Insufficient Balance' },
    }).reason, 'insufficient-balance');
    assert.equal(C.interpretBalanceProbe({
      status: 200,
      body: { is_available: true, balance_infos: [{ total_balance: '0' }] },
    }).reason, 'zero-balance');
    assert.equal(C.interpretBalanceProbe({ status: 200, body: { is_available: true } }).reason, 'no-balance-info');
  });

  it('有余额才 use；探失败 fail-closed', async () => {
    const C = await CORE_LOAD;
    const ok = C.interpretBalanceProbe({
      status: 200,
      body: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.5' }] },
    });
    assert.equal(ok.ok, true);
    assert.equal(C.planFallbackTarget({
      provider: 'deepseek', currentProvider: 'opencode-go', probe: ok,
    }).action, 'use');
    assert.equal(C.planFallbackTarget({
      provider: 'deepseek', currentProvider: 'opencode-go',
      probe: { ok: false, reason: 'insufficient-balance' },
    }).action, 'skip');
    assert.equal(C.planFallbackTarget({
      provider: 'fake-ds', currentProvider: 'fake-go',
    }).action, 'use');
  });

  it('probeDeepseekBalance 把 402 正文交给 interpret，不抛', async () => {
    const C = await CORE_LOAD;
    const r = await C.probeDeepseekBalance({
      apiKey: 'k',
      fetchFn: async () => ({ status: 402, text: async () => '{"message":"Insufficient Balance"}' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'insufficient-balance');
  });
});
