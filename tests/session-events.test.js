// tests/session-events.test.js —— #891 期一 W1：会话态事件四类型
//   （session.state / decision.pending / decision.resolved / session.milestone）
//
// 判别力（本套存在的理由）：合法样本必须过，非法样本必须被拒——
//   ① 每类型的必填字段逐个缺一，一个不漏地拒（不是只试一个字段）
//   ② schema 声明的枚举写错（phase / identity / urgency / by / kind）拒
//   ③ decision.resolved 缺 target_decision_id 拒
//   ④ decision.pending 的 recommend 落空 / options 只有一条 / option 缺 label 拒
//   ⑤ W5 写口（#897）的真实 payload 必须过——「没查成」记 null 是合法的，
//      拿不到的字段不设必填（形状对不上就等于每条事件静默丢，hook 侧永远 exit 0）
// 闭集唯一权威 = schemas/events.schema.json；本套另核 scripts/event-write.mjs 头注的
// [闭集镜子] 段与它双向一致——镜子漂了就报红，这就是「不许在别处另抄清单」的那道警报。
// 变异自证：把 schema 里某条必填删掉，本套必须翻红（证据贴 PR 正文）。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const { buildEvent, writeEvent, schemaMeta } = require('../scripts/lib/event-writer.mjs');

const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas', 'events.schema.json'), 'utf8'));
const meta = schemaMeta(schema);
const TS = '2026-09-04T10:00:00+08:00';
const TS2 = '2026-09-04T10:30:00+08:00';
const MACHINE = 'TEST-891';

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}
function build(type, payload, over = {}) {
  return buildEvent({ type, ts: TS, machine: MACHINE, seq: 0, payload, schema, ...over });
}
/** 逐个删必填字段，返回「没被拒」的字段名（应为空） */
function requiredHoles(type, payload) {
  return (meta.requiredByType.get(type) || []).filter(f => {
    const p = { ...payload };
    delete p[f];
    return !throws(() => build(type, p));
  });
}

// ── 夹具（形状真、值全假；不含任何真 key/token/绝对路径） ────────────────────
const STATE = {
  session_id: 's-891-w1',
  identity: '工人',
  phase: '沉默',
  doing: '给事件闭集加三个类型',
  next: '跑变异自证再交卷',
  blocked: false,
  pending_decision_id: null,
  digest: '0f1e2d3c4b5a6978',
  repo: 'windsurf-dao',
  refs: ['#891'],
};
const PENDING = {
  decision_id: 'd-891-1',
  question: '三张卡先合哪张？',
  options: [
    { label: 'W1 先合', description: 'schema 是另两张的地基，先合少返工' },
    { label: '等三张齐', description: '一次合完，但地基改动会连带改另两张' },
  ],
  recommend: 'W1 先合',
  urgency: '急',
  why: '另两张卡都读它派生的闭集',
};
const RESOLVED = {
  target_decision_id: 'd-891-1',
  chosen: ['W1 先合'],
  by: '用户',
  note: '当场拍',
};
const MILESTONE = {
  kind: 'commit',
  repo: 'windsurf-dao',
  evidence: ['exit_code=0', 'commit:a1b2c3d'],
  milestone_key: 'commit:a1b2c3d',
  branch: 'feat/891-session-events',
  commit: 'a1b2c3d',
  subject: 'feat(events): 事件闭集加会话态类型',
  pr_number: null,
  session_id: 's-891-w1',
  refs: ['#891'],
};
// W5（PR #897）动作触发写口的真实 payload 形状：这三条必须原样过，
// 否则它的 hook（永远 exit 0）会把每条事件静默丢掉。
const W5_PENDING = {
  decision_id: 'dec-b93ccbf33d37b82b',
  question: '播报闸的每日预算上限定多少条？',
  options: [{ label: '每天 8 条 (Recommended)', description: '按今晚事件量估' }, { label: '每天 20 条', description: '几乎不压' }],
  recommend: '每天 8 条 (Recommended)',
  urgency: null,
  why: '按今晚事件量估',
  why_source: 'recommend_description',
  asked_by: 'AskUserQuestion',
};
const W5_OPEN = {
  decision_id: 'dec-af7fee469aa7eba5',
  question: '你想怎么办？',
  options: [],
  recommend: null,
  urgency: null,
  why: null,
  asked_by: 'mcp__mirasim__im_ask_user',
};
const W5_MILESTONE_UNKNOWN = {
  kind: 'land',
  repo: 'windsurf-dao',
  evidence: ['exit_code=0', 'git 探头没查成：not a git repository'],
  milestone_key: 'land:9f2a7c4d8e1b',
  branch: null,
  commit: null,
  subject: null,
  pr_number: null,
};

describe('session-events（#891 W1）', () => {
  it('① 三类型进闭集，必填字段按 schema 派生', async (t) => {
    await t.test('闭集含四个新类型', () => {
      const miss = ['session.state', 'decision.pending', 'decision.resolved', 'session.milestone'].filter(x => !meta.closedSet.includes(x));
      assert.ok(miss.length === 0, '闭集含四个新类型  →  缺 ' + miss.join(','));
    });
    await t.test('session.state 必填 = 八项（含 digest：播报闸去重靠它）', () => {
      const got = [...meta.requiredByType.get('session.state')].sort().join('/');
      const want = ['session_id', 'identity', 'phase', 'doing', 'next', 'blocked', 'pending_decision_id', 'digest'].sort().join('/');
      assert.ok(got === want, 'session.state 必填 = 八项  →  ' + got);
    });
    await t.test('decision.pending 必填含 options/recommend/urgency', () => {
      const req = meta.requiredByType.get('decision.pending');
      assert.ok(['decision_id', 'question', 'options', 'recommend', 'urgency', 'why'].every(f => req.includes(f)), 'decision.pending 必填含 options/recommend/urgency  →  ' + req.join('/'));
    });
    await t.test('decision.resolved 必填含 target_decision_id/chosen/by', () => {
      const req = meta.requiredByType.get('decision.resolved');
      assert.ok(['target_decision_id', 'chosen', 'by'].every(f => req.includes(f)), 'decision.resolved 必填含 target_decision_id/chosen/by  →  ' + req.join('/'));
    });
    // 必填只留「动作完成那一刻真拿得到」的四项。job.closed 不能复用正是因为它的
    // merged_by/usd_cash/usd_economic 那一刻一个都拿不到（#897 核过）——别重犯。
    await t.test('session.milestone 必填 = kind/repo/evidence/milestone_key 四项，一项不多', () => {
      const got = [...meta.requiredByType.get('session.milestone')].sort().join('/');
      const want = ['kind', 'repo', 'evidence', 'milestone_key'].sort().join('/');
      assert.ok(got === want, 'session.milestone 必填 = 四项  →  ' + got);
    });
    await t.test('session.milestone 不把 git 探头才知道的东西设必填（branch/commit/subject/pr_number 全可省）', () => {
      const req = meta.requiredByType.get('session.milestone');
      const wrong = ['branch', 'commit', 'subject', 'pr_number', 'merged_by', 'usd_cash', 'usd_economic'].filter(f => req.includes(f));
      assert.ok(wrong.length === 0, 'session.milestone 不把探头字段设必填  →  误设 ' + wrong.join(','));
    });
  });

  it('② 合法样本三类型全过', async (t) => {
    for (const [type, payload] of [['session.state', STATE], ['decision.pending', PENDING], ['decision.resolved', RESOLVED], ['session.milestone', MILESTONE]]) {
      const ev = build(type, payload);
      await t.test(`${type} 合法样本过，event_id 为 sha256 hex`, () => {
        assert.ok(/^[0-9a-f]{64}$/.test(ev.event_id) && ev.type === type && ev.schema_version === 1, `${type} 合法样本过  →  ` + JSON.stringify(ev.event_id));
      });
    }
    await t.test('session.state 可省 repo/refs（读端容忍缺字段）', () => {
      const p = { ...STATE };
      delete p.repo;
      delete p.refs;
      assert.ok(!throws(() => build('session.state', p)), 'session.state 可省 repo/refs');
    });
    await t.test('decision.resolved 可省 note', () => {
      const p = { ...RESOLVED };
      delete p.note;
      assert.ok(!throws(() => build('decision.resolved', p)), 'decision.resolved 可省 note');
    });
    await t.test('session.milestone 只给必填四项也过（探头字段全不给）', () => {
      const p = { kind: 'pr-merge', repo: 'windsurf-dao', evidence: ['exit_code=0'], milestone_key: 'pr-merge:pr-893' };
      assert.ok(!throws(() => build('session.milestone', p)), 'session.milestone 只给必填四项也过');
    });
  });

  it('②b W5 写口（#897）的真实 payload 原样过', async (t) => {
    const cases = [
      ['decision.pending', W5_PENDING, 'urgency 记 null（两种问用户的工具入参都没这一位）'],
      ['decision.pending', W5_OPEN, '开放问题：options 空、recommend null'],
      ['session.milestone', W5_MILESTONE_UNKNOWN, 'git 探头没查成：三项 null，evidence 写清没查成'],
    ];
    for (const [type, payload, name] of cases) {
      await t.test(`${type}：${name}`, () => {
        let err = null;
        try { build(type, payload); } catch (e) { err = e.message; }
        assert.ok(err === null, `${type}：${name}  →  ` + err);
      });
    }
    await t.test('kind 三个合法值逐个都过', () => {
      const bad = ['commit', 'land', 'pr-merge'].filter(k => throws(() => build('session.milestone', { ...MILESTONE, kind: k })));
      assert.ok(bad.length === 0, 'kind 三个合法值逐个都过  →  误拒 ' + bad.join(','));
    });
  });

  it('③ 必填缺一必被拒（逐字段，不是抽一个）', async (t) => {
    for (const [type, payload] of [['session.state', STATE], ['decision.pending', PENDING], ['decision.resolved', RESOLVED], ['session.milestone', MILESTONE]]) {
      await t.test(`${type}：任一必填缺失都被拒`, () => {
        const holes = requiredHoles(type, payload);
        assert.ok(holes.length === 0, `${type}：任一必填缺失都被拒  →  漏拒 ` + holes.join(','));
      });
    }
    await t.test('decision.resolved 缺 target_decision_id 明确被拒', () => {
      const p = { ...RESOLVED };
      delete p.target_decision_id;
      assert.ok(throws(() => build('decision.resolved', p)), 'decision.resolved 缺 target_decision_id 明确被拒');
    });
    // 这两条是硬钉：上面那个循环是从 schema 派生的，schema 被改软它跟着软；
    // 幂等键与判据出处丢了，里程碑就成了「重复计账 + 说不出 ✓ 从哪来」。
    await t.test('session.milestone 缺 milestone_key 明确被拒（幂等键丢了会重复计账）', () => {
      const p = { ...MILESTONE };
      delete p.milestone_key;
      assert.ok(throws(() => build('session.milestone', p)), 'session.milestone 缺 milestone_key 明确被拒');
    });
    await t.test('session.milestone 缺 evidence 明确被拒（说不出 ✓ 从哪读回来就是打假 ✓）', () => {
      const p = { ...MILESTONE };
      delete p.evidence;
      assert.ok(throws(() => build('session.milestone', p)), 'session.milestone 缺 evidence 明确被拒');
    });
    // evidence 统一成字符串数组（2026-09-04 帅位拍板：不留同名不同形）。下限从 schema 的
    // minItems 读，本文件不抄数字——改坏 schema 的 minItems，下面这两条就是报警器。
    await t.test('session.milestone 的 evidence 是空数组 → 拒（里程碑没证据就不该写）', () => {
      assert.ok(throws(() => build('session.milestone', { ...MILESTONE, evidence: [] })), 'evidence 空数组 → 拒');
    });
    await t.test('session.milestone 的 evidence 写成字符串 → 拒（同名必须同形，注释不是闸）', () => {
      assert.ok(throws(() => build('session.milestone', { ...MILESTONE, evidence: 'exit_code=0；git 探头查到了' })), 'evidence 写成字符串 → 拒');
    });
    await t.test('evidence 一项就够（单元素数组合法：信息一点不丢）', () => {
      assert.ok(!throws(() => build('session.milestone', { ...MILESTONE, evidence: ['exit_code=0'] })), 'evidence 单元素数组合法');
    });
    await t.test('attr.* 的 evidence 与它同形（同一份数组形状，读端不必按 type 分支）', () => {
      const attr = {
        job_id: 'j-891', model: 'x', model_share: 1, brief_share: 0, coord_share: 0, env_share: 0,
        overrun_attr: null, confidence: 0.9, evidence: ['c-j-891'], why: 'fixture',
      };
      assert.ok(!throws(() => build('attr.rule', attr)), 'attr.* 的 evidence 与它同形');
    });
  });

  it('④ 枚举写错必被拒（取值闭集只从 schema 读）', async (t) => {
    const cases = [
      ['session.state', STATE, { phase: '在跑' }, 'phase 非闭集值'],
      ['session.state', STATE, { phase: '' }, 'phase 空串'],
      ['session.state', STATE, { identity: 'worker' }, 'identity 用了英文'],
      ['decision.pending', PENDING, { urgency: '中' }, 'urgency 非急/缓/null'],
      ['decision.resolved', RESOLVED, { by: '审官' }, 'by 非用户/帅'],
      ['session.milestone', MILESTONE, { kind: 'rebase' }, 'kind 非 commit/land/pr-merge'],
      ['session.milestone', MILESTONE, { kind: null }, 'kind 记 null（种类是那一刻就知道的，不许没查成）'],
      ['session.milestone', MILESTONE, { identity: null }, 'identity 写 null（拿不到就整个字段别写）'],
    ];
    for (const [type, base, bad, name] of cases) {
      await t.test(`${type}：${name} → 拒`, () => {
        assert.ok(throws(() => build(type, { ...base, ...bad })), `${type}：${name} → 拒`);
      });
    }
    await t.test('phase 四个合法值逐个都过（枚举不是一刀切全拒）', () => {
      const bad = ['在途', '沉默', '待拍', '收尾'].filter(ph => throws(() => build('session.state', { ...STATE, phase: ph })));
      assert.ok(bad.length === 0, 'phase 四个合法值逐个都过  →  误拒 ' + bad.join(','));
    });
    await t.test('既有类型的枚举也照罩（job.handoff reason 写错 → 拒）', () => {
      const ok = { job_id: 'j-891', from_model: 'a', to_model: 'b', reason: 'quota' };
      assert.ok(!throws(() => build('job.handoff', ok)) && throws(() => build('job.handoff', { ...ok, reason: '换人' })), '既有类型的枚举也照罩');
    });
  });

  it('⑤ decision.pending 的选项不变量', async (t) => {
    await t.test('options 只有一条 → 拒（一个选项不叫拍板）', () => {
      assert.ok(throws(() => build('decision.pending', { ...PENDING, options: [{ label: 'W1 先合' }] })), 'options 只有一条 → 拒');
    });
    await t.test('options 空（开放问题）但给了 recommend → 拒（没选项可推荐 ≠ 推荐了个不存在的）', () => {
      assert.ok(throws(() => build('decision.pending', { ...W5_OPEN, recommend: '随便' })), 'options 空但给了 recommend → 拒');
    });
    await t.test('options 不是数组 → 拒', () => {
      assert.ok(throws(() => build('decision.pending', { ...PENDING, options: 'A/B' })), 'options 不是数组 → 拒');
    });
    await t.test('option 缺 label → 拒', () => {
      assert.ok(throws(() => build('decision.pending', { ...PENDING, options: [{ description: '只写了解释' }, { label: '等三张齐' }] })), 'option 缺 label → 拒');
    });
    await t.test('recommend 不在任何 label 里 → 拒（否则一键选择是死的）', () => {
      assert.ok(throws(() => build('decision.pending', { ...PENDING, recommend: '都别合' })), 'recommend 不在任何 label 里 → 拒');
    });
    await t.test('option 只有 label（不写 description）仍合法', () => {
      assert.ok(!throws(() => build('decision.pending', { ...PENDING, options: [{ label: 'W1 先合' }, { label: '等三张齐' }], recommend: 'W1 先合' })), 'option 只有 label 仍合法');
    });
  });

  it('⑥ digest 才是内容维去重键（event_id 每轮必变）', async (t) => {
    const a = build('session.state', STATE);
    const b = build('session.state', STATE, { ts: TS2, seq: 7 });
    await t.test('同状态不同轮：event_id 变而 digest 不变', () => {
      assert.ok(a.event_id !== b.event_id && a.digest === b.digest, '同状态不同轮：event_id 变而 digest 不变  →  ' + `${a.event_id.slice(0, 8)}/${b.event_id.slice(0, 8)} digest=${a.digest}`);
    });
    await t.test('状态变了 digest 应由写口换新值（换 digest 即换去重键）', () => {
      const c = build('session.state', { ...STATE, doing: '换活了', digest: 'a1b2c3d4e5f60718' });
      assert.ok(c.digest !== a.digest, '状态变了 digest 换新值');
    });
  });

  it('⑦ 落盘 + 读回自证 + 追加不改历史', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1-891-'));
    const w = writeEvent({ dir, type: 'session.state', ts: TS, machine: MACHINE, seq: 0, payload: STATE, schema });
    const back = JSON.parse(fs.readFileSync(w.path, 'utf8'));
    await t.test('写出的文件读回来与内存事件一致（不打没读过的 ✓）', () => {
      assert.ok(back.event_id === w.event.event_id && back.doing === STATE.doing && back.phase === '沉默', '写出的文件读回来与内存事件一致  →  ' + JSON.stringify(back.event_id));
    });
    await t.test('同内容重写被拒（写一次即不可变）', () => {
      assert.ok(throws(() => writeEvent({ dir, type: 'session.state', ts: TS, machine: MACHINE, seq: 0, payload: STATE, schema })), '同内容重写被拒');
    });
    await t.test('同 session 下一轮再写一条合法（每轮末一条，不是每 job 一条）', () => {
      const w2 = writeEvent({ dir, type: 'session.state', ts: TS2, machine: MACHINE, seq: 1, payload: { ...STATE, phase: '收尾', digest: 'b2c3d4e5f6071829' }, schema });
      assert.ok(fs.existsSync(w2.path) && w2.path !== w.path, '同 session 下一轮再写一条合法');
    });
    await t.test('同 target 追加第二条 decision.resolved 合法（追加不改历史）', () => {
      const r1 = writeEvent({ dir, type: 'decision.resolved', ts: TS, machine: MACHINE, seq: 2, payload: RESOLVED, schema });
      const r2 = writeEvent({ dir, type: 'decision.resolved', ts: TS2, machine: MACHINE, seq: 3, payload: { ...RESOLVED, chosen: ['等三张齐'], note: '改主意' }, schema });
      assert.ok(fs.existsSync(r1.path) && fs.existsSync(r2.path), '同 target 追加第二条 decision.resolved 合法');
    });
    await t.test('session.milestone 落盘读回：evidence/milestone_key 原样在', () => {
      const m = writeEvent({ dir, type: 'session.milestone', ts: TS, machine: MACHINE, seq: 4, payload: MILESTONE, schema });
      const mb = JSON.parse(fs.readFileSync(m.path, 'utf8'));
      assert.ok(mb.event_id === m.event.event_id && Array.isArray(mb.evidence) && mb.evidence.join('|') === MILESTONE.evidence.join('|')
        && mb.milestone_key === 'commit:a1b2c3d' && mb.pr_number === null,
      'session.milestone 落盘读回  →  ' + JSON.stringify({ e: mb.evidence, k: mb.milestone_key, pr: mb.pr_number }));
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('⑧ CLI 真写真读（event-write.mjs 端到端）', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1-891-cli-'));
    const run = args => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'event-write.mjs'), ...args], { encoding: 'utf8', cwd: REPO });
    const ok = run(['--type', 'session.state', '--dir', dir, '--machine', MACHINE, '--ts', TS,
      '--session-id', 's-891-cli', '--identity', '工人', '--phase', '沉默',
      '--doing', 'CLI 读回自证', '--next', '交卷', '--blocked', 'false',
      '--pending-decision-id', 'null', '--digest', 'c3d4e5f607182930',
      '--repo', 'windsurf-dao', '--refs', '["#891"]']);
    await t.test('CLI 写 session.state 退出码 0', () => {
      assert.ok(ok.status === 0, 'CLI 写 session.state 退出码 0  →  ' + (ok.stderr || '').trim());
    });
    await t.test('CLI 写出的文件读回：event_id 在、字段在、null 没被写成字符串', () => {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      const ev = files.length === 1 ? JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8')) : null;
      assert.ok(ev && /^[0-9a-f]{64}$/.test(ev.event_id) && ev.pending_decision_id === null && ev.blocked === false && ev.refs[0] === '#891',
        'CLI 写出的文件读回  →  ' + JSON.stringify(ev && { id: ev.event_id.slice(0, 8), p: ev.pending_decision_id, b: ev.blocked }));
    });
    const bad = run(['--type', 'session.state', '--dir', dir, '--machine', MACHINE, '--ts', TS,
      '--session-id', 's-891-bad', '--identity', '工人', '--phase', '瞎写',
      '--doing', 'x', '--next', 'y', '--blocked', 'false',
      '--pending-decision-id', 'null', '--digest', 'd4e5f60718293041']);
    await t.test('CLI 写非法 phase 退出码非 0 且不落盘', () => {
      const n = fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
      assert.ok(bad.status !== 0 && n === 1, 'CLI 写非法 phase 退出码非 0 且不落盘  →  ' + `status=${bad.status} files=${n}`);
    });
    const ms = run(['--type', 'session.milestone', '--dir', dir, '--machine', MACHINE, '--ts', TS2,
      '--kind', 'commit', '--repo', 'windsurf-dao', '--milestone-key', 'commit:a1b2c3d',
      '--commit', 'a1b2c3d', '--branch', 'feat/891-session-events', '--pr-number', 'null',
      '--evidence', '["exit_code=0","commit:a1b2c3d"]']);
    await t.test('CLI 写 session.milestone 退出码 0，evidence 读回是数组不是字符串', () => {
      const hit = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
        .find(e => e.type === 'session.milestone');
      assert.ok(ms.status === 0 && hit && Array.isArray(hit.evidence) && hit.evidence.length === 2
        && hit.milestone_key === 'commit:a1b2c3d' && hit.pr_number === null,
      'CLI 写 session.milestone 退出码 0，evidence 读回是数组  →  ' + `status=${ms.status} ` + (ms.stderr || '').trim().slice(0, 120));
    });
    const badKind = run(['--type', 'session.milestone', '--dir', dir, '--machine', MACHINE, '--ts', TS,
      '--kind', 'rebase', '--repo', 'windsurf-dao', '--milestone-key', 'k', '--evidence', '["exit_code=0"]']);
    await t.test('CLI 写非法 kind 退出码非 0 且不落盘', () => {
      const n = fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
      assert.ok(badKind.status !== 0 && n === 2, 'CLI 写非法 kind 退出码非 0 且不落盘  →  ' + `status=${badKind.status} files=${n}`);
    });
    const badEv = run(['--type', 'session.milestone', '--dir', dir, '--machine', MACHINE, '--ts', TS,
      '--kind', 'commit', '--repo', 'windsurf-dao', '--milestone-key', 'k2', '--evidence', 'exit_code=0']);
    await t.test('CLI 把 evidence 写成字符串 → 退出码非 0 且不落盘（字符串也有 length，只比长度会蒙过去）', () => {
      const n = fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
      assert.ok(badEv.status !== 0 && n === 2, 'CLI evidence 写成字符串 → 拒  →  ' + `status=${badEv.status} files=${n}`);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // W5（PR #897）拿真 event-writer 实测出的洞：除 evidence 外，其余字段的 type 声明
  // 一律没人校验，四条形状漂移全静默落盘。静默失效正是本单要治的病，判据补在写入侧。
  it('⑩ 字段类型合 schema 的 type 声明（W5 实测四条洞）', async (t) => {
    const holes = [
      ['decision.resolved', RESOLVED, { chosen: '每天 8 条' }, 'chosen 写成字符串（声明 array）'],
      ['decision.pending', PENDING, { question: 12345 }, 'question 写成数字（声明 string）'],
      ['session.milestone', MILESTONE, { pr_number: '893' }, 'pr_number 写成字符串（声明 integer|null）'],
      ['session.milestone', MILESTONE, { repo: ['windsurf-dao'] }, 'repo 写成数组（声明 string|null）'],
    ];
    for (const [type, base, bad, name] of holes) {
      await t.test(`${type}：${name} → 拒`, () => {
        assert.ok(throws(() => build(type, { ...base, ...bad })), `${type}：${name} → 拒`);
      });
    }
    await t.test('报错点名字段与期望类型（不是一句「类型不对」）', () => {
      let msg = '';
      try { build('session.milestone', { ...MILESTONE, pr_number: '893' }); } catch (e) { msg = e.message; }
      assert.ok(msg.includes('pr_number') && msg.includes('integer') && msg.includes('string'), '报错点名字段与期望类型  →  ' + msg);
    });

    // 联合类型：声明里列了 null 的照放，没列的照拒——「null 一律拒」和「null 一律放」都是错的
    await t.test('联合类型：pending_decision_id 记 null 合法（声明 string|null）', () => {
      assert.ok(!throws(() => build('session.state', { ...STATE, pending_decision_id: null })), 'pending_decision_id 记 null 合法');
    });
    await t.test('联合类型：pending_decision_id 写数字仍拒', () => {
      assert.ok(throws(() => build('session.state', { ...STATE, pending_decision_id: 42 })), 'pending_decision_id 写数字仍拒');
    });
    await t.test('联合类型：pr_number 记 null 合法、branch/commit/subject 记 null 合法', () => {
      const p = { ...MILESTONE, pr_number: null, branch: null, commit: null, subject: null };
      assert.ok(!throws(() => build('session.milestone', p)), '探头三项与 pr_number 记 null 合法');
    });
    await t.test('声明里没列 null 的字段写 null 仍拒（session.state.doing）', () => {
      assert.ok(throws(() => build('session.state', { ...STATE, doing: null })), 'doing 写 null 仍拒');
    });
    await t.test('urgency: null 仍合法（走 enum 那条，不被类型校验误伤）', () => {
      assert.ok(!throws(() => build('decision.pending', { ...PENDING, urgency: null })), 'urgency: null 仍合法');
    });
    await t.test('identity 整个字段不写仍合法（拿不到就别写，不是写 null）', () => {
      const p = { ...MILESTONE };
      delete p.identity;
      assert.ok(!throws(() => build('session.milestone', p)) && throws(() => build('session.milestone', { ...MILESTONE, identity: null })),
        'identity 不写合法 / 写 null 拒');
    });

    // typeof [] === 'object'：光看 typeof 会把数组当对象放过——与上一轮
    // 「字符串也有 .length」是同一个坑换了形状，所以数组必须先判「是数组」
    await t.test('声明 object 的字段收到数组 → 拒（typeof [] === object 这个坑）', () => {
      const d = { job_id: 'j-891', model: 'x', identity: '工人', work_type: '写码', model_version: 'v', terminal: 't', decision_id: 'dd', price_snapshot: [] };
      assert.ok(throws(() => build('job.dispatch', d)) && !throws(() => build('job.dispatch', { ...d, price_snapshot: {} })),
        '声明 object 的字段收到数组 → 拒');
    });
    await t.test('数组元素类型也校验（refs 里混进数字 → 拒）', () => {
      assert.ok(throws(() => build('session.state', { ...STATE, refs: ['#891', 42] })), 'refs 里混进数字 → 拒');
    });
    await t.test('数组元素报错点明第几项', () => {
      let msg = '';
      try { build('session.state', { ...STATE, refs: ['#891', 42] }); } catch (e) { msg = e.message; }
      assert.ok(msg.includes('第 2 项') && msg.includes('refs'), '数组元素报错点明第几项  →  ' + msg);
    });
    await t.test('整数喂给声明 number 的字段合法（integer ⊂ number，别误伤）', () => {
      const m = { job_id: 'j-891', model: 'x', token_in: 1, token_out: 2, cache_hit: 0, usd_cash: 1 };
      assert.ok(!throws(() => build('job.meter', m)), '整数喂给 number 合法');
    });
    await t.test('小数喂给声明 integer 的字段 → 拒', () => {
      const m = { job_id: 'j-891', model: 'x', token_in: 1.5, token_out: 2, cache_hit: 0, usd_cash: 1 };
      assert.ok(throws(() => build('job.meter', m)), '小数喂给 integer → 拒');
    });
    await t.test('纯 enum 字段（无 type 声明）不被类型校验误伤：四个 phase 值仍全过', () => {
      const bad = ['在途', '沉默', '待拍', '收尾'].filter(ph => throws(() => build('session.state', { ...STATE, phase: ph })));
      assert.ok(bad.length === 0, '纯 enum 字段不被误伤  →  误拒 ' + bad.join(','));
    });
  });

  it('⑨ 派生注释镜子 = schema 闭集（不许在别处另抄清单）', async (t) => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'event-write.mjs'), 'utf8');
    const lines = src.split(/\r?\n/);
    const from = lines.findIndex(l => l.includes('[闭集镜子开始]'));
    const to = lines.findIndex(l => l.includes('[闭集镜子结束]'));
    await t.test('镜子段标记还在（被挪走/删掉即报警，不是静默通过）', () => {
      assert.ok(from >= 0 && to > from, '镜子段标记还在  →  ' + `from=${from} to=${to}`);
    });
    // 只认「纯 ascii 小写 + 点 + 斜杠」的清单行：说明性中文行天然被排除，
    // 类型名不带点的（incident）也收得到。
    const mirrored = lines.slice(from + 1, to)
      .map(l => l.replace(/^\s*\/\//, '').trim())
      .filter(l => /^[a-z][a-z._ /]*$/.test(l))
      .flatMap(l => l.split('/'))
      .map(x => x.trim())
      .filter(x => /^[a-z][a-z_]*(\.[a-z][a-z_]*)?$/.test(x));
    await t.test('镜子与闭集双向一致（一多一少都红）', () => {
      const a = [...new Set(mirrored)].sort().join(',');
      const b = [...meta.closedSet].sort().join(',');
      assert.ok(a === b && mirrored.length === meta.closedSet.length, '镜子与闭集双向一致  →  ' + `镜子=${a} 闭集=${b}`);
    });
  });
});
