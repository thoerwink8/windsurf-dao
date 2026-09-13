// scripts/lib/exhausted.mjs —— 自动化认输是 PR 的属性，不是待发送的事件（#1000）
//
// 来历：exhausted 走 escalate 开单，开单去重把同一 key 吃掉 → 零日志永久卡死（PR #909）。
// 再动去重 = 「怎么喊人」第四层。本文件把认输做成状态：打标、跳过、看门狗按 @head 推一次。
//
// 零 IO。调用方填 PR / 账本，这里只判。

export const EXHAUSTED_LABEL = '卡死/自动化认输';
export const WAITING_USER_LABEL = '卡死/等用户';
export const EXHAUSTED_VERBS = new Set(['drain', 'rework', 'rereview', 'pump-draft']);
export const EXHAUSTED_COMMENT_MARK = '[commander-exhausted]';

/** 账本键必须带 @head。只用 pr 会把修好的新局面永久挡住（PR #909 / df87014a）。
 *  #1238：再带一段**判据版本**——「这个标是按哪一版判据打的」原先没记，
 *  于是判据改了、标还挂着，谁都不知道它过期没有。 */
export function exhaustedPushKey(pr, head, epoch) {
  const n = pr == null ? '' : String(pr).trim();
  const h = typeof head === 'string' ? head.trim() : '';
  if (!n || !h) return null;
  const base = `pushed:${n}@${h}`;
  const e = typeof epoch === 'string' && /^[0-9a-f]{12}$/.test(epoch) ? epoch : null;
  return e ? `${base}@e${e}` : base;
}

/**
 * 从账本键里取判据版本。没带（老键）→ null。
 *
 * 这个函数存在的理由：**老记录必须能被认出来是老的**。取了 null 就当「判据未知」处理，
 * 不许当成「判据没变」——那会让 #1143 那批在加版本之前认输的标永远过期不了。
 */
export function epochOfPushKey(key) {
  const m = /@e([0-9a-f]{12})$/.exec(String(key || ''));
  return m ? m[1] : null;
}

export function exhaustedPushPath(home) {
  return `${String(home || '').replace(/\/+$/, '')}/.dao/exhausted-push.json`;
}

function labelNames(labels) {
  if (!Array.isArray(labels)) return [];
  const out = [];
  for (const l of labels) {
    if (typeof l === 'string') { if (l) out.push(l); continue; }
    if (l && typeof l.name === 'string' && l.name) out.push(l.name);
  }
  return out;
}

/** 指挥官见到这两个标都跳过重试。等用户 = 已经升级给人，不再机械推。 */
export function prHasStuckLabel(pr) {
  const names = labelNames(pr && pr.labels);
  return names.includes(EXHAUSTED_LABEL) || names.includes(WAITING_USER_LABEL);
}

export function prHasExhaustedLabel(pr) {
  return labelNames(pr && pr.labels).includes(EXHAUSTED_LABEL);
}

export function prHasWaitingUserLabel(pr) {
  return labelNames(pr && pr.labels).includes(WAITING_USER_LABEL);
}

export function waitingUserComment({ pr, verb, tries, head } = {}) {
  const v = EXHAUSTED_VERBS.has(verb) ? verb : String(verb || '?');
  const n = pr == null ? '?' : String(pr);
  const h = typeof head === 'string' && head.trim() ? head.trim() : null;
  const triesN = Number.isFinite(Number(tries)) ? Number(tries) : '?';
  return [
    `${EXHAUSTED_COMMENT_MARK} ${v} PR #${n}${h ? '@' + h : ''}`,
    '',
    `draft 收口泵试了 ${triesN} 次仍是 draft。已打「${WAITING_USER_LABEL}」，指挥官不再泵。`,
    h ? `当前 head：${h}` : '当前 head 没查成，标打在 PR 上（属性不依赖 head）。',
    '',
    '帅位三选一：',
    '1. 去掉该标——已解决，下轮可再泵',
    '2. 补验收 / 转正式 / 关掉 PR',
    '3. 保持等用户，看门狗不再推',
  ].join('\n');
}

export function exhaustedComment({ pr, verb, tries, head, why, retryVerdict, maxTries } = {}) {
  const v = EXHAUSTED_VERBS.has(verb) ? verb : String(verb || '?');
  const n = pr == null ? '?' : String(pr);
  const h = typeof head === 'string' && head.trim() ? head.trim() : null;
  const triesN = Number.isFinite(Number(tries)) ? Number(tries) : '?';
  // 真因必须写进评论（#1233 实咬）：原来这里只有「动词 X 试了 3 次仍没推动」——读这句话的人
  // 会去查这张 PR 为什么没动，而真正的原因（`execution profile unverified: codex-relay-gpt-5.6-sol`）
  // 躺在 drain 的返回值里，一句话都没带出来。四张判绿可合的 PR 就这样被同一个必然失败卡住，
  // 而认输理由让人往错的方向查。
  const cause = typeof why === 'string' && why.trim() ? why.trim().split(/\r?\n/)[0].slice(0, 400) : null;
  // #1237：两种结局必须分得开。「一次都不该试」和「真试满了」读起来是两件事——
  // 拿「试了 N 次仍没推动」去描述一个判据必拒的失败，是同一族误导（#1233 的教训）。
  const cap = Number.isFinite(Number(maxTries)) ? Number(maxTries) : null;
  const hopeless = retryVerdict === 'terminal';
  const headline = hopeless
    ? `自动化交人：动词 ${v} 的失败重试不会变（成因在重试能改变的范围之外），第 ${triesN} 次即停手，不烧满 ${cap || '?'} 次名额。`
    : `自动化认输：动词 ${v} 试了 ${triesN} 次仍没推动。`;
  return [
    `${EXHAUSTED_COMMENT_MARK} ${v} PR #${n}${h ? '@' + h : ''}`,
    '',
    headline,
    cause ? `最后一次失败的原因：${cause}` : '（这几次没留下具体原因——没查到什么挡住了它，只记了次数）',
    h ? `当前 head：${h}` : '当前 head 没查成，标打在 PR 上（属性不依赖 head）。',
    '',
    '指挥官从此跳过这张 PR，不再重试。帅位三选一：',
    '1. 去掉「卡死/自动化认输」——已解决，下轮可再试',
    '2. 换成「卡死/等用户」——升级给人，看门狗不再推',
    '3. 关掉 PR',
    '',
    '新 head 允许看门狗再推一次（工人推了新东西 = 新局面）。',
  ].join('\n');
}

export function buildMarkExhausted({ pr, verb, tries, head, why, label, retryVerdict, maxTries } = {}) {
  const n = pr == null ? null : Number.isFinite(Number(pr)) ? Number(pr) : pr;
  const v = EXHAUSTED_VERBS.has(verb) ? verb : String(verb || '');
  const useWaiting = label === WAITING_USER_LABEL || v === 'pump-draft';
  return {
    kind: 'mark-exhausted',
    pr: n,
    verb: v,
    tries: Number(tries) || 0,
    head: typeof head === 'string' && head.trim() ? head.trim() : null,
    label: useWaiting ? WAITING_USER_LABEL : EXHAUSTED_LABEL,
    // #1237：把判据结论带在动作上，执行侧与看板都能读，不必从评论正文里反解。
    retryVerdict: retryVerdict || null,
    maxTries: Number.isFinite(Number(maxTries)) ? Number(maxTries) : null,
    why: why || (useWaiting
      ? `PR #${n} draft 收口泵试满，打「${WAITING_USER_LABEL}」交帅`
      : `PR #${n} 自动化认输（${verb} 试满）`),
    comment: useWaiting
      ? waitingUserComment({ pr: n, verb, tries, head })
      : exhaustedComment({ pr: n, verb, tries, head, why }),
  };
}

/**
 * 看门狗：带「卡死/自动化认输」的开放 PR，同一 (pr, head) 只推一次。
 * 换成「卡死/等用户」/摘标/关掉 → 不再推。head 没查成 → 不推、不写无 head 键。
 */
export function planExhaustedPush({ prs = [], ledger = {}, epoch = null } = {}) {
  const book = ledger && typeof ledger === 'object' ? ledger : {};
  const pushes = [];
  const skipped = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (!pr || pr.number == null) continue;
    const n = pr.number;
    if (!Array.isArray(pr.labels)) {
      skipped.push({ pr: n, why: 'labels-unscanned' });
      continue;
    }
    const names = labelNames(pr.labels);
    if (names.includes(WAITING_USER_LABEL)) {
      skipped.push({ pr: n, why: 'waiting-user' });
      continue;
    }
    if (!names.includes(EXHAUSTED_LABEL)) continue;
    const head = typeof pr.headRefOid === 'string' && pr.headRefOid.trim() ? pr.headRefOid.trim() : null;
    if (!head) {
      skipped.push({ pr: n, why: 'head-unscanned' });
      continue;
    }
    const key = exhaustedPushKey(n, head, epoch);
    if (book[key]) {
      skipped.push({ pr: n, why: 'already-pushed', key });
      continue;
    }
    pushes.push({
      pr: n,
      head,
      key,
      title: pr.title || '',
      text: `PR #${n} 自动化认输（${EXHAUSTED_LABEL}），head ${head.slice(0, 8)}。帅位三选一：去掉该标 / 换成「${WAITING_USER_LABEL}」 / 关掉 PR。新 head 会再推一次。`,
    });
  }
  return { pushes, skipped };
}

/**
 * 「卡死/自动化认输」是**带 head、带判据版本**的判据，不是永久标签——过期就摘。
 *
 * 2026-09-11 实咬：这个标被写成单向闩，写它的路径好几处、摘它的一处都没有，
 * 而 `prHasStuckLabel` 一票否决该 PR 的全部动作 → 12 张 PR 被永久焊死。
 * 设计意图本来就不是永久的（本文件开头：「账本键必须带 @head」）。
 *
 * 2026-09-13 第二次实咬（#1238）：摘标只认「工人推了新 head」，于是**判据修好了但没人推
 * 新 head 的 PR 永远过期不了**。实测 6 张（#1225/#1213/#1211/#1209/#1111/#1148），
 * 其中 #1111/#1148 的病（审官读 PR 走裸 gh，在 GH_CONFIG_DIR=/var/empty 下必失败）
 * 早已修在 master 上——标还挂着，因为「病修好了」原先不是一条能触发摘标的判据。
 * 人对它们做「摘标重推」也无效（#1111 上有更正），因为重推仍读到旧账。
 *
 * 所以判据有三条，任一成立就摘：
 *   ① 工人推了新 head           —— 新局面（原有）
 *   ② 判据版本变了             —— 挡住它的那套判据已经改了（#1238 新增）
 *   ③ 认输记录没带版本（老键）  —— 加版本之前的记录，无从判断，按过期处理（#1238）
 *
 * ③ 为什么按过期而不是保守留着：**留下的代价是「永久卡死」，摘掉的代价是「多试几次」**。
 * 两者不对称，且后者有重试上限兜底（#1236 的判据版本 + 试满交人）。
 *
 * 只摘「自动化认输」，**不动「等用户」**——那是「已升级给人」，人没回话机器不该自己动。
 *
 * @param {Array} prs  开放 PR（要带 number / headRefOid / labels）
 * @param {Object} ledger  `pushed:<pr>@<head>[@e<epoch>]` → { at, pr, head }
 * @param {Array} pushedThisRound  本轮刚推过的键（刚认输的别当场又摘掉）
 * @param {string|null} epoch  本轮的判据版本（lib/retry-epoch.mjs）；拿不到就退回只认 ①
 */
export function planExhaustedLabelClear({ prs = [], ledger = {}, pushedThisRound = [], epoch = null } = {}) {
  const book = ledger && typeof ledger === 'object' ? ledger : {};
  const nowEpoch = typeof epoch === 'string' && /^[0-9a-f]{12}$/.test(epoch) ? epoch : null;
  const justPushed = new Set((Array.isArray(pushedThisRound) ? pushedThisRound : []).map(String));
  const clears = [];
  const skipped = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (!pr || pr.number == null) continue;
    const n = pr.number;
    if (!Array.isArray(pr.labels)) { skipped.push({ pr: n, why: 'labels-unscanned' }); continue; }
    const names = labelNames(pr.labels);
    if (!names.includes(EXHAUSTED_LABEL)) continue;          // 没这个标，不是本函数的事
    if (names.includes(WAITING_USER_LABEL)) { skipped.push({ pr: n, why: 'waiting-user' }); continue; }
    const head = typeof pr.headRefOid === 'string' && pr.headRefOid.trim() ? pr.headRefOid.trim() : null;
    if (!head) { skipped.push({ pr: n, why: 'head-unscanned' }); continue; }  // 没查成不动手（摘错要重认输一轮）
    // 找这张 PR 的认输记录。取 **at 最新**的那条，不是 Object.keys 里第一条——
    // 一张 PR 在账本里有几十条（#1118 有 32 条），Object.keys 的顺序是插入顺序，
    // 拿第一条 = 拿最老的，比较出来的「工人推了新东西」是拿 7 天前的 head 比的。
    const mine = Object.keys(book)
      .filter((k) => { const v = book[k]; return v && Number(v.pr) === Number(n); })
      .map((k) => ({ key: k, at: Date.parse(book[k].at || '') || 0, head: String(book[k].head || '') }))
      .sort((a, b) => b.at - a.at);
    const latest = mine[0] || null;
    const recordedHead = latest ? latest.head : '';
    if (!recordedHead) { skipped.push({ pr: n, why: 'no-ledger-head' }); continue; }
    const recordedEpoch = latest ? epochOfPushKey(latest.key) : null;
    if (justPushed.has(exhaustedPushKey(n, head, nowEpoch) || '')) { skipped.push({ pr: n, why: 'just-pushed' }); continue; }
    if (recordedHead === head) {
      // head 没动。这时只有「判据变了」或「老记录没带版本」能让它过期。
      if (!recordedEpoch) {
        clears.push({
          pr: n, head, recordedHead, reason: 'epoch-missing',
          why: `PR #${n} 的认输记录是加判据版本之前写的（head ${head.slice(0, 8)}）——`
            + `无从判断它是不是还成立。留着 = 可能永久卡死，摘掉 = 最多多试几次（有上限兜底），故按过期处理，摘标重回流水线`,
        });
        continue;
      }
      if (!nowEpoch) { skipped.push({ pr: n, why: 'epoch-unscanned' }); continue; } // 本轮版本没算成，没依据，不动手
      if (recordedEpoch !== nowEpoch) {
        clears.push({
          pr: n, head, recordedHead, reason: 'epoch-changed',
          why: `PR #${n} 认输时的判据版本 ${recordedEpoch} 已不是现在的 ${nowEpoch}`
            + `——挡住它的那套判据改过了，旧认输对新判据不成立，摘标让它重获机会`,
        });
        continue;
      }
      skipped.push({ pr: n, why: 'same-head-same-epoch' });
      continue;
    }
    clears.push({
      pr: n, head, recordedHead, reason: 'new-head',
      why: `PR #${n} 认输记录在 head ${recordedHead.slice(0, 8)}，现在已是 ${head.slice(0, 8)}`
        + `——工人推了新东西 = 新局面，旧认输不成立，摘标让它重回流水线`,
    });
  }
  return { clears, skipped };
}
