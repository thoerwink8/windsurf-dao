import { ghAs, loadRoleCreds } from './gh.mjs';

// Production agents have installation credentials but deliberately no personal
// gh login. CI/dev checkouts without an App retain their explicit CLI context.
export function readBranchProtection(args, { appCredentials = loadRoleCreds,
  readAsApp = ghAs, readAsCli } = {}) {
  if (!Array.isArray(args) || args.length !== 2 || args[0] !== 'api'
    || !/^repos\/[\w.-]+\/[\w.-]+\/branches\/master$/.test(args[1])) {
    return { error: null, status: 1, stdout: '', stderr: '只允许读取仓库主分支的保护摘要' };
  }
  if (appCredentials('marshal').ok) {
    const r = readAsApp('marshal', args);
    return { error: null, status: r.ok ? 0 : (r.status || 1), stdout: r.out || '', stderr: r.error || '' };
  }
  return readAsCli(args);
}
