// tests/server-check.test.js —— Linux 服务器底座探测的判别力
//
// 这套测试钉的是 2026-08-24 故意样本当场抓出的两个缺陷（停掉 orca 复跑探测器时暴露）：
//  1. `orca status` 恒返回 ok:true —— 只看 ok 会在 orca 已死时报绿。
//  2. `runtime_unavailable` 是「探不到」，判成红会把根因埋进一片假红里。
// 判别力的意思是：把判据改宽/改错，下面必须有人变红。

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  classifyOrcaStdout,
  classifyRuntimeStatus,
  classifyAccountsResult,
  classifyFeishuTriage,
  classifyAgentStallWatch,
  UNPROBEABLE_CODES,
  parseStartAgentProviders,
  parseTuiAgentDisplayNames,
  classifyRequiredAgents,
  providerToAgentId,
  classifyLandAutomation,
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

  await t.test('#802 本构建是否认 --agent id', async (t) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const here = path.dirname(fileURLToPath(import.meta.url));

    await t.test('provider → agent id 自持映射（不 import launch.mjs）', () => {
      assert.equal(providerToAgentId('gw'), 'pi');
      assert.equal(providerToAgentId('deepseek'), 'pi');
      assert.equal(providerToAgentId('opencode-go'), 'pi');
      assert.equal(providerToAgentId('devin'), 'devin');
      assert.equal(providerToAgentId('grok'), 'grok');
      assert.equal(providerToAgentId('gpt'), 'codex');
      assert.equal(providerToAgentId('claude'), null);
    });

    await t.test('TOML start=agent 扫得出 gw/devin，不把 launch_note 里的字当字段', () => {
      const toml = [
        '[providers.gw]',
        'cli = "pi"',
        'start = "agent"',
        'launch_note = """',
        'start = "agent"',
        '"""',
        '[providers.claude]',
        'start = "command"',
        '[providers.devin]',
        'start = "agent"',
      ].join('\n');
      const r = parseStartAgentProviders(toml);
      assert.equal(r.unscanned, false);
      assert.deepEqual(r.providers.map((p) => p.name), ['gw', 'devin']);
    });

    await t.test('没 [providers.*] → unscanned，不是 0 个', () => {
      const r = parseStartAgentProviders('updated = "2026-09-03"\n');
      assert.equal(r.unscanned, true);
    });

    await t.test('目录夹具含 pi/devin/grok → 扫得出', () => {
      const text = fs.readFileSync(path.join(here, 'fixtures/orca-tui-agents/ok.js'), 'utf8');
      const r = parseTuiAgentDisplayNames(text);
      assert.equal(r.unscanned, false);
      assert.ok(r.ids.includes('pi') && r.ids.includes('devin') && r.ids.includes('grok'), JSON.stringify(r.ids));
    });

    await t.test('故意违规：目录缺 pi，路由要 pi → 红', () => {
      const text = fs.readFileSync(path.join(here, 'fixtures/orca-tui-agents/missing-pi.js'), 'utf8');
      const known = parseTuiAgentDisplayNames(text);
      const r = classifyRequiredAgents({
        requiredIds: ['pi', 'devin', 'grok'],
        knownIds: known.ids,
        knownUnscanned: known.unscanned,
      });
      assert.equal(r.state, 'red');
      assert.ok(r.missing.includes('pi'), JSON.stringify(r));
    });

    await t.test('目录扫不到 → unknown，不许当绿', () => {
      const r = classifyRequiredAgents({
        requiredIds: ['pi'],
        knownIds: null,
        knownUnscanned: true,
        knownError: '没扫到',
      });
      assert.equal(r.state, 'unknown');
    });

    await t.test('目录齐 → ok', () => {
      const r = classifyRequiredAgents({
        requiredIds: ['pi', 'devin', 'grok'],
        knownIds: ['pi', 'devin', 'grok', 'codex'],
        knownUnscanned: false,
      });
      assert.equal(r.state, 'ok');
    });
  });

  await t.test('classifyFeishuTriage（⑫ #801）', async (t) => {
    await t.test('active → ok', () => {
      const r = classifyFeishuTriage({ probed: true, code: 0, stdout: 'active' });
      assert.equal(r.state, 'ok');
    });

    await t.test('inactive / failed → red，且带怎么起', () => {
      for (const s of ['inactive', 'failed']) {
        const r = classifyFeishuTriage({ probed: true, code: 3, stdout: s });
        assert.equal(r.state, 'red');
        assert.match(r.detail, /systemctl start/);
      }
    });

    await t.test('systemctl 探不到（Windows/无 systemd）→ unknown，不当绿', () => {
      const r = classifyFeishuTriage({ probed: false, reason: 'spawn 失败：ENOENT' });
      assert.equal(r.state, 'unknown');
    });

    await t.test('输出不认识（契约变了）→ unknown', () => {
      const r = classifyFeishuTriage({ probed: true, code: 0, stdout: 'weird-state' });
      assert.equal(r.state, 'unknown');
    });
  });

  await t.test('#829 land automation 在册且启用', async (t) => {
    await t.test('没有这条 → red，带安装命令', () => {
      const r = classifyLandAutomation([]);
      assert.equal(r.state, 'red');
      assert.match(r.detail, /install-land-automation/);
    });
    await t.test('在册但 enabled=false → red（判别性：disable 必须变红）', () => {
      const r = classifyLandAutomation([{ name: 'land', enabled: false, id: 'x' }]);
      assert.equal(r.state, 'red');
      assert.match(r.detail, /enabled/);
    });
    await t.test('在册且 enabled=true → ok', () => {
      const r = classifyLandAutomation([{ name: 'land', enabled: true, id: 'abc' }]);
      assert.equal(r.state, 'ok');
      assert.match(r.detail, /abc/);
    });
    await t.test('同名两条 → red（幂等坏了）', () => {
      const r = classifyLandAutomation([
        { name: 'land', enabled: true, id: 'a' },
        { name: 'land', enabled: true, id: 'b' },
      ]);
      assert.equal(r.state, 'red');
    });
    await t.test('不是数组 → unknown，不许当绿', () => {
      assert.equal(classifyLandAutomation(null).state, 'unknown');
      assert.equal(classifyLandAutomation(undefined).state, 'unknown');
    });
    await t.test('别的名字在册不算这条', () => {
      const r = classifyLandAutomation([{ name: 'other', enabled: true, id: 'z' }]);
      assert.equal(r.state, 'red');
    });
  });

  await t.test('classifyAgentStallWatch（⑮ #833，另起一项不改 automations 行）', async (t) => {
    await t.test('正式 timer 在册且垫片不在 → ok', () => {
      const r = classifyAgentStallWatch({
        probed: true,
        timersText: 'Thu dao-agent-stall.timer dao-agent-stall.service',
        padScriptExists: false,
      });
      assert.equal(r.state, 'ok');
    });

    await t.test('垫片 timer 还在 → red（影子制度）', () => {
      const r = classifyAgentStallWatch({
        probed: true,
        timersText: 'Thu agent-stall-watch.timer agent-stall-watch.service',
        padScriptExists: false,
      });
      assert.equal(r.state, 'red');
      assert.match(r.detail, /垫片/);
    });

    await t.test('垫片脚本还在 → red，即使正式 timer 已在', () => {
      const r = classifyAgentStallWatch({
        probed: true,
        timersText: 'Thu dao-agent-stall.timer dao-agent-stall.service',
        padScriptExists: true,
      });
      assert.equal(r.state, 'red');
      assert.match(r.detail, /agent-stall-watch\.mjs/);
    });

    await t.test('正式 timer 不在册 → red，带怎么起', () => {
      const r = classifyAgentStallWatch({
        probed: true,
        timersText: 'Thu sysstat-collect.timer',
        padScriptExists: false,
      });
      assert.equal(r.state, 'red');
      assert.match(r.detail, /dao-agent-stall\.timer/);
    });

    await t.test('systemctl 探不到 → unknown，不当绿', () => {
      const r = classifyAgentStallWatch({ probed: false, reason: 'spawn 失败：ENOENT' });
      assert.equal(r.state, 'unknown');
    });

    await t.test('垫片脚本没查成 → unknown', () => {
      const r = classifyAgentStallWatch({
        probed: true,
        timersText: 'Thu dao-agent-stall.timer',
        padScriptUnknown: true,
      });
      assert.equal(r.state, 'unknown');
    });
  });
});
