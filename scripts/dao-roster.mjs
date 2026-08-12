#!/usr/bin/env node
// dao-roster.mjs — 开机探测：本机可用的执行体与编排织物（2026-08-11 动态编排策略）
//
// 输出一行 JSON roster，供协调者派单前现查——不靠会话记忆（「记忆里 codex 在」
// 与「此刻 codex 在」是两回事）。探测面含**编排织物本身**（orca）：它挂了，
// 选项里自然只剩原生 Agent 路径——断供预案就是探测，不写双轨文档（定案②）。
//
// 用法：node scripts/dao-roster.mjs          一行 JSON
// 探测失败一律标 absent/unknown，不炸——探测器的职责是报告现状，不是维护面子。
//
// 缺席判定（2026-08-12 打回后改 where/which 交叉验证）：中文 Windows 下 cmd 找不到命令时
// stderr 是 GBK 被 utf8 解码后的乱码，中英文文案正则都命中不了——正则结构性死路，不再修正则。
// 探测非零退出 / status==null 时追加一次 `where`(win32)/`which`(其他) 交叉验证：
// 定位器退出 0 = 命令在只是跑坏 ⇒ unknown；非零 = 真缺席 ⇒ false。退出码与编码无关。
// NOT_FOUND_RE 仅作定位器本身不可用（无 where/which 或定位器崩了）时的兜底。
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Windows 下必须 shell 解析：npm 装的 CLI 只有 .cmd/.ps1 垫片没有 .exe，
// 裸 spawnSync 探不到（pi 实测被误报 absent，2026-08-12）。
const SHELL = process.platform === "win32";
const LOCATOR = SHELL ? "where" : "which";
const NOT_FOUND_RE = /(?:not found|not recognized as an internal or external command|command not found)/i;

// 交叉验证：定位器退出 0 = 命令存在（只是探测跑坏）⇒ true；非零 = 真缺席 ⇒ false；
// 定位器自身不可用（error / status==null）⇒ null，由调用方走 NOT_FOUND_RE 兜底。
function locate(cmd, timeoutMs, runner) {
  const r = runCommand(runner, LOCATOR, [cmd], timeoutMs);
  if (r.error || r.status == null) return null;
  return r.status === 0;
}

// 三态判定：true = 可用（带版本）；false = 真缺席；"unknown" = 存在但跑坏 / 探测失败。
function probeOnce(cmd, args, timeoutMs, runner) {
  try {
    const r = runCommand(runner, cmd, args, timeoutMs);
    if (r.error || r.status == null) {
      // 探测没跑出状态（超时 / 启动故障）：交给定位器交叉验证，定位器找得到才是 unknown。
      const found = locate(cmd, timeoutMs, runner);
      if (found !== null) return found ? { available: "unknown" } : { available: false };
      const detail = String(r.stderr || r.stdout || "");
      return NOT_FOUND_RE.test(detail) ? { available: false } : { available: "unknown" };
    }
    if (r.status !== 0) {
      const found = locate(cmd, timeoutMs, runner);
      if (found !== null) return found ? { available: "unknown" } : { available: false };
      const detail = String(r.stderr || r.stdout || "");
      return NOT_FOUND_RE.test(detail) ? { available: false } : { available: "unknown" };
    }
    const ver = String(r.stdout || r.stderr || "").trim().split(/\r?\n/)[0].slice(0, 80);
    return { available: true, version: ver || "unknown" };
  } catch (_) { return { available: "unknown" }; }
}

function runCommand(runner, cmd, args, timeoutMs) {
  const command = SHELL ? [cmd, ...args].join(" ") : cmd;
  const commandArgs = SHELL ? [] : args;
  return runner(command, commandArgs, {
    encoding: "utf8", timeout: timeoutMs, windowsHide: true, shell: SHELL,
  });
}

export function probe(cmd, args = ["--version"], timeoutMs = 4000, runner = spawnSync) {
  const first = probeOnce(cmd, args, timeoutMs, runner);
  return first.available === "unknown" ? probeOnce(cmd, args, timeoutMs, runner) : first;
}

// pi 的网关模型列表：试它的 models 子命令；拿不到就标 unknown（有 CLI 却不知模型≠没有）。
export function probePi(runner = spawnSync) {
  const base = probe("pi", ["--version"], 4000, runner);
  if (base.available !== true) return base;
  const m = runCommand(runner, "pi", ["models", "--json"], 6000);
  if (!m.error && m.status === 0 && m.stdout) {
    try {
      const doc = JSON.parse(m.stdout);
      const ids = (Array.isArray(doc) ? doc : doc.models || []).map((x) => x.id || x.name || String(x)).slice(0, 40);
      if (ids.length) return { ...base, models: ids };
    } catch (_) { /* 输出不是 JSON ⇒ 标 unknown */ }
  }
  return { ...base, models: "unknown" };
}

function glyph(available) {
  return available === true ? "✓" : available === false ? "✗" : "?";
}

export function summarize(fabric, agents) {
  return "fabric=" + Object.entries(fabric).map(([k, v]) => k + glyph(v.available)).join(",") +
    " agents=" + Object.entries(agents).map(([k, v]) => k + glyph(v.available)).join(",");
}

export function buildRoster() {
  const roster = {
    at: new Date().toISOString(),
    fabric: { orca: probe("orca") },
    agents: {
      claude: probe("claude"),
      codex: probe("codex"),
      pi: probePi(),
      omp: probe("omp"),
      grok: probe("grok"),
    },
  };
  roster.summary = summarize(roster.fabric, roster.agents);
  return roster;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(buildRoster()) + "\n");
}
