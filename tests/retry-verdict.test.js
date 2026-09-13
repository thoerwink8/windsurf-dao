// #1237：失败分三类——「再试一次会不会不一样」。
//
// 病：7 天日志 274 条错误里 54% 是不可试的（树/文件已经不在了、账本里根本没这条记录、
// 执行目录判死），而现行机制对它们一视同仁地试满 3 次 = 白等 3×45 分钟才见到人。
//
// 本套要证的是**判据两头都有判别力**（这是分类器最容易做错的地方）：
//   · 不可试的样本必须判 terminal —— 判成 retryable = 白等两小时
//   · 可试的样本必须判 retryable —— 判成 terminal = 把能自愈的推给人
//   · 认不出的必须判 unknown 且**说明它认不出** —— 不许静默兜底成「可试」还不吭声
//
// 样本取自真实日志（7 天 commander-act），不是编的。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const RV = import('file://' + path.join(REPO, 'scripts', 'lib', 'retry-verdict.mjs').replace(/\\/g, '/'));

describe('#1237 judgeRetry：不可试的样本必须判 terminal', () => {
  it('真实日志里的不可试样本全判 terminal', async () => {
    const { judgeRetry, RETRY_VERDICT_PROBES } = await RV;
    const wrong = [];
    for (const sample of RETRY_VERDICT_PROBES.mustBeTerminal) {
      const v = judgeRetry({ error: sample });
      if (v.verdict !== 'terminal') wrong.push(`${v.verdict} ← ${sample.slice(0, 70)}`);
    }
    assert.deepEqual(wrong, [], '这些重试不会变，判成可试就是白等两小时');
  });

  it('不可试的样本带得出「为什么不可试」', async () => {
    const { judgeRetry } = await RV;
    const v = judgeRetry({ error: "session-stop 没查成: ENOENT: no such file or directory, lstat '/x/dao-1024'" });
    assert.equal(v.verdict, 'terminal');
    assert.ok(v.why.includes('重试能改变的范围之外'), '理由要说人话  →  ' + v.why);
    assert.ok(v.matched, '要留下命中的是哪条规则（词表要能被审查）');
  });
});

describe('#1237 judgeRetry：可试的样本必须判 retryable', () => {
  it('真实日志里的可试样本全判 retryable', async () => {
    const { judgeRetry, RETRY_VERDICT_PROBES } = await RV;
    const wrong = [];
    for (const sample of RETRY_VERDICT_PROBES.mustBeRetryable) {
      const v = judgeRetry({ error: sample });
      if (v.verdict !== 'retryable') wrong.push(`${v.verdict} ← ${sample.slice(0, 70)}`);
    }
    assert.deepEqual(wrong, [], '这些会随时间改变，判成不可试就是把能自愈的推给人');
  });
});

describe('#1237 judgeRetry：认不出时不许静默兜底', () => {
  it('认不出的原文 → unknown，且说得出「这条该进词表」', async () => {
    const { judgeRetry } = await RV;
    const v = judgeRetry({ error: '某种从没见过的新失败：宇宙射线打翻了咖啡' });
    assert.equal(v.verdict, 'unknown', 'unknown 是独立的一态，不许并进 retryable');
    assert.equal(v.matched, null);
    assert.ok(v.why.includes('词表'), '要说得出这是词表该长的信号  →  ' + v.why);
  });

  it('没有原文 → unknown（不是 terminal：不知道的事不许判死）', async () => {
    const { judgeRetry } = await RV;
    for (const empty of [undefined, null, '', '   ', {}]) {
      const v = judgeRetry({ error: empty });
      assert.equal(v.verdict, 'unknown', `空的必须判 unknown  →  ${JSON.stringify(empty)}`);
    }
  });

  it('大小写不敏感（上游错误大小写不稳）', async () => {
    const { judgeRetry } = await RV;
    assert.equal(judgeRetry({ error: 'ENOENT: no such file' }).verdict, 'terminal');
    assert.equal(judgeRetry({ error: 'enoent: no such file' }).verdict, 'terminal');
    assert.equal(judgeRetry({ error: 'MERGEABLE=UNKNOWN' }).verdict, 'retryable');
  });
});

describe('#1237 exhaustedReasonText：两种结局写出来是两件事', () => {
  it('terminal 说「不再试第 N 次、不烧名额」，不说「试满」', async () => {
    const { exhaustedReasonText } = await RV;
    const t = exhaustedReasonText({ verdict: 'terminal', tries: 1, maxTries: 3, error: 'execution profile unverified: codex-relay-gpt-5.6-sol' });
    assert.ok(t.includes('重试不会变'), '要点明成因在重试范围之外  →  ' + t);
    assert.ok(t.includes('不再试第 2 次'), '要写清「没有下一次」  →  ' + t);
    assert.ok(t.includes('不烧满 3 次名额'), '要写清没白烧名额  →  ' + t);
    assert.ok(t.includes('codex-relay-gpt-5.6-sol'), '真因必须在  →  ' + t);
  });

  it('retryable 说「试了 N 次仍没推动」', async () => {
    const { exhaustedReasonText } = await RV;
    const t = exhaustedReasonText({ verdict: 'retryable', tries: 3, maxTries: 3, error: 'review-pending-drain 未全部成功' });
    assert.ok(t.includes('试了 3 次仍没推动'), '  →  ' + t);
    assert.ok(!t.includes('重试不会变'), '可试的不许写成「不会变」  →  ' + t);
  });

  it('没留下原文时明说，不含糊', async () => {
    const { exhaustedReasonText } = await RV;
    const t = exhaustedReasonText({ verdict: 'retryable', tries: 3, maxTries: 3 });
    assert.ok(t.includes('没留下失败原文'), '  →  ' + t);
  });
});
