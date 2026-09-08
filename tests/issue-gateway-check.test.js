// #792：遍历全部宿主配置面的闸。少接一处就红；只断言「某处有」不算。
// 零样本 = 没查成，不是绿。不复用检查器自己的 HOST_SURFACES 来造「绿」。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const CHECK = path.join(REPO, 'scripts', 'lib', 'issue-gateway-check.mjs');
const CHECK_LOAD = import('file://' + CHECK.replace(/\\/g, '/'));

describe('issue-gateway-check 全宿主面', () => {
  it('本仓绿', async () => {
    const { checkIssueGatewayAlive } = await CHECK_LOAD;
    const live = checkIssueGatewayAlive({ root: REPO });
    assert.ok(live.green, JSON.stringify(live));
    assert.equal(live.fail, undefined);
    assert.ok(live.scanned > 0);
  });

  it('一个面都没扫到 → 没查成', async () => {
    const { checkIssueGatewaySurfaces } = await CHECK_LOAD;
    const r = checkIssueGatewaySurfaces({ root: REPO, surfaces: [] });
    assert.ok(r.fail);
    assert.match(r.fail.join(' '), /没扫到|没查/);
  });

  it('少接 soldier-book-mirasim → 红（现役工人第一份书，不是「别处有」就算过）', async () => {
    const { checkIssueGatewaySurfaces, HOST_SURFACES } = await CHECK_LOAD;
    const files = {};
    for (const s of HOST_SURFACES) {
      const p = path.join(REPO, s.rel);
      files[s.rel] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    }
    files['host/skills/dispatch/templates/soldier-book-mirasim.md'] = '# 无网关\n';
    const r = checkIssueGatewaySurfaces({ root: REPO, files });
    assert.ok(r.fail, JSON.stringify(r));
    assert.match(r.fail.join(' '), /soldier-book-mirasim|少接/);
  });

  it('少接 AGENTS.md → 红（不是「别处有」就算过）', async () => {
    const { checkIssueGatewaySurfaces, HOST_SURFACES } = await CHECK_LOAD;
    const files = {};
    for (const s of HOST_SURFACES) {
      const p = path.join(REPO, s.rel);
      files[s.rel] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    }
    files['AGENTS.md'] = '# 无网关\n';
    const r = checkIssueGatewaySurfaces({ root: REPO, files });
    assert.ok(r.fail, JSON.stringify(r));
    assert.match(r.fail.join(' '), /AGENTS|少接/);
  });

  it('少接 .cursor/hooks.json → 红', async () => {
    const { checkIssueGatewaySurfaces } = await CHECK_LOAD;
    const r = checkIssueGatewaySurfaces({
      root: path.join(os.tmpdir(), 'no-such-issue-gw-root'),
      surfaces: [{ id: 'cursor-hooks', rel: '.cursor/hooks.json', kind: 'hook-json', must: 'dispatch-gate' }],
    });
    assert.ok(r.fail);
    assert.match(r.fail.join(' '), /不在|cursor/);
  });

  it('常驻面写回裸 gh issue create → 红', async () => {
    const { checkNoBareGhIssueWrite } = await CHECK_LOAD;
    const r = checkNoBareGhIssueWrite({
      root: REPO,
      files: { 'AGENTS.md': '请跑 gh issue create --title x\n' },
      extraRels: ['AGENTS.md'],
    });
    assert.ok(r.fail);
    assert.match(r.fail.join(' '), /裸 gh issue|create/);
  });

  it('入口文件不在 → 没查成', async () => {
    const { checkIssueGatewayAlive } = await CHECK_LOAD;
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-gw-empty-'));
    const r = checkIssueGatewayAlive({ root: empty });
    assert.ok(r.fail);
    assert.match(r.fail.join(' '), /不在|没查|少接/);
  });

  it('生产脚本绕过网关写 Issue → 红', async () => {
    const { checkNoBareIssueWriteInCode } = await CHECK_LOAD;
    const r = checkNoBareIssueWriteInCode({
      root: REPO,
      extraRels: ['scripts/x.mjs'],
      files: { 'scripts/x.mjs': "runGh(['issue', 'comment', n, '--body', body]);\n" },
      exempt: [],
    });
    assert.ok(r.fail, JSON.stringify(r));
    assert.match(r.fail.join(' '), /绕过|comment/);
  });

  it('生产脚本 0 个文件 → 没查成', async () => {
    const { checkNoBareIssueWriteInCode } = await CHECK_LOAD;
    const r = checkNoBareIssueWriteInCode({ root: REPO, extraRels: [] });
    assert.equal(Boolean(r.fail), true);
    assert.match(r.fail.join(' '), /没扫到|没查/);
  });

  it('自动化单元没卸个人 token → 红', async () => {
    const { checkNoPersonalTokenInUnits } = await CHECK_LOAD;
    const r = checkNoPersonalTokenInUnits({
      root: REPO,
      extraRels: ['host/machine/systemd/dao-refiner.service'],
      files: { 'host/machine/systemd/dao-refiner.service': '[Service]\nUser=orca\nExecStart=/usr/bin/node scripts/refiner.mjs\n' },
    });
    assert.equal(Boolean(r.fail), true, JSON.stringify(r));
    assert.match(r.fail.join(' '), /没卸|GH_TOKEN|GH_CONFIG_DIR/);
  });

  it('自动化单元卸了 token 但仍读 ~/.config/gh → 红', async () => {
    const { checkNoPersonalTokenInUnits } = await CHECK_LOAD;
    const r = checkNoPersonalTokenInUnits({
      root: REPO,
      extraRels: ['host/machine/systemd/dao-refiner.service'],
      files: {
        'host/machine/systemd/dao-refiner.service':
          '[Service]\nUser=orca\nUnsetEnvironment=GH_TOKEN GITHUB_TOKEN\nExecStart=/usr/bin/node scripts/refiner.mjs\n',
      },
    });
    assert.equal(Boolean(r.fail), true, JSON.stringify(r));
    assert.match(r.fail.join(' '), /GH_CONFIG_DIR|没卸/);
  });

  it('写 Issue 的单元卸 token + GH_CONFIG_DIR=/var/empty → 绿', async () => {
    const { checkNoPersonalTokenInUnits } = await CHECK_LOAD;
    const r = checkNoPersonalTokenInUnits({
      root: REPO,
      extraRels: ['host/machine/systemd/dao-refiner.service'],
      files: {
        'host/machine/systemd/dao-refiner.service':
          '[Service]\nUser=orca\nUnsetEnvironment=GH_TOKEN GITHUB_TOKEN\nEnvironment=GH_CONFIG_DIR=/var/empty\nExecStart=/usr/bin/node scripts/refiner.mjs\n',
      },
    });
    assert.equal(Boolean(r.fail), false, JSON.stringify(r));
    assert.match(String(r.green || ''), /1\/1/);
  });

  it('dao-gh-events 设了 GH_CONFIG_DIR=/var/empty → 红（webhook forward 依赖个人 gh 登录）', async () => {
    const { checkNoPersonalTokenInUnits } = await CHECK_LOAD;
    const r = checkNoPersonalTokenInUnits({
      root: REPO,
      extraRels: ['host/machine/systemd/dao-gh-events.service'],
      files: {
        'host/machine/systemd/dao-gh-events.service':
          '[Service]\nUser=orca\nUnsetEnvironment=GH_TOKEN GITHUB_TOKEN\nEnvironment=GH_CONFIG_DIR=/var/empty\nExecStart=/usr/bin/node scripts/gh-event-bridge.mjs\n',
      },
    });
    assert.equal(Boolean(r.fail), true, JSON.stringify(r));
    assert.match(r.fail.join(' '), /GH_CONFIG_DIR|没卸/);
  });

  it('dao-gh-events 只卸 token、不设 GH_CONFIG_DIR → 绿', async () => {
    const { checkNoPersonalTokenInUnits } = await CHECK_LOAD;
    const r = checkNoPersonalTokenInUnits({
      root: REPO,
      extraRels: ['host/machine/systemd/dao-gh-events.service'],
      files: {
        'host/machine/systemd/dao-gh-events.service':
          '[Service]\nUser=orca\nUnsetEnvironment=GH_TOKEN GITHUB_TOKEN\nExecStart=/usr/bin/node scripts/gh-event-bridge.mjs\n',
      },
    });
    assert.equal(Boolean(r.fail), false, JSON.stringify(r));
    assert.match(String(r.green || ''), /1\/1/);
  });

  it('一个 systemd 单元都没扫到 → 没查成', async () => {
    const { checkNoPersonalTokenInUnits } = await CHECK_LOAD;
    const r = checkNoPersonalTokenInUnits({ root: REPO, extraRels: [] });
    assert.equal(Boolean(r.fail), true);
    assert.match(r.fail.join(' '), /没扫到|没查/);
  });
});
