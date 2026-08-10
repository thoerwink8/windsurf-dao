// dao 会话标题中文化 hook — UserPromptSubmit
//
// Claude Code 内置标题 prompt 写死在二进制里(英文规范 no-more-than-6-words / sentence case,
// 无语言指令),导致中文会话也被服务端英译。本 hook 在用户发首条消息时,
// 用你的原始 prompt 调 Claude 生成简体中文短标题,经 hookSpecificOutput.sessionTitle 注入。
//
// 已逆向证实(claude.exe 2.1.x):
//   - UserPromptSubmit hook stdin 含 prompt / session_title / session_id
//   - 输出 hookSpecificOutput.sessionTitle 被存为 custom-title
//   - 展示优先级 custom-title > 自动生成的 aiTitle(永不被英译覆盖)
//
// 设计要点(为道日损 + 道法自然):
//   - 只在首条消息生效:session_title 已非空即瞬时跳过(零成本)
//   - 任何错误/超时一律 exit 0 无输出,优雅降级回默认标题,下条消息自愈重试
//   - 45s 冷却:API 故障时不让每条消息都卡延迟
//
// 真相源:windsurf-dao/ccswitch/hooks/dao-cn-title.js
// 由 settings.json 的 UserPromptSubmit hook 调用。

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");

// ── 读 stdin ──
let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch (_) {}

let input = {};
try { input = JSON.parse(raw); } catch (_) {}

const prompt = String(input.prompt || "");
const currentTitle = String(input.session_title || "").trim();
const sessionId = String(input.session_id || "");

// 始终 exit 0(只增不阻);所有 return 都意味着"放弃设标题,降级回默认"
function done() { process.exit(0); }

// ① 标题已设过 → 瞬时跳过(天然的"只在首条生效"开关)
if (currentTitle) done();

// ② 剥噪音:去掉 [Image #N]、<tag>...</tag>、首尾空白
function strip(s) {
  return s
    .replace(/\[Image #\d+\]/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const clean = strip(prompt);

// ③ 无实质内容(纯命令/纯图片/空) → 跳过
//    纯 slash 命令(如 "/clear" "/goal xxx" 开头且去命令后无中文)交给默认标题
if (!clean || clean.length < 2) done();
if (/^\//.test(clean)) {
  // 去掉首个 /命令 token 后若仍有实质内容,用剩余部分;否则跳过
  const rest = clean.replace(/^\/\S+\s*/, "").trim();
  if (!rest) done();
}

// ④ 冷却:state 文件按 sessionId 记录上次尝试时间,45s 内不重试
//    防 API 故障期间每条消息都卡同步延迟
const COOLDOWN_MS = 45_000;
const stateDir = path.join(os.tmpdir(), "dao-cn-title");
const stateFile = sessionId ? path.join(stateDir, sessionId + ".ts") : "";
if (stateFile) {
  try {
    const last = Number(fs.readFileSync(stateFile, "utf8")) || 0;
    if (Date.now() - last < COOLDOWN_MS) done();
  } catch (_) {}
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, String(Date.now()));
  } catch (_) {}
}

// ⑤ 调 Claude 生成中文标题
const token = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "";
if (!token) done(); // 无凭据 → 降级
const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

const ask =
  "下面是一段对话的开场白。请用不超过12个汉字的简体中文,简洁概括它的核心主题,作为会话标题。" +
  "只输出标题本身,不要引号、不要标点、不要解释、不要英文。\n\n开场白:" +
  clean.slice(0, 600);

const body = JSON.stringify({
  model,
  max_tokens: 32,
  messages: [{ role: "user", content: ask }],
});

let url;
try { url = new URL(base + "/v1/messages"); } catch (_) { done(); }
const mod = url.protocol === "https:" ? https : http;

const req = mod.request(
  url,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": token,
      "Authorization": "Bearer " + token,
      "anthropic-version": "2023-06-01",
      "Content-Length": Buffer.byteLength(body),
    },
    timeout: 8000,
  },
  (res) => {
    let data = "";
    res.on("data", (c) => (data += c));
    res.on("end", () => {
      let title = "";
      try {
        const j = JSON.parse(data);
        title = ((j.content && j.content[0] && j.content[0].text) || "").trim();
      } catch (_) {}
      title = title.replace(/[\r\n]+/g, " ").replace(/^["'「『《]+|["'」』》。.\s]+$/g, "").trim();
      if (title.length > 20) title = title.slice(0, 20);
      // 必须含中文才采纳,否则降级(不输出 = 用默认标题)
      if (!title || !/[一-鿿]/.test(title)) done();
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            sessionTitle: title,
          },
        })
      );
      process.exit(0);
    });
  }
);
req.on("error", () => done());
req.on("timeout", () => { try { req.destroy(); } catch (_) {} done(); });
req.write(body);
req.end();
