// 飞书群有效性检查 · 判别力回归网（issue #813）
//
// 验 scripts/lib/feishu-groups-check.mjs（dao-check 第 ㉘ 项）：
//   红 —— 查不到/已解散必须报红并写出群名（故意违规样本被拦住）；
//   绿 —— 四个群都在必须绿，证明检查器不是恒红；
//   SKIP —— 无 lark-cli / 无凭据必须 SKIP 不是绿；
//   没查成 —— 0 个 chat_id / JSON 坏了 / 文件不在 / 探头失败，全部单独报红。
// 检查器自持解析，不许 import feishu-triage 的 loadGroups。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'feishu-groups-check.mjs');
const FIX = path.join(__dirname, 'fixtures', 'feishu-groups-check');
const LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function enoentSpawn() {
  return () => {
    const e = new Error('spawn lark-cli ENOENT');
    e.code = 'ENOENT';
    return { error: e, status: null, stdout: '', stderr: '' };
  };
}

describe('feishu-groups-check', () => {
  it('检查器不复用 feishu-triage 的解析', () => {
    const src = fs.readFileSync(LIB, 'utf8');
    const imports = [...src.matchAll(/^import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.ok(!imports.some((s) => /feishu-triage/.test(s)),
      '检查器 import 了 feishu-triage ⇒ 自己查自己  →  ' + JSON.stringify(imports));
  });

  it('parseGroupCatalog：注释键跳过 / 0 个没查成 / JSON 坏了没查成', async (t) => {
    const S = await LOAD;

    await t.test('_ 注释键不算 chat_id，四个实体键扫得出', () => {
      const r = S.parseGroupCatalog(JSON.stringify({
        _comment: 'x',
        oc_a: { repo: 'org/a', kind: 'project' },
        oc_b: { repo: 'org/b', kind: 'project' },
        oc_c: { repo: 'org/c', kind: 'project' },
        oc_h: { kind: 'hub' },
      }));
      assert.equal(r.kind, 'ok', JSON.stringify(r));
      assert.equal(r.groups.length, 4);
      assert.ok(!r.groups.some((g) => g.chatId === '_comment'));
      assert.ok(r.groups.find((g) => g.chatId === 'oc_h').label.includes('总控群'));
    });

    await t.test('只有注释键 = 0 个 chat_id = 没查成，不是绿', () => {
      const r = S.parseGroupCatalog(JSON.stringify({ _comment: 'none' }));
      assert.equal(r.kind, 'unscanned', JSON.stringify(r));
      assert.ok(/没扫到|没查/.test((r.fail || []).join(' ')), JSON.stringify(r.fail));
    });

    await t.test('JSON 坏了 = 没查成', () => {
      const r = S.parseGroupCatalog('{');
      assert.equal(r.kind, 'unscanned', JSON.stringify(r));
    });

    await t.test('根是数组 = 没查成', () => {
      const r = S.parseGroupCatalog('[]');
      assert.equal(r.kind, 'unscanned', JSON.stringify(r));
    });
  });

  it('classifyChatGet：在 / 查不到 / 已解散 / 无 cli / 无凭据 / 没查成 分得开', async (t) => {
    const S = await LOAD;

    await t.test('ok:true + chat_status=normal → exists 带群名', () => {
      const r = S.classifyChatGet({
        status: 0, error: null, stderr: '',
        stdout: JSON.stringify({ ok: true, identity: 'bot', data: { name: 'windsurf-dao', chat_status: 'normal' } }),
      }, 'oc_x');
      assert.equal(r.kind, 'exists', JSON.stringify(r));
      assert.equal(r.name, 'windsurf-dao');
    });

    await t.test('实测信封：code 99992356 not exists → missing', () => {
      const r = S.classifyChatGet({
        status: 1, error: null, stdout: '',
        stderr: JSON.stringify({
          ok: false, identity: 'bot',
          error: {
            type: 'api', subtype: 'unknown', code: 99992356,
            message: 'The request you send is not a valid {open_chat_id} or not exists, Invalid ids: [oc_dead]',
          },
        }),
      }, 'oc_dead');
      assert.equal(r.kind, 'missing', JSON.stringify(r));
    });

    await t.test('ok:true 但 chat_status=dissolved → missing', () => {
      const r = S.classifyChatGet({
        status: 0, error: null, stderr: '',
        stdout: JSON.stringify({ ok: true, data: { name: '旧群', chat_status: 'dissolved' } }),
      }, 'oc_old');
      assert.equal(r.kind, 'missing', JSON.stringify(r));
      assert.match(r.reason, /解散|dissolved|状态/);
    });

    await t.test('ENOENT → skip 无 lark-cli，不是绿', () => {
      const e = new Error('spawn lark-cli ENOENT');
      e.code = 'ENOENT';
      const r = S.classifyChatGet({ error: e, status: null, stdout: '', stderr: '' }, 'oc_x');
      assert.equal(r.kind, 'skip', JSON.stringify(r));
      assert.match(r.reason, /无 lark-cli/);
    });

    await t.test('authorization → skip 无凭据', () => {
      const r = S.classifyChatGet({
        status: 1, error: null, stdout: '',
        stderr: JSON.stringify({ ok: false, error: { type: 'authorization', message: 'not logged in' } }),
      }, 'oc_x');
      assert.equal(r.kind, 'skip', JSON.stringify(r));
      assert.match(r.reason, /无凭据/);
    });

    await t.test('{ok:true} 无 data → unscanned，不是 exists', () => {
      const r = S.classifyChatGet({
        status: 0, error: null, stderr: '',
        stdout: JSON.stringify({ ok: true }),
      }, 'oc_dead');
      assert.equal(r.kind, 'unscanned', JSON.stringify(r));
    });

    await t.test('{ok:true,data:{}} 缺 chat_status → unscanned', () => {
      const r = S.classifyChatGet({
        status: 0, error: null, stderr: '',
        stdout: JSON.stringify({ ok: true, data: {} }),
      }, 'oc_dead');
      assert.equal(r.kind, 'unscanned', JSON.stringify(r));
    });

    await t.test('ok:true 有 name 但缺 chat_status → unscanned', () => {
      const r = S.classifyChatGet({
        status: 0, error: null, stderr: '',
        stdout: JSON.stringify({ ok: true, data: { name: 'x' } }),
      }, 'oc_x');
      assert.equal(r.kind, 'unscanned', JSON.stringify(r));
    });

    await t.test('ok:true 未知 chat_status → unscanned', () => {
      const r = S.classifyChatGet({
        status: 0, error: null, stderr: '',
        stdout: JSON.stringify({ ok: true, data: { name: 'x', chat_status: 'weird' } }),
      }, 'oc_x');
      assert.equal(r.kind, 'unscanned', JSON.stringify(r));
      assert.match(String(r.error || ''), /不认识|没查成/);
    });

    await t.test('空输出 → unscanned，不是 missing 也不是绿', () => {
      const r = S.classifyChatGet({ status: 0, error: null, stdout: '', stderr: '' }, 'oc_x');
      assert.equal(r.kind, 'unscanned', JSON.stringify(r));
    });
  });

  it('classifyAuthStatus：ready / 无 cli / 无凭据 / 没查成', async (t) => {
    const S = await LOAD;

    await t.test('bot available+ready → ready', () => {
      const r = S.classifyAuthStatus({
        status: 0, error: null, stderr: '',
        stdout: JSON.stringify({ ok: true, identities: { bot: { available: true, status: 'ready' } } }),
      });
      assert.equal(r.kind, 'ready', JSON.stringify(r));
    });

    await t.test('bot 未就绪 → skip 无凭据；CI 话面带 CI 无法验证', () => {
      const r = S.classifyAuthStatus({
        status: 0, error: null, stderr: '',
        stdout: JSON.stringify({ ok: true, identities: { bot: { available: false, status: 'missing' } } }),
      }, { isCi: true });
      assert.equal(r.kind, 'skip', JSON.stringify(r));
      assert.match(r.reason, /无凭据/);
      assert.match(r.reason, /CI 无法验证/);
    });

    await t.test('ENOENT + isCi → skip 无 lark-cli（CI 无法验证）', () => {
      const e = new Error('spawn lark-cli ENOENT');
      e.code = 'ENOENT';
      const r = S.classifyAuthStatus({ error: e, status: null, stdout: '', stderr: '' }, { isCi: true });
      assert.equal(r.kind, 'skip', JSON.stringify(r));
      assert.match(r.reason, /无 lark-cli/);
      assert.match(r.reason, /CI 无法验证/);
    });
  });

  it('inspectFeishuGroups：绿 / 红点名 / SKIP 不是绿 / 0 个没查成', async (t) => {
    const S = await LOAD;
    const four = [
      { chatId: 'oc_a', label: 'org/a（oc_a）' },
      { chatId: 'oc_b', label: 'org/b（oc_b）' },
      { chatId: 'oc_c', label: 'org/c（oc_c）' },
      { chatId: 'oc_h', label: '总控群（oc_h）' },
    ];
    const ready = () => ({ kind: 'ready' });

    await t.test('四个都在 → 绿，带群名', () => {
      const r = S.inspectFeishuGroups({
        groups: four, preflight: ready,
        probeChat: (id) => ({ kind: 'exists', name: id === 'oc_h' ? '道·总控' : id }),
      });
      assert.equal(r.kind, 'ok', JSON.stringify(r));
      assert.ok(r.green && r.green.includes('4') && r.green.includes('道·总控'), r.green);
      assert.ok(!r.skip && !r.fail);
    });

    await t.test('一个查不到 → 红且点名该群，不是 SKIP', () => {
      const r = S.inspectFeishuGroups({
        groups: four, preflight: ready,
        probeChat: (id) => id === 'oc_b'
          ? { kind: 'missing', name: id, reason: '查不到或已解散' }
          : { kind: 'exists', name: id },
      });
      assert.equal(r.kind, 'red', JSON.stringify(r));
      assert.ok(/org\/b/.test((r.fail || []).join(' ')), JSON.stringify(r.fail));
      assert.ok(!r.green && !r.skip);
    });

    await t.test('无 lark-cli 预检 → SKIP 不是绿', () => {
      const r = S.inspectFeishuGroups({
        groups: four,
        preflight: () => ({ kind: 'skip', reason: '无 lark-cli' }),
        probeChat: () => ({ kind: 'exists', name: 'x' }),
      });
      assert.equal(r.kind, 'skip', JSON.stringify(r));
      assert.match(r.skip, /无 lark-cli/);
      assert.ok(!r.green);
    });

    await t.test('0 个群 → 没查成，不是绿也不是 SKIP', () => {
      const r = S.inspectFeishuGroups({ groups: [], preflight: ready, probeChat: () => ({ kind: 'exists' }) });
      assert.equal(r.kind, 'unscanned', JSON.stringify(r));
      assert.ok(!r.green && !r.skip);
    });
  });

  it('夹具红/绿/空有判别力', async () => {
    const S = await LOAD;
    const r = S.inspectFeishuGroupsFixtures(FIX);
    assert.ok(r.ok && !r.unscanned, JSON.stringify(r));
    assert.equal(r.kinds.red, 1);
    assert.equal(r.kinds.ok, 1);
    assert.equal(r.kinds.empty, 1);
  });

  it('checkFeishuGroups live 形态：模板 / 实机映射 / SKIP / 绿 / 红', async (t) => {
    const S = await LOAD;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-groups-'));

    function rootWithTemplate(name, groupsFile) {
      const root = path.join(tmp, name);
      fs.mkdirSync(path.join(root, 'host', 'machine'), { recursive: true });
      fs.copyFileSync(groupsFile, path.join(root, 'host', 'machine', 'feishu-groups.json'));
      return root;
    }
    function homeWithRuntime(name, groupsFile) {
      const home = path.join(tmp, name + '-home');
      fs.mkdirSync(path.join(home, '.mirasim', 'keys'), { recursive: true });
      fs.copyFileSync(groupsFile, path.join(home, '.mirasim', 'keys', 'feishu-groups.json'));
      return home;
    }

    await t.test('仓内模板不在 → 没查成，不是 SKIP', () => {
      const r = S.checkFeishuGroups({ root: tmp, home: path.join(tmp, 'no-home'), spawn: enoentSpawn() });
      assert.equal(r.kind, 'unscanned', JSON.stringify(r));
      assert.ok(/不在|没查/.test((r.fail || []).join(' ')), JSON.stringify(r.fail));
      assert.ok(!r.skip && !r.green);
    });

    await t.test('有模板、无实机映射 → SKIP 本机未接飞书，不是绿', () => {
      const root = rootWithTemplate('no-runtime', path.join(FIX, 'ok', 'groups.json'));
      const r = S.checkFeishuGroups({
        root, home: path.join(tmp, 'empty-home'), spawn: enoentSpawn(), isCi: true,
      });
      assert.equal(r.kind, 'skip', JSON.stringify(r));
      assert.match(r.skip, /本机未接飞书/);
      assert.match(r.skip, /CI 无法验证/);
      assert.ok(!r.green);
    });

    await t.test('有实机映射 + 无 lark-cli → SKIP 无 lark-cli，不是绿', () => {
      const root = rootWithTemplate('no-cli', path.join(FIX, 'ok', 'groups.json'));
      const home = homeWithRuntime('no-cli', path.join(FIX, 'ok', 'groups.json'));
      const r = S.checkFeishuGroups({ root, home, spawn: enoentSpawn(), isCi: true });
      assert.equal(r.kind, 'skip', JSON.stringify(r));
      assert.match(r.skip, /无 lark-cli/);
      assert.match(r.skip, /CI 无法验证/);
      assert.ok(!r.green);
    });

    await t.test('有实机映射 + 假探头全在 → 绿', () => {
      const root = rootWithTemplate('ok-live', path.join(FIX, 'ok', 'groups.json'));
      const home = homeWithRuntime('ok-live', path.join(FIX, 'ok', 'groups.json'));
      const probes = JSON.parse(fs.readFileSync(path.join(FIX, 'ok', 'probes.json'), 'utf8'));
      const r = S.checkFeishuGroups({ root, home, spawn: S.makeProbeSpawn(probes) });
      assert.equal(r.kind, 'ok', JSON.stringify(r));
      assert.ok(r.green && r.green.includes('4'), r.green);
    });

    await t.test('有实机映射 + 失效群 → 红且点名 dissolved-sample', () => {
      const root = rootWithTemplate('red-live', path.join(FIX, 'ok', 'groups.json'));
      const home = homeWithRuntime('red-live', path.join(FIX, 'red', 'groups.json'));
      const probes = JSON.parse(fs.readFileSync(path.join(FIX, 'red', 'probes.json'), 'utf8'));
      const r = S.checkFeishuGroups({ root, home, spawn: S.makeProbeSpawn(probes) });
      assert.equal(r.kind, 'red', JSON.stringify(r));
      assert.match((r.fail || []).join(' '), /dissolved-sample/);
    });
  });
});
