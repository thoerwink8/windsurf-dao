// skill 装载面「该接回哪几个家目录」的唯一一份判据（dao-check ㉚ 与 skills-heal 共用）。
//
// 病（2026-09-13 实咬，#1146 的洞）：自愈单元 `User=orca` 拿 `$HOME=/home/orca`，
// 而 dao-check 用 `process.env.HOME` 看到的是 `/root`。两边各修各看的装载面——
// 自愈器每 5 分钟对 orca 那份说「无事可做」，检查器对 root 那份报了三天红，
// 谁也没错，是「同一条判据在两个地方各写了一份、还各用一个 home」。
//
// 判据：一个家目录有 `.claude/`，就说明那里有本检查要守的装载面
// （`~/.claude/skills`，NEW-MACHINE §11）。**不把只有 `.mirasim/` 的家算进来**——
// 那是 mirasim 自己的发现面，本检查/自愈既不查它也不该凭空建 `.claude/skills`。
// **不写死用户名**——手打的名字早晚漏（判例 memory hand-typed-constant-will-be-wrong）：
// 这台机器上 root 与 orca 都有 `.claude/`，换台机器用户名可能不同。
//
// 取不到家目录列表（读不了 /etc/passwd）时返回 unscanned，**不返回空数组**：
// 「一个家目录都没有」和「这次没读到」必须分得开，否则整条自愈链会静默变成空转。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 判定某目录算不算「有装载面的家目录」。导出供测试拿假目录造样本。 */
export function looksLikeAgentHome(dir) {
  return existsSync(join(dir, '.claude'));
}

/** 从一份 passwd 文本里取家目录（第 6 栏，绝对路径）。 */
export function homesFromPasswd(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(':');
    if (parts.length < 6) continue;
    const home = parts[5].trim();
    if (!home.startsWith('/')) continue; // nologin 之类会留空串
    if (!out.includes(home)) out.push(home);
  }
  return out;
}

/** 本机所有家目录候选（passwd 全量；读不了返回 null）。 */
function passwdHomes(readFile = readFileSync) {
  for (const p of ['/etc/passwd']) {
    try { return homesFromPasswd(readFile(p, 'utf8')); } catch { /* 换下一个 */ }
  }
  return null;
}

/**
 * 该守哪几个装载面。
 *
 * @param {{env?: object, readdir?: Function, readFile?: Function}} deps 测试注入用
 * @returns {{ok: true, homes: string[]} | {ok: false, reason: string}}
 *          `homes` 只含**真的存在装载面**的家目录，按路径排序（幂等、可断言）。
 *          ok:false 是「没查成」，调用方不许把它当成空列表静默跳过。
 */
export function agentHomes({ env = process.env, readdir = readdirSync, readFile = readFileSync } = {}) {
  const candidates = new Set();
  // 显式覆盖：排障/测试用，逗号或冒号分隔；给了就以它为准，不掺 passwd。
  const override = String((env && (env.DAO_SKILL_HOMES || env.DAO_AGENT_HOMES)) || '').trim();
  if (override) {
    for (const h of override.split(/[,:]/).map((s) => s.trim()).filter(Boolean)) {
      if (h.startsWith('/')) candidates.add(h.replace(/\/+$/, '') || '/');
    }
    if (!candidates.size) return { ok: false, reason: `DAO_SKILL_HOMES 里没有绝对路径：${override}` };
  } else {
    const fromPasswd = passwdHomes(readFile);
    if (!fromPasswd) return { ok: false, reason: '读不了 /etc/passwd——取不到家目录清单（≠ 一个都没有）' };
    for (const h of fromPasswd) candidates.add(h);
    // 当前进程的家目录也纳入：passwd 里没有运行身份时（容器/临时用户）不至于漏掉自己。
    const cur = String((env && (env.HOME || env.USERPROFILE)) || '').trim();
    if (cur.startsWith('/')) candidates.add(cur.replace(/\/+$/, '') || '/');
  }

  const homes = [];
  let inspected = 0;
  for (const dir of candidates) {
    let entries;
    try { entries = readdir(dir); } catch { continue; } // 不存在 / 没权限：不是「没装载面」，是够不着
    inspected++;
    if (entries.includes('.claude')) homes.push(dir);
  }
  if (inspected === 0) {
    return { ok: false, reason: `候选家目录 ${candidates.size} 个一个都读不到——没查成（≠ 都没有装载面）` };
  }
  return { ok: true, homes: homes.sort() };
}
