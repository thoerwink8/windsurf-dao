#!/usr/bin/env node
// go-fallback 端到端验收（issue #520）
//
// 用法（在仓库根或本目录）：
//   node host/pi-extensions/test/e2e.mjs              # 硬限流（quota）场景：首轮放行、随后 429 额度耗尽
//   node host/pi-extensions/test/e2e.mjs rate-limit   # 瞬时限流场景：全程 429 rate_limit_error
//   node host/pi-extensions/test/e2e.mjs no-creds     # 直连凭据缺失场景（预期明确报错、不许静默降级成功）
//
// 干的事：
//   1. 造一个一次性 pi 环境（PI_CODING_AGENT_DIR / 会话目录独立，不碰本机 ~/.pi/agent）
//   2. 起 fake 上游（fake-go 先放行一轮工具调用、再 429 额度耗尽；fake-ds 直连成功）。
//      端口用随机空闲端口 + 环境变量传递，绝不占用固定端口——防止残留进程劫持测试。
//   3. 用 pi --print 派一个「跑一半」的任务：先写 PHASE1_BEFORE_CUTOVER，再回复 PHASE2
//   4. 断言，缺一报错：
//      a. 任务最终完成（stdout 有 PHASE2_TASK_DONE_VIA_DIRECT_DS）
//      b. 中途被切走且未重启（marker 同时有 PHASE1_BEFORE_CUTOVER 与 PHASE1_AFTER_CUTOVER）
//      c. 切换有可见记录（会话 jsonl 里有 model_change fake-go→fake-ds 与 go-fallback 条目）
//      d. settings.json 默认值被恢复（setModel 会改写它，扩展必须还原）
//      e. 请求序列符合预期（go#1 200 → go#2 429 → ds#1 200 → ds#2 200），
//         序列不对说明有别的进程在应答，测试无效。
//
// 本机实测输出样例见 PR 正文（2026-08-16）。

import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");
const EXT = path.join(REPO, "host", "pi-extensions", "go-fallback.ts");
const SERVER = path.join(__dirname, "fake-server.mjs");

const MODE = process.argv[2] || "quota";
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "gf-e2e-"));
const AGENT = path.join(BASE, "agent");
const SESSIONS = path.join(BASE, "sessions");
fs.mkdirSync(path.join(AGENT, "extensions"), { recursive: true });
fs.mkdirSync(SESSIONS, { recursive: true });

const marker = path.join(BASE, "marker.txt");
const task = `任务：先运行 bash 命令 echo PHASE1_BEFORE_CUTOVER >> ${marker.replace(/\\/g, "/")}，然后回复 PHASE2_TASK_DONE`;

console.log(`GF-E2E base: ${BASE}  mode: ${MODE}`);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

function write(p, content) {
  fs.writeFileSync(p, content, "utf8");
}

function providerModels(port, apiKey) {
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    api: "openai-completions",
    ...(apiKey ? { apiKey } : {}),
    models: [
      { id: "deepseek-v4-flash", name: "DS Flash fake", reasoning: false, contextWindow: 100000, maxTokens: 16384 },
    ],
  };
}

function resolvePiCli() {
  if (process.env.PI_CLI) return process.env.PI_CLI;
  const candidates = [];
  const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout?.trim();
  if (npmRoot) candidates.push(path.join(npmRoot, "@earendil-works", "pi-coding-agent", "dist", "cli.js"));
  candidates.push("C:/nvm4w/nodejs/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("找不到 pi 的 dist/cli.js，请设 PI_CLI 环境变量指向它");
}

function waitForPort(port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const s = net.connect({ host: "127.0.0.1", port }, () => {
        s.destroy();
        clearInterval(iv);
        resolve(true);
      });
      s.on("error", () => {
        if (Date.now() - t0 > 5000) {
          clearInterval(iv);
          resolve(false);
        }
      });
    }, 200);
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败: ${msg}`);
}

async function main() {
  const portGo = await freePort();
  const portDs = await freePort();
  const noCreds = MODE === "no-creds";

  // 一次性 pi 环境
  const models = {
    providers: {
      "fake-go": providerModels(portGo, "test-key-go"),
      "fake-ds": providerModels(portDs, noCreds ? undefined : "test-key-ds"),
    },
  };
  write(path.join(AGENT, "models.json"), JSON.stringify(models, null, 2));
  write(
    path.join(AGENT, "auth.json"),
    JSON.stringify(
      noCreds
        ? { "fake-go": { type: "api_key", key: "test-key-go" } }
        : { "fake-go": { type: "api_key", key: "test-key-go" }, "fake-ds": { type: "api_key", key: "test-key-ds" } }
    )
  );
  write(
    path.join(AGENT, "settings.json"),
    JSON.stringify({ defaultProvider: "fake-go", defaultModel: "deepseek-v4-flash" }, null, 2)
  );
  fs.copyFileSync(EXT, path.join(AGENT, "extensions", "go-fallback.ts"));
  // go-fallback.ts import 同目录的 go-fallback-core.mjs（纯决策层），必须一起拷
  fs.copyFileSync(
    path.join(REPO, "host", "pi-extensions", "go-fallback-core.mjs"),
    path.join(AGENT, "extensions", "go-fallback-core.mjs")
  );

  // 起 fake 上游（随机端口，进程级隔离）
  const server = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      GF_TEST_BASE: BASE,
      GO_MODE: MODE === "rate-limit" ? "rate-limit" : "quota",
      GF_PORT_GO: String(portGo),
      GF_PORT_DS: String(portDs),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (!(await waitForPort(portGo)) || !(await waitForPort(portDs))) {
    server.kill();
    throw new Error("fake 上游未在 5 秒内就绪");
  }

  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: AGENT,
    PI_CODING_AGENT_SESSION_DIR: SESSIONS,
    PI_GO_FALLBACK_PRIMARY: "fake-go",
    PI_GO_FALLBACK_PROVIDER: "fake-ds",
  };
  // 直接起 node cli.js，不经 cmd/shell——避免 shell 把任务串里的空格和 >> 当命令语法吞掉
  const res = spawnSync(process.execPath, [resolvePiCli(), "--provider", "fake-go", "--model", "deepseek-v4-flash", "-p", task], {
    env,
    encoding: "utf8",
    timeout: 150000,
  });
  server.kill();

  const stdout = res.stdout || "";
  const stderr = res.stderr || "";
  console.log(`pi exit=${res.status}`);
  console.log(`--- pi stdout ---\n${stdout.trim()}`);
  console.log(`--- pi stderr ---\n${stderr.trim()}`);

  const markerContent = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
  const settings = JSON.parse(fs.readFileSync(path.join(AGENT, "settings.json"), "utf8"));
  const session = fs
    .readdirSync(SESSIONS)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => fs.readFileSync(path.join(SESSIONS, f), "utf8"))
    .join("\n");
  const requests = fs.existsSync(path.join(BASE, "requests.jsonl"))
    ? fs
        .readFileSync(path.join(BASE, "requests.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];

  const seq = requests.map((r) => `${r.server}${r.reqSeq}:${r.status}`).join(" ");

  if (noCreds) {
    // 凭据缺失：必须明确失败，不许静默降级成功
    assert(res.status !== 0, "凭据缺失时应非零退出（明确报错），实际 exit=" + res.status);
    assert(/凭据缺失|无法降级/.test(stderr), "stderr 应有明确降级失败记录");
    assert(!/PHASE2_TASK_DONE/.test(stdout), "凭据缺失时任务不应被静默完成");
    console.log("✓ 凭据缺失场景：明确报错、未静默降级");
    console.log(`  请求序列: ${seq}`);
    return;
  }

  // a. 任务完成
  assert(/PHASE2_TASK_DONE_VIA_DIRECT_DS/.test(stdout), "任务应在降级通道上完成（stdout 应有 PHASE2_TASK_DONE_VIA_DIRECT_DS）");
  // b. 中途切走且未重启（quota 模式：go 首轮放行、写了一半才 429；rate-limit 模式：go 全 429，从第一轮就被切走）
  if (MODE !== "rate-limit") {
    assert(markerContent.includes("PHASE1_BEFORE_CUTOVER"), "切走前已写到一半（marker 应有 PHASE1_BEFORE_CUTOVER）");
  }
  assert(markerContent.includes("PHASE1_AFTER_CUTOVER"), "切走后继续干活（marker 应有 PHASE1_AFTER_CUTOVER）");
  // c. 可见记录
  assert(session.includes('"customType":"go-fallback"'), "会话应有 go-fallback 持久条目（appendEntry）");
  assert(/fake-go.*fake-ds/s.test(session), "会话应有 fake-go → fake-ds 的模型切换记录");
  // d. 默认值恢复
  assert(settings.defaultProvider === "fake-go" && settings.defaultModel === "deepseek-v4-flash", "settings.json 默认值应恢复为 fake-go/deepseek-v4-flash");
  // e. 请求序列（防止被残留进程劫持应答）
  const wantSeq = MODE === "rate-limit" ? /^go1:429 go2:429 ds1:200 ds2:200( |$)/ : /^go1:200 go2:429 ds1:200 ds2:200( |$)/;
  assert(wantSeq.test(seq), `请求序列应为 ${wantSeq}，实际: ${seq}`);

  console.log("✓ 端到端验收通过：中途限流 → 自动切直连 → 任务做完，切换有可见记录，默认值已恢复");
  console.log(`  请求序列: ${seq}`);
  console.log(`  临时环境: ${BASE}`);
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
