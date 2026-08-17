// 承认即落点（#583）：标记解析、搬运、三次升级、差集 A 红 B 绿。
// hook 正文只从 transcript 来，stdin 里即便塞了标记也不能入账。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const CORE = path.join(REPO, 'scripts', 'lib', 'deferred.mjs');
const HOOK = path.join(REPO, 'scripts', 'lib', 'deferred-hook.mjs');
const CHECK = path.join(REPO, 'scripts', 'lib', 'deferred-gap-check.mjs');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  →  ' + detail : ''}`); }
}

function runHook({ event, stdinExtra = {}, envExtra = {}, cwd, home, project }) {
  const stdin = JSON.stringify({
    hook_event_name: event,
    session_id: stdinExtra.session_id,
    transcript_path: stdinExtra.transcript_path,
    cwd: stdinExtra.cwd || cwd,
    ...stdinExtra.rest,
  });
  return spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8',
    input: stdin,
    timeout: 15000,
    windowsHide: true,
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      CLAUDE_PROJECT_DIR: project,
      ...envExtra,
    },
  });
}

async function main() {
  const D = await import('file://' + CORE.replace(/\\/g, '/'));
  const H = await import('file://' + HOOK.replace(/\\/g, '/'));
  const C = await import('file://' + CHECK.replace(/\\/g, '/'));

  console.log('\n=== 标记解析 ===');
  {
    const marks = D.extractMarks('先记下。[[挂账: 残留没清 | 手头在派工 | 派完立刻清]] 完。');
    check('抽出一条挂账三字段', marks.length === 1 && marks[0].action === '挂账'
      && marks[0].what === '残留没清' && marks[0].why === '手头在派工' && marks[0].thaw === '派完立刻清',
      JSON.stringify(marks));
    const mixed = D.extractMarks('[[关闭: D-001 | PR #585 已合]][[不做: D-002 | 过期了]][[继续挂: D-003 | 还在挡 | 明天再看]]');
    check('关闭/不做/继续挂都能抽', mixed.map((m) => m.action).join(',') === '关闭,不做,继续挂', JSON.stringify(mixed));
    check('空是什么不入账', D.extractMarks('[[挂账:  | x | y]]').length === 0);
    check('全文冒号也认', D.extractMarks('[[挂账：中文冒号 | 因 | 解]]')[0]?.what === '中文冒号');
  }

  console.log('\n=== transcript 只取 text，不取 thinking，不取 stdin ===');
  {
    const jsonl = [
      JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: '[[挂账: 用户说的 | a | b]]' }] } }),
      JSON.stringify({
        uuid: 'asst-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '[[挂账: thinking里的 | a | b]]' },
            { type: 'text', text: '好。[[挂账: 正文里的 | 因 | 解]]' },
          ],
        },
      }),
    ].join('\n');
    const last = D.lastAssistantText(jsonl);
    check('最后一条 assistant 只要 text', last.text.includes('正文里的') && !last.text.includes('thinking里的'), last.text);
    const marks = D.extractMarks(last.text);
    check('thinking / 用户消息不会被当成承认', marks.length === 1 && marks[0].what === '正文里的', JSON.stringify(marks));
  }

  console.log('\n=== 入账 / 关闭要证据 / 三次升级 ===');
  {
    const first = D.applyMarks({ items: [] }, [
      { action: '挂账', what: '残留没清', why: '在派工', thaw: '派完清' },
    ], { now: 'T0' });
    check('新账 D-001 open', first.doc.items[0].id === 'D-001' && first.doc.items[0].status === 'open'
      && first.delta.added.length === 1, JSON.stringify(first.delta));

    const noEv = D.applyMarks(first.doc, [{ action: '关闭', id: 'D-001', evidence: '' }]);
    check('没证据不能关', noEv.doc.items[0].status === 'open' && noEv.delta.rejected.length === 1, JSON.stringify(noEv.delta));

    const closed = D.applyMarks(first.doc, [{ action: '关闭', id: 'D-001', evidence: 'PR #585 已合' }]);
    check('有证据才关', closed.doc.items[0].status === 'closed' && closed.delta.closed.length === 1);

    const again = D.applyMarks(first.doc, [
      { action: '挂账', what: '残留没清', why: '还在挡', thaw: '下一轮' },
    ]);
    check('同一条再挂 = 继续挂计数 +1', again.doc.items[0].continues === 1 && again.delta.continued.length === 1, JSON.stringify(again.doc.items[0]));

    let doc = first.doc;
    for (let i = 0; i < 3; i++) {
      doc = D.applyMarks(doc, [{ action: '继续挂', id: 'D-001', why: `第${i + 1}次`, thaw: '再等' }]).doc;
    }
    check('第 3 次继续挂升级 escalated', doc.items[0].status === 'escalated' && doc.items[0].continues === 3, JSON.stringify(doc.items[0]));

    const wont = D.applyMarks(first.doc, [{ action: '不做', id: 'D-001', why: '过期了' }]);
    check('明确不做是合法终态', wont.doc.items[0].status === 'wontfix' && wont.delta.wontfix.length === 1);

    const noWhy = D.applyMarks(first.doc, [{ action: '不做', id: 'D-001', why: '' }]);
    check('不做没原因拒绝', noWhy.doc.items[0].status === 'open' && noWhy.delta.rejected.length === 1);

    check('没变化 formatDelta 空', D.formatDelta(D.emptyDelta()) === '');
    check('有变化才出增量行', /^\[挂账·增量\]/.test(D.formatDelta(first.delta)), D.formatDelta(first.delta));
  }

  console.log('\n=== 账本往返 ===');
  {
    const { doc } = D.applyMarks({ items: [] }, [{ action: '挂账', what: '往返', why: '测', thaw: '过' }], { now: 'T1' });
    const text = D.serializeLedger(doc);
    const back = D.parseLedger(text);
    check('serialize/parse 不丢字段', back.items[0].id === 'D-001' && back.items[0].what === '往返', JSON.stringify(back.items[0]));
    check('空账本也能 parse', D.parseLedger('').items.length === 0);
  }

  console.log('\n=== 差集：样本 A 红 / 样本 B 绿 / 零样本不是绿 ===');
  {
    const missT = fs.readFileSync(path.join(REPO, 'tests/fixtures/deferred/missing/transcript.jsonl'), 'utf8');
    const missL = fs.readFileSync(path.join(REPO, 'tests/fixtures/deferred/missing/DEFERRED.md'), 'utf8');
    const hitT = fs.readFileSync(path.join(REPO, 'tests/fixtures/deferred/aligned/transcript.jsonl'), 'utf8');
    const hitL = fs.readFileSync(path.join(REPO, 'tests/fixtures/deferred/aligned/DEFERRED.md'), 'utf8');
    const a = C.inspectDeferredGap({ transcriptTexts: [missT], ledgerText: missL });
    const b = C.inspectDeferredGap({ transcriptTexts: [hitT], ledgerText: hitL });
    const z = C.inspectDeferredGap({ transcriptTexts: ['没有这种标记'], ledgerText: missL });
    const u = C.inspectDeferredGap({ ledgerText: missL });
    check('样本 A 有标记无账本 → gap', a.kind === 'gap' && a.missing.some((x) => x.what.includes('探针 #999')), JSON.stringify(a));
    check('样本 B 已入账 → ok', b.kind === 'ok' && b.tagged.length === 1, JSON.stringify(b));
    check('0 条标记 → empty-external，不是 ok', z.kind === 'empty-external', JSON.stringify(z));
    check('没给 transcript → unscanned，不是 0 条', u.kind === 'unscanned', JSON.stringify(u));
    check('检查器源码不含 Date.now', !/Date\.now\s*\(/.test(fs.readFileSync(CHECK, 'utf8')));
    check('检查器无 from ./deferred.mjs（不复用被检查对象的解析）', !/from ['"]\.\/deferred\.mjs['"]/.test(fs.readFileSync(CHECK, 'utf8')));
  }

  console.log('\n=== dao-check 接线：本仓样本 A/B + hook 装载 ===');
  {
    const r = C.checkDeferred({ root: REPO });
    check('本仓 checkDeferred 绿（A 红已在 inspect 验过，这里是装载+双样本）', !!r.green && !r.fail, JSON.stringify(r));
    const noRoot = C.checkDeferred({});
    check('没给 root → 没查成', !!noRoot.fail, JSON.stringify(noRoot));
  }

  console.log('\n=== hook：正文只从 transcript 来，stdin 正文无效 ===');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-'));
    const home = path.join(tmp, 'home');
    const project = path.join(tmp, 'proj');
    const cwd = path.join(tmp, 'work');
    const slug = D.projectSlug(cwd);
    const sid = 'sess-hook-1';
    const tdir = path.join(home, '.claude', 'projects', slug);
    fs.mkdirSync(tdir, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'DEFERRED.md'), D.serializeLedger({ items: [] }), 'utf8');
    const jsonl = [
      JSON.stringify({ message: { role: 'user', content: 'go' } }),
      JSON.stringify({
        uuid: 'asst-hook',
        message: { role: 'assistant', content: [{ type: 'text', text: '[[挂账: 来自transcript | 因 | 解]]' }] },
      }),
    ].join('\n');
    fs.writeFileSync(path.join(tdir, `${sid}.jsonl`), jsonl, 'utf8');

    const poisoned = runHook({
      event: 'Stop',
      home,
      project,
      cwd,
      stdinExtra: {
        session_id: sid,
        cwd,
        rest: {
          prompt: '[[挂账: 来自stdin | 不该入账 | x]]',
          text: '[[挂账: 也是stdin | 不该入账 | x]]',
        },
      },
    });
    check('Stop hook exit 0（只报不拦）', poisoned.status === 0, `status=${poisoned.status} ${poisoned.stderr}`);
    const ledger = D.parseLedger(fs.readFileSync(path.join(project, 'DEFERRED.md'), 'utf8'));
    check('入账的是 transcript 那条', ledger.items.length === 1 && ledger.items[0].what === '来自transcript', JSON.stringify(ledger.items));
    check('stdin 里的标记没入账', !ledger.items.some((i) => i.what.includes('stdin')), JSON.stringify(ledger.items));

    const again = runHook({
      event: 'Stop',
      home,
      project,
      cwd,
      stdinExtra: { session_id: sid, cwd },
    });
    const ledger2 = D.parseLedger(fs.readFileSync(path.join(project, 'DEFERRED.md'), 'utf8'));
    check('同一条 assistant 再 Stop 不重复入账', again.status === 0 && ledger2.items.length === 1 && ledger2.items[0].continues === 0, JSON.stringify(ledger2.items));

    const prompt = runHook({
      event: 'UserPromptSubmit',
      home,
      project,
      cwd,
      stdinExtra: { session_id: sid, cwd },
    });
    check('下一轮 UserPromptSubmit 播增量', /\[挂账·增量\]/.test(prompt.stdout) && /来自transcript/.test(prompt.stdout), prompt.stdout);
    check('写法提醒每轮都在', /\[挂账\]/.test(prompt.stdout), prompt.stdout);

    const prompt2 = runHook({
      event: 'UserPromptSubmit',
      home,
      project,
      cwd,
      stdinExtra: { session_id: sid, cwd },
    });
    check('增量播过就安静，不再出账况行', !/\[挂账·增量\]/.test(prompt2.stdout) && /\[挂账\]/.test(prompt2.stdout), prompt2.stdout);

    const noSid = runHook({
      event: 'Stop',
      home,
      project,
      cwd,
      stdinExtra: { cwd, rest: { text: '[[挂账: 无session也想从stdin混进来 | a | b]]' } },
    });
    const ledger3 = D.parseLedger(fs.readFileSync(path.join(project, 'DEFERRED.md'), 'utf8'));
    check('没有 session_id 时 stdin 正文仍不能入账', noSid.status === 0 && ledger3.items.length === 1, JSON.stringify(ledger3.items));
    check('没查成写 stderr，不是假装扫过', /没查成/.test(noSid.stderr), noSid.stderr);

    const resolved = H.resolveTranscriptPath({ session_id: sid, cwd }, { USERPROFILE: home, HOME: home });
    check('session_id 能拼出 transcript 路径', resolved.how === 'session_id' && resolved.path.endsWith(`${sid}.jsonl`), JSON.stringify(resolved));
  }

  console.log('\n=== 装载面故意拆掉应红 ===');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-check-'));
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), '{"hooks":{}}', 'utf8');
    const r = C.checkDeferred({ root: tmp });
    check('settings 没有 hook 且没有样本 → 没查成（不是绿）', !!r.fail && !r.green, JSON.stringify(r));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
