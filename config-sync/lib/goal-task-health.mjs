import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const claudeDir = path.join(home, '.claude');
const tasksDir = path.join(claudeDir, 'tasks');
const projectsDir = path.join(claudeDir, 'projects');

const badJson = [];
const taskRows = [];
const staleInProgress = [];
const transcriptRisks = [];

function walk(dir, visitor) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const filePath = path.join(dir, name);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) walk(filePath, visitor);
    else visitor(filePath, stat);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
}

function scanTasks() {
  walk(tasksDir, (filePath, stat) => {
    if (!filePath.endsWith('.json')) return;
    try {
      const task = readJson(filePath);
      const sessionId = path.basename(path.dirname(filePath));
      taskRows.push({
        sessionId,
        path: filePath,
        id: task.id,
        subject: task.subject,
        status: task.status,
        mtimeMs: stat.mtimeMs,
      });
    } catch (error) {
      badJson.push({ path: filePath, error: error.message });
    }
  });

  const now = Date.now();
  for (const row of taskRows) {
    if (row.status === 'in_progress' && now - row.mtimeMs > 15 * 60 * 1000) {
      staleInProgress.push(row);
    }
  }
}

function scanTranscript(filePath) {
  const sessionId = path.basename(filePath, '.jsonl');
  const text = fs.readFileSync(filePath, 'utf8');
  if (!/TaskUpdate #\d+ completed/.test(text)) return;

  const summaryMentions = new Map();
  const toolCalls = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item.type === 'text') {
        for (const match of item.text.matchAll(/TaskUpdate #(\d+) completed/g)) {
          summaryMentions.set(match[1], (summaryMentions.get(match[1]) || 0) + 1);
        }
      }
      if (item.type === 'tool_use' && item.name === 'TaskUpdate') {
        const taskId = String(item.input?.taskId ?? '');
        const status = String(item.input?.status ?? '');
        if (taskId && status === 'completed') {
          toolCalls.set(taskId, (toolCalls.get(taskId) || 0) + 1);
        }
      }
    }
  }

  for (const [taskId, mentions] of summaryMentions) {
    if (toolCalls.has(taskId)) continue;

    // 只有“文字声称 completed，但任务文件仍未 completed”才是真风险。
    // 文件不存在（元对话引用）或已 completed（已被修复/状态一致）不报，避免 goal 排障会话误报。
    const taskFile = path.join(tasksDir, sessionId, `${taskId}.json`);
    let actualStatus = null;
    try { actualStatus = readJson(taskFile).status; } catch { /* 任务文件不存在 */ }
    if (actualStatus === null || actualStatus === 'completed') continue;

    transcriptRisks.push({
      sessionId,
      taskId,
      summaryMentions: mentions,
      completedToolUses: 0,
      actualStatus,
      path: filePath,
    });
  }
}

function scanTranscripts() {
  walk(projectsDir, (filePath) => {
    if (filePath.endsWith('.jsonl')) scanTranscript(filePath);
  });
}

function main() {
  scanTasks();
  scanTranscripts();

  const result = {
    checkedAt: new Date().toISOString(),
    taskJsonCount: taskRows.length,
    badJson,
    staleInProgress: staleInProgress.map((row) => ({
      sessionId: row.sessionId,
      id: row.id,
      subject: row.subject,
      status: row.status,
      path: row.path,
    })),
    transcriptRisks,
  };

  console.log(JSON.stringify(result, null, 2));
  if (badJson.length || staleInProgress.length || transcriptRisks.length) process.exit(1);
}

main();
