// 审计闸（scripts/lib/session-audit.mjs + scripts/session-audit-hook.mjs）· 回归网
//
// 验的层：①纯函数四态正反样本（漏记 / 放行 / 静默 / 时间错位边界）②三态不许合并
//        （账本没读成 ≠ 查过没事）③自己的 audit.* 不算「账上有了」④不刷屏（报一次、提示一次）
//        ⑤**变异自证**：把「有产出无事件」这条判据改坏 → 测试翻红
//        ⑥落点指针报警（hook 文件被挪走即红）⑦hook 真跑：造 commit 不写事件 → 真落盘
//        audit.bypass，读回自证；补写事件后复跑 → 放行 ⑧异常路径一律 exit 0 且不刷屏。
// 判别力自检问句：把闸放宽（该红不红）或收紧（该静默却说话）的改动，是否都至少有一条断言变红？
// ⚠ 合成凭据一律 CANARY_* 命名，不是真实凭据。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
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

const commit = (sha, ts = T1) => ({ sha, ts, subject: 'feat: x' });
const ev = (type, ts, extra = {}) => ({ type, ts, machine: 'm', seq: 1, event_id: `id-${type}-${ts}`, ...extra });

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
  const file = path.join(SANDBOX, `mutant-${Buffer.from(find).toString('hex').slice(0, 16)}.mjs`);
  fs.writeFileSync(file, src.replace(find, replace), 'utf8');
  return import(toUrl(file));
}

describe('session-audit · 纯函数', () => {
  it('① 有产出无事件 ⇒ 判漏记，missing 是可复查的 evidence 键', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({ produced: { commits: [commit('077f48b1c2d3')] }, events: [], since: T0 });
    assert.strictEqual(r.verdict, 'missing');
    assert.deepStrictEqual(r.missing, ['commit:077f48b']);
    assert.ok(r.detail && r.detail.includes('commit:077f48b'), 'detail 要能复查');
  });

  it('① 多种产出都进 evidence（commit + PR）', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({
      produced: { commits: [commit('aaaaaaabbbb')], prs: [{ number: 891, ts: T1 }] },
      events: [], since: T0,
    });
    assert.strictEqual(r.verdict, 'missing');
    assert.deepStrictEqual(r.missing, ['commit:aaaaaaa', 'pr:#891']);
  });

  it('② 有产出且窗内有事件 ⇒ 放行（静默）', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({
      produced: { commits: [commit('077f48b1c2d3')] },
      events: [ev('job.closed', T1)], since: T0,
    });
    assert.strictEqual(r.verdict, 'silent');
    assert.deepStrictEqual(r.missing, []);
  });

  it('③ 无产出 ⇒ 静默（工作树脏也不算产出，默认档）', async () => {
    const { auditTurn } = await LIB_LOAD;
    const clean = auditTurn({ produced: {}, events: [], since: T0 });
    assert.strictEqual(clean.verdict, 'silent');
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

  it('④ 边界 · 时间错位：事件早于本轮起点 ⇒ 不算覆盖，仍判漏记', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({
      produced: { commits: [commit('077f48b1c2d3')] },
      events: [ev('job.closed', TM1)], since: T0,
    });
    assert.strictEqual(r.verdict, 'missing', '上一轮的事件不该给这一轮的产出背书');
  });

  it('④ 边界 · 恰好落在起点上的事件算窗内（>= 不是 >，宁放行不误报）', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({ produced: { commits: [commit('077f48b1c2d3')] }, events: [ev('job.closed', T0)], since: T0 });
    assert.strictEqual(r.verdict, 'silent');
  });

  it('④ 边界 · 跨时区同一时刻算窗内（比毫秒不比字符串）', async () => {
    const { auditTurn } = await LIB_LOAD;
    // 2026-09-04T02:05:00Z === 2026-09-04T10:05:00+08:00，字符串序反了
    const r = auditTurn({ produced: { commits: [commit('077f48b1c2d3')] }, events: [ev('job.closed', '2026-09-04T02:05:00Z')], since: T0 });
    assert.strictEqual(r.verdict, 'silent', 'ISO 串直接比大小会把跨时区事件判成窗外');
  });

  it('⑤ 三态不合并 · 账本没读成 ⇒ unscanned，既不判红也不判绿', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({ produced: { commits: [commit('077f48b1c2d3')] }, events: { unscanned: true, error: '目录不在' }, since: T0 });
    assert.strictEqual(r.verdict, 'unscanned');
    assert.deepStrictEqual(r.missing, [], '没查成时不许给出 missing（那会被写成 evidence）');
    assert.ok(r.why.includes('没读成'));
  });

  it('⑤ 三态不合并 · since 无法确定 ⇒ unscanned', async () => {
    const { auditTurn } = await LIB_LOAD;
    for (const bad of [undefined, null, '', 'not-a-date']) {
      assert.strictEqual(auditTurn({ produced: { commits: [commit('a1b2c3d4')] }, events: [], since: bad }).verdict, 'unscanned');
    }
  });

  it('⑤ 采集腿没查成只会漏报，绝不把红变绿', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({
      produced: { commits: [commit('077f48b1c2d3')], unscanned: ['prs'] },
      events: [], since: T0,
    });
    assert.strictEqual(r.verdict, 'missing', 'PR 腿没查成不该影响 commit 腿的判红');
    assert.ok(r.why.includes('prs'), '没查成的腿必须写进 why');
  });

  it('⑥ 自己写的 audit.* 不算「账上有了」（否则报一次就永久失声）', async () => {
    const { auditTurn } = await LIB_LOAD;
    const r = auditTurn({
      produced: { commits: [commit('077f48b1c2d3')] },
      events: [ev('audit.bypass', T1, { detail: 'd', evidence: ['commit:zzzzzzz'] })],
      since: T0,
    });
    assert.strictEqual(r.verdict, 'missing', 'evidence 对不上的 audit.bypass 不该覆盖本批产出');
  });

  it('⑦ 不刷屏 · 已有覆盖的 audit.bypass ⇒ remind（只提示，不再写）', async () => {
    const { auditTurn, remindLine } = await LIB_LOAD;
    const bypass = ev('audit.bypass', T1, { detail: 'd', evidence: ['commit:077f48b'] });
    const r = auditTurn({ produced: { commits: [commit('077f48b1c2d3')] }, events: [bypass], since: T0 });
    assert.strictEqual(r.verdict, 'remind');
    assert.deepStrictEqual(r.remindFor, [bypass.event_id]);
    const line = remindLine(r);
    assert.ok(line.includes('补记 commit:077f48b'), '提示要说清补记什么');
    assert.strictEqual(line.split('\n').length, 1, '一句话，不刷屏');
  });

  it('⑦ 不刷屏 · 提示过之后彻底静默', async () => {
    const { auditTurn } = await LIB_LOAD;
    const bypass = ev('audit.bypass', T1, { detail: 'd', evidence: ['commit:077f48b'] });
    const r = auditTurn({
      produced: { commits: [commit('077f48b1c2d3')] }, events: [bypass], since: T0,
      reminded: [bypass.event_id],
    });
    assert.strictEqual(r.verdict, 'silent');
  });

  it('⑧ 变异自证：把「有产出无事件」判据改坏 → 该红的样本不红了', async (t) => {
    const { auditTurn } = await LIB_LOAD;
    const redSample = { produced: { commits: [commit('077f48b1c2d3')] }, events: [], since: T0 };
    assert.strictEqual(auditTurn(redSample).verdict, 'missing', '前提：这个样本在正确实现上是红的');

    await t.test('判据改成「窗内有没有事件都算账上有了」⇒ 翻红', async () => {
      const m = await mutantLib('if (relevant.length > 0) {', 'if (true) {');
      assert.notStrictEqual(
        m.auditTurn(redSample).verdict, 'missing',
        '把覆盖判据改成恒真后样本仍判 missing ⇒ 这条断言不是靠该判据过的，没有判别力'
      );
    });

    await t.test('产出键算法改坏（commit 档失效）⇒ 翻红', async () => {
      const m = await mutantLib("if (tiers.includes('commit')) {", 'if (false) {');
      assert.notStrictEqual(m.auditTurn(redSample).verdict, 'missing', 'commit 档失效后仍判 missing ⇒ 断言没判别力');
    });

    await t.test('把 audit.* 也算成相关事件 ⇒「报一次即失声」那条断言翻红', async () => {
      const m = await mutantLib("if (!type || type.startsWith('audit.')) return false;", 'if (!type) return false;');
      const r = m.auditTurn({
        produced: { commits: [commit('077f48b1c2d3')] },
        events: [ev('audit.bypass', T1, { detail: 'd', evidence: ['commit:zzzzzzz'] })],
        since: T0,
      });
      assert.notStrictEqual(r.verdict, 'missing', '把 audit.* 算成相关事件后仍判 missing ⇒ 该断言没判别力');
    });
  });
});

// ── hook 落点与真跑 ─────────────────────────────────────────────────────────

function runHook(cwd, { ledger, state, sessionId = 's1', tiers, env = {} } = {}) {
  return spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8',
    timeout: 30000,
    input: JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'Stop' }),
    env: {
      ...process.env,
      LEDGER_EVENTS_DIR: ledger,
      DAO_AUDIT_STATE_DIR: state,
      ...(tiers ? { DAO_AUDIT_TIERS: tiers } : {}),
      ...env,
    },
  });
}

function ledgerEvents(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
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
  const sha = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  return sha;
}

describe('session-audit-hook · 落点与真跑', () => {
  it('⑨ 落点指针报警：hook 文件在，且语法过得去', () => {
    // 「写了指针就要配一道会报警的检查」：hook 被挪走/改名/写坏 ⇒ 这里红，
    // 不留指向空气的指针（注册片段在 PR 正文里指的就是这个路径）。
    assert.ok(fs.existsSync(HOOK), `hook 落点不在：${HOOK}`);
    const chk = spawnSync(process.execPath, ['--check', HOOK], { encoding: 'utf8' });
    assert.strictEqual(chk.status, 0, `hook 语法不过：${chk.stderr}`);
    // hook 必须走仓内 lib，不许自己抄一份判据
    const src = fs.readFileSync(HOOK, 'utf8');
    // 同样用正则不用字面量：`from './lib/...'` 的字面量会被孤儿测试闸（㉖）当成本测试自己的引用。
    assert.ok(/from\s+(['"])\.\/lib\/session-audit\.mjs\1/.test(src), 'hook 没用纯函数 ⇒ 判据可能被抄了第二份');
    assert.ok(/from\s+(['"])\.\/lib\/redact\.mjs\1/.test(src), 'hook 没接脱敏 ⇒ 写口可能漏 key');
  });

  it('⑩ 真跑 · 造 commit 不写事件 ⇒ 判红并真落盘 audit.bypass（读回自证）', () => {
    const repo = freshSandbox('repo-red');
    const ledger = freshSandbox('ledger-red');
    const state = freshSandbox('state-red');
    const sha = makeRepo(repo);
    assert.ok(/^[0-9a-f]{40}$/.test(sha), `造 commit 失败：${sha}`);

    // session_id 里塞一个合成凭据：证明写路径真的过了 redact（不是只在纯函数里过）
    const CANARY = 'sk-CANARYaaaabbbbccccddddeeeeffff1234';
    const r = runHook(repo, { ledger, state, sessionId: `sess-${CANARY}` });
    assert.strictEqual(r.status, 0, `hook 退出码应为 0，实际 ${r.status}：${r.stderr}`);
    assert.strictEqual(r.stdout.trim(), '', '判红那一轮不打印（人还在场，账上那条足够）');

    const events = ledgerEvents(ledger);
    assert.strictEqual(events.length, 1, `应恰好落盘 1 条事件，实际 ${events.length}`);
    const e = events[0];
    assert.strictEqual(e.type, 'audit.bypass', '类型必须是既有的 audit.bypass，不新造类型');
    assert.deepStrictEqual(e.evidence, [`commit:${sha.slice(0, 7)}`], 'evidence 必须是能复查的 sha');
    assert.ok(e.detail.includes(`commit:${sha.slice(0, 7)}`), 'detail 要能复查');
    assert.ok(e.event_id && e.ts && e.machine !== undefined, '基础字段齐');
    // 脱敏读回自证：整条事件里不许留下凭据形状
    assert.ok(!JSON.stringify(e).includes(CANARY), '写出的事件里留下了凭据 ⇒ 脱敏没生效');
    assert.ok(JSON.stringify(e).includes('[REDACTED:'), '看不到占位 ⇒ 无法确认真过了脱敏');

    // 幂等：同一轮重复触发不重复写、不报错、不刷屏
    const again = runHook(repo, { ledger, state, sessionId: `sess-${CANARY}` });
    assert.strictEqual(again.status, 0);
    assert.ok(ledgerEvents(ledger).length <= 2, '重复触发不该无限增长');
  });

  it('⑪ 真跑 · 补写事件后复跑 ⇒ 放行（不再写新的 audit.bypass）', () => {
    const repo = freshSandbox('repo-green');
    const ledger = freshSandbox('ledger-green');
    const state = freshSandbox('state-green');
    const sha = makeRepo(repo);

    // 把窗口起点压到 commit 之前，让这一轮确实「看得见」那个产出
    const since = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(state, 's-green.json'), JSON.stringify({ since, reminded: [] }), 'utf8');

    // 先证明这个局面本来是红的
    const red = runHook(repo, { ledger, state, sessionId: 's-green' });
    assert.strictEqual(red.status, 0);
    const afterRed = ledgerEvents(ledger).filter(e => e.type === 'audit.bypass');
    assert.strictEqual(afterRed.length, 1, `前提：没补记时应判红，实际 ${afterRed.length} 条`);

    // 补记一条真事件（非 audit.*），窗口再压回去
    fs.writeFileSync(path.join(state, 's-green.json'), JSON.stringify({ since, reminded: [] }), 'utf8');
    const w = spawnSync(process.execPath, [
      path.join(REPO, 'scripts', 'event-write.mjs'),
      '--type', 'incident', '--ts', new Date().toISOString(),
      '--fingerprint', `commit ${sha.slice(0, 7)} 补记`, '--disposition', '挂账待补', '--why', '补记本轮产出',
    ], { encoding: 'utf8', env: { ...process.env, LEDGER_EVENTS_DIR: ledger } });
    assert.strictEqual(w.status, 0, `补写事件失败：${w.stderr}`);

    const before = ledgerEvents(ledger).filter(e => e.type === 'audit.bypass').length;
    const green = runHook(repo, { ledger, state, sessionId: 's-green' });
    assert.strictEqual(green.status, 0);
    const after = ledgerEvents(ledger).filter(e => e.type === 'audit.bypass').length;
    assert.strictEqual(after, before, '账上有事件了还继续写 audit.bypass ⇒ 闸没放行');
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
      ['cwd 不是 git 仓（采集腿全没查成）', () => ({
        ledger: freshSandbox('led-e4'), state: freshSandbox('state-e4'), cwd: freshSandbox('not-a-repo'),
      })],
      ['stdin 是空的（拿不到宿主 payload）', () => ({
        ledger: freshSandbox('led-e5'), state: freshSandbox('state-e5'), emptyStdin: true,
      })],
    ];

    for (const [label, setup] of cases) {
      await t.test(label, () => {
        const cfg = setup();
        const r = cfg.emptyStdin
          ? spawnSync(process.execPath, [HOOK], {
            encoding: 'utf8', timeout: 30000, input: '',
            env: { ...process.env, LEDGER_EVENTS_DIR: cfg.ledger, DAO_AUDIT_STATE_DIR: cfg.state },
          })
          : runHook(cfg.cwd || repo, { ledger: cfg.ledger, state: cfg.state, sessionId: 'err' });
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
