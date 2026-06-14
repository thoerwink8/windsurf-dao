#!/usr/bin/env node
// remove-mark.js — invoked by the /remove command.
// Marks the CURRENT Claude Code session for deletion: records its transcript file path
// into <config>/.remove-pending. The actual delete happens on the next SessionStart
// (see remove-session.js) because a live transcript would just be rewritten if deleted now.
const fs = require('fs');
const os = require('os');
const path = require('path');

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const sid = process.env.CLAUDE_CODE_SESSION_ID;

if (!sid) {
  console.log('[remove] 拿不到 CLAUDE_CODE_SESSION_ID，无法定位当前会话；中止，未标记。');
  process.exit(0);
}

// Locate <sid>.jsonl under ~/.claude/projects/<slug>/ (search all project dirs; the id is unique)
const projectsDir = path.join(configDir, 'projects');
let target = null;
try {
  for (const sub of fs.readdirSync(projectsDir)) {
    const candidate = path.join(projectsDir, sub, sid + '.jsonl');
    if (fs.existsSync(candidate)) { target = candidate; break; }
  }
} catch (e) { /* projects dir missing */ }

if (!target) {
  console.log(`[remove] 没找到当前会话的记录文件（${sid}.jsonl），可能尚未落盘；中止。`);
  process.exit(0);
}

const marker = path.join(configDir, '.remove-pending');
try {
  fs.writeFileSync(marker, target, 'utf8');
  console.log(`[remove] 已标记删除当前会话：${path.basename(target)}`);
  console.log('[remove] 现在按 /clear 开新会话，切换瞬间这条会话会被删除、不可 /resume。');
} catch (e) {
  console.log(`[remove] 写标记失败：${e.message}`);
}
