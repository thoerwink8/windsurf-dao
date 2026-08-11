#!/usr/bin/env node
// dao-roster.mjs — 开机探测：本机可用的执行体与编排织物（2026-08-11 动态编排策略）
//
// 输出一行 JSON roster，供协调者派单前现查——不靠会话记忆（「记忆里 codex 在」
// 与「此刻 codex 在」是两回事）。探测面含**编排织物本身**（orca）：它挂了，
// 选项里自然只剩原生 Agent 路径——断供预案就是探测，不写双轨文档（定案②）。
//
// 用法：node scripts/dao-roster.mjs          一行 JSON
// 探测失败一律标 absent/unknown，不炸——探测器的职责是报告现状，不是维护面子。
import { spawnSync } from "node:child_process";

function probe(cmd, args = ["--version"], timeoutMs = 4000) {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
    if (r.error || r.status !== 0) return { available: false };
    const ver = String(r.stdout || r.stderr || "").trim().split(/\r?\n/)[0].slice(0, 80);
    return { available: true, version: ver || "unknown" };
  } catch (_) { return { available: false }; }
}

// pi 的网关模型列表：试它的 models 子命令；拿不到就标 unknown（有 CLI 却不知模型≠没有）。
function probePi() {
  const base = probe("pi");
  if (!base.available) return base;
  const m = spawnSync("pi", ["models", "--json"], { encoding: "utf8", timeout: 6000, windowsHide: true });
  if (!m.error && m.status === 0 && m.stdout) {
    try {
      const doc = JSON.parse(m.stdout);
      const ids = (Array.isArray(doc) ? doc : doc.models || []).map((x) => x.id || x.name || String(x)).slice(0, 40);
      if (ids.length) return { ...base, models: ids };
    } catch (_) { /* 输出不是 JSON ⇒ 标 unknown */ }
  }
  return { ...base, models: "unknown" };
}

const roster = {
  at: new Date().toISOString(),
  fabric: { orca: probe("orca") },                    // 编排织物：它 absent ⇒ 编排路径整体缺席
  agents: {                                            // 执行体（Orca 的 --agent id 与之一一对应）
    claude: probe("claude"),
    codex: probe("codex"),
    pi: probePi(),
    omp: probe("omp"),
    grok: probe("grok"),
  },
};
roster.summary =
  "fabric=" + (roster.fabric.orca.available ? "orca✓" : "orca✗") +
  " agents=" + Object.entries(roster.agents).map(([k, v]) => k + (v.available ? "✓" : "✗")).join(",");
process.stdout.write(JSON.stringify(roster) + "\n");
