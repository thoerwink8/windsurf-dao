import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AcpClient, AcpRpcError } from '../../../scripts/lib/acp-client.mjs';

const scenario = process.argv[2] || 'complete';
const cwd = process.cwd();
const record = event => fs.appendFileSync(path.join(cwd, 'fake-events.ndjson'), JSON.stringify(event) + '\n', { mode: 0o600 });
let model = scenario === 'alias' ? 'default[]' : 'test-model-a[effort=high]';
let mcpServers = [];
let loaded = false;
const historyFile = path.join(cwd, 'fake-backend-session.json');
const readHistory = () => JSON.parse(fs.readFileSync(historyFile, 'utf8'));
const saveHistory = history => fs.writeFileSync(historyFile, JSON.stringify(history), { mode: 0o600 });
const configOptions = () => [{ id: 'model', category: 'model', type: 'select', currentValue: model, options: [
  { value: 'test-model-a[effort=high]', name: 'A' }, { value: 'test-model-b[effort=high]', name: 'B' },
] }];
const questions = [{ id: 'choice', prompt: 'Choose a value', allowMultiple: false, options: [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }] }];
const forever = () => new Promise(() => {});
const client = new AcpClient({ readable: process.stdin, writable: process.stdout,
  onNotification: (method, params) => record({ method, params }),
  onRequest: async (method, params) => {
    record({ method, params });
    if (method === 'initialize') {
      if (scenario === 'slow-initialize') await new Promise(resolve => setTimeout(resolve, 500));
      return { protocolVersion: 1, agentCapabilities: { loadSession: scenario !== 'no-load' && !fs.existsSync(path.join(cwd, 'disable-load')) } };
    }
    if (method === 'session/new') {
      mcpServers = params.mcpServers;
      saveHistory({ sessionId: 'fixture-session', model, prompts: [] });
      if (scenario === 'auth') throw new AcpRpcError(-32001, 'Authentication required');
      if (scenario === 'legacy-model') return { sessionId: 'fixture-session', models: { currentModelId: model, availableModels: [{ modelId: model }, { modelId: 'test-model-b[effort=high]' }] } };
      return { sessionId: 'fixture-session', configOptions: configOptions() };
    }
    if (method === 'session/load') {
      const history = readHistory();
      if (params.sessionId !== history.sessionId) throw new AcpRpcError(-32000, 'Unknown fixture session');
      loaded = true;
      model = history.model;
      mcpServers = params.mcpServers;
      record({ restoredEnvironment: process.env.ACP_RESUME_MARKER, restoredHome: process.env.HOME });
      await client.notify('session/update', { sessionId: history.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD-HISTORY-MUST-NOT-BE-NEW-OUTPUT' } } });
      await client.notify('session/update', { sessionId: history.sessionId, update: { sessionUpdate: 'usage_update', usage: { inputTokens: 91, outputTokens: 3 } } });
      // ACP LoadSessionResponse need not repeat the requested sessionId.
      return { configOptions: configOptions() };
    }
    if (method === 'session/set_config_option') {
      if (scenario !== 'mismatch') model = params.value;
      const history = readHistory(); history.model = model; saveHistory(history);
      return { configOptions: configOptions() };
    }
    if (method === 'session/set_model') return {};
    if (method !== 'session/prompt') throw new AcpRpcError(-32601, 'Fixture unsupported request');
    const history = readHistory();
    const textPrompt = params.prompt[0].text;
    history.prompts.push(textPrompt); saveHistory(history);
    if (scenario === 'resume') {
      if (!loaded) return forever();
      await client.notify('session/update', { sessionId: history.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `resumed:${history.prompts.join('|')}` } } });
      return { stopReason: 'end_turn' };
    }
    if (scenario === 'hold' || scenario === 'slow-initialize') return forever();
    if (scenario === 'delayed') await new Promise(resolve => setTimeout(resolve, 300));
    if (scenario === 'subtree') {
      const child = spawn(process.execPath, [new URL('./subtree.mjs', import.meta.url).pathname, cwd], { stdio: 'ignore' });
      record({ childPid: child.pid });
      return forever();
    }
    if (scenario === 'unknown') {
      try { await client.request('_cognition.ai/megaplan/ask', { question: 'unsupported' }); }
      catch (error) { record({ rejectedCode: error.code }); }
      return forever();
    }
    if (scenario === 'switch') {
      await client.notify('session/update', { sessionId: 'fixture-session', update: { sessionUpdate: 'current_model_update', currentModelId: 'unrequested-model' } });
      return forever();
    }
    let result;
    if (scenario === 'question') result = await client.request('cursor/ask_question', { questions });
    if (scenario === 'plan') result = await client.request('cursor/create_plan', { toolCallId: 'plan-one', name: 'A plan', overview: 'Review this plan', plan: 'Read and test', todos: [] });
    if (scenario === 'permission') result = await client.request('session/request_permission', { sessionId: 'fixture-session', toolCall: { toolCallId: 'read-one', kind: 'read', title: 'Read proof', rawInput: { path: 'proof.txt' } }, options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow once' }, { optionId: 'no', kind: 'reject_once', name: 'Reject' }] });
    if (['mcp', 'mcp-permission', 'foreign-mcp'].includes(scenario)) {
      if (scenario !== 'mcp') {
        const permission = await client.request('session/request_permission', { sessionId: 'fixture-session',
          toolCall: { kind: 'other', toolCallId: 'question-permission', title: scenario === 'mcp-permission' ? 'dao-interactions-dao_ask_user_question: dao_ask_user_question' : 'foreign-server: dao_ask_user_question' },
          options: [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'allow-always', kind: 'allow_always' }] });
        record({ mcpPermission: permission });
      }
      const spec = mcpServers.find(server => server.name === 'dao-interactions');
      if (!spec) throw new AcpRpcError(-32000, 'Missing MCP question server');
      const tool = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'ignore'] });
      const mcp = new AcpClient({ readable: tool.stdout, writable: tool.stdin });
      await mcp.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fake-acp', version: '1' } });
      const list = await mcp.request('tools/list', {});
      record({ tools: list.tools.map(tool => tool.name) });
      await client.notify('session/update', { sessionId: 'fixture-session', update: { sessionUpdate: 'tool_call', toolCallId: 'mcp-one', title: 'dao_ask_user_question', status: 'in_progress' } });
      const response = await mcp.request('tools/call', { name: 'dao_ask_user_question', arguments: { questions } }, { timeoutMs: 0 });
      result = JSON.parse(response.content[0].text);
      record({ toolResult: result });
      fs.writeFileSync(path.join(cwd, 'after-answer.txt'), result.outcome.answers?.[0]?.selectedOptionIds?.[0] || result.outcome.outcome);
      await client.notify('session/update', { sessionId: 'fixture-session', update: { sessionUpdate: 'tool_call_update', toolCallId: 'mcp-one', status: 'completed' } });
      mcp.close();
      tool.stdin.end();
    }
    if (result) record({ answer: result });
    await client.notify('session/update', { sessionId: 'fixture-session', update: { sessionUpdate: 'usage_update', usage: { inputTokens: 12, outputTokens: 3, token: 'opaque-secret', accessToken: 'opaque-access', accountId: 'private-account', note: process.env.ACP_FIXTURE_SECRET || 'safe' } } });
    await client.notify('session/update', { sessionId: 'fixture-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `finished:${result?.outcome?.outcome || 'complete'}` } } });
    if (scenario === 'question' || scenario === 'permission' || scenario === 'plan') await new Promise(resolve => setTimeout(resolve, 150));
    return { stopReason: scenario === 'incomplete' ? 'max_tokens' : 'end_turn', usage: { totalTokens: 15 } };
  },
});
client.on('closed', () => process.exit(0));
