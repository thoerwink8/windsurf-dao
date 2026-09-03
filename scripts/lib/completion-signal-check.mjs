// 完工信号契约检查（#575 ⑥，dao-check 第 ⑯ 项）。
//
// 病：flow 读 PR comment 首行「完工」，工人只发编排层 worker_done → 流转器看不见。
// #575 ⑥ 订正：交棒发 issue comment；#586 工人走 worker-done 发这条 comment（并按需起审官）。
// 检查逻辑自己持有契约文本，不 import flow / review-state 的正则（自己查自己查不出错）。
// 两边对不上（比如把 worker-brief 的「完工」改成「已完成」）必须报红。

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FILES = {
  flow: 'scripts/flow.mjs',
  reviewState: 'scripts/lib/review-state.mjs',
  brief: 'host/skills/dispatch/templates/soldier-book.md',
  dispatch: 'host/skills/dispatch/SKILL.md',
};

// 检查器自己写的标记，不从被检查对象 import。
const FLOW_MARK = '完工信号：issue comment 首行命中「完工」';
const JUDGMENT_MARK = '/^完工/';
const BRIEF_HEAD = '首行以「完工」开头';
const BRIEF_CMD = 'dao.mjs worker-done';
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
  if (!loaded.reviewState.includes(JUDGMENT_MARK)) {
    problems.push(`review-state.mjs 缺首行正则 ${JUDGMENT_MARK}（改成 /^已完成/ 就会认不出工人评论）`);
  }
  if (!loaded.brief.includes(BRIEF_HEAD)) {
    problems.push(`soldier-book 没教「${BRIEF_HEAD}」（把「完工」改成「已完成」就会踩这里）`);
  }
  if (!loaded.brief.includes(BRIEF_CMD)) {
    problems.push(`soldier-book 没写发评论命令「${BRIEF_CMD}」`);
  }
  if (!loaded.brief.includes(BRIEF_EXAMPLE)) {
    problems.push(`soldier-book 没给格式例子「${BRIEF_EXAMPLE}」`);
  }
  if (!loaded.dispatch.includes(DISPATCH_MARK) || !loaded.dispatch.includes(DISPATCH_LINE)) {
    problems.push(`dispatch skill 完工信号节没写「${DISPATCH_MARK}」/ ${DISPATCH_LINE}`);
  }

  if (problems.length) {
    return {
      fail: [
        `完工信号契约两边对不上 ${problems.length} 处`,
        'flow 读首行「完工」，soldier-book / dispatch skill 必须教同一句话；改一边必须改另一边',
        problems.slice(0, 4).join('；'),
      ],
    };
  }
  return { green: '完工信号契约：soldier-book / flow 都读 issue comment 首行「完工」' };
}
