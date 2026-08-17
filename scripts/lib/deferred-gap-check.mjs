// 挂账差集检查（#583，dao-check 第 ⑰ 项）。
//
// 判据形状抄 #581：外部事实 \ 本地记录，不是时钟。
//   外部 = transcript 文本里出现的 [[挂账:]] 标记（不问 hook 自己怎么解析）
//   本地 = DEFERRED.md 里已经入账的 what
// 差集非空 → 红（标记写了但没搬走 = 记录轨断了）。
// 禁 Date.now：不派工/不承认的日子用时钟必假红，假阳守卫会被关掉。
//
// 检查逻辑自己持有标记正则与账本字段读法，不 import deferred.mjs /
// deferred-hook.mjs——自己查自己查不出 hook 解析写错。
//
// 上线要正负样本都过：有差集必红、无差集必绿。只验一边会把「永远红」或「永远绿」当生效。

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const FIXTURES = {
  missing: {
    transcript: 'tests/fixtures/deferred/missing/transcript.jsonl',
    ledger: 'tests/fixtures/deferred/missing/DEFERRED.md',
  },
  aligned: {
    transcript: 'tests/fixtures/deferred/aligned/transcript.jsonl',
    ledger: 'tests/fixtures/deferred/aligned/DEFERRED.md',
  },
};

const SETTINGS_REL = '.claude/settings.json';
const HOOK_MARK = /deferred-hook/i;
const STOP_EVENT = 'Stop';
const BOARD_HOOK_REL = 'scripts/lib/board-hook.mjs';
const INJECT_MARK = "from './deferred-hook.mjs'";
const INJECT_CALL = 'promptLines';

// 检查器自己的标记：只认 [[挂账:...]]，写法与 deferred.mjs 的 MARK_RE 故意不同
// （那边允许跨行 [\s\S]，这边单行到 ]；那边捕获四种动作，这边只扫入账动作）。
const HANG_TAG = /\[\[挂账[:：]([^\]]*)\]\]/g;

function readRel(root, rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return { missing: true, path: p };
  try { return { text: readFileSync(p, 'utf8'), path: p }; } catch (e) {
    return { missing: true, path: p, error: String(e.message || e) };
  }
}

function readJson(file) {
  if (!existsSync(file)) return { exists: false };
  try {
    return { exists: true, doc: JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) };
  } catch (e) {
    return { exists: true, broken: String(e.message).slice(0, 80) };
  }
}

function eventCommands(doc, eventName) {
  const entries = doc?.hooks?.[eventName];
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const g of entries) {
    for (const h of (g?.hooks || [])) {
      if (h?.type === 'command' && typeof h.command === 'string') out.push(h.command);
    }
  }
  return out;
}

function resolveHookScript(command, root) {
  const m = String(command || '').match(/["']?((?:[^"'\s]|\\ )*deferred-hook[^"'\s]*\.mjs)["']?/);
  if (!m) return '';
  let p = m[1].replace(/^["']|["']$/g, '').trim();
  p = p.replace(/^\$\{?CLAUDE_PROJECT_DIR\}?[\\/]?/, '');
  if (!p) return '';
  return isAbsolute(p) ? p : join(root, p);
}

function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 检查器自己从任意文本里抠挂账标记，不走 hook 的 extractMarks。 */
export function extractHangTags(text) {
  const out = [];
  const src = String(text || '');
  HANG_TAG.lastIndex = 0;
  let m;
  while ((m = HANG_TAG.exec(src))) {
    const what = String(m[1] || '').split('|')[0].trim();
    if (what) out.push({ what });
  }
  return out;
}

/** 检查器自己读账本 what，不走 parseLedger。 */
export function readLedgerWhats(text) {
  const whats = [];
  for (const block of String(text || '').split(/\n---\n/)) {
    const m = block.match(/(?:^|\n)what:\s*(.*)\s*(?:\n|$)/);
    if (m && m[1].trim()) whats.push(m[1].trim());
  }
  return whats;
}

/**
 * @returns {{
 *   kind: 'unscanned'|'empty-external'|'gap'|'ok',
 *   missing: {what:string}[],
 *   tagged: {what:string}[],
 *   line: string
 * }}
 */
export function inspectDeferredGap({ transcriptTexts, ledgerText } = {}) {
  if (!Array.isArray(transcriptTexts)) {
    return {
      kind: 'unscanned',
      missing: [],
      tagged: [],
      line: '挂账差集：没给 transcript 列表，本次没查成，不是绿',
    };
  }
  const tagged = [];
  for (const t of transcriptTexts) {
    for (const g of extractHangTags(t)) tagged.push(g);
  }
  if (tagged.length === 0) {
    return {
      kind: 'empty-external',
      missing: [],
      tagged: [],
      line: '挂账差集：transcript 0 条挂账标记——没扫到样本，不是绿',
    };
  }
  const have = new Set(readLedgerWhats(ledgerText || '').map(norm));
  const missing = tagged.filter((t) => !have.has(norm(t.what)));
  if (missing.length) {
    return {
      kind: 'gap',
      missing,
      tagged,
      line: `挂账差集：transcript 有标记但账本没有：${missing.map((x) => x.what).join(' / ')}（查 ${tagged.length} 条）`,
    };
  }
  return {
    kind: 'ok',
    missing: [],
    tagged,
    line: `挂账差集：对齐 ${tagged.length} 条`,
  };
}

function loadFixturePair(root, pair) {
  const t = readRel(root, pair.transcript);
  const l = readRel(root, pair.ledger);
  if (t.missing || l.missing) {
    return {
      missing: true,
      line: `挂账样本不在：${t.missing ? pair.transcript : pair.ledger}`,
    };
  }
  return {
    missing: false,
    gap: inspectDeferredGap({ transcriptTexts: [t.text], ledgerText: l.text }),
  };
}

function checkHookMounted(root) {
  const settingsFile = join(root, SETTINGS_REL);
  const r = readJson(settingsFile);
  if (!r.exists) {
    return { fail: ['随仓 .claude/settings.json 不在', '挂账 hook 挂在这里：恢复文件；0 个装载面 = 本次等于没查', settingsFile] };
  }
  if (r.broken) {
    return { fail: ['随仓 .claude/settings.json 解析不了', '修 JSON；解析不了 = 本次等于没查', r.broken] };
  }
  const stop = eventCommands(r.doc, STOP_EVENT).filter((c) => HOOK_MARK.test(c));
  if (stop.length === 0) {
    return { fail: ['一个 Stop 挂账 hook 都没扫到', '在 .claude/settings.json 的 Stop 里挂 scripts/lib/deferred-hook.mjs', SETTINGS_REL] };
  }
  const script = resolveHookScript(stop[0], root);
  if (!script || !existsSync(script)) {
    return { fail: ['Stop 挂账 hook 指向的脚本不在', '注册指向空气 = 红', script || stop[0]] };
  }
  const board = readRel(root, BOARD_HOOK_REL);
  if (board.missing) {
    return { fail: ['盘面 hook 不在，写法提醒没地方注入', '恢复 scripts/lib/board-hook.mjs', BOARD_HOOK_REL] };
  }
  if (!board.text.includes(INJECT_MARK) || !board.text.includes(INJECT_CALL)) {
    return {
      fail: [
        'UserPromptSubmit 没有注入挂账写法提醒',
        'board-hook 必须 import deferred-hook 的 promptLines（不另挂第二条以免拖超时）',
        BOARD_HOOK_REL,
      ],
    };
  }
  return { ok: true, script };
}

/**
 * @returns {{green?: string, fail?: [string, string, string]}}
 */
export function checkDeferred({ root } = {}) {
  if (!root) return { fail: ['没给仓库根', 'checkDeferred 要 root', ''] };

  const miss = loadFixturePair(root, FIXTURES.missing);
  if (miss.missing) {
    return { fail: [miss.line, '恢复 tests/fixtures/deferred/missing/；0 个样本 = 本次等于没查', FIXTURES.missing.transcript] };
  }
  if (miss.gap.kind !== 'gap') {
    return {
      fail: [
        '挂账样本 A 没拦住（有标记无账本应红）',
        '差集检查把「永远绿」当成了生效；先修 inspectDeferredGap 再合并',
        miss.gap.line,
      ],
    };
  }

  const hit = loadFixturePair(root, FIXTURES.aligned);
  if (hit.missing) {
    return { fail: [hit.line, '恢复 tests/fixtures/deferred/aligned/；缺负样本 = 分不清永远红', FIXTURES.aligned.transcript] };
  }
  if (hit.gap.kind !== 'ok') {
    return {
      fail: [
        '挂账样本 B 误红（有标记且已入账应绿）',
        '差集检查把「永远红」当成了生效；先修匹配再合并',
        hit.gap.line,
      ],
    };
  }

  const mounted = checkHookMounted(root);
  if (mounted.fail) return { fail: mounted.fail };

  return {
    green: `挂账差集：样本 A 红 / 样本 B 绿；Stop 已挂搬运，写法提醒走 board-hook`,
  };
}
