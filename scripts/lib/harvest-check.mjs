// 回流闸（issue #888）：好东西不许烂在单里。
//
// 病：通用产物只在做它的那张单里躺着。指望「记得抽出来」= 靠自觉，实证四次全哑
// （判机制不靠自觉，2026-09-04 拍板）；靠用户口头提醒 = 用户当闸，最贵的一种闸。
//
// 闸：交卷时士兵在 PR 正文写 `## 回流` 段（士兵书自查第 5 条）；合并时收口官/帅接单，
// 在段内回写受理证据。**孤儿回流段 = 有人发现了好东西但没人接** → 红，点名 PR。
//
// 两套独立逻辑，禁止互相调用：
//   scanHarvestSection —— 只认 PR 正文里的段与受理行，不查 issue 存不存在。
//   judgeHarvest       —— 只吃已扫出的结构，不碰 IO、不发网络请求。
// 自己查自己查不出错：判官不复用「写段的人自己说已受理」以外的推断。
//
// 零样本：给了 PR 列表却一条正文都没扫到 = 没查成（红），不是「都没写回流段」。
// 三行体：段里缺任一行（产物/为什么通用/落点）→ 红。空段比没段更坏——它看着像做了。
//
// **按 Markdown 行边界解析**（PR #890 审官 P1）：老版本用 indexOf/无锚正则，于是
// `### 回流`、正文里反引号包着的 `` `## 回流` ``、`## 回流历史`、以及把三个字段挤成
// 一行（`产物：x；为什么通用：…；落点：…；已回流：abcdef1`）全都被判 ok:true——
// 格式不合规、实际没有三行的段能绕过闸。现在：
//   · 段标题只认**独立的二级标题行**且标题正文恰好是「回流」；
//   · 三个字段与受理证据**各自匹配独立行**（行首锚 + 一行只放一个字段）；
//   · 围栏代码块（``` / ~~~）内的行一律不算——正文里演示模板不该被当成真回流段。
//
// 收紧后 `### 回流`、散句提到 `## 回流`（本 PR 正文自己就有）一律「不认」——不是段，
// 不参与判定。这就是设计页已拍的取舍：**宁可漏报，不做「没写回流段」的自动识别**。
// 把标题层级写错单独判红是另一件事（要另立一类红），本单不做，不在这里顺手扩范围。

export const SECTION_HEADING = '## 回流';
/** 段标题正文（去掉 `## ` 与 ATX 闭合井号后必须恰好等于它）。 */
const SECTION_TITLE = '回流';
/** 段内三行的必填标记。写法宽松（认中文冒号或英文冒号），缺一行即红。 */
export const REQUIRED_FIELDS = ['产物', '为什么通用', '落点'];
/** 受理证据：开了回流单，或已经就地上收（给 sha / PR 号），或明确判定不上收（要写原因）。 */
const ACCEPT_RULES = [
  { key: '回流单', tail: String.raw`#\d+` },
  { key: '已回流', tail: String.raw`(?:[0-9a-f]{7,40}|#\d+)` },
  { key: '不回流', tail: String.raw`\S` },   // 明确判定不值得上收，也算接住了（要写原因）
];

/** 围栏代码块起止行（``` 或 ~~~，最多 3 空格缩进）。 */
const FENCE_RE = /^[ \t]{0,3}(?:`{3,}|~{3,})/;
/** ATX 标题行。捕获井号串与标题正文。 */
const HEADING_RE = /^[ \t]{0,3}(#{1,6})[ \t]+(.*)$/;
/** 行首可以有的装饰：列表符号 / 有序号 / 粗体开头。字段名必须紧跟其后。 */
const LEAD = String.raw`^[ \t]{0,3}(?:[-*+][ \t]+|\d{1,9}[.)][ \t]+)?(?:\*\*|__)?`;
/**
 * 字段名与冒号之间允许的收尾装饰：粗体闭合，和一段括号限定语。
 * 限定语这条是被真语料咬出来的——PR #901 写的是 `**为什么通用（≥2 场景）**：`，
 * 而士兵任务书模板自己就把「（说得出 ≥2 个使用场景才算）」写在字段名后面。
 * 只放行成对括号里的短限定语（不放行任意文字），行首锚不动：挤成一行照旧不算。
 */
const AFTER_KEY = String.raw`(?:\*\*|__)?(?:[（(【\[][^）)】\]\n]{0,60}[）)】\]])?(?:\*\*|__)?[ \t]*[：:][ \t]*`;

/** 「行首独立字段标记」：只认标记本身，值可以空（留给下面的换行取值）。 */
function fieldLabelRe(key) {
  return new RegExp(`${LEAD}${key}${AFTER_KEY}`);
}
/** 「行首独立字段行」正则：`产物：x`、`- 产物：x`、`- **产物**：x` 都算；行尾挤进来的不算。 */
function fieldLineRe(key) {
  return new RegExp(`${LEAD}${key}${AFTER_KEY}(.*)$`);
}
/**
 * 「行首独立受理行」正则：证据必须自己占一行的行首，不能挂在别的字段行尾。
 * 受理证据不给换行取值——它就一个 sha / #N / 一句原因，写不下才是没写（`不回流：` 空着 = 没接）。
 */
function acceptLineRe(rule) {
  return new RegExp(`${LEAD}${rule.key}${AFTER_KEY}${rule.tail}`);
}

/** 这一行是不是「某个必填字段或受理证据的标记行」——换行取值到这里必须停。 */
function isAnyLabelLine(text) {
  return REQUIRED_FIELDS.some(k => fieldLabelRe(k).test(text))
    || ACCEPT_RULES.some(r => fieldLabelRe(r.key).test(text));
}

/** 去掉 ATX 闭合井号（`## 回流 ##`）后的标题正文。 */
function headingTitle(raw) {
  return String(raw).replace(/[ \t]+#+[ \t]*$/, '').trim();
}

/**
 * 把正文切成行，标出哪些行在围栏代码块里。返回 [{ text, fenced }]。
 * 围栏只做「开/关」翻转（不追字符与长度）——PR 正文的复杂度到不了那一层，
 * 而多切一点总比把示例段当真段判红好。
 */
function splitLines(text) {
  const out = [];
  let inFence = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (FENCE_RE.test(line)) {
      // 围栏行本身既不是内容也不是标题
      out.push({ text: line, fenced: true });
      inFence = !inFence;
      continue;
    }
    out.push({ text: line, fenced: inFence });
  }
  return out;
}

/** 这一行是不是「独立的 `## 回流` 标题行」。 */
function isSectionHeadingLine(line) {
  if (line.fenced) return false;
  const m = line.text.match(HEADING_RE);
  if (!m) return false;
  return m[1].length === 2 && headingTitle(m[2]) === SECTION_TITLE;
}

/** 这一行是不是「结束回流段」的标题行（同级或更高级：`# ` / `## `）。 */
function isSectionEndLine(line) {
  if (line.fenced) return false;
  const m = line.text.match(HEADING_RE);
  return Boolean(m) && m[1].length <= 2;
}

/**
 * 扫一份 PR 正文。返回 { has, fields, missing, accepted, acceptedBy, section }。
 * 不查 issue 是否真存在——那是 live 检查另一条腿的事，这里只认正文自述。
 */
export function scanHarvestSection(body) {
  const lines = splitLines(String(body || ''));
  const at = lines.findIndex(isSectionHeadingLine);
  if (at === -1) {
    // 没有独立的 `## 回流` 标题行 = 没段，不参与判定（`### 回流`、散句提及都走这条）。
    return { has: false, fields: {}, missing: [], accepted: false, acceptedBy: null };
  }

  // 段落到下一个同级/更高级标题行为止（`### ` 是段内子标题，不结束段）。
  const body_ = lines.slice(at + 1);
  const endAt = body_.findIndex(isSectionEndLine);
  const section = endAt === -1 ? body_ : body_.slice(0, endAt);
  const contentLines = section.filter(l => !l.fenced).map(l => l.text);

  const fields = {};
  for (const key of REQUIRED_FIELDS) {
    const re = fieldLineRe(key);
    const others = REQUIRED_FIELDS.filter(k => k !== key);
    for (let i = 0; i < contentLines.length; i++) {
      const m = contentLines[i].match(re);
      if (!m) continue;
      let val = String(m[1]).trim();
      // 一行只放一个字段：值里再挤别的必填字段 = 三个字段挤成一行，不算三行体。
      if (val && others.some(k => new RegExp(`${k}[ \\t]*[：:]`).test(val))) continue;
      // 标记行以冒号收尾、值写在下面几行（Markdown 常见写法，PR #901 实例）：
      // 往下找第一行有字的内容当值；撞到下一个字段/受理标记就停——那说明这个标记下面是空的。
      if (!val) {
        for (let j = i + 1; j < contentLines.length; j++) {
          const next = contentLines[j];
          if (isAnyLabelLine(next)) break;
          if (next.trim()) { val = next.trim(); break; }
        }
      }
      if (!val) continue;
      fields[key] = val;
      break;
    }
  }
  const missing = REQUIRED_FIELDS.filter(k => !fields[k]);

  let acceptedBy = null;
  for (const rule of ACCEPT_RULES) {
    const re = acceptLineRe(rule);
    const hit = contentLines.find(text => re.test(text));
    if (hit) { acceptedBy = hit.trim(); break; }
  }
  return {
    has: true,
    fields,
    missing,
    accepted: Boolean(acceptedBy),
    acceptedBy,
    section: contentLines.join('\n'),
  };
}

/**
 * 判官。吃 [{number, title, body, mergedAt}]，出 { ok, unscanned, orphans[], thin[], accepted[] }。
 * - orphans：有段、没受理证据（合并了却没人接）。
 * - thin：有段、三行不全（空段最坏：看着像做了）。
 */
export function judgeHarvest(prs) {
  if (!Array.isArray(prs)) {
    return { ok: false, unscanned: true, error: '没拿到 PR 列表——没查成', orphans: [], thin: [], accepted: [] };
  }
  if (prs.length === 0) {
    // 近窗口内一个合并 PR 都没有：本项无从判断，交给调用方按 SKIP 处置（不是绿）。
    return { ok: true, unscanned: false, empty: true, orphans: [], thin: [], accepted: [] };
  }
  const orphans = [];
  const thin = [];
  const accepted = [];
  let scanned = 0;
  for (const pr of prs) {
    if (!pr || pr.number == null) continue;
    // 正文读到了才算扫成。全是空正文 = 取数那步没成（gh 字段没取对/权限不够），
    // 不是「大家都没写回流段」——这两者的处置完全不同。
    if (typeof pr.body !== 'string' || pr.body.trim() === '') continue;
    scanned += 1;
    const r = scanHarvestSection(pr.body);
    if (!r.has) continue;
    if (r.missing.length) thin.push(`#${pr.number} 回流段缺「${r.missing.join('/')}」`);
    if (!r.accepted) orphans.push(`#${pr.number} 回流段没人接（缺 回流单:#N / 已回流:<sha> / 不回流:<原因>）`);
    else accepted.push(`#${pr.number} ${r.acceptedBy}`);
  }
  if (scanned === 0) {
    return { ok: false, unscanned: true, error: '给了 PR 却一条都没扫成——没查成', orphans: [], thin: [], accepted: [] };
  }
  return {
    ok: orphans.length === 0 && thin.length === 0,
    unscanned: false, scanned, orphans, thin, accepted,
  };
}

// ── live 腿的取数覆盖面（PR #890 审官 P1）────────────────────────────────────
// 病：老版本硬编码 `--limit 30`，而近 7 天真实 merged PR 已 40 个（2026-09-04 实测：
// limit 30 恰好回 30 条 = 取满，limit 100/1000 都回 40）。被截掉的那 10 个里若有孤儿段
// 会**静默漏报**，话面却写「近 7 天 30 个已合并 PR 全有受理证据」= 把部分扫描报成全量通过。
// 这正是本仓最常犯的那条病：「没查成」显示成「查过没事」。
//
// 修：上限抬到 HARVEST_LIVE_LIMIT（1000，与同文件 checkLedgerGapLive 的取数上限一致），
// **且取满即 fail-closed**——条数摸到上限就说明结果可能被截断，只能报「没查成」。
// 取数参数与上限判据共用同一个常量（harvestLiveArgs / judgeHarvestCoverage），
// 防「改了 limit 忘了改校验」漂移。

/** live 腿一次取多少个 merged PR。取满即视为可能被截断（fail-closed）。 */
export const HARVEST_LIVE_LIMIT = 1000;

/** live 腿的 gh 参数。上限只在这里出现一次，判据读同一个常量。 */
export function harvestLiveArgs(since, limit = HARVEST_LIVE_LIMIT) {
  return [
    'pr', 'list', '--state', 'merged', '--limit', String(limit),
    '--search', `merged:>=${since}`, '--json', 'number,body,mergedAt',
  ];
}

/**
 * 覆盖面判据（纯函数，零 IO）：取到的条数摸到上限 = 结果可能不完整 = 没查成。
 * 不许把「只扫了前 N 个」报成「近 7 天全量通过」。
 */
export function judgeHarvestCoverage(count, limit = HARVEST_LIVE_LIMIT) {
  if (!Number.isInteger(count) || count < 0) {
    return { ok: false, unscanned: true, error: `取到的 PR 条数不是非负整数（${count}）——没查成` };
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    return { ok: false, unscanned: true, error: `取数上限不是正整数（${limit}）——没查成` };
  }
  if (count >= limit) {
    return {
      ok: false,
      unscanned: true,
      saturated: true,
      count,
      limit,
      error: `取到 ${count} 条 = 上限 ${limit}，结果可能被截断——没查成（不许把部分扫描报成近 7 天全量通过）`,
    };
  }
  return { ok: true, unscanned: false, saturated: false, count, limit };
}

/**
 * 夹具判别（样本检查用）。readJson(name) → [{number,body}] 或 null。
 * red 必须判红、ok 必须干净、empty 必须判没查成。
 */
export function inspectHarvestFixtures({ readJson }) {
  const red = readJson('red');
  if (!red) return { ok: false, unscanned: true, error: 'red 夹具读不到' };
  const rv = judgeHarvest(red);
  if (rv.ok) return { ok: false, unscanned: false, error: 'red 夹具没判红——闸失去判别力' };

  const okDoc = readJson('ok');
  if (!okDoc) return { ok: false, unscanned: true, error: 'ok 夹具读不到' };
  const ov = judgeHarvest(okDoc);
  if (!ov.ok) {
    return { ok: false, unscanned: false, error: `ok 夹具被误杀：${[...ov.orphans, ...ov.thin].slice(0, 2).join('；')}` };
  }

  const empty = readJson('empty');
  if (!empty) return { ok: false, unscanned: true, error: 'empty 夹具读不到' };
  const ev = judgeHarvest(empty);
  if (!ev.unscanned) {
    return { ok: false, unscanned: false, error: 'empty 夹具（有 PR 但全无正文）没判成没查成' };
  }
  return {
    ok: true,
    unscanned: false,
    kinds: { red: rv.orphans.length + rv.thin.length, ok: ov.accepted.length, empty: 1 },
  };
}
