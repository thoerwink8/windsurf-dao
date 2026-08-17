// #575 ⑥ 完工信号契约检查：flow 读的首行「完工」与 worker-brief 教的必须是同一句。
// 检查器自己持有标记，不 import flow/judgment 的正则。
// 负控：把 worker-brief 里的「完工」改成「已完成」必须报红。

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const CHECK = path.join(REPO, 'scripts', 'lib', 'completion-signal-check.mjs');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  →  ' + detail : ''}`); }
}

async function main() {
  const { checkCompletionSignal } = await import('file://' + CHECK.replace(/\\/g, '/'));

  const live = checkCompletionSignal({ root: REPO });
  check('本仓契约绿', !!live.green && !live.fail, JSON.stringify(live));

  const empty = checkCompletionSignal({ root: path.join(REPO, 'tests', 'fixtures', 'no-such-root') });
  check('文件不在 → 没查成（不是绿）', !!empty.fail && /不在|没查/.test(empty.fail[0] + empty.fail[1]), JSON.stringify(empty));

  const brief = fs.readFileSync(path.join(REPO, 'host', 'skills', 'worker-brief', 'SKILL.md'), 'utf8');
  const broken = brief.replaceAll('完工', '已完成');
  check('负控样本：worker-brief 里已没有「完工」二字', !broken.includes('完工') && broken.includes('已完成'));
  const mutated = checkCompletionSignal({
    root: REPO,
    files: { 'host/skills/worker-brief/SKILL.md': broken },
  });
  check('把 worker-brief 的「完工」改成「已完成」→ 必须报红',
    !!mutated.fail && /对不上|已完成|完工/.test(mutated.fail.join(' ')),
    JSON.stringify(mutated));

  const flow = fs.readFileSync(path.join(REPO, 'scripts', 'flow.mjs'), 'utf8');
  const flowBroken = flow.replace('完工信号：PR comment 首行命中「完工」', '完工信号：PR comment 首行命中「已完成」');
  const flowMut = checkCompletionSignal({
    root: REPO,
    files: { 'scripts/flow.mjs': flowBroken },
  });
  check('改坏 flow.mjs 契约注释 → 必须报红', !!flowMut.fail, JSON.stringify(flowMut));

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
