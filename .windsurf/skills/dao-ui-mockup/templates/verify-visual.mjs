/**
 * dao-ui-mockup · 第六步「固」6.2 验证模板 · mockup vs impl diff
 *
 * 用法（实施完代码后必跑）：
 *   1. 第六步固已产出 _tmp/selector-mapping-<topic>.json（schema 见 templates/selector-mapping.schema.json）
 *   2. 复制本文件到 _tmp/verify-visual-<topic>.mjs
 *   3. 修改 MAPPING_PATH 指向你的 selector-mapping JSON
 *   4. 运行 `node _tmp/verify-visual-<topic>.mjs`
 *   5. 看 _tmp/visual-diff-<topic>.md 报告，全绿才能进 dao-finish
 *
 * 道法自然：不靠 quality.md 加补丁铁律记得检查 a11y / shadcn 裂痕，
 * 而是让 mockup 当 ground truth + diff 验证自动捕获偏差。
 *
 * dogfooding 反馈（2026-05-16）：selector mapping 提到 JSON 让其作为第六步固产出，
 * 验证脚本本身保持薄一层 runner。
 */

import { chromium } from '@playwright/test'
import { writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// === 配置 · 改这一行指向你的 mapping JSON ===
const MAPPING_PATH = '_tmp/selector-mapping-<topic>.json'

const mapping = JSON.parse(readFileSync(MAPPING_PATH, 'utf-8'))
const { meta, scopes } = mapping
const TOPIC = meta.topic
const MOCKUP_HTML = resolve(meta.mockupHtml)
const DEV_SERVER_URL = meta.implUrl
const SELECTED_DIRECTION = meta.direction
const REPORT_PATH = `_tmp/visual-diff-${TOPIC}.md`
const VIEWPORT = meta.viewport ?? { width: 1280, height: 800 }

// 量哪些 computed style 维度
function getStyleSubset(el) {
  const cs = getComputedStyle(el)
  return {
    fontSize: cs.fontSize,
    fontFamily: cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
    fontWeight: cs.fontWeight,
    lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing,
    color: cs.color,
    backgroundColor: cs.backgroundColor,
    borderRadius: cs.borderRadius,
    borderWidth: cs.borderWidth,
    padding: cs.padding,
    height: cs.height,
    boxShadow: cs.boxShadow.length > 60 ? cs.boxShadow.slice(0, 60) + '...' : cs.boxShadow,
  }
}

// === 主流程 ===
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: VIEWPORT })

// 1. 截 mockup HTML
const mockupPage = await ctx.newPage()
await mockupPage.goto('file://' + MOCKUP_HTML)
await mockupPage.evaluate((dir) => {
  document.documentElement.dataset.direction = dir
}, SELECTED_DIRECTION)
await mockupPage.waitForTimeout(300)

// 2. 截 dev server
const implPage = await ctx.newPage()
await implPage.goto(DEV_SERVER_URL, { waitUntil: 'domcontentloaded' })
await implPage.waitForTimeout(800)

// 3. 量 diff · 按 mapping.scopes 分组循环
const rows = []
const failures = []

for (const [scopeName, scope] of Object.entries(scopes)) {
  // 进入 scope（如 navigate 到特定路径或点开 dialog）
  if (scope.openBy?.navigate) {
    await implPage.goto(DEV_SERVER_URL + scope.openBy.navigate, { waitUntil: 'domcontentloaded' })
    await implPage.waitForTimeout(scope.openBy.wait ?? 500)
  }
  if (scope.openBy?.click) {
    await implPage.locator(scope.openBy.click).first().click()
    await implPage.waitForTimeout(scope.openBy.wait ?? 400)
  }

  for (const check of scope.checks) {
    let mockStyle = null, implStyle = null

    try {
      mockStyle = await mockupPage.locator(check.mockSel).first().evaluate(getStyleSubset)
    } catch (e) {
      failures.push(`[${scopeName}] ${check.name} mockup '${check.mockSel}': ${e.message.split('\n')[0]}`)
      continue
    }
    try {
      implStyle = await implPage.locator(check.implSel).first().evaluate(getStyleSubset)
    } catch (e) {
      failures.push(`[${scopeName}] ${check.name} impl '${check.implSel}': ${e.message.split('\n')[0]}`)
      continue
    }

    const skipDims = new Set(check.skipDims ?? [])

    for (const dim of Object.keys(mockStyle)) {
      if (skipDims.has(dim)) continue
      const mockVal = mockStyle[dim]
      const implVal = implStyle[dim]
      if (mockVal === implVal) continue

      let verdict = '✅ 设计噪音'
      if (dim === 'fontSize') {
        const implPx = parseFloat(implVal)
        if (implPx < 12) verdict = `❌ a11y 红线 < 12px`
        else if (Math.abs(parseFloat(mockVal) - implPx) > 2) verdict = `❌ 偏差 > 2px`  // Tailwind step 与 mockup px 天然 ±2px 噪音
      } else if (dim === 'borderRadius') {
        const m = parseFloat(mockVal), i = parseFloat(implVal)
        if (Math.abs(m - i) > 2) verdict = `❌ radius 偏差 > 2px`
      } else if (dim === 'fontFamily' && mockStyle.fontFamily !== implStyle.fontFamily) {
        verdict = `⚠️ 字体差异（核对 fallback 链）`
      } else if (dim === 'padding' || dim === 'height') {
        verdict = `⚠️ spacing 体系差异（Tailwind step vs px · 用 skipDims 标已接受）`
      } else if (dim === 'boxShadow' || dim === 'color' || dim === 'backgroundColor') {
        verdict = `⚠️ ${dim} 待人审`
      }

      rows.push({ scope: scopeName, name: check.name, dim, mock: mockVal, impl: implVal, verdict, notes: check.notes ?? '' })
    }
  }
}

await browser.close()

// === 输出报告 ===
const failCount = rows.filter((r) => r.verdict.startsWith('❌')).length
const warnCount = rows.filter((r) => r.verdict.startsWith('⚠️')).length
const passCount = rows.filter((r) => r.verdict.startsWith('✅')).length

const scopeNames = [...new Set(rows.map((r) => r.scope))]
const scopeBlocks = scopeNames.map((s) => {
  const sub = rows.filter((r) => r.scope === s)
  return `## scope: ${s}\n\n| 元素 | 维度 | mockup | 实施 | 处置 | 备注 |\n|---|---|---|---|---|---|\n${sub.map((r) => `| ${r.name} | ${r.dim} | ${r.mock} | ${r.impl} | ${r.verdict} | ${r.notes} |`).join('\n')}`
}).join('\n\n')

const md = `# Visual Diff Report · ${TOPIC}

生成时间: ${new Date().toISOString()}
方向: ${SELECTED_DIRECTION}
mapping: ${MAPPING_PATH}

## 关卡判定

- ❌ ${failCount} 项必修
- ⚠️ ${warnCount} 项待人审/体系差异
- ✅ ${passCount} 项设计噪音可接受

${failCount === 0 ? '**🟢 全绿 → 可进 dao-finish**' : '**🔴 有 ❌ → 回炉（修代码或修 mockup）**'}

${scopeBlocks}

${failures.length > 0 ? `\n## Selector 失败\n\n${failures.map((f) => `- ${f}`).join('\n')}\n` : ''}
`

writeFileSync(REPORT_PATH, md, 'utf-8')
console.log(`✅ 报告已写入 ${REPORT_PATH}`)
console.log(`关卡: ${failCount === 0 ? '🟢 PASS' : `🔴 FAIL (${failCount} ❌)`}`)
process.exit(failCount === 0 ? 0 : 1)
