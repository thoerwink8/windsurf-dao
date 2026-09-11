#!/usr/bin/env node
// 换机接线：一条幂等命令（2026-08-31 拍板：不立制度，只留命令；跑几遍都安全）。
//
//   node scripts/onboard.mjs            # 检查 → 能修的修 → 报告
//   node scripts/onboard.mjs --dry-run  # 只看不动
//
// 修什么 / 绝不修什么：
//   global-missing/drift → 备份现文件为 CLAUDE.md.bak-<ts>，再从 docs/global-CLAUDE.md 覆盖
//   skills-missing/dangling/partial/elsewhere → 合并式接回（#1146：仓内逐个链，外来目录保留，不删 mirasim 自有 skill）
//   memory-unlinked/broken  → 只在能找到合法 clone（origin 对得上）且落点无内容时才接；
//                             落点是有内容的普通目录 = 拒绝并指路人工并回
//                             （memory-relink-needs-content-diff 教训：方向判反=静默丢记忆）
//   pi-ext-missing/drift    → 把 host/pi-extensions 里 go-fallback 两个文件重拷到 ~/.pi/agent/extensions
//                             （只在装了 pi 的机器上；本机那份若被手改过，先备份 .bak-<ts>）
//   skills-not-link / creds-missing / mcp-slow-boot / statusline-dangling → 永远只报不修
//
// exit 0 = 修完复查全绿；exit 1 = 还有剩（含 dry-run 查出问题）。

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, symlinkSync, unlinkSync, rmdirSync, readdirSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { checkOnboard, repoRootOfThisFile, ONBOARD_REPORT_ONLY, PI_EXTENSIONS } from './lib/onboard-check.mjs';
import { checkMemoryLink, defaultHome, encodeProjectDir, originUrlFromConfig, repoSlugFromUrl, MEMORY_REPO_SLUG } from './lib/dao-memory-link-check.mjs';
import { healSkillsMount } from './lib/skills-mount.mjs';

const DRY = process.argv.includes('--dry-run');
const root = repoRootOfThisFile();
const home = defaultHome();
const say = (s) => process.stdout.write(s + '\n');
const act = (s, fn) => { if (DRY) { say(`  [拟] ${s}`); return false; } fn(); say(`  [修] ${s}`); return true; };

function fixGlobal() {
  const truth = join(root, 'docs', 'global-CLAUDE.md');
  const live = join(home, '.claude', 'CLAUDE.md');
  act(`同步全局约定 ${live} ← ${truth}`, () => {
    mkdirSync(dirname(live), { recursive: true });
    if (existsSync(live)) copyFileSync(live, `${live}.bak-${Date.now()}`);
    // 逐字拷真相源；行尾不动（真相源什么样就什么样）
    writeFileSync(live, readFileSync(truth));
  });
}

function fixSkills() {
  // #1146：合并式接回。整目录链接（mirasim 劫走）卸掉后建成真目录 + 逐个仓内链；
  // 被劫目标里的外来条目链回新目录，原目录不删。缺链/悬空同样走这一份。
  act(`合并式接回 ~/.claude/skills ← host/skills（外来保留）`, () => {
    const r = healSkillsMount({ root, home, dryRun: false, say: (s) => say('    ' + s) });
    if (r.unscanned) throw new Error(`没查成：${r.reason}`);
    if (!r.ok) throw new Error(r.error || '接回失败');
  });
}

/** memory：只走安全路径，其余情况指路。 */
function fixMemory(id) {
  const linkPath = join(home, '.claude', 'projects', encodeProjectDir(root), 'memory');
  // 找合法 clone：本仓的兄弟目录 <parent>/windsurf-dao-memory，origin 必须对得上
  const candidate = join(dirname(root), 'windsurf-dao-memory');
  const cfg = join(candidate, '.git', 'config');
  let ok = false;
  try { ok = repoSlugFromUrl(originUrlFromConfig(readFileSync(cfg, 'utf8'))) === MEMORY_REPO_SLUG; } catch { /* 不在或读不了 */ }
  if (!ok) {
    say(`  [指路] 没找到合法 memory clone。先：git clone git@github.com:${MEMORY_REPO_SLUG}.git "${candidate}" 再重跑本命令`);
    return;
  }
  let st = null;
  try { st = lstatSync(linkPath); } catch { /* 不在，可以接 */ }
  if (st && !st.isSymbolicLink() && readdirSync(linkPath).length > 0) {
    say(`  [拒绝] ${linkPath} 是有内容的普通目录——自动接会丢本机记忆，先人工逐文件并回 clone 再删目录重跑`);
    return;
  }
  act(`接 memory Junction ${linkPath} → ${candidate}`, () => {
    // 悬空链接和空目录占位要分开清：unlink 删不了目录（EISDIR）。
    // 目录一律走 rmdirSync——它拒绝非空目录，是第 75 行守卫之后的第二道保险。
    if (st) st.isSymbolicLink() ? unlinkSync(linkPath) : rmdirSync(linkPath);
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(candidate, linkPath, 'junction');
  });
}

/** pi 扩展：从仓里重拷（NEW-MACHINE §6b）。手改过的本机副本先备份，仓是真相源。 */
function fixPiExt() {
  const dst = join(home, '.pi', 'agent', 'extensions');
  act(`重拷 pi 扩展 ${dst} ← host/pi-extensions（${PI_EXTENSIONS.join(' ')}）`, () => {
    mkdirSync(dst, { recursive: true });
    for (const f of PI_EXTENSIONS) {
      const live = join(dst, f);
      if (existsSync(live)) copyFileSync(live, `${live}.bak-${Date.now()}`);
      copyFileSync(join(root, 'host', 'pi-extensions', f), live);
    }
  });
}

// ── 主流程：查 → 修 → 复查 ─────────────────────────────────────────
const before = checkOnboard({ root, home });
if (before.unscanned.length) { for (const u of before.unscanned) say(`[链] 没查成：${u}`); process.exit(1); }
if (!before.problems.length) { say('[链] 全绿：三处接线与凭据都在，无事可做'); process.exit(0); }

say(`[链] 查出 ${before.problems.length} 处：`);
for (const p of before.problems) say(`  - ${p.id}: ${p.msg}`);

for (const p of before.problems) {
  if (p.id === 'global-missing' || p.id === 'global-drift') fixGlobal();
  else if (p.id === 'skills-missing' || p.id === 'skills-partial' || p.id === 'skills-dangling' || p.id === 'skills-elsewhere') fixSkills();
  else if (p.id === 'memory-unlinked' || p.id === 'memory-broken') fixMemory(p.id);
  else if (p.id === 'pi-ext-missing' || p.id === 'pi-ext-drift') fixPiExt();
  else say(`  [只报不修] ${p.id}: ${p.msg}`);
}

if (DRY) { say('[链] dry-run 结束，什么都没动'); process.exit(before.problems.length ? 1 : 0); }

const after = checkOnboard({ root, home });
const rest = after.problems.filter(p => !ONBOARD_REPORT_ONLY.has(p.id));

for (const p of after.problems.filter(p => ONBOARD_REPORT_ONLY.has(p.id))) say(`[链] 提醒：${p.msg}`);
if (after.unscanned.length || rest.length) {
  for (const u of after.unscanned) say(`[链] 复查没查成：${u}`);
  for (const p of rest) say(`[链] 复查仍在：${p.id}: ${p.msg}`);
  process.exit(1);
}
say('[链] 复查全绿（只报不修项除外，见上）');
process.exit(0);
