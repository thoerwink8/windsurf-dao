// scripts/lib/stdout-exit.mjs —— 写完 stdout 再退出
//
// `console.log` / `stdout.write` 之后立刻 `process.exit` 会把还在用户态缓冲里的字节丢掉。
// 管道下游（`dao now --json | jq`）就看到半截 JSON、进程却是 0（#1297 实咬）。
// Node 文档口径：把 exit 放到 write 的 callback / drain 之后。

/**
 * 把 text 写进 stdout，排空后再 process.exit(code)。
 * 可注入 stdout / exit，测试不必真退测试进程。
 */
export function writeStdoutAndExit(text, { stdout = process.stdout, exit = process.exit, code = 0 } = {}) {
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    exit(code);
  };
  try {
    if (!stdout || typeof stdout.write !== 'function') {
      done();
      return;
    }
    const ok = stdout.write(String(text), () => done());
    if (!ok && typeof stdout.once === 'function') stdout.once('drain', done);
  } catch {
    done();
  }
}
