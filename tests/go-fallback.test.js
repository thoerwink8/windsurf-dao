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
const path = require('node:path');

const CORE = path.resolve(__dirname, '..', 'host', 'pi-extensions', 'go-fallback-core.mjs');
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
