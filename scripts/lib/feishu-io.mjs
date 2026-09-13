// Keep GitHub and lark-cli waits off the WebSocket callback event loop.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function runAsync(exe, args, { timeout = 60000, exec = execFile } = {}) {
  return new Promise((resolve) => {
    exec(exe, args, { encoding: 'utf8', windowsHide: true, shell: false,
      timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout || '', stderr: stderr || error?.message || '', code: error?.code || 0 });
    });
  });
}

export function readGithubAsync(_exe, args) {
  return runAsync(process.execPath, [fileURLToPath(new URL('../gh-as.mjs', import.meta.url)), 'marshal', '--', ...args]);
}

export async function writeIssueAsync(req) {
  const verb = { issue_create: 'create', issue_comment: 'comment' }[req.action];
  if (!verb) throw new Error('Unsupported Feishu issue write');
  const args = [fileURLToPath(new URL('../issue-gateway.mjs', import.meta.url)), verb,
    '--repo', req.repo, '--host', req.host, '--idempotency-key', req.idempotency_key];
  if (req.issue) args.push('--issue', String(req.issue));
  if (req.title) args.push('--title', req.title);
  args.push('--body', req.body || '');
  for (const label of req.labels || []) args.push('--label', label);
  const r = await runAsync(process.execPath, args);
  if (!r.ok) return { ok: false, error: r.stderr };
  try { return JSON.parse(r.stdout); }
  catch { return { ok: false, error: 'GitHub 写入未返回可核实的结果' }; }
}
