// hooks-drift.mjs — claude hooks 三层对账（issue #366）
//
// ── 治的病 ──────────────────────────────────────────────────────────────────
// #324 退役 9 个 hook 时只清了 git 快照（config-sync/common/settings.json），
// cc-switch DB 的 settings.common_config_claude 里的注册没跟着清；于是每次切账号
// 下发都把死 hook 灌回 ~/.claude/settings.json（live），每个工具调用刷一次
// MODULE_NOT_FOUND。doctor 当时全绿——它只数 mcp_servers/skills 的行数，从不看
// common_config_claude 的**内容**，更不看 live hooks 指向的文件在不在。本文件补
// 三层对账：①DB ↔ 快照 ②live 存在性 ③live ↔ 快照。三个 check* 函数在 doctor.mjs。
//
// ── 全域摸底（写这道闸前的基线，2026-08-13 手术后实测）────────────────────────
// config-sync/common/settings.json 的 common_config_claude.hooks 当前 5 个事件
// （PreToolUse/SessionStart/Stop/StopFailure/UserPromptSubmit）、共 7 条 command。
// 本文件的遍历不认事件名单——`extractHookCommands` 走 `Object.entries(hooksSection)`，
// 新增/改名事件自动纳入扫描面，不需要回来加一行。
//
// ── Orca 注入段：为什么要滤掉 ──────────────────────────────────────────────
// Orca 会往 live settings.json 的多个事件（含 dao 已注册的 PreToolUse/SessionStart/
// Stop/StopFailure/UserPromptSubmit，以及 dao 完全没注册过的 PostToolUse/
// SubagentStart/SubagentStop/TeammateIdle/PostToolUseFailure/PermissionRequest）
// 各插一条形如 `if [ -f '<home>/.orca/agent-hooks/claude-hook.cmd' ]; then ...`
// 的 hook。那是 Orca 的自留地，不是 dao 下发面的一部分——三层对账里任何一层看到它
// 都不该算漂移。判据只认命令串里含不含 ORCA_HOOK_MARKER，不认事件名（Orca 会插进
// 哪些事件是 Orca 自己的实现细节，dao 不该替它维护清单）。
//
// ── 自检不复用被守对象的解析（dao-writing-rules.md 第二节）────────────────────
// `extractHookCommands` 是「找 command」的主逻辑（结构化 JSON 遍历）。自检需要回答
// 「我是不是瞎了」，如果自检也走同一套遍历，遍历本身漏掉一整段时两半会一起归零，
// 差恒为 0 ⇒ 自检永远为真。`countCommandOccurrencesRaw` 是另一套独立实现：直接对
// **原始 JSON 文本**做正则扫描，不经过 JSON.parse 与对象遍历。两者数字对不上（尤其
// 「结构遍历=0 但原文本>0」）说明结构遍历本身坏了，doctor.mjs 据此判 fail 而不是
// 沉默判 pass。

import fs from 'node:fs';
import { stableJson } from './sqlite.mjs';

// Orca 在 live settings.json 里注入的 hook 命令里都含这个子串（真实样本见上）。
export const ORCA_HOOK_MARKER = '.orca/agent-hooks';

// ── 路径归一化（issue #376 边界债 #2/#3）────────────────────────────────────
// 同一个 hook 文件在不同机器/不同写法下，command 字符串里的路径可能正斜杠、
// 反斜杠混写，盘符大小写也可能不同——这些差异不改变「指向同一个文件」这件事，
// 但字节级深比较会把它们当成漂移（#2），marker 子串匹配也会因反斜杠变体而
// 整段漏滤（#3）。只用于「判断是不是同一个东西」，不用于文件系统操作
// （existsSync 走原始路径，大小写/斜杠语义交给操作系统自己处理）。
function normalizeSlashesAndDrive(text) {
  return String(text || '')
    .replace(/\\/g, '/')
    .replace(/\b([A-Za-z]):\//g, (_m, d) => `${d.toLowerCase()}:/`);
}

export function isOrcaHookCommand(command) {
  return typeof command === 'string' && normalizeSlashesAndDrive(command).includes(ORCA_HOOK_MARKER);
}

// ── 主逻辑：结构化遍历 ────────────────────────────────────────────────────
// hooksSection 形如 { EventName: [ { matcher?, hooks: [{ command, timeout, type }] } ] }。
// 返回 [{ event, command }]，不做任何过滤（过滤是调用方的事，见 filterOrcaHookGroups）。
export function extractHookCommands(hooksSection) {
  const out = [];
  if (!hooksSection || typeof hooksSection !== 'object') return out;
  for (const [event, groups] of Object.entries(hooksSection)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
      for (const hook of hooks) {
        if (hook && typeof hook.command === 'string') out.push({ event, command: hook.command });
      }
    }
  }
  return out;
}

// 滤掉 Orca 注入段：组内每条 command 都是 Orca 的 ⇒ 整组丢；组内混了 Orca 与非 Orca
// （目前实测样本没有这种混法，但不假设它不会发生）⇒ 只留非 Orca 的 hook 项；
// 一个事件下所有组都被丢空 ⇒ 该事件整个键从结果里消失（不留空数组），
// 这样过滤后的结构才能跟从不知道 Orca 存在的快照做逐字节意义的深比较。
export function filterOrcaHookGroups(hooksSection) {
  const out = {};
  if (!hooksSection || typeof hooksSection !== 'object') return out;
  for (const [event, groups] of Object.entries(hooksSection)) {
    if (!Array.isArray(groups)) continue;
    const keptGroups = [];
    for (const group of groups) {
      const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
      const keptHooks = hooks.filter((hook) => !isOrcaHookCommand(hook?.command));
      if (keptHooks.length === 0) continue;
      keptGroups.push(keptHooks.length === hooks.length ? group : { ...group, hooks: keptHooks });
    }
    if (keptGroups.length) out[event] = keptGroups;
  }
  return out;
}

// `node "<path>" [...其余参数]` 或 `node '<path>' [...]` 形态里的路径；不是这个
// 形态返回 null（本闸只射 node hook，其余 command 类型——目前只有 Orca 的 shell
// if 判断——不在射程内，且 Orca 那条已经在 isOrcaHookCommand 那关被挡）。
// issue #376 边界债 #1：原正则只认双引号，混合形态（单引号 node hook）会被判定
// 「不是 node 形态」而整条静默漏过存在性检查——死 hook 因此不会被 checked 收进去，
// 既不报「missing」也不出现在盲信号计数里。两个分支要求引号成对（不接受 `node "x'`
// 这种首尾不一致的写法）。
const NODE_HOOK_RE = /^node\s+(?:"([^"]+)"|'([^']+)')/;
export function extractNodeHookPath(command) {
  const match = NODE_HOOK_RE.exec(String(command || '').trim());
  if (!match) return null;
  return match[1] !== undefined ? match[1] : match[2];
}

// 独立于 NODE_HOOK_RE 的「像不像 node hook」判据，只给下面的自检用——不提取路径，
// 只要求 `node` 后面跟一个引号。若 NODE_HOOK_RE 本身的引号捕获逻辑坏了（例如
// 手滑把 `(?:...)` 改错），这条判据仍然独立存在，不会跟着一起瞎（dao-writing-rules
// 第二节：自检那一半不能复用被守对象的解析）。
const RAW_NODE_FORM_RE = /^node\s+["']/;
function looksLikeNodeHookRaw(command) {
  return RAW_NODE_FORM_RE.test(String(command || '').trim());
}

// live settings.json 里每个 node hook 指向的文件是否存在。existsSync 可注入，
// 测试用假的存在性表，不用真的碰磁盘或真的 live 文件。
// 返回 { checked, missing }：checked 是本闸射程内、且已排除 Orca 段之后真正判定过
// 的条目；missing 是其中文件不存在的。checked.length === 0 时调用方应视为「本轮没
// 查成」而不是「查过没事」（零样本闸，dao-check.mjs 头注同一判据）。
export function checkNodeHookExistence(hooksSection, { existsSync = fs.existsSync } = {}) {
  const checked = [];
  const missing = [];
  for (const { event, command } of extractHookCommands(hooksSection)) {
    if (isOrcaHookCommand(command)) continue;
    const hookPath = extractNodeHookPath(command);
    if (!hookPath) continue;
    const entry = { event, command, path: hookPath };
    checked.push(entry);
    if (!existsSync(hookPath)) missing.push(entry);
  }
  return { checked, missing };
}

// ── 自检：独立于上面结构化遍历的第二套实现（正则扫原始 JSON 文本）──────────
// 只用于「结构化遍历是不是瞎了」这一问，不用于判违例——判违例仍然只信
// extractHookCommands/checkNodeHookExistence 那一套结构化结果。
const RAW_COMMAND_RE = /"command"\s*:\s*"((?:\\.|[^"\\])*)"/g;
export function countCommandOccurrencesRaw(rawJsonText) {
  const text = String(rawJsonText || '');
  let count = 0;
  let match;
  RAW_COMMAND_RE.lastIndex = 0;
  while ((match = RAW_COMMAND_RE.exec(text)) !== null) {
    let command;
    try { command = JSON.parse(`"${match[1]}"`); } catch { command = match[1]; }
    if (!isOrcaHookCommand(command)) count++;
  }
  return count;
}

// 把「结构遍历数」与「独立正则扫描数」放在一起：structural === 0 而 textual > 0
// 是结构遍历瞎了的信号（原文本明明有非 Orca 的 command，遍历却一条没找到）。
export function selfCheckHookSampleCount(hooksSection, rawJsonText) {
  const structural = extractHookCommands(hooksSection).filter((c) => !isOrcaHookCommand(c.command)).length;
  const textual = countCommandOccurrencesRaw(rawJsonText);
  return { structural, textual, blind: structural === 0 && textual > 0 };
}

// ── issue #376 边界债 #4：live 存在性检查的盲信号必须同一个射程 ─────────────
// checkNodeHookExistence 只看 node 形态的 hook（extractNodeHookPath 命中才收进
// checked）。旧版盲信号用 countCommandOccurrencesRaw——那是「任意非 Orca command」
// 的计数，射程比 checked 宽。后果：live 里合法地只有非 node 形态 hook（checked=0
// 天经地义）时，只要还有别的非 Orca command，textual>0，就会被误判成「判据自身
// 失效」触发硬 FAIL（2026-08 沙箱实测复现）。本函数把独立正则扫描收窄到 node 形态
// （用上面的 looksLikeNodeHookRaw，不是 NODE_HOOK_RE），使盲信号与 checked 同射程。
export function countNodeHookOccurrencesRaw(rawJsonText) {
  const text = String(rawJsonText || '');
  let count = 0;
  let match;
  RAW_COMMAND_RE.lastIndex = 0;
  while ((match = RAW_COMMAND_RE.exec(text)) !== null) {
    let command;
    try { command = JSON.parse(`"${match[1]}"`); } catch { command = match[1]; }
    if (isOrcaHookCommand(command)) continue;
    if (looksLikeNodeHookRaw(command)) count++;
  }
  return count;
}

// ── 两段 hooks 深比较，供 DB↔快照 / live↔快照 两处调用（issue #376 边界债 #6）──
// 这段判断逻辑本来分别复制在 doctor.mjs 的两个 check* 函数里——「结构遍历是主逻辑，
// 只测它」的老测试套件测不到这段 glue：filterOrcaHookGroups + 零样本闸 + 深比较
// 三步怎么拼、拼错了会不会被抓到，此前完全没有断言覆盖（2026-08 对抗审 mutation ③
// 实测：单元套件全绿而真机假绿，命中的正是这段 glue）。抽成纯函数后 doctor.mjs
// 只做取数与文案渲染，判断逻辑单独可测。
//
// 返回 status 四态：
//   'blind'       —— 过滤 Orca 段后两边都是 0 条，但过滤前（rawCountA/B，不经过
//                     isOrcaHookCommand）至少一边 > 0——marker 判据疑似恒真吞掉了
//                     一切，不能算「没查成」，必须报「判据自身可能失效」（边界债 #5：
//                     零样本闸的 marker 无关兜底）。
//   'zero-sample' —— 过滤前后都是 0 条，真的没有样本，不判定。
//   'match'       —— 归一化（斜杠/盘符）后深比较一致（边界债 #2）。
//   'drift'       —— 深比较不一致。
export function compareHookSections(sectionA, sectionB) {
  const filteredA = filterOrcaHookGroups(sectionA);
  const filteredB = filterOrcaHookGroups(sectionB);
  const countA = extractHookCommands(filteredA).length;
  const countB = extractHookCommands(filteredB).length;
  // rawCount 不经过 filterOrcaHookGroups/isOrcaHookCommand，是纯结构化计数——
  // 与 countA/countB 的差异来源只能是 marker 判据本身，不依赖它，才谈得上「兜底」。
  const rawCountA = extractHookCommands(sectionA).length;
  const rawCountB = extractHookCommands(sectionB).length;

  if (countA === 0 && countB === 0) {
    if (rawCountA > 0 || rawCountB > 0) {
      return { status: 'blind', countA, countB, rawCountA, rawCountB };
    }
    return { status: 'zero-sample', countA, countB, rawCountA, rawCountB };
  }

  const same = stableJson(normalizeHookSectionForCompare(filteredA)) === stableJson(normalizeHookSectionForCompare(filteredB));
  return { status: same ? 'match' : 'drift', countA, countB, rawCountA, rawCountB };
}

// 深比较前把每条 command 的斜杠/盘符大小写归一化（issue #376 边界债 #2）。只改
// 用于比较的副本，不改传入对象、不改文件系统层面的任何东西。
export function normalizeHookSectionForCompare(hooksSection) {
  if (!hooksSection || typeof hooksSection !== 'object') return hooksSection;
  const out = {};
  for (const [event, groups] of Object.entries(hooksSection)) {
    if (!Array.isArray(groups)) { out[event] = groups; continue; }
    out[event] = groups.map((group) => {
      if (!group || typeof group !== 'object') return group;
      const hooks = Array.isArray(group.hooks) ? group.hooks : [];
      return {
        ...group,
        hooks: hooks.map((h) => (h && typeof h.command === 'string')
          ? { ...h, command: normalizeSlashesAndDrive(h.command) }
          : h),
      };
    });
  }
  return out;
}
