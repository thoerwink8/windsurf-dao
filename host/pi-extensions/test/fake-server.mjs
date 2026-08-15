// Fake upstream servers for go-fallback E2E (issue #520).
// - Port 8457 = "fake-go"   (mimics opencode.ai/zen/go):
//     GO_MODE=quota（默认）: req#1 OK with tool call, then 429 GoUsageLimitError（额度耗尽，non-retryable）
//     GO_MODE=rate-limit     : every request 429 rate_limit_error（瞬时限流，pi 会内置重试）
// - Port 8458 = "fake-ds"   (mimics direct api.deepseek.com): req#1 tool call, req>=2 text
// Every request is logged to <base>/requests.jsonl for evidence.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.GF_TEST_BASE || path.join(process.cwd(), ".gf-e2e");
const LOG = path.join(BASE, "requests.jsonl");
// 命令要进 Git Bash 执行，路径必须全正斜杠（反斜杠会被 bash 当转义符吃掉）
const MARKER = path.join(BASE, "marker.txt").replace(/\\/g, "/");
const GO_MODE = process.env.GO_MODE || "quota";

fs.mkdirSync(BASE, { recursive: true });

let goCount = 0;
let dsCount = 0;

function log(server, req, status, bodyHint) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    server,
    method: req.method,
    url: req.url,
    status,
    reqSeq: server === "go" ? ++goCount : ++dsCount,
    respHint: bodyHint,
  });
  fs.appendFileSync(LOG, line + "\n");
}

function sse(res, chunks) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function chunk(id, delta, finish_reason) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason }],
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => resolve(data));
  });
}

function makeServer(port, name, handler) {
  const s = http.createServer(async (req, res) => {
    const body = await readBody(req);
    try {
      await handler(req, res, body);
    } catch (e) {
      log(name, req, 500, String(e));
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e) } }));
    }
  });
  s.listen(port, "127.0.0.1", () => console.log(`[${name}] listening on 127.0.0.1:${port}`));
}

const PORT_GO = Number(process.env.GF_PORT_GO || 8457);
const PORT_DS = Number(process.env.GF_PORT_DS || 8458);

// ── fake-go ────────────────────────────────────────────────────────────────
makeServer(PORT_GO, "go", async (req, res) => {
  if (req.method !== "POST" || !req.url.includes("/chat/completions")) {
    res.writeHead(404); res.end(); return;
  }
  const n = goCount + 1;
  if (GO_MODE === "quota" && n === 1) {
    log("go", req, 200, "tool_call: bash echo PHASE1_BEFORE_CUTOVER");
    const toolArgs = JSON.stringify({ command: `echo PHASE1_BEFORE_CUTOVER >> ${MARKER}` });
    sse(res, [
      chunk("chatcmpl-go-1", { role: "assistant", content: "" }, null),
      chunk("chatcmpl-go-1", { tool_calls: [{ index: 0, id: "call_go_1", type: "function", function: { name: "bash", arguments: "" } }] }, null),
      chunk("chatcmpl-go-1", { tool_calls: [{ index: 0, function: { arguments: toolArgs } }] }, null),
      chunk("chatcmpl-go-1", {}, "tool_calls"),
    ]);
    return;
  }
  if (GO_MODE === "quota") {
    // OpenCode Zen Go 风格额度耗尽：429 + GoUsageLimitError（实测 pi 对这类错误不重试，当场放弃）
    log("go", req, 429, "GoUsageLimitError body");
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": "3600",
      "x-should-retry": "false",
    });
    res.end(JSON.stringify({
      error: {
        type: "GoUsageLimitError",
        message: "Monthly usage limit reached. Enable available-balance usage to continue, or wait for the limit to reset.",
      },
    }));
    return;
  }
  // rate-limit mode: transient 429 forever（pi 会内置重试；扩展在第 2 次连续失败后降级）
  log("go", req, 429, "rate_limit_error body");
  res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
  res.end(JSON.stringify({
    error: { message: "Rate limit reached. Please slow down.", type: "rate_limit_error" },
  }));
});

// ── fake-ds ────────────────────────────────────────────────────────────────
makeServer(PORT_DS, "ds", async (req, res) => {
  if (req.method !== "POST" || !req.url.includes("/chat/completions")) {
    res.writeHead(404); res.end(); return;
  }
  const n = dsCount + 1;
  if (n === 1) {
    log("ds", req, 200, "tool_call: bash echo PHASE1_AFTER_CUTOVER");
    const toolArgs = JSON.stringify({ command: `echo PHASE1_AFTER_CUTOVER >> ${MARKER}` });
    sse(res, [
      chunk("chatcmpl-ds-1", { role: "assistant", content: "" }, null),
      chunk("chatcmpl-ds-1", { tool_calls: [{ index: 0, id: "call_ds_1", type: "function", function: { name: "bash", arguments: "" } }] }, null),
      chunk("chatcmpl-ds-1", { tool_calls: [{ index: 0, function: { arguments: toolArgs } }] }, null),
      chunk("chatcmpl-ds-1", {}, "tool_calls"),
    ]);
    return;
  }
  log("ds", req, 200, "text reply");
  sse(res, [
    chunk("chatcmpl-ds-2", { role: "assistant", content: "" }, null),
    chunk("chatcmpl-ds-2", { content: n === 2 ? "PHASE2_TASK_DONE_VIA_DIRECT_DS" : "ack (continuation)" }, null),
    chunk("chatcmpl-ds-2", {}, "stop"),
  ]);
});
