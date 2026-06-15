// 同步范围（scope）：dao-sync 第二步「同步什么」的取值。
// 一个 scope 对应一组 snapshot 文件 / cc-switch 表，导出与恢复共用同一套定义。

export const SCOPES = [
  { key: 'settings', label: '通用配置 (common_config_*)', tables: ['settings'] },
  { key: 'mcp', label: 'MCP 服务器', tables: ['mcp_servers'] },
  { key: 'skills', label: 'Skills / Skill 仓库', tables: ['skills', 'skill_repos'] },
  { key: 'prompts', label: 'Prompts', tables: ['prompts'] },
  { key: 'proxy', label: 'Proxy / 端点 / 定价', tables: ['proxy_config', 'provider_endpoints', 'model_pricing'] },
];

export const SCOPE_KEYS = SCOPES.map((s) => s.key);

// 把用户输入（'all' / 'settings,mcp' / undefined）解析成 Set 或 null（null = 全部）。
export function parseScope(value) {
  if (value === null || value === undefined || value === '' || value === 'all') return null;
  const wanted = String(value)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length || wanted.includes('all')) return null;
  const unknown = wanted.filter((k) => !SCOPE_KEYS.includes(k));
  if (unknown.length) {
    throw new Error(`未知的同步范围：${unknown.join(', ')}。可选：${SCOPE_KEYS.join(', ')} 或 all。`);
  }
  return new Set(wanted);
}

// 从 argv 里取 --only=a,b（或 --scope=a,b）。没有就返回 null（全部）。
export function parseScopeArg(argv = process.argv.slice(2)) {
  for (const arg of argv) {
    const m = /^--(?:only|scope)=(.*)$/.exec(arg);
    if (m) return parseScope(m[1]);
  }
  return null;
}

// scope 是否命中某个 key（only=null 表示全部命中）。
export function wants(only, key) {
  return !only || only.has(key);
}

export function describeScope(only) {
  if (!only) return '全部';
  return SCOPES.filter((s) => only.has(s.key)).map((s) => s.key).join(', ');
}
