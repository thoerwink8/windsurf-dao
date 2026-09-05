// #929：审官标准第 8 条「事故修复 PR 必有『机制判定』段」（2026-09-04 拍板）原先只落了两处——
// 审官那边的判红清单 + 指挥官报帅单模板的必填栏——**没落进工人任务书**。
// 工人写 PR 时不知道要写这段，等审官判红了才回来补，每张事故修复单白跑一轮返工。
//
// 这道闸守三件事：
// ① 工人任务书 host/skills/dispatch/templates/soldier-book.md 里确实有这条；
// ② 三处落点（规矩原文 / 工人任务书 / 报帅单模板）说的是**同一件事**——防「各写各的、慢慢漂开」；
// ③ 任务书里引用的「审官标准第 N 条」编号没漂——规矩原文里编号列表第 N 条仍是机制判定那条。
//
// 不死抠字面：不比对整句，只查四个**要件**（栏名 / 问还会不会再犯 / 会→机制改在哪 / 不会→为什么）。
// 措辞怎么改都行，四个要件少一个才红——少了任何一个，这条规矩就不再是可执行的动作。
//
// 判据失效看得出来：读不到文件、要件表为空 ⇒ `unscanned`（没查成）；文件读到了但里面没这条 ⇒ `red`
// （扫完发现缺条）。两种 kind、两句不同的报错，谁都不许静默通过。
// 检查器自持正则，不 import 被检查对象（skill / commander.mjs）的任何解析逻辑——自己查自己查不出错。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const STANDARD = 'host/skills/dispatch/review-standard.md';   // 规矩原文（审官判红清单第 8 条）
const SOLDIER = 'host/skills/dispatch/templates/soldier-book.md'; // 工人任务书（#929 补的就是这里）
const COMMANDER = 'scripts/commander.mjs';                     // 报帅单模板的必填栏

// 一条规矩的四个要件。改措辞不红，少要件才红。
const ELEMENTS = [
  { key: '栏名叫「机制判定」', re: /机制判定/ },
  { key: '问「还会不会再犯」', re: /再犯/ },
  { key: '会 → 机制改在哪', re: /机制[^\n]{0,6}改/ },
  { key: '不会 → 为什么', re: /不会[^\n]{0,8}为什么/ },
];

function read(rel) {
  const p = path.join(REPO, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/**
 * 抽出「机制判定」那一条的正文：命中行 + 它后面的续行。
 * 续行判据：非空、不是新的列表项/标题/围栏、且含中文（.mjs 里那行下面是 `],` 之类，一断即停）。
 * 抽不出来返回 null——上层据此区分「没这条」和「有但缺要件」。
 */
function clauseOf(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes('机制判定'));
  if (i < 0) return null;
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length; j += 1) {
    const l = lines[j];
    if (!l.trim()) break;
    if (/^\s*(#{1,6}\s|\d+[.)]\s|[-*+]\s|>|```)/.test(l)) break;
    if (!/[一-龥]/.test(l)) break;
    out.push(l);
  }
  return out.join('\n');
}

/** 规矩原文里「机制判定」是编号列表的第几条；不是编号列表项就返回 null（＝这道编号闸没查成）。 */
function itemNumberOf(text) {
  let cur = null;
  for (const l of String(text == null ? '' : text).split(/\r?\n/)) {
    const m = /^\s{0,3}(\d+)[.)]\s/.exec(l);
    if (m) cur = Number(m[1]);
    else if (!l.trim()) cur = null;               // 空行断开，续行才跟着上一条
    if (l.includes('机制判定') && cur !== null) return cur;
  }
  return null;
}

/** 三态：unscanned（没查成）/ red（扫完发现缺条或漂开）/ ok。 */
function inspect({ files, elements = ELEMENTS } = {}) {
  if (!files || typeof files !== 'object') return { kind: 'unscanned', fail: '没给 files（没查成）' };
  const rels = Object.keys(files);
  if (rels.length === 0) return { kind: 'unscanned', fail: '一处落点都没扫到（没查成，不是「三处都没问题」）' };
  if (!Array.isArray(elements) || elements.length === 0) {
    return { kind: 'unscanned', fail: '要件表是空的，等于一条都没查（没查成）' };
  }
  const unreadable = rels.filter((r) => files[r] == null);
  if (unreadable.length) return { kind: 'unscanned', fail: `读不到落点：${unreadable.join(' ')}（没查成）` };

  const clauses = {};
  const noClause = [];
  for (const rel of rels) {
    const c = clauseOf(files[rel]);
    if (c) clauses[rel] = c;
    else noClause.push(rel);
  }
  if (noClause.length) {
    return {
      kind: 'red',
      fail: `这些落点里没有「机制判定」这条：${noClause.join(' ')}——规矩只落了一半，缺的那头等着被判红返工`,
      scanned: rels.length,
    };
  }

  const drift = [];
  for (const rel of rels) {
    for (const e of elements) {
      if (!e.re.test(clauses[rel])) drift.push(`${rel} 缺要件「${e.key}」`);
    }
  }
  if (drift.length) {
    return {
      kind: 'red',
      fail: `几处说法漂开了（同一条规矩要件对不齐）：${drift.join('；')}`,
      scanned: rels.length,
    };
  }
  return { kind: 'ok', scanned: rels.length, elements: elements.length };
}

describe('#929 机制判定这条规矩，工人任务书里也得有', () => {
  it('① 夹具：没查成 / 缺条判红 / 漂开判红 / 齐了才绿', () => {
    const FULL = '机制判定：这错在制度生效前还会再犯吗？会 → 机制改在哪；不会 → 为什么。';

    assert.equal(inspect().kind, 'unscanned', '不给 files 必须没查成');
    assert.equal(inspect({ files: {} }).kind, 'unscanned', '一处都没扫到必须没查成');

    const unreadable = inspect({ files: { [SOLDIER]: null, [STANDARD]: FULL } });
    assert.equal(unreadable.kind, 'unscanned', '文件读不到必须没查成  →  ' + JSON.stringify(unreadable));
    assert.match(String(unreadable.fail), /soldier-book/, '没查成也要点名是哪份读不到');

    const noElem = inspect({ files: { [SOLDIER]: FULL }, elements: [] });
    assert.equal(noElem.kind, 'unscanned', '要件表空了必须没查成，不许当绿');

    const missing = inspect({ files: { [SOLDIER]: '这里压根没提这件事。', [STANDARD]: FULL } });
    assert.equal(missing.kind, 'red', '任务书缺这条必须红  →  ' + JSON.stringify(missing));
    assert.match(String(missing.fail), /soldier-book/, '红证据要点名是哪份缺');
    assert.notEqual(missing.kind, 'unscanned', '「扫完发现缺条」和「没查成」必须分得开');

    const drift = inspect({
      files: { [SOLDIER]: '机制判定：这错还会再犯吗？会 → 机制改在哪。', [STANDARD]: FULL },
    });
    assert.equal(drift.kind, 'red', '要件对不齐必须红  →  ' + JSON.stringify(drift));
    assert.match(String(drift.fail), /不会/, '红证据要点名缺的是哪个要件');

    const reworded = inspect({
      files: {
        [SOLDIER]: '交卷前想一下机制判定：这个错还会再犯吗？会的话机制怎么改；不会的话说清为什么。',
        [STANDARD]: FULL,
      },
    });
    assert.equal(reworded.kind, 'ok', '换个说法但要件齐 ⇒ 不许红（这道闸不抠字面）  →  ' + JSON.stringify(reworded));

    const ok = inspect({ files: { [SOLDIER]: FULL, [STANDARD]: FULL } });
    assert.equal(ok.kind, 'ok', '要件齐必须绿  →  ' + JSON.stringify(ok));
    assert.equal(ok.scanned, 2, '扫了几处要报出来，免得「扫了 0 处」被当成绿');
  });

  it('② live：规矩原文 / 工人任务书 / 报帅单模板三处都有，且说的是同一件事', () => {
    const files = {};
    for (const rel of [STANDARD, SOLDIER, COMMANDER]) files[rel] = read(rel);
    const r = inspect({ files });
    assert.equal(r.kind, 'ok', 'live 必须绿  →  ' + JSON.stringify(r));
    assert.equal(r.scanned, 3, '三处落点都要扫到，少一处就是没查成  →  ' + JSON.stringify(r));
  });

  it('③ live：任务书引用的「审官标准第 N 条」编号没漂', () => {
    const soldier = read(SOLDIER);
    const standard = read(STANDARD);
    assert.ok(soldier !== null, `读不到 ${SOLDIER} ⇒ 本条没查成`);
    assert.ok(standard !== null, `读不到 ${STANDARD} ⇒ 本条没查成`);

    const cited = /审官标准第\s*(\d+)\s*条/.exec(soldier);
    assert.ok(cited, `任务书里没写「审官标准第 N 条」⇒ 指针没了或换了写法，这道编号闸没查成（${SOLDIER}）`);

    const real = itemNumberOf(standard);
    assert.ok(real !== null, `${STANDARD} 里「机制判定」不在编号列表项上 ⇒ 编号闸没查成`);

    assert.equal(
      Number(cited[1]), real,
      `任务书写「审官标准第 ${cited[1]} 条」，而原文里机制判定是第 ${real} 条——中间插条把编号顶走了，改任务书里的编号`,
    );
  });
});
