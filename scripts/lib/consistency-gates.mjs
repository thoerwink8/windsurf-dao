// 两道一致性闸的纯函数实现（issue #340 活 3）。
//
// 纯函数契约：路径全部由参数注入，不读全局环境、不 console.log、不 process.exit。
// 返回形态统一：{ fails: [[what, howToFix, evidence], ...], greens: ["一行", ...] }
//   fails 每项恰好 3 个槽位（什么坏了 / 怎么修 / 机器给的一行证据）。
//
// 守的两个静默失效面：
//   ㈠ 命令表指空 —— ccswitch/dao.md 的「器 · 命令表」列了 /命令 但没实现，无人报错，
//      用户敲下去才发现。零样本闸：节找不到 / 抽出 0 条 ⇒ 红（本次没查成，不是没问题）。
//   ㈡ 归位未部署 —— 仓里有 skill 却没 symlink 进 ~/.claude/skills，它永远不会被加载。
//      排除清单唯一真相源是 dao.ps1 的 Get-InternalOnlySkills（不许在 mjs 里手抄一份）。

import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 闸㈠：命令表里每个 /命令 都必须有实现（commands/<n>.md 或 skills/<n>/SKILL.md）。
 */
export function checkCommandTableImplemented({ repoRoot }) {
  const daoMd = join(repoRoot, 'ccswitch', 'dao.md');
  if (!existsSync(daoMd)) {
    return {
      fails: [['命令表源 ccswitch/dao.md 不在', '本次没查成，不是没问题：确认 ccswitch/dao.md 是否被移动或改名', daoMd]],
      greens: [],
    };
  }
  let src;
  try {
    src = readFileSync(daoMd, 'utf8');
  } catch (e) {
    return {
      fails: [['命令表源 ccswitch/dao.md 读不了', '修文件权限或编码', String(e.message).slice(0, 160)]],
      greens: [],
    };
  }

  // 截出「## 器」节：从匹配 /^##\s*器/m 的那一行起，到下一个 /^##\s/m 行之前。
  const startMatch = src.match(/^##\s*器.*$/m);
  if (!startMatch) {
    return {
      fails: [['命令表节（## 器）找不到', '标题被改名了 ⇒ 闸静默失效；恢复 dao.md 的「## 器」节标题', daoMd]],
      greens: [],
    };
  }
  const after = src.slice(startMatch.index + startMatch[0].length);
  const endMatch = after.match(/^##\s/m);
  const section = endMatch ? after.slice(0, endMatch.index) : after;

  // 两段处理（顺序不能反）：① 围栏状态机把三反引号代码块内容整块挖除（含边界行）——
  // 围栏内是命令用法示例，不该被当裸写/命令表内容扫；未闭合的围栏视为开到节尾（漏检方向）。
  // ② 对剩余文本做反引号命令抽取与裸写扫描。围栏内命令与它是否实现无关，一律不参与解析。
  const noFence = stripFencedBlocks(section);

  // 抽反引号包裹的斜杠命令名，去重。
  const names = [...noFence.matchAll(/`\/([A-Za-z0-9][A-Za-z0-9._-]*)`/g)].map((m) => m[1]);
  const uniq = [...new Set(names)];
  if (uniq.length === 0) {
    return {
      fails: [['命令表抽出 0 条 /命令', '解析器与 dao.md 写法对不上 ⇒ 本次等于没查；核反引号斜杠命令写法', daoMd]],
      greens: [],
    };
  }

  // 格式漂移即红：抽完反引号命令后挖掉所有反引号片段，剩下文本里的裸写斜杠命令 ⇒ 判红。
  // 闸抽不到的东西就等于没查——裸写命令不做「有无实现」判断，因为它根本没进过解析器。
  const fails = [];
  const bare = [...new Set(scanBareCommands(noFence))];
  if (bare.length > 0) {
    fails.push(['命令表有裸写未加反引号的 /命令', '命令表里的 /命令必须用反引号包裹，否则闸抽不到它 ⇒ 静默漏检', bare.join(' ')]);
  }

  const missing = uniq.filter((n) => !hasImplementation(repoRoot, n));
  if (missing.length > 0) {
    fails.push([`命令表里有实现缺失的 /命令 ${missing.length} 个`, '要么补 ccswitch/commands/<名>.md，要么建 ccswitch/skills/<名>/SKILL.md', missing.join(' ')]);
  }
  if (fails.length > 0) return { fails, greens: [] };
  return { fails: [], greens: [`命令表 ${uniq.length} 个 /命令全部有实现`] };
}

/** 裸写斜杠命令扫描正则：/ 前必须是行首或「中文正文里可能紧跟命令名的标点」一次补齐。
 *  含半角空格/制表/换行（\s）、全角空格（　）、全角逗号句号分号冒号叹号问号（，。；：！？）、
 *  全角括号（（）、顿号（、）与半角逗号（,）。 */
const BARE_COMMAND_RE = /(?:^|[\s　，。；：！？、（(、,])\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;

/** 挖掉节内所有反引号片段后，扫裸写斜杠命令。
 *  反引号挖除按行处理、不跨行配对：一行内配不上的落单反引号只吞到本行尾（否则跨行配对会把
 *  行间的裸写命令吞掉 ⇒ 漏红）；命中候选后紧跟第二个 / 的不算命令（/usr/bin/env 是路径）。
 *  入参是已过围栏挖除的文本（stripFencedBlocks 的产物），这里只管行内反引号。 */
function scanBareCommands(section) {
  const stripped = section.split(/\r?\n/).map(stripLineBackticks).join('\n');
  const out = [];
  for (const m of stripped.matchAll(BARE_COMMAND_RE)) {
    const after = stripped[m.index + m[0].length] || '';
    if (after === '/') continue;
    out.push(m[1]);
  }
  return out;
}

/** 逐行剔除反引号片段：配对 `...` 挖掉，落单的反引号（奇数个）只吞到本行尾。 */
function stripLineBackticks(line) {
  let out = '', inTick = false;
  for (const ch of line) { if (ch === '`') inTick = !inTick; else if (!inTick) out += ch; }
  return out;
}

/** 围栏状态机：以行首三个反引号（^\s*```）为界，成对切换 in/out，fence 内容整块挖除（含边界行）。
 *  未闭合的 fence 视为一直开到节尾（方向是漏检不是误红）。必须在按行 toggle 之前执行。 */
function stripFencedBlocks(section) {
  const lines = section.split(/\r?\n/);
  let inFence = false;
  const out = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (!inFence) out.push(line);
  }
  return out.join('\n');
}

function hasImplementation(repoRoot, n) {
  return existsSync(join(repoRoot, 'ccswitch', 'commands', `${n}.md`)) || existsSync(join(repoRoot, 'ccswitch', 'skills', n, 'SKILL.md'));
}

/**
 * 闸㈡：ccswitch/skills 下每个应部署的 skill 都必须在 ~/.claude/skills 有活链。
 * 排除清单唯一真相源是 dao.ps1 的 Get-InternalOnlySkills（return @( ... ) 里的双引号名）。
 * 判「活链」只认两件事：lstat 是链接型 + existsSync 为真（existsSync 跟随链接 ⇒ 假即悬空链）。
 * 不许要求 target 指向 repoRoot —— 本仓平时在 git worktree 里工作，链指向主仓。
 */
export function checkSkillsDeployed({ repoRoot, homeDir }) {
  const claudeDir = join(homeDir, '.claude');
  if (!existsSync(claudeDir)) {
    return { fails: [], greens: [`skill 部署面 跳过：${claudeDir} 不在（非部署环境，本项没查）`] };
  }

  // 上下文判据：只有当前仓就是部署源仓时，「缺链」才是真漂移。
  // dao 的部署真相源是主仓，~/.claude 的链全指向那里；在一个还没合并的 feature
  // worktree 里跑体检，本树新增/改名的 skill 必然还没被部署——那是正常态不是缺陷。
  // 从 ~/.claude/skills 的链接型条目 target（<仓根>/ccswitch/skills/<name>）推出
  // 部署源仓集合 S（去重后比较，规范化逻辑见 normalizePath）；S 为空 ⇒ 判红（零样本闸）。
  // 判据是「repoRoot ∈ S 才走检查」而非多数票：外来链只能让 S 变大，永远不能把
  // repoRoot 从 S 里挤出去，投票污染这条攻击面直接不存在。
  const claudeSkills = join(claudeDir, 'skills');
  const deploySources = collectDeploySourceRoots(claudeSkills);
  if (deploySources.size === 0) {
    return {
      fails: [['一条 dao skill 链都没有', '跑 .\\dao.bat --deploy（等效 dao.ps1 link-claude）', claudeSkills]],
      greens: [],
    };
  }
  if (!deploySources.has(normalizePath(repoRoot))) {
    return {
      fails: [],
      greens: [`skill 部署面 跳过：本仓不是部署源仓（源=${[...deploySources.values()].join(', ')}），未合并的分支/worktree 里缺链是正常态，本项没查`],
    };
  }

  const ps1Path = join(repoRoot, 'dao.ps1');
  let excluded = [];
  try {
    excluded = extractExcludedFromPs1(readFileSync(ps1Path, 'utf8'));
  } catch {
    excluded = [];
  }
  if (excluded.length === 0) {
    return {
      fails: [['skill 排除清单解析出 0 条', 'dao.ps1 的 Get-InternalOnlySkills 与解析器漂移 ⇒ 本次等于没查；核 return @( ... ) 双引号清单', ps1Path]],
      greens: [],
    };
  }

  const skillsDir = join(repoRoot, 'ccswitch', 'skills');
  if (!existsSync(skillsDir)) {
    return {
      fails: [['skill 部署源 ccswitch/skills 不在', '本次没查成，不是没问题：确认部署源目录是否被移动', skillsDir]],
      greens: [],
    };
  }
  const all = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory());
  const shouldDeploy = all.filter((n) => !excluded.includes(n));
  if (shouldDeploy.length === 0) {
    return {
      fails: [['应部署 skill 集 0 条', 'ccswitch/skills 全被排除或为空 ⇒ 本次等于没查；核 Get-InternalOnlySkills 清单', skillsDir]],
      greens: [],
    };
  }

  const missing = shouldDeploy.filter((n) => !isAliveLink(join(claudeSkills, n), n));
  if (missing.length === 0) {
    return { fails: [], greens: [`skill 部署面 ${shouldDeploy.length} 个全部有活链`] };
  }
  return {
    fails: [[`未部署的 skill ${missing.length} 个`, '跑 .\\dao.bat --deploy（等效 dao.ps1 link-claude）', missing.join(' ')]],
    greens: [],
  };
}

/** 从 dao.ps1 抽 Get-InternalOnlySkills 的 return @( ... ) 里双引号清单；抽不到 ⇒ []（交给零样本闸判红）。
 *  解析契约（防注释抢占）：① 先逐行剔注释（每行第一个 # 及其后丢掉；前提：清单里的名字不含 #，
 *  故不必处理引号内 # 的复杂情形）；② 截函数体（到下一个 ^function 或文件尾）；③ 在函数体内找
 *  return @( 并用括号配平找真正收尾的 )（不是第一个 )）；④ 只在该数组体内抽双引号名字。
 *  不认什么（改这段代码前必须知道）：本解析器不懂 PowerShell 字符串字面量——若函数体内出现
 *  单引号字符串如 'ex: return @( "alpha" )'（剔注释拦不住它），alpha 会被假排除成假绿。
 *  接受这个前提：在清单函数体里写这种字符串极不自然（与「名字不含 #」同档前提），真实清单
 *  不存在此形态；无引号名字的 return @( 形态已 fail-closed 零样本红兜底。 */
function extractExcludedFromPs1(ps1Src) {
  const stripped = stripPs1Comments(ps1Src);
  const fnMatch = stripped.match(/function Get-InternalOnlySkills\b/);
  if (!fnMatch) return [];
  const bodyStart = fnMatch.index + fnMatch[0].length;
  const nextFn = stripped.slice(bodyStart).search(/^function\b/m);
  const body = nextFn === -1 ? stripped.slice(bodyStart) : stripped.slice(bodyStart, bodyStart + nextFn);
  const retIdx = body.indexOf('return @(');
  if (retIdx === -1) return [];
  const open = retIdx + 'return @('.length;
  const close = findMatchingParen(body, open);
  if (close === -1) return [];
  const arrBody = body.slice(open, close);
  return [...arrBody.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** 逐行剔除 PowerShell 注释：每行第一个 # 及其后丢掉。 */
function stripPs1Comments(src) {
  return src.split(/\r?\n/).map((line) => {
    const h = line.indexOf('#');
    return h === -1 ? line : line.slice(0, h);
  }).join('\n');
}

/** 括号配平：从 open（'(' 的下一位）找配平的 ')' 下标；没配平 ⇒ -1。 */
function findMatchingParen(text, open) {
  let depth = 1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** 从链接 target（<仓根>/ccswitch/skills/<name>）推出部署源仓根：截到 ccswitch 之前那一段。 */
function deriveDeployRoot(target) {
  const m = String(target).match(/(.+)[/\\]ccswitch[/\\]skills[/\\][^/\\]+$/);
  return m ? m[1] : null;
}

/** 路径归一化：分隔符统一 /、去掉 \\?\ 长路径前缀（四字符 //?/）、小写（Windows 上 C:\x 与 c:/x 必须算同一个）。 */
function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\/\/\?\//, '').toLowerCase();
}

/** 收集所有链接型条目推出的部署源仓根（规范化去重）；返回 Map<normalizedKey, display>。 */
function collectDeploySourceRoots(claudeSkills) {
  const roots = new Map();
  if (existsSync(claudeSkills)) {
    for (const entry of readdirSync(claudeSkills)) {
      const p = join(claudeSkills, entry);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (!st.isSymbolicLink()) continue;
      let target;
      try { target = readlinkSync(p); } catch { continue; }
      const root = deriveDeployRoot(target);
      if (!root) continue;
      const key = normalizePath(root);
      if (!roots.has(key)) roots.set(key, root);
    }
  }
  return roots;
}

/** 活链 = lstat 链接型 + existsSync 为真（悬空即假）+ target 末段身份与 name 一致（大小写不敏感）
 *  + 目标下存在 SKILL.md 且是文件（目录不算）。刻意不要求 target 指向 repoRoot——worktree 兼容。 */
function isAliveLink(p, name) {
  try {
    const st = lstatSync(p);
    const target = readlinkSync(p);
    return st.isSymbolicLink() && existsSync(p) && isSameName(target, name) && statSync(join(target, 'SKILL.md')).isFile();
  } catch {
    return false;
  }
}

/** target 末段 basename 与 name 一致（规范化 + 大小写不敏感，Windows）。 */
function isSameName(target, name) {
  const base = String(target).split(/[\\/]/).pop() || '';
  return normalizePath(base) === normalizePath(name);
}
