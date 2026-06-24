#!/usr/bin/env node

/**
 * dao-smoke — dao skill ecosystem integrity self-check.
 * Usage: node scripts/dao-smoke.mjs
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DEVIN_SKILLS = join(ROOT, '.devin', 'skills');
const DEVIN_RULES  = join(ROOT, '.devin', 'rules');
const CC_SKILLS    = join(ROOT, 'ccswitch', 'skills');

const PASS = '\x1b[32m✔\x1b[0m';
const FAIL = '\x1b[31m✘\x1b[0m';

let passed = 0;
let failed = 0;
const errors = [];

function ok(msg) { console.log(`  ${PASS} ${msg}`); passed++; }
function fail(msg) { console.log(`  ${FAIL} ${msg}`); failed++; errors.push(msg); }

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      fields[key] = val;
    }
  }
  return fields;
}

async function listDirs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(e => e.name);
}

async function fileExists(path) {
  try { await stat(path); return true; } catch { return false; }
}

// ── 1. Validate .devin/skills/*/SKILL.md frontmatter ────────────────────────

console.log('\n📋 1. .devin/skills — SKILL.md frontmatter');

const devinSkillDirs = await listDirs(DEVIN_SKILLS);
const devinSkillNames = new Set();

for (const dir of devinSkillDirs) {
  const skillFile = join(DEVIN_SKILLS, dir, 'SKILL.md');
  if (!(await fileExists(skillFile))) {
    fail(`${dir}/SKILL.md missing`);
    continue;
  }
  const content = await readFile(skillFile, 'utf8');
  const fm = parseFrontmatter(content);
  if (!fm) {
    fail(`${dir}/SKILL.md — no YAML frontmatter`);
    continue;
  }
  if (!fm.name) {
    fail(`${dir}/SKILL.md — missing "name" in frontmatter`);
    continue;
  }
  if (!fm.description) {
    fail(`${dir}/SKILL.md — missing "description" in frontmatter`);
    continue;
  }
  if (fm.name !== dir) {
    fail(`${dir}/SKILL.md — name "${fm.name}" ≠ directory "${dir}"`);
  } else {
    ok(`${dir}`);
  }
  devinSkillNames.add(fm.name);
}

// ── 2. Validate .devin/rules/*.md structure ─────────────────────────────────

console.log('\n📋 2. .devin/rules — structure');

const VALID_TRIGGERS = new Set(['always_on', 'model_decision', 'glob', 'manual']);
const ruleFiles = (await readdir(DEVIN_RULES)).filter(f => f.endsWith('.md'));

for (const file of ruleFiles) {
  if (file === 'README.md') {
    ok(`${file} (index, skipped)`);
    continue;
  }
  const content = await readFile(join(DEVIN_RULES, file), 'utf8');
  const fm = parseFrontmatter(content);
  if (!fm) {
    fail(`${file} — no YAML frontmatter`);
    continue;
  }
  if (!fm.trigger) {
    fail(`${file} — missing "trigger" in frontmatter`);
    continue;
  }
  if (!VALID_TRIGGERS.has(fm.trigger)) {
    fail(`${file} — invalid trigger "${fm.trigger}" (expected: ${[...VALID_TRIGGERS].join(', ')})`);
    continue;
  }
  ok(`${file} (trigger: ${fm.trigger})`);
}

// ── 3. Broken cross-references between skills ───────────────────────────────

console.log('\n📋 3. Cross-references (skill → skill)');

const refPattern = /(?:派|回|进|→|->|调|拉起|启动|触发|参见|见|转)\s*(dao-[a-z][-a-z0-9]*)/g;
// commands / 外部仓库名等非 skill 的 dao-* 名称，不算交叉引用
const knownNonSkills = new Set(['dao-dev', 'dao-evolve', 'dao-superpowers', 'dao-autopilot', 'dao-hub', 'dao-loop']);

let refTotal = 0;
let refBroken = 0;

for (const dir of devinSkillDirs) {
  const skillFile = join(DEVIN_SKILLS, dir, 'SKILL.md');
  if (!(await fileExists(skillFile))) continue;
  const content = await readFile(skillFile, 'utf8');

  const refs = new Set();
  let m;
  while ((m = refPattern.exec(content)) !== null) {
    const target = m[1];
    if (target !== dir) refs.add(target);
  }
  refPattern.lastIndex = 0;

  for (const target of refs) {
    if (knownNonSkills.has(target)) continue;
    refTotal++;
    if (devinSkillNames.has(target)) {
      ok(`${dir} → ${target}`);
    } else {
      fail(`${dir} → ${target} (target not found)`);
      refBroken++;
    }
  }
}

if (refTotal === 0) {
  console.log('  (no cross-references detected)');
} else if (refBroken === 0) {
  console.log(`  all ${refTotal} cross-references valid`);
}

// ── 4. ccswitch/skills/ mirrors .devin/skills/ ──────────────────────────────

console.log('\n📋 4. ccswitch/skills mirror check');

const ccSkillDirs = new Set(await listDirs(CC_SKILLS));

const KNOWN_CC_EXTRAS = new Set([
  'dao-cli', 'dao-compliance-check', 'dao-loop',
  'dao-meta', 'dao-philosophy', 'dao-project-scaffold',
  'dao-project-structure', 'dao-quality',
  'dao-workflow-system',
]);

const KNOWN_DEVIN_ONLY = new Set([
  'dao-cloud', 'dao-goal',
]);

for (const dir of devinSkillDirs) {
  if (KNOWN_DEVIN_ONLY.has(dir)) {
    ok(`${dir} — devin-only (known exception)`);
    continue;
  }
  if (ccSkillDirs.has(dir)) {
    const ccSkillFile = join(CC_SKILLS, dir, 'SKILL.md');
    if (await fileExists(ccSkillFile)) {
      const content = await readFile(ccSkillFile, 'utf8');
      const fm = parseFrontmatter(content);
      if (fm && fm.name && fm.description) {
        ok(`${dir} — mirrored with valid frontmatter`);
      } else {
        fail(`${dir} — mirrored but SKILL.md frontmatter invalid`);
      }
    } else {
      fail(`${dir} — directory exists in ccswitch but SKILL.md missing`);
    }
  } else {
    fail(`${dir} — missing from ccswitch/skills/`);
  }
}

const devinSkillDirSet = new Set(devinSkillDirs);

for (const dir of ccSkillDirs) {
  if (!devinSkillDirSet.has(dir)) {
    if (KNOWN_CC_EXTRAS.has(dir)) {
      ok(`${dir} — ccswitch-only (rules→skill conversion)`);
    } else {
      fail(`${dir} — in ccswitch but not in .devin/skills/ and not a known extra`);
    }
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(50));
console.log(`  ${PASS} ${passed} passed    ${FAIL} ${failed} failed`);

if (errors.length > 0) {
  console.log('\nFailures:');
  for (const e of errors) console.log(`  ${FAIL} ${e}`);
}

console.log();
process.exit(failed > 0 ? 1 : 0);
