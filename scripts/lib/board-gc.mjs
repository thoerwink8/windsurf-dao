// scripts/lib/board-gc.mjs —— 僵尸卡自动发现（纯函数层）
//
// 用户 2026-09-05：「把剩下的僵尸卡都判断一下是否不需要，然后将其处理掉，
// 并且需要建立一个能够自动清理的机制自动去发现，自动去清理」。
//
// 已有的 board-reset 是「重测前一锅端」——它的目标是所有非主树顶层卡，不看这卡还要不要。
// 这里要的是相反的东西：**只清确实不需要的那几张**，其余一张不动。
//
// 僵尸的定义必须两条同时成立，缺一不可：
//   ① 活不需要了（PR 已合/已关、分支内容已全在 master、或同一 PR 的重复卡）
//   ② 卡上（含子卡）没有活着的进程
// 只满足 ② 的是**卡住**不是僵尸——那归换人/重派（#833），删了等于把在途活删掉。
//
// 三条不许越的红线，每条都对着一次实咬：
//   - 主树永不进名单。
//   - 任何一项没查成（PR 态查不到 / 终端没采到 / 分支态不知道）⇒ 这张卡不动，进 unscanned。
//     「没查成」和「查过没事」必须分得开（本仓硬规矩）。
//   - 分支不在远端、而树里还有本地提交或脏文件 ⇒ risky，只报不删。
//     远端有分支 = 活已经在 GitHub 上，本地树删了也丢不了；远端没有 = 删了就没了。
//     （memory deleted-card-process-outlived-it：判「安全删」不能只看外部产出。）

import { worktreeIdOf, prNumberFromWorktree } from './card-identity.mjs';

/** 卡 + 它的全部后代（用 childWorktreeIds 递归，认不出的子 id 也报出来）。 */
export function descendantsOf(card, worktrees) {
  const byId = new Map((Array.isArray(worktrees) ? worktrees : []).map((w) => [worktreeIdOf(w), w]));
  const out = [];
  const missing = [];
  const walk = (w) => {
    for (const cid of (Array.isArray(w?.childWorktreeIds) ? w.childWorktreeIds : [])) {
      const c = byId.get(cid);
      if (!c) { missing.push(cid); continue; }
      out.push(c);
      walk(c);
    }
  };
  walk(card);
  return { descendants: out, missing };
}

function lookup(map, key) {
  if (key == null) return undefined;
  if (map instanceof Map) return map.get(key);
  if (map && typeof map === 'object') return map[key];
  return undefined;
}

/** PR 态归一：MERGED / CLOSED 算「活已了结」，OPEN 算「还需要」，其余当没查成。 */
function prVerdict(raw) {
  const s = String(raw || '').toUpperCase();
  if (s === 'MERGED') return 'done';
  if (s === 'CLOSED') return 'done';
  if (s === 'OPEN') return 'open';
  return null;
}

/**
 * 扫一轮盘面，判每张顶层卡是「僵尸 / 留着 / 有风险 / 没查成」。
 *
 * @param worktrees        orca ps 的 worktrees
 * @param aliveWorktreeIds Set：至少有一个会话判 active 的卡 id（由 liveness 算好传进来，
 *                         本模块不碰活性判据——一把尺只在一处）
 * @param prState          PR 号 → 'OPEN'|'MERGED'|'CLOSED'；查不到就别放进来（放进来的都算查成了）
 * @param branchState      分支名 → { onRemote, ahead, dirty }；同上
 */
export function planBoardGc({ worktrees, aliveWorktreeIds, prState, branchState } = {}) {
  if (!Array.isArray(worktrees)) {
    return { ok: false, error: '盘面没查成（worktrees 不是数组），一张都不判', zombies: [], keep: [], risky: [], unscanned: [] };
  }
  if (!(aliveWorktreeIds instanceof Set)) {
    return { ok: false, error: '活性没查成（没给 alive 集合），一张都不判', zombies: [], keep: [], risky: [], unscanned: [] };
  }
  const zombies = [];
  const keep = [];
  const risky = [];
  const unscanned = [];

  const dupZombieIds = new Set();
  const dupWhy = new Map();
  // 同一父卡下、指向同一个 PR 的同类子卡是重复卡（memory one-pr-one-reviewer：一 PR 只能一张审官卡）。
  // 留 lastActivityAt 最新的一张，其余判重复。活着的那张不动——重复也不许删在跑的。
  for (const parent of worktrees) {
    const kids = worktrees.filter((w) => w && w.parentWorktreeId && parent
      && String(w.parentWorktreeId) === String(worktreeIdOf(parent)));
    const byPr = new Map();
    for (const k of kids) {
      const pr = prNumberFromWorktree(k);
      if (pr == null) continue;
      if (!byPr.has(pr)) byPr.set(pr, []);
      byPr.get(pr).push(k);
    }
    for (const [pr, group] of byPr) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => (Number(b.lastActivityAt) || 0) - (Number(a.lastActivityAt) || 0));
      for (const dead of sorted.slice(1)) {
        const id = worktreeIdOf(dead);
        dupZombieIds.add(id);
        dupWhy.set(id, `PR #${pr} 有 ${group.length} 张同类卡，只留最新那张`);
      }
    }
  }

  for (const w of worktrees) {
    if (!w || typeof w !== 'object') continue;
    const id = worktreeIdOf(w);
    const name = w.displayName || id || '(无名卡)';
    if (w.isMainWorktree) { keep.push({ id, name, why: '主树永不删' }); continue; }
    if (w.isArchived) continue;

    // 子卡：只有「重复卡」这一种理由能让它单独出列，其余随父卡整树走。
    if (w.parentWorktreeId) {
      if (!dupZombieIds.has(id)) continue;
      if (aliveWorktreeIds.has(id)) { keep.push({ id, name, why: '重复卡，但它上面还有活着的进程' }); continue; }
      zombies.push({ id, name, path: w.path || null, why: dupWhy.get(id), kind: 'duplicate' });
      continue;
    }

    if (!id) { unscanned.push({ id: null, name, why: '卡没有 id，判不了' }); continue; }

    const { descendants, missing } = descendantsOf(w, worktrees);
    if (missing.length) {
      unscanned.push({ id, name, why: `有 ${missing.length} 个子卡不在盘面列表里，整树判不了` });
      continue;
    }
    const family = [w, ...descendants];

    // ② 有活着的进程 → 一定留。先判这条，省掉后面所有查询。
    const aliveIn = family.filter((f) => aliveWorktreeIds.has(worktreeIdOf(f)));
    if (aliveIn.length) {
      keep.push({ id, name, why: `${aliveIn.length} 个会话还在推进` });
      continue;
    }

    // ① 活还需不需要
    const prs = [...new Set(family.map(prNumberFromWorktree).filter((n) => n != null))];
    if (prs.length) {
      const verdicts = prs.map((n) => ({ n, v: prVerdict(lookup(prState, n)) }));
      const bad = verdicts.filter((x) => x.v === null);
      if (bad.length) {
        unscanned.push({ id, name, why: `PR ${bad.map((x) => '#' + x.n).join('/')} 的状态没查成` });
        continue;
      }
      const stillOpen = verdicts.filter((x) => x.v === 'open');
      if (stillOpen.length) {
        keep.push({ id, name, why: `PR ${stillOpen.map((x) => '#' + x.n).join('/')} 还开着，活没完（卡住≠不需要）` });
        continue;
      }
      zombies.push({
        id, name, path: w.path || null, kind: 'pr-done',
        why: `PR ${prs.map((n) => '#' + n).join('/')} 已合并或已关闭，且整树没有活着的进程`,
        children: descendants.length,
      });
      continue;
    }

    // 没有 PR：看分支里还有没有没落地的东西
    const branch = String(w.branch || '').replace(/^refs\/heads\//, '');
    const bs = lookup(branchState, branch);
    if (!bs || typeof bs !== 'object') {
      unscanned.push({ id, name, why: `分支 ${branch || '(未知)'} 的状态没查成` });
      continue;
    }
    const ahead = Number(bs.ahead) || 0;
    const dirty = Number(bs.dirty) || 0;
    if (ahead === 0 && dirty === 0) {
      zombies.push({
        id, name, path: w.path || null, kind: 'empty-branch',
        why: `无 PR，分支 ${branch} 相对 master 零提交零改动`,
        children: descendants.length,
      });
      continue;
    }
    // 没提交的改动永远不可能已经在 master 里，先判掉，不进后面的贡献判据。
    if (dirty > 0 && !bs.onRemote) {
      risky.push({ id, name, path: w.path || null, why: `无 PR，分支 ${branch} 不在远端且有 ${dirty} 个未提交改动——删了就没了，要人判` });
      continue;
    }
    // 「有几个本地提交」不等于「有活会丢」：分支常常是同一件事的旧实现，master 已经用别的 PR 落了。
    // 提交号比不出来（rebase / 重做后 patch-id 就变了，git cherry 会给出假的「未合入」），
    // 只有内容比得出来：把分支合进 master 看树变不变。
    //   contributes === false → 合进去等于没合，整支是陈旧副本 → 可清
    //   contributes === true  → 真有 master 没有的东西 → 留着
    //   contributes 缺失/null → 合不干净（有冲突），判不了 → 要人判，绝不自动删
    if (bs.contributes === false) {
      zombies.push({
        id, name, path: w.path || null, kind: 'already-in-master',
        why: `无 PR，分支 ${branch} 的 ${ahead} 个提交合进 master 等于没合（内容已全在）`,
        children: descendants.length,
      });
      continue;
    }
    if (bs.contributes !== true) {
      risky.push({ id, name, path: w.path || null, why: `无 PR，分支 ${branch} 有 ${ahead} 个提交但合不干净（有冲突），是不是陈旧副本判不了——要人判` });
      continue;
    }
    if (!bs.onRemote) {
      risky.push({
        id, name, path: w.path || null,
        why: `无 PR，分支 ${branch} 不在远端却有 ${ahead} 个 master 没有的提交——删了就没了，要人判`,
      });
      continue;
    }
    keep.push({ id, name, why: `无 PR，但分支 ${branch} 有 ${ahead} 个提交待处理（远端有备份）` });
  }

  return { ok: true, zombies, keep, risky, unscanned };
}

/** 渲染成人读报告。没查成的那节必须显形，不许装成「扫完是空的」。 */
export function formatBoardGc(plan, { apply = false } = {}) {
  if (!plan || plan.ok !== true) return `盘面 GC 没跑成：${plan?.error || '未知原因'}`;
  const L = [];
  L.push(`僵尸卡 ${plan.zombies.length} 张｜留着 ${plan.keep.length} 张｜要人判 ${plan.risky.length} 张｜没查成 ${plan.unscanned.length} 张`);
  if (plan.zombies.length) {
    L.push('', apply ? '## 已清' : '## 将清（--apply 才真删）');
    for (const z of plan.zombies) L.push(`- ${z.name}｜${z.why}${z.children ? `｜带 ${z.children} 张子卡` : ''}`);
  }
  if (plan.risky.length) {
    L.push('', '## 要人判（有活可能丢，不自动删）');
    for (const r of plan.risky) L.push(`- ${r.name}｜${r.why}`);
  }
  if (plan.unscanned.length) {
    L.push('', '## 没查成（≠ 查过没事，本轮不动）');
    for (const u of plan.unscanned) L.push(`- ${u.name}｜${u.why}`);
  }
  return L.join('\n');
}
