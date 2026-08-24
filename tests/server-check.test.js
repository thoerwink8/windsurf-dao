// tests/server-check.test.js —— Linux 服务器底座探测的判别力
//
// 这套测试钉的是 2026-08-24 故意样本当场抓出的两个缺陷（停掉 orca 复跑探测器时暴露）：
//  1. `orca status` 恒返回 ok:true —— 只看 ok 会在 orca 已死时报绿。
//  2. `runtime_unavailable` 是「探不到」，判成红会把根因埋进一片假红里。
// 判别力的意思是：把判据改宽/改错，下面必须有人变红。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyOrcaStdout,
  classifyRuntimeStatus,
  classifyAccountsResult,
  UNPROBEABLE_CODES,
} from '../scripts/server-check.mjs';

test('server-check 判别力', async (t) => {
  await t.test('classifyOrcaStdout', async (t) => {
    await t.test('没探到（spawn 失败）→ unknown，不是红也不是通', () => {
      const r = classifyOrcaStdout({ probed: false, reason: 'spawn 失败：ENOENT' });
      assert.equal(r.state, 'unknown');
    });

    await t.test('空 stdout → unknown（不许当 0 条）', () => {
      const r = classifyOrcaStdout({ probed: true, code: 0, stdout: '' });
      assert.equal(r.state, 'unknown');
    });

    await t.test('stdout 不是 JSON → unknown', () => {
      const r = classifyOrcaStdout({ probed: true, code: 0, stdout: 'command not found' });
      assert.equal(r.state, 'unknown');
    });

    await t.test('JSON 坏了 → unknown', () => {
      const r = classifyOrcaStdout({ probed: true, code: 0, stdout: '{"ok":tru' });
      assert.equal(r.state, 'unknown');
    });

    await t.test('启动期先吐诊断行、后面跟真 JSON → 认得出（取第一个 { 起）', () => {
      const stdout = '[serve] orca CLI install: installed\n{"ok":true,"result":{"worktrees":[]}}';
      const r = classifyOrcaStdout({ probed: true, code: 0, stdout });
      assert.equal(r.state, 'ok');
      assert.deepEqual(r.payload.result.worktrees, []);
    });

    await t.test('runtime_unavailable → unknown（真缺陷 2：不许判红埋掉根因）', () => {
      const stdout = JSON.stringify({
        ok: false,
        error: { code: 'runtime_unavailable', message: 'Could not read Orca runtime metadata' },
      });
      const r = classifyOrcaStdout({ probed: true, code: 0, stdout });
      assert.equal(r.state, 'unknown');
      assert.match(r.detail, /探不到/);
    });

    await t.test('业务错误（非探不到码）→ red', () => {
      const stdout = JSON.stringify({ ok: false, error: { code: 'missing_repo_selector', message: 'Missing repo selector' } });
      const r = classifyOrcaStdout({ probed: true, code: 0, stdout });
      assert.equal(r.state, 'red');
    });

    await t.test('ok:false 但 exit 0 —— 退出码不是信号', () => {
      const stdout = JSON.stringify({ ok: false, error: { code: 'whatever', message: 'x' } });
      assert.equal(classifyOrcaStdout({ probed: true, code: 0, stdout }).state, 'red');
    });

    await t.test('探不到码表里必须有 runtime_unavailable', () => {
      assert.ok(UNPROBEABLE_CODES.has('runtime_unavailable'));
    });
  });

  await t.test('classifyRuntimeStatus', async (t) => {
    await t.test('orca 已死：ok:true 但 reachable:false → red（真缺陷 1：曾经报绿）', () => {
      const result = {
        app: { running: false, pid: null },
        runtime: { state: 'not_running', reachable: false, runtimeId: null },
      };
      const r = classifyRuntimeStatus(result);
      assert.equal(r.state, 'red');
      assert.match(r.detail, /不可达/);
      assert.match(r.detail, /serve/); // 报红要带怎么起
    });

    await t.test('reachable:true → ok，且带 runtimeId', () => {
      const result = { app: { running: true }, runtime: { state: 'running', reachable: true, runtimeId: 'abc' } };
      const r = classifyRuntimeStatus(result);
      assert.equal(r.state, 'ok');
      assert.match(r.detail, /abc/);
    });

    await t.test('契约变了（reachable 不是布尔）→ unknown，不是绿', () => {
      assert.equal(classifyRuntimeStatus({ runtime: { state: 'running' } }).state, 'unknown');
      assert.equal(classifyRuntimeStatus({}).state, 'unknown');
      assert.equal(classifyRuntimeStatus(null).state, 'unknown');
    });

    await t.test('reachable 是字符串 "true" 也算契约变了 —— 不许被真值糊过去', () => {
      assert.equal(classifyRuntimeStatus({ runtime: { reachable: 'true' } }).state, 'unknown');
    });
  });

  await t.test('classifyAccountsResult', async (t) => {
    await t.test('一个账号都没有 → red（派工起得来也登不上）', () => {
      const r = classifyAccountsResult({ claude: { accounts: [] }, codex: { accounts: [] } });
      assert.equal(r.state, 'red');
      assert.match(r.detail, /account add/);
    });

    await t.test('有账号 → ok，计数按厂商加总', () => {
      const r = classifyAccountsResult({ claude: { accounts: [{ id: 'a' }, { id: 'b' }] }, codex: { accounts: [{ id: 'c' }] } });
      assert.equal(r.state, 'ok');
      assert.equal(r.count, 3);
    });

    await t.test('认不出任何厂商键 → unknown（契约变了 ≠ 0 个）', () => {
      assert.equal(classifyAccountsResult({}).state, 'unknown');
      assert.equal(classifyAccountsResult({ claude: { accts: [] } }).state, 'unknown');
      assert.equal(classifyAccountsResult(null).state, 'unknown');
    });
  });
});
