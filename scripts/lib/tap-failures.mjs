// 从 node --test 的 TAP 输出里取「哪几条红、各自为什么红」。
//
// 原先只取 `not ok` 那一行的测试名，YAML 块（error / expected / actual / code）整个丢掉。
// 后果：dao-check 判红时人只看得到「某测试红了」，看不到断言差在哪——#1358 追了一天，
// 三次实验都因为拿不到断言正文而只能重猜。随机红尤其吃这个亏：复现一次不一定再红，
// 当场那份输出就是唯一的现场。
//
// 只认 TAP 的 not ok 行（测试名里带 fail/错误/红 字样的 ok 行不许冒充失败证据，#566）；
// 一套红多条就全列（只报头一条会让人以为修完就绿，然后再红一轮）；
// 退出非 0 却没有 not ok 行 = 崩了/格式变了 → 返回 null，上层说「没查成」，不许拿别的行冒充。

// 每条红最多带这么多行现场；再多是刷屏，少了看不出断言差在哪
export const BODY_LINES_MAX = 6;
// 只挑这几种 YAML 键：其余（duration_ms / location / failureType）对判因没帮助
const KEEP = /^\s*(error|expected|actual|code|message|stderr|stdout|exitCode|signal):/;

/** 返回 [{ name, body: string[] }]；没有 not ok 行返回 null。 */
export function extractTapFailures(output) {
  const lines = String(output || '').split(/\r?\n/);
  const fails = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
    if (!head) continue;
    const indent = head[1].length;
    const body = [];
    let inBlock = false, keeping = false;
    // YAML 块紧跟在 not ok 后面：`  ---` 开、`  ...` 收，缩进比 not ok 深
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j];
      const lead = l.length - l.trimStart().length;
      if (!inBlock) { if (l.trim() === '---' && lead > indent) { inBlock = true; continue; } if (/^\s*(not )?ok \d+/.test(l)) break; continue; }
      if (l.trim() === '...' && lead > indent) break;
      if (KEEP.test(l)) keeping = true;
      else if (/^\s*[a-zA-Z_]+:/.test(l) && lead === indent + 2) keeping = false;   // 换到下一个不要的键
      if (keeping && l.trim() && body.length < BODY_LINES_MAX) body.push(l.trim().slice(0, 200));
    }
    fails.push({ name: head[2].trim().slice(0, 200), body });
  }
  return fails.length ? fails : null;
}

/** 给 dao-check 的证据栏用：一条红一段，名字在前、现场缩进跟在后面。 */
export function tapFailuresEvidence(output) {
  const fails = extractTapFailures(output);
  if (!fails) return '退出非 0 但没扫到标准 not ok 行——测试崩了或输出格式变了，本次没查成，需人工复现';
  const blocks = fails.map(({ name, body }) => body.length ? `${name}\n${body.map(b => '    ' + b).join('\n')}` : name);
  return `测试输出 ${fails.length} 条红：\n${blocks.join('\n')}`;
}
