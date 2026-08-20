// 派工闸门（#546 #517）：拦裸 orca 派工命令。
//
// Claude Code 的命令型 hook：只有 exit 2 拦得住动作；崩溃 / exit 1 / 超时在宿主眼里全是放行。
// 所以本文件任何异常都转成 exit 2（fail-closed）。「崩了」和「判通过」不许同形。
// 用法：hook 读 stdin 的 PreToolUse JSON；测试也可 argv 传入命令。

import { readFileSync } from 'node:fs';

export const GATE_HINT = [
  '派工只走 node scripts/dao.mjs dispatch（用法：node scripts/dao.mjs dispatch --help）。',
  '逃生口：node scripts/dao.mjs raw -- <命令>（会留痕）。',
].join('');

export const HEARTBEAT_HINT = '心跳不准发到 Run（#667）。活性看 git/产物/看门狗，不要 orca orchestration send --type heartbeat。';

export const COORDINATOR_HINT = [
  '人用窗口永不当 coordinator（#667）。',
  '派工走 node scripts/dao.mjs dispatch（经信箱台 --from），不要从帅窗 run-use / run-create。',
].join('');

export function normalizeCmd(cmd) {
  return String(cmd || '').replace(/\s+/g, ' ').trim();
}

export function extractHookCommand(event) {
  if (event == null) return '';
  if (typeof event === 'string') {
    const t = event.trim();
    if (!t) return '';
    if (t.startsWith('{')) {
      try { return extractHookCommand(JSON.parse(t)); }
      catch { return t; }
    }
    return t;
  }
  if (typeof event !== 'object') return '';
  const input = event.tool_input || event.toolInput || event.input || {};
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    if (typeof input.command === 'string') return input.command;
    if (typeof input.cmd === 'string') return input.cmd;
  }
  if (typeof event.command === 'string') return event.command;
  return '';
}

export function commandFromHookInput(stdinText, argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  const dd = args.indexOf('--');
  if (dd >= 0 && args[dd + 1]) return args.slice(dd + 1).join(' ');
  const text = String(stdinText || '').trim();
  if (!text) return '';
  return extractHookCommand(text);
}

/**
 * 把一条 shell 命令拆成「会真跑起来的语句」。
 * 独立实现，不复用 dao.mjs 的 parseArgs（仓规：检查逻辑不得复用被检查对象自己的解析）。
 * 拆点：未加引号的 && || ; | 换行。未加引号的 # 当注释丢掉。
 */
export function splitShellStatements(cmd) {
  const s = String(cmd || '');
  const parts = [];
  let buf = '';
  let quote = null;
  let escaped = false;
  const flush = () => {
    const t = stripUnquotedComment(buf).trim();
    if (t) parts.push(t);
    buf = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { buf += c; escaped = false; continue; }
    if (quote) {
      if (c === '\\' && quote !== "'") { escaped = true; buf += c; continue; }
      if (c === quote) quote = null;
      buf += c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; buf += c; continue; }
    if (c === '\\') { escaped = true; buf += c; continue; }
    if (c === '\n' || c === '\r' || c === ';') { flush(); continue; }
    if (c === '&' && s[i + 1] === '&') { flush(); i++; continue; }
    if (c === '|' && s[i + 1] === '|') { flush(); i++; continue; }
    if (c === '|') { flush(); continue; }
    buf += c;
  }
  flush();
  return parts;
}

function stripUnquotedComment(stmt) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < stmt.length; i++) {
    const c = stmt[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (c === '\\' && quote !== "'") { escaped = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '#') return stmt.slice(0, i);
  }
  return stmt;
}

/** 把一句拆成 token。带引号的整段算一个 token，quoted=true。 */
export function tokenizeShell(stmt) {
  const s = String(stmt || '');
  const tokens = [];
  let buf = '';
  let quote = null;
  let escaped = false;
  let quoted = false;
  const flush = () => {
    if (buf.length || quoted) tokens.push({ value: buf, quoted });
    buf = '';
    quoted = false;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { buf += c; escaped = false; continue; }
    if (quote) {
      if (c === '\\' && quote !== "'") { escaped = true; continue; }
      if (c === quote) { quote = null; continue; }
      buf += c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; quoted = true; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (/\s/.test(c)) { flush(); continue; }
    buf += c;
  }
  flush();
  return tokens;
}

function bareTokens(stmt) {
  return tokenizeShell(stmt)
    .filter(t => !t.quoted && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.value))
    .map(t => t.value);
}

/** 这句真正跑起来的程序是不是 dao.mjs（任意 verb，含 raw）。 */
export function isDaoMjsInvocation(stmt) {
  const toks = bareTokens(stmt);
  return toks.some(t => /(^|[\\/])dao\.mjs$/i.test(t));
}

/** 这句未加引号的 token 序列里有没有 orca orchestration (worker-start|task-create|dispatch)。 */
export function isOrcaDispatchInvocation(stmt) {
  const toks = bareTokens(stmt);
  for (let i = 0; i < toks.length - 2; i++) {
    if (!/(^|[\\/])orca(\.exe|\.cmd)?$/i.test(toks[i])) continue;
    if (toks[i + 1] !== 'orchestration') continue;
    if (/^(worker-start|task-create|dispatch)$/.test(toks[i + 2])) return true;
  }
  return false;
}

/**
 * 裸 orca 派工动作。dao.mjs 自己的 dispatch / raw / worker-start 不拦。
 * #575：放行判据是「这句实际执行的命令是不是 dao.mjs」，不是「整条命令串里有没有这两个词」。
 * `echo "dao.mjs raw" && orca orchestration worker-start` 必须仍被拦。
 */
export function isDispatchBypass(cmd) {
  const statements = splitShellStatements(cmd);
  if (statements.length === 0) return false;
  for (const stmt of statements) {
    if (isDaoMjsInvocation(stmt)) continue;
    if (isOrcaDispatchInvocation(stmt)) return true;
  }
  return false;
}

/** 裸 `orca orchestration send --type heartbeat`。dao.mjs raw 逃生口不拦。 */
export function isHeartbeatSend(stmt) {
  if (isDaoMjsInvocation(stmt)) return false;
  const toks = tokenizeShell(stmt).map((t) => t.value);
  let send = false;
  for (let i = 0; i < toks.length - 2; i++) {
    if (!/(^|[\\/])orca(\.exe|\.cmd)?$/i.test(toks[i])) continue;
    if (toks[i + 1] !== 'orchestration') continue;
    if (toks[i + 2] === 'send') { send = true; break; }
  }
  if (!send) return false;
  for (let i = 0; i < toks.length - 1; i++) {
    if (toks[i] === '--type' && /^heartbeat$/i.test(toks[i + 1])) return true;
  }
  return false;
}

/** 裸 `orca orchestration run-use|run-create`。会把调用窗绑成 coordinator。 */
export function isHumanCoordinatorBind(stmt) {
  if (isDaoMjsInvocation(stmt)) return false;
  const toks = bareTokens(stmt);
  for (let i = 0; i < toks.length - 2; i++) {
    if (!/(^|[\\/])orca(\.exe|\.cmd)?$/i.test(toks[i])) continue;
    if (toks[i + 1] !== 'orchestration') continue;
    if (/^(run-use|run-create)$/.test(toks[i + 2])) return true;
  }
  return false;
}

export function decideGate(cmd) {
  const statements = splitShellStatements(cmd);
  const parts = statements.length ? statements : [String(cmd || '')];
  for (const stmt of parts) {
    if (isHeartbeatSend(stmt)) {
      return {
        block: true,
        command: normalizeCmd(cmd),
        message: `拦下发到 Run 的心跳：${normalizeCmd(cmd)}\n${HEARTBEAT_HINT}`,
      };
    }
    if (isHumanCoordinatorBind(stmt)) {
      return {
        block: true,
        command: normalizeCmd(cmd),
        message: `拦下帅窗抢 coordinator：${normalizeCmd(cmd)}\n${COORDINATOR_HINT}`,
      };
    }
  }
  if (!isDispatchBypass(cmd)) return { block: false, command: normalizeCmd(cmd) };
  return {
    block: true,
    command: normalizeCmd(cmd),
    message: `拦下裸 orca 派工：${normalizeCmd(cmd)}\n${GATE_HINT}`,
  };
}

export function runAsHook({ stdinText = '', argv = [], env = process.env } = {}) {
  try {
    const crash = env && (env.DISPATCH_GATE_CRASH === '1' || env.DISPATCH_GATE_CRASH === 'true');
    if (crash) throw new Error('dispatch-gate 故意崩（DISPATCH_GATE_CRASH）');
    const cmd = commandFromHookInput(stdinText, argv);
    const decision = decideGate(cmd);
    if (decision.block) return { exit: 2, stderr: decision.message, command: decision.command };
    return { exit: 0, stderr: '', command: decision.command };
  } catch (e) {
    return {
      exit: 2,
      stderr: `dispatch-gate 崩了，按拦下处理（fail-closed）：${e && e.message ? e.message : e}`,
    };
  }
}

function readStdinSync() {
  try {
    if (process.stdin.isTTY) return '';
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const invoked = process.argv[1] && /dispatch-gate\.mjs$/.test(String(process.argv[1]).replace(/\\/g, '/'));
if (invoked) {
  const stdinText = readStdinSync();
  const r = runAsHook({ stdinText, argv: process.argv.slice(2), env: process.env });
  if (r.stderr) process.stderr.write(`${r.stderr}\n`);
  process.exit(r.exit);
}
