// #792 跨宿主 Issue 写入网关：业务契约、禁传身份、幂等、回读作者、fail-closed。
// 不打真 GitHub：runMarshal 全注入。真机验收写在 PR 正文。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'issue-gateway.mjs');
const CLI = path.join(REPO, 'scripts', 'issue-gateway.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));
const CLI_LOAD = import('file://' + CLI.replace(/\\/g, '/'));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'issue-gw-'));
}

function marshalIssue(over = {}) {
  return {
    number: over.number || 42,
    url: over.url || 'https://github.com/thoerwink8/windsurf-dao/issues/42',
    title: over.title || 't',
    state: over.state || 'OPEN',
    author: over.author || { login: 'dao-marshal[bot]', is_bot: true, type: 'Bot' },
    labels: over.labels || [],
    closedBy: over.closedBy,
  };
}

function fakeMarshal({ createAuthor, commentAuthor, view, failWrite, failRead, failJson } = {}) {
  const calls = [];
  return {
    calls,
    runMarshal(args) {
      calls.push(args.slice());
      const verb = args[1];
      if (failWrite && (verb === 'create' || verb === 'comment' || verb === 'close' || verb === 'edit' || verb === 'reopen')) {
        return { ok: false, error: '模拟写入失败' };
      }
      if (verb === 'create') {
        return { ok: true, out: 'https://github.com/thoerwink8/windsurf-dao/issues/42\n' };
      }
      if (verb === 'comment') {
        return { ok: true, out: 'https://github.com/thoerwink8/windsurf-dao/issues/42#issuecomment-9\n' };
      }
      if (verb === 'close' || verb === 'reopen' || verb === 'edit') {
        return { ok: true, out: 'ok\n' };
      }
      if (args[0] === 'api') {
        if (failRead) return { ok: false, error: '模拟回读失败' };
        if (failJson) return { ok: true, out: 'not-json' };
        const author = commentAuthor || { login: 'dao-marshal[bot]', type: 'Bot' };
        return { ok: true, out: JSON.stringify({ user: author, html_url: 'https://github.com/thoerwink8/windsurf-dao/issues/42#issuecomment-9' }) };
      }
      if (verb === 'view') {
        if (failRead) return { ok: false, error: '模拟回读失败' };
        if (failJson) return { ok: true, out: 'not-json' };
        const json = view || marshalIssue({ author: createAuthor });
        return { ok: true, out: JSON.stringify(json) };
      }
      return { ok: false, error: `未预期 ${args.join(' ')}` };
    },
  };
}

function baseCreate(over = {}) {
  return {
    action: 'issue_create',
    repo: 'thoerwink8/windsurf-dao',
    title: '收口身份',
    body: '正文',
    labels: ['任务'],
    host: 'claude',
    idempotency_key: 'k-create-1',
    ...over,
  };
}

describe('issue-gateway 校验', () => {
  it('禁传身份 / token / 任意命令', async () => {
    const G = await LIB_LOAD;
    for (const field of ['identity', 'token', 'role', 'cmd', 'command', 'gh', 'GH_TOKEN']) {
      const r = G.validateRequest({ ...baseCreate(), [field]: 'x' });
      assert.equal(r.ok, false, field);
      assert.equal(r.stage, 'forbidden_field', field);
    }
  });

  it('缺幂等键 / 缺 host / 仓库不合法', async () => {
    const G = await LIB_LOAD;
    const noKey = G.validateRequest(baseCreate({ idempotency_key: '' }));
    assert.equal(noKey.ok, false);
    assert.equal(noKey.stage, 'missing_idempotency');
    const noHost = G.validateRequest(baseCreate({ host: '' }));
    assert.equal(noHost.ok, false);
    assert.match(noHost.error, /host/);
    const badRepo = G.validateRequest(baseCreate({ repo: 'not-a-repo' }));
    assert.equal(badRepo.ok, false);
    assert.match(badRepo.error, /owner\/name/);
    const dots = G.validateRequest(baseCreate({ repo: '../etc/passwd' }));
    assert.equal(dots.ok, false);
  });

  it('允许列表外的仓库拒绝', async () => {
    const G = await LIB_LOAD;
    const fake = fakeMarshal();
    const r = G.applyIssueWrite(baseCreate({ repo: 'evil/x' }), { dir: tmp(), runMarshal: fake.runMarshal });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'allowlist');
  });

  it('#1024：默认允许列表含 bot 已装的仓（ws-cleaner / miraquota-ledger），跨仓完工不许被名单挡回本仓', async () => {
    const G = await LIB_LOAD;
    const listed = G.loadAllowlist();
    assert.equal(listed.ok, true);
    assert.equal(listed.repos.includes('thoerwink8/ws-cleaner'), true);
    assert.equal(listed.repos.includes('thoerwink8/miraquota-ledger'), true);
    assert.equal(listed.repos.includes('thoerwink8/windsurf-dao'), true);
    const fake = fakeMarshal();
    const blocked = G.applyIssueWrite(
      baseCreate({ repo: 'someone/other', idempotency_key: 'k-1024-other' }),
      { dir: tmp(), runMarshal: fake.runMarshal },
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.stage, 'allowlist');
    const passed = G.applyIssueWrite(
      {
        action: 'issue_comment',
        repo: 'thoerwink8/ws-cleaner',
        issue: '12',
        body: '完工：PR #12',
        host: 'worker-done',
        idempotency_key: 'k-1024-ws-comment',
      },
      {
        dir: tmp(),
        runMarshal: (args) => {
          fake.calls.push(args.slice());
          if (args[1] === 'comment') {
            return { ok: true, out: 'https://github.com/thoerwink8/ws-cleaner/issues/12#issuecomment-9\n' };
          }
          if (args[0] === 'api') {
            return { ok: true, out: JSON.stringify({ user: { login: 'dao-marshal[bot]', type: 'Bot' } }) };
          }
          return { ok: false, error: `unexpected ${args.join(' ')}` };
        },
      },
    );
    assert.notEqual(passed.stage, 'allowlist', passed.error);
    assert.equal(passed.ok, true, passed.error);
    const comment = fake.calls.find((a) => a[1] === 'comment');
    assert.equal(comment.includes('--repo'), true);
    assert.equal(comment.includes('thoerwink8/ws-cleaner'), true);
    assert.equal(comment.includes('thoerwink8/windsurf-dao'), false);
  });
});

describe('issue-gateway 写入契约', () => {
  it('create 成功必须回读 marshal 作者，光有 URL 不算成功', async () => {
    const G = await LIB_LOAD;
    const fake = fakeMarshal();
    const r = G.applyIssueWrite(baseCreate(), { dir: tmp(), runMarshal: fake.runMarshal });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.number, 42);
    assert.equal(r.author, 'dao-marshal[bot]');
    assert.equal(r.replay, false);
    assert.match(r.url, /issues\/42/);
    const create = fake.calls.find((a) => a[1] === 'create');
    assert.ok(create.some((t) => String(t).includes('dao-idempotency:k-create-1')));
    const view = fake.calls.find((a) => a[1] === 'view');
    assert.ok(view, '必须回读');
  });

  it('#790 回归：作者是个人账号必须失败', async () => {
    const G = await LIB_LOAD;
    const fake = fakeMarshal({ createAuthor: { login: 'thoerwink8', type: 'User', is_bot: false } });
    const r = G.applyIssueWrite(baseCreate({ idempotency_key: 'k-790' }), { dir: tmp(), runMarshal: fake.runMarshal });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'author_mismatch');
    assert.match(r.error, /thoerwink8/);
    assert.equal(r.url, 'https://github.com/thoerwink8/windsurf-dao/issues/42');
  });

  it('回读失败 / 非 JSON / 写入失败 都 fail-closed，不退个人 gh', async () => {
    const G = await LIB_LOAD;
    const dir = tmp();
    const readFail = G.applyIssueWrite(baseCreate({ idempotency_key: 'k-read' }), {
      dir, runMarshal: fakeMarshal({ failRead: true }).runMarshal,
    });
    assert.equal(readFail.ok, false);
    assert.equal(readFail.stage, 'gh_readback');

    const jsonFail = G.applyIssueWrite(baseCreate({ idempotency_key: 'k-json' }), {
      dir, runMarshal: fakeMarshal({ failJson: true }).runMarshal,
    });
    assert.equal(jsonFail.ok, false);
    assert.equal(jsonFail.stage, 'gh_readback');

    const writeFail = G.applyIssueWrite(baseCreate({ idempotency_key: 'k-write' }), {
      dir, runMarshal: fakeMarshal({ failWrite: true }).runMarshal,
    });
    assert.equal(writeFail.ok, false);
    assert.equal(writeFail.stage, 'gh_write');
  });

  it('凭据缺失 fail-loud，不 spawn 裸 gh', async () => {
    const G = await LIB_LOAD;
    const empty = tmp();
    const r = G.applyIssueWrite(baseCreate({ idempotency_key: 'k-creds' }), { dir: tmp(), appsDir: empty });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'creds_missing');
    assert.match(r.error, /没装|缺凭据/);
  });

  it('同一 idempotency_key 重放 create 不第二次写入', async () => {
    const G = await LIB_LOAD;
    const dir = tmp();
    const fake = fakeMarshal();
    const a = G.applyIssueWrite(baseCreate({ idempotency_key: 'same' }), { dir, runMarshal: fake.runMarshal });
    assert.equal(a.ok, true);
    const writes = fake.calls.filter((c) => c[1] === 'create').length;
    const b = G.applyIssueWrite(baseCreate({ idempotency_key: 'same', title: '另一份' }), { dir, runMarshal: fake.runMarshal });
    assert.equal(b.ok, true);
    assert.equal(b.replay, true);
    assert.equal(b.number, 42);
    assert.equal(fake.calls.filter((c) => c[1] === 'create').length, writes);
  });

  it('comment / edit-labels / close 走同一入口', async () => {
    const G = await LIB_LOAD;
    const dir = tmp();
    const fake = fakeMarshal({
      view: marshalIssue({
        state: 'CLOSED',
        labels: [{ name: '已消歧' }],
        author: { login: 'dao-marshal[bot]', type: 'Bot' },
      }),
    });
    const c = G.issueComment({
      repo: 'thoerwink8/windsurf-dao', issue: 42, body: '追评',
      host: 'codex', idempotency_key: 'c1',
    }, { dir, runMarshal: fake.runMarshal });
    assert.equal(c.ok, true, c.error);
    assert.equal(c.author, 'dao-marshal[bot]');

    const e = G.issueEditLabels({
      repo: 'thoerwink8/windsurf-dao', issue: 42, add: ['已消歧'],
      host: 'pi', idempotency_key: 'e1',
    }, { dir, runMarshal: fake.runMarshal });
    assert.equal(e.ok, true, e.error);
    assert.ok(e.labels.includes('已消歧'));

    const z = G.issueClose({
      repo: 'thoerwink8/windsurf-dao', issue: 42, reason: 'completed',
      host: 'linux', idempotency_key: 'z1',
    }, { dir, runMarshal: fake.runMarshal });
    assert.equal(z.ok, true, z.error);
    assert.equal(z.state, 'CLOSED');
  });

  it('comment 作者不是 bot → 失败', async () => {
    const G = await LIB_LOAD;
    const fake = fakeMarshal({ commentAuthor: { login: 'thoerwink8', type: 'User' } });
    const r = G.issueComment({
      repo: 'thoerwink8/windsurf-dao', issue: 42, body: 'x',
      host: 'claude', idempotency_key: 'c-bad',
    }, { dir: tmp(), runMarshal: fake.runMarshal });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'author_mismatch');
  });

  it('每次调用写审计，能区分宿主 / 动作 / 失败阶段', async () => {
    const G = await LIB_LOAD;
    const dir = tmp();
    const fake = fakeMarshal({ createAuthor: { login: 'thoerwink8', type: 'User' } });
    G.applyIssueWrite(baseCreate({ host: 'mirasim', idempotency_key: 'aud-1' }), { dir, runMarshal: fake.runMarshal });
    const lines = fs.readFileSync(path.join(dir, 'audit', 'audit.ndjson'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.host, 'mirasim');
    assert.equal(rec.action, 'issue_create');
    assert.equal(rec.ok, false);
    assert.equal(rec.stage, 'author_mismatch');
    assert.equal(rec.bot, 'dao-marshal[bot]');
    assert.equal(rec.idempotency_key, 'aud-1');
  });

  it('群消息链接可当幂等键（#792 方向评论）', async () => {
    const G = await LIB_LOAD;
    const key = 'feishu:oc_x:om_root1';
    const body = G.embedIdempotencyMarker('正文', key);
    assert.equal(G.extractIdempotencyMarker(body), key);
  });

  it('close/reopen 回读 {} 缺 state → fail-closed，不是绿', async () => {
    const G = await LIB_LOAD;
    const dir = tmp();
    const fake = fakeMarshal({ view: {} });
    const z = G.issueClose({
      repo: 'thoerwink8/windsurf-dao', issue: 42, reason: 'completed',
      host: 'linux', idempotency_key: 'z-empty',
    }, { dir, runMarshal: fake.runMarshal });
    assert.equal(z.ok, false);
    assert.equal(z.stage, 'gh_readback');
    assert.match(z.error, /没有 state/);

    const o = G.issueReopen({
      repo: 'thoerwink8/windsurf-dao', issue: 42,
      host: 'linux', idempotency_key: 'o-empty',
    }, { dir, runMarshal: fake.runMarshal });
    assert.equal(o.ok, false);
    assert.equal(o.stage, 'gh_readback');
  });

  it('幂等账写失败不得盖回 ok:true', async () => {
    const G = await LIB_LOAD;
    const dir = tmp();
    // 把 idempotency 占成文件：mkdir 失败；audit 目录仍可写，stage 才是幂等账而不是审计。
    fs.writeFileSync(path.join(dir, 'idempotency'), 'not-a-dir');
    const fake = fakeMarshal();
    const r = G.issueCreate(baseCreate({ idempotency_key: 'store-fail' }), {
      dir, runMarshal: fake.runMarshal,
    });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.stage, 'idempotency_store');
    assert.equal(r.landed, true);
    assert.equal(r.number, 42);
    assert.match(r.error, /人工按 URL/);
  });

  it('审计目录不可写 → 不得报告成功', async (t) => {
    // root 无视文件权限位，chmod 0444 拦不住写——这条只能在非 root 下验（CI/orca 是非 root）。
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('root 下权限位失效，本条验不了');
      return;
    }
    const G = await LIB_LOAD;
    const root = tmp();
    const dir = path.join(root, 'gw');
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'audit', 'audit.ndjson'), 'x');
    fs.chmodSync(path.join(dir, 'audit', 'audit.ndjson'), 0o444);
    const fake = fakeMarshal();
    let r;
    try {
      r = G.issueCreate(baseCreate({ idempotency_key: 'aud-ro' }), {
        dir, runMarshal: fake.runMarshal,
      });
    } finally {
      try { fs.chmodSync(path.join(dir, 'audit', 'audit.ndjson'), 0o644); } catch { /* restore */ }
    }
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.stage, 'audit');
    assert.match(r.error, /审计写失败/);
  });
});

describe('issue-gateway CLI', () => {
  it('禁止 --identity / --token 旗标', async () => {
    const C = await CLI_LOAD;
    const r = C.parseGatewayArgv(['create', '--identity', 'marshal', '--repo', 'a/b']);
    assert.equal(r.ok, false);
    assert.match(r.error, /禁止旗标/);
  });

  it('动作映射 create→issue_create', async () => {
    const C = await CLI_LOAD;
    const r = C.parseGatewayArgv([
      'create', '--repo', 'thoerwink8/windsurf-dao', '--title', 't',
      '--host', 'claude', '--idempotency-key', 'k',
    ]);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.request.action, 'issue_create');
    assert.equal(r.request.host, 'claude');
  });
});
