/**
 * dao-ui-mockup · 第六步「固」6.2 验证模板 · mockup vs impl diff
 *
 * 用法（实施完代码后必跑）：
 *   1. 复制本文件到 _tmp/verify-visual-<topic>.mjs
 *   2. 修改 MOCKUP_HTML / DEV_SERVER_URL / SELECTED_DIRECTION
 *   3. 修改 CHECKS 数组：列出关键组件的 mockup selector + impl selector
 *   4. 运行 `node _tmp/verify-visual-<topic>.mjs`
 *   5. 看 _tmp/visual-diff-<topic>.md 报告，全绿才能进 dao-finish
 *
 * 道法自然：不靠 quality.md 加补丁铁律记得检查 a11y / shadcn 裂痕，
 * 而是让 mockup 当 ground truth + diff 验证自动捕获偏差。
 */

import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// === 配置（每个项目改这里）===
const TOPIC = '<topic>'
const MOCKUP_HTML = resolve(`_tmp/ui-mockup-${TOPIC}.html`)
const DEV_SERVER_URL = 'http://localhost:1420'
const SELECTED_DIRECTION = '<linear|notion|claude|raycast>' // 用户在「五·择」选定的方向
const REPORT_PATH = `_tmp/visual-diff-${TOPIC}.md`

const VIEWPORT = { width: 1280, height: 800 }

// 关键组件 selector 映射 · mockup 端 vs 实施端
// 列出 dialog/button/input/select/card/sidebar 等关键组件
const CHECKS = [
  // { name: 'Button.primary',  mockSel: '.btn-primary',     implSel: 'button[data-slot="button"][data-variant="default"]' },
  // { name: 'Input',           mockSel: '.qa-textarea',      implSel: '[data-slot="input"]' },
  // { name: 'Dialog',          mockSel: '.scene-window',     implSel: '[data-slot="dialog-content"]' },
  // { name: 'SelectTrigger',   mockSel: '.dir-tabs button',  implSel: '[data-slot="select-trigger"]' },
  // { name: 'Card',            mockSel: '.swatch',           implSel: '[data-slot="card"]' },
  // { name: 'StatusBadge',     mockSel: '.project-status',   implSel: '[data-slot="status-badge"]' },
]

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

// 3. 量 diff
const rows = []
const failures = []

for (const check of CHECKS) {
  let mockStyle = null
  let implStyle = null

  try {
    mockStyle = await mockupPage.locator(check.mockSel).first().evaluate(getStyleSubset)
  } catch (e) {
    failures.push(`${check.name}: mockup selector "${check.mockSel}" 未找到 - ${e.message}`)
    continue
  }

  try {
    implStyle = await implPage.locator(check.implSel).first().evaluate(getStyleSubset)
  } catch (e) {
    failures.push(`${check.name}: impl selector "${check.implSel}" 未找到 - ${e.message}`)
    continue
  }

  // 逐维度 diff
  for (const dim of Object.keys(mockStyle)) {
    const mockVal = mockStyle[dim]
    const implVal = implStyle[dim]
    if (mockVal === implVal) continue

    // a11y 红线：fontSize < 12px
    let verdict = '✅ 设计噪音'
    if (dim === 'fontSize') {
      const implPx = parseFloat(implVal)
      if (implPx < 12) verdict = `❌ a11y 红线 < 12px`
      else if (Math.abs(parseFloat(mockVal) - implPx) > 1) verdict = `❌ 偏差 > 1px`
    } else if (dim === 'borderRadius' || dim === 'padding' || dim === 'height') {
      const m = parseFloat(mockVal), i = parseFloat(implVal)
      if (Math.abs(m - i) > 2) verdict = `❌ 偏差 > 2px`
    } else if (dim === 'fontFamily' && mockStyle.fontFamily !== implStyle.fontFamily) {
      verdict = `❌ 字体不一致（shadcn 裂痕？）`
    } else if (dim === 'boxShadow') {
      verdict = `⚠️ shadow 待人审`
    }

    rows.push({ name: check.name, dim, mock: mockVal, impl: implVal, verdict })
  }
}

await browser.close()

// === 输出报告 ===
const failCount = rows.filter((r) => r.verdict.startsWith('❌')).length
const warnCount = rows.filter((r) => r.verdict.startsWith('⚠️')).length
const passCount = rows.filter((r) => r.verdict.startsWith('✅')).length

const md = `# Visual Diff Report · ${TOPIC}

生成时间: ${new Date().toISOString()}
方向: ${SELECTED_DIRECTION}
检查项: ${CHECKS.length} 组件 / ${rows.length} 维度差异

## 关卡判定

- ❌ ${failCount} 项必修
- ⚠️ ${warnCount} 项待人审
- ✅ ${passCount} 项设计噪音可接受

${failCount === 0 ? '**🟢 全绿 → 可进 dao-finish**' : '**🔴 有 ❌ → 回炉（修代码或修 mockup）**'}

## 差异表

| 元素 | 维度 | mockup | 实施 | 处置 |
|---|---|---|---|---|
${rows.map((r) => `| ${r.name} | ${r.dim} | ${r.mock} | ${r.impl} | ${r.verdict} |`).join('\n')}

${failures.length > 0 ? `\n## Selector 失败\n\n${failures.map((f) => `- ${f}`).join('\n')}` : ''}
`

writeFileSync(REPORT_PATH, md, 'utf-8')
console.log(`✅ 报告已写入 ${REPORT_PATH}`)
console.log(`关卡: ${failCount === 0 ? '🟢 PASS' : `🔴 FAIL (${failCount} ❌)`}`)
process.exit(failCount === 0 ? 0 : 1)
