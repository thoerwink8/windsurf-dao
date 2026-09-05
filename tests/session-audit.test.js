// 审计闸（scripts/lib/session-audit.mjs + scripts/session-audit-hook.mjs）· 回归网
//
// 验的层：①逐项覆盖（无关事件**不许**掩盖漏记，审官 P1）②放行只认指向本产出的事件
//        ③无产出静默 ④时间边界（错位/跨时区/PR 窗口，审官 P2）⑤三态不许合并
//        ⑥自己的 audit.* 不算「账上有了」⑦不刷屏（报一次、提示一次）
//        ⑧跨轮 pending（审官 P1：不存下来 remind 永远不会发生）
//        ⑨变异自证 ⑩落点指针报警 ⑪**真 hook 三轮生命周期**（不手改状态文件）
//        ⑫异常路径一律 exit 0 且不刷屏。
// 判别力自检问句：把闸放宽（该红不红）或收紧（该静默却说话）的改动，是否都至少有一条断言变红？
// ⚠ 合成凭据一律 CANARY_* 命名，不是真实凭据。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'session-audit.mjs');
const HOOK = path.join(REPO, 'scripts', 'session-audit-hook.mjs');
const SANDBOX = path.join(REPO, '_tmp', 'session-audit-sandbox');

const toUrl = p => 'file://' + p.replace(/\\/g, '/');
const LIB_LOAD = import(toUrl(LIB));

const T0 = '2026-09-04T10:00:00+08:00';   // 本轮起点
const T1 = '2026-09-04T10:05:00+08:00';   // 窗内
const TM1 = '2026-09-04T09:30:00+08:00';  // 窗外（上一轮）
const SHA = '077f48b1c2d3e4f5';
const KEY = 'commit:077f48b';             // SHA 的 evidence 键

const commit = (sha = SHA, ts = T1) => ({ sha, ts, subject: 'feat: x' });
const ev = (type, ts, extra = {}) => ({ type, ts, machine: 'm', seq: 1, event_id: `id-${type}-${ts}`, ...extra });
/** 指向某个 commit 的事件：正文里带着那个 sha（真事件就是这样引用产出的）。 */
const evFor = (type, ts, sha = SHA) => ev(type, ts, { why: `跟进 ${sha.slice(0, 7)}` });

function freshSandbox(name) {
  const dir = path.join(SANDBOX, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── 变异手：把纯函数的某一行机械改坏，跑同一条断言，要求它翻红 ────────────────
function mutantLib(find, replace) {
  fs.mkdirSync(SANDBOX, { recursive: true });
  const src = fs.readFileSync(LIB, 'utf8');
  assert.ok(src.includes(find), `变异手找不到目标行 ${JSON.stringify(find)} ⇒ 实现结构变了，变异自证失效`);
  const file = path.join(SANDBOX, `mutant-${Buffer.from(find).toString('hex').slice(0, 20)}.mjs`);
  fs.writeFileSync(file, src.replace(find, replace), 'utf8');
  return import(toUrl(file));
}

describe('session-audit · 纯函数', () => {
  it('① 有产出、零事件 ⇒ 判漏记，missing 是可复查的 evidence 键', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({ produced: { commits: [commit()] }, events: [], since: T0 });
    assert.strictEqual(r.verdict, 'missing');
    assert.deepStrictEqual(r.missing, [KEY]);
    assert.deepStrictEqual(r.pending, [KEY], '没补记的产出要交回调用方跨轮带着走');
    assert.ok(r.detail && r.detail.includes(KEY), 'detail 要能复查');
  });

  it('① 审官 P1 · **无关事件不许掩盖漏记**（首版一条无关 incident 就能判绿）', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({
      produced: { commits: [commit()] },
      events: [
        ev('incident', T1, { fingerprint: '别的事故', disposition: '挂账待补', why: '与本轮产出无关' }),
        ev('job.closed', T1, { job_id: 'dj-999' }),
      ],
      since: T0,
    });
    assert.strictEqual(r.verdict, 'missing', '窗内有事件但没有一条指向这个 commit ⇒ 仍是漏记');
    assert.deepStrictEqual(r.missing, [KEY]);
  });

  it('① 逐项覆盖 · 只有没被指向的那几项进 missing（不是整批）', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({
      produced: { commits: [commit(), commit('aaaaaaabbbb')], prs: [{ number: 891, ts: T1 }] },
      events: [evFor('job.closed', T1)],           // 只指向第一个 commit
      since: T0,
    });
    assert.strictEqual(r.verdict, 'missing');
    assert.deepStrictEqual(r.missing, ['commit:aaaaaaa', 'pr:#891'], '被指向的那一项不该进 evidence');
  });

  it('② 放行 · 事件正文里出现该 commit 的 sha ⇒ 记上了', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({ produced: { commits: [commit()] }, events: [evFor('job.closed', T1)], since: T0 });
    assert.strictEqual(r.verdict, 'silent');
    assert.deepStrictEqual(r.pending, [], '记上了就要把 pending 清掉');
  });

  it('② 放行 · PR 靠 pr_number 字段命中，也靠正文 #号 命中', async (t) => {
    const { auditTurn } = await LIB_LOAD;
    const produced = { prs: [{ number: 891, ts: T1 }] };
    await t.test('pr_number 字段', () => {
      assert.strictEqual(auditTurn({ produced, events: [ev('job.closed', T1, { pr_number: 891 })], since: T0 }).verdict, 'silent');
    });
    await t.test('正文 #891', () => {
      assert.strictEqual(auditTurn({ produced, events: [ev('job.closed', T1, { why: '合了 #891' })], since: T0 }).verdict, 'silent');
    });
    await t.test('别的 PR 号不算', () => {
      assert.strictEqual(auditTurn({ produced, events: [ev('job.closed', T1, { pr_number: 892 })], since: T0 }).verdict, 'missing');
    });
  });

  it('② 放行 · 事件带同一个 session_id 即为本会话产出背书（agent 侧的正门）', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({
      produced: { commits: [commit()] },
      events: [ev('job.closed', T1, { session_id: 'sess-A' })],
      since: T0, sessionId: 'sess-A',
    });
    assert.strictEqual(r.verdict, 'silent');
    const other = auditTurn({
      produced: { commits: [commit()] },
      events: [ev('job.closed', T1, { session_id: 'sess-B' })],
      since: T0, sessionId: 'sess-A',
    });
    assert.strictEqual(other.verdict, 'missing', '别的会话的事件不该给本会话背书');
  });

  it('③ 无产出 ⇒ 静默（工作树脏也不算产出，默认档）', async () => {
    const { auditTurn } = await LIB_LOAD;
    assert.strictEqual(auditTurn({ produced: {}, events: [], since: T0 }).verdict, 'silent');
    const dirty = auditTurn({ produced: { dirty: ['scripts/a.mjs', 'scripts/b.mjs'] }, events: [], since: T0 });
    assert.strictEqual(dirty.verdict, 'silent', '活干到一半不该报警（否则每个编辑会话第一轮就刷屏）');
    assert.ok(dirty.why.includes('2 个文件'), '关着的档仍要把事实带进 why 当上下文');
  });

  it('③ 开 dirty 档 ⇒ 工作树改动也算产出（档位真的生效，不是装饰）', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({ produced: { dirty: ['scripts/a.mjs'] }, events: [], since: T0, tiers: ['commit', 'pr', 'dirty'] });
    assert.strictEqual(r.verdict, 'missing');
    assert.deepStrictEqual(r.missing, ['file:scripts/a.mjs']);
  });

  it('④ 边界 · 事件早于本轮起点 ⇒ 不算覆盖，仍判漏记', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({ produced: { commits: [commit()] }, events: [evFor('job.closed', TM1)], since: T0 });
    assert.strictEqual(r.verdict, 'missing', '上一轮的事件不该给这一轮的产出背书');
  });

  it('④ 边界 · 恰好落在起点上的事件算窗内（>= 不是 >，宁放行不误报）', async () => {
    const { auditTurn } = await LIB_LOAD;
    assert.strictEqual(auditTurn({ produced: { commits: [commit()] }, events: [evFor('job.closed', T0)], since: T0 }).verdict, 'silent');
  });

  it('④ 边界 · 跨时区同一时刻算窗内（比毫秒不比字符串）', async () => {
    const { auditTurn } = await LIB_LOAD;
    // 2026-09-04T02:05:00Z === 2026-09-04T10:05:00+08:00，字符串序反了
    const r = auditTurn({ produced: { commits: [commit()] }, events: [evFor('job.closed', '2026-09-04T02:05:00Z')], since: T0 });
    assert.strictEqual(r.verdict, 'silent', 'ISO 串直接比大小会把跨时区事件判成窗外');
  });

  it('④ 审官 P2 · 很久以前更新的 open PR 不算本轮产出', async (t) => {
    const { auditTurn, produceKeys } = await LIB_LOAD;
    await t.test('窗外 PR ⇒ 无产出、静默（首版每轮都报它）', () => {
      const r = auditTurn({ produced: { prs: [{ number: 1, updatedAt: '2020-01-01T00:00:00+08:00' }] }, events: [], since: T0 });
      assert.strictEqual(r.verdict, 'silent');
      assert.deepStrictEqual(r.missing, []);
    });
    await t.test('窗内 PR ⇒ 照常算产出', () => {
      assert.strictEqual(auditTurn({ produced: { prs: [{ number: 2, updatedAt: T1 }] }, events: [], since: T0 }).verdict, 'missing');
    });
    await t.test('窗外 commit 同样被滤掉', () => {
      assert.deepStrictEqual(produceKeys({ commits: [commit(SHA, TM1)] }, ['commit', 'pr'], T0), []);
    });
    await t.test('不传 since 时不过滤（produceKeys 单独用的老契约）', () => {
      assert.deepStrictEqual(produceKeys({ commits: [commit(SHA, TM1)] }), [KEY]);
    });
  });

  it('⑤ 三态不合并 · 账本没读成 ⇒ unscanned，既不判红也不判绿', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({ produced: { commits: [commit()] }, events: { unscanned: true, error: '目录不在' }, since: T0, carry: [KEY] });
    assert.strictEqual(r.verdict, 'unscanned');
    assert.deepStrictEqual(r.missing, [], '没查成时不许给出 missing（那会被写成 evidence）');
    assert.deepStrictEqual(r.pending, [KEY], '没读成不等于补记了 ⇒ pending 原样带走');
    assert.ok(r.why.includes('没读成'));
  });

  it('⑤ 审官返工 · unscanned 必须留下本轮产出键（否则 since 一推就静默漏报）', async (t) => {
    const { auditTurn } = await LIB_LOAD;
    const unscanned = { unscanned: true, error: '目录不在' };
    await t.test('首轮无 carry、有新 commit ⇒ pending 含本轮键（不是只带走空 carry）', () => {
      const r = auditTurn({ produced: { commits: [commit()] }, events: unscanned, since: T0 });
      assert.strictEqual(r.verdict, 'unscanned');
      assert.deepStrictEqual(r.missing, []);
      assert.deepStrictEqual(r.pending, [KEY], '账本没读成也要把本轮可确定的产出放进 pending');
    });
    await t.test('下一轮 events=[]、无新产出 ⇒ missing，不是 silent', () => {
      const r1 = auditTurn({ produced: { commits: [commit()] }, events: unscanned, since: T0 });
      const r2 = auditTurn({ produced: {}, events: [], since: T1, carry: r1.pending });
      assert.strictEqual(r2.verdict, 'missing', '账本恢复后仍应看见上一轮没扫到的产出');
      assert.deepStrictEqual(r2.missing, [KEY]);
      assert.deepStrictEqual(r2.pending, [KEY]);
    });
  });

  it('⑤ 三态不合并 · since 无法确定 ⇒ unscanned', async () => {
    const { auditTurn } = await LIB_LOAD;
    for (const bad of [undefined, null, '', 'not-a-date']) {
      assert.strictEqual(auditTurn({ produced: { commits: [commit()] }, events: [], since: bad }).verdict, 'unscanned');
    }
  });

  it('⑤ 采集腿没查成只会漏报，绝不把红变绿', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({ produced: { commits: [commit()], unscanned: ['prs'] }, events: [], since: T0 });
    assert.strictEqual(r.verdict, 'missing', 'PR 腿没查成不该影响 commit 腿的判红');
    assert.ok(r.why.includes('prs'), '没查成的腿必须写进 why');
  });

  it('⑥ 自己写的 audit.* 不算「账上有了」（否则报一次就永久失声）', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({
      produced: { commits: [commit()] },
      // 这条 audit.bypass 正文里就带着本产出的 sha（报警本来就要带 evidence），
      // 若把 audit.* 当候选事件，它会给自己背书 ⇒ 必须排除。
      events: [ev('audit.bypass', T1, { detail: `漏记 ${KEY}`, evidence: ['commit:zzzzzzz'] })],
      since: T0,
    });
    assert.strictEqual(r.verdict, 'missing');
  });

  it('⑦ 不刷屏 · 已有覆盖的 audit.bypass ⇒ remind（只提示，不再写）', async () => {
    const { auditTurn, remindLine } = await LIB_LOAD;
    const bypass = ev('audit.bypass', T1, { detail: 'd', evidence: [KEY] });
    const r = auditTurn({ produced: { commits: [commit()] }, events: [bypass], since: T0 });
    assert.strictEqual(r.verdict, 'remind');
    assert.deepStrictEqual(r.remindFor, [bypass.event_id]);
    const line = remindLine(r);
    assert.ok(line.includes(`补记 ${KEY}`), '提示要说清补记什么');
    assert.strictEqual(line.split('\n').length, 1, '一句话，不刷屏');
  });

  it('⑦ 不刷屏 · 提示过之后彻底静默，但 pending 不清（还是没补记）', async () => {
    const { auditTurn } = await LIB_LOAD;
    const bypass = ev('audit.bypass', T1, { detail: 'd', evidence: [KEY] });
    const r = auditTurn({ produced: { commits: [commit()] }, events: [bypass], since: T0, reminded: [bypass.event_id] });
    assert.strictEqual(r.verdict, 'silent');
    assert.deepStrictEqual(r.pending, [KEY]);
  });

  it('⑧ 审官 P1 · 跨轮 carry：产出滚出 git 窗口后仍在管（否则 remind 永不发生）', async (t) => {
    const { auditTurn, MAX_PENDING } = await LIB_LOAD;
    await t.test('本轮零新产出、carry 有货 ⇒ 照样在判', () => {
      const bypass = ev('audit.bypass', TM1, { detail: 'd', evidence: [KEY] });
      const r = auditTurn({ produced: {}, events: [bypass], since: T0, carry: [KEY] });
      assert.strictEqual(r.verdict, 'remind', 'carry 丢了这里就会是 silent —— 那正是首版的病');
    });
    await t.test('carry 的产出被事件指向后清掉', () => {
      const r = auditTurn({ produced: {}, events: [evFor('job.closed', T1)], since: T0, carry: [KEY] });
      assert.strictEqual(r.verdict, 'silent');
      assert.deepStrictEqual(r.pending, []);
    });
    await t.test('pending 有上限，不无限堆积', () => {
      const many = Array.from({ length: MAX_PENDING + 10 }, (_, i) => `commit:x${String(i).padStart(6, '0')}`);
      const r = auditTurn({ produced: {}, events: [], since: T0, carry: many });
      assert.ok(r.pending.length <= MAX_PENDING, `pending 应 <= ${MAX_PENDING}，实际 ${r.pending.length}`);
    });
  });

  it('⑨ 变异自证：把判据逐条改坏 → 对应断言必须翻红', async (t) => {
    const { auditTurn } = await LIB_LOAD;
    const red = { produced: { commits: [commit()] }, events: [], since: T0 };
    assert.strictEqual(auditTurn(red).verdict, 'missing', '前提：这个样本在正确实现上是红的');

    const mutations = [
      ['覆盖判据恒真（有没有指向都算记上了）', 'if (uncovered.length === 0) {', 'if (true) {',
        m => m.auditTurn(red).verdict],
      ['commit 档失效', "if (tiers.includes('commit')) {", 'if (false) {',
        m => m.auditTurn(red).verdict],
      ['把 audit.* 也算成候选事件', "if (!type || type.startsWith('audit.')) return false;", 'if (!type) return false;',
        m => m.auditTurn({
          produced: { commits: [commit()] },
          events: [ev('audit.bypass', T1, { detail: `漏记 ${KEY}`, evidence: ['commit:zzzzzzz'] })],
          since: T0,
        }).verdict],
      ['relatedness 恒真（任意事件都算指向）', 'return sha.length >= 7 && body.includes(sha);', 'return true;',
        m => m.auditTurn({
          produced: { commits: [commit()] },
          events: [ev('incident', T1, { fingerprint: '无关', disposition: '挂账待补', why: '无关' })],
          since: T0,
        }).verdict],
      ['产出窗口过滤失效（远古 PR 又算本轮产出）', 'const ok = ts => (sinceMs === null ? true : inWindow(ts, sinceMs));', 'const ok = () => true;',
        m => (m.auditTurn({ produced: { prs: [{ number: 1, updatedAt: '2020-01-01T00:00:00+08:00' }] }, events: [], since: T0 }).verdict === 'missing'
          ? 'missing-ancient-pr' : 'silent')],
      ['carry 被丢掉（remind 永不发生）', 'const keys = [...new Set([...keepCarry, ...fresh])].slice(-MAX_PENDING);', 'const keys = [...new Set([...fresh])].slice(-MAX_PENDING);',
        m => m.auditTurn({ produced: {}, events: [ev('audit.bypass', TM1, { detail: 'd', evidence: [KEY] })], since: T0, carry: [KEY] }).verdict],
      ['unscanned 丢掉本轮产出（账本恢复后静默漏报）', 'verdict: \'unscanned\', ...nil, pending: keys,', 'verdict: \'unscanned\', ...nil, pending: keepCarry,',
        m => m.auditTurn({ produced: { commits: [commit()] }, events: { unscanned: true, error: '目录不在' }, since: T0 }).pending.join(',')],
    ];

    // 每条变异体上，对应样本的判定必须**不同于**正确实现的判定。
    const want = {
      '覆盖判据恒真（有没有指向都算记上了）': 'missing',
      'commit 档失效': 'missing',
      '把 audit.* 也算成候选事件': 'missing',
      'relatedness 恒真（任意事件都算指向）': 'missing',
      '产出窗口过滤失效（远古 PR 又算本轮产出）': 'silent',
      'carry 被丢掉（remind 永不发生）': 'remind',
      'unscanned 丢掉本轮产出（账本恢复后静默漏报）': KEY,
    };
    for (const [label, find, replace, probe] of mutations) {
      await t.test(`${label} ⇒ 翻红`, async () => {
        const m = await mutantLib(find, replace);
        assert.notStrictEqual(probe(m), want[label],
          `改坏「${label}」后判定仍是 ${want[label]} ⇒ 该断言不是靠这条判据过的，没有判别力`);
      });
    }
  });
});

// ── hook 落点与真跑 ─────────────────────────────────────────────────────────

function runHook(cwd, { ledger, state, sessionId = 's1', tiers, input } = {}) {
  return spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8',
    timeout: 30000,
    input: input !== undefined ? input : JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'Stop' }),
    env: {
      ...process.env,
      LEDGER_EVENTS_DIR: ledger,
      DAO_AUDIT_STATE_DIR: state,
      ...(tiers ? { DAO_AUDIT_TIERS: tiers } : {}),
    },
  });
}

function ledgerEvents(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function bypasses(dir) {
  return ledgerEvents(dir).filter(e => e.type === 'audit.bypass');
}

function makeRepo(dir) {
  const run = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  run('init', '-q');
  run('config', 'user.email', 't@example.com');
  run('config', 'user.name', 'test');
  run('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n', 'utf8');
  run('add', '-A');
  run('commit', '-q', '-m', 'feat: 造一个产出');
  return spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
}

describe('session-audit-hook · 落点与真跑', () => {
  it('⑩ 落点指针报警：hook 文件在，且语法过得去', () => {
    // 「写了指针就要配一道会报警的检查」：hook 被挪走/改名/写坏 ⇒ 这里红，
    // 不留指向空气的指针（注册片段在 PR 正文里指的就是这个路径）。
    assert.ok(fs.existsSync(HOOK), `hook 落点不在：${HOOK}`);
    const chk = spawnSync(process.execPath, ['--check', HOOK], { encoding: 'utf8' });
    assert.strictEqual(chk.status, 0, `hook 语法不过：${chk.stderr}`);
    const src = fs.readFileSync(HOOK, 'utf8');
    // 用正则不用字面量：`from './lib/...'` 的字面量会被孤儿测试闸（㉖）当成本测试自己的引用。
    assert.ok(/from\s+(['"])\.\/lib\/session-audit\.mjs\1/.test(src), 'hook 没用纯函数 ⇒ 判据可能被抄了第二份');
    assert.ok(/from\s+(['"])\.\/lib\/redact\.mjs\1/.test(src), 'hook 没接脱敏 ⇒ 写口可能漏 key');
  });

  it('⑪ 审官 P1 · 真 hook 三轮生命周期：报警 → 提示一次 → 静默（**不手改状态文件**）', () => {
    const repo = freshSandbox('repo-life');
    const ledger = freshSandbox('ledger-life');
    const state = freshSandbox('state-life');
    const sha = makeRepo(repo);
    const key = `commit:${sha.slice(0, 7)}`;
    assert.ok(/^[0-9a-f]{40}$/.test(sha), `造 commit 失败：${sha}`);

    // 轮 1：判红，写事件，不打印
    const r1 = runHook(repo, { ledger, state, sessionId: 'life' });
    assert.strictEqual(r1.status, 0, `轮1 退出码应为 0：${r1.stderr}`);
    assert.strictEqual(r1.stdout.trim(), '', '轮1 不打印（产出刚落地，人还在场）');
    assert.strictEqual(bypasses(ledger).length, 1, '轮1 应写 1 条 audit.bypass');
    assert.deepStrictEqual(bypasses(ledger)[0].evidence, [key]);
    const st1 = JSON.parse(fs.readFileSync(path.join(state, 'life.json'), 'utf8'));
    assert.deepStrictEqual(st1.pending, [key], '轮1 要把未补记的产出存进 pending');

    // 轮 2：**不动状态文件**。commit 已滚出 git 窗口，靠 pending 才看得见它。
    const r2 = runHook(repo, { ledger, state, sessionId: 'life' });
    assert.strictEqual(r2.status, 0);
    assert.ok(r2.stdout.includes('[审计]'), `轮2 应提示一句，实际 stdout=${JSON.stringify(r2.stdout)}`);
    assert.ok(r2.stdout.includes(key), '提示里要写清补记什么');
    assert.strictEqual(r2.stdout.trim().split('\n').length, 1, '轮2 只许一行');
    assert.strictEqual(bypasses(ledger).length, 1, '轮2 不该再写事件');

    // 轮 3：提示过了 ⇒ 彻底静默
    const r3 = runHook(repo, { ledger, state, sessionId: 'life' });
    assert.strictEqual(r3.status, 0);
    assert.strictEqual(r3.stdout.trim(), '', '轮3 应彻底静默（不刷屏）');
    assert.strictEqual(bypasses(ledger).length, 1);

    // 轮 4：补记一条指向该 commit 的真事件 ⇒ pending 清空、仍静默
    const w = spawnSync(process.execPath, [
      path.join(REPO, 'scripts', 'event-write.mjs'),
      '--type', 'incident', '--ts', new Date().toISOString(),
      '--fingerprint', `commit ${sha.slice(0, 7)} 补记`, '--disposition', '挂账待补', '--why', '补记本轮产出',
    ], { encoding: 'utf8', env: { ...process.env, LEDGER_EVENTS_DIR: ledger } });
    assert.strictEqual(w.status, 0, `补写事件失败：${w.stderr}`);

    const r4 = runHook(repo, { ledger, state, sessionId: 'life' });
    assert.strictEqual(r4.status, 0);
    assert.strictEqual(r4.stdout.trim(), '', '补记后应静默');
    assert.strictEqual(bypasses(ledger).length, 1, '补记后不该再写 audit.bypass');
    const st4 = JSON.parse(fs.readFileSync(path.join(state, 'life.json'), 'utf8'));
    assert.deepStrictEqual(st4.pending, [], '补记后 pending 要清空');
  });

  it('⑪ 审官返工 · 首轮账本 unscanned + 新 commit，下一轮空账本仍应 missing 不是 silent', () => {
    const repo = freshSandbox('repo-unscan');
    const ledger = path.join(SANDBOX, 'ledger-unscan-missing');
    const state = freshSandbox('state-unscan');
    fs.rmSync(ledger, { recursive: true, force: true });
    const sha = makeRepo(repo);
    const key = `commit:${sha.slice(0, 7)}`;

    // 轮 1：账本目录不存在 ⇒ unscanned。hook 仍推进 since；本轮产出必须进 pending。
    const r1 = runHook(repo, { ledger, state, sessionId: 'unscan' });
    assert.strictEqual(r1.status, 0, `轮1 退出码应为 0：${r1.stderr}`);
    assert.strictEqual(r1.stdout.trim(), '', 'unscanned 不刷屏');
    assert.ok(!fs.existsSync(ledger) || bypasses(ledger).length === 0, '没查成不许写 audit.bypass');
    const st1 = JSON.parse(fs.readFileSync(path.join(state, 'unscan.json'), 'utf8'));
    assert.deepStrictEqual(st1.pending, [key], '首轮 unscanned 也要把本轮 commit 放进 pending');

    // 轮 2：账本恢复为空、无新产出。commit 已滚出 git 窗口，全靠 pending。
    fs.mkdirSync(ledger, { recursive: true });
    const r2 = runHook(repo, { ledger, state, sessionId: 'unscan' });
    assert.strictEqual(r2.status, 0, `轮2 退出码应为 0：${r2.stderr}`);
    assert.strictEqual(r2.stdout.trim(), '', '判红那一轮不打印');
    assert.strictEqual(bypasses(ledger).length, 1, '账本恢复后应补写 audit.bypass，而不是 silent');
    assert.deepStrictEqual(bypasses(ledger)[0].evidence, [key]);
    const st2 = JSON.parse(fs.readFileSync(path.join(state, 'unscan.json'), 'utf8'));
    assert.deepStrictEqual(st2.pending, [key]);
  });

  it('⑪ 真跑 · 写出的事件已脱敏（读回自证）', () => {
    const repo = freshSandbox('repo-red');
    const ledger = freshSandbox('ledger-red');
    const state = freshSandbox('state-red');
    const sha = makeRepo(repo);
    // session_id 里塞一个合成凭据：证明写路径真的过了 redact（不是只在纯函数里过）
    const CANARY = 'sk-CANARYaaaabbbbccccddddeeeeffff1234';

    const r = runHook(repo, { ledger, state, sessionId: `sess-${CANARY}` });
    assert.strictEqual(r.status, 0);
    const e = bypasses(ledger)[0];
    assert.ok(e, '应落盘一条 audit.bypass');
    assert.strictEqual(e.type, 'audit.bypass', '类型必须是既有的 audit.bypass，不新造类型');
    assert.deepStrictEqual(e.evidence, [`commit:${sha.slice(0, 7)}`], 'evidence 必须是能复查的 sha');
    assert.ok(!JSON.stringify(e).includes(CANARY), '写出的事件里留下了凭据 ⇒ 脱敏没生效');
    assert.ok(JSON.stringify(e).includes('[REDACTED:'), '看不到占位 ⇒ 无法确认真过了脱敏');
  });

  it('⑫ 异常路径一律 exit 0 且不刷屏', async (t) => {
    const repo = freshSandbox('repo-err');
    makeRepo(repo);

    const cases = [
      ['账本路径被文件占住（读不成）', () => {
        const f = path.join(freshSandbox('led-file'), 'occupied');
        fs.writeFileSync(f, 'not a dir\n', 'utf8');
        return { ledger: f, state: freshSandbox('state-e1') };
      }],
      ['账本里有坏 JSON（读不成）', () => {
        const led = freshSandbox('led-corrupt');
        fs.writeFileSync(path.join(led, 'bad.json'), '{这不是合法 JSON', 'utf8');
        return { ledger: led, state: freshSandbox('state-e2') };
      }],
      ['状态目录被文件占住（写不了状态）', () => {
        const f = path.join(freshSandbox('state-file'), 'occupied');
        fs.writeFileSync(f, 'not a dir\n', 'utf8');
        return { ledger: freshSandbox('led-e3'), state: f };
      }],
      ['状态文件是坏 JSON（缓存损坏当首轮）', () => {
        const st = freshSandbox('state-bad');
        fs.writeFileSync(path.join(st, 'err.json'), '{坏了', 'utf8');
        return { ledger: freshSandbox('led-e6'), state: st };
      }],
      ['cwd 不是 git 仓（采集腿全没查成）', () => ({
        ledger: freshSandbox('led-e4'), state: freshSandbox('state-e4'), cwd: freshSandbox('not-a-repo'),
      })],
      ['stdin 是空的（拿不到宿主 payload）', () => ({
        ledger: freshSandbox('led-e5'), state: freshSandbox('state-e5'), input: '',
      })],
    ];

    for (const [label, setup] of cases) {
      await t.test(label, () => {
        const cfg = setup();
        const r = runHook(cfg.cwd || repo, {
          ledger: cfg.ledger, state: cfg.state, sessionId: 'err', input: cfg.input,
        });
        assert.strictEqual(r.status, 0, `${label}：退出码应为 0，实际 ${r.status}`);
        assert.strictEqual(r.stdout.trim(), '', `${label}：不该刷屏，实际 stdout=${JSON.stringify(r.stdout)}`);
        assert.strictEqual(r.stderr.trim(), '', `${label}：不该刷 stderr，实际 ${JSON.stringify(r.stderr)}`);
      });
    }
  });

  it('⑬ 账本目录不可写 ⇒ 仍 exit 0（注入不成就明说没查成，不打假 ✓）', () => {
    const repo = freshSandbox('repo-ro');
    makeRepo(repo);
    const ledger = freshSandbox('ledger-ro');
    const state = freshSandbox('state-ro');
    // 注入：把账本目录设成只读。Windows 上 chmod 对目录多半是空操作 ⇒ 先探针验注入是否真成立。
    let injected = false;
    try {
      fs.chmodSync(ledger, 0o500);
      const probe = path.join(ledger, '.probe');
      try { fs.writeFileSync(probe, 'x', 'utf8'); fs.rmSync(probe, { force: true }); }
      catch { injected = true; }
    } catch { /* chmod 本身不支持 */ }

    const r = runHook(repo, { ledger, state, sessionId: 'ro' });
    try { fs.chmodSync(ledger, 0o700); } catch { /* 还原失败不影响判定 */ }

    assert.strictEqual(r.status, 0, `不可写时也必须 exit 0，实际 ${r.status}：${r.stderr}`);
    assert.strictEqual(r.stdout.trim(), '', '不可写时不该刷屏');
    assert.strictEqual(r.stderr.trim(), '', '不可写时不该刷 stderr');
    if (!injected) {
      // 「没查成」与「查过没事」分开说：注入没成立就说清，不冒充已验证。
      console.log('  ℹ 本机无法把目录设成只读（Windows chmod 对目录为空操作）⇒ ' +
        '「写入失败」这一格没注入成；上面断言只证明了 exit 0 与不刷屏，没证明写失败被吞。');
    }
  });
});
