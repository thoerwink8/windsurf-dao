#!/usr/bin/env node
/**
 * gw-remote-probe —— 从编排机（Contabo）探供应商健康，落一份机器可读健康表给编排层读，红了报总控群。
 *
 * 为什么不在网关机上报警：飞书凭据（~/.mirasim/keys/feishu-app.json）与 hub-say 只在 Contabo，
 * 凭据不外扩是硬规矩。网关机的 gw-health 只留档 + 退出码；「让人知道」这一步归这里。
 *
 * 探三类 target（issue #5，§66）：探测面从网关仓的 gateway-policy.json 派生，不再写死在本文件——
 *   ① pool  ：六个组别名走网关 /v1/chat/completions（探整条降级链，别名红=池不可用）；key=gw:<组>/<模型>
 *   ② leg   ：每条腿单独探。凭据不出 HK（选乙）——HK 的 gw-legs-health 逐渠道测、写只读口，
 *             本脚本 curl 那口合并；读不到口 → 全部 unscanned（不是红）。key=leg:<渠道名>
 *   ③ direct：codex 审官直连 pqapi /v1/responses，不经网关、池/腿探针都覆盖不到；key 由策略给全。
 * 每轮把三类结果原子写进健康表（~/.dao/provider-health.json，见 probe.healthFile）：
 *   { updatedAt, intervalMin, targets:{ key:{ kind, state, code, ms, lastGreenAt, strikes, why } } }
 *
 * 判据（2026-09-03 两次误判换来的，DECISIONS §61）：一律流式；只看 HTTP 码不算通——
 *   通过 = 收到过非空 content/text/reasoning 增量（pqapi 挂那天流式回 200，整条流只有 `: PING` 心跳）。
 *
 * 只在**连红两轮**时说话，恢复了再说一句；不是每轮都刷屏。报警状态（报过谁/心跳）存 STATE_FILE，
 * strikes/lastGreenAt 存健康表本身（表即状态，不另攒一份）。
 *
 * 用法：
 *   node gw-remote-probe.mjs                 # 探一轮、落表、连红两轮报群；退出码 0（红项不算探针失败）
 *   node gw-remote-probe.mjs --strict        # 有红项就退出码 1（手动/CI 用）
 *   node gw-remote-probe.mjs --quiet         # 只探只落表、不报警（调试用）
 *   node gw-remote-probe.mjs --only <key>    # 只探某个 target（后台「只探这条」），其余原样留在表里
 * 装单元：sudo bash scripts/install-gw-remote-probe.sh
 *   （#967：本脚本不再写 systemd 单元。旧 --install 会写出缺 OnCalendar 的 timer，停一次再起就永不再跑。）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import { loadPolicy, probePlan } from "./lib/gateway-policy.mjs";
import { buildHealthTable, mergeLegHealth, computeAlerts, plainTarget, buildRedAlert, responsesEventHasContent } from "./lib/probe-health.mjs";
import { codexResponsesProbeBody, probeTargetOf, planProbe, runProbe, NATIVE_LOGIN_FILES } from "./lib/provider-probe.mjs";

const argv = process.argv.slice(2);
// #967：旧 --install 写出的 timer 只有单调时钟。必须在读策略之前拦——这条旗标不该去碰网关。
if (argv.includes("--install")) {
  console.error("gw-remote-probe --install 已退役（#967）。旧模板没有 OnCalendar，停一次再起会进 active(elapsed) 死态且无人报警。装法：sudo bash scripts/install-gw-remote-probe.sh");
  process.exit(1);
}

const GATEWAY = process.env.GW_BASE || "https://156.224.28.95.sslip.io";
// 选型真相源在本仓（#842/#1145 同款：探测面从真相源派生，不手打清单）。
const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const KEYS_DIR = process.env.GW_KEYS_DIR || join(os.homedir(), ".mirasim", "keys");
const STATE_FILE = process.env.GW_PROBE_STATE || join(os.homedir(), ".local", "state", "gw-remote-probe.json");
const HUB_SAY = process.env.HUB_SAY || "/home/orca/bin/hub-say";
const TIMEOUT_MS = Number(process.env.GW_PROBE_TIMEOUT_MS || 180_000);

const POLICY = loadPolicy();
const PLAN = probePlan(POLICY);

// ~ 展开到 home（healthFile / codexHome 都写成 ~/…，跨机器不写死用户名）
const expand = p => (p && p.startsWith("~/")) ? p.replace(/^~/, os.homedir()) : p;
const HEALTH_FILE = process.env.GW_HEALTH_FILE || expand(PLAN.healthFile) || `${os.homedir()}/.dao/provider-health.json`;

// key 只从 keys/ 现读（唯一真相，轮换后自动跟上，§54）；读不到就说读不到，不猜。
function keyFor(group) {
  try { return readFileSync(`${KEYS_DIR}/${group}.key`, "utf8").trim(); } catch { return ""; }
}

// 判据正则：非空 content / text / reasoning(_content)。tool_calls 不在探针里出现，不列。
const CONTENT_RE = /"(?:content|text|reasoning_content|reasoning)":"[^"]/;

// ① pool：走网关流式探别名，验整条降级链在位
async function probePool(t) {
  const key = keyFor(t.group);
  if (!key) return { key: t.key, kind: "pool", state: "red", code: null, ms: null, why: `无 key（keys/ 里没有 ${t.group}.key）` };
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST", signal: ac.signal,
      headers: {
        "content-type": "application/json", authorization: `Bearer ${key}`,
        "X-Dao-Actor": "gw-remote-probe", "X-Dao-Task": "ai-gateway-stack#5",
      },
      body: JSON.stringify({ model: t.model, stream: true, max_tokens: 16,
        messages: [{ role: "user", content: "reply with the single word ok" }] }),
    });
    if (!res.ok) return { key: t.key, kind: "pool", state: "red", code: res.status, ms: Date.now() - started, why: `HTTP ${res.status}` };
    let text = "", got = false;
    for await (const buf of res.body) {
      text += Buffer.from(buf).toString("utf8");
      if (CONTENT_RE.test(text)) { got = true; break; }   // 一见真内容就收手，少花一点
      if (Date.now() - started > TIMEOUT_MS) break;
    }
    ac.abort();  // 主动断开，流式断开只记输入（§59）
    const ms = Date.now() - started;
    return got ? { key: t.key, kind: "pool", state: "green", code: 200, ms, why: `${ms}ms` }
               : { key: t.key, kind: "pool", state: "red", code: 200, ms, why: `200 但零内容（只有心跳/空 delta，${ms}ms）` };
  } catch (e) {
    return { key: t.key, kind: "pool", state: "red", code: null, ms: Date.now() - started,
      why: e.name === "AbortError" ? `超时 ${TIMEOUT_MS / 1000}s` : String(e.message || e).slice(0, 80) };
  } finally { clearTimeout(timer); }
}

// ② leg：读 HK 只读口的逐腿结果（curl 失败/超时 → null → mergeLegHealth 判全 unscanned）
async function fetchLegs() {
  if (!PLAN.legsEndpoint) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch(PLAN.legsEndpoint, { signal: ac.signal, headers: { "cache-control": "no-cache" } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

// codex 直连口：从 codex 配置读 base_url 与 key（都不落日志）。config.toml 只取所需两值，不引 TOML 库。
function readCodexConn(direct) {
  const home = expand(direct.codexHome || "~/.codex");
  let baseUrl = null, model = direct.model || null, key = "";
  try {
    const toml = readFileSync(`${home}/config.toml`, "utf8");
    const prov = direct.provider || (toml.match(/^\s*model_provider\s*=\s*"([^"]+)"/m) || [])[1] || "custom";
    // 取 [model_providers.<prov>] 段内的 base_url
    const sec = new RegExp(`\\[model_providers\\.${prov}\\]([\\s\\S]*?)(?:\\n\\[|$)`).exec(toml);
    if (sec) baseUrl = (sec[1].match(/base_url\s*=\s*"([^"]+)"/) || [])[1] || null;
    if (!model) model = (toml.match(/^\s*model\s*=\s*"([^"]+)"/m) || [])[1] || null;
  } catch { /* 配置读不到 → baseUrl 留空，下面判 unscanned */ }
  // GW_CODEX_KEY 只作临时覆盖用（判别性实验：喂假 key 验红，不改配置文件）；平时不设，现读 auth.json
  if (process.env.GW_CODEX_KEY) key = process.env.GW_CODEX_KEY;
  else try { key = JSON.parse(readFileSync(`${home}/auth.json`, "utf8")).OPENAI_API_KEY || ""; } catch { /* 无 key */ }
  return { baseUrl, model, key };
}

// ③ direct：pqapi /v1/responses 流式探 8 token，判据同款（responses 事件流里找 output_text/reasoning 的非空 delta）
async function probeDirect(direct) {
  const { baseUrl, model, key } = readCodexConn(direct);
  if (!baseUrl || !model) return { key: direct.key, kind: "direct", state: "unscanned", code: null, ms: null, why: "读不到 codex 配置（base_url/model）" };
  if (!key) return { key: direct.key, kind: "direct", state: "unscanned", code: null, ms: null, why: "读不到 codex key（auth.json）" };
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    // responses input 必须走结构化 message（与派前探针同一份 helper）。裸字符串会被
    // 本机桥转成空 messages → 500，健康表把探针自己造的红记成上游挂了。
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST", signal: ac.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(codexResponsesProbeBody({
        model, text: "reply with the single word ok", maxOutputTokens: 16,
      })),
    });
    if (!res.ok) return { key: direct.key, kind: "direct", state: "red", code: res.status, ms: Date.now() - started, why: `HTTP ${res.status}` };
    let buf = "", got = false;
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          // responses 流：output_text/reasoning delta，或 completed.output 里的非空 content/text/reasoning。
          // 空 content:[] 的 completed 不算通（长度兜底会把空消息判绿）。
          if (responsesEventHasContent(JSON.parse(payload))) got = true;
        } catch { /* 非 JSON data 行，跳过 */ }
        if (got) break;
      }
      if (got || Date.now() - started > TIMEOUT_MS) break;
    }
    ac.abort();
    const ms = Date.now() - started;
    return got ? { key: direct.key, kind: "direct", state: "green", code: 200, ms, why: `${ms}ms` }
               : { key: direct.key, kind: "direct", state: "red", code: 200, ms, why: `200 但零内容（空流/只有心跳，${ms}ms）` };
  } catch (e) {
    return { key: direct.key, kind: "direct", state: "red", code: null, ms: Date.now() - started,
      why: e.name === "AbortError" ? `超时 ${TIMEOUT_MS / 1000}s` : String(e.message || e).slice(0, 80) };
  } finally { clearTimeout(timer); }
}

// ④ native：不发现请求，只验凭据文件在不在（判据在 provider-probe.mjs）。走同一个 planProbe/runProbe，
// 免得「探针的判据」和「派前预检的判据」两处各写一份、哪天分叉。
async function probeNative(t) {
  const landing = t.landing;
  const target = probeTargetOf(landing);
  const r = await runProbe(planProbe(landing, {}), {});
  return { key: target || `native:${t.provider}`, kind: "native-login", state: r.state, code: r.code, ms: r.ms, why: r.why };
}

function readJson(f, dflt) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return dflt; } }

// ④ native：网关退役后，grok / composer 这些腿走的是官方 CLI 自己的登录态，不经网关——
// 没有池、没有 HK 逐腿口，前三类都覆盖不到，健康表里它们曾经是空白（= 派工选型看不见它们）。
// 探测面**从选型真相源的「腿」节现推**，不另手打一份 provider 清单（memory: 手打常量早晚填错）。
// 读不到腿表 = 这类一条都不探（不是「都健康」）；判据本身在 provider-probe 的 planProbe/runProbe。
function nativeTargets() {
  const doc = readJson(REPO_ROOT + "/docs/model-routing.json", null);
  const legs = doc && Array.isArray(doc["腿"]) ? doc["腿"] : null;
  if (!legs) {
    console.error("  ⚠ 读不到选型 JSON 的「腿」节——本轮不探本地登录型（不是「都健康」）");
    return [];
  }
  const seen = new Map();
  for (const leg of legs) {
    if (!leg || leg["状态"] !== "在役") continue;
    const landing = leg["落地"];
    const provider = landing && landing.provider ? String(landing.provider) : "";
    if (!provider || !NATIVE_LOGIN_FILES[provider] || seen.has(provider)) continue;
    seen.set(provider, { provider, landing: { provider } });
  }
  return [...seen.values()];
}
function writeAtomic(f, obj) {
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, f);   // rename 原子：编排层 orca 要么读到旧表要么读到新表，不会读到半份
}
function readState() { return readJson(STATE_FILE, { alerted: [] }); }
function writeState(state) {
  try { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error(`  ⚠ 状态写不进 ${STATE_FILE}（${e.message}）——下轮会重复报警`); }
}
function say(text) {
  if (!existsSync(HUB_SAY)) { console.error(`  ⚠ ${HUB_SAY} 不在，报不出去`); return false; }
  try { execFileSync(HUB_SAY, [text], { stdio: "ignore", timeout: 30_000, windowsHide: true }); return true; }
  catch (e) { console.error(`  ⚠ hub-say 失败：${String(e.message).slice(0, 120)}`); return false; }
}

const onlyIdx = argv.indexOf("--only");
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;

// 串行探：并行会把 pqapi 这类排队上游自己挤慢（实测并行 sol 超时、串行 28s 就通），
// 探针把被探对象探挂是最蠢的假阳性。一轮约 1 分钟，30 分钟的定时器完全够。
const nowIso = new Date().toISOString();
const results = [];
const wantPool = PLAN.pools.filter(t => !only || t.key === only);
const wantDirect = PLAN.direct.filter(t => !only || t.key === only);
const wantLegs = !only || only.startsWith("leg:");
const natives = nativeTargets();
const wantNative = only ? natives.filter(t => `native:${t.provider}` === only) : natives;

for (const t of wantPool) results.push(await probePool(t));
for (const d of wantDirect) results.push(await probeDirect(d));
for (const n of wantNative) results.push(await probeNative(n));
if (wantLegs) {
  const legsDoc = await fetchLegs();
  const legs = only ? PLAN.legs.filter(l => l.key === only) : PLAN.legs;
  const merged = mergeLegHealth(legs, legsDoc, Date.now(), PLAN.intervalMin);
  for (const l of legs) results.push({ key: l.key, ...merged[l.key] });
}

// 折进上一份表（strikes/lastGreenAt 从旧表续）；--only 时其余 target 原样保留
const prevTable = readJson(HEALTH_FILE, null);
const table = buildHealthTable(prevTable, results, PLAN.intervalMin, nowIso);
writeAtomic(HEALTH_FILE, table);

// journal：本轮探到的每条一行
const icon = s => s === "green" ? "✓" : s === "unscanned" ? "·" : "⚠";
for (const r of results) {
  const t = table.targets[r.key];
  console.log(`  ${icon(t.state)} ${r.key.padEnd(34)} ${t.state.padEnd(9)} ${t.why}`);
}

// 报警：连红达阈值才喊，恢复再说一句（§61）。unscanned 不参与——「没探成」不是「不通」。
const prev = readState();
const { newlyBad, recovered, nowRed, nextAlerted } = computeAlerts(table, prev.alerted, PLAN.strikesToAlert);
if (!argv.includes("--quiet") && !only) {
  if (newlyBad.length) {
    say(buildRedAlert(newlyBad.map(k => ({ key: k, why: table.targets[k].why })), PLAN));
  }
  if (recovered.length && !newlyBad.length) {
    say(`网关这几条线路恢复了：${recovered.map(plainTarget).join("、")}。不用处理。`);
  }
}

// 周报心跳：timer 被删/机器重装后最容易发生的是「什么都不发生」——每 heartbeatDays 主动说一句「还在跑」，
// 于是**沉默本身**成了可察觉的异常（配不了检查的指针不如不留）。--only 不算一轮，不动心跳。
let heartbeatAt = prev.heartbeatAt, rounds = prev.rounds || 0;
if (!only) {
  const lastBeat = prev.heartbeatAt ? Date.parse(prev.heartbeatAt) : 0;
  const beatDue = Date.now() - lastBeat > PLAN.heartbeatDays * 24 * 3600 * 1000;
  rounds = beatDue ? 0 : rounds + 1;
  if (beatDue && !argv.includes("--quiet")) {
    const green = Object.values(table.targets).filter(v => v.state === "green").length;
    say(`网关探活周报：还在跑，上周探了 ${rounds} 轮。现在 ${Object.keys(table.targets).length} 条线路里 ${green} 条正常${nowRed.length ? `，不通的：${nowRed.map(plainTarget).join("、")}` : ""}。
这条周报如果哪周没出现，说明探活自己停了，那才要查。`);
    heartbeatAt = nowIso;
    rounds = 0;
  } else if (!heartbeatAt) heartbeatAt = nowIso;
}
// --quiet / --only 是「只探不惊动」：不推进 alerted，否则一次调试跑会把某个 key 标成「已报过」，
// 把之后真正该报的那一声吞掉（原脚本 --quiet 也保持 alerted 不变，别回归）。
const advanceAlerts = !only && !argv.includes("--quiet");
writeState({ alerted: advanceAlerts ? nextAlerted : (prev.alerted || []), at: nowIso, rounds, heartbeatAt });

// 退出码默认 0：**探到红项不是探针失败**（红项出口是报警 + journal 的 ⚠ + 健康表）。
// 只有探针自己跑不动（一把 pool key 都读不到）才算失败。手动/CI 想按红失败加 --strict。
const poolResults = results.filter(r => r.kind === "pool");
const brokenProbe = poolResults.length > 0 && poolResults.every(r => /无 key/.test(r.why || ""));
process.exit(brokenProbe || (argv.includes("--strict") && nowRed.length) ? 1 : 0);
