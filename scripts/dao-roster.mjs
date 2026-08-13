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
//
// 超时预算是负载相关的，不是常数（issue #385 取证）：本机空闲时 `pi --version` 远快于预算，
// 但派单窗并发把机器压满时，**突发那一刻的第一次 spawn** 会慢上一个量级，随后立刻回落。
// 所以重试必须放大预算——沿用同一预算立刻重跑，两次会被同一波突发一起咬住，
// 健康的 CLI 就被判成 unknown（假未知，且它是派单决策的输入）。
// 放大只是缩小窗口，关不上：突发尾巴无上界。关不上的那部分靠 reason 字段留痕，见下。
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 缓存落点（issue #409 §二 冻结公式，两边 —— 本文件与 CJS 侧的 dao-roster-refresh.js —— 各自独立
// 实现同一条公式，互不 import：mjs/cjs 不能互相同步 import，重复是硬约束不是偷懒）。
// 做成函数而非常量：env 覆盖要在同一进程内可被测试改写，模块顶层常量只求值一次。
function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}
export function rosterCachePath() {
  return process.env.DAO_ROSTER_CACHE || path.join(homeDir(), ".claude", "dao-roster-cache.json");
}

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

// 非 true 的判定一律带 reason（issue #385 要求：别让「不知道」不留痕）。
// reason 只供人读，**不参与任何判定**——加解析它的下游前先想清楚它不是契约。
function verdict(r, cmd, timeoutMs, runner) {
  const why = r.error ? "error:" + (r.error.code || r.error.message) : "exit:" + r.status;
  const found = locate(cmd, timeoutMs, runner);
  if (found === true) return { available: "unknown", reason: why + ", locator:found" };
  if (found === false) return { available: false, reason: why + ", locator:miss" };
  const detail = String(r.stderr || r.stdout || "");
  return NOT_FOUND_RE.test(detail)
    ? { available: false, reason: why + ", locator:unavailable, not-found-text" }
    : { available: "unknown", reason: why + ", locator:unavailable" };
}

// 三态判定：true = 可用（带版本）；false = 真缺席；"unknown" = 存在但跑坏 / 探测失败。
// 「跑出状态但非零」与「压根没跑出状态（超时 / 启动故障）」判法完全相同，故合成一个条件：
// status 为 null/undefined 时 `!== 0` 同样成立。改这里前先核真值表，别只核超时那一态。
function probeOnce(cmd, args, timeoutMs, runner) {
  try {
    const r = runCommand(runner, cmd, args, timeoutMs);
    if (r.error || r.status !== 0) return verdict(r, cmd, timeoutMs, runner);
    const ver = String(r.stdout || r.stderr || "").trim().split(/\r?\n/)[0].slice(0, 80);
    return { available: true, version: ver || "unknown" };
  } catch (e) { return { available: "unknown", reason: "threw:" + ((e && e.code) || "unknown") }; }
}

function runCommand(runner, cmd, args, timeoutMs) {
  const command = SHELL ? [cmd, ...args].join(" ") : cmd;
  const commandArgs = SHELL ? [] : args;
  return runner(command, commandArgs, {
    encoding: "utf8", timeout: timeoutMs, windowsHide: true, shell: SHELL,
  });
}

// 重试的预算放大倍数。首探已超时才付这个代价：真缺席的命令是快速非零退出，不走重试。
// 代价面：present-but-hung 的 CLI 单条最坏耗时从 2×预算变成 4×预算。
export const RETRY_TIMEOUT_FACTOR = 3;

export function probe(cmd, args = ["--version"], timeoutMs = 4000, runner = spawnSync) {
  const first = probeOnce(cmd, args, timeoutMs, runner);
  if (first.available !== "unknown") return first;
  return probeOnce(cmd, args, timeoutMs * RETRY_TIMEOUT_FACTOR, runner);
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

// 落盘逻辑单独导出：测试用假 roster + 临时路径直接调用它，绕开 buildRoster() 的真实探测
// （探测要跑好几个子进程，慢且不确定），只验证「mkdir + write」这半段自己的行为。
export function writeRosterCache(roster, cachePath = rosterCachePath()) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(roster));
}

// 缓存落盘是 CLI 直跑独有的副作用（issue #409 第 1 项：SessionStart 刷新钩子靠这份缓存
// 判新鲜/过期，不重新探测）。stdout 那一行必须逐字节不变——写缓存失败绝不能污染它，
// 所以缓存写在 stdout.write 之后，且写失败只吞进 try/catch、最多一行 stderr。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const roster = buildRoster();
  process.stdout.write(JSON.stringify(roster) + "\n");
  try {
    writeRosterCache(roster);
  } catch (e) {
    process.stderr.write("dao-roster: 缓存写入失败（不影响 stdout）：" + (e && e.message) + "\n");
  }
}
