// config-sync 只读盘点：把 skills / MCP 的多来源全扫出来，标重复/冲突/孤儿/悬空链。
// 不改任何下发链，纯诊断。判定符号链接有效性用 readlink 目标存在性，
// 不用 existsSync(链路径)——跨盘符号链接在普通进程下解引用会 EPERM 假性报错。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectRows, tableExists } from './sqlite.mjs';
import { projectRoot, stripBom } from './paths.mjs';

const home = os.homedir();
const claudeSkillsDir = path.join(home, '.claude', 'skills');
const claudeJsonPath = path.join(home, '.claude.json');
// 项目源用 projectRoot 推导，不硬编码本机路径（换机可移植）。
const daoSkillsSrc = path.join(projectRoot, 'ccswitch', 'skills');
const daoMcpDir = path.join(projectRoot, 'ccswitch', 'mcp');

function linkInfo(full) {
  const st = fs.lstatSync(full);
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(full);
    return { kind: 'symlink', target, valid: fs.existsSync(target) };
  }
  if (st.isDirectory()) return { kind: 'realdir' };
  return { kind: 'file' };
}

function inventorySkills() {
  console.log('\n=== Skills 盘点 ===');

  const cc = tableExists('skills') ? selectRows('skills', 'ORDER BY name').map((s) => s.name) : [];
  const daoSrc = safeDirs(daoSkillsSrc);

  const valid = [];
  const dangling = [];
  const realDirs = [];
  if (fs.existsSync(claudeSkillsDir)) {
    for (const it of fs.readdirSync(claudeSkillsDir)) {
      const info = linkInfo(path.join(claudeSkillsDir, it));
      if (info.kind === 'symlink') (info.valid ? valid : dangling).push({ name: it, target: info.target });
      else if (info.kind === 'realdir') realDirs.push(it);
    }
  }

  console.log(`  来源1 cc-switch DB: ${cc.length} 个通用 skill`);
  console.log(`  来源2 windsurf-dao 源: ${daoSrc.length} 个`);
  console.log(`  落点 ~/.claude/skills: 有效链 ${valid.length} | 悬空链 ${dangling.length} | 真实目录 ${realDirs.length}`);

  const daoSet = new Set(daoSrc);
  const dup = cc.filter((n) => daoSet.has(n));
  console.log(`\n  [命名隔离] cc-switch 与 dao 重名: ${dup.length ? dup.join(', ') : '无（好）'}`);

  if (dangling.length) {
    const byParent = {};
    for (const d of dangling) {
      const parent = path.dirname(d.target);
      (byParent[parent] = byParent[parent] || []).push(d.name);
    }
    console.log(`\n  [悬空链] ${dangling.length} 个软链目标已不存在：`);
    for (const parent of Object.keys(byParent)) {
      console.log(`    源 ${parent}（已失效）: ${byParent[parent].length} 个`);
      console.log(`      ${byParent[parent].join(', ')}`);
    }
  } else {
    console.log('\n  [悬空链] 无');
  }

  const realButInSrc = realDirs.filter((n) => daoSet.has(n));
  if (realButInSrc.length) {
    console.log(`\n  [不一致] dao 源里有、~/.claude 却是真实拷贝而非软链: ${realButInSrc.join(', ')}`);
  }

  const srcNotLinked = daoSrc.filter((n) => !valid.some((v) => v.name === n) && !realDirs.includes(n));
  if (srcNotLinked.length) console.log(`\n  [未链] dao 源有但未链到 ~/.claude: ${srcNotLinked.join(', ')}`);

  return { dangling: dangling.length, inconsistent: realButInSrc.length };
}

function safeDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

export { inventorySkills, safeDirs, claudeJsonPath, daoMcpDir };

function readJsonSafe(filePath) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return null;
  }
}

function inventoryMcp() {
  console.log('\n=== MCP 盘点 ===');

  const cc = tableExists('mcp_servers') ? selectRows('mcp_servers', 'ORDER BY name') : [];
  const ccNames = cc.map((m) => m.name);

  const wdNames = fs.existsSync(daoMcpDir)
    ? [...new Set(fs.readdirSync(daoMcpDir).filter((f) => f.endsWith('.cmd')).map((f) => f.replace(/-mcp\.cmd$|\.cmd$/, '')))]
    : [];

  const cj = readJsonSafe(claudeJsonPath);
  const cjNames = cj ? Object.keys(cj.mcpServers || {}) : [];

  console.log(`  来源1 cc-switch DB: ${ccNames.join(', ') || '无'}`);
  const ccClaude = cc.filter((m) => m.enabled_claude).map((m) => m.name);
  const ccCodex = cc.filter((m) => m.enabled_codex).map((m) => m.name);
  console.log(`    启用: claude=[${ccClaude.join(',') || '无'}] codex=[${ccCodex.join(',') || '无'}]`);
  console.log(`  来源2 windsurf-dao/mcp: ${wdNames.join(', ') || '无'}`);
  console.log(`  来源3 ~/.claude.json global: ${cjNames.join(', ') || '无'}`);

  const all = [...new Set([...ccNames, ...wdNames, ...cjNames])].sort();
  let dup = 0;
  let orphan = 0;
  console.log('\n  逐工具来源分布：');
  for (const n of all) {
    const where = [];
    if (ccNames.includes(n)) where.push('cc-switch');
    if (wdNames.includes(n)) where.push('windsurf-dao');
    if (cjNames.includes(n)) where.push('claude.json');
    let tag = '';
    if (where.length > 1) { tag = '  [重复-多处定义]'; dup++; }
    else if (!where.includes('cc-switch')) { tag = '  [孤儿-cc-switch 未纳管]'; orphan++; }
    console.log(`    ${n}: ${where.join(' + ')}${tag}`);
  }

  if (ccClaude.length === 0 && ccNames.length > 0) {
    console.log('\n  [注意] cc-switch 的 MCP 全部未对 claude 启用；Claude 端 MCP 实际来自 claude.json 与 Desktop 注入。');
  }

  return { dup, orphan };
}

function main() {
  console.log('config-sync 来源盘点（只读，不改任何下发链）');
  const s = inventorySkills();
  const m = inventoryMcp();

  console.log('\n=== 小结 ===');
  console.log(`  skills 悬空链: ${s.dangling} | 真实拷贝不一致: ${s.inconsistent}`);
  console.log(`  mcp 多处重复: ${m.dup} | cc-switch 未纳管(孤儿): ${m.orphan}`);
  console.log('\n  本工具只盘点，不修改。如需收敛来源，另行决策。');
}

try {
  main();
} catch (error) {
  console.error(`盘点失败：${error.message}`);
  process.exit(1);
}
