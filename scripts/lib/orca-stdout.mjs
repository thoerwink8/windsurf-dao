// scripts/lib/orca-stdout.mjs —— 全仓 orca stdout 解析唯一入口（#580）
//
// 改这段前必须知道：orca 子命令带不带 --json，返回形状不一样。
// 2026-08-17 实测（#580 事故）：
//   terminal send 不带 --json → 纯文本 "Sent N bytes to term_<handle>."（exit 0）
//   terminal send --json      → { ok, result.send.{handle,accepted,bytesWritten} }
//   terminal read/create/close、worktree *、orchestration * → 必须 --json 才是信封
// 只修 flow 一处 send = 等下一个子命令再咬一次。新解析走这里。

const SENT_PLAIN_RE = /^Sent\s+(\d+)\s+bytes\b/i;

export function parseOrcaStdout(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return { ok: false, error: 'orca 无输出' };

  // terminal send 默认人读回执：文本送达了，不是失败。
  const sent = text.match(SENT_PLAIN_RE);
  if (sent) {
    const bytes = Number(sent[1]);
    return {
      ok: true,
      sentPlaintext: true,
      bytes,
      json: { ok: true, result: { send: { accepted: true, bytesWritten: bytes } } },
    };
  }

  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return { ok: true, json: JSON.parse(text.slice(start, end + 1)) }; }
      catch { /* fall through */ }
    }
    return { ok: false, error: `orca 输出不是 JSON: ${text.slice(0, 160)}` };
  }
}
