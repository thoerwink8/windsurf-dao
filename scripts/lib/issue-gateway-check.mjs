// 跨宿主 Issue 写入网关闸（#792）。
//
// 修法必须每个调用面都接上，不是加一条规矩了事（消歧：第七次栽在「只落一个调用点」）。
// 本检查自己列宿主配置面、自己读文件、自己判「指向网关 / 拦裸 gh issue 写」，
// 不 import 网关自己的解析。少接一处就红；「某处有」不算。
// 零样本（一个面都没扫到 / 文件不在 / JSON 坏了）= 没查成，不是绿。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const HOST_SURFACES = [
  { id: 'claude-settings', rel: '.claude/settings.json', kind: 'hook-json', must: 'dispatch-gate' },
  { id: 'cursor-hooks', rel: '.cursor/hooks.json', kind: 'hook-json', must: 'dispatch-gate' },
  { id: 'agents', rel: 'AGENTS.md', kind: 'resident-md', must: 'issue-gateway' },
  { id: 'claude-md', rel: 'CLAUDE.md', kind: 'resident-md', must: 'issue-gateway' },
  { id: 'global-claude', rel: 'docs/global-CLAUDE.md', kind: 'resident-md', must: 'issue-gateway' },
  { id: 'dispatch-skill', rel: 'host/skills/dispatch/SKILL.md', kind: 'resident-md', must: 'issue-gateway' },
  { id: 'cli-notes-pi', rel: 'docs/cli-notes/pi.md', kind: 'resident-md', must: 'issue-gateway' },
  { id: 'cli-notes-codex', rel: 'docs/cli-notes/codex.md', kind: 'resident-md', must: 'issue-gateway' },
  { id: 'cli-notes-claude', rel: 'docs/cli-notes/claude.md', kind: 'resident-md', must: 'issue-gateway' },
  { id: 'cli-notes-cursor', rel: 'docs/cli-notes/cursor.md', kind: 'resident-md', must: 'issue-gateway' },
  { id: 'cli-notes-feishu', rel: 'docs/cli-notes/feishu.md', kind: 'resident-md', must: 'issue-gateway' },
];

const GATEWAY_MARK = 'issue-gateway';
const GATE_MARK = 'dispatch-gate';
const BARE_WRITE_RE = /\bgh\s+issue\s+(create|comment|close|edit|reopen|delete)\b/;

function readRel(root, rel, files) {
  if (files && Object.prototype.hasOwnProperty.call(files, rel)) {
    return { text: files[rel], rel };
  }
  const p = join(root || '', rel);
  if (!existsSync(p)) return { missing: true, path: p, rel };
  try { return { text: readFileSync(p, 'utf8'), path: p, rel }; }
  catch (e) { return { missing: true, path: p, rel, error: String(e.message || e) }; }
}

function walkMd(dir, prefix, acc) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walkMd(p, rel, acc);
    else if (name.endsWith('.md') && st.isFile()) acc.push(rel);
  }
  return acc;
}

function hasBareWrite(text) {
  return String(text || '').split(/\r?\n/).some((line) => {
    if (/issue-gateway|gh-as\.mjs/.test(line) && BARE_WRITE_RE.test(line)) return false;
    return BARE_WRITE_RE.test(line);
  });
}

function checkHookJson(loaded, surface) {
  if (loaded.missing) {
    return { fail: [`宿主面 ${surface.id} 不在：${surface.rel}`, '恢复该文件；少一处 = 红', loaded.path || surface.rel] };
  }
  let doc;
  try { doc = JSON.parse(String(loaded.text || '').replace(/^\uFEFF/, '')); }
  catch (e) {
    return { fail: [`宿主面 ${surface.id} 解析不了`, '修 JSON；解析不了 = 没查成', String(e.message).slice(0, 80)] };
  }
  const blob = JSON.stringify(doc);
  if (!blob.includes(GATE_MARK)) {
    return { fail: [`宿主面 ${surface.id} 没挂 dispatch-gate`, '裸 gh issue 写动作靠这个闸拦；少接一处就红', surface.rel] };
  }
  return { ok: true, id: surface.id };
}

function checkResidentMd(loaded, surface) {
  if (loaded.missing) {
    return { fail: [`宿主面 ${surface.id} 不在：${surface.rel}`, '恢复该文件；少一处 = 红', loaded.path || surface.rel] };
  }
  const text = String(loaded.text || '');
  if (!text.includes(GATEWAY_MARK)) {
    return { fail: [`宿主面 ${surface.id} 没指向 issue-gateway`, '文字提醒只作迁移护栏，但每个调用面都要接到同一入口；少接一处就红', surface.rel] };
  }
  return { ok: true, id: surface.id };
}

/**
 * @returns {{green?: string, fail?: [string, string, string], scanned?: number, hits?: object[]}}
 */
export function checkIssueGatewaySurfaces({ root, files, surfaces } = {}) {
  if (!root && !files) return { fail: ['没给仓库根', 'checkIssueGatewaySurfaces 要 root', ''] };
  const list = Array.isArray(surfaces) ? surfaces : HOST_SURFACES;
  if (list.length === 0) {
    return { fail: ['一个宿主配置面都没扫到', '0 个样本 = 本次等于没查，不是绿', 'HOST_SURFACES'] };
  }
  const problems = [];
  let scanned = 0;
  for (const surface of list) {
    const loaded = readRel(root || '', surface.rel, files);
    const r = surface.kind === 'hook-json' ? checkHookJson(loaded, surface) : checkResidentMd(loaded, surface);
    if (r.fail) problems.push(r.fail[0]);
    else scanned += 1;
  }
  if (problems.length) {
    return {
      fail: [
        `宿主配置面少接 ${problems.length} 处`,
        '每个调用面都要接到 issue-gateway / dispatch-gate；只断言「某处有」不算',
        problems.slice(0, 8).join('；'),
      ],
      scanned,
    };
  }
  return {
    green: `跨宿主 Issue 写入面 ${scanned}/${list.length} 已接到网关（少一处就红）`,
    scanned,
  };
}

/**
 * skill / 常驻 md 里仍教裸 gh issue 写动作 → 红。
 * 检查器自己 walk，不复用 marshal-issue-identity-check。
 */
export function checkNoBareGhIssueWrite({ root, files, extraRels } = {}) {
  if (!root && !files) return { fail: ['没给仓库根', 'checkNoBareGhIssueWrite 要 root', ''] };
  let rels;
  if (Array.isArray(extraRels)) rels = extraRels;
  else if (files) {
    rels = Object.keys(files).filter((k) => k.endsWith('.md') || k.endsWith('.json'));
  } else {
    rels = [
      'AGENTS.md', 'CLAUDE.md', 'docs/global-CLAUDE.md',
      ...walkMd(join(root, 'host', 'skills'), 'host/skills', []),
      ...walkMd(join(root, 'docs', 'cli-notes'), 'docs/cli-notes', []),
    ];
  }
  if (rels.length === 0) {
    return { fail: ['一个常驻/skill 文件都没扫到', '0 个样本 = 本次等于没查，不是绿', 'host/skills + cli-notes'] };
  }
  const hits = [];
  for (const rel of rels) {
    const loaded = readRel(root || '', rel, files);
    if (loaded.missing) {
      return { fail: [`文件读不到：${rel}`, '读失败不是 0 条违规', loaded.path || rel] };
    }
    const lines = String(loaded.text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/issue-gateway|gh-as\.mjs/.test(line)) continue;
      const m = line.match(BARE_WRITE_RE);
      if (m) hits.push({ rel, line: i + 1, verb: m[1], excerpt: line.trim().slice(0, 160) });
    }
  }
  if (hits.length) {
    return {
      fail: [
        `还有 ${hits.length} 处教裸 gh issue 写动作`,
        '改成 node scripts/issue-gateway.mjs；只读 view/list 可以继续裸',
        hits.slice(0, 4).map((h) => `${h.rel}:${h.line} ${h.verb}`).join('；'),
      ],
      scanned: rels.length,
      hits,
    };
  }
  return {
    green: `裸 gh issue 写动作 0 处（扫了 ${rels.length} 个面）`,
    scanned: rels.length,
    hits: [],
  };
}

export function checkIssueGatewayAlive({ root, files } = {}) {
  const surfaces = checkIssueGatewaySurfaces({ root, files });
  if (surfaces.fail) return surfaces;
  const bare = checkNoBareGhIssueWrite({ root, files });
  if (bare.fail) return bare;
  const cli = readRel(root || '', 'scripts/issue-gateway.mjs', files);
  if (cli.missing) {
    return { fail: ['唯一入口 scripts/issue-gateway.mjs 不在', '恢复该文件；入口不在 = 没查成', cli.path || 'scripts/issue-gateway.mjs'] };
  }
  if (!String(cli.text || '').includes('idempotency')) {
    return { fail: ['issue-gateway CLI 不提幂等键', '每次写必须带 idempotency_key', 'scripts/issue-gateway.mjs'] };
  }
  const lib = readRel(root || '', 'scripts/lib/issue-gateway.mjs', files);
  if (lib.missing) {
    return { fail: ['网关 lib 不在', '恢复 scripts/lib/issue-gateway.mjs', lib.path || 'scripts/lib/issue-gateway.mjs'] };
  }
  const libText = String(lib.text || '');
  if (!libText.includes('dao-marshal')) {
    return { fail: ['网关没钉死 dao-marshal', '身份必须固定，调用者不能选', 'scripts/lib/issue-gateway.mjs'] };
  }
  if (/GH_TOKEN|GITHUB_TOKEN/.test(libText) && /spawnSync\(\s*['"]gh/.test(libText)) {
    return { fail: ['网关源码里还有裸 gh + 个人 token 退路', '缺凭据必须 fail-loud，不许退回个人 gh', 'scripts/lib/issue-gateway.mjs'] };
  }
  return {
    green: `${surfaces.green}；${bare.green}`,
    scanned: (surfaces.scanned || 0) + (bare.scanned || 0),
  };
}

void hasBareWrite;
