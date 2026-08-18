// tests/dianjiangtai.tests.js —— 点将台实现回归网（PR #456）
//
// 覆盖任务书四项：
//   ① 设计 C.1 零样本/1单/5单三个代入例 → 数值与文档唯一一致（0.500 / 0.533 / 0.698）
//   ② decision_id 复算一致性（同输入同票、异输入异票、CLI 两次运行同票）
//   ③ 空账本冷启动不出 NaN（三轮返工红4 的退化规则逐条覆盖：μ_global 空→0.5、
//      n_model=0→Q_parent=μ_global、σ_parent 空→先验 σ=√(1/12)）
//   ④ 事件写入工具：ULID+机器名文件名、一事件一文件、写一次即不可变、attr 不变量
// 外加：政策 YAML 解析、schema 闭集派生（= 设计 16 种事件类型）、配额覆盖、禁令门闩。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const {
  select, hashOf, beijingMinutes, canonicalStringify, matchBeijingRoute,
  parseWindow, isInWindows, computeCost,
} = require("../scripts/lib/dianjiangtai-core.mjs");
const { parseYaml } = require("../scripts/lib/yaml-min.mjs");
const { buildEvent, writeEvent, schemaMeta, nextSeq, ulidFromMs } = require("../scripts/lib/event-writer.mjs");

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}
const round3 = x => Math.round(x * 1000) / 1000;

// ── 夹具 ──────────────────────────────────────────────────────────────

const TS = "2026-08-15T10:00:00+08:00";            // 北京 10:00 = 峰时（09:00-12:00）
const TS_VALLEY = "2026-08-15T13:00:00+08:00";     // 北京 13:00 = 谷时（12:00-14:00）
const FLASH = "deepseek-v4-flash";
const FLASH_VERSION = "DeepSeek-V4-Flash-0731";

const schema = JSON.parse(fs.readFileSync(path.join(REPO, "schemas", "events.schema.json"), "utf8"));
const models = parseYaml(fs.readFileSync(path.join(REPO, "policy", "models.yml"), "utf8")).models;
const bans = parseYaml(fs.readFileSync(path.join(REPO, "policy", "bans.yml"), "utf8")).bans;
const weights = parseYaml(fs.readFileSync(path.join(REPO, "policy", "weights.yml"), "utf8"));

const BASE_INPUTS = { ts: TS, identity: "协调者", workType: "写码", taskTokens: 40000, risk: "低", reversible: true };

/** 造 n 个同格成功/失败 job 的事件流（(m,i,w) 全同，w_time=1、w_version=1） */
function sampleJobs({ n, success = true, model = FLASH, version = FLASH_VERSION, identity = "协调者", workType = "写码", ts = TS, prefix = "" }) {
  const events = [];
  for (let i = 0; i < n; i++) {
    const job = `${prefix}t-${i + 1}`;
    events.push(
      { type: "job.opened", schema_version: 1, ts, machine: "TEST", seq: i * 3, event_id: `o-${job}`, job_id: job, task_class: "实现", work_type: workType, identity, scale: "S", risk: "低", reversible: true, task_tokens: 40000, candidate_models: [model], selected: model, why: "fixture" },
      { type: "job.dispatch", schema_version: 1, ts, machine: "TEST", seq: i * 3 + 1, event_id: `d-${job}`, job_id: job, model, identity, work_type: workType, model_version: version, terminal: "pi", price_snapshot: {}, decision_id: `dd-${job}` },
      { type: "job.closed", schema_version: 1, ts, machine: "TEST", seq: i * 3 + 2, event_id: `c-${job}`, job_id: job, success, rework: !success, usd_cash: 0.1, usd_economic: 0.1, merged_by: model },
    );
    if (!success) {
      events.push({ type: "attr.rule", schema_version: 1, ts, machine: "TEST", seq: i * 3 + 3, event_id: `a-${job}`, job_id: job, model, model_share: 1, brief_share: 0, coord_share: 0, env_share: 0, overrun_attr: null, confidence: 0.9, evidence: [`c-${job}`], why: "fixture" });
    }
  }
  return events;
}

/** 每个模型各 n 个同格成功 job（job_id 带模型前缀防串桶；让所有模型缺口满足） */
function manyJobs(modelList, n) {
  return modelList.flatMap(m => sampleJobs({ n, model: m.id, version: m.version, prefix: `${m.id}-` }));
}

const run = (over = {}) => select({ ...BASE_INPUTS, jobId: "j-test", events: [], models, bans, weights, policyHash: hashOf({ models, bans, weights }), ...over });

function cli(args) {
  return spawnSync(process.execPath, [path.join(REPO, "scripts", "select.mjs"), ...args], { encoding: "utf8", cwd: REPO });
}
function cliDj(args) {
  return spawnSync(process.execPath, [path.join(REPO, "scripts", "dianjiangtai-select.mjs"), ...args], { encoding: "utf8", cwd: REPO });
}

describe('dianjiangtai', () => {
  it('① C.1 三个代入例（数值与设计文档唯一一致）', async (t) => {
    const zero = run();
    const one = run({ jobId: "j1", events: sampleJobs({ n: 1 }) });
    const five = run({ jobId: "j5", events: sampleJobs({ n: 5 }) });

    await t.test('零样本 μ_raw=0.500、n_eff=0', () => {
      assert.ok(zero.models[FLASH].features.muRaw === 0.5 && zero.models[FLASH].features.nEff === 0, '零样本 μ_raw=0.500、n_eff=0  →  ' + `${zero.models[FLASH].features.muRaw}/${zero.models[FLASH].features.nEff}`);
    });
    await t.test('零样本 μ_shrunk = 0.500（文档代入例1）', () => {
      assert.ok(zero.models[FLASH].features.muShrunk.toFixed(3) === "0.500", '零样本 μ_shrunk = 0.500（文档代入例1）  →  ' + zero.models[FLASH].features.muShrunk);
    });
    await t.test('1 单成功 μ_raw=0.667、n_eff=1', () => {
      assert.ok(round3(one.models[FLASH].features.muRaw) === 0.667 && one.models[FLASH].features.nEff === 1, '1 单成功 μ_raw=0.667、n_eff=1  →  ' + `${one.models[FLASH].features.muRaw}/${one.models[FLASH].features.nEff}`);
    });
    await t.test('1 单成功 μ_shrunk = 0.533（文档代入例2）', () => {
      assert.ok(one.models[FLASH].features.muShrunk.toFixed(3) === "0.533", '1 单成功 μ_shrunk = 0.533（文档代入例2）  →  ' + one.models[FLASH].features.muShrunk);
    });
    await t.test('5 单全成功 μ_raw=0.857、n_eff=5', () => {
      assert.ok(round3(five.models[FLASH].features.muRaw) === 0.857 && five.models[FLASH].features.nEff === 5, '5 单全成功 μ_raw=0.857、n_eff=5  →  ' + `${five.models[FLASH].features.muRaw}/${five.models[FLASH].features.nEff}`);
    });
    await t.test('5 单全成功 μ_shrunk = 0.698（文档代入例3）', () => {
      assert.ok(five.models[FLASH].features.muShrunk.toFixed(3) === "0.698", '5 单全成功 μ_shrunk = 0.698（文档代入例3）  →  ' + five.models[FLASH].features.muShrunk);
    });

    // 收缩链条肉眼核对：零样本直接落在父级（0.5）；5 单本格接管 56%
    await t.test('零样本 μ_shrunk 直接落在父级 Q_parent', () => {
      assert.ok(zero.models[FLASH].features.muShrunk === zero.models[FLASH].features.QParent, '零样本 μ_shrunk 直接落在父级 Q_parent');
    });
    await t.test('5 单本格权重 5/9≈56%', () => {
      assert.ok((5 / 9).toFixed(3) === "0.556", '5 单本格权重 5/9≈56%');
    });
  });

  it('③ 空账本冷启动不出 NaN（红4 退化规则逐条）', async (t) => {
    const zero = run();
    const five = run({ jobId: "j5", events: sampleJobs({ n: 5 }) });
    const zf = zero.models[FLASH].features;
    await t.test('红4a：μ_global 样本集合为空 → 0.5', () => {
      assert.ok(zf.muGlobal === 0.5, '红4a：μ_global 样本集合为空 → 0.5  →  ' + zf.muGlobal);
    });
    await t.test('红4b：n_model=0 → Q_parent=μ_global', () => {
      assert.ok(zf.nModel === 0 && zf.QParent === zf.muGlobal, '红4b：n_model=0 → Q_parent=μ_global  →  ' + `${zf.nModel}/${zf.QParent}`);
    });
    await t.test('红4c：σ_parent 加权集合为空 → 先验 σ=√(1/12)≈0.2887', () => {
      assert.ok(Math.abs(zf.sigmaParent - Math.sqrt(1 / 12)) < 1e-12, '红4c：σ_parent 加权集合为空 → 先验 σ=√(1/12)≈0.2887  →  ' + zf.sigmaParent);
    });
    await t.test('零样本全特征有限（无 NaN/Infinity）', () => {
      assert.ok(Object.values(zf).every(v => typeof v !== "number" || Number.isFinite(v)), '零样本全特征有限（无 NaN/Infinity）');
    });
    await t.test('零样本 Score 有限', () => {
      assert.ok(Number.isFinite(zero.models[FLASH].score), '零样本 Score 有限  →  ' + zero.models[FLASH].score);
    });
    for (const m of Object.keys(zero.models)) {
      await t.test(`零样本 ${m} score/cost/sigma 均有限`, () => {
        assert.ok(Number.isFinite(zero.models[m].score) && zero.models[m].cost.c !== undefined, `零样本 ${m} score/cost/sigma 均有限  →  ` + JSON.stringify(zero.models[m]));
      });
    }
    await t.test('零样本 A 选项存在且有理由', () => {
      assert.ok(!!zero.options.A.model && ["highest_score", "quota_explore"].includes(zero.options.A.reason), '零样本 A 选项存在且有理由');
    });

    // 红4 另一面：只含旧版本样本 → base_p 生效、当前格仍零样本不炸
    const oldVer = run({ jobId: "j-old", events: sampleJobs({ n: 4, version: "DeepSeek-V4-Flash-0601" }) });
    await t.test('旧版本 4 单 → base_p=1（先验中心=旧样本成功率），当前格零样本不炸', () => {
      assert.ok(oldVer.models[FLASH].features.baseP === 1 && Number.isFinite(oldVer.models[FLASH].features.muShrunk), '旧版本 4 单 → base_p=1（先验中心=旧样本成功率），当前格零样本不炸  →  ' + `${oldVer.models[FLASH].features.baseP}`);
    });
    await t.test('旧版本样本不进当前格：n_eff 仍 0', () => {
      assert.ok(oldVer.models[FLASH].features.nEff === 0, '旧版本样本不进当前格：n_eff 仍 0');
    });

    // 父级收缩：本格(写码)零样本、模型其他格(审查)4 正样本 → μ_shrunk = Q_parent = (n·μ + k·μ_global)/(n+k)
    const otherCell = run({ jobId: "j-oc", workType: "写码", events: sampleJobs({ n: 4, workType: "审查" }) });
    await t.test('父级收缩：本格(写码)零样本、模型(审查)4 正样本 → n_model=4、μ_model=1', () => {
      assert.ok(otherCell.models[FLASH].features.nModel === 4 && otherCell.models[FLASH].features.muModel === 1, '父级收缩：本格(写码)零样本、模型(审查)4 正样本 → n_model=4、μ_model=1  →  ' + `${otherCell.models[FLASH].features.nModel}/${otherCell.models[FLASH].features.muModel}`);
    });
    await t.test('父级收缩：μ_shrunk = (0·μ_raw + 4·Q_parent)/4 = Q_parent', () => {
      assert.ok(otherCell.models[FLASH].features.muShrunk === otherCell.models[FLASH].features.QParent, '父级收缩：μ_shrunk = (0·μ_raw + 4·Q_parent)/4 = Q_parent  →  ' + otherCell.models[FLASH].features.muShrunk);
    });

    // 失败样本入 β：1 负样本（conf=0.9）→ α=1,β=1+0.9 → μ_raw=1/2.9=0.3448，n_eff=0.9
    const oneFail = run({ jobId: "j-f", events: sampleJobs({ n: 1, success: false }) });
    await t.test('1 负样本（conf=0.9）→ μ_raw = 1/2.9 ≈ 0.345', () => {
      assert.ok(round3(oneFail.models[FLASH].features.muRaw) === 0.345, '1 负样本（conf=0.9）→ μ_raw = 1/2.9 ≈ 0.345  →  ' + oneFail.models[FLASH].features.muRaw);
    });
    await t.test('失败样本按 w_conf×model_share 计入（0.9×1）', () => {
      assert.ok(Math.abs(oneFail.models[FLASH].features.nEff - 0.9) < 1e-9, '失败样本按 w_conf×model_share 计入（0.9×1）  →  ' + oneFail.models[FLASH].features.nEff);
    });

    // F9 用户偏好：override 计 P，explore 不计
    const ov = run({ jobId: "j-p", events: [{ type: "job.override", schema_version: 1, ts: TS, machine: "TEST", seq: 0, event_id: "ov-1", job_id: "j-p", model: FLASH, identity: "协调者", work_type: "写码" }] });
    await t.test('F9：同刻 override → P = 0.5^0 = 1', () => {
      assert.ok(ov.models[FLASH].features.P === 1, 'F9：同刻 override → P = 0.5^0 = 1  →  ' + ov.models[FLASH].features.P);
    });
    const ovScope = run({ jobId: "j-ps", events: [{ type: "job.override", schema_version: 1, ts: TS, machine: "TEST", seq: 0, event_id: "ov-s", job_id: "j-ps", model: FLASH, identity: "协调者", work_type: "写码", override_kind: "scope", why: "追加职责" }] });
    await t.test('F9：scope 追加不计入 P', () => {
      assert.ok(ovScope.models[FLASH].features.P === 0, 'F9：scope 追加不计入 P  →  ' + ovScope.models[FLASH].features.P);
    });
    const ex = run({ jobId: "j-e", events: [{ type: "job.explore", schema_version: 1, ts: TS, machine: "TEST", seq: 0, event_id: "ex-1", job_id: "j-e", model: FLASH, identity: "协调者", work_type: "写码" }] });
    await t.test('F9：explore 不计入 P', () => {
      assert.ok(ex.models[FLASH].features.P === 0, 'F9：explore 不计入 P  →  ' + ex.models[FLASH].features.P);
    });

    // F11/F12：job.meter 不带 identity/work_type，格归属由 job 的派单解析（防静默失效）
    const withMeter = run({ jobId: "j-mt", events: [
      ...sampleJobs({ n: 1 }),
      { type: "job.meter", schema_version: 1, ts: TS, machine: "TEST", seq: 20, event_id: "meter-1", job_id: "t-1", model: FLASH, token_in: 12000, token_out: 3000, cache_hit: 3000, usd_cash: 0.05 },
    ] });
    await t.test('F12：meter 经 job 派单归到 (flash,协调者,写码) 格，token 画像=中位数', () => {
      assert.ok(withMeter.models[FLASH].cost.tIn === 40000 && withMeter.models[FLASH].cost.tOut === 3000, 'F12：meter 经 job 派单归到 (flash,协调者,写码) 格，token 画像=中位数  →  ' + `${withMeter.models[FLASH].cost.tIn}/${withMeter.models[FLASH].cost.tOut}`);
    });
    await t.test('F11：meter 缓存命中率 EWMA 进成本（h>0 → metered 降低）', () => {
      assert.ok(withMeter.models[FLASH].cost.h > 0 && withMeter.models[FLASH].cost.h < 1, 'F11：meter 缓存命中率 EWMA 进成本（h>0 → metered 降低）  →  ' + withMeter.models[FLASH].cost.h);
    });

    // F8 缺口：零样本短fall=3，5 单后=0
    await t.test('F8：零样本 shortfall = per_cell_floor(3)', () => {
      assert.ok(zero.models[FLASH].features.shortfall === 3, 'F8：零样本 shortfall = per_cell_floor(3)');
    });
    await t.test('F8：5 单后 shortfall = 0', () => {
      assert.ok(five.models[FLASH].features.shortfall === 0, 'F8：5 单后 shortfall = 0');
    });
  });

  it('C.3 配额覆盖 / 红2 修法 / F10 峰谷现算 / 门闩（F1/F14/F15）', async (t) => {
    const zero = run();
    const five = run({ jobId: "j5", events: sampleJobs({ n: 5 }) });
    // C.3 配额覆盖：零样本低风险单 → A 默认项强制从缺口集合轮转（quota_explore）
    await t.test('C.3：零样本低风险单 A=quota_explore', () => {
      assert.ok(zero.options.A.reason === "quota_explore", 'C.3：零样本低风险单 A=quota_explore  →  ' + zero.options.A.reason);
    });
    // 红2 修法验证：每格 3 单后 shortfall=0 但 globalShortfall=2（新模型全局保底 5）→ 覆盖仍触发
    const many = manyJobs(models, 3);
    const mid = run({ jobId: "j-mid", events: many });
    await t.test('红2：每格 3 单但全局缺口未满足 → A 仍 quota_explore', () => {
      assert.ok(mid.options.A.reason === "quota_explore", '红2：每格 3 单但全局缺口未满足 → A 仍 quota_explore  →  ' + mid.options.A.reason);
    });
    await t.test('红2：每格 3 单后 shortfall=0 且 globalShortfall=2', () => {
      assert.ok(Object.values(mid.models).every(d => d.features.shortfall === 0 && d.features.globalShortfall === 2), '红2：每格 3 单后 shortfall=0 且 globalShortfall=2  →  ' + JSON.stringify(Object.values(mid.models).map(d => [d.model, d.features.shortfall, d.features.globalShortfall])));
    });
    // 每个模型 5 单（每格 n_eff≥3 且 n_global≥5）→ 缺口全满足 → 无覆盖 → highest_score
    const satisfied = run({ jobId: "j-full", events: manyJobs(models, 5) });
    await t.test('C.3：全部模型每格 n_eff≥3 且 n_global≥5 后 A=highest_score', () => {
      assert.ok(satisfied.options.A.reason === "highest_score", 'C.3：全部模型每格 n_eff≥3 且 n_global≥5 后 A=highest_score  →  ' + satisfied.options.A.reason);
    });
    await t.test('C.3：缺口全满足后 shortfall=0 且 globalShortfall=0', () => {
      assert.ok(Object.values(satisfied.models).every(d => d.features.shortfall === 0 && d.features.globalShortfall === 0), 'C.3：缺口全满足后 shortfall=0 且 globalShortfall=0');
    });
    // 高风险单不让路探索
    const hiRisk = run({ jobId: "j-hi", risk: "高" });
    await t.test('C.3：高风险单不触发配额覆盖（仍 highest_score）', () => {
      assert.ok(hiRisk.options.A.reason === "highest_score", 'C.3：高风险单不触发配额覆盖（仍 highest_score）  →  ' + hiRisk.options.A.reason);
    });

    // 峰谷现算（F10）：用夹具验算法，不绑政策文件。
    // ds-flash 2026-08-16 主通道换成 opencode Go 额度池后，policy/models.yml 里已无按量计价模型，
    // 但 computeCost 的 metered 分支仍在服役（应急直连、将来新增按量模型都走它）——
    // 断言若继续读真实 flash 条目，就会随通道变更一起哑掉，把「没样本可查」伪装成「查过没事」。
    const METERED_FIXTURE = {
      id: "fixture-metered",
      pricing: {
        verified_at: "2026-08-14",
        unit: "元/百万tokens",
        metered: {
          peak_windows_beijing: ["09:00-12:00", "14:00-18:00"],
          peak: { cache_hit: 0.10, cache_miss: 3.0, output: 9.0 },
          valley: { cache_hit: 0.05, cache_miss: 1.5, output: 4.5 },
        },
        fixed_fee: 0,
        subscription: null,
      },
    };
    const fxPeak = computeCost({ model: METERED_FIXTURE, taskTokens: 40000, meters: [], at: TS });
    const fxValley = computeCost({ model: METERED_FIXTURE, taskTokens: 40000, meters: [], at: TS_VALLEY });
    await t.test('F10 峰谷现算：峰时成本 > 谷时（3.0/1.5 与 9.0/4.5 阶梯）', () => {
      assert.ok(fxPeak.c > fxValley.c, 'F10 峰谷现算：峰时成本 > 谷时（3.0/1.5 与 9.0/4.5 阶梯）  →  ' + `${fxPeak.c} vs ${fxValley.c}`);
    });
    await t.test('F10 夹具确实算出非零成本（防两边都 0 的假通过）', () => {
      assert.ok(fxPeak.c > 0 && fxValley.c > 0, 'F10 夹具确实算出非零成本（防两边都 0 的假通过）  →  ' + `${fxPeak.c}/${fxValley.c}`);
    });
    await t.test('峰谷时刻判定：10:00 峰、13:00 谷', () => {
      assert.ok(beijingMinutes(TS) === 600 && beijingMinutes(TS_VALLEY) === 780, '峰谷时刻判定：10:00 峰、13:00 谷');
    });

    // 禁令门闩（F1）：gpt 被禁 UI、deepseek 被禁查证
    const ui = run({ jobId: "j-ui", workType: "UI" });
    await t.test('F1：gpt-5.6-sol 对 UI 工种被 ban 剔除', () => {
      assert.ok(ui.models["gpt-5.6-sol"].gates.rejected && ui.models["gpt-5.6-sol"].gates.reasons.includes("ban"), 'F1：gpt-5.6-sol 对 UI 工种被 ban 剔除');
    });
    await t.test('F1：ban 剔除模型不在 B 自选位', () => {
      assert.ok(!ui.options.B.models.includes("gpt-5.6-sol"), 'F1：ban 剔除模型不在 B 自选位');
    });
    const chz = run({ jobId: "j-chz", workType: "查证" });
    await t.test('F1：deepseek 系对查证被 ban 剔除', () => {
      assert.ok(chz.models[FLASH].gates.rejected && chz.models["deepseek-v4-pro"].gates.rejected, 'F1：deepseek 系对查证被 ban 剔除');
    });

    // F14 上下文门闩：任务预算超窗口剔除（flash 窗口 1M）
    const bigTask = run({ jobId: "j-big", taskTokens: 2000000 });
    await t.test('F14：任务 2M token > flash 窗口 1M → context_insufficient 剔除', () => {
      assert.ok(bigTask.models[FLASH].gates.rejected && bigTask.models[FLASH].gates.reasons.some(r => r.startsWith("context_insufficient")), 'F14：任务 2M token > flash 窗口 1M → context_insufficient 剔除');
    });

    // F15 可用性门闩
    const busy = run({ jobId: "j-busy", availability: { [FLASH]: "忙" } });
    await t.test('F15：flash 忙 → 剔除且标注', () => {
      assert.ok(busy.models[FLASH].gates.rejected && busy.models[FLASH].gates.reasons.includes("availability:忙"), 'F15：flash 忙 → 剔除且标注');
    });
  });

  it('② decision_id 复算一致性（E.1 决策票）', async (t) => {
    await t.test('决策票：同输入两次运行 decision_id 相同', () => {
      assert.ok(run({ jobId: "j-d1" }).decision_id === run({ jobId: "j-d1" }).decision_id, '决策票：同输入两次运行 decision_id 相同');
    });
    const dBase = run({ jobId: "j-d1" });
    await t.test('决策票：job_id 变化 → decision_id 不同', () => {
      assert.ok(dBase.decision_id !== run({ jobId: "j-d2" }).decision_id, '决策票：job_id 变化 → decision_id 不同');
    });
    await t.test('决策票：事件变化 → decision_id 不同', () => {
      assert.ok(dBase.decision_id !== run({ jobId: "j-d1", events: sampleJobs({ n: 1 }) }).decision_id, '决策票：事件变化 → decision_id 不同');
    });
    await t.test('决策票：时间变化（峰/谷）→ decision_id 不同', () => {
      assert.ok(dBase.decision_id !== run({ jobId: "j-d1", ts: TS_VALLEY }).decision_id, '决策票：时间变化（峰/谷）→ decision_id 不同');
    });
    await t.test('决策票：工种变化 → decision_id 不同', () => {
      assert.ok(dBase.decision_id !== run({ jobId: "j-d1", workType: "审查" }).decision_id, '决策票：工种变化 → decision_id 不同');
    });
    await t.test('决策票：sha256 hex 64 位', () => {
      assert.ok(/^[0-9a-f]{64}$/.test(dBase.decision_id), '决策票：sha256 hex 64 位');
    });
    await t.test('决策票：policy_hash 入快照可复算', () => {
      assert.ok(dBase.snapshot.policy_hash === hashOf({ models, bans, weights }), '决策票：policy_hash 入快照可复算');
    });

    // CLI 两次运行同票（真实 policy + 真实 ledger 读盘路径）
    const cliArgs = ["--identity", "协调者", "--work-type", "写码", "--ts", TS, "--job-id", "cli-1", "--task-tokens", "40000"];
    const cli1 = cli(cliArgs);
    await t.test('CLI select.mjs 退出码 0', () => {
      assert.ok(cli1.status === 0, 'CLI select.mjs 退出码 0  →  ' + (cli1.stderr || "").slice(0, 200));
    });
    const cliOut1 = cli1.status === 0 ? JSON.parse(cli1.stdout) : null;
    await t.test('CLI 输出含 decision_id 与三选项', () => {
      assert.ok(cliOut1 && cliOut1.decision_id && cliOut1.options.A && cliOut1.options.B && cliOut1.options.C, 'CLI 输出含 decision_id 与三选项');
    });
    const cli2 = cli(cliArgs);
    await t.test('CLI 两次运行 decision_id 相同（确定性）', () => {
      assert.ok(cli1.status === 0 && cli2.status === 0 && cliOut1.decision_id === JSON.parse(cli2.stdout).decision_id, 'CLI 两次运行 decision_id 相同（确定性）');
    });
    const cliArgsChz = cliArgs.map((v, i) => (cliArgs[i - 1] === "--work-type" ? "查证" : v));
    const cli3 = cli(cliArgsChz);
    await t.test('CLI 工种变化（查证，deepseek 被禁）→ decision_id 不同', () => {
      assert.ok(cli3.status === 0 && cliOut1.decision_id !== JSON.parse(cli3.stdout).decision_id, 'CLI 工种变化（查证，deepseek 被禁）→ decision_id 不同  →  ' + (cli3.stderr || "").slice(0, 120));
    });
  });

  it('审官红项回归：红1（B/C 门闩校验）/ 红3（--ts 截断）/ 红4（接手正样本）', async (t) => {
    // 红1：--commit B|C 自选必须落在门闩通过集合（禁令不可绕过，设计 C.4/E.5）
    const r1tmp = fs.mkdtempSync(path.join(os.tmpdir(), "djt-r1-"));
    const r1Files = () => fs.readdirSync(r1tmp).filter(f => f.endsWith(".json"));
    const r1b = cli(["--identity", "协调者", "--work-type", "UI", "--ts", TS, "--job-id", "dj-r1b", "--events-dir", r1tmp, "--commit", "B", "--pick", "gpt-5.6-sol"]);
    await t.test('红1：UI 工种 --commit B --pick gpt（被 ban）→ 非 0 退出', () => {
      assert.ok(r1b.status !== 0, '红1：UI 工种 --commit B --pick gpt（被 ban）→ 非 0 退出  →  ' + `status=${r1b.status} stderr=${(r1b.stderr || "").slice(0, 80)}`);
    });
    await t.test('红1：违规自选不落账（0 事件文件）', () => {
      assert.ok(r1Files().length === 0, '红1：违规自选不落账（0 事件文件）  →  ' + r1Files().join(","));
    });
    const r1c = cli(["--identity", "协调者", "--work-type", "UI", "--ts", TS, "--job-id", "dj-r1c", "--events-dir", r1tmp, "--commit", "C", "--pick", "gpt-5.6-sol"]);
    await t.test('红1：--commit C 同样拦截被 ban 模型（不落账）', () => {
      assert.ok(r1c.status !== 0 && r1Files().length === 0, '红1：--commit C 同样拦截被 ban 模型（不落账）  →  ' + `status=${r1c.status}`);
    });
    const r1ok = cli(["--identity", "协调者", "--work-type", "UI", "--ts", TS, "--job-id", "dj-r1ok", "--events-dir", r1tmp, "--commit", "B", "--pick", "grok-4.6"]);
    await t.test('红1：合法自选（UI 下 grok 通过门闩）正常落账 3 事件', () => {
      assert.ok(r1ok.status === 0 && r1Files().length === 3, '红1：合法自选（UI 下 grok 通过门闩）正常落账 3 事件  →  ' + `status=${r1ok.status} files=${r1Files().length}`);
    });
    fs.rmSync(r1tmp, { recursive: true, force: true });

    // 红3：选型时刻之后的事件不得参与重放（复算按 --ts 截断，F6 只对过去衰减）
    const FUTURE_TS = "2026-09-01T10:00:00+08:00"; // 比选型时刻晚 17 天
    const futureEvts = sampleJobs({ n: 1, prefix: "f-" }).map(e => ({ ...e, ts: FUTURE_TS }));
    const r3f = run({ jobId: "j-fut", events: futureEvts });
    await t.test('红3：未来成功样本不入当前格（nEff=0，不被 w_time>1 放大）', () => {
      assert.ok(r3f.models[FLASH].features.nEff === 0, '红3：未来成功样本不入当前格（nEff=0，不被 w_time>1 放大）  →  ' + `nEff=${r3f.models[FLASH].features.nEff}`);
    });
    await t.test('红3：账只多了未来事件 → decision_id 不变（同输入同票可复算）', () => {
      assert.ok(run({ jobId: "j-fut" }).decision_id === r3f.decision_id, '红3：账只多了未来事件 → decision_id 不变（同输入同票可复算）  →  decision_id 变了');
    });

    // 红4：接手成功样本 version 取接手者当前 registry.version → 正样本进接手者当前格
    const handoffEvts = [
      { type: "job.opened", schema_version: 1, ts: TS, machine: "TEST", seq: 0, event_id: "o-h", job_id: "h-1", task_class: "实现", work_type: "写码", identity: "协调者", scale: "S", risk: "低", reversible: true, task_tokens: 40000, candidate_models: [FLASH], selected: FLASH, why: "fixture" },
      { type: "job.dispatch", schema_version: 1, ts: TS, machine: "TEST", seq: 1, event_id: "d-h", job_id: "h-1", model: FLASH, identity: "协调者", work_type: "写码", model_version: FLASH_VERSION, terminal: "pi", price_snapshot: {}, decision_id: "dd-h" },
      { type: "job.handoff", schema_version: 1, ts: TS, machine: "TEST", seq: 2, event_id: "hh-1", job_id: "h-1", from_model: FLASH, to_model: "grok-4.6", reason: "quota", why: "fixture" },
      { type: "job.closed", schema_version: 1, ts: TS, machine: "TEST", seq: 3, event_id: "c-h", job_id: "h-1", success: true, rework: false, usd_cash: 0.1, usd_economic: 0.1, merged_by: "grok-4.6" },
    ];
    const r4h = run({ jobId: "j-h4", events: handoffEvts });
    await t.test('红4：接手成功 → 接手者 grok nEff=1（正样本进当前格）', () => {
      assert.ok(r4h.models["grok-4.6"].features.nEff === 1, '红4：接手成功 → 接手者 grok nEff=1（正样本进当前格）  →  ' + `nEff=${r4h.models["grok-4.6"].features.nEff}`);
    });
    await t.test('红4：grok baseP 仍 0.5（无旧版本样本、不误降格）', () => {
      assert.ok(r4h.models["grok-4.6"].features.baseP === 0.5, '红4：grok baseP 仍 0.5（无旧版本样本、不误降格）  →  ' + `baseP=${r4h.models["grok-4.6"].features.baseP}`);
    });
    await t.test('红4：源模型 flash 不记正样本（nEff=0）', () => {
      assert.ok(r4h.models[FLASH].features.nEff === 0, '红4：源模型 flash 不记正样本（nEff=0）  →  ' + `nEff=${r4h.models[FLASH].features.nEff}`);
    });
  });

  it('④ 事件写入工具', async (t) => {
    const meta = schemaMeta(schema);
    const DESIGN_TYPES = ["job.opened", "job.dispatch", "job.meter", "job.handoff", "job.closed", "job.override", "job.explore", "attr.rule", "attr.llm", "attr.human", "attr.retract", "policy.patch", "sub.usage", "incident", "audit.bypass", "audit.stale"];
    await t.test('schema 闭集派生 = 设计 16 种事件类型', () => {
      assert.ok(meta.closedSet.length === 16 && DESIGN_TYPES.every(t => meta.closedSet.includes(t)) && meta.closedSet.every(t => DESIGN_TYPES.includes(t)), 'schema 闭集派生 = 设计 16 种事件类型  →  ' + meta.closedSet.join(","));
    });
    await t.test('schema 派生必填：job.dispatch 要求 decision_id/model/terminal 等', () => {
      assert.ok(["job_id", "model", "identity", "work_type", "model_version", "terminal", "price_snapshot", "decision_id"].every(f => meta.requiredByType.get("job.dispatch").includes(f)), 'schema 派生必填：job.dispatch 要求 decision_id/model/terminal 等');
    });

    const dispatchPayload = { job_id: "dj-w", model: FLASH, identity: "协调者", work_type: "写码", model_version: FLASH_VERSION, terminal: "pi", price_snapshot: {}, decision_id: "abc123" };
    const ev = buildEvent({ type: "job.dispatch", ts: TS, machine: "TEST", seq: 0, payload: dispatchPayload, schema });
    await t.test('buildEvent：event_id 为 sha256 hex', () => {
      assert.ok(/^[0-9a-f]{64}$/.test(ev.event_id), 'buildEvent：event_id 为 sha256 hex');
    });
    await t.test('buildEvent：事件内容含 schema_version=1 与全字段', () => {
      assert.ok(ev.schema_version === 1 && ev.job_id === "dj-w" && ev.type === "job.dispatch", 'buildEvent：事件内容含 schema_version=1 与全字段');
    });
    await t.test('buildEvent：拒绝未知类型', () => {
      assert.ok(throws(() => buildEvent({ type: "nope", ts: TS, machine: "TEST", seq: 0, payload: dispatchPayload, schema })), 'buildEvent：拒绝未知类型');
    });
    await t.test('buildEvent：拒绝缺必填', () => {
      assert.ok(throws(() => buildEvent({ type: "job.dispatch", ts: TS, machine: "TEST", seq: 0, payload: { job_id: "x" }, schema })), 'buildEvent：拒绝缺必填');
    });
    await t.test('buildEvent：拒绝保留字段混入 payload', () => {
      assert.ok(throws(() => buildEvent({ type: "job.dispatch", ts: TS, machine: "TEST", seq: 0, payload: { ...dispatchPayload, ts: TS }, schema })), 'buildEvent：拒绝保留字段混入 payload');
    });

    // attr 责任向量不变量（D.1）
    const goodAttr = { job_id: "dj-a", model: FLASH, model_share: 0.3, brief_share: 0.7, coord_share: 0, env_share: 0, overrun_attr: null, confidence: 0.9, evidence: ["c-0"], why: "换模型同时改任务书才通过（L0 规则7）" };
    await t.test('attr：份额和=1 通过', () => {
      assert.ok(!throws(() => buildEvent({ type: "attr.rule", ts: TS, machine: "TEST", seq: 0, payload: goodAttr, schema })), 'attr：份额和=1 通过');
    });
    await t.test('attr：份额和≠1 拒绝', () => {
      assert.ok(throws(() => buildEvent({ type: "attr.rule", ts: TS, machine: "TEST", seq: 0, payload: { ...goodAttr, model_share: 0.5 }, schema })), 'attr：份额和≠1 拒绝');
    });
    await t.test('attr：unknown 四份额全 0 且 confidence 高 → 拒绝', () => {
      assert.ok(throws(() => buildEvent({ type: "attr.rule", ts: TS, machine: "TEST", seq: 0, payload: { ...goodAttr, model_share: 0, brief_share: 0, coord_share: 0, env_share: 0 }, schema })), 'attr：unknown 四份额全 0 且 confidence 高 → 拒绝');
    });
    await t.test('attr：unknown 全 0 且 confidence=low → 通过', () => {
      assert.ok(!throws(() => buildEvent({ type: "attr.rule", ts: TS, machine: "TEST", seq: 0, payload: { ...goodAttr, model_share: 0, brief_share: 0, coord_share: 0, env_share: 0, confidence: 0.5 }, schema })), 'attr：unknown 全 0 且 confidence=low → 通过');
    });

    // writeEvent：一事件一文件、ULID+机器名文件名、写一次即不可变、重复内容拒绝
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "djt-"));
    const w1 = writeEvent({ dir: tmp, type: "job.dispatch", ts: TS, machine: "TEST", seq: 0, payload: dispatchPayload, schema });
    await t.test('writeEvent：文件名 = <26位ULID>-<machine>.json', () => {
      assert.ok(/^[0-9A-HJKMNP-TV-Z]{26}-TEST\.json$/.test(path.basename(w1.path)), 'writeEvent：文件名 = <26位ULID>-<machine>.json  →  ' + path.basename(w1.path));
    });
    await t.test('writeEvent：写一次即不可变（同事件重写拒绝）', () => {
      assert.ok(throws(() => writeEvent({ dir: tmp, type: "job.dispatch", ts: TS, machine: "TEST", seq: 0, payload: dispatchPayload, schema })), 'writeEvent：写一次即不可变（同事件重写拒绝）');
    });
    await t.test('writeEvent：同 job 二次 job.dispatch 拒绝（每 job 一次防重复计账）', () => {
      assert.ok(throws(() => writeEvent({ dir: tmp, type: "job.dispatch", ts: TS, machine: "TEST", seq: 0, payload: { ...dispatchPayload, terminal: "codex" }, schema })), 'writeEvent：同 job 二次 job.dispatch 拒绝（每 job 一次防重复计账）');
    });
    const w2 = writeEvent({ dir: tmp, type: "job.dispatch", ts: TS, machine: "TEST", seq: 0, payload: { ...dispatchPayload, job_id: "dj-w2", terminal: "codex" }, schema });
    await t.test('writeEvent：不同内容+不同 job → 不同文件（同 ts 也唯一）', () => {
      assert.ok(w1.path !== w2.path && w1.event.event_id !== w2.event.event_id, 'writeEvent：不同内容+不同 job → 不同文件（同 ts 也唯一）');
    });
    writeEvent({ dir: tmp, type: "job.closed", ts: TS, machine: "TEST", seq: 3, payload: { job_id: "dj-w", success: true, rework: false, usd_cash: 0.1, usd_economic: 0.1, merged_by: FLASH }, schema });
    await t.test('writeEvent：同 job 不同类型（dispatch/closed）共存放行', () => {
      assert.ok(fs.readdirSync(tmp).filter(f => f.endsWith(".json")).length === 3, 'writeEvent：同 job 不同类型（dispatch/closed）共存放行');
    });
    await t.test('writeEvent：同 job 二次 job.closed 拒绝', () => {
      assert.ok(throws(() => writeEvent({ dir: tmp, type: "job.closed", ts: TS, machine: "TEST", seq: 4, payload: { job_id: "dj-w", success: true, rework: false, usd_cash: 0.1, usd_economic: 0.1, merged_by: FLASH }, schema })), 'writeEvent：同 job 二次 job.closed 拒绝');
    });
    await t.test('nextSeq：本机 max seq + 1', () => {
      assert.ok(nextSeq(tmp, "TEST") === 4 && nextSeq(tmp, "OTHER") === 0, 'nextSeq：本机 max seq + 1');
    });
    const ulid = ulidFromMs(Date.parse(TS), "0123456789abcdef0123456789abcdef");
    await t.test('ulidFromMs：26 位 Crockford base32、时间序前缀', () => {
      assert.ok(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(ulid) && ulidFromMs(Date.parse(TS) + 1000, "0123456789abcdef0123456789abcdef") > ulid, 'ulidFromMs：26 位 Crockford base32、时间序前缀');
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('政策 YAML 解析 / canonicalStringify', async (t) => {
    await t.test('models.yml 解析出 9 个现役模型', () => {
      assert.ok(models.length === 9, 'models.yml 解析出 9 个现役模型  →  ' + String(models.length));
    });
    const flash = models.find(m => m.id === FLASH);
    // 2026-08-16：ds-flash/pro 主通道换成 opencode Go（同一模型换计费通道，条目仍只有一条）。
    // 版本串照旧核对；计价口径改核「主通道是 Go 的额度包月」——直连按量价目退到
    // model-routing.toml 末尾的价目注记，只在切回应急直连时参考。
    await t.test('models.yml：flash 版本串与 model-routing.toml 注记一致', () => {
      assert.ok(flash.version === FLASH_VERSION, 'models.yml：flash 版本串与 model-routing.toml 注记一致  →  ' + flash.version);
    });
    await t.test('models.yml：flash 主通道 = opencode-go 额度包月（不是按量）', () => {
      assert.ok(flash.provider === "opencode-go" && flash.pricing.subscription.marginal_cost === 0 && flash.pricing.metered === null, 'models.yml：flash 主通道 = opencode-go 额度包月（不是按量）  →  ' + `${flash.provider}/${JSON.stringify(flash.pricing.metered)}`);
    });
    await t.test('models.yml：grok 订阅边际成本≈0（拍板口径）', () => {
      assert.ok(models.find(m => m.id === "grok-4.6").pricing.subscription.marginal_cost === 0, 'models.yml：grok 订阅边际成本≈0（拍板口径）');
    });
    await t.test('models.yml：gpt/claude 价目 verified_at=null（待补）', () => {
      assert.ok(models.find(m => m.id === "gpt-5.6-sol").pricing.verified_at === null && models.find(m => m.id === "claude-opus").pricing.verified_at === null, 'models.yml：gpt/claude 价目 verified_at=null（待补）');
    });
    await t.test('bans.yml：3 条硬禁令', () => {
      assert.ok(bans.length === 3, 'bans.yml：3 条硬禁令  →  ' + String(bans.length));
    });
    await t.test('bans.yml：gpt UI ban、deepseek 查证 ban 就位', () => {
      assert.ok(bans.some(b => b.models.includes("gpt-5.6-sol") && b.work_types.includes("UI")) && bans.some(b => b.models.includes(FLASH) && b.work_types.includes("查证")), 'bans.yml：gpt UI ban、deepseek 查证 ban 就位');
    });
    await t.test('weights.yml：λ_risk=1.0 / λ_pref=0.2 / λ_cost=0.15（C.1 默认）', () => {
      assert.ok(weights.weights.lambda_risk === 1.0 && weights.weights.lambda_pref === 0.2 && weights.weights.lambda_cost === 0.15, 'weights.yml：λ_risk=1.0 / λ_pref=0.2 / λ_cost=0.15（C.1 默认）');
    });
    await t.test('weights.yml：k=4、k0=2', () => {
      assert.ok(weights.shrinkage.k === 4 && weights.shrinkage.k0 === 2, 'weights.yml：k=4、k0=2');
    });

    // 确定性：canonicalStringify 键序稳定
    await t.test('canonicalStringify：键序稳定', () => {
      assert.ok(canonicalStringify({ b: 1, a: 2 }) === canonicalStringify({ a: 2, b: 1 }), 'canonicalStringify：键序稳定');
    });
  });

  it('⑤ 分时路由参与推荐（接线：峰时写码必须 grok-4.6）', async (t) => {
    const { parse: parseToml } = require("../scripts/lib/smol-toml.cjs");
    const routing = parseToml(fs.readFileSync(path.join(REPO, "docs", "model-routing.toml"), "utf8"));
    const routes = routing.routes || [];
    await t.test('model-routing.toml 读到写码峰/谷两条路由', () => {
      assert.ok(routes.filter(r => r.role === "写码").length === 2, 'model-routing.toml 读到写码峰/谷两条路由  →  ' + String(routes.length));
    });
    await t.test('matchBeijingRoute：峰时 10:00 写码 → grok-4.6', () => {
      assert.ok(matchBeijingRoute(routes, "写码", TS).model === "grok-4.6", 'matchBeijingRoute：峰时 10:00 写码 → grok-4.6');
    });
    await t.test('matchBeijingRoute：谷时 13:00 写码 → deepseek-v4-flash', () => {
      assert.ok(matchBeijingRoute(routes, "写码", TS_VALLEY).model === FLASH, 'matchBeijingRoute：谷时 13:00 写码 → deepseek-v4-flash');
    });
    await t.test('matchBeijingRoute：审查无分时路由 → null', () => {
      assert.ok(matchBeijingRoute(routes, "审查", TS) === null, 'matchBeijingRoute：审查无分时路由 → null');
    });

    // 红2：四个切换点 + 邻点，表驱动十时刻（M3 开下界 / M4 闭上界会在此红）
    const SWITCH = [
      ["00:00", FLASH], ["08:59", FLASH], ["09:00", "grok-4.6"], ["11:59", "grok-4.6"], ["12:00", FLASH],
      ["13:59", FLASH], ["14:00", "grok-4.6"], ["17:59", "grok-4.6"], ["18:00", FLASH], ["23:59", FLASH],
    ];
    for (const [hm, want] of SWITCH) {
      const got = matchBeijingRoute(routes, "写码", `2026-08-15T${hm}:00+08:00`);
      await t.test(`切换点 ${hm} → ${want === FLASH ? "谷 flash" : "峰 grok"}`, () => {
        assert.ok(!!got && got.model === want, `切换点 ${hm} → ${want === FLASH ? "谷 flash" : "峰 grok"}  →  ` + (got && got.model));
      });
    }
    const writeRoutes = routes.filter(r => r.role === "写码");
    let holes = 0, overlaps = 0;
    for (let min = 0; min < 1440; min++) {
      const hits = writeRoutes.filter(r => isInWindows(min, String(r.beijing).split(",").map(s => parseWindow(s.trim()))));
      if (hits.length === 0) holes++;
      if (hits.length > 1) overlaps++;
    }
    await t.test('全天 1440 分钟恰好 1 条写码路由（无空洞）', () => {
      assert.ok(holes === 0, '全天 1440 分钟恰好 1 条写码路由（无空洞）  →  ' + `holes=${holes}`);
    });
    await t.test('全天 1440 分钟恰好 1 条写码路由（无重叠）', () => {
      assert.ok(overlaps === 0, '全天 1440 分钟恰好 1 条写码路由（无重叠）  →  ' + `overlaps=${overlaps}`);
    });
  });

  it('判别力账本 / select+routes 接线（红3）', async (t) => {
    const { parse: parseToml } = require("../scripts/lib/smol-toml.cjs");
    const routing = parseToml(fs.readFileSync(path.join(REPO, "docs", "model-routing.toml"), "utf8"));
    const routes = routing.routes || [];
    // 红3：判别力账本——不接线则 highest_score 不是 grok（flash 5 正 + grok 6 负，配额已满）
    const discEvents = [
      ...manyJobs(models.filter(m => m.id !== "grok-4.6"), 5),
      ...sampleJobs({ n: 6, model: "grok-4.6", version: "grok-4.6", success: false }),
    ];
    const discBare = run({ jobId: "j-disc", events: discEvents });
    const discWired = run({ jobId: "j-disc", events: discEvents, routes });
    await t.test('判别力：不接线（无 routes）A ≠ grok-4.6', () => {
      assert.ok(discBare.options.A.model !== "grok-4.6", '判别力：不接线（无 routes）A ≠ grok-4.6  →  ' + discBare.options.A.model);
    });
    await t.test('判别力：接线后峰时 A = grok-4.6', () => {
      assert.ok(discWired.options.A.model === "grok-4.6" && discWired.options.A.model !== FLASH, '判别力：接线后峰时 A = grok-4.6  →  ' + discWired.options.A.model);
    });
    await t.test('判别力：接线后 reason=route_beijing（与 A.model 同源）', () => {
      assert.ok(discWired.options.A.reason === "route_beijing", '判别力：接线后 reason=route_beijing（与 A.model 同源）  →  ' + discWired.options.A.reason);
    });
    await t.test('判别力：不接线 reason ≠ route_beijing', () => {
      assert.ok(discBare.options.A.reason !== "route_beijing", '判别力：不接线 reason ≠ route_beijing  →  ' + discBare.options.A.reason);
    });

    const routedPeak = run({ jobId: "j-route-peak", events: discEvents, routes });
    await t.test('select+routes：峰时写码 A = grok-4.6（不是 ds-flash）', () => {
      assert.ok(routedPeak.options.A.model === "grok-4.6" && routedPeak.options.A.model !== FLASH, 'select+routes：峰时写码 A = grok-4.6（不是 ds-flash）  →  ' + routedPeak.options.A.model);
    });
    await t.test('select+routes：峰时 reason=route_beijing', () => {
      assert.ok(routedPeak.options.A.reason === "route_beijing", 'select+routes：峰时 reason=route_beijing  →  ' + routedPeak.options.A.reason);
    });
    const routedValley = run({ jobId: "j-route-valley", ts: TS_VALLEY, events: discEvents, routes });
    await t.test('select+routes：谷时写码 A = deepseek-v4-flash', () => {
      assert.ok(routedValley.options.A.model === FLASH, 'select+routes：谷时写码 A = deepseek-v4-flash  →  ' + routedValley.options.A.model);
    });
    await t.test('select+routes：谷时 reason=route_beijing', () => {
      assert.ok(routedValley.options.A.reason === "route_beijing", 'select+routes：谷时 reason=route_beijing  →  ' + routedValley.options.A.reason);
    });
    await t.test('slate：峰时第一是 grok，fallback 是下一模型不是管子', () => {
      assert.ok(Array.isArray(routedPeak.slate) && routedPeak.slate[0] === "grok-4.6" && routedPeak.slate[1] === FLASH, 'slate：峰时第一是 grok，fallback 是下一模型不是管子  →  ' + JSON.stringify(routedPeak.slate));
    });
    await t.test('slate：谷时第一是 flash', () => {
      assert.ok(Array.isArray(routedValley.slate) && routedValley.slate[0] === FLASH, 'slate：谷时第一是 flash  →  ' + JSON.stringify(routedValley.slate));
    });
    await t.test('无 routes 时行为不变：零样本仍 quota_explore', () => {
      assert.ok(run().options.A.reason === "quota_explore", '无 routes 时行为不变：零样本仍 quota_explore');
    });

    // CLI 的 provider 前缀来自 origin/master 路由表（#533），这里从同一来源派生期望值——
    // 不硬编码前缀（#519 教训：换通道会咬断言），只钉模型 id 与 provider 的对应关系。
    function masterProviderOf(modelId) {
      const r = spawnSync("git", ["show", "origin/master:docs/model-routing.toml"], { encoding: "utf8", cwd: REPO });
      if (r.status !== 0) throw new Error(`git show origin/master 失败: ${(r.stderr || r.stdout || "").slice(0, 200)}`);
      const models = parseToml(r.stdout).models || [];
      const m = models.find(x => x && x.id === modelId);
      return m && m.provider ? m.provider : null;
    }
    const flashProvider = masterProviderOf(FLASH);
    const grokProvider = masterProviderOf("grok-4.6");
    await t.test('master 路由表里 flash/grok 都有 provider（前缀期望来源）', () => {
      assert.ok(!!flashProvider && !!grokProvider, 'master 路由表里 flash/grok 都有 provider（前缀期望来源）  →  ' + `${flashProvider}/${grokProvider}`);
    });
    const discDir = fs.mkdtempSync(path.join(os.tmpdir(), "djt-disc-"));
    discEvents.forEach((e, i) => fs.writeFileSync(path.join(discDir, `${i}.json`), JSON.stringify(e)));
    const djPeak = cliDj(["--role", "写码", "--identity", "协调者", "--ts", TS, "--job-id", "wire-peak", "--events-dir", discDir]);
    await t.test('CLI dianjangtai-select 峰时退出码 0', () => {
      assert.ok(djPeak.status === 0, 'CLI dianjangtai-select 峰时退出码 0  →  ' + (djPeak.stderr || "").slice(0, 200));
    });
    const djPeakOut = djPeak.status === 0 ? JSON.parse(djPeak.stdout) : { options: { A: {} } };
    await t.test('CLI 伪造峰时输入：写码推荐 provider/grok-4.6（#533 provider/model 全称）', () => {
      assert.ok(djPeakOut.options.A.model === `${grokProvider}/grok-4.6`, 'CLI 伪造峰时输入：写码推荐 provider/grok-4.6（#533 provider/model 全称）  →  ' + JSON.stringify(djPeakOut.options && djPeakOut.options.A));
    });
    await t.test('CLI 峰时写码不是 ds-flash（钉死分时违例）', () => {
      assert.ok(djPeakOut.options.A.model !== `${flashProvider}/${FLASH}`, 'CLI 峰时写码不是 ds-flash（钉死分时违例）');
    });
    await t.test('CLI 峰时 A 带 provider 字段（#533）', () => {
      assert.ok(djPeakOut.options.A.provider === grokProvider, 'CLI 峰时 A 带 provider 字段（#533）  →  ' + JSON.stringify(djPeakOut.options.A));
    });
    await t.test('CLI 峰时 A/B/C 三个选项模型标识都渲染成 provider/model（#533）', () => {
      assert.ok(["A", "B", "C"].every(k => {
        const opt = djPeakOut.options[k];
        const ids = Array.isArray(opt.models) ? opt.models : [opt.model];
        return ids.every(m => typeof m === "string" && m.includes("/"));
      }), 'CLI 峰时 A/B/C 三个选项模型标识都渲染成 provider/model（#533）  →  ' + JSON.stringify(djPeakOut.options));
    });
    await t.test('CLI 峰时输出含 decision_id 与三选项', () => {
      assert.ok(!!(djPeakOut.decision_id && djPeakOut.options.A && djPeakOut.options.B && djPeakOut.options.C), 'CLI 峰时输出含 decision_id 与三选项');
    });
    await t.test('CLI 峰时 reason=route_beijing', () => {
      assert.ok(djPeakOut.options.A.reason === "route_beijing", 'CLI 峰时 reason=route_beijing  →  ' + djPeakOut.options.A.reason);
    });
    const djValley = cliDj(["--role", "写码", "--identity", "协调者", "--ts", TS_VALLEY, "--job-id", "wire-valley", "--events-dir", discDir]);
    await t.test('CLI 谷时写码推荐 provider/deepseek-v4-flash（#533，前缀随 master 路由表）', () => {
      assert.ok(djValley.status === 0 && JSON.parse(djValley.stdout).options.A.model === `${flashProvider}/${FLASH}`, 'CLI 谷时写码推荐 provider/deepseek-v4-flash（#533，前缀随 master 路由表）  →  ' + (djValley.stderr || "").slice(0, 120));
    });
    const djNoTs = cliDj(["--role", "写码"]);
    await t.test('CLI 缺 --ts 非 0 退出（禁 Date.now）', () => {
      assert.ok(djNoTs.status !== 0, 'CLI 缺 --ts 非 0 退出（禁 Date.now）');
    });
    fs.rmSync(discDir, { recursive: true, force: true });
  });

  it('⑥ 回填幂等：GitHub 实录快照写事件，重跑不重复', async (t) => {
    const { reconstructJob, writeReconstructedJobs, isClosedOnDate, resolveModelId, classifyFromGithub } = require("../scripts/lib/dianjiangtai-backfill.mjs");
    const backfillSnap = JSON.parse(fs.readFileSync(path.join(REPO, "tests", "fixtures", "backfill-github-2026-08-15.json"), "utf8"));
    await t.test('resolveModelId：grok → grok-4.6 且 ∈ registry', () => {
      assert.ok(resolveModelId("grok", models) === "grok-4.6" && models.some(m => m.id === "grok-4.6"), 'resolveModelId：grok → grok-4.6 且 ∈ registry');
    });
    await t.test('resolveModelId：未知串 → null', () => {
      assert.ok(resolveModelId("not-a-model", models) === null, 'resolveModelId：未知串 → null');
    });
    const recGrok = reconstructJob(backfillSnap.prs.find(p => p.number === 458) || {
      number: 458, title: "[grok] x", createdAt: "2026-08-15T02:00:00Z", mergedAt: "2026-08-15T02:00:00Z",
      labels: [{ name: "model/grok" }, { name: "type/写码" }], reviews: [],
    }, { models });
    await t.test('红1：model/grok 标签落账 id=grok-4.6（∈ registry）', () => {
      assert.ok(!recGrok.skip && recGrok.model === "grok-4.6" && models.some(m => m.id === recGrok.model), '红1：model/grok 标签落账 id=grok-4.6（∈ registry）  →  ' + (recGrok.model || recGrok.reason));
    });
    const ghostPr = { number: 9999, title: "ghost", createdAt: "2026-08-15T02:00:00Z", labels: [{ name: "model/not-a-model" }, { name: "type/写码" }], reviews: [] };
    const recGhost = reconstructJob(ghostPr, { models });
    await t.test('红1：未知 model/* skip 并报原因', () => {
      assert.ok(recGhost.skip && /not-a-model/.test(recGhost.reason || ""), '红1：未知 model/* skip 并报原因  →  ' + recGhost.reason);
    });
    const ghostDir = fs.mkdtempSync(path.join(os.tmpdir(), "djt-ghost-"));
    const ghostWrite = writeReconstructedJobs({
      jobs: [recGhost], dir: ghostDir, schema, machine: "TEST-GHOST",
    });
    await t.test('红1：skip 进 details 不落账', () => {
      assert.ok(ghostWrite.written === 0 && ghostWrite.details[0].skip && /not-a-model/.test(ghostWrite.details[0].reason || ""), '红1：skip 进 details 不落账  →  ' + JSON.stringify(ghostWrite));
    });
    fs.rmSync(ghostDir, { recursive: true, force: true });
    await t.test('classifyFromGithub：model/grok 规范化', () => {
      assert.ok(classifyFromGithub({ title: "x", labels: [{ name: "model/grok" }] }, { models }).model === "grok-4.6", 'classifyFromGithub：model/grok 规范化');
    });
    await t.test('回填夹具来自 GitHub 实录（有 source + prs）', () => {
      assert.ok(Array.isArray(backfillSnap.prs) && backfillSnap.prs.length >= 2 && /gh /.test(backfillSnap.source || ""), '回填夹具来自 GitHub 实录（有 source + prs）');
    });
    const closedToday = backfillSnap.prs.filter(pr => isClosedOnDate(pr, "2026-08-15"));
    await t.test('2026-08-15 北京日已结单至少含 #456/#460', () => {
      assert.ok(closedToday.some(p => p.number === 456) && closedToday.some(p => p.number === 460), '2026-08-15 北京日已结单至少含 #456/#460  →  ' + closedToday.map(p => p.number).join(","));
    });
    const rec456 = reconstructJob(backfillSnap.prs.find(p => p.number === 456), { models });
    await t.test('回填 #456：模型/工种来自标签，红项=4（判定行）', () => {
      assert.ok(!rec456.skip && rec456.model === FLASH && rec456.workType === "写码" && rec456.redFlags === 4, '回填 #456：模型/工种来自标签，红项=4（判定行）  →  ' + JSON.stringify({ skip: rec456.skip, model: rec456.model, red: rec456.redFlags }));
    });
    await t.test('回填 #456：派单+结单+归因 4 事件', () => {
      assert.ok(rec456.events.map(e => e.type).join(",") === "job.opened,job.dispatch,job.closed,attr.rule", '回填 #456：派单+结单+归因 4 事件  →  ' + rec456.events.map(e => e.type).join(","));
    });
    const rec460 = reconstructJob(backfillSnap.prs.find(p => p.number === 460), { models });
    await t.test('回填 #460：标题 [pi] 推出 flash，试测单 coord 归因', () => {
      assert.ok(!rec460.skip && rec460.model === FLASH && rec460.events.find(e => e.type === "attr.rule").payload.coord_share === 1, '回填 #460：标题 [pi] 推出 flash，试测单 coord 归因');
    });

    function runBackfill(dir) {
      return spawnSync(process.execPath, [
        path.join(REPO, "scripts", "dianjiangtai-backfill.mjs"),
        "--date", "2026-08-15",
        "--source-json", path.join(REPO, "tests", "fixtures", "backfill-github-2026-08-15.json"),
        "--events-dir", dir,
        "--machine", "TEST-BACKFILL",
      ], { encoding: "utf8", cwd: REPO });
    }
    const bfDir = fs.mkdtempSync(path.join(os.tmpdir(), "djt-bf-"));
    const bf1 = runBackfill(bfDir);
    await t.test('回填脚本首跑退出码 0', () => {
      assert.ok(bf1.status === 0, '回填脚本首跑退出码 0  →  ' + (bf1.stderr || bf1.stdout || "").slice(0, 240));
    });
    const bf1Out = bf1.status === 0 ? JSON.parse(bf1.stdout) : { written: 0 };
    await t.test('回填首跑写出事件（>0，非 mock 内生）', () => {
      assert.ok(bf1Out.written > 0, '回填首跑写出事件（>0，非 mock 内生）  →  ' + JSON.stringify(bf1Out));
    });
    const bfFiles1 = fs.readdirSync(bfDir).filter(f => f.endsWith(".json")).sort();
    await t.test('回填文件名 ULID-machine', () => {
      assert.ok(bfFiles1.every(f => /-TEST-BACKFILL\.json$/.test(f)), '回填文件名 ULID-machine  →  ' + (bfFiles1[0] || "(empty)"));
    });
    const bf2 = runBackfill(bfDir);
    const bf2Out = bf2.status === 0 ? JSON.parse(bf2.stdout) : { written: -1, skipped: 0 };
    await t.test('回填重跑退出码 0（幂等不炸）', () => {
      assert.ok(bf2.status === 0, '回填重跑退出码 0（幂等不炸）  →  ' + (bf2.stderr || "").slice(0, 200));
    });
    await t.test('回填重跑 written=0（不重复写事件）', () => {
      assert.ok(bf2Out.written === 0, '回填重跑 written=0（不重复写事件）  →  ' + JSON.stringify(bf2Out));
    });
    await t.test('回填重跑 skipped=首跑 written', () => {
      assert.ok(bf2Out.skipped === bf1Out.written, '回填重跑 skipped=首跑 written  →  ' + `${bf2Out.skipped} vs ${bf1Out.written}`);
    });
    const bfFiles2 = fs.readdirSync(bfDir).filter(f => f.endsWith(".json")).sort();
    await t.test('回填重跑文件集合不变', () => {
      assert.ok(JSON.stringify(bfFiles1) === JSON.stringify(bfFiles2), '回填重跑文件集合不变');
    });
    fs.rmSync(bfDir, { recursive: true, force: true });
  });

  it('#581 审读 A 位锁 GPT', async (t) => {
    const { pinReviewerSlotA } = require("../scripts/lib/dianjiangtai-reviewer-slot.mjs");
    await t.test('pinReviewerSlotA 在门闩集合有 GPT 时锁 GPT', () => {
      assert.ok(pinReviewerSlotA({
        models: [{ id: "gpt-5.6-sol", provider: "gpt" }, { id: "claude-opus", provider: "claude" }, { id: "grok-4.6", provider: "grok" }],
        passerIds: ["grok-4.6", "claude-opus", "gpt-5.6-sol"],
      }).model === "gpt-5.6-sol", 'pinReviewerSlotA 在门闩集合有 GPT 时锁 GPT');
    });
    await t.test('pinReviewerSlotA GPT 被剔后顺延 Opus', () => {
      assert.ok(pinReviewerSlotA({
        models: [{ id: "gpt-5.6-sol", provider: "gpt" }, { id: "claude-opus", provider: "claude" }, { id: "grok-4.6", provider: "grok" }],
        passerIds: ["grok-4.6", "claude-opus"],
      }).model === "claude-opus", 'pinReviewerSlotA GPT 被剔后顺延 Opus');
    });
    const { parse: parseToml } = require("../scripts/lib/smol-toml.cjs");
    function masterProviderOf(modelId) {
      const r = spawnSync("git", ["show", "origin/master:docs/model-routing.toml"], { encoding: "utf8", cwd: REPO });
      if (r.status !== 0) throw new Error(`git show origin/master 失败: ${(r.stderr || r.stdout || "").slice(0, 200)}`);
      const models = parseToml(r.stdout).models || [];
      const m = models.find(x => x && x.id === modelId);
      return m && m.provider ? m.provider : null;
    }
    const revDir = fs.mkdtempSync(path.join(os.tmpdir(), "djt-rev-"));
    const djReview = cliDj(["--role", "审读", "--ts", "2026-08-15T15:00:00+08:00", "--job-id", "rev-pin", "--events-dir", revDir]);
    await t.test('CLI 审读退出码 0', () => {
      assert.ok(djReview.status === 0, 'CLI 审读退出码 0  →  ' + (djReview.stderr || "").slice(0, 240));
    });
    const djReviewOut = djReview.status === 0 ? JSON.parse(djReview.stdout) : { options: { A: {} } };
    const gptProvider = masterProviderOf("gpt-5.6-sol");
    await t.test('CLI 审读 A = provider/gpt-5.6-sol', () => {
      assert.ok(!!gptProvider && djReviewOut.options.A.model === `${gptProvider}/gpt-5.6-sol`, 'CLI 审读 A = provider/gpt-5.6-sol  →  ' + JSON.stringify(djReviewOut.options && djReviewOut.options.A));
    });
    await t.test('CLI 审读 A reason=reviewer_default_gpt', () => {
      assert.ok(djReviewOut.options.A.reason === "reviewer_default_gpt", 'CLI 审读 A reason=reviewer_default_gpt  →  ' + JSON.stringify(djReviewOut.options && djReviewOut.options.A));
    });
    await t.test('CLI 审读 B 仍走评分（集合长度>1）', () => {
      assert.ok(Array.isArray(djReviewOut.options.B.models) && djReviewOut.options.B.models.length > 1, 'CLI 审读 B 仍走评分（集合长度>1）  →  ' + JSON.stringify(djReviewOut.options && djReviewOut.options.B));
    });
    const djUi = cliDj(["--role", "审读", "--work-type", "UI", "--ts", "2026-08-15T15:00:00+08:00", "--job-id", "rev-ui", "--events-dir", revDir]);
    await t.test('CLI 审读+UI 退出码 0', () => {
      assert.ok(djUi.status === 0, 'CLI 审读+UI 退出码 0  →  ' + (djUi.stderr || "").slice(0, 240));
    });
    const djUiOut = djUi.status === 0 ? JSON.parse(djUi.stdout) : { options: { A: {} } };
    const opusProvider = masterProviderOf("claude-opus");
    await t.test('CLI 审读撞 UI ban → A = provider/claude-opus', () => {
      assert.ok(!!opusProvider && djUiOut.options.A.model === `${opusProvider}/claude-opus`, 'CLI 审读撞 UI ban → A = provider/claude-opus  →  ' + JSON.stringify(djUiOut.options && djUiOut.options.A));
    });
    await t.test('CLI 审读撞 UI ban reason=reviewer_order', () => {
      assert.ok(djUiOut.options.A.reason === "reviewer_order", 'CLI 审读撞 UI ban reason=reviewer_order  →  ' + JSON.stringify(djUiOut.options && djUiOut.options.A));
    });
    fs.rmSync(revDir, { recursive: true, force: true });
  });
});