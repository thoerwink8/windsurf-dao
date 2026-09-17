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

  it('快路无署名单号：仍交卷，issue 为空（完工 comment 只发 PR）', async () => {
    const { planWorkerDone } = await WD;
    const got = planWorkerDone({
      pr: '1282',
      body: '返工完成：PR #1282',
      runGh: fakeGh({
        title: '[grok] fix(审官): 快路',
        body: '无署名 issue',
        labels: ['model/grok-4.6', 'reviewer/gpt-5.6-luna', 'type/写码'],
        reviews: [{ id: 1 }],
      }),
    });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.issue, null, JSON.stringify(got));
    assert.equal(got.round, 'rework');
  });

  it('快路 PR 无署名单号：不拒，issue 为空，完工只发 PR comment', async () => {
    const { planWorkerDone } = await WD;
    const got = planWorkerDone({
      pr: '1288',
      body: '返工完成：同步阻塞',
      runGh: fakeGh({
        title: '[cc] fix(dao-check): 测试孤儿',
        body: '快路无署名',
        labels: ['model/claude-opus-5', 'reviewer/gpt-5.6-luna', 'type/写码'],
        reviews: [{ id: 1, body: '判定：红 1 项' }],
      }),
    });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.issue, null);
    assert.equal(got.round, 'rework');
    assert.equal(got.shouldCreate, false);
  });

  it('快路无署名单号：有 model/* + reviewer/* 仍可交卷，comment 只发 PR', async () => {
    const { planWorkerDone } = await WD;
    const first = planWorkerDone({
      pr: '1274',
      body: '完工：快路',
      runGh: fakeGh({
        title: '[cc] fix',
        labels: ['model/grok-4.6', 'reviewer/gpt-5.6-luna', 'type/写码'],
        reviews: [],
        body: '快路，没有署名单号',
      }),
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.issue, null);
    assert.equal(first.round, 'first');
    const rework = planWorkerDone({
      pr: '1274',
      body: '返工完成：快路',
      runGh: fakeGh({
        title: '[cc] fix',
        labels: ['model/grok-4.6', 'reviewer/gpt-5.6-luna', 'type/写码'],
        reviews: [{ state: 'CHANGES_REQUESTED' }],
        body: '快路，没有署名单号',
      }),
    });
    assert.equal(rework.ok, true, JSON.stringify(rework));
    assert.equal(rework.issue, null);
    assert.equal(rework.round, 'rework');
    assert.match(rework.comment, /^返工完成/);
  });

  it('快路无署名单但标齐 → 放行，issue 为 null（完工评论发 PR）', async () => {
    const { planWorkerDone } = await WD;
    const got = planWorkerDone({
      pr: '1286',
      body: '返工完成：PR #1286',
      runGh: fakeGh({
        title: '[cc] fix(心跳): x',
        body: '快路，正文里没有署名单这一行',
        labels: ['model/claude-opus-5', 'reviewer/gpt-5.6-luna', 'type/写码'],
        reviews: [{ id: 1, body: '判定：红 2 项' }],
      }),
    });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.issue, null);
    assert.equal(got.round, 'rework');
    assert.match(got.comment, /^返工完成/);
  });

  it('无署名快路 PR + 已有 review → 返工过，issue 为空，完工发在 PR 上', async () => {
    const { planWorkerDone } = await WD;
    const got = planWorkerDone({
      pr: '1271',
      body: '返工完成：PR #1271 红项已改',
      runGh: fakeGh({
        title: '[cc] fix(返工): 解冻',
        body: '快路，无署名 issue',
        labels: ['model/grok-4.6', 'reviewer/gpt-5.6-sol', 'type/写码'],
        reviews: [{ state: 'CHANGES_REQUESTED', body: '修红项' }],
        headRefName: 'dao-queue-selfheal',
      }),
    });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.round, 'rework');
    assert.equal(got.issue, null);
    assert.match(got.comment, /^返工完成/);
  });

  it('快路无署名单：plan 不拒，issue 空，完工 comment 走 PR', async () => {
    const { planWorkerDone } = await WD;
    const got = planWorkerDone({
      pr: '1270',
      body: '返工完成：PR #1270',
      runGh: fakeGh({
        title: 'fix(派工): 快路',
        body: '快路按设计不署名 issue',
        labels: ['model/grok-4.6', 'reviewer/gpt-5.6-luna', 'type/写码'],
        reviews: [{ state: 'CHANGES_REQUESTED' }],
      }),
    });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.issue, null);
    assert.equal(got.round, 'rework');
    assert.match(got.comment, /^返工完成/);
  });

  it('dao.mjs 快路无署名单 → 完工评论只发 PR，merge-policy 走 manual', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'dao.mjs'), 'utf8');
    const start = src.indexOf('async function cmdWorkerDoneMirasim');
    const end = src.indexOf('async function cmdStartMirasim', start);
    assert.equal(start >= 0, true);
    assert.equal(end > start, true);
    const fn = src.slice(start, end);
    assert.match(fn, /if \(plan\.issue != null\) \{/);
    assert.match(fn, /快路无署名单，完工评论只发 PR/);
    assert.match(fn, /mergePolicy: books\.mergePolicy/);
    const mpStart = src.indexOf('function mirasimMergePolicy');
    const mpEnd = src.indexOf('function reviewerLockPath', mpStart);
    assert.equal(mpStart >= 0, true);
    assert.equal(mpEnd > mpStart, true);
    const mp = src.slice(mpStart, mpEnd);
    assert.match(mp, /unsignedIssueMergePolicy/);
    assert.match(mp, /!hasIssue/);
    const crStart = src.indexOf('async function cmdReviewerCreateMirasim');
    const crEnd = src.indexOf('async function cmdWorkerDoneMirasim', crStart);
    assert.equal(crStart >= 0, true);
    assert.equal(crEnd > crStart, true);
    const cr = src.slice(crStart, crEnd);
    assert.match(cr, /mirasimMergePolicy/);
    assert.match(cr, /快路无署名单/);
  });
});
