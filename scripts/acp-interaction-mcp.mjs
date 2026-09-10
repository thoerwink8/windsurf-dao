#!/usr/bin/env node
// Shared explicit-question tool for ACP CLIs which do not expose a native AskQuestion.
// This server writes only control messages. The durable runner owns policy and status.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AcpClient, AcpRpcError } from './lib/acp-client.mjs';
import { acpAtomicJson, acpReadJson, acpProcessAlive } from './lib/acp-runtime.mjs';

const TOOL = {
  name: 'dao_ask_user_question',
  description: 'Ask the user one or more explicit questions and wait for their answers before continuing.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['questions'],
    properties: { questions: {
      type: 'array', minItems: 1, maxItems: 10,
      items: { type: 'object', additionalProperties: false, required: ['id', 'prompt', 'options'], properties: {
        id: { type: 'string', minLength: 1 }, prompt: { type: 'string', minLength: 1 }, allowMultiple: { type: 'boolean' },
        options: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['id', 'label'], properties: { id: { type: 'string', minLength: 1 }, label: { type: 'string', minLength: 1 } } } },
      } },
    } },
  },
};

export function validateMcpQuestions(args) {
  const questions = args?.questions;
  if (!Array.isArray(questions) || !questions.length || questions.length > 10) return false;
  const unique = values => values.every(value => typeof value === 'string' && value.length) && new Set(values).size === values.length;
  return unique(questions.map(question => question?.id)) && questions.every(question =>
    typeof question.prompt === 'string' && question.prompt.length &&
    (question.allowMultiple === undefined || typeof question.allowMultiple === 'boolean') &&
    Array.isArray(question.options) && question.options.length && unique(question.options.map(option => option?.id)) &&
    question.options.every(option => typeof option.label === 'string' && option.label.length),
  );
}

export function createInteractionMcp({ sessionDir, readable = process.stdin, writable = process.stdout, pollMs = 50 }) {
  let closed = false;
  const client = new AcpClient({ readable, writable, onRequest: async (method, params = {}) => {
    if (method === 'initialize') return { protocolVersion: params.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dao-interactions', version: '1.0.0' } };
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: [TOOL] };
    if (method !== 'tools/call') throw new AcpRpcError(-32601, 'Unsupported MCP method');
    if (params.name !== TOOL.name || !validateMcpQuestions(params.arguments)) throw new AcpRpcError(-32602, 'Invalid question tool arguments');
    const id = randomUUID();
    const inbox = path.join(sessionDir, 'inbox', `${Date.now()}-${id}.json`);
    acpAtomicJson(inbox, { id, type: 'mcp_request', method: 'mcp/dao_ask_user_question', params: params.arguments, createdAt: new Date().toISOString() });
    const receipt = path.join(sessionDir, 'receipts', `${id}.json`);
    while (!closed) {
      try {
        const response = acpReadJson(receipt);
        if (!response.ok) throw new AcpRpcError(-32000, 'Question interaction failed');
        return { content: [{ type: 'text', text: JSON.stringify(response.result) }], isError: response.result?.outcome?.outcome === 'cancelled' };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const status = acpReadJson(path.join(sessionDir, 'status.json'));
      if (!acpProcessAlive(status.runner)) throw new AcpRpcError(-32000, 'Question supervisor is no longer running');
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    throw new AcpRpcError(-32000, 'Question connection closed');
  } });
  client.on('closed', () => { closed = true; });
  return client;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--session-dir' || !path.isAbsolute(process.argv[3] || '')) process.exit(2);
  const client = createInteractionMcp({ sessionDir: process.argv[3] });
  client.on('closed', () => process.exit(0));
  // Raw exception strings may contain question/account content, so never print them.
  process.on('uncaughtException', () => process.exit(1));
  process.on('unhandledRejection', () => process.exit(1));
}
