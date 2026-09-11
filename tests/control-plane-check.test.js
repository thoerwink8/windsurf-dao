// 控制面闸生产挂载活检（#1165）。
// 落点从未出现过必须是 skip 不是绿——这正是 #948 把缺口锁成绿的那个洞。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LIB = 'file://' + path.join(REPO, 'scripts', 'lib', 'control-plane-check.mjs').replace(/\\/g, '/');

describe('控制面闸：静态挂载面', () => {
  it('本仓现役路径检查绿', async () => {
    const S = await import(LIB);
    const live = S.checkControlPlaneProduction({ root: REPO });
    assert.equal(!!live.fail, false, JSON.stringify(live));
    assert.match(live.green, /pre-push/);
  });

  it('dao.mjs 热路没挂闸 → 静态检查红（不是绿）', async () => {
    const S = await import(LIB);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-cp-hot-'));
    fs.mkdirSync(path.join(empty, 'scripts', 'githooks'), { recursive: true });
    fs.mkdirSync(path.join(empty, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(empty, 'scripts', 'githooks', 'pre-push'), 'control-plane-pre-push.mjs\n');
    fs.writeFileSync(path.join(empty, 'scripts', 'lib', 'control-plane-pre-push.mjs'), 'decideControlPlane\n');
    fs.writeFileSync(path.join(empty, 'scripts', 'land.mjs'), 'decideControlPlane\n');
    fs.writeFileSync(path.join(empty, 'scripts', 'lib', 'control-plane-write.mjs'), 'control-plane.json\nwriteControlPlaneFile\n');
    fs.writeFileSync(path.join(empty, 'scripts', 'mirasim-ws-probe.mjs'), 'writeControlPlane\ncontrolPlaneDocFromProbe\n');
    fs.writeFileSync(path.join(empty, 'scripts', 'dao.mjs'), 'async function cmdDispatchMirasim(){}\nasync function cmdDispatch(){}\nasync function cmdStartMirasim(){}\nasync function cmdSessionRead(){}\n');
    fs.writeFileSync(path.join(empty, 'scripts', 'lib', 'execution-runtime.mjs'), 'export function ensureGitWorkspace(){}\n');
    fs.writeFileSync(path.join(empty, 'scripts', 'lib', 'executor-binding.mjs'), 'export function createMirasimBinding(){}\n');
    const r = S.checkControlPlaneProduction({ root: empty });
    assert.equal(!!r.green, false);
    assert.match(r.fail.join(' '), /没挂控制面闸|fail-closed|稳定来源/);
  });

  it('零样本（没有 githooks/pre-push）→ 没查成，不是绿', async () => {
    const S = await import(LIB);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-cp-empty-'));
    const r = S.checkControlPlaneProduction({ root: empty });
    assert.equal(!!r.green, false);
    assert.equal(Array.isArray(r.fail), true);
    assert.match(r.fail.join(' '), /不在|没查成/);
  });

  it('落点从未出现过 → skip 不是绿', async () => {
    const S = await import(LIB);
    const r = S.checkControlPlaneDropPoint({
      env: { DAO_CONTROL_PLANE_FILE: path.join(os.tmpdir(), 'dao-cp-never.json') },
      exists: () => false,
    });
    assert.equal(!!r.green, false);
    assert.match(r.skip, /从未出现过|没查成/);
  });

  it('落点在 → 绿', async () => {
    const S = await import(LIB);
    const file = path.join(os.tmpdir(), 'dao-cp-present.json');
    const r = S.checkControlPlaneDropPoint({
      env: { DAO_CONTROL_PLANE_FILE: file },
      exists: (p) => p === file,
    });
    assert.equal(!!r.skip, false);
    assert.match(r.green, /落点在/);
  });
});
