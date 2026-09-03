// dao-check ㉘：飞书群有效性（issue #813）。
//
// 病：群 chat_id 过期或群已解散时，dao-check 照样绿，也指不出是哪个群。
//
// 发现面（帅 2026-09-03：真实 chat_id 不进仓，PR #806 审官要求）：
//   仓内 host/machine/feishu-groups.json = 占位模板，必须在（缺 = 没查成）。
//   实机映射 ~/.mirasim/keys/feishu-groups.json（600，换机手动带）。
//   live 优先读实机这份；没有 → SKIP「本机未接飞书」，不拿占位 key 去探（探了必红）。
//
// 闸：读实机 json 的 chat_id（`_` 开头是注释，不参与），逐个用
// `lark-cli im chats get --as bot --chat-id` 确认还在。
// 查不到 / 已解散 → 红，证据写出群名；全都在 → 绿。
// 无 lark-cli 或无凭据（CI 典型）→ SKIP，不是绿。
// 0 个 chat_id / 模板不在 / JSON 坏了 / 探头失败 → 没查成，不是「都在」。
//
// 检查器自持 JSON 解析与 lark-cli 信封分类，不 import feishu-triage 的
// loadGroups（自己查自己查不出错）。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const GROUPS_REL = 'host/machine/feishu-groups.json';
export const RUNTIME_GROUPS_REL = '.mirasim/keys/feishu-groups.json';
const FIX_RUNTIME = '把 ~/.mirasim/keys/feishu-groups.json 里失效的 chat_id 换成还活着的群（lark-cli im +chat-list --as bot），或删掉已解散的那一行';

const SPAWN_OPTS = { encoding: 'utf8', timeout: 20000 };

function firstJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* 可能有前缀诊断行 */ }
  const i = s.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i)); } catch { return null; }
}

function envelopeOf(r) {
  return firstJson(r && r.stdout) || firstJson(r && r.stderr)
    || firstJson(`${(r && r.stdout) || ''}\n${(r && r.stderr) || ''}`);
}

function isEnoent(r) {
  const err = r && r.error;
  if (!err) return false;
  const msg = String(err.message || err);
  return err.code === 'ENOENT' || /ENOENT/i.test(msg);
}

function ciMark(isCi) {
  return isCi ? '（CI 无法验证）' : '';
}

export function groupLabel(chatId, value) {
  const id = String(chatId || '');
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.name === 'string' && value.name.trim()) return `${value.name.trim()}（${id}）`;
    if (typeof value.repo === 'string' && value.repo.trim()) return `${value.repo.trim()}（${id}）`;
    if (value.kind === 'hub') return `总控群（${id}）`;
  }
  return id;
}

function isMissingChatError(err) {
  const code = err && err.code;
  const msg = String((err && err.message) || '');
  if (code === 99992356 || code === 232009 || code === 232006) return true;
  return /not exists|not a valid \{open_chat_id\}|invalid ids|已解散|不存在|dissolved/i.test(msg);
}

function isAuthError(err) {
  const type = String((err && err.type) || '');
  const subtype = String((err && err.subtype) || '');
  const msg = String((err && err.message) || '');
  return type === 'authorization'
    || subtype === 'missing_scope'
    || /not logged in|unauthor|no credential|未登录|无凭据/i.test(msg);
}

/** 独立解析群表。不复用 feishu-triage.loadGroups。 */
export function parseGroupCatalog(src) {
  let j;
  try { j = JSON.parse(src); } catch (e) {
    return {
      kind: 'unscanned',
      fail: ['群映射表 JSON 坏了', '修 host/machine/feishu-groups.json 的 JSON 语法', String(e.message || e).slice(0, 160)],
    };
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    return {
      kind: 'unscanned',
      fail: ['群映射表根不是对象', '应为 { chat_id: { repo, kind } }', `typeof=${j == null ? String(j) : Array.isArray(j) ? 'array' : typeof j}`],
    };
  }
  const groups = [];
  for (const [id, v] of Object.entries(j)) {
    if (id.startsWith('_')) continue;
    groups.push({ chatId: id, label: groupLabel(id, v) });
  }
  if (groups.length === 0) {
    return {
      kind: 'unscanned',
      fail: ['一个飞书群都没扫到', 'json 里 0 个 chat_id（_ 注释键不算）⇒ 本次等于没查，不是都在', '0'],
      groups: [],
    };
  }
  return { kind: 'ok', groups };
}

export function readGroupCatalog(file) {
  if (!file || !existsSync(file)) {
    return {
      kind: 'unscanned',
      fail: ['群映射表不在', '恢复 host/machine/feishu-groups.json；缺文件 = 没查成', String(file || '')],
    };
  }
  let src;
  try { src = readFileSync(file, 'utf8'); } catch (e) {
    return {
      kind: 'unscanned',
      fail: ['群映射表读不了', '本次没查成，不是没问题', String(e.message || e).slice(0, 160)],
    };
  }
  return parseGroupCatalog(src);
}

export function classifyAuthStatus(r, { isCi = false } = {}) {
  const ci = ciMark(isCi);
  if (isEnoent(r)) return { kind: 'skip', reason: `无 lark-cli${ci}` };
  if (r && r.error) {
    return { kind: 'unscanned', error: `auth status spawn 失败：${String(r.error.message || r.error).slice(0, 120)}` };
  }
  const j = envelopeOf(r);
  if (!j) {
    const text = `${(r && r.stdout) || ''}${(r && r.stderr) || ''}`.trim();
    if (!text) return { kind: 'unscanned', error: 'auth status 无输出（没查成）' };
    return { kind: 'unscanned', error: `auth status 输出不是 JSON：${text.slice(0, 120)}` };
  }
  if (j.ok === false) {
    const err = j.error && typeof j.error === 'object' ? j.error : {};
    if (isAuthError(err)) return { kind: 'skip', reason: `无凭据${ci}` };
    return { kind: 'unscanned', error: `auth status 失败：${String(err.message || JSON.stringify(err)).slice(0, 120)}` };
  }
  const bot = j.identities && typeof j.identities === 'object' ? j.identities.bot : null;
  if (!bot || bot.available !== true || (bot.status && bot.status !== 'ready')) {
    return { kind: 'skip', reason: `无凭据${ci}` };
  }
  return { kind: 'ready' };
}

export function classifyChatGet(r, chatId) {
  if (isEnoent(r)) return { kind: 'skip', reason: '无 lark-cli' };
  if (r && r.error) {
    return { kind: 'unscanned', error: `spawn 失败：${String(r.error.message || r.error).slice(0, 120)}` };
  }
  const j = envelopeOf(r);
  if (!j) {
    const text = `${(r && r.stdout) || ''}${(r && r.stderr) || ''}`.trim();
    if (!text) return { kind: 'unscanned', error: 'lark-cli 无输出（没查成）' };
    return { kind: 'unscanned', error: `输出不是 JSON：${text.slice(0, 120)}` };
  }
  if (j.ok === true) {
    const data = j.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { kind: 'unscanned', error: '成功信封缺 data 对象（没查成）' };
    }
    if (!Object.prototype.hasOwnProperty.call(data, 'chat_status')
        || data.chat_status == null || String(data.chat_status).trim() === '') {
      return { kind: 'unscanned', error: '成功信封缺 chat_status（没查成）' };
    }
    const status = String(data.chat_status);
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (status === 'normal') {
      return { kind: 'exists', name: name || String(chatId || ''), status };
    }
    if (status === 'dissolved' || status === 'dissolved_save') {
      return { kind: 'missing', name: name || String(chatId || ''), reason: `已解散或状态=${status}` };
    }
    return { kind: 'unscanned', error: `chat_status 不认识：${status}（没查成）` };
  }
  const err = j.error && typeof j.error === 'object' ? j.error : {};
  if (isAuthError(err)) return { kind: 'skip', reason: '无凭据' };
  if (isMissingChatError(err)) return { kind: 'missing', name: String(chatId || ''), reason: '查不到或已解散' };
  return { kind: 'unscanned', error: `lark-cli 报错：${String(err.message || JSON.stringify(err)).slice(0, 120)}` };
}

export function runAuthStatus(spawn = spawnSync) {
  return spawn('lark-cli', ['auth', 'status', '--json'], SPAWN_OPTS);
}

export function runChatGet(chatId, spawn = spawnSync) {
  return spawn('lark-cli', ['im', 'chats', 'get', '--as', 'bot', '--chat-id', String(chatId), '--json'], SPAWN_OPTS);
}

/**
 * 纯判官：已解析的群清单 + 探头。
 * probeChat(chatId) → classifyChatGet 的返回。
 * preflight() → classifyAuthStatus 的返回（可选）。
 */
export function inspectFeishuGroups({ groups, probeChat, preflight, fixHow } = {}) {
  if (!Array.isArray(groups)) {
    return { kind: 'unscanned', fail: ['没给群清单', '本次没查成', 'groups 不是数组'] };
  }
  if (groups.length === 0) {
    return {
      kind: 'unscanned',
      fail: ['一个飞书群都没扫到', 'json 里 0 个 chat_id ⇒ 本次等于没查，不是都在', '0'],
    };
  }
  if (typeof preflight === 'function') {
    const p = preflight();
    if (p && p.kind === 'skip') return { kind: 'skip', skip: `飞书群有效性：${p.reason}` };
    if (!p || p.kind !== 'ready') {
      return {
        kind: 'unscanned',
        fail: ['飞书凭据预检没查成', 'lark-cli auth status --json 要能跑；失败不是没问题', (p && p.error) || ''],
      };
    }
  }
  if (typeof probeChat !== 'function') {
    return { kind: 'unscanned', fail: ['没给查群探头', '本次没查成', 'probeChat'] };
  }
  const missing = [];
  const names = [];
  for (const g of groups) {
    const r = probeChat(g.chatId);
    if (r && r.kind === 'skip') return { kind: 'skip', skip: `飞书群有效性：${r.reason}` };
    if (!r || r.kind === 'unscanned') {
      return {
        kind: 'unscanned',
        fail: [
          '飞书群有效性没查成',
          'lark-cli im chats get --as bot 必须能跑出 JSON；失败不是没问题',
          `${g.label}: ${(r && r.error) || '探头无结果'}`,
        ],
      };
    }
    if (r.kind === 'missing') missing.push(g.label);
    else names.push(r.name || g.label);
  }
  if (missing.length) {
    return {
      kind: 'red',
      fail: [
        `飞书群查不到或已解散 ${missing.length} 个`,
        fixHow || FIX_RUNTIME,
        missing.join('；'),
      ],
      missing,
      scanned: groups.length,
    };
  }
  return {
    kind: 'ok',
    green: `飞书群 ${names.length} 个都在：${names.join('、')}`,
    names,
    scanned: groups.length,
  };
}

export function makeProbeSpawn(probes) {
  const map = probes && typeof probes === 'object' ? probes : {};
  return (cmd, args) => {
    if (String(cmd) !== 'lark-cli') {
      const e = new Error('spawn ENOENT');
      e.code = 'ENOENT';
      return { error: e, status: null, stdout: '', stderr: '' };
    }
    if (Array.isArray(args) && args[0] === 'auth') {
      if (map.__enoent) {
        const e = new Error('spawn lark-cli ENOENT');
        e.code = 'ENOENT';
        return { error: e, status: null, stdout: '', stderr: '' };
      }
      if (map.__noAuth) {
        return {
          status: 1, stdout: '', error: null,
          stderr: JSON.stringify({ ok: false, error: { type: 'authorization', message: 'not logged in' } }),
        };
      }
      return {
        status: 0, stderr: '', error: null,
        stdout: JSON.stringify({ ok: true, identities: { bot: { available: true, status: 'ready' } } }),
      };
    }
    const i = Array.isArray(args) ? args.indexOf('--chat-id') : -1;
    const id = i >= 0 ? args[i + 1] : '';
    const env = map[id];
    if (!env) {
      return {
        status: 1, stdout: '', error: null,
        stderr: JSON.stringify({ ok: false, error: { type: 'api', code: 99992356, message: 'not exists' } }),
      };
    }
    if (env.ok) return { status: 0, stdout: JSON.stringify(env), stderr: '', error: null };
    return { status: 1, stdout: '', stderr: JSON.stringify(env), error: null };
  };
}

export function checkFeishuGroups({ root, home, spawn = spawnSync, isCi = false } = {}) {
  if (!root) return { kind: 'unscanned', fail: ['没给仓库根', '本次没查成', ''] };
  const template = readGroupCatalog(join(root, GROUPS_REL));
  if (template.kind === 'unscanned') return template;
  const homeDir = home == null ? (process.env.HOME || process.env.USERPROFILE || '') : home;
  const runtime = homeDir ? join(homeDir, RUNTIME_GROUPS_REL) : '';
  if (!runtime || !existsSync(runtime)) {
    return {
      kind: 'skip',
      skip: `飞书群有效性：本机未接飞书（无 ~/.mirasim/keys/feishu-groups.json）${ciMark(isCi)}`,
    };
  }
  const cat = readGroupCatalog(runtime);
  if (cat.kind === 'unscanned') return cat;
  return inspectFeishuGroups({
    groups: cat.groups,
    preflight: () => classifyAuthStatus(runAuthStatus(spawn), { isCi }),
    probeChat: (id) => classifyChatGet(runChatGet(id, spawn), id),
    fixHow: FIX_RUNTIME,
  });
}

/** 夹具判别力：red 必须抓出失效群、ok 必须绿、empty 必须标没查成。 */
export function inspectFeishuGroupsFixtures(root) {
  if (!root) return { ok: false, unscanned: true, error: '没给样本根目录' };
  if (!existsSync(root)) return { ok: false, unscanned: true, error: `样本目录不在：${root}` };
  const kinds = { red: 0, ok: 0, empty: 0 };
  const problems = [];
  for (const kind of ['red', 'ok', 'empty']) {
    const dir = join(root, kind);
    if (!existsSync(dir)) { problems.push(`缺 ${kind}/`); continue; }
    const groupsFile = join(dir, 'groups.json');
    if (!existsSync(groupsFile)) { problems.push(`${kind}/ 缺 groups.json`); continue; }
    let src;
    try { src = readFileSync(groupsFile, 'utf8'); } catch (e) {
      problems.push(`${kind}/ 读不了：${e.message || e}`);
      continue;
    }
    const cat = parseGroupCatalog(src);
    if (kind === 'empty') {
      if (cat.kind !== 'unscanned') problems.push('empty/ 没标没查成');
      else kinds.empty += 1;
      continue;
    }
    if (cat.kind === 'unscanned') {
      problems.push(`${kind}/ 清单没查成：${(cat.fail || []).join(' ')}`);
      continue;
    }
    const probesFile = join(dir, 'probes.json');
    if (!existsSync(probesFile)) { problems.push(`${kind}/ 缺 probes.json`); continue; }
    let probes;
    try { probes = JSON.parse(readFileSync(probesFile, 'utf8')); } catch (e) {
      problems.push(`${kind}/ probes.json 坏了：${e.message || e}`);
      continue;
    }
    const spawn = makeProbeSpawn(probes);
    const r = inspectFeishuGroups({
      groups: cat.groups,
      preflight: () => classifyAuthStatus(runAuthStatus(spawn)),
      probeChat: (id) => classifyChatGet(runChatGet(id, spawn), id),
    });
    if (kind === 'red') {
      if (r.kind !== 'red') problems.push(`red/ 自称该红但判成 ${r.kind}`);
      else if (!/dissolved-sample/.test((r.fail || []).join(' '))) problems.push('red/ 没点出 dissolved-sample');
      else kinds.red += 1;
    }
    if (kind === 'ok') {
      if (r.kind !== 'ok') problems.push(`ok/ 自称该绿但判成 ${r.kind}：${(r.fail || []).join(' ')}`);
      else kinds.ok += 1;
    }
  }
  if (kinds.red === 0 || kinds.ok === 0 || kinds.empty === 0) {
    return {
      ok: false, unscanned: true,
      error: `样本种类不够 red=${kinds.red} ok=${kinds.ok} empty=${kinds.empty}`,
      kinds, problems,
    };
  }
  if (problems.length) return { ok: false, unscanned: false, error: problems[0], kinds, problems };
  return { ok: true, unscanned: false, kinds };
}
