// GitHub MCP Proxy Bootstrap
// Sets global dispatcher to route all fetch() through Clash proxy for GitHub API access in China
// Usage: node --require "./github-proxy-bootstrap.js" <server-script>

const { setGlobalDispatcher, ProxyAgent } = require('undici');

const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
setGlobalDispatcher(new ProxyAgent(PROXY_URL));
