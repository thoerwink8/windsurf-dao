// #808：server-ops / feishu-ops 里反引号仓内路径必须真有文件。
// 写了指针就要配会报警的检查（落点被删/未入仓时红，不许指向空气）。
// 检查器自持正则，不 import skill 自己的任何解析。
// 三态：起点缺失 = 没查成；抽到 0 条路径 = 没查成；抽到的路径有不存在的 = 红。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const PATH_RE = /`((?:host|scripts)\/[^`\n]+|NEW-MACHINE\.md)`/g;
const SKILLS = [
  'host/skills/server-ops/SKILL.md',
  'host/skills/feishu-ops/SKILL.md',
];

function extractRepoPointers(text) {
  const found = [];
  const src = String(text || '');
  let m;
  const re = new RegExp(PATH_RE.source, 'g');
  while ((m = re.exec(src))) {
    const p = m[1].replace(/[.,;:]+$/, '').replace(/\/+$/, '');
    if (p) found.push(p);
  }
  return found;
}

function inspectPointers({ files, exists }) {
  if (!files || typeof files !== 'object') {
    return { kind: 'unscanned', fail: '没给 files（没查成）' };
  }
  const rels = Object.keys(files);
  if (rels.length === 0) return { kind: 'unscanned', fail: '一个 skill 都没扫到（没查成）' };
  const missingStart = rels.filter((rel) => files[rel] == null);
  if (missingStart.length) {
    return { kind: 'unscanned', fail: `指针起点缺失：${missingStart.join(' ')}（没查成）` };
  }
  const all = [];
  for (const rel of rels) {
    for (const p of extractRepoPointers(files[rel])) all.push({ from: rel, path: p });
  }
  if (all.length === 0) {
    return { kind: 'unscanned', fail: '反引号仓内路径抽到 0 条（没查成，不是没有指针）' };
  }
  const missing = all.filter((x) => !exists(x.path));
  if (missing.length) {
    return {
      kind: 'red',
      fail: `指向空气 ${missing.length} 条：${missing.map((x) => `${x.from} → ${x.path}`).join(' ')}`,
      scanned: all.length,
    };
  }
  return { kind: 'ok', scanned: all.length };
}

describe('ops-skill-pointers', () => {
  it('#808 夹具：没查成 / 空气指针红 / 齐则绿', () => {
    const empty = inspectPointers({ files: {}, exists: () => true });
    assert.equal(empty.kind, 'unscanned', '空 files 必须没查成  →  ' + JSON.stringify(empty));

    const dangling = inspectPointers({
      files: { 'host/skills/feishu-ops/SKILL.md': '看 `host/machine/no-such-file.json`。' },
      exists: () => false,
    });
    assert.equal(dangling.kind, 'red', '空气指针必须红  →  ' + JSON.stringify(dangling));
    assert.match(String(dangling.fail), /no-such-file/, '红证据要点名落点');

    const zero = inspectPointers({
      files: { 'host/skills/feishu-ops/SKILL.md': '没有仓内反引号路径。' },
      exists: () => true,
    });
    assert.equal(zero.kind, 'unscanned', '抽到 0 条必须没查成  →  ' + JSON.stringify(zero));

    const ok = inspectPointers({
      files: { 'host/skills/server-ops/SKILL.md': '装法见 `NEW-MACHINE.md` 与 `host/machine/systemd/orca-serve.service`。' },
      exists: (p) => p === 'NEW-MACHINE.md' || p === 'host/machine/systemd/orca-serve.service',
    });
    assert.equal(ok.kind, 'ok', '落点齐必须绿  →  ' + JSON.stringify(ok));
  });

  it('#808 live：两份 ops skill 的仓内指针都在，且各 ≤ 120 行', () => {
    const files = {};
    for (const rel of SKILLS) {
      const p = path.join(REPO, rel);
      files[rel] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    }
    const r = inspectPointers({
      files,
      exists: (rel) => fs.existsSync(path.join(REPO, rel)),
    });
    assert.equal(r.kind, 'ok', 'live 指针必须齐  →  ' + JSON.stringify(r));

    for (const rel of SKILLS) {
      const n = files[rel].split(/\r?\n/).length;
      assert.ok(n <= 120, `${rel} 行数 ${n} > 120`);
    }

    assert.equal(
      fs.existsSync(path.join(REPO, 'host/skills/webview-debug')),
      false,
      'webview-debug 必须已删',
    );
  });
});
