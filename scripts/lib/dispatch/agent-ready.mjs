// scripts/lib/dispatch/agent-ready.mjs —— start=agent 后校准注入目标（#802）
//
// 改这段前必须知道：无头 Linux 上 worker-start --agent 会把 agent 起在另一张
// 新终端（list/show 的 agentIdentity=pi|grok|…），但回的 handle / 记账的
// workerHandle 常是 worktree 自带空壳或「派工协调」壳。任务书打进壳
// （`读: command not found`），agent 那张空着等。title 指纹不可靠（Linux bash
// 标题是 user@host:path，#633 空壳识别因此失效）。只认 agentIdentity 字段：
// 有值 = agent，字段在但空 = shell，字段不在 = 没查成。校准到 agent 终端后
// 重送任务书；只有 worktree 上完全没有 agent 终端才回退往壳里送 launch。

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

/** list item 或 show 的 result.terminal。不认 title。 */
export function terminalAgentIdentity(term) {
  if (!term || typeof term !== 'object' || Array.isArray(term)) return null;
  const raw = Object.prototype.hasOwnProperty.call(term, 'agentIdentity')
    ? term.agentIdentity
    : (Object.prototype.hasOwnProperty.call(term, 'agent') ? term.agent : undefined);
  if (raw === undefined) return undefined;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

export function classifyTerminalRole(term) {
  if (term == null) return { kind: 'missing', reason: '没给终端' };
  if (typeof term !== 'object' || Array.isArray(term)) {
    return { kind: 'unscanned', reason: '终端结构不认识' };
  }
  if (!term.handle) return { kind: 'unscanned', reason: '没 handle' };
  const id = terminalAgentIdentity(term);
  if (id === undefined) {
    return { kind: 'unknown', handle: term.handle, reason: '回包没有 agentIdentity（没查成，不是判定是 shell）' };
  }
  if (id) return { kind: 'agent', handle: term.handle, agentIdentity: id };
  return { kind: 'shell', handle: term.handle, reason: 'agentIdentity 空' };
}

export function pickAgentTerminal(terminals, { worktreeId, wantAgentId } = {}) {
  if (!Array.isArray(terminals)) {
    return {
      ok: false, unscanned: true, handle: null,
      error: 'terminal list 不是数组（没查成，不是 0 个 agent）',
    };
  }
  const inTree = (worktreeId
    ? terminals.filter(t => t && t.worktreeId === worktreeId)
    : terminals.filter(Boolean));
  const agents = [];
  let sawField = false;
  for (const t of inTree) {
    const role = classifyTerminalRole(t);
    if (role.kind === 'agent') {
      sawField = true;
      agents.push({ handle: t.handle, agentIdentity: role.agentIdentity });
    } else if (role.kind === 'shell') {
      sawField = true;
    }
  }
  if (!sawField && inTree.length > 0) {
    return {
      ok: false, unscanned: true, handle: null, scanned: inTree.length,
      error: '回包没有 agentIdentity（没查成）',
    };
  }
  if (agents.length === 0) {
    return { ok: true, unscanned: false, handle: null, scanned: inTree.length, agentIdentity: null };
  }
  const want = wantAgentId ? String(wantAgentId).trim() : '';
  const chosen = (want && agents.find(a => a.agentIdentity === want)) || agents[0];
  return {
    ok: true, unscanned: false, handle: chosen.handle,
    agentIdentity: chosen.agentIdentity, scanned: inTree.length, count: agents.length,
  };
}

/** 注入目标：有 agent 终端就校准过去，不许往空壳送字。 */
export function planInjectTarget({ claimedHandle, terminals, worktreeId, wantAgentId } = {}) {
  const picked = pickAgentTerminal(terminals, { worktreeId, wantAgentId });
  if (!picked.ok && picked.unscanned) {
    return { action: 'unscanned', handle: claimedHandle || null, error: picked.error };
  }
  if (picked.handle) {
    if (claimedHandle && claimedHandle === picked.handle) {
      return {
        action: 'keep', handle: picked.handle, agentIdentity: picked.agentIdentity,
        reason: '记账 handle 已是 agent 终端',
      };
    }
    return {
      action: 'calibrate',
      handle: picked.handle,
      agentIdentity: picked.agentIdentity,
      fromHandle: claimedHandle || null,
      reason: 'workerHandle 指向空壳，校准到 agentIdentity 终端再注入',
    };
  }
  const claimed = claimedHandle && Array.isArray(terminals)
    ? terminals.find(t => t && t.handle === claimedHandle)
    : null;
  const claimedRole = claimed ? classifyTerminalRole(claimed) : { kind: 'missing' };
  if (claimedRole.kind === 'agent') {
    return {
      action: 'keep', handle: claimedHandle, agentIdentity: claimedRole.agentIdentity,
      reason: 'claimed handle 有 agentIdentity',
    };
  }
  return {
    action: 'fallback-command',
    handle: claimedHandle || null,
    reason: 'worktree 上没有 agentIdentity 终端',
  };
}
