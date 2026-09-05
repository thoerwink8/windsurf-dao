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
      assert.ok(body.includes('- 做到什么样算做完：部署完在群里确认即可'), '→ ' + body);
      assert.ok(body.includes('- 现在做还是先记着：这批做'), '→ ' + body);
      assert.ok(body.includes('- 要不要写进文档：不用记'), '→ ' + body);
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

// ─────────────────────────────────────────────────────────────────────────────
// 以下为块A（PR #806）适配器测试：归一化 / 群映射 / 凭据 / 状态持久化 /
// fixture CLI 端到端 / llm 契约 / gh deps / hub 卡片。
// ─────────────────────────────────────────────────────────────────────────────
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_A = path.resolve(__dirname, '..');
const CLI = path.join(REPO_A, 'scripts', 'feishu-triage.mjs');
const EVENTS_FIXTURE = path.join(REPO_A, 'tests', 'fixtures', 'feishu-events.jsonl');
const GROUPS_FIXTURE = path.join(REPO_A, 'tests', 'fixtures', 'feishu-groups.json');
const FAKE_GH = path.join(REPO_A, 'tests', 'fixtures', 'fake-feishu-gh.mjs');
const MOD = import('file://' + CLI.replace(/\\/g, '/'));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-test-'));
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', cwd: REPO_A, env: { ...process.env, ...env }, timeout: 60000,
  });
}

function parseLines(stdout) {
  return String(stdout || '').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

describe('#801 块A 飞书适配器', () => {
  it('normalizeInbound：文本消息 → Inbound，群映射填 repo', async () => {
    const M = await MOD;
    const groups = M.loadGroups(GROUPS_FIXTURE);
    const event = {
      event: {
        sender: { sender_id: { open_id: 'ou_user1' }, sender_type: 'user', sender_name: '小明' },
        message: {
          message_id: 'om_1', chat_id: 'oc_windsurf_dao', chat_type: 'group',
          message_type: 'text', content: '{"text":" 帮我看看 802 单 "}', create_time: '1725000000000',
        },
      },
    };
    const inbound = M.normalizeInbound(event, groups);
    assert.ok(inbound, '应归一化成功');
    assert.equal(inbound.chatId, 'oc_windsurf_dao');
    assert.equal(inbound.messageId, 'om_1');
    assert.equal(inbound.rootId, 'om_1', '非回复消息：话题根 = 自己');
    assert.equal(inbound.senderOpenId, 'ou_user1');
    assert.equal(inbound.senderName, '小明');
    assert.equal(inbound.text, '帮我看看 802 单');
    assert.equal(inbound.ts, 1725000000000);
    assert.equal(inbound.repo, 'thoerwink8/windsurf-dao');
  });

  it('normalizeInbound：回复消息 rootId = root_id；hub 群 repo = null', async () => {
    const M = await MOD;
    const groups = M.loadGroups(GROUPS_FIXTURE);
    const reply = {
      event: {
        sender: { sender_id: { open_id: 'ou_user2' }, sender_type: 'user' },
        message: {
          message_id: 'om_2', root_id: 'om_1', parent_id: 'om_1', chat_id: 'oc_windsurf_dao',
          message_type: 'text', content: '{"text":"补充"}', create_time: '1725000001000',
        },
      },
    };
    assert.equal(M.normalizeInbound(reply, groups).rootId, 'om_1');

    const hub = {
      event: {
        sender: { sender_id: { open_id: 'ou_user1' }, sender_type: 'user' },
        message: { message_id: 'om_3', chat_id: 'oc_hub', message_type: 'text', content: '{"text":"总控群消息"}', create_time: '1725000002000' },
      },
    };
    const hubIn = M.normalizeInbound(hub, groups);
    assert.equal(hubIn.repo, null, 'hub 群 repo 为 null');
    assert.equal(hubIn.chatId, 'oc_hub');

    const unknown = { ...hub, event: { ...hub.event, message: { ...hub.event.message, chat_id: 'oc_unknown_chat' } } };
    assert.equal(M.normalizeInbound(unknown, groups).repo, null, '未映射群 repo 为 null');
  });

  it('normalizeInbound：机器人自消息 / 非文本 / 空文本 / 缺字段 → null', async () => {
    const M = await MOD;
    const groups = M.loadGroups(GROUPS_FIXTURE);
    const base = {
      event: {
        sender: { sender_id: { open_id: 'ou_x' }, sender_type: 'user' },
        message: { message_id: 'om_x', chat_id: 'oc_windsurf_dao', message_type: 'text', content: '{"text":"hi"}', create_time: '1' },
      },
    };
    assert.equal(M.normalizeInbound({ ...base, event: { ...base.event, sender: { sender_id: { open_id: 'ou_bot' }, sender_type: 'app' } } }, groups), null, 'app 自消息跳过');
    assert.equal(M.normalizeInbound({ ...base, event: { ...base.event, message: { ...base.event.message, message_type: 'image', content: '{"image_key":"x"}' } } }, groups), null, '非文本跳过');
    assert.equal(M.normalizeInbound({ ...base, event: { ...base.event, message: { ...base.event.message, content: '{"text":"   "}' } } }, groups), null, '空文本跳过');
    assert.equal(M.normalizeInbound({ ...base, event: { ...base.event, message: { ...base.event.message, chat_id: '' } } }, groups), null, '缺 chat_id 跳过');
    assert.equal(M.normalizeInbound(null, groups), null);
    assert.equal(M.normalizeInbound({}, groups), null);
  });

  it('loadGroups：_ 注释键跳过；坏 kind / project 缺 repo 报错', async () => {
    const M = await MOD;
    const dir = tmpdir();
    const file = path.join(dir, 'groups.json');
    fs.writeFileSync(file, JSON.stringify({
      _comment: '说明',
      oc_a: { repo: 'thoerwink8/a', kind: 'project' },
      oc_hub: { kind: 'hub' },
    }));
    const g = M.loadGroups(file);
    assert.deepEqual(Object.keys(g).sort(), ['oc_a', 'oc_hub']);
    assert.equal(g.oc_a.repo, 'thoerwink8/a');

    fs.writeFileSync(file, JSON.stringify({ oc_b: { kind: 'weird' } }));
    assert.throws(() => M.loadGroups(file), /kind/);
    fs.writeFileSync(file, JSON.stringify({ oc_c: { kind: 'project' } }));
    assert.throws(() => M.loadGroups(file), /repo/);
    fs.writeFileSync(file, 'not json');
    assert.throws(() => M.loadGroups(file), /读不了/);
  });

  it('loadCredentials：字段校验', async () => {
    const M = await MOD;
    const dir = tmpdir();
    const file = path.join(dir, 'feishu-app.json');
    fs.writeFileSync(file, JSON.stringify({
      appId: 'cli_test', appSecret: 'secret_test', hubChatId: 'oc_hub_real',
      allowOpenIds: ['ou_user1'],
    }));
    const c = M.loadCredentials(file);
    assert.equal(c.appId, 'cli_test');
    assert.equal(c.appSecret, 'secret_test');
    assert.equal(c.hubChatId, 'oc_hub_real');
    assert.deepEqual(c.allowOpenIds, ['ou_user1']);

    fs.writeFileSync(file, JSON.stringify({ appId: 'x' }));
    assert.throws(() => M.loadCredentials(file), /appSecret/);
    fs.writeFileSync(file, 'bad');
    assert.throws(() => M.loadCredentials(file), /读不了/);
  });

  it('createStateStore：落盘 / 重载 / 坏文件从空开始', async () => {
    const M = await MOD;
    const dir = tmpdir();
    const file = path.join(dir, 'feishu-threads.json');
    const store = M.createStateStore(file);
    store.map.set('om_root', { seen: 1 });
    store.save();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.threads.om_root.seen, 1);

    const again = M.createStateStore(file);
    assert.equal(again.map.get('om_root').seen, 1, '重载回话题状态');

    fs.writeFileSync(file, '{broken');
    const empty = M.createStateStore(file);
    assert.equal(empty.map.size, 0, '坏状态文件 → 空 Map（可丢可重算）');
  });

  it('loadCore：块B 缺席 → 空 triage 桩（fixture 跑通的前提）', async () => {
    const M = await MOD;
    const core = await M.loadCore();
    assert.equal(typeof core.triage, 'function');
    if (core.source === 'stub') {
      // B 未落地（本 PR 当前状态）：空桩必须返回空 replies/actions
      const out = await core.triage({ rootId: 'r' }, { state: new Map() });
      assert.deepEqual(out.replies, []);
      assert.deepEqual(out.actions, []);
      assert.ok(out.state instanceof Map);
    }
    // B 落地后本断言自然失效（source=core），由块B 的测试接管语义覆盖
  });

  it('fixture CLI 端到端：B 缺席空桩跑通，事件计数正确', async () => {
    const dir = tmpdir();
    const stateFile = path.join(dir, 'state.json');
    // 显式注入空桩，钉死「B 缺席也能跑通」——B 落地后本测试不受影响
    const stubCore = path.join(dir, 'stub-core.mjs');
    fs.writeFileSync(stubCore, 'export async function triage(inbound, deps) { return { replies: [], actions: [], state: deps.state }; }\n');
    const r = runCli(['--fixture', EVENTS_FIXTURE, '--groups', GROUPS_FIXTURE, '--state', stateFile], { FEISHU_CORE_MODULE: stubCore });
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
    const lines = parseLines(r.stdout);
    const types = lines.map((l) => l.type);
    assert.ok(types.includes('inbound'), '有 inbound 记录');
    const done = lines.find((l) => l.type === 'done');
    assert.ok(done, '有 done 记录');
    assert.equal(done.lines, 7);
    assert.equal(done.processed, 6, '5 条群消息（含扁平 SDK 样本）+ 1 条未知群（app 自消息跳过）');
    assert.equal(done.skipped, 1, '机器人自消息跳过');
    assert.equal(done.replies, 0, '空桩无回执');
    assert.equal(done.actions, 0, '空桩无动作');
    assert.ok(fs.existsSync(stateFile), '状态落盘');
  });

  it('fixture CLI 端到端：假 core 注入 → replies/actions 管线全通 + 状态累计', async () => {
    const M = await MOD;
    const dir = tmpdir();
    const coreFile = path.join(dir, 'fake-core.mjs');
    const stateFile = path.join(dir, 'state.json');
    fs.writeFileSync(coreFile, `
export async function triage(inbound, deps) {
  const prev = deps.state.get(inbound.rootId) || { seen: 0 };
  deps.state.set(inbound.rootId, { seen: prev.seen + 1, last: inbound.text });
  return {
    replies: [{ rootId: inbound.rootId, text: '已收到：' + inbound.text }],
    actions: inbound.repo
      ? [{ type: 'issue_created', repo: inbound.repo, number: 9001, url: 'https://x/9001', gate: '已消歧' }]
      : [{ type: 'hub_card', repo: null, number: 9002, url: 'https://x/9002', title: inbound.text, from: inbound.senderName }],
    state: deps.state,
  };
}
`);
    const r = runCli(['--fixture', EVENTS_FIXTURE, '--groups', GROUPS_FIXTURE, '--state', stateFile], { FEISHU_CORE_MODULE: coreFile });
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
    const lines = parseLines(r.stdout);
    const done = lines.find((l) => l.type === 'done');
    assert.equal(done.processed, 6);
    assert.equal(done.replies, 6, '每个 inbound 一条回执');
    assert.equal(done.actions, 6, '项目群 4 条 issue_created + hub/未知群 2 条 hub_card');

    const issueCreated = lines.filter((l) => l.type === 'action' && l.action.type === 'issue_created');
    const hubCards = lines.filter((l) => l.type === 'action' && l.action.type === 'hub_card');
    assert.equal(issueCreated.length, 4);
    assert.equal(hubCards.length, 2);

    const replies = lines.filter((l) => l.type === 'reply');
    assert.ok(replies.every((l) => l.rootId && l.text.startsWith('已收到：')), '回执带 rootId 与文本');

    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(persisted.threads.om_1.seen, 2, 'om_1 话题累计两条（首条 + 回复）');
    assert.equal(persisted.threads.om_3.seen, 1);
  });

  it('CLI：--help 退出 0；坏参数 / fixture 文件不存在退出 1', async () => {
    const h = runCli(['--help']);
    assert.equal(h.status, 0);
    assert.match(h.stdout, /--fixture/);
    const bad = runCli(['--nope']);
    assert.equal(bad.status, 1);
    const missing = runCli(['--fixture', path.join(tmpdir(), 'nope.jsonl'), '--groups', GROUPS_FIXTURE]);
    assert.equal(missing.status, 1);
  });

  it('deps.llm（补充2）：网关契约 / model / key 文件 / 失败抛错', async () => {
    const M = await MOD;
    const dir = tmpdir();
    const keyFile = path.join(dir, 'feishu-triage.key');
    fs.writeFileSync(keyFile, 'k123\n');
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (String(init?.body || '').includes('FAIL')) return { ok: false, status: 500 };
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: '{"a":1}' } }] }),
      };
    };
    const llm = M.makeLlm({ gateway: 'https://gw.example', keyPath: keyFile, fetchImpl });

    const text = await llm({ system: 's', user: 'u' });
    assert.equal(text, '{"a":1}', '非 json 模式原样返回文本');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://gw.example/v1/chat/completions', '网关 + /v1/chat/completions');
    assert.equal(calls[0].init.headers.authorization, 'Bearer k123', 'key 文件内容作 Bearer');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, 'grok-4.6', 'model 默认 grok-4.6（白名单内）');
    assert.equal(body.stream, true, '一律流式（2026-09-04：非流式 60s 必超时）');
    assert.equal(body.messages[0].content, 's');
    assert.ok(!body.response_format, '非 json 模式不带 response_format');

    const obj = await llm({ system: 's', user: 'u', json: true });
    assert.deepEqual(obj, { a: 1 }, 'json 模式解析对象');

    await assert.rejects(() => M.makeLlm({ gateway: '', keyPath: keyFile, fetchImpl })({ system: 's', user: 'u' }), /ANTHROPIC_BASE_URL/);
    await assert.rejects(() => M.makeLlm({ gateway: 'https://gw.example', keyPath: path.join(dir, 'no.key'), fetchImpl })({ system: 's', user: 'u' }), /feishu-triage key/);
    await assert.rejects(() => llm({ system: 's', user: 'FAIL' }), /HTTP 500/);
  });

  it('#823 伪 fetch 断言 X-Dao 三头齐', async () => {
    const M = await MOD;
    const dir = tmpdir();
    const keyFile = path.join(dir, 'feishu-triage.key');
    fs.writeFileSync(keyFile, 'k123\n');
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      };
    };
    const llm = M.makeLlm({ gateway: 'https://gw.example', keyPath: keyFile, fetchImpl });
    await llm({
      system: 's',
      user: 'u',
      daoActor: 'feishu-triage',
      daoTask: 'thoerwink8/windsurf-dao#823',
      daoRun: 'oc_chat_1',
    });
    assert.equal(calls.length, 1);
    const h = calls[0].init.headers;
    assert.equal(h['X-Dao-Actor'], 'feishu-triage', 'X-Dao-Actor');
    assert.equal(h['X-Dao-Task'], 'thoerwink8/windsurf-dao#823', 'X-Dao-Task');
    assert.equal(h['X-Dao-Run'], 'oc_chat_1', 'X-Dao-Run');

    const defaults = M.daoTraceHeaders({ repo: 'thoerwink8/windsurf-dao', chatId: 'oc_x' });
    assert.equal(defaults['X-Dao-Task'], 'thoerwink8/windsurf-dao#triage', '未建单落 repo#triage');
    const withIssue = M.daoTraceHeaders({ repo: 'thoerwink8/windsurf-dao', issueNumber: 42, chatId: 'oc_x' });
    assert.equal(withIssue['X-Dao-Task'], 'thoerwink8/windsurf-dao#42', '已建单带号');
  });

  it('deps 的 gh 三件套：搜索 / 建单 / 追评（假 gh）', async () => {
    const M = await MOD;
    const nodeRun = (bin, args, opts) => M.runGh(process.execPath, [bin, ...args], opts);
    const deps = M.makeGhDeps({ ghBin: FAKE_GH, run: nodeRun });

    const hits = await deps.ghSearch('thoerwink8/windsurf-dao', '会话');
    assert.equal(hits.length, 2);
    assert.equal(hits[0].number, 1436);
    assert.equal(hits[0].title, '会话支持');
    assert.match(hits[0].url, /issues\/1436/);

    const created = await deps.ghCreateIssue('thoerwink8/windsurf-dao', {
      title: '[飞书] 测试单', body: '现象\n期望', labels: ['任务', '已消歧'],
    });
    assert.equal(created.number, 9001);

    const ok = await deps.ghComment('thoerwink8/windsurf-dao', 9001, '已在 #9001 下补充');
    assert.equal(ok, true);

    await assert.rejects(() => deps.ghSearch('thoerwink8/windsurf-dao', 'FAIL'), /gh search 失败/);
    await assert.rejects(() => deps.ghCreateIssue('thoerwink8/fail-repo', { title: 'x', body: 'y' }), /issue create 失败/);
  });

  it('buildDeps：allowOpenIds 来自凭据，state 是 Map', async () => {
    const M = await MOD;
    const store = M.createStateStore(path.join(tmpdir(), 's.json'));
    const deps = M.buildDeps({
      creds: { allowOpenIds: ['ou_user1'], hubChatId: 'oc_hub' },
      store,
      gateway: 'https://gw.example',
    });
    assert.deepEqual(deps.allowOpenIds, ['ou_user1']);
    assert.ok(deps.state instanceof Map);
    assert.equal(typeof deps.now, 'function');
    assert.equal(typeof deps.ghSearch, 'function');
    assert.equal(typeof deps.ghCreateIssue, 'function');
    assert.equal(typeof deps.ghComment, 'function');
    assert.equal(typeof deps.llm, 'function');
  });

  it('buildHubCard：待拍板卡片结构', async () => {
    const M = await MOD;
    const card = M.buildHubCard({ repo: 'thoerwink8/a', number: 42, url: 'https://x/42', title: '单子', from: '小明' });
    assert.equal(card.header.title.content, '待拍板：thoerwink8/a#42');
    assert.equal(card.header.template, 'orange');
    assert.match(card.elements[0].text.content, /小明/);
    assert.equal(card.elements[1].actions[0].url, 'https://x/42');
  });

  // —— 返工轮契约测试（审官红①+红②、帅实况 1/2/5）——

  it('normalizeInbound：扁平 SDK 事件样本（WSClient 长连接推的就是这个形）', async () => {
    const M = await MOD;
    const groups = M.loadGroups(GROUPS_FIXTURE);
    // 真 SDK：WSClient → EventDispatcher 注册的 handler 收到的是扁平数据（无 {event:{...}} 壳）
    const flat = {
      schema: '2.0',
      event_type: 'im.message.receive_v1',
      sender: { sender_id: { open_id: 'ou_flat' }, sender_type: 'user' },
      message: {
        message_id: 'om_flat_1', chat_id: 'oc_windsurf_dao', chat_type: 'group',
        message_type: 'text', content: '{"text":"扁平事件"}', create_time: '1725000005000',
      },
    };
    const inbound = M.normalizeInbound(flat, groups);
    assert.ok(inbound, '扁平结构必须归一化成功（实咬：只认 webhook 壳时长连接事件全被静默丢弃）');
    assert.equal(inbound.chatId, 'oc_windsurf_dao');
    assert.equal(inbound.rootId, 'om_flat_1');
    assert.equal(inbound.text, '扁平事件');
    assert.equal(inbound.repo, 'thoerwink8/windsurf-dao');
  });

  it('normalizeInbound：@_user_N 占位符剥掉，多空格归一', async () => {
    const M = await MOD;
    const groups = M.loadGroups(GROUPS_FIXTURE);
    const flat = {
      schema: '2.0', event_type: 'im.message.receive_v1',
      sender: { sender_id: { open_id: 'ou_at' }, sender_type: 'user' },
      message: {
        message_id: 'om_at_1', chat_id: 'oc_windsurf_dao', chat_type: 'group',
        message_type: 'text', content: '{"text":"@_user_1 @_user_2  帮我看看 802 单"}', create_time: '1725000006000',
      },
    };
    const inbound = M.normalizeInbound(flat, groups);
    assert.equal(inbound.text, '帮我看看 802 单', '@_user_N 占位符剥掉、多空格归一');
  });

  it('ghCreateIssue 契约：不带 --json，stdout URL 取号；假 gh 遇未知参数失败', async () => {
    const M = await MOD;
    const nodeRun = (bin, args, opts) => M.runGh(process.execPath, [bin, ...args], opts);
    const deps = M.makeGhDeps({ ghBin: FAKE_GH, run: nodeRun });

    const created = await deps.ghCreateIssue('thoerwink8/windsurf-dao', { title: 't', body: 'b', labels: ['任务'] });
    assert.equal(created.number, 9001);
    assert.equal(created.url, 'https://github.com/thoerwink8/windsurf-dao/issues/9001');

    // 判别性：真 gh issue create 收到 --json 报 unknown flag，假 gh 必须同样失败（审官红①）
    const withJson = M.runGh(process.execPath, [FAKE_GH, 'issue', 'create', '--repo', 'thoerwink8/x', '--title', 't', '--body', 'b', '--json', 'number,url']);
    assert.equal(withJson.ok, false, '假 gh 必须拦下 --json');
    assert.match(withJson.stderr, /--json/);
    assert.equal(withJson.code, 2);
  });

  it('aliases 归根：机器人回复消息 id 映射回原话题根，随状态落盘', async () => {
    const M = await MOD;
    const dir = tmpdir();
    const stateFile = path.join(dir, 'state.json');
    const store = M.createStateStore(stateFile);

    // 机器人回了一条，飞书网页端另开话题：root_id 变成机器人消息 id om_bot_1
    store.aliases.om_bot_1 = 'om_root_orig';
    assert.equal(store.canonicalRoot('om_bot_1'), 'om_root_orig', '别名归到原根');
    assert.equal(store.canonicalRoot('om_bot_1', 'om_x'), 'om_root_orig', '多个候选优先走别名');
    assert.equal(store.canonicalRoot('om_unknown'), 'om_unknown', '无别名原样返回');
    assert.equal(store.canonicalRoot('', 'om_y'), 'om_y', '空 id 跳过');
    // 环保护：a→b→a 最多 5 跳不死循环
    store.aliases.om_a = 'om_b';
    store.aliases.om_b = 'om_a';
    assert.equal(typeof store.canonicalRoot('om_a'), 'string');
    store.save();

    // 落盘后重载，别名还在（网页端追答跨重启仍能归根）
    const again = M.createStateStore(stateFile);
    assert.equal(again.aliases.om_bot_1, 'om_root_orig');
    assert.equal(again.canonicalRoot('om_bot_1'), 'om_root_orig');
  });

  it('handleEvent：别名归根端到端（预置别名，网页端另开话题的追答归回原根）', async () => {
    const M = await MOD;
    const dir = tmpdir();
    const stateFile = path.join(dir, 'state.json');
    const coreFile = path.join(dir, 'alias-core.mjs');
    fs.writeFileSync(coreFile, `
export async function triage(inbound, deps) {
  deps.state.set(inbound.rootId, { seen: (deps.state.get(inbound.rootId)?.seen || 0) + 1 });
  return { replies: [{ rootId: inbound.rootId, text: '收到' }], actions: [], state: deps.state };
}
`);
    // 预置别名：机器人回过的消息 om_bot_reply_1 → 原话题根 om_1（帅实况 5：网页端对机器人那条
    // 「回复」会另开话题，root_id 变成机器人消息 id，不归回原根就把追答当新需求重问）
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, threads: {}, aliases: { om_bot_reply_1: 'om_1' } }));
    const r = runCli(['--fixture', EVENTS_FIXTURE, '--groups', GROUPS_FIXTURE, '--state', stateFile], { FEISHU_CORE_MODULE: coreFile });
    assert.equal(r.status, 0, r.stderr);

    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // 事件 1（om_1）+ 事件 2（root=om_1）+ 事件 7（root=om_bot_reply_1 → 别名归 om_1）= 3
    assert.equal(persisted.threads.om_1.seen, 3, '追答经别名归回原根，om_1 累计 3 条');
    assert.equal(persisted.threads.om_bot_reply_1, undefined, '不产生孤儿新话题');
    assert.equal(persisted.aliases.om_bot_reply_1, 'om_1', '别名随状态落盘');
  });
});

describe('llm 流式（2026-09-04：非流式 + 60s 在 grok 排队时必超时，同「探针一律流式」教训）', () => {
  it('SSE 累积成整段文本；心跳/[DONE]/半截 JSON 都不炸', async () => {
    const M = await MOD;
    const { readSseText } = M;
    const chunks = [
      'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"delta":{"content":"，'.concat('世界"}}]}\n\n'),
      ': heartbeat\n\ndata: {"cho',           // 半截，下一块拼齐
      'ices":[{"delta":{"content":"！"}}]}\n\ndata: [DONE]\n\n',
    ];
    const enc = new TextEncoder();
    let i = 0;
    const body = { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }) }) };
    assert.equal(await readSseText(body), '你好，世界！');
  });

  it('makeLlm 走流式响应；json 模式仍解析对象', async () => {
    const M = await MOD;
    const dir = tmpdir();
    const keyFile = path.join(dir, 'feishu-triage-stream.key');
    fs.writeFileSync(keyFile, 'k9\n');
    const enc = new TextEncoder();
    const sse = (text) => {
      const parts = [`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`, 'data: [DONE]\n\n'];
      let i = 0;
      return { getReader: () => ({ read: async () => (i < parts.length ? { done: false, value: enc.encode(parts[i++]) } : { done: true }) }) };
    };
    const fetchImpl = async () => ({ ok: true, status: 200, body: sse('{"intent":"situation"}') });
    const llm = M.makeLlm({ gateway: 'https://gw.example', keyPath: keyFile, fetchImpl });
    assert.equal(await llm({ system: 's', user: 'u' }), '{"intent":"situation"}');
    assert.deepEqual(await llm({ system: 's', user: 'u', json: true }), { intent: 'situation' });
  });

  it('超时预算：默认 180s 是从模块读回来的真值，不是「有个信号量」就算过', async () => {
    const M = await MOD;
    assert.equal(M.LLM_TIMEOUT_MS, 180000, '默认预算必须是 180s——改小了这条要红（60s 曾把盘面问答全切断）');
    const dir = tmpdir();
    const keyFile = path.join(dir, 'feishu-triage-timeout.key');
    fs.writeFileSync(keyFile, 'k9\n');
    let seenSignal = null;
    const enc = new TextEncoder();
    const sse = () => { const parts = [`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}

`]; let i = 0; return { getReader: () => ({ read: async () => (i < parts.length ? { done: false, value: enc.encode(parts[i++]) } : { done: true }) }) }; };
    const fetchImpl = async (_u, init) => { seenSignal = init.signal; return { ok: true, status: 200, body: sse() }; };
    await M.makeLlm({ gateway: 'https://gw.example', keyPath: keyFile, fetchImpl, timeoutMs: 1234 })({ system: 's', user: 'u' });
    assert.ok(seenSignal && typeof seenSignal.aborted === 'boolean', '流式路径也带 AbortSignal');
  });
});
