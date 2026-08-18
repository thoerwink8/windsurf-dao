// 帅操作 issue 走 marshal（#627）。
//
// 病：两位帅共用 thoerwink8 token，skill 再教裸 `gh issue create`，GitHub 历史上
// 分不清是用户本人还是哪位帅。本检查只盯「教帅写 issue 的那一层」——host/skills。
// 检查器自己持有标记文本，不 import skill / dao.mjs 的任何解析逻辑。
//
// 两道：
//   1. dispatch skill 必须还在教「走 marshal、不用裸」；节被删 = 红。
//   2. host/skills 里不许再出现可执行形态的裸 `gh issue <写动词>`。
// 零样本：一个 .md 都没扫到 → 没查成，不是绿。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DISPATCH_REL = 'host/skills/dispatch/SKILL.md';
const SKILLS_DIR = 'host/skills';

// 检查器自己写的标记，不从被检查对象 import。
const MARK_HEADING = '帅操作 issue 的身份约定';
const MARK_CMD = 'gh-as.mjs marshal';
const MARK_RULE = '不用裸';

// 只认写动作。view / list 不落作者，允许继续裸 gh。
const BARE_WRITE_RE = /\bgh\s+issue\s+(create|comment|close|edit|reopen|delete)\b/g;

function readRel(root, rel, override) {
  if (override && Object.prototype.hasOwnProperty.call(override, rel)) return { text: override[rel], rel };
  const p = join(root || '', rel);
  if (!existsSync(p)) return { missing: true, path: p, rel };
  try { return { text: readFileSync(p, 'utf8'), path: p, rel }; }
  catch (e) { return { missing: true, path: p, rel, error: String(e.message || e) }; }
}

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

function findBareWrites(text) {
  const hits = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    BARE_WRITE_RE.lastIndex = 0;
    const m = BARE_WRITE_RE.exec(line);
    if (m) hits.push({ line: i + 1, verb: m[1], excerpt: line.trim().slice(0, 160) });
  }
  return hits;
}

/**
 * @returns {{green?: string, fail?: [string, string, string], scanned?: number, hits?: object[]}}
 */
export function checkMarshalIssueIdentity({ root, files, skills } = {}) {
  if (!root && !files) return { fail: ['没给仓库根', 'checkMarshalIssueIdentity 要 root', ''] };

  const dispatch = readRel(root || '', DISPATCH_REL, files);
  if (dispatch.missing) {
    return {
      fail: [
        `帅操作 issue 约定文件不在：${DISPATCH_REL}`,
        '恢复该文件后再跑；0 个样本 = 本次等于没查',
        dispatch.path || DISPATCH_REL,
      ],
    };
  }

  const missingMarks = [];
  if (!dispatch.text.includes(MARK_HEADING)) missingMarks.push(`缺节标题「${MARK_HEADING}」`);
  if (!dispatch.text.includes(MARK_CMD)) missingMarks.push(`缺命令「${MARK_CMD}」`);
  if (!dispatch.text.includes(MARK_RULE)) missingMarks.push(`缺禁令「${MARK_RULE}」`);
  if (missingMarks.length) {
    return {
      fail: [
        `dispatch skill 帅操作 issue 约定被拆 ${missingMarks.length} 处`,
        '恢复 host/skills/dispatch/SKILL.md「帅操作 issue 的身份约定」节；改一边必须改另一边',
        missingMarks.join('；'),
      ],
    };
  }

  let rels;
  if (Array.isArray(skills)) {
    rels = skills;
  } else if (files && Object.keys(files).some(k => k.startsWith('host/skills/'))) {
    rels = Object.keys(files).filter(k => k.startsWith('host/skills/') && k.endsWith('.md'));
  } else {
    rels = walkMd(join(root || '', SKILLS_DIR), SKILLS_DIR, []);
  }

  if (rels.length === 0) {
    return {
      fail: [
        'host/skills 一个 .md 都没扫到',
        '技能目录空了或路径错了；0 个样本 = 本次等于没查，不是绿',
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
          `技能文件读不到：${rel}`,
          '恢复该文件后再跑；读失败不是 0 条违规',
          loaded.path || rel,
        ],
      };
    }
    for (const h of findBareWrites(loaded.text)) {
      hits.push({ rel, ...h });
    }
  }

  if (hits.length) {
    return {
      fail: [
        `host/skills 还有 ${hits.length} 处教裸 gh issue 写动作`,
        '改成 `node scripts/gh-as.mjs marshal -- issue <动词>`；只读 view/list 可以继续裸',
        hits.slice(0, 4).map(h => `${h.rel}:${h.line} ${h.verb}  ${h.excerpt}`).join('；'),
      ],
      scanned: rels.length,
      hits,
    };
  }

  return {
    green: `帅操作 issue 走 marshal：dispatch 约定在，扫了 ${rels.length} 个 skill，0 处裸写`,
    scanned: rels.length,
    hits: [],
  };
}
