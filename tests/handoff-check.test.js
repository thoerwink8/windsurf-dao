// tests/handoff-check.test.js —— 交卷闸的判别力（issue #904）
//
// 这套测试要证的不是「代码跑得通」，是**判据分得开**：
//   · 每条红判据旁边必须有一条同形状的绿样本——否则它可能是恒红（恒红＝没人看的噪声）。
//   · 每条绿判据旁边必须有一条同形状的红样本——否则它可能是恒绿（恒绿＝假闸，比没闸更糟）。
//   · 「没查成」必须跟「查过没事」在**结果上**分得开，且照样非零退出（fail-closed）。
//
// 分两层：
//   一层 纯判据（scripts/lib/handoff-check.mjs）：拿假事实喂，钉死每个分支。
//   二层 真 git 样本：临时建一个带 origin 的仓，造「切自旧 master」「反向删文件」
//        「指针指向空气」三个坏分支各自被拦下，再造一个干净分支必须放行。
//        二层不联网——origin 是本地目录，fetch 走文件系统。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OK, RED, UNKNOWN,
  judgeBaseFreshness, judgeReverseDeletions, inspectDeletionManifest,
  extractRepoPointers, judgePointers, judgeHandoffBaseline,
  verdictFromItems, COVERAGE_GAPS,
} from '../scripts/lib/handoff-check.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'scripts', 'handoff-check.mjs');

// ---------------------------------------------------------------------------
// 一层：纯判据
// ---------------------------------------------------------------------------

test('① 基底含最新 master', async (t) => {
  await t.test('基线 ref 解不出 → 没查成（不是通）', () => {
    const r = judgeBaseFreshness({ baseRef: 'origin/master', baseResolved: false });
    assert.equal(r.state, UNKNOWN);
  });

  await t.test('merge-base 没跑成 → 没查成', () => {
    const r = judgeBaseFreshness({ baseResolved: true, fetched: true, isAncestor: null });
    assert.equal(r.state, UNKNOWN);
  });

  await t.test('不是祖先 → 红，且报出差了哪几个提交、动了哪些文件', () => {
    const r = judgeBaseFreshness({
      baseResolved: true, fetched: true, isAncestor: false,
      missingCommits: [{ sha: 'a453eb7abc', subject: '卡 F：mirasim 任务书' }],
      missingFiles: ['scripts/lib/mirasim-verbs.mjs', 'tests/mirasim-books.test.js'],
    });
    assert.equal(r.state, RED);
    assert.match(r.detail, /a453eb7/);
    assert.match(r.detail, /mirasim-verbs\.mjs/);
    assert.match(r.detail, /rebase/);
  });

  await t.test('不是祖先的红必须指路「变基」而不是「恢复文件」（#902 那次就是读反了）', () => {
    const r = judgeBaseFreshness({ baseResolved: true, fetched: true, isAncestor: false, missingCommits: [], missingFiles: [] });
    assert.match(r.detail, /不要去「恢复文件」/);
  });

  await t.test('没 fetch 成但已经不是祖先 → 照样红（陈旧缓存只会低估差距）', () => {
    const r = judgeBaseFreshness({ baseResolved: true, fetched: false, fetchError: '断网', isAncestor: false, missingCommits: [], missingFiles: [] });
    assert.equal(r.state, RED);
  });

  await t.test('是祖先但没 fetch 成 → 没查成（判绿只能证明「比我缓存的那个新」）', () => {
    const r = judgeBaseFreshness({ baseResolved: true, fetched: false, fetchError: '断网', isAncestor: true });
    assert.equal(r.state, UNKNOWN);
    assert.match(r.detail, /最新/);
  });

  await t.test('拉到远端且是祖先 → 通', () => {
    assert.equal(judgeBaseFreshness({ baseResolved: true, fetched: true, isAncestor: true }).state, OK);
  });
});

test('② 相对 master 零删除', async (t) => {
  await t.test('删除清单没查成 → 没查成（不当成 0 条）', () => {
    const r = judgeReverseDeletions({ deleted: null, deletedError: 'git diff 退出 128' });
    assert.equal(r.state, UNKNOWN);
    assert.match(r.detail, /128/);
  });

  await t.test('零删除 → 通', () => {
    assert.equal(judgeReverseDeletions({ deleted: [] }).state, OK);
  });

  await t.test('有删除但读不到正文 → 没查成（不许静默放行，也不许诬红）', () => {
    const r = judgeReverseDeletions({ deleted: ['tests/a.test.js'], prBody: null, prBodyError: 'gh 起不来' });
    assert.equal(r.state, UNKNOWN);
    assert.match(r.detail, /gh 起不来/);
  });

  await t.test('有删除、正文没有删除说明 → 红，指路「放回去」', () => {
    const r = judgeReverseDeletions({ deleted: ['tests/a.test.js'], prBody: '## 目标\n随便写点什么' });
    assert.equal(r.state, RED);
    assert.match(r.detail, /放回去/);
    assert.match(r.detail, /git checkout/);
  });

  await t.test('正文有清单标记但漏点名 → 红，且点出漏了哪个（光写「有删除，理由见上」不算数）', () => {
    const r = judgeReverseDeletions({
      deleted: ['tests/a.test.js', 'scripts/b.mjs'],
      prBody: '## 删除清单\n- tests/a.test.js：机制退役',
    });
    assert.equal(r.state, RED);
    assert.deepEqual(r.unlisted, ['scripts/b.mjs']);
  });

  await t.test('正文有清单且逐个点名 → 通（证明它不是恒红）', () => {
    const r = judgeReverseDeletions({
      deleted: ['tests/a.test.js', 'scripts/b.mjs'],
      prBody: '## 删除清单 + 为什么删\n- tests/a.test.js：机制退役\n- scripts/b.mjs：同上',
    });
    assert.equal(r.state, OK);
  });

  await t.test('inspectDeletionManifest：没标记词 → 全部算漏点名', () => {
    const r = inspectDeletionManifest('目标：随便', ['x.md']);
    assert.equal(r.marked, false);
    assert.deepEqual(r.missing, ['x.md']);
  });
});

test('④ 制度指针不指向空气', async (t) => {
  await t.test('抽得出 md 正文里的仓内路径', () => {
    const r = extractRepoPointers([{ file: 'host/skills/dispatch/SKILL.md', text: '正式路径见 `host/skills/dispatch/review-standard.md`。' }]);
    assert.deepEqual(r.map((x) => x.path), ['host/skills/dispatch/review-standard.md']);
  });

  await t.test('.json 不许被切成 .js（拿真历史跑第一次就咬中的假阳性）', () => {
    const r = extractRepoPointers([{ file: 'host/skills/x/plugin.json', text: '把 docs/release-policy.json 的判据注入上下文' }]);
    assert.deepEqual(r.map((x) => x.path), ['docs/release-policy.json']);
  });

  await t.test('tests/ 下不扫——那里的路径是夹具不是指针（实测占假阳性 5/8）', () => {
    const r = extractRepoPointers([{ file: 'tests/patrol.test.js', text: "const r = f(['docs/observations/a.md']);" }]);
    assert.deepEqual(r, []);
  });

  await t.test('单字母主名当占位举例，不当指针（host/skills/x/hooks/y.mjs 这种）', () => {
    const r = extractRepoPointers([{ file: 'scripts/foo.mjs', text: '// 往上四层就是仓根（host/skills/ask-gate/hooks/x.mjs）' }]);
    assert.deepEqual(r, []);
  });

  await t.test('墓志铭句子不算指针（「已删 / 不存在 / 已退役」）', () => {
    const r = extractRepoPointers([{ file: 'docs/a.md', text: 'scripts/flow.mjs 已随 #425 退役，不存在' }]);
    assert.deepEqual(r, []);
  });

  await t.test('通配 / 模板 / 相对跳级一律不猜', () => {
    const r = extractRepoPointers([
      { file: 'docs/a.md', text: 'host/skills/**/SKILL.md 与 scripts/${name}.mjs 与 docs/../x.md' },
    ]);
    assert.deepEqual(r, []);
  });

  await t.test('同一条指针写十遍只报一次', () => {
    const r = extractRepoPointers([
      { file: 'docs/a.md', text: '见 scripts/dao-check.mjs' },
      { file: 'docs/b.md', text: '还是 scripts/dao-check.mjs' },
    ]);
    assert.equal(r.length, 1);
  });

  await t.test('检查器自己的文件不扫（不然它的正则和例子会自伤）', () => {
    const r = extractRepoPointers([{ file: 'scripts/lib/handoff-check.mjs', text: '见 docs/never-exists.md' }]);
    assert.deepEqual(r, []);
  });

  await t.test('diff 没跑成 → 没查成', () => {
    assert.equal(judgePointers({ scanError: 'git diff 退出 128' }).state, UNKNOWN);
  });

  await t.test('一行新增都没扫到 → 没查成（「没扫到样本」≠「没有坏指针」）', () => {
    const r = judgePointers({ addedLineCount: 0, pointers: [], missing: [] });
    assert.equal(r.state, UNKNOWN);
    assert.match(r.detail, /没扫到/);
  });

  await t.test('有指向空气的指针 → 红，点名路径和写它的文件', () => {
    const r = judgePointers({
      addedLineCount: 10, pointers: [{ path: 'scripts/ghost.mjs', file: 'host/skills/dispatch/SKILL.md' }],
      missing: [{ path: 'scripts/ghost.mjs', file: 'host/skills/dispatch/SKILL.md' }],
    });
    assert.equal(r.state, RED);
    assert.match(r.detail, /scripts\/ghost\.mjs/);
    assert.match(r.detail, /SKILL\.md/);
  });

  await t.test('指针都在 → 通（证明它不是恒红）', () => {
    const r = judgePointers({ addedLineCount: 10, pointers: [{ path: 'scripts/dao-check.mjs', file: 'docs/a.md' }], missing: [] });
    assert.equal(r.state, OK);
  });
});

test('⑤ 自证基线＝审官所见', async (t) => {
  await t.test('git status 没跑成 → 没查成', () => {
    assert.equal(judgeHandoffBaseline({ statusError: '退出 128' }).state, UNKNOWN);
  });

  await t.test('有已跟踪文件改了没提交 → 红（自证跑的和审官看的不是同一份）', () => {
    const r = judgeHandoffBaseline({ dirtyTracked: ['scripts/a.mjs'], localHead: 'a'.repeat(40), remoteRef: 'origin/f', remoteHead: 'a'.repeat(40) });
    assert.equal(r.state, RED);
    assert.match(r.detail, /没提交/);
  });

  await t.test('远端没有这条分支 → 红（没推等于没交）', () => {
    const r = judgeHandoffBaseline({ branch: 'f', dirtyTracked: [], localHead: 'a'.repeat(40), remoteRef: 'origin/f', remoteHead: null, remoteError: '远端没有同名分支' });
    assert.equal(r.state, RED);
    assert.match(r.detail, /push/);
  });

  await t.test('本地比远端多提交 → 红', () => {
    const r = judgeHandoffBaseline({ dirtyTracked: [], localHead: 'a'.repeat(40), remoteRef: 'origin/f', remoteHead: 'b'.repeat(40) });
    assert.equal(r.state, RED);
  });

  await t.test('干净且同点 → 通；未跟踪文件只报数不判红', () => {
    const r = judgeHandoffBaseline({ dirtyTracked: [], untrackedCount: 3, localHead: 'a'.repeat(40), remoteRef: 'origin/f', remoteHead: 'a'.repeat(40) });
    assert.equal(r.state, OK);
    assert.match(r.detail, /3 个未跟踪/);
  });
});

test('汇总：红优先于没查成，两者都非零退出', () => {
  assert.equal(verdictFromItems([{ state: OK }, { state: OK }]).exit, 0);
  assert.equal(verdictFromItems([{ state: OK }, { state: UNKNOWN }]).exit, 2);
  assert.equal(verdictFromItems([{ state: RED }, { state: UNKNOWN }]).exit, 1);
});

test('覆盖边界必须跟着结果一起讲出来（跑绿≠契约没问题）', () => {
  assert.ok(COVERAGE_GAPS.length >= 2);
  assert.ok(COVERAGE_GAPS.some((g) => g.includes('字段')));
  assert.ok(COVERAGE_GAPS.some((g) => g.includes('合并顺序')));
});

// ---------------------------------------------------------------------------
// 二层：真 git 样本
// ---------------------------------------------------------------------------

/** 临时仓：origin.git（裸）+ work（克隆）。全在文件系统上，不联网。 */
function buildSampleRepo() {
  const root = mkdtempSync(join(tmpdir(), 'handoff-check-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  // stdio 全 pipe：git push / clone 把进度写 stderr，继承下去会把测试输出淹了。
  const g = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });

  execFileSync('git', ['init', '--bare', '-b', 'master', origin], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  execFileSync('git', ['clone', origin, work], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  g(work, ['config', 'user.email', 'sample@example.invalid']);
  g(work, ['config', 'user.name', 'handoff sample']);
  g(work, ['config', 'commit.gpgsign', 'false']);

  const put = (rel, text) => {
    const abs = join(work, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  };

  // 提交 A：本单分支将要切在这里（「旧 master」）
  put('scripts/real.mjs', '// 老早就有的脚本\n');
  put('docs/base.md', '起点\n');
  g(work, ['add', 'scripts/real.mjs', 'docs/base.md']);
  g(work, ['commit', '-m', 'A: 起点']);
  g(work, ['push', '-u', 'origin', 'master']);
  const shaA = g(work, ['rev-parse', 'HEAD']).trim();

  // 提交 B：别人（平行卡）后来合进 master 的东西
  put('docs/from-other-card.md', '别的卡合进来的成果\n');
  put('scripts/other-card.mjs', '// 别的卡的实现\n');
  g(work, ['add', 'docs/from-other-card.md', 'scripts/other-card.mjs']);
  g(work, ['commit', '-m', 'B: 别的卡合进 master']);
  g(work, ['push', 'origin', 'master']);

  // 坏样本一：切自旧 master（① 该红）
  g(work, ['checkout', '-b', 'stale', shaA]);
  put('docs/mine.md', '我的活\n');
  g(work, ['add', 'docs/mine.md']);
  g(work, ['commit', '-m', '在旧基底上干活']);
  g(work, ['push', '-u', 'origin', 'stale']);

  // 坏样本二：反向删掉 master 已有的文件（② 该红）
  g(work, ['checkout', 'master']);
  g(work, ['checkout', '-b', 'wipe']);
  g(work, ['rm', '-q', 'docs/from-other-card.md', 'scripts/other-card.mjs']);
  put('docs/mine2.md', '我的活\n');
  g(work, ['add', 'docs/mine2.md']);
  g(work, ['commit', '-m', '解冲突时把别人的东西删了']);
  g(work, ['push', '-u', 'origin', 'wipe']);

  // 坏样本三：新写的制度指针指向空气（④ 该红）
  g(work, ['checkout', 'master']);
  g(work, ['checkout', '-b', 'ghostptr']);
  put('docs/rule.md', '正式路径见 `scripts/never-born.mjs`，照它做。\n');
  g(work, ['add', 'docs/rule.md']);
  g(work, ['commit', '-m', '写了一条指向空气的指针']);
  g(work, ['push', '-u', 'origin', 'ghostptr']);

  // 好样本：基底新、零删除、指针都在、已推送（四件全通 ⇒ 证明判据不是恒红）
  g(work, ['checkout', 'master']);
  g(work, ['checkout', '-b', 'clean']);
  put('docs/good.md', '实现见 `scripts/real.mjs` 与 `scripts/other-card.mjs`。\n');
  g(work, ['add', 'docs/good.md']);
  g(work, ['commit', '-m', '干净的一单']);
  g(work, ['push', '-u', 'origin', 'clean']);

  return { root, work, g };
}

/** 在样本仓的某条分支上跑真命令，拿 JSON 结果 + 真退出码。 */
function runCli(work, branch, extraArgs = [], g) {
  g(work, ['checkout', '-q', branch]);
  const r = spawnSync(process.execPath, [CLI, '--repo', work, '--json', ...extraArgs], {
    encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout).trim()); } catch { /* 解析失败下面会断言出来 */ }
  return { exit: r.status, payload, stdout: r.stdout, stderr: r.stderr };
}

const item = (payload, id) => payload.items.find((i) => i.id === id);

test('真 git 样本：三个坏分支各自被拦下，干净分支放行', { timeout: 300000 }, async (t) => {
  let repo;
  try {
    repo = buildSampleRepo();
  } catch (e) {
    // 没有 git 就没法造样本——这是「没查成」，必须显形，不许静默跳过当通过。
    assert.fail(`造不出临时 git 样本仓（没查成，不是通过）：${e && e.message}`);
  }
  const { work, root, g } = repo;

  try {
    await t.test('坏样本一 切自旧 master → ① 红、整体不得交卷', () => {
      const r = runCli(work, 'stale', [], g);
      assert.ok(r.payload, `没拿到 JSON：${r.stdout}${r.stderr}`);
      assert.equal(item(r.payload, '①').state, RED);
      assert.match(item(r.payload, '①').detail, /B: 别的卡合进 master/);
      assert.match(item(r.payload, '①').detail, /from-other-card\.md/);
      // 缺别人的东西 ≠ 自己删了东西：② 必须仍是绿，否则会指挥人去「恢复」别人的文件（#902）
      assert.equal(item(r.payload, '②').state, OK);
      assert.equal(r.exit, 1);
    });

    await t.test('坏样本二 反向删除 → ② 红（正文没有删除说明）', () => {
      const bodyNo = join(root, 'body-no.md');
      writeFileSync(bodyNo, '## 目标\n干我的活\n', 'utf8');
      const r = runCli(work, 'wipe', ['--body-file', bodyNo], g);
      assert.ok(r.payload, `没拿到 JSON：${r.stdout}${r.stderr}`);
      assert.equal(item(r.payload, '②').state, RED);
      assert.match(item(r.payload, '②').detail, /from-other-card\.md/);
      assert.equal(item(r.payload, '①').state, OK); // 基底是新的，只是删了东西
      assert.equal(r.exit, 1);
    });

    await t.test('同一条坏分支，正文逐个点名后 ② 转绿（证明它不是恒红）', () => {
      const bodyYes = join(root, 'body-yes.md');
      writeFileSync(bodyYes, '## 删除清单 + 为什么删\n- docs/from-other-card.md：机制退役\n- scripts/other-card.mjs：同上\n', 'utf8');
      const r = runCli(work, 'wipe', ['--body-file', bodyYes], g);
      assert.equal(item(r.payload, '②').state, OK);
      assert.equal(r.exit, 0);
    });

    await t.test('坏样本三 新写的指针指向空气 → ④ 红', () => {
      const r = runCli(work, 'ghostptr', [], g);
      assert.ok(r.payload, `没拿到 JSON：${r.stdout}${r.stderr}`);
      assert.equal(item(r.payload, '④').state, RED);
      assert.match(item(r.payload, '④').detail, /never-born\.mjs/);
      assert.equal(r.exit, 1);
    });

    await t.test('好样本 四件全通、退出 0（反证判据不是恒红）', () => {
      const r = runCli(work, 'clean', [], g);
      assert.ok(r.payload, `没拿到 JSON：${r.stdout}${r.stderr}`);
      for (const i of r.payload.items) assert.equal(i.state, OK, `${i.id} ${i.name} 应通，实际 ${i.state}：${i.detail}`);
      assert.equal(r.exit, 0);
    });

    await t.test('没查成也不放行：基线 ref 指到不存在的东西 → 退出 2，不是 0', () => {
      const r = runCli(work, 'clean', ['--base', 'origin/no-such-branch'], g);
      assert.ok(r.payload, `没拿到 JSON：${r.stdout}${r.stderr}`);
      assert.equal(item(r.payload, '①').state, UNKNOWN);
      assert.equal(r.exit, 2);
    });

    await t.test('git 命令失败要显形：不是 git 仓 → 退出 2 且说清楚', () => {
      const notRepo = mkdtempSync(join(tmpdir(), 'handoff-not-a-repo-'));
      const r = spawnSync(process.execPath, [CLI, '--repo', notRepo, '--json'], { encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 2);
      assert.match(String(r.stderr), /不是 git 仓/);
      rmSync(notRepo, { recursive: true, force: true, maxRetries: 3 });
    });
  } finally {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* 临时目录，删不掉交给系统 */ }
  }
});
