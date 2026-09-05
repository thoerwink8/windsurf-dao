// 动作触发写口（#891 W5）：三个写口的正反样本 + 真落盘 + 幂等 + 脱敏。
//
// 判据只来自工具入参/出参与退出码——本测试里没有一条「猜用户说话方式」的样本。
//
// 权威 schema 怎么来（composedSchema）：读真 schemas/events.schema.json，**只给真 schema 里
// 还没有的类型**拿 fixtures/action-writers/proposed-types.json 补位。所以 W1（PR #893）合并后
// 这套测试当场改用 W1 的真定义，不会出现「我的副本与权威各自演进」；同时最后那组「指针自退役」
// 断言会报红，提醒删夹具。
//
// 另有一组「payload 形状必须符合权威 schema 声明」：写入侧只校验必填/enum/跨字段不变量，
// **不校验 JSON Schema 的 type**（PR #893 自述）⇒ 两卡形状对不上时事件照样落盘且无人报警。
// 那组就是这个静默漂移的报警器，并自带故意违规样本验判别力。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AW = path.join(ROOT, 'scripts', 'lib', 'action-writers.mjs');
const HOOK = path.join(ROOT, 'scripts', 'lib', 'action-writers-hook.mjs');
const AW_LOAD = import('file://' + AW.replace(/\\/g, '/'));
const HOOK_LOAD = import('file://' + HOOK.replace(/\\/g, '/'));
const REAL_SCHEMA = path.join(ROOT, 'schemas', 'events.schema.json');
const PROPOSED = path.join(__dirname, 'fixtures', 'action-writers', 'proposed-types.json');

// 测试自己的脱敏 stub：W2 的 redact.mjs 尚未合并，本测试不依赖它的实现，只依赖
// 「redact(text) -> text」这个契约（PR 正文已写明这处依赖 W2）。
const stubRedact = s => String(s)
  .replace(/\bsk-[A-Za-z0-9._~+/=-]{8,}/g, '[REDACTED:sk-key]')
  .replace(/[A-Za-z]:[\\/][^\s"']+/g, '[REDACTED:path]')
  .replace(/(?:^|(?<=\s))\/(?:home|Users|d|c)\/[^\s"']+/g, '[REDACTED:path]');

/**
 * 权威 schema：真 schema 优先，真 schema 还没有的类型才拿夹具补位（#893 合并后夹具自动失效，
 * 测试当场改用 W1 的真定义 —— 不会出现「我的副本与权威各自演进」那种漂移）。
 */
function composedSchema() {
  const real = JSON.parse(fs.readFileSync(REAL_SCHEMA, 'utf8'));
  const proposed = JSON.parse(fs.readFileSync(PROPOSED, 'utf8'));
  const realTitles = new Set((real.oneOf || []).map(d => d.title));
  const fill = proposed.oneOf.filter(d => !realTitles.has(d.title));
  return { ...real, oneOf: [...real.oneOf, ...fill] };
}

/** 从权威 schema 抽某类型某字段的声明（测试自持解析，不复用 event-writer 的 schemaMeta）。 */
function declOf(schema, title, field) {
  const def = (schema.oneOf || []).find(d => d.title === title);
  if (!def) return null;
  for (const part of def.allOf || []) {
    if (part && part.properties && part.properties[field]) return part.properties[field];
  }
  return null;
}

/**
 * 测试侧的形状校验器：payload 每个字段是否符合权威 schema 声明的 type / enum。
 * 为什么要它：写入侧（event-writer）只校验必填、enum 与跨字段不变量，**不校验 JSON Schema
 * 的 type**（PR #893 自述）。所以「W5 写数组、schema 声明字符串」这类两卡对不上的漂移，
 * 事件照样落盘、没有任何东西会当场报警 —— 这一组就是那个报警器。
 * 自持解析（不 import 被检对象的 schemaMeta），返回违规清单（空 = 全合）。
 */
function shapeViolations(schema, title, payload) {
  const jsType = v => (v === null ? 'null' : (Array.isArray(v) ? 'array' : typeof v));
  const bad = [];
  for (const [field, value] of Object.entries(payload || {})) {
    const decl = declOf(schema, title, field);
    if (!decl) continue; // schema 没声明的字段（additionalProperties: true）不管
    if (Array.isArray(decl.enum)) {
      if (!decl.enum.includes(value)) bad.push(`${field}: 值 ${JSON.stringify(value)} 不在 enum ${JSON.stringify(decl.enum)}`);
      continue;
    }
    if (decl.type === undefined) continue;
    const allowed = Array.isArray(decl.type) ? decl.type : [decl.type];
    const actual = jsType(value);
    const norm = actual === 'number' && Number.isInteger(value) ? ['number', 'integer'] : [actual];
    if (!allowed.some(a => norm.includes(a))) {
      bad.push(`${field}: 实产是 ${actual}，schema 声明 ${JSON.stringify(decl.type)}`);
      continue;
    }
    if (actual === 'array' && decl.minItems != null && value.length < decl.minItems) {
      bad.push(`${field}: 数组只有 ${value.length} 项，schema 要求至少 ${decl.minItems}`);
    }
    if (actual === 'array' && decl.items && decl.items.type === 'string' && value.some(x => typeof x !== 'string')) {
      bad.push(`${field}: 数组里有非字符串项，schema 声明 items 是 string`);
    }
  }
  return bad;
}

const ASK_INPUT = {
  questions: [{
    question: '播报闸的每日预算上限定多少条？',
    header: '播报预算',
    multiSelect: false,
    options: [
      { label: '每天 8 条 (Recommended)', description: '按今晚的事件量估，8 条能覆盖里程碑又不吵' },
      { label: '每天 20 条', description: '几乎不压，群里会吵' },
    ],
  }],
};

function preEvent(overrides = {}) {
  return {
    session_id: 'sess-891',
    cwd: 'D:\\frank\\wd-w5-writers',
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: ASK_INPUT,
    ...overrides,
  };
}

function bashEvent({ command, output }) {
  return {
    session_id: 'sess-891',
    cwd: 'D:\\frank\\wd-w5-writers',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: output,
  };
}

const TS = '2026-09-04T21:00:00+08:00';

describe('action-writers · 写口 1 待拍板（PreToolUse）', () => {
  it('AskUserQuestion 正常入参：字段齐、推荐位=第一项、why 有出处', async (t) => {
    const S = await AW_LOAD;
    const r = S.buildDecisionPending({ event: preEvent(), ts: TS, redact: stubRedact });
    await t.test('写一条 decision.pending', () => {
      assert.ok(r.ok && r.writes.length === 1 && r.writes[0].type === 'decision.pending',
        '写一条 decision.pending  →  ' + JSON.stringify(r).slice(0, 200));
    });
    const p = r.writes[0].payload;
    await t.test('五个字段都从入参取到（question/options/recommend/urgency/why）', () => {
      assert.ok(p.question.includes('每日预算')
        && p.options.length === 2
        && p.options[0].label === '每天 8 条 (Recommended)'
        && p.recommend === '每天 8 条 (Recommended)'
        && p.urgency === null
        && p.why.includes('8 条能覆盖里程碑'),
        '五字段  →  ' + JSON.stringify(p));
    });
    await t.test('why 标出处（recommend_description），urgency 没查成记 null 不伪造', () => {
      assert.ok(p.why_source === 'recommend_description' && p.urgency === null,
        'why_source/urgency  →  ' + JSON.stringify({ why_source: p.why_source, urgency: p.urgency }));
    });
    await t.test('asked_by 记的是真触发的工具名', () => {
      assert.ok(p.asked_by === 'AskUserQuestion', 'asked_by  →  ' + p.asked_by);
    });
    await t.test('cwd 是绝对路径，事件里只留末段目录名（不产生绝对路径）', () => {
      assert.ok(p.repo === 'wd-w5-writers' && !/[A-Za-z]:[\\/]/.test(JSON.stringify(p)),
        'repo 只留 basename  →  ' + JSON.stringify(p.repo) + ' / ' + JSON.stringify(p).slice(0, 160));
    });
  });

  it('mirasim 侧 mcp__mirasim__im_ask_user 同样匹配，why 优先取 hint', async (t) => {
    const S = await AW_LOAD;
    const ev = {
      session_id: 'sess-891',
      cwd: '/home/orca/windsurf-dao',
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__mirasim__im_ask_user',
      tool_input: {
        question: '播报闸先上哪一类？',
        header: '播报',
        hint: '今晚三个写口都没接播，先上待拍板最省事',
        options: [{ label: '先上待拍板 (Recommended)', description: '插播即时' }, { label: '先上里程碑' }],
      },
    };
    const r = S.buildDecisionPending({ event: ev, ts: TS, redact: stubRedact });
    await t.test('mirasim 侧也写得出', () => {
      assert.ok(r.ok && r.writes.length === 1, 'mirasim 侧写得出  →  ' + JSON.stringify(r.reason));
    });
    await t.test('why 取 hint 并标 why_source=hint', () => {
      const p = r.writes[0].payload;
      assert.ok(p.why_source === 'hint' && p.why.includes('先上待拍板最省事'), 'why  →  ' + JSON.stringify(p.why));
    });
  });

  it('反样本：缺字段 / 不是问用户的工具 一律不写且说清没查成', async (t) => {
    const S = await AW_LOAD;
    const missing = S.buildDecisionPending({ event: preEvent({ tool_input: { header: '空题' } }), ts: TS, redact: stubRedact });
    await t.test('入参没 question ⇒ 不写 + reason 含没查成', () => {
      assert.ok(!missing.ok && missing.writes.length === 0 && /没查成/.test(missing.reason),
        '缺字段不写  →  ' + JSON.stringify(missing));
    });
    const other = S.buildDecisionPending({ event: preEvent({ tool_name: 'Read' }), ts: TS, redact: stubRedact });
    await t.test('Read 这类工具 ⇒ 不写', () => {
      assert.ok(!other.ok && other.writes.length === 0, '非问用户工具不写  →  ' + JSON.stringify(other));
    });
    const noTs = S.buildDecisionPending({ event: preEvent(), redact: stubRedact });
    await t.test('没注入 ts ⇒ 不写（时间必须由调用方给）', () => {
      assert.ok(!noTs.ok && /ts/.test(noTs.reason), '缺 ts 不写  →  ' + JSON.stringify(noTs.reason));
    });
  });

  it('一次问多题 ⇒ 一题一条，decision_id 互不相同', async (t) => {
    const S = await AW_LOAD;
    const two = {
      questions: [
        { question: '第一题：预算几条？', options: [{ label: 'A' }, { label: 'B' }] },
        { question: '第二题：先上哪个面？', options: [{ label: 'C' }, { label: 'D' }] },
      ],
    };
    const r = S.buildDecisionPending({ event: preEvent({ tool_input: two }), ts: TS, redact: stubRedact });
    await t.test('两题两条事件，id 不同', () => {
      assert.ok(r.ok && r.writes.length === 2
        && r.writes[0].decision_id !== r.writes[1].decision_id,
        '两题两条  →  ' + JSON.stringify(r.writes.map(w => w.decision_id)));
    });
  });
});

describe('action-writers · decision.pending 的 options 合法形状（schema 跨字段不变量，#893）', () => {
  it('工具只给一个选项 ⇒ 降级成开放问题（空 options + recommend null），label 不静默丢', async (t) => {
    const S = await AW_LOAD;
    const one = {
      question: '要不要现在合？',
      hint: '只有一条路',
      options: [{ label: '合', description: '没有别的选项' }],
    };
    const r = S.buildDecisionPending({
      event: preEvent({ tool_name: 'mcp__mirasim__im_ask_user', tool_input: one }),
      ts: TS,
      redact: stubRedact,
    });
    const p = r.writes[0].payload;
    await t.test('options 空 + recommend null（schema 拒单选项，也拒空 options 配非 null recommend）', () => {
      assert.ok(Array.isArray(p.options) && p.options.length === 0 && p.recommend === null,
        '降级形状  →  ' + JSON.stringify({ options: p.options, recommend: p.recommend }));
    });
    await t.test('被丢掉的那条 label 留在 options_note 里（不静默丢）', () => {
      assert.ok(typeof p.options_note === 'string' && p.options_note.includes('合'),
        'options_note  →  ' + JSON.stringify(p.options_note));
    });
  });

  it('开放问题（工具不给选项）⇒ 空 options + recommend null', async (t) => {
    const S = await AW_LOAD;
    const r = S.buildDecisionPending({
      event: preEvent({ tool_name: 'mcp__mirasim__im_ask_user', tool_input: { question: '你怎么看？', hint: '开放问题' } }),
      ts: TS,
      redact: stubRedact,
    });
    const p = r.writes[0].payload;
    await t.test('空 options 配 recommend null，且没有 options_note（本来就没选项）', () => {
      assert.ok(p.options.length === 0 && p.recommend === null && p.options_note === undefined,
        '开放问题  →  ' + JSON.stringify({ options: p.options, recommend: p.recommend, note: p.options_note }));
    });
  });

  it('两条及以上 ⇒ 原样保留，recommend 必命中某条 label', async (t) => {
    const S = await AW_LOAD;
    const p = S.buildDecisionPending({ event: preEvent(), ts: TS, redact: stubRedact }).writes[0].payload;
    await t.test('recommend 在 options 的 label 里（schema 拒指向不存在的选项）', () => {
      assert.ok(p.options.length === 2 && p.options.map(o => o.label).includes(p.recommend),
        'recommend 命中  →  ' + JSON.stringify({ labels: p.options.map(o => o.label), recommend: p.recommend }));
    });
  });
});

describe('action-writers · 写口 2 拍板结果（PostToolUse）', () => {
  it('权威出参形状 responses[].selectedOptions[].label：chosen 对、对得上 Pre 侧、by=用户', async (t) => {
    const S = await AW_LOAD;
    const pre = S.buildDecisionPending({ event: preEvent(), ts: TS, redact: stubRedact });
    const post = S.buildDecisionResolved({
      event: preEvent({
        hook_event_name: 'PostToolUse',
        tool_response: { responses: [{ selectedOptions: [{ label: '每天 8 条 (Recommended)' }] }] },
      }),
      ts: '2026-09-04T21:00:09+08:00',
      redact: stubRedact,
    });
    await t.test('写一条 decision.resolved', () => {
      assert.ok(post.ok && post.writes.length === 1 && post.writes[0].type === 'decision.resolved',
        '写一条 resolved  →  ' + JSON.stringify(post).slice(0, 200));
    });
    const p = post.writes[0].payload;
    await t.test('target_decision_id 对上 Pre 侧那条（ts 不同也照样对上）', () => {
      assert.ok(p.target_decision_id === pre.writes[0].decision_id,
        'id 对上  →  ' + p.target_decision_id + ' vs ' + pre.writes[0].decision_id);
    });
    await t.test('chosen = 用户选的 label，by=用户，freeform=false', () => {
      assert.ok(p.chosen.length === 1 && p.chosen[0] === '每天 8 条 (Recommended)'
        && p.by === '用户' && p.freeform === false,
        'chosen/by/freeform  →  ' + JSON.stringify(p));
    });
    await t.test('chosen_source 记下从哪个形状读到的（不打假 ✓）', () => {
      assert.ok(p.chosen_source === 'responses[]', 'chosen_source  →  ' + p.chosen_source);
    });
  });

  it('用户自由输入（不在选项里）也要能记，并标 freeform=true', async (t) => {
    const S = await AW_LOAD;
    const post = S.buildDecisionResolved({
      event: preEvent({
        hook_event_name: 'PostToolUse',
        tool_response: { responses: [{ answer: '都不选，先只播事故，其他攒着' }] },
      }),
      ts: TS,
      redact: stubRedact,
    });
    await t.test('自由输入记下来且 freeform=true', () => {
      const p = post.ok && post.writes[0].payload;
      assert.ok(post.ok && p.chosen[0].includes('先只播事故') && p.freeform === true,
        '自由输入  →  ' + JSON.stringify(post.ok ? p : post.reason));
    });
  });

  it('反样本：出参认不出答案 ⇒ 不写 resolved（不许拿空当「选了空」）', async (t) => {
    const S = await AW_LOAD;
    for (const [name, resp] of [
      ['出参为空', undefined],
      ['出参是空串', ''],
      ['出参里没有答案字段', { responses: [{ header: '播报预算' }] }],
    ]) {
      const r = S.buildDecisionResolved({
        event: preEvent({ hook_event_name: 'PostToolUse', tool_response: resp }),
        ts: TS,
        redact: stubRedact,
      });
      await t.test(`${name} ⇒ 不写 + 说没查成`, () => {
        assert.ok(!r.ok && r.writes.length === 0 && /没查成/.test(r.reason),
          `${name}  →  ` + JSON.stringify(r));
      });
    }
  });

  it('出参字段名两套说法都认（tool_response / tool_result）', async (t) => {
    const S = await AW_LOAD;
    const ev = preEvent({ hook_event_name: 'PostToolUse' });
    delete ev.tool_response;
    ev.tool_result = { responses: [{ selectedOptions: [{ label: '每天 20 条' }] }] };
    const r = S.buildDecisionResolved({ event: ev, ts: TS, redact: stubRedact });
    await t.test('tool_result 也读得到', () => {
      assert.ok(r.ok && r.writes[0].payload.chosen[0] === '每天 20 条', 'tool_result  →  ' + JSON.stringify(r.reason || r.writes[0].payload.chosen));
    });
  });
});

describe('action-writers · 写口 3 里程碑（Bash PostToolUse，真成功才写）', () => {
  it('git commit 退出码 0 ⇒ 写，evidence 记清判据出处', async (t) => {
    const S = await AW_LOAD;
    const r = S.buildMilestone({
      event: bashEvent({ command: 'git commit -m "feat: x"', output: { exit_code: 0, stdout: '1 file changed', stderr: '', interrupted: false } }),
      ts: TS,
      redact: stubRedact,
      gitProbe: () => ({ commit: 'abc1234', subject: 'feat: x', branch: 'feat/891-action-writers' }),
    });
    await t.test('写一条里程碑，kind=commit', () => {
      assert.ok(r.ok && r.writes.length === 1 && r.writes[0].payload.kind === 'commit',
        'kind=commit  →  ' + JSON.stringify(r).slice(0, 200));
    });
    await t.test('evidence 是字符串数组，每项可复查（exit_code=0 / commit:<短 sha>）', () => {
      const ev = r.writes[0].payload.evidence;
      assert.ok(Array.isArray(ev) && ev.length >= 1 && ev.every(x => typeof x === 'string')
        && ev.some(x => /exit_code=0/.test(x)) && ev.some(x => x === 'commit:abc1234'),
        'evidence  →  ' + JSON.stringify(ev));
    });
    await t.test('幂等键锚在真 sha 上', () => {
      assert.ok(r.writes[0].milestone_key === 'commit:abc1234', 'milestone_key  →  ' + r.writes[0].milestone_key);
    });
  });

  it('【判据核心】命令没成功 / 成没成没查成 ⇒ 一律不写', async (t) => {
    const S = await AW_LOAD;
    const cases = [
      ['退出码非 0', { exit_code: 1, stdout: '', stderr: 'nothing to commit', interrupted: false }, /没成功/],
      ['被中断（退出码却是 0）', { exit_code: 0, interrupted: true }, /没成功/],
      ['显式错误标记', { is_error: true, stdout: '' }, /没成功/],
      ['出参里没有退出码', { stdout: 'ok', stderr: '' }, /没查成/],
      ['出参为空', undefined, /没查成/],
      ['出参是字符串（拿不到退出码）', '1 file changed', /没查成/],
    ];
    for (const [name, output, re] of cases) {
      const r = S.buildMilestone({
        event: bashEvent({ command: 'git commit -m "x"', output }),
        ts: TS,
        redact: stubRedact,
        gitProbe: () => ({ commit: 'abc1234' }),
      });
      await t.test(`${name} ⇒ 不写`, () => {
        assert.ok(!r.ok && r.writes.length === 0 && re.test(r.reason), `${name}  →  ` + JSON.stringify(r));
      });
    }
  });

  it('命令识别：真动作认、假动作不认', async (t) => {
    const S = await AW_LOAD;
    const yes = [
      ['cd 后提交（常见形态）', 'cd /d/frank/wd-w5-writers && git commit -m "feat"', 'commit', null],
      ['git -C 形态', 'git -C /d/frank/wd-w5-writers commit -m "feat"', 'commit', null],
      ['land 落地', 'node /d/frank/windsurf-dao/scripts/land.mjs', 'land', null],
      ['gh pr merge 带单号', 'gh pr merge 891 --squash --delete-branch', 'pr-merge', 891],
    ];
    for (const [name, cmd, kind, pr] of yes) {
      const c = S.classifyMilestoneCommand(cmd);
      await t.test(`${name} ⇒ 认出 ${kind}`, () => {
        assert.ok(c.ok && c.matches[0].kind === kind && c.matches[0].pr_number === pr,
          `${name}  →  ` + JSON.stringify(c));
      });
    }
    const no = [
      ['引号里的字样不算', 'echo "git commit -m x"'],
      ['--dry-run 什么都没落地', 'git commit --dry-run -m "x"'],
      ['git status 不是里程碑', 'git status --short'],
      ['land.mjs --help 之外的普通 node', 'node scripts/dao-check.mjs'],
    ];
    for (const [name, cmd] of no) {
      const c = S.classifyMilestoneCommand(cmd);
      await t.test(`${name} ⇒ 不认`, () => {
        assert.ok(!c.ok && c.matches.length === 0, `${name}  →  ` + JSON.stringify(c));
      });
    }
    const multi = S.classifyMilestoneCommand('git commit -m "x" && gh pr merge 891 --squash');
    await t.test('一条命令两个里程碑动作 ⇒ 不写（单个退出码归不到具体动作）', () => {
      assert.ok(!multi.ok && multi.matches.length === 2 && /归不到具体动作/.test(multi.reason),
        '多动作  →  ' + JSON.stringify(multi));
    });
    const notBash = S.buildMilestone({
      event: { tool_name: 'Write', hook_event_name: 'PostToolUse', tool_input: { command: 'git commit -m x' }, tool_response: { exit_code: 0 } },
      ts: TS,
      redact: stubRedact,
    });
    await t.test('非 Bash 工具 ⇒ 不写', () => {
      assert.ok(!notBash.ok && /不是 Bash/.test(notBash.reason), '非 Bash  →  ' + JSON.stringify(notBash.reason));
    });
  });

  it('git 探头没查成不留假 ✓：commit/branch 记 null，evidence 说清', async (t) => {
    const S = await AW_LOAD;
    const r = S.buildMilestone({
      event: bashEvent({ command: 'git commit -m "x"', output: { exit_code: 0, interrupted: false } }),
      ts: TS,
      redact: stubRedact,
      gitProbe: () => ({ error: 'not a git repository' }),
    });
    await t.test('探头失败仍写事件，但字段是 null + evidence 标没查成', () => {
      const p = r.ok && r.writes[0].payload;
      assert.ok(r.ok && p.commit === null && p.branch === null
        && p.evidence.some(x => /git 探头没查成/.test(x)),
        '探头失败  →  ' + JSON.stringify(r.ok ? p : r.reason));
    });
  });
});

describe('action-writers · 脱敏是写入前置条件', () => {
  it('payload 里的 key 形状串被打码，绝对路径不出现', async (t) => {
    const S = await AW_LOAD;
    const r = S.buildDecisionPending({
      event: preEvent({
        tool_input: {
          questions: [{
            question: '网关 key sk-abcdef1234567890 该换吗？',
            options: [{ label: '换', description: '旧 key 是 sk-abcdef1234567890，落在 D:\\frank\\keys\\gw.txt' }],
          }],
        },
      }),
      ts: TS,
      redact: stubRedact,
    });
    const text = JSON.stringify(r.writes[0].payload);
    await t.test('sk- 串不出现在事件里', () => {
      assert.ok(!/sk-abcdef/.test(text) && /REDACTED:sk-key/.test(text), 'sk 打码  →  ' + text.slice(0, 240));
    });
    await t.test('绝对路径不出现在事件里', () => {
      assert.ok(!/[A-Za-z]:[\\/]frank/.test(text), '绝对路径  →  ' + text.slice(0, 240));
    });
  });

  it('redact 缺席或坏了 ⇒ 抛错拒绝裸写（fail-closed）', async (t) => {
    const S = await AW_LOAD;
    await t.test('redact 不是函数 ⇒ 抛', () => {
      assert.throws(() => S.redactDeep({ a: 'x' }, null), /拒绝裸写/, 'redact 缺席');
    });
    await t.test('redact 返回非字符串 ⇒ 抛', () => {
      assert.throws(() => S.redactDeep({ a: 'x' }, () => 42), /拒绝裸写/, 'redact 返回非串');
    });
  });
});

describe('action-writers · payload 形状必须符合权威 schema 声明（写入侧不校验 type，这是报警器）', () => {
  it('三个写口的实产逐字段合权威声明（type / enum / items / minItems）', async (t) => {
    const S = await AW_LOAD;
    const schema = composedSchema();
    const pending = S.buildDecisionPending({ event: preEvent(), ts: TS, redact: stubRedact }).writes[0];
    const resolved = S.buildDecisionResolved({
      event: preEvent({ hook_event_name: 'PostToolUse', tool_response: { responses: [{ selectedOptions: [{ label: '每天 8 条 (Recommended)' }] }] } }),
      ts: TS,
      redact: stubRedact,
    }).writes[0];
    const milestone = S.buildMilestone({
      event: bashEvent({ command: 'git commit -m "x"', output: { exit_code: 0, interrupted: false } }),
      ts: TS,
      redact: stubRedact,
      gitProbe: () => ({ commit: 'abc1234', subject: 'x', branch: 'b' }),
    }).writes[0];
    for (const w of [pending, resolved, milestone]) {
      const bad = shapeViolations(schema, w.type, w.payload);
      await t.test(`${w.type} 实产合声明`, () => {
        assert.ok(bad.length === 0, `${w.type} 与权威 schema 声明对不上  →  ` + bad.join('；'));
      });
    }
  });

  it('探头没查成那一路（三项 null）也合声明', async (t) => {
    const S = await AW_LOAD;
    const schema = composedSchema();
    const w = S.buildMilestone({
      event: bashEvent({ command: 'gh pr merge 897 --squash', output: { exit_code: 0, interrupted: false } }),
      ts: TS,
      redact: stubRedact,
      gitProbe: () => ({ error: 'not a git repository' }),
    }).writes[0];
    await t.test('null 三项 + pr_number 整数 都合声明', () => {
      const bad = shapeViolations(schema, w.type, w.payload);
      assert.ok(bad.length === 0 && w.payload.pr_number === 897, '合声明  →  ' + (bad.join('；') || JSON.stringify(w.payload.pr_number)));
    });
  });

  it('校验器有判别力：故意造两条违规实产，必须被点名', async (t) => {
    const schema = composedSchema();
    const evStr = shapeViolations(schema, 'session.milestone', { evidence: 'exit_code=0；git 探头查到了' });
    await t.test('evidence 写成字符串 ⇒ 被点名（这正是本轮要改的那处）', () => {
      assert.ok(evStr.length === 1 && /evidence/.test(evStr[0]), 'evidence 字符串  →  ' + JSON.stringify(evStr));
    });
    const bads = shapeViolations(schema, 'decision.pending', { urgency: '中' })
      .concat(shapeViolations(schema, 'decision.resolved', { by: '机器人', chosen: 'A' }))
      .concat(shapeViolations(schema, 'session.milestone', { evidence: [], identity: null }));
    await t.test('urgency:"中" / by:"机器人" / chosen 是字符串 / evidence 空数组 / identity:null 五处全被点名', () => {
      assert.ok(bads.length === 5, '违规清单  →  ' + JSON.stringify(bads));
    });
  });

  it('by 只能是「用户」或「帅」，写口给的是用户', async (t) => {
    const S = await AW_LOAD;
    const schema = composedSchema();
    const decl = declOf(schema, 'decision.resolved', 'by');
    const w = S.buildDecisionResolved({
      event: preEvent({ hook_event_name: 'PostToolUse', tool_response: { responses: [{ answer: '自由输入' }] } }),
      ts: TS,
      redact: stubRedact,
    }).writes[0];
    await t.test('权威 enum 含「用户」，实产就是它', () => {
      assert.ok(decl.enum.includes(w.payload.by) && w.payload.by === '用户',
        'by  →  ' + JSON.stringify({ enum: decl.enum, got: w.payload.by }));
    });
  });

  it('单选项那一路：pending 降级不影响 resolved 的 freeform 判定（选项真相不丢）', async (t) => {
    const S = await AW_LOAD;
    const one = { question: '要不要现在合？', options: [{ label: '合' }] };
    const picked = S.buildDecisionResolved({
      event: preEvent({ tool_name: 'mcp__mirasim__im_ask_user', tool_input: one, hook_event_name: 'PostToolUse', tool_response: { responses: [{ selectedOptions: [{ label: '合' }] }] } }),
      ts: TS,
      redact: stubRedact,
    }).writes[0].payload;
    await t.test('用户选了那唯一选项 ⇒ freeform=false（不因 pending 降级而误判自由输入）', () => {
      assert.ok(picked.freeform === false && picked.chosen[0] === '合',
        'freeform  →  ' + JSON.stringify({ freeform: picked.freeform, chosen: picked.chosen }));
    });
  });
});

describe('action-writers-hook · 真落盘 / 幂等 / 缺类型降级 / 不阻断', () => {
  function tmpEnv() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ledger-'));
    const schemaFile = path.join(dir, 'events.schema.json');
    fs.writeFileSync(schemaFile, JSON.stringify(composedSchema(), null, 2));
    return { dir, env: { LEDGER_EVENTS_DIR: dir, DAO_EVENTS_SCHEMA: schemaFile } };
  }
  function eventsIn(dir) {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'events.schema.json')
      .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  }

  it('待拍板样本喂进 hook 入口 ⇒ 真落盘，读回字段齐、已脱敏', async (t) => {
    const H = await HOOK_LOAD;
    const { dir, env } = tmpEnv();
    const r = await H.runHook({ stdinText: JSON.stringify(preEvent()), env, root: ROOT });
    await t.test('exit 恒 0（hook 只增不阻）', () => {
      assert.ok(r.exit === 0, 'exit  →  ' + r.exit);
    });
    await t.test('真写了一条 decision.pending 到盘上', () => {
      assert.ok(r.written.length === 1 && r.written[0].type === 'decision.pending' && fs.existsSync(r.written[0].path),
        '落盘  →  ' + JSON.stringify({ written: r.written, notes: r.notes }));
    });
    const onDisk = eventsIn(dir);
    await t.test('读回的事件字段齐（含 event_id / decision_id / recommend）', () => {
      const e = onDisk[0];
      assert.ok(onDisk.length === 1 && e.type === 'decision.pending' && e.event_id && e.decision_id
        && e.recommend === '每天 8 条 (Recommended)' && e.asked_by === 'AskUserQuestion',
        '读回  →  ' + JSON.stringify(onDisk).slice(0, 300));
    });
    await t.test('脱敏来源被记下来（不是「大概过了」）', () => {
      assert.ok(r.notes.some(n => /^脱敏来源：/.test(n)), 'notes  →  ' + JSON.stringify(r.notes));
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('同一动作重复触发 ⇒ 幂等，账里仍只有一条', async (t) => {
    const H = await HOOK_LOAD;
    const { dir, env } = tmpEnv();
    const stdinText = JSON.stringify(preEvent());
    await H.runHook({ stdinText, env, root: ROOT });
    const again = await H.runHook({ stdinText, env, root: ROOT });
    await t.test('第二次不写且不报失败', () => {
      assert.ok(again.exit === 0 && again.written.length === 0 && again.notes.some(n => /幂等|重复/.test(n)),
        '第二次  →  ' + JSON.stringify(again));
    });
    await t.test('账里仍只有一条 decision.pending', () => {
      const n = eventsIn(dir).filter(e => e.type === 'decision.pending').length;
      assert.ok(n === 1, '条数  →  ' + n);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('schema 闭集里没有该类型 ⇒ 跳过并说明，绝不改 schema、绝不阻断', async (t) => {
    const H = await HOOK_LOAD;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-noschema-'));
    const r = await H.runHook({
      stdinText: JSON.stringify(preEvent()),
      env: { LEDGER_EVENTS_DIR: dir, DAO_EVENTS_SCHEMA: REAL_SCHEMA },
      root: ROOT,
    });
    await t.test('不写 + notes 点名闭集缺该类型 + exit 0', () => {
      assert.ok(r.exit === 0 && r.written.length === 0
        && r.notes.some(n => /不在 schema 闭集里/.test(n)),
        '缺类型降级  →  ' + JSON.stringify(r));
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('脏输入 / 非匹配工具 ⇒ exit 0 不抛不写', async (t) => {
    const H = await HOOK_LOAD;
    const { dir, env } = tmpEnv();
    for (const [name, text] of [
      ['空 stdin', ''],
      ['不是 JSON', 'this is not json'],
      ['JSON 坏了', '{"tool_name":'],
      ['非匹配工具', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x' } })],
    ]) {
      const r = await H.runHook({ stdinText: text, env, root: ROOT });
      await t.test(`${name} ⇒ exit 0 不写`, () => {
        assert.ok(r.exit === 0 && r.written.length === 0 && r.notes.length > 0, `${name}  →  ` + JSON.stringify(r));
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('里程碑真落盘：git commit 样本 + 真 git 探头（本仓）', async (t) => {
    const H = await HOOK_LOAD;
    const { dir, env } = tmpEnv();
    const r = await H.runHook({
      stdinText: JSON.stringify(bashEvent({
        command: 'git commit -m "test"',
        output: { exit_code: 0, stdout: '1 file changed', stderr: '', interrupted: false },
      })),
      env,
      root: ROOT,
    });
    await t.test('落盘一条 session.milestone', () => {
      assert.ok(r.written.length === 1 && r.written[0].type === 'session.milestone',
        '落盘  →  ' + JSON.stringify({ written: r.written, notes: r.notes }));
    });
    await t.test('kind/evidence 齐，事件里没有绝对路径', () => {
      const e = eventsIn(dir).find(x => x.type === 'session.milestone');
      assert.ok(e && e.kind === 'commit' && Array.isArray(e.evidence) && e.evidence.some(x => /exit_code=0/.test(x))
        && !/[A-Za-z]:[\\/]frank/.test(JSON.stringify(e)),
        '里程碑事件  →  ' + JSON.stringify(e));
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gitProbeAt 在本仓真跑得出短 sha 与分支（不是「执行到了」）', async (t) => {
    const H = await HOOK_LOAD;
    const g = H.gitProbeAt({ cwd: ROOT });
    await t.test('真读回 sha/分支', () => {
      assert.ok(!g.error && /^[0-9a-f]{7,}$/.test(String(g.commit)) && g.branch,
        'git 探头  →  ' + JSON.stringify(g));
    });
    const bad = H.gitProbeAt({ cwd: undefined });
    await t.test('没给 cwd ⇒ 报 error，不假装查过', () => {
      assert.ok(bad.error, '没 cwd  →  ' + JSON.stringify(bad));
    });
  });
});

describe('action-writers · 提议类型夹具的自退役报警', () => {
  it('三个类型一旦进了真 schema，本夹具就该删（此断言即报警器）', async (t) => {
    const real = JSON.parse(fs.readFileSync(REAL_SCHEMA, 'utf8'));
    const realTitles = new Set((real.oneOf || []).map(d => d.title));
    const proposed = JSON.parse(fs.readFileSync(PROPOSED, 'utf8'));
    const landed = proposed.oneOf.map(d => d.title).filter(t2 => realTitles.has(t2));
    await t.test('夹具与真 schema 不重叠（重叠 ⇒ 删夹具与本断言）', () => {
      assert.ok(landed.length === 0,
        '这些类型已进真 schema，请删 tests/fixtures/action-writers/proposed-types.json 及本断言  →  ' + landed.join(', '));
    });
    await t.test('夹具本身没空（零样本 ⇒ 本次等于没查）', () => {
      assert.ok(Array.isArray(proposed.oneOf) && proposed.oneOf.length === 3,
        '夹具条数  →  ' + (proposed.oneOf || []).length);
    });
  });
});
