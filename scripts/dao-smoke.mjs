#!/usr/bin/env node

/**
 * dao-smoke — dao skill ecosystem integrity self-check.
 * Validates ccswitch/skills/ frontmatter and cross-references.
 * Usage: node scripts/dao-smoke.mjs
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CC_SKILLS = join(ROOT, 'ccswitch', 'skills');

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

// ── 1. Validate ccswitch/skills/*/SKILL.md frontmatter ─────────────────────

console.log('\n📋 1. ccswitch/skills — SKILL.md frontmatter');

const ccSkillDirs = await listDirs(CC_SKILLS);
const ccSkillNames = new Set();

for (const dir of ccSkillDirs) {
  const skillFile = join(CC_SKILLS, dir, 'SKILL.md');
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
  ccSkillNames.add(fm.name);
}

// ── 2. Broken cross-references between skills ──────────────────────────────

console.log('\n📋 2. Cross-references (skill → skill)');

const refPattern = /(?:派|回|进|→|->|调|拉起|启动|触发|参见|见|转)\s*(dao-[a-z][-a-z0-9]*)/g;
// command / workflow 之类「不是 skill 的 dao-* 名字」，被 skill 正文引用时不算断链。
// 2026-07-27：`dao-evolve` 退役并从各处引用面移除，同批移出本表——留着等于给一个已死的
// 名字继续开豁免口子（往后谁再写「见 dao-evolve」将被本检查报为断链，那正是想要的）。
const knownNonSkills = new Set(['dao-dev', 'dao-superpowers', 'dao-hub', 'dao-loop', 'dao-distill', 'dao-harvest']);

let refTotal = 0;
let refBroken = 0;

for (const dir of ccSkillDirs) {
  const skillFile = join(CC_SKILLS, dir, 'SKILL.md');
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
    if (ccSkillNames.has(target)) {
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

// ── Summary ────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(50));
console.log(`  ${PASS} ${passed} passed    ${FAIL} ${failed} failed`);

if (errors.length > 0) {
  console.log('\nFailures:');
  for (const e of errors) console.log(`  ${FAIL} ${e}`);
}

console.log();
process.exit(failed > 0 ? 1 : 0);
