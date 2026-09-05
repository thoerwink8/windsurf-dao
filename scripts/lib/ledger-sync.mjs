// scripts/lib/ledger-sync.mjs —— 跨机账本汇聚：按需拉取（设计 A / A.2，issue #891 期二）
//
// 病：事件账本机优先、不进 git（见 ledger-home.mjs），于是「另一台机器干了什么」在本机零落点，
// 要带走只能手动拷目录。汇聚机制一直挂着，看板与播报面就没法「同读一份账」。
//
// 药：一条命令按需从别的机器拉事件，把并集落到本机账本目录。汇聚 = 按文件名求并集
// （设计 A.2：与当年 git merge 同一性质），不改历史、不动已有文件。
//
// 不变量（破了就是 bug，不是风格问题）：
//  ① 一事件一文件 <ulid>-<machine>.json，**内容决定名**（event-writer 用事件内容哈希当 ULID 熵）。
//     所以「同名」= 同一事件，同名跳过是安全的。
//  ② 不可变：已存在的文件永不覆盖。纠错走 attr.retract 追加，不改历史。
//  ③ 全序键 (ts, machine, seq, event_id)：排序判据只有一份，在 ledger-query.mjs，这里直接用。
//  ④ 幂等：重复拉取零副作用，输出「新增 N / 跳过 M」。
//
// 同名判等按**解析后的规范化 JSON**，不按字节。2026-09-04 实咬：本机 834 个事件是 git 检出
// 的种子（CRLF），服务器同名同事件是 LF——字节比会把 441 个同一事件全判成冲突。
//
// 「内容决定名」有一个既有例外：事件被就地脱敏后（dao-redact --in-place）内容变了、名字还是老的。
// 本机实测 834 个里 1 个如此。所以名字与内容对不上只报 suspect（点名，不拦），
// 真冲突只认「同名 + 规范化内容不同」。
//
// 传输跟着现有基建走：ssh（用本机 ssh 配置里的 Host 别名，免密可登）+ 远端 sh + base64，一次连接一批文件。
// 不引新依赖、不开端口、不留常驻进程。远端脚本自带哨兵头尾行，「没查成」和「查过是 0 条」分得开。

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, relative, basename, isAbsolute } from 'node:path';
import { basename as posixBase } from 'node:path/posix';
import { basename as winBase } from 'node:path/win32';
import { canonicalStringify, sha256Hex } from './dianjiangtai-core.mjs';
import { ulidFromMs } from './event-writer.mjs';
import { compareEvents } from './ledger-query.mjs';

// ── 纯函数层：名字 / 判等 / 计划 / 分类 / 合并 / 排序 ───────────────────────

/** 事件文件名形态：26 位 Crockford base32 的 ULID + `-` + 机器名 + `.json`。
 *  machine 只许 `[A-Za-z0-9._-]`，整段不是 `.` / `..`。`(.+)` 会把 `01…-../../outside.json`
 *  认成合法事件名，join 之后逃出账本目录。Linux 上 `\\` 不是分隔符，所以还要同时等于
 *  posix/win32 basename，Windows 写法 `..\\..\\outside.json` 才拦得住。 */
export const EVENT_NAME_RE = /^([0-9A-HJKMNP-TV-Z]{26})-([A-Za-z0-9._-]+)\.json$/;

/** 来件名必须是账本目录里的单段文件名，不能带路径组件。远端即使受信也不许靠远端自觉。
 *  含路径组件（`/` `\\` NUL、绝对路径、非 basename）——列表/打包流里见到就整份作废。 */
export function hasPathComponent(name) {
  const s = String(name || '');
  if (!s) return true;
  if (s.includes('/') || s.includes('\\') || s.includes('\0') || isAbsolute(s)) return true;
  // Linux 上 `\\` 不是分隔符：平台 basename 拦不住 Windows 写法，必须双边验。
  if (posixBase(s) !== s || winBase(s) !== s || basename(s) !== s) return true;
  return false;
}

export function isSafeEventName(name) {
  const s = String(name || '');
  if (!s || hasPathComponent(s)) return false;
  if (/\s/.test(s)) return false; // bundle 按空格拆 name/base64，名字里不许有空白
  const m = EVENT_NAME_RE.exec(s);
  if (!m) return false;
  if (m[2] === '.' || m[2] === '..') return false;
  return true;
}

export function parseEventName(name) {
  if (!isSafeEventName(name)) return null;
  const m = EVENT_NAME_RE.exec(String(name));
  if (!m) return null;
  return { ulid: m[1], machine: m[2] };
}

/** 来件名 → 账本目录内的绝对路径。逃出目录或名字非法一律 ok:false，不拼 path。 */
export function eventPathInDir(dir, name) {
  if (dir == null || dir === '') return { ok: false, why: '没给账本目录' };
  if (!isSafeEventName(name)) {
    return { ok: false, why: '文件名不是安全的 <ulid>-<machine>.json basename（禁 / \\ ..）' };
  }
  const root = resolve(String(dir));
  const dest = resolve(root, name);
  const rel = relative(root, dest);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, why: `解析后的路径逃出账本目录：${name}` };
  }
  if (posixBase(name) !== name || winBase(name) !== name || basename(dest) !== name) {
    return { ok: false, why: `解析后的文件名与来件不一致：${name}` };
  }
  return { ok: true, path: dest };
}

/**
 * 事件文本 → 身份。规范化 JSON（键排序）当判等依据，所以 CRLF/缩进/键序差异不算不同。
 * 坏 JSON、非对象、缺全序键骨架字段都拿不到身份——拿不到就不许进账。
 */
export function eventIdentity(text) {
  let event;
  try {
    event = JSON.parse(String(text));
  } catch (e) {
    return { ok: false, why: `不是 JSON：${String(e.message || e).slice(0, 80)}` };
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, why: '不是 JSON 对象' };
  }
  const missing = ['type', 'ts', 'machine', 'seq', 'event_id'].filter(k => event[k] === undefined);
  if (missing.length) return { ok: false, why: `缺骨架字段 ${missing.join('/')}` };
  const canonical = canonicalStringify(event);
  return { ok: true, event, canonical, fingerprint: sha256Hex(canonical) };
}

/** 同名判等：规范化内容相同即同一事件。两边任一拿不到身份 → 判不了（不许当「相同」）。 */
export function sameEvent(aText, bText) {
  const a = eventIdentity(aText);
  const b = eventIdentity(bText);
  if (!a.ok || !b.ok) return { decided: false, why: a.ok ? `对照方 ${b.why}` : `来件 ${a.why}` };
  return { decided: true, same: a.fingerprint === b.fingerprint };
}

/** 内容反推文件名（event-writer 确定性命名的逆核）。脱敏改写过的老事件会对不上，只报 suspect。 */
export function expectedEventName(event) {
  if (!event || typeof event.ts !== 'string' || typeof event.machine !== 'string') return null;
  const ms = Date.parse(event.ts);
  if (Number.isNaN(ms)) return null;
  const entropy = sha256Hex(canonicalStringify(event)).slice(0, 20);
  return `${ulidFromMs(ms, entropy)}-${event.machine}.json`;
}

/**
 * 拉取计划：远端名字集 ∖ 本机名字集。
 * verify=true 时连本机已有的也一起拉回来比内容（审计用；默认不拉，同名即同一事件）。
 * 非事件名（.dispatch-index、临时件等）一律不拉，点名进 ignored。
 * 形态像事件（.json）但 parseEventName 失败（含 ../ 等）进 rejected，不进 ignored。
 */
export function planFetch({ localNames = [], remoteNames = [], verify = false } = {}) {
  const local = new Set(localNames);
  const fetch = [];
  const skip = [];
  const ignored = [];
  const rejected = [];
  for (const name of remoteNames) {
    if (!parseEventName(name)) {
      // ignored 是给 .dispatch-index 这类「本来就不是事件」的 ok 桶。
      // 形态像事件（.json）但名字不安全 → rejected，不许报「拉过且没事」。
      if (/\.json$/i.test(String(name || ''))) rejected.push(name);
      else ignored.push(name);
      continue;
    }
    if (!local.has(name)) fetch.push(name);
    else if (verify) fetch.push(name);
    else skip.push(name);
  }
  fetch.sort();
  skip.sort();
  return { fetch, skip, ignored, rejected, verify: !!verify };
}

/**
 * 一件来件的处置：add（本机没有）/ skip（同名且同内容）/ conflict（同名不同内容）/ reject（进不了账）。
 * conflict 是真红：同名意味着同一事件，内容却不同 ⇒ 有一边的历史被改过。
 */
export function classifyIncoming({ name, text, localText }) {
  if (!isSafeEventName(name) || !parseEventName(name)) {
    return { name, action: 'reject', why: '文件名不是安全的 <ulid>-<machine>.json basename（禁 / \\ ..）' };
  }
  const id = eventIdentity(text);
  if (!id.ok) return { name, action: 'reject', why: id.why };
  const want = expectedEventName(id.event);
  const suspect = want && want !== name ? `名字与内容对不上（内容应叫 ${want}）` : null;
  if (localText === undefined || localText === null) {
    return { name, action: 'add', text, event: id.event, fingerprint: id.fingerprint, suspect };
  }
  const cmp = sameEvent(text, localText);
  if (!cmp.decided) return { name, action: 'reject', why: `同名文件比不了：${cmp.why}` };
  if (cmp.same) return { name, action: 'skip', why: '同名同内容', fingerprint: id.fingerprint, suspect };
  const localId = eventIdentity(localText);
  return {
    name,
    action: 'conflict',
    why: '同名不同内容——同名即同一事件，此处必有一边改过历史',
    fingerprint: id.fingerprint,
    localFingerprint: localId.ok ? localId.fingerprint : null,
    suspect,
  };
}

/**
 * 合并一批来件（纯函数，不碰盘）：localTexts 是「本机已有的 名字→文本」，incoming 是拉回来的。
 * 返回四类明细 + 计数；同一批里重复出现的同名来件按第一件算，后面的按 skip/conflict 判。
 */
export function mergeIncoming({ localTexts = new Map(), incoming = [] } = {}) {
  const seen = new Map(localTexts instanceof Map ? localTexts : Object.entries(localTexts || {}));
  const added = [];
  const skipped = [];
  const conflicts = [];
  const rejected = [];
  const suspects = [];
  for (const item of incoming) {
    const name = item && item.name;
    const r = classifyIncoming({ name, text: item && item.text, localText: seen.get(name) });
    if (r.suspect) suspects.push({ name, why: r.suspect });
    if (r.action === 'add') {
      added.push(r);
      seen.set(name, r.text); // 同批次内也不许重复添加同一文件名
    } else if (r.action === 'skip') skipped.push(r);
    else if (r.action === 'conflict') conflicts.push(r);
    else rejected.push(r);
  }
  return {
    added,
    skipped,
    conflicts,
    rejected,
    suspects,
    counts: {
      added: added.length,
      skipped: skipped.length,
      conflicts: conflicts.length,
      rejected: rejected.length,
    },
  };
}

/** 全序排序（设计 A.2 的 (ts, machine, seq, event_id)）。判据只有一份，在 ledger-query.mjs。 */
export function sortEvents(events) {
  return (events || []).slice().sort(compareEvents);
}

// ── 远端命令层：脚本是纯函数（可测），执行走注入的 run（可假造）────────────

export const LIST_SENTINEL = 'DAO_LEDGER_LIST v1';
export const LIST_END_PREFIX = 'DAO_LEDGER_LIST_END';
export const BUNDLE_SENTINEL = 'DAO_LEDGER_BUNDLE v1';
export const BUNDLE_END_PREFIX = 'DAO_LEDGER_BUNDLE_END';
export const NODIR_SENTINEL = 'DAO_LEDGER_NODIR';
export const NOREAD_SENTINEL = 'DAO_LEDGER_NOREAD';
export const DEFAULT_REMOTE_DIR = '~/.dao/ledger/events';

/** POSIX sh 单引号转义。 */
export function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * 远端目录表达式：~/... 交给远端 $HOME 展开（各机用户不同，不许在本机拼死）；
 * 其余按字面量单引号包住。展开路径里不许出现 " $ 反引号 \ ——那是注入面。
 */
export function remoteDirExpr(dir) {
  const d = String(dir || DEFAULT_REMOTE_DIR);
  if (d === '~' || d.startsWith('~/')) {
    const rest = d.slice(1).replace(/^\//, '');
    if (/["$`\\]/.test(rest)) throw new Error(`远端目录里有不许出现的字符：${d}`);
    return rest ? `"$HOME/${rest}"` : '"$HOME"';
  }
  return shQuote(d);
}

/**
 * 列远端事件名。头行哨兵 + **尾行条数**：少了尾行就是流被截断，条数对不上就是丢了行，
 * 两种都判没查成，不许当「远端 0 条」（审官 P1①）。
 *
 * 不用 `ls | grep || true`：那个写法把列举错误（没权限、I/O 错）吞成空列表。
 * 改成 glob 自己数，并在开头显式验目录可读可进——不可读时 glob 会退化成字面量、
 * 看起来就像「空目录」，所以必须先拿 NOREAD 哨兵把这条路堵死。
 */
export function remoteListScript(dir) {
  return [
    `d=${remoteDirExpr(dir)}`,
    `[ -d "$d" ] || { echo ${NODIR_SENTINEL}; exit 3; }`,
    `[ -r "$d" ] && [ -x "$d" ] || { echo ${NOREAD_SENTINEL}; exit 5; }`,
    `echo ${shQuote(LIST_SENTINEL)}`,
    'n=0',
    'for f in "$d"/*.json; do [ -e "$f" ] || continue; printf ' + "'%s\\n'" + ' "${f##*/}"; n=$((n+1)); done',
    `printf '${LIST_END_PREFIX} %s\\n' "$n"`,
  ].join('; ');
}

/** 按 stdin 给的名单读文件，每行 `<名字> <base64>`；尾行报条数，截断查得出来。 */
export function remoteBundleScript(dir) {
  return [
    `d=${remoteDirExpr(dir)}`,
    `[ -d "$d" ] || { echo ${NODIR_SENTINEL}; exit 3; }`,
    `[ -r "$d" ] && [ -x "$d" ] || { echo ${NOREAD_SENTINEL}; exit 5; }`,
    `echo ${shQuote(BUNDLE_SENTINEL)}`,
    'n=0',
    'while IFS= read -r f; do ' +
      '[ -f "$d/$f" ] || { echo "MISS $f"; continue; }; ' +
      "printf '%s ' \"$f\"; " +
      'base64 -w0 -- "$d/$f" || exit 4; ' +
      "printf '\\n'; " +
      'n=$((n+1)); ' +
    'done',
    "printf 'DAO_LEDGER_BUNDLE_END %s\\n' \"$n\"",
  ].join('; ');
}

/**
 * 列表 stdout → 名字。三道验：头行哨兵、尾行哨兵、尾行条数 == 实收行数。
 * 任一不过都判没查成——ssh 吐了头行就断线、远端目录没权限，都不是「0 条」（审官 P1①）。
 */
export function parseRemoteList(stdout) {
  const lines = String(stdout == null ? '' : stdout).split(/\r?\n/);
  if (lines.some(l => l.trim() === NODIR_SENTINEL)) {
    return { unscanned: true, error: '远端账本目录不在', names: [] };
  }
  if (lines.some(l => l.trim() === NOREAD_SENTINEL)) {
    return { unscanned: true, error: '远端账本目录读不了（权限）——不是 0 条', names: [] };
  }
  const at = lines.findIndex(l => l.trim() === LIST_SENTINEL);
  if (at < 0) return { unscanned: true, error: '远端没吐哨兵头行（命令没跑成，不是 0 条）', names: [] };
  const names = [];
  let declared = null;
  for (const raw of lines.slice(at + 1)) {
    const line = raw.trim();
    if (!line) continue;
    const end = new RegExp(`^${LIST_END_PREFIX} (\\d+)$`).exec(line);
    if (end) {
      declared = Number(end[1]);
      continue;
    }
    if (declared !== null) {
      return { unscanned: true, error: `尾行之后还有内容（协议乱了）：${line.slice(0, 40)}`, names };
    }
    // 含路径组件的名字不是「非事件忽略项」——那是逃逸，整份名单作废。
    // `.dispatch-index` 这类本机索引仍进 names，由 planFetch 点名进 ignored。
    if (hasPathComponent(line)) {
      return {
        unscanned: true,
        error: `远端名单有路径逃逸/非法文件名：${line.slice(0, 80)}`,
        names,
      };
    }
    names.push(line);
  }
  if (declared === null) {
    return { unscanned: true, error: '列表没尾行哨兵（吐了头行就断了 ⇒ 流被截断，不是 0 条）', names };
  }
  if (declared !== names.length) {
    return { unscanned: true, error: `尾行说 ${declared} 个、实收 ${names.length} 个（列表不完整）`, names };
  }
  return { unscanned: false, names, declared };
}

/** 打包 stdout → [{name,text}]。头行、尾行条数、base64 三处任一对不上都算没查成。 */
export function parseRemoteBundle(stdout, { requested } = {}) {
  const asked = requested == null ? null : new Set(requested);
  const lines = String(stdout == null ? '' : stdout).split(/\r?\n/);
  if (lines.some(l => l.trim() === NODIR_SENTINEL)) {
    return { unscanned: true, error: '远端账本目录不在', files: [], missing: [] };
  }
  if (lines.some(l => l.trim() === NOREAD_SENTINEL)) {
    return { unscanned: true, error: '远端账本目录读不了（权限）', files: [], missing: [] };
  }
  const at = lines.findIndex(l => l.trim() === BUNDLE_SENTINEL);
  if (at < 0) return { unscanned: true, error: '远端没吐哨兵头行（命令没跑成）', files: [], missing: [] };
  const files = [];
  const missing = [];
  let declared = null;
  for (const raw of lines.slice(at + 1)) {
    const line = raw.trim();
    if (!line) continue;
    const end = /^DAO_LEDGER_BUNDLE_END (\d+)$/.exec(line);
    if (end) {
      declared = Number(end[1]);
      continue;
    }
    if (line.startsWith('MISS ')) {
      const missName = line.slice(5);
      if (hasPathComponent(missName)) {
        return {
          unscanned: true,
          error: `打包流 MISS 名有路径逃逸：${missName.slice(0, 80)}`,
          files,
          missing,
        };
      }
      missing.push(missName);
      continue;
    }
    const sp = line.indexOf(' ');
    if (sp <= 0) return { unscanned: true, error: `打包流有认不出的行：${line.slice(0, 40)}`, files, missing };
    const name = line.slice(0, sp);
    const b64 = line.slice(sp + 1);
    // 传输中的 name 必须是安全 basename，且必须在这次请求名单里；不靠列表端已经滤过。
    if (!isSafeEventName(name)) {
      return {
        unscanned: true,
        error: `打包流有路径逃逸/非法文件名：${name.slice(0, 80)}`,
        files,
        missing,
      };
    }
    if (asked && !asked.has(name)) {
      return {
        unscanned: true,
        error: `打包流回了没请过的名字：${name.slice(0, 80)}`,
        files,
        missing,
      };
    }
    let text;
    try {
      const buf = Buffer.from(b64, 'base64');
      if (buf.length === 0 && b64.length > 0) throw new Error('base64 解不开');
      text = buf.toString('utf8');
    } catch (e) {
      return { unscanned: true, error: `${name} base64 解不开：${String(e.message || e).slice(0, 60)}`, files, missing };
    }
    files.push({ name, text });
  }
  if (declared === null) {
    return { unscanned: true, error: '打包流没尾行（流被截断了）', files, missing };
  }
  if (declared !== files.length) {
    return { unscanned: true, error: `尾行说 ${declared} 个、实收 ${files.length} 个（流被截断了）`, files, missing };
  }
  return { unscanned: false, files, missing, declared };
}

// ── 落盘层 ────────────────────────────────────────────────────────────────

/** 默认执行器：spawnSync。测试注入假的，不碰网。 */
export function defaultRun(cmd, args, { input, timeout = 120000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, timeout, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error) return { probed: false, reason: `spawn 失败：${r.error.code || r.error.message}` };
  if (r.signal) return { probed: false, reason: `被信号打断：${r.signal}（可能超时 ${timeout}ms）` };
  return { probed: true, code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function localEventNames(dir) {
  if (!dir || !existsSync(dir)) return { unscanned: true, error: `本机账本目录不在：${dir}`, names: [] };
  try {
    return { unscanned: false, names: readdirSync(dir).filter(f => f.endsWith('.json')) };
  } catch (e) {
    return { unscanned: true, error: `本机账本目录读不了：${String(e.message || e).slice(0, 100)}`, names: [] };
  }
}

/**
 * 写一件来件：原子写（同目录 .tmp + rename），已存在一律不覆盖（不可变律②）。
 * 写完立刻从盘上读回来核 event_id 与规范化内容——✓ 只许来自读回的事实。
 */
export function writeIncoming({ dir, name, text }) {
  // 写盘前再验一次名字与目录边界：列表端拦过不等于这里可以信任（bundle 拆名、远端构造）。
  const located = eventPathInDir(dir, name);
  if (!located.ok) return { ok: false, why: located.why };
  const path = located.path;
  // 写盘/改名/读回都可能直接抛（盘满、权限、落点父路径是个文件）。抛出去 = 调用方
  // 的 --json 不出结构化结果、逐件失败汇总也走不到，所以在这里就地收成 ok:false（审官 P2③）。
  try {
    if (existsSync(path)) return { ok: false, why: '目标已存在，不覆盖' };
    mkdirSync(dir, { recursive: true });
    // 临时件故意不是事件名（.tmp- 后缀），所以不走 eventPathInDir；仍必须落在同一目录。
    const tmpName = `${basename(name)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    const tmp = resolve(dir, tmpName);
    const tmpRel = relative(resolve(dir), tmp);
    if (tmpRel.startsWith('..') || isAbsolute(tmpRel) || basename(tmp) !== tmpName) {
      return { ok: false, why: '临时件路径逃出账本目录', path };
    }
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
    const back = eventIdentity(readFileSync(path, 'utf8'));
    const want = eventIdentity(text);
    if (!back.ok) return { ok: false, why: `读回不成：${back.why}`, path };
    if (!want.ok) return { ok: false, why: `来件本身不成：${want.why}`, path };
    if (back.fingerprint !== want.fingerprint) {
      return { ok: false, why: '读回内容与来件不一致（落盘出问题）', path };
    }
    return { ok: true, path, event_id: back.event.event_id, fingerprint: back.fingerprint };
  } catch (e) {
    return { ok: false, why: `写盘/读回抛了：${e && e.code ? e.code : String(e && e.message ? e.message : e).slice(0, 100)}`, path };
  }
}

/** 分批：一次 ssh 拉一批，名单走 stdin（不进 argv，长度不受命令行上限约束）。 */
export function chunk(list, size) {
  const step = Math.max(1, size);
  const out = [];
  for (let i = 0; i < (list || []).length; i += step) out.push(list.slice(i, i + step));
  return out;
}

/**
 * 三态判决的**唯一口径**：状态桶 → 归类。
 *
 * 判决只有这一处（审官三条是同一种病的三个位置：「没查成」被当成「没有/成功」）。
 * 两头都钉住，忘了归类不可能静默变绿：
 *  · `emptyResult()` 的桶就是这张表的键 —— 加桶必须先在这里归类；
 *  · `verdict()` 遍历结果里**实际存在**的数组桶，遇到表上没有的键、或归类值不在
 *    ok/unscanned/red 三档里（写错字也算），一律 fail-closed 判红。
 *    **没有「默认落进 ok」这条路。**
 */
export const SIGNAL_CLASS = {
  added: 'ok',
  skipped: 'ok',
  ignored: 'ok', // 远端的非事件文件（索引/临时件），本来就不该拉
  suspects: 'ok', // 名字与内容对不上：就地脱敏过的老事件，点名不拦
  unscanned: 'unscanned',
  rejected: 'unscanned', // 来件进不了账（坏 JSON / 名字非法 / 同名文件比不了）
  missing: 'unscanned', // 列表列了、逐件取值时没了 ⇒ 这次没汇聚成，不许报同步成功
  lost: 'unscanned', // 请过但既没回内容也没回 MISS ⇒ 名单没送到 / 流丢行
  conflicts: 'red',
  writeFailures: 'red',
};

const SIGNAL_STATES = new Set(['ok', 'unscanned', 'red']);

/** 结果骨架：桶由 SIGNAL_CLASS 的键生成，所以「有桶必有归类」。 */
export function emptyResult({ host, remoteDir, localDir, verify, apply } = {}) {
  const out = {
    host: host ?? null,
    remoteDir: remoteDir ?? null,
    localDir: localDir ?? null,
    verify: !!verify,
    applied: !!apply,
    remoteTotal: null,
    counts: {},
  };
  for (const key of Object.keys(SIGNAL_CLASS)) {
    out[key] = [];
    out.counts[key] = 0;
  }
  return out;
}

/** 计数从桶现算，不手抄（手抄就会漏掉新桶）。 */
export function recount(out) {
  out.counts = {};
  for (const key of Object.keys(SIGNAL_CLASS)) out.counts[key] = (out[key] || []).length;
  return out;
}

/**
 * 从一台机器按需拉取。
 * apply=false 只算不写（--dry-run）。三态见 verdict()。
 */
export function pullFromHost({
  host,
  remoteDir = DEFAULT_REMOTE_DIR,
  localDir,
  verify = false,
  apply = true,
  run = defaultRun,
  sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20'],
  batch = 150,
} = {}) {
  const out = emptyResult({ host, remoteDir, localDir, verify, apply });
  if (!host) {
    out.unscanned.push('没给 --from <ssh 别名>');
    return recount(out);
  }
  const localList = localEventNames(localDir);
  if (localList.unscanned) {
    if (!apply) {
      out.unscanned.push(localList.error);
      return recount(out);
    }
    // 首拉：本机还没这个目录，建了当空集算。建不出来（父路径是文件、没权限、盘满）
    // 会直接抛——抛出去调用方就拿不到结构化结果了（审官 P2③），就地收成真红。
    try {
      mkdirSync(localDir, { recursive: true });
    } catch (e) {
      out.writeFailures.push({
        name: String(localDir),
        why: `本机落点建不出来：${e && e.code ? e.code : String(e && e.message ? e.message : e).slice(0, 100)}`,
      });
      return recount(out);
    }
  }
  const localNames = localList.unscanned ? [] : localList.names;

  const listed = run('ssh', [...sshArgs, host, remoteListScript(remoteDir)]);
  if (!listed.probed) {
    out.unscanned.push(`ssh ${host} 没跑成：${listed.reason}`);
    return recount(out);
  }
  const remote = parseRemoteList(listed.stdout);
  if (remote.unscanned) {
    out.unscanned.push(`${host} 列表没查成：${remote.error}（exit ${listed.code}）`);
    return recount(out);
  }
  // 协议三道验都过了，但命令仍非零 ⇒ 列举过程出过事，一律当没查成，不许拿这份名单当全集。
  if (listed.code !== 0) {
    out.unscanned.push(
      `${host} 列表命令非零退出 exit ${listed.code}（列举可能不全，不当 0 条）` +
      `${listed.stderr ? `：${String(listed.stderr).trim().slice(0, 120)}` : ''}`
    );
    return recount(out);
  }
  out.remoteTotal = remote.names.length;

  const plan = planFetch({ localNames, remoteNames: remote.names, verify });
  out.ignored = plan.ignored;
  out.rejected = (plan.rejected || []).map(name => ({
    name,
    why: '文件名不是安全的 <ulid>-<machine>.json',
  }));
  if (!verify) out.skipped = plan.skip.map(name => ({ name, why: '同名跳过（未取内容）' }));

  const localTexts = new Map();
  for (const name of plan.fetch) {
    const located = eventPathInDir(localDir, name);
    if (!located.ok) continue; // 非法名进不了 fetch 计划；这里再挡一层
    if (existsSync(located.path)) {
      try {
        localTexts.set(name, readFileSync(located.path, 'utf8'));
      } catch (e) {
        out.unscanned.push(`本机 ${name} 读不了：${String(e.message || e).slice(0, 80)}`);
      }
    }
  }

  const incoming = [];
  for (const names of chunk(plan.fetch, batch)) {
    const got = run('ssh', [...sshArgs, host, remoteBundleScript(remoteDir)], { input: names.join('\n') + '\n' });
    if (!got.probed) {
      out.unscanned.push(`ssh ${host} 取内容没跑成：${got.reason}`);
      return recount(out);
    }
    const bundle = parseRemoteBundle(got.stdout, { requested: names });
    if (bundle.unscanned) {
      out.unscanned.push(`${host} 取内容没查成：${bundle.error}（exit ${got.code}）`);
      return recount(out);
    }
    if (got.code !== 0) {
      out.unscanned.push(
        `${host} 取内容命令非零退出 exit ${got.code}（这批可能不全）` +
        `${got.stderr ? `：${String(got.stderr).trim().slice(0, 120)}` : ''}`
      );
      return recount(out);
    }
    // 逐件对账：请过的每个名字必须要么回内容、要么回 MISS。都没回 = 名单没送到 / 流丢行，
    // 也不许当「就这些」。回了没请过的名字同样是协议乱了。
    const back = new Set([...bundle.files.map(f => f.name), ...bundle.missing]);
    for (const n of names) if (!back.has(n)) out.lost.push({ name: n, why: '请过但既没回内容也没回 MISS' });
    const asked = new Set(names);
    for (const f of bundle.files) {
      if (!asked.has(f.name) || !parseEventName(f.name)) {
        out.lost.push({
          name: f.name,
          why: parseEventName(f.name) ? '没请过却回了内容（协议乱了）' : 'bundle 文件名不安全，不得交给 mergeIncoming',
        });
        continue;
      }
      incoming.push(f);
    }
    out.missing.push(...bundle.missing.map(name => ({ name, why: '列表列了、取值时远端已没有' })));
  }
  if (out.lost.length) return recount(out); // 名单对不上账，后面别拿半份数据当结果

  const merged = mergeIncoming({ localTexts, incoming });
  out.conflicts = merged.conflicts;
  out.rejected.push(...merged.rejected);
  out.suspects = merged.suspects;
  if (verify) out.skipped = merged.skipped;
  else out.skipped.push(...merged.skipped);

  if (apply) {
    for (const item of merged.added) {
      const w = writeIncoming({ dir: localDir, name: item.name, text: item.text });
      if (w.ok) out.added.push({ name: item.name, event_id: w.event_id, path: w.path });
      else out.writeFailures.push({ name: item.name, why: w.why });
    }
  } else {
    out.added = merged.added.map(i => ({ name: i.name, event_id: i.event.event_id, path: null }));
  }

  return recount(out);
}

/**
 * 汇总多台机器 → 三态退出码：0 通 / 1 真红 / 2 没查成。真红优先（必须处置）。
 *
 * 归类只查 SIGNAL_CLASS 这一张表，且**没有默认放过的分支**：桶不在表上、或归类值不是
 * ok/unscanned/red，都进 unclassified 并判红。所以以后谁加了状态桶忘了归类，
 * 拿到的是红加一句「判决表漏登记」，不是一个假绿。
 */
export function verdict(results) {
  const list = results || [];
  let red = false;
  let unscanned = false;
  const unclassified = new Set();
  for (const r of list) {
    for (const [key, value] of Object.entries(r || {})) {
      if (!Array.isArray(value) || value.length === 0) continue;
      const cls = SIGNAL_CLASS[key];
      if (!SIGNAL_STATES.has(cls)) {
        unclassified.add(key);
        continue;
      }
      if (cls === 'red') red = true;
      else if (cls === 'unscanned') unscanned = true;
    }
  }
  if (unclassified.size) {
    return {
      code: 1,
      state: 'red',
      unclassified: [...unclassified],
      why: `有没归类的状态桶（SIGNAL_CLASS 漏登记）：${[...unclassified].join('/')}——fail-closed 判红`,
    };
  }
  if (red) return { code: 1, state: 'red' };
  if (unscanned) return { code: 2, state: 'unscanned' };
  return { code: 0, state: 'ok' };
}
