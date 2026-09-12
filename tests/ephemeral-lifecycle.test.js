// tests/ephemeral-lifecycle.test.js —— 短命会话改造的机器可算钉
// 不 import 被检查对象的解析函数；只读源码和文件在不在。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

describe('ephemeral-lifecycle', () => {
  it('推一把生产文件已删，安装脚本只卸载', () => {
    assert.equal(existsSync(join(REPO, 'scripts/nudge-stalled.mjs')), false);
    assert.equal(existsSync(join(REPO, 'scripts/lib/nudge-stalled.mjs')), false);
    assert.equal(existsSync(join(REPO, 'scripts/lib/nudge-skip.mjs')), false);
    assert.equal(existsSync(join(REPO, 'host/machine/systemd/dao-nudge-stalled.timer')), false);
    assert.equal(existsSync(join(REPO, 'host/machine/systemd/dao-nudge-stalled.service')), false);
    const sh = read('scripts/install-nudge-stalled.sh');
    assert.match(sh, /disable --now dao-nudge-stalled\.timer/);
    assert.doesNotMatch(sh, /enable --now dao-nudge-stalled/);
  });

  it('progress-watch 并进指挥官，独立单元已删', () => {
    assert.equal(existsSync(join(REPO, 'host/machine/systemd/dao-progress-watch.timer')), false);
    assert.equal(existsSync(join(REPO, 'host/machine/systemd/dao-progress-watch.service')), false);
    const commander = read('scripts/commander.mjs');
    assert.match(commander, /runProgressWatch\s*\(/);
    assert.match(commander, /^function cmdAct\(/m);
    assert.ok(!/^async function cmdAct\(/m.test(commander));
    const sh = read('scripts/install-progress-watch.sh');
    assert.match(sh, /disable --now dao-progress-watch\.timer/);
    assert.doesNotMatch(sh, /enable --now dao-progress-watch/);
  });

  it('交卷入队并停会话；审官 mirasim 书不许自己合', () => {
    const dao = read('scripts/dao.mjs');
    assert.match(dao, /queued-for-review|enqueueOnly:\s*true/);
    assert.match(dao, /stopSessionsAtCwd/);
    const mira = read('host/skills/dispatch/templates/reviewer-book-mirasim.md');
    assert.doesNotMatch(mira, /pr merge/);
    assert.match(mira, /不许自己合/);
  });

  it('指挥官 / AGENTS / worker-brief 指 mirasim 书', () => {
    const commander = read('scripts/commander.mjs');
    assert.match(commander, /soldier-book-mirasim\.md/);
    assert.doesNotMatch(commander, /闭环框架见 host\/skills\/dispatch\/templates\/soldier-book\.md/);
    const agents = read('AGENTS.md').split('\n')[0];
    assert.match(agents, /soldier-book-mirasim\.md/);
    assert.match(agents, /reviewer-book-mirasim\.md/);
    const brief = read('host/skills/worker-brief/SKILL.md');
    assert.match(brief, /soldier-book-mirasim\.md/);
  });

  it('orca 任务书已删', () => {
    assert.equal(existsSync(join(REPO, 'host/skills/dispatch/templates/soldier-book.md')), false);
    assert.equal(existsSync(join(REPO, 'host/skills/dispatch/templates/reviewer-book.md')), false);
    assert.equal(existsSync(join(REPO, 'host/skills/dispatch/templates/soldier-inject.md')), false);
    assert.equal(existsSync(join(REPO, 'host/skills/dispatch/templates/reviewer-inject.md')), false);
  });

  it('land / close-issues 仍是旁路脚本', () => {
    assert.equal(existsSync(join(REPO, 'scripts/land.mjs')), true);
    assert.equal(existsSync(join(REPO, 'scripts/close-issues.mjs')), true);
  });

  it('会话名单超时宽过 8s，避免指挥官把刮名单超时当成没人', () => {
    assert.match(read('scripts/mirasim-sessions.mjs'), /MIRASIM_LS_TIMEOUT_MS \|\| 30000/);
    assert.match(read('scripts/commander.mjs'), /MIRASIM_LS_TIMEOUT_MS: process\.env\.MIRASIM_LS_TIMEOUT_MS \|\| '30000'/);
    assert.match(read('scripts/commander.mjs'), /timeout:\s*40000/);
  });
});
