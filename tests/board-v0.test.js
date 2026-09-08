// 看板 v0（#818）：一张表 + 超时告警 + 「状态」回表。
//
// 头等大事仍是「没查成」与「没有 / 超时」分得开。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const toUrl = (p) => 'file://' + p.replace(/\\/g, '/');
const BOARD = import(toUrl(path.join(REPO, 'scripts', 'lib', 'board-v0.mjs')));
const COLLECT = import(toUrl(path.join(REPO, 'scripts', 'lib', 'board-collect.mjs')));
const WATCH = import(toUrl(path.join(REPO, 'scripts', 'board-watch.mjs')));
const CORE = import(toUrl(path.join(REPO, 'scripts', 'lib', 'feishu-triage-core.mjs')));
const PROFILE = import(toUrl(path.join(REPO, 'scripts', 'lib', 'feishu-group-profile.mjs')));
const POLICY = import(toUrl(path.join(REPO, 'scripts', 'lib', 'dispatch-policy-check.mjs')));
const CMD = import(toUrl(path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs')));

const NOW = '2026-09-07T12:00:00Z';
const HOURS_AGO = (h) => new Date(Date.parse(NOW) - h * 3600000).toISOString();

const okEnv = (items) => ({ scanned: true, items });
const deadEnv = (why) => ({ scanned: false, error: why });

function issue(over = {}) {
  const createdAt = over.createdAt || HOURS_AGO(1);
  const base = {
    number: 818, title: '看板 v0', createdAt,
    labels: [{ name: '已消歧' }, { name: 'model/grok-4.6' }],
  };
  const merged = { ...base, ...over };
  if (!Object.prototype.hasOwnProperty.call(over, 'events')) {
    merged.events = [{ event: 'labeled', label: { name: '已消歧' }, created_at: merged.createdAt }];
  }
  return merged;
}
function pr(over = {}) {
  const createdAt = over.createdAt || HOURS_AGO(2);
  const base = {
    number: 1108, title: '看板实现', createdAt, isDraft: true,
    reviewDecision: '', labels: [{ name: 'model/grok-4.6' }],
  };
  const merged = { ...base, ...over };
  if (!Object.prototype.hasOwnProperty.call(over, 'events')) {
    const names = (merged.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
    const at = merged.createdAt;
    if (names.includes('卡死/自动化认输') || names.includes('卡死/等用户')) {
      const hit = names.includes('卡死/自动化认输') ? '卡死/自动化认输' : '卡死/等用户';
      merged.events = [{ event: 'labeled', label: { name: hit }, created_at: at }];
    } else if (String(merged.reviewDecision).toUpperCase() === 'CHANGES_REQUESTED') {
      merged.events = [{ event: 'reviewed', state: 'changes_requested', submitted_at: at }];
    } else if (String(merged.reviewDecision).toUpperCase() === 'APPROVED') {
      merged.events = [{ event: 'reviewed', state: 'approved', submitted_at: at }];
    } else if (merged.isDraft === true) {
      merged.events = [{ event: 'convert_to_draft', created_at: at }];
    } else {
      merged.events = [{ event: 'ready_for_review', created_at: at }];
    }
  }
  return merged;
}
function order(over = {}) {
  const ts = over.ts || HOURS_AGO(0.5);
  const status = over.status || 'running';
  const base = {
    id: 'dq-1', ts, issue: 818, name: '看板 v0', status,
    model: 'grok-4.6',
    runningAt: status === 'running' ? ts : null,
  };
  return { ...base, ...over };
}

describe('看板行：三态信封', () => {
  it('三源齐：issue / 合并请求 / 排队单各一行，含阶段、耗时、模型', async () => {
    const S = await BOARD;
    const board = S.renderBoard({
      now: NOW,
      issues: okEnv([issue()]),
      prs: okEnv([pr()]),
      queue: okEnv([order()]),
      ledger: okEnv([]),
    });
    assert.equal(board.rows.length, 3);
    const iss = board.rows.find((r) => r.kind === 'issue');
    const p = board.rows.find((r) => r.kind === 'pr');
    const q = board.rows.find((r) => r.kind === 'queue');
    assert.equal(iss.stage, '已消歧待派');
    assert.equal(iss.elapsedHours, 1);
    assert.equal(iss.model, 'grok-4.6');
    assert.equal(iss.state, 'green');
    assert.equal(p.stage, '工人干活');
    assert.equal(p.elapsedHours, 2);
    assert.equal(p.model, 'grok-4.6');
    assert.equal(q.stage, '执行中');
    assert.equal(q.elapsedHours, 0.5);
    assert.equal(board.sources.issues.state, 'green');
    assert.equal(board.sources.prs.state, 'green');
    assert.equal(board.sources.queue.state, 'green');
  });

  it('源挂掉只坏自己那几行，不许显示成一切正常', async () => {
    const S = await BOARD;
    const board = S.renderBoard({
      now: NOW,
      issues: deadEnv('gh 超时'),
      prs: okEnv([pr()]),
      queue: okEnv([]),
      ledger: deadEnv('账本目录不在'),
    });
    const iss = board.rows.filter((r) => r.kind === 'issue');
    assert.equal(iss.length, 1);
    assert.equal(iss[0].state, 'unscanned');
    assert.match(iss[0].why, /gh 超时/);
    const p = board.rows.find((r) => r.kind === 'pr');
    assert.equal(p.state, 'green');
    assert.equal(p.id, '1108');
    assert.equal(board.sources.issues.state, 'unscanned');
    assert.equal(board.sources.prs.state, 'green');
    assert.equal(board.sources.ledger.state, 'unscanned');
    const text = S.formatBoardTable(board);
    assert.match(text, /没查成/);
    assert.match(text, /合并请求 #1108/);
    assert.equal(S.plainViolations(text).length, 0);
  });

  it('账本补模型：标签没有 model/ 时用 job.dispatch', async () => {
    const S = await BOARD;
    const board = S.renderBoard({
      now: NOW,
      issues: okEnv([issue({ labels: [{ name: '已消歧' }] })]),
      prs: okEnv([]),
      queue: okEnv([]),
      ledger: okEnv([{ type: 'job.dispatch', issue: 818, model: 'gpt-5.6-luna' }]),
    });
    assert.equal(board.rows[0].model, 'gpt-5.6-luna');
  });
});

describe('阶段超时纯函数', () => {
  it('墙钟超阈值 → 该报', async () => {
    const S = await BOARD;
    const board = S.renderBoard({
      now: NOW,
      issues: okEnv([issue({ createdAt: HOURS_AGO(5) })]),
      prs: okEnv([]),
      queue: okEnv([]),
      ledger: okEnv([]),
      thresholdHours: 4,
    });
    assert.equal(board.rows[0].state, 'red');
    const plan = S.planStageTimeoutAlerts({ rows: board.rows, thresholdHours: 4 });
    assert.equal(plan.alerts.length, 1);
    assert.equal(plan.alerts[0].key, 'issue:818:已消歧待派');
    assert.equal(S.plainViolations(plan.alerts[0].text).length, 0);
    assert.match(plan.alerts[0].text, /超过 4 小时/);
  });

  it('同主体同阶段已报过且未跨阶段 → 不重报', async () => {
    const S = await BOARD;
    const board = S.renderBoard({
      now: NOW,
      issues: okEnv([issue({ createdAt: HOURS_AGO(5) })]),
      prs: okEnv([]),
      queue: okEnv([]),
      ledger: okEnv([]),
    });
    const once = S.planStageTimeoutAlerts({
      rows: board.rows, thresholdHours: 4,
      ledger: { alerts: { 'issue:818:已消歧待派': { at: HOURS_AGO(0.1) } } },
    });
    assert.equal(once.alerts.length, 0);
    assert.equal(once.skipped.some((s) => /已报过/.test(s.reason)), true);
  });

  it('跨阶段再报', async () => {
    const S = await BOARD;
    const board = S.renderBoard({
      now: NOW,
      prs: okEnv([pr({ createdAt: HOURS_AGO(6), isDraft: false, reviewDecision: 'CHANGES_REQUESTED' })]),
      issues: okEnv([]),
      queue: okEnv([]),
      ledger: okEnv([]),
    });
    assert.equal(board.rows[0].stage, '已红返工');
    const plan = S.planStageTimeoutAlerts({
      rows: board.rows, thresholdHours: 4,
      ledger: { alerts: { 'pr:1108:工人干活': { at: HOURS_AGO(1) } } },
    });
    assert.equal(plan.alerts.length, 1);
    assert.equal(plan.alerts[0].key, 'pr:1108:已红返工');
  });

  it('源没查成 → 不报超时', async () => {
    const S = await BOARD;
    const board = S.renderBoard({
      now: NOW,
      issues: deadEnv('ssh 连不上'),
      prs: okEnv([]),
      queue: okEnv([]),
      ledger: okEnv([]),
    });
    const plan = S.planStageTimeoutAlerts({ rows: board.rows, thresholdHours: 4 });
    assert.equal(plan.alerts.length, 0);
    assert.equal(plan.skipped.some((s) => /没查成/.test(s.reason)), true);
  });

  it('开单 10h、当前阶段只待了 1h → 绿、不报超时', async () => {
    const S = await BOARD;
    const board = S.renderBoard({
      now: NOW,
      issues: okEnv([issue({
        createdAt: HOURS_AGO(10),
        events: [{ event: 'labeled', label: { name: '已消歧' }, created_at: HOURS_AGO(1) }],
      })]),
      prs: okEnv([]),
      queue: okEnv([]),
      ledger: okEnv([]),
      thresholdHours: 4,
    });
    assert.equal(board.rows[0].elapsedHours, 1);
    assert.equal(board.rows[0].state, 'green');
    const plan = S.planStageTimeoutAlerts({ rows: board.rows, thresholdHours: 4 });
    assert.equal(plan.alerts.length, 0);
  });

  it('开 PR 10h、打回 1h → 绿、不报超时', async () => {
    const S = await BOARD;
    const board = S.renderBoard({
      now: NOW,
      issues: okEnv([]),
      prs: okEnv([pr({
        createdAt: HOURS_AGO(10),
        isDraft: false,
        reviewDecision: 'CHANGES_REQUESTED',
        events: [{ event: 'reviewed', state: 'changes_requested', submitted_at: HOURS_AGO(1) }],
      })]),
      queue: okEnv([]),
      ledger: okEnv([]),
      thresholdHours: 4,
    });
    assert.equal(board.rows[0].stage, '已红返工');
    assert.equal(board.rows[0].elapsedHours, 1);
    assert.equal(board.rows[0].state, 'green');
    const plan = S.planStageTimeoutAlerts({ rows: board.rows, thresholdHours: 4 });
    assert.equal(plan.alerts.length, 0);
  });

  it('执行中缺 .running 时间 → 不拿入队 ts 顶', async () => {
    const S = await BOARD;
    const board = S.renderBoard({
      now: NOW,
      issues: okEnv([]),
      prs: okEnv([]),
      queue: okEnv([order({ ts: HOURS_AGO(10), status: 'running', runningAt: null })]),
      ledger: okEnv([]),
      thresholdHours: 4,
    });
    assert.equal(board.rows[0].stage, '执行中');
    assert.equal(board.rows[0].elapsedHours, null);
    const plan = S.planStageTimeoutAlerts({ rows: board.rows, thresholdHours: 4 });
    assert.equal(plan.alerts.length, 0);
  });

  it('事件没查成（events 缺席）→ 不拿开单日顶', async () => {
    const S = await BOARD;
    const board = S.renderBoard({
      now: NOW,
      issues: okEnv([issue({ createdAt: HOURS_AGO(10), events: undefined })]),
      prs: okEnv([]),
      queue: okEnv([]),
      ledger: okEnv([]),
      thresholdHours: 4,
    });
    assert.equal(board.rows[0].elapsedHours, null);
    assert.equal(board.rows[0].state, 'green');
    const plan = S.planStageTimeoutAlerts({ rows: board.rows, thresholdHours: 4 });
    assert.equal(plan.alerts.length, 0);
  });

  it('一开就是草稿：查过事件但没有 convert_to_draft → 用开 PR 日', async () => {
    const S = await BOARD;
    const board = S.renderBoard({
      now: NOW,
      issues: okEnv([]),
      prs: okEnv([pr({ createdAt: HOURS_AGO(2), isDraft: true, events: [] })]),
      queue: okEnv([]),
      ledger: okEnv([]),
      thresholdHours: 4,
    });
    assert.equal(board.rows[0].stage, '工人干活');
    assert.equal(board.rows[0].elapsedHours, 2);
    assert.equal(board.rows[0].state, 'green');
  });

  it('开单 10h、阶段未知（没有阶段起点）→ elapsedHours=null、不报超时', async () => {
    const S = await BOARD;
    const board = S.renderBoard({
      now: NOW,
      issues: okEnv([issue({
        createdAt: HOURS_AGO(10),
        events: [],
      })]),
      prs: okEnv([]),
      queue: okEnv([]),
      ledger: okEnv([]),
      thresholdHours: 4,
    });
    assert.equal(board.rows[0].elapsedHours, null);
    assert.equal(board.rows[0].startedAt, null);
    assert.equal(board.rows[0].state, 'green');
    const plan = S.planStageTimeoutAlerts({ rows: board.rows, thresholdHours: 4 });
    assert.equal(plan.alerts.length, 0);
    assert.equal(plan.skipped.some((s) => /耗时没算出来/.test(s.reason)), true);
  });
});

describe('总控群状态闸', () => {
  it('「状态」「看板」命中；问候不命中；盘面怎么样仍走旧路', async () => {
    const P = await PROFILE;
    assert.equal(P.looksLikeStatusQuery('状态'), true);
    assert.equal(P.looksLikeStatusQuery('@机器人 状态'), true);
    assert.equal(P.looksLikeStatusQuery('看板怎么样'), true);
    assert.equal(P.looksLikeStatusQuery('你好'), false);
    assert.equal(P.looksLikeGreeting('你好'), true);
    assert.equal(P.looksLikeStatusQuery('盘面怎么样'), false);
    assert.equal(P.looksLikeStatusQuery('给面板加个夜间模式'), false);
  });

  it('问状态回表，不调 LLM；问候仍不甩表', async () => {
    const S = await CORE;
    const TABLE = '看板：\n- 单 #818 · 已消歧待派 · 1 小时 · grok-4.6';
    let llmCalls = 0;
    let tableCalls = 0;
    const deps = {
      ghSearch: async () => [],
      ghCreateIssue: async () => { throw new Error('不该建单'); },
      ghComment: async () => {},
      llm: async () => { llmCalls += 1; throw new Error('状态闸不该调 LLM'); },
      now: () => Date.parse(NOW),
      state: new Map(),
      allowOpenIds: ['openid-user'],
      hubChat: { enabled: true, allowedActions: ['situation', 'decision', 'guide'] },
      hubContext: async () => ({ projects: [] }),
      boardTable: async () => { tableCalls += 1; return TABLE; },
    };
    const inbound = {
      chatId: 'oc_hub', rootId: 'om_1', messageId: 'om_2',
      senderOpenId: 'openid-user', senderName: '用户',
      text: '状态', ts: 1, repo: null, kind: 'hub',
    };
    const out = await S.triage(inbound, deps);
    assert.equal(out.replies[0].text, TABLE);
    assert.equal(llmCalls, 0);
    assert.equal(tableCalls, 1);
    assert.equal(out.actions[0].record.intent, 'situation');

    const hi = await S.triage({ ...inbound, text: '你好' }, deps);
    assert.equal(hi.replies[0].text.includes('看板'), false);
    assert.equal(tableCalls, 1);
  });
});

describe('board-watch 账本去重 + 没查成退出', () => {
  it('dry-run 该报的行进 sent；同 key 再跑不重报', async () => {
    const W = await WATCH;
    const S = await BOARD;
    const board = S.renderBoard({
      now: NOW,
      issues: okEnv([issue({ createdAt: HOURS_AGO(5) })]),
      prs: okEnv([]),
      queue: okEnv([]),
      ledger: okEnv([]),
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-watch-'));
    const state = path.join(dir, 'watch.json');
    const collect = async () => ({ board });
    const said = [];
    const hubSay = (text) => { said.push(text); return { ok: true, messageId: 'm1' }; };
    const first = await W.runBoardWatch({ root: dir, state, dryRun: false, now: NOW, collect, hubSay });
    assert.equal(first.ok, true);
    assert.equal(first.sent.length, 1);
    assert.equal(said.length, 1);
    const second = await W.runBoardWatch({ root: dir, state, dryRun: false, now: NOW, collect, hubSay });
    assert.equal(second.ok, true);
    assert.equal(second.sent.length, 0);
    assert.equal(said.length, 1);
  });

  it('defaultHubSay：退出码 0 但没回执 → 失败（不许当发出去）', async () => {
    const W = await WATCH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-hub-'));
    const fake = path.join(dir, 'hub-say.mjs');
    fs.writeFileSync(fake, 'process.exit(0)\n');
    const prev = process.env.BOARD_WATCH_HUB_SAY;
    process.env.BOARD_WATCH_HUB_SAY = fake;
    try {
      const r = W.defaultHubSay('单 #818 超时');
      assert.equal(r.ok, false);
      assert.match(r.error, /没回 message_id/);
    } finally {
      if (prev == null) delete process.env.BOARD_WATCH_HUB_SAY;
      else process.env.BOARD_WATCH_HUB_SAY = prev;
    }
  });

  it('hub-say 退出码 0 但没回执 → 告警没发出去，账本不记', async () => {
    const W = await WATCH;
    const S = await BOARD;
    const board = S.renderBoard({
      now: NOW,
      issues: okEnv([issue({ createdAt: HOURS_AGO(5) })]),
      prs: okEnv([]),
      queue: okEnv([]),
      ledger: okEnv([]),
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-watch-'));
    const state = path.join(dir, 'watch.json');
    const r = await W.runBoardWatch({
      root: dir, state, dryRun: false, now: NOW,
      collect: async () => ({ board }),
      hubSay: () => ({ ok: false, error: 'hub-say 退出码 0 但没回 message_id——没送进群' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.exit, 1);
    assert.match(r.error, /没发出去/);
    assert.equal(fs.existsSync(state), false);
  });

  it('主源没查成 → exit 2，不把整张表当正常', async () => {
    const W = await WATCH;
    const S = await BOARD;
    const board = S.renderBoard({
      now: NOW,
      issues: deadEnv('gh 挂了'),
      prs: okEnv([]),
      queue: okEnv([]),
      ledger: okEnv([]),
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-watch-'));
    const r = await W.runBoardWatch({
      root: dir, state: path.join(dir, 'w.json'), dryRun: true, now: NOW,
      collect: async () => ({ board }),
      hubSay: () => ({ ok: true, messageId: 'x' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.exit, 2);
    assert.match(r.error, /没查成/);
  });
});

describe('策略 board 节 + CLI 动词', () => {
  it('真身 docs/dispatch-policy.json 有 board 节且过校验', async () => {
    const C = await POLICY;
    const r = C.inspectDispatchPolicyLive(REPO);
    assert.equal(r.unscanned, false, JSON.stringify(r.problems));
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'dispatch-policy.json'), 'utf8'));
    assert.equal(doc.board.workerWallHoursMax, 4);
  });

  it('workerWallHoursMax: 0 红', async () => {
    const C = await POLICY;
    const src = JSON.stringify({
      preflight: { enabled: true, timeoutMs: 5000, maxCandidates: 4, useHealthTable: true },
      breaker: { windowHours: 24, failuresToTrip: 3, cooldownHours: 24, halfOpenProbes: 1 },
      hubChat: { enabled: true, allowedActions: ['situation'], upstream: { redThreshold: 2, decisions: true, digest: false } },
      board: { workerWallHoursMax: 0 },
    });
    const r = C.inspectDispatchPolicySource(src);
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, false);
    assert.equal(r.problems.some((p) => /workerWallHoursMax/.test(p)), true);
  });

  it('board 动词已登记', async () => {
    const S = await CMD;
    assert.equal(S.VERBS.includes('board'), true);
    assert.equal(S.FLAGS_BY_VERB.board.has('--json'), true);
    assert.match(S.USAGE, /board \[--json\]/);
    const parsed = S.parseArgs(['node', 'dao.mjs', 'board', '--json']);
    assert.equal(parsed.verb, 'board');
    assert.equal(parsed.json, true);
  });
});

describe('阶段事件取数：一张失败只让耗时空着', () => {
  it('attachStageEvents：一张查不到事件仍 scanned，不把整路打成没查成', async () => {
    const C = await COLLECT;
    const env = okEnv([
      { number: 818, title: 'a', labels: [{ name: '已消歧' }] },
      { number: 792, title: 'b', labels: [{ name: '已消歧' }] },
    ]);
    const out = await C.attachStageEvents(env, {
      kind: 'issue',
      fetchEvents: async ({ number }) => {
        if (number === 818) return [{ event: 'labeled', label: { name: '已消歧' }, created_at: HOURS_AGO(1) }];
        return null;
      },
    });
    assert.equal(out.scanned, true);
    assert.equal(out.items[0].events.length, 1);
    assert.equal(out.items[1].events, undefined);
  });
});

describe('timer 单元在仓里', () => {
  it('dao-board-watch.timer 有 OnCalendar，装机脚本不 chmod 仓内文件', () => {
    const unitDir = path.join(REPO, 'host', 'machine', 'systemd');
    const timer = fs.readFileSync(path.join(unitDir, 'dao-board-watch.timer'), 'utf8');
    const service = fs.readFileSync(path.join(unitDir, 'dao-board-watch.service'), 'utf8');
    assert.match(timer, /^OnCalendar=/m);
    assert.match(timer, /^OnCalendar=\*:19\/20$/m);
    assert.match(timer, /^Persistent=true$/m);
    assert.match(service, /board-watch\.mjs/);
    assert.match(service, /^User=orca$/m);
    const install = fs.readFileSync(path.join(REPO, 'scripts', 'install-board-watch.sh'), 'utf8');
    const bad = install.split(/\r?\n/).filter((l) => /^\s*chmod\b/.test(l) && /\$(ROOT|\{ROOT\})/.test(l));
    assert.deepEqual(bad, []);
    const index = fs.readFileSync(path.join(REPO, 'host', 'machine', 'INDEX.md'), 'utf8');
    assert.match(index, /~\/\.dao\/board-watch\.json/);
  });

  it('仓内 .timer 的 OnCalendar 互不相同——撞点就是自己跟自己抢', () => {
    const unitDir = path.join(REPO, 'host', 'machine', 'systemd');
    const units = fs.readdirSync(unitDir).filter((f) => f.endsWith('.timer'));
    assert.ok(units.length > 0, '一个 .timer 都没扫到');
    const cals = units.map((u) => {
      const s = fs.readFileSync(path.join(unitDir, u), 'utf8');
      const m = s.match(/^OnCalendar=(.+)$/m);
      assert.ok(m, `${u} 没有 OnCalendar`);
      return `${m[1]}  ← ${u}`;
    });
    const values = cals.map((c) => c.split('  ← ')[0]);
    assert.equal(new Set(values).size, values.length, `点位撞了：${cals.join(' / ')}`);
  });
});
