// 已删的 DeepSeek 官方直连：现行启动/操作文档不许再写成可照抄的通道。
//
// 起因：PR #1276 第一轮只扫了 URL 和 catalog ID，漏掉
// `docs/model-routing.toml` commandcode.launch_note 里「pi 保持 DeepSeek 官方 API 原通道」。
// 同一行写了「已删 / 不要 / 不得 / dated / 判例」算交代，不算现行指引。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

const EXEMPT_RE = /已删|不要|不得|deleted|retired|historical|dated|不是官方|不能走官方|不要再|not a current|判例|channel retired|渠道已删/;

const PATTERNS = Object.freeze([
  { id: 'deepseek-official-api', re: /DeepSeek\s*官方\s*API/i },
  { id: 'keep-deepseek', re: /保持\s*DeepSeek/ },
  { id: 'official-api-channel', re: /官方\s*API\s*原通道/ },
  { id: 'pi-provider-deepseek', re: /pi\s+--provider\s+deepseek\b/ },
  { id: 'official-direct', re: /官方直连/ },
]);

const MUST_EXIST = Object.freeze(['docs/model-routing.toml', 'NEW-MACHINE.md']);

function scanDroppedDeepseekOps(text) {
  const hits = [];
  const lines = String(text || '').split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (EXEMPT_RE.test(line)) continue;
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      if (p.re.test(line)) {
        hits.push({ line: i + 1, id: p.id, excerpt: line.trim().slice(0, 160) });
        break;
      }
    }
  }
  return hits;
}

function walkMd(dir, prefix, acc) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) walkMd(p, rel, acc);
    else if (name.endsWith('.md') && st.isFile()) acc.push(rel);
  }
  return acc;
}

function listOperationalFiles(root) {
  const rels = [...MUST_EXIST];
  walkMd(path.join(root, 'docs', 'cli-notes'), 'docs/cli-notes', rels);
  walkMd(path.join(root, 'host', 'skills'), 'host/skills', rels);
  return rels;
}

function scanTree(root, files) {
  const hits = [];
  const missing = [];
  const scanned = [];
  for (const rel of files) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) {
      missing.push(rel);
      continue;
    }
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch (e) {
      missing.push(`${rel} (${e.code || e.message})`);
      continue;
    }
    scanned.push(rel);
    for (const hit of scanDroppedDeepseekOps(text)) {
      hits.push({ file: rel, ...hit });
    }
  }
  return { hits, missing, scanned };
}

describe('dropped-deepseek-ops', () => {
  it('审官点名的那句操作性结论必须红', () => {
    const red = scanDroppedDeepseekOps(
      '要在 pi 里用的唯一路是写 provider 插件。**pi 保持 DeepSeek 官方 API 原通道。**'
    );
    assert.equal(red.length, 1);
    assert.equal(red[0].id, 'deepseek-official-api');
  });

  it('同类现行指引也红：照抄启动命令、把官方直连写进优先级', () => {
    const cmd = scanDroppedDeepseekOps('日常：pi --provider deepseek --model deepseek-v4-flash');
    assert.equal(cmd.length, 1);
    assert.equal(cmd[0].id, 'pi-provider-deepseek');

    const rank = scanDroppedDeepseekOps(
      '写码通道优先级 devin > opencode-go > 官方直连（#688）'
    );
    assert.equal(rank.length, 1);
    assert.equal(rank[0].id, 'official-direct');
  });

  it('同一行交代已删/不要/判例则绿；别家官方 API 与「官方 CLI 直连」不误伤', () => {
    assert.equal(scanDroppedDeepseekOps('2026-09-15：官方直连渠道已删，不要再填。').length, 0);
    assert.equal(scanDroppedDeepseekOps('不要 `pi --provider deepseek`。').length, 0);
    assert.equal(scanDroppedDeepseekOps(
      '判例（2026-08-16）：擅自先切官方直连、再换 claude-opus。'
    ).length, 0);
    assert.equal(scanDroppedDeepseekOps('pi 不走已删的 DeepSeek 官方直连。').length, 0);
    assert.equal(scanDroppedDeepseekOps('Anthropic 官方 API').length, 0);
    assert.equal(scanDroppedDeepseekOps('GPT 腿改官方 CLI 直连 relay。').length, 0);
  });

  it('URL/catalog 扫描覆盖不了这句：纯域名检查会漏', () => {
    const prose = '**pi 保持 DeepSeek 官方 API 原通道。**';
    assert.equal(/api\.deepseek\.com/.test(prose), false);
    // 夹具负例：本行正则含已删 catalog id，扫描 A 若纳入 tests 会命中；不是现行指针。
    assert.equal(/deepseek-native-flash/.test(prose), false);
    assert.ok(scanDroppedDeepseekOps(prose).length > 0);
  });

  it('扫描 A：已删 catalog ID 排除测试夹具后 0 处现行指针', () => {
    const r = spawnSync(
      'grep',
      [
        '-RnE',
        'deepseek-native-flash|deepseek-direct-models|deepseek-api|deepseek-prices|deepseek-deepseek-flash|deepseek-deepseek-v4-pro',
        '--include=*.md',
        '--include=*.json',
        '--include=*.mjs',
        '--include=*.js',
        '--include=*.toml',
        '--include=*.yml',
        '--include=*.ts',
        '--exclude-dir=ledger',
        '--exclude-dir=node_modules',
        '--exclude-dir=.git',
        '--exclude-dir=tests',
        // .claude/worktrees/ 下是**别的分支的工作副本**，不是本树现行文档。
        // 2026-09-17 实咬：8 棵残留树里 skills-heal-home 带着 dao-1226 的旧 catalog
        // 文件，扫描 A 把它当现行指针命中 → master 自身红 → 全仓推送被 land 挡住。
        // 扫描面必须只含本树，否则「谁在这台机器上留过树」会变成判据的一部分。
        '--exclude-dir=.claude',
        '.',
      ],
      { cwd: REPO, encoding: 'utf8' },
    );
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.equal(String(r.stdout || '').trim(), '');
  });

  it('现行启动/操作文档 0 条残留；必扫文件缺失 = 没查成', () => {
    const files = listOperationalFiles(REPO);
    assert.ok(files.length >= MUST_EXIST.length, `扫到 ${files.length} 个文件`);

    const live = scanTree(REPO, files);
    assert.equal(live.missing.length, 0, `没查成：${live.missing.join('；')}`);
    assert.ok(live.scanned.includes('docs/model-routing.toml'), 'toml 必须扫到');
    assert.ok(live.scanned.includes('NEW-MACHINE.md'), 'NEW-MACHINE.md 必须扫到');
    assert.equal(
      live.hits.length,
      0,
      live.hits.map((h) => `${h.file}:${h.line} ${h.id} ${h.excerpt}`).join('\n')
    );

    const empty = scanTree(REPO, []);
    assert.equal(empty.scanned.length, 0);
    assert.equal(empty.hits.length, 0);

    const ghost = scanTree(REPO, ['docs/model-routing.toml', 'no-such-ops.md']);
    assert.deepEqual(ghost.missing, ['no-such-ops.md']);
  });
});
