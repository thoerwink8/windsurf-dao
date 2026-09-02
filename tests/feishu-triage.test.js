// tests/feishu-triage.test.js —— 飞书适配器 块A（issue #801）
//
// 覆盖（本单职责 = 块A 适配器）：
//   · 归一化：飞书事件 → Inbound（群映射填 repo / hub 为 null / 机器人自消息与非文本跳过）
//   · 群映射表 / 凭据文件解析
//   · 话题状态持久化（~/.dao/feishu-threads.json 同款形态，可丢可重算）
//   · fixture CLI 端到端：B 缺席（空 triage 桩）跑通 + 假 core 注入验 replies/actions 管线
//   · deps.llm（补充2 契约：网关 URL / model grok-4.6 / key 文件 / 失败抛错）
//   · deps 的 gh 三件套（假 gh）
//   · 块B 缺席时 loadCore 回落到空桩
// 判重命中/未命中、三问缺一追问、两档放行、hub 卡片 的语义是块B 的职责（另一张 PR）。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'scripts', 'feishu-triage.mjs');
const EVENTS_FIXTURE = path.join(REPO, 'tests', 'fixtures', 'feishu-events.jsonl');
const GROUPS_FIXTURE = path.join(REPO, 'tests', 'fixtures', 'feishu-groups.json');
const FAKE_GH = path.join(REPO, 'tests', 'fixtures', 'fake-feishu-gh.mjs');
const MOD = import('file://' + CLI.replace(/\\/g, '/'));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-test-'));
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', cwd: REPO, env: { ...process.env, ...env }, timeout: 60000,
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
    assert.equal(done.lines, 5);
    assert.equal(done.processed, 4, '3 条群消息 + 1 条未知群（app 自消息跳过）');
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
    assert.equal(done.processed, 4);
    assert.equal(done.replies, 4, '每个 inbound 一条回执');
    assert.equal(done.actions, 4, '项目群 2 条 issue_created + hub/未知群 2 条 hub_card');

    const issueCreated = lines.filter((l) => l.type === 'action' && l.action.type === 'issue_created');
    const hubCards = lines.filter((l) => l.type === 'action' && l.action.type === 'hub_card');
    assert.equal(issueCreated.length, 2);
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
    const keyFile = path.join(dir, 'grok.key');
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
    assert.equal(body.model, 'grok-4.6', 'model 固定 grok-4.6');
    assert.equal(body.messages[0].content, 's');
    assert.ok(!body.response_format, '非 json 模式不带 response_format');

    const obj = await llm({ system: 's', user: 'u', json: true });
    assert.deepEqual(obj, { a: 1 }, 'json 模式解析对象');

    await assert.rejects(() => M.makeLlm({ gateway: '', keyPath: keyFile, fetchImpl })({ system: 's', user: 'u' }), /ANTHROPIC_BASE_URL/);
    await assert.rejects(() => M.makeLlm({ gateway: 'https://gw.example', keyPath: path.join(dir, 'no.key'), fetchImpl })({ system: 's', user: 'u' }), /grok key/);
    await assert.rejects(() => llm({ system: 's', user: 'FAIL' }), /HTTP 500/);
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
});
