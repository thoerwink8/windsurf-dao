// tests/worker-model-host-prefix.test.js —— 起审官同厂闸的工人家族兜底（chain:reviewer-entrance#1）
//
// 实咬 PR #1070：帅位手开的 PR，署名单没有 `model/*`（那个标签的唯一自动写入方
// stampIssueLabels 在**派工成功之后**才调，手开的 PR 走不到那一步），起审官当场拒
// 「扫完没有 model/*」，PR 停在没人审，每 45 分钟重试一次、3 次后永远停住。
//
// 兜底判据是标题的 `[宿主]` 前缀。它定不到型号，但定得到家族，而同厂闸只要家族。
// 下面的边界条例逐条钉住「什么时候不许兜底」——兜底放宽一格就等于同厂闸放行同厂审官。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WD = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'worker-done.mjs').replace(/\\/g, '/'));
const VG = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'reviewer-vendor-gate.mjs').replace(/\\/g, '/'));

describe('宿主前缀 → 供应商家族', () => {
  it('三个单供应商宿主认得出', async () => {
    const { vendorFamilyFromHostPrefix } = await WD;
    assert.equal(vendorFamilyFromHostPrefix('[cc] fix(x): y').family, 'claude');
    assert.equal(vendorFamilyFromHostPrefix('[codex] feat: z').family, 'gpt');
    assert.equal(vendorFamilyFromHostPrefix('[grok] chore: w').family, 'grok');
  });

  // pi 会在上游报错时 1 毫秒内静默切到同 model id 的另一个 provider（memory
  // pi-silent-provider-fallback），家族推不出来。漏登记的代价是「照旧拒绝起审官」，
  // 猜错的代价是「同厂闸放行同厂审官」——两边不对称，所以宁缺勿滥。
  it('多供应商宿主 pi 必须推不出（这条不是遗漏，是判据）', async () => {
    const { vendorFamilyFromHostPrefix, HOST_PREFIX_VENDOR_FAMILY } = await WD;
    assert.equal(HOST_PREFIX_VENDOR_FAMILY.pi, undefined, 'pi 被登记进家族表了——它是多供应商宿主');
    assert.equal(vendorFamilyFromHostPrefix('[pi] feat: y').ok, false);
  });

  it('没有前缀 / 未知宿主 → 推不出，不猜', async () => {
    const { vendorFamilyFromHostPrefix } = await WD;
    assert.equal(vendorFamilyFromHostPrefix('fix: 没有前缀').ok, false);
    assert.equal(vendorFamilyFromHostPrefix('[unknown-host] x').ok, false);
    assert.equal(vendorFamilyFromHostPrefix('').ok, false);
    assert.equal(vendorFamilyFromHostPrefix(null).ok, false);
  });

  // 兜底产出的 modelId 必须能被同厂闸真的解析出家族——这是两个模块之间的契约，
  // 只测「返回了 claude」不够，得测同厂闸拿到它算得出 claude。
  it('兜底产出的 id 能被 vendorFamilyOf 解析（跨模块契约）', async () => {
    const { HOST_PREFIX_VENDOR_FAMILY } = await WD;
    const { vendorFamilyOf } = await VG;
    for (const family of Object.values(HOST_PREFIX_VENDOR_FAMILY)) {
      assert.equal(vendorFamilyOf(family), family, `同厂闸认不出兜底家族 ${family}`);
    }
  });
});

describe('resolveWorkerFromPr 什么时候才许兜底', () => {
  // 假 gh：按 PR 标题与 issue 标签造三种局面，不出网。
  // reviews 一并带上——planWorkerDone 会再调一次 pr view --json reviews，
  // 缺数组会被当成没查成，测不到首审兜底。
  const fakeGh = ({ title, labels, issueOk = true, reviews = [] }) => (args) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      return { ok: true, out: JSON.stringify({ title, body: '署名 issue #999', reviews }) };
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      if (!issueOk) return { ok: false, error: 'gh 挂了' };
      return { ok: true, out: JSON.stringify({ labels: labels.map((name) => ({ name })) }) };
    }
    throw new Error('未预期的 gh 调用：' + args.join(' '));
  };

  it('有 model/* 标签时走标签，不走兜底', async () => {
    const { resolveWorkerFromPr } = await WD;
    const got = resolveWorkerFromPr({ pr: '1', runGh: fakeGh({ title: '[cc] x', labels: ['model/grok-4.6'] }) });
    assert.equal(got.ok, true);
    assert.equal(got.source, 'label');
    assert.equal(got.modelId, 'grok-4.6', '标签在就必须用标签——兜底只补空缺，不许覆盖');
  });

  it('扫完确实没有 model/* → 用宿主前缀兜底', async () => {
    const { resolveWorkerFromPr } = await WD;
    const got = resolveWorkerFromPr({ pr: '1', runGh: fakeGh({ title: '[cc] fix: y', labels: ['type/写码'] }) });
    assert.equal(got.ok, true);
    assert.equal(got.source, 'host-prefix');
    assert.equal(got.modelId, 'claude');
  });

  // 这条是本次改动最危险的边界：把「没查成」兜成「查过了是 claude」，
  // 等于把 fail-closed 改成了猜。
  it('标签没查成（gh 挂了）→ 绝不兜底', async () => {
    const { resolveWorkerFromPr } = await WD;
    const got = resolveWorkerFromPr({ pr: '1', runGh: fakeGh({ title: '[cc] x', labels: [], issueOk: false }) });
    assert.equal(got.ok, false);
    assert.equal(got.unscanned, true);
  });

  it('多个 model/* → 不兜底（那是要人消歧的真歧义）', async () => {
    const { resolveWorkerFromPr } = await WD;
    const got = resolveWorkerFromPr({
      pr: '1', runGh: fakeGh({ title: '[cc] x', labels: ['model/grok-4.6', 'model/kimi-k3'] }),
    });
    assert.equal(got.ok, false);
    assert.notEqual(got.source, 'host-prefix');
  });

  it('没标签又推不出家族（[pi]）→ 照旧拒绝，且理由带上两条', async () => {
    const { resolveWorkerFromPr } = await WD;
    const got = resolveWorkerFromPr({ pr: '1', runGh: fakeGh({ title: '[pi] x', labels: ['type/写码'] }) });
    assert.equal(got.ok, false);
    assert.match(got.error, /扫完没有 model/);
    assert.match(got.error, /宿主前缀也推不出家族/);
  });
});

// 审官红项 1（PR #1079）：首审入口 planWorkerDone 原先直接对 resolved.labels 调
// requireWorkerModel，宿主前缀兜底接在 resolveWorkerFromPr 上根本走不到。
// 复现就是这条——无 model/*、标题 [cc]、已有 reviewer/* 的手开 PR。
describe('planWorkerDone 首审也走宿主前缀兜底', () => {
  const fakeGh = ({ title, labels, issueOk = true, reviews = [] }) => (args) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      return { ok: true, out: JSON.stringify({ title, body: '署名 issue #999', reviews }) };
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      if (!issueOk) return { ok: false, error: 'gh 挂了' };
      return { ok: true, out: JSON.stringify({ labels: labels.map((name) => ({ name })) }) };
    }
    throw new Error('未预期的 gh 调用：' + args.join(' '));
  };

  it('无 model/* 的 [cc] 手开 PR → 首审产出家族模型，不拒', async () => {
    const { planWorkerDone } = await WD;
    const got = planWorkerDone({
      pr: '1079',
      runGh: fakeGh({
        title: '[cc] manual PR',
        labels: ['reviewer/gpt-5.6-sol', 'type/写码'],
        reviews: [],
      }),
    });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.round, 'first');
    assert.equal(got.shouldCreate, true);
    assert.equal(got.workerModel, 'claude');
    assert.equal(got.workerSource, 'host-prefix');
    assert.equal(got.reviewer, 'gpt-5.6-sol');
  });

  it('多个 model/* → 首审仍拒（fail-closed，不拿前缀消歧）', async () => {
    const { planWorkerDone } = await WD;
    const got = planWorkerDone({
      pr: '1079',
      runGh: fakeGh({
        title: '[cc] x',
        labels: ['model/grok-4.6', 'model/kimi-k3', 'reviewer/gpt-5.6-sol'],
        reviews: [],
      }),
    });
    assert.equal(got.ok, false);
    assert.equal(got.state, 'many');
  });

  it('标签没查成 → 首审仍拒（fail-closed，不许兜成 claude）', async () => {
    const { planWorkerDone } = await WD;
    const got = planWorkerDone({
      pr: '1079',
      runGh: fakeGh({ title: '[cc] x', labels: [], issueOk: false, reviews: [] }),
    });
    assert.equal(got.ok, false);
    assert.equal(got.unscanned, true);
  });

  // 机制闸：宿主前缀兜底只许接在 resolveWorkerFromPr 这一处。生产代码再直接调
  // requireWorkerModel，等于又开一条「扫完没有 model/* 就拒、到不了兜底」的入口——
  // 正是本单首审漏接的形状。tests/ 可以调（钉三态），scripts/ 不行。
  it('生产代码里 requireWorkerModel 只许 resolveWorkerFromPr 调', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'worker-done.mjs'), 'utf8');
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const def = stripped.match(/export function requireWorkerModel\s*\(/g) || [];
    const calls = stripped.match(/requireWorkerModel\s*\(/g) || [];
    assert.equal(def.length, 1, 'requireWorkerModel 定义应恰好一处');
    assert.equal(calls.length, 2, `生产调用应只有定义 + resolveWorkerFromPr 内部一处，实际 ${calls.length}`);
    assert.match(stripped, /export function resolveWorkerFromPr[\s\S]*requireWorkerModel\s*\(/,
      '剩下那一处调用必须在 resolveWorkerFromPr 里');
    assert.doesNotMatch(stripped, /export function planWorkerDone[\s\S]*requireWorkerModel\s*\(/,
      'planWorkerDone 不得再直接调 requireWorkerModel');
  });
});
