export const meta = {
  name: 'incremental-review',
  description: '增量三镜复审(参数化):对指定 git range 的累计 diff 做集成缝/测试判别力/账实一致三镜扫描,发现→对抗验证',
  // ⚠ 本字段必须是**单个字符串字面量**——Workflow 工具校验 meta 为纯字面量,
  // 字符串 `+` 拼接是 BinaryExpression,会被整脚本拒载(2026-08-01 实测报
  // "meta must be a pure literal: non-literal node type in meta: BinaryExpression");
  // 货架级契约由 tests/dao-consolidate.tests.js 末节对本目录全部 *.js 求值。
  whenToUse:
    '需要 args: {repoPath, range}(两个都必填,均不设默认)。`repoPath` 不设默认的理由同货架三位同架成员:跨项目资产内置某一个仓的路径,正是它上一版不可复用的根因;`range` 不设默认的理由不同——增量复审的范围必须由调用方显式声明,猜一个区间等于对着一个没人确认过的范围出报告。何时跑:①一批 PR 连着合完、想找**单个 PR 终审时结构性看不见**的跨提交缺陷时②发布/收账提交落地后核账实是否真一致时③想知道本批新增的测试到底有没有判别力时。三镜:集成缝(跨提交/跨文件的相互作用)、测试判别力(守护对象真坏掉时会不会红)、账实一致(版本号落点/账本描述/验收勾选与实际 diff 是否相符)。不该跑:找单个文件内部的产品 bug(那是 `code-quality-audit` 的活)、复盘执行缺陷(那是 `pr-history-postmortem` 的活)、range 内只有一两个提交(fan-out 三路不划算)。',
  phases: [
    { title: 'Find', detail: '三镜并行:集成缝 / 测试判别力 / 回归与账实一致' },
    { title: 'Verify', detail: '逐条对抗核验:锚点真实存在?推理成立?严重度恰当?拿不准倾向推翻或降级' },
  ],
}

// `args` 可能以调用方原始 JSON 字符串形式到达,也可能已是解析好的对象,视运行时而定——
// 两种形态都归一化处理。不是合法 JSON 的字符串原样落回,交给下方必填校验去报错。
const ARGS = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch (e) { return args } })() : args

const RANGE = ARGS && ARGS.range
if (!RANGE) {
  throw new Error('incremental-review workflow requires args: {range: "<from-rev>..<to-rev>"}')
}
// repoPath 无默认值:2026-08-02 上架 dao 货架时由「缺省 mousse-cli」改为必填,与
// pr-history-postmortem / dao-harvest / dao-consolidate 三位同架成员对齐——一个跨项目
// 资产内置某一个仓的路径,失效形态是「在别的仓里跑出一份关于 mousse-cli 的报告」,
// 而那份报告看起来完全正常。缺省即报错,不猜。
const REPO = ARGS && ARGS.repoPath
if (!REPO) {
  throw new Error('incremental-review workflow requires args: {repoPath: "<absolute repo path>"}')
}

const FINDINGS = { type:'object', required:['findings'], properties:{ findings:{ type:'array', items:{ type:'object', required:['title','file','severity','evidence'], properties:{ title:{type:'string'}, file:{type:'string'}, line:{type:'number'}, severity:{enum:['P1','P2','P3']}, evidence:{type:'string'} } } }, clean_claims:{ type:'array', items:{type:'string'} } } }
const VERDICT = { type:'object', required:['isReal','reason'], properties:{ isReal:{type:'boolean'}, downgrade:{type:'string'}, reason:{type:'string'} } }

// 三镜刻意不预设"这次 range 里有什么"（原版曾硬编码具体 PR 号/具体文件名，只对那一次
// 复审有效）——统一先让 agent 自己用 git log/diff 摸清 range 内实际改了什么，再按镜头
// 视角深挖，这样同一份脚本才能对任意未来的 range 重复调用。
//
// 同理不预设**这个仓长什么样**（2026-08-02 上架时补的一格）：版本号有几处落点、账本
// 叫什么名字、验收清单在哪，各仓都不同。原版把某一个仓的答案（「版本四处一体」「CHANGELOG/
// PROGRESS」）写死在 prompt 里 ⇒ 换个仓跑，镜头会去找一批**根本不存在的东西**，
// 而「找不到」与「找了都对」在报告里长得一模一样。现改为一律「先探测该仓实际有什么，
// 探不到就判本项不适用并写进 clean_claims」——**不适用要说出来，不许沉默**。
const LENSES = [
 {key:'seam', prompt:`集成缝镜:审 ${REPO} 仓库 git range ${RANGE} 的累计 diff(用 git -C ${REPO} log --oneline ${RANGE} 与 git -C ${REPO} diff ${RANGE} --stat 先摸清本次范围改了哪些提交/文件，再用 git -C ${REPO} diff/show 有界深挖)。找跨提交/跨文件的集成缝缺陷——单个提交终审时结构性看不见的相互作用:新增测试与其真实消费点之间的隐含假设是否一致、release/版本收账提交与**该仓全部版本号落点**是否真一致(先自己在仓里探出有几处、分别在哪:包管理清单/构建配置/前端注入常量/锁文件…**不要预设是几处、也不要预设文件名**;探不到就判本项不适用并写进 clean_claims)、跨文件重构后遗留的调用点是否都同步更新。只报有证据锚点(文件+行+复现推理)的发现,压制臆测;查净处入 clean_claims。搜索一律内置 Grep/Glob/Read,禁 bash grep/cat/tail 任何形态含大小写变体。`},
 {key:'test-power', prompt:`测试判别力镜:审 ${REPO} 仓库 git range ${RANGE} 中新增/修改的测试(先用 git -C ${REPO} diff ${RANGE} --stat 定位改了哪些 *.test.*/*_test.*/测试模块，逐个深挖)。逐个问:该测试在其守护对象真坏掉时会不会红?找假绿风险——mock 吞断言/fake timer 跳过真实路径/扫描器或正则类判据存在逃逸口/弱断言(如 toBeGreaterThan(0))是否足够。只报有证据的发现,查净处入 clean_claims。工具约束:内置 Grep/Glob/Read,禁 bash grep/cat/tail 含大小写变体。`},
 {key:'consistency', prompt:`回归与账实一致镜:审 ${REPO} 仓库 git range ${RANGE} 内的 release/docs/账本类提交与代码实态的一致性。**先探测这个仓实际有哪些账本与版本落点,不要照搬任何预设的文件名**(通读 git -C ${REPO} log ${RANGE} --oneline 摸清有哪些版本收账/变更日志/进度流水/验收补勾类提交;再用 Glob/Read 确认这些文件在本仓真实存在)。逐项核:①**版本号的全部落点**互相一致且与锁文件一致(有几处由你探出来,不要预设是几处) ②变更日志/进度流水条目描述的改动量(文件数/行数/覆盖范围/数字)与实际 diff 相符 ③验收清单类文件(acceptance/checklist)新勾的框抽样核其证据注真实 ④引用的 commit/PR/issue 号真存在。**某一项在本仓不存在对应载体时,显式写「本仓无此载体,本项不适用」进 clean_claims,不要沉默跳过**——沉默会被读成「查过且没问题」。只报有证据的发现。工具约束:内置 Grep/Glob/Read,禁 bash grep/cat/tail 含大小写变体。`},
]

phase('Find')
const rounds = await parallel(LENSES.map(l => () => agent(l.prompt, {label:`find:${l.key}`, phase:'Find', schema: FINDINGS, model:'sonnet'})))
const all = rounds.filter(Boolean).flatMap(r => r.findings)
const seen = new Set(); const deduped = []
for (const f of all) { const k = f.file + '|' + f.title.slice(0,40); if (!seen.has(k)) { seen.add(k); deduped.push(f) } }
log(`三镜共 ${all.length} 条,去重后 ${deduped.length} 条进入对抗验证`)

phase('Verify')
const verified = await parallel(deduped.map(f => () =>
  agent(`对抗验证官:试图推翻此复审发现——「${f.title}」文件 ${f.file} 行 ${f.line ?? '?'} 严重度 ${f.severity}。原证据:${f.evidence}。在 ${REPO} 实仓独立核实(内置 Grep/Glob/Read,禁 bash grep/cat/tail 含大小写变体):证据锚点真实存在?推理成立?严重度恰当?拿不准时倾向推翻或降级,不拔高。reason 里给你的独立证据。`, {label:`verify:${(f.file||'').split('/').pop()}`, phase:'Verify', schema: VERDICT, model:'sonnet'}).then(v => ({...f, verdict: v}))
))
const confirmed = verified.filter(Boolean).filter(f => f.verdict && f.verdict.isReal)
const rejected = verified.filter(Boolean).filter(f => f.verdict && !f.verdict.isReal).map(f => ({title: f.title, reason: f.verdict.reason}))
const clean_claims = rounds.filter(Boolean).flatMap(r => r.clean_claims || [])
return { repoPath: REPO, range: RANGE, confirmed, rejected, clean_claims }
