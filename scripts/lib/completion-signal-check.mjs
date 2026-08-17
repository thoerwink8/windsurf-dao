// 完工信号契约检查（#575 ⑥，dao-check 第 ⑮ 项）。
//
// 病：flow 读 PR comment 首行「完工」，worker-brief 只教 worker_done → 自动起审官从未触发。
// 检查逻辑自己持有契约文本，不 import flow / judgment 的正则（自己查自己查不出错）。
// 两边对不上（比如把 worker-brief 的「完工」改成「已完成」）必须报红。

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FILES = {
  flow: 'scripts/flow.mjs',
  judgment: 'scripts/lib/judgment.mjs',
  brief: 'host/skills/worker-brief/SKILL.md',
  dispatch: 'host/skills/dispatch/SKILL.md',
};

// 检查器自己写的标记，不从被检查对象 import。
const FLOW_MARK = '完工信号：PR comment 首行命中「完工」';
const JUDGMENT_MARK = '/^完工/';
const BRIEF_HEAD = '首行以「完工」开头';
const BRIEF_CMD = 'gh-as.mjs worker -- issue comment';
const BRIEF_EXAMPLE = '完工：PR #';
const DISPATCH_MARK = '交棒发到 **issue comment**';
const DISPATCH_LINE = 'flow.mjs:183';

function readRel(root, rel, override) {
  if (override && Object.prototype.hasOwnProperty.call(override, rel)) return { text: override[rel] };
  const p = join(root, rel);
  if (!existsSync(p)) return { missing: true, path: p };
  try { return { text: readFileSync(p, 'utf8'), path: p }; }
  catch (e) { return { missing: true, path: p, error: String(e.message || e) }; }
}

/**
 * @returns {{green?: string, fail?: [string, string, string]}}
 */
export function checkCompletionSignal({ root, files } = {}) {
  if (!root && !files) return { fail: ['没给仓库根', 'checkCompletionSignal 要 root', ''] };

  const loaded = {};
  for (const [key, rel] of Object.entries(FILES)) {
    const r = readRel(root || '', rel, files);
    if (r.missing) {
      return {
        fail: [
          `完工信号契约文件不在：${rel}`,
          '恢复该文件后再跑；0 个样本 = 本次等于没查',
          r.path || rel,
        ],
      };
    }
    loaded[key] = r.text;
  }

  const problems = [];
  if (!loaded.flow.includes(FLOW_MARK)) {
    problems.push(`flow.mjs 缺契约注释「${FLOW_MARK}」`);
  }
  if (!loaded.judgment.includes(JUDGMENT_MARK)) {
    problems.push(`judgment.mjs 缺首行正则 ${JUDGMENT_MARK}（改成 /^已完成/ 就会让 flow 认不出工人评论）`);
  }
  if (!loaded.brief.includes(BRIEF_HEAD)) {
    problems.push(`worker-brief 没教「${BRIEF_HEAD}」（把「完工」改成「已完成」就会踩这里）`);
  }
  if (!loaded.brief.includes(BRIEF_CMD)) {
    problems.push(`worker-brief 没写发评论命令「${BRIEF_CMD}」`);
  }
  if (!loaded.brief.includes(BRIEF_EXAMPLE)) {
    problems.push(`worker-brief 没给格式例子「${BRIEF_EXAMPLE}」`);
  }
  if (!loaded.dispatch.includes(DISPATCH_MARK) || !loaded.dispatch.includes(DISPATCH_LINE)) {
    problems.push(`dispatch skill 完工信号节没写「${DISPATCH_MARK}」/ ${DISPATCH_LINE}`);
  }

  if (problems.length) {
    return {
      fail: [
        `完工信号契约两边对不上 ${problems.length} 处`,
        'flow 读首行「完工」，worker-brief / dispatch skill 必须教同一句话；改一边必须改另一边',
        problems.slice(0, 4).join('；'),
      ],
    };
  }
  return { green: '完工信号契约：worker-brief 教 issue comment 首行「完工」；flow.mjs:183 仍读 PR（改读 issue 未落地）' };
}
