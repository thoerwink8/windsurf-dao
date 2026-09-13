// tests/worker-model-host-prefix.test.js —— #1116：选型只读 PR label，不猜家族
//
// 原文件钉的是「宿主前缀兜底」（chain:reviewer-entrance#1，为帅位手开 PR 加的第 1 层补丁）。
// 用户 2026-09-07 拍板删掉反推层：没标就拒、话面「需人工打标」，不读 issue、不猜家族。
// 本文件改钉新契约，旧函数名必须零残留。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WD = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'worker-done.mjs').replace(/\\/g, '/'));

function fakeGh({ title, labels, reviews = [], headRefName = 'dao-1', body = '署名 issue #999' } = {}) {
  return (args) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      const want = String(args[args.indexOf('--json') + 1] || '');
      if (want === 'reviews') return { ok: true, out: JSON.stringify({ reviews }) };
      return {
        ok: true,
        out: JSON.stringify({
          title,
          body,
          labels: (labels || []).map((name) => ({ name })),
          headRefName,
          reviews,
        }),
      };
    }
    throw new Error('未预期的 gh 调用：' + args.join(' '));
  };
}

describe('#1116 反推层已删', () => {
  it('生产代码零残留：collectIssueLabelsFromPr / vendorFamilyFromHostPrefix / uniqueNames / HOST_PREFIX', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'worker-done.mjs'), 'utf8');
    assert.doesNotMatch(src, /collectIssueLabelsFromPr/);
    assert.doesNotMatch(src, /vendorFamilyFromHostPrefix/);
    assert.doesNotMatch(src, /HOST_PREFIX_VENDOR_FAMILY/);
    assert.doesNotMatch(src, /uniqueNames/);
    assert.doesNotMatch(src, /function uniqueNames/);
  });

  it('scripts/ 选型路径不再 issue view --json labels', () => {
    const root = path.join(__dirname, '..', 'scripts');
    const hits = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p);
        else if (name.endsWith('.mjs')) {
          const text = fs.readFileSync(p, 'utf8');
          if (/issue',\s*'view'[\s\S]{0,80}labels/.test(text) || /issue view.*--json['"] labels/.test(text)) {
            hits.push(p);
          }
        }
      }
    };
    walk(root);
    // 消歧门 / stampIssueLabels 仍读 issue labels（那是派工治理，不是选型反推）。
    // 选型入口（worker-done / reviewer-create）不许再走。
    const wd = fs.readFileSync(path.join(root, 'lib', 'dispatch', 'worker-done.mjs'), 'utf8');
    assert.doesNotMatch(wd, /\['issue',\s*'view'/);
    assert.doesNotMatch(wd, /issue view/);
  });
});

describe('resolveWorkerFromPr 只读 PR label', () => {
  it('有 model/* 走标签', async () => {
    const { resolveWorkerFromPr } = await WD;
    const got = resolveWorkerFromPr({
      pr: '1',
      runGh: fakeGh({ title: '[cc] x', labels: ['model/grok-4.6'] }),
    });
    assert.equal(got.ok, true);
    assert.equal(got.source, 'label');
    assert.equal(got.modelId, 'grok-4.6');
  });

  it('扫完没有 model/* → 拒，话面需人工打标，不猜家族', async () => {
    const { resolveWorkerFromPr } = await WD;
    const got = resolveWorkerFromPr({
      pr: '1',
      runGh: fakeGh({ title: '[cc] fix: y', labels: ['type/写码'] }),
    });
    assert.equal(got.ok, false);
    assert.equal(got.state, 'none');
    assert.match(got.error, /需人工打标/);
    assert.match(got.error, /不读 issue、不猜家族/);
    assert.notEqual(got.source, 'host-prefix');
  });

  it('PR labels 缺数组 → unscanned，不猜', async () => {
    const { resolveWorkerFromPr, collectPrLabels, planWorkerDone } = await WD;
    const malformed = (out) => (args) => {
      if (args[0] === 'pr' && args[1] === 'view') return { ok: true, out };
      throw new Error('未预期 ' + args.join(' '));
    };
    for (const [name, out] of [
      ['缺字段 {}', '{}'],
      ['labels:null', JSON.stringify({ labels: null })],
      ['labels 非数组', JSON.stringify({ labels: 'model/claude' })],
    ]) {
      const collected = collectPrLabels({ pr: '1', runGh: malformed(out) });
      assert.equal(collected.ok, false, `${name} collect 应拒`);
      assert.equal(collected.unscanned, true, `${name} 应 unscanned`);
      const resolved = resolveWorkerFromPr({ pr: '1', runGh: malformed(out) });
      assert.equal(resolved.ok, false, `${name} resolve 应拒`);
      assert.equal(resolved.unscanned, true);
      const planned = planWorkerDone({ pr: '1079', runGh: malformed(out) });
      assert.equal(planned.ok, false, `${name} 首审应拒`);
    }
  });

  it('多个 model/* → many，不许猜', async () => {
    const { resolveWorkerFromPr } = await WD;
    const got = resolveWorkerFromPr({
      pr: '1',
      runGh: fakeGh({ title: '[cc] x', labels: ['model/grok-4.6', 'model/kimi-k3'] }),
    });
    assert.equal(got.ok, false);
    assert.equal(got.state, 'many');
  });

  it('gh 调用序列没有 issue view', async () => {
    const { resolveWorkerFromPr, resolveReviewerFromPr } = await WD;
    const calls = [];
    const runGh = (args) => {
      calls.push(args.slice());
      return {
        ok: true,
        out: JSON.stringify({
          title: 'x',
          body: '署名 issue #999',
          labels: [{ name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-luna' }],
          headRefName: 'dao-1',
          reviews: [],
        }),
      };
    };
    const w = resolveWorkerFromPr({ pr: '1', runGh });
    const r = resolveReviewerFromPr({ pr: '1', runGh });
    assert.equal(w.ok, true);
    assert.equal(r.ok, true);
    assert.equal(calls.some((a) => a[0] === 'issue'), false, JSON.stringify(calls));
  });

  // #1104 在反推层上：署两张单会把同一份 model/* 收集两遍，去重才能放行。
  // #1116 真相源是 PR 自己的一组标签，不读两张 issue——署两张单不再进选型路径。
  it('#1104 形状：PR 上只有一组 model/* → 放行，不读署名单', async () => {
    const { resolveWorkerFromPr } = await WD;
    const got = resolveWorkerFromPr({
      pr: '1104',
      runGh: fakeGh({
        title: '[grok] fix',
        body: '署名 issue #1065、署名 issue #1097',
        labels: ['model/grok-4.6', 'type/写码'],
      }),
    });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.modelId, 'grok-4.6');
    assert.deepEqual(got.refs, [1065, 1097]);
  });
});

describe('planWorkerDone 手开 PR 没标就拒', () => {
  it('无 model/* 的 [cc] 手开 PR → 首审拒，需人工打标', async () => {
    const { planWorkerDone } = await WD;
    const got = planWorkerDone({
      pr: '1079',
      runGh: fakeGh({
        title: '[cc] manual PR',
        labels: ['reviewer/gpt-5.6-sol', 'type/写码'],
        reviews: [],
      }),
    });
    assert.equal(got.ok, false, JSON.stringify(got));
    assert.match(got.error, /需人工打标/);
  });

  it('PR 上有 model/* + reviewer/* → 首审过', async () => {
    const { planWorkerDone } = await WD;
    const got = planWorkerDone({
      pr: '1079',
      runGh: fakeGh({
        title: '[cc] manual PR',
        labels: ['model/grok-4.6', 'reviewer/gpt-5.6-sol', 'type/写码'],
        reviews: [],
      }),
    });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.workerModel, 'grok-4.6');
    assert.equal(got.reviewer, 'gpt-5.6-sol');
    assert.equal(got.workerSource, 'label');
  });
});
