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
  assert.equal(ignored('pr-body-123.md'), true, '仓根手写的 PR 正文草稿不进 git');
  assert.equal(ignored('scripts/repo-hygiene.mjs'), false);
  assert.equal(ignored('.gitignore'), false);
});

test('仓根不许有**已跟踪**的一次性文件（防「git add -A 把草稿卷进去」）', () => {
  // 2026-09-19 实咬：我自己把仓根取数用的 .iss*.json 卷进了 #1502；更早还有 3 个 pr-body-*.md。
  const out = spawnSync('git', ['ls-files', '.iss*.json', 'pr-body-*.md', '_tmp-*'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(out.status, 0);
  const strays = String(out.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(strays, [], `仓根有已跟踪的一次性文件：${strays.join(' ')}`);
});
