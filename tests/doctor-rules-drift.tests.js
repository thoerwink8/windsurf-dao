// doctor-rules-drift.tests.js — 作用域规则漂移检测回归网（issue #376 A）
//
// 治的病：~/.claude/rules/dao-scope-*.md 是 ccswitch/rules/scoped/*.md 的部署投影，
// 今天实测发现这批投影是 8-02 旧版、没人盯——doctor 从未查过这一层，只有手动跑
// `node ccswitch/scripts/dao-rules-deploy.mjs --check` 才会发现。本套测试验的是
// 抽出来给 doctor 复用的纯函数 detectRulesDrift（不落盘、不 process.exit，fs 三个
// 读操作可注入），以及 validateRule。真实语料（下方 REAL 前缀）直接读仓库里现存的
// ccswitch/rules/scoped/ 与 ~/.claude/rules/，其余场景用注入的假文件系统构造
// （dao-writing-rules 第二节：验证要用真实语料，不自造内生 mock，除非要覆盖真实
// 磁盘上凑不出的形状——这里假 fs 只补真实磁盘凑不出的漂移/孤儿/非法场景）。

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const D = require(path.join(REPO, "ccswitch", "scripts", "dao-rules-deploy.mjs"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

const VALID_RULE = [
  "---",
  "paths:",
  '  - "**/*.md"',
  "---",
  "",
  "# body",
  "",
].join("\n");

// 假文件系统：srcFiles/destFiles 是 { 文件名: 内容 } 的字典，SRC/DEST 是固定的
// 虚拟目录路径（用 path.join 生成，跟 detectRulesDrift 内部 `join(srcDir, f)` 用
// 同一套路径拼接逻辑，避免 Windows 分隔符不一致导致的假匹配失败）。
const SRC = path.join(REPO, "_fake_scoped_src_376");
const DEST = path.join(REPO, "_fake_scoped_dest_376");

function makeFakeFs({ srcFiles = null, destFiles = {}, destDirExists = true } = {}) {
  const srcNames = srcFiles === null ? null : Object.keys(srcFiles);
  const destNames = Object.keys(destFiles);
  const srcDirExists = srcFiles !== null;
  const fsExistsSync = (p) => {
    if (p === SRC) return srcDirExists;
    if (p === DEST) return destDirExists;
    if (srcNames) for (const name of srcNames) if (path.join(SRC, name) === p) return true;
    for (const name of destNames) if (path.join(DEST, name) === p) return true;
    return false;
  };
  const fsReadFileSync = (p) => {
    if (srcNames) for (const name of srcNames) if (path.join(SRC, name) === p) return srcFiles[name];
    for (const name of destNames) if (path.join(DEST, name) === p) return destFiles[name];
    throw new Error("ENOENT (fake fs)：" + p);
  };
  const fsReaddirSync = (p) => {
    if (p === SRC) return srcNames || [];
    if (p === DEST) return destNames;
    return [];
  };
  return { srcDir: SRC, destDir: DEST, fsExistsSync, fsReadFileSync, fsReaddirSync };
}

console.log("\n=== ① validateRule：合法性校验（回归，非本次改动但是 detectRulesDrift 的地基）===");
{
  check("合法规则无报错", D.validateRule("dao-scope-x.md", VALID_RULE).length === 0);
  check("缺 frontmatter 报错", D.validateRule("dao-scope-x.md", "no frontmatter here").length > 0);
  check("用 globs: 而非 paths: 报错", D.validateRule("dao-scope-x.md", "---\nglobs:\n  - \"*.md\"\n---\n").length > 0);
  check("前导 * 未加引号报错", D.validateRule("dao-scope-x.md", "---\npaths:\n  - *.md\n---\n").length > 0);
}

console.log("\n=== ② 正控：源与投影内容一致 ⇒ 无漂移无孤儿 ===");
{
  const fake = makeFakeFs({ srcFiles: { "dao-scope-a.md": VALID_RULE }, destFiles: { "dao-scope-a.md": VALID_RULE } });
  const r = D.detectRulesDrift(fake);
  check("errorCode 为 null", r.errorCode === null, JSON.stringify(r));
  check("drift 为空", r.drift.length === 0, JSON.stringify(r.drift));
  check("orphans 为空", r.orphans.length === 0, JSON.stringify(r.orphans));
  check("loaded 收了 1 份", r.loaded.length === 1);
}

console.log("\n=== ③ 红：投影内容与源不一致 → 必须报「内容不一致」===");
{
  const fake = makeFakeFs({
    srcFiles: { "dao-scope-a.md": VALID_RULE },
    destFiles: { "dao-scope-a.md": VALID_RULE.replace("# body", "# STALE 8-02 旧版正文") },
  });
  const r = D.detectRulesDrift(fake);
  check("红：drift 命中 1 条", r.drift.length === 1 && r.drift[0].name === "dao-scope-a.md", JSON.stringify(r.drift));
  check("kind 标注为「内容不一致」", r.drift[0].kind === "内容不一致");
}

console.log("\n=== ④ 红：投影缺文件 → 必须报「缺失」===");
{
  const fake = makeFakeFs({ srcFiles: { "dao-scope-a.md": VALID_RULE }, destFiles: {} });
  const r = D.detectRulesDrift(fake);
  check("红：drift 命中 1 条，kind=缺失", r.drift.length === 1 && r.drift[0].kind === "缺失", JSON.stringify(r.drift));
}

console.log("\n=== ⑤ 正控：CRLF/LF 行尾差异不算漂移（比对本就按规范化行尾）===");
{
  const fake = makeFakeFs({
    srcFiles: { "dao-scope-a.md": VALID_RULE },
    destFiles: { "dao-scope-a.md": VALID_RULE.replace(/\n/g, "\r\n") },
  });
  const r = D.detectRulesDrift(fake);
  check("同内容仅行尾不同 ⇒ 不判漂移", r.drift.length === 0, JSON.stringify(r.drift));
}

console.log("\n=== ⑥ 红：孤儿投影（源已删、投影还在）===");
{
  const fake = makeFakeFs({
    srcFiles: { "dao-scope-a.md": VALID_RULE },
    destFiles: { "dao-scope-a.md": VALID_RULE, "dao-scope-orphan.md": VALID_RULE },
  });
  const r = D.detectRulesDrift(fake);
  check("红：orphans 命中 dao-scope-orphan.md", r.orphans.includes("dao-scope-orphan.md"), JSON.stringify(r.orphans));
  check("非 dao-scope- 前缀的投影文件不算孤儿（不归本脚本管辖）", (() => {
    const fake2 = makeFakeFs({
      srcFiles: { "dao-scope-a.md": VALID_RULE },
      destFiles: { "dao-scope-a.md": VALID_RULE, "some-other-file.md": "x" },
    });
    return D.detectRulesDrift(fake2).orphans.length === 0;
  })());
}

console.log("\n=== ⑦ errorCode 2：源目录不存在 / 源目录空 ===");
{
  const missingDir = D.detectRulesDrift({ srcDir: SRC, destDir: DEST, fsExistsSync: () => false, fsReadFileSync: () => { throw new Error("不该被调用"); }, fsReaddirSync: () => [] });
  check("源目录不存在 ⇒ errorCode=2", missingDir.errorCode === 2, JSON.stringify(missingDir));

  const emptyDir = makeFakeFs({ srcFiles: {} });
  const r = D.detectRulesDrift(emptyDir);
  check("源目录存在但一个 .md 都没有 ⇒ errorCode=2（零样本闸：不是「无漂移」）", r.errorCode === 2, JSON.stringify(r));
}

console.log("\n=== ⑧ errorCode 3：文件名前缀不对 / 规则本身不合法 ===");
{
  const badName = makeFakeFs({ srcFiles: { "not-prefixed.md": VALID_RULE } });
  const r1 = D.detectRulesDrift(badName);
  check("文件名不带 dao-scope- 前缀 ⇒ errorCode=3", r1.errorCode === 3, JSON.stringify(r1));

  const badContent = makeFakeFs({ srcFiles: { "dao-scope-bad.md": "no frontmatter" } });
  const r2 = D.detectRulesDrift(badContent);
  check("规则内容不合法 ⇒ errorCode=3", r2.errorCode === 3, JSON.stringify(r2));
  check("invalid 数组记录了具体文件与原因", r2.invalid.length === 1 && r2.invalid[0].name === "dao-scope-bad.md", JSON.stringify(r2.invalid));
}

console.log("\n=== ⑨ 真实语料：本仓当前 ccswitch/rules/scoped/ ↔ ~/.claude/rules/ ===");
{
  const r = D.detectRulesDrift();
  check("真实源目录能正常读到（errorCode 为 null）", r.errorCode === null, JSON.stringify({ errorCode: r.errorCode, errorMessage: r.errorMessage }));
  check("真实源目录下确实有作用域规则（零样本闸：不是「查了 0 条」）", r.loaded.length > 0, `实际 ${r.loaded.length}`);
}

console.log("\n=== ⑩ mutation（先破再验）：弄坏内容比较判据，真实漂移必须能被真实检测出来 ===");
{
  const SRC_PATH = path.join(REPO, "ccswitch", "scripts", "dao-rules-deploy.mjs");
  const SRC_TEXT = fs.readFileSync(SRC_PATH, "utf8");
  const ANCHOR = "if (cur !== null && norm(cur) === norm(text)) continue;";
  if (!SRC_TEXT.includes(ANCHOR)) {
    check("mutation 锚点在源文件里找得到", false, `锚点串没命中：${ANCHOR}（detectRulesDrift 实现已变化，需要更新本测试的锚点）`);
  } else {
    // 变异体必须落在源文件同目录（ccswitch/scripts/），本文件内部用 import.meta.url
    // 算 SRC_DIR/DEST_DIR 默认值——虽然本测试全程显式传参不会用到默认值，但放同目录
    // 更贴近「只改判据这一行，其余环境不变」的变异体定义，且与 hooks-drift 那套
    // mutation 测试的处理方式一致（避免相对导入路径解析到错误目录的同类问题）。
    const mutantPath = path.join(REPO, "ccswitch", "scripts", `dao-rules-deploy.MUTANT-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
    try {
      const mutated = SRC_TEXT.replace(ANCHOR, "if (true) continue; // MUTATED: 恒判内容一致");
      fs.writeFileSync(mutantPath, mutated, "utf8");
      const M = require(mutantPath);

      const fakeDiff = makeFakeFs({
        srcFiles: { "dao-scope-a.md": VALID_RULE },
        destFiles: { "dao-scope-a.md": VALID_RULE.replace("# body", "# 真的不一样") },
      });

      const mutantResult = M.detectRulesDrift(fakeDiff);
      check("变异体仍存活（不是把靶弄死，抛错/errorCode 非空都算靶死）",
        mutantResult && mutantResult.errorCode === null && Array.isArray(mutantResult.drift), JSON.stringify(mutantResult));
      check("mutation：内容比较恒真 ⇒ 真实存在的漂移被吞掉（drift=0，此前会漏报，对应今天发现的「旧版没人盯」那类失效）",
        mutantResult.drift.length === 0, JSON.stringify(mutantResult.drift));

      const realResult = D.detectRulesDrift(fakeDiff);
      check("正控：真实实现同输入下必须报出漂移（内容确实不同）",
        realResult.drift.length === 1, JSON.stringify(realResult.drift));
    } finally {
      fs.rmSync(mutantPath, { force: true });
    }
  }
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
