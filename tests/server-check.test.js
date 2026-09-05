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
  parseProviderClis,
  inServiceProviders,
  retiredClis,
  splitPathValue,
  classifyExecutableEntry,
  whichOnPath,
  scanRetiredClis,
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
    // 2026-09-05 改判：这条原本判真红「派工起得来终端也登不上」。实测推翻了它的前提——
    // 服务器托管账号一直是 0，审官与工人却整天在跑：#822 之后全员走 pi + 网关 keyFile，
    // orca 托管账号根本不在登录路径上。永远红的检查会把真红淹掉，比没有检查更糟。
    // 判据保留（真回到 CLI 直连时还有用），但降成不报红，且必须说清「本机不走这条路」。
    await t.test('一个账号都没有 → 不报红，但要说清本机不走这条登录路', () => {
      const r = classifyAccountsResult({ claude: { accounts: [] }, codex: { accounts: [] } });
      assert.notEqual(r.state, 'red', '前提已不成立，不许继续报一个谁也修不了的红');
      assert.equal(r.empty, true, '0 个要显形，不能和「有账号」长得一样');
      assert.match(r.detail, /不走这条登录路/);
      assert.match(r.detail, /account add/, '真要改回 CLI 直连时，修法仍要写在这里');
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

// ⑲ 退役 CLI 还在 PATH（#960）。#868 在这段代码上四轮判红，四条坑逐条钉在下面。
// 平台一律显式传（platform:'linux'），否则这套断言在 Windows 上跑的是另一条分支。
test('⑲ 退役 CLI 还在 PATH（#960，#868 的四条坑逐条钉死）', async (t) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  // 假 stat：present 里有就返回给定 mode，没有就抛 ENOENT。不碰真环境。
  const statOf = (present) => (file) => {
    if (!present.has(file)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return { isFile: () => true, mode: present.get(file) };
  };
  const throwingStat = (code) => () => { const e = new Error(code); e.code = code; throw e; };
  const TOML = ['[providers.gw]', 'cli = "pi"', '[providers.devin]', 'cli = "devin"'].join('\n');
  const JSON_DOC = { 工人: { 写码: { 模型: [{ id: 'x', 禁用: false, provider: 'gw' }] } } };
  const scan = (over) => scanRetiredClis({
    tomlText: TOML, routingDoc: JSON_DOC, platform: 'linux', delimiter: ':',
    pathValue: '/usr/bin:/home/orca/bin', stat: statOf(new Map()), ...over,
  });

  await t.test('坑 1：找到文件 ≠ 能执行——没有可执行位不算命中', async (t) => {
    await t.test('mode 644 → not-executable，不是 executable', () => {
      const r = classifyExecutableEntry('/home/orca/bin/devin', {
        platform: 'linux', stat: () => ({ isFile: () => true, mode: 0o644 }),
      });
      assert.equal(r.state, 'not-executable', 'PATH 目录里躺着的同名普通文件不该被当成 CLI');
      assert.match(r.why, /644/);
    });

    await t.test('mode 755 → executable', () => {
      const r = classifyExecutableEntry('/home/orca/bin/devin', {
        platform: 'linux', stat: () => ({ isFile: () => true, mode: 0o755 }),
      });
      assert.equal(r.state, 'executable');
    });

    await t.test('整条链上：644 的 devin 不该让本项变红', () => {
      const r = scan({ stat: statOf(new Map([['/home/orca/bin/devin', 0o644]])) });
      assert.equal(r.state, 'ok', `不可执行的同名文件不该报警，实际：${r.detail}`);
      assert.equal(r.count, 0);
    });

    await t.test('目录也叫 devin（不是普通文件）→ 不算命中', () => {
      const r = classifyExecutableEntry('/home/orca/bin/devin', {
        platform: 'linux', stat: () => ({ isFile: () => false, mode: 0o755 }),
      });
      assert.equal(r.state, 'absent');
    });
  });

  await t.test('坑 2：EACCES 是「有但看不见」，不许当 absent', async (t) => {
    for (const code of ['EACCES', 'EPERM']) {
      await t.test(`${code} → unknown`, () => {
        const r = classifyExecutableEntry('/root/bin/devin', { platform: 'linux', stat: throwingStat(code) });
        assert.equal(r.state, 'unknown', `${code} 判成 absent 就是漏报`);
        assert.notEqual(r.state, 'absent');
      });
    }

    await t.test('ENOENT / ENOTDIR 才是真「没有」', () => {
      for (const code of ['ENOENT', 'ENOTDIR']) {
        assert.equal(classifyExecutableEntry('/x/devin', { platform: 'linux', stat: throwingStat(code) }).state, 'absent');
      }
    });

    await t.test('整条链上：全 EACCES → 没查成，不是「扫完 0 条」', () => {
      const r = scan({ stat: throwingStat('EACCES') });
      assert.equal(r.state, 'unknown');
      assert.match(r.detail, /没查成/);
      assert.doesNotMatch(r.detail, /一个都不在 PATH 上/, '「看不见」不许说成「扫完没有」');
    });
  });

  await t.test('坑 3：existsSync 遇权限错返 false——本节禁用它，判据必须自己看 e.code', async (t) => {
    await t.test('源码里这一节不许出现 existsSync', () => {
      const src = fs.readFileSync(path.join(REPO, 'scripts', 'server-check.mjs'), 'utf8');
      const from = src.indexOf('export function classifyExecutableEntry');
      const to = src.indexOf('export function scanRetiredClis');
      assert.ok(from > 0 && to > from, '定位不到这一节（判据挪走了就该有人来改这条）');
      assert.doesNotMatch(src.slice(from, to), /existsSync/, 'existsSync 分不出「没有」和「看不见」，本节不许用');
    });

    await t.test('whichOnPath 把看不见的位置记进 unknowns，而不是当没有', () => {
      const w = whichOnPath('devin', { dirs: ['/root/bin'], platform: 'linux', stat: throwingStat('EACCES') });
      assert.equal(w.hits.length, 0);
      assert.equal(w.unknowns.length, 1, '看不见的位置必须显形，否则和「扫过没有」一模一样');
      assert.match(w.unknowns[0].why, /EACCES/);
    });
  });

  await t.test('坑 4：PATH 空段在 POSIX 里是当前目录，不许 filter(Boolean) 丢掉', async (t) => {
    await t.test('a::b → 三段，中间那段是 .', () => {
      const r = splitPathValue('/usr/bin::/home/orca/bin', { delimiter: ':', platform: 'linux' });
      assert.equal(r.unscanned, false);
      assert.deepEqual(r.dirs, ['/usr/bin', '.', '/home/orca/bin']);
      assert.equal(r.dirs.length, '/usr/bin::/home/orca/bin'.split(':').filter(Boolean).length + 1,
        'filter(Boolean) 会少一段——那一段正是当前目录');
    });

    await t.test('整条链上：devin 就在当前目录 → 照样查得出来', () => {
      const r = scan({
        pathValue: '/usr/bin::/home/orca/bin',
        stat: statOf(new Map([['./devin', 0o755]])),
      });
      assert.equal(r.state, 'red', `空段被丢掉就漏报了：${r.detail}`);
      assert.match(r.detail, /devin/);
    });

    await t.test('Windows 的空段该忽略（CreateProcess 不认当前目录这条老规矩）', () => {
      const r = splitPathValue('C:\\a;;C:\\b', { delimiter: ';', platform: 'win32' });
      assert.deepEqual(r.dirs, ['C:\\a', 'C:\\b']);
    });

    await t.test('PATH 读不到 → 没查成，不是「PATH 上没有」', () => {
      assert.equal(splitPathValue('', { delimiter: ':', platform: 'linux' }).unscanned, true);
      assert.equal(splitPathValue(undefined, { delimiter: ':', platform: 'linux' }).unscanned, true);
    });
  });

  await t.test('清单从真相源推，不许手写', async (t) => {
    await t.test('parseProviderClis 扫得出 [providers.*].cli，且不吃 launch_note 里的字', () => {
      const toml = [
        '[providers.gw]', 'cli = "pi"',
        'launch_note = """', 'cli = "假的"', '"""',
        '[providers.devin]', 'cli = "devin"',
      ].join('\n');
      const r = parseProviderClis(toml);
      assert.equal(r.unscanned, false);
      assert.deepEqual(r.clis, [{ provider: 'gw', cli: 'pi' }, { provider: 'devin', cli: 'devin' }]);
    });

    await t.test('一条 cli 都没扫到 → unscanned，不是 0 个 CLI', () => {
      assert.equal(parseProviderClis('').unscanned, true);
      assert.equal(parseProviderClis('updated = "2026-09-05"').unscanned, true);
      assert.equal(parseProviderClis('[providers.gw]\nstart = "agent"').unscanned, true);
    });

    await t.test('inServiceProviders：禁用的不算，腿表只认「在役」', () => {
      const r = inServiceProviders({
        工人: { 写码: { 模型: [
          { id: 'a', 禁用: false, provider: 'gw' },
          { id: 'b', 禁用: true, provider: 'devin' },
        ] } },
        腿: [
          { id: 'l1', 状态: '在役', 落地: { provider: 'claude' } },
          { id: 'l2', 状态: '停用', 落地: { provider: 'cursor' } },
        ],
      });
      assert.equal(r.unscanned, false);
      assert.deepEqual([...r.providers].sort(), ['claude', 'gw']);
    });

    await t.test('一个在役 provider 都推不出来 → 没查成（不是「全退役」）', () => {
      assert.equal(inServiceProviders({}).unscanned, true);
      assert.equal(inServiceProviders(null).unscanned, true);
      assert.equal(inServiceProviders({ 腿: [{ 状态: '停用', 落地: { provider: 'devin' } }] }).unscanned, true);
    });

    await t.test('一名多 provider：只要还有一个在役就不算退役（pi）', () => {
      const clis = [
        { provider: 'gw', cli: 'pi' },
        { provider: 'opencode-go', cli: 'pi' },
        { provider: 'devin', cli: 'devin' },
      ];
      const r = retiredClis({ clis, inService: ['gw'] });
      assert.deepEqual(r.map((x) => x.cli), ['devin'], '天天在用的 pi 不许被报成退役');
    });

    await t.test('真文件推出来的清单：含 devin/cursor-agent/grok，不含 pi/codex', () => {
      const cat = parseProviderClis(fs.readFileSync(path.join(REPO, 'docs', 'model-routing.toml'), 'utf8'));
      const svc = inServiceProviders(JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'model-routing.json'), 'utf8')));
      assert.equal(cat.unscanned, false);
      assert.equal(svc.unscanned, false);
      const names = retiredClis({ clis: cat.clis, inService: svc.providers }).map((x) => x.cli);
      for (const want of ['devin', 'cursor-agent', 'grok']) {
        assert.ok(names.includes(want), `#822 退役的 ${want} 该在清单里，实际 ${JSON.stringify(names)}`);
      }
      for (const live of ['pi', 'codex']) {
        assert.ok(!names.includes(live), `在役的 ${live} 不该进退役清单，实际 ${JSON.stringify(names)}`);
      }
    });
  });

  await t.test('三态在输出上分得开：查出问题 / 扫完 0 条 / 没查成', async (t) => {
    await t.test('故意违规样本：PATH 上放一个可执行 devin → 红，点名 CLI 与目录', () => {
      const r = scan({ stat: statOf(new Map([['/home/orca/bin/devin', 0o755]])) });
      assert.equal(r.state, 'red');
      assert.match(r.detail, /devin/);
      assert.match(r.detail, /\/home\/orca\/bin/, '报红必须说清在哪个目录，否则没法动手');
      assert.equal(r.count, 1);
    });

    await t.test('反证：移走之后转绿（判据不是恒红）', () => {
      const r = scan({ stat: statOf(new Map()) });
      assert.equal(r.state, 'ok');
      assert.equal(r.count, 0);
      assert.match(r.detail, /扫了 \d+ 个退役 CLI/, '「扫完 0 条」要说清扫了什么，否则和「没扫」分不开');
    });

    await t.test('反证：在役的 pi 在 PATH 上也不许报（判据不是恒绿的反面——恒红）', () => {
      const r = scan({ pathValue: '/usr/bin', stat: statOf(new Map([['/usr/bin/pi', 0o755]])) });
      assert.equal(r.state, 'ok');
    });

    await t.test('一个退役 CLI 都推不出来 → 没查成，不是「都在役」', () => {
      const r = scan({ tomlText: '[providers.gw]\ncli = "pi"' });
      assert.equal(r.state, 'unknown');
      assert.match(r.detail, /没查成/);
    });

    await t.test('启动模板 / 选型真相源没扫成 → 各自的没查成，话术能认出是哪一头', () => {
      const a = scan({ tomlText: '' });
      assert.equal(a.state, 'unknown');
      assert.match(a.detail, /model-routing\.toml/);
      const b = scan({ routingDoc: {} });
      assert.equal(b.state, 'unknown');
      assert.match(b.detail, /model-routing\.json/);
    });

    await t.test('命中和看不见同时存在 → 红优先（真查出问题不许被没查成盖住）', () => {
      const r = scan({
        pathValue: '/home/orca/bin:/root/bin',
        stat: (file) => {
          if (file === '/home/orca/bin/devin') return { isFile: () => true, mode: 0o755 };
          const e = new Error('EACCES'); e.code = 'EACCES'; throw e;
        },
      });
      assert.equal(r.state, 'red');
    });
  });
});

// ⑳ 仓里的 systemd 单元 vs 机器上装着的。2026-09-05 巡检第一次真跑就抓到：
// 仓里把 OnCalendar 补进了 dao-agent-stall.timer，机器上仍是两天前那份——**改了仓 ≠ 装了机器**。
// dao-sync 只拉代码不装单元，而 timer-armed 只扫仓里的文件，于是「检查全绿，修没有生效」。
test('⑳ 单元漂移', async (t) => {
  const { classifyUnitDrift } = await import('../scripts/server-check.mjs');

  await t.test('内容一致 → ok（反证判据不是恒红）', () => {
    const r = classifyUnitDrift([
      { name: 'a.timer', repo: 'X', live: 'X' },
      { name: 'b.service', repo: 'Y', live: 'Y' },
    ]);
    assert.equal(r.state, 'ok');
    assert.match(r.detail, /2 个/, '要说清比了几个，否则「比了 0 个」和「都一致」长得一样');
  });

  await t.test('故意违规样本：仓里改了机器上没装 → red 并点名', () => {
    const r = classifyUnitDrift([
      { name: 'dao-agent-stall.timer', repo: 'OnCalendar=*:2/15\nOnBootSec=3min', live: 'OnBootSec=3min' },
      { name: 'ok.timer', repo: 'Z', live: 'Z' },
    ]);
    assert.equal(r.state, 'red');
    assert.match(r.detail, /dao-agent-stall\.timer/, '要点名是哪个，不能只给数字');
    assert.match(r.detail, /install/, '要给修法');
  });

  await t.test('机器上压根没装 → unknown，不是 red 也不是 ok', () => {
    const r = classifyUnitDrift([{ name: 'x.timer', repo: 'A', live: null }]);
    assert.equal(r.state, 'unknown');
    assert.match(r.detail, /没装|没查成/);
  });

  await t.test('扫出 0 个 → unknown（判据失效，不是「都一致」）', () => {
    assert.equal(classifyUnitDrift([]).state, 'unknown');
    assert.equal(classifyUnitDrift(null).state, 'unknown');
  });

  await t.test('只差换行/首尾空白 → 不算漂移（避免天天红成噪音）', () => {
    const r = classifyUnitDrift([{ name: 'a.timer', repo: '[Timer]\nOnCalendar=*:07\n', live: '[Timer]\r\nOnCalendar=*:07' }]);
    assert.equal(r.state, 'ok');
  });
});
