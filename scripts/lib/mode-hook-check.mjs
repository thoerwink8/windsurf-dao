// 态注入 hook 的活检（dao-check 第 ⑦ 项的实现，issue #488）。
//
// 单独成文件只为一件事：让 tests/dao-mode.tests.js 能拿假 HOME 造违规样本来验它自己的判别力，
// 而不必去跑整个 dao-check（那会递归——dao-check 会跑 tests/，tests 再跑 dao-check）。
//
// 被检查的是什么：仓内每个自带 hook 的 skill（`host/skills/<名>/hooks/hooks.json` 声明
// UserPromptSubmit）。这类 skill 以插件形态装在 `~/.claude/skills/<名>/`，Claude Code
// 会自动加载（`<名>@skills-dir`），**不经过 settings.json**。为兼容手工注册的老路子，
// settings.json / settings.local.json 里的注册也一并认。
//
// 验两层，缺一不可（静态门控拦不住运行时失效）：
//   静态：仓内声明的每个 hook 脚本，都要能在本机某个装载面上被点到（插件面或 settings 面）。
//   运行时：把点到的那条命令原样跑两次——一次喂造好的专注态、一次喂不存在的状态文件。
//           断言专注那次带得出焦点原文、缺失那次带不出、且两次输出不同形。
//           symlink 断了、node 不在、脚本坏了、输出写死了，只有这一层抓得住。
//
// 为什么必须每次 dao check 都重验：装载面没有单一 owner——插件面会随 worktree 删除断链，
// settings.json 更是 cc-switch 下发 / Orca 写 hooks / CC 本体重置三方互相覆盖。
// 装过一次 ≠ 现在还在。
//
// 自己 JSON.parse 各装载面，不复用被检查方的任何解析——自己查自己查不出错。

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const SENTINEL = 'DAOCHECK-SENTINEL-焦点';

const SETTINGS_FACES = ['settings.json', 'settings.local.json'];

/** 从一份 hooks 配置（settings 或插件 hooks.json）里抽出 UserPromptSubmit 的 command 列表。 */
function promptCommands(doc) {
  const entries = doc?.hooks?.UserPromptSubmit;
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const g of entries) {
    for (const h of (g?.hooks || [])) {
      if (h?.type === 'command' && typeof h.command === 'string') out.push(h.command);
    }
  }
  return out;
}

function readJson(file) {
  if (!existsSync(file)) return { exists: false };
  try {
    return { exists: true, doc: JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) };
  } catch (e) {
    return { exists: true, broken: String(e.message).slice(0, 80) };
  }
}

function runRegistered(command, stateFile, pluginRoot) {
  const r = spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'dao check 自检' }),
    timeout: 30000,
    env: { ...process.env, DAO_STATE_FILE: stateFile, CLAUDE_PLUGIN_ROOT: pluginRoot || '' },
  });
  return { status: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

/** 仓内自带 hook 的 skill：返回 [{ name, hooksFile, scripts: [文件名], commands: [声明的命令] }] */
function declaredHookSkills(root) {
  const dir = join(root, 'host', 'skills');
  if (!existsSync(dir)) return { missingDir: dir, list: [] };
  const list = [];
  for (const name of readdirSync(dir)) {
    const skillDir = join(dir, name);
    if (!statSync(skillDir).isDirectory()) continue;
    const hooksFile = join(skillDir, 'hooks', 'hooks.json');
    const r = readJson(hooksFile);
    if (!r.exists) continue;
    if (r.broken) { list.push({ name, hooksFile, broken: r.broken, scripts: [], commands: [] }); continue; }
    const commands = promptCommands(r.doc);
    if (commands.length === 0) continue;
    const scripts = readdirSync(join(skillDir, 'hooks')).filter(f => f.endsWith('.mjs'));
    list.push({ name, hooksFile, scripts, commands });
  }
  return { list };
}

/**
 * @param {{root: string, home: string}} opts root=仓库根，home=放 .claude/ 的那个目录
 * @returns {{green?: string, fail?: [string, string, string]}} 三槽位与 dao-check 的 fail() 对齐
 */
export function checkModeHook({ root, home }) {
  const declared = declaredHookSkills(root);
  if (declared.missingDir) {
    return { fail: ['host/skills 不在', '本次没查成：确认 skill 真相源目录是否被移动', declared.missingDir] };
  }
  const broken = declared.list.filter(s => s.broken);
  if (broken.length) {
    return { fail: [`skill 的 hooks.json 解析不了 ${broken.length} 个`, '修 JSON；解析不了 = 本次等于没查', broken.map(s => `${s.name}: ${s.broken}`).join(' ')] };
  }
  if (declared.list.length === 0) {
    return { fail: ['一个自带 hook 的 skill 都没扫到', '本仓的态注入 hook 应声明在 host/skills/<名>/hooks/hooks.json；0 个 = 本次等于没查', join(root, 'host', 'skills')] };
  }
  const scripts = declared.list.flatMap(s => s.scripts);
  if (scripts.length === 0) {
    return { fail: ['声明了 hook 但一个 .mjs 都没有', 'hooks.json 在、脚本没了 ⇒ 注册指向空气', declared.list.map(s => s.hooksFile).join(' ')] };
  }

  // 装载面 ①：插件面（~/.claude/skills/<名>/hooks/hooks.json，Claude Code 自动加载，不经 settings.json）
  const candidates = [];   // { command, pluginRoot, where }
  for (const s of declared.list) {
    const pluginRoot = join(home, '.claude', 'skills', s.name);
    const r = readJson(join(pluginRoot, 'hooks', 'hooks.json'));
    if (!r.exists || r.broken) continue;
    for (const c of promptCommands(r.doc)) {
      candidates.push({ command: c.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot.replace(/\\/g, '/')), pluginRoot, where: `插件面 ${s.name}` });
    }
  }

  // 装载面 ②：settings.json / settings.local.json（手工注册的老路子）
  let anySettingsFace = false;
  for (const n of SETTINGS_FACES) {
    const file = join(home, '.claude', n);
    const r = readJson(file);
    if (!r.exists) continue;
    anySettingsFace = true;
    if (r.broken) {
      return { fail: [`settings 面解析不了：${n}`, '修 JSON；解析不了 = 本次等于没查', `${file}: ${r.broken}`] };
    }
    for (const c of promptCommands(r.doc)) candidates.push({ command: c, pluginRoot: '', where: `settings 面 ${n}` });
  }

  if (candidates.length === 0) {
    return { fail: [
      '态注入 hook 一个装载面都没点到',
      `装：把 host/skills/<名> 用 SymbolicLink 链到 ${join(home, '.claude', 'skills')}\\<名>（插件面自动加载，不用改 settings.json），详见 NEW-MACHINE.md`,
      `找过：${join(home, '.claude', 'skills')} 下的插件面${anySettingsFace ? ' + settings 面' : '（settings 面也没有）'}`,
    ] };
  }

  const unregistered = scripts.filter(f => !candidates.some(c => c.command.includes(f)));
  if (unregistered.length) {
    return { fail: [
      `态注入 hook 没被任何装载面点到 ${unregistered.length} 个`,
      '没装或被覆盖了：按 NEW-MACHINE.md「专注/值守态注入」那节重装（装载面无单一 owner，装过一次 ≠ 现在还在）',
      `缺 ${unregistered.join(' ')}；现有候选 ${candidates.map(c => c.where).join('/')}`,
    ] };
  }

  // 运行时：真跑，两种输入必须出两种形。
  const tmpState = join(tmpdir(), `dao-check-state-${process.pid}.json`);
  const gone = join(tmpdir(), `dao-check-gone-${process.pid}-不存在.json`);
  const problems = [];
  const hitWheres = [];
  for (const f of scripts) {
    const hit = candidates.find(c => c.command.includes(f));
    hitWheres.push(hit.where);
    writeFileSync(tmpState, JSON.stringify({
      mode: 'focus', since: new Date().toISOString(),
      focus: { what: SENTINEL, doneWhen: '自检跑完' },
      offTopicStreak: 0, parked: [],
    }), 'utf8');
    const onFocus = runRegistered(hit.command, tmpState, hit.pluginRoot);
    const onMissing = runRegistered(hit.command, gone, hit.pluginRoot);
    const tag = `${f}(${hit.where})`;
    if (onFocus.status !== 0) problems.push(`${tag} 喂专注态退出码 ${onFocus.status}`);
    else if (!onFocus.out.includes(SENTINEL)) problems.push(`${tag} 喂专注态没把焦点吐出来：${onFocus.out.slice(0, 60) || '(空输出)'}`);
    if (onMissing.status !== 0) problems.push(`${tag} 喂缺失态退出码 ${onMissing.status}`);
    else if (onMissing.out.includes(SENTINEL)) problems.push(`${tag} 喂缺失态还吐焦点（读的不是给它的状态文件）`);
    else if (onFocus.out && onFocus.out === onMissing.out) problems.push(`${tag} 两种输入输出同形 ⇒ 「读到了」和「没读到」分不开`);
  }
  try { rmSync(tmpState, { force: true }); } catch { /* 清不掉不影响判定 */ }

  if (problems.length) {
    return { fail: [
      `态注入 hook 跑不出正确输出 ${problems.length} 处`,
      '装载面点到了但跑不动 = 断链/坏了：手跑 `node host/skills/<名>/hooks/<名>.mjs hook` 看报什么',
      problems.slice(0, 6).join('；'),
    ] };
  }
  return { green: `态注入 hook ${scripts.length} 个已装载且真跑得动（${[...new Set(hitWheres)].join('/')}；读到/没读到两种形可分辨）` };
}
