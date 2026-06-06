// dao 通用配置自愈合并器 — SessionStart hook + dao.ps1 link-claude + 登录计划任务 共用
//
// 背景:cc-switch 只能管 ~/.claude/settings.json 的 env 段(token/base_url/模型映射),
// 管不到 permissions/hooks/model/statusLine/theme 等通用配置。而 Claude Code 桌面端升级
// 已知会清空甚至删光 settings.json(见 anthropics/claude-code#40714 / #37871)。
// 本脚本以 claude/settings.base.json 为单一真相源,把通用配置幂等合并回 settings.json。
//
// 合并策略(用户已确认):
//   - env 段:子键合并 —— 保留 settings.json 现有 env(cc-switch 注入的 token/base_url/模型),
//             只补/盖 base.json 里声明的通用 env 键(如 CLAUDE_CODE_ATTRIBUTION_HEADER)。
//             => 凭证绝不丢。
//   - 其余顶层键:基线强制覆盖 —— base.json 声明的键一律以 base 为准(theme 被改了也纠回)。
//   - settings.json 里 base 未声明的顶层键(如 cc-switch 可能加的别的项):原样保留。
//   - 幂等:合并结果与现有完全一致则不写盘。
//
// 调用方式:
//   node dao-settings-sync.js                  # 默认:base 路径同目录上一级推断,settings 取 ~/.claude/settings.json
//   node dao-settings-sync.js <base> <target>  # 显式传参(dao.ps1 用)
//   作为 SessionStart hook 时无参,走默认路径。
//
// 任何错误一律 exit 0 无副作用(优雅降级,不阻断会话启动)。
// 真相源:windsurf-dao/claude/hooks/dao-settings-sync.js

const fs = require("fs");
const os = require("os");
const path = require("path");

function done() { process.exit(0); }

// 读 JSON 并剥离 UTF-8 BOM。
// PowerShell 的 Set-Content -Encoding UTF8 / 部分写入方会带 BOM(ef bb bf),
// JSON.parse 遇 BOM 直接抛错。必须先剥离,否则误判文件损坏 → 清空 env → 丢 token。
function readJson(p) {
  let txt = fs.readFileSync(p, "utf8");
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
  return JSON.parse(txt);
}

// ── 路径解析 ──
const argBase = process.argv[2];
const argTarget = process.argv[3];

// base.json 默认在本脚本上两级目录(hooks/ -> claude/settings.base.json)
const basePath = argBase
  ? path.resolve(argBase)
  : path.resolve(__dirname, "..", "settings.base.json");

const targetPath = argTarget
  ? path.resolve(argTarget)
  : path.join(os.homedir(), ".claude", "settings.json");

// ── 读基线(真相源缺失则什么都不做)──
let base;
try {
  base = readJson(basePath);
} catch (_) {
  done();
}
if (!base || typeof base !== "object") done();

// ── 读现有 settings ──
// 区分两种"读不到":
//   - 文件不存在 → 视作空对象,走全量重建(token 由 cc-switch 重新注入,符合预期)
//   - 文件存在但解析失败(损坏/半截写入)→ 放弃本次,绝不用空对象覆盖,以免冲掉 token
let current = {};
if (fs.existsSync(targetPath)) {
  try {
    current = readJson(targetPath);
  } catch (_) {
    done(); // 文件在但读不动:宁可不动,等下次自愈,也不丢凭证
  }
}
if (!current || typeof current !== "object") current = {};

// ── 合并 ──
// 浅拷贝现有 -> 保留 base 未声明的顶层键
const merged = Object.assign({}, current);

for (const key of Object.keys(base)) {
  if (key === "env") {
    // env:子键合并,现有值优先(护住 cc-switch 的凭证),base 只补声明的通用键
    const curEnv = (current.env && typeof current.env === "object") ? current.env : {};
    const baseEnv = (base.env && typeof base.env === "object") ? base.env : {};
    // 先放现有 env(token/base_url/模型保留),再用 base 的通用键覆盖(确保通用键以基线为准)
    merged.env = Object.assign({}, curEnv, baseEnv);
  } else {
    // 其余顶层键:基线强制覆盖
    merged[key] = base[key];
  }
}

// ── 幂等:递归按键排序后稳定序列化对比,无变化不写盘 ──
function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === "object") {
    const out = {};
    for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
    return out;
  }
  return o;
}

const before = JSON.stringify(sortKeys(current));
const after = JSON.stringify(sortKeys(merged));

if (before === after) {
  // 已一致(且文件存在),不动
  if (fs.existsSync(targetPath)) done();
}

// ── 写盘(2 空格缩进,与 base.json 一致)──
try {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
} catch (_) {
  // 写失败也静默,下次启动/登录再自愈
}

done();
