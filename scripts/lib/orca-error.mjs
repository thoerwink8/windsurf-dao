// scripts/lib/orca-error.mjs —— orca 错误对象统一抽文本（#595）
//
// 改这段前必须知道：orca --json 失败时常把 error 做成对象（{code, message, files}）。
// 直接拼进字符串会变成 [object Object]，三次删树都要另跑裸命令才看得到真因。
// 提取序：error.message → error.code → JSON.stringify。任何路径都不得产出 [object Object]。

export function orcaErrorText(error) {
  if (error == null || error === '') return '';
  if (typeof error === 'string') return error;
  if (typeof error !== 'object') return String(error);

  const rawMsg = error.message;
  const msg = typeof rawMsg === 'string' ? rawMsg.trim() : '';
  const rawCode = error.code;
  const code = rawCode == null ? '' : String(rawCode).trim();

  if (msg) return code && code !== msg ? `orca 报错 ${code}: ${msg}` : msg;
  if (code) return `orca 报错 ${code}`;

  try {
    const json = JSON.stringify(error);
    if (json && json !== '{}' && json !== '[]') return json;
  } catch {
    // 循环引用等
  }
  return 'orca 报错（对象无法序列化）';
}
