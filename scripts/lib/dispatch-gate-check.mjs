// 派工闸门活检（dao-check 第 ⑬ 项，#546 #517 #553 #707）。
//
// 闸门有两个挂载面，缺一即红：
//   A. 随仓 `.claude/settings.json` 的 PreToolUse（#553：clone 即生效、cc-switch 碰不到）；
//   B. 随仓 `.cursor/hooks.json` 的 beforeShellExecution（#707：Cursor 帅位挂载面）。
// 自己 JSON.parse 两个配置文件并自己遍历命令，不复用闸门自己的解析——自己查自己查不出错。
// 判据三层，缺一即红：
//   ① 装载：配置里至少有一条指向 dispatch-gate 脚本的命令（独立标记，见 GATE_MARK）。
//   ② 指向：从命令里抽出的脚本路径在仓里真存在（注册指向空气 = 红）。
//   ③ 行为：把声明的脚本当真进程跑——旁路应拦、普通 orca 应放行、崩了也应拦。
//      宿主协议不同：Claude 形入口（dispatch-gate-hook.mjs）exit 2 拦、stderr 给提示；
//      Cursor 形入口（cursor-dispatch-gate-hook.mjs）exit 恒 0、stdout JSON permission
//      拦/放（#707 实测：Cursor Windows 用 PowerShell 包装跑钩子，子进程退出码被吞成 0，
//      exit 2 语义到不了宿主，所以 Cursor 面必须走 JSON 协议）。
// 零样本（配置文件不在 / JSON 坏了 / 一个派工闸都没扫到）单独报红，不许记成绿。

import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

// 检查器自己的标记：命令里带 dispatch-gate 字样的脚本路径算「派工闸」。
// 不以闸门自己的解析逻辑为准。
const GATE_MARK = /dispatch-gate/i;

function readJson(file) {
  if (!existsSync(file)) return { exists: false };
  try {
    return { exists: true, doc: JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) };
  } catch (e) {
    return { exists: true, broken: String(e.message).slice(0, 80) };
  }
}

/** 从 settings.json 的 hooks 结构里抽出全部 PreToolUse command（检查器自己的遍历）。 */
function preToolUseCommands(doc) {
  const entries = doc?.hooks?.PreToolUse;
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const g of entries) {
    for (const h of (g?.hooks || [])) {
      if (h?.type === 'command' && typeof h.command === 'string') out.push(h.command);
    }
  }
  return out;
}

/** 从 .cursor/hooks.json 抽 beforeShellExecution 条目（含 failClosed 标记，检查器自己的遍历）。 */
function beforeShellExecutionEntries(doc) {
  const entries = doc?.hooks?.beforeShellExecution;
  if (!Array.isArray(entries)) return [];
  return entries.filter(h => h && typeof h === 'object' && h.type === 'command' && typeof h.command === 'string');
}

/** 从一条 hook 命令里抽出脚本路径，并相对仓库根解析。返回 '' 表示抽不出。 */
function resolveScript(command, root) {
  const m = String(command || '').match(/["']?((?:[^"'\s]|\\ )*dispatch-gate[^"'\s]*\.mjs)["']?/);
  if (!m) return '';
  let p = m[1].replace(/^["']|["']$/g, '').trim();
  // 展开宿主注入的项目根变量；检查器只验路径存在性，不模拟宿主展开
  p = p.replace(/^\$\{?CLAUDE_PROJECT_DIR\}?[\\/]?/, '');
  if (!p) return '';
  return isAbsolute(p) ? p : join(root, p);
}

function payload(command) {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  });
}

// Cursor beforeShellExecution 的 stdin 形（#707 实测：command 在顶层）。
function cursorPayload(command) {
  return JSON.stringify({
    conversation_id: 'c1',
    generation_id: 'g1',
    command,
    cwd: '',
    hook_event_name: 'beforeShellExecution',
    workspace_roots: ['C:/repo'],
  });
}

function runScript(script, { command, envExtra = {}, cursor = false } = {}) {
  return spawnSync(process.execPath, [script], { windowsHide: true,
    encoding: 'utf8',
    input: cursor ? cursorPayload(command) : payload(command),
    timeout: 15000,
    env: { ...process.env, ...envExtra },
  });
}

/** 从 Cursor 面钩子 stdout 抽响应 JSON。 */
function cursorResponse(r) {
  try { return JSON.parse(String(r.stdout || '').trim()); } catch { return null; }
}

/**
 * Claude 面（.claude/settings.json PreToolUse）。
 * @returns {{green?: string, fail?: [string, string, string]}}
 */
function checkClaudeMount(root) {
  const settingsFile = join(root, '.claude', 'settings.json');
  const r = readJson(settingsFile);
  if (!r.exists) {
    return {
      fail: [
        '随仓 .claude/settings.json 不在',
        '派工闸挂在这里（#553）：恢复文件；0 个装载面 = 本次等于没查',
        settingsFile,
      ],
    };
  }
  if (r.broken) {
    return {
      fail: [
        '随仓 .claude/settings.json 解析不了',
        '修 JSON；解析不了 = 本次等于没查',
        r.broken,
      ],
    };
  }
  const gateCommands = preToolUseCommands(r.doc).filter(c => GATE_MARK.test(c));
  if (gateCommands.length === 0) {
    return {
      fail: [
        '一个 PreToolUse 派工闸都没扫到',
        `settings.json 的 PreToolUse 里要有指向 dispatch-gate 脚本的 command（标记 ${GATE_MARK}）；0 个 = 本次等于没查`,
        settingsFile,
      ],
    };
  }

  const problems = [];
  let scanned = 0;
  for (const command of gateCommands) {
    const script = resolveScript(command, root);
    if (!script || !existsSync(script)) {
      problems.push(`PreToolUse 指向的脚本不存在：${command}`);
      continue;
    }
    scanned++;

    const blocked = runScript(script, { command: 'orca orchestration worker-start --task t --worktree w' });
    if (blocked.status !== 2) {
      problems.push(`旁路 worker-start 应 exit 2，实际 ${blocked.status} ${String(blocked.stderr || blocked.stdout || '').slice(0, 80)}`);
    } else if (!/dao\.mjs dispatch/.test(`${blocked.stderr || ''}${blocked.stdout || ''}`)) {
      problems.push(`拦住了但没指出 dao.mjs dispatch：${command}`);
    }

    const taskCreate = runScript(script, { command: 'orca orchestration task-create --spec x' });
    if (taskCreate.status !== 2) {
      problems.push(`旁路 task-create 应 exit 2，实际 ${taskCreate.status}`);
    }

    const allowed = runScript(script, { command: 'orca orchestration inbox --json' });
    if (allowed.status !== 0) {
      problems.push(`普通 orca inbox 应放行，实际 ${allowed.status} ${String(allowed.stderr || '').slice(0, 80)}`);
    }

    const heartbeat = runScript(script, { command: 'orca orchestration send --type heartbeat --subject alive' });
    if (heartbeat.status !== 2) {
      problems.push(`心跳发到 Run 应 exit 2，实际 ${heartbeat.status}`);
    } else if (!/心跳不准发/.test(`${heartbeat.stderr || ''}${heartbeat.stdout || ''}`)) {
      problems.push('拦住心跳但没写「心跳不准发」');
    }

    const runUse = runScript(script, { command: 'orca orchestration run-use --id run_x' });
    if (runUse.status !== 2) {
      problems.push(`裸 run-use 应 exit 2，实际 ${runUse.status}`);
    }

    const raw = runScript(script, { command: 'node scripts/dao.mjs raw -- orca orchestration worker-start --task t' });
    if (raw.status !== 0) {
      problems.push(`逃生口 raw 应放行，实际 ${raw.status}`);
    }

    // #575 ③：放行判据是「实际执行的命令」，不是整串关键词。故意把 dao.mjs raw
    // 写进 echo 字符串再裸跑 worker-start——旧闸会放行，新闸必须仍 exit 2。
    const decoy = runScript(script, {
      command: 'echo "dao.mjs raw" && orca orchestration worker-start --task t --worktree w',
    });
    if (decoy.status !== 2) {
      problems.push(`echo "dao.mjs raw" && worker-start 应仍被拦（exit 2），实际 ${decoy.status}——关键词匹配过宽`);
    }

    const crashed = runScript(script, {
      command: 'orca orchestration send --type heartbeat',
      envExtra: { DISPATCH_GATE_CRASH: '1' },
    });
    if (crashed.status !== 2) {
      problems.push(`崩了应 exit 2（fail-closed），实际 ${crashed.status} —— 崩了等于放行`);
    } else if (!/fail-closed|崩/.test(`${crashed.stderr || ''}${crashed.stdout || ''}`)) {
      problems.push(`崩了 exit 2 但没报出来`);
    }
  }

  if (scanned === 0) {
    return {
      fail: [
        '声明了 PreToolUse 派工闸但一个脚本都没跑成',
        'settings.json 在、脚本没了 ⇒ 注册指向空气',
        gateCommands.join(' | '),
      ],
    };
  }
  if (problems.length) {
    return {
      fail: [
        `派工闸跑不出正确拦截 ${problems.length} 处`,
        '旁路/心跳/帅窗 run-use 必须 exit 2、inbox 必须放行、崩了必须 exit 2：手跑 node scripts/lib/dispatch-gate-hook.mjs',
        problems.slice(0, 6).join('；'),
      ],
    };
  }
  return { green: `Claude 面派工闸 ${scanned} 个已挂载且真拦得住（旁路 exit 2 / 逃生口放行 / 崩了 exit 2）` };
}

/**
 * Cursor 面（.cursor/hooks.json beforeShellExecution，#707）。
 * 协议与 Claude 面不同：永远 exit 0，拦/放看 stdout JSON 的 permission。
 * 另查条目级 failClosed:true（Windows 包装吞退出码，超时/崩溃靠它兜底）。
 * @returns {{green?: string, fail?: [string, string, string]}}
 */
function checkCursorMount(root) {
  const hooksFile = join(root, '.cursor', 'hooks.json');
  const r = readJson(hooksFile);
  if (!r.exists) {
    return {
      fail: [
        '随仓 .cursor/hooks.json 不在',
        'Cursor 帅位派工闸挂在这里（#707）：恢复文件；0 个装载面 = 本次等于没查',
        hooksFile,
      ],
    };
  }
  if (r.broken) {
    return {
      fail: [
        '随仓 .cursor/hooks.json 解析不了',
        '修 JSON；解析不了 = 本次等于没查',
        r.broken,
      ],
    };
  }
  const gateEntries = beforeShellExecutionEntries(r.doc).filter(h => GATE_MARK.test(h.command));
  if (gateEntries.length === 0) {
    return {
      fail: [
        '一个 beforeShellExecution 派工闸都没扫到',
        `.cursor/hooks.json 的 beforeShellExecution 里要有指向 dispatch-gate 脚本的 command（标记 ${GATE_MARK}）；0 个 = 本次等于没查`,
        hooksFile,
      ],
    };
  }

  const problems = [];
  let scanned = 0;
  for (const entry of gateEntries) {
    const command = entry.command;
    if (entry.failClosed !== true) {
      problems.push(`Cursor 派工闸条目要 failClosed: true（#707：Windows 包装吞退出码，超时/崩溃靠 failClosed 兜底）：${command}`);
    }
    const script = resolveScript(command, root);
    if (!script || !existsSync(script)) {
      problems.push(`beforeShellExecution 指向的脚本不存在：${command}`);
      continue;
    }
    scanned++;

    // Cursor 面协议：exit 恒 0，拦/放全在 stdout JSON permission（#707 实测）
    const blocked = runScript(script, { command: 'orca orchestration worker-start --task t --worktree w', cursor: true });
    const blockedDoc = cursorResponse(blocked);
    if (blocked.status !== 0 || !blockedDoc || blockedDoc.permission !== 'deny') {
      problems.push(`Cursor 面旁路 worker-start 应 exit 0 + permission deny，实际 status=${blocked.status} ${String(blocked.stdout || '').slice(0, 120)}`);
    } else if (!/dao\.mjs dispatch/.test(JSON.stringify(blockedDoc))) {
      problems.push(`Cursor 面拦住了但没指出 dao.mjs dispatch：${command}`);
    }

    const allowed = runScript(script, { command: 'orca orchestration inbox --json', cursor: true });
    const allowedDoc = cursorResponse(allowed);
    if (allowed.status !== 0 || !allowedDoc || allowedDoc.permission !== 'allow') {
      problems.push(`Cursor 面普通 orca inbox 应 permission allow，实际 status=${allowed.status} ${String(allowed.stdout || '').slice(0, 120)}`);
    }

    const heartbeat = runScript(script, { command: 'orca orchestration send --type heartbeat --subject alive', cursor: true });
    const hbDoc = cursorResponse(heartbeat);
    if (!hbDoc || hbDoc.permission !== 'deny' || !/心跳不准发/.test(JSON.stringify(hbDoc))) {
      problems.push(`Cursor 面心跳应 deny 且写「心跳不准发」：${String(heartbeat.stdout || '').slice(0, 120)}`);
    }

    const runUse = runScript(script, { command: 'orca orchestration run-use --id run_x', cursor: true });
    const ruDoc = cursorResponse(runUse);
    if (!ruDoc || ruDoc.permission !== 'deny') {
      problems.push(`Cursor 面裸 run-use 应 deny：${String(runUse.stdout || '').slice(0, 120)}`);
    }

    const raw = runScript(script, { command: 'node scripts/dao.mjs raw -- orca orchestration worker-start --task t', cursor: true });
    const rawDoc = cursorResponse(raw);
    if (!rawDoc || rawDoc.permission !== 'allow') {
      problems.push(`Cursor 面逃生口 raw 应 allow：${String(raw.stdout || '').slice(0, 120)}`);
    }

    const crashed = runScript(script, {
      command: 'orca orchestration send --type heartbeat',
      envExtra: { DISPATCH_GATE_CRASH: '1' },
      cursor: true,
    });
    const crashDoc = cursorResponse(crashed);
    if (!crashDoc || crashDoc.permission !== 'deny') {
      problems.push(`Cursor 面崩了应 deny（fail-closed），实际 ${String(crashed.stdout || '').slice(0, 120)} —— 崩了等于放行`);
    }
  }

  if (scanned === 0) {
    return {
      fail: [
        '声明了 beforeShellExecution 派工闸但一个脚本都没跑成',
        'hooks.json 在、脚本没了 ⇒ 注册指向空气',
        gateEntries.map(e => e.command).join(' | '),
      ],
    };
  }
  if (problems.length) {
    return {
      fail: [
        `Cursor 面派工闸跑不出正确拦截 ${problems.length} 处`,
        '旁路/心跳/帅窗 run-use 必须 permission deny、inbox 必须 allow、崩了必须 deny：手跑 node scripts/lib/cursor-dispatch-gate-hook.mjs',
        problems.slice(0, 6).join('；'),
      ],
    };
  }
  return { green: `Cursor 面派工闸 ${scanned} 个已挂载且真拦得住（deny JSON / allow JSON / 崩了 deny + failClosed:true）` };
}

/**
 * @returns {{green?: string, fail?: [string, string, string]}}
 */
export function checkDispatchGate({ root } = {}) {
  if (!root) return { fail: ['没给仓库根', 'checkDispatchGate 要 root', ''] };
  const claude = checkClaudeMount(root);
  if (claude.fail) {
    const cursor = checkCursorMount(root);
    if (cursor.fail) {
      return {
        fail: [
          claude.fail[0],
          claude.fail[1],
          `${claude.fail[2] || ''}；[cursor] ${cursor.fail[0]}：${cursor.fail[2] || ''}`,
        ],
      };
    }
    return claude;
  }
  const cursor = checkCursorMount(root);
  if (cursor.fail) return cursor;
  return { green: `${claude.green}；${cursor.green}` };
}
