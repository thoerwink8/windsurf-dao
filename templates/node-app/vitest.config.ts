import { defineConfig } from 'vitest/config'

// Vitest 配置骨架（node-app 薄层）。
// 默认 node 环境，测纯逻辑零配置。
// 要测 React 组件时：装 @vitejs/plugin-react + happy-dom，
//   然后取消下面两行注释并删掉注释行：
//   import react from '@vitejs/plugin-react'
//   plugins: [react()],
//   并在 test 里加 environment: 'happy-dom'

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['**/*.{test,spec}.{ts,tsx}', '**/index.ts', '**/types.ts'],
    },
  },
})
