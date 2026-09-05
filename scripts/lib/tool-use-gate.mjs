// scripts/lib/tool-use-gate.mjs —— Bash 命令文本上的两条确定性判据。
//
// 改这段代码前必须知道的五条：
//
// 1. 判据早就有了，缺的是触发。memory `heredoc-eats-backslash-escapes` 和
//    `python-stub-use-py` 每轮只注入索引行，具体内容要主动 recall——2026-09-05
//    一轮对话里两条被踩三次，每次都是「我有这条却又踩了」。本模块只负责看命令
//    文本给不给注，怎么触发在 host/skills/tool-use-gate/hooks/。
//
// 2. **永不拦**。命中只注一句，不命中就闭嘴。拦错了会挡住正常工作，而这两条
//    本来就有误报面（不是每个 heredoc 都含转义）。与 ask-gate 同口径。
//
// 3. 机器只看命令文本，不理解意图。heredoc 三条（有 heredoc、目标是 js/ts、
//    文本里有反斜杠转义）全到才注；python 只认命令词是 `python`/`python.exe`，
//    `py` 和 `python3` 不注。
//
// 4. 本文件是纯函数，不碰文件系统、不 spawn。hook 入口才读 stdin。谁要在这
//    里加 spawn，必须带 windowsHide: true（判例 platform-adapter-deleted-while-still-used：
//    每轮闪窗）。
//
// 5. 与同日 ask-gate 同型不同事，不是第二层补丁。那边挂提问工具，这边挂 Bash。

export const BASH_TOOLS = ['Bash'];

export const HEREDOC_NOTE =
  '[工具使用闸] heredoc 写 .mjs/.js/.ts 时，shell 会吞掉 \\n \\s 这类转义（变成真换行/真字符）。改用 Edit 工具，或把内容写成 raw 文件再 splice。';

export const PYTHON_NOTE =
  '[工具使用闸] 本机 `python` 是 WindowsApps stub，exit 49 静默失败，命令「成功」但一个字没写进去。用 `py`（或 `python3`）。';

/** 从 Bash 工具入参取命令文本。字段名不靠猜：command 优先，没有才 cmd。 */
export function bashCommand(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.cmd === 'string') return input.cmd;
  return '';
}

/**
 * 命令文本是否含 heredoc（`<<EOF` / `<<'EOF'` / `<<"EOF"` / `<<-EOF`）。
 * 只认有名字的定界符；`<<` 后面直接是重定向或空，不算。
 */
export function hasHeredoc(command) {
  // 定界符必须全大写或含 EOF/END/HERE 这类惯用名，避免把 `echo a << b` 当 heredoc。
  // 真 heredoc 几乎都是 EOF / END / PY / JS / JSON / FILE。
  return /<<\s*-?\s*(['"]?)(?:EOF|END|HERE|TXT|JSON|JS|TS|PY|XML|HTML|MD|SQL|YAML|YML|[A-Z][A-Z0-9_]*)\1(?:\s|$)/.test(String(command || ''));
}

/** 命令文本是否点到 .mjs / .js / .ts 目标（issue 点名的三种；.cjs 不在范围内）。 */
export function targetsJs(command) {
  return /\.(?:mjs|js|ts)\b/i.test(String(command || ''));
}

/**
 * 命令文本里是否有反斜杠转义（`\n` `\s` `\d` `\[` 之类）。
 * 认的是两个字符「\ + 字母/常用元字符」，不是真换行——真换行是 heredoc 体，不算吞转义。
 */
export function hasBackslashEscape(command) {
  return /\\[nrtwsdWDSB\[\](){}.*+?^$|0]/.test(String(command || ''));
}

export function isHeredocEscape(command) {
  const cmd = String(command || '');
  return hasHeredoc(cmd) && targetsJs(cmd) && hasBackslashEscape(cmd);
}

/**
 * 命令词是不是裸 `python` / `python.exe`。
 * 按管道/列表拆段再看第一词：`py`、`python3`、`python3.12`、`/usr/bin/python3` 都不注；
 * `python -c`、`python.exe`、`/usr/bin/python`、`C:\WindowsApps\python.exe` 要注。
 * `echo python` 这种把 python 当参数的，不注。
 */
export function isPythonStub(command) {
  const parts = String(command || '').split(/(?:&&|\|\||[;|\n])/);
  for (const raw of parts) {
    let tok = String(raw || '').trim();
    if (!tok) continue;
    tok = tok.replace(/^(?:sudo|command|time|env)(?:\s+-[^\s]+)*\s+/, '');
    const cmd0 = (tok.split(/\s+/)[0] || '').replace(/^["']|["']$/g, '');
    const base = cmd0.split(/[/\\]/).pop() || '';
    if (/^python(?:\.exe)?$/i.test(base)) return true;
  }
  return false;
}

/**
 * 纯判定。返回按稳定顺序排列的命中项（heredoc 在前，python 在后）。
 * 空数组 = 不注。调用方不要把空数组和「没查成」混成一种输出。
 */
export function classifyBash(command) {
  const cmd = String(command || '');
  const notes = [];
  if (isHeredocEscape(cmd)) notes.push({ id: 'heredoc-escape', text: HEREDOC_NOTE });
  if (isPythonStub(cmd)) notes.push({ id: 'python-stub', text: PYTHON_NOTE });
  return notes;
}

/** 注入给模型看的那段字。空 notes → 空串（hook 此时应闭嘴，不要吐空 JSON）。 */
export function renderToolUseGate(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return '';
  return notes.map((n) => n.text).join('\n');
}

/** 给用户看的短警告（systemMessage）。跟 additionalContext 同源，只是缩成一行。 */
export function renderWarning(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return '';
  const ids = notes.map((n) => n.id).join('、');
  return `[工具使用闸] 这条 Bash 命中了 ${ids}（不拦，只提醒）`;
}
