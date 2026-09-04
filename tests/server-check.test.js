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
  classifyBotModelProbe,
  parseEnvFile,
  UNPROBEABLE_CODES,
  parseStartAgentProviders,
  parseTuiAgentDisplayNames,
  classifyRequiredAgents,
  providerToAgentId,
  classifyLandAutomation,
  parseEnabledAgentIds,
  classifyRetiredClis,
  RETIRED_WORKER_CLIS,
  whichOnPath,
  isExecutableEntry,
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
        requiredIds: ['pi', 'codex'],
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
        requiredIds: ['pi', 'codex'],
        knownIds: ['pi', 'devin', 'grok', 'codex'],
        knownUnscanned: false,
      });
      assert.equal(r.state, 'ok');
    });

    await t.test('#822 启用 JSON 只收 pi/codex，退役 grok/devin 不算必认', () => {
      const json = JSON.stringify({
        '工人': {
          '写码': {
            '模型': [
              { id: 'grok-4.6', '禁用': false, provider: 'gw' },
              { id: 'devin-x', '禁用': true, provider: 'devin' },
            ],
          },
        },
        '审官': {
          '审查': {
            '模型': [
              { id: 'gpt-5.6-sol', '禁用': false, provider: 'gpt' },
            ],
          },
        },
      });
      const r = parseEnabledAgentIds(json);
      assert.equal(r.unscanned, false);
      assert.deepEqual(r.ids.sort(), ['codex', 'pi']);
      assert.ok(!r.ids.includes('grok') && !r.ids.includes('devin'), JSON.stringify(r.ids));
    });

    await t.test('#822 空 JSON / 全禁用 = 没扫到，不是 0 个', () => {
      assert.equal(parseEnabledAgentIds('').unscanned, true);
      assert.equal(parseEnabledAgentIds('{}').unscanned, true);
      const allOff = parseEnabledAgentIds(JSON.stringify({
        '工人': { '写码': { '模型': [{ id: 'devin-x', '禁用': true, provider: 'devin' }] } },
      }));
      assert.equal(allOff.unscanned, true);
    });
  });

  await t.test('#822 退役工人 CLI 三态', async (t) => {
    await t.test('扫完 0 个 → ok', () => {
      const r = classifyRetiredClis({ probed: true, found: [] });
      assert.equal(r.state, 'ok');
      assert.match(r.detail, /0 个/);
    });
    await t.test('还在 PATH → 红', () => {
      const r = classifyRetiredClis({ probed: true, found: ['grok=/usr/bin/grok', 'devin=/home/orca/.local/bin/devin'] });
      assert.equal(r.state, 'red');
      assert.ok(r.found.includes('grok=/usr/bin/grok'), JSON.stringify(r));
    });
    await t.test('没探到 → unknown，不许当绿', () => {
      const r = classifyRetiredClis({ probed: false, reason: 'spawn 失败：ENOENT' });
      assert.equal(r.state, 'unknown');
    });
    await t.test('名单含 grok/cursor-agent/devin/reclaude', () => {
      for (const n of ['grok', 'cursor-agent', 'devin', 'reclaude']) {
        assert.ok(RETIRED_WORKER_CLIS.includes(n), n);
      }
      assert.ok(!RETIRED_WORKER_CLIS.includes('pi') && !RETIRED_WORKER_CLIS.includes('codex'));
    });
  });

  await t.test('#822 whichOnPath 只认可执行入口（审官红：同名目录/不可执行文件不许当命中）', async (t) => {
    const posixDir = '/tmp/bin/grok';
    const posixFile = '/tmp/bin/grok';
    const winDir = 'C:\\Tools\\grok.exe';

    await t.test('POSIX 同名目录 → 不命中', () => {
      const r = whichOnPath('grok', {
        platform: 'linux',
        pathEnv: '/tmp/bin',
        exists: (p) => p === posixDir,
        stat: () => ({ isDirectory: () => true, isFile: () => false, mode: 0o755 }),
      });
      assert.equal(r.probed, true);
      assert.equal(r.hit, null, JSON.stringify(r));
    });

    await t.test('POSIX 不可执行文件（无 execute bit）→ 不命中', () => {
      const r = whichOnPath('grok', {
        platform: 'linux',
        pathEnv: '/tmp/bin',
        exists: (p) => p === posixFile,
        stat: () => ({ isDirectory: () => false, isFile: () => true, mode: 0o644 }),
      });
      assert.equal(r.probed, true);
      assert.equal(r.hit, null, JSON.stringify(r));
    });

    await t.test('POSIX 真正可执行文件 → 命中', () => {
      const r = whichOnPath('grok', {
        platform: 'linux',
        pathEnv: '/tmp/bin',
        exists: (p) => p === posixFile,
        stat: () => ({ isDirectory: () => false, isFile: () => true, mode: 0o755 }),
      });
      assert.equal(r.probed, true);
      assert.equal(r.hit, posixFile, JSON.stringify(r));
    });

    await t.test('Windows 同名目录 → 不命中', () => {
      const r = whichOnPath('grok', {
        platform: 'win32',
        pathEnv: 'C:\\Tools',
        exists: (p) => p.replace(/\\/g, '/') === 'C:/Tools/grok.exe' || p === winDir,
        stat: () => ({ isDirectory: () => true, isFile: () => false }),
      });
      assert.equal(r.probed, true);
      assert.equal(r.hit, null, JSON.stringify(r));
    });

    await t.test('Windows .exe 是文件 → 命中', () => {
      const r = whichOnPath('grok', {
        platform: 'win32',
        pathEnv: 'C:\\Tools',
        exists: (p) => String(p).includes('grok.exe'),
        stat: () => ({ isDirectory: () => false, isFile: () => true }),
      });
      assert.equal(r.probed, true);
      assert.ok(r.hit && String(r.hit).includes('grok.exe'), JSON.stringify(r));
    });

    await t.test('isExecutableEntry：目录 / 无 x 位 / 有 x 位（三态对象契约）', () => {
      assert.deepEqual(isExecutableEntry('/x', {
        platform: 'linux',
        exists: () => true,
        stat: () => ({ isDirectory: () => true, isFile: () => false, mode: 0o755 }),
      }), { executable: false });
      assert.deepEqual(isExecutableEntry('/x', {
        platform: 'linux',
        exists: () => true,
        stat: () => ({ isDirectory: () => false, isFile: () => true, mode: 0o644 }),
      }), { executable: false });
      assert.deepEqual(isExecutableEntry('/x', {
        platform: 'linux',
        exists: () => true,
        stat: () => ({ isDirectory: () => false, isFile: () => true, mode: 0o111 }),
      }), { executable: true });
    });

    await t.test('stat 抛 EACCES → {error}，不当 absent', () => {
      const r = isExecutableEntry('/locked/x', {
        platform: 'linux',
        exists: () => true,
        stat: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; },
      });
      assert.ok(r.error && r.error.includes('EACCES'), JSON.stringify(r));
      assert.equal(r.executable, undefined);
    });

    await t.test('PATH 里有探不动的项且没命中 → probed:false（没查成不是 0 个）', () => {
      const r = whichOnPath('grok', {
        platform: 'linux',
        pathEnv: '/locked:/usr/bin',
        exists: (p) => String(p).startsWith('/locked'),
        stat: (p) => {
          if (String(p).startsWith('/locked')) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
          const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
        },
      });
      assert.equal(r.probed, false);
      assert.equal(r.hit, null);
      assert.match(r.reason, /探不动/);
      assert.match(r.reason, /没查成不是 0 个/);
    });

    await t.test('探不动的项之外命中了 → 照常 hit（探错不拦真命中）', () => {
      const r = whichOnPath('grok', {
        platform: 'linux',
        pathEnv: '/locked:/usr/bin',
        exists: () => true,
        stat: (p) => {
          if (String(p).startsWith('/locked')) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
          return { isDirectory: () => false, isFile: () => true, mode: 0o755 };
        },
      });
      assert.equal(r.probed, true);
      assert.equal(r.hit, '/usr/bin/grok');
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

test('⑰ 机器人模型探针（2026-09-04 实咬：模型被砍后消费方零报警，机器人哑了一天）', async (t) => {
  await t.test('200 且有真内容 → 绿', () => {
    const r = classifyBotModelProbe({ probed: true, code: 200, gotContent: true, model: 'grok-4.6' });
    assert.equal(r.state, 'ok');
    assert.match(r.detail, /grok-4\.6/);
  });

  await t.test('503 model_not_found → 红，且点名「模型已被砍」', () => {
    const r = classifyBotModelProbe({ probed: true, code: 503, gotContent: false, model: 'claude-5-fable-medium', reason: 'No available channel for model claude-5-fable-medium' });
    assert.equal(r.state, 'red');
    assert.match(r.detail, /模型已被砍/);
    assert.match(r.detail, /FEISHU_LLM_MODEL/);
  });

  await t.test('200 但零内容（只有心跳）→ 红，不当绿', () => {
    const r = classifyBotModelProbe({ probed: true, code: 200, gotContent: false, model: 'grok-4.6' });
    assert.equal(r.state, 'red');
    assert.match(r.detail, /零内容/);
  });

  await t.test('探不到（本机没 key / 没网关）→ unknown，不当绿也不当红', () => {
    const r = classifyBotModelProbe({ probed: false, reason: '机器人 key 不在本机' });
    assert.equal(r.state, 'unknown');
    assert.match(r.detail, /没探成/);
  });
});

test('⑰ 返工：env 文件解析 + 连不上判没查成 + 推理增量算真内容（审官红 2/3/4）', async (t) => {
  await t.test('parseEnvFile：认 export/引号/注释，值里的 = 不切断', () => {
    const e = parseEnvFile([
      '# 注释行',
      'ANTHROPIC_BASE_URL=https://gw.example',
      'export FEISHU_LLM_MODEL="grok-4.6"',
      "QUOTED='v=1&b=2'",
      '  SPACED = x ',
      '坏行没有等号',
    ].join('\n'));
    assert.equal(e.ANTHROPIC_BASE_URL, 'https://gw.example');
    assert.equal(e.FEISHU_LLM_MODEL, 'grok-4.6', '引号要剥掉');
    assert.equal(e.QUOTED, 'v=1&b=2', '值里的 = 不许当分隔符');
    assert.equal(e.SPACED, 'x');
    assert.equal(Object.keys(e).length, 4, '注释与坏行不进表');
  });

  await t.test('连不上/超时（curl 000）→ 没查成，不是真红', () => {
    const r = classifyBotModelProbe({ probed: false, reason: 'curl 退出 28（连不上或超时，HTTP 000）' });
    assert.equal(r.state, 'unknown', '网络抖一下不许算网关真红');
    assert.match(r.detail, /没探成/);
  });

  await t.test('探不到时不许说「本机不是编排机」这种误导话', () => {
    const r = classifyBotModelProbe({ probed: false, reason: '网关地址没查成（/etc/feishu-triage.env 里没有 ANTHROPIC_BASE_URL，环境变量里也没有）' });
    assert.equal(r.state, 'unknown');
    assert.doesNotMatch(r.detail, /不是编排机/);
  });
});
