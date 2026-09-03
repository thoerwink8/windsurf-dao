// scripts/lib/plain-words.mjs —— 机器人对人说话的「说人话」闸（用户 2026-09-04 拍板，落地清单第 9 步）。
//
// 判据（docs/decisions/SERVER-LANDING-CHECKLIST.md「说人话判据」）：群里每条消息用户不查文档能看懂；
// 不出现 pid/cwd/timer/路径/命令行/内部代号；修法放「怎么修」行。口诀：这个词用户自己说过吗？没有就换。
//
// 用法：文案生成处 `ensurePlain(text, where)`——有违规只往 stderr 记一行并照发（报警不能因文案被吞），
// 测试里 `plainViolations(text)` 必须为空，把黑话拦在合并前，不是拦在群里。

const RULES = [
  { re: /\bpid\s*=/i, why: '进程号（pid=）' },
  { re: /\bcwd\s*=/i, why: '工作目录字段（cwd=）' },
  { re: /\bcomm\s*=/i, why: '进程名字段（comm=）' },
  { re: /\bhandle\s*=|\bterm_[0-9a-f]{8}/i, why: '终端句柄' },
  { re: /\.(timer|service)\b/, why: 'systemd 单元名' },
  { re: /\bsystemctl\b|\bjournalctl\b|\bjournal\b/i, why: 'systemd 命令/日志' },
  { re: /\benabled\b|\bdisabled\b/i, why: '英文状态词 enabled/disabled' },
  { re: /(^|[\s（(：:])(\/home\/|\/etc\/|\/tmp\/|~\/)/, why: '文件路径' },
  { re: /\bnode\s+scripts\//, why: '命令行' },
  { re: /(^|\s)--[a-z][\w-]*/, why: '命令行参数' },
  { re: /\bHTTP\s*\d{3}\b|\b[45]\d{2}\b(?=\s*(错误|error|$))/i, why: 'HTTP 状态码' },
  { re: /\b(unscanned|escalate|dryRun|dry-run|worktree|orphan)\b/i, why: '内部英文代号' },
  { re: /\b(pool|leg|direct)\s*(红|绿)/i, why: '探针内部分类词（pool/leg/direct）' },
  { re: /\blive agent\b/i, why: '内部英文代号 live agent' },
];

/** 返回 [{why, match}]；空数组 = 说人话。 */
export function plainViolations(text) {
  const s = String(text ?? '');
  const out = [];
  for (const r of RULES) {
    const m = s.match(r.re);
    if (m) out.push({ why: r.why, match: m[0].trim().slice(0, 40) });
  }
  return out;
}

/** 发出前过一道：有违规 stderr 记一行（带出处），文本原样返回——宁可黑话也不能不报警。 */
export function ensurePlain(text, where = '') {
  const v = plainViolations(text);
  if (v.length) {
    console.error(`[说人话] ${where || '?'} 有 ${v.length} 处黑话：${v.map((x) => `${x.why}「${x.match}」`).join('；')}`);
  }
  return text;
}

/** 三行体：出了什么事 / 对你的影响 / 我打算怎么办。空段落自动省略。 */
export function threeLines({ what, impact, plan }) {
  return [what, impact ? `影响：${impact}` : '', plan ? `我打算：${plan}` : ''].filter(Boolean).join('\n');
}
