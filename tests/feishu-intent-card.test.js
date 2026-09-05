// #875：意图层（问候不甩盘点）+ 待拍板卡片回传 + 群 profile 范围闸。
// 判别：故意构造的违规样本必须被拦（问候夹盘点、不认识的意图、重复点击、缺单号）。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const toUrl = (p) => 'file://' + p.replace(/\\/g, '/');
const CORE = import(toUrl(path.join(REPO, 'scripts', 'lib', 'feishu-triage-core.mjs')));
const ADAPTER = import(toUrl(path.join(REPO, 'scripts', 'feishu-triage.mjs')));
const PROFILE = import(toUrl(path.join(REPO, 'scripts', 'lib', 'feishu-group-profile.mjs')));
const CARD = import(toUrl(path.join(REPO, 'scripts', 'lib', 'feishu-hub-card.mjs')));

const DEFAULT_REPO = 'thoerwink8/windsurf-dao';
const HUB_POLICY = {
  enabled: true,
  allowedActions: ['situation', 'decision', 'guide'],
  upstream: { redThreshold: 2, decisions: true, digest: false },
};
const HUB_PROFILE = {
  persona: '总控群助手。问候闲聊只打招呼；明确问现状才给盘面。',
  intents: ['greeting', 'situation', 'decision', 'new_request'],
  refuse: '这事不归我，去项目群开个单。',
};
const CONTEXT = {
  projects: [{
    repo: DEFAULT_REPO,
    situation: {
      at: '2026-09-04T00:00:00.000Z',
      repo: DEFAULT_REPO,
      github: {
        scanned: true,
        issues: [{ number: 846, title: '[待拍板] 盘点：orphan-cwd', labels: [{ name: '待拍板' }] }],
        prs: [],
      },
    },
    error: null,
  }],
  health: { updatedAt: 't', targets: { grok: { state: 'green' } } },
  breaker: { updatedAt: 't', targets: {} },
};

function hubInbound(over = {}) {
  return {
    chatId: 'oc_hub',
    rootId: 'om_hub_root',
    messageId: 'om_hub_msg',
    senderOpenId: 'openid-user',
    senderName: '用户',
    text: '现在盘面怎么样？',
    ts: 1700000000,
    repo: null,
    kind: 'hub',
    profile: HUB_PROFILE,
    ...over,
  };
}

function scriptedLlm(script) {
  let i = 0;
  return async () => {
    const r = script[Math.min(i, script.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return r;
  };
}

function makeDeps(over = {}) {
  const calls = { comment: [], llm: [], context: 0 };
  const { llm: llmOverride, ...rest } = over;
  const deps = {
    ghSearch: async () => [],
    ghCreateIssue: async () => { throw new Error('hub 对话不该建单'); },
    ghComment: async (repo, number, body) => { calls.comment.push({ repo, number, body }); },
    llm: async (arg) => {
      calls.llm.push(arg);
      if (!llmOverride) throw new Error('测试没给 llm 脚本');
      return llmOverride(arg);
    },
    now: () => 1700000100000,
    state: new Map(),
    allowOpenIds: ['openid-user'],
    hubChat: HUB_POLICY,
    hubContext: async () => { calls.context += 1; return CONTEXT; },
    ...rest,
  };
  return { deps, calls };
}

function cardEvent({ choice = 'recommend', issue = 846, repo = DEFAULT_REPO, messageId = 'om_card_1' } = {}) {
  return {
    schema: '2.0',
    header: { event_type: 'card.action.trigger', event_id: 'e-card' },
    event: {
      operator: { open_id: 'ou_user1', user_name: '老板' },
      action: { tag: 'button', value: { issue: String(issue), choice, repo } },
      context: { open_message_id: messageId, open_chat_id: 'oc_hub' },
      token: 'tok_1',
    },
  };
}

describe('群 profile（#875 ⑥⑦）', () => {
  it('缺 profile 用默认；不认识的意图必须抛（故意违规样本）', async () => {
    const P = await PROFILE;
    const d = P.parseProfile(undefined);
    assert.deepStrictEqual(d.intents, P.DEFAULT_PROFILE.intents);
    assert.throws(() => P.parseProfile({ intents: ['hack'] }, { chatId: 'oc_x' }), /hack/);
    assert.throws(() => P.parseProfile({ persona: '' }, { chatId: 'oc_x' }), /persona/);
    assert.throws(() => P.parseProfile({ refuse: '  ' }, { chatId: 'oc_x' }), /refuse/);
    assert.throws(() => P.parseProfile('nope', { chatId: 'oc_x' }), /不是对象/);
  });

  it('问候闸：你好命中；现状怎么样不命中；盘点段落算漏', async () => {
    const P = await PROFILE;
    assert.equal(P.looksLikeGreeting('你好'), true);
    assert.equal(P.looksLikeGreeting('你好呀'), true);
    assert.equal(P.looksLikeGreeting('hi'), true);
    assert.equal(P.looksLikeGreeting('现状怎么样'), false);
    assert.equal(P.looksLikeGreeting('现在盘面怎么样？'), false);
    assert.equal(P.inventoryLeak('待拍板 1 张：#846'), true);
    assert.equal(P.inventoryLeak('在的，有事直接说。'), false);
    assert.equal(P.safeGreetingReply('待拍板 3 张，开放 issues 12'), P.GREETING_FALLBACK);
    assert.equal(P.safeGreetingReply('在的。'), '在的。');
  });
});

describe('意图层：先理解再行动（#875 ①⑥）', () => {
  it('注入「你好」：对话式短句，不含盘点段落；不读态势', async () => {
    const S = await CORE;
    const P = await PROFILE;
    const { deps, calls } = makeDeps({
      llm: scriptedLlm(['在的，有事直接说。']),
    });
    const out = await S.triage(hubInbound({ text: '你好' }), deps);
    assert.equal(out.replies.length, 1);
    assert.equal(out.replies[0].text, '在的，有事直接说。');
    assert.equal(P.inventoryLeak(out.replies[0].text), false);
    assert.doesNotMatch(out.replies[0].text, /待拍板|开放 issues|【项目/);
    assert.equal(out.actions[0].record.intent, 'greeting');
    assert.equal(calls.context, 0, '问候不读盘面');
    assert.equal(calls.comment.length, 0);
  });

  it('问候被 LLM 塞进盘点：闸拦住，换成兜底短句（故意违规样本）', async () => {
    const S = await CORE;
    const P = await PROFILE;
    const { deps } = makeDeps({
      llm: scriptedLlm(['待拍板 2 张：#846 #875。开放 issues 12 张。']),
    });
    const out = await S.triage(hubInbound({ text: '你好' }), deps);
    assert.equal(out.replies[0].text, P.GREETING_FALLBACK);
    assert.equal(P.inventoryLeak(out.replies[0].text), false);
  });

  it('注入「现状怎么样」：走盘点，prompt 带态势出处', async () => {
    const S = await CORE;
    const ANSWER = '出了什么事：在途 1 张待拍板 #846。\n影响：还等你拍。\n我打算：先不动。出处：项目态势。';
    const { deps, calls } = makeDeps({
      llm: scriptedLlm([{ intent: 'situation', issueNumber: null }, ANSWER]),
    });
    const out = await S.triage(hubInbound({ text: '现状怎么样' }), deps);
    assert.equal(out.replies[0].text, ANSWER);
    assert.equal(out.actions[0].record.intent, 'situation');
    assert.ok(calls.llm[1].user.includes('#846'), '盘面回答的 prompt 要带单号出处');
    assert.equal(calls.context, 1);
  });

  it('注入超范围问题：拒答一句话，不编、不读盘面', async () => {
    const S = await CORE;
    const { deps, calls } = makeDeps({
      llm: scriptedLlm([{ intent: 'other', issueNumber: null }]),
    });
    const out = await S.triage(hubInbound({ text: '帮我写一段 rust 排序' }), deps);
    assert.equal(out.replies[0].text, HUB_PROFILE.refuse);
    assert.equal(out.actions[0].record.intent, 'other');
    assert.equal(calls.context, 0);
    assert.equal(calls.comment.length, 0);
  });
});

describe('待拍板卡片回传（#875 ②⑤⑧）', () => {
  it('卡片正文自带出事/影响/推荐/期限，按钮三选一回传，GitHub 只兜底', async () => {
    const C = await CARD;
    const card = C.buildHubCard({
      repo: DEFAULT_REPO, number: 875, url: 'https://github.com/thoerwink8/windsurf-dao/issues/875',
      title: '飞书意图层', from: '用户',
      what: '总控群发你好被甩盘点',
      impact: '不像人，拍板还得读大段文字',
      recommend: '先理解再行动，卡片一键拍',
      why: '用户 09-04 亲自点的这两处',
      deadline: '双向门：4 小时内不拍按推荐执行',
    });
    const body = card.elements[0].text.content;
    assert.match(body, /出了什么事：总控群发你好被甩盘点/);
    assert.match(body, /影响：不像人/);
    assert.match(body, /推荐：先理解再行动/);
    assert.match(body, /期限：双向门/);
    assert.match(body, /打开单子看/);
    const btns = card.elements[1].actions;
    assert.deepStrictEqual(btns.map((b) => b.text.content), ['按推荐执行', '等我回来拍', '换个方案']);
    for (const b of btns) {
      assert.equal(b.behaviors[0].type, 'callback');
      assert.equal(b.value.issue, '875');
      assert.ok(['recommend', 'wait', 'alternative'].includes(b.value.choice));
    }
  });

  it('fixture 注入 card.action.trigger → gh 评论动作 + 卡片更新回包', async () => {
    const M = await ADAPTER;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu875-card-'));
    const store = M.createStateStore(path.join(dir, 'threads.json'));
    store.hubPending.om_card_1 = { repo: DEFAULT_REPO, number: 846, title: '盘点', what: '有孤儿进程' };
    const comments = [];
    const deps = {
      now: () => new Date('2026-09-04T12:00:00+08:00'),
      ghComment: async (repo, number, body) => { comments.push({ repo, number, body }); },
    };
    const res = await M.handleEvent(cardEvent(), {
      groups: { oc_hub: { kind: 'hub' } }, store, deps, triage: async () => { throw new Error('不该走消息 triage'); },
      client: null, creds: null,
    });
    assert.ok(res.cardAck, '必须有卡片回包');
    assert.equal(res.cardAck.toast.type, 'success');
    assert.match(res.cardAck.toast.content, /按推荐执行/);
    assert.equal(res.cardAck.card.type, 'raw');
    assert.match(res.cardAck.card.data.header.title.content, /已拍/);
    assert.match(res.cardAck.card.data.elements[0].text.content, /已拍：按推荐执行 · 老板/);
    const gh = res.actions.find((a) => a.type === 'gh_comment');
    assert.ok(gh, '必须有 gh 评论动作');
    assert.equal(gh.repo, DEFAULT_REPO);
    assert.equal(gh.number, 846);
    assert.match(gh.body, /按推荐执行/);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].number, 846);
    assert.equal(store.hubPending.om_card_1.decided.choice, 'recommend');
  });

  it('重复点击：toast 已拍过，不再写评论（故意违规样本）', async () => {
    const M = await ADAPTER;
    const store = {
      hubPending: {
        om_card_1: {
          repo: DEFAULT_REPO, number: 846,
          decided: { choice: 'recommend', who: '老板', when: '2026-09-04 12:00' },
        },
      },
      save() {},
    };
    const comments = [];
    const deps = { now: () => Date.now(), ghComment: async (...a) => comments.push(a) };
    const res = await M.handleEvent(cardEvent({ choice: 'wait' }), {
      groups: {}, store, deps, triage: async () => ({}), client: null,
    });
    assert.equal(res.cardKind, 'duplicate');
    assert.match(res.cardAck.toast.content, /已经拍过了/);
    assert.equal(comments.length, 0);
  });

  it('不认识的 choice / 缺单号：拦下不写评论', async () => {
    const M = await ADAPTER;
    const C = await CARD;
    const store = { hubPending: {}, save() {} };
    const comments = [];
    const deps = { now: () => Date.now(), ghComment: async (...a) => comments.push(a) };
    const bad = await M.handleCardAction(cardEvent({ choice: 'hack', issue: 846 }), { store, deps });
    assert.equal(bad.response.kind, 'bad_choice');
    assert.equal(comments.length, 0);
    const miss = C.cardCallbackResponse({ choice: 'recommend', repo: '', number: 0, name: 'x' });
    assert.equal(miss.kind, 'missing_issue');
  });

  it('换个方案：评论 + 追问一句', async () => {
    const M = await ADAPTER;
    const store = {
      hubPending: { om_card_1: { repo: DEFAULT_REPO, number: 846 } },
      save() {},
    };
    const deps = { now: () => Date.now(), ghComment: async () => {} };
    const res = await M.handleEvent(cardEvent({ choice: 'alternative' }), {
      groups: {}, store, deps, triage: async () => ({}), client: null,
    });
    assert.ok(res.actions.some((a) => a.type === 'gh_comment'));
    assert.ok(res.replies.some((r) => /换成哪条/.test(r.text)));
  });
});
