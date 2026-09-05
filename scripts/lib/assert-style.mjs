// scripts/lib/assert-style.mjs —— 断言写法闸：复合条件不许塞进一个 assert.ok
//
// 来历（2026-09-06 用户问「我们写测试的方式是不是错的」，量完确实是）：
// 全仓 2958 处 `assert.ok`，其中 **1471 处是 `assert.ok(a && b, '手拼消息')`**；
// 而 `assert.equal` 只有 2314、`deepEqual` 219。dao.test.js 更极端：623 个 ok / 只有 6 个 equal。
//
// 为什么这是问题——不是风格洁癖，是失败时的信息量差一个量级：
//
//   assert.ok(a.pr === 43 && a.state === 'open', '应当是 43 且 open  →  ' + JSON.stringify(a))
//     ⇒ error: '应当是 43 且 open  →  {"pr":42,...}'   expected: true  actual: false
//        （哪一半坏的？得人眼比对手拼消息）
//
//   assert.deepStrictEqual(a, { pr: 43, state: 'open' })
//     ⇒ Expected values to be strictly deep-equal:
//          +   pr: 42,
//          -   pr: 43,        （直接指到字段）
//
// 行业准则：**永远断言能拆到的最简条件**——写复合省下的时间，在别人调试失败时全赔回去。
// 那 480 条手拼失败消息不是优点是症状：正因为 ok 丢掉了 expected/actual 才不得不手写，
// 而手写的会跟断言漂移（判例 hand-typed-constant-will-be-wrong）。
//
// **只看新增/改动的行。** 存量 1471 处的价值在判据本身，重写风险高于收益；
// 要止损的是「以后还这么写」。这也是本闸能上线的前提——全量判会红一千多条，
// 而红一千多条的闸等于没有闸。
//
// 注意「一个测试只能一个断言」**不是**行业共识（被广泛反驳）；真正的准则是
// 「一个测试一个行为」。所以本闸只拦「一条断言里塞多个检查」，不限制一个测试写几条断言。

/** 一行里是不是「复合条件的 assert.ok」。只认 && —— || 往往是「二选一皆可」的合法写法。 */
export const COMPOUND_OK_RE = /assert\.ok\s*\([^;]*&&/;

/**
 * @param {{file:string, added:string[]}[]} diffs 每个文件本次**新增**的行
 * @returns {{state:'ok'|'red'|'unknown', detail:string, hits?:object[]}}
 */
export function classifyAssertStyle(diffs) {
  if (!Array.isArray(diffs)) return { state: 'unknown', detail: '拿不到 diff（没查成，不是「没有违规」）' };
  const hits = [];
  for (const d of diffs) {
    if (!d || !Array.isArray(d.added)) continue;
    if (!/\.test\.(js|mjs|cjs)$/.test(d.file)) continue;   // 只管测试文件
    for (const line of d.added) {
      if (COMPOUND_OK_RE.test(line)) hits.push({ file: d.file, line: line.trim().slice(0, 90) });
    }
  }
  if (hits.length === 0) {
    return { state: 'ok', detail: `新增测试行里没有复合 assert.ok（扫了 ${diffs.length} 个文件）` };
  }
  const shown = hits.slice(0, 3).map((h) => `${h.file}: ${h.line}`).join('；');
  return {
    state: 'red',
    hits,
    detail: `${hits.length} 处新增的复合断言 —— ${shown}${hits.length > 3 ? ' …' : ''}`,
  };
}
