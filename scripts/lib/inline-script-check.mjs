// dao-check ㊲：判据不得经过外壳的引号层（2026-09-13 用户拍板「赞同」，随 #1240）。
//
// 病（2026-09-13 实咬）：我在 bash 里用 `node -e ".../@e([0-9a-f]{12})$/..."` 验一件事，
// bash 把双引号里的 `$/` 当成变量展开 **吞掉了**，命令照常 exit 0、输出照常像模像样。
// 那晚的「验证」因此全部不可靠——**闸不报错、结果也不报错，只有判据被改过了**。
// 这不是 Windows 方言问题（同一行在 Linux 上一样吞），是「引号套引号」：
// 外壳负责一轮展开，我再往里塞一层需要原样保留的 `$`，等于把判据交给外壳作文。
//
// 判据要**恰好等于外壳的规则**，不能比它宽也不能比它窄：
//   - 比真闸宽（见到 `$` 就报）→ 单引号里的 `$`、`\$` 转义、注释里的讨论全被误报，
//     红得没道理的闸最后一定被关掉（仓规）。
//   - 比真闸窄（只认 `$(`）→ 漏掉 `$/`、`$名` 这些同样会被吞的形状。
// 所以本文件带一个**引号状态扫描器**（不是词表）：先算出一行里哪些字符落在
// 「未转义的双引号区间」内，再只在那些区间里找 `$` 与反引号。
//
// 四种形状：
//  1. 内联代码解释器（`node -e` / `node --eval` / `python3 -c` / `perl -e` / `ruby -e`）
//     的代码里，出现落在双引号区间的 `$`/反引号 → 红。正当做法：代码写文件再跑。
//  2. `--body` 当参数传，正文里有落在双引号区间的 `$(`/`${`/反引号 → 红。
//     正当做法：`--body-file f.md`。
//  3. `gh issue create|comment|edit` 带 `--body` → 红（#792 同口径：写动作只走网关，
//     网关只收 `--body-file`）。这一条不看引号状态：**参数形状本身**就是违反。
//  4. node_modules / docs/observations 不扫。
//
// 检查器自持解析，不 import 任何 shell 解析器、不 import 网关——本文件不执行任何命令。
//
// 三态必须分得开：
//   unscanned —— 没给文件清单 / 扫到 0 份文本（没查成）
//   red       —— 扫到违规（每条给出 文件:行 + 命中形状 + 修法）
//   ok        —— 扫了 N 份文本，0 个违规

const INLINE_CODE_RES = [
  { name: 'node', re: /\bnode\s+(?:--eval|-e)\b/ },
  { name: 'python', re: /\b(?:python3?|py)\s+-c\b/ },
  { name: 'perl', re: /\bperl\s+-e\b/ },
  { name: 'ruby', re: /\bruby\s+-e\b/ },
];

/**
 * 一行的引号状态扫描：返回每个字符的下标是否落在「未转义的双引号区间」内。
 *
 * 规则（与 POSIX shell 一致的那部分）：
 *   - 单引号内一切原样，直到下一个单引号（单引号内不能转义）。
 *   - 双引号内 `\` 只对 `$ ` \` " \n` 生效，对 `\d` 这种是原样保留。这里按
 *     「双引号内任何 `\` 都转义下一个字符」处理——只会让判据更窄，不会更宽。
 *   - `#` 在未引用状态且位于词首 → 该行剩余部分是注释。
 *
 * 一行独立判，不跨行；但**引号没闭合**（`node -e "…` 写在多行里）时，闭区间
 * 一律算作「双引号内」——「没判断出来」要往红的那边倒（本仓硬规矩）。
 * 唯一的例外：行末落在**未闭合的单引号**里（`node -e '…` 跨行），那是正当用法
 * （`scripts/install-dao-gh-events.sh:56` 就是），单引号里外壳一个字都不动。
 */
export function quoteMask(line, carry = null) {
  const s = String(line || '');
  const n = s.length;
  const inDouble = new Array(n).fill(false);
  const inSingle = new Array(n).fill(false);
  const inComment = new Array(n).fill(false);
  let mode = carry === 'single' || carry === 'double' ? carry : 'none';
  let comment = false;
  let openQuote = mode === 'none' ? -1 : -1;
  let openQuoteKind = mode === 'none' ? null : mode;
  let openAt = mode === 'none' ? -1 : 0;
  for (let i = 0; i < n; i++) {
    const ch = s[i];
    if (comment) { inComment[i] = true; continue; }
    if (ch === '\\' && mode !== 'single') { i += 1; continue; }
    if (ch === '#' && mode === 'none') {
      // 词首才算注释：前一个字符是空白或行首。
      const prev = i === 0 ? ' ' : s[i - 1];
      if (/\s/.test(prev)) { comment = true; inComment[i] = true; continue; }
    }
    if (ch === "'" && mode !== 'double') {
      if (mode === 'single') { mode = 'none'; openQuote = -1; openQuoteKind = null; openAt = -1; }
      else { mode = 'single'; openQuote = i; openQuoteKind = 'single'; openAt = i; }
      continue;
    }
    if (ch === '"' && mode !== 'single') {
      if (mode === 'double') { mode = 'none'; openQuote = -1; openQuoteKind = null; openAt = -1; }
      else { mode = 'double'; openQuote = i; openQuoteKind = 'double'; openAt = i; }
      continue;
    }
    if (mode === 'single') inSingle[i] = true;
    else if (mode === 'double') inDouble[i] = true;
  }
  // 行末仍未闭合：从开引号那一格起、这一行剩下的部分都归它。
  // 跨行时这一段的边界由 quoteMasksOfText 修——它知道下一行是从引号态开始的。
  if (mode !== 'none') {
    const target = mode === 'single' ? inSingle : inDouble;
    const from = openAt >= 0 ? openAt : 0;
    for (let i = from; i < n; i++) if (!inComment[i]) target[i] = true;
  }
  return { inDouble, inSingle, inComment, openQuote, openQuoteKind, endMode: mode, endOpenAt: openAt };
}

/** 把 `i` 格归/不归某个引号区间。`inside=false` 是摘掉行内的保守猜测。 */
function setIn(mask, kind, i, inside = true) {
  if (kind === 'single') { mask.inSingle[i] = inside; if (inside) mask.inDouble[i] = false; }
  else { mask.inDouble[i] = inside; if (inside) mask.inSingle[i] = false; }
}

/**
 * 整段的引号掩码：**逐行把引号态带下去**（`carry`）。
 *
 * 为什么不能一行一行独立算：引号是跨行的。`node -e '…'` 续写时，续写行里的
 * `"` 在单引号里是普通字符，不是切换点；只看这一行就会把它当双引号的开引号，
 * 于是判定反过来——外层引号里的 `$`（安全）被判危险，外层引号外的真违规被判安全。
 *
 * 带状态就没有这个歧义：上一行没收尾的引号，下一行从那个引号态开始算。
 * 行内未闭合的引号从开引号那一格起整段归它（保守），跨行段由 `carry` 保证连续。
 */
export function quoteMasksOfText(text) {
  const lines = String(text || '').split(/\n/);
  const masks = [];
  let carry = null;
  for (const line of lines) {
    const m = quoteMask(line, carry);
    masks.push(m);
    carry = m.endMode === 'none' ? null : m.endMode;
  }
  return { lines, masks };
}

/**
 * 带 heredoc 状态的逐行扫描器。
 *
 * `<<'EOF'` / `<<"EOF"`：**定界符被引用 = 正文一个字都不展开**，是躲开外壳的正规军
 * （三规则之一）。这种 heredoc 里的 `$` 全部放行——不认它，闸就会被正当用法刷红。
 * `<<EOF`（定界符没引用）：正文**会**展开，照常扫。`<<-EOF` 允许前置 tab 缩进。
 *
 * heredoc 状态在本函数里带下去；引号状态由 `quoteMasksOfText` 在整段上算好。
 */
export function scanInlineScriptText(text, { file = '' } = {}) {
  const { lines, masks } = quoteMasksOfText(text);
  let heredocTag = null;   // 正在某个 heredoc 正文里
  let heredocQuoted = false;
  const violations = [];
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (heredocTag != null) {
      const isEnd = heredocQuoted
        ? line.trim() === heredocTag
        : line === heredocTag || line.trim() === heredocTag;
      if (isEnd) { heredocTag = null; heredocQuoted = false; }
      return; // heredoc 正文不判：引用的定界符一个字都不展开
    }
    const open = matchHeredocStart(line);
    if (open) {
      heredocTag = open.tag;
      heredocQuoted = open.quoted;
      // 定界行本身仍要判（`cat > x <<EOF` 后面跟的东西与 heredoc 正文无关）。
    }
    const v = judgeInlineScriptLine(line, { file, lineNo, mask: masks[i] });
    if (v) violations.push(v);
  });
  return violations;
}

/** 行内是否开了一个 heredoc（`<<'EOF'` / `<<"EOF"` / `<<EOF` / `<<-EOF`）。 */
export function matchHeredocStart(line) {
  const s = String(line || '');
  if (/^\s*(?:#|\/\/)/.test(s)) return null;
  const m = /<<(-?)\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|\\?([A-Za-z_][A-Za-z0-9_]*))/.exec(s);
  if (!m) return null;
  const tag = m[2] || m[3] || m[4];
  if (!tag) return null;
  const quoted = Boolean(m[2] || m[3]);
  return { tag, quoted, stripTabs: m[1] === '-' };
}

/**
 * 内联代码解释器**代码参数**在行内的区间。
 *
 * 判据只该看「代码本身」，不该看同一行里别的词——`if [[ -f "$STATE" ]] && runuser -u
 * orca -- node -e '…'` 里，`$STATE` 是正当的参数展开（它在外层双引号里，本来就要展开），
 * 代码在后面的单引号里、一个字都不会被动。整行一起看就会把这行判红。
 *
 * 返回 `{ name, start, end }`（代码区间是 [start, end)，end = -1 表示到行尾）；
 * 命令行里没有内联代码解释器 → null。
 */
export function inlineCodeSpan(line) {
  const s = String(line || '');
  const { inComment } = quoteMask(s);
  for (const c of INLINE_CODE_RES) {
    const re = new RegExp(c.re.source, 'g');
    let m;
    while ((m = re.exec(s))) {
      if (inComment[m.index]) break;
      let i = m.index + m[0].length;
      while (s[i] === ' ' || s[i] === '\t') i += 1;
      const q = s[i];
      if (q === "'" || q === '"') {
        for (let k = i + 1; k < s.length; k++) {
          if (q === '"' && s[k] === '\\') { k += 1; continue; }
          if (s[k] === q) return { name: c.name, start: i + 1, end: k, quote: q };
        }
        return { name: c.name, start: i + 1, end: s.length, quote: q };
      }
      return { name: c.name, start: i, end: s.length, quote: null };
    }
  }
  return null;
}

/**
 * 落在**双引号区间**里的展开形状。空数组 = 这一段没有「被外壳吃掉」的风险。
 * 单引号区间里的 `$` 全部放行：外壳对单引号一个字都不动（`node -e '…'` 是正当用法）。
 *
 * 传 `syntheticDouble`（代码参数被双引号包住时）：整段本体按双引号区间判——
 * 代码里的 `'…'` 是**代码**的单引号，不是外壳的引号层，不能拿它当放行理由。
 * 抽出来的这一段必须重新算引号，不能沿用整行的掩码：整行里那段的下标与这里的对不上。
 */
export function hazardousShapes(segment, { syntheticDouble = false } = {}) {
  const s = String(segment || '');
  if (syntheticDouble) {
    const inner = `"${s.replace(/"/g, '\\"')}"`;
    const { inDouble } = quoteMask(inner);
    return shapesAt(s, (i) => inDouble[i + 1]);
  }
  const { inDouble } = quoteMask(s);
  return shapesAt(s, (i) => inDouble[i]);
}

function shapesAt(s, isDouble) {
  const shapes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '`') { if (isDouble(i)) shapes.push('`'); continue; }
    if (s[i] !== '$') continue;
    if (!isDouble(i)) continue;
    const next = s[i + 1] || '';
    if (next === '(') shapes.push('$(');
    else if (next === '{') shapes.push('${');
    else if (next === '/') shapes.push('$/');
    else if (/[A-Za-z_]/.test(next)) shapes.push('$名');
    else if (next === '"' || next === '\\') shapes.push('$"');
  }
  return [...new Set(shapes)];
}

/**
 * 抽 `--body` 的**参数值**，只在它长成命令行旗标时才认。
 *
 * 为什么不能见 `--body` 就取：仓里 `--body` 也出现在散文与 JS 模板串里——
 * `多行 --body 先写文件再 --body-file`、`` `worker-done --body 首行必须以「${prefix}」开头` ``
 * ——那些不是命令行，`${…}` 是 JS 插值、`--body-file` 是另一个旗标。按「旗标」收窄：
 * 必须前面有命令（`gh` / `node` / `perl` / 其它单词）或落在行首，且后面紧跟分隔符或 `=`。
 * 返回 { text, quoted }；没找到 → null。
 */
function splitBodyValue(line) {
  const s = String(line || '');
  const re = /(^|[\s;&|(])([A-Za-z][\w./-]*\s+)*--body(?![-a-z])/g;
  const m = re.exec(s);
  if (!m) return null;
  // 落在 JS 模板串 / Markdown 行内代码里的 `--body` 不是命令行，是散文在引用这个旗标。
  // 反引号区间的判据：本行**反引号个数为奇数**、且 `--body` 落在第一个反引号之后 →
  // 它在行内代码/模板串里。奇数判断对付不了多行模板串，但那种形状由 `.mjs` 的
  // 代码本身兜（真在模板串里插值，判的该是 JS 语义而不是外壳）。
  const before = s.slice(0, m.index);
  const ticks = (before.match(/`/g) || []).length;
  if (ticks % 2 === 1) return null;
  let i = m.index + m[0].length;
  while (s[i] === ' ' || s[i] === '\t') i += 1;
  if (s[i] === '=') { i += 1; while (s[i] === ' ' || s[i] === '\t') i += 1; }
  const q = s[i];
  if (q === "'" || q === '"') {
    let out = '';
    for (let k = i + 1; k < s.length; k++) {
      if (s[k] === '\\' && q === '"') { out += s[k + 1] || ''; k += 1; continue; }
      if (s[k] === q) return { text: out, quoted: true, quote: q };
      out += s[k];
    }
    return { text: out, quoted: true, quote: q, unterminated: true };
  }
  const tail = s.slice(i);
  const word = tail.split(/[\s;|&)}+]+/)[0] || '';
  return { text: word, quoted: false, quote: null };
}

/**
 * 纯判官：一行文本 + 所属文件，出违规或 null。
 * 只判**判据有没有经过外壳的引号层**，不判这行跑起来对不对。
 */
export function judgeInlineScriptLine(line, { file = '', lineNo = 0 } = {}) {
  const text = String(line || '');
  if (!text.trim()) return null;
  const path = String(file || '');
  if (/(^|\/)node_modules\//.test(path)) return null;
  // 整行注释：本文件在 .mjs / .js 里是解释器，在 .sh / .md 里是正文。注释里讨论
  // 「别这么写」不该报红——红得没道理的闸最后一定被关掉（仓规）。只认整行注释，
  // 行尾注释（`echo x # node -e "…$y"`）仍算动手路径，照报。
  if (/^\s*(?:#|\/\/|;;|REM\b)/i.test(text)) return null;
  // 多行注释的续行（` * …`）：`*` 起头那一格在 .js/.mjs 里是注释正文，在 shell 里
  // 是通配符词——判据取折中，只认「`* ` 起头」这种几乎只出现在块注释里的形状。
  if (/^\s*\*(\s|$)/.test(text)) return null;

  // 形状 4：gh issue 写动作带 --body（#792 同口径：写动作只走网关，网关只收 --body-file）。
  // 判据收在**正文真会被外壳碰到**的那些形状上（命令替换 / 引号层 / 变量 / 反引号），
  // 不认「--body 一律红」——闸自己的正控样本（`decideGate('gh issue create --title t
  // --body b')`）也是这个形状，一律红就会把闸自己刷成红的，红得没道理的闸会被关掉。
  if (/\bgh\s+issue\s+(?:create|comment|edit|reopen|close)\b/.test(text)) {
    const bodyVal = splitBodyValue(text);
    if (bodyVal && /[\$`]/.test(bodyVal.text)) {
      return {
        file: path, line: lineNo, lineText: text.trim(),
        kind: 'gh-issue-body-arg',
        why: 'gh issue 写动作带 --body 参数，正文里含变量/命令替换——身份与正文都不该由现场拼（#792）',
        fix: '写动作走 `node scripts/issue-gateway.mjs`，正文用 `--body-file`',
      };
    }
  }
  // 形状 1：内联代码解释器 —— 只看**代码参数**那一段（见 inlineCodeSpan 的说明）
  const span = inlineCodeSpan(text);
  if (span) {
    const codeShapes = hazardousShapes(
      text.slice(span.start, span.end < 0 ? text.length : span.end),
      { syntheticDouble: span.quote === '"' },
    );
    if (codeShapes.length) {
      return {
        file: path, line: lineNo, lineText: text.trim(),
        kind: 'inline-eval',
        why: `内联 ${span.name} 代码里出现 ${codeShapes.join('、')} 落在双引号区间——外壳先展开一轮，判据在到达解释器之前就被改掉了`,
        fix: '把代码写进文件再跑（`node /tmp/x.mjs`），不要用 -e/-c 传代码',
      };
    }
  }

  // 形状 2：`--body` 真当参数传，且正文里有命令替换（只看命令替换，不看裸 `$名`）
  const bodyArg = splitBodyValue(text);
  if (bodyArg) {
    // 判据落在**正文本身**上：正文被双引号包住时按双引号区间判（`'…'` 是正文内容，
    // 不是外壳的引号层）；没被包住就自己包一层——命令行上裸写 `--body $(date)` 同样会展开。
    const bodyShapes = hazardousShapes(bodyArg.text, { syntheticDouble: bodyArg.quote !== "'" });
    const subst = bodyShapes.filter((s) => s === '$(' || s === '${' || s === '`');
    if (subst.length) {
      return {
        file: path, line: lineNo, lineText: text.trim(),
        kind: 'inline-body',
        why: `--body 当参数传，正文里有 ${subst.join('、')} 落在双引号区间——外壳先展开，正文与实测值不一致且不报错`,
        fix: '正文写进文件，用 `--body-file f.md`',
      };
    }
  }

  return null;
}

/**
 * 扫一批 {path, text}，出违规名单。
 * files 不是数组 / 长度为 0 → unscanned（「一个都没扫到」不许当绿）。
 */

export function inspectInlineScripts({ files } = {}) {
  if (!Array.isArray(files)) {
    return { ok: false, unscanned: true, error: '没给文件清单（没查成）', violations: [], scanned: 0 };
  }
  if (files.length === 0) {
    return { ok: false, unscanned: true, error: '扫到 0 份文本（没查成，不是 0 个违规）', violations: [], scanned: 0 };
  }
  const violations = [];
  let scanned = 0;
  for (const f of files) {
    const path = f && f.path != null ? String(f.path) : '';
    if (!f || typeof f.text !== 'string') {
      return {
        ok: false, unscanned: true,
        error: `读 ${path || '(无名)'} 失败：没给正文（没查成）`,
        violations: [], scanned,
      };
    }
    scanned += 1;
    for (const v of scanInlineScriptText(f.text, { file: path })) violations.push(v);
  }
  return { ok: violations.length === 0, unscanned: false, error: null, violations, scanned };
}

/** 扫哪些文件：仓内动手面（脚本 + 装机文档 + skill），不含派生数据与 node_modules。 */
export const INLINE_SCAN_SUFFIXES = ['.mjs', '.js', '.sh', '.bash', '.md', '.markdown'];
export const INLINE_SCAN_SKIP_DIRS = ['node_modules', '.git', '.claude/worktrees', 'docs/observations'];

/**
 * 这个相对路径是不是**样本**——故意违规的输入，不是动手路径。
 *
 * live 扫描必须跳过它们，否则闸给自己报红：`tests/fixtures/**` 里放的就是
 * 「这条必须被拦下」的样本，`tests/**` 里则写满了「喂这条进去该判红」的用例。
 * 判官本身（`judgeInlineScriptLine` / `scanInlineScriptText`）对样本一视同仁——
 * 判别力正是靠「样本喂进去必须红」验的，这个开关只属于 live 那一层。
 */
export function isSamplePath(rel) {
  const n = String(rel || '').replace(/\\/g, '/');
  if (/(^|\/)tests\/fixtures\//.test(n)) return true;
  // 判据自身的测试：文件里写满了「喂这条进去该判红」的用例，那些字面量必须长得
  // 像违规才验得出判别力。**只认这一个文件**，不认整个 tests/ ——
  // `tests/tool-use-gate.test.js` 那次实咬（2026-08-2x）就是「活代码里藏着违规形状」，
  // 把 tests/ 整个排除掉就会漏掉下一个。
  return /(^|\/)tests\/inline-script\.test\.js$/.test(n);
}

function hasScanSuffix(rel) {
  return INLINE_SCAN_SUFFIXES.some((s) => String(rel || '').endsWith(s));
}

function inSkipDir(rel) {
  const n = String(rel || '').replace(/\\/g, '/');
  return INLINE_SCAN_SKIP_DIRS.some((d) => n === d || n.startsWith(`${d}/`) || n.includes(`/${d}/`));
}

/**
 * 取扫描面：优先 `git ls-files`（追踪面），git 不可用时退回遍历（跳过 .git / node_modules）。
 * 取不到 → null（调用方判没查成）。
 */
export function listScanFiles({ root, spawnSync, readdir, stat } = {}) {
  if (typeof root !== 'string' || !root) return null;
  if (typeof spawnSync === 'function') {
    const r = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (r && r.status === 0 && typeof r.stdout === 'string') {
      const all = r.stdout.split(/\r?\n/).filter(Boolean).map((f) => f.replace(/\\/g, '/'));
      if (all.length) return all.filter((f) => hasScanSuffix(f) && !inSkipDir(f));
    }
  }
  if (typeof readdir !== 'function' || typeof stat !== 'function') return null;
  const out = [];
  const walk = (dir, prefix) => {
    let names;
    try { names = readdir(dir); } catch { return; }
    if (!Array.isArray(names)) return;
    for (const name of names) {
      if (name === '.git' || name === 'node_modules') continue;
      const p = `${dir}/${name}`;
      const rel = prefix ? `${prefix}/${name}` : name;
      let st;
      try { st = stat(p); } catch { continue; }
      if (st && st.isDirectory()) walk(p, rel);
      else if (st && st.isFile() && hasScanSuffix(rel) && !inSkipDir(rel)) out.push(rel);
    }
  };
  walk(root, '');
  return out.length ? out : null;
}

/**
 * 夹具判别力：red 必须拦下、ok 必须绿、empty 必须标没查成。
 * 红样本必须同时证明「三种被吞的形状」都能命中（`$/`、`${`、`$(`），
 * 且 `ok/` 里的正当用法（单引号无 `$`、代码写文件、`--body-file`）一个都不许报。
 */
export function inspectInlineScriptsFixtures({
  rootRel = 'tests/fixtures/inline-script',
  exists, readdir, readFile,
} = {}) {
  if (typeof exists !== 'function' || typeof readdir !== 'function' || typeof readFile !== 'function') {
    return { ok: false, unscanned: true, error: '没给 exists/readdir/readFile 探头（没查成）' };
  }
  if (!exists(rootRel)) {
    return { ok: false, unscanned: true, error: `样本目录不在：${rootRel}` };
  }
  const kinds = { red: 0, ok: 0, empty: 0 };
  const problems = [];
  for (const kind of ['red', 'ok', 'empty']) {
    const dir = `${rootRel}/${kind}`;
    if (!exists(dir)) {
      problems.push(`缺 ${kind}/`);
      continue;
    }
    let names;
    try {
      names = readdir(dir);
    } catch (e) {
      problems.push(`列 ${dir} 失败：${String(e && e.message ? e.message : e).slice(0, 120)}`);
      continue;
    }
    if (!Array.isArray(names)) {
      problems.push(`列 ${dir} 没给名单`);
      continue;
    }
    const files = [];
    // 隐藏文件是 git 占位（`.gitkeep`），不是样本——算进去的话 empty/ 永远绿不了。
    for (const n of names.filter((x) => typeof x === 'string' && !x.startsWith('.'))) {
      let text;
      try {
        text = readFile(`${dir}/${n}`);
      } catch {
        problems.push(`读 ${dir}/${n} 失败`);
        continue;
      }
      if (typeof text === 'string') files.push({ path: `${dir}/${n}`, text });
    }
    const r = inspectInlineScripts({ files });
    if (kind === 'empty') {
      if (!r.unscanned) problems.push(`empty/ 应没查成但判成 ok=${r.ok} unscanned=${r.unscanned} scanned=${r.scanned}`);
      else kinds.empty += 1;
    } else if (kind === 'red') {
      if (r.unscanned || r.ok) {
        problems.push(`red/ 自称该红但判成 ok=${r.ok} unscanned=${r.unscanned}`);
      } else {
        const all = (r.violations || []).map((v) => v.lineText).join('\n');
        for (const need of ['$/', '${', '$(', 'inline-eval', 'inline-body']) {
          const has = need.startsWith('$')
            ? all.includes(need)
            : (r.violations || []).some((v) => v.kind === need);
          if (!has) problems.push(`red/ 没覆盖 ${need}`);
        }
        if (problems.length) { /* 落到下面统一返回 */ } else kinds.red += 1;
      }
    } else if (kind === 'ok') {
      if (r.unscanned || !r.ok) {
        const first = (r.violations || [])[0];
        problems.push(`ok/ 自称该绿但判成 ok=${r.ok} unscanned=${r.unscanned}${first ? `：${first.file}:${first.line} ${first.why}` : ''}`);
      } else if (r.scanned === 0) {
        problems.push('ok/ 扫了 0 份——和 empty 分不开');
      } else kinds.ok += 1;
    }
  }
  if (kinds.red === 0 || kinds.ok === 0 || kinds.empty === 0) {
    return { ok: false, unscanned: true, error: `样本种类不够 red=${kinds.red} ok=${kinds.ok} empty=${kinds.empty}`, kinds, problems };
  }
  if (problems.length) return { ok: false, unscanned: false, error: problems[0], kinds, problems };
  return { ok: true, unscanned: false, kinds };
}
