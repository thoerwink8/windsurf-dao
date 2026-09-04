// tests/broadcast-gate.test.js —— 播报闸五条闸（issue #891 期一，W3）
//
// 每条闸正反样本各至少一例；另加确定性、诚实性（没查成 ≠ 没有）、配置坏样本、
// 25 条事件端到端重放，以及**变异自证**：把闸的判据改坏（预算上限当成无限 /
// 去重键永不命中 / 缓也当急 / 配置坏了照套默认），跑同一批断言必须翻红。
// 变异体写到临时目录、相对 import 改写成真 lib 的 file:// 绝对路径 ⇒ 不污染仓树。
//
// 事件形状按 W1 #893 的最终契约（session.milestone / decision.pending /
// session.state / decision.resolved）。W1 未合进 master 时，SCHEMA 用**真** schema
// 复制一份补上缺的那几条 title——`stubbedTypes()` 把补了哪几条报出来，别装作
// 「测的就是最终 schema」；W1 一落地，补的那份自动让位给真定义（见套「schema 桩状况」）。

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

// ── schema：真 schema 派生，只补还没有的 title ──────────────────────────────
const REAL_SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas', 'events.schema.json'), 'utf8'));
const W1_TYPES = ['session.state', 'decision.pending', 'decision.resolved', 'session.milestone'];

/** W1 #893 契约里本闸真正吃到的两位枚举——真 schema 有就用真的，桩只在缺席时兜底。 */
const STUB_PROPS = {
  'decision.pending': {
    type: { const: 'decision.pending' },
    decision_id: { type: 'string' },
    question: { type: 'string' },
    options: { type: 'array' },
    recommend: { type: ['string', 'null'] },
    urgency: { enum: ['急', '缓', null] },
    why: { type: ['string', 'null'] },
  },
  'session.milestone': {
    type: { const: 'session.milestone' },
    kind: { enum: ['commit', 'land', 'pr-merge'] },
    repo: { type: ['string', 'null'] },
    evidence: { type: 'array', items: { type: 'string' }, minItems: 1 },
    milestone_key: { type: 'string' },
  },
};

function realTitles() {
  return new Set(REAL_SCHEMA.oneOf.map((d) => d.title));
}
function stubbedTypes() {
  const have = realTitles();
  return W1_TYPES.filter((t) => !have.has(t));
}
function schemaWithW1() {
  const s = JSON.parse(JSON.stringify(REAL_SCHEMA));
  const have = new Set(s.oneOf.map((d) => d.title));
  for (const t of W1_TYPES) {
    if (have.has(t)) continue; // 真 schema 已有 ⇒ 用真的，桩不覆盖
    s.oneOf.push({
      title: t,
      allOf: [
        { $ref: '#/definitions/base' },
        { type: 'object', properties: STUB_PROPS[t] || { type: { const: t } }, additionalProperties: true },
      ],
    });
  }
  return s;
}
const SCHEMA = schemaWithW1();
const DAY = '2026-09-04';

// ── 事件工厂：按 W1 #893 的必填字段造合法 payload ────────────────────────────
let nextSeq = 0;
function ev(o) {
  nextSeq += 1;
  const seq = o.seq === undefined ? nextSeq : o.seq;
  return {
    schema_version: 1,
    ts: '2026-09-04T10:00:00+08:00',
    machine: 'win',
    event_id: o.event_id || `id${String(seq).padStart(3, '0')}`,
    ...o,
    seq,
  };
}
const incident = (fp, extra = {}) => ev({
  type: 'incident', fingerprint: fp, disposition: '升级用户', why: `探针红：${fp}`, ...extra,
});
/** W5 #897 的写口：commit/land/pr-merge，没有 success 字段。 */
const milestone = (key, extra = {}) => ev({
  type: 'session.milestone', kind: 'commit', repo: 'windsurf-dao',
  evidence: ['exit_code=0', `commit:${key}`], milestone_key: `commit:${key}`,
  branch: 'feat/x', commit: key, subject: `提交 ${key}`, ...extra,
});
/** 历史类型：能力账正样本，判据是 success===true。 */
const jobClosed = (job, success) => ev({
  type: 'job.closed', job_id: job, success, rework: !success, usd_cash: 0.1,
  usd_economic: 0.1, merged_by: 'opus-5', summary: `${job} ${success ? '已合并落地' : '失败关单'}`,
});
const pending = (id, urgency, extra = {}) => ev({
  type: 'decision.pending', decision_id: `d-${id}`, question: `${id} 要拍板`,
  options: [{ label: '甲', description: '代价甲' }, { label: '乙', description: null }],
  recommend: '甲', urgency, why: null, ...extra,
});
const meter = (job) => ev({
  type: 'job.meter', job_id: job, model: 'm', token_in: 1, token_out: 1, cache_hit: 0, usd_cash: 0.01,
});

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

// ── schema 桩状况：别装作测的就是最终 schema ─────────────────────────────────

test('schema 桩状况：补了哪几条要报出来；真 schema 有了就用真的', async () => {
  const { deriveGateTypes } = await gate();
  const stubbed = stubbedTypes();
  assert.ok(
    stubbed.every((t) => W1_TYPES.includes(t)),
    `只该补 W1 #893 在加的那几类，实际补了 ${JSON.stringify(stubbed)}`,
  );
  // 真 schema 已有的类型，SCHEMA 里必须只有一份（桩没覆盖真定义）
  const titles = SCHEMA.oneOf.map((d) => d.title);
  assert.strictEqual(new Set(titles).size, titles.length, 'SCHEMA 里不许有重复 title（桩把真定义顶了）');

  // W1 一落地，这条就拿真 schema 的枚举核对——桩若与最终契约不符，这里会翻红
  const derived = deriveGateTypes(SCHEMA);
  assert.deepStrictEqual(derived.urgencyEnum, ['急', '缓', null], 'urgency 枚举必须是 急/缓/null（W1 #893 契约）');
  assert.deepStrictEqual(derived.milestoneKinds, ['commit', 'land', 'pr-merge'], 'kind 枚举必须是 commit/land/pr-merge');
  if (realTitles().has('decision.pending')) {
    const { propSchema } = await gate();
    assert.deepStrictEqual(
      propSchema(REAL_SCHEMA, 'decision.pending', 'urgency').enum, ['急', '缓', null],
      'W1 已合入 ⇒ 真 schema 的 urgency 枚举与本套的判据必须一致',
    );
  }
});

// ── 闸1：只播状态跃迁（内容维去重，键=(主体,digest)）────────────────────────

test('闸1 正：同主体 digest 变了就放行（状态跃迁）', async () => {
  const groups = await twoGroups();
  const first = pending('891', '急');
  const r1 = await decide({ events: [first], groups });
  assert.strictEqual(sentTo(r1, PROJ).length, 1, '首次该播');
  const key = sentTo(r1, PROJ)[0].dedupeKey;

  const moved = pending('891', '急', { question: '891 改成走并存方案，要拍板' });
  const r2 = await decide({ events: [moved], groups, state: { seen: { [PROJ]: [key] } } });
  assert.strictEqual(sentTo(r2, PROJ).length, 1, 'digest 变了该放行');
  assert.notStrictEqual(sentTo(r2, PROJ)[0].dedupeKey, key, '键必须跟着内容变');
});

test('闸1 反：同主体同 digest 不播（跨轮 + 本轮内各一例）', async () => {
  const groups = await twoGroups();
  const e = pending('891', '急');
  const r1 = await decide({ events: [e], groups });
  const key = sentTo(r1, PROJ)[0].dedupeKey;

  const r2 = await decide({ events: [e], groups, state: { seen: { [PROJ]: [key] } } });
  assert.strictEqual(sentTo(r2, PROJ).length, 0, '同键跨轮不该再播');
  assert.match(droppedBy(r2, 1, PROJ)[0].why, /已播过/);

  const twin = { ...e, event_id: 'id999', seq: 999 };
  const r3 = await decide({ events: [e, twin], groups });
  assert.strictEqual(sentTo(r3, PROJ).length, 1, '本轮同键只播一条');
  assert.match(droppedBy(r3, 1, PROJ)[0].why, /本轮已收下同键/);
});

test('闸1 主体：里程碑按 milestone_key 取主体，不认通名 subject（同标题两个提交不许撞）', async () => {
  const { subjectOf } = await gate();
  // session.milestone.subject 是**提交标题**。拿它当主体，两个同标题的提交会撞成
  // 一条、后一条永不播（审官没点，返工时自己查出来的）。
  const a = milestone('aaaaaaa', { subject: '同一个标题' });
  const b = milestone('bbbbbbb', { subject: '同一个标题' });
  assert.strictEqual(subjectOf(a), 'milestone_key=commit:aaaaaaa');
  assert.notStrictEqual(subjectOf(a), subjectOf(b), '同标题不同提交的主体必须不同');

  const groups = await twoGroups();
  const r = await decide({ events: [a, b], groups, state: { windowClosing: true } });
  assert.strictEqual(droppedBy(r, 1, PROJ).length, 0, '两条都不该被闸1 压掉');
  assert.strictEqual(sentTo(r, PROJ)[0].eventIds.length, 2, '两条都进了窗末摘要');

  // 反：真的同一次动作重复上报（milestone_key 相同）就该压掉一条
  const again = { ...a, event_id: 'again', seq: 900 };
  const r2 = await decide({ events: [a, again], groups, state: { windowClosing: true } });
  assert.strictEqual(droppedBy(r2, 1, PROJ).length, 1, '同 milestone_key 重复上报要压掉');
});

// ── 闸2：白名单三类，两个里程碑类型判据分开 ────────────────────────────────

test('闸2 正：session.milestone 三种 kind + job.closed(success) 都算里程碑', async () => {
  const groups = await twoGroups();
  const events = [
    milestone('c1', { kind: 'commit' }),
    milestone('l1', { kind: 'land', milestone_key: 'land:abc' }),
    milestone('p1', { kind: 'pr-merge', milestone_key: 'pr-896', pr_number: 896 }),
    jobClosed('j1', true),
  ];
  const r = await decide({ events, groups, state: { windowClosing: true } });
  const rows = sentTo(r, PROJ);
  assert.strictEqual(rows.length, 1, '四条合成一条窗末摘要');
  assert.strictEqual(rows[0].class, 'milestone');
  assert.strictEqual(rows[0].eventIds.length, 4, '两个类型都进了同一个里程碑批次');
  assert.strictEqual(droppedBy(r, 2).length, 0, '一条都不该被闸2 拦');
});

test('闸2 正：session.milestone 即时渲染带 kind；job.closed 没 kind 不硬凑', async () => {
  const { renderMessage } = await gate();
  assert.strictEqual(renderMessage(milestone('a1', { kind: 'land', subject: '收工一条命令过了' }), 'milestone'),
    '[里程碑·land] 收工一条命令过了');
  assert.strictEqual(renderMessage(jobClosed('j1', true), 'milestone'), '[里程碑] j1 已合并落地');
});

test('闸2 反：残缺里程碑 / 失败关单 / 白名单外 / 闭集外，四种都只进账不播', async () => {
  const groups = await twoGroups();
  const noKey = milestone('x1'); delete noKey.milestone_key;
  const noEvidence = milestone('x2', { evidence: [] });
  const bogus = ev({ type: 'not.a.real.type', summary: '编的类型' });
  const r = await decide({
    events: [noKey, noEvidence, jobClosed('j8', false), meter('j9'), bogus],
    groups, state: { windowClosing: true },
  });
  assert.strictEqual(r.send.length, 0, '五条都不该播');
  const g2 = droppedBy(r, 2);
  assert.strictEqual(g2.length, 5, `闸2 该拦下 5 条，实际 ${g2.length}`);
  assert.ok(g2.every((s) => s.chatId === null), '闸2 是全局判定，与群无关');
  const byWhy = (re) => g2.filter((s) => re.test(s.why)).length;
  assert.strictEqual(byWhy(/缺 milestone_key/), 1, '缺幂等键要点名（它就是去重主体）');
  assert.strictEqual(byWhy(/evidence 空或缺/), 1, 'evidence 空要点名（schema minItems=1）');
  assert.strictEqual(byWhy(/success !== true/), 1, '失败关单要说清为什么不算里程碑');
  assert.strictEqual(byWhy(/不在播报白名单/), 1, 'job.meter 在闭集内但不在白名单');
  assert.strictEqual(byWhy(/不在 schema 闭集/), 1, '编的类型要说不在闭集');
});

test('闸2 诚实：schema 缺类型 = 没查成，不是「没有这类事件」', async () => {
  const { deriveGateTypes, decideBroadcast, validateBroadcastGroups } = await gate();
  const realDerived = deriveGateTypes(REAL_SCHEMA);
  assert.ok(realDerived.closedSet.includes('incident'));
  assert.ok(realDerived.closedSet.includes('job.closed'));
  assert.ok(
    realDerived.missing.every((m) => W1_TYPES.includes(m.type)),
    `缺的只该是 W1 在加的那几类，实际 ${JSON.stringify(realDerived.missing)}`,
  );

  const groups = await twoGroups();
  const stripped = JSON.parse(JSON.stringify(SCHEMA));
  stripped.oneOf = stripped.oneOf.filter((d) => d.title !== 'session.milestone');
  const r = decideBroadcast({
    events: [milestone('a1')],
    config: { schema: stripped, groups },
    state: { day: DAY, windowClosing: true },
  });
  assert.strictEqual(r.send.length, 0);
  assert.ok(
    r.why.some((w) => /没查成/.test(w) && /session\.milestone/.test(w)),
    `why 必须明说没查成，实际：${r.why.join(' | ')}`,
  );
  // 一个类里少一个类型，另一个类型还得照常工作 —— job.closed 顶得住
  const r2 = decideBroadcast({
    events: [jobClosed('j1', true)],
    config: { schema: stripped, groups },
    state: { day: DAY, windowClosing: true },
  });
  assert.strictEqual(sentTo(r2, PROJ).length, 1, 'session.milestone 缺席不该让整个里程碑类哑掉');

  const v = validateBroadcastGroups(JSON.parse(fs.readFileSync(GROUPS_TEMPLATE, 'utf8')), stripped);
  assert.ok(v.missingTypes.some((t) => /session\.milestone/.test(t)), '校验器也要把缺的类型报出来');
});

// ── 闸3：急缓分流按事件自己的 urgency ────────────────────────────────────

test('闸3 正：urgency=急 即时插播；事故固定即时', async () => {
  const groups = await twoGroups();
  const r = await decide({ events: [pending('p1', '急'), incident('fp1')], groups, state: { windowClosing: false } });
  const rows = sentTo(r, PROJ);
  assert.strictEqual(rows.length, 2, '非窗末，急件也要出去');
  assert.ok(rows.every((s) => s.kind === 'instant' && s.urgency === '急'));
  assert.match(rows.find((s) => s.class === 'decision.pending').why, /事件自报 urgency=急/);
});

test('闸3 反：urgency=缓 走窗末，不许当急（审官第 2 条）', async () => {
  const groups = await twoGroups();
  const slow = pending('p1', '缓');
  const off = await decide({ events: [slow], groups, state: { windowClosing: false } });
  assert.strictEqual(sentTo(off, PROJ).length, 0, 'urgency=缓 非窗末不该发');
  const held = droppedBy(off, 3, PROJ);
  assert.strictEqual(held.length, 1);
  assert.strictEqual(held[0].deferred, true, 'deferred 要与「丢弃」分得开');
  assert.match(held[0].why, /事件自报 urgency=缓/);

  const on = await decide({ events: [slow], groups, state: { windowClosing: true } });
  const rows = sentTo(on, PROJ);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].kind, 'digest', '缓的待拍板要落到批处理路径');
  assert.strictEqual(rows[0].urgency, '缓');
});

test('闸3 反：urgency=null / 缺字段 ⇒ 按缓处理，但说的是「没判过」不是「判过是缓」', async () => {
  const groups = await twoGroups();
  const nul = pending('p1', null);
  const missing = pending('p2', null); delete missing.urgency;
  const r = await decide({ events: [nul, missing], groups, state: { windowClosing: false } });
  assert.strictEqual(sentTo(r, PROJ).length, 0, 'null 也要落批处理，不许即时');
  const held = droppedBy(r, 3, PROJ);
  assert.strictEqual(held.length, 2);
  for (const h of held) {
    assert.match(h.why, /没判过/, '账面记的是没判过');
    assert.ok(!/判过是缓/.test(h.why) || /不是「判过是缓」/.test(h.why), '不许说成「判过是缓」');
  }
  assert.match(held.find((h) => h.eventId === nul.event_id).why, /记的是 null/);
  assert.match(held.find((h) => h.eventId === missing.event_id).why, /这一位没写/);

  // 窗末：null 的那条要被收进摘要，且 why 点出「其中几条没判过」
  const on = await decide({ events: [nul, missing], groups, state: { windowClosing: true } });
  const row = sentTo(on, PROJ)[0];
  assert.strictEqual(row.kind, 'digest');
  assert.match(row.why, /2 条 urgency 没判过/);
});

test('闸3 反：urgency 值不在 schema 枚举 ⇒ 没查成，按缓兜底', async () => {
  const groups = await twoGroups();
  const weird = pending('p1', '特急');
  const r = await decide({ events: [weird], groups, state: { windowClosing: false } });
  assert.strictEqual(sentTo(r, PROJ).length, 0, '认不出的取值不许当急放出去');
  const held = droppedBy(r, 3, PROJ)[0];
  assert.match(held.why, /不认识/);
  assert.match(held.why, /没查成/);
  assert.match(held.why, /急\/缓\/null/, '理由里要带上从 schema 派生出来的枚举');
});

test('闸3：窗末按类各合一条三行摘要，抬头不混', async () => {
  const groups = await twoGroups();
  const events = [
    pending('p1', '缓'), pending('p2', '缓'),
    milestone('m1'), milestone('m2'), milestone('m3'), milestone('m4'),
  ];
  const r = await decide({ events, groups, state: { windowClosing: true } });
  const rows = sentTo(r, PROJ);
  assert.deepStrictEqual(rows.map((s) => s.class), ['decision.pending', 'milestone'], '按 BROADCAST_CLASSES 固定顺序');
  assert.ok(rows.every((s) => s.kind === 'digest' && s.text.split('\n').length === 3), '每条恒三行');
  assert.match(rows[0].text, /^\[待拍板\] 窗末汇总 2 条/, '待拍板不许挂里程碑抬头');
  assert.match(rows[1].text, /^\[里程碑\] 窗末汇总 4 条/);
  assert.match(rows[1].text, /另有 1 条，@我问详情/);
  assert.strictEqual(rows[1].eventIds.length, 4);
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
  assert.deepStrictEqual(rows.map((s) => s.kind), ['instant', 'budget-notice']);
  assert.strictEqual(rows[1].text, '还有 2 条，@我问详情');
  assert.strictEqual(droppedBy(r, 4, PROJ).length, 2, '被拦的两条要逐条留痕');

  const wide = await twoGroups({ projBudget: 9 });
  const r2 = await decide({ events: [incident('a'), incident('b'), incident('c')], groups: wide });
  assert.strictEqual(sentTo(r2, PROJ).filter((s) => s.kind === 'budget-notice').length, 0);
  assert.strictEqual(sentTo(r2, PROJ).length, 3, '上限跟配置走，不跟事件量走');

  const r3 = await decide({ events: [incident('a')], groups: wide, state: { sentToday: { [PROJ]: 9 } } });
  assert.deepStrictEqual(sentTo(r3, PROJ).map((s) => s.kind), ['budget-notice']);

  const noticeKey = sentTo(r3, PROJ)[0].dedupeKey;
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
    events: [pending('p1', '急'), incident('fp1'), milestone('m1')],
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
    events: [incident('a'), incident('b'), meter('j1'), milestone('m1'), pending('p1', null)],
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
  const events = [incident('a'), milestone('m1'), pending('p1', '急'), meter('m9'), incident('b'), milestone('m2'), pending('p2', '缓')];
  const state = { windowClosing: true };
  const a = await decide({ events, groups, state });
  const b = await decide({ events: [...events].reverse(), groups, state });
  const c = await decide({ events: [events[3], events[0], events[6], events[5], events[1], events[4], events[2]], groups, state });
  assert.strictEqual(JSON.stringify(b), JSON.stringify(a));
  assert.strictEqual(JSON.stringify(c), JSON.stringify(a));
});

test('入参不被改写（纯函数）', async () => {
  const groups = await twoGroups();
  const events = [incident('a'), milestone('m1'), pending('p1', null)];
  const snapshot = JSON.stringify(events);
  const state = { day: DAY, windowClosing: true, seen: {}, sentToday: {} };
  const stateSnapshot = JSON.stringify(state);
  const { decideBroadcast } = await gate();
  decideBroadcast({ events, config: { schema: SCHEMA, groups }, state });
  assert.strictEqual(JSON.stringify(events), snapshot);
  assert.strictEqual(JSON.stringify(state), stateSnapshot);
});

// ── 群订阅配置：样例 + 校验 + 坏样本 ──────────────────────────────────────

test('仓内群映射模板里的 broadcast 样例过校验，且既有消费方不受影响', async () => {
  const { validateBroadcastGroups } = await gate();
  const json = JSON.parse(fs.readFileSync(GROUPS_TEMPLATE, 'utf8'));
  const v = validateBroadcastGroups(json, SCHEMA);
  assert.deepStrictEqual(v.problems, [], `模板该过校验，实际：${v.problems.join('；')}`);
  assert.deepStrictEqual(v.missingTypes, [], '补过 W1 的 schema 下不该有缺类型');
  assert.ok(Object.keys(v.groups).length >= 4, '至少四个占位群');
  assert.ok(Object.keys(v.groups).every((k) => !k.startsWith('_')), '_ 开头的注释键不参与');

  const { loadGroups } = await import(pathToFileURL(path.join(REPO, 'scripts', 'feishu-triage.mjs')).href);
  assert.ok(Object.keys(loadGroups(GROUPS_TEMPLATE)).length >= 4, 'feishu-triage.loadGroups 照旧读得出群');
  const { parseGroupCatalog } = await import(pathToFileURL(path.join(LIB, 'feishu-groups-check.mjs')).href);
  const cat = parseGroupCatalog(fs.readFileSync(GROUPS_TEMPLATE, 'utf8'));
  assert.strictEqual(cat.kind, 'ok', `feishu-groups-check 照旧解析得动，实际 ${JSON.stringify(cat.fail || '')}`);
});

test('群订阅配置：只有字段缺省才套默认；写坏了一律报「没读成」（审官第 3 条）', async () => {
  const { loadBroadcastGroups, DEFAULT_SUBSCRIBE, DEFAULT_DAILY_BUDGET } = await gate();

  // 正：整节缺省 ⇒ 按 kind 取默认
  const d = loadBroadcastGroups({ oc_p: { repo: 'a/b', kind: 'project' }, oc_h: { kind: 'hub' } });
  assert.deepStrictEqual(d.problems, []);
  assert.deepStrictEqual(d.groups.oc_h.subscribe, DEFAULT_SUBSCRIBE.hub, '人多的群默认只订里程碑');
  assert.deepStrictEqual(d.groups.oc_p.subscribe, DEFAULT_SUBSCRIBE.project);
  assert.strictEqual(d.groups.oc_h.dailyBudget, DEFAULT_DAILY_BUDGET.hub);
  // 正：空对象也是「字段都缺省」⇒ 默认
  const empty = loadBroadcastGroups({ oc_p: { kind: 'project', broadcast: {} } });
  assert.deepStrictEqual(empty.problems, []);
  assert.strictEqual(empty.groups.oc_p.dailyBudget, DEFAULT_DAILY_BUDGET.project);

  // 反：broadcast 出现但不是对象 ⇒ problems，且**不许**落进 groups 套默认值
  for (const bad of ['bad', [], null, 0, true]) {
    const r = loadBroadcastGroups({ oc_x: { repo: 'a/b', kind: 'project', broadcast: bad } });
    assert.strictEqual(r.problems.length, 1, `broadcast=${JSON.stringify(bad)} 该报一条毛病`);
    assert.match(r.problems[0], /broadcast 不是对象/);
    assert.match(r.problems[0], /没读成/, '要说「没读成」，不许静默套默认');
    assert.strictEqual(r.groups.oc_x, undefined, `broadcast=${JSON.stringify(bad)} 不许套出一份播报策略`);
  }

  // 反：节内字段类型不对，同样不许套默认
  const badSub = loadBroadcastGroups({ oc_p: { kind: 'project', broadcast: { subscribe: 'milestone' } } });
  assert.match(badSub.problems[0], /subscribe 不是数组/);
  assert.strictEqual(badSub.groups.oc_p, undefined);
  const badBudget = loadBroadcastGroups({ oc_p: { kind: 'project', broadcast: { dailyBudget: -1 } } });
  assert.match(badBudget.problems[0], /非负整数/);
  assert.strictEqual(badBudget.groups.oc_p, undefined);
  assert.match(loadBroadcastGroups({ oc_p: { kind: 'project', broadcast: { dailyBudget: 1.5 } } }).problems[0], /非负整数/);
  assert.match(loadBroadcastGroups({ oc_p: { kind: 'project', broadcast: { subscribe: ['里程碑'] } } }).problems[0], /不认识的类/);
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

// ── 端到端重放：25 条事件，含重复 digest、超预算、混合类型与三种 urgency ────────

function replayFixture() {
  nextSeq = 0;
  const events = [];
  for (const fp of ['probe-red', 'quota-out', 'tui-stuck']) {
    events.push(incident(fp));
    events.push({ ...incident(fp), event_id: `dup-${fp}` }); // 同主体同 digest（重放）
  }
  for (const k of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) events.push(milestone(k));
  events.push(jobClosed('j1', true));
  events.push(jobClosed('j2', true));
  events.push(jobClosed('x1', false));
  events.push(jobClosed('x2', false));
  events.push(pending('888', '急'));
  events.push(pending('890', '急'));
  events.push({ ...pending('888', '急'), event_id: 'dup-888' }); // 同主体同 digest
  events.push(pending('891', '缓'));
  events.push(pending('892', '缓'));
  events.push(pending('893', null));                            // 写口没判过
  for (const j of ['t1', 't2', 't3']) events.push(meter(j));
  return events;
}

test('端到端重放：25 条事件，条数与顺序都对得上', async () => {
  const events = replayFixture();
  assert.strictEqual(events.length, 25, '样本条数先自证');
  const groups = await twoGroups({ projBudget: 5, hubBudget: 6 });
  const r = await decide({ events, groups, state: { windowClosing: true } });

  // 闸2：3 条 job.meter + 2 条失败关单 = 5 条只进账不播（全局判定）
  assert.strictEqual(droppedBy(r, 2).length, 5);
  // 闸1：项目群里 3 条重复事故 + 1 条重复待拍板 = 4 条同键被压
  assert.strictEqual(droppedBy(r, 1, PROJ).length, 4);
  // 闸5：hub 群只订里程碑 ⇒ 6 条事故 + 6 条待拍板被拦
  assert.strictEqual(droppedBy(r, 5, HUB).length, 12);

  // 项目群：3 事故 + 2 条 urgency=急 = 5 条急件，预算 5 ⇒ 发满 5 条；
  // 两个窗末批次（3 条缓待拍板 / 8 条里程碑）全被预算拦 ⇒ 11 条 + 一条提示
  const proj = sentTo(r, PROJ);
  assert.deepStrictEqual(proj.map((s) => s.kind), ['instant', 'instant', 'instant', 'instant', 'instant', 'budget-notice']);
  assert.deepStrictEqual(proj.slice(0, 5).map((s) => s.class),
    ['incident', 'incident', 'incident', 'decision.pending', 'decision.pending'], '急件按账本全序，事故在前');
  assert.strictEqual(proj[5].text, '还有 11 条，@我问详情', '被拦 = 3 条缓待拍板 + 8 条里程碑');
  assert.strictEqual(droppedBy(r, 4, PROJ).length, 11);

  // hub 群：6 条 session.milestone + 2 条 job.closed 合成一条三行摘要，预算 6 够用
  const hub = sentTo(r, HUB);
  assert.deepStrictEqual(hub.map((s) => s.kind), ['digest']);
  assert.strictEqual(hub[0].text.split('\n').length, 3);
  assert.match(hub[0].text, /^\[里程碑\] 窗末汇总 8 条/);
  assert.match(hub[0].text, /另有 5 条，@我问详情/);
  assert.strictEqual(hub[0].eventIds.length, 8);

  // 顺序：群按 chat_id 字典序（oc_hub 在 oc_proj 前），群内按账本全序
  assert.deepStrictEqual(r.send.map((s) => s.chatId), [HUB, PROJ, PROJ, PROJ, PROJ, PROJ, PROJ]);
  const projEvents = proj.slice(0, 5).map((s) => s.eventIds[0]);
  assert.deepStrictEqual(projEvents, [...projEvents].sort(), '群内按账本全序，不吃入参顺序');
  assert.strictEqual(r.send.length + r.suppressed.length, 39, 'send + suppressed 逐条都有交代');
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
    assert.notDeepStrictEqual(rows.map((s) => s.kind), ['instant', 'budget-notice'], '变异体竟然还是对的 ⇒ 这条断言没判别力');
    assert.strictEqual(rows.length, 3, '预算无限的变异体会把超限的三条全播出去');
    assert.strictEqual(rows.filter((s) => s.kind === 'budget-notice').length, 0);
  } finally {
    m.cleanup();
  }
});

test('变异自证②：去重键永不命中 ⇒ 闸1 的断言必须翻红', async () => {
  const m = mutantUrl('const key = dedupeKey(event);', 'const key = `never-${event.event_id}`;', 'dedupe-dead');
  try {
    const { decideBroadcast } = await import(m.url);
    const groups = await twoGroups();
    const e = pending('891', '急');
    const twin = { ...e, event_id: 'id999', seq: 999 };
    const r = decideBroadcast({
      events: [e, twin], config: { schema: SCHEMA, groups }, state: { day: DAY },
    });
    assert.strictEqual(r.send.filter((s) => s.chatId === PROJ).length, 2, '键换成 event_id 后重复内容双发（正是闸1 要防的）');
    assert.strictEqual(r.suppressed.filter((s) => s.gate === 1).length, 0);
  } finally {
    m.cleanup();
  }
});

test('变异自证③：urgency=缓 也当急 ⇒ 闸3 的断言必须翻红（审官第 2 条）', async () => {
  const m = mutantUrl(
    "return { urgency: URGENCY_BATCH, unjudged: false, why: '事件自报 urgency=缓 ⇒ 攒到窗末' };",
    "return { urgency: URGENCY_INSTANT, unjudged: false, why: '变异：缓也当急' };",
    'urgency-ignored',
  );
  try {
    const { decideBroadcast } = await import(m.url);
    const groups = await twoGroups();
    const r = decideBroadcast({
      events: [pending('p1', '缓')], config: { schema: SCHEMA, groups }, state: { day: DAY },
    });
    const rows = r.send.filter((s) => s.chatId === PROJ);
    assert.deepStrictEqual(rows.map((s) => `${s.kind}/${s.urgency}`), ['instant/急'], '变异体把缓的待拍板即时插播出去了');
    assert.strictEqual(r.suppressed.filter((s) => s.gate === 3).length, 0, '变异体不会把它攒到窗末');
  } finally {
    m.cleanup();
  }
});

test('变异自证④：配置写坏照套默认 ⇒ 群配置的断言必须翻红（审官第 3 条）', async () => {
  const m = mutantUrl('if (hasB && !plainObject(v.broadcast)) {', 'if (false) {', 'config-silent-default');
  try {
    const { loadBroadcastGroups, DEFAULT_DAILY_BUDGET } = await import(m.url);
    const r = loadBroadcastGroups({ oc_x: { repo: 'a/b', kind: 'project', broadcast: 'bad' } });
    assert.deepStrictEqual(r.problems, [], '变异体把「没读成」咽掉了');
    assert.strictEqual(r.groups.oc_x.dailyBudget, DEFAULT_DAILY_BUDGET.project, '变异体把写坏的配置静默套成了默认播报策略');
  } finally {
    m.cleanup();
  }
});
