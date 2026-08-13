// /dao-remove 的标记半场：找到当前会话的 transcript，把它的路径写进
// ~/.claude/.remove-pending；删除半场归 SessionStart hook（dao-remove-session.js）——
// 会话档在会话进行中删不掉，只能标记、下次开窗时删。
// 不变量：只写 .remove-pending 一个文件，找不到会话号/会话档时必须静默中止（exit 0），
// 绝不能猜一个文件去标——标错 = 删错别人的会话。
const fs = require('fs');
const os = require('os');
const p = require('path');

const cfg = process.env.CLAUDE_CONFIG_DIR || p.join(os.homedir(), '.claude');
const sid = process.env.CLAUDE_CODE_SESSION_ID;
if (!sid) {
  console.log('[dao-remove] 拿不到 CLAUDE_CODE_SESSION_ID，已中止');
  process.exit(0);
}

const projects = p.join(cfg, 'projects');
let transcript = null;
try {
  for (const slug of fs.readdirSync(projects)) {
    const candidate = p.join(projects, slug, sid + '.jsonl');
    if (fs.existsSync(candidate)) { transcript = candidate; break; }
  }
} catch (e) { /* projects 目录读不到 ⇒ 走下面的未找到分支 */ }

if (!transcript) {
  console.log('[dao-remove] 没找到当前会话文件，已中止');
  process.exit(0);
}

fs.writeFileSync(p.join(cfg, '.remove-pending'), transcript);
console.log('[dao-remove] 已标记删除：' + p.basename(transcript) + ' — 现在按 /clear 即丢弃，不可 resume');
