/**
 * Fidelity 验证脚本参考模板 — Playwright + TypeScript
 *
 * 使用方式：复制到项目 tests/fidelity/ 目录，填入 PAGE_STATES。
 * 遵循 fidelity.md §6.5 步骤规范，项目可加步骤不可减。
 */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'fs';

// ════════════════════════════════════════════════
// 项目侧填充：从 .claude/rules/design-fidelity.md 状态矩阵提取
// ════════════════════════════════════════════════

interface PageState {
  /** 页面标识（如 'dashboard', 'report'） */
  page: string;
  /** 状态标识（如 'empty', 'loading', 'overflow'） */
  state: string;
  /** app 路由或导航路径 */
  route: string;
  /** 状态注入函数（mock 数据 / 触发 loading / 设置条件） */
  setup?: (page: import('@playwright/test').Page) => Promise<void>;
  /** 对应 design/pages/*.html 路径（无则为代码独有态） */
  designHtml?: string;
  /** 阈值档位 */
  tier: 'core' | 'secondary' | 'dynamic';
}

// ⬇️ 项目侧在此填入完整状态矩阵 ⬇️
const PAGE_STATES: PageState[] = [
  // { page: 'dashboard', state: 'empty',   route: '/',  tier: 'core' },
  // { page: 'dashboard', state: 'normal',  route: '/',  tier: 'core', designHtml: 'dashboard.html' },
  // { page: 'dashboard', state: 'overflow', route: '/', tier: 'core',
  //   setup: async (p) => { await p.evaluate(() => { /* inject 100+ items */ }); } },
];

// ════════════════════════════════════════════════
// 阈值与路径（通常不需改动）
// ════════════════════════════════════════════════

const THRESHOLDS: Record<PageState['tier'], number> = {
  core: 0.0005,       // 0.05%
  secondary: 0.001,   // 0.1%
  dynamic: 0.003,     // 0.3%
};

const OUTPUT_DIR = '_tmp/qa/fidelity';

// ════════════════════════════════════════════════
// 布局完整性检查 — §6.4.1 Layout Integrity
// 检测窗口边缘死区（CSS Grid/Flex 行列模板缺失）
// 项目侧可覆盖 LAYOUT_GAP_THRESHOLD 和 SHELL_SELECTOR
// ════════════════════════════════════════════════

const LAYOUT_GAP_THRESHOLD = 20; // px，差值超过此值 → fail
const SHELL_SELECTOR = '[data-slot="app-shell"], body > *:first-child'; // 最外层布局容器

async function assertNoLayoutGap(page: import('@playwright/test').Page): Promise<void> {
  const selector = SHELL_SELECTOR;
  const gap = await page.evaluate((sel) => {
    const shell = document.querySelector(sel);
    if (!shell) return 0;
    const children = Array.from(shell.children).filter(
      (el) => getComputedStyle(el).display !== 'none',
    );
    const last = children[children.length - 1];
    if (!last) return 0;
    return shell.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
  }, selector);
  expect(gap, `窗口底部布局死区 ${gap}px 超过阈值 ${LAYOUT_GAP_THRESHOLD}px`).toBeLessThan(
    LAYOUT_GAP_THRESHOLD,
  );
}

// ════════════════════════════════════════════════
// Step 0: 合规校验 — 状态清单不能为空
// ════════════════════════════════════════════════

test.beforeAll(() => {
  if (PAGE_STATES.length <= 1) {
    throw new Error(
      'PAGE_STATES 为空或只有一个态，不符合 §6.5 覆盖要求。' +
      '请从 .claude/rules/design-fidelity.md 状态矩阵提取全部态。'
    );
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });
});

// ════════════════════════════════════════════════
// Step 1~5: 逐态验证（§6.5 必须步骤）
// ════════════════════════════════════════════════

for (const ps of PAGE_STATES) {
  test(`fidelity: ${ps.page}/${ps.state}`, async ({ page }) => {
    // Step 1: 状态注入
    if (ps.setup) {
      await ps.setup(page);
    }

    // Step 2: 导航 + 等待渲染稳定
    await page.goto(ps.route);
    await page.waitForLoadState('networkidle');

    // Step 3: 截图（人可读审计产出）
    const screenshotPath = `${OUTPUT_DIR}/verify-${ps.page}-${ps.state}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // Step 4: 布局完整性检查（§6.4.1 — 所有非模态页面均执行）
    await assertNoLayoutGap(page);

    // Step 5: 有原型 → 像素 diff
    if (ps.designHtml) {
      await expect(page).toHaveScreenshot(
        `${ps.page}-${ps.state}.png`,
        { maxDiffPixelRatio: THRESHOLDS[ps.tier] },
      );
    }

    // Step 6: 无原型（代码独有态）→ 空白检测
    if (!ps.designHtml) {
      const body = await page.locator('body').boundingBox();
      const content = await page.locator(
        'main, [data-testid="content"], [role="main"]',
      ).first().boundingBox();
      if (body && content) {
        const ratio =
          (content.width * content.height) / (body.width * body.height);
        expect(ratio, `${ps.page}/${ps.state} 内容区占比过低，疑似大面积空白`)
          .toBeGreaterThan(0.3);
      }
    }
  });
}

// ════════════════════════════════════════════════
// Step 7: 设计原型基线截图
// 通常由 playwright.config.ts 的 webServer 自动启停
// design/ HTTP server，基线存 *-snapshots/（tracked）
// ════════════════════════════════════════════════
