// .git 属主一致性闸（dao-check ㉟，issue #1149）
//
// 验 scripts/lib/git-ownership-check.mjs：
//   故意构造 root 属主文件 → 红且点名文件；
//   干净仓 → 绿；
//   仓不在 → 没查成，不许当绿；
//   检查器自持判据，不 import 被检查对象；
//   红/绿/空夹具有判别力。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'git-ownership-check.mjs');
const FIX = path.join(__dirname, 'fixtures', 'git-ownership');
const LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function probes({ existsMap, dirSet, uidMap, findMap } = {}) {
  return {
    exists: (p) => Boolean(existsMap && existsMap[p]),
    isDir: (p) => Boolean(dirSet && dirSet.has(p)),
    statUid: (p) => {
      if (uidMap && Object.prototype.hasOwnProperty.call(uidMap, p)) return uidMap[p];
      throw new Error(`statUid 没给 ${p}`);
    },
    findRootOwned: (gitDir) => {
      if (findMap && Object.prototype.hasOwnProperty.call(findMap, gitDir)) return findMap[gitDir];
      return { ok: false, error: `find 没给 ${gitDir}` };
    },
  };
}

describe('git-ownership-check', () => {
  it('检查器不复用被检查对象', () => {
    const src = fs.readFileSync(LIB, 'utf8');
    const imports = [...src.matchAll(/^import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.equal(imports.length, 0, '本检查器零 import，探头全注入  →  ' + JSON.stringify(imports));
    assert.equal(/require\s*\(/.test(src), false, '也不许 require 被检查对象');
  });

  it('故意构造 root 属主文件 → 红且点名文件', async () => {
    const S = await LOAD;
    const evil = '/srv/projects/windsurf-dao/.git/objects/pack/pack-evil.pack';
    const r = S.classifyGitOwnership([{
      name: 'windsurf-dao',
      path: '/srv/projects/windsurf-dao',
      gitDir: '/srv/projects/windsurf-dao/.git',
      exists: true,
      scanned: true,
      repoOwnerUid: 1000,
      rootOwned: [evil],
    }]);
    assert.equal(r.kind, 'red');
    assert.match(r.evidence, /pack-evil\.pack/);
    assert.match(r.howToFix, /chown -R orca:orca \/srv\/projects\/windsurf-dao\/\.git/);
  });

  it('干净仓 → 绿', async () => {
    const S = await LOAD;
    const r = S.classifyGitOwnership([{
      name: 'windsurf-dao',
      path: '/srv/projects/windsurf-dao',
      gitDir: '/srv/projects/windsurf-dao/.git',
      exists: true,
      scanned: true,
      repoOwnerUid: 1000,
      rootOwned: [],
    }]);
    assert.equal(r.kind, 'ok');
    assert.match(r.line, /扫完 0 个/);
  });

  it('仓不在 → 没查成，不是绿', async () => {
    const S = await LOAD;
    const r = S.classifyGitOwnership([{
      name: 'ai-gateway-stack',
      path: '/no/such/ai-gateway-stack',
      exists: false,
      scanned: false,
      reason: '仓路径不存在',
    }]);
    assert.equal(r.kind, 'unscanned');
    assert.match(r.line, /没查成/);
    assert.match(r.evidence, /ai-gateway-stack/);
  });

  it('一个仓都没扫 / 空清单 → 没查成', async () => {
    const S = await LOAD;
    assert.equal(S.classifyGitOwnership(null).kind, 'unscanned');
    assert.equal(S.classifyGitOwnership([]).kind, 'unscanned');
    assert.match(S.classifyGitOwnership([]).line, /没查成/);
  });

  it('真污染优先于仓不在：脏仓不许被缺路径盖成没查成', async () => {
    const S = await LOAD;
    const r = S.classifyGitOwnership([
      {
        name: 'windsurf-dao',
        path: '/srv/projects/windsurf-dao',
        gitDir: '/srv/projects/windsurf-dao/.git',
        exists: true,
        scanned: true,
        repoOwnerUid: 1000,
        rootOwned: ['/srv/projects/windsurf-dao/.git/objects/xx'],
      },
      {
        name: 'ai-gateway-stack',
        path: '/no/such',
        exists: false,
        scanned: false,
      },
    ]);
    assert.equal(r.kind, 'red');
    assert.match(r.evidence, /objects\/xx/);
  });

  it('仓本身归 root → skip，不是绿也不是红', async () => {
    const S = await LOAD;
    const r = S.classifyGitOwnership([{
      name: 'windsurf-dao',
      path: '/srv/projects/windsurf-dao',
      exists: true,
      scanned: true,
      repoOwnerUid: 0,
      skippedBecauseRoot: true,
      rootOwned: [],
    }]);
    assert.equal(r.kind, 'skip');
  });

  it('scanGitRepo：仓不在 / .git 缺失 / 非目录 / find 失败 / 干净 / 脏', async () => {
    const S = await LOAD;
    const repo = '/srv/projects/windsurf-dao';
    const gitDir = repo + '/.git';

    const missing = S.scanGitRepo({
      name: 'windsurf-dao',
      path: repo,
      ...probes({ existsMap: {} }),
    });
    assert.equal(missing.exists, false);
    assert.equal(missing.scanned, false);
    assert.match(missing.reason, /仓路径不存在/);

    const noGit = S.scanGitRepo({
      name: 'windsurf-dao',
      path: repo,
      ...probes({ existsMap: { [repo]: true } }),
    });
    assert.equal(noGit.exists, true);
    assert.equal(noGit.scanned, false);
    assert.match(noGit.reason, /\.git 不在/);

    const fileGit = S.scanGitRepo({
      name: 'windsurf-dao',
      path: repo,
      ...probes({
        existsMap: { [repo]: true, [gitDir]: true },
        dirSet: new Set(),
      }),
    });
    assert.equal(fileGit.scanned, false);
    assert.match(fileGit.reason, /不是目录/);

    const noFiles = S.scanGitRepo({
      name: 'windsurf-dao',
      path: repo,
      ...probes({
        existsMap: { [repo]: true, [gitDir]: true },
        dirSet: new Set([gitDir]),
        uidMap: { [repo]: 1000 },
        findMap: { [gitDir]: { ok: true } },
      }),
    });
    assert.equal(noFiles.scanned, false);
    assert.match(noFiles.reason, /没给 files 数组/);

    const findFail = S.scanGitRepo({
      name: 'windsurf-dao',
      path: repo,
      ...probes({
        existsMap: { [repo]: true, [gitDir]: true },
        dirSet: new Set([gitDir]),
        uidMap: { [repo]: 1000 },
        findMap: { [gitDir]: { ok: false, error: 'ENOENT' } },
      }),
    });
    assert.equal(findFail.scanned, false);
    assert.match(findFail.reason, /find 没查成/);

    const clean = S.scanGitRepo({
      name: 'windsurf-dao',
      path: repo,
      ...probes({
        existsMap: { [repo]: true, [gitDir]: true },
        dirSet: new Set([gitDir]),
        uidMap: { [repo]: 1000 },
        findMap: { [gitDir]: { ok: true, files: [] } },
      }),
    });
    assert.equal(clean.scanned, true);
    assert.equal(clean.rootOwned.length, 0);
    assert.equal(S.classifyGitOwnership([clean]).kind, 'ok');

    const dirty = S.scanGitRepo({
      name: 'windsurf-dao',
      path: repo,
      ...probes({
        existsMap: { [repo]: true, [gitDir]: true },
        dirSet: new Set([gitDir]),
        uidMap: { [repo]: 1000 },
        findMap: { [gitDir]: { ok: true, files: [gitDir + '/objects/pack/pack-evil.pack'] } },
      }),
    });
    assert.equal(dirty.scanned, true);
    assert.equal(dirty.rootOwned.length, 1);
    const judged = S.classifyGitOwnership([dirty]);
    assert.equal(judged.kind, 'red');
    assert.match(judged.evidence, /pack-evil\.pack/);
  });

  it('夹具红/绿/空有判别力；故意 root 文件被拦住', async () => {
    const S = await LOAD;
    const exists = (rel) => fs.existsSync(path.join(REPO, rel));
    const readFile = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
    const r = S.inspectGitOwnershipFixtures({ exists, readFile });
    assert.equal(r.ok, true, r.error || JSON.stringify(r));
    assert.equal(r.unscanned, false);
    assert.equal(r.kinds.red, 1);
    assert.equal(r.kinds.ok, 1);
    assert.equal(r.kinds.empty, 1);

    const red = S.classifyGitOwnership(JSON.parse(fs.readFileSync(path.join(FIX, 'red.json'), 'utf8')));
    assert.equal(red.kind, 'red');
    assert.match(red.evidence, /pack-evil\.pack/);

    const ok = S.classifyGitOwnership(JSON.parse(fs.readFileSync(path.join(FIX, 'ok.json'), 'utf8')));
    assert.equal(ok.kind, 'ok');

    const empty = S.classifyGitOwnership(JSON.parse(fs.readFileSync(path.join(FIX, 'empty.json'), 'utf8')));
    assert.equal(empty.kind, 'unscanned');
    assert.match(empty.line, /没查成/);
  });

  it('在管仓清单钉死两仓', async () => {
    const S = await LOAD;
    assert.equal(S.DEFAULT_MANAGED_REPOS.length, 2);
    assert.equal(S.DEFAULT_MANAGED_REPOS[0].name, 'windsurf-dao');
    assert.equal(S.DEFAULT_MANAGED_REPOS[0].path, '/srv/projects/windsurf-dao');
    assert.equal(S.DEFAULT_MANAGED_REPOS[1].name, 'ai-gateway-stack');
    assert.equal(S.DEFAULT_MANAGED_REPOS[1].path, '/srv/projects/ai-gateway-stack');
  });

  it('find 权限错误 / 非零退出 → 没查成，不是绿', async () => {
    const S = await LOAD;
    const denied = S.interpretFindRootOwned({
      status: 1,
      stdout: '',
      stderr: 'find: \'/srv/projects/windsurf-dao/.git/objects\': Permission denied\n',
    });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /Permission denied/);

    const repo = '/srv/projects/windsurf-dao';
    const gitDir = repo + '/.git';
    const scan = S.scanGitRepo({
      name: 'windsurf-dao',
      path: repo,
      ...probes({
        existsMap: { [repo]: true, [gitDir]: true },
        dirSet: new Set([gitDir]),
        uidMap: { [repo]: 1000 },
        findMap: { [gitDir]: denied },
      }),
    });
    assert.equal(scan.scanned, false);
    assert.match(scan.reason, /Permission denied/);
    const judged = S.classifyGitOwnership([scan]);
    assert.equal(judged.kind, 'unscanned');
    assert.match(judged.line, /没扫成/);

    // 判别力反证：旧写法把 Permission denied 滤掉、status=1 当干净——同一份 stderr 必须仍是没查成
    const leaked = S.interpretFindRootOwned({
      status: 1,
      stdout: '',
      stderr: 'find: \'.git/objects/pack\': Permission denied\n',
    });
    assert.equal(leaked.ok, false, 'status=1 + 只有 Permission denied 不许当干净');
    assert.equal(Array.isArray(leaked.files), false);

    const status0WithStderr = S.interpretFindRootOwned({
      status: 0,
      stdout: '',
      stderr: 'find: \'.git\': Permission denied\n',
    });
    assert.equal(status0WithStderr.ok, false);

    const cleanFind = S.interpretFindRootOwned({ status: 0, stdout: '', stderr: '' });
    assert.equal(cleanFind.ok, true);
    assert.deepEqual(cleanFind.files, []);
  });
});
