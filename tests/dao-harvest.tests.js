// dao-harvest workflow · 编排契约自证（args 校验 + 源集 + 分批不截断 + prompt 硬要求）
//
// 跑法：node tests/dao-harvest.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 为什么这是测试而不是 _tmp 里的一次性干跑脚本 ─────────────────────────────
// 本仓自己实测的判据是「形态 vs 判断」：要求在无标记时刻发起自由裁量动作的东西会被漏
// （携带率 9-24%），跟着某个必经动作走的不会（100%）。一个躺在 `_tmp/` 里的干跑器要靠
// 有人**想起来**跑 —— 那就是判断类。挪进 `tests/` 后由 `scripts/run-tests.mjs` 扫目录
// 自动纳入，每次跑测试都过一遍，才是形态类。同一把尺子也要量自己的交付物。
//
// ── 验的是哪一层 ────────────────────────────────────────────────────────────
// workflow 脚本在真实 harness 里靠注入全局（args / phase / agent / pipeline / log）执行，
// 光做语法核验证明不了 args 契约与编排数据流。这里 stub 掉 `agent`（返回罐头结果）把整条
// 编排跑一遍，验到的是：**必填校验 / 未知参数报错 / 缺省源集 / 零候选跳过核验 /
// 超 CHUNK 分批且逐条可追不丢失 / prompt 真带上了该带的硬要求 / slug 推导与 args 覆盖**。
//
// **验不到的**（写清楚，别把干跑全绿读成「这个 workflow 好用」）：真实模型行为——prompt
// 的有效性、schema 是否被模型遵守、`pipeline` 在真 harness 下的并发度（本文件的 stub
// pipeline 是串行实现，只验数据流不验并发）。以及最重要的一条：收割出来的候选质量。

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const SRC = path.join(REPO, "ccswitch", "workflows", "dao-harvest.js");

// `export const meta` 是 ESM 语法，用 new Function 包一层时要先剥掉 export 关键字。
// 只剥这一处、且用行首锚定，不做全局改写——避免把 prompt 文案里可能出现的同名字样也改掉。
const raw = fs.readFileSync(SRC, "utf8").replace(/^export const meta =/m, "const meta =");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

function makeStubs(candidateCount) {
  const calls = { phases: [], agents: [], logs: [] };
  const phase = (t) => calls.phases.push(t);
  const log = (m) => calls.logs.push(m);
  const agent = async (prompt, opts) => {
    calls.agents.push({ label: opts.label, phase: opts.phase, model: opts.model, prompt });
    if (opts.phase === "收割") {
      return {
        summary: "stub summary",
        source_health: {
          source: opts.label, yield: candidateCount ? "富矿" : "零",
          scanned: "stub", note: "stub",
        },
        candidates: Array.from({ length: candidateCount }, (_, i) => ({
          practice: "p" + i, evidence: "e" + i, cross_project: true,
          is_form: i % 2 === 0, trigger: i % 2 === 0 ? "模板首行" : "无",
          clause_text: "c" + i, layer: "clause-common",
          dedup_checked: "d" + i, confidence: "high",
        })),
      };
    }
    return {
      overall: "stub verdict " + opts.label,
      verdicts: [{
        practice: "p0", is_new: true, criteria_hold: true,
        layer_agreed: "clause-common", pass: true, reason: "r",
      }],
    };
  };
  // stub pipeline：串行跑 producer→consumer。真 harness 可能并行，本文件不验并发度。
  const pipeline = async (items, producer, consumer) => {
    const out = [];
    for (const it of items) out.push(await consumer(await producer(it), it));
    return out;
  };
  return { phase, log, agent, pipeline, calls };
}

async function run(argsObj, candidateCount = 0) {
  const s = makeStubs(candidateCount);
  const fn = new Function("args", "phase", "agent", "pipeline", "log",
    "return (async () => {" + raw + "})()");
  const ret = await fn(argsObj, s.phase, s.agent, s.pipeline, s.log);
  return { ret, calls: s.calls };
}

async function main() {
  // ══ 必填与非法参数：两个方向都要夹住 ══════════════════════════════════════
  console.log("\n[args 契约]");
  try {
    await run({});
    check("缺 repoPath 必须抛错", false, "未抛错");
  } catch (e) {
    check("缺 repoPath 必须抛错且提到 repoPath", /repoPath/.test(e.message), e.message.slice(0, 80));
  }
  try {
    await run({ repoPath: "D:/x", sources: ["bogus"] });
    check("未知 source 必须抛错", false, "未抛错");
  } catch (e) {
    check("未知 source 抛错并列出合法值",
      /bogus/.test(e.message) && /transcript/.test(e.message), e.message.slice(0, 80));
  }
  {
    // 负控：合法参数不该抛错（只证「能拦」不算完成，还要证「不误拦」）
    const { calls } = await run(JSON.stringify({ repoPath: "D:/x", sources: ["workboard"] }), 0);
    check("负控：args 以 JSON 字符串到达也能解析且只跑指定源",
      calls.agents.length === 1 && calls.agents[0].label === "harvest:workboard",
      JSON.stringify(calls.agents.map((a) => a.label)));
  }
  {
    const { calls } = await run({ repoPath: "D:/x" }, 0);
    const labels = calls.agents.map((a) => a.label);
    check("sources 缺省 = 四源全跑", labels.length === 4, labels.join(","));
  }

  // ══ 零候选路径：零收割是合格交付，不能崩也不能派核验官 ═════════════════════
  console.log("\n[零候选]");
  {
    const { calls, ret } = await run({ repoPath: "D:/x", sources: ["transcript"] }, 0);
    check("零候选不派核验官", calls.agents.filter((a) => a.phase === "核验").length === 0);
    check("零候选打了可见日志", calls.logs.some((l) => /零候选/.test(l)));
    check("零候选仍返回该路结果（verdict=null 而非整路丢弃）",
      ret.length === 1 && ret[0].verdict === null);
  }

  // ══ 分批核验：承重字段不得静默截断（已知误裁来源）═══════════════════════════
  console.log("\n[分批不截断]");
  {
    const N = 13; // > CHUNK(6)，逼出分批路径
    const { calls } = await run({ repoPath: "D:/x", sources: ["transcript"] }, N);
    const v = calls.agents.filter((a) => a.phase === "核验");
    check("13 条候选分 3 批", v.length === 3, "实际 " + v.length);
    const allPrompts = v.map((a) => a.prompt).join("\n");
    const missing = Array.from({ length: N }, (_, i) => "p" + i)
      .filter((p) => !new RegExp('"practice": "' + p + '"').test(allPrompts));
    check("13 条逐条都递交到了核验官（零丢失）", missing.length === 0, "丢:" + missing.join(","));
    check("每批 prompt 标明「第 N/共 M 批」", v.every((a) => /第 \d\/3 批/.test(a.prompt)));
  }
  {
    // 负控：候选数 ≤ CHUNK 时不该分批，也不该出现「第 N/共 M 批」噪音
    const { calls } = await run({ repoPath: "D:/x", sources: ["transcript"] }, 3);
    const v = calls.agents.filter((a) => a.phase === "核验");
    check("负控：3 条候选单批核验且无分批字样",
      v.length === 1 && !/第 \d\/\d 批/.test(v[0].prompt));
  }

  // ══ prompt 硬要求：条款落地要靠这些字样真的在 prompt 里 ════════════════════
  console.log("\n[prompt 承载的硬要求]");
  {
    const { calls } = await run({ repoPath: "D:/frank/mousse-cli", sources: ["transcript"] }, 0);
    const p = calls.agents[0].prompt;
    const musts = [
      ["三判据 cross_project", "cross_project"],
      ["三判据 is_form", "is_form"],
      ["去重字段 dedup_checked", "dedup_checked"],
      ["条款元字段 [n=", "[n="],
      ["条款元字段 触发:", "触发:"],
      ["无触发标记", "仅判据·无触发"],
      ["slug 推导进了取数路径", "D--frank-mousse-cli"],
      ["实测取数校正（omit 陷阱）", "Omitted long matching line"],
      ["禁笃定措辞", "禁笃定措辞"],
      ["零收割是合格交付", "零收割是合格交付"],
      ["subagent 身份铁律", "禁止调用 AskUserQuestion"],
      ["只读红线", "不写不改任何文件"],
    ];
    for (const [name, needle] of musts) check("收割 prompt 含" + name, p.includes(needle), needle);
  }
  {
    const { calls } = await run({ repoPath: "D:/x", sources: ["transcript"] }, 2);
    const v = calls.agents.find((a) => a.phase === "核验");
    for (const needle of ["独立判重", "至少两个不同的关键词", "merge-base", "最常被高报"]) {
      check("核验 prompt 含「" + needle + "」", v.prompt.includes(needle));
    }
  }

  // ══ 路径推导与覆盖：推导是近似规则，覆盖必须真的生效 ═══════════════════════
  console.log("\n[路径推导 / args 覆盖]");
  {
    const a = (await run({ repoPath: "D:/frank/mousse-cli", sources: ["transcript"] }, 0)).calls.agents[0].prompt;
    check("slug 推导：D:/frank/mousse-cli → D--frank-mousse-cli",
      a.includes("~/.claude/projects/D--frank-mousse-cli"));
    const b = (await run({ repoPath: "D:/x", sources: ["transcript"], sessionLogDir: "/custom/dir" }, 0)).calls.agents[0].prompt;
    check("sessionLogDir 覆盖生效且推导值不再出现",
      b.includes("/custom/dir") && !b.includes("projects/D-x"));
    const c = (await run({ repoPath: "D:/x", sources: ["workboard"], workboardFile: "docs/BOARD.md" }, 0)).calls.agents[0].prompt;
    check("workboardFile 覆盖生效", c.includes("docs/BOARD.md") && !c.includes("docs/ops/WORKBOARD.md"));
    const d = (await run({ repoPath: "D:/x", sources: ["transcript"], extraSignals: ["我私自"] }, 0)).calls.agents[0].prompt;
    check("extraSignals 追加进信号词表", d.includes("我私自"));
  }

  // ══ 返回值与汇总 ═════════════════════════════════════════════════════════
  console.log("\n[返回值 / 汇总日志]");
  {
    const { ret, calls } = await run({ repoPath: "D:/x", sources: ["workboard", "intent-log"] }, 2);
    check("返回两路结果", Array.isArray(ret) && ret.length === 2);
    check("每路含 source/harvest/verdict", ret.every((r) => r.source && r.harvest && r.verdict));
    check("打了「核验通过 N/M」汇总", calls.logs.some((l) => /核验通过 \d+\/\d+/.test(l)));
    check("打了编排侧下一步指引", calls.logs.some((l) => /下一步\(编排侧\)/.test(l)));
    check("phase 标记两段齐全", calls.phases.includes("收割"));
  }

  // ══ meta 字段（whenToUse 是用户/帅唯一的选型依据，缺了等于没上货架）════════
  console.log("\n[meta]");
  {
    check("meta.name 与文件名一致", /name:\s*'dao-harvest'/.test(raw));
    check("meta.whenToUse 声明 repoPath 必填", /whenToUse[\s\S]{0,400}repoPath.*必填/.test(raw));
    check("meta.phases 两段", (raw.match(/\{ title: '/g) || []).length === 2);
    // 2026-07-27 首轮实测：本 workflow 与量化那一路（pr-history-postmortem）的候选
    // **重合度为 0**，两类模式在对方的取数对象里结构上不可见。不写明分工的话，下一个人
    // 跑完看到 is_form 占比极低会误判成「收割没用」——故把这层交代钉成断言，防它在
    // 将来的措辞压缩里被当成啰嗦话删掉（本仓已有条款正文压缩丢细节的实证）。
    check("meta 声明了「只覆盖单次叙事半边」并点名互补 workflow",
      /pr-history-postmortem/.test(raw) && /重合度.*0|重合度为 0/.test(raw));
    check("收割 prompt 禁自造量化论断（那是另一路的活）",
      /禁自造量化论断/.test(raw));
  }

  console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.log("  FAIL  测试自身异常 → " + (e && e.stack ? e.stack : e));
  console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail + 1} ===`);
  process.exit(1);
});
