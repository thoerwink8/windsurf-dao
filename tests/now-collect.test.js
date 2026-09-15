// `dao now` 取数层回归（#905 返工）：本机真读 HEAD、远端按登记 treePath 补采。
// 判官（same/behind、live/gone）仍在 now-board.mjs，这里只证明取数把数送到判官。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const BOARD = path.join(REPO, 'scripts', 'lib', 'now-board.mjs');
const COLLECT = path.join(REPO, 'scripts', 'lib', 'now-collect.mjs');
const load = p => import('file://' + p.replace(/\\/g, '/'));

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const WT = '/home/orca/wt-unblock';
const MIRA = '/home/orca/mirasim-worktrees/windsurf-dao/dao-review-pr-900';
const DEAD_STUB = '本机侧没读审官树 HEAD';

/** 新脚本必须从登记抽出 treePath 再 git -C 打 TREE；只扫 mirasim-worktrees 的旧脚本必须翻红。 */
function coversRegistryTreePath(script) {
  const s = String(script || '');
  if (!/treePath/.test(s)) return false;
  if (!/-C "\$tp"/.test(s)) return false;
  if (!/printf "TREE\\t/.test(s)) return false;
  return true;
}

const OLD_REMOTE_TREE_ONLY = [
  'set -u',
  'for t in "$HOME"/mirasim-worktrees/*/* /home/orca/mirasim-worktrees/*/*; do',
  '  case "$t" in *"*"*) continue;; esac',
  '  [ -e "$t/.git" ] || continue',
  '  oid=$(git -c safe.directory="*" -C "$t" rev-parse HEAD 2>/dev/null) || oid=-',
  '  printf "TREE\\t%s\\t%s\\n" "$t" "$oid"',
  'done',
  'for p in /proc/[0-9]*; do',
  '  cwd=$(readlink "$p/cwd" 2>/dev/null) || continue',
  '  case "$cwd" in *mirasim-worktrees*) printf "PROC\\t%s\\t%s\\n" "${p#/proc/}" "$cwd";; esac',
  'done',
  'printf "END\\n"',
].join('\n');

describe('dao now 取数：本机 fillTreeHeads / lookupGitHead', () => {
  it('源码不再写死桩「本机侧没读审官树 HEAD」', () => {
    const src = fs.readFileSync(COLLECT, 'utf8');
    assert.doesNotMatch(src, /本机侧没读审官树 HEAD/);
  });

  it('fillTreeHeads + judgeTreeHead：lookup 给 A、PR head 也是 A → same', async () => {
    const C = await load(COLLECT);
    const S = await load(BOARD);
    const items = [{ pr: '1', treePath: '/t/a' }];
    C.fillTreeHeads(items, (p) => {
      assert.equal(p, '/t/a');
      return { scanned: true, oid: HEAD };
    });
    assert.equal(items[0].treeHead.scanned, true);
    assert.equal(items[0].treeHead.oid, HEAD);
    assert.equal(S.judgeTreeHead({ treeHead: items[0].treeHead, headRefOid: HEAD }).state, 'same');
  });

  it('fillTreeHeads + judgeTreeHead：lookup 给 A、PR head 是 B → behind', async () => {
    const C = await load(COLLECT);
    const S = await load(BOARD);
    const items = [{ pr: '1', treePath: '/t/a' }];
    C.fillTreeHeads(items, () => ({ scanned: true, oid: OLD }));
    assert.equal(items[0].treeHead.scanned, true);
    assert.equal(items[0].treeHead.oid, OLD);
    const behind = S.judgeTreeHead({ treeHead: items[0].treeHead, headRefOid: HEAD });
    assert.equal(behind.state, 'behind');
    assert.match(behind.why, /审官树停在/);
  });

  it('treePath 有、lookup 失败 → scanned:false，error 带路径，不得再出现死桩', async () => {
    const C = await load(COLLECT);
    const items = [{ pr: '1', treePath: '/t/fail' }];
    C.fillTreeHeads(items, (p) => ({ scanned: false, error: `审官树 ${p} 的 HEAD 没读到：git 退出 128` }));
    assert.equal(items[0].treeHead.scanned, false);
    assert.match(items[0].treeHead.error, /\/t\/fail/);
    assert.doesNotMatch(items[0].treeHead.error, new RegExp(DEAD_STUB));
    const direct = C.lookupGitHead('/t/fail', {
      exists: () => true,
      runGit: () => ({ ok: false, error: 'fatal: not a git repository' }),
    });
    assert.equal(direct.scanned, false);
    assert.match(direct.error, /\/t\/fail/);
    assert.doesNotMatch(direct.error, new RegExp(DEAD_STUB));
  });

  it('已有 treeHead.scanned===true → 不覆盖', async () => {
    const C = await load(COLLECT);
    const items = [{ pr: '1', treePath: '/t/a', treeHead: { scanned: true, oid: OLD } }];
    C.fillTreeHeads(items, () => ({ scanned: true, oid: HEAD }));
    assert.equal(items[0].treeHead.oid, OLD);
  });

  it('无 treePath → scanned:false，error 说登记没写路径', async () => {
    const C = await load(COLLECT);
    const items = [{ pr: '1' }];
    C.fillTreeHeads(items, () => { throw new Error('无路径不该调 lookup'); });
    assert.equal(items[0].treeHead.scanned, false);
    assert.match(items[0].treeHead.error, /登记没写路径/);
    const direct = C.lookupGitHead('');
    assert.equal(direct.scanned, false);
    assert.match(direct.error, /登记没写路径|没写路径/);
  });

  it('lookupGitHead 可注入 runGit：成功给出 40 位 hex', async () => {
    const C = await load(COLLECT);
    const r = C.lookupGitHead('/t/a', {
      exists: () => true,
      runGit: (p) => {
        assert.equal(p, '/t/a');
        return { ok: true, out: `${HEAD}\n` };
      },
    });
    assert.equal(r.scanned, true);
    assert.equal(r.oid, HEAD);
  });

  it('lookupGitHead 真 git init 临时仓：oid 对得上 rev-parse HEAD', async () => {
    const C = await load(COLLECT);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'now-collect-git-'));
    try {
      const init = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
      assert.equal(init.status, 0, init.stderr);
      const commit = spawnSync('git', [
        '-c', 'user.email=now-collect@test',
        '-c', 'user.name=now-collect',
        'commit', '--allow-empty', '-m', 'i',
      ], { cwd: dir, encoding: 'utf8' });
      assert.equal(commit.status, 0, commit.stderr);
      const want = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
      assert.match(want, /^[0-9a-f]{40}$/i);
      const got = C.lookupGitHead(dir);
      assert.equal(got.scanned, true, JSON.stringify(got));
      assert.equal(got.oid, want);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dao now 取数：登记落点必须含真实写入方那个目录', () => {
  const DAO = path.join(REPO, 'scripts', 'dao.mjs');

  it('本机候选目录里有 ~/.dao/mirasim（否则每一张有审官的 PR 都判成「登记找不到」）', async () => {
    const C = await load(COLLECT);
    const dirs = C.localRegistryDirs({ repoRoot: '/repo', worktreePaths: ['/repo/.claude/worktrees/a'], home: '/home/orca' });
    assert.ok(dirs.includes(path.join('/home/orca', '.dao', 'mirasim')), `候选目录里没有写入方那个目录：${dirs.join(', ')}`);
  });

  it('正控：写入方的 flowDir 与本动词扫的目录是同一个（抄判据信源，不信文案）', async () => {
    const C = await load(COLLECT);
    // 判据取自**写入方源码本身**：mirasimRegistry() 里 flowDir 那段。
    // 手打一遍路径当判据，就会在写入方换落点时静默失配（判例 hand-typed-constant-will-be-wrong）。
    const src = fs.readFileSync(DAO, 'utf8');
    const m = /flowDir:\s*join\(homedir\(\),\s*'([^']+)',\s*'([^']+)'\)/.exec(src);
    assert.ok(m, 'dao.mjs 里找不到 mirasimRegistry 的 flowDir（写入方换了写法，本判据要跟着改）');
    const want = path.join('/home/orca', ...m.slice(1));
    const dirs = C.localRegistryDirs({ repoRoot: '/repo', home: '/home/orca' });
    assert.ok(dirs.includes(want), `写入方写到 ${want}，候选目录扫的是 ${dirs.join(', ')}`);
  });
});

describe('dao now 取数：远端按登记 treePath 补采（含 /home/orca/wt-*）', () => {
  it('REG treePath=/home/orca/wt-unblock + TREE/PROC 同路径 → treeHead scanned 且会话 live', async () => {
    const C = await load(COLLECT);
    const S = await load(BOARD);
    const items = C.attachRemoteTreeHeads(
      [{ pr: '900', treePath: WT }],
      new Map([[WT, HEAD]]),
    );
    assert.equal(items[0].treeHead.scanned, true);
    assert.equal(items[0].treeHead.oid, HEAD);
    const sess = S.judgeSession({
      sessions: { scanned: true, items: [{ pid: '42', cwd: WT }] },
      treePath: WT,
    });
    assert.equal(sess.state, 'live');
  });

  it('只有 TREE mirasim-worktrees、REG 的 treePath 是 /home/orca/wt-unblock → treeHead 没查成', async () => {
    const C = await load(COLLECT);
    const items = C.attachRemoteTreeHeads(
      [{ pr: '900', treePath: WT }],
      new Map([[MIRA, HEAD]]),
    );
    assert.equal(items[0].treeHead.scanned, false, '漏扫必须可见，不是默认同步');
    assert.match(items[0].treeHead.error, /wt-unblock/);
  });

  it('parseRemoteScan 认 TREE/PROC 的 /home/orca/wt-* 路径', async () => {
    const C = await load(COLLECT);
    const p = C.parseRemoteScan([
      `TREE\t${WT}\t${HEAD}`,
      `PROC\t42\t${WT}`,
      'END',
    ].join('\n'));
    assert.equal(p.ended, true);
    assert.equal(p.trees.get(WT), HEAD);
    assert.equal(p.procs.length, 1);
    assert.equal(p.procs[0].cwd, WT);
    assert.equal(p.procs[0].pid, '42');
  });

  it('REMOTE_SCRIPT 按登记 treePath 打 TREE；只扫 mirasim-worktrees 的旧脚本要翻红', async () => {
    const C = await load(COLLECT);
    assert.equal(typeof C.REMOTE_SCRIPT, 'string');
    assert.doesNotMatch(C.REMOTE_SCRIPT, /\$\{/, '远端脚本禁止 ${}（JS 模板串会先吃掉）');
    assert.equal(
      coversRegistryTreePath(OLD_REMOTE_TREE_ONLY),
      false,
      '只扫 mirasim-worktrees 的旧脚本必须翻红',
    );
    assert.equal(
      coversRegistryTreePath(C.REMOTE_SCRIPT),
      true,
      '新脚本必须从登记 treePath 打 TREE',
    );
    assert.match(C.REMOTE_SCRIPT, /treePath/);
    assert.doesNotMatch(C.REMOTE_SCRIPT, /case "\$cwd" in \*mirasim-worktrees\*/);
  });
});

const OLD_PER_FILE_PYTHON = [
  'for f in "$d"/reviewer-*.json; do',
  '  [ -f "$f" ] || continue',
  '  printf "REG\\t%s\\t%s\\n" "$f" "$(base64 -w0 < "$f")"',
  '  tp=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(\\"treePath\\") or \\"\\")" "$f" 2>/dev/null) || tp=',
  '  if [ -z "$tp" ]; then tp=$(grep -o "\\"treePath\\":\\"[^\\"]*\\"" "$f" 2>/dev/null | head -n 1 | cut -d "\\"" -f 4); fi',
  '  if [ -n "$tp" ]; then printf "%s\\n" "$tp" >> "$TPLIST"; fi',
  'done',
].join('\n');

function spawnsPythonPerRegistry(script) {
  return /python3\s+-c/.test(script);
}

function extractsPrettyTreePath(script) {
  return /treePath/.test(script) && /\[\[:space:\]\]/.test(script);
}

function nestedProcReadlink(script) {
  return /readlink "\$p\/cwd"/.test(script);
}

describe('dao now 取数：自扫复杂度（#1297）', () => {
  it('构造旧实现（逐份 python3 -c / 无空格 grep / 逐 pid readlink）必须被判违规', () => {
    assert.equal(spawnsPythonPerRegistry(OLD_PER_FILE_PYTHON), true);
    assert.equal(extractsPrettyTreePath(OLD_PER_FILE_PYTHON), false, '旧 grep 假定 "treePath":"p"，pretty JSON 会漏');
    assert.equal(nestedProcReadlink(OLD_REMOTE_TREE_ONLY), true);
  });

  it('现役 REMOTE_SCRIPT 不起 python，sed 吃 pretty JSON 空格，/proc 不逐 pid readlink', async () => {
    const C = await load(COLLECT);
    assert.equal(spawnsPythonPerRegistry(C.REMOTE_SCRIPT), false);
    assert.doesNotMatch(C.REMOTE_SCRIPT, /python3/);
    assert.equal(extractsPrettyTreePath(C.REMOTE_SCRIPT), true);
    assert.ok(C.REMOTE_SCRIPT.includes(C.TREE_PATH_SED), '脚本必须用同一条 TREE_PATH_SED');
    assert.equal(nestedProcReadlink(C.REMOTE_SCRIPT), false);
    assert.ok(C.REMOTE_SCRIPT.includes(C.PROC_AWK), '脚本必须用同一条 PROC_AWK');
    assert.match(C.REMOTE_SCRIPT, /ls -l \/proc\/\[0-9\]\*\/cwd/);
  });

  it('PROC_AWK：cwd 等于或落在登记树下才打 PROC；没箭头的行忽略', async () => {
    const C = await load(COLLECT);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'now-proc-awk-'));
    try {
      const tp = path.join(dir, 'tp');
      fs.writeFileSync(tp, `${WT}\n`);
      const ls = [
        `lrwxrwxrwx 1 orca orca 0 Jan 1 /proc/42/cwd -> ${WT}`,
        `lrwxrwxrwx 1 orca orca 0 Jan 1 /proc/43/cwd -> ${WT}/src`,
        'lrwxrwxrwx 1 root root 0 Jan 1 /proc/1/cwd',
        'lrwxrwxrwx 1 orca orca 0 Jan 1 /proc/9/cwd -> /tmp/other',
      ].join('\n') + '\n';
      const r = await C.run('awk', ['-v', `tplist=${tp}`, C.PROC_AWK], { input: ls, timeout: 2000 });
      assert.equal(r.ok, true, r.error);
      const p = C.parseRemoteScan(`${r.out}END\n`);
      const cwds = p.procs.map((x) => `${x.pid}:${x.cwd}`).sort();
      assert.deepEqual(cwds, [`42:${WT}`, `43:${WT}/src`]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('TREE_PATH_SED 抽出 pretty 与 compact 的 treePath', async () => {
    const C = await load(COLLECT);
    const pretty = '{\n  "treePath": "/home/orca/wt-unblock"\n}\n';
    const compact = '{"treePath":"/home/orca/wt-unblock"}\n';
    const a = await C.run('sed', ['-n', C.TREE_PATH_SED], { input: pretty, timeout: 2000 });
    const b = await C.run('sed', ['-n', C.TREE_PATH_SED], { input: compact, timeout: 2000 });
    assert.equal(a.ok, true, a.error);
    assert.equal(b.ok, true, b.error);
    assert.equal(String(a.out).trim(), '/home/orca/wt-unblock');
    assert.equal(String(b.out).trim(), '/home/orca/wt-unblock');
  });

  it('输出没 END → 两侧都 unscanned', async () => {
    const C = await load(COLLECT);
    const r = await C.fetchLocalSelfScan({
      runFn: async () => ({ ok: true, out: 'DIROK\t/x\n' }),
    });
    assert.equal(r.registries.scanned, false);
    assert.equal(r.sessions.scanned, false);
    assert.match(r.registries.error, /没查成|没跑完/);
  });

  it('故意拖过预算 → 明确 unscanned', { timeout: 5000 }, async () => {
    const C = await load(COLLECT);
    const r = await C.fetchLocalSelfScan({
      timeout: 80,
      script: 'sleep 2\nprintf END\n',
    });
    assert.equal(r.registries.scanned, false);
    assert.equal(r.sessions.scanned, false);
    assert.match(r.registries.error, /没查成/);
  });

  it('本机自扫在 11 秒内完成并返回 END', { timeout: 15000 }, async () => {
    const C = await load(COLLECT);
    const t0 = Date.now();
    const r = await C.run('sh', ['-s'], { timeout: C.SCAN_TIMEOUT_MS, input: C.REMOTE_SCRIPT });
    const ms = Date.now() - t0;
    assert.ok(r.ok, r.error);
    const p = C.parseRemoteScan(r.out);
    assert.equal(p.ended, true, `没收到 END（${ms}ms）：${String(r.out).slice(-200)}`);
    assert.ok(ms < C.SCAN_TIMEOUT_MS, `自扫 ${ms}ms，超了 ${C.SCAN_TIMEOUT_MS}`);
    const withPath = p.regs.filter((x) => x && x.treePath);
    if (withPath.length) {
      const hits = withPath.filter((x) => p.trees.has(x.treePath));
      assert.ok(hits.length > 0, '登记有 treePath 却没打出 TREE（sed 抽路径失败）');
    }
  });
});

