// #801 块 B：飞书 triage 逻辑（判重/三问/建单/两档放行）纯函数测试。
// 规格：issue #801 消歧记录「块 B 逻辑」+「消歧记录·补充 2」。
// 覆盖：判重命中/未命中、判重列表格式、回执句式（含 #N 与落点）、三问缺一追问、
//       追问合并成单条、两档放行、hub 卡片、LLM 失败不编造、issue 正文固定段。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'feishu-triage-core.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));
const PERSONA_PATH = path.join(REPO, 'host', 'skills', 'feishu-triage', 'persona.md');

const USER_OPEN_ID = 'openid-user';
const OTHER_OPEN_ID = 'openid-customer';

function inbound(over = {}) {
  return {
    chatId: 'oc_project',
    rootId: 'om_root1',
    messageId: 'om_msg1',
    senderOpenId: USER_OPEN_ID,
    senderName: '用户',
    text: '服务器上飞书机器人加个群映射，部署完能在群里确认',
    ts: 1700000000,
    repo: 'thoerwink8/windsurf-dao',
    ...over,
  };
}

/** 按脚本顺序出 llm 结果；脚本里放 Error 实例 = 该次调用抛错。 */
function scriptedLlm(script) {
  let i = 0;
  return async () => {
    const r = script[Math.min(i, script.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return r;
  };
}

/** 三问全答的 llm ② 返回。 */
const FULL_ANSWERS = {
  answers: {
    done: { answered: true, text: '部署完在群里确认即可' },
    batch: { answered: true, text: '这批做' },
    docs: { answered: true, text: '不用记' },
  },
  questions: [],
};

function makeDeps(over = {}) {
  const calls = { search: [], create: [], comment: [], llm: [] };
  const { llm: llmOverride, llmResult, ...rest } = over;
  const llmImpl = llmOverride || (async () => llmResult);
  const deps = {
    ghSearch: async (repo, query) => {
      calls.search.push({ repo, query });
      return rest.searchResult ?? [];
    },
    ghCreateIssue: async (repo, arg) => {
      calls.create.push({ repo, arg });
      return { number: 42, url: 'https://github.com/thoerwink8/windsurf-dao/issues/42' };
    },
    ghComment: async (repo, number, body) => {
      calls.comment.push({ repo, number, body });
    },
    llm: async (arg) => {
      calls.llm.push(arg);
      return llmImpl(arg);
    },
    now: () => 1700000100,
    state: new Map(),
    allowOpenIds: [USER_OPEN_ID],
    ...rest,
  };
  return { deps, calls };
}

describe('feishu-triage-core（#801 块 B）', () => {
  it('persona.md 是 llm system 段全文，且含九条规则', async (t) => {
    const S = await LIB_LOAD;
    const persona = fs.readFileSync(PERSONA_PATH, 'utf8');
    await t.test('PERSONA 常量 === 文件全文', () => {
      assert.strictEqual(S.PERSONA, persona, 'system 段必须等于 persona.md 全文（补充 2）');
    });
    await t.test('九条规则都写进去了', () => {
      for (const marker of ['先结论后细节', '凡提到单子必带编号', '回执要说清落在哪', '状态如实、不猜', '追问一次问清', '给操作就给步骤', '不越权', '外人一致对待', '一条回复 ≤ 8 行']) {
        assert.ok(persona.includes(marker), `缺规则标记：${marker}`);
      }
    });
  });

  it('判重命中：回帖列单 + 回执句式（含 #N 与落点）+ 追评，不建单', async (t) => {
    const S = await LIB_LOAD;
    const { deps, calls } = makeDeps({
      searchResult: [
        { number: 2760, title: '飞书机器人进群', url: 'https://github.com/thoerwink8/windsurf-dao/issues/2760' },
        { number: 1436, title: '会话支持机器人', url: 'https://github.com/thoerwink8/windsurf-dao/issues/1436' },
      ],
      llm: scriptedLlm([{
        verdicts: [
          { number: 2760, verdict: '同一件事', reason: '都是加群映射' },
          { number: 1436, verdict: '相关', reason: '同一机器人' },
        ],
        summary: '要把群映射加进飞书机器人',
      }]),
    });
    const out = await S.triage(inbound(), deps);
    const reply = out.replies[0];

    await t.test('ghSearch 用 repo + 消息文本当 query', () => {
      assert.strictEqual(calls.search.length, 1);
      assert.strictEqual(calls.search[0].repo, 'thoerwink8/windsurf-dao');
      assert.strictEqual(calls.search[0].query, inbound().text);
    });
    await t.test('追评到命中的单（含来源 message_id）', () => {
      assert.strictEqual(calls.comment.length, 1);
      assert.strictEqual(calls.comment[0].number, 2760);
      assert.ok(calls.comment[0].body.includes('om_msg1'), '追评正文要带来源 message_id');
    });
    await t.test('回执句式：已在 #N 下补充了你的反馈 + 一句概括', () => {
      assert.ok(reply.text.includes('已在 #2760 下补充了你的反馈：要把群映射加进飞书机器人。'), '回执句式不对 → ' + reply.text);
    });
    await t.test('判重列表格式：#N + 标题一行一条', () => {
      assert.ok(reply.text.includes('历史相关单：'), '要有列表头 → ' + reply.text);
      assert.ok(reply.text.includes('#2760 飞书机器人进群'), '第一行格式 → ' + reply.text);
      assert.ok(reply.text.includes('#1436 会话支持机器人'), '第二行格式 → ' + reply.text);
      assert.ok(reply.text.includes('需要某一条的具体状态可以告诉我编号。'), '缺收尾句 → ' + reply.text);
    });
    await t.test('不建新单、无动作；状态进 done 并记住命中的单', () => {
      assert.strictEqual(calls.create.length, 0);
      assert.deepStrictEqual(out.actions, []);
      const st = out.state.get('om_root1');
      assert.strictEqual(st.phase, 'done');
      assert.strictEqual(st.issue.number, 2760);
      assert.strictEqual(st.issue.existing, true);
    });
  });

  it('判重未命中：不追评，进入三问', async (t) => {
    const S = await LIB_LOAD;
    const { deps, calls } = makeDeps({
      searchResult: [
        { number: 2760, title: '飞书机器人进群', url: 'u' },
        { number: 1436, title: '会话支持机器人', url: 'u2' },
      ],
      llm: scriptedLlm([
        { verdicts: [{ number: 2760, verdict: '无关' }, { number: 1436, verdict: '无关' }], summary: '新需求' },
        {
          answers: { done: { answered: false, text: '' }, batch: { answered: false, text: '' }, docs: { answered: false, text: '' } },
          questions: ['做到什么算做完？', '这批做还是以后做？', '要记进 docs/memory 吗？'],
        },
      ]),
    });
    const out = await S.triage(inbound(), deps);
    const reply = out.replies[0];

    await t.test('没追评、没建单', () => {
      assert.strictEqual(calls.comment.length, 0);
      assert.strictEqual(calls.create.length, 0);
    });
    await t.test('一轮最多追问 2 条，合并成一条消息', () => {
      assert.strictEqual(out.replies.length, 1, '追问必须合并成单条消息');
      assert.ok(reply.text.includes('还需要确认 2 件事：'), '最多 2 问 → ' + reply.text);
      assert.ok(reply.text.includes('1. 做到什么算做完？'), '第一问 → ' + reply.text);
      assert.ok(reply.text.includes('2. 这批做还是以后做？'), '第二问 → ' + reply.text);
      assert.ok(!reply.text.includes('3.'), '一轮不许问 3 条 → ' + reply.text);
    });
    await t.test('状态进 asking', () => {
      assert.strictEqual(out.state.get('om_root1').phase, 'asking');
    });
  });

  it('三问缺一追问：已答的不再问，答齐才建单', async (t) => {
    const S = await LIB_LOAD;
    const { deps, calls } = makeDeps({
      searchResult: [],
      llm: scriptedLlm([
        { verdicts: [], summary: '新需求' },
        {
          answers: {
            done: { answered: true, text: '部署完群里确认' },
            batch: { answered: false, text: '' },
            docs: { answered: true, text: '不用记' },
          },
          questions: ['这批做还是以后做？'],
        },
      ]),
    });
    const out = await S.triage(inbound(), deps);
    const reply = out.replies[0];

    await t.test('只问缺的那一问，已答的不重复问', () => {
      assert.ok(reply.text.includes('还需要确认 1 件事：'), '→ ' + reply.text);
      assert.ok(reply.text.includes('1. 这批做还是以后做？'), '→ ' + reply.text);
      assert.ok(!reply.text.includes('做到什么算做完'), '已答的不该再问 → ' + reply.text);
      assert.ok(!reply.text.includes('docs/memory'), '已答的不该再问 → ' + reply.text);
    });

    // 用户回答缺项 → 三问齐 → 建单
    const { deps: deps2, calls: calls2 } = makeDeps({
      searchResult: [],
      llm: scriptedLlm([
        { verdicts: [], summary: '新需求' },
        { ...FULL_ANSWERS, answers: { done: { answered: true, text: '部署完群里确认' }, batch: { answered: true, text: '这批做' }, docs: { answered: true, text: '不用记' } } },
        { title: '加群映射', sections: { 现象: '机器人没加新群', 复现或来源: '群里说话没反应', 期望: '加一行映射就能用' } },
      ]),
    });
    const out2 = await S.triage(inbound({ messageId: 'om_msg2', text: '这批做' }), deps2);
    await t.test('答齐 → 建单，labels 按放行档位', () => {
      assert.strictEqual(calls2.create.length, 1);
      assert.deepStrictEqual(calls2.create[0].arg.labels, ['任务', '已消歧']);
      assert.strictEqual(out2.actions[0].type, 'issue_created');
      assert.strictEqual(out2.actions[0].gate, '已消歧');
    });
    await t.test('回链接 + 单号', () => {
      const r = out2.replies[0].text;
      assert.ok(r.includes('已建单 #42'), '→ ' + r);
      assert.ok(r.includes('issues/42'), '→ ' + r);
    });
  });

  it('两档放行：名单外的人 → 待拍板 + hub 卡片；名单内 → 已消歧无卡片', async (t) => {
    const S = await LIB_LOAD;

    // 名单外
    const { deps, calls } = makeDeps({
      allowOpenIds: [USER_OPEN_ID],
      searchResult: [],
      llm: scriptedLlm([
        { verdicts: [], summary: '新需求' },
        { ...FULL_ANSWERS },
        { title: '加群映射', sections: { 现象: 'x', 复现或来源: 'y', 期望: 'z' } },
      ]),
    });
    const out = await S.triage(inbound({ senderOpenId: OTHER_OPEN_ID, senderName: '客户甲' }), deps);
    await t.test('labels = 任务 + 待拍板', () => {
      assert.deepStrictEqual(calls.create[0].arg.labels, ['任务', '待拍板']);
    });
    await t.test('actions 带 issue_created(待拍板) + hub_card', () => {
      assert.strictEqual(out.actions.length, 2);
      assert.deepStrictEqual(out.actions[0], {
        type: 'issue_created', repo: 'thoerwink8/windsurf-dao', number: 42,
        url: 'https://github.com/thoerwink8/windsurf-dao/issues/42', gate: '待拍板',
      });
      assert.deepStrictEqual(out.actions[1], {
        type: 'hub_card', repo: 'thoerwink8/windsurf-dao', number: 42,
        url: 'https://github.com/thoerwink8/windsurf-dao/issues/42',
        title: '[飞书] 加群映射', from: '客户甲',
      });
    });
    await t.test('回复注明待拍板', () => {
      assert.ok(out.replies[0].text.includes('待拍板'), '→ ' + out.replies[0].text);
    });

    // 名单内
    const { deps: deps2, calls: calls2 } = makeDeps({
      allowOpenIds: [USER_OPEN_ID],
      searchResult: [],
      llm: scriptedLlm([
        { verdicts: [], summary: '新需求' },
        { ...FULL_ANSWERS },
        { title: '加群映射', sections: { 现象: 'x', 复现或来源: 'y', 期望: 'z' } },
      ]),
    });
    const out2 = await S.triage(inbound(), deps2);
    await t.test('名单内：已消歧 + 无 hub_card', () => {
      assert.deepStrictEqual(calls2.create[0].arg.labels, ['任务', '已消歧']);
      assert.strictEqual(out2.actions.length, 1);
      assert.strictEqual(out2.actions[0].gate, '已消歧');
    });

    // 审官实证点：外人发起话题，名单内的人补答三问 → 放行仍按发起人（待拍板），不许被补答者带成已消歧
    const { deps: deps3, calls: calls3 } = makeDeps({
      allowOpenIds: [USER_OPEN_ID],
      searchResult: [],
      llm: scriptedLlm([
        { verdicts: [], summary: '新需求' },
        { answers: { done: { answered: false, text: '' }, batch: { answered: false, text: '' }, docs: { answered: false, text: '' } }, questions: ['这批做还是以后做？'] },
        { ...FULL_ANSWERS },
        { title: '加群映射', sections: { 现象: 'x', 复现或来源: 'y', 期望: 'z' } },
      ]),
    });
    const out3a = await S.triage(inbound({ senderOpenId: OTHER_OPEN_ID, senderName: '客户甲' }), deps3);
    assert.strictEqual(out3a.state.get('om_root1').phase, 'asking', '外人发起 → 先追问');
    deps3.state = out3a.state;
    const out3b = await S.triage(inbound({ messageId: 'om_msg2', senderOpenId: USER_OPEN_ID, senderName: '用户', text: '这批做' }), deps3);
    await t.test('外人发起 + 名单内补答：仍待拍板 + hub_card（放行按发起人）', () => {
      assert.deepStrictEqual(calls3.create[0].arg.labels, ['任务', '待拍板']);
      assert.strictEqual(out3b.actions.length, 2);
      assert.strictEqual(out3b.actions[0].gate, '待拍板');
      assert.strictEqual(out3b.actions[1].type, 'hub_card');
      assert.strictEqual(out3b.actions[1].from, '客户甲', '卡片署名发起人，不是补答者');
    });
  });

  it('issue 正文固定段：现象/复现或来源/期望/三问答案/来源消息，不贴聊天全文', async (t) => {
    const S = await LIB_LOAD;
    const { deps, calls } = makeDeps({
      searchResult: [],
      llm: scriptedLlm([
        { verdicts: [], summary: '新需求' },
        { ...FULL_ANSWERS },
        { title: '加群映射', sections: { 现象: '机器人没加新群', 复现或来源: '群里说话没反应', 期望: '加一行映射就能用' } },
      ]),
    });
    await S.triage(inbound(), deps);
    const body = calls.create[0].arg.body;
    const title = calls.create[0].arg.title;

    await t.test('标题 [飞书] + 动宾短语', () => {
      assert.strictEqual(title, '[飞书] 加群映射');
    });
    await t.test('五段齐全', () => {
      for (const seg of ['## 现象', '## 复现或来源', '## 期望', '## 三问答案', '## 来源消息']) {
        assert.ok(body.includes(seg), `缺 ${seg} → ${body}`);
      }
    });
    await t.test('三问答案带原文', () => {
      assert.ok(body.includes('- 做到什么算做完：部署完在群里确认即可'), '→ ' + body);
      assert.ok(body.includes('- 这批做还是以后：这批做'), '→ ' + body);
      assert.ok(body.includes('- 是否 docs/memory 该记：不用记'), '→ ' + body);
    });
    await t.test('来源消息 = chat_id + message_id，不贴聊天全文', () => {
      assert.ok(body.includes('- chat_id：oc_project'), '→ ' + body);
      assert.ok(body.includes('- message_id：om_msg1'), '→ ' + body);
      assert.ok(!body.includes(inbound().text), '正文不许贴聊天原文 → ' + body);
    });
  });

  it('LLM 失败：回「稍后重试」不编造，不建单不追评，状态不动', async (t) => {
    const S = await LIB_LOAD;
    const boom = new Error('网关挂了');

    await t.test('判重阶段 llm 抛错', async () => {
      const { deps, calls } = makeDeps({ llm: scriptedLlm([boom]) });
      const out = await S.triage(inbound(), deps);
      assert.strictEqual(out.replies[0].text, '机器人暂时没法判断，稍后重试。');
      assert.deepStrictEqual(out.actions, []);
      assert.strictEqual(calls.create.length, 0);
      assert.strictEqual(calls.comment.length, 0);
      assert.strictEqual(out.state.has('om_root1'), false, '失败不留状态，下条消息重试');
    });

    await t.test('三问阶段 llm 抛错', async () => {
      const { deps, calls } = makeDeps({
        searchResult: [],
        llm: scriptedLlm([{ verdicts: [], summary: '新需求' }, boom]),
      });
      const out = await S.triage(inbound(), deps);
      assert.strictEqual(out.replies[0].text, '机器人暂时没法判断，稍后重试。');
      assert.strictEqual(calls.create.length, 0, '不许建单');
    });

    await t.test('渲染阶段 llm 返回空标题（不编造）', async () => {
      const { deps, calls } = makeDeps({
        searchResult: [],
        llm: scriptedLlm([{ verdicts: [], summary: '新需求' }, { ...FULL_ANSWERS }, { title: '', sections: {} }]),
      });
      const out = await S.triage(inbound(), deps);
      assert.strictEqual(out.replies[0].text, '机器人暂时没法判断，稍后重试。');
      assert.strictEqual(calls.create.length, 0);
    });

    await t.test('llm 返回乱字符串（非 JSON）也走兜底', async () => {
      const { deps, calls } = makeDeps({ llm: scriptedLlm(['不是JSON']) });
      const out = await S.triage(inbound(), deps);
      assert.strictEqual(out.replies[0].text, '机器人暂时没法判断，稍后重试。');
      assert.strictEqual(calls.create.length, 0);
    });

    await t.test('已有话题：失败不得污染入参 state（#801 审官实证点）', async () => {
      // 第一跳：判重未命中 → asking，状态落在 deps.state 里。
      const { deps, calls } = makeDeps({
        searchResult: [],
        llm: scriptedLlm([
          { verdicts: [], summary: '新需求' },
          { answers: { done: { answered: false, text: '' }, batch: { answered: false, text: '' }, docs: { answered: false, text: '' } }, questions: ['做到什么算做完？'] },
          boom,
        ]),
      });
      const out1 = await S.triage(inbound(), deps);
      assert.strictEqual(out1.state.get('om_root1').msgs.length, 1);
      deps.state = out1.state;
      const snapshot = JSON.stringify([...out1.state.entries()]);

      // 第二跳：同话题新消息，三问 llm 抛错 → 兜底回复，且入参 state 原样（不许带回滚外的痕迹）。
      const out2 = await S.triage(inbound({ messageId: 'om_msg2', text: '这批做' }), deps);
      assert.strictEqual(out2.replies[0].text, '机器人暂时没法判断，稍后重试。');
      assert.strictEqual(calls.create.length, 0);
      assert.strictEqual(JSON.stringify([...out2.state.entries()]), snapshot, '失败后 state 必须与失败前逐字节一致（消息没追加、时间戳没动）');
    });
  });

  it('判重候选只取前 10 条（消歧记录「前 10 条」）', async (t) => {
    const S = await LIB_LOAD;
    const many = Array.from({ length: 13 }, (_, i) => ({
      number: 100 + i, title: `候选 ${i}`, url: `u${i}`,
    }));
    const { deps, calls } = makeDeps({
      searchResult: many,
      llm: scriptedLlm([{
        verdicts: many.slice(0, 10).map(c => ({ number: c.number, verdict: '无关' })),
        summary: '新需求',
      }]),
    });
    await S.triage(inbound(), deps);
    await t.test('llm 只看到前 10 条（prompt 不含第 11+ 条）', () => {
      assert.ok(calls.llm.length >= 1, 'llm 至少被调一次');
      const user = calls.llm[0].user;
      assert.ok(user.includes('#100 候选 0'), '第 1 条要在 → ' + user.slice(0, 200));
      assert.ok(user.includes('#109 候选 9'), '第 10 条要在 → ' + user.slice(0, 300));
      assert.ok(!user.includes('#110'), '第 11 条不许进 prompt → ' + user.slice(0, 400));
      assert.ok(!user.includes('候选 12'), '第 13 条不许进 prompt');
    });
  });

  it('hub 群（repo=null）：不建单不判重，只指路', async (t) => {
    const S = await LIB_LOAD;
    const { deps, calls } = makeDeps({ searchResult: [{ number: 1, title: 'x', url: 'u' }] });
    const out = await S.triage(inbound({ repo: null, chatId: 'oc_hub' }), deps);
    await t.test('指路回复', () => {
      assert.strictEqual(out.replies[0].text, '这里是总控群，需求请发到项目群。');
    });
    await t.test('不碰任何 gh/llm，不留状态', () => {
      assert.strictEqual(calls.search.length, 0);
      assert.strictEqual(calls.llm.length, 0);
      assert.strictEqual(calls.create.length, 0);
      assert.strictEqual(out.state.size, 0);
    });
  });

  it('done 后同话题新消息：追评到已建单 + 回执', async (t) => {
    const S = await LIB_LOAD;
    const { deps, calls } = makeDeps({
      searchResult: [],
      llm: scriptedLlm([
        { verdicts: [], summary: '新需求' },
        { ...FULL_ANSWERS },
        { title: '加群映射', sections: { 现象: 'x', 复现或来源: 'y', 期望: 'z' } },
      ]),
    });
    const out1 = await S.triage(inbound(), deps);
    // 块 A 会把返回的 state 持久化并回填 deps.state；这里模拟同一话题的下一条消息。
    deps.state = out1.state;
    const out2 = await S.triage(inbound({ messageId: 'om_msg3', text: '补充一下：还要支持新群名' }), deps);

    await t.test('追评到已建单 #42', () => {
      assert.strictEqual(calls.comment.length, 1);
      assert.strictEqual(calls.comment[0].number, 42);
      assert.ok(calls.comment[0].body.includes('om_msg3'));
    });
    await t.test('回执句式带 #N 与落点', () => {
      assert.ok(out2.replies[0].text.includes('已在 #42 下补充了你的反馈：补充一下：还要支持新群名。'), '→ ' + out2.replies[0].text);
    });
    await t.test('状态保持 done，不重复建单', () => {
      assert.strictEqual(out1.state.get('om_root1').phase, 'done');
      assert.strictEqual(calls.create.length, 1);
    });
  });

  it('state 是 Map：跨消息累积答案，不污染入参', async (t) => {
    const S = await LIB_LOAD;
    const { deps } = makeDeps({
      searchResult: [],
      llm: scriptedLlm([
        { verdicts: [], summary: '新需求' },
        { answers: { done: { answered: false, text: '' }, batch: { answered: false, text: '' }, docs: { answered: false, text: '' } }, questions: ['做到什么算做完？', '这批做还是以后做？'] },
      ]),
    });
    const before = deps.state;
    const out = await S.triage(inbound(), deps);
    await t.test('返回新 Map，入参 Map 不被改', () => {
      assert.notStrictEqual(out.state, before);
      assert.strictEqual(before.size, 0);
      assert.strictEqual(out.state.size, 1);
      const st = out.state.get('om_root1');
      assert.strictEqual(st.msgs.length, 1);
      assert.strictEqual(st.phase, 'asking');
    });
  });
});
