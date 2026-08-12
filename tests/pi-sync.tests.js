// pi-sync.tests.js — pi(~/.pi/agent/) 配置同步（issue #344）回归网
//
// 判据全在 config-sync/lib/pi-sync.mjs（纯函数 + 显式目录参数的 I/O 边界），
// 本套测试用 _tmp/pi-sync-sandbox 临时目录跑全流程，不碰真机 ~/.pi/agent 与 common-secrets.json。
// 层：①脱敏往返 ②缺失 secrets 降级 ③settings 漂移正负控 ④主题三向漂移 ⑤auth 泄漏 ⑥I/O 往返。
// 判别力自检问句：任何放宽/收紧 pi 漂移判据的改动，是否都至少有一条断言会变红？

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const P = require(path.join(REPO, "config-sync", "lib", "pi-sync.mjs"));
const SANDBOX = path.join(REPO, "_tmp", "pi-sync-sandbox");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
function sb(rel) { return path.join(SANDBOX, rel); }
function w(rel, content) {
  const p = sb(rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}

const CANARY_KEY = "sk-CANARYaaaabbbbccccddddeeee";

console.log("\n=== ① auth 脱敏往返（导出 → 恢复 → 原样）===");
{
  const auth = {
    deepseek: { type: "api_key", key: CANARY_KEY },
    openai: { type: "api_key", key: "sk-openai-CANARY-1111" },
    proxy: { type: "none", note: "纯文本不脱敏" },
  };
  const { redacted, secrets } = P.redactPiAuth(auth);
  check("敏感字段值 → 占位符", redacted.deepseek.key === "__CONFIG_SYNC_SECRET__" && redacted.openai.key === "__CONFIG_SYNC_SECRET__");
  check("非敏感字段不动", redacted.proxy.note === "纯文本不脱敏" && redacted.proxy.type === "none");
  check("secrets 键带 pi_auth 命名空间", Object.keys(secrets).sort().join(",") === "pi_auth :: deepseek.key,pi_auth :: openai.key");
  const back = P.rehydratePiAuth(redacted, secrets);
  check("还原后与原文结构一致", P.sameJson(back, auth));
  check("缺真实值 ⇒ 返回 null（恢复方跳过）", P.rehydratePiAuth(redacted, {}) === null);
}

console.log("\n=== ② settings 漂移判定（正控 + 负控）===");
{
  const a = { theme: "dao-dark", defaultProvider: "deepseek", defaultModel: "deepseek-v4-flash" };
  const b = { defaultModel: "deepseek-v4-flash", theme: "dao-dark", defaultProvider: "deepseek" }; // 键序不同
  check("负控：键序/缩进不同仍是同一份", P.sameJson(a, b));
  check("正控：值不同判漂移", !P.sameJson(a, { ...a, theme: "light" }));
  check("正控：缺键判漂移", !P.sameJson(a, { theme: "dao-dark" }));
}

console.log("\n=== ③ 主题三向漂移（缺 / 改 / 多）===");
{
  const snapThemeA = w("snap/themes/dao-dark.json", JSON.stringify({ name: "dao-dark", vars: { a: 1 } }));
  const snapThemeB = w("snap/themes/extra.json", JSON.stringify({ name: "extra" }));
  const localThemeA = w("local/themes/dao-dark.json", JSON.stringify({ vars: { a: 1 }, name: "dao-dark" }));
  const localThemeB = w("local/themes/other.json", JSON.stringify({ name: "other" }));

  const snapMap = { "dao-dark.json": snapThemeA, "extra.json": snapThemeB };
  const localMap = { "dao-dark.json": localThemeA, "other.json": localThemeB };
  const d = P.themeDrift(snapMap, localMap);
  check("内容一致（结构相同）不算改动", !d.changed.includes("dao-dark.json"));
  check("快照有、本机缺 ⇒ missing", d.missing.includes("extra.json"));
  check("本机多出 ⇒ extra", d.extra.includes("other.json"));
  check("漂移三向无漏报", d.missing.length === 1 && d.changed.length === 0 && d.extra.length === 1);

  const broken = w("snap/themes/broken.json", "{ not json");
  const brokenLocal = w("local/themes/broken.json", "{ not json");
  check("非 JSON 文件走字节哈希：字节相同算一致", P.sameFile(broken, brokenLocal));
  check("非 JSON 字节不同算漂移", !P.sameFile(broken, w("local/themes/broken2.json", "{ different")));
}

console.log("\n=== ④ auth 占位快照泄漏判定 ===");
{
  const clean = { deepseek: { type: "api_key", key: "__CONFIG_SYNC_SECRET__" } };
  check("负控：全占位符 ⇒ 零泄漏", P.leakedSecretPaths(clean).length === 0);
  const leaky = { deepseek: { type: "api_key", key: CANARY_KEY }, model: "deepseek-v4" };
  const leaked = P.leakedSecretPaths(leaky);
  check("正控：真实密钥字段 ⇒ 报泄漏路径", leaked.includes("deepseek.key"));
  check("正控：非敏感字段不误报", !leaked.includes("model"));
  check("占位计数：1 个占位符", P.countPiSecrets({ "pi_auth :: deepseek.key": CANARY_KEY }) === 1);
  check("占位计数：非 pi_auth 键不计入", P.countPiSecrets({ "common_config_x :: a.b": "v" }) === 0);
}

console.log("\n=== ⑤ I/O 往返：导出 → 恢复（干净环境模拟）===");
{
  const agent = sb("io/agent");
  const snap = sb("io/snap");
  const secretsPath = sb("io/secrets.json");
  const fresh = sb("io/fresh"); // 恢复目标（模拟另一台机器的空 ~/.pi/agent）

  // 造一台「源机器」的 ~/.pi/agent
  w("io/agent/settings.json", JSON.stringify({ lastChangelogVersion: "0.84.1", defaultProvider: "deepseek", defaultModel: "deepseek-v4-flash", theme: "dao-dark" }));
  w("io/agent/themes/dao-dark.json", JSON.stringify({ name: "dao-dark", colors: { accent: "accentBlue" } }));
  w("io/agent/auth.json", JSON.stringify({ deepseek: { type: "api_key", key: CANARY_KEY } }));
  // 不该被同步的本机产物，导出/恢复都必须不碰
  w("io/agent/sessions/x.json", "{}");
  w("io/agent/models-store.json", "{}");
  w("io/agent/bin/tool.exe", "x");
  w("io/agent/extensions/y.js", "x");

  const exp = P.exportPi({ agentDir: agent, snapshotDir: snap, secretsPath });
  check("导出：settings 落快照", fs.existsSync(path.join(snap, "settings.json")));
  check("导出：主题落快照", fs.existsSync(path.join(snap, "themes", "dao-dark.json")));
  check("导出：auth 落占位快照", fs.readFileSync(path.join(snap, "auth.json"), "utf8").includes("__CONFIG_SYNC_SECRET__"));
  check("导出：真实值入 common-secrets.json", fs.readFileSync(secretsPath, "utf8").includes(CANARY_KEY));
  check("导出：不碰 sessions/models-store/bin/extensions", fs.existsSync(path.join(snap, "sessions")) === false && fs.existsSync(path.join(snap, "models-store.json")) === false);
  check("导出：快照 auth 无明文密钥", P.leakedSecretPaths(JSON.parse(fs.readFileSync(path.join(snap, "auth.json"), "utf8"))).length === 0);

  // 干净环境恢复
  const rst = P.restorePi({ agentDir: fresh, snapshotDir: snap, secretsPath });
  check("恢复：settings 落位", fs.existsSync(path.join(fresh, "settings.json")));
  check("恢复：主题落位", fs.existsSync(path.join(fresh, "themes", "dao-dark.json")));
  check("恢复：auth 脱敏还原（真值回位）", fs.readFileSync(path.join(fresh, "auth.json"), "utf8").includes(CANARY_KEY));
  check("恢复：settings 与源机器一致", P.sameFile(path.join(agent, "settings.json"), path.join(fresh, "settings.json")));
  check("恢复：auth 与源机器一致", P.sameFile(path.join(agent, "auth.json"), path.join(fresh, "auth.json")));
  check("恢复：不写 sessions/models-store/bin/extensions", fs.existsSync(path.join(fresh, "sessions")) === false && fs.existsSync(path.join(fresh, "models-store.json")) === false);
  check("恢复：change 清单覆盖三件", rst.changes.sort().join(",") === "auth.json,settings.json,themes/dao-dark.json");

  // 缺 secrets 的机器：auth 跳过、其余照常
  fs.rmSync(path.join(fresh, "auth.json"), { force: true });
  const rst2 = P.restorePi({ agentDir: fresh, snapshotDir: snap, secretsPath: sb("no-secrets.json") });
  check("缺 secrets ⇒ auth 跳过（不写坏文件）", !fs.existsSync(path.join(fresh, "auth.json")));
  check("缺 secrets ⇒ settings/themes 照常落位", fs.existsSync(path.join(fresh, "settings.json")) && fs.existsSync(path.join(fresh, "themes", "dao-dark.json")));

  // dry-run 不落盘
  fs.rmSync(path.join(fresh, "settings.json"), { force: true });
  P.restorePi({ agentDir: fresh, snapshotDir: snap, secretsPath, dryRun: true });
  check("dry-run 不写盘", !fs.existsSync(path.join(fresh, "settings.json")));
}

console.log("\n=== ⑥ 泄漏判定与导出脱敏同一份判据（isSecretKey）===");
{
  check("apiKey / token / secret 字段名全报泄漏（未脱敏时）",
    P.leakedSecretPaths({ a: { apiKey: "x", token: "y", secret: "z", safe: "ok" } }).sort().join(",") === "a.apiKey,a.secret,a.token");
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
