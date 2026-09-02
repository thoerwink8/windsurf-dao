// 换机接线自检 + onboard 幂等命令（2026-08-31）。
// 铁律照旧：绿要能证明是查过的绿（假 HOME 全绿样本）；每类违规要有故意样本被拦住；
// 「没查成」与「查过没事」不同形；哨兵绿 = 零输出。
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const LIB_LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'onboard-check.mjs').replace(/\\/g, '/'));
const MEM_LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'dao-memory-link-check.mjs').replace(/\\/g, '/'));

/** 假 HOME：三处接线全对 + 凭据在（全绿基线，每个用例各拆一处）。 */
function mkHome(tag, { root = REPO } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `onboard-${tag}-`));
  const dotClaude = path.join(home, '.claude');
  fs.mkdirSync(dotClaude, { recursive: true });
  fs.copyFileSync(path.join(root, 'docs', 'global-CLAUDE.md'), path.join(dotClaude, 'CLAUDE.md'));
  fs.symlinkSync(path.join(root, 'host', 'skills'), path.join(dotClaude, 'skills'), 'junction');
  // 假 memory clone：origin 指向正牌 memory 仓
  const clone = path.join(home, 'fake-memory-clone');
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  fs.writeFileSync(path.join(clone, '.git', 'config'),
    '[remote "origin"]\n\turl = git@github.com:thoerwink8/windsurf-dao-memory.git\n');
  return { home, clone };
}
async function linkMemory(home, clone, root) {
  const M = await MEM_LOAD;
  const memDir = path.join(home, '.claude', 'projects', M.encodeProjectDir(root), 'memory');
  fs.mkdirSync(path.dirname(memDir), { recursive: true });
  fs.symlinkSync(clone, memDir, 'junction');
  return memDir;
}
const mkCreds = (home) => fs.mkdirSync(path.join(home, '.dao', 'apps'), { recursive: true });

describe('onboard', () => {
  it('全绿基线：0 问题，哨兵零输出（绿≠碰巧没扫）', async () => {
    const S = await LIB_LOAD;
    const { home, clone } = mkHome('green');
    await linkMemory(home, clone, REPO);
    mkCreds(home);
    const r = S.checkOnboard({ root: REPO, home });
    assert.deepEqual(r.unscanned, [], '不该没查成  →  ' + JSON.stringify(r.unscanned));
    assert.equal(r.problems.length, 0, '全绿  →  ' + JSON.stringify(r.problems));
    assert.equal(S.onboardNoticeLine(r), '', '哨兵绿必须零输出');
  });

  it('故意违规逐类被拦', async (t) => {
    const S = await LIB_LOAD;
    const ids = async (home) => (S.checkOnboard({ root: REPO, home })).problems.map(p => p.id);

    await t.test('全局约定漂移', async () => {
      const { home, clone } = mkHome('drift'); await linkMemory(home, clone, REPO); mkCreds(home);
      fs.appendFileSync(path.join(home, '.claude', 'CLAUDE.md'), '\n本机私改一行\n');
      assert.ok((await ids(home)).includes('global-drift'));
    });
    await t.test('skills 链接不在', async () => {
      const { home, clone } = mkHome('noskill'); await linkMemory(home, clone, REPO); mkCreds(home);
      fs.rmSync(path.join(home, '.claude', 'skills'));
      assert.ok((await ids(home)).includes('skills-missing'));
    });
    await t.test('skills/dispatch 是拷贝的真目录 → skills-not-link 只报不修', async () => {
      const { home, clone } = mkHome('dirskill'); await linkMemory(home, clone, REPO); mkCreds(home);
      const p = path.join(home, '.claude', 'skills');
      fs.rmSync(p); fs.mkdirSync(path.join(p, 'dispatch'), { recursive: true });
      fs.writeFileSync(path.join(p, 'dispatch', 'SKILL.md'), '拷贝残留');
      assert.ok((await ids(home)).includes('skills-not-link'));
    });
    await t.test('skills 目录在但缺链接 → skills-partial（可修）', async () => {
      const { home, clone } = mkHome('partial'); await linkMemory(home, clone, REPO); mkCreds(home);
      const p = path.join(home, '.claude', 'skills');
      fs.rmSync(p); fs.mkdirSync(p);
      assert.ok((await ids(home)).includes('skills-partial'));
    });
    await t.test('逐个链接形态（现行部署）→ 绿', async () => {
      const { home, clone } = mkHome('perskill'); await linkMemory(home, clone, REPO); mkCreds(home);
      const p = path.join(home, '.claude', 'skills');
      fs.rmSync(p); fs.mkdirSync(p);
      fs.symlinkSync(path.join(REPO, 'host', 'skills', 'dispatch'), path.join(p, 'dispatch'), 'junction');
      assert.equal((await ids(home)).length, 0, '逐个链接应绿');
    });
    await t.test('memory 未接 / 凭据缺失 一起报（主 clone 形态：.git 是目录）', async () => {
      // 本测试仓自己是 linked worktree（.git 是文件），会命中「worktree 不报 memory」的抑制；
      // 造一个 .git 为目录的合成主 clone 根来验「换机没接」这条真的会响。
      const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-mainclone-'));
      fs.mkdirSync(path.join(fakeRoot, '.git'));
      fs.mkdirSync(path.join(fakeRoot, 'docs'), { recursive: true });
      fs.copyFileSync(path.join(REPO, 'docs', 'global-CLAUDE.md'), path.join(fakeRoot, 'docs', 'global-CLAUDE.md'));
      fs.mkdirSync(path.join(fakeRoot, 'host', 'skills', 'dispatch'), { recursive: true });
      fs.writeFileSync(path.join(fakeRoot, 'host', 'skills', 'dispatch', 'SKILL.md'), 'stub');
      const { home } = mkHome('nomem', { root: fakeRoot }); // 不接 memory、不放凭据
      const S2 = await LIB_LOAD;
      const got = S2.checkOnboard({ root: fakeRoot, home }).problems.map(p => p.id);
      assert.ok(got.includes('memory-unlinked') && got.includes('creds-missing'), JSON.stringify(got));
    });
    await t.test('linked worktree（.git 是文件）不报 memory-unlinked——不许每会话刷噪音', async () => {
      // 不拿 REPO 当样本：本仓在主 clone（.git 是目录）上跑时形态就变了，
      // 断言不得依赖测试仓自己的形态——造一个 .git 是文件的合成 worktree 根。
      const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-wtroot-'));
      fs.writeFileSync(path.join(wtRoot, '.git'), 'gitdir: ../elsewhere/.git/worktrees/x\n');
      fs.mkdirSync(path.join(wtRoot, 'docs'), { recursive: true });
      fs.copyFileSync(path.join(REPO, 'docs', 'global-CLAUDE.md'), path.join(wtRoot, 'docs', 'global-CLAUDE.md'));
      fs.mkdirSync(path.join(wtRoot, 'host', 'skills', 'dispatch'), { recursive: true });
      fs.writeFileSync(path.join(wtRoot, 'host', 'skills', 'dispatch', 'SKILL.md'), 'stub');
      const { home } = mkHome('wtquiet', { root: wtRoot }); mkCreds(home); // 不接 memory
      const S2 = await LIB_LOAD;
      const got = S2.checkOnboard({ root: wtRoot, home }).problems.map(p => p.id);
      assert.ok(!got.includes('memory-unlinked'), JSON.stringify(got));
    });
  });

  describe('④ MCP 冷启动开销', () => {
    const writeMcp = (home, servers) =>
      fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: servers }));

    it('没有 ~/.claude.json 不算问题（没配过 MCP 的机器）', async () => {
      const S = await LIB_LOAD;
      const { home } = mkHome('mcp-none');
      assert.deepEqual(S.checkMcpBootCost({ home }), {});
    });

    it('npx @latest 型被拦住，报 mcp-slow-boot 且点名是哪几个', async () => {
      const S = await LIB_LOAD;
      const { home } = mkHome('mcp-slow');
      writeMcp(home, {
        playwright: { command: 'cmd', args: ['/c', 'npx', '-y', '@playwright/mcp@latest'] },
        context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] },
        fast: { command: 'cmd', args: ['/c', 'C:\\bin\\context7-mcp.cmd'] },
      });
      const r = S.checkMcpBootCost({ home });
      assert.equal(r.problem?.id, 'mcp-slow-boot', JSON.stringify(r));
      assert.match(r.problem.msg, /playwright/);
      assert.match(r.problem.msg, /context7/);
      assert.ok(!/fast/.test(r.problem.msg), '钉到本地的不该被算慢  →  ' + r.problem.msg);
    });

    it('全部钉到本地命令 = 绿（证明绿是查过的绿）', async () => {
      const S = await LIB_LOAD;
      const { home } = mkHome('mcp-pinned');
      writeMcp(home, {
        context7: { command: 'cmd', args: ['/c', 'C:\\Users\\x\\nodejs\\context7-mcp.cmd'] },
        codegraph: { command: 'cmd', args: ['/c', 'C:/tools/node.exe', 'C:/tools/codegraph.js', 'serve'] },
      });
      assert.deepEqual(S.checkMcpBootCost({ home }), {});
    });

    it('读得到但解析不了 → unscanned，不是「查过没事」', async () => {
      const S = await LIB_LOAD;
      const { home } = mkHome('mcp-broken');
      fs.writeFileSync(path.join(home, '.claude.json'), '{ 这不是 JSON');
      const r = S.checkMcpBootCost({ home });
      assert.ok(r.unscanned, JSON.stringify(r));
      assert.ok(!r.problem, '没查成不许当成问题报  →  ' + JSON.stringify(r));
    });

    it('onboard.mjs 只报不修：不碰用户的 ~/.claude.json', async () => {
      const { home, clone } = mkHome('mcp-e2e');
      await linkMemory(home, clone, REPO); mkCreds(home);
      const cfg = path.join(home, '.claude.json');
      writeMcp(home, { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } });
      const before = fs.readFileSync(cfg, 'utf8');
      const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'onboard.mjs')],
        { env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: 'utf8' });
      assert.match(r.stdout, /只报不修.*mcp-slow-boot/, r.stdout + r.stderr);
      assert.equal(fs.readFileSync(cfg, 'utf8'), before, 'onboard 不许改用户的 MCP 配置');
    });

    it('项目级 mcpServers 也算（claude mcp add 默认就落这儿）', async () => {
      const S = await LIB_LOAD;
      const { home } = mkHome('mcp-proj');
      fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
        mcpServers: {},
        projects: { 'C:/some/proj': { mcpServers: { foo: { command: 'npx', args: ['-y', 'foo@latest'] } } } },
      }));
      const r = S.checkMcpBootCost({ home });
      assert.equal(r.problem?.id, 'mcp-slow-boot', JSON.stringify(r));
      assert.match(r.problem.msg, /foo@proj/, '要点名是哪个项目的  →  ' + r.problem.msg);
    });

    it('uvx 且本机没有 uv 托管 Python → 说清是握手必失败，不是慢', async () => {
      const S = await LIB_LOAD;
      const { home } = mkHome('mcp-uvx-nopy');
      writeMcp(home, { fetch: { command: 'uvx', args: ['--with', 'mcp<2', 'mcp-server-fetch'] } });
      const r = S.checkMcpBootCost({ home });
      assert.match(r.problem.msg, /CONNECTION_CLOSED/, '慢与必失败要分开  →  ' + r.problem.msg);
    });

    it('uvx 但有 uv 托管 Python → 只说慢，不喊必失败', async () => {
      const S = await LIB_LOAD;
      const { home } = mkHome('mcp-uvx-py');
      fs.mkdirSync(path.join(home, 'AppData', 'Roaming', 'uv', 'python', 'cpython-3.12'), { recursive: true });
      writeMcp(home, { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } });
      const r = S.checkMcpBootCost({ home });
      assert.equal(r.problem?.id, 'mcp-slow-boot');
      assert.ok(!/CONNECTION_CLOSED/.test(r.problem.msg), r.problem.msg);
    });

    it('只剩只报不修项时：哨兵不指去跑 onboard，onboard 自己也不红', async () => {
      const S = await LIB_LOAD;
      const { home, clone } = mkHome('mcp-quiet');
      await linkMemory(home, clone, REPO); mkCreds(home);
      writeMcp(home, { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } });
      const line = S.onboardNoticeLine(S.checkOnboard({ root: REPO, home }));
      assert.match(line, /mcp-slow-boot/, line);
      assert.ok(!/同意后跑/.test(line), '修不了就别把人指过去  →  ' + line);
      const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'onboard.mjs')],
        { env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: 'utf8' });
      assert.equal(r.status, 0, '只报不修项不该让 onboard 永远红  →  ' + r.stdout + r.stderr);
    });
  });

  it('没查成与绿不同形：真相源不在 → unscanned，哨兵行说「没查成」', async () => {
    const S = await LIB_LOAD;
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-noroot-'));
    const { home } = mkHome('unscanned');
    const r = S.checkOnboard({ root: fakeRoot, home });
    assert.ok(r.unscanned.length >= 1, '必须落 unscanned  →  ' + JSON.stringify(r));
    const line = S.onboardNoticeLine(r);
    assert.ok(/没查成/.test(line) && !/未就绪/.test(line), '形要分开  →  ' + line);
  });

  it('onboard.mjs e2e：dry-run 不动，实跑修复漂移并留备份', async (t) => {
    const { home, clone } = mkHome('e2e'); await linkMemory(home, clone, REPO); mkCreds(home);
    const live = path.join(home, '.claude', 'CLAUDE.md');
    fs.appendFileSync(live, '\n漂移标记\n');
    const drifted = fs.readFileSync(live, 'utf8');
    const env = { ...process.env, USERPROFILE: home, HOME: home };
    const run = (args) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'onboard.mjs'), ...args], { env, encoding: 'utf8' });

    await t.test('dry-run：exit 1 且文件原样', () => {
      const r = run(['--dry-run']);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.equal(fs.readFileSync(live, 'utf8'), drifted, 'dry-run 不许动文件');
    });
    await t.test('实跑：exit 0、内容归位、备份在', () => {
      const r = run([]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const truth = fs.readFileSync(path.join(REPO, 'docs', 'global-CLAUDE.md'), 'utf8');
      assert.equal(fs.readFileSync(live, 'utf8'), truth, '应与真相源一致');
      const baks = fs.readdirSync(path.dirname(live)).filter(f => f.startsWith('CLAUDE.md.bak-'));
      assert.ok(baks.length === 1, '备份要在  →  ' + JSON.stringify(baks));
    });
    await t.test('幂等：再跑一遍还是 0 且不再多备份', () => {
      const r = run([]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const baks = fs.readdirSync(path.dirname(live)).filter(f => f.startsWith('CLAUDE.md.bak-'));
      assert.equal(baks.length, 1, '全绿不该再备份');
    });
  });

  describe('⑥ pi 扩展 go-fallback（仓是真相源，本机是拷贝）', () => {
    const ext = (home) => path.join(home, '.pi', 'agent', 'extensions');
    const truth = (f) => fs.readFileSync(path.join(REPO, 'host', 'pi-extensions', f), 'utf8');
    const installAll = (home) => { fs.mkdirSync(ext(home), { recursive: true }); for (const f of ['go-fallback.ts', 'go-fallback-core.mjs']) fs.writeFileSync(path.join(ext(home), f), truth(f)); };

    it('没装 pi（~/.pi/agent 不在）→ 不算问题', async () => {
      const S = await LIB_LOAD;
      const { home } = mkHome('pi-none');
      assert.deepEqual(S.checkPiExtensions({ root: REPO, home }), {});
    });
    it('两个文件都与仓一致 → 绿（证明绿是查过的绿）', async () => {
      const S = await LIB_LOAD;
      const { home } = mkHome('pi-ok'); installAll(home);
      assert.deepEqual(S.checkPiExtensions({ root: REPO, home }), {});
    });
    it('只拷了 .ts 漏了它 import 的 core（NEW-MACHINE 旧装法）→ pi-ext-missing 点名 core', async () => {
      const S = await LIB_LOAD;
      const { home } = mkHome('pi-missing'); installAll(home);
      fs.rmSync(path.join(ext(home), 'go-fallback-core.mjs'));
      const r = S.checkPiExtensions({ root: REPO, home });
      assert.equal(r.problem?.id, 'pi-ext-missing', JSON.stringify(r));
      assert.match(r.problem.msg, /go-fallback-core\.mjs/);
    });
    it('本机副本与仓不一致 → pi-ext-drift', async () => {
      const S = await LIB_LOAD;
      const { home } = mkHome('pi-drift'); installAll(home);
      fs.appendFileSync(path.join(ext(home), 'go-fallback.ts'), '\n// 本机手改\n');
      assert.equal(S.checkPiExtensions({ root: REPO, home }).problem?.id, 'pi-ext-drift');
    });
    it('onboard.mjs e2e：缺/漂都重拷，手改的留备份，再跑幂等', async () => {
      const { home, clone } = mkHome('pi-e2e'); await linkMemory(home, clone, REPO); mkCreds(home);
      installAll(home);
      fs.rmSync(path.join(ext(home), 'go-fallback-core.mjs'));
      fs.appendFileSync(path.join(ext(home), 'go-fallback.ts'), '\n// 本机手改\n');
      const env = { ...process.env, USERPROFILE: home, HOME: home };
      const run = () => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'onboard.mjs')], { env, encoding: 'utf8' });
      let r = run();
      assert.equal(r.status, 0, r.stdout + r.stderr);
      for (const f of ['go-fallback.ts', 'go-fallback-core.mjs'])
        assert.equal(fs.readFileSync(path.join(ext(home), f), 'utf8'), truth(f), `${f} 应与仓一致`);
      assert.ok(fs.readdirSync(ext(home)).some(f => f.startsWith('go-fallback.ts.bak-')), '手改过的要留备份');
      r = run();
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /全绿：/, '再跑应全绿  →  ' + r.stdout);
    });
  });

  it('接线：settings.json SessionStart 只挂 onboard 哨兵（守卫已归零不许回来）', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8'));
    const cmds = (settings.hooks?.SessionStart || []).flatMap(g => (g.hooks || []).map(h => h.command));
    assert.ok(cmds.length === 1 && cmds[0].includes('onboard-session-hook.mjs'), JSON.stringify(cmds));
    assert.ok(!cmds.some(c => c.includes('guard-session-hook')), '守卫不许借尸还魂');
  });

  it('接线：.cursor/hooks.json 只挂派工闸（守卫归零时漏摘的 Cursor 面，2026-09-02 补）', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(REPO, '.cursor', 'hooks.json'), 'utf8')).hooks || {};
    assert.deepEqual(Object.keys(hooks), ['beforeShellExecution'], JSON.stringify(Object.keys(hooks)));
    const cmds = JSON.stringify(hooks);
    assert.ok(!/guard-session-hook|board-hook/.test(cmds), '守卫/盘面不许借尸还魂  →  ' + cmds);
  });

  describe('⑤ 状态栏脚本路径（settings.json 里唯一指向本仓的本机绝对路径）', () => {
    const writeSettings = (home, obj) => fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(obj));

    it('没有 settings.json / 没配 statusLine → 不算问题（不猜）', async () => {
      const S = await LIB_LOAD;
      const { home } = mkHome('sl-none');
      assert.deepEqual(S.checkStatusLine({ home }), {});
      writeSettings(home, { model: 'sonnet' });
      assert.deepEqual(S.checkStatusLine({ home }), {});
    });

    it('指向仓里真在的 host/statusline.js → 绿（证明绿是查过的绿）', async () => {
      const S = await LIB_LOAD;
      const { home } = mkHome('sl-ok');
      writeSettings(home, { statusLine: { type: 'command', command: `node ${path.join(REPO, 'host', 'statusline.js').replace(/\\/g, '/')}` } });
      assert.deepEqual(S.checkStatusLine({ home }), {});
    });

    it('指向别台机器的路径（仓搬家/换盘）→ statusline-dangling，只报不修、不碰 settings.json', async () => {
      const S = await LIB_LOAD;
      const { home, clone } = mkHome('sl-dangling'); await linkMemory(home, clone, REPO); mkCreds(home);
      writeSettings(home, { statusLine: { type: 'command', command: 'node D:/elsewhere/windsurf-dao/host/statusline.js' } });
      const r = S.checkStatusLine({ home });
      assert.equal(r.problem?.id, 'statusline-dangling', JSON.stringify(r));
      assert.match(r.problem.msg, /D:\/elsewhere/, '要点名指到哪去了  →  ' + r.problem.msg);
      const line = S.onboardNoticeLine(S.checkOnboard({ root: REPO, home }));
      assert.match(line, /statusline-dangling/, line);
      assert.ok(!/同意后跑/.test(line), '修不了就别把人指去跑 onboard  →  ' + line);
      const cfg = path.join(home, '.claude', 'settings.json');
      const before = fs.readFileSync(cfg, 'utf8');
      const run = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'onboard.mjs')],
        { env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: 'utf8' });
      assert.equal(run.status, 0, '只报不修项不该让 onboard 红  →  ' + run.stdout + run.stderr);
      assert.equal(fs.readFileSync(cfg, 'utf8'), before, 'onboard 不许碰 settings.json（红线文件）');
    });

    it('settings.json 解析不了 → unscanned，不是「查过没事」', async () => {
      const S = await LIB_LOAD;
      const { home } = mkHome('sl-broken');
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ 坏的');
      const r = S.checkStatusLine({ home });
      assert.ok(r.unscanned && !r.problem, JSON.stringify(r));
    });
  });
});
