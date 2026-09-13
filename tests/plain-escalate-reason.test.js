// 报帅单内部代号不许进群（2026-09-05 实咬）：用户在总控群问「现状怎么样了」，机器人答
// 「#918 唤醒用尽」——那是 wake-exhausted 被 LLM 直译的结果。代号原样躺在 issue 标题里，
// 而标题被当上下文原样喂给了 LLM。
//
// 两层判据：① 源头翻译（plainTitle）——喂之前换人话，LLM 看不到代号；
//           ② 兜底报警（plain-words 规则）——别处漏了要有东西喊一声。
// 判别力：认不出的代号必须原样留着（不猜不吞），且人话文本不许被误报。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const url = (rel) => 'file://' + path.join(REPO, rel).replace(/\\/g, '/');

describe('报帅单代号 → 人话', () => {
  it('① 源头翻译：标题里的 reason 代号换成人话', async () => {
    const { plainTitle } = await import(url('scripts/lib/feishu-triage-core.mjs'));
    assert.equal(plainTitle('[待拍板] wake-exhausted：PR #905'), '[待拍板] 反复推了都没动静：PR #905');
    assert.equal(plainTitle('[待拍板] two-red：PR #893'), '[待拍板] 审官连着判红：PR #893');
    assert.equal(plainTitle('[待拍板] missing-labels：issue #898'), '[待拍板] 缺派工标签：issue #898');
    assert.equal(plainTitle('[待拍板] approved-without-review：PR #1'), '[待拍板] 判绿记录对不上：PR #1');
  });

  it('① 判别力：没登记的代号原样留着——不猜、不吞', async () => {
    const { plainTitle } = await import(url('scripts/lib/feishu-triage-core.mjs'));
    const t = '[待拍板] some-future-code：x';
    assert.equal(plainTitle(t), t, '认不出就原样，翻译表不许瞎编');
    assert.equal(plainTitle(''), '');
    assert.equal(plainTitle(null), '');
  });

  it('② 兜底报警：代号漏进文案必须被判黑话', async () => {
    const { plainViolations } = await import(url('scripts/lib/plain-words.mjs'));
    for (const code of ['wake-exhausted', 'two-red', 'missing-labels', 'approved-without-review']) {
      const v = plainViolations(`#918 ${code} 待拍板`);
      assert.ok(v.some(x => x.why === '报帅单内部代号'), `${code} 必须被拦 → ${JSON.stringify(v)}`);
    }
  });

  it('② 判别力反证：翻译后的人话不许被误报', async () => {
    const { plainViolations } = await import(url('scripts/lib/plain-words.mjs'));
    assert.deepEqual(plainViolations('#918 反复推了都没动静，等你拍'), []);
    assert.deepEqual(plainViolations('#893 审官连着判红，等你拍换人'), []);
  });

  it('渲染点真的用了 plainTitle（不是只导出没接上）', async () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(REPO, 'scripts/lib/feishu-triage-core.mjs'), 'utf8');
    assert.match(src, /plainTitle\(i\.title\)/, '待拍板列表渲染必须过翻译');
  });
});

describe('三问问法必须是大白话', () => {
  it('三问的兜底问法自己不许踩黑话闸（含仓内目录名）', async () => {
    const [{ THREE_QUESTIONS }, { plainViolations }] = await Promise.all([
      import(url('scripts/lib/feishu-triage-core.mjs')),
      import(url('scripts/lib/plain-words.mjs')),
    ]);
    assert.equal(THREE_QUESTIONS.length, 3, '三问判据不许被改成两问/四问');
    for (const q of THREE_QUESTIONS) {
      assert.deepEqual(plainViolations(q.fallback), [], `三问「${q.key}」踩黑话：${q.fallback}`);
      assert.deepEqual(plainViolations(q.label), [], `三问 label「${q.key}」踩黑话：${q.label}`);
    }
  });

  it('判别力：仓内目录名会被拦（旧问法必须翻红）', async () => {
    const { plainViolations } = await import(url('scripts/lib/plain-words.mjs'));
    const v = plainViolations('要记进 docs/memory 吗？');
    assert.ok(v.some(x => x.why === '仓内目录名'), '旧问法必须被拦 → ' + JSON.stringify(v));
    assert.deepEqual(plainViolations('这事要不要写进文档，方便以后查？'), [], '人话不许误报');
  });

  it('LLM 提示词与人格文件同步（不许只改一处）', () => {
    const fs = require('fs');
    const core = fs.readFileSync(path.join(REPO, 'scripts/lib/feishu-triage-core.mjs'), 'utf8');
    const persona = fs.readFileSync(path.join(REPO, 'host/skills/feishu-triage/persona.md'), 'utf8');
    for (const src of [core, persona]) {
      assert.doesNotMatch(src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n'),
        /是否 docs\/memory 该记/, '旧问法残留');
    }
    assert.match(persona, /要不要写进文档/, 'persona 三问要跟上');
    assert.match(core, /要不要写进文档/, 'LLM 提示词三问要跟上');
  });
});
