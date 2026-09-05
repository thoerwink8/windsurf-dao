// 用户 2026-08-13 取消了「选项自动驾驶」：AskUserQuestion 的选项里不许出现
// 「照此办不再问 / 本窗同类照此 / 自动驾驶」这类防打扰选项，分配与选型每次都要拍。
// 口头取消过一次没落盘，被会话边界冲掉后 AI 又提了一遍——所以要有东西扫。
//
// 2026-09-05 用户补了反面：只有一个正确答案的事（真相源已存在 / 现成零件已在 / 规矩已拍板）
// 不该摆成选项，直接做。那一面是判断题，机器扫不了；本闸只守机器扫得动的这一面——
// skill 文案里不许把「自动驾驶」写成建议给出的选项。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SKILLS = path.join(REPO, 'host/skills');

// 出现即判红的措辞（都是「让用户一次授权、以后不再问」的形状）
const AUTOPILOT = [
  /照此(办|派)[^\n]{0,12}不再问/,
  /本窗同类照此/,
  /自动驾驶/,
  /不再逐(次|项)(询问|问)/,
  /一次授权[^\n]{0,10}后续不问/,
];

function mdFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) mdFiles(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

describe('不许给用户「自动驾驶」选项', () => {
  it('skill 文案里不出现「照此办不再问」类措辞', () => {
    const files = mdFiles(SKILLS);
    assert.ok(files.length >= 10,
      `只扫到 ${files.length} 个 skill 文档——扫描面可能挪了，这是「没查成」不是「查过没事」`);
    const bad = [];
    for (const f of files) {
      const rel = path.relative(REPO, f).replace(/\\/g, '/');
      const src = fs.readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        // 说明「不许这么做」的句子本身不算违规：带否定词的行放过
        if (/不(许|要|设|得|应)|禁止|别(给|设)|取消/.test(line)) return;
        for (const re of AUTOPILOT) {
          if (re.test(line)) bad.push(`${rel}:${i + 1}  ${line.trim().slice(0, 70)}`);
        }
      });
    }
    assert.deepEqual(bad, [],
      `skill 里出现自动驾驶类选项措辞（用户 2026-08-13 已取消该授权）：\n  ${bad.join('\n  ')}`);
  });

  it('判别力：违规样本必须被这套规则判红，说明句不许误报', () => {
    const violate = '- 选项三：照此派且本窗同类照此办不再问';
    const explain = '- 提案里不要再出现「照此办不再问」这类防打扰选项';
    const hit = (line) => {
      if (/不(许|要|设|得|应)|禁止|别(给|设)|取消/.test(line)) return false;
      return AUTOPILOT.some((re) => re.test(line));
    };
    assert.equal(hit(violate), true, '违规样本必须判红——否则这道检查是摆设');
    assert.equal(hit(explain), false, '「不要出现 X」的说明句不许被误报');
  });
});
