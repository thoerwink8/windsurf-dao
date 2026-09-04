// tests/broadcast-gate.test.js —— 播报闸五条闸（issue #891 期一，W3）
//
// 每条闸正反样本各至少一例；另加确定性、诚实性（没查成 ≠ 没有）、
// 配置校验、20+ 事件端到端重放，以及**变异自证**：把闸的判据改坏
// （预算上限当成无限 / 去重键永不命中），跑同一批断言必须翻红。
// 变异体写到临时目录、相对 import 改写成真 lib 的 file:// 绝对路径 ⇒ 不污染仓树。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib');
const GATE_SRC = path.join(LIB, 'broadcast-gate.mjs');
const GROUPS_TEMPLATE = path.join(REPO, 'host', 'machine', 'feishu-groups.json');

const gate = () => import(pathToFileURL(GATE_SRC).href);

// ── schema：真 schema 派生，不手抄闭集 ────────────────────────────────────
// W1 正在给 schemas/events.schema.json 加 session.state / decision.pending。
// 本测试拿**真** schema 复制一份，只补上还没有的那两个 title ⇒ W1 合进来后
// 不重复添加、断言照样成立（不会因为 W1 落地而翻红）。
const REAL_SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas', 'events.schema.json'), 'utf8'));
const W1_TYPES = ['session.state', 'decision.pending'];

function schemaWithW1() {
  const s = JSON.parse(JSON.stringify(REAL_SCHEMA));
  const have = new Set(s.oneOf.map((d) => d.title));
  for (const t of W1_TYPES) {
    if (have.has(t)) continue;
    s.oneOf.push({
      title: t,
      allOf: [
        { $ref: '#/definitions/base' },
        { type: 'object', properties: { type: { const: t } }, additionalProperties: true },
      ],
    });
  }
  return s;
}
const SCHEMA = schemaWithW1();
const DAY = '2026-09-04';

let nextSeq = 0;
function ev(o) {
  nextSeq += 1;
  const seq = o.seq === undefined ? nextSeq : o.seq;
  return {
    schema_version: 1,
    ts: '2026-09-04T10:00:00+08:00',
    machine: 'win',
    seq,
    event_id: o.event_id || `id${String(seq).padStart(3, '0')}`,
    ...o,
    seq,
  };
}
const incident = (fp, extra = {}) => ev({ type: 'incident', fingerprint: fp, disposition: '升级用户', why: `探针红：${fp}`, ...extra });
const milestone = (job, extra = {}) => ev({ type: 'job.closed', job_id: job, success: true, rework: false, summary: `${job} 已合并落地`, ...extra });
const failedClose = (job) => ev({ type: 'job.closed', job_id: job, success: false, rework: true, summary: `${job} 失败关单` });
const pending = (subject, extra = {}) => ev({
  type: 'decision.pending', subject, summary: `${subject} 要拍板`,
  options: ['甲', '乙'], recommend: '甲', ...extra,
});
const meter = (job) => ev({ type: 'job.meter', job_id: job, model: 'm', token_in: 1, token_out: 1, cache_hit: 0, usd_cash: 0.01 });

async function groupsOf(json) {
  const { loadBroadcastGroups } = await gate();
  const r = loadBroadcastGroups(json);
  assert.deepStrictEqual(r.problems, [], `群配置该无毛病，实际：${r.problems.join('；')}`);
  return r.groups;
}

const PROJ = 'oc_proj';
const HUB = 'oc_hub';
async function twoGroups({ projBudget = 20, hubBudget = 6 } = {}) {
  return groupsOf({
    _note: '注释键不参与',
    [PROJ]: { repo: 'a/b', kind: 'project', broadcast: { subscribe: ['decision.pending', 'milestone', 'incident'], dailyBudget: projBudget } },
    [HUB]: { kind: 'hub', broadcast: { dailyBudget: hubBudget } },
  });
}

async function decide({ events, groups, state = {}, config = {} }) {
  const { decideBroadcast } = await gate();
  return decideBroadcast({
    events,
    config: { schema: SCHEMA, groups, ...config },
    state: { day: DAY, ...state },
  });
}

const sentTo = (r, chatId) => r.send.filter((s) => s.chatId === chatId);
const droppedBy = (r, n, chatId) => r.suppressed.filter((s) => s.gate === n && (chatId === undefined || s.chatId === chatId));

// ── 闸1：只播状态跃迁（内容维去重，键=(主体,digest)）────────────────────────

test('闸1 正：同主体 digest 变了就放行（状态跃迁）', async () => {
  const groups = await twoGroups();
  const first = pending('issue#891');
  const r1 = await decide({ events: [first], groups });
  assert.strictEqual(sentTo(r1, PROJ).length, 1, '首次该播');
  const key = r1.send.find((s) => s.chatId === PROJ).dedupeKey;

  // 同主体、内容变了 ⇒ 新 digest ⇒ 上一轮的键压不住它
  const moved = pending('issue#891', { summary: 'issue#891 改成走并存方案，要拍板' });
  const r2 = await decide({ events: [moved], groups, state: { seen: { [PROJ]: [key] } } });
  assert.strictEqual(sentTo(r2, PROJ).length, 1, 'digest 变了该放行');
  assert.notStrictEqual(sentTo(r2, PROJ)[0].dedupeKey, key, '键必须跟着内容变');
});

test('闸1 反：同主体同 digest 不播（跨轮 + 本轮内各一例）', async () => {
  const groups = await twoGroups();
  const e = pending('issue#891');
  const r1 = await decide({ events: [e], groups });
  const key = sentTo(r1, PROJ)[0].dedupeKey;

  // 跨轮：上一轮播过的键在 state.seen 里
  const r2 = await decide({ events: [e], groups, state: { seen: { [PROJ]: [key] } } });
  assert.strictEqual(sentTo(r2, PROJ).length, 0, '同键跨轮不该再播');
  const cross = droppedBy(r2, 1, PROJ);
  assert.strictEqual(cross.length, 1);
  assert.match(cross[0].why, /已播过/, '理由要说得清是闸1 拦的');

  // 本轮内：一批里同键出现两次（重放/心跳重写），只播一条
  const twin = { ...e, event_id: 'id999', seq: 999 };
  const r3 = await decide({ events: [e, twin], groups });
  assert.strictEqual(sentTo(r3, PROJ).length, 1, '本轮同键只播一条');
  assert.match(droppedBy(r3, 1, PROJ)[0].why, /本轮已收下同键/);
});

// ── 闸2：白名单三类，类型闭集派生自 schema ──────────────────────────────────

test('闸2 正：三类都能过闸（类型名对派生闭集核验过）', async () => {
  const { deriveGateTypes, BROADCAST_CLASSES } = await gate();
  const derived = deriveGateTypes(SCHEMA);
  assert.deepStrictEqual(derived.missing, [], '补过 W1 的 schema 里三类的类型都该在闭集内');
  assert.ok(derived.closedSet.length >= 16, `闭集该是派生出来的一堆类型，实际 ${derived.closedSet.length}`);

  const groups = await twoGroups();
  const r = await decide({
    events: [pending('p1'), milestone('j1'), incident('fp1')],
    groups, state: { windowClosing: true },
  });
  const classes = sentTo(r, PROJ).map((s) => s.class).filter(Boolean);
  for (const c of BROADCAST_CLASSES) assert.ok(classes.includes(c), `${c} 该有一条出去`);
});

test('闸2 反：白名单外只进账不播（job.meter / 失败关单 / 闭集外类型）', async () => {
  const groups = await twoGroups();
  const bogus = ev({ type: 'not.a.real.type', summary: '编的类型' });
  const r = await decide({
    events: [meter('j9'), failedClose('j8'), bogus],
    groups, state: { windowClosing: true },
  });
  assert.strictEqual(r.send.length, 0, '三条都不该播');
  const g2 = droppedBy(r, 2);
  assert.strictEqual(g2.length, 3, `闸2 该拦下 3 条，实际 ${g2.length}`);
  assert.ok(g2.every((s) => s.chatId === null), '闸2 是全局判定，与群无关');
  assert.match(g2.find((s) => s.type === 'job.meter').why, /白名单/);
  assert.match(g2.find((s) => s.type === 'job.closed').why, /success=true/, '失败关单要说清为什么不算里程碑');
  assert.match(g2.find((s) => s.type === 'not.a.real.type').why, /不在 schema 闭集/);
});

test('闸2 诚实：schema 缺类型 = 没查成，不是「没有这类事件」', async () => {
  const { deriveGateTypes, validateBroadcastGroups } = await gate();
  // 拿真 schema（W1 未合前没有 decision.pending）验：缺的必须被点名
  const realDerived = deriveGateTypes(REAL_SCHEMA);
  assert.ok(realDerived.closedSet.includes('incident'), '真 schema 里 incident 该在');
  assert.ok(realDerived.closedSet.includes('job.closed'), '真 schema 里 job.closed 该在');
  assert.ok(
    realDerived.missing.every((m) => W1_TYPES.includes(m.type)),
    `缺的只该是 W1 在加的那两类，实际 ${JSON.stringify(realDerived.missing)}`,
  );

  const groups = await twoGroups();
  const stripped = JSON.parse(JSON.stringify(SCHEMA));
  stripped.oneOf = stripped.oneOf.filter((d) => d.title !== 'decision.pending');
  const { decideBroadcast } = await gate();
  const r = decideBroadcast({
    events: [pending('p1')],
    config: { schema: stripped, groups },
    state: { day: DAY },
  });
  assert.strictEqual(r.send.length, 0);
  assert.ok(
    r.why.some((w) => /没查成/.test(w) && /decision\.pending/.test(w)),
    `why 必须明说没查成，实际：${r.why.join(' | ')}`,
  );
  const v = validateBroadcastGroups(JSON.parse(fs.readFileSync(GROUPS_TEMPLATE, 'utf8')), stripped);
  assert.ok(v.missingTypes.some((t) => /decision\.pending/.test(t)), '校验器也要把缺的类型报出来');
});

// ── 闸3：急缓分流 ──────────────────────────────────────────────────────

test('闸3 正：急件即时插播，窗末里程碑合成一条三行摘要', async () => {
  const groups = await twoGroups();
  const urgent = await decide({ events: [incident('fp1'), pending('p1')], groups, state: { windowClosing: false } });
  const rows = sentTo(urgent, PROJ);
  assert.strictEqual(rows.length, 2, '非窗末，急件也要出去');
  assert.ok(rows.every((s) => s.kind === 'instant' && s.urgency === '急'));

  const closing = await decide({ events: [milestone('j1'), milestone('j2'), milestone('j3'), milestone('j4')], groups, state: { windowClosing: true } });
  const digest = sentTo(closing, PROJ);
  assert.strictEqual(digest.length, 1, '4 条里程碑合成一条');
  assert.strictEqual(digest[0].kind, 'digest');
  assert.strictEqual(digest[0].urgency, '缓');
  assert.strictEqual(digest[0].text.split('\n').length, 3, `摘要恒三行，实际：${JSON.stringify(digest[0].text)}`);
  assert.strictEqual(digest[0].eventIds.length, 4, '四条事件的 id 都要挂在这条消息上');
});

test('闸3 反：非窗末的里程碑攒着（deferred，不是丢弃）', async () => {
  const groups = await twoGroups();
  const r = await decide({ events: [milestone('j1'), milestone('j2')], groups, state: { windowClosing: false } });
  assert.strictEqual(sentTo(r, PROJ).length, 0, '非窗末不该发里程碑');
  const held = droppedBy(r, 3, PROJ);
  assert.strictEqual(held.length, 2);
  assert.ok(held.every((s) => s.deferred === true), 'deferred 要与「丢弃」分得开');
  assert.match(held[0].why, /窗末/);
});

// ── 闸4：每日预算硬闸（上限由群配置决定，不由事件量决定）───────────────────────

test('闸4 正：额度内照发，额度由群配置给', async () => {
  const groups = await twoGroups({ projBudget: 3 });
  const r = await decide({ events: [incident('a'), incident('b'), incident('c')], groups });
  assert.strictEqual(sentTo(r, PROJ).length, 3, '正好用满不该拦');
  assert.strictEqual(droppedBy(r, 4, PROJ).length, 0);
});

test('闸4 反：超上限只发「还有 X 条」，且一天一条', async () => {
  const groups = await twoGroups({ projBudget: 1 });
  const r = await decide({ events: [incident('a'), incident('b'), incident('c')], groups });
  const rows = sentTo(r, PROJ);
  assert.strictEqual(rows.length, 2, '一条正文 + 一条溢出提示');
  assert.strictEqual(rows[0].kind, 'instant');
  assert.strictEqual(rows[1].kind, 'budget-notice');
  assert.strictEqual(rows[1].text, '还有 2 条，@我问详情');
  assert.strictEqual(droppedBy(r, 4, PROJ).length, 2, '被拦的两条要逐条留痕');

  // 上限跟着配置走，不跟着事件量走：同一批事件、上限调大 ⇒ 不再有提示
  const wide = await twoGroups({ projBudget: 9 });
  const r2 = await decide({ events: [incident('a'), incident('b'), incident('c')], groups: wide });
  assert.strictEqual(sentTo(r2, PROJ).filter((s) => s.kind === 'budget-notice').length, 0);
  assert.strictEqual(sentTo(r2, PROJ).length, 3);

  // 已用额度也算：进本轮前已用满 ⇒ 一条正文都发不出，只剩提示
  const r3 = await decide({ events: [incident('a')], groups: wide, state: { sentToday: { [PROJ]: 9 } } });
  assert.deepStrictEqual(sentTo(r3, PROJ).map((s) => s.kind), ['budget-notice']);

  // 提示一天一条：把提示的键喂回 seen ⇒ 不再重复提示
  const noticeKey = r3.send.find((s) => s.kind === 'budget-notice').dedupeKey;
  const r4 = await decide({
    events: [incident('a')], groups: wide,
    state: { sentToday: { [PROJ]: 9 }, seen: { [PROJ]: [noticeKey] } },
  });
  assert.strictEqual(sentTo(r4, PROJ).length, 0, '同一天不该再提示一遍');
});

// ── 闸5：群维度订阅 ────────────────────────────────────────────────────

test('闸5 正：项目群三类全收；反：hub 群默认只订里程碑', async () => {
  const groups = await twoGroups();
  const r = await decide({
    events: [pending('p1'), incident('fp1'), milestone('j1')],
    groups, state: { windowClosing: true },
  });
  assert.strictEqual(sentTo(r, PROJ).length, 3, '项目群三类都要到');

  const hub = sentTo(r, HUB);
  assert.strictEqual(hub.length, 1, 'hub 群只该收里程碑那一条');
  assert.strictEqual(hub[0].class, 'milestone');
  const g5 = droppedBy(r, 5, HUB);
  assert.strictEqual(g5.length, 2, '待拍板与事故被闸5 拦在 hub 群外');
  assert.ok(g5.every((s) => /未订阅/.test(s.why)));
});

// ── 输出契约：三个键、每条都有理由、确定性 ─────────────────────────────────

test('输出恰好三个键，每条判定都有可读理由', async () => {
  const groups = await twoGroups({ projBudget: 1 });
  const r = await decide({
    events: [incident('a'), incident('b'), meter('j1'), milestone('j1')],
    groups, state: { windowClosing: false },
  });
  assert.deepStrictEqual(Object.keys(r).sort(), ['send', 'suppressed', 'why']);
  for (const row of r.send) assert.ok(row.why && row.why.length > 0, '放行也要给理由');
  for (const row of r.suppressed) {
    assert.ok(row.why && row.why.length > 0, '拦下必须给理由');
    assert.ok(Number.isInteger(row.gate) && row.gate >= 1 && row.gate <= 5, `理由要指到具体哪条闸，实际 gate=${row.gate}`);
  }
  assert.ok(r.why.length >= r.send.length + r.suppressed.length, 'why 要覆盖到每条判定');
});

test('确定性：打乱入参顺序，输出逐字节相同', async () => {
  const groups = await twoGroups({ projBudget: 4 });
  const events = [incident('a'), milestone('j1'), pending('p1'), meter('m1'), incident('b'), milestone('j2')];
  const state = { windowClosing: true };
  const a = await decide({ events, groups, state });
  const b = await decide({ events: [...events].reverse(), groups, state });
  const c = await decide({ events: [events[3], events[0], events[5], events[1], events[4], events[2]], groups, state });
  assert.strictEqual(JSON.stringify(b), JSON.stringify(a));
  assert.strictEqual(JSON.stringify(c), JSON.stringify(a));
});

test('入参不被改写（纯函数）', async () => {
  const groups = await twoGroups();
  const events = [incident('a'), milestone('j1')];
  const snapshot = JSON.stringify(events);
  const state = { day: DAY, windowClosing: true, seen: {}, sentToday: {} };
  const stateSnapshot = JSON.stringify(state);
  const { decideBroadcast } = await gate();
  decideBroadcast({ events, config: { schema: SCHEMA, groups }, state });
  assert.strictEqual(JSON.stringify(events), snapshot);
  assert.strictEqual(JSON.stringify(state), stateSnapshot);
});

// ── 群订阅配置：样例 + 校验 ────────────────────────────────────────────────

test('仓内群映射模板里的 broadcast 样例过校验，且既有消费方不受影响', async () => {
  const { validateBroadcastGroups } = await gate();
  const json = JSON.parse(fs.readFileSync(GROUPS_TEMPLATE, 'utf8'));
  const v = validateBroadcastGroups(json, SCHEMA);
  assert.deepStrictEqual(v.problems, [], `模板该过校验，实际：${v.problems.join('；')}`);
  assert.deepStrictEqual(v.missingTypes, [], '补过 W1 的 schema 下不该有缺类型');
  assert.ok(Object.keys(v.groups).length >= 4, '至少四个占位群');
  assert.ok(Object.keys(v.groups).every((k) => !k.startsWith('_')), '_ 开头的注释键不参与');

  // 沿用不另造：多出来的 broadcast 字段不能把既有两个消费方顶翻
  const { loadGroups } = await import(pathToFileURL(path.join(REPO, 'scripts', 'feishu-triage.mjs')).href);
  const legacy = loadGroups(GROUPS_TEMPLATE);
  assert.ok(Object.keys(legacy).length >= 4, 'feishu-triage.loadGroups 照旧读得出群');
  const { parseGroupCatalog } = await import(pathToFileURL(path.join(LIB, 'feishu-groups-check.mjs')).href);
  const cat = parseGroupCatalog(fs.readFileSync(GROUPS_TEMPLATE, 'utf8'));
  assert.strictEqual(cat.kind, 'ok', `feishu-groups-check 照旧解析得动，实际 ${JSON.stringify(cat.fail || '')}`);
});

test('群订阅配置：省了按 kind 取默认，写坏了要报出来', async () => {
  const { loadBroadcastGroups, DEFAULT_SUBSCRIBE, DEFAULT_DAILY_BUDGET } = await gate();
  const d = loadBroadcastGroups({ oc_p: { repo: 'a/b', kind: 'project' }, oc_h: { kind: 'hub' } });
  assert.deepStrictEqual(d.problems, []);
  assert.deepStrictEqual(d.groups.oc_h.subscribe, DEFAULT_SUBSCRIBE.hub, '人多的群默认只订里程碑');
  assert.deepStrictEqual(d.groups.oc_p.subscribe, DEFAULT_SUBSCRIBE.project);
  assert.strictEqual(d.groups.oc_h.dailyBudget, DEFAULT_DAILY_BUDGET.hub);

  assert.match(loadBroadcastGroups({ oc_p: { kind: 'project', broadcast: { subscribe: ['里程碑'] } } }).problems[0], /不认识的类/);
  assert.match(loadBroadcastGroups({ oc_p: { kind: 'project', broadcast: { dailyBudget: -1 } } }).problems[0], /非负整数/);
  assert.match(loadBroadcastGroups({ oc_p: { kind: 'project', broadcast: { subscribe: 'milestone' } } }).problems[0], /不是数组/);
  assert.match(loadBroadcastGroups({ oc_p: { kind: '群' } }).problems[0], /kind 不认识/);
  // 零样本报红：一个群都没读到 = 没读成，不是「没有群」
  assert.match(loadBroadcastGroups({ _only: '注释' }).problems[0], /没读到|没读成/);
  assert.match(loadBroadcastGroups(null).problems[0], /没读成/);
});

test('坏入参当场抛，不静默返回空结果', async () => {
  const { decideBroadcast, deriveGateTypes } = await gate();
  const groups = await twoGroups();
  assert.throws(() => decideBroadcast({ events: 'nope', config: { schema: SCHEMA, groups }, state: { day: DAY } }), /数组/);
  assert.throws(() => decideBroadcast({ events: [], config: { schema: SCHEMA }, state: { day: DAY } }), /config\.groups/);
  assert.throws(() => decideBroadcast({ events: [], config: { schema: SCHEMA, groups }, state: {} }), /state\.day/);
  assert.throws(() => deriveGateTypes({ nope: 1 }), /没派生成/);
});

// ── 端到端重放：22 条事件，含重复 digest、超预算、混合类型 ───────────────────

function replayFixture() {
  nextSeq = 0;
  const events = [];
  for (const fp of ['probe-red', 'quota-out', 'tui-stuck']) {
    events.push(incident(fp));
    events.push({ ...incident(fp), event_id: `dup-${fp}` }); // 同主体同 digest（重放）
  }
  for (const j of ['j1', 'j2', 'j3', 'j4', 'j5', 'j6']) events.push(milestone(j));
  for (const j of ['x1', 'x2', 'x3']) events.push(failedClose(j));
  for (const p of ['#888', '#890', '#891']) events.push(pending(p));
  events.push({ ...pending('#891'), event_id: 'dup-891' }); // 同主体同 digest
  for (const j of ['m1', 'm2', 'm3']) events.push(meter(j));
  return events;
}

test('端到端重放：22 条事件，条数与顺序都对得上', async () => {
  const events = replayFixture();
  assert.strictEqual(events.length, 22, '样本条数先自证');
  const groups = await twoGroups({ projBudget: 5, hubBudget: 6 });
  const r = await decide({ events, groups, state: { windowClosing: true } });

  // 闸2：3 条 job.meter + 3 条失败关单 = 6 条只进账不播（全局判定）
  assert.strictEqual(droppedBy(r, 2).length, 6);
  // 闸1：项目群里 3 条重复事故 + 1 条重复待拍板 = 4 条同键被压
  assert.strictEqual(droppedBy(r, 1, PROJ).length, 4);
  // 闸5：hub 群只订里程碑 ⇒ 6 条事故 + 4 条待拍板被拦
  assert.strictEqual(droppedBy(r, 5, HUB).length, 10);

  // 项目群：3 事故 + 3 待拍板 = 6 条急件，预算 5 ⇒ 发 5 条，第 6 条 + 6 条里程碑摘要全被预算拦
  const proj = sentTo(r, PROJ);
  assert.deepStrictEqual(proj.map((s) => s.kind), ['instant', 'instant', 'instant', 'instant', 'instant', 'budget-notice']);
  assert.strictEqual(proj[5].text, '还有 7 条，@我问详情', '被拦 = 1 条急件 + 6 条里程碑');
  assert.strictEqual(droppedBy(r, 4, PROJ).length, 7);

  // hub 群：6 条里程碑窗末合成一条三行摘要，预算 6 够用
  const hub = sentTo(r, HUB);
  assert.deepStrictEqual(hub.map((s) => s.kind), ['digest']);
  assert.strictEqual(hub[0].text.split('\n').length, 3);
  assert.match(hub[0].text, /窗末汇总 6 条/);
  assert.match(hub[0].text, /另有 3 条，@我问详情/);
  assert.strictEqual(hub[0].eventIds.length, 6);

  // 顺序：群按 chat_id 字典序（oc_hub 在 oc_proj 前），群内按账本全序
  assert.deepStrictEqual(r.send.map((s) => s.chatId), [HUB, PROJ, PROJ, PROJ, PROJ, PROJ, PROJ]);
  const projEvents = proj.slice(0, 5).map((s) => s.eventIds[0]);
  assert.deepStrictEqual(projEvents, [...projEvents].sort(), '群内按账本全序，不吃入参顺序');
  assert.strictEqual(r.send.length + r.suppressed.length, 34, 'send + suppressed 逐条都有交代');
});

// ── 变异自证：把闸的判据改坏，同一批断言必须翻红 ──────────────────────────────

function mutantUrl(from, to, tag) {
  const src = fs.readFileSync(GATE_SRC, 'utf8');
  assert.ok(src.includes(from), `变异锚点不在了（判据被改过？）：${from}`);
  const mutated = src.split(from).join(to)
    // 相对 import 改写成真 lib 的绝对 file:// ⇒ 变异体放临时目录也能解析依赖
    .replace(/from '\.\/([\w.-]+\.mjs)'/g, (_m, f) => `from ${JSON.stringify(pathToFileURL(path.join(LIB, f)).href)}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgate-mutant-'));
  const file = path.join(dir, `${tag}.mjs`);
  fs.writeFileSync(file, mutated);
  return { url: pathToFileURL(file).href, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('变异自证①：预算上限当成无限 ⇒ 闸4 的断言必须翻红', async () => {
  const m = mutantUrl('let remaining = budget - used;', 'let remaining = Number.POSITIVE_INFINITY;', 'budget-infinite');
  try {
    const { decideBroadcast } = await import(m.url);
    const groups = await twoGroups({ projBudget: 1 });
    const r = decideBroadcast({
      events: [incident('a'), incident('b'), incident('c')],
      config: { schema: SCHEMA, groups },
      state: { day: DAY },
    });
    const rows = r.send.filter((s) => s.chatId === PROJ);
    // 好代码在这里给 ['instant','budget-notice']；坏代码把三条全放出去
    assert.notDeepStrictEqual(rows.map((s) => s.kind), ['instant', 'budget-notice'], '变异体竟然还是对的 ⇒ 这条断言没判别力');
    assert.strictEqual(rows.length, 3, '预算无限的变异体会把超限的三条全播出去');
    assert.strictEqual(rows.filter((s) => s.kind === 'budget-notice').length, 0, '变异体不会发溢出提示');
  } finally {
    m.cleanup();
  }
});

test('变异自证②：去重键永不命中 ⇒ 闸1 的断言必须翻红', async () => {
  const m = mutantUrl('const key = dedupeKey(event);', 'const key = `never-${event.event_id}`;', 'dedupe-dead');
  try {
    const { decideBroadcast } = await import(m.url);
    const groups = await twoGroups();
    const e = pending('issue#891');
    const twin = { ...e, event_id: 'id999', seq: 999 };
    const r = decideBroadcast({
      events: [e, twin],
      config: { schema: SCHEMA, groups },
      state: { day: DAY },
    });
    const rows = r.send.filter((s) => s.chatId === PROJ);
    assert.strictEqual(rows.length, 2, '键换成 event_id 后同键不再撞 ⇒ 重复内容双发（正是闸1 要防的）');
    assert.strictEqual(r.suppressed.filter((s) => s.gate === 1).length, 0, '变异体一条都不会被闸1 拦');
  } finally {
    m.cleanup();
  }
});
