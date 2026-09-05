// 提问工具可移植闸（2026-09-05 实咬）。
//
// 病灶：全局约定写的是「决策点使用 `AskUserQuestion`」——点名了一个具体工具。
// mirasim 用 `-p --output-format stream-json` 无头模式起 claude 时，那个工具要交互式 TUI 才渲染得出来，
// harness 直接把它关掉；我按规矩去调，撞 "No such tool"，降级成纯文字编号选项——
// 用户手机上就收不到推送了，而规矩本身读起来完全没问题。
//
// 这道闸把「规矩不许点名单一提问工具」从「以后记得」变成会报警：
// 真相源 docs/global-CLAUDE.md 里，提问那条必须写成能力 + 解析顺序，且至少列出两个候选工具。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const TRUTH = path.join(REPO, 'docs', 'global-CLAUDE.md');

function decisionLines(text) {
  // 只看「决策点」那一条及其续行（以 - 开头的条目，直到下一个同级条目）。
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^-\s*决策点/.test(l));
  if (start < 0) return null;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^-\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

describe('提问工具可移植闸', () => {
  const text = fs.readFileSync(TRUTH, 'utf8');

  it('真相源里有「决策点」这一条——找不到就是判据失效，不是通过', () => {
    assert.ok(decisionLines(text), `${TRUTH} 里没有以「决策点」开头的条目，本闸判据已失效`);
  });

  it('决策点那条至少列出两个候选提问工具（不许点名单一工具）', () => {
    const block = decisionLines(text);
    const tools = new Set();
    if (/AskUserQuestion/.test(block)) tools.add('AskUserQuestion');
    if (/im_ask_user/.test(block)) tools.add('im_ask_user');
    assert.ok(
      tools.size >= 2,
      `决策点只提到 ${[...tools].join('、') || '零个'} 个提问工具。换个前端它不在，规矩就会把我引到 No such tool——`
      + '要写成「能力 + 解析顺序」，列出至少两个候选。',
    );
  });

  it('要写明「都没有」时怎么办（退纯文字），否则无头前端上这条规矩等于断路', () => {
    const block = decisionLines(text);
    assert.match(block, /纯文字|文字编号|回编号/, '缺兜底路径：都没有弹窗工具时该怎么问，规矩里没写');
  });

  it('判别力反证：把候选删到只剩一个，本闸必须红', () => {
    const block = decisionLines(text);
    const crippled = block.replace(/im_ask_user/g, 'X');
    const tools = ['AskUserQuestion', 'im_ask_user'].filter((t) => new RegExp(t).test(crippled));
    assert.equal(tools.length, 1, '构造样本本身要真的只剩一个候选，否则这条反证没意义');
    // 上一条测试若拿到这个样本就该失败——这里显式断言判据对样本敏感。
    assert.ok(tools.length < 2, '只剩一个候选时应当判红');
  });
});
