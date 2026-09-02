// scripts/lib/dispatch/agent-ready.mjs —— start=agent 落成裸 shell 的屏面分类与回退计划（#802）
//
// 改这段前必须知道：无头 Linux 上 worker-start --agent pi|devin 可能起的是裸 bash，
// 任务书被当 shell 命令执行（现场：`读: command not found`）。Orca 1.4.x 的
// TUI_AGENT_CONFIG 里有 pi/devin，所以「id 在目录里」≠「agent 真起来了」。
// 只在屏面给出裸 shell / 注入被吃的实证时才回退 --command；空屏/spinner
// 不当回退（那可能是 grok 还在画 logo）。回退是往已有终端里送 launch 命令，
// 不是再 worker-start --terminal（Windows 上那条会 agent_unconfigured）。

const SHELL_ATE_INJECT_RE = /command not found|不是内部或外部命令|无法将[\s\S]{0,24}项识别|No such file or directory/i;
const AGENT_READY_RE = /Grok Build|always-approve|Ask Devin to build|╭─|╰─|ctrl\+q|Shift\+Tab:mode|\[Pasted (?:Content|text)|Working\b|Grok \d|Devin CLI|OpenAI Codex|cursor-agent|pi coding agent/i;
const SPINNER_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|Starting MCP servers|Connecting|正在启动|初始化|请稍候|加载中/;
const BARE_SHELL_RE = /(?:^|\n)(?:PS [^>\n]*>|[A-Z]:\\[^>\n]*>|[^@\s\n]+@[^:\s\n]+:[^$#\n]*[#$]|bash-\d[\d.]*[#$]|\*|\$|#)\s*$/;

export function classifyAgentScreen(text) {
  const s = String(text || '');
  if (!s.trim()) return { kind: 'empty', reason: '读了是空的' };
  if (SHELL_ATE_INJECT_RE.test(s)) {
    return { kind: 'shell-ate-inject', reason: '任务书被 shell 当命令执行（command not found）' };
  }
  if (AGENT_READY_RE.test(s)) {
    return { kind: 'agent-ready', reason: '屏面有 agent TUI 指纹' };
  }
  const end = s.trimEnd();
  if (SPINNER_RE.test(s) && !BARE_SHELL_RE.test(end)) {
    return { kind: 'spinner', reason: 'TUI 还在加载' };
  }
  if (BARE_SHELL_RE.test(end) || /(?:^|\n)(?:PS .*>|\$)\s*$/.test(end)) {
    return { kind: 'bare-shell', reason: '屏面是裸 shell 提示符' };
  }
  return { kind: 'unknown', reason: '屏面既不是明确的 TUI 也不是明确的裸 shell' };
}

export function shouldFallbackToCommand(screen) {
  const kind = screen && screen.kind;
  return kind === 'bare-shell' || kind === 'shell-ate-inject';
}

/** 纯函数：看屏面要不要回退。不跑 orca。 */
export function planAgentScreenFallback({ screen, command } = {}) {
  if (!shouldFallbackToCommand(screen)) {
    return { action: 'keep', screen: screen || null };
  }
  const cmd = String(command || '').trim();
  if (!cmd) {
    return {
      action: 'fail',
      screen,
      error: `start=agent 落成裸 shell，没有 launch.command 可回退（${(screen && screen.reason) || (screen && screen.kind) || 'bare-shell'}）`,
    };
  }
  return { action: 'fallback', screen, command: cmd };
}

export function launchAttempt({
  modelId, pipeIndex, provider, mode, kind, agentId, error,
} = {}) {
  const row = {};
  if (modelId != null && String(modelId).trim() !== '') row.modelId = modelId;
  if (Number.isInteger(pipeIndex)) row.pipeIndex = pipeIndex;
  if (provider != null && String(provider).trim() !== '') row.provider = provider;
  if (mode != null && String(mode).trim() !== '') row.mode = mode;
  if (kind != null && String(kind).trim() !== '') row.kind = kind;
  if (agentId != null && String(agentId).trim() !== '') row.agentId = agentId;
  if (error != null && String(error).trim() !== '') row.error = error;
  return row;
}
