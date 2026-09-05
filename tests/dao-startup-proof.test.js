// tests/dao-startup-proof.test.js —— dao 开工验证
//
// 2026-09-06 从 dao.test.js 拆出（原 4220 行 / 1058 用例一个文件）。
// 本套管：粘贴不证明开工——四家 CLI 的屏面判据
// 共享前置在 tests/helpers/dao-harness.js，各套逐字复用，行为与拆分前一致。

const { describe, it } = require('node:test');
const { assert, fs, os, path, spawnSync, REPO, CLI, LIB, S_LOAD, DAO_LOAD, cliInProc, ROUTING_LOAD, waitForOutJson } = require('./helpers/dao-harness');

describe('dao 开工验证', () => {
  it('#602：开工验证保留；#619 订正粘贴定性', async (t) => {
    const S = await S_LOAD;
    const MARKER = '› [Pasted Content 7383 chars]\n';
    const CLEAN = '短摘要：修命令库\nThinking...\n';
    const LOADING = 'Starting MCP servers (0/5)\n';
    const unproven = () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'no_hook_report' });
    const noopSleep = () => {};

    const a = S.verifyStartedPolling({
      dispatchId: 'ctx_a',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [LOADING] } } }),
      proofOnce: () => ({ ok: true, proven: true, source: 'transcript' }),
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    await t.test('开工验证：worker-read 证明（transcript）→ started', () => {
      assert.ok(a.ok === true && a.state === 'started', '开工验证：worker-read 证明（transcript）→ started  →  ' + JSON.stringify(a));
    });

    const b = S.verifyStartedPolling({
      dispatchId: 'ctx_b',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [MARKER] } } }),
      proofOnce: () => ({ ok: true, proven: true, source: 'transcript' }),
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('已有开工证明时 Pasted Content 不挡', () => {
      assert.ok(b.ok === true && b.state === 'started', '已有开工证明时 Pasted Content 不挡  →  ' + JSON.stringify(b));
    });

    const d = S.verifyStartedPolling({
      dispatchId: 'ctx_d',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [LOADING] } } }),
      proofOnce: unproven,
      timeoutMs: 60, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    await t.test('TUI 加载期不算开工 → 超时 failed', () => {
      assert.ok(d.ok === false && d.state === 'failed' && /超时/.test(d.reason), 'TUI 加载期不算开工 → 超时 failed  →  ' + JSON.stringify(d));
    });

    const e = S.verifyStartedPolling({
      dispatchId: 'ctx_e',
      readOnce: () => ({ error: 'terminal read timeout' }),
      proofOnce: unproven,
      timeoutMs: 60, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    await t.test('全程没读成 → 超时 failed 且带 unscanned', () => {
      assert.ok(e.ok === false && e.unscanned && e.unscanned.unscanned === true, '全程没读成 → 超时 failed 且带 unscanned  →  ' + JSON.stringify(e));
    });

    const g = S.verifyStartedPolling({
      dispatchId: 'ctx_g',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [CLEAN] } } }),
      proofOnce: () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'provider_unsupported' }),
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    await t.test('pi 正常提交：proof 不可用 + 屏面稳定 → started（proofFallback）',
      () => {
        assert.ok(g.ok === true && g.state === 'started' && g.proofFallback === true && g.stableRounds >= 3, 'pi 正常提交：proof 不可用 + 屏面稳定 → started（proofFallback）  →  ' + JSON.stringify(g));
      });

    let readsH = 0;
    const h = S.verifyStartedPolling({
      dispatchId: 'ctx_h',
      readOnce: () => {
        readsH++;
        return { ok: true, result: { terminal: { tail: [readsH <= 4 ? LOADING : CLEAN] } } };
      },
      proofOnce: () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'session_not_reported' }),
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    await t.test('pi 加载开头：加载期不算绿，结束后连续稳定才判绿',
      () => {
        assert.ok(h.ok === true && h.state === 'started' && h.proofFallback === true && h.stableRounds >= 3 && readsH >= 7, 'pi 加载开头：加载期不算绿，结束后连续稳定才判绿  →  ' + JSON.stringify(h));
      });

    const j = S.verifyStartedPolling({
      dispatchId: 'ctx_j',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [] } } }),
      proofOnce: () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'provider_unsupported' }),
      timeoutMs: 60, intervalMs: 5, sleep: noopSleep, label: '工人',
    });
    await t.test('proof 不可用 + 空屏 → 不许判绿，超时 failed',
      () => {
        assert.ok(j.ok === false && j.state === 'failed' && /超时/.test(j.reason), 'proof 不可用 + 空屏 → 不许判绿，超时 failed  →  ' + JSON.stringify(j));
      });

    // #877：pi 审官注入后屏面滚动，任务书指纹滚出屏外只剩 spinner——曾验过指纹 + Working = 开工。
    const EXPECT_877 = '按 host/skills/dispatch/review-standard.md 审 PR #877';
    const SPIN = ' ⠼ Working… (esc to interrupt)\n';
    let readsK = 0;
    const k = S.verifyStartedPolling({
      dispatchId: 'ctx_k',
      readOnce: () => {
        readsK++;
        return { ok: true, result: { terminal: { tail: [readsK <= 2 ? '任务书：' + EXPECT_877 + '\n' : SPIN] } } };
      },
      proofOnce: () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'provider_unsupported' }),
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官', expect: EXPECT_877,
    });
    await t.test('#877 指纹只闪 2 轮就滚屏、之后 Working → started（workingAfterInject）', () => {
      assert.ok(k.ok === true && k.state === 'started' && k.workingAfterInject === true,
        '#877 指纹只闪 2 轮就滚屏、之后 Working → started（workingAfterInject）  →  ' + JSON.stringify(k));
    });

    const m = S.verifyStartedPolling({
      dispatchId: 'ctx_m',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [SPIN] } } }),
      proofOnce: () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'provider_unsupported' }),
      timeoutMs: 60, intervalMs: 5, sleep: noopSleep, label: '审官', expect: EXPECT_877,
    });
    await t.test('#877 反例：从未见过任务书指纹、只有 Working → 仍超时 failed（#762 不回归）', () => {
      assert.ok(m.ok === false && m.state === 'failed' && /超时/.test(m.reason),
        '#877 反例：从未见过任务书指纹、只有 Working → 仍超时 failed（#762 不回归）  →  ' + JSON.stringify(m));
    });

    // #877 治本：pi session jsonl 直读当开工证明（orca worker-read 不认 pi）。
    await t.test('#877 piSessionSlug：/ 全换 -，首尾 -/--', () => {
      assert.strictEqual(S.piSessionSlug('/srv/projects/windsurf-dao'), '--srv-projects-windsurf-dao--');
    });
    {
      const piHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proof-'));
      const cwd = '/home/orca/orca/workspaces/x/PR-877-审官';
      const sessDir = path.join(piHome, '.pi', 'agent', 'sessions', S.piSessionSlug(cwd));
      fs.mkdirSync(sessDir, { recursive: true });
      const noneYet = S.piSessionProof({ cwd, sinceMs: Date.now() - 90000, home: piHome });
      await t.test('#877 pi proof：目录空 → 不 proven 不 unscanned（继续轮询）', () => {
        assert.ok(noneYet.ok === true && noneYet.proven === false && !noneYet.unscanned, JSON.stringify(noneYet));
      });
      const oldFile = path.join(sessDir, 'old.jsonl');
      fs.writeFileSync(oldFile, '{"type":"message","message":{"role":"user","content":[]}}\n');
      const past = new Date(Date.now() - 30 * 60 * 1000);
      fs.utimesSync(oldFile, past, past);
      const stale = S.piSessionProof({ cwd, sinceMs: Date.now() - 90000, home: piHome });
      await t.test('#877 pi proof：只有 20 分钟前旧会话 → 不 proven（上一针残留不当证据）', () => {
        assert.ok(stale.ok === true && stale.proven === false, JSON.stringify(stale));
      });
      fs.writeFileSync(path.join(sessDir, 'fresh.jsonl'),
        '{"type":"session","version":3}\n{"type":"message","message":{"role":"user","content":[{"type":"text","text":"任务书"}]}}\n');
      const proven = S.piSessionProof({ cwd, sinceMs: Date.now() - 90000, home: piHome });
      await t.test('#877 pi proof：新 jsonl 含 role:user → proven（任务书已进上下文）', () => {
        assert.ok(proven.ok === true && proven.proven === true && proven.source === 'pi-session', JSON.stringify(proven));
      });
      const noDir = S.piSessionProof({ cwd: '/no/such/tree', sinceMs: 0, home: piHome });
      await t.test('#877 pi proof：session 目录不存在 → 不 proven 不 unscanned', () => {
        assert.ok(noDir.ok === true && noDir.proven === false && !noDir.unscanned, JSON.stringify(noDir));
      });
    }

    const daoSrcPoll = fs.readFileSync(CLI, 'utf8');
    await t.test('dao.mjs 不再调用 verifyInjectionPolling', () => {
      assert.ok(!/verifyInjectionPolling\(/.test(daoSrcPoll), 'dao.mjs 不再调用 verifyInjectionPolling');
    });
    await t.test('dao.mjs 工人/审官/attach/续派走 finishWorkerInject', () => {
      assert.ok((daoSrcPoll.match(/finishWorkerInject\(\{/g) || []).length >= 4, 'dao.mjs 工人/审官/attach/续派走 finishWorkerInject  →  ' + (daoSrcPoll.match(/finishWorkerInject\(\{/g) || []).length);
    });

    const okLine = S.assertInjectText('读 host/skills/dispatch/templates/soldier-book.md spec=修 X #602', { label: '士兵注入' });
    await t.test('短指针放行', () => {
      assert.ok(okLine.ok === true, '短指针放行  →  ' + JSON.stringify(okLine));
    });
    const withNl = S.assertInjectText('a\nb', { label: '士兵注入' });
    await t.test('含换行不再拒（按 agent 转码，不禁换行）', () => {
      assert.ok(withNl.ok === true && withNl.newlines === true, '含换行不再拒（按 agent 转码，不禁换行）  →  ' + JSON.stringify(withNl));
    });
    const tooLong = S.assertInjectText('x'.repeat(S.INJECT_MAX_BYTES + 1), { label: '士兵注入' });
    await t.test('次闸：超长单行仍拒', () => {
      assert.ok(tooLong.ok === false && /上限/.test(tooLong.error), '次闸：超长单行仍拒  →  ' + JSON.stringify(tooLong));
    });
    await t.test('#619 闸明说只量我们那一半', () => {
      assert.ok(okLine.scope === 'our-spec-only' && /preamble/.test(okLine.note) && tooLong.scope === 'our-spec-only', '#619 闸明说只量我们那一半  →  ' + JSON.stringify({ ok: okLine, tooLong }));
    });

    await t.test('grok：\n → ESC+CR', () => {
      assert.ok(S.encodeSendText('a\nb\nc', 'grok') === 'a\x1b\rb\x1b\rc', 'grok：\n → ESC+CR');
    });
    await t.test('claude：\n 原样', () => {
      assert.ok(S.encodeSendText('a\nb', 'claude') === 'a\nb', 'claude：\n 原样');
    });
    await t.test('pi / opencode-go：\n 原样', () => {
      assert.ok(S.encodeSendText('a\nb', 'opencode-go') === 'a\nb' && S.newlineCodec('pi') === 'passthrough', 'pi / opencode-go：\n 原样');
    });
    await t.test('codex：不转码（换行留不住）', () => {
      assert.ok(S.encodeSendText('a\nb', 'codex') === 'a\nb' && S.newlineCodec('gpt-5.6-sol') === 'passthrough-lost', 'codex：不转码（换行留不住）');
    });
    const sent = S.argsTerminalSend({ terminal: 't', text: '一\n二', agent: 'grok' });
    await t.test('argsTerminalSend(grok) 载荷已转码且不含裸 LF', () => {
      assert.ok(sent.includes('一\x1b\r二') && !sent.includes('一\n二'), 'argsTerminalSend(grok) 载荷已转码且不含裸 LF');
    });
  });

  it('#661/#679：粘贴不证明开工——等 timeout 仍在框里才红，垫片补回车已退役', async (t) => {
    const S = await S_LOAD;
    const MARKER = '› [Pasted Content 4700 chars]\n';
    const CURSOR_ONLY = '[Pasted text #1 +86 lines]\n';
    const CURSOR_STUCK = '[Pasted text #1 +86 lines]\n→ 短摘要：修命令库\n';
    const CLEAN = '短摘要：审 PR #619\nThinking...\n';
    const WORKING = '短摘要：修命令库\nRunning: reading scripts/lib/dao-cmd.mjs\n';
    const noopSleep = () => {};
    const unproven = () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'no_hook_report' });
    const unavailable = () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'provider_unsupported' });

    let waitReads = 0;
    const fastFail = S.verifyStartedPolling({
      dispatchId: 'ctx_fast',
      readOnce: () => {
        waitReads += 1;
        return { ok: true, result: { terminal: { tail: [MARKER] } } };
      },
      proofOnce: unproven,
      timeoutMs: 50, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('#679：粘贴后等到超时仍在框里才 unsubmitted-paste，不是首拍即杀', () => {
      assert.ok(fastFail.ok === false && fastFail.state === 'unsubmitted-paste' && fastFail.pasteSubmitted === false && waitReads > 1 && fastFail.elapsedMs >= 40 && /注入未提交/.test(fastFail.reason) && /禁止粘贴当开工/.test(fastFail.reason) && !/超时/.test(fastFail.reason) && typeof fastFail.text === 'string' && /Pasted Content/.test(fastFail.text), '等到超时仍在框里  →  ' + JSON.stringify({ fastFail, waitReads }));
    });

    const cursorOnly = S.verifyStartedPolling({
      dispatchId: 'ctx_cursor_only',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [CURSOR_ONLY] } } }),
      proofOnce: unproven,
      timeoutMs: 50, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('故意只贴不发：等到超时仍只有 [Pasted text] → 红，不许当开工', () => {
      assert.ok(cursorOnly.ok === false && cursorOnly.state === 'unsubmitted-paste' && cursorOnly.pasteSubmitted === false && /禁止粘贴当开工/.test(cursorOnly.reason), '等到超时仍只有 [Pasted text] → 红  →  ' + JSON.stringify(cursorOnly));
    });

    const cursorStuck = S.verifyStartedPolling({
      dispatchId: 'ctx_cursor_stuck',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [CURSOR_STUCK] } } }),
      proofOnce: unproven,
      timeoutMs: 50, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('故意违规：粘贴块 + 未发 follow-up，等到超时 → 红，不许假装开工', () => {
      assert.ok(cursorStuck.ok === false && cursorStuck.state === 'unsubmitted-paste' && cursorStuck.pasteSubmitted === false, '等到超时仍未发  →  ' + JSON.stringify(cursorStuck));
    });

    let recN = 0;
    const pasteThenWork = S.verifyStartedPolling({
      dispatchId: 'ctx_wait_work',
      readOnce: () => {
        recN += 1;
        const tail = recN <= 2 ? [MARKER] : [WORKING];
        return { ok: true, result: { terminal: { tail } } };
      },
      proofOnce: unavailable,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('#679：粘贴后指纹消失且在干活 → 绿，不是立刻杀', () => {
      assert.ok(pasteThenWork.ok === true && pasteThenWork.state === 'started' && recN > 2 && pasteThenWork.proofFallback === true, '粘贴后发出去  →  ' + JSON.stringify({ pasteThenWork, recN }));
    });

    let proofReads = 0;
    let provenReads = 0;
    const provenSession = S.verifyStartedPolling({
      dispatchId: 'ctx_proven',
      readOnce: () => {
        provenReads += 1;
        // 第一拍粘贴块还没画出来（屏面干净），第二拍才出现——和真实时序一致。
        const tail = provenReads === 1 ? [CLEAN] : [MARKER];
        return { ok: true, result: { terminal: { tail } } };
      },
      proofOnce: () => {
        proofReads += 1;
        return proofReads === 1
          ? unproven()
          : { ok: true, proven: true, source: 'transcript' };
      },
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('绿样本：worker-read 真 transcript 证明 session → started（外部证据优先于屏上粘贴行）', () => {
      assert.ok(provenSession.ok === true && provenSession.state === 'started' && proofReads === 2 && provenReads === 1, '绿样本：worker-read 真 transcript → started  →  ' + JSON.stringify({ provenSession, proofReads, provenReads }));
    });

    const stillStuck = S.verifyStartedPolling({
      dispatchId: 'ctx_stuck',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [MARKER] } } }),
      proofOnce: unproven,
      timeoutMs: 60, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('无证明 + 等到超时仍是粘贴块 → unsubmitted-paste', () => {
      assert.ok(stillStuck.ok === false && stillStuck.state === 'unsubmitted-paste' && stillStuck.pasteSubmitted === false && /注入未提交/.test(stillStuck.reason) && stillStuck.text, '等到超时仍是粘贴块  →  ' + JSON.stringify(stillStuck));
    });

    const cleanOk = S.verifyStartedPolling({
      dispatchId: 'ctx_clean',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [CLEAN] } } }),
      proofOnce: unavailable,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('绿样本：屏面干净 + proof 不可用 → 稳定轮判开工（agent 真在干活）', () => {
      assert.ok(cleanOk.ok === true && cleanOk.state === 'started' && cleanOk.proofFallback === true, '屏面干净 + proof 不可用 → 稳定轮判开工  →  ' + JSON.stringify(cleanOk));
    });

    const workOk = S.verifyStartedPolling({
      dispatchId: 'ctx_work',
      readOnce: () => ({ ok: true, result: { terminal: { tail: [WORKING] } } }),
      proofOnce: unavailable,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('绿样本：Cursor 粘贴后状态行 Running → 真在干活，不当未提交 → 稳定轮绿', () => {
      assert.ok(workOk.ok === true && workOk.state === 'started' && workOk.proofFallback === true, 'Cursor 粘贴后在干活 → 稳定轮绿  →  ' + JSON.stringify(workOk));
    });

    const allRed = [];
    for (let i = 0; i < 10; i++) {
      allRed.push(S.verifyStartedPolling({
        dispatchId: `ctx_h${i}`,
        readOnce: () => ({ ok: true, result: { terminal: { tail: [`[Pasted Content ${4000 + i} chars]`] } } }),
        proofOnce: unproven,
        timeoutMs: 40, intervalMs: 5, sleep: noopSleep, label: '审官',
      }));
    }
    await t.test('连续 10 个只贴不发样本：全部红、全部 pasteSubmitted:false、零垫片', () => {
      assert.ok(allRed.length === 10 && allRed.every(r => r.ok === false && r.state === 'unsubmitted-paste' && r.pasteSubmitted === false), '连续 10 个只贴不发样本：全部红  →  ' + JSON.stringify(allRed.map(r => r.state)));
    });

    const libSrc = fs.readFileSync(LIB, 'utf8');
    await t.test('垫片退役：dao-cmd.mjs 不再定义 completePendingPaste、不再有 sendEnter', () => {
      assert.ok(!/export function completePendingPaste\(/.test(libSrc) && !/sendEnter/.test(libSrc), 'dao-cmd.mjs 不再定义 completePendingPaste 垫片、不再有 sendEnter');
    });
    const daoSrc2 = fs.readFileSync(CLI, 'utf8');
    await t.test('dao.mjs 不再有 sendEnter / sendEnterHandle 垫片路径', () => {
      assert.ok(!/sendEnter/.test(daoSrc2), 'dao.mjs 不再有 sendEnter 垫片路径');
    });
    await t.test('回滚前先存屏（failCreated 调 snapshotHandleScreen）', () => {
      assert.ok(/function failCreated[\s\S]*snapshotHandleScreen/.test(daoSrc2) && /function snapshotHandleScreen/.test(daoSrc2), '回滚前先存屏（failCreated 调 snapshotHandleScreen）');
    });
  });

  it('#651：Cursor 认出 [Pasted text #N +M lines] 与未发出 follow-up（含审红 1/2 返工补样）', async (t) => {
    const S = await S_LOAD;
    const CURSOR_STUCK = '[Pasted text #1 +86 lines]\n→ 短摘要：修命令库\n';              // 未提交：粘贴块 + 输入框压着 follow-up
    const CURSOR_STUCK_FOLLOWUPS = '[Pasted text #1 +86 lines]\n2 follow-ups\n';          // 未提交：follow-ups 计数
    const CURSOR_WORKING = '[Pasted text #1 +86 lines]\nRunning: reading scripts/lib/dao-cmd.mjs\n'; // 已提交在干活
    const CURSOR_EMPTY_PROMPT = '[Pasted text #1 +86 lines]\n→\n';                        // 审红1：粘贴块单独 + 空 → 提示
    const CURSOR_ALONE = '[Pasted text #1 +86 lines]\n';                                  // 审红1：#634 原现场，只有粘贴块
    const CURSOR_FOLLOWUP_ALONE = '→ 短摘要：修命令库\n';                                   // 第二条指纹：只有 → 行未发
    const CURSOR_WORK_WORD = '[Pasted text #1 +86 lines]\n→ 短摘要：Reading Cursor 粘贴并提交\n'; // 审红2：follow-up 正文含 Reading
    const noopSleep = () => {};
    const unproven = () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'no_hook_report' });
    const unavailable = () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'provider_unsupported' });

    // 1. 指纹认出：pastedContentMatch / verifyInjection
    const m1 = S.pastedContentMatch(CURSOR_STUCK);
    await t.test('pastedContentMatch 认出 Cursor 粘贴块 + 未发 follow-up', () => {
      assert.ok(m1 === '[Pasted text #1 +86 lines]', 'pastedContentMatch 认出 Cursor 粘贴块  →  ' + m1);
    });
    const m2 = S.pastedContentMatch(CURSOR_STUCK_FOLLOWUPS);
    await t.test('follow-ups 字样也算未提交', () => {
      assert.ok(m2 === '[Pasted text #1 +86 lines]', 'follow-ups 字样也算未提交  →  ' + m2);
    });
    const m3 = S.pastedContentMatch(CURSOR_WORKING);
    await t.test('已提交在干活（Running/读文件）→ 不当未提交', () => {
      assert.ok(m3 === null, '已提交在干活 → 不当未提交  →  ' + m3);
    });
    const m4 = S.pastedContentMatch(CURSOR_EMPTY_PROMPT);
    await t.test('审红1：粘贴块单独出现（空 → 提示）也算未提交', () => {
      assert.ok(m4 === '[Pasted text #1 +86 lines]', '审红1：粘贴块单独出现 → 未提交  →  ' + m4);
    });
    const mAlone = S.pastedContentMatch(CURSOR_ALONE);
    await t.test('审红1：只有 [Pasted text #1 +86 lines] → 未提交', () => {
      assert.ok(mAlone === '[Pasted text #1 +86 lines]', '审红1：只有粘贴块 → 未提交  →  ' + mAlone);
    });
    const mFollowup = S.pastedContentMatch(CURSOR_FOLLOWUP_ALONE);
    await t.test('第二条指纹：只有 → 行未发 follow-up → 未提交', () => {
      assert.ok(mFollowup !== null && /→/.test(mFollowup), '第二条指纹：→ 行未发 follow-up → 未提交  →  ' + mFollowup);
    });
    const mWorkWord = S.pastedContentMatch(CURSOR_WORK_WORD);
    await t.test('审红2：follow-up 正文含 Reading/Working 仍红', () => {
      assert.ok(mWorkWord === '[Pasted text #1 +86 lines]', '审红2：follow-up 正文含 Reading 仍红  →  ' + mWorkWord);
    });

    const vStuck = S.verifyInjection({ text: CURSOR_STUCK });
    await t.test('故意违规：Cursor 未提交 → 注入验证红', () => {
      assert.ok(vStuck.ok === false && /Pasted text/.test(vStuck.reason) && vStuck.evidence === '[Pasted text #1 +86 lines]', '故意违规：Cursor 未提交 → 注入验证红  →  ' + JSON.stringify(vStuck));
    });
    const vAlone = S.verifyInjection({ text: CURSOR_ALONE });
    await t.test('审红1：只有粘贴块 → 注入验证红', () => {
      assert.ok(vAlone.ok === false && vAlone.evidence === '[Pasted text #1 +86 lines]' && /Pasted text/.test(vAlone.reason), '审红1：只有粘贴块 → 注入验证红  →  ' + JSON.stringify(vAlone));
    });
    const vFollowupInj = S.verifyInjection({ text: CURSOR_FOLLOWUP_ALONE });
    await t.test('第二条指纹：只有 → 行未发 follow-up → 注入验证红', () => {
      assert.ok(vFollowupInj.ok === false && /follow-up/.test(vFollowupInj.reason), '第二条指纹：→ 行未发 follow-up → 注入验证红  →  ' + JSON.stringify(vFollowupInj));
    });
    const vWorkWordInj = S.verifyInjection({ text: CURSOR_WORK_WORD });
    await t.test('审红2：follow-up 正文含 Reading → 注入验证红', () => {
      assert.ok(vWorkWordInj.ok === false && /Pasted text/.test(vWorkWordInj.reason), '审红2：follow-up 正文含 Reading → 注入验证红  →  ' + JSON.stringify(vWorkWordInj));
    });
    const vWork = S.verifyInjection({ text: CURSOR_WORKING });
    await t.test('已提交 + 在干活 → 注入验证绿', () => {
      assert.ok(vWork.ok === true, '已提交 + 在干活 → 注入验证绿  →  ' + JSON.stringify(vWork));
    });
    const grokStillRed = S.verifyInjection({ text: '⚠ MCP failed\n[Pasted Content 4686 chars]\n›' });
    await t.test('Grok Pasted Content 折叠仍然红', () => {
      assert.ok(grokStillRed.ok === false && grokStillRed.evidence === '[Pasted Content 4686 chars]', 'Grok Pasted Content 折叠仍然红  →  ' + JSON.stringify(grokStillRed));
    });

    const leftoverRework = S.leftoverDispatchMatch('【返工指令 · 闭环自动流转 · 第 1 轮】\n[Pasted Content 5711 chars]');
    await t.test('#633 leftoverDispatchMatch 认出框里返工指令', () => {
      assert.ok(leftoverRework === '【返工指令', '#633 leftoverDispatchMatch 认出返工  →  ' + leftoverRework);
    });
    const leftoverRecheck = S.leftoverDispatchMatch('【复核指令 · 闭环自动流转】');
    await t.test('#633 leftoverDispatchMatch 认出复核指令', () => {
      assert.ok(leftoverRecheck === '【复核指令', '#633 leftoverDispatchMatch 认出复核  →  ' + leftoverRecheck);
    });
    const leftoverGeneric = S.leftoverDispatchMatch('[Pasted Content 5711 chars]\n›');
    await t.test('#633 无返工/复核字的粘贴块不算残留派活', () => {
      assert.ok(leftoverGeneric === null, '#633 普通粘贴块不是残留派活  →  ' + leftoverGeneric);
    });

    // 2. verifyStartedPolling：只贴不发等到超时才红；垫片没了，没有「补 enter → 绿」这条路。
    //    绿色来源：真 transcript、指纹消失且在干活、或屏面稳定。
    let fastReads = 0;
    const pollFast = S.verifyStartedPolling({
      dispatchId: 'ctx_poll_fast',
      readOnce: () => {
        fastReads += 1;
        return { ok: true, result: { terminal: { tail: ['[Pasted text #1 +86 lines]', '→ 短摘要：修命令库'] } } };
      },
      proofOnce: unproven,
      timeoutMs: 50, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('故意只贴不发：粘贴块 + follow-up → 等到超时才红，pasteSubmitted:false', () => {
      assert.ok(pollFast.ok === false && pollFast.state === 'unsubmitted-paste' && fastReads > 1 && pollFast.pasteSubmitted === false, '等到超时才红  →  ' + JSON.stringify({ pollFast, fastReads }));
    });

    // 绿样本（真在干活）：粘贴块从未出现在屏上，只有状态行。
    let recReads = 0;
    const pollRecover = S.verifyStartedPolling({
      dispatchId: 'ctx_poll_recover',
      readOnce: () => {
        recReads += 1;
        return { ok: true, result: { terminal: { tail: ['Running: reading files'] } } };
      },
      proofOnce: unavailable,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('绿样本：屏上没有未提交粘贴、状态行在干活 → 稳定轮判开工', () => {
      assert.ok(pollRecover.ok === true && pollRecover.state === 'started' && pollRecover.proofFallback === true, '绿样本：屏上没有未提交粘贴、在干活 → 稳定轮绿  →  ' + JSON.stringify(pollRecover));
    });

    const pollStuck = S.verifyStartedPolling({
      dispatchId: 'ctx_poll_stuck',
      readOnce: () => ({ ok: true, result: { terminal: { tail: ['[Pasted text #1 +86 lines]', '→ 短摘要：修命令库'] } } }),
      proofOnce: unproven,
      timeoutMs: 50, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('Cursor 未提交（无 sendEnter）→ 等到超时才报注入未提交', () => {
      assert.ok(pollStuck.ok === false && pollStuck.state === 'unsubmitted-paste' && /注入未提交/.test(pollStuck.reason) && !/超时/.test(pollStuck.reason) && /Pasted text/.test(pollStuck.evidence), 'Cursor 未提交等到超时  →  ' + JSON.stringify(pollStuck));
    });

    const pollWork = S.verifyStartedPolling({
      dispatchId: 'ctx_poll_work',
      readOnce: () => ({ ok: true, result: { terminal: { tail: ['[Pasted text #1 +86 lines]', 'Running: reading scripts/lib/dao-cmd.mjs'] } } }),
      proofOnce: unavailable,
      timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('Cursor 已提交 + 在干活 → 不报未提交，屏面稳定判开工', () => {
      assert.ok(pollWork.ok === true && pollWork.state === 'started' && pollWork.proofFallback === true, 'Cursor 已提交 + 在干活 → 屏面稳定判开工  →  ' + JSON.stringify(pollWork));
    });

    // Cursor 只贴不发 / 粘贴后发出去 的样本在上节已按 #679 重写（等到超时才红 / 指纹消失且干活才绿），
    // 这里只剩「只有粘贴块 → 红」与「follow-up 未发 → 红」两个补样。
    const pollAlone = S.verifyStartedPolling({
      dispatchId: 'ctx_poll_alone',
      readOnce: () => ({ ok: true, result: { terminal: { tail: ['[Pasted text #1 +86 lines]'] } } }),
      proofOnce: unproven,
      timeoutMs: 50, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('审红1：只有粘贴块 → 等到超时才红', () => {
      assert.ok(pollAlone.ok === false && pollAlone.state === 'unsubmitted-paste' && /注入未提交/.test(pollAlone.reason) && !/超时/.test(pollAlone.reason), '审红1：只有粘贴块等到超时  →  ' + JSON.stringify(pollAlone));
    });

    const pollWorkWord = S.verifyStartedPolling({
      dispatchId: 'ctx_poll_workword',
      readOnce: () => ({ ok: true, result: { terminal: { tail: ['[Pasted text #1 +86 lines]', '→ 短摘要：Reading Cursor 粘贴并提交'] } } }),
      proofOnce: unproven,
      timeoutMs: 50, intervalMs: 5, sleep: noopSleep, label: '审官',
    });
    await t.test('审红2：follow-up 正文含 Reading → 等到超时才红', () => {
      assert.ok(pollWorkWord.ok === false && pollWorkWord.state === 'unsubmitted-paste', '审红2：follow-up 正文含 Reading 等到超时  →  ' + JSON.stringify(pollWorkWord));
    });
  });

  it('#680：cursor [Pasted text] 是提交后残留；codex [Pasted Content] 仍是未提交', async (t) => {
    const S = await S_LOAD;
    const noopSleep = () => {};
    const unproven = () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'no_hook_report' });
    const PASTE = '[Pasted text #1 +86 lines]';
    const CODEX = '[Pasted Content 5037 chars]';

    await t.test('cursor 通道：Working 在粘贴块上方 + 残留不消失 → 绿，不是 unsubmitted-paste', () => {
      const r = S.verifyStartedPolling({
        dispatchId: 'ctx_cursor_residue',
        provider: 'cursor',
        readOnce: () => ({
          ok: true,
          result: { terminal: { tail: ['Working', PASTE] } },
        }),
        proofOnce: unproven,
        timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '工人',
      });
      assert.ok(r.ok === true && r.state === 'started' && r.cursorStart === 'working' && /Pasted text/.test(r.text),
        'cursor 残留+Working → 绿  →  ' + JSON.stringify(r));
    });

    await t.test('cursor-agent 通道别名同样认 Working', () => {
      const r = S.verifyStartedPolling({
        dispatchId: 'ctx_cursor_agent',
        provider: 'cursor-agent',
        readOnce: () => ({
          ok: true,
          result: { terminal: { tail: ['Working', PASTE] } },
        }),
        proofOnce: unproven,
        timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '工人',
      });
      assert.ok(r.ok === true && r.state === 'started', JSON.stringify(r));
    });

    await t.test('cursor 通道：残留不消失但输出在动 → 绿', () => {
      let n = 0;
      const r = S.verifyStartedPolling({
        dispatchId: 'ctx_cursor_moving',
        provider: 'cursor',
        readOnce: () => {
          n += 1;
          const body = n === 1 ? '短摘要：修命令库' : `短摘要：修命令库\n已读 ${n} 个文件`;
          return { ok: true, result: { terminal: { tail: [body, PASTE] } } };
        },
        proofOnce: unproven,
        timeoutMs: 5000, intervalMs: 5, sleep: noopSleep, label: '工人',
      });
      assert.ok(r.ok === true && r.state === 'started' && r.cursorStart === 'output-moving' && n > 1,
        'cursor 输出在动 → 绿  →  ' + JSON.stringify({ r, n }));
    });

    await t.test('codex 通道：[Pasted Content] 等到超时仍拦', () => {
      const r = S.verifyStartedPolling({
        dispatchId: 'ctx_codex_stuck',
        provider: 'gpt',
        readOnce: () => ({ ok: true, result: { terminal: { tail: [CODEX] } } }),
        proofOnce: unproven,
        timeoutMs: 50, intervalMs: 5, sleep: noopSleep, label: '审官',
      });
      assert.ok(r.ok === false && r.state === 'unsubmitted-paste' && /Pasted Content/.test(r.evidence || ''),
        'codex 未提交仍拦  →  ' + JSON.stringify(r));
    });

    await t.test('未标通道时 Codex Pasted Content 仍拦（默认）', () => {
      const r = S.verifyStartedPolling({
        dispatchId: 'ctx_codex_default',
        readOnce: () => ({ ok: true, result: { terminal: { tail: [CODEX] } } }),
        proofOnce: unproven,
        timeoutMs: 50, intervalMs: 5, sleep: noopSleep, label: '审官',
      });
      assert.ok(r.ok === false && r.state === 'unsubmitted-paste', JSON.stringify(r));
    });

    const daoSrc = fs.readFileSync(CLI, 'utf8');
    await t.test('审官路开工探针把 provider 传给 verifyStartedPolling（工人派工路已 fire-and-forget 不验）', () => {
      // 2026-08-23：派工主路（cmdDispatch/cmdDispatchBatch）删掉注入后开工验证；
      // 审官路（worker-done 复用/续派/reviewer-create/reviewer-attach）保留真认账。
      const calls = daoSrc.match(/finishWorkerInject\(\{[\s\S]{0,220}\}\)/g) || [];
      assert.ok(/provider: reviewerLaunch\.provider/.test(daoSrc)
        && /provider: launch\.provider/.test(daoSrc)
        && calls.every(c => !/workerLaunch|childLaunch/.test(c)),
        'dao.mjs 审官路开工探针要带 provider，工人派工路不再验  →  ' + calls.join('\n---\n'));
    });
  });

  it('#984：超时常量可注入；等超时才红，不许立刻杀', async (t) => {
    const S = await S_LOAD;
    const MARKER = '› [Pasted Content 4700 chars]\n';
    const unproven = () => ({ ok: true, proven: false, source: 'terminal', fallbackReason: 'no_hook_report' });

    function fakeClock(startMs) {
      let t = startMs;
      return {
        now: () => t,
        sleep: (ms) => { t += Math.max(1, ms); },
      };
    }

    await t.test('短超时：粘贴等到超时才 unsubmitted-paste，不是首拍即杀', () => {
      const c = fakeClock(1_000);
      let reads = 0;
      const r = S.verifyStartedPolling({
        dispatchId: 'ctx_984_short',
        readOnce: () => { reads += 1; return { ok: true, result: { terminal: { tail: [MARKER] } } }; },
        proofOnce: unproven,
        timeoutMs: 50, intervalMs: 5, sleep: c.sleep, now: c.now, label: '审官',
      });
      assert.equal(r.ok, false);
      assert.equal(r.state, 'unsubmitted-paste');
      assert.equal(r.pasteSubmitted, false);
      assert.ok(reads > 1, JSON.stringify({ r, reads }));
      assert.ok(r.elapsedMs >= 50, JSON.stringify({ r, reads }));
    });

    await t.test('变异：同一套粘贴把超时改回 5000，轮数必须变多（注入真生效）', () => {
      const short = fakeClock(1_000);
      let shortReads = 0;
      S.verifyStartedPolling({
        dispatchId: 'ctx_984_var_short',
        readOnce: () => { shortReads += 1; return { ok: true, result: { terminal: { tail: [MARKER] } } }; },
        proofOnce: unproven,
        timeoutMs: 50, intervalMs: 5, sleep: short.sleep, now: short.now, label: '审官',
      });
      const long = fakeClock(1_000);
      let longReads = 0;
      const longR = S.verifyStartedPolling({
        dispatchId: 'ctx_984_var_long',
        readOnce: () => { longReads += 1; return { ok: true, result: { terminal: { tail: [MARKER] } } }; },
        proofOnce: unproven,
        timeoutMs: 5000, intervalMs: 5, sleep: long.sleep, now: long.now, label: '审官',
      });
      assert.equal(longR.state, 'unsubmitted-paste');
      assert.ok(longReads > shortReads * 10, JSON.stringify({ shortReads, longReads }));
      assert.ok(longR.elapsedMs >= 5000, JSON.stringify({ elapsed: longR.elapsedMs }));
    });

    await t.test('waitAndVerify 空屏：短超时等到才失败，不是立刻红', () => {
      const c = fakeClock(1_000);
      let reads = 0;
      const r = S.waitAndVerify({
        readOnce: () => { reads += 1; return { text: '' }; },
        timeoutMs: 40, intervalMs: 10, sleep: c.sleep, now: c.now,
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, '读了是空的');
      assert.ok(reads > 1, JSON.stringify({ r, reads }));
    });

    await t.test('waitForOutJson 生产默认仍是 60s（#565 真派工不传 timeoutMs）', () => {
      const src = fs.readFileSync(path.join(__dirname, 'helpers', 'dao-harness.js'), 'utf8');
      assert.ok(/function waitForOutJson\(resultPath, \{ timeoutMs = 60000/.test(src),
        'waitForOutJson 默认必须 60000，不许砍到 5s');
    });
    await t.test('waitForOutJson 文件不在：短超时等到才放弃，不是立刻 null', () => {
      const missing = path.join(os.tmpdir(), 'dao-984-missing-' + Date.now() + '.json');
      const c = fakeClock(1_000);
      let naps = 0;
      const r = waitForOutJson(missing, {
        timeoutMs: 30, stepMs: 10, now: c.now, sleep: (ms) => { naps += 1; c.sleep(ms); },
      });
      assert.equal(r, null);
      assert.ok(naps > 1, JSON.stringify({ r, naps }));
    });
  });

});
