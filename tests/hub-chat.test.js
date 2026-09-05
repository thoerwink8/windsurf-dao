// #852 总帅入口第一版：hub 群全量对话。
// 判据覆盖：hub 问盘面 → 不回 HUB_GUIDANCE 且回答链含态势内容；
//           待拍板 thread 回复 → 拍板写回对应单；新需求 → 仍指路；
//           LLM 挂了 → LLM_DOWN_REPLY 不猜；聚合层 projects[] 多项目接口；
//           策略 hubChat 节校验；消费记录 ~/.dao/hub-chat/*.ndjson 带 updatedAt。
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const toUrl = (p) => 'file://' + p.replace(/\\/g, '/');
const CORE = import(toUrl(path.join(REPO, 'scripts', 'lib', 'feishu-triage-core.mjs')));
const ADAPTER = import(toUrl(path.join(REPO, 'scripts', 'feishu-triage.mjs')));
const POLICY_CHECK = import(toUrl(path.join(REPO, 'scripts', 'lib', 'dispatch-policy-check.mjs')));

const DEFAULT_REPO = 'thoerwink8/windsurf-dao';
const HUB_POLICY = {
  enabled: true,
  allowedActions: ['situation', 'decision', 'guide'],
  upstream: { redThreshold: 2, decisions: true, digest: false },
};

/** 指挥官态势 + 健康表 + 熔断表的聚合上下文夹具（结构对齐 ~/.dao 实机文件）。 */
const CONTEXT = {
  projects: [{
    repo: DEFAULT_REPO,
    situation: {
      at: '2026-09-03T11:51:03.380Z',
      repo: DEFAULT_REPO,
      github: {
        scanned: true,
        issues: [
          { number: 846, title: '[待拍板] 盘点：orphan-cwd', labels: [{ name: '待拍板' }] },
          { number: 807, title: '删 Windows 本机编排层', labels: [{ name: '任务' }, { name: '已消歧' }] },
        ],
        prs: [{ number: 853 }],
      },
    },
    error: null,
  }],
  health: {
    updatedAt: '2026-09-03T13:46:37Z',
    targets: {
      'gw:grokpool/grok-4.6': { state: 'red', why: '200 但零内容' },
      'gw:gptpool/gpt-5.6': { state: 'green' },
    },
  },
  breaker: { updatedAt: '2026-09-03T13:08:06Z', targets: { 'gw:windsurf/gpt-5.6-luna': { state: 'closed' } } },
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
    ...over,
  };
}

/** 按脚本顺序出 llm 结果；Error 实例 = 该次调用抛错。 */
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

describe('hub 对话（#852 总帅入口）', () => {
  it('问盘面：不回 HUB_GUIDANCE，回答经聚合盘面（态势/健康表内容进了 prompt）', async (t) => {
    const S = await CORE;
    const ANSWER = '在途 issues 2 张；待拍板 1 张：#846；grokpool 红 1 路，其余正常。';
    const { deps, calls } = makeDeps({
      llm: scriptedLlm([{ intent: 'situation', issueNumber: null }, ANSWER]),
    });
    const out = await S.triage(hubInbound(), deps);

    await t.test('回复是盘面回答，不是指路', () => {
      assert.strictEqual(out.replies.length, 1);
      assert.strictEqual(out.replies[0].text, ANSWER);
      assert.notStrictEqual(out.replies[0].text, S.HUB_GUIDANCE);
    });
    await t.test('第二次 llm 调用的 user 段含 situation + 健康表内容（聚合真进了上下文）', () => {
      assert.strictEqual(calls.llm.length, 2);
      const user = calls.llm[1].user;
      assert.ok(user.includes('#846'), '缺待拍板单号 → ' + user.slice(0, 400));
      assert.ok(user.includes('[待拍板] 盘点：orphan-cwd'), '缺待拍板标题');
      assert.ok(user.includes('gw:grokpool/grok-4.6'), '缺健康表红腿');
      assert.ok(user.includes('全部 closed'), '缺熔断态');
      assert.strictEqual(calls.context, 1, 'hubContext 读一次');
    });
    await t.test('消费记录动作：intent=situation、带 updatedAt、landedTo 为空', () => {
      assert.strictEqual(out.actions.length, 1);
      const a = out.actions[0];
      assert.strictEqual(a.type, 'hub_chat_record');
      assert.strictEqual(a.record.intent, 'situation');
      assert.strictEqual(a.record.landedTo, null);
      assert.strictEqual(a.record.question, '现在盘面怎么样？');
      assert.strictEqual(a.record.reply, ANSWER);
      assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(a.record.updatedAt), 'updatedAt 要是 ISO 时间');
    });
    await t.test('不建单不追评', () => {
      assert.strictEqual(calls.comment.length, 0);
    });
  });

  it('待拍板 thread 回复（hubPending 表命中）：拍板直落对应单，不走 LLM', async (t) => {
    const S = await CORE;
    const { deps, calls } = makeDeps({ llm: scriptedLlm([new Error('不该调 llm')]) });
    const out = await S.triage(hubInbound({
      text: '同意摘掉首选腿，走方案B',
      hubPending: { repo: DEFAULT_REPO, number: 846 },
    }), deps);

    await t.test('ghComment 写回 #846，正文带拍板人/原话/来源 id', () => {
      assert.strictEqual(calls.comment.length, 1);
      assert.strictEqual(calls.comment[0].repo, DEFAULT_REPO);
      assert.strictEqual(calls.comment[0].number, 846);
      assert.ok(calls.comment[0].body.includes('【飞书拍板】用户：同意摘掉首选腿，走方案B'));
      assert.ok(calls.comment[0].body.includes('om_hub_msg'), '要带来源 message_id');
    });
    await t.test('回执说清落点；llm 一次没调（确定性，不猜）', () => {
      assert.ok(out.replies[0].text.includes(`已记到 #846（windsurf-dao）`), out.replies[0].text);
      assert.strictEqual(calls.llm.length, 0);
    });
    await t.test('消费记录 landedTo 指到单', () => {
      assert.strictEqual(out.actions[0].record.landedTo, `${DEFAULT_REPO}#846`);
      assert.strictEqual(out.actions[0].record.intent, 'decision');
    });
  });

  it('待拍板 thread 回复（话题根是机器人发的带单链接，hub-say 旁路）：同样写回', async () => {
    const S = await CORE;
    const { deps, calls } = makeDeps({ llm: scriptedLlm([new Error('不该调 llm')]) });
    const out = await S.triage(hubInbound({
      text: '补标签就好，不用摘',
      threadRoot: {
        text: '指挥官报帅：#807 缺 model/ 标签\nhttps://github.com/thoerwink8/windsurf-dao/issues/807',
        fromBot: true,
      },
    }), deps);
    assert.strictEqual(calls.comment.length, 1);
    assert.strictEqual(calls.comment[0].number, 807);
    assert.ok(out.replies[0].text.includes('#807'));
  });

  it('拍板意图带 #N（新话题，无 pending）：LLM 判 decision 后写回该单', async () => {
    const S = await CORE;
    const { deps, calls } = makeDeps({
      llm: scriptedLlm([{ intent: 'decision', issueNumber: 807 }]),
    });
    const out = await S.triage(hubInbound({ text: '同意 #807 的方案A' }), deps);
    assert.strictEqual(calls.comment.length, 1);
    assert.strictEqual(calls.comment[0].repo, DEFAULT_REPO, '裸 #N 用聚合层第一个项目的 repo 兜底');
    assert.strictEqual(calls.comment[0].number, 807);
    assert.ok(out.replies[0].text.includes(`已记到 #807（windsurf-dao）`));
  });

  it('拍板意图但定位不到单：问编号，不猜不写', async () => {
    const S = await CORE;
    const { deps, calls } = makeDeps({
      llm: scriptedLlm([{ intent: 'decision', issueNumber: null }]),
    });
    const out = await S.triage(hubInbound({ text: '就按你说的办' }), deps);
    assert.strictEqual(calls.comment.length, 0);
    assert.strictEqual(out.replies[0].text, S.HUB_DECISION_ASK);
    assert.strictEqual(out.actions[0].record.landedTo, null);
  });

  it('新需求：仍回 HUB_GUIDANCE 指路项目群（唯一保留分支），不建单', async () => {
    const S = await CORE;
    const { deps, calls } = makeDeps({
      llm: scriptedLlm([{ intent: 'new_request', issueNumber: null }]),
    });
    const out = await S.triage(hubInbound({ text: '给面板加个夜间模式' }), deps);
    assert.strictEqual(out.replies[0].text, S.HUB_GUIDANCE);
    assert.strictEqual(calls.comment.length, 0);
    assert.strictEqual(out.actions[0].record.intent, 'new_request');
  });

  it('LLM 挂了：回 LLM_DOWN_REPLY，不编造、无动作', async () => {
    const S = await CORE;
    const { deps, calls } = makeDeps({ llm: scriptedLlm([new Error('网关 502')]) });
    const out = await S.triage(hubInbound(), deps);
    assert.strictEqual(out.replies[0].text, S.LLM_DOWN_REPLY);
    assert.deepStrictEqual(out.actions, []);
    assert.strictEqual(calls.comment.length, 0);
  });

  it('hubChat 关着 / deps 没给 hubChat：维持旧行为，一律指路', async () => {
    const S = await CORE;
    const off = makeDeps({ hubChat: { enabled: false, allowedActions: [] } });
    const out1 = await S.triage(hubInbound(), off.deps);
    assert.strictEqual(out1.replies[0].text, S.HUB_GUIDANCE);
    const none = makeDeps({ hubChat: undefined });
    const out2 = await S.triage(hubInbound(), none.deps);
    assert.strictEqual(out2.replies[0].text, S.HUB_GUIDANCE);
    // 未映射群（kind=null）也照旧指路
    const unmapped = makeDeps({});
    const out3 = await S.triage(hubInbound({ kind: null }), unmapped.deps);
    assert.strictEqual(out3.replies[0].text, S.HUB_GUIDANCE);
  });

  it('allowedActions 缺 decision：待拍板回复不写单、回执说明未开放', async () => {
    const S = await CORE;
    const { deps, calls } = makeDeps({
      hubChat: { enabled: true, allowedActions: ['situation'] },
    });
    const out = await S.triage(hubInbound({ hubPending: { repo: DEFAULT_REPO, number: 846 } }), deps);
    assert.strictEqual(calls.comment.length, 0);
    assert.ok(out.replies[0].text.includes('不收拍板'), out.replies[0].text); // 说人话文案（2026-09-04）
  });

  it('extractIssueRef：URL > owner/repo#N > 裸 #N（要兜底 repo）> 抽不到 null', async () => {
    const S = await CORE;
    assert.deepStrictEqual(
      S.extractIssueRef('见 https://github.com/thoerwink8/windsurf-dao/issues/807 的讨论'),
      { repo: 'thoerwink8/windsurf-dao', number: 807 },
    );
    assert.deepStrictEqual(
      S.extractIssueRef('拍 https://github.com/thoerwink8/windsurf-dao/pull/853'),
      { repo: 'thoerwink8/windsurf-dao', number: 853 },
    );
    assert.deepStrictEqual(
      S.extractIssueRef('thoerwink8/ai-gateway-stack#12 也一起'),
      { repo: 'thoerwink8/ai-gateway-stack', number: 12 },
    );
    assert.deepStrictEqual(S.extractIssueRef('同意 #807', DEFAULT_REPO), { repo: DEFAULT_REPO, number: 807 });
    assert.strictEqual(S.extractIssueRef('同意 #807'), null, '裸 #N 没兜底 repo 不猜');
    assert.strictEqual(S.extractIssueRef('没有编号'), null);
  });

  it('buildHubContextBlock：projects[] 逐项目渲染；没读到的面明说没查成', async () => {
    const S = await CORE;
    const block = S.buildHubContextBlock(CONTEXT);
    assert.ok(block.includes(`【项目 ${DEFAULT_REPO} 态势 @ 2026-09-03T11:51:03.380Z】`));
    assert.ok(block.includes('开放 issues 2 张 / PRs 1 张'));
    assert.ok(block.includes('#846 [待拍板] 盘点：orphan-cwd'));
    assert.ok(block.includes('红 1 路'));
    assert.ok(block.includes('gw:grokpool/grok-4.6（200 但零内容）'));
    assert.ok(block.includes('全部 closed'));

    // 多项目：两个项目两段（聚合层接口）
    const two = S.buildHubContextBlock({
      ...CONTEXT,
      projects: [
        CONTEXT.projects[0],
        { repo: 'thoerwink8/ai-gateway-stack', situation: null, error: '没有 situation 文件' },
      ],
    });
    assert.ok(two.includes(`【项目 ${DEFAULT_REPO} 态势`));
    assert.ok(two.includes('【项目 thoerwink8/ai-gateway-stack 态势】没查成：没有 situation 文件'));

    // 全空：三面都明说没查成
    const empty = S.buildHubContextBlock({});
    assert.ok(empty.includes('【项目态势】没查成'));
    assert.ok(empty.includes('【供应商健康】没查成'));
    assert.ok(empty.includes('【熔断】没查成'));
  });
});

describe('hub 对话块A（IO 薄壳，#852）', () => {
  it('normalizeInbound：kind 按群映射三态（project/hub/null）', async () => {
    const M = await ADAPTER;
    const groups = { oc_p: { repo: DEFAULT_REPO, kind: 'project' }, oc_hub: { kind: 'hub' } };
    const ev = (chatId) => ({
      schema: '2.0',
      event: {
        sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
        message: { message_id: 'om_1', chat_id: chatId, message_type: 'text', content: '{"text":"hi"}', create_time: '1725000000000' },
      },
    });
    assert.strictEqual(M.normalizeInbound(ev('oc_p'), groups).kind, 'project');
    assert.strictEqual(M.normalizeInbound(ev('oc_hub'), groups).kind, 'hub');
    assert.strictEqual(M.normalizeInbound(ev('oc_hub'), groups).repo, null);
    assert.strictEqual(M.normalizeInbound(ev('oc_x'), groups).kind, null);
  });

  it('loadHubChatPolicy：读 hubChat 节；缺文件/缺节 = 关（不猜）', async () => {
    const M = await ADAPTER;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub852-policy-'));
    const f = path.join(dir, 'dispatch-policy.json');
    fs.writeFileSync(f, JSON.stringify({ hubChat: HUB_POLICY }), 'utf8');
    const p = M.loadHubChatPolicy(f);
    assert.strictEqual(p.enabled, true);
    assert.deepStrictEqual(p.allowedActions, ['situation', 'decision', 'guide']);
    assert.strictEqual(p.upstream.redThreshold, 2);
    assert.strictEqual(M.loadHubChatPolicy(path.join(dir, 'nope.json')).enabled, false);
    fs.writeFileSync(f, JSON.stringify({ preflight: {} }), 'utf8');
    assert.strictEqual(M.loadHubChatPolicy(f).enabled, false);
    // 仓里真身默认开着（#852 交付判据）
    assert.strictEqual(M.loadHubChatPolicy().enabled, true, 'docs/dispatch-policy.json 的 hubChat.enabled 应为 true');
  });

  it('readHubContext：projects[] 逐项目取最新 situation；健康/熔断读不到明说', async () => {
    const M = await ADAPTER;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub852-ctx-'));
    const cdir = path.join(dir, 'commander');
    fs.mkdirSync(cdir);
    fs.writeFileSync(path.join(cdir, 'situation-2026-09-01T00-00-00-000Z.json'), JSON.stringify({ at: 'old', repo: DEFAULT_REPO }), 'utf8');
    fs.writeFileSync(path.join(cdir, 'situation-2026-09-03T00-00-00-000Z.json'), JSON.stringify({ at: 'new', repo: DEFAULT_REPO }), 'utf8');
    const healthFile = path.join(dir, 'provider-health.json');
    fs.writeFileSync(healthFile, JSON.stringify({ updatedAt: 't', targets: {} }), 'utf8');
    const ctx = M.readHubContext({
      projects: [
        { repo: null, dir: cdir },
        { repo: 'thoerwink8/ai-gateway-stack', dir: path.join(dir, 'no-such') },
      ],
      healthFile,
      breakerFile: path.join(dir, 'no-breaker.json'),
    });
    assert.strictEqual(ctx.projects.length, 2, '多项目接口：进两个出两个');
    assert.strictEqual(ctx.projects[0].situation.at, 'new', '取最新一份 situation');
    assert.strictEqual(ctx.projects[0].repo, DEFAULT_REPO, 'repo 缺省从态势文件回填');
    assert.strictEqual(ctx.projects[1].situation, null);
    assert.ok(ctx.projects[1].error.includes('态势读失败'), '读不到 = 没查成，写明原因');
    assert.ok(ctx.health && ctx.health.updatedAt === 't');
    assert.strictEqual(ctx.breaker, null);
    assert.ok(ctx.breakerError.includes('熔断表读失败'));
  });

  it('appendHubChatRecord：NDJSON 按天落盘，行带 updatedAt', async () => {
    const M = await ADAPTER;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub852-ndjson-'));
    const rec = { updatedAt: '2026-09-03T14:00:00.000Z', from: '用户', question: 'q', intent: 'situation', reply: 'a', landedTo: null };
    M.appendHubChatRecord(rec, dir);
    M.appendHubChatRecord({ ...rec, intent: 'decision', landedTo: `${DEFAULT_REPO}#846` }, dir);
    const file = path.join(dir, '2026-09-03.ndjson');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0].updatedAt, '2026-09-03T14:00:00.000Z');
    assert.strictEqual(lines[1].landedTo, `${DEFAULT_REPO}#846`);
  });

  it('handleEvent：hub_chat_record 动作落到 HUB_CHAT_DIR（fixture 模式也落）', async () => {
    const M = await ADAPTER;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub852-he-'));
    const stateFile = path.join(dir, 'threads.json');
    const prevEnv = process.env.HUB_CHAT_DIR;
    process.env.HUB_CHAT_DIR = path.join(dir, 'hub-chat');
    try {
      const store = M.createStateStore(stateFile);
      const groups = { oc_hub: { kind: 'hub' } };
      const record = { updatedAt: '2026-09-03T15:00:00.000Z', from: '用户', question: '盘面？', intent: 'situation', reply: '正常', landedTo: null };
      const triage = async (inbound, deps) => ({
        replies: [{ rootId: inbound.rootId, text: '正常' }],
        actions: [{ type: 'hub_chat_record', record }],
        state: deps.state,
      });
      const deps = { state: store.map };
      const event = {
        schema: '2.0',
        event: {
          sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
          message: { message_id: 'om_h1', chat_id: 'oc_hub', message_type: 'text', content: '{"text":"盘面？"}', create_time: '1725000000000' },
        },
      };
      const res = await M.handleEvent(event, { groups, store, deps, triage, client: null, creds: null });
      assert.ok(res, '事件要被处理');
      const file = path.join(process.env.HUB_CHAT_DIR, '2026-09-03.ndjson');
      assert.ok(fs.existsSync(file), '消费记录文件要落盘');
      const line = JSON.parse(fs.readFileSync(file, 'utf8').trim());
      assert.strictEqual(line.question, '盘面？');
    } finally {
      if (prevEnv === undefined) delete process.env.HUB_CHAT_DIR;
      else process.env.HUB_CHAT_DIR = prevEnv;
    }
  });

  it('executeAction hub_card：记 hubPending（卡片消息 id → 单号），thread 回复能对回单', async () => {
    const M = await ADAPTER;
    const store = { hubPending: {} };
    const client = { sendCard: async () => 'om_card_1' };
    await M.executeAction(client, { hubChatId: 'oc_hub' }, {
      type: 'hub_card', repo: DEFAULT_REPO, number: 846, url: 'u', title: 't', from: '用户',
    }, store);
    assert.equal(store.hubPending.om_card_1.repo, DEFAULT_REPO);
    assert.equal(store.hubPending.om_card_1.number, 846);
  });

  it('createStateStore：hubPending 持久化（写→读回）', async () => {
    const M = await ADAPTER;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub852-store-'));
    const f = path.join(dir, 'threads.json');
    const s1 = M.createStateStore(f);
    s1.hubPending.om_card_9 = { repo: DEFAULT_REPO, number: 852 };
    s1.save();
    const s2 = M.createStateStore(f);
    assert.deepStrictEqual(s2.hubPending.om_card_9, { repo: DEFAULT_REPO, number: 852 }, '读回 = 落盘事实');
  });
});

describe('dispatch-policy hubChat 校验（#852，dao-check 用）', () => {
  it('齐且合范围 = 绿；缺 hubChat 节 = 没查成；越界 = 红', async () => {
    const C = await POLICY_CHECK;
    // rebase 到 #843/#849 之后：缺 breaker = 红，所以样本要带全四节（缺 hubChat 的没查成语义单测在下面）
    const BASE = {
      preflight: { enabled: true, timeoutMs: 5000, maxCandidates: 4, useHealthTable: true },
      breaker: { windowHours: 24, failuresToTrip: 3, cooldownHours: 24, halfOpenProbes: 1 },
      commander: { maxDispatchPerRound: 2, requireModelInRouting: true },
    };
    const ok = C.inspectDispatchPolicySource(JSON.stringify({ ...BASE, hubChat: HUB_POLICY }));
    assert.strictEqual(ok.ok, true, JSON.stringify(ok.problems));

    const missing = C.inspectDispatchPolicySource(JSON.stringify(BASE));
    assert.strictEqual(missing.unscanned, true, '缺节 = 没查成，不是过');

    const bad = C.inspectDispatchPolicySource(JSON.stringify({
      ...BASE,
      hubChat: { enabled: 'yes', allowedActions: ['hack'], upstream: { redThreshold: 0, decisions: 'yes', digest: null } },
    }));
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.unscanned, false);
    assert.ok(bad.problems.some((p) => p.includes('hubChat.enabled')));
    assert.ok(bad.problems.some((p) => p.includes('不认识：hack')));
    assert.ok(bad.problems.some((p) => p.includes('redThreshold')));
  });

  it('仓里真身 docs/dispatch-policy.json 过校验', async () => {
    const C = await POLICY_CHECK;
    const r = C.inspectDispatchPolicyLive(REPO);
    assert.strictEqual(r.unscanned, false, '真身没查成：' + JSON.stringify(r.problems));
    assert.strictEqual(r.ok, true, '真身越界：' + JSON.stringify(r.problems));
  });
});
