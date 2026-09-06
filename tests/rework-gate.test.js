// tests/rework-gate.test.js —— 返工不该再过消歧门（用户 2026-09-06 拍板「走 3：改闸」）
//
// 实咬：PR #1070 / #1075 / #1079 判红或冲突要返工，指挥官派返工工人，被消歧门拒：
//   「issue #1063 缺『已消歧』label，拒派（fail-close，忘打标是拦住不是放行）」
// 三张署名单都是机器自己开的返工单，正文写得整整齐齐、model/reviewer 标也齐，只差那个标。
// 于是三条返工线全停——而 #1063 本身正是「噪音单去重」的修法，噪音机器也就停不下来。
//
// 判据：消歧门问的是「开工前想清楚了吗」。PR 已经存在 = 活早就开工了，代码就在 diff 里。
// 此时再拦，拦的是收尾不是开工。所以豁免条件是**可核查的事实**（是不是开放 PR 的署名单），
// 不是调用方自称「我是返工」。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CARD = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'card.mjs').replace(/\\/g, '/'));

/** 造一个 gh 执行器：issue 标签 + 开放 PR 列表都可控。 */
function ghWith({ labels = [], prs = [], prListOk = true, prListOut = null } = {}) {
  return (argv) => {
    if (argv[0] === 'issue') {
      return { ok: true, out: JSON.stringify({ labels: labels.map((name) => ({ name })) }) };
    }
    if (argv[0] === 'pr') {
      if (!prListOk) return { ok: false, error: 'gh 挂了' };
      return { ok: true, out: prListOut != null ? prListOut : JSON.stringify(prs) };
    }
    return { ok: false, error: '没料到的 gh 调用: ' + argv.join(' ') };
  };
}

// 真实语料：这三对是实咬现场的原样
const 返工现场 = [
  { issue: 1063, pr: { number: 1070, title: '[cc] fix(escalate): 噪音单的根因是判据写窄了三个字（#1063）', body: '署名 issue #1063' } },
  { issue: 1065, pr: { number: 1075, title: '[cc] fix(commander): 在途判据把「没查成」当成了「没有」', body: '署名 issue #1065' } },
  { issue: 1080, pr: { number: 1079, title: '[cc] fix(reviewer): 帅位手开的 PR 起不了审官', body: '署名 issue #1080' } },
];

describe('活已开工（有开放 PR 署名它）→ 放行', () => {
  for (const { issue, pr } of 返工现场) {
    it(`#${issue} 是 PR #${pr.number} 的署名单 → 缺标也放行`, async () => {
      const { checkIssueDisambiguated } = await CARD;
      const got = checkIssueDisambiguated({ issue, runGh: ghWith({ labels: ['type/写码'], prs: [pr] }) });
      assert.equal(got.ok, true);
      assert.equal(got.reworkExempt, true);
      assert.equal(got.pr, pr.number);
    });
  }

  it('署名写在标题里（`（#1063）`）也认得出', async () => {
    const { checkIssueDisambiguated } = await CARD;
    const got = checkIssueDisambiguated({
      issue: 1063,
      runGh: ghWith({ labels: [], prs: [{ number: 1070, title: 'fix: 某事（#1063）', body: '正文没写署名' }] }),
    });
    assert.equal(got.ok, true);
  });

  it('已经有「已消歧」标的照旧直接过，不用查 PR', async () => {
    const { checkIssueDisambiguated } = await CARD;
    let 查过PR = false;
    const gh = (argv) => {
      if (argv[0] === 'pr') { 查过PR = true; return { ok: true, out: '[]' }; }
      return { ok: true, out: JSON.stringify({ labels: [{ name: '已消歧' }] }) };
    };
    const got = checkIssueDisambiguated({ issue: 900, runGh: gh });
    assert.equal(got.ok, true);
    assert.equal(查过PR, false, '有标就该直接过，不该多打一次 gh');
  });
});

describe('豁免的边界（三条都不许放宽）', () => {
  it('没有任何开放 PR 署名它 → 照旧拒派（新活仍要过门）', async () => {
    const { checkIssueDisambiguated } = await CARD;
    const got = checkIssueDisambiguated({
      issue: 999,
      runGh: ghWith({ labels: ['type/写码'], prs: [{ number: 1070, title: 'fix（#1063）', body: '' }] }),
    });
    assert.equal(got.ok, false);
    assert.equal(got.hasLabel, false);
    assert.match(got.error, /缺「已消歧」/);
  });

  // 「待消歧」是明确的「还没定怎么做」，跟忘打标是两回事，豁免不许越过它。
  it('带「待消歧」标 → 有 PR 也拒派', async () => {
    const { checkIssueDisambiguated } = await CARD;
    const got = checkIssueDisambiguated({
      issue: 1063,
      runGh: ghWith({ labels: ['待消歧'], prs: [{ number: 1070, title: 'fix（#1063）', body: '' }] }),
    });
    assert.equal(got.ok, false);
    assert.equal(got.pending, true);
  });

  it('PR 列表没查成 → 不豁免，且说清是没查成（不许当放行）', async () => {
    const { checkIssueDisambiguated } = await CARD;
    const got = checkIssueDisambiguated({ issue: 1063, runGh: ghWith({ labels: [], prListOk: false }) });
    assert.equal(got.ok, false);
    assert.equal(got.exemptionUnscanned, true);
    assert.match(got.error, /没查成不放行/);
  });

  it('PR 列表返回不是 JSON / 不是数组 → 同样不豁免', async () => {
    const { checkIssueDisambiguated } = await CARD;
    const 坏 = checkIssueDisambiguated({ issue: 1063, runGh: ghWith({ labels: [], prListOut: '<html>502</html>' }) });
    assert.equal(坏.ok, false);
    assert.equal(坏.exemptionUnscanned, true);
    const 非数组 = checkIssueDisambiguated({ issue: 1063, runGh: ghWith({ labels: [], prListOut: '{"number":1}' }) });
    assert.equal(非数组.exemptionUnscanned, true);
  });

  it('issue 标签本身没查成 → 照旧不放行，轮不到豁免', async () => {
    const { checkIssueDisambiguated } = await CARD;
    const got = checkIssueDisambiguated({
      issue: 1063,
      runGh: (argv) => (argv[0] === 'issue' ? { ok: false, error: '限流' } : { ok: true, out: '[]' }),
    });
    assert.equal(got.ok, false);
    assert.equal(got.unscanned, true);
  });
});

describe('判据不靠自称', () => {
  // 调用方随手带一个 --rework 标志迟早会被滥用；豁免只认「开放 PR 署名它」这个事实。
  it('门的签名里没有任何「我是返工」之类的开关', async () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'card.mjs'), 'utf8');
    const a = src.indexOf('export function checkIssueDisambiguated');
    assert.notEqual(a, -1, '锚点找不到了——切片没取成，不是通过');
    const sig = src.slice(a, src.indexOf('\n', a));
    assert.equal(/rework|isRework|force|skipGate/i.test(sig), false, `门不许收「我是返工」这类开关：${sig}`);
  });

  it('署名判据复用 close-issue，不另造一份', async () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'card.mjs'), 'utf8');
    assert.match(src, /import \{ attributedIssueNumber \} from '\.\.\/close-issue\.mjs'/);
  });
});
