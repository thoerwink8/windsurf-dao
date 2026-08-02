// dao-hard-gates 回归网 — 每闸正控 + 误伤负控 + mutation 判别力 + canary 恒等
//
// 跑法：node tests/hard-gates.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 为什么这份测试的形态是这样 ──────────────────────────────────────────────
// 被测对象是**一道会 exit 2 拦人的闸**，它的两侧代价都是真代价：
//   · 漏报 → 那条禁令仍然只是文字，而文字禁令的实测遵守率是 0%（arxiv 2607.26819）
//   · 误报 → 合法动作被拦死，而甲类闸的逃生阀只有用户设得了 ⇒ 会话当场卡住
// 故每闸都是**双向断言**：违例必 exit 2 且 stderr 里给得出合法路径；合法输入必 exit 0。
// 只证明「能拦住」不算完成 —— 这是 dispatch-clauses 实现官节点名要求的那一条。
//
// ── mutation 为什么写进回归网而不是手工跑一次 ───────────────────────────────
// 「测试存在」不等于「测试有判别力」。手工 mutation 只发生一次，判据却会被反复编辑。
// 故本文件把 mutation 做成常驻断言：把某一闸的判定**改坏**（写进 _tmp/ 的副本，
// 从不碰真文件），断言原本 exit 2 的那条用例变成 exit 0；再断言真文件在整个过程中
// 逐字节没动过（canary 恒等）。任何一天有人把某条判据写成永假，这里会红。
//
// ── 已知不覆盖（照直写，别读成全覆盖）──────────────────────────────────────
// · matcher 覆盖面只由 `--selfcheck` 自查，本文件只断言它的**输出形态**——
//   真实注册状态取决于用户的 live settings.json，锚死会让测试随用户配置变红。
// · fail-open 路径用「注入一个必抛的判定」构造，证的是「崩了会放行且会喊」，
//   证不了「所有崩法都能被 catch 到」（catch 不住的崩法：进程级 OOM/被杀）。
// · G5 的 `--body-file` 只测真实可读文件；「文件读不到 ⇒ 放行」这个漏报面
//   有一条负控钉着，但那是**有意为之**（见 hook 内注释），不是待修的洞。
// · G6 与 dao-rhythm.js WAKEUP 信号的**跨文件判据一致性**不在本文件，在
//   `tests/dao-rhythm.tests.js` 末尾那一组（那边有现成的沙箱，能避开真实埋点日志污染）。
//   放在这里只留指针：判据有两份实现，一致性只由那一组钉着，改任一侧都要看它。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-hard-gates.js");
const NUDGE = path.join(REPO, "ccswitch", "hooks", "dao-tool-nudge.js");
const TMP = path.join(REPO, "_tmp", "hard-gates-tests");

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const HOME = process.env.USERPROFILE || process.env.HOME;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

function sha(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// 喂一次 PreToolUse 输入。script 缺省=真 hook；env 用于测逃生阀。
function gate(payload, { script = HOOK, env = {} } = {}) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, err: String(r.stderr || ""), out: String(r.stdout || "") };
}

function nudge(command, toolName = "Bash") {
  const r = spawnSync(process.execPath, [NUDGE], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    encoding: "utf8",
  });
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch (_) {}
  return String((out.hookSpecificOutput || {}).additionalContext || "");
}

const bash = (command, cwd) => ({ tool_name: "Bash", tool_input: { command }, cwd });
const edit = (file_path) => ({ tool_name: "Edit", tool_input: { file_path } });
const wake = (tool_input) => ({ tool_name: "ScheduleWakeup", tool_input });

// 每闸的一条"承重正控"，mutation 与 canary 都拿它当靶
const CANARY = {
  "G1-windows-mcp": { tool_name: "mcp__windows-mcp__Screenshot", tool_input: {} },
  "G2-live-settings": edit(path.join(HOME, ".claude", "settings.json")),
  "G3-publish": bash("npm publish --access public"),
  "G4-screenshot-path": {
    tool_name: "mcp__chrome-devtools__take_screenshot",
    tool_input: { filePath: "D:/frank/mousse-cli/shot.png" },
  },
  "G5-readonly-todo": bash('gh pr create --title x --body "做完了\n- [ ] 还没跑测试"'),
  // 取一条**真实语料形态**当承重正控：这段开头逐字抄自 ~/.claude/projects 里的历史心跳
  // （全量普查 993 次 ScheduleWakeup 调用，非 stop 的 962 次全长这样，零次带签名）。
  // 拿真实形态当靶，是为了让「闸上线后第一天会拦到什么」这件事在测试里就看得见。
  "G6-heartbeat-signature": wake({
    delaySeconds: 1500,
    prompt: "高性能目标窗心跳（不限时，目标=除蓄水池外 issue 清零）。对账：① 三路在途……",
  }),
  // 同样取**真实语料形态**：这条逐字抄自转录（`sed -n` 读文件片段是新增拦截面里第三大的一格）。
  // 注意它带 `cd … &&` 前缀 —— 真语料里 grep/sed 极少单独出现，绝大多数长这样，
  // 而这正是「段首」判据最容易写错的地方（`cd` 会把真正的命令挤到第二段去）。
  "G7-shell-search": bash("cd /d/frank/mousse-cli && sed -n 1,140p crates/mousse-app/src/commands/session.rs"),
};

const PRISTINE_SHA = sha(HOOK);
const canaryBefore = {};
for (const [id, p] of Object.entries(CANARY)) canaryBefore[id] = gate(p).code;

console.log("\n──── G1 · windows-mcp 全面禁令（一票否决，无逃生阀）────");
{
  for (const t of ["mcp__windows-mcp__Screenshot", "mcp__windows-mcp__Click", "mcp__windows_mcp__PowerShell"]) {
    const r = gate({ tool_name: t, tool_input: {} });
    check(`正控：${t} → exit 2`, r.code === 2, `code=${r.code}`);
    check(`正控：${t} stderr 给得出替代工具`, /chrome-devtools|playwright/.test(r.err), r.err.slice(0, 120));
  }
  // 无逃生阀：即便把别的闸的 env 全设上也拦
  check("无逃生阀：设了所有已知 env 仍 exit 2",
    gate(CANARY["G1-windows-mcp"], {
      env: { DAO_SETTINGS_EDIT_APPROVED: "1", DAO_PUBLISH_APPROVED: "1", DAO_ALLOW_READONLY_TODO: "1" },
    }).code === 2);

  const negatives = [
    ["chrome-devtools 截图（无路径）不该拦", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: {} }],
    ["playwright 点击不该拦", { tool_name: "mcp__playwright__browser_click", tool_input: {} }],
    ["名字里含 windows 但非 windows-mcp 服务器不该拦", { tool_name: "mcp__fs__read_windows_file", tool_input: {} }],
    ["内置 PowerShell 工具不该被当成 windows-mcp", bash("Get-Process node")],
  ];
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code}`);
}

console.log("\n──── G2 · live ~/.claude/settings.json（投影，非源）────");
{
  for (const n of ["settings.json", "settings.local.json"]) {
    const r = gate(edit(path.join(HOME, ".claude", n)));
    check(`正控：Edit ${n} → exit 2`, r.code === 2, `code=${r.code}`);
    // ⚠ 2026-08-02 issue #63 改钉：原先这两条钉的是「指出 config-sync 快照层 + direction=down 是正路」，
    // 而那条路径已被 #49 的下发链实测证伪（快照层与 common_config_* 镜像层都不在下发路径上，
    // 照它做改动永不生效，PR #43 即如此）。现在钉的是①真实下发源②那两层**被明说为不生效**。
    // **刻意不写成 `!/direction/` 那种反向断言**：新文案仍然点名 `dao.bat --direction=down/up`，
    // 只是把它从「正路」改成「别拿它来让 hook 生效」——禁令本身有价值（旧说法散在 PR body 与
    // 历史文档里，光删不说等于让人再试一次）。两条断言在文案被回退成旧版时都会红（已 mutation 实测）。
    check(`正控：${n} stderr 指出真实下发源 providers.settings_config + 每个 provider 都要改`,
      /providers/.test(r.err) && /settings_config/.test(r.err) && /每个 provider 都要改/.test(r.err), r.err.slice(0, 300));
    check(`正控：${n} stderr 明说快照层/镜像层不会生效（旧「正路」已被 #49 证伪）`,
      /镜像层/.test(r.err) && /不会生效/.test(r.err), r.err.slice(0, 300));
  }
  check("正控：Write（整份覆写）同样拦",
    gate({ tool_name: "Write", tool_input: { file_path: path.join(HOME, ".claude", "settings.json") } }).code === 2);
  check("正控：反斜杠路径同样拦（Windows 原生形态）",
    gate({ tool_name: "Write", tool_input: { file_path: `${HOME}\\.claude\\settings.json` } }).code === 2);
  check("逃生阀：DAO_SETTINGS_EDIT_APPROVED=1 → 放行",
    gate(CANARY["G2-live-settings"], { env: { DAO_SETTINGS_EDIT_APPROVED: "1" } }).code === 0);
  check("逃生阀只认 '1'，不认 'true'（免得随手设个值就等于关掉闸）",
    gate(CANARY["G2-live-settings"], { env: { DAO_SETTINGS_EDIT_APPROVED: "true" } }).code === 2);

  const negatives = [
    // 名字 2026-08-02 (#63) 改过：原写「改 git 快照层是正路」——**那句话本身已被 #49 证伪**
    // （快照层不在下发路径上）。断言不变、覆盖面不变：本闸只管 live 那一份，仓内文件本就不该拦。
    ["改仓内 config-sync 快照层不该拦（本闸只管 live 那一份；快照层能不能生效是另一回事）",
      edit(path.join(REPO, "config-sync", "common", "settings.json"))],
    ["改项目级 .claude/settings.json 不该拦（那不是 cc-switch 投影）",
      edit("D:/frank/mousse-cli/.claude/settings.json")],
    ["改 ~/.claude 下的别的文件不该拦", edit(path.join(HOME, ".claude", "CLAUDE.md"))],
    ["写 _tmp/settings-patch.json 是 dao 指定的降级路径，不该拦",
      edit(path.join(REPO, "_tmp", "settings-patch.json"))],
    ["Read 不该拦（本闸只管写）", { tool_name: "Read", tool_input: { file_path: path.join(HOME, ".claude", "settings.json") } }],
  ];
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code}`);
}

console.log("\n──── G3 · 对外发布（⑤自主边界：不可逆 + 需用户在场）────");
{
  const positives = [
    "npm publish --access public",
    "pnpm publish",
    "yarn publish",
    "cargo publish",
    "gh release create v1.2.3 --notes x",
    "gh release delete v1.0.0",
    "cd /d/frank/mousse-cli && npm publish",
    "VERSION=1.2.3 cargo publish",
  ];
  for (const c of positives) {
    const r = gate(bash(c));
    check(`正控：${c} → exit 2`, r.code === 2, `code=${r.code} ${r.err.slice(0, 80)}`);
  }
  check("正控：stderr 给得出三条合法路径（说明+dry-run+用户设 env）",
    /--dry-run/.test(gate(bash("npm publish")).err) && /DAO_PUBLISH_APPROVED/.test(gate(bash("npm publish")).err));
  check("正控：PowerShell 工具同样受管", gate({ tool_name: "PowerShell", tool_input: { command: "cargo publish" } }).code === 2);
  check("逃生阀：DAO_PUBLISH_APPROVED=1 → 放行",
    gate(CANARY["G3-publish"], { env: { DAO_PUBLISH_APPROVED: "1" } }).code === 0);

  const negatives = [
    ["--dry-run 是真演练，放行", "npm publish --dry-run"],
    ["cargo publish --dry-run 放行", "cargo publish --dry-run"],
    ["gh release list 只读，放行", "gh release list"],
    ["gh release view 只读，放行", "gh release view v1.0.0"],
    ["npm run build 放行", "npm run build"],
    ["npm install 放行", "npm install"],
    ["带 publish 字样但不是发布命令，放行", "node scripts/publish-notes.mjs"],
    ["字符串字面量里的命令，放行（段首不是它）", 'echo "npm publish"'],
    ["git push 归乙类软提醒，本闸放行", "git push origin main"],
  ];
  for (const [name, c] of negatives) check(`负控：${name}`, gate(bash(c)).code === 0, `code=${gate(bash(c)).code}`);
}

console.log("\n──── G4 · 浏览器 MCP 截图落盘路径（无逃生阀，正路只是换路径）────");
{
  const positives = [
    ["chrome-devtools 落项目根", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: { filePath: "D:/frank/mousse-cli/shot.png" } }],
    ["playwright 落 _tmp 但不在 qa 下", { tool_name: "mcp__playwright__browser_take_screenshot", tool_input: { filename: "_tmp/shot.png" } }],
    ["落系统 temp", { tool_name: "mcp__playwright__browser_take_screenshot", tool_input: { filename: "C:/Users/x/AppData/Local/Temp/a.png" } }],
    ["反斜杠路径", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: { filePath: "D:\\frank\\mousse-cli\\qa\\a.png" } }],
  ];
  for (const [name, p] of positives) {
    const r = gate(p);
    check(`正控：${name} → exit 2`, r.code === 2, `code=${r.code}`);
  }
  check("正控：stderr 给得出规范路径形态", /_tmp\/qa\/<context>/.test(gate(positives[0][1]).err));
  check("无逃生阀：设满 env 仍拦",
    gate(positives[0][1], { env: { DAO_SETTINGS_EDIT_APPROVED: "1", DAO_PUBLISH_APPROVED: "1", DAO_ALLOW_READONLY_TODO: "1" } }).code === 2);

  const negatives = [
    ["不给路径=内联返回不落盘，放行", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: { fullPage: true } }],
    ["绝对路径落 _tmp/qa 下，放行", { tool_name: "mcp__chrome-devtools__take_screenshot", tool_input: { filePath: "D:/frank/mousse-cli/_tmp/qa/pr-1/a.png" } }],
    ["相对路径落 _tmp/qa 下，放行", { tool_name: "mcp__playwright__browser_take_screenshot", tool_input: { filename: "_tmp/qa/run/a.png" } }],
    ["反斜杠的 _tmp\\qa 也认，放行", { tool_name: "mcp__playwright__browser_take_screenshot", tool_input: { filename: "D:\\repo\\_tmp\\qa\\c\\a.png" } }],
    ["非截图工具带路径，放行", { tool_name: "mcp__playwright__browser_navigate", tool_input: { filename: "x.png" } }],
  ];
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code}`);
}

console.log("\n──── G5 · 只读载体未勾待办（PR body / commit message）────");
{
  const bodyFile = path.join(TMP, "pr-body.md");
  fs.writeFileSync(bodyFile, "## 为什么改\n修了个洞。\n\n## 合并前自检\n- [ ] 验证跑了且过了\n", "utf8");
  const cleanFile = path.join(TMP, "pr-body-clean.md");
  fs.writeFileSync(cleanFile, "## 为什么改\n修了个洞。\n\n- [x] 验证跑了且过了（exit 0）\n", "utf8");

  const positives = [
    ["gh pr create 内联 body 含未勾框", bash('gh pr create --title x --body "- [ ] 还没跑"')],
    ["gh pr edit 内联 body 含未勾框", bash('gh pr edit 42 --body "- [ ] 待补"')],
    ["gh pr create --body-file 指向含未勾框的文件", bash(`gh pr create --title x --body-file ${bodyFile}`, TMP)],
    ["git commit -m 含未勾框", bash('git commit -m "[cc] feat: x\n- [ ] 随后补测试"')],
  ];
  for (const [name, p] of positives) {
    const r = gate(p);
    check(`正控：${name} → exit 2`, r.code === 2, `code=${r.code} ${r.err.slice(0, 80)}`);
    check(`正控：${name} stderr 给得出三选一`, /- \[x\]/.test(r.err) && /可编辑/.test(r.err), r.err.slice(0, 160));
  }
  check("正控：--body-file 用相对路径 + cwd 也能读到",
    gate(bash("gh pr create --title x --body-file pr-body.md", TMP)).code === 2);
  check("逃生阀：DAO_ALLOW_READONLY_TODO=1 → 放行",
    gate(CANARY["G5-readonly-todo"], { env: { DAO_ALLOW_READONLY_TODO: "1" } }).code === 0);

  const negatives = [
    ["已勾的 - [x] 是陈述过去，放行", bash('gh pr create --body "- [x] 跑过了"')],
    ["gh issue create 是可编辑载体，放行", bash('gh issue create --title x --body "- [ ] 待办"')],
    ["gh pr comment 不在本条射程内，放行", bash('gh pr comment 42 --body "- [ ] x"')],
    ["gh pr view 只读，放行", bash("gh pr view 42 --json body")],
    ["--body-file 指向干净文件，放行", bash(`gh pr create --title x --body-file ${cleanFile}`, TMP)],
    ["--body-file 指向不存在的文件 → 放行（明写的漏报面，不是洞）",
      bash("gh pr create --title x --body-file /nope/nothing.md", TMP)],
    ["普通 commit 无待办框，放行", bash('git commit -m "[cc] fix: 修一个 off-by-one"')],
    ["正文里出现减号但不是待办框，放行", bash('git commit -m "[cc] docs: a - b [ok]"')],
    // ↓ 这三条是「检查器把自己数进扫描面」的负控：讨论**本条规则**的正文必然引用那个记号，
    //   裸匹配会让每一份解释本闸的 PR body 都被本闸拦下（本批首稿实测命中）。
    ["散文里反引号引用该记号，放行（否则解释本规则的 PR 永远发不出去）",
      bash('gh pr create --title x --body "本闸拦的是只读载体里的 `- [ ]`，`- [x]` 放行"')],
    ["中文句子中间提到该记号，放行", bash('git commit -m "[cc] feat(gates): 拦未勾的 - [ ] 记号"')],
    ["--body-file 正文里只是引用该记号，放行",
      bash(`gh pr create --title x --body-file ${path.join(TMP, "pr-body-prose.md")}`, TMP)],
  ];
  fs.writeFileSync(path.join(TMP, "pr-body-prose.md"),
    "## 改了什么\n新闸拦的是只读载体里的 `- [ ]` 记号（`- [x]` 放行）。\n", "utf8");
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code} ${gate(p).err.slice(0, 80)}`);
}

console.log("\n──── G6 · 心跳 prompt 缺 [dao-heartbeat] 签名（stop:true 豁免）────");
{
  // 正控语料**全部取自真实历史形态**（~/.claude/projects/**/*.jsonl 全量普查，2026-08-02，
  // 993 次 ScheduleWakeup tool_use）。这不是形式主义：dispatch-clauses 对抗验证官节明写
  // 「近似手段的验证语料禁只来自本轮发现的形态」——自造语料只能证明「我想到的那几种被拦住了」。
  const positives = [
    ["最常见的真实形态（占语料首位）", wake({ delaySeconds: 1500, prompt: "高性能自主窗心跳。第一动作：回看上一轮是否真有面向用户的最终文本发出……" })],
    ["带方括号但不是签名（真实形态，易被误以为已签）", wake({ delaySeconds: 900, prompt: "【8h 高性能自主窗 · 心跳】第一动作：回看上一轮……" })],
    ["签名不在开头 ⇒ 不算签名（rhythm 那边也认不出）", wake({ delaySeconds: 900, prompt: "对账：① 两路在途 [dao-heartbeat]" })],
    ["大小写不符 ⇒ 不算（两边判据都大小写敏感）", wake({ delaySeconds: 900, prompt: "[DAO-HEARTBEAT] 心跳" })],
    ["空 prompt 且无 stop ⇒ 无从签名也无从对账", wake({ delaySeconds: 900, prompt: "" })],
    ["既无 prompt 也无 stop", wake({ delaySeconds: 900 })],
    ["stop 是字符串 'true' 不算豁免（免得成为 agent 够得着的旁路）", wake({ stop: "true", prompt: "心跳" })],
    ["stop:false 显式继续，仍要签名", wake({ stop: false, delaySeconds: 900, prompt: "心跳" })],
  ];
  for (const [name, p] of positives) {
    const r = gate(p);
    check(`正控：${name} → exit 2`, r.code === 2, `code=${r.code} ${r.err.slice(0, 80)}`);
  }
  const errText = gate(CANARY["G6-heartbeat-signature"]).err;
  check("正控：stderr 教得出**可直接照抄**的格式（含前缀本身 + 一个完整示例）",
    /\[dao-heartbeat\]/.test(errText) && /例如/.test(errText), errText.slice(0, 200));
  check("正控：stderr 说明它为什么不是装饰（指向 dao-rhythm 与留守四句的投递）",
    /dao-rhythm/.test(errText) && /dao-longwindow/.test(errText), errText.slice(0, 300));
  check("正控：stderr 点明 stop:true 是收窗的正路、不是绕签名的后门",
    /stop:true/.test(errText) && /别拿它绕开签名/.test(errText), errText.slice(0, 400));
  check("逃生阀：DAO_WAKEUP_UNSIGNED_OK=1 → 放行",
    gate(CANARY["G6-heartbeat-signature"], { env: { DAO_WAKEUP_UNSIGNED_OK: "1" } }).code === 0);
  check("逃生阀只认 '1'，不认 'true'",
    gate(CANARY["G6-heartbeat-signature"], { env: { DAO_WAKEUP_UNSIGNED_OK: "true" } }).code === 2);

  const negatives = [
    ["签名开头 → 放行", wake({ delaySeconds: 1500, prompt: "[dao-heartbeat] 高性能目标窗心跳。对账：①……" })],
    ["签名前有空白（两边都先 trim）→ 放行", wake({ delaySeconds: 900, prompt: "  \n[dao-heartbeat] 心跳" })],
    ["签名后紧跟内容无空格 → 放行（判据只管前缀）", wake({ delaySeconds: 900, prompt: "[dao-heartbeat]对账" })],
    ["只有签名没有正文 → 放行（内容够不够是人的判断，不是闸的）", wake({ prompt: "[dao-heartbeat]" })],
    ["stop:true 收窗 → 放行", wake({ stop: true })],
    ["stop:true 且带 prompt → 放行（仍是收窗调用）", wake({ stop: true, prompt: "收窗" })],
    ["别的工具带同名 prompt 参数 → 放行（本闸只认 ScheduleWakeup）",
      { tool_name: "Task", tool_input: { prompt: "高性能目标窗心跳" } }],
    ["工具名含 ScheduleWakeup 子串但不相等 → 放行（早退用全等，不用正则）",
      { tool_name: "mcp__x__ScheduleWakeupLater", tool_input: { prompt: "心跳" } }],
    ["Bash 里出现 [dao-heartbeat] 字样 → 放行（不是这道闸的事）",
      bash('echo "[dao-heartbeat] 心跳"')],
  ];
  for (const [name, p] of negatives) check(`负控：${name}`, gate(p).code === 0, `code=${gate(p).code} ${gate(p).err.slice(0, 80)}`);
}

console.log("\n──── 乙类 · dao-tool-nudge 直推主干分支（提醒不阻断，两态）────");
{
  const positives = [
    ["git push origin main", "git push origin main"],
    ["git push origin master", "git push origin master"],
    ["git push -u origin main", "git push -u origin main"],
    ["git push origin HEAD:main", "git push origin HEAD:main"],
    ["git push --force origin main", "git push --force origin main"],
    ["在 && 链后一段", "npm test && git push origin main"],
  ];
  for (const [name, c] of positives) {
    const ctx = nudge(c);
    check(`正控：${name} → 注入 PR-first 提醒`,
      /dao PR-first/.test(ctx) && /dao-pr-merge\.ps1/.test(ctx), JSON.stringify(ctx.slice(0, 80)));
  }
  check("正控：提醒里说明它是默认节律不是禁令（免得被读成硬闸）",
    /非禁令|默认节律/.test(nudge("git push origin main")));

  const negatives = [
    ["推特性分支不该提醒", "git push origin feat/x"],
    ["裸 git push 刻意不认（目标分支看不见）", "git push"],
    ["git push -u origin feature 不该提醒", "git push -u origin feature/abc"],
    ["删远程分支不是直推，不该提醒", "git push origin --delete main"],
    ["git pull 不该提醒", "git pull origin main"],
    ["字面量里的命令不该提醒", 'echo "git push origin main"'],
    ["分支名里含 main 但不是 main，不该提醒", "git push origin domain-fix"],
  ];
  for (const [name, c] of negatives) {
    check(`负控：${name}`, !/dao PR-first/.test(nudge(c)), JSON.stringify(nudge(c).slice(0, 80)));
  }
  check("乙类只提醒不阻断：nudge hook 恒 exit 0",
    spawnSync(process.execPath, [NUDGE], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push origin main" } }), encoding: "utf8" }).status === 0);
}

console.log("\n──── G7 · shell 里跑搜索/读文件（正负控全部取自真语料）────");
{
  // ⚠ 本节**每一条命令都是从 `~/.claude/projects/**/*.jsonl` 里逐字抄出来的真实调用**，
  //   一条都不是我构造的。理由是 dispatch-clauses 对抗验证官节点名的那条：
  //   「近似手段的验证语料禁只来自本轮发现的形态」—— 自造语料只能证明「我想到的那些能拦」，
  //   证不了「真实世界长什么样」。普查规模：32721 条命令 / 26402 条唯一命令。
  const positives = [
    ["sed 读文件片段（带 cd && 前缀，真语料最常见形态）",
      "cd /d/frank/mousse-cli && sed -n 130,200p crates/mousse-core/src/prompt_store/mod.rs", /Read 的/],
    ["cat 读文件", "cat src-ui/package.json", /Read/],
    ["grep 搜内容", 'grep -n "creative.libEmpty" src-ui/src/panels/creative/EquipmentLibraryColumn.tsx', /Grep 工具/],
    ["find 找路径", "find crates/mousse-core/src/injection -type f 2>/dev/null", /Glob 工具/],
    ["tail 读日志尾", "tail -8 _tmp/verify-all.log", /Read/],
    ["head 读文件头", "head -5 _tmp/pr-316-readback.md", /Read/],
    ["rg 搜内容", `rg -n "onmessage" src-ui/src --glob '!*.test.*'`, /Grep 工具/],
    // 这一条钉的是「`2>/dev/null` 是 **stderr** 重定向，不该被当成豁免②的 stdout 落文件」。
    // 两者只差一个字符，而放错会让绝大多数真实 grep 调用（真语料里极常带 `2>/dev/null`）整批漏掉。
    ["grep 带 2>/dev/null 仍拦（stderr 重定向 ≠ stdout 落文件）",
      'grep -rl "cdn.tailwindcss.com" "$dest/pages" 2>/dev/null', /Grep 工具/],
  ];
  for (const [name, c, altRe] of positives) {
    const r = gate(bash(c));
    check(`正控：${name} → exit 2`, r.code === 2, `code=${r.code}`);
    check(`正控：${name} → stderr 给得出替代写法`, altRe.test(r.err), r.err.slice(0, 160));
  }
  check("正控：PowerShell 的 Select-String 同样拦",
    gate({ tool_name: "PowerShell", tool_input: { command: "Select-String -Path D:\\frank\\mousse-cli\\package.json -Pattern version" } }).code === 2);
  // 拒绝消息必须自带「什么情况下不拦」，否则读的人会以为这几个命令被禁了 —— 而它们没有。
  check("正控：stderr 同时列出合法用法（免得被读成「这些命令被禁了」）",
    /管道过滤/.test(gate(bash("cat a.md")).err) && /段首/.test(gate(bash("cat a.md")).err));

  const negatives = [
    // ① 管道过滤 —— 这 4 条全部来自「被权限拒但 G7 刻意放行」的那 31 条
    ["管道过滤 grep（真语料）", `cd /d/frank/windsurf-dao-wt-r2 && node tests/clause-index.tests.js 2>&1 | grep -n "FAIL " | head -20`],
    ["管道过滤 grep 之二（真语料）", `git ls-files ccswitch/ | grep -iE "test|clause|ledger"`],
    ["管道过滤 + head（真语料）", `gh api repos/pleaseai/claude-code-docs/git/trees/main?recursive=1 --jq '.tree[].path' 2>&1 | grep -i hook | head -20`],
    ["until 轮询（真语料）", `until grep -q "VERIFY_ALL_EXIT=" /d/frank/mousse-cli/_tmp/adv-f1/verify-all.out 2>/dev/null; do sleep 10; done; echo "DONE"`],
    // ② stdout 落真实文件
    ["head 输出落文件（真语料）", "head -25 _tmp/branches-to-delete.txt > _tmp/batch1.txt"],
    ["tail 输出追加到文件（真语料）", "tail -n +2 _tmp/pr-384-body-readback.md >> _tmp/pr-384-body-new.md"],
    // ③ heredoc / 命令替换
    ["cat 写文件 heredoc（真语料）", "cat > _tmp/qa/issue-304/probe-buttons.js <<'JS'"],
    ["命令替换里的 head", 'echo "$(head -1 _tmp/x.txt)"'],
    // ④ 不是「读」的动作
    ["sed -i 原地改（真语料）", `sed -i -E -e 's/font-size:[[:space:]]*12px/font-size:var(--text-xs)/g' a.css`],
    ["find -exec（真语料）", `find ccswitch -name "*.md" -exec wc -l {} \\;`],
    ["tail -f 流式（真语料）", "tail -f /dev/null & sleep 1"],
    ["tail -c 字节模式（Read 无字节语义，真语料 92 例）", `tail -c 3000 "C:/Users/x/tasks/out.txt"`],
    ["head -c 字节模式（真语料 22 例）", `head -c 8000 "C:/Users/x/a.jsonl"`],
    // ⑤ 段首不是这些词
    ["git log --grep 自带参数（段首是 git）", `git log --grep="fix" -S "foo" --oneline -20`],
    ["ls 刻意不收（Glob 给不出时间戳/权限位；真语料 3266 例）", `ls -la "/d/frank/TraceyU/design/" 2>/dev/null`],
    ["wc 刻意不收（Read 数不了行数；真语料 1032 例）", `wc -l "D:/frank/windsurf-dao/ccswitch/dao.md"`],
    ["字面量里的命令不该拦", `echo "grep -n foo file"`],
    ["普通命令", "node scripts/run-tests.mjs"],
  ];
  for (const [name, c] of negatives) {
    const r = gate(bash(c));
    check(`负控：${name} → exit 0`, r.code === 0, `code=${r.code} err=${r.err.slice(0, 130)}`);
  }
  check("逃生阀：设了 DAO_SHELL_SEARCH_OK=1 即放行",
    gate(CANARY["G7-shell-search"], { env: { DAO_SHELL_SEARCH_OK: "1" } }).code === 0);
}

console.log("\n──── 段切分器升级（{seg,sep} + $() 感知）后 G3/G5 行为未变 ────");
{
  // 2026-08-02 为 G7 把 shellSegments 换成了 shellSegmentsRaw + 薄包装。**这一组钉的是
  // 「G3/G5 的判定路径一个字符没动」这句自陈** —— 没有它，那句话就只是作者的声明。
  check("G5：多行 commit 正文仍被拦（原本就是靠引号感知切分才拦得住的那一条）",
    gate(bash('git commit -m "[cc] feat: x\n- [ ] 随后补测试"')).code === 2);
  check("G5：`- [x]` 仍放行", gate(bash('git commit -m "做完了\n- [x] 跑了测试"')).code === 0);
  check("G3：npm publish 仍被拦", gate(bash("npm publish --access public")).code === 2);
  check("G3：--dry-run 仍放行", gate(bash("npm publish --dry-run")).code === 0);
  check("G3：字面量 echo \"npm publish\" 仍放行", gate(bash('echo "npm publish"')).code === 0);
  // $() 感知**新**带来的一处行为差异，照直断言出来（而不是假装没有）：
  // 以前 `echo "$(ls | head -1)"` 会在 `|` 处被切成两段（第二段段首 `head`），现在是一段。
  // 对 G3/G5 无影响（段首都是 echo），对 G7 是必须的 —— 命令替换里取一行输出不是读文件。
  check("$() 内部不再切分：命令替换里的 head 不触发 G7", gate(bash('echo "$(ls | head -1)"')).code === 0);
  check("$() 内部不再切分：G3 对命令替换里的 publish 仍是已知漏报（照直钉住，不假装拦得住）",
    gate(bash('echo "$(npm publish)"')).code === 0);
  // 管道仍然要切分（$() 感知不能把 `|` 一起吃掉），且**管道后面那一段仍进 G5 射程**。
  // 判据取「G5 真的拦下了它」而不是「exit 0」—— 放行有两种成因（走到了判定但没命中 /
  // 压根没走到），两者输出一样，只有拦下来才证明那一段被读过。
  // ⚠ 初稿这里写的是 `cat body.md | git commit -F -`，**当场被自己的闸拦下**：
  //    第一段 `cat body.md` 段首正是 G7 的靶。留着这句话当实例 —— 负控写错了会
  //    伪装成「被测对象有问题」，而这次它只是我选错了命令。
  const pipeBody = path.join(TMP, "pipe-body.md");
  fs.writeFileSync(pipeBody, "做了一半\n- [ ] 剩下的随后补\n", "utf8");
  check("管道仍然切分：`echo x | git commit -F <带未勾框的文件>` 仍被 G5 拦下",
    gate(bash(`echo hi | git commit -F "${pipeBody}"`)).code === 2);
}

console.log("\n──── mutation · 判别力（改坏一处，对应正控必须从红变绿）────");
{
  // 每条：把 hook 源码里的一段判据改成永假，断言那一闸的承重正控由 exit 2 掉成 exit 0。
  // 改的是 _tmp/ 里的副本，真文件全程不碰（下面 canary 段验证这一点）。
  const src = fs.readFileSync(HOOK, "utf8");
  const MUTANTS = [
    ["G1-windows-mcp", "/^mcp__windows[-_]?mcp?[-_]*__/i", "/^__NEVER_MATCHES__/"],
    ["G2-live-settings", '["settings.json", "settings.local.json"]', '["__no-such-file.json"]'],
    ["G3-publish", "/^(npm|pnpm|yarn|bun)\\s+publish\\b/.test(seg) ? seg :", "/^__nope\\b/.test(seg) ? seg :"],
    ["G4-screenshot-path", "if (/(^|\\/)_tmp\\/qa\\//i.test(p)) return null;", "if (true) return null;"],
    // 靶点取赋值左侧而非正则字面量本身：判据被收窄过一次（见 hook 里 UNCHECKED_TODO 的注释），
    // 把整条正则抄进测试会让「判据一改、mutation 靶点失配」变成一个静默失效面。
    ["G5-readonly-todo", "const UNCHECKED_TODO = ", "const UNCHECKED_TODO = /__NEVER_MATCH_TODO__/; const _deadPattern = "],
    ["G6-heartbeat-signature", "if (HEARTBEAT_SIG.test(p)) return null;", "if (true) return null;"],
    ["G7-shell-search", "const alt = SEARCH_TOOL_ALT[head];", "const alt = undefined;"],
  ];
  for (const [id, from, to] of MUTANTS) {
    check(`mutation 靶点在源码里唯一存在（${id}）`, src.split(from).length === 2,
      `出现 ${src.split(from).length - 1} 次`);
    const mutantPath = path.join(TMP, `mutant-${id}.js`);
    fs.writeFileSync(mutantPath, src.replace(from, to), "utf8");
    const before = gate(CANARY[id]).code;
    const after = gate(CANARY[id], { script: mutantPath }).code;
    check(`${id}：真文件拦（exit 2）而改坏后不拦（exit 0）⇒ 这条断言真的在测那段判据`,
      before === 2 && after === 0, `before=${before} after=${after}`);
    // 改坏一闸不该顺手把别的闸也弄哑（否则上面那条"变绿"可能是整个 hook 崩了）
    const otherId = id === "G1-windows-mcp" ? "G3-publish" : "G1-windows-mcp";
    check(`${id}：改坏它之后其他闸仍然拦（证明不是整个 hook 崩了）`,
      gate(CANARY[otherId], { script: mutantPath }).code === 2);
  }

  // ── 反向 mutation（2026-08-02 随 G6 加）：上面那批**全在「把门改松」这一侧**，
  //    于是「负控会不会红」这件事一次都没被验到 —— 一组永远为真的负控与一组真正管用的负控，
  //    在全绿的输出里长得一模一样（dispatch-clauses 对抗验证官节点名的第四件事）。
  //    故这里反着来一次：把 G6 的 stop 豁免改坏 ⇒ 原本放行的 `{stop:true}` 必须变成 exit 2。
  {
    const from = "if (ti.stop === true) return null;";
    const to = "if (ti.stop === \"__never_matches__\") return null;";
    check("反向 mutation 靶点在源码里唯一存在（G6 stop 豁免）", src.split(from).length === 2,
      `出现 ${src.split(from).length - 1} 次`);
    const mutantPath = path.join(TMP, "mutant-G6-stop-exemption.js");
    fs.writeFileSync(mutantPath, src.replace(from, to), "utf8");
    const stopOnly = wake({ stop: true });
    const before = gate(stopOnly).code;
    const after = gate(stopOnly, { script: mutantPath }).code;
    check("G6：真文件放行 stop:true（exit 0）而豁免被改坏后拦（exit 2）⇒ 那条负控真的在测豁免分支",
      before === 0 && after === 2, `before=${before} after=${after}`);
    check("G6：改坏豁免不影响签名判据（带签名的仍放行）",
      gate(wake({ prompt: "[dao-heartbeat] 心跳" }), { script: mutantPath }).code === 0);
  }

  // ── G7 的反向 mutation（三条豁免分支各一条）────────────────────────────────
  //    G7 的负控有 18 条，其中一多半靠三个豁免分支放行。**一组永远为真的负控与一组
  //    真正管用的负控，在全绿的输出里长得一模一样** —— 所以每个豁免分支都必须被单独
  //    改坏一次，看着对应负控从 exit 0 翻成 exit 2，才算证明「那条负控真的走到了那个分支」。
  //    这三条同时也是 dispatch-clauses 讲的第三向 mutation：判据还在、也还在算，
  //    只是**算出来的结果不再被消费** —— 前两向验「门在不在」，这一向验「门的答案有没有人听」。
  {
    const REVERSE = [
      ["管道豁免", 'if (sep === "|") continue;', 'if (sep === "__never__") continue;',
        'cd /d/x && node t.js 2>&1 | grep -n "FAIL " | head -20'],
      ["stdout 落文件豁免", "if (STDOUT_TO_FILE.test(rest)) continue;", "if (false) continue;",
        "head -25 _tmp/branches-to-delete.txt > _tmp/batch1.txt"],
      ["-c 字节模式豁免", 'if ((head === "tail" || head === "head") && /(^|\\s)-c(\\s|=|\\d)/.test(rest)) continue;',
        "if (false) continue;", 'tail -c 3000 "C:/Users/x/out.txt"'],
    ];
    for (const [name, from, to, negCmd] of REVERSE) {
      check(`反向 mutation 靶点唯一存在（G7 ${name}）`, src.split(from).length === 2,
        `出现 ${src.split(from).length - 1} 次`);
      const mp = path.join(TMP, `mutant-G7-${name}.js`);
      fs.writeFileSync(mp, src.replace(from, to), "utf8");
      const before = gate(bash(negCmd)).code;
      const after = gate(bash(negCmd), { script: mp }).code;
      check(`G7 ${name}：真文件放行（0）而豁免被改坏后拦（2）⇒ 那条负控真的在测这个分支`,
        before === 0 && after === 2, `before=${before} after=${after}`);
    }
  }

  // fail-open 路径：注入一个必抛的判定，断言"放行 + 大声喊"
  const boom = path.join(TMP, "mutant-throw.js");
  fs.writeFileSync(boom, src.replace(
    'if (!/^mcp__windows[-_]?mcp?[-_]*__/i.test(input.tool_name || "")) return null;',
    'throw new Error("injected");'
  ), "utf8");
  const r = gate(CANARY["G3-publish"], { script: boom });
  check("fail-open：守卫自身抛异常 → exit 0（放行，不砖掉会话）", r.code === 0, `code=${r.code}`);
  check("fail-open 不静默：stderr 明说「本次放行」+ 指向 --selfcheck",
    /守卫自身出错/.test(r.err) && /放行/.test(r.err) && /--selfcheck/.test(r.err), r.err.slice(0, 200));
}

console.log("\n──── canary 恒等（mutation 全程没碰过真文件）────");
{
  check("真 hook 文件 sha256 与开跑前一致", sha(HOOK) === PRISTINE_SHA);
  for (const [id, p] of Object.entries(CANARY)) {
    const after = gate(p).code;
    check(`${id}：mutation 前后真文件行为一致（before=${canaryBefore[id]} after=${after}）`,
      after === canaryBefore[id] && after === 2);
  }
}

console.log("\n──── --selfcheck（只断言形态，真实注册状态取决于用户配置）────");
{
  const r = spawnSync(process.execPath, [HOOK, "--selfcheck"], { encoding: "utf8" });
  const out = String(r.stdout || "");
  const shapeOk = /^✓ 已注册于 PreToolUse，matcher=/.test(out) ||
                  /^✗ 未注册：/.test(out) ||
                  /^✗ 读不到 live settings\.json/.test(out);
  check("首行为三种既定形态之一", shapeOk, JSON.stringify(out.split("\n")[0]));
  check("逐闸都各打印一行覆盖面结论", (out.match(/· G\d-|✓ G\d-|✗ G\d-/g) || []).length >= 7, out.slice(0, 400));
  check("末行报闸数与逃生阀清单", /共 7 道闸/.test(out) && /DAO_SETTINGS_EDIT_APPROVED/.test(out), out.slice(-200));
  check("G7 出现在逐闸覆盖面清单里", /G7-shell-search/.test(out), out.slice(0, 700));
  check("G7 的逃生阀进了末行清单", /DAO_SHELL_SEARCH_OK/.test(out), out.slice(-200));
  // G6 的注册面（matcher 加 `|ScheduleWakeup`）**属用户动作，本批不改**。故此刻 selfcheck
  // 大概率会把 G6 报成零覆盖 —— 那正是设计意图：「没接上」要在机器通道上说出来。
  // 这里刻意**不断言它一定是零覆盖**（用户随时可能注册完），只断言 G6 出现在逐闸清单里，
  // 即「这道闸的覆盖面确实被独立问过一次」。锚死任一态都会让测试随用户配置变红。
  check("G6 出现在逐闸覆盖面清单里（注册与否都得有它一行）", /G6-heartbeat-signature/.test(out), out.slice(0, 600));
  // ⚠ **这一条 2026-08-02 修过一个真 bug，成因值得留着**：它的名字写着「未注册 **/ 有闸失覆盖**」，
  // 而原判据是 `/^✗/.test(out)` —— `^` 不带 `m` 标志 ⇒ **只读首行**，也就是只看得见「注册没注册」，
  // 逐闸覆盖面那几行（`  ✗ Gn-…：matcher 覆盖不到 …`）它一行都读不到。
  // 于是「有闸失覆盖但已注册」这一态会被判成「该 exit 0」，与 selfcheck 的实际 exit 1 相撞。
  // **它一直没红，是因为在 G6 之前每道闸都被 matcher 覆盖着 —— 那一格从未被走到过。**
  // 这正是本仓反复记的那种形态：一条断言的**名字**覆盖了两种情况，**判据**只覆盖一种，
  // 而在缺一种样本的那段时间里，两者的输出逐字节相同。
  const anyFail = /(^|\n)\s*✗/.test(out);
  check("未注册 / 有闸失覆盖 → 退出码非 0（不许把「没接上」报成通过）",
    anyFail ? r.status !== 0 : r.status === 0, `code=${r.status} anyFail=${anyFail}`);
}

console.log("\n──── 兜底：无关输入一律不拦 ────");
{
  const harmless = [
    ["Read", { tool_name: "Read", tool_input: { file_path: "D:/x/a.md" } }],
    ["Grep", { tool_name: "Grep", tool_input: { pattern: "npm publish" } }],
    ["空输入", {}],
    ["普通 Bash", bash("node scripts/run-tests.mjs")],
    ["普通 Edit", edit("D:/frank/windsurf-dao/ccswitch/dao.md")],
  ];
  for (const [name, p] of harmless) check(`负控：${name} → exit 0`, gate(p).code === 0, `code=${gate(p).code}`);
  const r = spawnSync(process.execPath, [HOOK], { input: "这不是 JSON{{{", encoding: "utf8" });
  check("负控：喂垃圾输入 → exit 0（放行，不因解析失败拦人）", r.status === 0, `code=${r.status}`);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
