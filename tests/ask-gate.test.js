// 问人闸（用户 2026-09-05：「是不是要固化成机制呀？而不是作为文档，文档就会不遵守」）。
//
// 每条对着一个实咬：2026-09-05 帅位问了用户 5 次，其中 2 次不该问——
// 「拦一个明显切错基线的 PR」「关一张四轮没过的单」，两件都不在 human_holds 四条里。
// 判据早就写在 docs/release-policy.json 了，只是从没进过注入面。
//
// 最要紧的一组是 unscanned：JSON 读不到 / 字段缺了，必须落 unscanned 而不是 auto。
// 落成 auto 的方向是「AI 替用户拍了不该拍的」，不可逆；落成 ask 顶多多问一句。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LIB = 'file://' + path.join(REPO, 'scripts', 'lib', 'ask-gate.mjs').replace(/\\/g, '/');
const LOAD = import(LIB);

// 一份合法策略的最小骨架。各用例只改自己要破坏的那一处，别处保持合法——
// 否则「因为缺了别的字段才 unscanned」会冒充「因为这处坏了」。
const GOOD = {
  human_holds: ['对用户发布(minor/major)', '花钱', '删数据', '改规则(协作约定/本文件/model-routing)'],
  confirm: {
    patch: { who: 'auto' },
    minor: { who: 'admin:1' },
    major: { who: 'admin:1' },
  },
  version: { bump_by_commit_type: { fix: 'patch', docs: 'patch', chore: 'patch', feat: 'minor', 'feat!': 'major' } },
};
const good = (over) => JSON.stringify({ ...GOOD, ...(over || {}) });

describe('问人闸：策略解析（读不到 ≠ 没红线）', () => {
  it('真相源 docs/release-policy.json 现在解析得动，且四条红线都在', async () => {
    const S = await LOAD;
    const p = S.loadPolicy({ root: REPO });
    assert.equal(p.unscanned, undefined, `真相源解析不了：${p.unscanned}`);
    assert.ok(p.holds.length >= 1, 'human_holds 一条都没有 ⇒ 本闸等于没查');
    assert.equal(p.levelWho.patch, 'auto', 'confirm.patch.who 不是 auto 了——「小变动自己拍」这句话失去出处，本闸判据要重审');
  });

  it('真相源每条红线都能拆出至少一个 ≥2 字的说法——拆不出等于这条永远匹配不上', async () => {
    const S = await LOAD;
    const p = S.loadPolicy({ root: REPO });
    for (const h of p.holds) {
      assert.ok(S.holdKeywords(h).length > 0, `红线「${h}」拆不出任何可匹配说法，它对本闸是隐形的`);
    }
  });

  it('JSON 坏了 → unscanned，不是 auto', async () => {
    const S = await LOAD;
    const p = S.parsePolicy('{这不是合法 JSON');
    assert.match(p.unscanned, /解析不了/);
    const v = S.classifyAsk({ text: '随便什么事', policy: p });
    assert.equal(v.verdict, 'unscanned');
  });

  it('缺 human_holds → unscanned，不是 auto（反例：这里判错就是 AI 替用户拍板）', async () => {
    const S = await LOAD;
    const doc = { ...GOOD };
    delete doc.human_holds;
    const p = S.parsePolicy(JSON.stringify(doc));
    assert.match(p.unscanned, /human_holds/);
    assert.equal(S.classifyAsk({ text: '要不要花钱买服务器', policy: p }).verdict, 'unscanned');
  });

  it('human_holds 是空数组 → unscanned（0 条红线跟没读到一样，不许当「什么都能自己拍」）', async () => {
    const S = await LOAD;
    const p = S.parsePolicy(good({ human_holds: [] }));
    assert.match(p.unscanned, /空的/);
  });

  it('缺 confirm.patch.who → unscanned（「按 patch 级自己拍」没了出处）', async () => {
    const S = await LOAD;
    const p = S.parsePolicy(good({ confirm: { patch: {}, minor: { who: 'admin:1' }, major: { who: 'admin:1' } } }));
    assert.match(p.unscanned, /confirm\.patch\.who/);
  });

  it('缺 version.bump_by_commit_type → unscanned（分级判据没了）', async () => {
    const S = await LOAD;
    const p = S.parsePolicy(good({ version: {} }));
    assert.match(p.unscanned, /bump_by_commit_type/);
  });

  it('文件不在 → unscanned（「文件不在」不是「没有红线」）', async () => {
    const S = await LOAD;
    const p = S.loadPolicy({ file: path.join(REPO, 'docs', '这个文件不存在.json') });
    assert.match(p.unscanned, /不在/);
  });
});

describe('问人闸：三态判定', () => {
  const P = async () => (await LOAD).parsePolicy(good());

  it('ask —— 提到花钱，命中 human_holds', async () => {
    const S = await LOAD;
    const v = S.classifyAsk({ text: '要不要花钱买一台服务器？', policy: await P() });
    assert.equal(v.verdict, 'ask');
    assert.equal(v.matched, '花钱');
  });

  it('ask —— 显式写「依据：删数据」', async () => {
    const S = await LOAD;
    const v = S.classifyAsk({ text: '这批旧卡清不清（依据：删数据）', policy: await P() });
    assert.equal(v.verdict, 'ask');
    assert.equal(v.basis, '删数据');
  });

  it('ask —— 括号里的同义写法也算命中（minor 属于「对用户发布(minor/major)」）', async () => {
    const S = await LOAD;
    const v = S.classifyAsk({ text: '依据：minor 发布', policy: await P() });
    assert.equal(v.verdict, 'ask');
    assert.equal(v.matched, '对用户发布(minor/major)');
  });

  it('auto —— 2026-09-05 实咬样本一：拦一个明显切错基线的 PR', async () => {
    const S = await LOAD;
    const v = S.classifyAsk({ text: '要不要拦下这个明显切错基线的 PR？', policy: await P() });
    assert.equal(v.verdict, 'auto');
    assert.match(v.why, /human_holds/);
  });

  it('auto —— 2026-09-05 实咬样本二：关一张四轮没过的单', async () => {
    const S = await LOAD;
    const v = S.classifyAsk({ text: '#833 审了四轮还没过，关掉还是继续？', policy: await P() });
    assert.equal(v.verdict, 'auto');
  });

  it('auto —— 写了依据但不在四条里，依据要被带出来给 AI 看', async () => {
    const S = await LOAD;
    const v = S.classifyAsk({ text: '要不要换个审官（依据：省时间）', policy: await P() });
    assert.equal(v.verdict, 'auto');
    assert.equal(v.basis, '省时间');
  });

  it('写了依据就只按依据判——正文里蹭到红线字样不算数', async () => {
    const S = await LOAD;
    // 正文提了「花钱」，但 AI 自己交代的依据是「省时间」⇒ 按依据判 auto。
    // 这条防的是「随口提一句花钱就把闸糊过去」。
    const v = S.classifyAsk({ text: '换审官能省点花钱吗（依据：省时间）', policy: await P() });
    assert.equal(v.verdict, 'auto');
  });
});

describe('问人闸：分级线索（version.bump_by_commit_type）', () => {
  const P = async () => (await LOAD).parsePolicy(good());

  it('fix → patch → auto', async () => {
    const S = await LOAD;
    const v = S.classifyAsk({ text: '修个空指针', hints: { commitType: 'fix' }, policy: await P() });
    assert.equal(v.verdict, 'auto');
  });

  it('feat → minor → ask（confirm.minor.who=admin:1）', async () => {
    const S = await LOAD;
    const v = S.classifyAsk({ text: '加个新命令', hints: { commitType: 'feat' }, policy: await P() });
    assert.equal(v.verdict, 'ask');
    assert.match(v.matched, /confirm\.minor\.who=admin:1/);
  });

  it('feat! → major → ask', async () => {
    const S = await LOAD;
    const v = S.classifyAsk({ text: '换掉参数格式', hints: { commitType: 'feat!' }, policy: await P() });
    assert.equal(v.verdict, 'ask');
    assert.match(v.matched, /major/);
  });

  it('线索认不出来 → unscanned，不是 auto（级都定不了不许放行）', async () => {
    const S = await LOAD;
    const v = S.classifyAsk({ text: '不知道算什么', hints: { commitType: 'wibble' }, policy: await P() });
    assert.equal(v.verdict, 'unscanned');
    assert.match(v.why, /bump_by_commit_type/);
  });

  it('红线优先于分级：fix 级只要碰了删数据照样得问', async () => {
    const S = await LOAD;
    const v = S.classifyAsk({ text: '顺手把旧表删了（依据：删数据）', hints: { commitType: 'fix' }, policy: await P() });
    assert.equal(v.verdict, 'ask');
    assert.equal(v.matched, '删数据');
  });
});

describe('问人闸：注入文本三形两两不同，且「没查成」读不成「查过没事」', () => {
  it('三态输出互不相同，unscanned 那形必须自带「没查成」', async () => {
    const S = await LOAD;
    const policy = S.parsePolicy(good());
    const texts = {
      ask: S.renderAskGate(S.classifyAsk({ text: '依据：花钱', policy }), { policy }),
      auto: S.renderAskGate(S.classifyAsk({ text: '关掉这张单？', policy }), { policy }),
      unscanned: S.renderAskGate(S.classifyAsk({ text: 'x', policy: S.parsePolicy('坏的') }), { policy }),
    };
    const seen = new Set(Object.values(texts));
    assert.equal(seen.size, 3, '三态里有两形同形 ⇒ 这两种情况分不开');
    assert.match(texts.unscanned, /没查成/);
    assert.match(texts.unscanned, /不是「可以自己拍」/, '「没查成」那形必须当场否掉「那就自己拍吧」这条读法，否则它会被当成放行');
    assert.match(texts.auto, /依据/, 'auto 那形必须要求 AI 交代依据，否则它只是句评论');
    assert.ok(texts.ask.length < texts.auto.length, '该问那形要短——放行不啰嗦');
  });

  it('auto 那形把四条红线原样列出来（列表从 JSON 现取，不抄常量）', async () => {
    const S = await LOAD;
    const policy = S.parsePolicy(good());
    const t = S.renderAskGate(S.classifyAsk({ text: '关掉这张单？', policy }), { policy });
    for (const h of policy.holds) assert.ok(t.includes(h), `注入文本里没有红线「${h}」`);
  });
});

describe('问人闸：从提问工具的入参取文', () => {
  it('AskUserQuestion 的嵌套结构里，依据写在哪个字段都收得到', async () => {
    const S = await LOAD;
    const input = {
      questions: [{
        question: '这批数据清不清？',
        header: '清理',
        options: [{ label: '清', description: '依据：删数据' }, { label: '不清', description: '留着' }],
      }],
    };
    const text = S.askToolText(input);
    assert.equal(S.extractBasis(text), '删数据');
  });

  it('mirasim im_ask_user 的扁平结构同样收得到', async () => {
    const S = await LOAD;
    const text = S.askToolText({ question: '买不买？', hint: '依据：花钱', options: [{ label: '买' }] });
    assert.match(text, /花钱/);
  });

  it('坏 payload 不许把取文转晕（自引用/超深嵌套只当没有）', async () => {
    const S = await LOAD;
    let deep = { s: '底' };
    for (let i = 0; i < 40; i += 1) deep = { deep };
    assert.doesNotThrow(() => S.askToolText(deep));
    assert.equal(S.askToolText(null), '');
    assert.equal(S.askToolText(undefined), '');
  });

  it('两个提问工具的名字都在 ASK_TOOLS 里（少一个 = 那条路没闸）', async () => {
    const S = await LOAD;
    assert.ok(S.ASK_TOOLS.includes('AskUserQuestion'));
    assert.ok(S.ASK_TOOLS.includes('mcp__mirasim__im_ask_user'));
  });
});

describe('问人闸：hook 的装载声明与真相源对得上', () => {
  const HOOKS = path.join(REPO, 'host', 'skills', 'ask-gate', 'hooks', 'hooks.json');

  it('hooks.json 声明的是 PreToolUse，且 matcher 覆盖两个提问工具', async () => {
    const S = await LOAD;
    const raw = fs.readFileSync(HOOKS, 'utf8');
    assert.ok(!raw.startsWith('﻿'), 'hooks.json 带 BOM——宿主解析不了');
    const doc = JSON.parse(raw);
    const entries = doc?.hooks?.PreToolUse;
    assert.ok(Array.isArray(entries) && entries.length, 'hooks.json 里没有 PreToolUse');
    const matchers = entries.map((e) => e.matcher).filter(Boolean);
    assert.ok(matchers.length, 'matcher 缺失 = 对所有工具都跑，纯噪音');
    for (const tool of S.ASK_TOOLS) {
      assert.ok(matchers.some((m) => new RegExp(m).test(tool)), `matcher 匹配不到 ${tool}——那条路没闸`);
    }
    // 反例：matcher 不许把别的工具也网进来（对着 Bash 讲「该不该问用户」是纯噪音）。
    for (const other of ['Bash', 'Read', 'Edit', 'mcp__mirasim__gui_act']) {
      assert.ok(!matchers.some((m) => new RegExp(m).test(other)), `matcher 把 ${other} 也网进来了`);
    }
  });

  it('声明里点到的脚本真的在（注册指向空气是常见死法）', () => {
    const doc = JSON.parse(fs.readFileSync(HOOKS, 'utf8'));
    const cmds = doc.hooks.PreToolUse.flatMap((e) => (e.hooks || []).map((h) => h.command));
    assert.ok(cmds.length, '一条 command 都没有');
    for (const c of cmds) {
      const m = c.match(/hooks\/([\w.-]+\.mjs)/);
      assert.ok(m, `command 里看不出脚本名：${c}`);
      assert.ok(fs.existsSync(path.join(REPO, 'host', 'skills', 'ask-gate', 'hooks', m[1])), `声明点到的 ${m[1]} 不在`);
    }
  });
});
