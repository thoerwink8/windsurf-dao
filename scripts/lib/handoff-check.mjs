// scripts/lib/handoff-check.mjs —— 交卷闸的纯判据（issue #904）
//
// 改这段代码前必须知道的四件事：
//
// 1. 本文件不碰 git、不碰网络、不读文件。所有事实由 scripts/handoff-check.mjs 采集后注入。
//    分开是为了让 tests/handoff-check.test.js 能拿假事实钉死判别力，而真样本（临时 git 仓）
//    只需要验采集那一层——两层各测各的，不用起真远端也能证明判据不是恒绿。
//
// 2. 三态不许压成两态：ok = 查过没事；red = 查成了且不对；unknown = 这次没查成。
//    unknown 一律非零退出（fail-closed）。「没查成」被当成「没问题」正是本单要堵的洞。
//
// 3. 判据只核「本分支与 master 的关系」，不核「本分支自不自洽」。后者 dao-check + 单元测试
//    已经在做，而 #904 记的 0/9 全红恰恰全出在前者：工人自证全绿（本树自洽），审官全判红
//    （与别人的既成事实不一致）。往本文件加判据前先问：这条是不是又在核本树自洽？是就别加。
//
// 4. 「差了别人的提交」和「删了别人的文件」是两件事，指路文案必须相反（#902 实咬）：
//    前者要变基把别人的东西**拿进来**，后者要把删掉的**放回去**。把前者当后者去「恢复文件」，
//    等于把别人已合并的成果重新提交一遍，制造真冲突——所以 ① 的红必须明写「不要去恢复文件」。

export const OK = 'ok';
export const RED = 'red';
export const UNKNOWN = 'unknown';

/** 列表太长时只报前 n 条，省略号带真实总数——省略了多少必须说，不然人会以为就这些。 */
function head(list, n, unit = '个') {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length <= n) return arr.join('、');
  return `${arr.slice(0, n).join('、')} …等 ${arr.length} ${unit}`;
}

// ---------------------------------------------------------------------------
// ① 基底含最新 master
// ---------------------------------------------------------------------------

/**
 * 判据：`git merge-base --is-ancestor <base> HEAD`。base 不是 HEAD 的祖先 ⇒ 本树切自旧 master，
 * 别人已合并的东西在这棵树里根本没出生（#893 就是这样，全套测试照样绿——没人测的东西不会红）。
 *
 * 事实里 fetched 这一项不能省：本地 origin/master 是缓存，不 fetch 的判绿只能证明
 * 「比我记得的那个 master 新」。所以两种结果不对称——
 *   不是祖先：即使拿的是陈旧缓存也已成立（真 master 只会更靠前）⇒ 直接红。
 *   是祖先但没 fetch 成：证不到「含**最新** master」⇒ unknown，不许放行。
 *
 * facts: { baseRef, baseResolved, fetched, fetchError, isAncestor, missingCommits, missingFiles }
 *   isAncestor: true / false / null（null = 这次没查成）
 *   missingCommits: [{ sha, subject }]  master 上有而本树没有的提交
 *   missingFiles:   [path]              那些提交动过的文件
 */
export function judgeBaseFreshness(facts = {}) {
  const { baseRef = 'origin/master', baseResolved, fetched, fetchError, isAncestor } = facts;
  if (!baseResolved) {
    return { state: UNKNOWN, detail: `解不出基线 ${baseRef}（远端跟踪引用不在？）——没查成，不当通过` };
  }
  if (isAncestor === null || isAncestor === undefined) {
    return { state: UNKNOWN, detail: `merge-base 没跑成，判不了基底新旧——没查成，不当通过` };
  }
  if (isAncestor === false) {
    const commits = (facts.missingCommits || []).map((c) => `${String(c.sha).slice(0, 7)} ${c.subject || ''}`.trim());
    const files = facts.missingFiles || [];
    const staleNote = fetched ? '' : `（注意：这次没拉到远端${fetchError ? `——${fetchError}` : ''}，真 master 只会更靠前）`;
    return {
      state: RED,
      detail: `本树切自旧 ${baseRef}${staleNote}：差 ${commits.length} 个提交、涉及 ${files.length} 个文件。`
        + `\n      差的提交：${head(commits, 6, '个') || '（列不出来）'}`
        + `\n      别人动过的文件：${head(files, 10, '个') || '（列不出来）'}`
        + `\n      怎么办：\`git fetch origin && git rebase ${baseRef}\`（或 merge）把这些**拿进来**。`
        + `\n      不要去「恢复文件」——它们不是被你删的，是还没出生；当成删除去恢复＝把别人已合并的成果重新提交一遍，制造真冲突（#902）。`,
      missingCommits: commits,
      missingFiles: files,
    };
  }
  if (!fetched) {
    return {
      state: UNKNOWN,
      detail: `本地 ${baseRef} 是祖先，但这次没拉到远端${fetchError ? `（${fetchError}）` : ''}——`
        + `只证得了「比我缓存的那个 master 新」，证不了「含最新 master」。联网后重跑，或 --no-fetch 自担风险。`,
    };
  }
  return { state: OK, detail: `基底含最新 ${baseRef}` };
}

// ---------------------------------------------------------------------------
// ② 相对 master 零删除
// ---------------------------------------------------------------------------

// 必须用三点 `base...HEAD`（= merge-base 到 HEAD），不许用两点。
// 两点 `base HEAD` 会把「master 后来新增、本树还没有」的文件也列成 D，那正是 #902 里
// 把基底过旧误读成反向删除的那个陷阱；判据自己踩进去，就会指挥人去「恢复」别人的文件。
// 三点只列本分支真正删掉的东西——① 管缺东西，② 管删东西，两条边界不许混。

const DELETION_MANIFEST_RE = /删除清单|删除说明|为什么删/;

/**
 * PR 正文里的「删除清单」算不算数：只认两件机械的事——
 *   a) 有清单标记词；b) 每个被删文件都在正文里被点名。
 * 只认 a 会被一句「本 PR 有删除，理由见上」糊弄过去；点名每个文件才逼人逐个过一遍。
 * 返回 { ok, missing }：missing = 有标记但没被点名的文件。
 */
export function inspectDeletionManifest(body, deleted = []) {
  const text = String(body || '');
  if (!DELETION_MANIFEST_RE.test(text)) return { ok: false, marked: false, missing: deleted.slice() };
  const missing = deleted.filter((p) => !text.includes(p));
  return { ok: missing.length === 0, marked: true, missing };
}

/**
 * facts: { baseRef, deleted, deletedError, prBody, prBodyError, prLabel }
 *   deleted: [path]（三点 diff 的 --diff-filter=D 结果）；null/undefined + deletedError = 没查成
 *   prBody:  PR 正文全文；拿不到时给 null 并填 prBodyError
 */
export function judgeReverseDeletions(facts = {}) {
  const { baseRef = 'origin/master', deleted, deletedError, prBody, prBodyError, prLabel = 'PR 正文' } = facts;
  if (!Array.isArray(deleted)) {
    return { state: UNKNOWN, detail: `删除清单没查成（${deletedError || '没给结果'}）——不当成 0 条` };
  }
  if (deleted.length === 0) {
    return { state: OK, detail: `相对 ${baseRef} 零删除` };
  }
  const list = head(deleted, 12, '个文件');
  if (prBody === null || prBody === undefined) {
    return {
      state: UNKNOWN,
      detail: `本分支删了 ${deleted.length} 个 ${baseRef} 上已有的文件（${list}），`
        + `但读不到${prLabel}核对删除说明（${prBodyError || '没给正文'}）——没查成，不放行。`
        + `\n      要么恢复这些文件，要么在${prLabel}写「删除清单 + 为什么删」并逐个点名，再用 --body-file 让本闸核对。`,
      deleted,
    };
  }
  const manifest = inspectDeletionManifest(prBody, deleted);
  if (manifest.ok) {
    return { state: OK, detail: `删了 ${deleted.length} 个文件，${prLabel}有删除清单且逐个点名（${list}）` };
  }
  const why = manifest.marked
    ? `${prLabel}有删除清单，但这些被删文件没在正文里点名：${head(manifest.missing, 12, '个文件')}`
    : `${prLabel}没有「删除清单 / 为什么删」段`;
  return {
    state: RED,
    detail: `本分支删了 ${deleted.length} 个 ${baseRef} 上已有的文件：${list}。${why}。`
      + `\n      怎么办：把误删的文件**放回去**（\`git checkout ${baseRef} -- <文件>\`），`
      + `或在${prLabel}加一段「删除清单 + 为什么删」，逐个点名这些路径。`
      + `\n      先分清是哪一种：本树缺别人的东西看 ①（那要变基，不是恢复）；这里列的是**你这条分支真删掉**的（#902）。`,
    deleted,
    unlisted: manifest.missing,
  };
}

// ---------------------------------------------------------------------------
// ④ 制度指针不指向空气
// ---------------------------------------------------------------------------

// 只扫**本分支新增的行**，不扫全仓。理由有二：
//   · 精度——全仓扫会把历史遗留的坏指针算到本单头上，红一次就没人看第二次（286c9b3 砍四支软提醒的原因）。
//   · 语义——本闸问的是「你这轮写下的指针指向空气了吗」，历史债不是交卷的门槛。
// 后缀必须长的排前面，末尾还要挡住后继字母：写 `json` 在 `js` 后面，`docs/release-policy.json`
// 会被切成 `docs/release-policy.js` 报「不存在」——2026-09-05 头一次拿真历史跑就咬中这条。
const POINTER_RE = /(?:^|[^\w./\\-])((?:scripts|tests|host|docs)\/[A-Za-z0-9._\-\/]*[A-Za-z0-9_-]\.(?:mjs|cjs|json|jsonc|js|md|sh|toml|yaml|yml|txt|ts))(?![A-Za-z0-9])/g;

// 拿真历史（HEAD~20..HEAD，5517 行新增）实测出来的两类假阳性，各配一条最小规避：
//   · 测试文件里的路径是**夹具**不是指针：tests/patrol.test.js 造的 docs/observations/a.md
//     本来就不该存在。整个 tests/ 一律不扫——8 条假阳性里 5 条出在这。
//   · 注释里拿单字母文件名举例（`host/skills/ask-gate/hooks/x.mjs` 说的是目录层数）。
//     真文件不会叫 x.mjs，所以按「主名 ≤2 字符」放过；失效方向只会是漏报，符合本单
//     「宁可漏报不要噪声」的定调。
const PLACEHOLDER_BASENAME_RE = /(?:^|\/)[A-Za-z0-9_-]{1,2}\.[A-Za-z0-9]+$/;

// 写着「已删 / 不存在 / 已退役」的句子里那条路径，指的就是不存在——那是记述不是指针。
const TOMBSTONE_RE = /不存在|已删|删掉|删除|退役|移除|下线|曾经|过时|已不在/;

// 检查器自己的文件、以及它的单测：里面全是正则与故意造的假路径，扫进去必然自伤。
// （同 scripts/lib/machine-path-check.mjs 的 SKIP_RELS，那条已被同类问题咬过一次。）
// CHANGELOG.md 是发布列车从历史提交标题生成的，历史里提过的路径今天可能早已删掉。
export const POINTER_SKIP_RELS = new Set([
  'scripts/lib/handoff-check.mjs',
  'scripts/handoff-check.mjs',
  'CHANGELOG.md',
]);

/** 整目录跳过：tests/ 下全是故意造的假路径夹具（实测占假阳性的 5/8）。 */
export function pointerSkipFile(file) {
  const f = String(file || '').replace(/\\/g, '/');
  if (!f) return true;
  if (POINTER_SKIP_RELS.has(f)) return true;
  return /^tests\//.test(f);
}

/**
 * 从「新增行」里抽仓内路径指针。
 * lines: [{ file, text }]，file 是这一行所在的仓内路径，text 是不带 + 号的行文本。
 * 返回 [{ path, file, line }]，按 path 去重（同一条指针写十遍只报一次）。
 */
export function extractRepoPointers(lines = []) {
  const seen = new Map();
  for (const item of lines) {
    const file = item && item.file ? String(item.file) : '';
    if (pointerSkipFile(file)) continue;
    const text = item && item.text != null ? String(item.text) : '';
    if (!text) continue;
    if (TOMBSTONE_RE.test(text)) continue;
    for (const m of text.matchAll(POINTER_RE)) {
      const p = m[1];
      // 通配 / 模板 / 相对跳级：拼不出确定落点的，不猜（宁可漏报不要噪声）。
      if (/[*?{}<>$\\]/.test(p) || p.includes('..') || p.includes('//')) continue;
      if (p.length > 200) continue;
      if (PLACEHOLDER_BASENAME_RE.test(p)) continue;
      if (!seen.has(p)) seen.set(p, { path: p, file, line: text.trim().slice(0, 120) });
    }
  }
  return [...seen.values()];
}

/**
 * facts: { scanError, addedLineCount, pointers, missing }
 *   addedLineCount: 这次 diff 到的新增行数——0 行 = 这次没扫到样本（unknown），不是「没有坏指针」
 *   pointers: extractRepoPointers 的结果；missing: 其中在本分支上不存在的
 */
export function judgePointers(facts = {}) {
  const { scanError, addedLineCount, pointers, missing } = facts;
  if (scanError) return { state: UNKNOWN, detail: `新增行没扫成（${scanError}）——没查成，不当通过` };
  if (!Array.isArray(pointers) || !Array.isArray(missing)) {
    return { state: UNKNOWN, detail: '指针扫描没给出结果——没查成，不当通过' };
  }
  if (!addedLineCount) {
    return { state: UNKNOWN, detail: '这次一行新增都没扫到——「没扫到样本」不等于「没有坏指针」' };
  }
  if (missing.length) {
    const shown = missing.slice(0, 8).map((m) => `${m.path}（写在 ${m.file}）`);
    return {
      state: RED,
      detail: `本分支新写下 ${missing.length} 条指向空气的仓内路径：`
        + `\n      ${shown.join('\n      ')}`
        + (missing.length > shown.length ? `\n      …等 ${missing.length} 条` : '')
        + `\n      怎么办：路径写错就改对；东西该由别的卡提供就先 ① 变基把它拿进来；确实不打算有这个文件就把指针删掉。`
        + `\n      指向空气的指针比没有指针更糟——#893 的 dispatch/SKILL.md 就是这样，而全套测试全绿。`,
      missing,
    };
  }
  return { state: OK, detail: `新增 ${addedLineCount} 行里的 ${pointers.length} 条仓内路径指针都真实存在` };
}

// ---------------------------------------------------------------------------
// ⑤ 自证基线 = 审官所见
// ---------------------------------------------------------------------------

/**
 * 本条不在 #904 的四件里，是我加的第五件：前四件核的都是「分支与 master 的关系」，
 * 但它们全建立在一个前提上——**审官看到的就是我自证过的那份代码**。这个前提会静默失效：
 * 未提交的改动、没推上去的提交，本地跑什么都绿，而 PR 页上是另一份。
 * 「全绿然后全红」的最省力成因就是这个，且判据零歧义、零误报，所以值得当机械闸。
 *
 * 未跟踪文件只报数不判红：.mirasim/ 这类本机杂物常年在，判红等于让闸天天喊狼来了。
 *
 * facts: { branch, dirtyTracked, untrackedCount, statusError, localHead, remoteRef, remoteHead, remoteError }
 */
export function judgeHandoffBaseline(facts = {}) {
  const {
    branch = '', dirtyTracked, untrackedCount = 0, statusError,
    localHead, remoteRef, remoteHead, remoteError,
  } = facts;
  if (statusError) return { state: UNKNOWN, detail: `git status 没跑成（${statusError}）——没查成，不当通过` };
  if (!Array.isArray(dirtyTracked)) return { state: UNKNOWN, detail: '工作区状态没给出结果——没查成，不当通过' };
  const extra = untrackedCount ? `（另有 ${untrackedCount} 个未跟踪文件，本条不判它们）` : '';

  if (dirtyTracked.length) {
    return {
      state: RED,
      detail: `有 ${dirtyTracked.length} 个已跟踪文件改了没提交：${head(dirtyTracked, 10, '个')}${extra}。`
        + `\n      你的自证跑在这份代码上，审官看到的是 PR 上那份——两者不是同一个东西。`
        + `\n      怎么办：\`git add <具体路径>\` 提交并推送（禁 -A，共享工作树会卷走别人的半成品），或先 stash 再重跑本闸。`,
      dirty: dirtyTracked,
    };
  }
  if (!localHead) return { state: UNKNOWN, detail: '读不到本地 HEAD——没查成，不当通过' };
  if (remoteError || !remoteHead) {
    return {
      state: RED,
      detail: `远端还没有这条分支（${remoteRef || `origin/${branch || '<当前分支>'}`}${remoteError ? `：${remoteError}` : ''}）${extra}。`
        + `\n      审官只审远端那份；没推上去等于没交。怎么办：\`git push -u origin HEAD\`。`,
    };
  }
  if (localHead !== remoteHead) {
    return {
      state: RED,
      detail: `本地 HEAD (${String(localHead).slice(0, 7)}) 与 ${remoteRef} (${String(remoteHead).slice(0, 7)}) 不一致${extra}。`
        + `\n      自证跑的是本地这份，审官审的是远端那份。怎么办：\`git push\`（若远端更靠前，先查是不是别人推过）。`,
    };
  }
  return { state: OK, detail: `工作区干净，本地与 ${remoteRef} 同点（${String(localHead).slice(0, 7)}）${extra}` };
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

/** 退出码三态，与 scripts/server-check.mjs 同一惯例：0 通 / 1 真红 / 2 没查成。红优先于没查成。 */
export function verdictFromItems(items = []) {
  const red = items.filter((i) => i.state === RED).length;
  const unknown = items.filter((i) => i.state === UNKNOWN).length;
  const ok = items.length - red - unknown;
  const exit = red ? 1 : unknown ? 2 : 0;
  return { exit, verdict: exit === 0 ? '通' : exit === 1 ? '真红' : '没查成', ok, red, unknown, total: items.length };
}

/** 本闸盖不到什么——必须跟着结果一起打出来，免得「跑绿了」被读成「契约没问题」。 */
export const COVERAGE_GAPS = [
  '平行卡的**字段名与枚举值**对账（#904 第 3 件）：本仓没有可机读的 schema 真相源，'
  + '要判就得手维护一张共享字段表，而手维护的常量必然过期——做出来是假闸。这条没做，理由见 issue #904 回复。',
  '两张在途 PR 的**合并顺序**（#897 那类）：站在单条分支里看不见「谁先合会让 master 错配」，'
  + '要跨 PR 视野才判得了。这条本闸盖不到，仍归帅在合并前判。',
];
