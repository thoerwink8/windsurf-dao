// .gitignore 的判别力闸：这些路径**必须**被 ignore，源文件**不许**被误 ignore。
// 2026-09-19 实咬：根目录 node_modules 没被 ignore，它以「未跟踪文件」躺在共用主树里，
// 谁跑一次 `git add -A` 就会把整棵依赖树卷进提交。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ignored = (p) => spawnSync('git', ['check-ignore', '-q', p], { cwd: ROOT }).status === 0;

test('node_modules 一律被 ignore（根 / 子包 / 任何层）', () => {
  // 目录型模式（`xxx/`）只匹配目录：路径不存在时裸名问不出结果，**必须带尾斜杠**或给子路径。
  assert.equal(ignored('node_modules/'), true, '根目录 node_modules 必须被 ignore');
  assert.equal(ignored('node_modules/.bin/prettier'), true);
  assert.equal(ignored('packages/fleet/node_modules/'), true);
  assert.equal(ignored('host/machine/feishu-triage/node_modules/'), true);
});

test('自动产物被 ignore；源文件不许被误 ignore', () => {
  assert.equal(ignored('.playwright-mcp/'), true);
  assert.equal(ignored('scripts/repo-hygiene.mjs'), false);
  assert.equal(ignored('.gitignore'), false);
});
