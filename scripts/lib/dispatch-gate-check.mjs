// 派工闸门活检（dao-check 第 ⑬ 项，#546 #517 #553）。
//
// 闸门挂载在**随仓 `.claude/settings.json`**（#553 从 plugin 换挂法：clone 即生效、cc-switch 碰不到、
// 装机零步骤），不再扫 host/skills/<名>/hooks/hooks.json 的插件面。
// 自己 JSON.parse settings.json 并自己遍历 PreToolUse，不复用闸门自己的解析——自己查自己查不出错。
// 判据三层，缺一即红：
//   ① 装载：settings.json 的 PreToolUse 里至少有一条指向 dispatch-gate 脚本的命令（独立标记，见 GATE_MARK）。
//   ② 指向：从命令里抽出的脚本路径在仓里真存在（注册指向空气 = 红）。
//   ③ 行为：把声明的脚本当真进程跑——旁路应 exit 2、普通 orca 应 exit 0、崩了也应 exit 2。
// 零样本（settings.json 不在 / JSON 坏了 / 一个 PreToolUse 派工闸都没扫到）单独报红，不许记成绿。

import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

// 检查器自己的标记：settings.json 里哪条 PreToolUse command 算「派工闸」。
// 不以闸门自己的解析逻辑为准，只认命令里带 dispatch-gate 字样的脚本路径。
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

/** 从一条 hook 命令里抽出脚本路径，并相对仓库根解析。返回 '' 表示抽不出。 */
function resolveScript(command, root) {
  const m = String(command || '').match(/["']?((?:[^"'\s]|\\ )*dispatch-gate[^"'\s]*\.mjs)["']?/);
  if (!m) return '';
  let p = m[1].replace(/^["']|["']$/g, '').trim();
  // 展开 Claude Code 注入的项目根变量；检查器只验路径存在性，不模拟宿主展开
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

function runScript(script, { command, envExtra = {} } = {}) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    input: payload(command),
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, ...envExtra },
  });
}

/**
 * @returns {{green?: string, fail?: [string, string, string]}}
 */
export function checkDispatchGate({ root } = {}) {
  if (!root) return { fail: ['没给仓库根', 'checkDispatchGate 要 root', ''] };
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

    const allowed = runScript(script, { command: 'orca orchestration send --type heartbeat --subject alive' });
    if (allowed.status !== 0) {
      problems.push(`普通 orca send 应放行，实际 ${allowed.status} ${String(allowed.stderr || '').slice(0, 80)}`);
    }

    const raw = runScript(script, { command: 'node scripts/dao.mjs raw -- orca orchestration worker-start --task t' });
    if (raw.status !== 0) {
      problems.push(`逃生口 raw 应放行，实际 ${raw.status}`);
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
        '旁路必须 exit 2、普通 orca 必须放行、崩了必须 exit 2：手跑 node scripts/lib/dispatch-gate-hook.mjs',
        problems.slice(0, 6).join('；'),
      ],
    };
  }
  return { green: `派工闸 ${scanned} 个已挂载且真拦得住（旁路 exit 2 / 逃生口放行 / 崩了 exit 2）` };
}
