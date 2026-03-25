// GitHub MCP Proxy Bootstrap
// Patches global fetch to route through Clash proxy for GitHub API access in China
// Usage: node --require "./github-proxy-bootstrap.js" <server-script>

const { ProxyAgent } = require('undici');

const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
const dispatcher = new ProxyAgent(PROXY_URL);

const originalFetch = globalThis.fetch;
globalThis.fetch = function patchedFetch(url, opts = {}) {
  return originalFetch(url, { ...opts, dispatcher });
};
