// 派工闸门活检（dao-check 第 ⑬ 项，#546 #517）。
//
// 自己 JSON.parse hooks.json，不复用闸门自己的解析——自己查自己查不出错。
// 把声明的脚本当真进程跑：旁路应 exit 2、普通 orca 应 exit 0、崩了也应 exit 2。
// 零样本（一个 PreToolUse 都没扫到 / 脚本不在 / JSON 坏了）单独报红，不许记成绿。

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function readJson(file) {
  if (!existsSync(file)) return { exists: false };
  try {
    return { exists: true, doc: JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) };
  } catch (e) {
    return { exists: true, broken: String(e.message).slice(0, 80) };
  }
}

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

function declaredPreToolUse(root) {
  const dir = join(root, 'host', 'skills');
  if (!existsSync(dir)) return { missingDir: dir, list: [] };
  const list = [];
  for (const name of readdirSync(dir)) {
    const skillDir = join(dir, name);
    if (!statSync(skillDir).isDirectory()) continue;
    const hooksFile = join(skillDir, 'hooks', 'hooks.json');
    const r = readJson(hooksFile);
    if (!r.exists) continue;
    if (r.broken) {
      list.push({ name, hooksFile, broken: r.broken, commands: [], scripts: [] });
      continue;
    }
    const commands = preToolUseCommands(r.doc);
    if (commands.length === 0) continue;
    const hooksDir = join(skillDir, 'hooks');
    const scripts = existsSync(hooksDir)
      ? readdirSync(hooksDir).filter(f => f.endsWith('.mjs'))
      : [];
    list.push({ name, hooksFile, commands, scripts, hooksDir });
  }
  return { list };
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
  const declared = declaredPreToolUse(root);
  if (declared.missingDir) {
    return { fail: ['host/skills 不在', '本次没查成：确认 skill 真相源目录是否被移动', declared.missingDir] };
  }
  const broken = declared.list.filter(s => s.broken);
  if (broken.length) {
    return {
      fail: [
        `派工闸 hooks.json 解析不了 ${broken.length} 个`,
        '修 JSON；解析不了 = 本次等于没查',
        broken.map(s => `${s.name}: ${s.broken}`).join(' '),
      ],
    };
  }
  if (declared.list.length === 0) {
    return {
      fail: [
        '一个 PreToolUse 派工闸都没扫到',
        '本仓的派工闸应声明在 host/skills/<名>/hooks/hooks.json 的 PreToolUse；0 个 = 本次等于没查',
        join(root, 'host', 'skills'),
      ],
    };
  }

  const problems = [];
  let scanned = 0;
  for (const s of declared.list) {
    const script = (s.scripts || [])
      .map(f => join(s.hooksDir, f))
      .find(p => existsSync(p));
    if (!script) {
      problems.push(`${s.name} 声明了 PreToolUse 但 hooks/ 下没有 .mjs`);
      continue;
    }
    scanned++;

    const blocked = runScript(script, { command: 'orca orchestration worker-start --task t --worktree w' });
    if (blocked.status !== 2) {
      problems.push(`${s.name} 旁路 worker-start 应 exit 2，实际 ${blocked.status} ${String(blocked.stderr || blocked.stdout || '').slice(0, 80)}`);
    } else if (!/dao\.mjs dispatch/.test(`${blocked.stderr || ''}${blocked.stdout || ''}`)) {
      problems.push(`${s.name} 拦住了但没指出 dao.mjs dispatch`);
    }

    const taskCreate = runScript(script, { command: 'orca orchestration task-create --spec x' });
    if (taskCreate.status !== 2) {
      problems.push(`${s.name} 旁路 task-create 应 exit 2，实际 ${taskCreate.status}`);
    }

    const allowed = runScript(script, { command: 'orca orchestration send --type heartbeat --subject alive' });
    if (allowed.status !== 0) {
      problems.push(`${s.name} 普通 orca send 应放行，实际 ${allowed.status} ${String(allowed.stderr || '').slice(0, 80)}`);
    }

    const raw = runScript(script, { command: 'node scripts/dao.mjs raw -- orca orchestration worker-start --task t' });
    if (raw.status !== 0) {
      problems.push(`${s.name} 逃生口 raw 应放行，实际 ${raw.status}`);
    }

    const crashed = runScript(script, {
      command: 'orca orchestration send --type heartbeat',
      envExtra: { DISPATCH_GATE_CRASH: '1' },
    });
    if (crashed.status !== 2) {
      problems.push(`${s.name} 崩了应 exit 2（fail-closed），实际 ${crashed.status} —— 崩了等于放行`);
    } else if (!/fail-closed|崩/.test(`${crashed.stderr || ''}${crashed.stdout || ''}`)) {
      problems.push(`${s.name} 崩了 exit 2 但没报出来`);
    }
  }

  if (scanned === 0) {
    return {
      fail: [
        '声明了 PreToolUse 但一个脚本都没跑成',
        'hooks.json 在、脚本没了 ⇒ 注册指向空气',
        declared.list.map(s => s.hooksFile).join(' '),
      ],
    };
  }
  if (problems.length) {
    return {
      fail: [
        `派工闸跑不出正确拦截 ${problems.length} 处`,
        '旁路必须 exit 2、普通 orca 必须放行、崩了必须 exit 2：手跑 node host/skills/dispatch/hooks/dispatch-gate.mjs',
        problems.slice(0, 6).join('；'),
      ],
    };
  }
  return { green: `派工闸 ${scanned} 个已声明且真拦得住（旁路 exit 2 / 逃生口放行 / 崩了 exit 2）` };
}
