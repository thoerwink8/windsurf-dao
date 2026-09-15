// skills 装载面合并式接回（#1146）。
//
// 病：mirasim 每次启动把 ~/.claude/skills 整目录劫成指向 ~/.mirasim/skills 的链接。
// 旧口径 skills-elsewhere 只报不修，人手工重链两次都被劫回；dao-check ㉚ 因此常红。
//
// 修：把发现面恢复成 NEW-MACHINE §11 的形态——真目录 + 逐个仓内链接。
// mirasim 自有目录（lark-* / eval 等）不删：从被劫目标里抄一份链回新目录，原目录原封不动。
//
// 本文件只动 ~/.claude/skills 这一层，绝不 rm -rf 被劫目标。
// onboard.mjs 与 scripts/skills-heal.mjs（systemd 自愈）共用这一份。

import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const linkType = () => (process.platform === 'win32' ? 'junction' : undefined);

function samePath(a, b) {
  const n = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') return n(a).toLowerCase() === n(b).toLowerCase();
  return n(a) === n(b);
}

export function listSkillNames(src) {
  try {
    return readdirSync(src).filter((n) => {
      try { return lstatSync(join(src, n)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }
}

/**
 * 装载面形态。kinds：
 *   missing    —— ~/.claude/skills 不在（没装）
 *   hijacked   —— 整目录符号链接（mirasim 形态 / 旧整目录 Junction）
 *   dangling   —— 整目录链接悬空
 *   file       —— 存在但不是目录也不是链接
 *   directory  —— 真目录（现行部署；缺链由 heal 补）
 *   unscanned  —— 没查成
 */
export function classifySkillsMount({ root, home, dir = '.claude' } = {}) {
  if (!home) return { kind: 'unscanned', reason: 'home 空' };
  const face = join(home, dir, 'skills');
  const src = join(root || '', 'host', 'skills');
  if (!src || !existsSync(src)) return { kind: 'unscanned', reason: 'host/skills 不在', face, src };
  let st;
  try { st = lstatSync(face); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { kind: 'missing', face, src };
    return { kind: 'unscanned', reason: String(e.message || e).slice(0, 160), face, src };
  }
  if (st.isSymbolicLink()) {
    let target = null;
    try { target = realpathSync(face); }
    catch { return { kind: 'dangling', face, src }; }
    return { kind: 'hijacked', face, src, target };
  }
  if (!st.isDirectory()) return { kind: 'file', face, src };
  return { kind: 'directory', face, src };
}

function keeperEntries(target, srcNames) {
  if (!target) return [];
  let names;
  try { names = readdirSync(target); }
  catch { return []; }
  const out = [];
  for (const n of names) {
    if (srcNames.includes(n)) continue; // 仓内同名：接回仓内链，不动被劫目录里那一份
    out.push({ name: n, from: join(target, n) });
  }
  return out;
}

function ensureRepoLinks(face, src, srcNames, dryRun) {
  const linked = [];
  const rebuilt = [];
  for (const name of srcNames) {
    const l = join(face, name);
    const want = join(src, name);
    let st = null;
    try { st = lstatSync(l); } catch { st = null; }
    if (!st) {
      if (!dryRun) symlinkSync(want, l, linkType());
      linked.push(name);
      continue;
    }
    if (st.isSymbolicLink()) {
      let current = null;
      try { current = realpathSync(l); } catch { current = null; }
      if (current && samePath(current, want)) continue;
      if (!dryRun) {
        unlinkSync(l);
        symlinkSync(want, l, linkType());
      }
      rebuilt.push(name);
      continue;
    }
    // 真目录 / 真文件：不动（skills-not-link，人先移走）
  }
  return { linked, rebuilt };
}

function linkKeepers(face, keepers, dryRun) {
  const kept = [];
  for (const k of keepers) {
    const dest = join(face, k.name);
    let st = null;
    try { st = lstatSync(dest); } catch { st = null; }
    if (st) continue;
    if (!dryRun) {
      try { symlinkSync(k.from, dest, linkType()); }
      catch { continue; }
    }
    kept.push(k.name);
  }
  return kept;
}

/**
 * 合并式接回。幂等：已经是真目录且仓内链齐 → changed=false。
 * 不删被劫目标里的任何东西。
 *
 * @returns {{ok:boolean, changed?:boolean, kind?:string, linked?:string[], rebuilt?:string[], kept?:string[], unscanned?:boolean, error?:string, reason?:string, face?:string, target?:string}}
 */
export function healSkillsMount({ root, home, dir = '.claude', dryRun = false, say = () => {} } = {}) {
  const c = classifySkillsMount({ root, home, dir });
  if (c.kind === 'unscanned') return { ok: false, unscanned: true, kind: c.kind, reason: c.reason, face: c.face };
  if (c.kind === 'file') {
    return { ok: false, kind: 'file', error: `${c.face} 不是目录也不是链接——先移走再跑`, face: c.face };
  }
  const srcNames = listSkillNames(c.src);
  if (!srcNames.length) {
    return { ok: false, unscanned: true, kind: c.kind, reason: 'host/skills 空', face: c.face };
  }

  const keepers = (c.kind === 'hijacked') ? keeperEntries(c.target, srcNames) : [];

  if (c.kind === 'hijacked' || c.kind === 'dangling') {
    say(`${dryRun ? '[拟] ' : ''}卸整目录链接 ${c.face}` + (c.target ? ` ← ${c.target}` : '（悬空）'));
    if (!dryRun) {
      try { unlinkSync(c.face); }
      catch (e) { return { ok: false, kind: c.kind, error: `卸链接失败：${e.message}`, face: c.face, target: c.target }; }
      mkdirSync(c.face, { recursive: true });
    }
  } else if (c.kind === 'missing') {
    say(`${dryRun ? '[拟] ' : ''}建装载面 ${c.face}`);
    if (!dryRun) mkdirSync(c.face, { recursive: true });
  }

  const reshaping = c.kind === 'hijacked' || c.kind === 'dangling' || c.kind === 'missing';
  const { linked, rebuilt } = dryRun && reshaping
    ? { linked: srcNames, rebuilt: [] }
    : ensureRepoLinks(c.face, c.src, srcNames, dryRun);
  // dry-run 时 face 还是整目录链接，lstat(face/name) 会穿到被劫目标里「已经在」——那不是接回后的状态。
  const kept = dryRun && c.kind === 'hijacked'
    ? keepers.map((k) => k.name)
    : linkKeepers(c.face, keepers, dryRun);

  const shapeChanged = c.kind === 'hijacked' || c.kind === 'dangling' || c.kind === 'missing';
  const changed = shapeChanged || linked.length > 0 || rebuilt.length > 0 || kept.length > 0;
  if (changed) {
    say(`${dryRun ? '[拟] ' : ''}仓内链 ${linked.length} 补 / ${rebuilt.length} 重建，外来保留 ${kept.length}：${kept.join('、') || '无'}`);
  }
  return {
    ok: true,
    changed,
    kind: c.kind,
    linked,
    rebuilt,
    kept,
    face: c.face,
    target: c.target,
  };
}
