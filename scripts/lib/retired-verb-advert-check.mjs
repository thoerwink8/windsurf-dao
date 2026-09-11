// 现役帮助/手册不许把已退役 dao 动词写成可照抄的入口（#1150 审官红 2）。
//
// 改这段前必须知道：
//   reviewer-attach / dispatch-exec / dispatch --batch / notify / send 还在 CLI
//   路由里当「调用即拒」的 stub，FLAGS/VERBS 可以留；本闸只扫**现役帮助**把它们
//   写成用法。历史叙述、测试、CHANGELOG、判例档案不扫。
//   同一行写了「已退役 / 不要调 / 调用即拒」算交代，不算宣传。
// 检查器自己持有标记，不 import dao-cmd.USAGE。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const RETIRED_ADVERT_IDS = Object.freeze([
  'reviewer-attach',
  'dispatch-exec',
  'notify',
  'send',
  'dispatch-batch',
]);

const EXEMPT_RE = /已退役|调用即拒|不要调|不许调|无落点|当场拒|不是入口/;

const PATTERNS = Object.freeze([
  { id: 'reviewer-attach', re: /(?:node\s+scripts\/)?dao\.mjs\s+reviewer-attach\b|^[ \t]+reviewer-attach\s/ },
  { id: 'dispatch-exec', re: /(?:node\s+scripts\/)?dao\.mjs\s+dispatch-exec\b|^[ \t]+dispatch-exec\s/ },
  { id: 'notify', re: /(?:node\s+scripts\/)?dao\.mjs\s+notify\b|^[ \t]+notify\s/ },
  { id: 'send', re: /(?:node\s+scripts\/)?dao\.mjs\s+send\b|^[ \t]+send\s/ },
  { id: 'dispatch-batch', re: /(?:node\s+scripts\/)?dao\.mjs\s+dispatch\s+--batch\b|^[ \t]+dispatch\s+--batch\b|\bdispatch\s+--batch\b/ },
]);

const SKILLS_DIR = 'host/skills';
const EXTRA_LIVE = Object.freeze([
  'NEW-MACHINE.md',
  'README.md',
  'AGENTS.md',
  'scripts/lib/dao-cmd.mjs',
  'scripts/commander.mjs',
]);

function walkMd(dir, prefix, acc) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walkMd(p, rel, acc);
    else if (name.endsWith('.md') && st.isFile()) acc.push(rel);
  }
  return acc;
}

export function listLiveManuals(root) {
  const rels = walkMd(join(root || '', SKILLS_DIR), SKILLS_DIR, []);
  for (const extra of EXTRA_LIVE) {
    if (existsSync(join(root || '', extra))) rels.push(extra);
  }
  return rels;
}

/**
 * 扫一份正文。同一行带退役标记的不算宣传。
 * @returns {{line:number,id:string,excerpt:string}[]}
 */
export function scanRetiredAdverts(text) {
  const hits = [];
  const lines = String(text || '').split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (EXEMPT_RE.test(line)) continue;
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      if (p.re.test(line)) {
        hits.push({ line: i + 1, id: p.id, excerpt: line.trim().slice(0, 160) });
        break;
      }
    }
  }
  return hits;
}

function readRel(root, rel, override) {
  if (override && Object.prototype.hasOwnProperty.call(override, rel)) {
    return { text: override[rel], rel };
  }
  const p = join(root || '', rel);
  if (!existsSync(p)) return { missing: true, path: p, rel };
  try { return { text: readFileSync(p, 'utf8'), path: p, rel }; }
  catch (e) { return { missing: true, path: p, rel, error: String(e.message || e) }; }
}

/**
 * 夹具：red 必须红、ok 必须绿、empty（0 个文件）必须没查成。
 * @returns {{ok:boolean,unscanned?:boolean,error?:string,kinds?:{red:number,ok:number,empty:number}}}
 */
export function inspectRetiredVerbAdvertFixtures(dir) {
  if (!dir || !existsSync(dir)) {
    return { ok: false, unscanned: true, error: '夹具目录不在' };
  }
  const kinds = { red: 0, ok: 0, empty: 0 };
  const problems = [];
  for (const kind of ['red', 'ok', 'empty']) {
    const sub = join(dir, kind);
    if (!existsSync(sub)) {
      problems.push(`缺 ${kind}/`);
      continue;
    }
    const files = readdirSync(sub).filter((f) => f.endsWith('.md'));
    if (kind === 'empty') {
      if (files.length !== 0) problems.push('empty/ 里不该有 md');
      else kinds.empty += 1;
      continue;
    }
    if (files.length === 0) {
      problems.push(`${kind}: 0 个 md——没查成`);
      continue;
    }
    const anyHit = files.some((f) => scanRetiredAdverts(readFileSync(join(sub, f), 'utf8')).length);
    if (kind === 'red' && !anyHit) problems.push('red/ 自称该红但扫不到退役入口宣传');
    if (kind === 'ok' && anyHit) problems.push('ok/ 自称该绿但仍在宣传退役入口');
    kinds[kind] += 1;
  }
  if (kinds.red === 0 || kinds.ok === 0 || kinds.empty === 0) {
    return {
      ok: false,
      unscanned: kinds.red + kinds.ok + kinds.empty === 0,
      error: `样本种类不够 red=${kinds.red} ok=${kinds.ok} empty=${kinds.empty}`,
      kinds,
    };
  }
  if (problems.length) return { ok: false, error: problems.join('；'), kinds };
  return { ok: true, kinds };
}

/**
 * @returns {{green?: string, fail?: [string, string, string], scanned?: number, hits?: object[]}}
 */
export function checkRetiredVerbAdvert({ root, files, manuals } = {}) {
  if (!root && !files && !manuals) {
    return { fail: ['没给仓库根', 'checkRetiredVerbAdvert 要 root', ''] };
  }

  let rels;
  if (Array.isArray(manuals)) rels = manuals;
  else if (files) rels = Object.keys(files);
  else rels = listLiveManuals(root);

  if (rels.length === 0) {
    return {
      fail: [
        '现役帮助一个文件都没扫到',
        'host/skills 或 USAGE/指挥官任务书路径错了；0 个样本 = 本次等于没查，不是绿',
        SKILLS_DIR,
      ],
    };
  }

  const hits = [];
  for (const rel of rels) {
    const loaded = readRel(root || '', rel, files);
    if (loaded.missing) {
      return {
        fail: [
          `现役帮助读不到：${rel}`,
          '恢复该文件后再跑；读失败不是 0 条违规',
          loaded.path || rel,
        ],
      };
    }
    for (const h of scanRetiredAdverts(loaded.text)) {
      hits.push({ file: rel, ...h });
    }
  }

  if (hits.length) {
    const shown = hits.slice(0, 6).map((h) => `${h.file}:${h.line} ${h.id}`).join('；');
    return {
      fail: [
        `现役帮助还在宣传已退役入口 ${hits.length} 处`,
        '删掉可照抄的 reviewer-attach / dispatch-exec / dispatch --batch / notify / send；补派走 reviewer-create，通知走 GitHub 评论 + 飞书 hub。同一行写「已退役/不要调」才算交代',
        shown + (hits.length > 6 ? ' …' : ''),
      ],
      scanned: rels.length,
      hits,
    };
  }
  return {
    green: `现役帮助未宣传退役入口（${rels.length} 个文件）`,
    scanned: rels.length,
    hits,
  };
}
